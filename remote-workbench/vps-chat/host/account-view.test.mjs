import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { WebSocket } from 'ws';
import { accountSocketPath, readAccountRoute } from './account-view.js';
const bundle = process.env.DSH_VPS_ACCOUNT_HOST_BUNDLE;
const { createHost, prefix } = await import(bundle ? pathToFileURL(bundle) : './index.js');

test('account viewer binds an allowlisted action to a verified single-use VPS channel', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-account-relay-'));
  const policy = join(root, 'ssh-relay.json');
  t.after(async () => { await rm(policy, { force: true }); await rmdir(root); });
  const relay = { socksPort: 18808, expectedSshSource: '192.0.2.9' };
  const settings = {
    host: 'fixture.invalid', user: 'fixture', port: 22, hostKeyConfirmed: true,
    identityPath: 'C:/fixture/key', knownHostsPath: 'C:/fixture/pins',
    expectedIpv4: '192.0.2.8', expectedIpv6: '',
  };
  const targetId = 'a'.repeat(64);
  const calls = [];
  let processHandle;
  let exited;
  let wrongPeer = false;
  let expectedAction = 'claude-account';
  let expectedRoute = relay;
  let startupIssue;
  let host;
  const server = createServer((req, res) => req.url === prefix + 'token' ? host.token(req, res) : host.rpc(req, res));
  server.on('upgrade', (req, socket, head) => host.upgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  host = createHost({
    port, root, accountEnabled: true,
    bridge: { request(packet) { calls.push(packet); return { ok: true, preset: { settings, targetId } }; } },
    launchAccountBrowser(received, source, routed, action) {
      assert.deepEqual(received, settings);
      assert.deepEqual(routed, expectedRoute);
      assert.match(source, /https:\/\/claude\.ai\/settings\/account/);
      assert.match(source, /https:\/\/platform\.claude\.com\/settings\/keys/);
      assert.equal(action, expectedAction);
      assert.equal(processHandle, undefined);
      const header = wrongPeer ? 'wrong source\n' : 'DSH_VPS_RELAY_READY\n';
      const program = startupIssue
        ? `process.stdout.write(${JSON.stringify(header)}); process.stderr.write(${JSON.stringify('DSH_ACCOUNT_ERROR ' + startupIssue + '\n')}); process.exitCode = 1;`
        : `process.stdin.pipe(process.stdout); process.stdout.write(${JSON.stringify(header + 'RFB 003.008\n')});`;
      processHandle = spawn(process.execPath, ['-e', program],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      exited = once(processHandle, 'close');
      return processHandle;
    },
  });
  let viewer;
  try {
    const headers = { 'X-DSH-VPS-CHAT': '1', 'Content-Type': 'application/json' };
    const { token } = await (await fetch(origin + prefix + 'token', { headers })).json();
    const prepare = (fields, authorized = true) => fetch(origin + prefix + 'rpc', {
      method: 'POST', headers: authorized ? { ...headers, 'X-DSH-VPS-CHAT-Token': token } : headers,
      body: JSON.stringify({ op: 'account-view', targetId, ...fields }),
    });
    assert.equal((await prepare({}, false)).status, 403);
    assert.equal((await prepare({ url: 'https://fixture.invalid/' })).status, 400);
    assert.equal((await prepare({ action: 'https://fixture.invalid/' })).status, 400);
    assert.equal((await prepare({ action: 'constructor' })).status, 400);
    assert.equal((await prepare({ action: 'codex-login', command: 'codex' })).status, 400);
    assert.throws(() => readAccountRoute(root));
    assert.equal(readAccountRoute(root, true), null);
    await writeFile(policy, '{}');
    assert.throws(() => readAccountRoute(root, true));
    assert.equal((await (await prepare()).json()).code, 'relay_required');
    await writeFile(policy, Buffer.alloc(1025));
    assert.throws(() => readAccountRoute(root, true));
    assert.equal((await (await prepare()).json()).code, 'relay_required');
    assert.equal(processHandle, undefined);
    const url = `ws://127.0.0.1:${port}${accountSocketPath}`;
    if (bundle) {
      await rm(policy);
      expectedRoute = null;
      expectedAction = 'codex-login';
      const direct = await (await prepare({ action: expectedAction })).json();
      viewer = new WebSocket(url, [direct.protocol], { origin });
      const [hello] = await once(viewer, 'message');
      assert.equal(hello.toString(), 'RFB 003.008\n');
      viewer.close();
      assert.equal((await exited)[0], 0);
      processHandle = undefined;
      expectedRoute = relay;
      expectedAction = 'claude-account';
    }
    await writeFile(policy, JSON.stringify({ version: 1, ...relay }));
    assert.deepEqual(readAccountRoute(root, true), relay);
    assert.equal((await (await prepare({ targetId: 'b'.repeat(64) })).json()).code, 'account_unavailable');
    const grant = await (await prepare()).json();
    assert.equal(grant.port, port);
    const untrusted = new WebSocket(url, [grant.protocol], { origin: 'https://fixture.invalid' });
    await assert.rejects(once(untrusted, 'open'));
    assert.equal(processHandle, undefined);
    viewer = new WebSocket(url, [grant.protocol], { origin });
    const [hello] = await once(viewer, 'message');
    assert.equal(hello.toString(), 'RFB 003.008\n');
    viewer.send(Buffer.from('input fixture'));
    const [echo] = await once(viewer, 'message');
    assert.equal(echo.toString(), 'input fixture');
    assert.equal((await (await prepare()).json()).code, 'account_busy');
    viewer.close();
    assert.equal((await exited)[0], 0);
    const replay = new WebSocket(url, [grant.protocol], { origin });
    await assert.rejects(once(replay, 'open'));
    processHandle = undefined;
    expectedAction = 'claude-login';
    startupIssue = 'account_encrypted_home_required';
    const blocked = await (await prepare({ action: expectedAction })).json();
    viewer = new WebSocket(url, [blocked.protocol], { origin });
    const [closeCode, closeReason] = await once(viewer, 'close');
    assert.equal(closeCode, 1011);
    assert.equal(closeReason.toString(), startupIssue);
    assert.equal((await exited)[0], 1);
    processHandle = undefined;
    startupIssue = undefined;
    const pending = await (await prepare({ action: 'chatgpt-account' })).json();
    await writeFile(policy, JSON.stringify({ version: 1, ...relay, socksPort: relay.socksPort + 1 }));
    viewer = new WebSocket(url, [pending.protocol], { origin });
    await once(viewer, 'close');
    assert.equal(processHandle, undefined);
    await writeFile(policy, JSON.stringify({ version: 1, ...relay }));
    wrongPeer = true;
    expectedAction = 'antigravity-login';
    const unverifiedGrant = await (await prepare({ action: expectedAction })).json();
    viewer = new WebSocket(url, [unverifiedGrant.protocol], { origin });
    let gotFrame = false;
    viewer.once('message', () => { gotFrame = true; });
    viewer.once('open', () => viewer.send(Buffer.from('must not reach SSH stdin')));
    await once(viewer, 'close');
    assert.equal(gotFrame, false);
    assert.equal(processHandle.stdin.bytesWritten, 0);
    await exited;
    assert.deepEqual(calls, Array.from({ length: bundle ? 6 : 5 }, () => ({ op: 'preset' })));
  } finally {
    viewer?.terminate();
    host.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
