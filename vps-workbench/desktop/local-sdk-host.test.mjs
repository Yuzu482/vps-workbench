import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { localCredentialVariable, localModels, openCodexRuntime } from './codex-runtime.mjs';
import { startWorkbenchServer } from './server.mjs';

async function temporaryRoot(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'workbench-local-sdk-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('pinned SDK receives only the selected Windows API route, private state and read-only options', async (t) => {
  const root = await temporaryRoot(t);
  const vendor = join(root, 'local-codex', 'bin');
  await mkdir(vendor, { recursive: true });
  await writeFile(join(vendor, 'codex.exe'), 'Runtime path fixture.');
  const apiKey = 'sk-fixture-local-key';
  const environment = { SysTemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture', APPDATA: 'C:\\AppData',
    ProgramData: 'C:\\ProgramData', HTTPS_PROXY: 'http://relay.invalid', SSH_CONNECTION: 'fixture',
    OPENAI_API_KEY: 'not-selected', OPENAI_BASE_URL: 'https://elsewhere.invalid', CODEX_HOME: 'C:\\unrelated',
    PATH: 'C:\\untrusted', CODEX_WINDOWS_REGISTERED_CORE: '1', [localCredentialVariable]: apiKey,
    NODE_OPTIONS: '--require=C:\\untrusted.js' };
  const stateRoot = join(root, 'app-state');
  const calls = [];
  class FakeCodex {
    constructor(options) { calls.push(options); }
    startThread(options) { return { method: 'start', options }; }
    resumeThread(id, options) { return { method: 'resume', id, options }; }
  }
  const options = { runtimeRoot: root, stateRoot, apiKey, environment, isWindowsX64: true,
    loadSdk: async () => ({ Codex: FakeCodex }) };
  const runtime = await openCodexRuntime(options);
  const directory = join(root, '项目.只读');
  await mkdir(directory);
  const profile = { id: randomUUID(), directory, model: localModels[0].id, effort: 'low' };
  assert.equal(runtime.runtimeAvailable, true);
  assert.equal(runtime.credentialConfigured(), true);
  const first = await runtime.createThread(profile, null);
  assert.equal(first.method, 'start');
  assert.deepEqual(first.options, { model: profile.model, modelReasoningEffort: 'low', workingDirectory: directory,
    approvalPolicy: 'never', sandboxMode: 'read-only', skipGitRepoCheck: true,
    networkAccessEnabled: false, webSearchMode: 'disabled' });
  const [sdk] = calls;
  assert.equal(sdk.codexPathOverride, join(vendor, 'codex.exe'));
  assert.equal(sdk.baseUrl, 'https://api.openai.com/v1');
  assert.equal(sdk.apiKey, apiKey);
  assert.equal(sdk.env.CODEX_HOME, join(stateRoot, 'threads', profile.id));
  assert.equal(sdk.env.TEMP, join(stateRoot, 'temp', profile.id));
  assert.equal(sdk.env.ProgramData, environment.ProgramData);
  assert.ok(sdk.configOverrides[0].includes(JSON.stringify(directory) + ' = { trust_level = "untrusted" }'));
  assert.equal(sdk.config.windows.sandbox, 'unelevated');
  assert.equal(sdk.config.model_provider, 'openai');
  assert.equal(Object.hasOwn(sdk.config, 'model_verbosity'), false);
  assert.equal(sdk.config.forced_login_method, 'api');
  assert.equal(sdk.config.shell_environment_policy.inherit, 'none');
  assert.equal(sdk.config.features.system_proxy_fallback, false);
  assert.equal(sdk.config.features.memories, false);
  for (const name of ['HTTPS_PROXY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'SSH_CONNECTION',
    'CODEX_WINDOWS_REGISTERED_CORE', 'NODE_OPTIONS', localCredentialVariable]) assert.equal(Object.hasOwn(sdk.env, name), false);
  assert.equal(sdk.env.PATH.includes('untrusted'), false);
  assert.deepEqual(await runtime.createThread(profile, 'native-thread', { verbosity: 'low' }),
    { ...first, method: 'resume', id: 'native-thread' });
  assert.equal(calls[1].config.model_verbosity, 'low');
  await writeFile(join(sdk.env.CODEX_HOME, 'config.toml'), 'Injected per-user configuration.');
  await assert.rejects(runtime.createThread(profile, 'native-thread'), { code: 'invalid_environment' });
  const unauthenticated = await openCodexRuntime({ ...options, apiKey: undefined });
  await assert.rejects(unauthenticated.createThread(profile, null), { code: 'auth_required' });
  assert.equal(calls.length, 2);
});

test('standalone separates trusted Local IPC from legacy SSH RPC and enforces browse', async (t) => {
  const root = await temporaryRoot(t);
  const ssh = [];
  const native = [];
  let mode = 'execute';
  const fixture = createPreviewFixtures().chat({ op: 'preset' }).preset;
  const app = await startWorkbenchServer({
    webRoot: root, workbenchRoot: join(root, 'old-conversations'), terminalRoot: root, runtimeRoot: root,
    localStateRoot: join(root, 'local-sdk'), access: () => ({ mode, workspace: 'default' }),
    makeBridge: () => ({ request(packet) { ssh.push(packet); return { ok: true, targetId: fixture.targetId }; } }),
    makeLocalRuntime: async () => ({
      runtimeAvailable: true, credentialConfigured: () => true,
      createThread(profile, resumed) {
        native.push({ profile, resumed });
        return { async runStreamed(prompt) { return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'fixture-thread' };
          yield { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: prompt + ' echoed' } };
          yield { type: 'turn.completed' };
        })() }; } };
      },
    }),
  });
  try {
    assert.deepEqual(app.localStatus().profiles, []);
    const { profile } = await app.registerLocalProfile({ name: '本机配置', directory: root, model: localModels[0].id, effort: 'low' });
    const common = { location: 'local-sdk', backend: 'codex', profileId: profile.id };
    const ids = { targetId: profile.targetId, sessionId: 'local-' + randomUUID(), turnId: randomUUID() };
    const send = { ...common, ...ids, op: 'send', prompt: '验证原位置' };
    for (const invalid of [{ ...send, location: 'ssh-vps' }, { ...send, backend: 'claude-sdk' },
      { ...send, profileId: randomUUID() }, { ...send, sessionId: randomUUID() },
      { ...send, attachments: [] }, { ...send, projectMemory: null }]) {
      assert.equal((await app.requestLocal(invalid)).ok, false);
    }
    assert.equal((await app.requestLocal(send)).ok, true);
    let packet;
    for (let index = 0; index < 100; index++) {
      packet = await app.requestLocal({ ...common, ...ids, op: 'refresh' });
      if (packet.session?.turns[0].state === 'completed') break;
      await wait(15);
    }
    assert.equal(packet.session.turns[0].reply, '验证原位置 echoed');
    assert.equal((await app.requestLocal(send)).duplicate, true);
    assert.equal(native.length, 1);
    assert.deepEqual(ssh, []);

    const headers = { Cookie: app.cookie.name + '=' + app.cookie.value, 'X-DSH-VPS-CHAT': '1',
      'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    const endpoint = app.origin + '/dsh-vps-chat/api/';
    headers['X-DSH-VPS-CHAT-Token'] = (await (await fetch(endpoint + 'token', { headers })).json()).token;
    const rpc = (body) => fetch(endpoint + 'rpc', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await rpc(send)).status, 400);
    const priorSsh = { op: 'list', settings: fixture.settings };
    assert.equal((await (await rpc(priorSsh)).json()).targetId, fixture.targetId);
    assert.deepEqual(ssh, [priorSsh]);
    const wrong = await rpc({ op: 'get', targetId: fixture.targetId, sessionId: ids.sessionId, settings: fixture.settings });
    assert.equal(wrong.status, 400);
    assert.equal(ssh.length, 1);
    assert.equal(native.length, 1);

    mode = 'browse';
    app.accessChanged();
    assert.equal((await app.requestLocal({ ...send, turnId: randomUUID() })).code, 'browse_only');
    assert.equal((await app.requestLocal({ ...common, ...ids, op: 'stop' })).code, 'browse_only');
    assert.equal((await app.requestLocal({ ...common, op: 'list' })).sessions.length, 1);
    assert.equal((await app.requestLocal({ ...common, ...ids, op: 'refresh' })).ok, true);
    assert.equal(native.length, 1);
    assert.equal(ssh.length, 1);
  } finally {
    await app.close();
  }
});

test('private local jobs stage raster input for the SDK and clean it up', async (t) => {
  const root = await temporaryRoot(t);
  const vendor = join(root, 'local-codex', 'bin');
  await mkdir(vendor, { recursive: true });
  await writeFile(join(vendor, 'codex.exe'), 'Pinned SDK fixture.');
  const profile = { id: randomUUID(), directory: root, model: localModels[0].id, effort: 'medium' };
  const sessionId = 'local-' + randomUUID();
  const raster = Buffer.from('89504e470d0a1a0a', 'hex');
  let staged;
  class FakeCodex {
    constructor({ config, configOverrides }) {
      assert.equal(config.features.shell_tool, false);
      assert.equal(config.features.unified_exec, false);
      assert.match(configOverrides[1], /mcp_servers = \{ +\}/u);
    }
    startThread({ workingDirectory, sandboxMode }) {
      assert.equal(workingDirectory, join(root, 'workspaces', profile.id, sessionId));
      assert.equal(sandboxMode, 'read-only');
      return { async runStreamed(input) {
        assert.deepEqual(input[0], { type: 'text', text: '只发送选定参考图' });
        assert.equal(input[1].type, 'local_image');
        staged = input[1].path;
        assert.deepEqual(await readFile(staged), raster);
        return { events: (async function* () { yield { type: 'turn.completed' }; })() };
      } };
    }
  }
  const runtime = await openCodexRuntime({ runtimeRoot: root, stateRoot: root, apiKey: 'sk-fixture-local-key',
    environment: { SystemRoot: 'C:\\Windows' }, isWindowsX64: true, loadSdk: async () => ({ Codex: FakeCodex }) });
  const thread = await runtime.createThread(profile, null, { workspace: 'private', sessionId, rasterInput: true });
  const result = await thread.runStreamed([
    { type: 'text', text: '只发送选定参考图' }, { type: 'raster', format: 'png', bytes: raster },
  ], {});
  for await (const _event of result.events) { /* Wait for the SDK response and cleanup. */ }
  await assert.rejects(readFile(staged), { code: 'ENOENT' });
});
