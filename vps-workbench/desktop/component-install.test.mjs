import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { c as tar } from 'tar';
import { createComponentInstaller, validComponentSelection } from './component-install.mjs';
import { openLocalCredentials } from './local-credentials.mjs';
import { startWorkbenchServer } from './server.mjs';
import { localModels } from './codex-runtime.mjs';
import { openLocalAgentRuntime } from './local-agent-runtime.mjs';
import { providerDefaultModels } from '../local-sdk/providers.mjs';

const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');
const pinnedExecutable = new URL('https://storage.googleapis.com/antigravity-public/antigravity-cli/fixture/agy.exe');
const pinnedArchive = new URL('https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz');

async function scratch(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vps-components-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('one selected Windows component is verified, cached and repairable after interruption or corruption', async (t) => {
  const root = await scratch(t);
  const bytes = Buffer.from('test-only executable, never run');
  const catalog = { antigravity: { version: '1.0.0', binary: {
    url: pinnedExecutable.href, integrity: sha512(bytes), bytes: bytes.length,
  } } };
  let response;
  const requests = [];
  const installer = createComponentInstaller({ root, catalog, supported: true, request: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    requests.push(url);
    return typeof response === 'function' ? response(options.signal) : new Response(response);
  } });
  const install = (signal = new AbortController().signal) => installer.install('antigravity', signal);
  assert.equal(validComponentSelection(['codex', 'claude-sdk']), true);
  assert.equal(validComponentSelection(['antigravity', 'antigravity']), false);
  assert.equal(validComponentSelection(['https://example.com']), false);
  assert.equal(validComponentSelection(['__proto__']), false);
  await assert.rejects(installer.install('codex', new AbortController().signal), { code: 'invalid_component' });

  response = Buffer.from('truncated');
  await assert.rejects(install(), { code: 'component_integrity_failed' });
  assert.equal(await installer.installed('antigravity'), null);
  assert.deepEqual(await readdir(join(root, 'antigravity')), []);

  const started = Promise.withResolvers();
  const cancel = new AbortController();
  response = (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started.resolve();
  });
  const interrupted = install(cancel.signal);
  await started.promise;
  cancel.abort();
  await assert.rejects(interrupted, { code: 'component_cancelled' });
  assert.deepEqual(await readdir(join(root, 'antigravity')), []);

  response = bytes;
  const first = install();
  assert.equal(install(), first);
  const result = await first;
  assert.deepEqual(await readFile(result.agyPath), bytes);
  assert.deepEqual(await install(), result);
  await writeFile(result.agyPath, 'corrupted data');
  assert.equal(await installer.installed('antigravity'), null);
  assert.deepEqual(await install(), result);
  assert.deepEqual(await readFile(result.agyPath), bytes);
  assert.deepEqual(requests, Array(4).fill(pinnedExecutable.href));
});

test('archive installation rejects filenames unsafe for Windows even with a matching digest', async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, 'package'));
  await writeFile(join(root, 'package', 'data.txt'), 'data');
  const archive = join(root, 'fixture.tgz');
  await tar({ cwd: root, file: archive, gzip: true, prefix: 'package/NUL' }, ['package/data.txt']);
  const bytes = await readFile(archive);
  const installer = createComponentInstaller({ root: join(root, 'components'), supported: true,
    catalog: { codex: { version: '1.0.0', packages: [{ name: '@openai/codex-sdk', url: pinnedArchive.href, integrity: sha512(bytes) }] } },
    request: async () => new Response(bytes), stage: { codex() { assert.fail('must reject archive before staging'); } } });
  await assert.rejects(installer.install('codex', new AbortController().signal), { code: 'component_archive_invalid' });
  assert.equal(await installer.installed('codex'), null);
});

test('changing an installed SDK and rewriting its installation stamp cannot change the pinned import', async (t) => {
  const root = await scratch(t);
  const contents = 'export const Codex = class {}';
  const filename = 'node_modules/@openai/codex-sdk/dist/index.js';
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const contentHash = (value) => hash(filename + '\0' + hash(value) + '\n');
  await mkdir(join(root, 'package'));
  await writeFile(join(root, 'package', 'index.js'), contents);
  const archive = join(root, 'fixture.tgz');
  await tar({ cwd: root, file: archive, gzip: true }, ['package/index.js']);
  const bytes = await readFile(archive);
  const installer = createComponentInstaller({ root: join(root, 'components'), supported: true,
    catalog: { codex: { version: '1.0.0', content: contentHash(contents), packages: [
      { name: '@openai/codex-sdk', url: pinnedArchive.href, integrity: sha512(bytes) },
    ] } },
    request: async () => new Response(bytes), stage: { async codex(_modules, payload) {
      await mkdir(join(payload, 'node_modules/@openai/codex-sdk/dist'), { recursive: true });
      await writeFile(join(payload, filename), contents);
    } } });
  const result = await installer.install('codex', new AbortController().signal);
  const changed = 'export const Codex = class Unpinned {}';
  await writeFile(result.sdkEntry, changed);
  const destination = join(root, 'components', 'codex', '1.0.0');
  await writeFile(join(destination, 'verified-component.json'),
    JSON.stringify({ backend: 'codex', version: '1.0.0', content: contentHash(changed) }));
  assert.equal(await installer.installed('codex'), null);
  await installer.install('codex', new AbortController().signal);
  assert.equal(await readFile(result.sdkEntry, 'utf8'), contents);
  assert.deepEqual(await readdir(join(root, 'components', 'codex')), ['1.0.0']);
});

test('installation activates only the selected local records and preserves route and credential ownership after restart', async (t) => {
  const root = await scratch(t);
  let mode = 'browse';
  const reads = [], downloads = [], localCreations = [];
  const installed = new Map();
  const credentials = new Map();
  const makeRuntime = async ({ sdkEntry, backend = 'codex', apiKey, claudeKey }) => ({
    models: backend === 'codex' ? localModels : providerDefaultModels,
    runtimeAvailable: Boolean(sdkEntry), credentialConfigured: () => Boolean(apiKey ?? claudeKey),
    createThread() { localCreations.push(backend); assert.fail('install must never start a turn'); },
  });
  const start = () => startWorkbenchServer({
    webRoot: root, workbenchRoot: join(root, 'remote'), terminalRoot: join(root, 'terminal'),
    runtimeRoot: join(root, 'helper'), localStateRoot: join(root, 'local-sdk'), componentRoot: join(root, 'components'),
    componentMode: 'on-demand', makeLocalRuntime: makeRuntime, makeLocalAgentRuntime: makeRuntime, access: () => ({ mode }),
    makeBridge: () => ({ request() { assert.fail('installation must never initiate a VPS operation'); } }),
    makeSubscriptionHost: () => ({ dispose() {} }),
    localCredentials: {
      read: async (backend) => { reads.push(backend); return credentials.get(backend); },
      write: async (backend, key) => { credentials.set(backend, { key }); },
    },
    makeComponentInstaller: () => ({ supported: true, status: () => ['codex', 'claude-sdk', 'antigravity'].map((backend) => ({ backend })),
      installed: async (backend) => installed.get(backend),
      async install(backend) {
        downloads.push(backend);
        if (backend === 'antigravity') throw Object.assign(new Error(), { code: 'component_download_failed' });
        const result = { sdkEntry: backend + '-fixture' };
        installed.set(backend, result);
        return result;
      },
    }),
  });
  let host = await start();
  t.after(() => host?.close());
  assert.equal(host.localComponentsStatus().mode, 'on-demand');
  assert.deepEqual(host.localStatus().profiles, []);
  assert.equal((await host.installLocalComponents(['codex'])).code, 'browse_only');
  assert.equal((await host.installLocalComponents(['codex', '../path'])).code, 'invalid_component');
  mode = 'execute';
  assert.deepEqual(await host.installLocalComponents(['claude-sdk', 'antigravity']), { ok: false,
    results: [{ backend: 'claude-sdk', ok: true }, { backend: 'antigravity', ok: false, code: 'component_download_failed' }] });
  const [profile] = host.localStatus().profiles;
  assert.equal(profile.backend, 'claude-sdk');
  assert.match(profile.directory, /installed-workspaces[\\/]claude-sdk$/u);
  assert.equal((await host.saveLocalCredential('codex', 'unused')).code, 'credential_unavailable');
  assert.equal((await host.saveLocalCredential('claude-sdk', 'fixture-key')).ok, true);
  assert.equal(host.localStatus().providers.find(({ backend }) => backend === 'codex').credentialConfigured, false);
  assert.equal(host.localStatus().providers.find(({ backend }) => backend === 'claude-sdk').credentialConfigured, true);
  assert.deepEqual(downloads, ['claude-sdk', 'antigravity']);
  assert.equal(host.localComponentsStatus().items.filter(({ ready }) => ready).length, 1);
  assert.equal((await host.installLocalComponents(['claude-sdk'])).ok, true);
  assert.deepEqual(host.localStatus().profiles, [profile]);
  await host.close();
  host = await start();
  assert.deepEqual(host.localStatus().profiles, [profile]);
  assert.equal(host.localComponentsStatus().items.find(({ backend }) => backend === 'claude-sdk').ready, true);
  assert.equal(host.localStatus().providers.find(({ backend }) => backend === 'claude-sdk').credentialConfigured, true);
  assert.deepEqual(downloads, ['claude-sdk', 'antigravity']);
  assert.deepEqual(localCreations, []);
  assert.ok(reads.includes('claude-sdk'));
});

test('local credentials use separate encrypted files and abort without overwriting a committed key', async (t) => {
  const root = await scratch(t);
  const key = 'sk-test-1234567890';
  const claude = 'sk-ant-fixture-1234567890';
  const keys = new Map();
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const token = createHash('sha256').update(value).digest();
      keys.set(token.toString('hex'), value);
      return token;
    },
    decryptString(value) { return keys.get(value.toString('hex')); },
  };
  const credentials = openLocalCredentials({ root, encryption, platform: 'win32' });
  await credentials.write('codex', key, () => true);
  await credentials.write('claude-sdk', claude, () => true);
  await assert.rejects(credentials.write('claude-sdk', key, () => true), { code: 'invalid_key' });
  await assert.rejects(credentials.write('codex', claude, () => true), { code: 'invalid_key' });
  await assert.rejects(credentials.write('codex', key + '-other', () => false), { code: 'browse_only' });
  assert.deepEqual(await readdir(root), ['claude-sdk.bin', 'codex.bin']);
  assert.deepEqual(await credentials.read('codex'), { key });
  assert.deepEqual(await credentials.read('claude-sdk'), { key: claude });
  assert.ok(!(await readFile(join(root, 'codex.bin'))).includes(key));
  assert.equal(await credentials.read('antigravity'), null);
});

test('Antigravity login hands the approved Windows executable its own profile and never starts before permission', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await scratch(t);
  const agyPath = join(root, 'agy.exe');
  const stateRoot = join(root, 'state');
  const fixture = 'test executable, never started';
  await writeFile(agyPath, fixture);
  const calls = [];
  const runtime = await openLocalAgentRuntime({ backend: 'antigravity', runtimeRoot: root, stateRoot,
    agyPath, agyHash: createHash('sha256').update(fixture).digest('hex'),
    environment: { SystemRoot: process.env.SystemRoot, ANTHROPIC_API_KEY: 'unexpected', SSH_CONNECTION: 'unexpected' },
    isWindowsX64: true,
    launchLogin: async (...args) => { calls.push(args); },
  });
  const profile = { id: 'test-profile' };
  assert.equal(runtime.runtimeAvailable, true);
  assert.deepEqual(await runtime.login(profile, () => false), { ok: false, code: 'browse_only' });
  assert.deepEqual(calls, []);
  assert.equal((await runtime.login(profile, () => true)).ok, true);
  const [binary, directory, environment] = calls[0];
  assert.equal(binary, agyPath);
  assert.equal(directory, join(stateRoot, 'accounts', profile.id));
  assert.equal(environment.HOME, directory);
  assert.equal(environment.USERPROFILE, directory);
  assert.equal(environment.SSH_CONNECTION, undefined);
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  await writeFile(agyPath, 'modified');
  await assert.rejects(runtime.login(profile, () => true), { code: 'invalid_environment' });
  assert.equal(calls.length, 1);
});

test('personal Claude subscription uses its own login, threads and account directory without API or SSH fallback', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await scratch(t);
  const runtimeRoot = join(root, 'helper');
  const binary = join(runtimeRoot, 'local-claude', 'claude.exe');
  await mkdir(join(runtimeRoot, 'local-claude'), { recursive: true });
  await writeFile(binary, 'fixture: never executed');
  const profileFields = { backend: 'claude-sdk', directory: root, name: 'Claude', model: 'default', effort: 'default' };
  const personalFields = { ...profileFields, authMode: 'subscription' };
  const key = 'sk-ant-api03-fixture-' + 'a'.repeat(48);
  const logins = [], probes = [], queries = [];
  let access = 'execute';
  let login = { loggedIn: false };
  const start = (personalClaudeSubscription) => startWorkbenchServer({
    webRoot: root, terminalRoot: root, workbenchRoot: join(root, 'ssh'), runtimeRoot, personalClaudeSubscription,
    localStateRoot: join(root, 'sdk'), access: () => ({ mode: access }),
    makeBridge: () => ({ request() { assert.fail('subscription must not use SSH'); } }),
    makeSubscriptionHost: () => ({ dispose() {} }),
    localAgentOptions: {
      claudeKey: key, isWindowsX64: true,
      environment: { SystemRoot: process.env.SystemRoot, ANTHROPIC_API_KEY: 'inherited', ANTHROPIC_AUTH_TOKEN: 'inherited',
        CLAUDE_CODE_OAUTH_TOKEN: 'inherited', ANTHROPIC_BASE_URL: 'inherited', HTTPS_PROXY: 'inherited', SSH_CONNECTION: 'inherited',
        CLAUDE_CONFIG_DIR: 'inherited' },
      inspectClaudeLogin: async (...args) => { probes.push(args); return login; },
      launchClaudeLogin: async (...args) => { logins.push(args); },
      loadClaude: async () => ({ async *query({ prompt, options }) {
        queries.push(options);
        const session_id = options.sessionId ?? options.resume;
        const input = await prompt[Symbol.asyncIterator]().next();
        yield { session_id, type: 'system', subtype: 'init' };
        yield { session_id, type: 'assistant', message: { id: 'reply', content: [{ type: 'text', text: '订阅夹具' }] } };
        yield { session_id, type: 'result', subtype: 'success', is_error: false, user_message_uuids: [input.value.uuid] };
      } }),
    },
  });
  let host = await start(false);
  t.after(() => host.close());
  const claude = () => host.localStatus().providers.find(({ backend }) => backend === 'claude-sdk');
  assert.equal(claude().personalSubscriptionAvailable, undefined);
  assert.equal((await host.registerLocalProfile(personalFields)).code, 'invalid_profile');
  const apiProfile = (await host.registerLocalProfile(profileFields)).profile;
  await host.close();
  host = await start(true);
  assert.equal(claude().personalSubscriptionAvailable, true);
  const { profile } = await host.registerLocalProfile(personalFields);
  assert.ok(profile);
  assert.equal(profile.authMode, 'subscription');
  assert.notEqual(profile.targetId, apiProfile.targetId);
  assert.notEqual(profile.accountDirectory, apiProfile.accountDirectory);
  assert.equal((await host.registerLocalProfile(personalFields)).profile.id, profile.id);
  assert.equal((await host.checkLocalClaudeSubscription(apiProfile.id)).code, 'credential_unavailable');
  access = 'browse';
  assert.equal((await host.loginLocalClaudeSubscription(profile.id)).code, 'browse_only');
  assert.equal((await host.checkLocalClaudeSubscription(profile.id)).code, 'browse_only');
  assert.deepEqual([logins.length, probes.length, queries.length], [0, 0, 0]);
  access = 'execute';
  assert.deepEqual(await host.loginLocalClaudeSubscription(profile.id), { ok: true });
  assert.deepEqual(logins[0].slice(0, 2), [binary, profile.accountDirectory]);
  assert.deepEqual(await host.checkLocalClaudeSubscription(profile.id), { ok: true, status: 'sign_in_required' });
  const request = (selected, op, sessionId, turnId) => host.requestLocal({ location: 'local-sdk', backend: 'claude-sdk', op: 'workbench',
    payload: { op, settings: { location: 'local-sdk', provider: 'claude-sdk', profileId: selected.id },
      targetId: selected.targetId, sessionId, turnId, ...(op === 'send' && { prompt: '夹具对话' }) } });
  async function turn(selected, state, sessionId = randomUUID()) {
    const turnId = randomUUID();
    assert.equal((await request(selected, 'send', sessionId, turnId)).ok, true);
    for (let i = 0; i < 100; i++) {
      const result = await request(selected, 'refresh', sessionId, turnId);
      const row = result.session?.turns.find(({ id }) => id === turnId);
      if (row?.state === state) return row;
      await wait(25);
    }
    assert.fail('expected turn state ' + state);
  }
  assert.equal((await turn(profile, 'failed')).code, 'auth_required');
  assert.deepEqual(queries, []);
  login = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', subscriptionType: 'pro' };
  assert.equal((await host.checkLocalClaudeSubscription(profile.id)).status, 'sign_in_required');
  login.authMethod = 'claude.ai';
  login.configDirectory = apiProfile.accountDirectory;
  assert.equal((await host.checkLocalClaudeSubscription(profile.id)).status, 'unknown');
  login.configDirectory = profile.accountDirectory;
  login.email = 'not-returned@example.test';
  assert.deepEqual(await host.checkLocalClaudeSubscription(profile.id), { ok: true, status: 'signed_in' });
  const session = randomUUID();
  assert.match((await turn(profile, 'complete', session)).reply, /订阅夹具/);
  const { env, sessionId: nativeId } = queries[0];
  assert.ok(nativeId);
  assert.deepEqual(env, logins[0][2]);
  assert.deepEqual(env, probes.at(-1)[2]);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'SSH_CONNECTION']) {
    assert.equal(env[name], undefined);
  }
  await host.close();
  host = await start(true);
  assert.equal((await turn(profile, 'complete', session)).state, 'complete');
  assert.equal(queries[1].resume, nativeId);
  assert.equal(queries[1].env.CLAUDE_CONFIG_DIR, profile.accountDirectory);
  login = { loggedIn: false };
  assert.equal((await turn(profile, 'failed', session)).code, 'auth_required');
  const probeCount = probes.length;
  await turn(apiProfile, 'complete');
  assert.equal(probes.length, probeCount);
  assert.equal(queries[2].env.ANTHROPIC_API_KEY, key);
  assert.equal(queries[2].env.CLAUDE_CONFIG_DIR, apiProfile.accountDirectory);
  await host.close();
  host = await start(false);
  assert.ok(claude().profiles.some(({ id }) => id === profile.id));
  assert.equal((await host.loginLocalClaudeSubscription(profile.id)).code, 'credential_unavailable');
  assert.equal((await request(profile, 'send', session, randomUUID())).code, 'auth_required');
  assert.equal(queries.length, 3);
});
