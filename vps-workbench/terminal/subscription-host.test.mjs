import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStandaloneSubscriptionHost, SUBSCRIPTION_PREFIX } from './subscription-host.mjs';

const targetId = 'ab'.repeat(32);
const relay = { version: 1, socksPort: 1180, expectedSshSource: '192.0.2.13' };

function fakeBridge(frames, processModes, failInput) {
  return (file, [mode]) => {
    processModes.push(mode);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    const respond = value => child.stdout.write(JSON.stringify(value) + '\n');
    let running = true;
    function finish(code) {
      if (!running) return;
      running = false;
      child.stdout.end();
      child.emit('close', code, null);
    }
    child.kill = () => finish(1);
    child.stdin = new Writable({
      write(data, encoding, done) {
        const message = JSON.parse(data.toString());
        frames.push(message);
        if (message.type === 'native-start') {
          respond({ type: 'ready' });
          respond({ type: 'output', data: Buffer.from(`隔离终端已就绪：${message.options.operationId}`).toString('base64') });
        }
        if (message.type === 'native-status') {
          respond({ type: 'status', state: 'finished', exitCode: 0 });
          finish(0);
        }
        if (message.type === 'close') {
          respond({ type: 'exit', code: 0, error: null });
          finish(0);
        }
        if (message.type === 'input' && failInput) return done(new Error('fixture write result uncertain'));
        done();
      },
    });
    return child;
  };
}

async function fixture(t, configure = {}) {
  const base = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.subscription-fixture-'));
  const stateRoot = join(base, 'state');
  mkdirSync(stateRoot);
  const relayPath = join(base, 'ssh-relay.json');
  const settings = {
    provider: 'claude-sdk', host: 'fixture.example', port: 22, user: 'tester',
    hostKeyConfirmed: true, knownHostsPath: join(base, 'known_hosts'), identityPath: join(base, 'mock-key'),
    workspace: '/workspace/fixture', expectedIpv4: '192.0.2.12', expectedIpv6: '',
  };
  const pins = 'fixture.example ssh-ed25519 fixture\n';
  writeFileSync(settings.knownHostsPath, pins);
  writeFileSync(settings.identityPath, 'fixture');
  const frames = [], processModes = [];
  const options = {
    port: 32141, stateRoot, workbenchRoot: base, executable: join(base, 'fake.exe'),
    spawn: fakeBridge(frames, processModes, configure.failInput),
    authorize: configure.authorize,
    verifyTarget(root, submitted) {
      assert.equal(root, base);
      assert.equal(readFileSync(submitted.knownHostsPath, 'utf8'), pins);
      assert.notEqual(submitted.knownHostsPath, settings.knownHostsPath);
      assert.equal(submitted.provider, settings.provider);
      return configure.verifyTarget?.({ relayPath, submitted }) ?? targetId;
    },
  };
  let host = createStandaloneSubscriptionHost(options);
  t.after(() => {
    host.dispose();
    rmSync(base, { recursive: true, force: true });
  });
  function request(path, method, headers, body) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method, url: SUBSCRIPTION_PREFIX + path, socket: { remoteAddress: '127.0.0.1' },
      rawHeaders: ['Host', '127.0.0.1:32141', ...headers],
    });
    return new Promise((resolve, reject) => {
      let status;
      const res = { writeHead(code) { status = code; }, end(data) { resolve({ status, body: JSON.parse(data) }); } };
      Promise.resolve((path === 'bootstrap' ? host.token : host.rpc)(req, res)).catch(reject);
    });
  }
  const bootstrap = (extra = []) => request('bootstrap', 'GET', ['x-rtw-bootstrap', '1', ...extra]);
  let token = (await bootstrap()).body.token;
  const rpc = (op, args = {}, nonce = randomUUID()) => request('rpc', 'POST', [
    'content-type', 'application/json', 'x-rtw-token', token, 'x-rtw-nonce', nonce,
  ], { op, ...args });
  const start = (patch = {}) => rpc('native-subscription-start', { settings, targetId, requireRelay: false, mode: 'new', ...patch });
  return {
    relayPath, settings, rpc, start, bootstrap, frames, processModes,
    async restart() {
      host.dispose();
      host = createStandaloneSubscriptionHost(options);
      token = (await bootstrap()).body.token;
    },
  };
}

test('isolated relay launch, original receipt, and explicit reconciliation', async t => {
  const f = await fixture(t);
  writeFileSync(f.relayPath, JSON.stringify(relay));
  assert.equal((await f.bootstrap(['Origin', 'https://fixture.invalid'])).status, 403);
  const nonce = randomUUID();
  assert.deepEqual((await f.rpc('native-subscription-route', {}, nonce)).body.result, {
    kind: 'relay', socksPort: relay.socksPort, expectedSshSource: relay.expectedSshSource,
  });
  assert.equal((await f.rpc('native-subscription-route', {}, nonce)).status, 409);
  assert.equal((await f.rpc('native-start')).status, 400);
  assert.equal((await f.rpc('native-reopen')).status, 400);
  assert.equal((await f.start({ targetId: 'aa'.repeat(32) })).body.code, 'subscription_preflight_rejected');
  assert.deepEqual(f.frames, []);

  const launch = await f.start({ requireRelay: true, mode: 'picker' });
  const { sessionId } = launch.body.result;
  assert.equal(launch.status, 200);
  assert.equal(f.frames[0].type, 'native-start');
  assert.equal(f.frames[0].options.provider, 'claude');
  assert.equal(f.frames[0].options.mode, 'picker');
  assert.equal(f.frames[0].options.socksPort, relay.socksPort);
  assert.equal(f.frames[0].options.expectedSshSource, relay.expectedSshSource);
  assert.equal((await f.rpc('native-subscription-current', { settings: f.settings, targetId, requireRelay: true, mode: 'new' })).body.result.sessionId, sessionId);
  const other = await f.rpc('native-subscription-current', { settings: { ...f.settings, workspace: '/other' }, targetId, requireRelay: true, mode: 'new' });
  assert.equal(other.body.result.otherTerminal, true);
  assert.equal(other.body.result.sessionId, null);
  const poll = await f.rpc('native-poll', { sessionId, after: 0 });
  assert.equal(poll.body.result.state, 'ready');
  assert.equal(poll.body.result.events[0].type, 'output');
  assert.equal((await f.rpc('native-input', { sessionId, data: 'b2sN' })).status, 200);
  assert.deepEqual(f.frames[1], { type: 'input', data: 'b2sN' });
  const resized = await f.rpc('native-resize', { sessionId, columns: 42, rows: 12 });
  assert.deepEqual(resized.body.result, { state: 'ready', sessionId, lastSequence: poll.body.result.lastSequence });
  assert.deepEqual(f.frames[2], { type: 'resize', columns: 42, rows: 12 });
  assert.equal((await f.rpc('native-resize', { sessionId: randomUUID(), columns: 40, rows: 12 })).status, 409);
  assert.equal(f.frames.length, 3);
  assert.equal((await f.rpc('native-close', { sessionId })).body.result.state, 'detached');
  assert.equal((await f.rpc('native-acknowledge', { operationId: sessionId, reviewed: true })).status, 409);
  assert.equal((await f.rpc('native-status', { operationId: sessionId })).body.result.state, 'finished');
  assert.equal((await f.rpc('native-acknowledge', { operationId: sessionId, reviewed: true })).body.result.state, 'closed');
  await f.restart();
  assert.equal((await f.rpc('native-list')).body.result.records[0].operationId, sessionId);
  assert.equal((await f.rpc('native-status', { operationId: sessionId })).body.result.state, 'finished');
  assert.deepEqual(f.processModes, ['--native', '--native-status', '--native-status']);
});

test('an absent optional relay and a legacy direct receipt respect current route policy', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.rpc('native-subscription-route')).body.result, { kind: 'direct' });
  assert.equal((await f.start({ requireRelay: true })).body.code, 'subscription_preflight_rejected');
  const { sessionId } = (await f.start()).body.result;
  assert.equal(f.frames[0].options.socksPort, null);
  assert.equal(f.frames[0].options.expectedSshSource, null);
  writeFileSync(f.relayPath, JSON.stringify(relay));
  assert.equal((await f.rpc('native-status', { operationId: sessionId })).status, 409);
  assert.deepEqual(f.processModes, ['--native']);
});

test('a configured relay that disappears or becomes invalid never triggers a direct launch', async t => {
  const f = await fixture(t, { verifyTarget({ relayPath }) { unlinkSync(relayPath); return targetId; } });
  writeFileSync(f.relayPath, JSON.stringify(relay));
  assert.equal((await f.start()).body.code, 'subscription_preflight_rejected');
  assert.equal((await f.start()).body.code, 'subscription_preflight_rejected');
  writeFileSync(f.relayPath, '{invalid');
  assert.equal((await f.start()).body.code, 'subscription_preflight_rejected');
  assert.deepEqual(f.processModes, []);
});

test('switching to browse-only during terminal preflight prevents dispatch', async t => {
  let execute = true;
  const f = await fixture(t, {
    authorize: (op) => execute || op === 'native-list',
    verifyTarget() { execute = false; return targetId; },
  });
  const response = await f.start();
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'workbench_browse_only');
  assert.deepEqual(f.processModes, []);
  assert.equal((await f.rpc('native-list')).status, 200);
});

test('an uncertain write retains its receipt and stops follow-up writes', async t => {
  const f = await fixture(t, { failInput: true });
  const { sessionId } = (await f.start()).body.result;
  const first = await f.rpc('native-input', { sessionId, data: 'YQ0=' });
  assert.equal(first.body.code, 'write_uncertain');
  assert.equal((await f.rpc('native-input', { sessionId, data: 'Yg0=' })).body.code, 'unavailable');
  assert.deepEqual(f.frames.filter(frame => frame.type === 'input'), [{ type: 'input', data: 'YQ0=' }]);
  assert.equal((await f.rpc('native-list')).body.result.records[0].operationId, sessionId);
  assert.equal((await f.start()).body.code, 'unavailable');
});
