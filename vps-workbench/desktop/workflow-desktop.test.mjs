import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openSettingsSection } from './test-settings.mjs';
import { agentPresetKey, legacyAgentPresetKey, readAgentPresets, resolveAgentPreset } from '../agent-presets/state.mjs';
import { extensionPreferenceKey } from '../extensions/state.mjs';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { mixedWorkflowRunKey, readWorkflows, workflowEditPrefix, workflowKey, workflowRunKey } from '../workflow-engine/state.mjs';
import { readWorkflowRun } from '../workflow-engine/runner.mjs';

const require = createRequire(import.meta.url);
const { _electron } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const { version } = require('../package.json');
const executable = resolve(process.env.VPS_WORKBENCH_TEST_EXE ||
  `dist/VPS-Workbench-${version}-win-x64/VPS Workbench.exe`);

test('packaged desktop exposes protected mixed-workflow IPC in an isolated data directory', { timeout: 40_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vps-mixed-desktop-'));
  const browserData = join(root, 'desktop');
  await mkdir(browserData);
  await mkdir(join(browserData, 'conversations'));
  await writeFile(join(browserData, 'conversations', 'ssh-relay.json'), '{}');
  let desktop;
  t.after(async () => {
    await desktop?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  desktop = await _electron.launch({ executablePath: executable, cwd: root, timeout: 15_000,
    env: { ...process.env, APPDATA: root, LOCALAPPDATA: root, VPS_WORKBENCH_DATA_DIR: browserData } });
  const page = await desktop.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/u, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async (key) => {
    const native = window.vpsWorkbench;
    const status = await native.mixedWorkflow({ op: 'status' });
    const canOverwrite = await native.setPreference(key, '{}').then(() => true, () => false);
    await native.setAccess({ mode: 'browse', workspace: 'read-only' });
    const denied = await native.mixedWorkflow({ op: 'start', input: {} });
    return { status, canOverwrite, denied };
  }, mixedWorkflowRunKey);
  assert.deepEqual(result.status, { ok: true, run: null, running: false, error: '' });
  assert.equal(result.canOverwrite, false);
  assert.equal(result.denied.code, 'workbench_browse_only');
});

test('packaged Agent resources, scoped memory and legacy presets apply to a parallel workflow', { timeout: 100_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-workflow-desktop-'));
  const browserData = join(directory, 'desktop');
  const conversations = join(browserData, 'conversations');
  const pretendAppData = join(directory, 'isolated-appdata');
  const fixtures = createPreviewFixtures();
  const { [workflowKey]: _example, ...preferences } = fixtures.preferences;
  const targetId = fixtures.chat({ op: 'preset' }).preset.targetId;
  const { workspaceId: projectId } = fixtures.projects[0];
  const fixtureExtensions = { memoryEnabled: false, memories: [],
    servers: [{ id: 'fixture-status', targetId, enabled: true }],
    plugins: [{ id: 'writing', version: '1', schema: 1, name: '文案工具', description: '', enabled: true,
      prompts: [{ title: '简洁表达', text: '用一句话说明报名方式。' }] }],
  };
  const preferencesFile = join(browserData, 'preferences.json');
  await mkdir(conversations, { recursive: true });
  await mkdir(pretendAppData);
  await writeFile(join(browserData, 'projects.json'), JSON.stringify(fixtures.projects.map((project) => ({ ...project, path: directory }))));
  // Keep the actual remote bridge blocked if a request escapes the fixture.
  await writeFile(join(conversations, 'ssh-relay.json'), '{}');
  const python = join(process.env.LOCALAPPDATA, 'Programs/Python/Python311/python.exe');
  const env = { ...process.env, APPDATA: pretendAppData, LOCALAPPDATA: pretendAppData,
    VPS_WORKBENCH_DATA_DIR: browserData, VPS_WORKBENCH_PYTHON: python };
  const packets = [];
  const artifactPath = 'docs/交付检查.html';
  const artifactText = '<h1>阶段交付预览</h1>' + '\n' + '核对表单。';
  const artifactBytes = Buffer.from(artifactText);
  const largePath = 'reports/export.bin';
  const chunkBytes = 1024 * 1024;
  const largeBytes = Buffer.alloc(chunkBytes + 48, 0xb3);
  const persona = '准备活动页的标题和行动号召。';
  const output = '按「标题」和「报名文案」两栏输出。';
  const stages = [
    { name: '活动简报', provider: 'codex', model: 'preview-codex',
      instruction: '列出活动目标和交付物。', result: '简报结果：为周末读书会准备活动页。' },
    { name: '写页面文案', provider: 'claude-sdk', model: 'preview-sonnet-sdk',
      instruction: `${persona}\n\n输出规范\n${output}`, result: '文案分支产物：周末一起读书，点此报名。' },
    { name: '检查发布', provider: 'codex', model: 'preview-codex-mini',
      instruction: '独立核对移动端和报名入口。', result: '发布分支产物：待校验移动端表单。' },
    { name: '汇总交付', provider: 'antigravity', model: '',
      instruction: '把两个分支的产物合成发布简报。', result: '汇总结果：整合品牌文案和移动端检查项。' },
  ];
  const legacyId = 'c04d157a-6829-4c9d-af24-0747a0bece4f';
  const { name, provider, model, instruction } = stages[0];
  const legacyPresets = JSON.stringify([{ id: legacyId, revision: 3, name, provider, model, instruction }]);
  await writeFile(preferencesFile, JSON.stringify({ ...preferences, 'dsh-vps-chat:component-welcome:v1': 'seen', [legacyAgentPresetKey]: legacyPresets,
    [extensionPreferenceKey]: JSON.stringify(fixtureExtensions) }));
  const stageSessions = new Map();
  const timeline = [];
  let desktop;
  let blockNextList = false;
  let releaseList;
  let releaseFirstBranch;
  let checkpoint = 'launching the isolated desktop';
  t.after(() => t.diagnostic(`Last workflow test step: ${checkpoint}`));
  const readPreferences = async () => JSON.parse(await readFile(preferencesFile, 'utf8'));

  try {
    desktop = await _electron.launch({ executablePath: executable, timeout: 15_000, cwd: directory, env });
    checkpoint = 'waiting for the first window';
    const page = await desktop.firstWindow({ timeout: 10_000 });
    page.setDefaultTimeout(12_000);
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/u, { waitUntil: 'domcontentloaded' });
    await page.route('**/dsh-vps-chat/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      packets.push(body);
      if (body.op === 'workflow-artifacts') {
        const file = { path: artifactPath, size: artifactBytes.length };
        const large = { path: largePath, size: largeBytes.length };
        const json = body.after === artifactPath ? { ok: true, files: [large], truncated: false }
          : body.path === largePath ? { ok: true, file: { ...large, offset: body.offset, revision: 'c'.repeat(64),
            data: largeBytes.subarray(body.offset, body.offset + chunkBytes).toString('base64') } }
            : body.path === artifactPath ? { ok: true, file: { ...file, data: artifactBytes.toString('base64') } }
              : { ok: true, files: [file], truncated: true };
        await route.fulfill({ status: 200, json });
        return;
      }
      if (blockNextList && body.op === 'list') {
        blockNextList = false;
        await new Promise((resolve) => { releaseList = resolve; });
        await route.fulfill({ status: 200, json: fixtures.chat(body) }).catch(() => {});
        return;
      }
      const reply = fixtures.chat(body);
      if (body.op === 'send' && !body.prompt.startsWith(workflowEditPrefix)) {
        const index = stages.findIndex((item) => body.prompt.includes(item.instruction));
        if (index !== -1) {
          stageSessions.set(body.sessionId, index);
          timeline.push(`send:${index}`);
          if (index === 2) releaseFirstBranch?.();
          if (index === 1 && !timeline.includes('send:2')) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 9000);
              releaseFirstBranch = () => { clearTimeout(timer); resolve(); };
            });
          }
        }
      } else {
        const index = stageSessions.get(body.sessionId);
        const turn = reply.session?.turns.at(-1);
        if (index !== undefined && turn?.state === 'complete') {
          turn.reply = stages[index].result;
          if (!timeline.includes(`complete:${index}`)) timeline.push(`complete:${index}`);
        }
      }
      await route.fulfill({ status: 200, json: reply });
    });
    checkpoint = 'loading the fixture connection';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
    const entry = page.getByRole('button', { name: '工作流', exact: true });
    const panel = page.getByRole('dialog', { name: '工作流', exact: true });
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    const send = page.getByRole('button', { name: '发送', exact: true });
    const workflows = async () => readWorkflows((await readPreferences())[workflowKey] ?? null);
    const presets = async () => {
      const data = await readPreferences();
      return readAgentPresets(data[agentPresetKey] ?? null, data[legacyAgentPresetKey] ?? null);
    };
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    const presetCard = (id, scope = settings) => scope.locator(`button[data-preset-id="${id}"]`);
    const radio = (scope, name) => scope.getByRole('radio', { name, exact: true });
    const currentModel = settings.locator('[aria-label="当前模型"]');
    const graph = panel.getByRole('region', { name: '工作流流程图', exact: true });
    const graphNode = (index, title) => graph.getByRole('button', { name: `第 ${index} 阶段 · ${title}`, exact: true });
    const agentTip = page.getByRole('tooltip');
    async function checkAgentNode(node, agentName, memory, icon) {
      assert.equal(await node.getAttribute('data-agent-name'), agentName);
      assert.ok((await node.innerText()).includes(agentName));
      assert.ok((await node.innerText()).includes(memory));
      assert.equal(await node.locator(`[data-icon="${icon}"] img`).count(), 1);
    }
    async function checkAgentTip(texts) {
      await agentTip.waitFor();
      const text = await agentTip.innerText();
      for (const content of texts) assert.ok(text.includes(content), `Agent tooltip missing ${content}`);
      const tipBounds = await agentTip.boundingBox();
      const panelBounds = await panel.boundingBox();
      assert.ok(tipBounds && panelBounds);
      assert.ok(tipBounds.x >= panelBounds.x - 1 && tipBounds.y >= panelBounds.y - 1 &&
        tipBounds.x + tipBounds.width <= panelBounds.x + panelBounds.width + 1 &&
        tipBounds.y + tipBounds.height <= panelBounds.y + panelBounds.height + 1);
    }
    async function openAgentSettings() {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await openSettingsSection(settings, 'Agent 预设');
    }
    async function closeSettings() {
      await settings.getByRole('button', { name: '完成', exact: true }).click();
      await settings.waitFor({ state: 'hidden' });
    }

    checkpoint = 'reading the original flat Agent preset';
    await openAgentSettings();
    await presetCard(legacyId).click();
    assert.equal(await presetCard(legacyId).getAttribute('aria-pressed'), 'true');
    assert.equal(await settings.getByRole('textbox', { name: '预设名称', exact: true }).inputValue(), name);
    assert.equal(await radio(settings, 'Codex').isChecked(), true);
    assert.ok((await currentModel.textContent()).includes(model));
    assert.equal(await settings.getByRole('textbox', { name: '角色指令', exact: true }).inputValue(), instruction);
    assert.equal((await readPreferences())[agentPresetKey], undefined);
    checkpoint = 'editing the compact Agent cards, model directory and resource controls';
    await settings.getByRole('button', { name: '新建预设', exact: true }).click();
    await settings.getByRole('textbox', { name: '预设名称', exact: true }).fill('活动页文案 Agent');
    assert.equal(await settings.locator('select').count(), 0);
    await radio(settings, 'Codex').press('ArrowRight');
    assert.equal(await radio(settings, 'Claude API').isChecked(), true);
    await radio(settings, 'Claude 订阅 SDK').press('Space');
    assert.equal(await radio(settings, 'Claude 订阅 SDK').isChecked(), true);
    await settings.getByRole('button', { name: '读取模型', exact: true }).click();
    const modelFilter = settings.getByRole('searchbox', { name: '筛选模型', exact: true });
    await modelFilter.fill('not-in-fixture');
    await radio(settings, stages[1].model).waitFor({ state: 'hidden' });
    await modelFilter.fill('sonnet-sdk');
    await radio(settings, stages[1].model).press('Space');
    assert.ok((await currentModel.textContent()).includes(stages[1].model));
    const directoryRequests = () => packets.filter(({ op, settings: connection }) =>
      op === 'models' && connection.provider === stages[1].provider).length;
    const beforeRefresh = directoryRequests();
    await settings.getByRole('button', { name: '刷新目录', exact: true }).click();
    await radio(settings, stages[1].model).waitFor();
    assert.equal(directoryRequests(), beforeRefresh + 1);
    await modelFilter.press('Escape');
    await modelFilter.waitFor({ state: 'hidden' });
    await settings.getByRole('button', { name: '展开模型目录', exact: true }).waitFor();
    await settings.getByRole('textbox', { name: '角色指令', exact: true }).fill(persona);
    await settings.getByRole('button', { name: '添加输出规范', exact: true }).click();
    await settings.getByRole('textbox', { name: '输出规范', exact: true }).fill(output);
    const templates = settings.getByRole('region', { name: 'Agent 预设', exact: true })
      .getByRole('button', { name: '提示词模板', exact: true });
    await templates.click();
    await settings.getByRole('button', { name: '文案工具 · 简洁表达', exact: true }).click();
    await settings.getByRole('button', { name: /^移除提示词模板 /u }).waitFor();
    await radio(settings, '共享记忆').press('Space');
    await settings.getByRole('button', { name: '保存预设', exact: true }).click();
    await settings.getByRole('button', { name: '活动页文案 Agent', exact: true }).waitFor();
    const [legacyAgent, copyAgent] = await presets();
    assert.equal(legacyAgent.id, legacyId);
    assert.equal(legacyAgent.revision, 3);
    assert.deepEqual(resolveAgentPreset(legacyAgent), { name, provider, model, instruction });
    assert.equal(copyAgent.revision, 1);
    assert.deepEqual(copyAgent.modules.map(({ id }) => id), ['executor', 'persona', 'output', 'plugins', 'memory']);
    const compiled = resolveAgentPreset(copyAgent);
    assert.deepEqual([compiled.provider, compiled.model, compiled.instruction],
      [stages[1].provider, stages[1].model, stages[1].instruction]);
    assert.equal((await readPreferences())[legacyAgentPresetKey], legacyPresets);
    assert.equal(await presetCard(copyAgent.id).getAttribute('aria-pressed'), 'true');
    const settingsScroll = settings.locator('.vc-settings-scroll');
    const originalSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 430, height: 620 });
    assert.equal(await settingsScroll.evaluate((pane) => pane.scrollWidth <= pane.clientWidth + 1), true);
    await page.setViewportSize(originalSize);
    if (process.env.VPS_WORKBENCH_AGENT_PRESETS_IMAGE) {
      await settingsScroll.evaluate((pane) => { pane.scrollTop = 0; });
      await settings.screenshot({ path: process.env.VPS_WORKBENCH_AGENT_PRESETS_IMAGE, animations: 'disabled' });
    }
    if (process.env.VPS_WORKBENCH_AGENT_PRESETS_DARK_IMAGE) {
      await page.emulateMedia({ colorScheme: 'dark' });
      await settingsScroll.evaluate((pane) => { pane.scrollTop = 0; });
      await settings.screenshot({ path: process.env.VPS_WORKBENCH_AGENT_PRESETS_DARK_IMAGE, animations: 'disabled' });
      await page.emulateMedia({ colorScheme: null });
    }
    const statusPresetName = '上线检查 Agent';
    await settings.getByRole('button', { name: '新建预设', exact: true }).click();
    await settings.getByRole('textbox', { name: '预设名称', exact: true }).fill(statusPresetName);
    await settings.getByRole('button', { name: '读取模型', exact: true }).click();
    await radio(settings, stages[2].model).press('Space');
    await settings.getByRole('button', { name: '收起模型目录', exact: true }).click();
    await settings.getByRole('textbox', { name: '角色指令', exact: true }).fill(stages[2].instruction);
    await settings.getByRole('button', { name: 'MCP 服务', exact: true }).click();
    await settings.getByRole('button', { name: 'fixture-status', exact: true }).click();
    assert.equal(await radio(settings, '独立上下文').isChecked(), true);
    await settings.getByRole('button', { name: '保存预设', exact: true }).click();
    await settings.getByRole('button', { name: statusPresetName, exact: true }).waitFor();
    const statusAgent = (await presets()).find(({ name }) => name === statusPresetName);
    await closeSettings();

    checkpoint = 'reading and applying Agent cards in the workflow stage editor';
    await entry.click();
    await panel.getByRole('button', { name: '新建工作流', exact: true }).click();
    await panel.getByRole('textbox', { name: '工作流名称', exact: true }).fill('跨订阅发布演练');
    async function stage(index, { name, provider, model, instruction }) {
      const group = panel.getByRole('group', { name: `第 ${index} 阶段`, exact: true });
      await group.getByRole('textbox', { name: '阶段名称', exact: true }).fill(name);
      await group.getByRole('combobox', { name: '执行工具', exact: true }).selectOption(provider);
      if (model) {
        await group.getByRole('button', { name: `读取第 ${index} 阶段的模型目录`, exact: true }).click();
        await group.getByRole('combobox', { name: '模型', exact: true }).selectOption(model);
      }
      await group.getByRole('textbox', { name: '角色与指令', exact: true }).fill(instruction);
    }
    const originalStage = panel.getByRole('group', { name: '第 1 阶段', exact: true });
    const gallery = (group) => group.getByRole('group', { name: '套用 Agent 预设', exact: true });
    assert.equal(await gallery(originalStage).locator('select').count(), 0);
    assert.ok((await presetCard(legacyId, originalStage).innerText()).includes('默认不共享'));
    await presetCard(legacyId, originalStage).press('Enter');
    assert.equal(await originalStage.getByRole('textbox', { name: '角色与指令', exact: true }).inputValue(), instruction);
    assert.equal(await presetCard(legacyId, originalStage).getAttribute('aria-pressed'), 'true');
    await panel.getByRole('button', { name: '添加阶段', exact: true }).click();
    const copyStage = panel.getByRole('group', { name: '第 2 阶段', exact: true });
    await copyStage.getByRole('textbox', { name: '阶段名称', exact: true }).fill(stages[1].name);
    const selectedCard = presetCard(copyAgent.id, copyStage);
    const copyMeta = await selectedCard.innerText();
    for (const text of ['Claude 订阅 SDK', stages[1].model, '共享记忆', '文案工具', '简洁表达']) {
      assert.ok(copyMeta.includes(text), `Card text missing ${text}`);
    }
    assert.equal(await selectedCard.locator('img').count(), 1);
    const statusMeta = await presetCard(statusAgent.id, copyStage).innerText();
    for (const text of ['Codex', stages[2].model, '独立上下文', 'fixture-status']) {
      assert.ok(statusMeta.includes(text), `Card text missing ${text}`);
    }
    await selectedCard.click();
    assert.equal(await selectedCard.getAttribute('aria-pressed'), 'true');
    assert.equal(await copyStage.getByRole('textbox', { name: '阶段名称', exact: true }).inputValue(), stages[1].name);
    assert.equal(await copyStage.getByRole('combobox', { name: '执行工具', exact: true }).inputValue(), stages[1].provider);
    assert.equal(await copyStage.getByRole('combobox', { name: '模型', exact: true }).inputValue(), stages[1].model);
    assert.equal(await copyStage.getByRole('textbox', { name: '角色与指令', exact: true }).inputValue(), stages[1].instruction);
    assert.equal(await radio(copyStage, '共享记忆').isChecked(), true);
    await presetCard(legacyId, copyStage).click();
    assert.equal(await radio(copyStage, '默认不共享').isChecked(), true);
    assert.equal(await copyStage.getByRole('button', { name: /^移除提示词模板 /u }).count(), 0);
    await selectedCard.click();
    if (process.env.VPS_WORKBENCH_WORKFLOW_PRESETS_IMAGE) {
      await gallery(copyStage).scrollIntoViewIfNeeded();
      await gallery(copyStage).screenshot({ path: process.env.VPS_WORKBENCH_WORKFLOW_PRESETS_IMAGE, animations: 'disabled' });
    }

    await copyStage.getByRole('button', { name: '管理预设', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await presetCard(copyAgent.id).click();
    await settings.getByRole('textbox', { name: '预设名称', exact: true }).fill('活动页文案 Agent 第二版');
    await settings.getByRole('textbox', { name: '角色指令', exact: true }).fill('集中检查已有文案的语气。');
    await settings.getByRole('button', { name: '移除输出规范', exact: true }).click();
    await radio(settings, '独立上下文').press('Space');
    await settings.getByRole('button', { name: '保存预设', exact: true }).click();
    await settings.getByRole('button', { name: '活动页文案 Agent 第二版', exact: true }).waitFor();
    const editedAgent = (await presets()).find(({ id }) => id === copyAgent.id);
    assert.equal(editedAgent.revision, 2);
    assert.deepEqual(editedAgent.modules.map(({ id }) => id), ['executor', 'persona', 'plugins', 'memory']);
    await closeSettings();
    await entry.click();
    assert.equal(await copyStage.getByRole('textbox', { name: '角色与指令', exact: true }).inputValue(), stages[1].instruction);
    assert.equal(await radio(copyStage, '共享记忆').isChecked(), true);
    assert.equal(await presetCard(copyAgent.id, copyStage).getAttribute('aria-pressed'), 'false');
    assert.equal(packets.filter(({ op }) => op === 'send').length, 0);
    t.diagnostic('Preset cards showed the provider, model, memory and resources. Applying one preserved the stage name, and later preset edits preserved the stage snapshot.');

    checkpoint = 'showing Agent name snapshots and hover details on the graph';
    const firstNode = graphNode(1, stages[0].name);
    const secondNode = graphNode(2, stages[1].name);
    await checkAgentNode(firstNode, legacyAgent.name, '默认不共享', 'codex');
    await checkAgentNode(secondNode, copyAgent.name, '共享记忆', 'claude-sdk');
    assert.ok(!(await secondNode.innerText()).includes(stages[1].model));
    await secondNode.hover();
    await checkAgentTip([stages[1].model, 'MCP', '提示词模板', '文案工具', '简洁表达']);
    if (process.env.VPS_WORKBENCH_WORKFLOW_AGENT_NODE_IMAGE) {
      await panel.screenshot({ path: process.env.VPS_WORKBENCH_WORKFLOW_AGENT_NODE_IMAGE, animations: 'disabled' });
    }
    await secondNode.press('Escape');
    await agentTip.waitFor({ state: 'hidden' });
    await panel.waitFor();

    checkpoint = 'creating and connecting the workflow branches';
    await firstNode.click();
    assert.equal(await firstNode.getAttribute('aria-pressed'), 'true');
    assert.equal(await panel.getByRole('group', { name: '第 2 阶段', exact: true }).count(), 0);
    await firstNode.press('ArrowRight');
    assert.equal(await secondNode.getAttribute('aria-pressed'), 'true');
    await secondNode.dragTo(firstNode, { targetPosition: { x: 30, y: 42 } });
    await graph.getByRole('button', { name: '第 1 阶段 · 写页面文案', exact: true }).waitFor();
    assert.equal(await panel.getByRole('group', { name: '第 1 阶段', exact: true })
      .getByRole('textbox', { name: '阶段名称', exact: true }).inputValue(), '写页面文案');
    await panel.getByRole('button', { name: '下移第 1 阶段', exact: true }).click();
    await firstNode.click();
    await panel.getByRole('button', { name: '添加阶段', exact: true }).click();
    const checkStage = panel.getByRole('group', { name: '第 3 阶段', exact: true });
    await checkStage.getByRole('textbox', { name: '阶段名称', exact: true }).fill(stages[2].name);
    await presetCard(statusAgent.id, checkStage).click();
    assert.equal(await checkStage.getByRole('button', { name: '移除MCP 服务 fixture-status', exact: true }).count(), 1);
    assert.equal(await radio(checkStage, '独立上下文').isChecked(), true);
    const scopedFiles = checkStage.getByRole('group', { name: '阶段文件授权', exact: true });
    await scopedFiles.getByRole('textbox', { name: '远端相对路径', exact: true }).fill('docs/checklist.txt');
    await scopedFiles.getByRole('button', { name: '添加远端路径', exact: true }).click();
    await scopedFiles.getByText('docs/checklist.txt', { exact: true }).waitFor();
    const fixtureAttachment = Buffer.from('explicit desktop attachment');
    await scopedFiles.getByLabel('选择本地附件', { exact: true }).setInputFiles({
      name: 'fixture-attachment.txt', mimeType: 'text/plain', buffer: fixtureAttachment,
    });
    await scopedFiles.getByText('fixture-attachment.txt', { exact: true }).waitFor();
    if (process.env.VPS_WORKBENCH_WORKFLOW_FILE_IMAGE) {
      await scopedFiles.screenshot({ path: process.env.VPS_WORKBENCH_WORKFLOW_FILE_IMAGE, animations: 'disabled' });
    }
    await panel.getByRole('button', { name: '添加独立阶段', exact: true }).click();
    await stage(4, stages[3]);
    const inspectionNode = graphNode(3, stages[2].name);
    await checkAgentNode(inspectionNode, statusPresetName, '独立上下文', 'codex');
    await inspectionNode.hover();
    await checkAgentTip([stages[2].model, 'fixture-status', '提示词模板']);
    await graphNode(4, stages[3].name).hover();
    await checkAgentNode(graphNode(4, stages[3].name), '自定义 Agent', '默认不共享', 'antigravity');
    await checkAgentTip(['VPS CLI 默认模型']);

    const port = (index, side) => graph.getByRole('button', { name: `第 ${index} 阶段${side}端口`, exact: true });
    async function connect(from, to) {
      const output = port(from, '输出');
      const input = port(to, '输入');
      await output.scrollIntoViewIfNeeded();
      await input.scrollIntoViewIfNeeded();
      const source = await output.boundingBox();
      const target = await input.boundingBox();
      assert.ok(source && target);
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
      await page.mouse.up();
    }
    await connect(2, 4);
    await connect(3, 4);
    await graph.getByRole('button', { name: '第 4 阶段 · 汇总交付', exact: true }).click();
    await panel.getByRole('button', { name: '移除第 2 阶段到第 4 阶段的连接', exact: true }).click();
    await port(2, '输出').click();
    await port(4, '输入').click();
    await port(4, '输出').click();
    await port(1, '输入').click();
    await panel.getByRole('alert').filter({ hasText: /循环|环路|闭环/u }).waitFor();

    await panel.getByRole('button', { name: '保存工作流', exact: true }).click();
    await panel.getByRole('button', { name: '在聊天中编辑', exact: true }).waitFor();
    assert.equal(await panel.getByRole('alert').filter({ hasText: /循环|环路|闭环/u }).count(), 0);
    const [saved] = await workflows();
    assert.deepEqual(saved.stages.map(({ provider, model }) => [provider, model]),
      stages.map(({ provider, model }) => [provider, model]));
    assert.deepEqual(saved.stages[1].agent, compiled.agent);
    assert.deepEqual(saved.stages[2].agent, { mcpServers: [{ id: 'fixture-status', targetId }], plugins: [], memory: 'isolated' });
    const selectedFile = saved.stages[2].fileAccess;
    assert.equal(selectedFile.targetId, targetId);
    assert.deepEqual(selectedFile.paths, ['docs/checklist.txt']);
    const [attachmentRef] = selectedFile.attachments;
    assert.equal(attachmentRef.name, 'fixture-attachment.txt');
    assert.deepEqual(await readFile(join(browserData, 'workflow-attachments', attachmentRef.digest)), fixtureAttachment);
    assert.deepEqual(saved.stages.map(({ agentPreset }) => agentPreset), [legacyAgent, copyAgent, statusAgent, null]
      .map((preset) => preset ? { id: preset.id, name: preset.name } : undefined));
    const [briefId, copyId, checkId, mergeId] = saved.stages.map(({ id }) => id);
    const edgeNames = ({ from, to }) => `${from}:${to}`;
    assert.deepEqual(saved.edges.map(edgeNames).sort(),
      [`${briefId}:${copyId}`, `${briefId}:${checkId}`, `${copyId}:${mergeId}`, `${checkId}:${mergeId}`].sort());

    checkpoint = 'checking graph navigation in a narrow window';
    const fullSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 412, height: 640 });
    await firstNode.click();
    await firstNode.press('ArrowRight');
    assert.equal(await secondNode.getAttribute('aria-pressed'), 'true');
    await checkAgentTip([stages[1].model, '简洁表达']);
    await secondNode.press('Escape');
    await agentTip.waitFor({ state: 'hidden' });
    const overflow = await graph.locator('.vc-workflow-graph-scroll').evaluate((strip) => {
      const selected = strip.querySelector('[aria-pressed="true"]').getBoundingClientRect();
      const bounds = strip.getBoundingClientRect();
      return { scrollable: strip.scrollWidth > strip.clientWidth, selectedVisible: selected.right <= bounds.right + 1 };
    });
    assert.deepEqual(overflow, { scrollable: true, selectedVisible: true });
    const cardBounds = await gallery(copyStage).evaluate((group) => {
      const bounds = group.getBoundingClientRect();
      return [...group.querySelectorAll('button[data-preset-id]')].every((item) => {
        const box = item.getBoundingClientRect();
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
      });
    });
    assert.equal(cardBounds, true);
    await page.setViewportSize(fullSize);
    await graph.getByRole('button', { name: '第 4 阶段 · 汇总交付', exact: true }).click();
    if (process.env.VPS_WORKBENCH_WORKFLOW_UI_IMAGE) {
      await panel.locator('.vc-workflow-edit-pane').evaluate((pane) => { pane.scrollTop = 0; });
      await panel.screenshot({ path: process.env.VPS_WORKBENCH_WORKFLOW_UI_IMAGE, animations: 'disabled' });
    }
    t.diagnostic('Pointer links, connection removal, cycle prevention, and narrow-window graph navigation passed.');

    checkpoint = 'canceling a held preflight and then running the fork and merge';
    const task = '为读书会活动页安排周末发布。';
    await panel.getByRole('textbox', { name: '运行任务', exact: true }).fill(task);
    await panel.getByRole('combobox', { name: '记忆项目', exact: true }).selectOption(projectId);
    const start = panel.getByRole('button', { name: '开始运行', exact: true });
    blockNextList = true;
    const preflight = page.waitForRequest((request) => request.url().endsWith('/dsh-vps-chat/api/rpc') &&
      request.postDataJSON()?.op === 'list');
    await start.click();
    await preflight;
    await panel.getByRole('button', { name: '取消准备', exact: true }).click();
    releaseList?.();
    assert.equal(packets.filter(({ op }) => op === 'send').length, 0);
    assert.equal(await panel.getByRole('combobox', { name: '记忆项目', exact: true }).inputValue(), projectId);

    await start.click();
    await panel.getByRole('button', { name: '暂停运行', exact: true }).waitFor();
    await panel.getByRole('button', { name: '关闭工作流', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await entry.click();
    try {
      await panel.getByText('工作流已完成。', { exact: true }).waitFor({ timeout: 28_000 });
    } catch (error) {
      const current = readWorkflowRun((await readPreferences())[workflowRunKey] ?? null);
      t.diagnostic(JSON.stringify({ timeline, phase: current?.phase, states: current?.rows.map(({ state }) => state) }));
      throw error;
    }
    await panel.getByLabel('第 4 阶段输出', { exact: true }).waitFor();
    const sends = () => packets.filter(({ op }) => op === 'send');
    assert.equal(sends().length, 4);
    const byStage = stages.map((item) => sends().find(({ prompt }) => prompt.includes(item.instruction)));
    assert.deepEqual(byStage.map(({ settings, model = '' }) => [settings.provider, model]),
      stages.map(({ provider, model }) => [provider, model]));
    assert.equal(new Set(byStage.map(({ sessionId }) => sessionId)).size, 4);
    assert.ok(byStage.every(({ prompt }) => prompt.includes(task)));
    assert.ok(byStage[1].prompt.includes(stages[0].result));
    assert.ok(byStage[2].prompt.includes(stages[0].result));
    assert.ok(!byStage[1].prompt.includes(stages[2].result));
    assert.ok(!byStage[2].prompt.includes(stages[1].result));
    assert.ok(byStage[3].prompt.includes(stages[1].result));
    assert.ok(byStage[3].prompt.includes(stages[2].result));
    assert.ok(timeline.indexOf('complete:0') < timeline.indexOf('send:1'));
    assert.ok(timeline.indexOf('complete:0') < timeline.indexOf('send:2'));
    assert.ok(Math.max(timeline.indexOf('send:1'), timeline.indexOf('send:2')) <
      Math.min(timeline.indexOf('complete:1'), timeline.indexOf('complete:2')));
    assert.ok(Math.max(timeline.indexOf('complete:1'), timeline.indexOf('complete:2')) < timeline.indexOf('send:3'));
    const run = readWorkflowRun((await readPreferences())[workflowRunKey]);
    assert.equal(run.phase, 'complete');
    assert.equal(run.version, 4);
    assert.equal(run.projectId, projectId);
    assert.ok(byStage.every(({ workflowStage }) => workflowStage?.runId === run.id));
    assert.ok(byStage.every((packet) => !Object.hasOwn(packet, 'workflowFiles')));
    assert.deepEqual(run.rows.map(({ turnId }) => turnId), byStage.map(({ turnId }) => turnId));
    assert.deepEqual(run.workflow.stages[2].fileAccess, selectedFile);
    assert.match(await panel.getByLabel('第 3 阶段输出目录').innerText(), new RegExp(run.rows[2].turnId));
    t.diagnostic('Two branches overlapped and the final model received both of their results after they completed.');

    checkpoint = 'reading saved workflow artifacts';
    const completedStage = panel.getByRole('list', { name: '运行阶段', exact: true }).getByRole('listitem').nth(2);
    await completedStage.getByRole('button', { name: '查看产物', exact: true }).click();
    await completedStage.getByRole('button', { name: artifactPath, exact: true }).click();
    const rendered = completedStage.getByLabel('产物内容预览', { exact: true });
    assert.equal(await rendered.textContent(), artifactText);
    assert.equal(await rendered.locator('h1').count(), 0);
    const download = completedStage.getByRole('link', { name: '下载文件', exact: true });
    assert.match(await download.getAttribute('href'), /^blob:/u);
    assert.equal(await download.getAttribute('download'), '交付检查.html');
    async function saveArtifact(destination, bytes) {
      await desktop.evaluate(({ session }, path) => {
        globalThis.fixtureArtifactDownload = new Promise((resolve) => {
          session.defaultSession.once('will-download', (_event, item) => {
            item.setSavePath(path);
            item.once('done', (_done, state) => resolve(state));
          });
        });
      }, destination);
      await download.click();
      assert.equal(await desktop.evaluate(() => Promise.race([
        globalThis.fixtureArtifactDownload, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
      ])), 'completed');
      assert.deepEqual(await readFile(destination), bytes);
    }
    await saveArtifact(join(directory, 'fixture-artifact-download.html'), artifactBytes);
    await completedStage.getByRole('button', { name: '加载更多产物', exact: true }).click();
    await completedStage.getByRole('button', { name: largePath, exact: true }).click();
    await completedStage.getByRole('button', { name: '准备下载', exact: true }).click();
    await download.waitFor();
    assert.equal(await download.getAttribute('download'), 'export.bin');
    await saveArtifact(join(directory, 'fixture-artifact-export.bin'), largeBytes);
    await completedStage.getByRole('button', { name: '收起产物', exact: true }).click();
    await rendered.waitFor({ state: 'detached' });
    const artifactCalls = packets.filter(({ op }) => op === 'workflow-artifacts');
    assert.ok(artifactCalls.every(({ workflowRunId, sessionId, turnId }) => workflowRunId === run.id &&
      sessionId === run.rows[2].sessionId && turnId === run.rows[2].turnId));
    assert.deepEqual(artifactCalls.map(({ path, after, offset }) => [path, after, offset]), [
      [undefined, undefined, undefined],
      [artifactPath, undefined, undefined],
      [undefined, artifactPath, undefined],
      [largePath, undefined, 0],
      [largePath, undefined, chunkBytes],
    ]);

    async function editFromChat(action, prompt) {
      await panel.getByRole('button', { name: action, exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
      await editor.fill(prompt);
      await send.click();
      await page.getByRole('button', { name: '审阅工作流配置', exact: true }).click();
      return page.getByRole('dialog', { name: '确认工作流提案', exact: true });
    }
    checkpoint = 'reviewing chat proposals';
    const proposal = await editFromChat('在聊天中编辑', '让文案和上线检查并行，再汇总发布结果。');
    await proposal.getByRole('heading', { name: '活动页发布', exact: true }).waitFor();
    const proposedGraph = proposal.getByRole('region', { name: '工作流流程图', exact: true });
    await proposedGraph.getByRole('button', { name: '第 4 阶段 · 汇总交付', exact: true }).click();
    await proposal.getByRole('region', { name: '提案阶段详情', exact: true })
      .getByText('汇总页面文案和上线清单，列出待确认项。', { exact: true }).waitFor();
    assert.ok(sends().at(-1).prompt.startsWith(workflowEditPrefix));
    assert.ok(sends().at(-1).prompt.includes(saved.name));
    assert.ok(sends().at(-1).prompt.includes(JSON.stringify(saved.edges)));
    assert.doesNotMatch(sends().at(-1).prompt, /fixture-status|简洁表达|mcpServers|agentPreset|活动页文案 Agent/);
    assert.deepEqual(await workflows(), [saved]);
    await proposal.getByRole('button', { name: '保存提案', exact: true }).click();
    await panel.waitFor();
    const [updated] = await workflows();
    assert.equal(updated.id, saved.id);
    assert.equal(updated.revision, 2);
    assert.equal(updated.stages.length, 4);
    assert.equal(updated.edges.length, 4);
    assert.deepEqual(updated.stages.map(({ agent }) => agent), saved.stages.map(({ agent }) => agent));
    assert.deepEqual(updated.stages.map(({ agentPreset }) => agentPreset), saved.stages.map(({ agentPreset }) => agentPreset));
    assert.equal(sends().length, 5);

    const newProposal = await editFromChat('在聊天中创建', '给另一场活动创建发布工作流。');
    await newProposal.getByRole('button', { name: '拒绝提案', exact: true }).click();
    await panel.waitFor();
    assert.deepEqual(await workflows(), [updated]);
    assert.equal(sends().length, 6);
    const rawWriteRejected = await page.evaluate(async (key) => {
      try { await window.vpsWorkbench.setPreference(key, '[]'); return false; } catch { return true; }
    }, workflowKey);
    assert.equal(rawWriteRejected, true);

    await panel.getByRole('button', { name: '关闭工作流', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    const unboundText = `${workflowEditPrefix}请展示配置格式。`;
    await editor.fill(unboundText);
    await send.click();
    const ordinaryTurn = page.locator('.vc-turn').filter({
      has: page.getByText(unboundText, { exact: true }),
    });
    await ordinaryTurn.getByText('本地预览提供一份示例配置。', { exact: true }).waitFor();
    assert.equal(await ordinaryTurn.getByRole('button', { name: '审阅工作流配置', exact: true }).count(), 0);
    assert.deepEqual(await workflows(), [updated]);

    checkpoint = 'restoring the saved workflow and run after reload';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
    await entry.click();
    assert.equal(await panel.getByRole('combobox', { name: '已保存的工作流', exact: true }).inputValue(), updated.id);
    await panel.getByText('工作流已完成。', { exact: true }).waitFor();
    assert.equal(sends().length, 7);
    t.diagnostic('The model proposal changed the selected workflow only after confirmation. Reload restored the configuration and receipt.');

    checkpoint = 'checking global stop controls after restoring in-progress branch receipts';
    async function restoreRun(stopRequested, branchState, otherState, joinState) {
      const snapshot = { ...run, phase: 'paused', stopRequested, message: '恢复模拟回执。',
        rows: run.rows.map((row, index) => {
          if (index === 1) return { ...row, state: branchState };
          if (index === 2) return { ...row, state: otherState };
          if (index === 3) return { ...row, state: joinState, reply: '' };
          return row;
        }) };
      await page.evaluate(([key, value]) => window.vpsWorkbench.setPreference(key, value),
        [workflowRunKey, JSON.stringify(snapshot)]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
      await entry.click();
    }
    await restoreRun(false, 'stopping', 'complete', 'waiting');
    await panel.getByRole('button', { name: '停止运行', exact: true }).waitFor();
    await panel.getByRole('button', { name: '查询并继续', exact: true }).waitFor();
    await restoreRun(true, 'canceling', 'stopping', 'skipped');
    await panel.getByRole('button', { name: '重试停止', exact: true }).click();
    await panel.getByText('工作流已停止。', { exact: true }).waitFor();
    assert.deepEqual(packets.filter(({ op }) => op === 'stop').map(({ turnId }) => turnId), [run.rows[1].turnId]);
    assert.equal(sends().length, 7);

    checkpoint = 'deleting a persisted preset after reopening settings';
    await panel.getByRole('button', { name: '管理预设', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await presetCard(copyAgent.id).click();
    assert.equal(await settings.getByRole('textbox', { name: '预设名称', exact: true }).inputValue(), '活动页文案 Agent 第二版');
    for (const id of [copyAgent.id, legacyId, statusAgent.id]) {
      if (id !== copyAgent.id) await presetCard(id).click();
      await settings.getByRole('button', { name: '删除预设', exact: true }).click();
      await settings.getByRole('button', { name: '确认删除预设', exact: true }).click();
      await presetCard(id).waitFor({ state: 'detached' });
    }
    assert.deepEqual(await presets(), []);
    assert.equal((await readPreferences())[legacyAgentPresetKey], legacyPresets);
    assert.deepEqual(await workflows(), [updated]);
    await closeSettings();
    await entry.click();
    await checkAgentNode(secondNode, copyAgent.name, '共享记忆', 'claude-sdk');
    for (const key of [agentPresetKey, legacyAgentPresetKey]) {
      const rawPresetWriteRejected = await page.evaluate(async (name) => {
        try { await window.vpsWorkbench.setPreference(name, '[]'); return false; } catch { return true; }
      }, key);
      assert.equal(rawPresetWriteRejected, true);
    }
  } finally {
    releaseList?.();
    releaseFirstBranch?.();
    if (desktop) {
      const child = desktop.process();
      const timer = setTimeout(() => child.kill(), 5000).unref();
      try { await desktop.close(); } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
