import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply, createBridge, createHost, prefix } from './index.js';

const headers = { 'X-DSH-VPS-CHAT': '1' };
const settings = {
  host: 'vps.example',
  port: 22,
  user: 'fixture',
  identityPath: 'C:/test/id',
  knownHostsPath: 'C:/test/known_hosts',
  workspace: '/test/project',
  expectedIpv4: '192.0.2.10',
  expectedIpv6: '',
  hostKeyConfirmed: true,
};

test('local workbench routes enforce scope and dispatch only the declared JSON operations', async t => {
  const calls = [];
  const bridge = {
    request(body) { calls.push(body); return { ok: true, sessions: [] }; },
  };
  let host;
  const server = createServer((req, res) => {
    if (req.url === prefix + 'token') return host.token(req, res);
    return host.rpc(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  host = createHost({ port, bridge });
  t.after(() => { host.dispose(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${port}`;
  const url = origin + prefix;
  assert.equal((await fetch(url + 'token')).status, 403);
  assert.equal((await fetch(url + 'token', { headers: { ...headers, Origin: 'https://external.invalid' } })).status, 403);
  assert.equal((await fetch(url + 'token', { headers: { ...headers, 'X-Forwarded-For': '127.0.0.1' } })).status, 403);
  const bootstrap = await fetch(url + 'token', { headers: { ...headers, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  const { token } = await bootstrap.json();
  assert.match(token, /^[\w-]{43}$/);
  const rpc = (body, extra) => fetch(url + 'rpc', {
    method: 'POST',
    headers: { ...headers, 'X-DSH-VPS-CHAT-Token': token, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
  assert.equal((await rpc({ op: 'list', settings }, { 'X-DSH-VPS-CHAT-Token': 'x'.repeat(43) })).status, 403);
  assert.equal((await rpc({ op: 'list', settings, command: ['python.exe'] })).status, 400);
  assert.equal((await rpc({ op: 'local_model', settings })).status, 400);
  assert.equal((await rpc({ op: 'preset', settings })).status, 400);
  assert.equal((await rpc({ op: 'list', settings: { ...settings, provider: 'local' } })).status, 400);
  assert.equal((await rpc({ op: 'list', settings: { ...settings, hostKeyConfirmed: false } })).status, 400);
  assert.equal((await rpc({ op: 'list', settings: { ...settings, identityPath: 'x'.repeat(66_000) } })).status, 400);
  assert.deepEqual(calls, []);

  const payload = {
    op: 'send', settings, sessionId: 'a1a11111-1111-4111-8111-111111111111',
    targetId: 'c'.repeat(64),
    turnId: 'b2b22222-2222-4222-8222-222222222222', prompt: '你好\n${literal} ; | &',
  };
  assert.equal((await rpc({ ...payload, targetId: undefined })).status, 400);
  assert.equal((await rpc({ op: 'preset' })).status, 200);
  assert.equal((await rpc(payload, { Origin: origin })).status, 200);
  const codex = { ...payload, settings: { ...settings, provider: 'codex' } };
  assert.equal((await rpc(codex)).status, 200);
  assert.equal((await rpc({ ...codex, advanced: { verbosity: 'low' } })).status, 400);
  assert.equal((await rpc({ op: 'model-options', settings: codex.settings, targetId: codex.targetId })).status, 400);
  const design = { ...codex, mode: 'design' };
  assert.equal((await rpc({ ...payload, mode: 'design' })).status, 400);
  assert.equal((await rpc({ ...codex, mode: 'other' })).status, 400);
  assert.equal((await rpc({ op: 'list', settings, mode: 'design' })).status, 400);
  assert.equal((await rpc(design)).status, 200);
  const expandedDesign = {
    ...design,
    designContext: {
      text: '来自画布的选定批注',
      images: [{ name: 'test.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(80_000) }],
    },
  };
  assert.equal((await rpc({ ...codex, designContext: expandedDesign.designContext })).status, 400);
  assert.equal((await rpc({ ...design, designContext: { text: '', images: [] } })).status, 400);
  assert.equal((await rpc({ ...design, designContext: {
    text: '截图', images: [{ name: 'remote.png', dataUrl: 'https://external.invalid/image.png' }],
  } })).status, 400);
  assert.equal((await rpc(expandedDesign)).status, 200);
  const { prompt, ...identity } = codex;
  const stop = { ...identity, op: 'stop' };
  assert.equal((await rpc({ ...stop, prompt })).status, 400);
  assert.equal((await rpc({ ...stop, turnId: 'invalid' })).status, 400);
  assert.equal((await rpc(stop)).status, 200);
  const steer = { ...identity, op: 'steer', steerId: '77af1579-7540-4a22-b28e-f4cc488df729', prompt: '把标题改成暖白色。' };
  assert.equal((await rpc({ ...steer, settings })).status, 400);
  assert.equal((await rpc({ ...steer, prompt: '过'.repeat(1201) })).status, 400);
  assert.equal((await rpc({ ...steer, steerId: 'invalid' })).status, 400);
  assert.equal((await rpc({ ...steer, designContext: { text: 'unused', images: [] } })).status, 400);
  assert.equal((await rpc(steer)).status, 200);
  const agySettings = { ...settings, provider: 'antigravity' };
  const agySteer = { ...steer, settings: agySettings };
  assert.equal((await rpc(agySteer)).status, 200);
  const approval = {
    ...identity, settings: agySettings, op: 'approval',
    approvalId: '061e0c53-0555-4baa-944d-04a348720f33', decision: 'allow',
  };
  assert.equal((await rpc({ ...approval, settings: codex.settings })).status, 400);
  assert.equal((await rpc({ ...approval, decision: 'allow_always' })).status, 400);
  assert.equal((await rpc({ ...approval, turnId: undefined })).status, 400);
  assert.equal((await rpc({ ...approval, approvalId: 'invalid' })).status, 400);
  assert.equal((await rpc({ ...approval, command: 'unexpected' })).status, 400);
  assert.equal((await rpc(approval)).status, 200);
  const models = { op: 'models', settings: codex.settings, targetId: codex.targetId };
  const explicitModel = { ...design, model: 'fixture-mini', effort: 'medium' };
  const claudeModels = { ...models, settings: { ...settings, provider: 'claude' } };
  const claudeSelection = { ...payload, settings: claudeModels.settings, model: 'sonnet' };
  assert.equal((await rpc({ ...models, settings })).status, 400);
  assert.equal((await rpc({ ...models, sessionId: codex.sessionId })).status, 400);
  assert.equal((await rpc({ ...codex, effort: 'low' })).status, 400);
  assert.equal((await rpc({ ...codex, model: 'with space' })).status, 400);
  assert.equal((await rpc({ ...payload, model: 'fixture-mini' })).status, 400);
  assert.equal((await rpc({ ...claudeSelection, effort: 'high' })).status, 400);
  assert.equal((await rpc({ ...steer, model: 'fixture-mini' })).status, 400);
  assert.equal((await rpc(models)).status, 200);
  assert.equal((await rpc(explicitModel)).status, 200);
  assert.equal((await rpc(claudeModels)).status, 200);
  assert.equal((await rpc(claudeSelection)).status, 200);
  assert.deepEqual(calls, [{ op: 'preset' }, payload, codex, design, expandedDesign, stop, steer, agySteer, approval, models, explicitModel,
    claudeModels, claudeSelection]);
  host.dispose();
  assert.equal((await rpc(payload)).status, 403);
  assert.equal(calls.length, 13);
});

test('advanced settings choose the current bridge and preserve direct and verified relay routing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.js'), `
    const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    const port = process.env.DSH_VPS_CHAT_SOCKS_PORT ?? null;
    process.stdout.write(JSON.stringify({ ok: true, request, port, ...(request.op === 'list' ? { targetId: 'c'.repeat(64) } : {}) }));
  `);
  let policy = null;
  const bridge = createBridge({ root, executable: process.execPath, pythonPath: process.execPath,
    compatibilityDirectory: join(root, 'absent-compat'), readRoute: () => policy });
  t.after(() => bridge.dispose());
  const codex = { op: 'send', settings: { ...settings, provider: 'codex' }, advanced: { verbosity: 'low' } };
  const claude = { op: 'send', settings: { ...settings, provider: 'claude' }, advanced: { maxOutputTokens: 2048 } };
  const options = (packet, targetId = 'c'.repeat(64)) => bridge.request({ op: 'model-options', settings: packet.settings, targetId });
  assert.deepEqual(await options(codex), { ok: true, fields: ['verbosity'] });
  assert.equal((await options(codex, 'd'.repeat(64))).code, 'target_changed');
  assert.deepEqual(await bridge.request(codex), { ok: true, request: codex, port: null });
  assert.deepEqual(await options(claude), { ok: true, fields: [], reason: 'direct-claude' });
  assert.equal((await bridge.request(claude)).code, 'invalid_request');
  policy = { socksPort: 15301, expectedSshSource: '192.0.2.4' };
  assert.deepEqual(await options(claude), { ok: true, fields: ['maxOutputTokens', 'reasoningEffort'] });
  assert.deepEqual(await bridge.request(claude), { ok: true, request: claude, port: '15301' });
});

test('missing local bridge gives a pre-dispatch error without another execution path', async () => {
  const bridge = createBridge({ root: undefined });
  assert.deepEqual(await bridge.request({ op: 'list', settings }), {
    ok: false, code: 'bridge_not_ready', message: '本机 VPS 对话组件或 Python 运行环境不可用。',
  });
});

test('Cordis apply registers and disposes both routes in one effect', () => {
  const routes = new Map();
  const context = {
    webServer: {
      port: 12345,
      register(record) {
        assert.equal(record.kind, 'exact');
        routes.set(record.path, record.handler);
        return () => routes.delete(record.path);
      },
    },
    effect(start) { this.dispose = start(); },
  };
  apply(context, {});
  assert.deepEqual([...routes.keys()], [prefix + 'token', prefix + 'rpc']);
  context.dispose();
  assert.equal(routes.size, 0);
});
