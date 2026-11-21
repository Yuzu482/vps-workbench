// Invoke with the installed DSH Desktop executable in Electron's Node mode.
// The fixture deliberately uses a separate DSH home and dummy SSH files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

if (!process.versions.electron || !process.resourcesPath || process.argv.length !== 3) {
  throw new Error('Run this fixture with the DSH Desktop executable and one local archive path.');
}
const archive = resolve(process.argv[2]);
const runtime = join(process.resourcesPath, 'app.asar', 'node_modules');
const loadModule = name => import(pathToFileURL(join(runtime, name)));
const { createGenerationPackageBackend } = await loadModule('dsh-desktop-market-installer/generations/package-backend.mjs');
const { Context } = await loadModule('@deepseek-ai/cordis/lib/index.js');
const tempDirectory = await realpath(tmpdir());
const home = await mkdtemp(join(tempDirectory, 'dsh-vps-chat-loader-'));
const profile = 'vps-chat-fixture';
const packageName = 'dsh-vps-chat-workbench';
const profileDir = join(home, 'profiles', profile);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

try {
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'vps-chat-profile-fixture', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }));
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n');
  const source = join(home, 'source');
  await mkdir(source);
  const tar = join(process.env.SystemRoot, 'System32/tar.exe');
  const entries = execFileSync(tar, ['-tzf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 }).trim().split(/\r?\n/);
  assert.ok(entries.includes('package/package.json'));
  assert.ok(entries.every(entry => /^package\/[a-z0-9.\-/]+$/i.test(entry) && !entry.split('/').includes('..')));
  execFileSync(tar, ['-xzf', archive, '-C', source], { windowsHide: true });
  const sourceDirectory = join(source, 'package');
  const expectedVersion = (await readJson(join(sourceDirectory, 'package.json'))).version;
  const backend = createGenerationPackageBackend({
    dshHome: home,
    profile,
    nodeExecutablePath: process.execPath,
    dshEntryPath: join(runtime, '@deepseek-ai/dsh/lib/bin.js'),
    pnpmEntryPath: join(runtime, 'pnpm/bin/pnpm.cjs'),
    environment: {
      ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1',
      npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
    },
  });
  const installed = await backend.install({
    kind: 'path', spec: sourceDirectory, path: sourceDirectory, expectedName: packageName, expectedVersion, autoInstallPeers: false,
  });
  assert.equal(installed.packageResult?.exitCode, 0, installed.packageResult?.output?.slice(-2500));
  assert.equal(installed.bundle, packageName);
  installed.commit();
  const installedDir = join(profileDir, 'node_modules', packageName);
  const profileManifest = await readJson(join(profileDir, 'package.json'));
  assert.ok(Object.hasOwn(profileManifest.dependencies, packageName));
  // The Desktop manager selects the bundle in its separate activation step.
  // Select only the new bundle in this disposable profile before mounting it.
  profileManifest.dsh.profile.bundles = [packageName];
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(profileManifest));
  const manifest = await readJson(join(installedDir, 'package.json'));
  assert.equal(manifest.version, expectedVersion);
  assert.deepEqual(manifest.dsh.client.inject, ['dsh-desktop-workbenches', '@deepseek-ai/dsh-api-workspace-controller']);
  const client = await readFile(join(installedDir, manifest.exports['./client']), 'utf8');
  let handoff;
  runInNewContext(client, {
    TextEncoder, window: { __ModuleLoader__: { load(packet) { handoff = packet; } } },
  }, { timeout: 3000 });
  assert.equal(handoff?.id, packageName);
  const platform = new Map([
    ['react', { createElement() {}, memo(component) { return component; } }],
    ['@deepseek-ai/dsh-client-ui-primitives', { CodeBlock() {}, async writeClipboard() { return false; } }],
  ]);
  const clientPlugin = handoff.factory(id => {
    assert.ok(platform.has(id), 'Unsupported Desktop platform module');
    return platform.get(id);
  });
  assert.equal(typeof clientPlugin.apply, 'function');
  assert.deepEqual(Array.from(clientPlugin.inject), ['desktopWorkbenches', 'workspaces']);
  const plugin = await import(pathToFileURL(join(installedDir, manifest.main)));
  assert.equal(plugin.name, packageName);
  const context = new Context();
  const routes = new Map();
  const upgrades = new Map();
  const server = createServer((req, res) => {
    const handler = routes.get(req.url);
    if (handler) return handler(req, res);
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    const handler = upgrades.get(req.url);
    if (handler) handler(req, socket, head);
    else socket.destroy();
  });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  try {
    const port = server.address().port;
    context.provide('webServer', {
      port,
      register({ kind, path, handler }) {
        assert.equal(kind, 'exact');
        assert.ok(!routes.has(path));
        routes.set(path, handler);
        return () => routes.delete(path);
      },
      registerUpgrade({ path, handler }) {
        assert.ok(!upgrades.has(path));
        upgrades.set(path, handler);
        return () => upgrades.delete(path);
      },
    });
    const stateRoot = join(home, 'vps-chat-workbench');
    const fiber = await context.plugin(plugin, { root: stateRoot });
    const base = `http://127.0.0.1:${port}${plugin.prefix}`;
    const requestHeaders = { 'X-DSH-VPS-CHAT': '1' };
    assert.ok(upgrades.has(plugin.prefix + 'account-screen'));
    const viewer = await fetch(base + 'account-player.mjs');
    assert.equal(viewer.status, 200);
    assert.match(viewer.headers.get('Content-Type'), /^text\/javascript/);
    assert.match(await viewer.text(), /export\s*\{/);
    const boot = await fetch(base + 'token', { headers: requestHeaders });
    assert.equal(boot.status, 200);
    const { token } = await boot.json();
    const identityPath = join(home, 'fixture-key');
    const knownHostsPath = join(home, 'fixture-known-hosts');
    await writeFile(identityPath, 'not-a-real-key');
    await writeFile(knownHostsPath, '# dummy pin fixture\n');
    const rpc = body => fetch(base + 'rpc', {
      method: 'POST',
      headers: { ...requestHeaders, 'X-DSH-VPS-CHAT-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const settings = {
      host: 'fixture.invalid', port: 22, user: 'fixture', identityPath, knownHostsPath,
      workspace: '/fixture', expectedIpv4: '192.0.2.18', expectedIpv6: '', hostKeyConfirmed: true, provider: 'codex',
    };
    assert.deepEqual(await (await rpc({ op: 'preset' })).json(), { ok: true, preset: null });
    const response = await rpc({ op: 'list', settings });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.targetId, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.sessions, []);
    await mkdir(stateRoot);
    const stored = { name: 'fixture', settings, targetId: result.targetId };
    await writeFile(join(stateRoot, 'default-target.json'), JSON.stringify(stored));
    assert.deepEqual(await (await rpc({ op: 'preset' })).json(), {
      ok: true, preset: { ...stored, sessions: [] },
    });
    const claudeSettings = { ...settings, provider: 'claude' };
    const claudeTarget = await (await rpc({ op: 'list', settings: claudeSettings })).json();
    assert.equal(claudeTarget.ok, true);
    const claudeModels = await (await rpc({
      op: 'models', settings: claudeSettings, targetId: claudeTarget.targetId,
    })).json();
    assert.equal(claudeModels.ok, true);
    assert.deepEqual(claudeModels.models.map(({ id }) => id), ['sonnet', 'opus', 'haiku']);
    if (expectedVersion.includes('-sdk.')) {
      const sdkSettings = { ...settings, provider: 'claude-sdk' };
      const sdk = await (await rpc({ op: 'list', settings: sdkSettings })).json();
      assert.equal(sdk.ok, true);
      assert.notEqual(sdk.targetId, result.targetId);
      assert.notEqual(sdk.targetId, claudeTarget.targetId);
      assert.deepEqual(sdk.sessions, []);
      const catalog = await (await rpc({ op:'models', settings:sdkSettings, targetId:sdk.targetId })).json();
      assert.equal(catalog.ok, true);
      assert.deepEqual(catalog.models.map(({ id }) => id), ['sonnet', 'opus', 'haiku']);
      const send = await (await rpc({
        op:'send', settings:sdkSettings, targetId:sdk.targetId,
        sessionId:'11111111-1111-4111-8111-111111111111', turnId:'22222222-2222-4222-8222-222222222222',
        prompt:'isolated SDK probe',
      })).json();
      assert.equal(send.code, 'relay_required');
    }
    assert.equal((await (await rpc({ op: 'models', settings, targetId: result.targetId })).json()).code, 'relay_required');
    assert.equal((await (await rpc({ op: 'account-view', targetId: result.targetId })).json()).code, 'relay_required');
    await writeFile(knownHostsPath, '# changed pin fixture\n');
    assert.equal((await (await rpc({ op: 'preset' })).json()).code, 'target_changed');
    await fiber.dispose();
    assert.equal(routes.size, 0);
    assert.equal(upgrades.size, 0);
  } finally {
    await new Promise(close => server.close(close));
  }
  console.log('PASS: packaged Desktop installer, actual Cordis registration, and isolated list via the packaged helper');
} finally {
  const actual = await realpath(home);
  if (dirname(actual) !== tempDirectory || !/^dsh-vps-chat-loader-[a-z0-9]+$/i.test(basename(actual))) {
    throw new Error('Could not verify the temporary profile path for cleanup.');
  }
  await rm(actual, { recursive: true, force: true });
}
