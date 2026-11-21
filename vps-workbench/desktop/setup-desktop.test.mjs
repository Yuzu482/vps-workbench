import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { agentPresetKey, applyAgentPresetChange } from '../agent-presets/state.mjs';
import { extensionPreferenceKey } from '../extensions/state.mjs';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { setupConnectionKey, readSetupPreset } from './setup-state.mjs';

const require = createRequire(import.meta.url);
const { _electron } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const { version } = require('../package.json');
const executable = resolve(process.env.VPS_WORKBENCH_TEST_EXE ||
  `dist/VPS-Workbench-${version}-win-x64/VPS Workbench.exe`);

test('a fresh desktop connection diagnoses each setup step and runs the sample on the checked VPS route', { timeout: 65_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'vps-setup-desktop-'));
  const fixture = createPreviewFixtures();
  const { settings, targetId } = fixture.chat({ op: 'preset' }).preset;
  const preferencesFile = join(root, 'preferences.json');
  const localAppData = join(root, 'local');
  const presetId = '9924132c-8737-48be-aebf-9f9c31286cf5';
  const server = { id: 'fixture-status', targetId };
  const agent = applyAgentPresetChange([], { op: 'save', id: presetId, revision: null, draft: {
    name: '接入验证 Agent',
    modules: [
      { id: 'executor', config: { provider: 'codex', model: 'preview-codex' } },
      { id: 'persona', config: { instruction: '核对状态。' } },
      { id: 'mcp', config: { servers: [server] } },
    ],
  } });
  const prefs = {
    [agentPresetKey]: JSON.stringify(agent),
    [extensionPreferenceKey]: JSON.stringify({ memoryEnabled: false, memories: [], plugins: [], servers: [{ ...server, enabled: true }] }),
  };
  await mkdir(join(root, 'conversations'));
  await mkdir(localAppData);
  await writeFile(join(root, 'conversations', 'ssh-relay.json'), '{}');
  await writeFile(preferencesFile, JSON.stringify(prefs));
  const readPrefs = async () => JSON.parse(await readFile(preferencesFile, 'utf8'));
  let app;
  const packets = [];
  const otherOrigins = [];
  let failure = 'ssh';
  try {
    app = await _electron.launch({ executablePath: executable, cwd: root, timeout: 15_000,
      env: { ...process.env, APPDATA: localAppData, LOCALAPPDATA: localAppData, VPS_WORKBENCH_DATA_DIR: root } });
    const page = await app.firstWindow({ timeout: 10_000 });
    page.setDefaultTimeout(12_000);
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/u, { waitUntil: 'domcontentloaded' });
    const origin = new URL(page.url()).origin;
    page.on('request', (request) => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) otherOrigins.push(request.url());
    });
    await page.route('**/dsh-vps-chat/api/rpc', async (route) => {
      const packet = route.request().postDataJSON();
      packets.push(packet);
      let reply;
      if (packet.op === 'preset') {
        const saved = (await readPrefs())[setupConnectionKey];
        reply = saved ? await readSetupPreset(saved, (settings) => fixture.chat({ op: 'list', settings })) : { ok: true, preset: null };
      } else if (packet.op === 'setup-check' && packet.kind === failure) {
        reply = { ok: false, code: `fixture_${failure}`, message: `检查失败 ${failure}` };
      } else if (packet.op === 'models' && failure === 'model') {
        reply = { ok: true, models: [] };
      } else reply = fixture.chat(packet);
      await route.fulfill({ status: 200, json: reply });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '开始 VPS 接入', exact: true }).click();
    const guide = page.getByRole('dialog', { name: 'VPS 接入向导', exact: true });
    const connect = guide.getByRole('button', { name: '连接并检查', exact: true });
    const runCheck = guide.getByRole('button', { name: /^(开始检查|重新检查)$/u });
    const step = (name) => guide.getByRole('listitem', { name, exact: true });
    const sample = guide.getByRole('button', { name: '运行示例工作流', exact: true });

    const fields = [
      ['VPS 主机', settings.host], ['SSH 端口', settings.port], ['SSH 用户名', settings.user],
      ['远端项目目录', settings.workspace], ['SSH 私钥文件路径', settings.identityPath],
      ['known_hosts 文件路径', settings.knownHostsPath], ['预期 VPS 出口 IPv4', settings.expectedIpv4],
    ];
    for (const [label, value] of fields) await guide.getByLabel(label, { exact: true }).fill(String(value));
    await guide.getByText('IPv6 设置', { exact: true }).click();
    await guide.getByLabel('预期 VPS 出口 IPv6（可选）', { exact: true }).fill(settings.expectedIpv6);
    assert.equal(await connect.isDisabled(), true);
    await guide.getByRole('checkbox', { name: /已核对/u }).check();
    await connect.click();
    await step('SSH 连接').getByRole('alert').filter({ hasText: '检查失败 ssh' }).waitFor();
    assert.equal((await readPrefs())[setupConnectionKey], undefined);
    assert.equal(await sample.count(), 0);

    failure = 'account';
    await connect.click();
    await step('账号登录').getByRole('alert').filter({ hasText: '检查失败 account' }).waitFor();
    await step('账号登录').getByRole('button', { name: '在 VPS 登录', exact: true }).waitFor();
    assert.deepEqual(JSON.parse((await readPrefs())[setupConnectionKey]), { settings, targetId });
    assert.equal(await sample.count(), 0);

    failure = 'model';
    await runCheck.click();
    await step('模型可用性').getByRole('alert').filter({ hasText: /未返回可选模型/u }).waitFor();
    assert.equal(await sample.count(), 0);

    failure = 'resources';
    await guide.getByLabel('检查额外 Agent').selectOption(presetId);
    await runCheck.click();
    await step('Agent 资源').getByRole('alert').filter({ hasText: '检查失败 resources' }).waitFor();
    assert.deepEqual(packets.find(({ kind }) => kind === 'resources').mcpServers, [server.id]);
    assert.equal(await sample.count(), 0);

    failure = '';
    await runCheck.click();
    await guide.getByText('4 / 4 项通过', { exact: true }).waitFor();
    assert.equal(packets.filter(({ op }) => op === 'send').length, 0);
    if (process.env.VPS_WORKBENCH_SETUP_IMAGE) await guide.screenshot({ path: process.env.VPS_WORKBENCH_SETUP_IMAGE, animations: 'disabled' });
    await sample.click();
    const workflow = page.getByRole('dialog', { name: '工作流', exact: true });
    await workflow.getByText('接入示例 · 读书会活动页', { exact: true }).waitFor();
    await workflow.getByText('已完成', { exact: true }).first().waitFor({ timeout: 22_000 });
    await workflow.getByLabel('第 2 阶段输出', { exact: true }).waitFor({ timeout: 22_000 });
    const sends = packets.filter(({ op }) => op === 'send');
    assert.equal(sends.length, 2);
    assert.ok(sends.every((packet) => packet.settings.host === settings.host && packet.targetId === targetId &&
      packet.model === 'preview-codex' && packet.workflowStage?.runId && !packet.extensions && !packet.projectMemory));
    assert.deepEqual(otherOrigins, []);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('本机保存的 VPS · 已配置', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'VPS 设置', exact: true }).click();
    await page.getByRole('button', { name: '接入向导', exact: true }).click();
    await guide.getByRole('button', { name: '开始检查', exact: true }).waitFor();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
