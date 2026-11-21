import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { openLocalSdk } from '../local-sdk/service.mjs';
import { localCredentialVariable, localModels } from './codex-runtime.mjs';
import { openAppData } from './data.mjs';
import { startPreview } from './preview-server.mjs';

const require = createRequire(import.meta.url);
const { chromium, _electron } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const { version } = require('../package.json');
const executable = resolve(process.env.VPS_WORKBENCH_TEST_EXE || `dist/VPS-Workbench-${version}-win-x64/VPS Workbench.exe`);
const locationKey = 'dsh-vps-chat:desktop-view-location:v1';
const defaultKey = 'dsh-vps-chat:desktop-new-location:v1';

async function selectLocal(page) {
  await page.getByRole('button', { name: '本机 SDK', exact: true }).click();
  await page.getByRole('heading', { name: '本地 Codex SDK', exact: true }).waitFor();
}

async function registerProfile(page, name) {
  await page.getByRole('button', { name: '本机配置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '本机配置' });
  await dialog.getByLabel('配置名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '选择工作目录并保存' }).click();
  await page.getByRole('button', { name: '配置 · ' + name, exact: true }).waitFor({ state: 'attached' });
  if (await dialog.isVisible()) await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
}

test('mock preview streams Local Codex, holds route binding, stops and restores selected history', { timeout: 45_000 }, async (t) => {
  const preview = await startPreview({ port: 0, watch: false });
  t.after(() => preview.close());
  const browser = await chromium.launch({ channel: 'msedge', args: ['--disable-background-networking', '--no-proxy-server'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 365, height: 480 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route) => route.request().url().startsWith(preview.origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(7000);
  const state = await (await fetch(preview.origin + '/__preview/state')).json();
  Object.assign(state.preferences, { [locationKey]: 'local-sdk', [defaultKey]: 'local-sdk' });
  await page.addInitScript(({ state, origin }) => {
    if (location.origin !== origin || sessionStorage.getItem('vps-workbench-preview-state')) return;
    sessionStorage.setItem('vps-workbench-preview-state', JSON.stringify(state));
  }, { state, origin: preview.origin });
  await page.goto(preview.origin);
  await selectLocal(page);
  await registerProfile(page, '只读测试');
  const draft = page.getByRole('textbox', { name: '本地对话草稿' });
  const submit = page.getByRole('button', { name: '发送', exact: true });
  await draft.fill('本机首轮');
  const box = await submit.boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 365 && box.y + box.height <= 480);
  await draft.press('Enter');
  await page.locator('[data-turn-state=running]').getByRole('heading', { name: '本机 SDK 演示' }).waitFor();
  await page.getByLabel('新建位置').selectOption('ssh-vps');
  await page.locator('[data-turn-state=completed]').getByText('收到 本机首轮', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '本机 SDK', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.ok(!requests.some((url) => /dsh-vps-chat|dsh-terminal-workbench/.test(url)));

  await draft.fill('本机续聊');
  await submit.click();
  await page.locator('[data-turn-state=completed]').getByRole('heading', { name: '续聊演示' }).waitFor();
  await draft.fill('本机停止轮');
  await submit.click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.locator('[data-turn-state=unknown]').getByText('本机停止轮', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查询回执', exact: true }).click();
  await page.getByRole('button', { name: '允许执行', exact: true }).click();
  await page.getByRole('button', { name: '仅浏览', exact: true }).waitFor();
  await draft.fill('浏览草稿');
  assert.equal(await submit.isDisabled(), true);

  await page.getByRole('button', { name: 'VPS SSH', exact: true }).click();
  await page.getByRole('complementary', { name: 'VPS 对话列表', includeHidden: true }).waitFor({ state: 'attached' });
  await selectLocal(page);
  assert.equal(await draft.inputValue(), '浏览草稿');
  await page.reload();
  await selectLocal(page);
  await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click();
  await page.getByRole('button', { name: '本机首轮', exact: true }).click();
  await page.locator('[data-turn-state=completed]').getByText('收到 本机续聊', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('staged Windows app loads the pinned native files and restores local records without SSH or credentials', {
  timeout: 55_000,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-sdk-package-test-')));
  const dataRoot = join(root, 'data');
  const appData = join(root, 'appdata');
  const directory = join(root, '只读项目');
  const appRoot = join(dirname(executable), 'resources', 'app');
  const codexDirectory = join(appRoot, 'helper', 'local-codex');
  const binary = join(codexDirectory, 'bin', 'codex.exe');
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [dataRoot, appData, directory]) await mkdir(dir);
  const exeVersion = execFileSync(binary, ['--version'], { timeout: 7000, windowsHide: true, encoding: 'utf8',
    env: { SystemRoot: process.env.SystemRoot } });
  assert.equal(exeVersion.trim(), 'codex-cli 0.166.0');
  for (const relative of ['helper/local-codex/LICENSE', 'node_modules/@openai/codex-sdk/LICENSE',
    'helper/local-codex/codex-resources/codex-command-runner.exe', 'helper/local-codex/codex-resources/codex-windows-sandbox-setup.exe']) {
    assert.ok((await readFile(join(appRoot, relative))).length > 100);
  }
  const data = await openAppData(dataRoot);
  await data.setPreference(locationKey, 'local-sdk');
  await data.setPreference(defaultKey, 'local-sdk');
  await data.flush();
  const env = { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, VPS_WORKBENCH_DATA_DIR: dataRoot,
    [localCredentialVariable]: '' };
  const errors = [], vpsRequests = [];
  let desktop;
  t.after(async () => { await desktop?.close(); });
  async function boot() {
    desktop = await _electron.launch({ executablePath: executable, cwd: root, env, timeout: 15_000 });
    const page = await desktop.firstWindow({ timeout: 10_000 });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      const url = request.url();
      if (/dsh-vps-chat|dsh-terminal-workbench/.test(url)) vpsRequests.push(url);
    });
    page.setDefaultTimeout(9000);
    await page.getByText('SDK 可用 · 凭据未配置', { exact: true }).waitFor();
    return page;
  }
  try {
    let page = await boot();
    assert.deepEqual(await desktop.evaluate(() => [process.platform, process.arch, process.versions.electron]),
      ['win32', 'x64', '44.7.0']);
    await desktop.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, directory);
    await registerProfile(page, '包内本机配置');
    const status = await page.evaluate(() => window.vpsWorkbench.localSdkStatus());
    const profile = status.profiles[0];
    assert.equal(profile.directory, directory);
    const binding = { location: 'local-sdk', backend: 'codex', profileId: profile.id,
      targetId: profile.targetId, sessionId: 'local-' + randomUUID() };
    const turn = { ...binding, op: 'send', turnId: randomUUID(), prompt: '包内历史' };
    const dispatch = (packet) => page.evaluate((body) => window.vpsWorkbench.localSdkRequest(body), packet);
    assert.equal((await dispatch(turn)).code, 'auth_required');
    assert.equal((await dispatch({ ...turn, settings: {} })).code, 'invalid_request');
    await desktop.close();
    desktop = undefined;

    let calls = 0;
    const store = await openLocalSdk({ root: join(dataRoot, 'local-sdk'), models: localModels,
      canExecute: () => true, credentialConfigured: () => true,
      createThread() {
        calls++;
        return { async runStreamed() { return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'packaged-history-fixture' };
          yield { type: 'item.completed', item: { id: 'demo', type: 'agent_message', text: '### 重新打开的历史' } };
          yield { type: 'turn.completed' };
        })() }; } };
      },
    });
    try {
      assert.equal((await store.request(turn)).ok, true);
      for (let elapsed = 0; elapsed < 1000;) {
        const receipt = await store.request({ ...binding, turnId: turn.turnId, op: 'refresh' });
        if (receipt.session.turns[0].state === 'completed') break;
        await wait(20);
        elapsed += 20;
      }
    } finally { await store.close(); }
    assert.equal(calls, 1);
    page = await boot();
    await page.getByRole('button', { name: '包内历史', exact: true }).click();
    await page.getByRole('heading', { name: '重新打开的历史' }).waitFor();
    await page.getByRole('button', { name: '允许执行', exact: true }).click();
    await page.getByRole('button', { name: '仅浏览', exact: true }).waitFor();
    assert.equal((await dispatch({ ...turn, turnId: randomUUID() })).code, 'browse_only');
    assert.deepEqual(vpsRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    desktop = undefined;
  }
});

test('the staged Windows Codex sandbox reads a fixture and refuses a write', { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'local-sdk-sandbox-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'codex-home'), scratch = join(root, 'temp');
  await mkdir(home);
  await mkdir(scratch);
  await writeFile(join(root, 'marker.txt'), 'WORKBENCH_READ_ONLY_FIXTURE');
  const binary = join(dirname(executable), 'resources', 'app', 'helper', 'local-codex', 'bin', 'codex.exe');
  const system = join(process.env.SystemRoot, 'System32');
  const command = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = { SystemRoot: process.env.SystemRoot, ProgramData: process.env.ProgramData,
    APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE,
    PATH: system, CODEX_HOME: home, TEMP: scratch, TMP: scratch };
  const run = (script) => spawnSync(binary, ['sandbox', '-c', 'windows.sandbox="unelevated"', '-P', ':read-only',
    '--include-managed-config', '-C', root, '--', command, '-NoProfile', '-NonInteractive', '-Command', script],
  { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 9000 });
  const read = run('Get-Content -LiteralPath marker.txt -ErrorAction Stop');
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout.trim(), 'WORKBENCH_READ_ONLY_FIXTURE');
  const write = run('Set-Content -LiteralPath blocked.txt -Value blocked -ErrorAction Stop');
  assert.equal(write.status, 1, write.stderr);
  assert.match(write.stderr, /GetContentWriterUnauthorizedAccessError/);
  await assert.rejects(readFile(join(root, 'blocked.txt')), { code: 'ENOENT' });
});
