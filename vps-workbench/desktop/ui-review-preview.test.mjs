import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openSettingsSection } from './test-settings.mjs';
import { startPreview } from './preview-server.mjs';
import { applyWorkflowChange, readWorkflows, workflowKey } from '../workflow-engine/state.mjs';
import { agentPresetKey, applyAgentPresetChange } from '../agent-presets/state.mjs';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { designExportMenu } from '../../remote-workbench/vps-chat/client/design-export-menu.js';
import { setupConnectionKey } from './setup-state.mjs';
import { extensionPreferenceKey, readExtensions } from '../extensions/state.mjs';
import { conversationLink, parseConversationLink, readQuotedPrompt } from '../../remote-workbench/vps-chat/client/chat-reference.js';

const require = createRequire(import.meta.url);
const { chromium } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const previewStorageKey = 'vps-workbench-preview-state';
const workbenchPreferenceKey = 'dsh-vps-chat:workbench:v1';

async function openCopiedLink(page, value) {
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('menuitem', { name: '打开对话链接…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '打开对话链接', exact: true });
  await dialog.getByLabel('对话链接', { exact: true }).fill(value);
  await dialog.getByRole('button', { name: '打开', exact: true }).click();
  return dialog;
}

async function openPreview(t, { viewport = { width: 1280, height: 720 }, seed, previewOptions } = {}) {
  const preview = await startPreview({ ...previewOptions, port: 0, watch: false });
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

test('the persistent shortcut rail docks conversation history beside the workspace', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t);
  const compact = page.getByRole('navigation', { name: '快捷侧栏', exact: true });
  const history = page.getByRole('complementary', { name: 'VPS 对话列表' });
  const main = page.locator('#root > [data-vps-chat] > .vc-main');
  await compact.waitFor();
  await history.waitFor({ state: 'hidden' });
  assert.equal((await compact.boundingBox()).width, 52);
  const initial = await main.boundingBox();
  const toggle = compact.getByRole('button', { name: '会话与项目', exact: true });
  await toggle.press('Enter');
  await history.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const docked = await main.boundingBox();
  assert.ok(docked.x > initial.x && docked.width < initial.width);
  assert.equal(docked.x + docked.width, initial.x + initial.width);
  const panel = await history.boundingBox();
  assert.equal(docked.x, panel.x + panel.width);
  await history.getByRole('button', { name: '纸间书店', exact: true }).focus();
  await page.keyboard.press('Escape');
  await history.waitFor({ state: 'hidden' });
  assert.equal(await toggle.evaluate((button) => document.activeElement === button), true);
  await toggle.click();
  await history.waitFor();
  await page.getByRole('textbox', { name: '消息', exact: true }).click();
  await history.waitFor();
  await (await sidebarButton(page, '纸间书店')).click();
  await (await sidebarButton(page, '纸间书店 · 周末发布清单')).click();
  await history.waitFor();
  await toggle.click();
  await history.waitFor({ state: 'hidden' });
  assert.deepEqual(await main.boundingBox(), initial);
  const titleToggle = page.locator('.desktop-sidebar-button');
  await titleToggle.press('Enter');
  await history.waitFor();
  await titleToggle.press('Escape');
  await history.waitFor({ state: 'hidden' });
  const searchButton = compact.getByRole('button', { name: '查找会话和资源', exact: true });
  await searchButton.press('Enter');
  const search = page.getByRole('dialog', { name: '本地全局搜索', exact: true });
  await search.getByRole('searchbox').waitFor();
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'hidden' });
  await compact.getByRole('button', { name: '项目资源库', exact: true }).press('Enter');
  const library = page.getByRole('dialog', { name: '项目资源库', exact: true });
  await library.getByRole('searchbox').waitFor();
  await page.keyboard.press('Escape');
  await library.waitFor({ state: 'hidden' });
  await compact.getByRole('button', { name: '新建对话', exact: true }).press('Enter');
  await page.getByRole('heading', { name: '开始一段对话', exact: true }).waitFor();
  await toggle.click();
  await history.waitFor();
  await page.setViewportSize({ width: 365, height: 480 });
  await compact.waitFor({ state: 'hidden' });
  await history.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click();
  await history.getByRole('button', { name: '新建对话', exact: true }).waitFor();
});

test('the provider palette expands inline to the right and puts the current tool first', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t);
  const trigger = page.getByRole('button', { name: '切换 VPS 执行端', exact: true });
  const palette = page.getByRole('listbox', { name: '已配置的 VPS 执行端', exact: true });
  const badge = trigger.locator('.vc-tool-badge');
  await page.evaluate(() => {
    window.fixtureProviderMoves = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, timing) {
      const animation = animate.call(this, frames, timing);
      if (this.matches('.vc-tool-option') && frames[0]?.translate) {
        window.fixtureProviderMoves.push({ label: this.getAttribute('aria-label'),
          distance: Number.parseFloat(frames[0].translate), duration: animation.effect.getTiming().duration });
      }
      return animation;
    };
  });
  await trigger.waitFor();
  const anchor = await badge.boundingBox();
  await trigger.click();
  const current = palette.getByRole('option', { name: 'Codex', exact: true });
  await current.waitFor();
  assert.equal(await palette.getByRole('option').first().getAttribute('aria-label'), 'Codex');
  const activeIcon = await current.locator('.vc-menu-icon').boundingBox();
  assert.ok(Math.abs(anchor.x + anchor.width / 2 - activeIcon.x - activeIcon.width / 2) < 1);
  assert.ok(Math.abs(anchor.y + anchor.height / 2 - activeIcon.y - activeIcon.height / 2) < 1);
  const other = palette.getByRole('option', { name: 'Claude API', exact: true });
  assert.ok((await other.boundingBox()).x > activeIcon.x + activeIcon.width);
  await other.click();
  const first = palette.getByRole('option').first();
  await palette.getByRole('option', { name: 'Claude API', selected: true }).waitFor();
  assert.equal(await first.getAttribute('aria-label'), 'Claude API');
  assert.equal(await first.evaluate((button) => document.activeElement === button), true);
  assert.deepEqual(await page.evaluate(() => window.fixtureProviderMoves), []);
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate((button) => document.activeElement === button), true);
  await trigger.press('ArrowDown');
  await palette.waitFor();
  assert.equal(await first.getAttribute('aria-label'), 'Claude API');
  await page.locator('.desktop-brand').click();
  await palette.waitFor({ state: 'hidden' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await trigger.click();
  await current.click();
  await palette.getByRole('option', { name: 'Codex', selected: true }).waitFor();
  assert.equal(await first.getAttribute('aria-label'), 'Codex');
  const moves = await page.evaluate(() => window.fixtureProviderMoves);
  assert.deepEqual(moves.map(({ label, distance }) => [label, Math.sign(distance)]), [['Codex', 1], ['Claude API', -1]]);
  assert.ok(moves.every(({ duration }) => duration === 180));
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });
});

test('subscription rings distinguish exhausted, unavailable and weekly-only observations', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t);
  await page.route('**/dsh-vps-chat/api/rpc', async (route) => {
    if (route.request().postDataJSON().op !== 'get') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    const turn = json.session?.turns.at(-1);
    if (turn) turn.subscriptionLimits = {
      fiveHour: { usedPercent: 92, resetsAt: 1 },
      weekly: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    };
    return route.fulfill({ response, json });
  });
  await (await sidebarButton(page, '纸间书店')).click();
  await (await sidebarButton(page, '纸间书店 · 周末发布清单')).click();
  const summary = page.getByRole('button', { name: '切换 VPS 执行端', exact: true });
  await summary.getByRole('img', { name: '5 小时额度，暂无数据', exact: true }).waitFor();
  await summary.getByRole('img', { name: '每周额度，剩余 0%', exact: true }).waitFor();
  await summary.press('Enter');
  await page.getByRole('region', { name: 'Codex', exact: true })
    .getByRole('group', { name: '每周额度，剩余 0%', exact: true }).getByText('0%', { exact: true }).waitFor();
});

test('subscription details fit the narrow view without scrolling and paginate extra profiles', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 365, height: 480 } });
  const vpsTrigger = page.getByRole('button', { name: '切换 VPS 执行端', exact: true });
  const localTrigger = page.getByRole('button', { name: '切换本机执行端', exact: true });
  const details = page.getByRole('region', { name: '已配置的订阅额度', exact: true });
  const fits = () => details.evaluate((element) => element.scrollHeight <= element.clientHeight + 1 &&
    getComputedStyle(element).overflowY === 'clip');
  await vpsTrigger.click();
  await details.getByRole('region', { name: 'Codex', exact: true }).waitFor();
  assert.equal(await details.getByRole('region').count(), 4);
  assert.equal(await fits(), true);
  await page.keyboard.press('Escape');

  await page.route('**/__preview/local-sdk', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    json.profiles = Array.from({ length: 5 }, (_, index) => ({
      id: crypto.randomUUID(), targetId: String(index).repeat(64), backend: 'codex',
      name: `配置 ${index + 1}`, directory: 'C:/fixture', model: 'preview-local-codex', effort: 'medium',
    }));
    return route.fulfill({ response, json });
  });
  await page.getByRole('button', { name: '本机 SDK', exact: true }).click();
  await localTrigger.click();
  await details.getByText('1 / 2', { exact: true }).waitFor();
  assert.equal(await details.getByRole('region').count(), 4);
  assert.equal(await fits(), true);
  const next = details.getByRole('button', { name: '下一页', exact: true });
  await page.keyboard.press('Tab');
  assert.equal(await next.evaluate((button) => document.activeElement === button), true);
  await page.keyboard.press('Enter');
  await details.getByText('2 / 2', { exact: true }).waitFor();
  await details.getByRole('region', { name: /配置 5/ }).waitFor();
  assert.equal(await details.getByRole('region').count(), 1);
  assert.equal(await fits(), true);
  await details.getByRole('button', { name: '上一页', exact: true }).click();
  await details.getByText('1 / 2', { exact: true }).waitFor();
});

test('a selected excerpt attaches to one draft and copied VPS links open the existing conversation or turn', { timeout: 40_000 }, async (t) => {
  const page = await openPreview(t);
  await page.evaluate(() => {
    window.vpsWorkbench.writeClipboard = async (text) => { window.copiedChatLink = text; return true; };
  });
  const sends = [];
  await page.route('**/dsh-vps-chat/api/rpc', (route) => {
    const packet = route.request().postDataJSON();
    if (packet.op === 'send') sends.push(packet);
    return route.continue();
  });
  const source = page.getByRole('button', { name: '读书会 · 开场流程', exact: true });
  await (await sidebarButton(page, '周末读书会')).click();
  await source.click();
  const messages = page.getByRole('region', { name: '对话消息', exact: true });
  const paragraph = messages.getByText(/先留五分钟签到/).first();
  await paragraph.waitFor();
  const excerpt = '先留五分钟签到';
  async function selectExcerpt() {
    await paragraph.evaluate((element, text) => {
      const selection = getSelection();
      const range = document.createRange();
      const start = element.firstChild.textContent.indexOf(text);
      range.setStart(element.firstChild, start);
      range.setEnd(element.firstChild, start + text.length);
      selection.removeAllRanges();
      selection.addRange(range);
    }, excerpt);
    await paragraph.dispatchEvent('contextmenu', { button: 2, clientX: 520, clientY: 240 });
  }
  await selectExcerpt();
  await page.getByRole('menuitem', { name: '复制选区与消息链接', exact: true }).click();
  const combination = await page.evaluate(() => window.copiedChatLink);
  const [copiedExcerpt, turnLink] = combination.split('\n\n');
  assert.equal(copiedExcerpt, excerpt);
  assert.equal(parseConversationLink(turnLink).location, 'ssh-vps');
  assert.ok(parseConversationLink(turnLink).turnId);
  await source.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制对话链接', exact: true }).click();
  const chatLink = await page.evaluate(() => window.copiedChatLink);
  const { turnId: copiedTurnId, ...conversation } = parseConversationLink(turnLink);
  assert.deepEqual(parseConversationLink(chatLink), conversation);
  await selectExcerpt();
  await page.getByRole('menuitem', { name: '添加到对话', exact: true }).click();
  const quote = page.locator('.vc-composer .vc-quote-preview');
  await quote.getByText(excerpt, { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '');
  assert.equal(sends.length, 0);
  await quote.getByRole('button', { name: '移除引用', exact: true }).click();
  await quote.waitFor({ state: 'hidden' });
  await selectExcerpt();
  await page.getByRole('menuitem', { name: '添加到对话', exact: true }).click();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('根据这段资料写一条提醒。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await quote.waitFor({ state: 'hidden' });
  assert.deepEqual(sends.map(({ prompt }) => readQuotedPrompt(prompt)),
    [{ prompt: '根据这段资料写一条提醒。', quote: excerpt }]);
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await openCopiedLink(page, chatLink);
  await paragraph.waitFor();
  await openCopiedLink(page, turnLink);
  await page.waitForFunction((id) => document.activeElement?.dataset.turnId === id, copiedTurnId);
  const invalid = await openCopiedLink(page, turnLink + '?secret=example');
  await invalid.getByRole('alert').getByText('请输入有效的 VPS Workbench 对话链接。').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(sends.length, 1);
});

test('a local link selects its registered profile from VPS history and cannot open on a mismatched target', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t, { previewOptions: { localAgents: true }, seed({ preferences }) {
    preferences['dsh-vps-chat:desktop-view-location:v1'] = 'ssh-vps';
  } });
  const link = await page.evaluate(async () => {
    const native = window.vpsWorkbench;
    const { profiles } = await native.localSdkStatus();
    const profile = profiles.find(({ backend }) => backend === 'codex');
    const sessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const result = await native.localSdkRequest({ location: 'local-sdk', backend: profile.backend, profileId: profile.id,
      targetId: profile.targetId, sessionId: 'local-' + sessionId, turnId, prompt: '来自本机历史的引用', op: 'send' });
    if (!result.ok) throw new Error(result.code);
    return { location: 'local-sdk', provider: profile.backend, targetId: profile.targetId, sessionId, turnId };
  });
  await openCopiedLink(page, conversationLink(link));
  const local = page.locator('[data-local-sdk]');
  const message = local.getByRole('region', { name: '对话消息', exact: true }).getByText('来自本机历史的引用', { exact: true });
  await message.waitFor();
  await page.waitForFunction((id) => document.activeElement?.dataset.turnId === id, link.turnId);
  await openCopiedLink(page, conversationLink({ ...link, targetId: 'f'.repeat(64) }));
  await page.getByRole('alert').getByText(/找不到链接对应的本机配置/).waitFor();
  await message.waitFor();
});

test('one local search groups both routes and opens exact message, project, board and workflow results', { timeout: 45_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 420, height: 640 }, previewOptions: { localAgents: true }, seed({ preferences }) {
    preferences['dsh-vps-chat:desktop-view-location:v1'] = 'ssh-vps';
  } });
  await page.evaluate(async () => {
    const native = window.vpsWorkbench;
    const { profiles } = await native.localSdkStatus();
    const profile = profiles.find(({ backend }) => backend === 'codex');
    const result = await native.localSdkRequest({ location: 'local-sdk', backend: profile.backend, profileId: profile.id,
      targetId: profile.targetId, sessionId: 'local-' + crypto.randomUUID(), turnId: crypto.randomUUID(),
      prompt: '本机资料也写到签到', op: 'send' });
    if (!result.ok) throw new Error(result.code);
  });
  await page.getByText('开始一段对话', { exact: true }).waitFor();
  const traffic = [];
  page.on('request', (request) => {
    if (/\/api\/rpc|__preview\/(?:local-sdk|mixed-workflow)/u.test(request.url())) traffic.push(request.url());
  });
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: '本地全局搜索', exact: true });
  const input = search.getByRole('searchbox', { name: '本地全局搜索', exact: true });
  await input.fill('签到');
  await search.getByRole('region', { name: /^本机 SDK/ }).getByRole('button', { name: /本机资料也写到签到/ }).waitFor();
  await search.getByRole('region', { name: /^VPS SSH/ }).getByRole('button', { name: /读书会 · 开场流程/ }).click();
  const detail = search.getByRole('region', { name: '搜索结果详情', exact: true });
  await detail.getByText(/先留五分钟签到/).waitFor();
  await input.fill('周末读书会');
  await search.getByRole('button', { name: /^项目\s*周末读书会/ }).click();
  await detail.getByRole('button', { name: '查看项目内的本机记录', exact: true }).click();
  await search.getByRole('button', { name: /消息.*读书会 · 开场流程/ }).waitFor();
  await search.getByRole('button', { name: /清除项目筛选/ }).click();
  await input.fill('青色分支');
  await search.getByRole('button', { name: /画板.*青色分支/ }).click();
  await detail.getByText(/00000000-0000-4000-8000-000000000203/).waitFor();
  const board = detail.locator('iframe');
  assert.equal(await board.getAttribute('sandbox'), '');
  assert.match(await board.getAttribute('srcdoc'), /Content-Security-Policy/u);
  assert.deepEqual(traffic, []);
  await detail.getByRole('button', { name: '在画布中打开', exact: true }).click();
  await search.waitFor({ state: 'hidden' });
  await page.locator('iframe[title="设计原型预览"][srcdoc*="纸间书店 · 青色分支"]').waitFor();
  await page.getByRole('button', { name: '本地全局搜索', exact: true }).click();
  await input.fill('活动页发布');
  await search.getByRole('button', { name: /^工作流\s*活动页发布/ }).click();
  await detail.getByText('整理发布简报', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '打开工作流', exact: true }).click();
  const workflow = page.getByRole('dialog', { name: '工作流', exact: true });
  await workflow.getByLabel('工作流名称').waitFor();
  assert.equal(await workflow.getByLabel('工作流名称').inputValue(), '活动页发布');
});

async function openVpsSetup(page) {
  const settings = page.getByRole('button', { name: '设置', exact: true });
  if (!(await settings.isVisible())) {
    const sidebar = page.getByRole('button', { name: '展开会话侧栏', exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
  }
  await settings.click();
  await page.getByRole('button', { name: '接入向导', exact: true }).click();
  return page.getByRole('dialog', { name: 'VPS 接入向导', exact: true });
}

test('VPS backend probe is automatic and a lost install reply resumes the original receipt after reload', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 420, height: 640 },
    previewOptions: { backendPlatform: { architecture: 'arm64' }, backendFailure: 'claude-sdk' } });
  const packets = [];
  let loseReply = true;
  let unavailableProbe = false;
  let sdkRemoved = false;
  await page.route('**/dsh-vps-chat/api/rpc', async (route) => {
    const packet = route.request().postDataJSON();
    packets.push(packet);
    if (loseReply && packet.op === 'setup-backend' && packet.kind === 'start') {
      loseReply = false;
      await route.fetch(); // The fixture accepted the original start.
      await route.fulfill({ status: 503, json: { ok: false, code: 'unknown' } });
    } else if (packet.op === 'setup-backend' && packet.kind === 'probe' && (unavailableProbe || sdkRemoved)) {
      const response = await route.fetch();
      const reply = await response.json();
      if (unavailableProbe) {
        reply.platform = null;
        reply.probeError = '暂时无法识别 VPS 系统。';
      } else reply.platform.providers['claude-sdk'] = { runtime: 'missing', onSshPath: false };
      await route.fulfill({ response, json: reply });
    } else await route.continue();
  });
  let guide = await openVpsSetup(page);
  let panel = guide.getByRole('listitem', { name: 'VPS 后端安装', exact: true });
  await panel.getByText('连接 VPS 后会自动识别系统和架构。', { exact: true }).waitFor();
  assert.equal(packets.some(({ op }) => op === 'setup-backend'), false);
  await guide.getByRole('button', { name: '开始检查', exact: true }).click();
  await panel.getByText('Ubuntu · 24.04 · ARM64', { exact: true }).waitFor();
  const start = panel.getByRole('button', { name: '安装所选执行端', exact: true });
  assert.equal(await start.isDisabled(), true);
  await panel.getByRole('checkbox', { name: 'Codex', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Claude Agent SDK', exact: true }).check();
  await start.press('Enter');
  await panel.getByRole('alert').getByText('尚未确认安装请求。请查询原安装。', { exact: true }).waitFor();
  const original = packets.find(({ op, kind }) => op === 'setup-backend' && kind === 'start');
  assert.deepEqual(original.providers, ['codex', 'claude-sdk']);
  assert.equal(original.settings.provider, 'codex');
  unavailableProbe = true;
  await page.reload();
  guide = await openVpsSetup(page);
  panel = guide.getByRole('listitem', { name: 'VPS 后端安装', exact: true });
  await guide.getByRole('button', { name: '开始检查', exact: true }).click();
  await panel.getByText('暂时无法识别 VPS 系统。', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '查询原安装', exact: true }).click();
  await panel.getByText('安装未全部完成', { exact: true }).waitFor();
  await panel.getByText('保留已有运行时', { exact: true }).waitFor();
  await panel.getByText('下载失败，请检查 VPS 网络后重试。', { exact: true }).waitFor();
  const queries = packets.filter(({ op, kind }) => op === 'setup-backend' && kind === 'status');
  assert.ok(queries.length && queries.every((query) => query.installId === original.installId && query.targetId === original.targetId));
  assert.equal(packets.filter(({ op, kind }) => op === 'setup-backend' && kind === 'start').length, 1);
  unavailableProbe = false;
  const recheck = guide.getByRole('button', { name: '重新检查', exact: true });
  await recheck.click();
  await panel.getByRole('checkbox', { name: 'Claude Agent SDK', exact: true }).check();
  await panel.getByRole('button', { name: '安装所选执行端', exact: true }).click();
  await panel.getByText('安装完成。可以继续检查账号和模型目录。', { exact: true }).waitFor();
  const starts = packets.filter(({ op, kind }) => op === 'setup-backend' && kind === 'start');
  assert.deepEqual(starts.map(({ providers }) => providers), [['codex', 'claude-sdk'], ['claude-sdk']]);
  assert.notEqual(starts[1].installId, original.installId);
  sdkRemoved = true;
  await recheck.click();
  const sdk = panel.getByRole('checkbox', { name: 'Claude Agent SDK', exact: true }).locator('..');
  await sdk.getByText('待安装', { exact: true }).waitFor();
  await sdk.getByText('上次安装 · 已安装', { exact: true }).waitFor();
  assert.equal(packets.some(({ op }) => ['send', 'setup-trial'].includes(op)), false);
});

test('VPS backend missing prerequisites show the distro-specific remedy and prevent installation', { timeout: 20_000 }, async (t) => {
  const page = await openPreview(t, { previewOptions: { backendPlatform: { distribution: 'rocky', distributionVersion: '9',
    packageManager: 'dnf', blocker: 'dependency_missing', sandbox: 'not_checked', missing: ['bubblewrap'] } } });
  const guide = await openVpsSetup(page);
  const panel = guide.getByRole('listitem', { name: 'VPS 后端安装', exact: true });
  await guide.getByRole('button', { name: '开始检查', exact: true }).click();
  await panel.getByText('Rocky Linux · 9 · x86‑64', { exact: true }).waitFor();
  await panel.getByText('缺少 bubblewrap', { exact: true }).waitFor();
  assert.match(await panel.locator('code').innerText(), /^sudo dnf install/);
  assert.equal(await panel.getByRole('button', { name: '安装所选执行端' }).count(), 0);
});

test('optional components install a chosen subset, show per-component failure and retry in a narrow window', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 365, height: 480 },
    previewOptions: { localComponents: true, componentFailure: 'claude-sdk' } });
  const panel = page.getByRole('region', { name: '可选本机组件' });
  const install = panel.getByRole('button', { name: '安装所选组件' });
  const codex = panel.getByRole('checkbox', { name: 'Codex', exact: true });
  const claude = panel.getByRole('checkbox', { name: 'Claude Agent SDK', exact: true });
  const agy = panel.getByRole('checkbox', { name: 'Antigravity ACP', exact: true });
  const submitted = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/__preview/local-components')) {
      const payload = request.postDataJSON();
      if (payload.op === 'install') submitted.push(payload.ids);
    }
  });
  await panel.waitFor();
  assert.equal(await install.isDisabled(), true);
  await codex.press('Space');
  await claude.check();
  await install.press('Enter');
  await panel.getByText('已就绪', { exact: true }).waitFor();
  await panel.getByRole('alert').getByText('下载中断。请检查本机网络后重试。', { exact: true }).waitFor();
  assert.equal(await codex.isDisabled(), true);
  assert.equal(await claude.isChecked(), true);
  assert.equal(await agy.isChecked(), false);
  await install.click();
  await panel.getByText('已就绪', { exact: true }).nth(1).waitFor();
  assert.deepEqual(submitted, [['codex', 'claude-sdk'], ['claude-sdk']]);
  assert.equal(await agy.isDisabled(), false);
  await panel.getByRole('button', { name: '前往模型与账号' }).click();
  await page.getByRole('heading', { name: '本机账号', exact: true }).waitFor();
  assert.equal(await page.getByLabel('查看本机账号配置').locator('option').count(), 2);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.desktop-location-tabs button[aria-pressed=true]').innerText(), 'VPS SSH');
  assert.equal(await page.getByLabel('新建位置').inputValue(), 'ssh-vps');
  await page.reload();
  await page.locator('.desktop-location-tabs button[aria-pressed=true]').waitFor();
  assert.equal(await panel.isVisible(), false);
});

test('VPS-only continuation saves the choice and skips all component downloads', { timeout: 20_000 }, async (t) => {
  const page = await openPreview(t, { previewOptions: { localComponents: true } });
  const panel = page.getByRole('region', { name: '可选本机组件' });
  const requests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/__preview/local-components')) requests.push(request.postDataJSON());
  });
  await panel.getByRole('button', { name: '暂只使用 VPS SSH' }).click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.desktop-location-tabs button[aria-pressed=true]').innerText(), 'VPS SSH');
  await page.reload();
  await page.locator('.desktop-location-tabs button[aria-pressed=true]').waitFor();
  assert.equal(await panel.isVisible(), false);
  assert.deepEqual(requests, []);
});

test('leaving and reopening component settings retains the in-progress installation and cancellation', { timeout: 20_000 }, async (t) => {
  const page = await openPreview(t, { previewOptions: { localComponents: true, componentDelay: 5000 } });
  const dialog = page.getByRole('dialog', { name: '设置' });
  const panel = dialog.getByRole('region', { name: '可选本机组件' });
  await panel.getByRole('checkbox', { name: 'Antigravity ACP' }).check();
  await panel.getByRole('button', { name: '安装所选组件' }).click();
  await dialog.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '应用偏好' }).click();
  await dialog.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '连接' }).click();
  await panel.getByRole('button', { name: '取消安装' }).click();
  await panel.getByText('安装已取消，可以重试。', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('checkbox', { name: 'Antigravity ACP' }).isChecked(), true);
});

async function readSavedWorkflows(page) {
  const raw = await page.evaluate(({ storage, key }) => JSON.parse(sessionStorage.getItem(storage)).preferences[key],
    { storage: previewStorageKey, key: workflowKey });
  return readWorkflows(raw);
}

async function browseLocally(page) {
  const access = page.getByRole('button', { name: '访问权限', exact: true });
  await access.press('Enter');
  const browse = page.getByRole('button', { name: '仅浏览', exact: true });
  await browse.click();
  await page.waitForFunction(() => document.querySelector('[data-local-sdk] [data-control=access]')?.dataset.browse === 'true');
  await page.keyboard.press('Escape');
}

async function sidebarButton(page, name) {
  const shortcut = page.getByRole('navigation', { name: '快捷侧栏' }).getByRole('button', { name, exact: true });
  if (await shortcut.isVisible()) return shortcut;
  const history = page.getByRole('complementary', { name: 'VPS 对话列表' });
  const toggle = page.locator('.desktop-sidebar-button');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await history.waitFor();
  return history.getByRole('button', { name, exact: true });
}

test('mixed workflow simulates offline, retries a confirmed stage and restores archived details', { timeout: 50_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 420, height: 640 },
    previewOptions: { localAgents: true, mixedFailureStage: 'summary' }, seed({ preferences }) {
    preferences['dsh-vps-chat:desktop-view-location:v1'] = 'ssh-vps';
  } });
  const record = await page.evaluate(async (key) => {
    const native = window.vpsWorkbench;
    const { targets } = await native.mixedWorkflow({ op: 'targets' });
    const local = targets.find(({ location }) => location === 'local-sdk');
    const vps = targets.find(({ location }) => location === 'ssh-vps');
    const stages = [
      { id: 'draft', name: '混合起草', provider: 'codex', model: '', instruction: '写出活动说明。',
        execution: { location: local.location, configId: local.id, context: 'independent' } },
      { id: 'blind', name: '混合盲审', provider: 'claude-sdk', model: '', instruction: '核对活动信息。',
        execution: { location: vps.location, configId: vps.id, context: 'blind' } },
      { id: 'summary', name: '混合汇总', provider: 'claude-sdk', model: '', instruction: '汇总阶段证据。',
        execution: { location: vps.location, configId: vps.id, context: 'independent' } },
    ];
    const draft = { id: crypto.randomUUID(), revision: 1, name: '混合发布', stages,
      edges: [{ from: 'draft', to: 'summary' }, { from: 'blind', to: 'summary' }] };
    await native.setPreference(key, JSON.stringify([draft]));
    return draft;
  }, workflowKey);
  await page.reload();
  const sidebar = page.getByRole('button', { name: '展开会话侧栏', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '工作流', exact: true });
  await panel.getByLabel('已保存的工作流').selectOption(record.id);
  await panel.getByRole('button', { name: '运行', exact: true }).click();
  const brief = panel.getByRole('group', { name: '运行简报', exact: true });
  const launch = brief.getByRole('button', { name: '开始运行', exact: true });
  const simulate = brief.getByRole('button', { name: '模拟运行', exact: true });
  await brief.getByLabel('运行任务', { exact: true }).fill('准备活动说明。');
  await brief.getByLabel('验收标准', { exact: true }).fill('标明免费报名。');
  await brief.getByLabel('「混合盲审」的证据', { exact: true }).fill('原始资料写明免费报名。');
  assert.equal(await launch.isDisabled(), true);
  assert.equal(await simulate.isDisabled(), true);
  await brief.getByRole('checkbox', { name: '结论', exact: true }).check();
  await brief.getByRole('checkbox', { name: '确认传递所选字段', exact: true }).check();
  await simulate.press('Enter');
  const simulation = brief.getByRole('region', { name: '模拟运行结果', exact: true });
  await simulation.getByText('查看阶段详情 · 混合盲审', { exact: true }).click();
  const blindPreview = simulation.locator('details[open]');
  await blindPreview.getByText(/用户授权的独立证据/).waitFor();
  assert.doesNotMatch(await blindPreview.innerText(), /模拟阶段 1 的结论/u);
  await simulation.getByText('查看阶段详情 · 混合汇总', { exact: true }).click();
  const summaryPreview = simulation.locator('details').filter({ hasText: '查看阶段详情 · 混合汇总' });
  assert.match(await summaryPreview.innerText(), /模拟阶段 1 的结论/u);
  assert.doesNotMatch(await summaryPreview.innerText(), /模拟阶段 1 的证据|原始资料写明免费报名/u);
  assert.equal((await page.evaluate(() => window.vpsWorkbench.mixedWorkflow({ op: 'status' }))).run, null);
  await brief.getByLabel('约束（可选）', { exact: true }).fill('保留来源编号。');
  await simulation.waitFor({ state: 'hidden' });
  await launch.scrollIntoViewIfNeeded();
  await assertWithinViewport(launch);
  await launch.press('Enter');
  const retry = panel.getByRole('button', { name: '重试阶段…', exact: true });
  await retry.waitFor();
  const original = (await page.evaluate(() => window.vpsWorkbench.mixedWorkflow({ op: 'status' }))).run;
  assert.equal(original.phase, 'failed');
  await retry.click();
  await panel.getByRole('group', { name: '确认重试阶段' }).getByRole('button', { name: '确认重试', exact: true }).click();
  await panel.getByText('工作流已完成。', { exact: true }).waitFor({ timeout: 15_000 });
  const status = await page.evaluate(() => window.vpsWorkbench.mixedWorkflow({ op: 'status' }));
  assert.equal(status.run.phase, 'complete');
  assert.notEqual(status.run.id, original.id);
  assert.deepEqual(status.run.rows.slice(0, 2), original.rows.slice(0, 2));
  assert.notEqual(status.run.rows[2].turnId, original.rows[2].turnId);
  assert.deepEqual(status.run.mixed.transfers, [{ from: 'draft', to: 'summary', fields: ['conclusion'] }]);
  assert.match(status.run.rows[0].reply, /本机完成初稿/u);
  const summaryRow = panel.getByRole('list', { name: '运行阶段', exact: true }).locator(':scope > li')
    .filter({ hasText: '第 3 阶段 · 混合汇总' });
  await summaryRow.getByText('查看阶段详情 · 混合汇总', { exact: true }).click();
  await summaryRow.getByText('结论 · 本机完成初稿。', { exact: true }).waitFor();
  await summaryRow.getByText(status.run.rows[2].turnId, { exact: true }).waitFor();
  const artifactList = await page.evaluate((runId) => window.vpsWorkbench.mixedWorkflow({
    op: 'artifacts', query: { runId, stageIndex: 2 },
  }), status.run.id);
  assert.equal(artifactList.ok, true, JSON.stringify(artifactList));
  await summaryRow.getByRole('button', { name: '查看产物', exact: true }).click();
  await summaryRow.getByRole('button', { name: artifactList.files[0].path, exact: true }).waitFor();
  await page.reload();
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  await panel.getByRole('button', { name: '运行', exact: true }).click();
  const history = panel.getByRole('region', { name: '混合运行历史', exact: true });
  await history.getByRole('button', { name: '查看运行历史', exact: true }).click();
  await history.getByRole('button', { name: '混合发布', exact: true }).click();
  const oldSummary = history.getByRole('list', { name: '运行阶段', exact: true }).locator(':scope > li')
    .filter({ hasText: '第 3 阶段 · 混合汇总' });
  await oldSummary.getByText('查看阶段详情 · 混合汇总', { exact: true }).click();
  await oldSummary.getByText(original.rows[2].turnId, { exact: true }).waitFor();
  await oldSummary.getByRole('button', { name: '查看产物', exact: true }).click();
  await oldSummary.getByRole('button', { name: artifactList.files[0].path, exact: true }).waitFor();
  await panel.getByRole('button', { name: '关闭工作流', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: '本地全局搜索', exact: true });
  await search.getByRole('searchbox', { name: '本地全局搜索' }).fill(artifactList.files[0].path);
  await search.getByRole('button', { name: /^产物/u }).last().click();
  const artifactDetail = search.getByRole('region', { name: '搜索结果详情', exact: true });
  await artifactDetail.getByText(original.rows[2].turnId, { exact: true }).waitFor();
  await artifactDetail.getByRole('button', { name: '打开原运行阶段', exact: true }).click();
  await oldSummary.waitFor();
  await page.waitForFunction(() => document.activeElement?.matches('li.vc-workflow-card[tabindex="-1"]') &&
    document.activeElement.textContent.includes('混合汇总'));
});

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
  await prompt.waitFor({ state: 'hidden' });
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
  await prompt.waitFor({ state: 'hidden' });
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

test('model and interface resets persist independently for the same VPS backend', { timeout: 35_000 }, async (t) => {
  const { targetId } = createPreviewFixtures().chat({ op: 'preset' }).preset;
  const model = { id: 'preview-codex-mini', targetId, effort: 'medium' };
  const prefs = { color: 'dark', accent: 'blue', textSize: 'large', width: 'wide', sendKey: 'ctrl-enter', motion: 'reduce' };
  const other = { color: 'light' };
  let profileKey;
  const page = await openPreview(t, { seed(state) {
    profileKey = Object.keys(state.preferences).find((key) => key.startsWith('dsh-vps-chat-tools:v1:')) + ':workbench';
    state.preferences[profileKey] = JSON.stringify({ codex: { ...prefs, model }, claude: other });
  } });
  const entry = page.getByRole('button', { name: '设置', exact: true });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  const models = settings.locator('[data-settings-backend=codex] details');
  const overrides = settings.locator('details').filter({ hasText: 'Codex 界面偏好' });
  const modelReset = models.getByRole('button', { name: '恢复默认模型与推理强度' });
  const prefReset = overrides.getByRole('button', { name: '恢复通用偏好' });
  async function savedProfiles() {
    return page.evaluate(({ storage, key }) => JSON.parse(JSON.parse(sessionStorage.getItem(storage)).preferences[key]), {
      storage: previewStorageKey, key: profileKey,
    });
  }
  async function openModels() {
    await openSettingsSection(settings, '执行端');
    await models.locator('summary').click();
  }
  async function openOverrides() {
    await openSettingsSection(settings, '按执行端覆盖');
    await overrides.locator('summary').click();
  }
  await entry.click();
  await openModels();
  assert.equal(await models.getByRole('combobox', { name: '主题', exact: true }).count(), 0);
  await modelReset.press('Enter');
  await models.getByText('当前配置 · 沿用执行端默认。当前会话可另选模型。').waitFor();
  assert.deepEqual(await savedProfiles(), { codex: prefs, claude: other });
  await openOverrides();
  assert.equal(await overrides.getByRole('combobox', { name: '主题', exact: true }).inputValue(), 'dark');
  assert.equal(await overrides.getByRole('combobox', { name: '模型', exact: true }).count(), 0);
  await openModels();
  await models.getByRole('button', { name: '读取模型目录', exact: true }).click();
  await models.getByRole('combobox', { name: '模型', exact: true }).selectOption(model.id);
  const effort = models.getByRole('combobox', { name: '推理强度', exact: true });
  await effort.selectOption('medium');
  await openOverrides();
  await prefReset.click();
  await overrides.getByText('跟随通用', { exact: true }).waitFor();
  assert.deepEqual(await savedProfiles(), { codex: { model }, claude: other });
  await settings.getByRole('button', { name: '关闭设置' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
  await entry.click();
  await openModels();
  await models.getByText('当前配置 · 已保存 ' + model.id).waitFor();
  await models.getByRole('button', { name: '查看此执行端账号' }).click();
  const account = settings.getByRole('region', { name: 'Codex', exact: true });
  assert.equal(await account.evaluate((node) => node === document.activeElement), true);
  await account.getByRole('button', { name: '查看此执行端模型' }).click();
  assert.equal(await models.evaluate((node) => node.open), true);
  await openOverrides();
  assert.equal(await overrides.getByRole('combobox', { name: '主题', exact: true }).inputValue(), '');
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
  await step(extras, '提示词模板').getByText('已通过', { exact: true }).waitFor();
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
  await settings.getByRole('listitem', { name: '本机 SDK', exact: true }).getByText('待检查', { exact: true }).waitFor();
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
  await openSettingsSection(settings, '执行端');
  await settings.getByText('隔离配置', { exact: true }).waitFor();
  assert.equal(await settings.getByLabel('配置名称', { exact: true }).count(), 0);
  await settings.getByRole('button', { name: '编辑本机配置' }).click();
  await settings.getByLabel('配置名称', { exact: true }).waitFor();
  assert.equal(await settings.getByLabel('配置名称', { exact: true }).count(), 1);
  await openSettingsSection(settings, '账号');
  await settings.getByText('VPS_WORKBENCH_LOCAL_CODEX_API_KEY', { exact: true }).waitFor();
  await settings.getByRole('listitem', { name: '实际模型响应', exact: true }).getByText('已通过', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('button', { name: '试跑模型' }).count(), 0);
  assert.equal(await settings.getByRole('button', { name: '测试本机配置' }).count(), 0);
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
    return op === 'configuration' ? route.fulfill({ json: { ok: true, targetId: 'a'.repeat(64),
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

test('saving VPS settings and closing from the other location preserves the selected VPS session and draft', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t);
  await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
  await (await sidebarButton(page, '周末读书会')).click();
  const row = await sidebarButton(page, '读书会 · 开场流程');
  await row.click();
  const draft = page.getByRole('textbox', { name: '消息', exact: true });
  await draft.fill('VPS 会话草稿');
  const history = page.getByRole('group', { name: '打开会话历史', exact: true });
  const newLocation = page.getByLabel('新建位置', { exact: true });
  await newLocation.selectOption('local-sdk');
  const packets = [];
  await page.route('**/dsh-vps-chat/api/rpc', (route) => {
    const packet = route.request().postDataJSON();
    packets.push(packet);
    if (packet.op === 'configuration' && packet.settings?.workspace === '/srv/changed-fixture') {
      return route.fulfill({ json: { ok: true, targetId: 'a'.repeat(64), memoryTargetId: 'b'.repeat(64), sessions: [] } });
    }
    return route.continue();
  });
  await page.route('**/__preview/connection', (route) => route.fulfill({ json: { ok: true } }));
  const localRequests = [];
  await page.route('**/__preview/local-sdk', (route) => {
    localRequests.push(route.request().method());
    return route.continue();
  });
  const entry = page.getByRole('button', { name: '设置', exact: true });
  await entry.click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await openSettingsSection(settings, '连接');
  const directory = settings.getByLabel('工作目录', { exact: true });
  await directory.fill('/srv/changed-fixture');
  await settings.getByRole('group', { name: '配置的执行位置' }).getByRole('button', { name: '本机 SDK' }).click();
  await page.getByRole('dialog', { name: '有未保存的设置' }).getByRole('button', { name: '保存并继续' }).click();
  await settings.getByRole('heading', { name: '本机 SDK 连接', exact: true }).waitFor();
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  assert.equal(await history.getByRole('button', { name: 'VPS SSH' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await row.getAttribute('aria-current'), 'true');
  assert.equal(await draft.inputValue(), 'VPS 会话草稿');
  assert.equal(await newLocation.inputValue(), 'local-sdk');
  await page.waitForFunction(() => document.activeElement?.matches('.vc-sidebar-settings'));
  assert.equal(await entry.evaluate((node) => node === document.activeElement), true);
  assert.deepEqual(localRequests, ['GET']);
  assert.ok(packets.length >= 2 && packets.every(({ op }) => op === 'configuration'));
  await entry.click();
  await openSettingsSection(settings, '连接');
  assert.equal(await directory.inputValue(), '/srv/changed-fixture');
});

test('local and VPS chat share the conversation, sidebar and settings styles at wide and compact sizes', { timeout: 45_000 }, async (t) => {
  for (const { viewport, color } of [
    { viewport: { width: 1280, height: 720 }, color: 'dark' },
    { viewport: { width: 365, height: 480 }, color: 'light' },
  ]) {
    await t.test(`${viewport.width}×${viewport.height} ${color}`, async (t) => {
      const page = await openPreview(t, { viewport, seed({ preferences }) {
        preferences[workbenchPreferenceKey] = JSON.stringify({ color, accent: 'violet', textSize: 'large' });
      } });
      const locations = page.getByRole('group', { name: '打开会话历史', exact: true });
      const toggle = page.locator('.desktop-sidebar-button');
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      const compact = viewport.width <= 620;
      const styles = [];
      const fieldStyles = [];

      for (const [label, selector, ready, fieldName] of [
        ['VPS SSH', '[data-vps-chat]', '本地演示 · VPS 已配置', 'SSH 用户名'],
        ['本机 SDK', '[data-local-sdk]', 'SDK 可用 · 凭据已配置', '配置名称'],
      ]) {
        const shell = page.locator(`#root > ${selector}`);
        await locations.getByRole('button', { name: label, exact: true }).click();
        await shell.getByText(ready, { exact: true }).waitFor();
        const newChat = shell.getByRole('button', { name: '新建对话', exact: true });
        const railShortcut = shell.getByRole('button', { name: '项目资源库', exact: true });
        if (compact) await toggle.click();
        await newChat.waitFor();
        await railShortcut.waitFor();
        await page.mouse.move(viewport.width - 2, 1);
        styles.push(await shell.evaluate((root) => [
          '.vc-header', '.vc-welcome :is(h1,h2)', '.vc-rail', '.vc-new', '.vc-sidebar-actions',
          '.vc-sidebar-settings', '.vc-composer', '.vc-composer textarea', '.vc-compose-icon-button',
        ].map((selector) => {
          const { backgroundColor, borderColor, borderRadius, color, fontFamily, fontSize } = getComputedStyle(root.querySelector(selector));
          return { selector, backgroundColor, borderColor, borderRadius, color, fontFamily, fontSize };
        })));

        if (compact) {
          if (label === '本机 SDK') {
            await railShortcut.focus();
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => {
              const toggle = document.querySelector('.desktop-sidebar-button');
              return toggle === document.activeElement && toggle.getAttribute('aria-expanded') === 'false';
            });
          } else await toggle.click();
          await railShortcut.waitFor({ state: 'hidden' });
          await newChat.waitFor({ state: 'hidden' });
        }

        assert.equal(await shell.evaluate((root) => {
          const title = root.querySelector('.vc-welcome :is(h1,h2)').getBoundingClientRect();
          const feed = root.querySelector('.vc-scroll').getBoundingClientRect();
          return title.top >= feed.top && title.bottom <= feed.bottom;
        }), true, `${label} welcome title stays visible`);
        const entry = shell.locator('.vc-sidebar-actions').getByRole('button', { name: '设置', exact: true });
        const bounds = await entry.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 &&
          bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
        await entry.press('Enter');
        await openSettingsSection(settings, '连接');
        const field = settings.getByLabel(fieldName, { exact: true });
        await field.waitFor();
        fieldStyles.push(await field.evaluate((node) => {
          const { backgroundColor, borderColor, borderRadius, color, fontSize } = getComputedStyle(node);
          return { backgroundColor, borderColor, borderRadius, color, fontSize };
        }));
        await page.keyboard.press('Escape');
        await settings.waitFor({ state: 'hidden' });
        assert.equal(await entry.evaluate((node) => node === document.activeElement), true);
      }

      assert.deepEqual(styles[1], styles[0]);
      assert.deepEqual(fieldStyles[1], fieldStyles[0]);
      const composer = page.locator('#root > [data-local-sdk] .vc-composer');
      await browseLocally(page);
      assert.equal(await composer.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
    });
  }
});

test('from local history an unvisited VPS loads only connection metadata and keeps browse access', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t, { seed({ preferences }) {
    preferences['dsh-vps-chat:desktop-view-location:v1'] = 'local-sdk';
    preferences['dsh-vps-chat:desktop-new-location:v1'] = 'ssh-vps';
  } });
  const entry = page.getByRole('button', { name: '设置', exact: true });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await entry.click();
  await settings.getByLabel('配置名称', { exact: true }).fill('本机测试配置');
  await settings.getByRole('button', { name: '选择工作目录并保存', exact: true }).click();
  await settings.getByText('本机测试配置', { exact: true }).last().waitFor();
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByText('向本机 Codex 提问，或让它带你熟悉当前项目。', { exact: true }).waitFor();
  const model = page.getByRole('dialog', { name: '模型', exact: true });
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await model.locator('.vc-advanced-model > summary').click();
  await model.locator('select[name=verbosity]').selectOption('low');
  await model.getByRole('button', { name: '应用', exact: true }).click();
  await model.getByText('已应用到后续请求。', { exact: true }).waitFor();
  await model.getByRole('button', { name: '关闭', exact: true }).click();
  const draft = page.getByRole('textbox', { name: '本地对话草稿' });
  await draft.fill('原本机会话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('[data-turn-state=complete]').getByText('收到 原本机会话', { exact: true }).waitFor();
  await browseLocally(page);
  await draft.fill('本机会话草稿');
  const originalRow = page.getByRole('complementary', { name: '本地对话历史' }).getByRole('button', { name: '原本机会话', exact: true });
  const packets = [];
  await page.route('**/dsh-vps-chat/api/rpc', (route) => {
    packets.push(route.request().postDataJSON());
    return route.continue();
  });
  await entry.click();
  await openSettingsSection(settings, '连接');
  await settings.getByRole('group', { name: '配置的执行位置' }).getByRole('button', { name: 'VPS SSH' }).press('Enter');
  const user = settings.getByLabel('SSH 用户名', { exact: true });
  await user.waitFor();
  await settings.getByText('已载入 VPS 预设', { exact: true }).waitFor();
  assert.equal(await user.inputValue(), 'preview');
  assert.equal(await settings.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
  assert.equal(await settings.getByRole('button', { name: '试跑模型', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  const history = page.getByRole('group', { name: '打开会话历史', exact: true });
  assert.equal(await history.getByRole('button', { name: '本机 SDK', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await draft.inputValue(), '本机会话草稿');
  assert.equal(await page.getByLabel('新建位置').inputValue(), 'ssh-vps');
  assert.equal(await entry.evaluate((node) => node === document.activeElement), true);
  await page.locator('.desktop-sidebar-button').click();
  assert.equal(await originalRow.getAttribute('aria-current'), 'true');
  assert.deepEqual(packets, [{ op: 'configuration' }]);
});

test('local tools and memory settings stay on the selected configuration and keep the draft', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t, { seed({ preferences }) {
    preferences['dsh-vps-chat:desktop-view-location:v1'] = 'local-sdk';
    preferences['dsh-vps-chat:desktop-new-location:v1'] = 'local-sdk';
  } });
  const requests = [];
  await page.route('**/dsh-vps-chat/api/rpc', (route) => {
    requests.push(route.request().postDataJSON());
    return route.continue();
  });
  const draft = page.getByRole('textbox', { name: '本地对话草稿', exact: true });
  await draft.fill('本机草稿');
  const entry = page.getByRole('button', { name: '设置', exact: true });
  await entry.press('Enter');
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByText(/独立的本机存储/u).waitFor();
  await settings.getByLabel('配置名称', { exact: true }).fill('本机资料配置');
  await settings.getByRole('button', { name: '选择工作目录并保存' }).click();
  await settings.getByRole('combobox', { name: '查看配置' }).waitFor();
  const cases = [
    ['提示词模板', settings.getByLabel('粘贴 JSON 清单', { exact: true })],
    ['Agent 预设', settings.getByRole('button', { name: '新建预设', exact: true })],
    ['MCP 服务器', settings.getByLabel('本机 HTTP 地址', { exact: true })],
    ['长期记忆', settings.getByText(/作用范围 · 本机 SDK/u)],
  ];
  const locations = settings.getByRole('group', { name: '配置的执行位置', exact: true });
  for (const [section, targetControl] of cases) {
    await openSettingsSection(settings, section);
    await targetControl.waitFor();
    assert.equal(await locations.getByRole('button', { name: '本机 SDK', exact: true }).getAttribute('aria-pressed'), 'true');
    if (section === '长期记忆') {
      await settings.getByLabel('记忆所属项目', { exact: true }).selectOption({ label: '纸间书店' });
      for (const name of ['开启个人自动记忆', '开启此项目的自动记忆', '随消息发送手动记忆']) {
        assert.equal(await settings.getByRole('switch', { name, exact: true }).count(), 1);
      }
      assert.equal(await settings.getByRole('heading', { name: '记忆提炼模型', exact: true }).count(), 1);
    }
  }
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  assert.equal(await draft.inputValue(), '本机草稿');
  assert.equal(await page.getByLabel('新建位置', { exact: true }).inputValue(), 'local-sdk');
  assert.equal(await entry.evaluate((node) => node === document.activeElement), true);
  assert.deepEqual(requests, []);
});

test('personal Claude subscription is selected per profile and has its own login check and model trial', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 420, height: 640 },
    previewOptions: { localAgents: true, personalSubscription: true } });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await openSettingsSection(settings, '连接');
  await settings.getByLabel('本机执行端', { exact: true }).selectOption('claude-sdk');
  const auth = settings.getByLabel('认证方式', { exact: true });
  assert.equal(await auth.inputValue(), 'api-key');
  await auth.selectOption('subscription');
  await settings.getByLabel('配置名称', { exact: true }).fill('订阅测试配置');
  await settings.getByRole('button', { name: '选择工作目录并保存', exact: true }).click();
  await settings.locator('dd').getByText('Claude 个人订阅', { exact: true }).waitFor();
  const status = await page.evaluate(() => window.vpsWorkbench.localSdkStatus());
  const profile = status.profiles.find(({ name }) => name === '订阅测试配置');
  const api = status.profiles.find(({ backend, authMode }) => backend === 'claude-sdk' && !authMode);
  assert.equal(profile.authMode, 'subscription');
  assert.notEqual(profile.targetId, api.targetId);
  await openSettingsSection(settings, '账号');
  const account = settings.getByLabel('查看本机账号配置');
  assert.equal(await account.inputValue(), profile.id);
  assert.equal(await settings.locator('input[type=password]').count(), 0);
  const probe = settings.getByRole('button', { name: '检查订阅登录', exact: true });
  await probe.click();
  await settings.getByText(/此配置尚未通过|尚未登录|请通过 Claude 登录/).first().waitFor();
  await settings.getByRole('button', { name: '打开 Claude 登录', exact: true }).click();
  await settings.getByText(/请在 Claude 登录窗口完成登录/).waitFor();
  await probe.click();
  await settings.getByText(/已核验此配置的 Claude 个人订阅登录/).waitFor();
  await account.selectOption(api.id);
  assert.equal(await probe.count(), 0);
  assert.equal(await settings.getByText('本机 API 密钥已配置。', { exact: true }).count(), 1);
  await account.selectOption(profile.id);
  await settings.getByRole('button', { name: '打开本机连接检查', exact: true }).click();
  await settings.getByRole('button', { name: '测试本机配置', exact: true }).click();
  await settings.getByRole('button', { name: '试跑模型', exact: true }).click();
  await settings.getByText('试跑已收到完整模型回复。', { exact: true }).waitFor();
});

test('local Claude and Antigravity share streaming, supplement and approval UI with isolated histories', { timeout: 60_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 420, height: 640 }, seed({ preferences }) {
    preferences['dsh-vps-chat:desktop-view-location:v1'] = 'local-sdk';
    preferences['dsh-vps-chat:desktop-new-location:v1'] = 'local-sdk';
  } });
  const sshPackets = [];
  await page.route('**/dsh-vps-chat/api/rpc', (route) => { sshPackets.push(route.request().postDataJSON()); return route.continue(); });
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await openSettingsSection(settings, '连接');
  const profiles = [
    { backend: 'claude-sdk', label: 'Claude Agent SDK', name: '本机 Claude 夹具', action: '允许一次' },
    { backend: 'antigravity', label: 'Antigravity ACP', name: '本机 ACP 夹具', action: '拒绝' },
  ];
  for (const { backend, name } of profiles) {
    await settings.getByLabel('本机执行端', { exact: true }).selectOption(backend);
    await settings.getByLabel('配置名称', { exact: true }).fill(name);
    await settings.getByRole('button', { name: '选择工作目录并保存', exact: true }).click();
    await settings.getByText(name, { exact: true }).last().waitFor();
  }
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  const picker = page.getByRole('button', { name: '切换本机执行端', exact: true });
  const draft = page.getByRole('textbox', { name: '本地对话草稿', exact: true });
  async function select(label) {
    await picker.click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await page.getByText(`向本机 ${label} 提问，或让它带你熟悉当前项目。`, { exact: true }).waitFor();
  }
  for (const { label, action } of profiles) {
    await select(label);
    await draft.fill(label + ' 补充与审批');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '发送补充', exact: true }).waitFor();
    await draft.fill('请保留原始证据');
    await page.getByRole('button', { name: '发送补充', exact: true }).click();
    const card = page.getByRole('list', { name: '工具授权' });
    await card.getByRole('button', { name: action, exact: true }).click();
    await card.getByText(action + ' · 决定已提交', { exact: true }).waitFor();
    const complete = page.locator('[data-turn-state=complete]');
    await complete.getByText('已收到补充 请保留原始证据', { exact: true }).waitFor();
    await complete.getByText(action === '允许一次' ? '工具决定 已允许一次' : '工具决定 已拒绝', { exact: true }).waitFor();
    assert.equal(await complete.count(), 1);
  }
  await select(profiles[0].label);
  const history = page.getByRole('complementary', { name: '本地对话历史' });
  const expand = page.getByRole('button', { name: '展开会话侧栏', exact: true });
  if (await expand.isVisible()) await expand.click();
  await history.getByRole('button', { name: 'Claude Agent SDK 补充与审批', exact: true }).click();
  await page.locator('[data-turn-state=complete]').getByText('工具决定 已允许一次', { exact: true }).waitFor();
  assert.equal(await history.getByRole('button', { name: 'Antigravity ACP 补充与审批', exact: true }).count(), 0);
  assert.deepEqual(sshPackets, []);
});

test('local SDK opens the design canvas, project resources and a graph run through the shared workbench', { timeout: 55_000 }, async (t) => {
  const page = await openPreview(t, { seed({ preferences }) {
    preferences['dsh-vps-chat:desktop-view-location:v1'] = 'local-sdk';
    preferences['dsh-vps-chat:desktop-new-location:v1'] = 'local-sdk';
    const draft = { name: '本机并行核对', stages: [
      { id: 's1', name: '核对内容', provider: 'codex', model: 'gpt-5.5', instruction: '整理内容。' },
      { id: 's2', name: '核对布局', provider: 'codex', model: 'gpt-6-sol', instruction: '整理布局。' },
      { id: 's3', name: '汇总', provider: 'codex', model: '', instruction: '合并两路证据。' },
    ], edges: [{ from: 's1', to: 's3' }, { from: 's2', to: 's3' }] };
    preferences[workflowKey] = JSON.stringify(applyWorkflowChange([], {
      op: 'save', id: '14e60b67-76ec-4d41-9ab3-f8f5dfd4cc49', revision: null, draft,
    }));
  } });
  const packets = [];
  const ssh = [];
  await page.route('**/dsh-vps-chat/api/**', (route) => { ssh.push(route.request().url()); return route.abort(); });
  await page.route('**/__preview/local-sdk', (route) => {
    if (route.request().method() === 'POST') packets.push(route.request().postDataJSON());
    return route.continue();
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByLabel('配置名称', { exact: true }).fill('本机全功能');
  await settings.getByRole('button', { name: '选择工作目录并保存' }).click();
  await settings.getByRole('combobox', { name: '查看配置' }).waitFor();
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '设计工作台', exact: true }).click();
  const canvas = page.getByRole('region', { name: '多画板画布' });
  await canvas.waitFor();
  await page.getByRole('combobox', { name: '归入本地项目' }).selectOption({ label: '纸间书店' });
  await page.getByRole('textbox', { name: '本地对话草稿', exact: true }).fill('制作可跳转的概览和详情两张画板。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await canvas.getByRole('button', { name: /概览/u }).first().waitFor();
  await canvas.getByRole('button', { name: /详情/u }).first().waitFor();
  await page.getByRole('button', { name: '项目资源库', exact: true }).click();
  const library = page.getByRole('dialog', { name: '项目资源库', exact: true });
  await library.getByText('概览', { exact: true }).first().waitFor();
  await page.keyboard.press('Escape');
  await library.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: '工作流', exact: true }).click();
  const flow = page.getByRole('dialog', { name: '工作流', exact: true });
  await flow.getByRole('combobox', { name: '已保存的工作流', exact: true }).selectOption({ label: '本机并行核对' });
  await flow.getByRole('textbox', { name: '运行任务' }).fill('同时核对内容和布局。');
  await flow.getByRole('button', { name: '开始运行', exact: true }).click();
  await flow.locator('.vc-workflow-title-row').getByRole('status').filter({ hasText: /^已完成$/u }).waitFor({ timeout: 15_000 });
  await flow.getByRole('button', { name: '查看产物', exact: true }).last().click();
  await flow.getByText('阶段结果.md', { exact: true }).waitFor();
  const sends = packets.filter(({ op, payload }) => op === 'workbench' && payload.op === 'send');
  assert.equal(sends.length, 4);
  assert.ok(sends.every(({ location, backend, payload }) => location === 'local-sdk' && backend === 'codex' &&
    payload.settings.location === 'local-sdk'));
  assert.deepEqual(ssh, []);
});

test('prompt-template actions preserve the manifest and the existing DSH import entry', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 365, height: 480 } });
  await page.getByText('本地演示 · VPS 已配置', { exact: true }).waitFor();
  await page.getByRole('button', { name: '文件', exact: true }).press('ArrowDown');
  await page.getByRole('menuitem', { name: '导入 DSH 对话数据…', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  const entry = page.getByRole('button', { name: '设置', exact: true });
  const showSidebar = page.getByRole('button', { name: '展开会话侧栏', exact: true });
  if (!await entry.isVisible()) await showSidebar.click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await entry.click();
  await openSettingsSection(settings, '提示词模板');
  const manifest = { schema: 1, id: 'fixture-review', name: '审校清单', version: '1.0.0', description: '',
    prompts: [{ title: '审校证据', text: '检查每条结论的证据。' }] };
  await settings.getByLabel('粘贴 JSON 清单', { exact: true }).fill(JSON.stringify(manifest));
  await settings.getByRole('button', { name: '导入粘贴的提示词模板', exact: true }).press('Enter');
  const group = settings.locator('.vc-settings-group').filter({ has: page.getByRole('heading', { name: manifest.name, exact: true }) });
  const enable = group.getByRole('switch', { name: '启用提示词模板', exact: true });
  await enable.press('Space');
  await group.getByRole('switch', { name: '启用提示词模板', checked: true }).waitFor();
  const saved = async () => readExtensions(await page.evaluate(({ storage, key }) =>
    JSON.parse(sessionStorage.getItem(storage)).preferences[key], { storage: previewStorageKey, key: extensionPreferenceKey }));
  const imported = (await saved()).plugins.find(({ id }) => id === manifest.id);
  assert.equal(imported.version, manifest.version);
  assert.deepEqual(imported.prompts, manifest.prompts);
  await settings.getByRole('button', { name: '关闭设置', exact: true }).press('Enter');
  const hideSidebar = page.getByRole('button', { name: '收起会话侧栏', exact: true });
  if (await hideSidebar.isVisible()) await hideSidebar.click();
  const composerTemplate = page.getByRole('button', { name: '提示词模板', exact: true });
  await assertWithinViewport(composerTemplate);
  await assertWithinViewport(page.getByRole('button', { name: '发送', exact: true }));
  await composerTemplate.press('Enter');
  await page.getByRole('dialog', { name: '提示词模板', exact: true }).getByRole('button', { name: '审校证据', exact: true }).press('Enter');
  assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), manifest.prompts[0].text);
  if (!await entry.isVisible()) await showSidebar.click();
  await entry.press('Enter');
  await openSettingsSection(settings, '提示词模板');
  await group.getByRole('button', { name: '移除提示词模板', exact: true }).press('Enter');
  await group.waitFor({ state: 'hidden' });
  assert.equal((await saved()).plugins.some(({ id }) => id === manifest.id), false);
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
        ['连接', '模型与账号', 'Agent 与工具', '记忆', '应用偏好']);
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
      await settings.getByRole('button', { name: '打开本机连接检查', exact: true }).click();
      await settings.getByRole('button', { name: '测试本机配置', exact: true }).click();
      await settings.getByRole('listitem', { name: '本机 SDK', exact: true }).getByText('已通过', { exact: true }).waitFor();
      assert.equal(requests.length, priorVpsRequests);
      await openSettingsSection(settings, '长期记忆');
      const localMemory = settings.getByRole('switch', { name: '开启个人自动记忆', exact: true });
      await assertWithinViewport(localMemory);
      await routeOptions.getByRole('button', { name: 'VPS SSH', exact: true }).press('Enter');
      await settings.getByText(/作用范围 · VPS SSH/u).waitFor();
      await assertWithinViewport(settings.getByRole('button', { name: '完成', exact: true }));
      assert.equal(requests.length, priorVpsRequests);
      await routeOptions.getByRole('button', { name: '本机 SDK', exact: true }).press('Enter');
      await localMemory.waitFor();
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
    const wide = viewport.width > 620;
    const rail = page.getByRole('complementary', { name: 'VPS 对话列表' });
    const shortcuts = wide ? page.getByRole('navigation', { name: '快捷侧栏' })
      : rail.getByRole('group', { name: '工作台快捷入口', exact: true });
    const first = await sidebarButton(page, '项目资源库');
    await first.waitFor();
    const entries = [first, ...['工作流', '设计工作台'].map((name) => shortcuts.getByRole('button', { name, exact: true }))];
    const boxes = await Promise.all(entries.map((entry) => entry.boundingBox()));
    assert.ok(boxes.every(({ x, y, height }) => (wide ? x === boxes[0].x : y === boxes[0].y) && height === 38));
    const footer = page.getByRole('group', { name: 'VPS 操作', exact: true });
    const newChat = (wide ? shortcuts : rail).getByRole('button', { name: '新建对话', exact: true });
    for (const button of [newChat, footer.getByRole('button', { name: '设置', exact: true }),
      footer.getByRole('button', { name: '切换 VPS 执行端', exact: true })]) await assertWithinViewport(button);
    assert.equal(await footer.getByRole('button').count(), 2);
    const providerButton = footer.getByRole('button', { name: '切换 VPS 执行端', exact: true });
    const settingsButton = footer.getByRole('button', { name: '设置', exact: true });
    const rings = providerButton.getByRole('img');
    assert.equal(await rings.count(), 2);
    const [fiveHour, weekly] = await Promise.all([rings.nth(0).boundingBox(), rings.nth(1).boundingBox()]);
    assert.deepEqual([fiveHour.width, weekly.width], [34, 24]);
    assert.ok(Math.abs(fiveHour.x + fiveHour.width / 2 - weekly.x - weekly.width / 2) < 0.5);
    assert.ok(Math.abs(fiveHour.y + fiveHour.height / 2 - weekly.y - weekly.height / 2) < 0.5);
    const logo = await providerButton.locator('.vc-quota-meter > .vc-menu-icon').boundingBox();
    assert.equal(logo.width, 16);
    assert.ok(Math.abs(fiveHour.x + fiveHour.width / 2 - logo.x - logo.width / 2) < 0.5);
    assert.ok(Math.abs(fiveHour.y + fiveHour.height / 2 - logo.y - logo.height / 2) < 0.5);
    await providerButton.getByRole('img', { name: '5 小时额度，暂无数据', exact: true }).waitFor();
    await providerButton.getByRole('img', { name: '每周额度，暂无数据', exact: true }).waitFor();
    await providerButton.press('Enter');
    const menu = footer.getByRole('dialog', { name: '执行端与订阅额度', exact: true });
    await assertWithinViewport(menu);
    await menu.getByRole('listbox').getByRole('option', { name: 'Codex', selected: true }).waitFor();
    const quota = menu.getByRole('region', { name: '已配置的订阅额度', exact: true });
    await quota.getByRole('region', { name: 'Codex', exact: true }).waitFor();
    assert.equal(await quota.getByRole('region', { name: 'Claude API', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await providerButton.evaluate((button) => button === document.activeElement), true);
    await providerButton.blur();
    await page.mouse.move(viewport.width - 3, 8);
    const fills = (button) => button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopColor, background: style.backgroundColor };
    });
    const clear = 'rgba(0, 0, 0, 0)';
    for (const button of [...entries, settingsButton, providerButton]) {
      assert.deepEqual(await fills(button), { border: clear, background: clear });
    }
    assert.equal((await fills(newChat)).border, clear);
    if (!wide) assert.notEqual((await fills(newChat)).background, clear);
    assert.equal(await shortcuts.getByRole('tooltip').count(), 0);
    await first.hover();
    await shortcuts.getByRole('tooltip').getByText('浏览项目里的画板、图片和代码块。', { exact: true }).waitFor();
    assert.notEqual((await fills(first)).background, clear);
    await page.mouse.move(viewport.width - 3, 8);
    await shortcuts.getByRole('tooltip').waitFor({ state: 'hidden' });
    assert.equal((await fills(first)).background, clear);
    await first.focus();
    await page.keyboard.press('Tab');
    assert.equal(await entries[1].evaluate((button) => document.activeElement === button), true);
    await shortcuts.getByRole('tooltip').getByText('工作流', { exact: true }).waitFor();
    assert.notEqual((await fills(entries[1])).background, clear);
    if (!wide) {
      const heading = await rail.getByRole('navigation', { name: '会话记录', exact: true }).getByRole('heading').boundingBox();
      assert.equal(heading.y - (boxes[0].y + boxes[0].height), 10);
    }
    await page.keyboard.press('Escape');
    await shortcuts.getByRole('tooltip').waitFor({ state: 'hidden' });
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

    const selectedShortcut = page.locator('.vc-playground-entry:visible[aria-current="page"]');
    if (wide) assert.notEqual((await fills(selectedShortcut)).background, clear);

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
    await page.waitForFunction((element) => {
      const { top, bottom } = element.getBoundingClientRect();
      return top >= 0 && bottom <= innerHeight;
    }, await source.elementHandle());
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

test('design comparison aligns parent and child, shares zoom, and durably carries selected boards', { timeout: 45_000 }, async (t) => {
  const page = await openPreview(t);
  const requests = [];
  await page.route('**/dsh-vps-chat/api/rpc', (route) => {
    requests.push(route.request().postDataJSON().op);
    return route.continue();
  });
  const scene = await openDesign(page);
  const child = scene.getByRole('button', { name: '纸间书店 · 青色分支', exact: true });
  const comparison = page.getByRole('dialog', { name: '对比来源版本', exact: true });
  const openComparison = async () => {
    await page.getByRole('button', { name: '对比来源版本', exact: true }).click();
    await comparison.waitFor();
  };
  await child.click();
  await openComparison();
  const boardChange = comparison.getByLabel('画板变化', { exact: true });
  const options = await boardChange.locator('option').allTextContents();
  assert.deepEqual(options, ['修改 · 纸间书店 · 青色分支', '移除 · 纸间书店 · 活动详情']);
  const left = comparison.getByTitle('父版画板预览');
  const right = comparison.getByTitle('子版画板预览');
  const zoom = comparison.getByLabel('同步缩放', { exact: true });
  const getScales = () => comparison.locator('iframe').evaluateAll((frames) => frames.map((frame) => frame.style.transform));
  await zoom.selectOption('50');
  assert.deepEqual(await getScales(), ['scale(0.5)', 'scale(0.5)']);
  await comparison.getByText('图层变化（1）', { exact: true }).click();
  await comparison.getByText('查看本月荐书 → 浏览秋日荐书', { exact: false }).waitFor();
  assert.equal(await right.getAttribute('sandbox'), '');
  assert.match(await left.getAttribute('srcdoc'), /outline:2px solid/);
  assert.match(await right.getAttribute('srcdoc'), /outline:2px solid/);
  for (const width of [420, 365]) {
    await page.setViewportSize({ width, height: width === 365 ? 480 : 640 });
    await zoom.selectOption('fit');
    const boxes = [await left.boundingBox(), await right.boundingBox()];
    assert.ok(boxes[0].x < boxes[1].x);
    assert.ok(boxes[0].y === boxes[1].y);
    assert.equal(...await getScales());
    await assertWithinViewport(zoom);
  }
  const save = comparison.getByRole('button', { name: '带入新版本（2）', exact: true });
  await comparison.getByRole('checkbox', { name: '带入子版画板 纸间书店 · 青色分支' }).check();
  await boardChange.selectOption('1');
  await comparison.getByText('此侧无对应画板', { exact: true }).waitFor();
  await comparison.getByRole('checkbox', { name: '带入父版画板 纸间书店 · 活动详情' }).check();
  assert.deepEqual(await comparison.getByRole('list', { name: '带入顺序' }).getByRole('button').allTextContents(),
    ['子版 · 纸间书店 · 青色分支 ×', '父版 · 纸间书店 · 活动详情 ×']);
  await page.evaluate(() => {
    const savePreference = window.vpsWorkbench.setPreference;
    window.vpsWorkbench.setPreference = async (key, value) => {
      if (key.startsWith('dsh-vps-design:v1:') && JSON.parse(value).localVersions?.length) throw new Error('fixture write failure');
      return savePreference(key, value);
    };
    window.restoreDesignSave = () => { window.vpsWorkbench.setPreference = savePreference; };
  });
  await save.press('Enter');
  await comparison.getByRole('alert').getByText(/本机保存失败/).waitFor();
  assert.equal(await save.isEnabled(), true);
  await page.evaluate(() => window.restoreDesignSave());
  await save.press('Enter');
  await comparison.waitFor({ state: 'hidden' });
  const stored = () => page.evaluate((key) => {
    const { preferences } = JSON.parse(sessionStorage.getItem(key));
    return Object.entries(preferences).filter(([name]) => name.startsWith('dsh-vps-design:v1:'))
      .flatMap(([, value]) => JSON.parse(value).localVersions ?? []);
  }, previewStorageKey);
  const [saved] = await stored();
  assert.equal((await stored()).length, 1);
  assert.deepEqual(saved.origins.map(({ versionId, index }) => [versionId.slice(-3), index]), [['203', 1], ['102', 2]]);
  assert.equal(saved.parentId.slice(-3), '203');
  assert.match(saved.sources[0], /浏览秋日荐书/);
  assert.match(saved.sources[1], /沿江散步读书会/);
  await page.reload();
  const reloadedScene = await openDesign(page);
  await reloadedScene.locator(`[data-board-id="${saved.id}:1"]`).waitFor();
  await reloadedScene.locator(`[data-board-id="${saved.id}:2"]`).waitFor();
  assert.deepEqual(await stored(), [saved]);
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: '本地全局搜索', exact: true });
  await search.getByRole('searchbox').fill('浏览秋日荐书');
  await search.getByRole('button', { name: /画板.*青色分支.*本机版本 1/ }).click();
  await search.getByRole('button', { name: '在画布中打开', exact: true }).click();
  await search.waitFor({ state: 'hidden' });
  const current = page.getByLabel('设计版本', { exact: true });
  await current.locator(`option:checked[value="${saved.id}"]`).waitFor({ state: 'attached' });
  assert.ok(!requests.includes('send'));
});

test('workflow editor saves separate attachment and MCP tool grants for both local providers', { timeout: 35_000 }, async (t) => {
  const page = await openPreview(t, { previewOptions: { localAgents: true }, seed({ preferences }) {
    preferences['dsh-vps-chat:desktop-view-location:v1'] = 'ssh-vps';
  } });
  const { id, claude, agy } = await page.evaluate(async (key) => {
    const native = window.vpsWorkbench;
    const { targets } = await native.mixedWorkflow({ op: 'targets' });
    const claude = targets.find((item) => item.location === 'local-sdk' && item.providers.includes('claude-sdk')).id;
    const agy = targets.find((item) => item.location === 'local-sdk' && item.providers.includes('antigravity')).id;
    const vps = targets.find((item) => item.location === 'ssh-vps').id;
    for (const profile of [claude, agy]) {
      const server = { id: 'fixture-docs', targetId: targets.find(({ id }) => id === profile).targetId,
        local: { url: 'http://127.0.0.1:3000/mcp', tools: ['lookup', 'summarize', 'write'] } };
      for (const enabled of [false, true]) await native.changeExtensions({ op: 'save-server', server: { ...server, enabled } });
    }
    const stage = (id, name, provider, configId, location = 'local-sdk') => ({
      id, name, provider, instruction: '完成此步骤并按简报交付。', model: '',
      execution: { location, configId, context: 'independent' },
    });
    const record = { id: crypto.randomUUID(), revision: 1, name: '文本混合验收', stages: [
      stage('draft', '本机初稿', 'claude-sdk', claude),
      stage('review', '本机审校', 'antigravity', agy),
      stage('collect', 'VPS 汇总', 'codex', vps, 'ssh-vps'),
    ], edges: [{ from: 'draft', to: 'collect' }, { from: 'review', to: 'collect' }] };
    await native.setPreference(key, JSON.stringify([record]));
    return { id: record.id, claude, agy };
  }, workflowKey);
  await page.reload();
  await page.getByRole('button', { name: '工作流', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '工作流', exact: true });
  await panel.getByLabel('已保存的工作流').selectOption(id);
  const config = panel.getByRole('combobox', { name: /^执行配置/u });
  const provider = panel.getByRole('combobox', { name: /^执行工具/u });
  assert.equal(await config.inputValue(), claude);
  await config.selectOption(agy);
  assert.equal(await provider.inputValue(), 'antigravity');
  assert.equal(await provider.locator('option:checked').textContent(), 'Antigravity ACP');
  assert.equal(await panel.getByRole('button', { name: /读取第 .*阶段的模型目录/u }).count(), 0);
  await config.selectOption(claude);
  assert.equal(await provider.inputValue(), 'claude-sdk');
  assert.equal(await provider.locator('option:checked').textContent(), 'Claude Agent SDK');
  const attachment = panel.getByLabel('选择本地附件', { exact: true });
  assert.equal(await panel.getByLabel('本机相对路径').count(), 0);
  await attachment.setInputFiles({ name: '初稿资料.txt', mimeType: 'text/plain', buffer: Buffer.from('只给本机 Claude') });
  await panel.getByRole('button', { name: '移除本地附件 初稿资料.txt' }).waitFor();
  await config.selectOption(agy);
  await panel.getByRole('alert').getByText(/现有授权属于另一执行配置/u).waitFor();
  assert.equal(await attachment.isDisabled(), true);
  await config.selectOption(claude);
  await panel.getByRole('checkbox', { name: 'fixture-docs · lookup', exact: true }).check();
  assert.equal(await panel.getByRole('checkbox', { name: 'fixture-docs · write', exact: true }).isChecked(), false);
  await panel.getByRole('button', { name: '第 2 阶段 · 本机审校', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: '移除本地附件 初稿资料.txt' }).count(), 0);
  assert.equal(await panel.getByRole('checkbox', { name: 'fixture-docs · lookup', exact: true }).isChecked(), false);
  await panel.getByRole('checkbox', { name: 'fixture-docs · summarize', exact: true }).check();
  await attachment.setInputFiles({ name: '核对资料.txt', mimeType: 'text/plain', buffer: Buffer.from('只给本机 Antigravity') });
  await panel.getByRole('button', { name: '移除本地附件 核对资料.txt' }).waitFor();
  await panel.getByRole('button', { name: '保存工作流', exact: true }).click();
  const brief = panel.getByRole('group', { name: '运行简报', exact: true });
  await brief.getByLabel('运行任务', { exact: true }).fill('处理纯文本活动说明。');
  await brief.getByLabel('验收标准', { exact: true }).fill('按确认的字段汇总结论。');
  for (const field of await brief.getByRole('checkbox', { name: '结论', exact: true }).all()) await field.check();
  for (const approval of await brief.getByRole('checkbox', { name: '确认传递所选字段', exact: true }).all()) await approval.check();
  await brief.getByRole('button', { name: '开始运行', exact: true }).click();
  await panel.getByText('工作流已完成。', { exact: true }).waitFor({ timeout: 15_000 });
  const result = await page.evaluate(() => window.vpsWorkbench.mixedWorkflow({ op: 'status' }));
  assert.deepEqual(result.run.rows.map(({ state }) => state), ['complete', 'complete', 'complete']);
  assert.deepEqual(result.run.workflow.stages.map(({ fileAccess }) => fileAccess?.attachments.map(({ name }) => name) ?? []),
    [['初稿资料.txt'], ['核对资料.txt'], []]);
  assert.deepEqual(result.run.workflow.stages.map(({ agent }) => agent?.mcpServers.flatMap(({ tools }) => tools) ?? []),
    [['lookup'], ['summarize'], []]);
  assert.match(result.run.rows[0].reply, /Claude Agent SDK 完成阶段/u);
  assert.match(result.run.rows[1].reply, /Antigravity ACP 完成阶段/u);
});

test('design materials reuse the settings switches and keep persistent and per-message choices distinct', { timeout: 30_000 }, async (t) => {
  const page = await openPreview(t);
  await openDesign(page);
  const trigger = page.getByRole('button', { name: '添加设计资料', exact: true });
  const dialog = page.getByRole('dialog', { name: '设计资料', exact: true });
  const next = dialog.getByRole('group', { name: '随下一条消息发送', exact: true });
  const brief = dialog.getByRole('switch', { name: '后续设计轮次附带简报', exact: true });
  const auto = dialog.getByRole('switch', { name: '后续设计轮次应用设计系统', exact: true });
  const system = next.getByRole('switch', { name: '设计系统', exact: true });
  const references = next.getByRole('switch', { name: '参考资料', exact: true });
  await trigger.click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('switch').count(), 5);
  assert.equal(await dialog.getByRole('checkbox').count(), 0);
  const styles = await brief.evaluate((input) => {
    const style = getComputedStyle(input);
    return [style.appearance, style.width, style.height, style.borderRadius];
  });
  assert.deepEqual(styles, ['none', '32px', '18px', '999px']);
  const imports = dialog.getByRole('group', { name: '导入设计资料', exact: true });
  async function checkLayout(minImportHeight) {
    const buttons = await imports.locator('label').evaluateAll((labels) => labels.map((label) => {
      const { x, y, width, height } = label.getBoundingClientRect();
      return { x, y, width, height };
    }));
    assert.equal(buttons.length, 3);
    assert.ok(buttons.every(({ y, width, height }) =>
      y === buttons[0].y && Math.abs(width - buttons[0].width) < 1 && height >= minImportHeight));
    const gaps = buttons.slice(1).map(({ x }, index) => x - buttons[index].x - buttons[index].width);
    assert.ok(gaps.every((gap) => gap >= 6 && gap <= 8.1));
    assert.ok(await next.locator('label').evaluateAll((rows) => rows.every((row) => row.getBoundingClientRect().height >= 36)));
  }
  await checkLayout(36);
  await dialog.getByText('后续设计轮次附带简报', { exact: true }).click();
  await auto.press('Space');
  assert.equal(await brief.isChecked(), true);
  assert.equal(await auto.isChecked(), true);
  assert.equal(await system.isChecked(), true);
  assert.equal(await system.isDisabled(), true);
  await auto.press('Space');
  assert.equal(await system.isDisabled(), false);
  assert.equal(await system.isChecked(), false);

  await page.setViewportSize({ width: 365, height: 480 });
  await checkLayout(46);
  await references.press('Space');
  assert.equal(await references.isChecked(), true);
  await references.scrollIntoViewIfNeeded();
  await assertWithinViewport(references);
  assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await trigger.evaluate((button) => {
    if (document.activeElement !== button) throw new Error('设计资料关闭后焦点未返回入口');
  });
  await trigger.click();
  assert.equal(await references.isChecked(), true);
  assert.equal(await brief.isChecked(), true);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();

  await page.reload();
  await openDesign(page);
  await trigger.click();
  assert.equal(await brief.isChecked(), true);
  assert.equal(await references.isChecked(), false);
});

test('interface language applies immediately to both locations and survives reload without editing drafts', { timeout: 40_000 }, async (t) => {
  const page = await openPreview(t);
  const languageGroup = () => page.locator('dialog:modal').getByRole('group', { name: /^(?:界面语言|Language)$/ });
  const chatDraft = '保持这段草稿 unchanged 😊';
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await composer.fill(chatDraft);
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Language / 界面语言', exact: true }).click();
  await languageGroup().getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
  await languageGroup().getByRole('button', { name: 'English', pressed: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.title(), 'VPS Workbench');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('navigation', { name: 'Settings categories', exact: true })
    .getByRole('button', { name: 'Connection', exact: true }).click();
  await dialog.getByLabel('VPS host', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), chatDraft);
  await page.getByRole('button', { name: 'Local search', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Local search', exact: true });
  await search.getByRole('searchbox', { name: 'Local search', exact: true }).waitFor();
  await search.getByRole('button', { name: 'Close search', exact: true }).click();
  await page.getByRole('group', { name: 'Conversation locations' })
    .getByRole('button', { name: 'Local SDK', exact: true }).click();
  await page.getByRole('group', { name: 'Local controls', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('group', { name: 'Local controls', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Language / 界面语言', exact: true }).click();
  await languageGroup().getByRole('button', { name: '简体中文', exact: true }).click();
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
});

test('language controls fit a compact viewport and invalid saved locales fall back to Chinese', { timeout: 25_000 }, async (t) => {
  const page = await openPreview(t, { viewport: { width: 365, height: 480 }, seed(state) {
    state.preferences['dsh-vps-chat:interface-language:v1'] = 'unsupported';
  } });
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Language / 界面语言', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('button', { name: 'English', exact: true }).press('Enter');
  const english = page.getByRole('dialog', { name: 'Settings', exact: true });
  const selected = english.getByRole('button', { name: 'English', pressed: true });
  await selected.waitFor();
  const bounds = await selected.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 365);
  await selected.press('Escape');
  await english.waitFor({ state: 'hidden' });
});
