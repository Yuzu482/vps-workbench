import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { componentCatalog } from './component-catalog.mjs';
import { localCredentialVariable } from './codex-runtime.mjs';
import { agyHashVariable, agyPathVariable, claudeKeyVariable } from './local-agent-runtime.mjs';

const require = createRequire(import.meta.url);
const { _electron } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');

test('thin Windows candidate installs the locked official runtimes from offline archives and reopens the same profiles', {
  timeout: 150_000,
}, async (t) => {
  assert.ok(process.env.VPS_WORKBENCH_TEST_EXE && process.env.VPS_WORKBENCH_TEST_COMPONENT_ARCHIVES,
    'Set VPS_WORKBENCH_TEST_EXE and VPS_WORKBENCH_TEST_COMPONENT_ARCHIVES to the on-demand package and pinned npm archives.');
  const exe = resolve(process.env.VPS_WORKBENCH_TEST_EXE);
  const cache = resolve(process.env.VPS_WORKBENCH_TEST_COMPONENT_ARCHIVES);
  const archives = {
    [componentCatalog.codex.packages[0].url]: join(cache, 'openai-codex-sdk-0.166.0.tgz'),
    [componentCatalog.codex.packages[1].url]: join(cache, 'openai-codex-0.166.0-win32-x64.tgz'),
    [componentCatalog['claude-sdk'].packages[0].url]: join(cache, 'anthropic-ai-claude-agent-sdk-0.3.296.tgz'),
    [componentCatalog['claude-sdk'].packages[1].url]: join(cache, 'anthropic-ai-claude-agent-sdk-win32-x64-0.3.296.tgz'),
  };
  await Promise.all(Object.values(archives).map((path) => stat(path)));
  const appRoot = join(dirname(exe), 'resources', 'app');
  assert.equal(JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).componentMode, 'on-demand');
  await assert.rejects(stat(join(appRoot, 'helper', 'local-codex')), { code: 'ENOENT' });
  await assert.rejects(stat(join(appRoot, 'helper', 'local-claude')), { code: 'ENOENT' });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vps-thin-package-')));
  const data = join(root, 'data');
  const appData = join(root, 'appdata');
  await mkdir(appData);
  let desktop;
  t.after(async () => {
    await desktop?.close();
    await rm(root, { recursive: true, force: true });
  });
  const env = { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, VPS_WORKBENCH_DATA_DIR: data,
    [localCredentialVariable]: '', [claudeKeyVariable]: '', [agyPathVariable]: '', [agyHashVariable]: '' };
  async function launch() {
    desktop = await _electron.launch({ executablePath: exe, cwd: root, env, timeout: 30_000 });
    const page = await desktop.firstWindow({ timeout: 25_000 });
    page.setDefaultTimeout(12_000);
    await desktop.evaluate((_electron, paths) => {
      const fs = process.getBuiltinModule('node:fs');
      const { Readable } = process.getBuiltinModule('node:stream');
      globalThis.fixtureRequests = [];
      globalThis.fetch = async (url) => {
        globalThis.fixtureRequests.push(url);
        if (!Object.hasOwn(paths, url)) throw new Error('unexpected_network');
        return new Response(Readable.toWeb(fs.createReadStream(paths[url])));
      };
    }, archives);
    return page;
  }
  let page = await launch();
  const settings = () => page.getByRole('dialog', { name: '设置' });
  const installer = () => settings().getByRole('region', { name: '可选本机组件' });
  await installer().waitFor();
  assert.deepEqual(await desktop.evaluate(() => [process.platform, process.arch, process.versions.electron]), ['win32', 'x64', '44.7.0']);
  assert.deepEqual(await desktop.evaluate(() => globalThis.fixtureRequests), []);
  assert.equal(await page.evaluate(async () => (await window.vpsWorkbench.localSdkStatus()).profiles.length), 0);
  await installer().getByRole('checkbox', { name: 'Codex', exact: true }).check();
  await installer().getByRole('checkbox', { name: 'Claude Agent SDK', exact: true }).check();
  await installer().getByRole('button', { name: '安装所选组件' }).click();
  await installer().getByText('已就绪', { exact: true }).nth(1).waitFor({ timeout: 75_000 });
  assert.deepEqual(await desktop.evaluate(() => globalThis.fixtureRequests), Object.keys(archives));
  const status = await page.evaluate(() => window.vpsWorkbench.localSdkStatus());
  assert.deepEqual(status.profiles.map(({ backend }) => backend), ['codex', 'claude-sdk']);
  assert.equal(new Set(status.profiles.map(({ directory }) => directory)).size, 2);
  assert.equal(status.providers.find(({ backend }) => backend === 'antigravity').runtimeAvailable, false);
  const codex = join(data, 'components', 'codex', componentCatalog.codex.version, 'helper', 'local-codex', 'bin', 'codex.exe');
  const claude = join(data, 'components', 'claude-sdk', componentCatalog['claude-sdk'].version, 'helper', 'local-claude', 'claude.exe');
  const cliVersion = (file) => execFileSync(file, ['--version'], { timeout: 8000, windowsHide: true, encoding: 'utf8',
    env: { SystemRoot: process.env.SystemRoot, USERPROFILE: root, HOME: root, APPDATA: appData, LOCALAPPDATA: appData } }).trim();
  assert.equal(cliVersion(codex), 'codex-cli 0.166.0');
  assert.match(cliVersion(claude), /^2[.]1[.]296\b/u);
  await installer().getByRole('button', { name: '前往模型与账号' }).click();
  const fakeKey = 'sk-test-fixture-1234567890';
  await settings().getByLabel('查看本机账号配置').selectOption(status.profiles[0].id);
  await settings().getByLabel('Codex 本机 API 密钥').fill(fakeKey);
  await settings().getByRole('button', { name: '保存本机密钥' }).click();
  await settings().getByText('本机密钥已保存。可在连接设置主动试跑。', { exact: true }).waitFor();
  const encrypted = await readFile(join(data, 'local-credentials', 'codex.bin'));
  assert.ok(encrypted.length && !encrypted.includes(fakeKey));
  assert.equal(await page.evaluate(async () => (await window.vpsWorkbench.localSdkStatus()).providers[1].credentialConfigured), false);
  await desktop.close();
  desktop = undefined;
  page = await launch();
  const restored = await page.evaluate(() => window.vpsWorkbench.localSdkStatus());
  assert.deepEqual(restored.profiles, status.profiles);
  assert.deepEqual(restored.providers.map(({ runtimeAvailable, credentialConfigured }) =>
    [runtimeAvailable, credentialConfigured]), [[true, true], [true, false], [false, false]]);
  assert.equal(await settings().isVisible(), false);
  assert.equal(await page.locator('.desktop-location-tabs button[aria-pressed=true]').innerText(), 'VPS SSH');
  assert.deepEqual(await desktop.evaluate(() => globalThis.fixtureRequests), []);
});
