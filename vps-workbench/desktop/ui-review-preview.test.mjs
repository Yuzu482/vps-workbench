import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openSettingsSection } from './test-settings.mjs';
import { startPreview } from './preview-server.mjs';
import { readWorkflows, workflowKey } from '../workflow-engine/state.mjs';
import { agentPresetKey, applyAgentPresetChange } from '../agent-presets/state.mjs';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { designExportMenu } from '../../remote-workbench/vps-chat/client/design-export-menu.js';
import { setupConnectionKey } from './setup-state.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const previewStorageKey = 'vps-workbench-preview-state';

async function openPreview(t, { viewport = { width: 1280, height: 720 }, seed } = {}) {
  const preview = await startPreview({ port: 0, watch: false });
  t.after(() => preview.close());
  const browser = await chromium.launch({ channel: 'msedge', args: ['--disable-background-networking', '--no-proxy-server'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(preview.origin + '/') || url.startsWith(`blob:${preview.origin}/`) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  t.after(() => assert.deepEqual(pageErrors, []));
  page.setDefaultTimeout(5000);
  if (seed) {
    const state = await (await fetch(preview.origin + '/__preview/state')).json();
    seed(state);
    await page.addInitScript(({ origin, key, state }) => {
      if (location.origin === origin && !sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify(state));
    }, { origin: preview.origin, key: previewStorageKey, state });
  }
  await page.goto(preview.origin);
  return page;
}

async function readSavedWorkflows(page) {
  const raw = await page.evaluate(({ storage, key }) => JSON.parse(sessionStorage.getItem(storage)).preferences[key],
    { storage: previewStorageKey, key: workflowKey });
  return readWorkflows(raw);
}

async function sidebarButton(page, name) {
  const button = page.getByRole('complementary', { name: 'VPS 对话列表' }).getByRole('button', { name, exact: true });
  await page.getByRole('button', { name: /会话侧栏$/ }).first().waitFor();
  if (!(await button.isVisible())) await page.getByRole('button', { name: /^(展开|收起)会话侧栏$/ }).click();
  return button;
}

async function openDesign(page) {
  await (await sidebarButton(page, '纸间书店')).click();
  await (await sidebarButton(page, '纸间书店 · 网站设计，设计会话')).click();
  await (await sidebarButton(page, '设计工作台')).click();
  if (page.viewportSize().width <= 620) {
    const hideSidebar = page.getByRole('button', { name: '收起会话侧栏', exact: true });
    if (await hideSidebar.isVisible()) await hideSidebar.click();
  }
  const scene = page.getByRole('region', { name: '多画板画布', exact: true });
  await scene.locator('[data-board-id]').first().waitFor();
  return scene;
}

async function assertWithinViewport(locator) {
  await locator.waitFor();
  const geometry = await locator.evaluate((element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { left, top, right, bottom, width: innerWidth, height: innerHeight };
  });
  assert.ok(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height,
    JSON.stringify(geometry));
}

test('P0 keeps unsaved workflow names and links until a guarded action succeeds', { timeout: 40_000 }, async (t) => {
  const otherId = 'a45320ea-6bca-4dc0-8255-9c63d4f40e27';
  const page = await openPreview(t, { seed(state) {
    const [original] = readWorkflows(state.preferences[workflowKey]);
    state.preferences[workflowKey] = JSON.stringify([original, { ...original, id: otherId, name: '第二个工作流' }]);
  } });
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '工作流', exact: true });
  const prompt = page.getByRole('dialog', { name: '工作流有未保存的修改', exact: true });
  const choices = panel.getByLabel('已保存的工作流');
  const newWorkflow = panel.getByRole('button', { name: '新建工作流', exact: true });
  const name = panel.getByLabel('工作流名称');
  const stay = prompt.getByRole('button', { name: '留在当前', exact: true });
  const discard = prompt.getByRole('button', { name: '放弃修改', exact: true });
  const save = prompt.getByRole('button', { name: '保存并继续', exact: true });
  const [original] = await readSavedWorkflows(page);

  await choices.selectOption(otherId);
  assert.equal(await name.inputValue(), '第二个工作流');
  await newWorkflow.click();
  assert.equal(await prompt.isVisible(), false);
  assert.equal(await name.inputValue(), '');
  await choices.selectOption(original.id);
  await discard.click();
  assert.equal(await name.inputValue(), original.name);

  const edited = '活动页发布 · 未保存名称';
  await name.fill(edited);
  await newWorkflow.click();
  await stay.press('Enter');
  assert.equal(await name.inputValue(), edited);
  assert.equal(await newWorkflow.evaluate((button) => button === document.activeElement), true);

  await panel.getByRole('button', { name: /撰写页面文案/ }).first().click();
  const link = panel.getByRole('button', { name: '移除第 1 阶段到第 2 阶段的连接', exact: true });
  await link.click();
  await choices.selectOption(otherId);
  await prompt.waitFor();
  await page.keyboard.press('Escape');
  await prompt.waitFor({ state: 'hidden' });
  assert.equal(await choices.evaluate((select) => select === document.activeElement), true);
  assert.equal(await choices.inputValue(), original.id);
  assert.equal(await name.inputValue(), edited);
  assert.equal(await link.count(), 0);

  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  assert.equal(await name.inputValue(), edited);

  await page.evaluate((key) => {
    const base = window.vpsWorkbench.setPreference;
    window.workflowWrites = 0;
    window.rejectWorkflowWrite = true;
    window.vpsWorkbench.setPreference = async (name, value) => {
      if (name === key) {
        window.workflowWrites++;
        if (window.rejectWorkflowWrite) throw new Error('夹具模拟保存失败');
      }
      return base(name, value);
    };
  }, workflowKey);
  await choices.selectOption(otherId);
  await save.click();
  await prompt.getByRole('alert').getByText('夹具模拟保存失败', { exact: true }).waitFor();
  await stay.click();
  assert.equal(await choices.inputValue(), original.id);
  assert.equal(await name.inputValue(), edited);
  assert.equal(await link.count(), 0);
  assert.deepEqual((await readSavedWorkflows(page))[0], original);

  await name.fill('');
  await newWorkflow.click();
  await save.click();
  await prompt.getByRole('alert').getByText(/工作流名称/).waitFor();
  await stay.click();
  assert.equal(await name.inputValue(), '');
  assert.equal(await link.count(), 0);
  assert.equal(await page.evaluate(() => window.workflowWrites), 1);

  await name.fill(edited);
  await page.evaluate(() => { window.rejectWorkflowWrite = false; });
  await newWorkflow.click();
  await save.click();
  assert.equal(await name.inputValue(), '');
  const saved = (await readSavedWorkflows(page)).find(({ id }) => id === original.id);
  assert.equal(saved.name, edited);
  assert.equal(saved.revision, original.revision + 1);
  assert.deepEqual(saved.edges, original.edges.filter(({ from, to }) => from !== 's1' || to !== 's2'));
  assert.equal(await page.evaluate(() => window.workflowWrites), 2);

  await choices.selectOption(otherId);
  await discard.click();
  await name.fill('要明确放弃的修改');
  await choices.selectOption(original.id);
  await discard.click();
  assert.equal(await name.inputValue(), edited);
  await choices.selectOption(otherId);
  assert.equal(await name.inputValue(), '第二个工作流');
  assert.equal(await prompt.isVisible(), false);
  await name.fill('第二个工作流 · 保存后切换');
  await choices.selectOption(original.id);
  await save.click();
  assert.equal(await choices.inputValue(), original.id);
  assert.equal(await name.inputValue(), edited);
  const second = (await readSavedWorkflows(page)).find(({ id }) => id === otherId);
  assert.equal(second.name, '第二个工作流 · 保存后切换');
  assert.equal(second.revision, original.revision + 1);
  assert.equal(await page.evaluate(() => window.workflowWrites), 3);
});

test('P1 brings the run form and status into view without dropping workflow configuration', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 365, height: 480 } });
  await (await sidebarButton(page, '工作流')).click();
  const panel = page.getByRole('dialog', { name: '工作流', exact: true });
  const views = panel.getByRole('group', { name: '工作流面板' });
  const config = panel.getByRole('region', { name: '工作流配置' });
  const run = panel.getByRole('region', { name: '工作流运行' });
  const name = config.getByLabel('工作流名称');
  const start = run.getByRole('button', { name: '开始运行', exact: true });
  await name.fill('窄窗工作流草稿');
  await views.getByRole('button', { name: '运行', exact: true }).press('Enter');
  await assertWithinViewport(start);
  assert.equal(await start.isDisabled(), true);
  await run.getByText('保存工作流后可以运行。', { exact: true }).waitFor();
  await views.getByRole('button', { name: '配置', exact: true }).press('Enter');
  assert.equal(await name.inputValue(), '窄窗工作流草稿');
  await panel.getByRole('button', { name: '保存工作流', exact: true }).click();
  await views.getByRole('button', { name: '运行', exact: true }).click();
  await run.getByRole('textbox', { name: '运行任务' }).fill('检查预览中的发布流程。');
  await assertWithinViewport(start);
  await start.click();
  const active = run.getByText('当前运行 · 运行中', { exact: true });
  await assertWithinViewport(active);
  await page.setViewportSize({ width: 1280, height: 720 });
  await config.waitFor();
  assert.equal(await views.isVisible(), false);
  const [configuration, running] = await Promise.all([config.boundingBox(), run.boundingBox()]);
  assert.ok(configuration.x < running.x && Math.abs(configuration.y - running.y) < 2);
});

test('P1 keeps edit, zoom and fit available when a narrow canvas has an attachment', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 365, height: 480 } });
  const scene = await openDesign(page);
  await scene.getByRole('button').first().click();
  const controls = page.locator('.vc-playground-controls');
  const more = controls.getByRole('button', { name: '更多画板操作', exact: true });
  const menu = page.getByRole('menu', { name: '更多画板操作', exact: true });
  await more.press('Enter');
  const iterate = menu.getByRole('menuitem', { name: '迭代所选', exact: true });
  assert.equal(await iterate.evaluate((button) => button === document.activeElement), true);
  await iterate.press('Enter');
  await page.locator('.vc-context-attachment').filter({ hasText: /迭代 ·/ }).waitFor();
  const edit = controls.getByRole('button', { name: '编辑画板', exact: true });
  const fit = controls.getByRole('button', { name: '适应全部画板', exact: true });
  await assertWithinViewport(edit);
  await assertWithinViewport(fit);
  for (const label of ['缩小画布', '放大画布']) await assertWithinViewport(controls.getByRole('button', { name: label }));
  assert.equal(await controls.evaluate((bar) => bar.scrollWidth <= bar.clientWidth), true);
  await fit.press('Enter');
  await more.press('Enter');
  await page.keyboard.press('ArrowDown');
  assert.equal(await menu.getByRole('menuitem', { name: '生成变体' }).evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press('End');
  assert.equal(await menu.getByRole('menuitem', { name: '移除画板附件', exact: true })
    .evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await more.evaluate((button) => button === document.activeElement), true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await assertWithinViewport(controls.getByRole('button', { name: '迭代所选', exact: true }));
  assert.equal(await more.isVisible(), false);
  await edit.press('Enter');
  await page.getByRole('region', { name: '单画板画布' }).waitFor();
});

test('P2 format commands pass the displayed board IDs and order to the export entry', () => {
  const entries = [
    { id: 'version-a:2', version: 1, title: '详情', html: '<h1>旧版详情</h1>' },
    { id: 'version-b:1', version: 2, title: '首页', html: '<h1>新版首页</h1>' },
  ];
  const packets = [];
  for (const contextSelection of [false, true]) {
    const { actions, summary } = designExportMenu(entries, (format, boards) => packets.push({ format, boards }), { contextSelection });
    assert.deepEqual(summary.items.map(({ id }) => id), ['version-a:2', 'version-b:1']);
    for (const action of actions) if (!action.disabled) action.run();
  }
  assert.deepEqual(packets.map(({ format }) => format), ['html', 'zip', 'pdf', 'pptx', 'html', 'zip', 'pdf', 'pptx']);
  assert.ok(packets.every(({ boards }) => boards === entries));
});

test('P2 exports the cross-version selection and the current version through distinct keyboard controls', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 365, height: 480 } });
  const scene = await openDesign(page);
  const cover = scene.getByRole('button', { name: '纸间书店 · 首页', exact: true });
  const fork = scene.getByRole('button', { name: '纸间书店 · 青色分支', exact: true });
  await cover.press('Enter');
  await fork.press('Shift+Enter');
  const batch = page.getByRole('button', { name: '导出所选（2）', exact: true });
  const current = page.getByRole('button', { name: '导出当前版本', exact: true });
  await assertWithinViewport(batch);
  await assertWithinViewport(current);

  let focused = false;
  for (let steps = 0; steps < 25 && !focused; steps++) {
    await page.keyboard.press('Tab');
    focused = await batch.evaluate((node) => node === document.activeElement);
  }
  assert.ok(focused, 'selection export must be reached with Tab');
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: '导出格式', exact: true });
  const inside = menu.locator('[data-export-board-id]');
  async function boardIds() { return inside.evaluateAll((nodes) => nodes.map((node) => node.dataset.exportBoardId)); }
  async function sceneIds(onlySelected) {
    return scene.locator(onlySelected ? '[data-board-id][data-selected=true]' : '[data-board-id]').evaluateAll((nodes) => nodes.map((node) => node.dataset.boardId));
  }
  const [first, third] = await sceneIds(true);
  assert.notEqual(first.split(':')[0], third.split(':')[0]);
  assert.deepEqual(await boardIds(), [first, third]);

  async function downloadTitles() {
    const pending = page.waitForEvent('download');
    await menu.getByRole('menuitem', { name: '下载 HTML', exact: true }).press('Enter');
    const result = await pending;
    assert.equal(result.suggestedFilename(), 'dsh-design.html');
    const html = await readFile(await result.path(), 'utf8');
    return [...html.matchAll(/<iframe id="design-board-\d+" data-board-frame [^>]*?title="([^"]+)"/g)].map(([, title]) => title);
  }
  assert.deepEqual(await downloadTitles(), ['纸间书店 · 首页', '纸间书店 · 青色分支']);
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await batch.evaluate((node) => node === document.activeElement), true);

  await current.press('ArrowDown');
  await menu.waitFor();
  const currentIds = (await sceneIds(false)).filter((id) => id.split(':')[0] === first.split(':')[0]);
  assert.equal(currentIds.length, 2);
  assert.deepEqual(await boardIds(), currentIds);
  const currentTitles = await downloadTitles();
  assert.equal(currentTitles.length, 2);
  assert.equal(currentTitles[0], '纸间书店 · 首页');
  assert.ok(!currentTitles.includes('纸间书店 · 青色分支'));

  await cover.press('Shift+F10');
  const contextMenu = page.getByRole('menu', { name: '所选画板操作', exact: true });
  assert.deepEqual(await contextMenu.locator('[data-export-board-id]').evaluateAll((nodes) => nodes.map((node) => node.dataset.exportBoardId)), [first, third]);
  await contextMenu.getByRole('menuitem', { name: '导出所选画板为 ZIP', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await cover.evaluate((node) => node === document.activeElement), true);

  await page.getByRole('group', { name: '画板浏览', exact: true }).getByRole('button', { name: '单画板', exact: true }).press('Enter');
  const single = page.frameLocator('iframe[title="设计原型预览"]');
  await single.getByRole('heading').first().waitFor();
  await current.press('Enter');
  await menu.waitFor();
  await single.getByRole('heading').first().click();
  await menu.waitFor({ state: 'hidden' });
});

test('P3 live settings survive discarding provider switches and explicit saves reach the picker', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t);
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const open = () => page.getByRole('button', { name: '设置', exact: true }).click();

  const api = settings.getByRole('checkbox', { name: 'Claude API', exact: true });
  const tools = settings.getByRole('region', { name: '执行端', exact: true });
  const codex = tools.locator('details').filter({ hasText: 'Codex 独立设置' });
  const light = settings.getByRole('group', { name: '主题', exact: true }).getByRole('button', { name: '浅色', exact: true });
  const savedModel = 'preview-codex-mini';

  await open();
  await openSettingsSection(settings, '外观');
  await settings.getByText('实时保存', { exact: true }).waitFor();
  await light.click();
  await openSettingsSection(settings, '执行端');
  await api.uncheck();
  await codex.locator('summary').click();
  await codex.getByRole('button', { name: '读取模型目录', exact: true }).click();
  await codex.getByRole('combobox', { name: '模型', exact: true }).selectOption(savedModel);
  await settings.getByRole('button', { name: '放弃启用变更', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });

  await open();
  await openSettingsSection(settings, '外观');
  assert.equal(await light.getAttribute('aria-pressed'), 'true');
  await openSettingsSection(settings, '执行端');
  assert.equal(await api.isChecked(), true);
  await codex.locator('summary').click();
  await codex.getByText(`当前配置 · 已保存 ${savedModel}`, { exact: true }).waitFor();
  await api.uncheck();
  await settings.getByRole('button', { name: '保存启用变更', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  await open();
  await openSettingsSection(settings, '执行端');
  assert.equal(await api.isChecked(), false);
  await api.check();
  await settings.getByRole('button', { name: '保存启用变更', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: '切换 VPS 执行端', exact: true }).click();
  await page.getByRole('option', { name: 'Claude API', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await open();
  await settings.getByRole('button', { name: '接入向导', exact: true }).click();
  await page.getByRole('dialog', { name: 'VPS 接入向导', exact: true }).getByRole('radio', { name: 'Claude API', exact: true }).waitFor();
});

test('P4 keeps base failures blocking and runs the isolated sample despite optional Agent failures', { timeout: 35_000 }, async (t) => {
  const mcpId = 'da78a36e-e0a0-4bcd-89d8-b9a302d66509';
  const modelId = '78cc1579-978b-4a2f-a3a7-7712899cdc10';
  const { targetId, settings: fixtureSettings } = createPreviewFixtures().chat({ op: 'preset' }).preset;
  const page = await openPreview(t, { seed(state) {
    const savePreset = (presets, id, name, model, extra = []) => applyAgentPresetChange(presets, { op: 'save', id, revision: null, draft: {
      name, modules: [{ id: 'executor', config: { provider: 'codex', model } },
        { id: 'persona', config: { instruction: '检查演示资源。' } }, ...extra],
    } });
    const resources = savePreset([], mcpId, '带有缺失 MCP 的 Agent', 'preview-codex-mini', [
      { id: 'mcp', config: { servers: [{ id: 'missing-fixture-mcp', targetId }] } },
    ]);
    state.preferences[agentPresetKey] = JSON.stringify(savePreset(resources, modelId, '指定旧模型的 Agent', 'obsolete-agent-model'));
  } });
  let failure = '';
  const packets = [];
  await page.route('**/dsh-vps-chat/api/rpc', (route) => {
    const packet = route.request().postDataJSON();
    packets.push(packet);
    if (packet.op === 'setup-check' && packet.kind === failure) {
      return route.fulfill({ json: { ok: false, code: `fixture_${failure}`, message: `夹具检查失败 ${failure}` } });
    }
    if (packet.op === 'models' && failure === 'catalog') return route.fulfill({ json: { ok: true, models: [] } });
    return route.continue();
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '接入向导', exact: true }).click();
  const guide = page.getByRole('dialog', { name: 'VPS 接入向导', exact: true });
  const base = guide.getByRole('region', { name: '基础接入检查', exact: true });
  const extras = guide.getByRole('region', { name: '额外 Agent 检查', exact: true });
  const step = (region, name) => region.getByRole('listitem', { name, exact: true });
  const check = guide.getByRole('button', { name: /^(开始检查|重新检查)$/ });
  const example = guide.getByRole('button', { name: '运行示例工作流', exact: true });
  for (const [kind, label, message] of [['ssh', 'SSH 连接与主机指纹', /夹具检查失败 ssh/],
    ['model', '预期 VPS 出口', /夹具检查失败 model/], ['account', '账号登录', /夹具检查失败 account/],
    ['catalog', '模型目录', /未返回可选模型/]]) {
    failure = kind;
    await check.click();
    await step(base, label).getByRole('alert').getByText(message).waitFor();
    assert.equal(await example.count(), 0);
  }

  failure = '';
  const selected = extras.getByLabel('检查额外 Agent');
  await selected.selectOption(mcpId);
  await check.click();
  await base.getByText('4 / 4 项通过', { exact: true }).waitFor();
  await step(extras, 'MCP 服务器').getByRole('alert').getByText(/missing-fixture-mcp/).waitFor();
  await step(extras, '插件模板').getByText('已通过', { exact: true }).waitFor();
  assert.equal(await example.isEnabled(), true);

  await selected.selectOption(modelId);
  assert.equal(await example.isEnabled(), true);
  await check.click();
  await step(extras, 'Agent 模型').getByRole('alert').getByText(/obsolete-agent-model/).waitFor();
  await base.getByText('4 / 4 项通过', { exact: true }).waitFor();
  assert.equal(packets.filter(({ op }) => op === 'send').length, 0);
  await example.click();
  const workflow = page.getByRole('dialog', { name: '工作流', exact: true });
  await workflow.getByText('接入示例 · 读书会活动页', { exact: true }).waitFor();
  await workflow.getByLabel('第 2 阶段输出', { exact: true }).waitFor({ timeout: 18_000 });
  const sends = packets.filter(({ op }) => op === 'send');
  assert.equal(sends.length, 2);
  assert.ok(sends.every((packet) => packet.settings.host === fixtureSettings.host && packet.settings.provider === 'codex' &&
    packet.targetId === targetId && packet.model === 'preview-codex' && !packet.extensions && !packet.projectMemory));
});

test('connection save, preflight and model trial report distinct evidence and keep the original VPS receipt', { timeout: 45_000 }, async (t) => {
  const page = await openPreview(t);
  const packets = [];
  let failEgress = true;
  let loseReply = true;
  await page.route('**/dsh-vps-chat/api/rpc', async (route) => {
    const packet = route.request().postDataJSON();
    packets.push(packet);
    if (packet.op === 'setup-check' && packet.kind === 'model' && failEgress) {
      return route.fulfill({ json: { ok: false, code: 'setup_model_route', message: '夹具：预期出口未确认。' } });
    }
    if (packet.op === 'setup-trial' && packet.kind === 'start' && loseReply) {
      loseReply = false;
      const upstream = await route.fetch();
      await upstream.dispose();
      return route.abort();
    }
    return route.continue();
  });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  async function open() {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings.getByRole('button', { name: '连接', exact: true }).click();
  }
  const results = settings.getByRole('region', { name: 'VPS 连接检查', exact: true });
  const testConnection = results.getByRole('button', { name: '测试连接', exact: true });
  const step = (name) => results.getByRole('listitem', { name, exact: true });
  const response = step('实际模型响应');
  const launch = response.getByRole('button', { name: '试跑模型', exact: true });
  const field = settings.getByLabel('SSH 私钥文件路径', { exact: true });
  const save = settings.getByRole('button', { name: '保存连接配置', exact: true });

  await open();
  await field.fill('C:/Preview/replacement-key');
  await settings.getByText('连接配置未保存', { exact: true }).waitFor();
  assert.equal(await testConnection.isDisabled(), true);
  await save.click();
  await settings.getByText('连接配置已保存', { exact: true }).waitFor();
  assert.equal(packets.some(({ op }) => op === 'setup-check' || op === 'setup-trial' || op === 'send'), false);
  await response.getByText('未试跑', { exact: true }).waitFor();
  assert.equal(await launch.isDisabled(), true);

  await testConnection.click();
  await step('预期 VPS 出口').getByRole('alert').filter({ hasText: '预期出口未确认' }).waitFor();
  await step('SSH 连接与主机指纹').getByText('已通过', { exact: true }).waitFor();
  await step('账号登录').getByText('待检查', { exact: true }).waitFor();
  await step('预期 VPS 出口').getByRole('button', { name: '核对预期出口', exact: true }).click();
  assert.equal(await settings.getByLabel('预期 VPS 出口 IPv4', { exact: true })
    .evaluate((node) => node === document.activeElement), true);

  failEgress = false;
  await testConnection.click();
  await results.getByText('预检通过', { exact: true }).waitFor();
  for (const name of ['账号登录', '模型目录']) await step(name).getByText('已通过', { exact: true }).waitFor();
  assert.equal(packets.some(({ op }) => op === 'setup-trial' || op === 'send'), false);
  await launch.press('Enter');
  await response.getByText('试跑结果待确认。请查询原回执。', { exact: true }).waitFor();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('本机保存的 VPS · VPS 已配置', { exact: true }).waitFor();
  await open();
  assert.equal(await field.inputValue(), 'C:/Preview/replacement-key');
  await response.getByRole('button', { name: '查询原回执', exact: true }).click();
  await response.getByRole('button', { name: '试跑模型', exact: true }).waitFor();
  await testConnection.click();
  await response.getByText('已通过', { exact: true }).waitFor();
  const starts = packets.filter(({ op, kind }) => op === 'setup-trial' && kind === 'start');
  const inspections = packets.filter(({ op, kind }) => op === 'setup-trial' && kind === 'inspect');
  assert.equal(starts.length, 1);
  assert.ok(inspections.length > 0 && inspections.every(({ sessionId, turnId, targetId, settings }) =>
    sessionId === starts[0].sessionId && turnId === starts[0].turnId && targetId === starts[0].targetId &&
    settings.identityPath === starts[0].settings.identityPath));
  await field.fill('C:/Preview/another-key');
  await response.getByText('未试跑', { exact: true }).waitFor();
  assert.equal(await launch.isDisabled(), true);
  const saved = await page.evaluate(({ key, pref }) => JSON.parse(sessionStorage.getItem(key)).preferences[pref],
    { key: previewStorageKey, pref: setupConnectionKey });
  assert.equal(JSON.parse(saved).settings.identityPath, 'C:/Preview/replacement-key');
});

test('local setup checks credentials and runs only the explicitly selected SDK path', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t, { seed(state) {
    state.preferences['dsh-vps-chat:desktop-view-location:v1'] = 'local-sdk';
  } });
  const ssh = [];
  const local = [];
  await page.route('**/dsh-vps-chat/api/**', (route) => {
    ssh.push(route.request().url());
    return route.abort();
  });
  await page.route('**/__preview/local-sdk', (route) => {
    if (route.request().method() === 'POST') local.push(route.request().postDataJSON());
    return route.continue();
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '测试本机配置', exact: true }).click();
  await settings.getByRole('listitem', { name: '本机 SDK', exact: true }).getByText('已通过', { exact: true }).waitFor();
  await settings.getByRole('listitem', { name: '本机账号凭据', exact: true }).getByText('待确认', { exact: true }).waitFor();
  const response = settings.getByRole('listitem', { name: '实际模型响应', exact: true });
  const trial = response.getByRole('button', { name: '试跑模型', exact: true });
  assert.equal(await trial.isDisabled(), true);
  await settings.getByLabel('配置名称', { exact: true }).fill('隔离配置');
  await settings.getByRole('button', { name: '选择工作目录并保存', exact: true }).click();
  await response.getByText('未试跑', { exact: true }).waitFor();
  assert.equal(local.some(({ op }) => op === 'send'), false);
  await trial.click();
  await response.getByText('已通过', { exact: true }).waitFor();
  const send = local.find(({ op }) => op === 'send');
  assert.equal(send.location, 'local-sdk');
  assert.ok(send.sessionId.startsWith('local-'));
  assert.ok(local.filter(({ op }) => op === 'refresh').every(({ profileId, sessionId, turnId, targetId }) =>
    profileId === send.profileId && sessionId === send.sessionId && turnId === send.turnId && targetId === send.targetId));
  assert.deepEqual(ssh, []);
});

test('settings keep drafts across tabs, guard all exits, and keep instant preferences on discard', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t);
  const entry = page.getByRole('button', { name: '设置', exact: true });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const guard = page.getByRole('dialog', { name: '有未保存的设置', exact: true });

  const tool = settings.getByRole('checkbox', { name: 'Claude API', exact: true });
  const light = settings.getByRole('button', { name: '浅色', exact: true });
  const close = settings.getByRole('button', { name: '关闭设置', exact: true });
  await entry.click();
  await openSettingsSection(settings, '执行端');
  await tool.uncheck();
  await openSettingsSection(settings, '外观');
  await light.click();
  await settings.getByText('应用偏好已保存', { exact: true }).waitFor();
  await settings.getByText('有未保存的设置', { exact: true }).waitFor();
  const disclosure = settings.locator('summary').filter({ hasText: '强调色' });
  await disclosure.press('Enter');
  await settings.getByRole('group', { name: '强调色', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await disclosure.evaluate((node) => node.parentElement.open), false);
  await page.keyboard.press('Escape');
  await guard.waitFor();
  await page.keyboard.press('Escape');
  await guard.waitFor({ state: 'hidden' });
  assert.equal(await disclosure.evaluate((node) => node === document.activeElement), true);

  await close.click();
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await close.evaluate((node) => node === document.activeElement), true);
  await page.mouse.click(2, 4);
  await guard.waitFor();
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await openSettingsSection(settings, '执行端');
  assert.equal(await tool.isChecked(), false);
  await settings.getByRole('button', { name: '接入向导', exact: true }).click();
  await guard.getByRole('button', { name: '放弃修改', exact: true }).click();
  const guide = page.getByRole('dialog', { name: 'VPS 接入向导', exact: true });
  await guide.waitFor();
  await guide.getByRole('button', { name: '关闭接入向导', exact: true }).click();
  await guide.waitFor({ state: 'hidden' });
  await entry.click();
  await openSettingsSection(settings, '执行端');
  assert.equal(await tool.isChecked(), true);
  await openSettingsSection(settings, '外观');
  assert.equal(await light.getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  assert.equal(await entry.evaluate((node) => node === document.activeElement), true);
});

test('failed setting saves preserve their draft and a new VPS keeps the former target enablement separate', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t);
  let refuseSave = true;
  await page.route('**/__preview/connection', (route) => refuseSave ? route.fulfill({ status: 500 }) : route.continue());
  const entry = page.getByRole('button', { name: '设置', exact: true });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const guard = page.getByRole('dialog', { name: '有未保存的设置', exact: true });

  const field = settings.getByLabel('SSH 私钥文件路径', { exact: true });
  const tool = settings.getByRole('checkbox', { name: 'Claude API', exact: true });
  const next = 'C:/Preview/alternate-identity';
  await entry.click();
  await openSettingsSection(settings, '连接');
  await field.fill(next);
  await page.keyboard.press('Escape');
  await guard.getByRole('button', { name: '保存并继续', exact: true }).click();
  await guard.getByRole('alert').filter({ hasText: '连接配置未能保存' }).waitFor();
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await field.inputValue(), next);
  assert.equal(await field.evaluate((node) => node === document.activeElement), true);
  await openSettingsSection(settings, '执行端');
  await tool.uncheck();
  await openSettingsSection(settings, '连接');
  await settings.getByRole('button', { name: '保存连接配置', exact: true }).click();
  await guard.getByText('请先处理原连接的执行端启用变更。', { exact: true }).waitFor();
  refuseSave = false;
  await guard.getByRole('button', { name: '保存并继续', exact: true }).click();
  await settings.getByText('连接配置已保存', { exact: true }).waitFor();
  await openSettingsSection(settings, '执行端');
  assert.equal(await tool.isChecked(), false);
  const prefs = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).preferences, previewStorageKey);
  const oldEnabled = Object.entries(prefs).find(([key]) => key.startsWith('dsh-vps-chat-tools:v1:'));
  assert.deepEqual(JSON.parse(oldEnabled[1]), ['codex', 'claude-sdk', 'antigravity', 'claude-subscription']);
  assert.equal(JSON.parse(prefs[setupConnectionKey]).settings.identityPath, next);
});

test('a changed SSH pin requires fresh confirmation in settings and in the wizard', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t);
  await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
  const calls = [];
  await page.route('**/dsh-vps-chat/api/rpc', (route) => {
    const { op } = route.request().postDataJSON();
    calls.push(op);
    return op === 'list' ? route.fulfill({ json: { ok: true, targetId: 'a'.repeat(64),
      memoryTargetId: 'b'.repeat(64), sessions: [] } }) : route.continue();
  });
  const entry = page.getByRole('button', { name: '设置', exact: true });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await entry.click();
  await settings.getByRole('button', { name: '连接', exact: true }).click();
  const save = settings.getByRole('button', { name: '保存连接配置', exact: true });
  await save.click();
  await settings.getByText('SSH 主机指纹已变化。请重新核对并确认后保存。', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('checkbox', { name: /已核对/u }).isChecked(), false);
  assert.equal(await save.isDisabled(), true);
  await settings.getByRole('button', { name: '接入向导', exact: true }).click();
  const guide = page.getByRole('dialog', { name: 'VPS 接入向导', exact: true });
  await guide.getByRole('radio', { name: 'Claude API', exact: true }).check();
  await guide.getByRole('button', { name: '开始检查', exact: true }).click();
  await guide.getByRole('listitem', { name: 'SSH 连接与主机指纹', exact: true }).getByRole('alert')
    .filter({ hasText: 'VPS 设置或主机指纹已变化' }).waitFor();
  assert.equal(calls.includes('setup-check'), false);
  await guide.getByRole('button', { name: '编辑连接', exact: true }).click();
  assert.equal(await guide.getByRole('checkbox', { name: /已核对/u }).isChecked(), false);
  assert.equal(await guide.getByRole('button', { name: '连接并检查', exact: true }).isDisabled(), true);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 365, height: 480 }, { width: 420, height: 640 }]) {
  test(`settings separate execution locations and keep controls reachable at ${viewport.width}×${viewport.height}`,
    { timeout: 35_000 }, async (t) => {
      const page = await openPreview(t, { viewport });
      await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
      const entry = page.getByRole('button', { name: '设置', exact: true });
      if (!await entry.isVisible()) await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click();
      await entry.press('Enter');
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      const navigation = settings.getByRole('navigation', { name: '设置分类', exact: true });
      assert.deepEqual(await navigation.getByRole('button').allTextContents(),
        ['连接', '模型与账号', 'Agent 与工具', '数据与记忆', '应用偏好']);
      await openSettingsSection(settings, '提示词模板');
      await settings.getByRole('heading', { name: '提示词模板', exact: true }).waitFor();
      await assertWithinViewport(settings.getByRole('button', { name: '完成', exact: true }));

      const requests = [];
      await page.route('**/dsh-vps-chat/api/rpc', (route) => {
        requests.push(route.request().postDataJSON());
        return route.continue();
      });
      await openSettingsSection(settings, '账号');
      const claude = settings.getByRole('region', { name: 'Claude API', exact: true });
      await claude.getByRole('button', { name: '检查账号和目录', exact: true }).press('Enter');
      await claude.getByText(/已配置私有 API 密钥/u).waitFor();
      const checks = requests.filter(({ op }) => ['setup-check', 'models'].includes(op));
      assert.ok(checks.length >= 3 && checks.every(({ settings: route }) => route.provider === 'claude'));
      assert.equal(requests.some(({ op }) => op === 'send' || op === 'setup-trial'), false);

      await openSettingsSection(settings, '连接');
      const sshFields = settings.getByLabel('SSH 用户名', { exact: true });
      await sshFields.fill('preview-draft');
      const routeOptions = settings.getByRole('group', { name: '配置的执行位置', exact: true });
      await routeOptions.getByRole('button', { name: '本机 SDK', exact: true }).press('Enter');
      const guard = page.getByRole('dialog', { name: '有未保存的设置', exact: true });
      await page.keyboard.press('Escape');
      await guard.waitFor({ state: 'hidden' });
      assert.equal(await sshFields.inputValue(), 'preview-draft');
      await routeOptions.getByRole('button', { name: '本机 SDK', exact: true }).click();
      await guard.getByRole('button', { name: '放弃修改', exact: true }).press('Enter');
      await settings.getByRole('heading', { name: '本机 SDK 连接', exact: true }).waitFor();
      assert.equal(await routeOptions.getByRole('button', { name: '本机 SDK', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await sshFields.count(), 0);
      const priorVpsRequests = requests.length;
      await openSettingsSection(settings, '账号');
      await settings.getByRole('button', { name: '测试本机配置', exact: true }).click();
      await settings.getByRole('listitem', { name: '本机 SDK', exact: true }).getByText('已通过', { exact: true }).waitFor();
      assert.equal(requests.length, priorVpsRequests);
      await openSettingsSection(settings, '外观');
      const light = settings.getByRole('button', { name: '浅色', exact: true });
      await light.press('Enter');
      await settings.getByText('应用偏好已保存', { exact: true }).waitFor();
      await assertWithinViewport(settings.getByRole('button', { name: '完成', exact: true }));
      await openSettingsSection(settings, '连接');
      await routeOptions.getByRole('button', { name: 'VPS SSH', exact: true }).press('Enter');
      await settings.getByRole('heading', { name: 'VPS 连接', exact: true }).waitFor();
      assert.equal(await sshFields.inputValue(), 'preview');
      await openSettingsSection(settings, '外观');
      assert.equal(await light.getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      await settings.waitFor({ state: 'hidden' });
      assert.equal(await entry.evaluate((node) => node === document.activeElement), true);
      assert.equal(await page.getByLabel('新建位置', { exact: true }).inputValue(), 'ssh-vps');
    });
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 365, height: 480 }]) {
  test(`P5 keeps workspace, board and resource controls distinct at ${viewport.width}×${viewport.height}`, { timeout: 30_000 }, async (t) => {
    const page = await openPreview(t, { viewport });
    await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
    await (await sidebarButton(page, '纸间书店')).click();
    await (await sidebarButton(page, '纸间书店 · 网站设计，设计会话')).click();
    const closeRail = page.getByRole('button', { name: '收起会话侧栏', exact: true });
    if (viewport.width < 600 && await closeRail.isVisible()) await closeRail.click();
    const layout = page.getByRole('group', { name: '工作区布局', exact: true });
    await layout.getByRole('button', { name: '对话', exact: true }).waitFor();
    if (viewport.width === 1280) await layout.getByRole('button', { name: '并排', exact: true }).waitFor();
    await layout.getByRole('button', { name: '画布', exact: true }).press('Enter');
    const browse = page.getByRole('group', { name: '画板浏览', exact: true });
    await browse.getByRole('button', { name: '单画板', exact: true }).waitFor();
    await browse.getByRole('button', { name: '多画板', exact: true }).press('Enter');
    const canvas = page.getByRole('region', { name: '设计工作台', exact: true });
    await canvas.getByRole('heading', { name: '设计工作台', exact: true }).waitFor();
    await assertWithinViewport(canvas.getByRole('button', { name: '适应全部画板', exact: true }));

    const entry = await sidebarButton(page, '项目资源库');
    await entry.press('Enter');
    const library = page.getByRole('dialog', { name: '项目资源库', exact: true });
    const query = library.getByRole('searchbox', { name: '搜索资源', exact: true });
    assert.equal(await query.evaluate((element) => document.activeElement === element), true);
    const catalog = library.getByRole('region', { name: '资源列表', exact: true });
    const board = catalog.getByRole('button', { name: /纸间书店 · 首页/ }).first();
    await board.press('Enter');
    const detail = library.getByRole('region', { name: '纸间书店 · 首页', exact: true });
    const source = detail.getByRole('button', { name: '打开来源会话', exact: true });
    await assertWithinViewport(source);
    await page.keyboard.press('Escape');
    await library.waitFor({ state: 'hidden' });
    assert.equal(await entry.evaluate((element) => document.activeElement === element), true);

    if (viewport.width === 1280) {
      await page.getByRole('button', { name: '切换 VPS 执行端', exact: true }).click();
      await page.getByRole('option', { name: 'Claude Code（订阅终端）', exact: true }).click();
      const terminal = page.getByRole('region', { name: 'Claude Code 订阅终端', exact: true });
      await terminal.getByText('终端会话未连接', { exact: true }).waitFor();
    }
  });
}
