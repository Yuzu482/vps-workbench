import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { openSettingsSection } from './test-settings.mjs';
import { openAppData } from './data.mjs';
import { createBridge } from '../../remote-workbench/vps-chat/host/index.js';

const require = createRequire(import.meta.url);
const { _electron } = require('../../dsh-terminal-workbench/client/browser-test/node_modules/playwright-core');
const { version } = require('../package.json');
const executable = resolve(process.env.VPS_WORKBENCH_TEST_EXE ||
  `dist/VPS-Workbench-${version}-win-x64/VPS Workbench.exe`);
const runtime = join(dirname(executable), 'resources/app/helper');
const legacyBaseline = process.env.VPS_WORKBENCH_TEST_BASELINE === '1';

test('packaged Windows workbench loads independently, runs the UI, and restores preferences', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-workbench-package-test-'));
  const browserData = join(directory, 'desktop');
  const conversations = join(browserData, 'conversations');
  const pretendAppData = join(directory, 'isolated-appdata');
  const identityPath = join(directory, 'fixture-key');
  const knownHostsPath = join(directory, 'known_hosts');
  await mkdir(conversations, { recursive: true });
  await mkdir(pretendAppData);
  await writeFile(identityPath, 'fixture only');
  await writeFile(knownHostsPath, 'fixture.invalid ssh-ed25519 fixture only\n');
  const settings = { host: 'fixture.invalid', port: 22, user: 'fixture', identityPath, knownHostsPath,
    workspace: '/work/fixture', expectedIpv4: '192.0.2.18', expectedIpv6: '', hostKeyConfirmed: true, provider: 'codex' };
  const localState = await openAppData(browserData);
  async function readPreferences() {
    try { return JSON.parse(await readFile(join(browserData, 'preferences.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  const project = join(directory, '测试美术项目');
  const secondProject = join(directory, '测试目录选择');
  await mkdir(project);
  await mkdir(secondProject);
  await localState.addProject(project);
  const variants = [['codex', 'compat'], ['claude', 'compat'], ['claude-sdk', 'compat/sdk'],
    ['antigravity', 'compat/antigravity']];
  let targetId;
  for (const [provider, path] of variants) {
    const reply = JSON.parse(execFileSync(join(runtime, path, 'DshVpsChatBridge.exe'), [conversations], {
      input: JSON.stringify({ op: 'list', settings: { ...settings, provider } }),
      encoding: 'utf8', windowsHide: true, timeout: 7000,
    }));
    assert.equal(reply.ok, true, provider + ': local state unavailable');
    assert.match(reply.targetId, /^[a-f0-9]{64}$/);
    if (provider === 'codex') targetId = reply.targetId;
  }
  await writeFile(join(conversations, 'default-target.json'),
    JSON.stringify({ name: '独立验收服务器', settings, targetId }));
  if (!legacyBaseline) {
    const bridge = createBridge({ root: conversations, executable: join(runtime, 'DshVpsChatBridge.exe'),
      compatibilityDirectory: join(runtime, 'compat'), pythonPath: join(directory, 'unused-python.exe') });
    const response = await bridge.request({ op: 'configuration' });
    bridge.dispose();
    assert.equal(response.ok, true);
    assert.equal(response.preset.targetId, targetId);
    assert.match(response.preset.memoryTargetId, /^[a-f0-9]{64}$/);
    assert.deepEqual(response.preset.sessions, []);
  }
  // Enforce an invalid relay for the fixture so any unexpected real operation fails before SSH.
  await writeFile(join(conversations, 'ssh-relay.json'), '{}');
  const python = join(process.env.LOCALAPPDATA, 'Programs/Python/Python311/python.exe');
  const env = { ...process.env, APPDATA: pretendAppData, LOCALAPPDATA: pretendAppData,
    VPS_WORKBENCH_DATA_DIR: browserData, VPS_WORKBENCH_PYTHON: python };
  let desktop;
  const pageErrors = [];
  const requests = [];
  const code = 'const isolated = true;';
  const fence = String.fromCharCode(96).repeat(3);
  async function open() {
    desktop = await _electron.launch({ executablePath: executable, timeout: 15_000, cwd: directory, env });
    const page = await desktop.firstWindow({ timeout: 10_000 });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => requests.push(request.url()));
    page.setDefaultTimeout(9000);
    await page.getByText(legacyBaseline ? '独立验收服务器 · 已配置' : '独立验收服务器 · VPS 已配置', { exact: true }).waitFor();
    return page;
  }
  try {
    let page = await open();
    const firstOrigin = new URL(page.url()).origin;
    assert.equal(await page.evaluate(() => typeof window.__ModuleLoader__), 'undefined');
    assert.equal(await page.title(), 'VPS 工作台');
    assert.equal(await (await fetch(page.url())).status, 403);
    await page.waitForFunction(() => document.querySelector('.desktop-app-icon')?.naturalWidth > 0);
    const titleBar = page.getByRole('group', { name: '工作台操作', exact: true });
    const appMenu = titleBar.getByRole('button', { name: legacyBaseline ? '工作台菜单' : '文件', exact: true });
    const editMenu = legacyBaseline ? appMenu : titleBar.getByRole('button', { name: '编辑', exact: true });
    const projectMenuLabel = legacyBaseline ? '本地项目' : '项目';
    const projectsMenu = titleBar.getByRole('button', { name: projectMenuLabel, exact: true });
    const sidebar = page.getByRole('complementary', { name: 'VPS 对话列表' });
    const hideSidebar = titleBar.getByRole('button', { name: '收起会话侧栏' });
    const showSidebar = titleBar.getByRole('button', { name: '展开会话侧栏' });
    const footer = page.getByRole('group', { name: 'VPS 操作', exact: true });
    const chooser = footer.getByRole('button', { name: '切换 VPS 执行端', exact: true });
    assert.equal(await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu()), null);
    await page.waitForFunction(() => navigator.windowControlsOverlay?.visible);
    async function verifyCaptionSpace() {
      assert.ok(await titleBar.evaluate((controls) => {
        const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
        const action = controls.querySelector('.desktop-projects-trigger').getBoundingClientRect();
        return area.width > 0 && area.width < innerWidth && action.right <= area.right && action.bottom <= area.bottom;
      }));
    }
    async function verifyFooter(stacked) {
      await chooser.waitFor();
      await chooser.locator('img').evaluate((image) => image.decode());
      assert.ok(await footer.evaluate((element, vertical) => {
        const root = element.closest('[data-vps-chat]').getBoundingClientRect();
        const dock = element.getBoundingClientRect();
        const main = element.parentElement.querySelector('.vc-main').getBoundingClientRect();
        const picker = element.querySelector('.vc-tool-trigger').getBoundingClientRect();
        const settings = element.querySelector('.vc-sidebar-settings').getBoundingClientRect();
        const rail = element.parentElement.querySelector('.vc-rail').getBoundingClientRect();
        const logo = element.querySelector('.vc-tool-badge img');
        return Math.abs(dock.left - root.left) < 1 && Math.abs(dock.bottom - root.bottom) < 1 &&
          rail.bottom <= dock.top + 1 && logo?.naturalWidth > 0 && logo.clientWidth >= 24 &&
          (vertical ? picker.bottom <= settings.top && dock.right <= main.left + 1
            : picker.right <= settings.left && main.bottom <= dock.top + 1);
      }, stacked));
    }
    await verifyCaptionSpace();
    await page.getByRole('button', { name: '测试美术项目', exact: true }).waitFor();
    if (!legacyBaseline) {
      await verifyFooter(true);
      assert.equal(await chooser.innerText(), 'Codex');
      assert.equal(await footer.locator('.vc-sidebar-settings [data-icon=settings] svg').count(), 1);
      assert.equal(await page.locator('.vc-header :is(.vc-tool-trigger, .vc-header-settings), .vc-account-entry').count(), 0);
      const newChat = sidebar.getByRole('button', { name: '新建对话', exact: true });
      await newChat.waitFor();
      assert.equal(await newChat.locator('[data-icon=new-chat] svg').count(), 1);
      assert.equal(await footer.getByRole('button', { name: '新建对话', exact: true }).count(), 0);
      assert.equal(await page.locator('.vc-composer [data-control=mode] [data-icon=chat]').count(), 1);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => {
        globalThis.fixtureRailFades = 0;
        document.querySelector('.vc-rail').addEventListener('transitionrun', (event) => {
          if (event.target === event.currentTarget && event.propertyName === 'opacity') globalThis.fixtureRailFades++;
        });
        const surfaces = {
          title: '.desktop-title-menu[aria-label="文件"]',
          tool: '.vc-tool-palette',
          access: '.vc-composer-panel[data-kind="access"]',
          mode: '.vc-composer-panel[data-kind="mode"]',
          context: '.vc-context-menu:not(.vc-export-menu)',
          export: '.vc-export-menu',
          folder: '.vc-session-group:has(button[title="测试美术项目"]) .vc-disclosure-motion',
          resources: '.vc-resource-library',
        };
        globalThis.fixtureMenuFades = [];
        document.addEventListener('transitionrun', (event) => {
          if (event.propertyName !== 'opacity' || event.pseudoElement) return;
          const surface = event.target;
          const name = Object.keys(surfaces).find((key) => surface.matches(surfaces[key]));
          if (!name) return;
          const style = getComputedStyle(surface);
          globalThis.fixtureMenuFades.push({
            name, opening: surface.matches(':popover-open,[open],[data-open=true],[data-expanded=true]'),
            duration: style.transitionDuration.split(',')[0],
            curve: surface.getAnimations().find((animation) => animation.transitionProperty === 'opacity')
              ?.effect.getTiming().easing,
            visible: style.display !== 'none' && Number(style.opacity) > 0,
            inert: surface.inert,
          });
        });
      });
    }
    await hideSidebar.click();
    await sidebar.waitFor({ state: 'hidden' });
    if (!legacyBaseline) {
      const rail = page.locator('#desktop-workbench-sidebar');
      await rail.waitFor({ state: 'hidden' });
      assert.equal(await rail.evaluate((element) => element.inert), true);
      await verifyFooter(false);
    }
    await showSidebar.click();
    await sidebar.waitFor();
    if (!legacyBaseline) await page.waitForFunction(() =>
      globalThis.fixtureRailFades >= 2 && getComputedStyle(document.querySelector('.vc-rail')).opacity === '1');
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(365, 640));
    await page.waitForFunction(() => innerWidth <= 620);
    await verifyCaptionSpace();
    await sidebar.waitFor({ state: 'hidden' });
    await showSidebar.click();
    await sidebar.waitFor();
    if (!legacyBaseline) {
      await verifyFooter(false);
      await chooser.press('ArrowDown');
      const palette = page.getByRole('listbox', { name: '已配置的 VPS 执行端', exact: true });
      await palette.waitFor();
      assert.ok(await palette.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const trigger = element.previousElementSibling.getBoundingClientRect();
        return box.bottom < trigger.top && box.left >= 0 && box.right <= innerWidth;
      }));
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'hidden' });
      assert.equal(await chooser.evaluate((element) => element === document.activeElement), true);
    }
    await hideSidebar.click();
    await sidebar.waitFor({ state: 'hidden' });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 850));
    await sidebar.waitFor();
    assert.equal(await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const maximized = new Promise((resolve) => window.once('maximize', resolve));
      window.maximize();
      await maximized;
      return window.isMaximized();
    }), true);
    await verifyCaptionSpace();
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const restored = new Promise((resolve) => window.once('unmaximize', resolve));
      window.unmaximize();
      await restored;
    });

    const windowsAppData = await desktop.evaluate(({ app }) => app.getPath('appData'));
    await desktop.evaluate(({ dialog }, path) => {
      globalThis.fixtureDirectoryPickers = [];
      dialog.showOpenDialog = async (_window, options) => {
        globalThis.fixtureDirectoryPickers.push(options);
        return options.defaultPath ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] };
      };
    }, secondProject);
    await appMenu.focus();
    await page.keyboard.press('ArrowDown');
    const importItem = page.getByRole('menuitem', { name: '导入 DSH 对话数据…', exact: true });
    assert.equal(await importItem.evaluate((item) => item === document.activeElement), true);
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('menuitem', { name: /退出工作台/ })
      .evaluate((item) => item === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await appMenu.evaluate((button) => button === document.activeElement), true);
    if (!legacyBaseline) {
      await appMenu.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      await page.getByRole('menu', { name: '编辑', exact: true }).waitFor();
      await page.keyboard.press('End');
      assert.equal(await page.getByRole('menuitem', { name: /全选/ }).evaluate((item) => item === document.activeElement), true);
      await page.keyboard.press('Escape');
    }
    await appMenu.click();
    await importItem.click();
    await projectsMenu.click();
    await page.getByRole('menuitem', { name: '添加目录…', exact: true }).click();
    const addedProject = sidebar.getByRole('button', { name: '测试目录选择', exact: true });
    await addedProject.waitFor();
    await projectsMenu.click();
    await page.getByRole('menuitem', { name: '移出 测试目录选择', exact: true }).click();
    await addedProject.waitFor({ state: 'hidden' });
    const savedProjects = JSON.parse(await readFile(join(browserData, 'projects.json'), 'utf8'));
    assert.deepEqual(savedProjects.map(({ workspaceId, title }) => ({ workspaceId, title })), localState.projects());
    assert.deepEqual(await desktop.evaluate(() => globalThis.fixtureDirectoryPickers), [
      { title: '选择原有 vps-chat-workbench 数据目录',
        defaultPath: join(windowsAppData, 'dsh-desktop', 'harness', 'vps-chat-workbench'), properties: ['openDirectory'] },
      { title: '添加本地项目目录', properties: ['openDirectory'] },
    ]);

    let pinnedProjectId;
    const after = [];
    const stopCalls = [];
    const designSupplements = [];
    let snapshots = 0;
    let transientRefreshFailure = false;
    const opening = ['## 正在生成的长回复', ...Array.from({ length: 42 }, (_, index) =>
      `第 ${index + 1} 段。**工作台**处理 *长文本* 和 \`Markdown\`。 `.repeat(4))].join('\n\n');
    assert.ok(opening.length >= 4096);
    const appended = opening + '\n\n## 新到的流式段落\n\n这一段紧随前文。';
    const final = ['## 独立对话测试已返回', '', fence + 'js', code, fence].join('\n');
    const designs = ['独立海报画板', '第二张海报画板'].map((title) =>
      [fence + 'html', `<!doctype html><html><body><h1>${title}</h1></body></html>`, fence].join('\n')).join('\n\n');
    const variant = [fence + 'html', '<!doctype html><html><title>青色变体</title><body><h1>青色变体</h1></body></html>', fence].join('\n');
    const forkBoard = [fence + 'html', '<title>红色分支</title><h1>红色分支</h1>', fence].join('\n');
    const updatedBoard = [fence + 'html', '<title>青色后续</title><h1>青色后续</h1>', fence].join('\n');
    const unusableBoard = [fence + 'html', '<html><head><title>空稿</title></head><body></body></html>', fence].join('\n');
    let finishVariant = false;
    function reply(packet, text, state) {
      const mode = packet.mode ?? 'chat';
      return { ok: true, session: { id: packet.sessionId, title: packet.prompt, mode,
        canSend: state !== 'running', turns: [{
          id: packet.turnId, prompt: packet.prompt, state, activity: [], reply: text,
          streaming: mode === 'chat', canStop: state === 'running',
        }] } };
    }
    await page.evaluate(() => {
      globalThis.fixtureMarkdownJobs = [];
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (data, ...args) {
        if (typeof data?.source === 'string') globalThis.fixtureMarkdownJobs.push(data.source.length);
        return post.call(this, data, ...args);
      };
    });
    await page.route('**/dsh-vps-chat/api/rpc', async (route) => {
      const packet = route.request().postDataJSON();
      if (packet.op === 'model-options' && packet.settings?.provider === 'codex') {
        await route.fulfill({ json: { ok: true, fields: ['verbosity'] } });
      } else if (packet.op === 'send') {
        after.push(packet);
        await route.fulfill({ json: packet.mode === 'design' ? designReply() : reply(packet, opening, 'running') });
      } else if (packet.op === 'refresh' && packet.sessionId === after[0]?.sessionId) {
        if (!legacyBaseline && snapshots === 1 && !transientRefreshFailure) {
          transientRefreshFailure = true;
          await route.abort('connectionreset');
          return;
        }
        snapshots++;
        await route.fulfill({ json: stopCalls.length ? reply(after[0], final, 'stopped')
          : reply(after[0], snapshots === 1 ? opening : appended, 'running') });
      } else if (packet.op === 'stop' && packet.sessionId === after[0]?.sessionId) {
        stopCalls.push(packet);
        await route.fulfill({ json: { ok: true, outcome: 'requested' } });
      } else if (packet.op === 'steer' && packet.sessionId === after[1]?.sessionId) {
        designSupplements.push(packet);
        await route.fulfill({ json: designReply() });
      } else if (['get', 'refresh'].includes(packet.op) && packet.sessionId === after[1]?.sessionId) {
        await route.fulfill({ json: designReply() });
      } else if (packet.op === 'design-history' && packet.sessionId === after[1]?.sessionId) {
        const { turns } = designReply().session;
        if (packet.turnId) return route.fulfill({ json: { ok: true, turn: turns.find(({ id }) => id === packet.turnId) } });
        const roots = new Map();
        const tips = new Map();
        for (const turn of turns) {
          const root = !turn.fork && roots.get(turn.parentTurnId) || turn.id;
          roots.set(turn.id, root);
          tips.set(root, turn.id);
        }
        await route.fulfill({ json: { ok: true, history: turns.map(({ id, parentTurnId, fork, ordinal, prompt, state }) => ({
          id, parentTurnId, fork, ordinal, title: prompt, state, hasBoards: state === 'complete',
          canContinue: state === 'complete' && tips.get(roots.get(id)) === id,
        })) } });
      } else if (packet.op === 'get' && packet.sessionId === after[0]?.sessionId) {
        await route.fulfill({ json: reply(after[0], final, 'stopped') });
      } else await route.continue();
    });
    function designReply() {
      const result = reply(after[1], designs, 'complete');
      const designTurns = after.filter(({ mode }) => mode === 'design');
      function scopedReply(packet) {
        const example = /<meta name="dsh-layer-revision" content='([^\r\n']+)'>/.exec(packet.designContext?.text ?? '')?.[1];
        if (!example) return unusableBoard;
        const { base, layer } = JSON.parse(example);
        const changes = packet.prompt.includes('越界') ? { removed: true } : { text: '只更新第二张标题', borderRadius: 12 };
        return [fence + 'html', `<!doctype html><html><head><meta name="dsh-layer-revision" content='${JSON.stringify({ base, layer, changes })}'>` +
          '<title>模型草稿</title></head><body><h1>本段草稿只用于传递属性</h1></body></html>', fence].join('\n');
      }
      result.session.turns = designTurns.map((packet, index) => ({
        ...reply(packet, [designs, variant, forkBoard, updatedBoard, unusableBoard][index] ?? scopedReply(packet),
          index === 1 && !finishVariant ? 'running' : 'complete').session.turns[0],
        streaming: true, ordinal: index + 1, fork: packet.designBase?.fork ?? false,
        canSteer: index === 1 && !finishVariant,
        steering: designSupplements.filter(({ turnId }) => turnId === packet.turnId)
          .map(({ steerId: id, prompt }) => ({ id, prompt, state: 'delivered' })),
        parentTurnId: packet.designBase?.parentTurnId ?? designTurns[index - 1]?.turnId ?? null,
      }));
      result.session.canSend = result.session.turns.at(-1).state === 'complete';
      result.session.canBranch = result.session.canSend;
      return result;
    }
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    const modelTrigger = page.getByRole('button', { name: '模型', exact: true });
    const modelPanel = page.getByRole('dialog', { name: '模型', exact: true });
    const verbosityControl = modelPanel.locator('select[name=verbosity]');
    const modelParameterKey = `dsh-vps-chat:model-parameters:v1:${targetId}`;
    async function openModelParameters() {
      await modelTrigger.click();
      await modelPanel.locator('.vc-advanced-model > summary').click();
    }
    async function closeModelParameters() {
      await modelPanel.getByRole('button', { name: '关闭', exact: true }).click();
      await page.locator('.vc-composer-panel[data-kind=model]').waitFor({ state: 'detached' });
    }
    const reference = { title: '设计风格', text: '使用温暖的自然色。' };
    const template = '检查这个项目的资源清单。';
    if (!legacyBaseline) {
      const accessTrigger = page.getByRole('button', { name: '访问权限', exact: true });
      await accessTrigger.click();
      const accessPanel = page.getByRole('dialog', { name: '访问权限', exact: true });
      await accessPanel.getByRole('button', { name: '强制只读', exact: true }).click();
      await accessTrigger.filter({ hasText: '强制只读' }).waitFor();
      await accessPanel.getByRole('button', { name: '仅浏览', exact: true }).click();
      await accessTrigger.filter({ hasText: '仅浏览' }).waitFor();
      await editor.fill('权限草稿');
      assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: legacyBaseline ? 'VPS 设置' : '设置', exact: true }).click();
      const toolDialog = page.getByRole('dialog', { name: legacyBaseline ? 'VPS 设置' : '设置', exact: true });
      await openSettingsSection(toolDialog, '执行端');
      const codexProfile = toolDialog.locator('details.vc-tool-disclosure')
        .filter({ has: page.getByText('Codex 独立设置', { exact: true }) });
      await codexProfile.locator('summary').click();
      await codexProfile.getByText('支持对话、设计模式和工作台 MCP。', { exact: true }).waitFor();
      await codexProfile.getByText('切换到「VPS 执行」后可读取此工具的模型。', { exact: true }).waitFor();
      await toolDialog.getByRole('button', { name: '关闭设置', exact: true }).click();
      await toolDialog.waitFor({ state: 'hidden' });
      if (!(await accessPanel.isVisible())) await accessTrigger.click();
      await accessPanel.getByRole('button', { name: 'VPS 执行', exact: true }).click();
      await accessTrigger.filter({ hasText: '强制只读' }).waitFor();
      const modeTrigger = page.getByRole('button', { name: '模式', exact: true });
      await modeTrigger.click();
      await page.getByRole('dialog', { name: '模式', exact: true }).waitFor();
      assert.equal(await accessTrigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await modeTrigger.getAttribute('aria-expanded'), 'true');
      await modeTrigger.click();
      await page.getByRole('dialog', { name: '模式', exact: true }).waitFor({ state: 'hidden' });
      await accessPanel.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: legacyBaseline ? 'VPS 设置' : '设置', exact: true }).click();
      const settingsPanel = page.getByRole('dialog', { name: legacyBaseline ? 'VPS 设置' : '设置', exact: true });
      await openSettingsSection(settingsPanel, 'MCP 服务器');
      await settingsPanel.getByLabel('服务 ID', { exact: true }).fill('fixture-status');
      await settingsPanel.getByRole('button', { name: '添加', exact: true }).click();
      const mcp = settingsPanel.getByRole('switch', { name: '启用服务', exact: true });
      assert.equal(await mcp.isChecked(), false);
      await mcp.click();
      await mcp.and(settingsPanel.locator('input:checked')).waitFor();
      await openSettingsSection(settingsPanel, '提示词模板');
      await settingsPanel.getByLabel('粘贴 JSON 清单', { exact: true }).fill(JSON.stringify({
        schema: 1, id: 'fixture-tools', name: '示例插件', version: '1.0.0', description: '',
        prompts: [{ title: '检查资源', text: template }],
      }));
      await settingsPanel.getByRole('button', { name: '导入粘贴的提示词模板', exact: true }).click();
      const plugin = settingsPanel.getByRole('switch', { name: '启用提示词模板', exact: true });
      assert.equal(await plugin.isChecked(), false);
      await plugin.click();
      await plugin.and(settingsPanel.locator('input:checked')).waitFor();
      await openSettingsSection(settingsPanel, '长期记忆');
      const personalMemory = settingsPanel.getByRole('switch', { name: '开启个人自动记忆', exact: true });
      assert.equal(await personalMemory.isChecked(), false);
      assert.deepEqual(await personalMemory.evaluate((input) => {
        const style = getComputedStyle(input);
        return { appearance: style.appearance, width: style.width, height: style.height };
      }), { appearance: 'none', width: '38px', height: '22px' });
      await personalMemory.press('Space');
      await personalMemory.and(settingsPanel.locator('input:checked')).waitFor();
      await page.waitForFunction(() => {
        const input = document.querySelector('input[aria-label="开启个人自动记忆"]');
        return new DOMMatrixReadOnly(getComputedStyle(input, '::before').transform).m41 === 16;
      });
      await settingsPanel.getByText('个人自动记忆', { exact: true }).click();
      await personalMemory.and(settingsPanel.locator('input:not(:checked)')).waitFor();
      await settingsPanel.getByRole('combobox', { name: '记忆所属项目', exact: true }).selectOption('');
      assert.equal(await settingsPanel.getByRole('switch', { name: '开启此项目的自动记忆', exact: true }).isDisabled(), true);
      assert.equal(await settingsPanel.getByRole('combobox', { name: /^Codex 模型/ }).inputValue(), '');
      assert.equal(await settingsPanel.getByRole('combobox', { name: /^提炼推理强度/ }).inputValue(), '');
      await settingsPanel.getByRole('button', { name: '添加记忆', exact: true }).click();
      await settingsPanel.getByLabel('标题', { exact: true }).fill(reference.title);
      await settingsPanel.getByLabel('内容', { exact: true }).fill(reference.text);
      await settingsPanel.getByRole('button', { name: '保存记忆', exact: true }).click();
      const includeMemory = settingsPanel.getByRole('switch', { name: '随消息发送手动记忆', exact: true });
      await includeMemory.click();
      await includeMemory.and(settingsPanel.locator('input:checked')).waitFor();
      await settingsPanel.getByRole('button', { name: '完成', exact: true }).click();
      await settingsPanel.waitFor({ state: 'hidden' });
      await editor.fill('');
      await page.getByRole('button', { name: '提示词模板', exact: true }).click();
      await page.getByRole('dialog', { name: '提示词模板', exact: true })
        .getByRole('button', { name: '检查资源', exact: true }).click();
      assert.equal(await editor.inputValue(), template);
      await page.getByText('长期记忆 1 条', { exact: true }).waitFor();
      await page.getByText('MCP 1 个', { exact: true }).waitFor();
    }
    await editor.fill('测试独立会话');
    await projectsMenu.click();
    await editor.click();
    await page.getByRole('menu', { name: projectMenuLabel, exact: true }).waitFor({ state: 'hidden' });
    await page.keyboard.press('Control+a');
    await page.waitForFunction(() => document.activeElement.selectionStart === 0 &&
      document.activeElement.selectionEnd === '测试独立会话'.length);
    await page.keyboard.press('ArrowRight');
    await editMenu.click();
    await page.getByRole('menuitem', { name: /全选/ }).click();
    await page.waitForFunction(() => document.activeElement.selectionStart === 0 &&
      document.activeElement.selectionEnd === '测试独立会话'.length);
    if (!legacyBaseline) {
      await openModelParameters();
      await modelPanel.getByRole('button', { name: '重试', exact: true }).click();
      await verbosityControl.selectOption('low');
      await modelPanel.getByRole('button', { name: '应用', exact: true }).click();
      await modelPanel.getByText('已应用到后续请求。', { exact: true }).waitFor();
      const stored = JSON.parse(await readFile(join(browserData, 'preferences.json'), 'utf8'));
      assert.deepEqual(JSON.parse(stored[modelParameterKey]), { verbosity: 'low' });
      await closeModelParameters();
    }
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('heading', { name: '正在生成的长回复', exact: true }).waitFor();
    await page.getByRole('heading', { name: '新到的流式段落', exact: true }).waitFor();
    if (!legacyBaseline) {
      assert.equal(transientRefreshFailure, true);
      assert.equal(after.length, 1);
      t.diagnostic('Automatic status recovery resumed the original stream without repeating its send.');
    }
    await page.waitForFunction(() => {
      const scroll = document.querySelector('.vc-scroll');
      return scroll.scrollHeight > scroll.clientHeight && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 4;
    });
    assert.deepEqual(await page.evaluate(() => globalThis.fixtureMarkdownJobs),
      legacyBaseline ? [] : [opening.length, appended.length]);
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await page.getByRole('heading', { name: '独立对话测试已返回', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '新到的流式段落', exact: true }).count(), 0);
    assert.equal(stopCalls.length, 1);
    assert.equal(stopCalls[0].sessionId, after[0].sessionId);
    assert.equal(stopCalls[0].turnId, after[0].turnId);
    t.diagnostic(`Streamed the same ${opening.length}-character reply with a duplicate and an append. ` +
      `Live Markdown worker jobs: ${legacyBaseline ? 0 : 2}.`);
    assert.equal(after.length, 1);
    assert.equal(after[0].targetId, targetId);
    assert.equal(after[0].settings.provider, 'codex');
    if (!legacyBaseline) {
      assert.deepEqual(after[0].extensions, { mcpServers: ['fixture-status'], memory: [reference] });
      assert.deepEqual(after[0].advanced, { verbosity: 'low' });
      await openModelParameters();
      assert.equal(await verbosityControl.inputValue(), 'low');
      await modelPanel.getByRole('button', { name: '恢复默认', exact: true }).click();
      await modelPanel.getByText('已恢复执行端默认。', { exact: true }).waitFor();
      await closeModelParameters();
    }
    await desktop.evaluate(({ clipboard }) => { clipboard.writeText = (text) => { globalThis.fixtureClipboard = text; }; });
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
    assert.equal(await desktop.evaluate(() => globalThis.fixtureClipboard), code);
    if (!legacyBaseline) {
      const messageMenu = page.getByRole('menu', { name: '消息操作' });
      await page.locator('.vc-code-block pre code').click({ button: 'right' });
      await messageMenu.getByRole('menuitem', { name: '复制代码', exact: true }).click();
      await messageMenu.waitFor({ state: 'hidden' });
      assert.equal(await desktop.evaluate(() => globalThis.fixtureClipboard), code);
      await page.locator('.vc-answer').click({ button: 'right' });
      await messageMenu.getByRole('menuitem', { name: '复制回复', exact: true }).click();
      assert.equal(await desktop.evaluate(() => globalThis.fixtureClipboard), final);

      const editorMenu = page.getByRole('menu', { name: '编辑消息' });
      await editor.fill('右键编辑测试');
      const contextSurface = page.locator('.vc-context-menu');
      await contextSurface.waitFor({ state: 'detached' });
      await page.evaluate(() => { globalThis.fixtureMenuFades = globalThis.fixtureMenuFades.filter(({ name }) => name !== 'context'); });
      await editor.click({ button: 'right', position: { x: 12, y: 12 } });
      await page.waitForFunction(() => {
        const menu = document.querySelector('.vc-context-menu:popover-open');
        return menu && getComputedStyle(menu).opacity === '1';
      });
      // Clicking the originating field is outside a context menu as well.
      await editor.click({ position: { x: 38, y: 24 } });
      await contextSurface.waitFor({ state: 'detached', timeout: 3_000 });
      const { contextFades, titleOpen } = await page.evaluate(() => ({
        contextFades: globalThis.fixtureMenuFades.filter(({ name }) => name === 'context'),
        titleOpen: globalThis.fixtureMenuFades.find(({ name, opening }) => name === 'title' && opening),
      }));
      assert.deepEqual(contextFades.map(({ opening, duration, curve }) => ({ opening, duration, curve })), [
        { opening: true, duration: titleOpen.duration, curve: titleOpen.curve },
        { opening: false, duration: titleOpen.duration, curve: titleOpen.curve },
      ]);
      assert.ok(contextFades[1].visible && contextFades[1].inert, 'outside dismissal fades while leaving the editor usable');
      assert.equal(await editor.evaluate((element) => document.activeElement === element), true);

      await editor.click({ button: 'right', position: { x: 12, y: 12 } });
      const previousMenu = await editorMenu.elementHandle();
      await page.waitForFunction((menu) => getComputedStyle(menu).opacity === '1', previousMenu);
      await editor.click({ button: 'right', position: { x: 38, y: 24 } });
      assert.equal(await editorMenu.evaluate((menu, previous) => menu !== previous, previousMenu), true,
        'right-clicking again opens a fresh surface while the old menu fades');
      await previousMenu.dispose();
      await page.waitForFunction(() => {
        const fades = globalThis.fixtureMenuFades.filter(({ name }) => name === 'context');
        return fades.filter(({ opening }) => opening).length >= 3 &&
          fades.filter(({ opening, visible, inert }) => !opening && visible && inert).length >= 2;
      });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.vc-context-menu'));

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await editor.click({ button: 'right', position: { x: 12, y: 12 } });
      assert.equal(await editorMenu.evaluate((menu) => getComputedStyle(menu).transitionDuration.split(',')[0]), '0s');
      await editor.click({ position: { x: 38, y: 24 } });
      await contextSurface.waitFor({ state: 'detached' });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await editor.press('Shift+F10');
      await editorMenu.getByRole('menuitem', { name: /全选/ }).click();
      await page.waitForFunction(() => document.activeElement.selectionStart === 0 &&
        document.activeElement.selectionEnd === '右键编辑测试'.length);
      // Verify the edit IPC and target selection without changing the system clipboard.
      await desktop.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        globalThis.fixtureNativePaste = contents.paste;
        contents.paste = () => { void contents.insertText('右键粘贴成功'); };
      });
      await editor.press('Shift+F10');
      const cut = editorMenu.getByRole('menuitem', { name: /剪切/ });
      assert.equal(await cut.getAttribute('aria-disabled'), null);
      await editorMenu.getByRole('menuitem', { name: /粘贴/ }).click();
      await page.waitForFunction(() => document.querySelector('textarea[aria-label=消息]').value === '右键粘贴成功');
      await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.paste = globalThis.fixtureNativePaste; });
      await editor.fill('');
    }
    if (legacyBaseline) {
      await page.getByRole('button', { name: '新建设计', exact: true }).click();
    } else {
      const modeTrigger = page.getByRole('button', { name: '模式', exact: true });
      await modeTrigger.click();
      const modeMenu = page.getByRole('dialog', { name: '模式', exact: true });
      await modeMenu.getByRole('button', { name: '设计', exact: true }).click();
      await modeTrigger.locator('[data-icon=canvas]').waitFor();
      await modeMenu.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '添加设计资料', exact: true }).click();
      const materials = page.getByRole('dialog', { name: '设计资料', exact: true });
      await materials.getByLabel('目标与使用者', { exact: true }).fill('让新玩家能快速找到蓝色购买入口');
      await materials.getByLabel('画板与关键状态', { exact: true }).fill('首页和购买确认');
      await materials.getByRole('checkbox', { name: '后续设计轮次附带简报', exact: true }).check();
      await materials.getByRole('textbox', { name: '设计系统', exact: true }).fill('购买入口用品牌青色');
      await materials.getByRole('checkbox', { name: '后续设计轮次应用设计系统', exact: true }).check();
      await materials.getByRole('textbox', { name: '文字参考', exact: true }).fill('只用于首轮的纸样参考');
      await materials.getByRole('checkbox', { name: '参考资料', exact: true }).check();
      await materials.getByRole('button', { name: '完成', exact: true }).click();
      await materials.waitFor({ state: 'hidden' });
    }
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('测试独立画布');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.frameLocator('iframe[title="设计原型预览"]')
      .getByRole('heading', { name: '独立海报画板', exact: true }).waitFor();
    const secondBoard = page.getByRole('group', { name: '画板', exact: true })
      .getByRole('button', { name: '画板 2', exact: true });
    await secondBoard.click();
    await page.frameLocator('iframe[title="设计原型预览"]')
      .getByRole('heading', { name: '第二张海报画板', exact: true }).waitFor();
    await page.getByRole('group', { name: '画板', exact: true }).getByRole('button', { name: '画板 1', exact: true }).click();
    await page.frameLocator('iframe[title="设计原型预览"]')
      .getByRole('heading', { name: '独立海报画板', exact: true }).waitFor();
    assert.equal(after[1].mode, 'design');
    assert.equal(after[1].advanced, undefined);
    if (!legacyBaseline) {
      assert.match(after[1].designContext.text, /设计工作方式 · 首稿/);
      assert.match(after[1].designContext.text, /风格倾向 · 平衡/);
      assert.match(after[1].designContext.text, /让新玩家能快速找到蓝色购买入口/);
      assert.match(after[1].designContext.text, /购买入口用品牌青色/);
      assert.match(after[1].designContext.text, /只用于首轮的纸样参考/);
    }
    const exportPath = join(directory, 'fixture-design.html');
    await desktop.evaluate(({ session }, path) => {
      globalThis.fixtureExport = new Promise((resolve) => {
        session.defaultSession.once('will-download', (_event, item) => {
          item.setSavePath(path);
          item.once('done', (_done, state) => resolve(state));
        });
      });
    }, exportPath);
    await page.getByRole('button', { name: legacyBaseline ? '导出' : '导出当前版本', exact: true }).click();
    await page.getByRole('menuitem', { name: '下载 HTML', exact: true }).click();
    assert.equal(await desktop.evaluate(() => globalThis.fixtureExport), 'completed');
    assert.match(await readFile(exportPath, 'utf8'), /独立海报画板/);
    if (!legacyBaseline) {
      await sidebar.getByRole('button', { name: '设计工作台', exact: true }).click();
      const playground = page.getByRole('region', { name: '设计工作台', exact: true });
      const scene = playground.getByRole('region', { name: '多画板画布', exact: true });
      const board1 = scene.getByRole('button', { name: '画板 1', exact: true });
      const board2 = scene.getByRole('button', { name: '画板 2', exact: true });
      const canvasMenu = page.getByRole('menu', { name: '画布操作', exact: true });
      const boardMenu = page.getByRole('menu', { name: '画板操作', exact: true });
      const batchMenu = page.getByRole('menu', { name: '所选画板操作', exact: true });
      const versionMenu = page.getByRole('menu', { name: '版本操作', exact: true });
      await board1.waitFor();
      await board2.waitFor();
      await playground.getByRole('button', { name: '设计风格 · 平衡', exact: true }).click();
      const styleDial = playground.getByRole('dialog', { name: '设计风格', exact: true });
      const slider = styleDial.getByRole('slider', { name: '风格倾向', exact: true });
      await slider.press('End');
      assert.equal(await slider.getAttribute('aria-valuetext'), '发散');
      await page.keyboard.press('Escape');
      await styleDial.waitFor({ state: 'hidden' });
      const dock = playground.getByRole('group', { name: '画布对话', exact: true });
      const messages = dock.getByRole('region', { name: '对话消息', exact: true });
      const historyToggle = dock.getByRole('button', { name: '对话历史', exact: true });
      assert.equal(await page.locator('.vc-main-body > .vc-conversation, .vc-main-body > .vc-splitter').count(), 0);
      assert.equal(await historyToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await messages.isVisible(), false);
      async function verifyFloatingDock() {
        const geometry = await scene.evaluate((element) => {
          const viewport = element.getBoundingClientRect();
          const body = element.closest('.vc-main-body').getBoundingClientRect();
          const composer = element.parentElement.querySelector('.vc-canvas-conversation .vc-composer').getBoundingClientRect();
          const tools = element.closest('.vc-playground').querySelector('.vc-playground-controls').getBoundingClientRect();
          const fits = Math.abs(body.left - viewport.left) <= 1 && Math.abs(body.right - viewport.right) <= 1 &&
            composer.top >= viewport.top && composer.bottom < viewport.bottom && composer.left > viewport.left &&
            composer.right < viewport.right && composer.bottom < tools.top && tools.bottom <= innerHeight;
          return { fits, width: innerWidth, height: innerHeight,
            viewport: viewport.toJSON(), body: body.toJSON(), composer: composer.toJSON(), tools: tools.toJSON() };
        });
        assert.ok(geometry.fits, `The floating composer fits inside the canvas ${JSON.stringify(geometry)}`);
      }
      await verifyFloatingDock();
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(365, 640));
      await page.waitForFunction(() => innerWidth <= 400);
      await playground.and(page.locator('.vc-canvas[data-compact="true"]')).waitFor();
      await verifyFloatingDock();
      const topologyToggle = playground.getByRole('button', { name: '版本拓扑', exact: true });
      assert.equal(await topologyToggle.getAttribute('aria-expanded'), 'false');
      const narrowCanvas = await scene.boundingBox();
      await scene.press('Shift+F10');
      assert.ok(await canvasMenu.evaluate((menu) => {
        const bounds = menu.getBoundingClientRect();
        return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
      }));
      await canvasMenu.getByRole('menuitem', { name: '显示版本拓扑', exact: true }).click();
      await playground.getByRole('region', { name: '版本拓扑', exact: true }).waitFor();
      assert.deepEqual(await scene.boundingBox(), narrowCanvas);
      await topologyToggle.click();
      await playground.getByRole('region', { name: '版本拓扑', exact: true }).waitFor({ state: 'hidden' });
      await historyToggle.click();
      await messages.waitFor();
      await verifyFloatingDock();
      await historyToggle.click();
      await messages.waitFor({ state: 'hidden' });
      await modelTrigger.click();
      await modelPanel.waitFor();
      assert.ok(await modelPanel.evaluate((panel) => panel.getBoundingClientRect().height > 60 &&
        panel.getBoundingClientRect().left >= 0 && panel.getBoundingClientRect().right <= innerWidth));
      await modelPanel.getByRole('button', { name: '关闭', exact: true }).click();
      await modelPanel.waitFor({ state: 'hidden' });
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(365, 480));
      await page.waitForFunction(() => innerHeight <= 500);
      await verifyFloatingDock();
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 850));
      await page.waitForFunction(() => innerWidth > 960);
      await verifyFloatingDock();
      if (await topologyToggle.getAttribute('aria-expanded') === 'false') await topologyToggle.click();
      const value = playground.locator('output[aria-label="当前缩放比例"]');
      await historyToggle.click();
      await messages.getByText('测试独立画布', { exact: true }).waitFor();
      const historyZoom = await value.textContent();
      await messages.hover();
      await page.mouse.wheel(0, 180);
      assert.equal(await value.textContent(), historyZoom);
      await messages.focus();
      await page.keyboard.press('F6');
      assert.equal(await editor.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Escape');
      await messages.waitFor({ state: 'hidden' });
      assert.equal(await historyToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await historyToggle.evaluate((element) => element === document.activeElement), true);
      await playground.getByRole('button', { name: '适应全部画板', exact: true }).click();
      const initialZoom = await value.textContent();
      await scene.click({ button: 'right', position: { x: 8, y: 8 } });
      await canvasMenu.getByRole('menuitem', { name: '放大画布', exact: true }).click();
      await value.filter({ hasNotText: initialZoom }).waitFor();
      await playground.getByRole('button', { name: '适应全部画板', exact: true }).click();
      await value.filter({ hasText: initialZoom }).waitFor();
      await board1.hover();
      const point = await board1.boundingBox();
      const firstBoardId = await board1.locator('..').getAttribute('data-board-id');
      const secondBoardId = await board2.locator('..').getAttribute('data-board-id');
      await scene.evaluate((element) => {
        globalThis.fixtureCanvasPointers = [];
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) {
          element.addEventListener(type, (event) => globalThis.fixtureCanvasPointers.push(
            [event.type, event.pointerId, event.clientX, event.clientY, event.target.className]), { once: true, capture: true });
        }
      });
      await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
      await page.mouse.down();
      await page.mouse.move(point.x + point.width / 2 + 24, point.y + point.height / 2 + 42, { steps: 4 });
      await scene.locator(`[data-board-id="${firstBoardId}"][data-moving="true"]`).waitFor({ state: 'attached' });
      await page.mouse.up();
      const designRecordKey = `dsh-vps-design:v1:${targetId}:${after[1].sessionId}`;
      function readPlayground() {
        return readPreferences().then((stored) => JSON.parse(stored[designRecordKey] ?? '{}').playground);
      }
      let placement;
      for (let retry = 0; retry < 50 && !placement; retry++) {
        placement = (await readPlayground())?.positions[firstBoardId];
        if (!placement) await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const evidence = placement ? { placement } : {
        point, id: firstBoardId, updated: await board1.boundingBox(), record: await readPlayground(),
        pointer: await page.evaluate(() => globalThis.fixtureCanvasPointers),
        moving: await board1.locator('..').getAttribute('data-moving'),
        recordKey: designRecordKey,
        savedPositions: Object.entries(await readPreferences())
          .filter(([key]) => key.startsWith('dsh-vps-design:v1:'))
          .map(([key, value]) => [key, JSON.parse(value).playground?.positions]),
        status: await page.getByRole('status').allTextContents(),
      };
      assert.ok(placement?.x > 0 && placement?.y > 0, `pointer drag commits a scoped local board position ${JSON.stringify(evidence)}`);
      const contextSurfaces = page.locator('.vc-context-menu');
      await contextSurfaces.waitFor({ state: 'detached' });
      await page.evaluate(() => { globalThis.fixtureMenuFades = globalThis.fixtureMenuFades.filter(({ name }) => name !== 'context'); });
      await board2.press('Shift+F10');
      assert.equal(await boardMenu.getByRole('menuitem', { name: '编辑画板', exact: true })
        .evaluate((button) => button === document.activeElement), true);
      await page.waitForFunction(() => globalThis.fixtureMenuFades.some(({ name, opening }) => name === 'context' && opening));
      await scene.click({ position: { x: 8, y: 8 } });
      await contextSurfaces.waitFor({ state: 'detached' });
      assert.ok(await page.evaluate(() => globalThis.fixtureMenuFades.some(({ name, opening, duration, inert }) =>
        name === 'context' && !opening && duration === '0.18s' && inert)));
      await board2.press('Shift+F10');
      await page.keyboard.press('Escape');
      assert.equal(await board2.evaluate((button) => button === document.activeElement), true);

      // An unselected thumbnail targets its own board without sending a prompt.
      const rightClickBoard2 = () => board2.locator('..').click({ button: 'right', position: { x: 24, y: 54 } });
      await board1.click();
      assert.equal(await board1.getAttribute('aria-pressed'), 'true');
      await desktop.evaluate(({ clipboard }) => {
        globalThis.fixtureOriginalClipboardWrite = clipboard.writeText;
        clipboard.writeText = (text) => { globalThis.fixtureCopiedBoard = text; };
      });
      try {
        await rightClickBoard2();
        await boardMenu.getByRole('menuitem', { name: '复制画板 HTML', exact: true }).click();
        await page.getByText('已复制画板 HTML', { exact: true }).waitFor();
        const copiedBoard = await desktop.evaluate(() => globalThis.fixtureCopiedBoard);
        assert.match(copiedBoard, /第二张海报画板/);
        assert.doesNotMatch(copiedBoard, /独立海报画板/);
      } finally {
        await desktop.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.fixtureOriginalClipboardWrite; });
      }
      const boardExportPath = join(directory, 'fixture-board-2.html');
      await desktop.evaluate(({ session }, path) => {
        globalThis.fixtureBoardExport = new Promise((resolve) => {
          session.defaultSession.once('will-download', (_event, item) => {
            item.setSavePath(path);
            item.once('done', (_done, state) => resolve(state));
          });
        });
      }, boardExportPath);
      await rightClickBoard2();
      await boardMenu.getByRole('menuitem', { name: '下载此画板 HTML', exact: true }).click();
      assert.equal(await desktop.evaluate(() => globalThis.fixtureBoardExport), 'completed');
      const exportedBoard = await readFile(boardExportPath, 'utf8');
      assert.match(exportedBoard, /第二张海报画板/);
      assert.doesNotMatch(exportedBoard, /独立海报画板/);
      assert.equal(after.length, 2);

      await rightClickBoard2();
      await boardMenu.getByRole('menuitem', { name: '连接画板', exact: true }).click();
      const connector = page.getByRole('dialog', { name: '连接画板', exact: true });
      await connector.getByLabel('目标画板', { exact: true }).selectOption(firstBoardId);
      await connector.getByRole('button', { name: '保存连接', exact: true }).click();
      await connector.waitFor({ state: 'hidden' });
      await scene.locator(`[data-board-link-from="${secondBoardId}"][data-board-link-to="${firstBoardId}"]`)
        .waitFor({ state: 'attached' });
      await rightClickBoard2();
      await boardMenu.getByRole('menuitem', { name: '播放原型', exact: true }).click();
      const player = page.getByRole('dialog', { name: '原型播放', exact: true });
      const screen = player.frameLocator('iframe[title="交互原型预览"]');
      await screen.getByText('第二张海报画板', { exact: true }).click();
      await screen.getByRole('heading', { name: '独立海报画板', exact: true }).waitFor();
      await player.getByRole('button', { name: '返回上一画板', exact: true }).click();
      await screen.getByText('第二张海报画板', { exact: true }).waitFor();
      await player.getByRole('button', { name: '关闭原型', exact: true }).click();
      await player.waitFor({ state: 'hidden' });
      assert.ok((await readPlayground()).links.some(({ from, to }) => from === secondBoardId && to === firstBoardId));
      await board1.click();
      await playground.getByRole('button', { name: '迭代所选', exact: true }).click();
      await page.locator('.vc-context-attachment').filter({ hasText: '迭代 · 画板 1' }).waitFor();
      await playground.getByRole('button', { name: '移除画板附件', exact: true }).click();
      await page.locator('.vc-context-attachment').filter({ hasText: '迭代 · 画板 1' }).waitFor({ state: 'hidden' });
      await board1.click({ button: 'right' });
      await boardMenu.getByRole('menuitem', { name: '生成变体', exact: true }).click();
      await page.locator('.vc-context-attachment').filter({ hasText: '变体 · 画板 1' }).waitFor();
      assert.match(await editor.inputValue(), /生成两种设计变体/);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const provisional = scene.locator('.vc-playground-card[data-provisional="true"]').filter({ hasText: '青色变体' });
      await provisional.waitFor({ state: 'attached' });
      await provisional.getByRole('button').press('Shift+F10');
      assert.equal(await boardMenu.getByRole('menuitem', { name: '生成变体', exact: true }).getAttribute('aria-disabled'), 'true');
      assert.equal(await boardMenu.getByRole('menuitem', { name: '下载此画板 HTML', exact: true }).getAttribute('aria-disabled'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(after[2].sessionId, after[1].sessionId);
      assert.equal(after[2].settings.provider, 'codex');
      assert.match(after[2].designContext.text, /设计工作方式 · 方案变体/);
      assert.match(after[2].designContext.text, /风格倾向 · 发散/);
      assert.match(after[2].designContext.text, /让新玩家能快速找到蓝色购买入口/);
      assert.match(after[2].designContext.text, /购买入口用品牌青色/);
      assert.doesNotMatch(after[2].designContext.text, /只用于首轮的纸样参考/);
      assert.match(after[2].designContext.text, /独立海报画板/);
      assert.doesNotMatch(after[2].designContext.text, /第二张海报画板/);
      assert.equal(await dock.getByRole('button', { name: '停止生成', exact: true }).isEnabled(), true);
      await editor.fill('补充，保留活动入口。');
      await dock.getByRole('button', { name: '发送补充', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.vc-canvas-conversation textarea').value);
      assert.equal(designSupplements.length, 1);
      assert.equal(designSupplements[0].turnId, after[2].turnId);
      finishVariant = true;
      await scene.locator('.vc-playground-card[data-provisional="false"]').filter({ hasText: '青色变体' })
        .waitFor({ state: 'attached' });
      assert.equal(await scene.locator('[data-board-id]').count(), 3);

      const variant = scene.getByRole('button', { name: '青色变体', exact: true });
      const count = playground.getByLabel('已选画板', { exact: true });
      const cards = [board1, board2, variant].map((button) => button.locator('..'));
      const cardBounds = () => Promise.all(cards.map((card) => card.boundingBox()));
      const fit = playground.getByRole('button', { name: '适应全部画板', exact: true });
      await fit.click();
      const [first, second] = await cardBounds();
      const start = { x: Math.min(first.x, second.x) - 8, y: Math.min(first.y, second.y) - 8 };
      const end = { x: Math.max(first.x + first.width, second.x + second.width) + 8, y: Math.max(first.y, second.y) + 28 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 6 });
      await scene.locator('.vc-playground-marquee').waitFor();
      await scene.locator('.vc-playground-card[data-selected=true]').nth(1).waitFor();
      await page.mouse.up();
      await count.filter({ hasText: '已选 2 张画板' }).waitFor();
      assert.equal(await board1.getAttribute('aria-pressed'), 'true');
      assert.equal(await board2.getAttribute('aria-pressed'), 'true');
      assert.equal(await variant.getAttribute('aria-pressed'), 'false');

      await board2.click({ modifiers: ['Control'] });
      assert.equal(await board2.getAttribute('aria-pressed'), 'false');
      await board2.press('Shift+Enter');
      await count.filter({ hasText: '已选 2 张画板' }).waitFor();
      await scene.press('Control+a');
      await count.filter({ hasText: '已选 3 张画板' }).waitFor();
      await variant.click({ modifiers: ['Shift'] });
      await count.filter({ hasText: '已选 2 张画板' }).waitFor();

      await scene.focus();
      const panOrigin = (await cards[0].boundingBox()).x;
      await page.keyboard.down('Space');
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 18, start.y + 14, { steps: 4 });
      await scene.and(page.locator('[data-dragging=true]')).waitFor();
      await page.mouse.up();
      await page.keyboard.up('Space');
      assert.ok((await cards[0].boundingBox()).x >= panOrigin + 17);
      await count.filter({ hasText: '已选 2 张画板' }).waitFor();
      await fit.click();

      const beforeGroup = await cardBounds();
      const grip = await board2.boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 + 22, grip.y + grip.height / 2 + 30, { steps: 4 });
      await scene.locator('.vc-playground-card[data-moving=true]').nth(1).waitFor();
      assert.equal(await cards[2].getAttribute('data-moving'), 'false');
      await page.mouse.up();
      const afterGroup = await cardBounds();
      const dx = afterGroup[0].x - beforeGroup[0].x;
      const dy = afterGroup[0].y - beforeGroup[0].y;
      assert.ok(dx > 15 && dy > 23);
      assert.ok(Math.abs(afterGroup[1].x - beforeGroup[1].x - dx) < 1);
      assert.ok(Math.abs(afterGroup[1].y - beforeGroup[1].y - dy) < 1);
      assert.deepEqual(afterGroup[2], beforeGroup[2]);
      let savedGroup;
      for (let retry = 0; retry < 50 && !savedGroup?.positions[secondBoardId]; retry++) {
        savedGroup = await readPlayground();
        if (!savedGroup?.positions[secondBoardId]) await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.ok(savedGroup.positions[firstBoardId].x > placement.x);
      assert.ok(savedGroup.positions[secondBoardId].y > 0);
      assert.equal(savedGroup.positions[await cards[2].getAttribute('data-board-id')], undefined);

      await variant.click({ button: 'right' });
      await boardMenu.getByRole('menuitem', { name: '下载此画板 HTML', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await desktop.evaluate(({ clipboard }) => {
        globalThis.fixtureOriginalClipboardWrite = clipboard.writeText;
        clipboard.writeText = (text) => { globalThis.fixtureCopiedSelection = text; };
      });
      try {
        await board1.press('Shift+F10');
        await batchMenu.getByRole('menuitem', { name: '复制所选画板 HTML', exact: true }).click();
        await page.getByText('已复制 2 张画板的 HTML', { exact: true }).waitFor();
        const copied = await desktop.evaluate(() => globalThis.fixtureCopiedSelection);
        assert.match(copied, /独立海报画板[\s\S]+第二张海报画板/);
        assert.match(copied, /data-dsh-go=&quot;1&quot;/);
        assert.doesNotMatch(copied, /青色变体/);
      } finally {
        await desktop.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.fixtureOriginalClipboardWrite; });
      }
      const selectionArchive = join(directory, 'fixture-selection.zip');
      await desktop.evaluate(({ session }, path) => {
        globalThis.fixtureSelectionExport = new Promise((resolve) => {
          session.defaultSession.once('will-download', (_event, item) => {
            item.setSavePath(path);
            item.once('done', (_done, state) => resolve(state));
          });
        });
      }, selectionArchive);
      await rightClickBoard2();
      await batchMenu.getByRole('menuitem', { name: '导出所选画板为 ZIP', exact: true }).click();
      assert.equal(await desktop.evaluate(() => globalThis.fixtureSelectionExport), 'completed');
      const archive = await readFile(selectionArchive, 'utf8');
      assert.match(archive, /artboards\/01\.html/);
      assert.match(archive, /artboards\/02\.html/);
      assert.doesNotMatch(archive, /artboards\/03\.html|青色变体/);
      assert.equal(after.length, 3);
      const topology = playground.getByRole('region', { name: '版本拓扑', exact: true });
      const revision = (turn) => topology.locator(`[data-version-id="${turn.turnId}"]`);
      assert.equal(await revision(after[2]).getAttribute('data-parent-id'), after[1].turnId);
      await revision(after[2]).press('Shift+F10');
      await versionMenu.getByRole('menuitem', { name: '查看父版本', exact: true }).click();
      await revision(after[1]).and(page.locator('[aria-pressed=true]')).waitFor();
      await revision(after[2]).click();
      await revision(after[1]).click({ button: 'right' });
      await versionMenu.getByRole('menuitem', { name: '从此版本 Fork', exact: true }).click();
      await topology.locator('[data-status=draft][aria-pressed=true]').waitFor({ state: 'attached' });
      assert.equal(after.length, 3);
      await topology.getByRole('button', { name: '取消分支草稿', exact: true }).click();
      await topology.locator('[data-status=draft]').waitFor({ state: 'detached' });
      await revision(after[1]).click({ button: 'right' });
      await versionMenu.getByRole('menuitem', { name: '从此版本 Fork', exact: true }).click();
      await page.locator('.vc-context-attachment').filter({ hasText: 'Fork · 版本 1' }).waitFor();
      await editor.fill('把最初版改成红色。');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await scene.getByRole('button', { name: '红色分支', exact: true }).waitFor();
      assert.deepEqual(after[3].designBase, { parentTurnId: after[1].turnId, fork: true });
      assert.equal(after[3].sessionId, after[1].sessionId);
      assert.match(after[3].designContext.text, /独立海报画板/);
      assert.match(after[3].designContext.text, /第二张海报画板/);
      assert.doesNotMatch(after[3].designContext.text, /青色变体/);
      assert.equal(await revision(after[3]).getAttribute('data-parent-id'), after[1].turnId);
      assert.equal(await revision(after[3]).getAttribute('data-fork'), 'true');
      await revision(after[2]).click({ button: 'right' });
      await versionMenu.getByRole('menuitem', { name: '继续此分支', exact: true }).click();
      await page.locator('.vc-context-attachment').filter({ hasText: '继续 · 版本 2' }).waitFor();
      await editor.fill('继续青色方向。');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await scene.getByRole('button', { name: '青色后续', exact: true }).waitFor();
      assert.deepEqual(after[4].designBase, { parentTurnId: after[2].turnId, fork: false });
      assert.equal(await revision(after[4]).getAttribute('data-parent-id'), after[2].turnId);
      await revision(after[4]).click({ button: 'right' });
      await versionMenu.getByRole('menuitem', { name: '对比来源版本', exact: true }).click();
      const comparison = page.getByRole('dialog', { name: '对比来源版本', exact: true });
      await comparison.frameLocator('iframe[title="来源画板预览"]')
        .getByRole('heading', { name: '青色变体', exact: true }).waitFor();
      await comparison.frameLocator('iframe[title="当前画板预览"]')
        .getByRole('heading', { name: '青色后续', exact: true }).waitFor();
      await comparison.getByRole('button', { name: '完成', exact: true }).click();
      await comparison.waitFor({ state: 'hidden' });
      await revision(after[1]).click();
      await editor.fill('切换画布时保留这段草稿。');
      await playground.getByRole('button', { name: '单画板', exact: true }).click();
      const singleBoard = page.frameLocator('iframe[title="设计原型预览"]')
        .getByRole('heading', { name: '独立海报画板', exact: true });
      await singleBoard.click({ button: 'right', position: { x: 14, y: 12 } });
      await boardMenu.getByRole('menuitem', { name: '下载此画板 HTML', exact: true }).waitFor();
      await singleBoard.click({ position: { x: 4, y: 2 } });
      await contextSurfaces.waitFor({ state: 'detached' });
      await singleBoard.click({ button: 'right' });
      await boardMenu.getByRole('menuitem', { name: '批注此图层', exact: true }).click();
      await playground.getByRole('button', { name: '编辑画布', exact: true })
        .and(page.locator('[aria-pressed=true]')).waitFor();
      const note = playground.getByRole('textbox', { name: '添加批注', exact: true });
      assert.equal(await note.evaluate((element) => document.activeElement === element), true);
      await note.fill('提高所选元素的对比度');
      await playground.getByRole('button', { name: '保存批注', exact: true }).click();
      await playground.getByRole('button', { name: '用第 1 条批注迭代', exact: true }).click();
      await page.locator('.vc-context-attachment').filter({ hasText: '仅修改图层 · 独立海报画板' }).waitFor();
      assert.equal(after.length, 5);
      await dock.getByRole('button', { name: '清除版本来源', exact: true }).click();
      assert.equal(await dock.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '切换画布时保留这段草稿。');
      await page.getByRole('button', { name: '返回设计对话', exact: true }).click();
      await page.locator('.vc-main-body > .vc-conversation textarea').waitFor();
      assert.equal(await editor.inputValue(), '切换画布时保留这段草稿。');
      await sidebar.getByRole('button', { name: '设计工作台', exact: true }).click();
      await playground.getByRole('button', { name: '单画板', exact: true }).click();
      await playground.getByRole('combobox', { name: '设计版本', exact: true }).selectOption('');
      await editor.fill('验收不含内容的候选稿');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByText('本轮回复已完成，暂无可显示的新画板。可在对话历史查看回复。', { exact: true }).waitFor();
      await page.frameLocator('iframe[title="设计原型预览"]')
        .getByRole('heading', { name: '青色后续', exact: true }).waitFor();
      await page.getByRole('button', { name: '返回设计对话', exact: true }).click();

      await page.getByRole('combobox', { name: '归入本地项目', exact: true }).selectOption(localState.projects()[0].workspaceId);
      const folder = sidebar.getByRole('group', { name: '测试美术项目', exact: true });
      await folder.getByRole('button', { name: '测试独立画布，设计会话', exact: true }).waitFor();
      const folderTrigger = sidebar.getByRole('button', { name: '测试美术项目', exact: true });
      await folderTrigger.click();
      await folder.waitFor({ state: 'hidden' });
      await folderTrigger.click();
      await folder.waitFor();
      await sidebar.getByRole('button', { name: '项目资源库', exact: true }).click();
      const library = page.getByRole('dialog', { name: '项目资源库', exact: true });
      await library.getByRole('button', { name: /^画板 2/ }).click();
      await library.frameLocator('iframe[title="画板 2"]').getByRole('heading', { name: '第二张海报画板', exact: true }).waitFor();
      await library.getByRole('button', { name: '打开来源会话', exact: true }).click();
      await library.waitFor({ state: 'hidden' });
      await page.frameLocator('iframe[title="设计原型预览"]')
        .getByRole('heading', { name: '第二张海报画板', exact: true }).waitFor();

      await sidebar.getByRole('button', { name: '设计工作台', exact: true }).click();
      await playground.getByRole('button', { name: '单画板', exact: true }).click();
      const designFrame = page.frameLocator('iframe[title="设计原型预览"]');
      async function sendLayerRevision(heading, prompt) {
        await designFrame.getByRole('heading', { name: heading, exact: true }).click({ button: 'right' });
        await boardMenu.getByRole('menuitem', { name: '迭代此图层', exact: true }).click();
        await page.locator('.vc-context-attachment').filter({ hasText: `仅修改图层 · ${heading}` }).waitFor();
        await editor.fill(prompt);
        await page.getByRole('button', { name: '发送', exact: true }).click();
      }
      await sendLayerRevision('第二张海报画板', '把标题改成只更新第二张标题，圆角设为 12。');
      const newHeading = designFrame.getByRole('heading', { name: '只更新第二张标题', exact: true });
      await newHeading.waitFor();
      assert.equal(await newHeading.evaluate((element) => getComputedStyle(element).borderRadius), '12px');
      assert.equal(await designFrame.getByRole('heading', { name: '本段草稿只用于传递属性' }).count(), 0);
      const acceptedTurn = after.at(-1);
      assert.equal(acceptedTurn.designBase.parentTurnId, after[1].turnId);
      assert.match(acceptedTurn.designContext.text, /dsh-layer-revision/);
      const scopeKey = `dsh-vps-design:v1:${targetId}:${acceptedTurn.sessionId}:revision:${acceptedTurn.turnId}`;
      const baseline = JSON.parse((await readPreferences())[scopeKey]);
      assert.equal(baseline.index, 2);
      assert.equal(baseline.sources.length, 2);
      assert.match(baseline.sources[1], /第二张海报画板/);
      await page.getByRole('button', { name: '画板 1', exact: true }).click();
      await designFrame.getByRole('heading', { name: '独立海报画板', exact: true }).waitFor();
      await page.getByRole('button', { name: '画板 2', exact: true }).click();
      await newHeading.waitFor();
      await sendLayerRevision('只更新第二张标题', '测试越界删除');
      await page.getByText('模型返回了未开放的属性或超出范围的值。请缩小修改范围后重试。', { exact: true }).first().waitFor();
      assert.equal(after.at(-1).designBase.parentTurnId, acceptedTurn.turnId);
      assert.equal(await newHeading.count(), 1);
      const sendsBeforeRetry = after.length;
      await page.getByRole('button', { name: '按校验反馈重试', exact: true }).click();
      await page.locator('.vc-context-attachment').filter({ hasText: '仅修改图层 · 只更新第二张标题' }).waitFor();
      assert.equal(await editor.inputValue(), '测试越界删除');
      assert.equal(after.length, sendsBeforeRetry);
      await page.getByRole('button', { name: '清除版本来源', exact: true }).click();
      await editor.fill('');
      await page.getByRole('button', { name: '返回设计对话', exact: true }).click();
      t.diagnostic('Scoped layer revision preserved both artboards, saved the frozen baseline, and rejected an out-of-scope edit.');

      const memoryTrigger = page.getByRole('button', { name: '会话记忆', exact: true });
      await memoryTrigger.click();
      const memoryPanel = page.getByRole('dialog', { name: '会话记忆', exact: true });
      await memoryPanel.getByRole('button', { name: '独立上下文', exact: true }).click();
      await memoryTrigger.filter({ hasText: '独立上下文' }).waitFor();
      await page.getByText('已新建独立会话，原聊天仍可续聊。', { exact: true }).waitFor();
      await folder.getByRole('button', { name: '测试独立画布，设计会话', exact: true }).waitFor();

      const sessionMenu = page.getByRole('menu', { name: '会话操作' });
      const chat = sidebar.getByRole('button', { name: '测试独立会话', exact: true });
      await chat.press('Shift+F10');
      assert.equal(await sessionMenu.getByRole('menuitem', { name: '置顶会话', exact: true })
        .evaluate((item) => item === document.activeElement), true);
      await page.keyboard.press('Escape');
      await sessionMenu.waitFor({ state: 'hidden' });
      assert.equal(await chat.evaluate((row) => row === document.activeElement), true);

      const moveMemory = page.getByRole('dialog', { name: '移动会话并选择记忆', exact: true });
      await chat.dragTo(folderTrigger);
      await folder.getByRole('button', { name: '测试独立会话', exact: true }).waitFor();
      assert.equal(await moveMemory.count(), 0);
      assert.equal(await chat.getAttribute('aria-current'), null);

      await projectsMenu.click();
      await page.getByRole('menuitem', { name: '添加目录…', exact: true }).click();
      await addedProject.waitFor();
      const projectMenu = page.getByRole('menu', { name: '项目操作' });
      const pinnedProjects = sidebar.getByRole('region', { name: '置顶项目', exact: true });
      await addedProject.click({ button: 'right' });
      await projectMenu.getByRole('menuitem', { name: '置顶项目', exact: true }).click();
      const pinnedFolder = pinnedProjects.getByRole('button', { name: '测试目录选择', exact: true });
      await pinnedFolder.waitFor();
      pinnedProjectId = await pinnedFolder.getAttribute('data-project-id');

      await chat.click({ button: 'right' });
      await sessionMenu.getByRole('menuitem', { name: '移动到项目…', exact: true }).click();
      const moveDialog = page.getByRole('dialog', { name: '移动到项目', exact: true });
      await moveDialog.getByRole('combobox').selectOption(pinnedProjectId);
      await moveDialog.getByRole('button', { name: '移动', exact: true }).click();
      await moveMemory.getByRole('button', { name: '取消', exact: true }).click();
      await moveMemory.waitFor({ state: 'hidden' });
      await folder.getByRole('button', { name: '测试独立会话', exact: true }).waitFor();

      await chat.dragTo(pinnedFolder);
      await moveMemory.getByRole('button', { name: '仅移动', exact: true }).click();
      await moveMemory.waitFor({ state: 'hidden' });
      const moved = pinnedProjects.getByRole('group', { name: '测试目录选择', exact: true })
        .getByRole('button', { name: '测试独立会话', exact: true });
      await moved.click();
      await memoryTrigger.filter({ hasText: '项目记忆关闭' }).waitFor();
      assert.deepEqual(JSON.parse((await readPreferences())[`dsh-vps-chat-projects:v1:${targetId}`])[after[0].sessionId],
        { projectId: pinnedProjectId, memory: 'isolated' });

      await chat.press('Shift+F10');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const renameDialog = page.getByRole('dialog', { name: '重命名会话', exact: true });
      await renameDialog.getByRole('textbox').fill('右键重命名后的会话');
      await renameDialog.getByRole('button', { name: '保存', exact: true }).click();
      const renamed = sidebar.getByRole('button', { name: '右键重命名后的会话', exact: true });
      await renamed.click({ button: 'right' });
      await sessionMenu.getByRole('menuitem', { name: '置顶会话', exact: true }).click();
      const pinned = sidebar.getByRole('region', { name: '置顶会话', exact: true });
      const pinnedChat = pinned.getByRole('button', { name: '右键重命名后的会话', exact: true });
      await pinnedChat.waitFor();
      await pinnedChat.dragTo(folderTrigger);
      await moveMemory.getByRole('button', { name: '移入并继承记忆', exact: true }).click();
      await moveMemory.waitFor({ state: 'hidden' });
      await page.getByRole('combobox', { name: '归入本地项目', exact: true })
        .locator('option:checked').filter({ hasText: '测试美术项目' }).waitFor({ state: 'attached' });
      assert.equal(await memoryTrigger.filter({ hasText: '项目记忆关闭' }).count(), 0);

      await renamed.click({ button: 'right' });
      await sessionMenu.getByRole('menuitem', { name: '归档会话', exact: true }).click();
      await pinned.waitFor({ state: 'hidden' });
      await sidebar.getByRole('button', { name: '已归档', exact: true }).click();
      const archived = sidebar.getByRole('group', { name: '已归档会话', exact: true });
      const archivedChat = archived.getByRole('button', { name: '右键重命名后的会话', exact: true });
      await archivedChat.evaluate((row) =>
        Promise.allSettled(row.closest('.vc-disclosure-motion').getAnimations().map((animation) => animation.finished)));
      await archivedChat.click({ button: 'right' });
      await sessionMenu.getByRole('menuitem', { name: '恢复会话', exact: true }).click();
      await pinned.getByRole('button', { name: '右键重命名后的会话', exact: true }).waitFor();
      await renamed.click();
      await page.locator('.vc-heading-title').getByText('右键重命名后的会话', { exact: true }).waitFor();
      await page.getByRole('heading', { name: '独立对话测试已返回', exact: true }).waitFor();
    }
    await page.getByRole('button', { name: legacyBaseline ? 'VPS 设置' : '设置', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: legacyBaseline ? 'VPS 设置' : '设置', exact: true });
    await openSettingsSection(dialog, '账号', legacyBaseline);
    await dialog.getByRole('button', { name: 'Claude 账号', exact: true }).waitFor();
    await openSettingsSection(dialog, '外观', legacyBaseline);
    if (!legacyBaseline) {
      const accent = dialog.locator('.vc-settings-disclosure > summary').filter({ hasText: '强调色' });
      assert.ok(await accent.evaluate((summary) => {
        const details = summary.parentElement;
        const before = getComputedStyle(details, '::details-content').opacity;
        summary.click();
        return before === '0' && details.open && Number(getComputedStyle(details, '::details-content').opacity) < 1;
      }));
      await page.waitForFunction(() => {
        const details = document.querySelector('.vc-settings-disclosure[open]');
        return details && getComputedStyle(details, '::details-content').opacity === '1';
      });
      assert.ok(await accent.evaluate((summary) => {
        const details = summary.parentElement;
        summary.click();
        const style = getComputedStyle(details, '::details-content');
        return !details.open && Number(style.opacity) > 0 && style.transitionDuration.split(',')[0] === '0.18s';
      }));
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.vc-settings-disclosure'), '::details-content').opacity === '0');
      const fades = await page.evaluate(() => globalThis.fixtureMenuFades);
      for (const name of ['title', 'tool', 'access', 'mode', 'export', 'folder', 'resources']) {
        assert.ok(fades.some((record) => record.name === name && record.opening && record.duration === '0.18s'), name);
        assert.ok(fades.some((record) => record.name === name && !record.opening && record.duration === '0.18s'), name);
      }
      await openSettingsSection(dialog, '交互', legacyBaseline);
      await dialog.getByRole('button', { name: '减少动画', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('root').dataset.chromeMotion === 'reduce');
      assert.deepEqual(await page.evaluate(() => ['.desktop-title-menu', '.vc-tool-palette', '.vc-workbench-settings']
        .map((selector) => getComputedStyle(document.querySelector(selector)).transitionDuration.split(',')[0])),
      ['0s', '0s', '0s']);
      await dialog.getByRole('group', { name: '动画' }).getByRole('button', { name: '跟随系统', exact: true }).click();
      await openSettingsSection(dialog, '外观', legacyBaseline);
    }
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const setOverlay = window.setTitleBarOverlay.bind(window);
      globalThis.fixtureOverlays = [];
      window.setTitleBarOverlay = (overlay) => { globalThis.fixtureOverlays.push(overlay); setOverlay(overlay); };
      if (window.setAccentColor) {
        const setAccent = window.setAccentColor.bind(window);
        globalThis.fixtureBorders = [];
        window.setAccentColor = (color) => { globalThis.fixtureBorders.push(color); setAccent(color); };
      }
    });
    async function checkWindowColors(settle = true) {
      if (settle) await page.locator('#root[data-appearance-transition]').waitFor({ state: 'detached' });
      const expected = await page.evaluate(async () => {
        const root = document.getElementById('root');
        const application = getComputedStyle(root);
        const shade = (name) => application.getPropertyValue('--desktop-' + name).trim();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        function background(element) {
          if (!element) return null;
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
          return '#' + rgb.map((value) => value.toString(16).padStart(2, '0')).join('');
        }
        const workbench = root.querySelector('[data-vps-chat]');
        const frame = {
          color: shade('chrome'), symbolColor: shade('ink'), borderColor: shade('frame'), accent: shade('accent'),
          header: background(root.querySelector('.desktop-titlebar')),
          canvas: background(workbench),
          settings: background(workbench.querySelector('.vc-workbench-settings[open]')),
        };
        await window.vpsWorkbench.bootstrap();
        return frame;
      });
      assert.equal(expected.header, expected.color);
      const observed = await desktop.evaluate(({ BrowserWindow }) => ({
        overlay: globalThis.fixtureOverlays.at(-1),
        borderColor: BrowserWindow.getAllWindows()[0].getAccentColor(),
      }));
      assert.equal(String(observed.borderColor).toLowerCase(), expected.borderColor);
      assert.deepEqual(observed.overlay, { color: expected.color, symbolColor: expected.symbolColor, height: 44 });
      return expected;
    }
    async function sampleAppearance(action) {
      await page.evaluate(() => {
        const root = document.getElementById('root');
        const observer = new MutationObserver(() => {
          const animation = document.getAnimations().find((item) => item.id === 'workbench-appearance');
          if (!animation) return;
          observer.disconnect();
          animation.pause();
        });
        observer.observe(root, { attributeFilter: ['data-appearance-transition'] });
      });
      await action.click();
      const progress = await page.evaluate(async () => {
        const animation = document.getAnimations().find((item) => item.id === 'workbench-appearance');
        await animation.ready;
        animation.currentTime = animation.effect.getTiming().duration / 3;
        for (let index = 0; index < 2; index++) await new Promise((resolve) => requestAnimationFrame(resolve));
        const workbench = document.querySelector('[data-vps-chat]');
        return parseFloat(getComputedStyle(workbench).getPropertyValue('--vc-appearance-progress')) / 100;
      });
      const colors = await checkWindowColors(false);
      await page.evaluate(() => document.getAnimations().find((item) => item.id === 'workbench-appearance').finish());
      return { colors, progress };
    }
    function assertSharedFade(from, middle, to) {
      assert.ok(middle.progress > 0 && middle.progress < 1);
      for (const key of ['color', 'borderColor', 'canvas', 'settings', 'accent']) {
        for (const offset of [1, 3, 5]) {
          const channel = (color) => parseInt(color.slice(offset, offset + 2), 16);
          const expected = channel(from[key]) * (1 - middle.progress) + channel(to[key]) * middle.progress;
          assert.ok(Math.abs(channel(middle.colors[key]) - expected) <= 1.5,
            key + ' does not follow the shared progress: ' + JSON.stringify({ from: from[key], middle: middle.colors[key], to: to[key] }));
        }
      }
    }
    const theme = dialog.getByRole('group', { name: '主题', exact: true });
    if (!legacyBaseline) {
      await theme.getByRole('button', { name: '深色', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('root').dataset.chromeTheme === 'dark');
    }
    await theme.getByRole('button', { name: '浅色', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('root').dataset.chromeTheme === 'light');
    const lightColors = !legacyBaseline && await checkWindowColors();
    const darkButton = theme.getByRole('button', { name: '深色', exact: true });
    const middleTheme = legacyBaseline ? await darkButton.click() : await sampleAppearance(darkButton);
    await page.waitForFunction(() => document.getElementById('root').dataset.chromeTheme === 'dark');
    const darkColors = !legacyBaseline && await checkWindowColors();
    if (!legacyBaseline) {
      assert.notEqual(lightColors.borderColor, darkColors.borderColor);
      assertSharedFade(lightColors, middleTheme, darkColors);
      const accents = dialog.locator('.vc-settings-disclosure > summary').filter({ hasText: '强调色' });
      await accents.click();
      const middleAccent = await sampleAppearance(dialog.getByRole('button', { name: '苔绿', exact: true }));
      const greenColors = await checkWindowColors();
      assert.notEqual(greenColors.borderColor, darkColors.borderColor);
      assert.notEqual(greenColors.color, darkColors.color);
      assert.equal(greenColors.accent, '#94d5b9');
      assertSharedFade(darkColors, middleAccent, greenColors);
      await dialog.locator('.vc-settings-disclosure:not([open]) > summary').filter({ hasText: '强调色' }).waitFor();
      await accents.click();
      await dialog.getByRole('button', { name: '跟随执行端', exact: true }).click();
      assert.deepEqual(await checkWindowColors(), darkColors);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await theme.getByRole('button', { name: '浅色', exact: true }).click();
      assert.equal(await page.locator('#root[data-appearance-transition]').count(), 0);
      assert.deepEqual(await checkWindowColors(), lightColors);
      await darkButton.click();
      assert.deepEqual(await checkWindowColors(), darkColors);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await desktop.evaluate(() => { globalThis.fixtureBorders.length = 0; });
    }
    await openSettingsSection(dialog, '执行端', legacyBaseline);
    await dialog.getByRole('checkbox', { name: 'Claude Code（订阅终端）', exact: true }).check();
    await dialog.getByRole('button', { name: legacyBaseline ? '保存执行端' : '保存启用变更', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('.vc-tool-trigger').click();
    await page.getByRole('option', { name: 'Claude Code（订阅终端）', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('region', { name: 'Claude Code 订阅终端' }).waitFor();
    if (!legacyBaseline) await verifyFooter(false);
    const nativeStatus = await page.evaluate(async () =>
      (await fetch('/dsh-terminal-workbench/api/bootstrap', { headers: { 'x-rtw-bootstrap': '1' } })).status);
    assert.equal(nativeStatus, 200);
    if (legacyBaseline) {
      assert.deepEqual((await desktop.evaluate(() => globalThis.fixtureOverlays)).at(-1),
        { color: '#29241f', symbolColor: '#eee5da', height: 44 });
    } else {
      await page.locator('[data-vps-chat][data-subscription-transition]').waitFor({ state: 'detached' });
      const subscriptionColors = await checkWindowColors();
      assert.notEqual(subscriptionColors.borderColor, darkColors.borderColor);
      assert.equal(subscriptionColors.accent, '#eac084');
      const frames = await desktop.evaluate(() => globalThis.fixtureBorders);
      assert.equal(frames.at(-1), subscriptionColors.borderColor);
      assert.ok(frames.some((color) => color !== darkColors.borderColor && color !== subscriptionColors.borderColor),
        JSON.stringify(frames));
    }
    assert.equal(await titleBar.getByRole('button', { name: /会话侧栏/ }).isDisabled(), true);
    await desktop.close();
    desktop = undefined;
    const stored = JSON.parse(await readFile(join(browserData, 'preferences.json'), 'utf8'));
    assert.equal(JSON.parse(stored['dsh-vps-chat:workbench:v1']).color, 'dark');
    if (!legacyBaseline) assert.deepEqual(JSON.parse(stored['dsh-vps-chat:desktop-access:v1']),
      { mode: 'execute', workspace: 'read-only' });
    if (!legacyBaseline) {
      const extensions = JSON.parse(stored['dsh-vps-chat:extensions:v1']);
      assert.ok(extensions.memoryEnabled && extensions.memories[0].text === reference.text);
      assert.ok(extensions.servers[0].enabled && extensions.plugins[0].enabled);
      assert.deepEqual(JSON.parse(stored[`dsh-vps-chat-conversations:v1:${targetId}`]), {
        [after[0].sessionId]: { title: '右键重命名后的会话', pinned: true },
      });
      assert.deepEqual(JSON.parse(stored['dsh-vps-chat:pinned-projects:v1']), [pinnedProjectId]);
      assert.equal(JSON.parse(stored[`dsh-vps-chat-projects:v1:${targetId}`])[after[0].sessionId],
        localState.projects()[0].workspaceId);
    }
    if (!legacyBaseline) {
      const preferences = join(browserData, 'preferences.json');
      assert.deepEqual(JSON.parse(await readFile(preferences + '.bak', 'utf8')), stored);
      await writeFile(preferences, '{"broken":');
    }
    page = await open();
    if (!legacyBaseline) {
      await page.getByText('已从本机备份恢复设置。', { exact: true }).waitFor();
      assert.deepEqual(await readPreferences(), stored);
      t.diagnostic('The packaged desktop restored its isolated corrupted settings from the latest backup.');
    }
    const secondOrigin = new URL(page.url()).origin;
    assert.notEqual(firstOrigin, secondOrigin);
    assert.equal(await page.locator('#root').getAttribute('data-chrome-theme'), 'dark');
    await page.getByRole('button', { name: '测试美术项目', exact: true }).waitFor();
    if (!legacyBaseline) {
      // The streamed conversation was supplied by the test relay, so reseed its sidebar entry on restart.
      await page.route('**/dsh-vps-chat/api/rpc', async (route) => {
        if (route.request().postDataJSON().op !== 'preset') return route.continue();
        const response = await route.fetch();
        const { sessionId: id, prompt: title } = after[0];
        const result = await response.json();
        await route.fulfill({ response, json: { ...result, preset: { ...result.preset, sessions: [{ id, title, mode: 'chat' }] } } });
      });
      await page.reload();
      await page.getByRole('region', { name: '置顶会话', exact: true })
        .getByRole('button', { name: '右键重命名后的会话', exact: true }).waitFor();
      await page.getByRole('region', { name: '置顶项目', exact: true })
        .getByRole('button', { name: '测试目录选择', exact: true }).waitFor();
    }
    await page.getByRole('button', { name: legacyBaseline ? 'VPS 设置' : '设置', exact: true }).click();
    dialog = page.getByRole('dialog', { name: legacyBaseline ? 'VPS 设置' : '设置', exact: true });
    await openSettingsSection(dialog, '外观', legacyBaseline);
    assert.equal(await dialog.getByRole('group', { name: '主题', exact: true })
      .getByRole('button', { name: '深色', exact: true }).getAttribute('aria-pressed'), 'true');
    if (!legacyBaseline) {
      const approvalId = 'd3dc9bc5-52fd-4dc0-9f57-26d505f7c21a';
      const approval = { id: approvalId, title: '读取授权样本', detail: '/workspace/sample.txt', kind: 'read', canAllow: true };
      const operations = [];
      let current;
      let approvalState = 'pending';
      await page.route('**/dsh-vps-chat/api/rpc', async (route) => {
        const packet = route.request().postDataJSON();
        if (packet.settings?.provider !== 'antigravity') return route.fallback();
        if (['send', 'steer', 'approval', 'stop'].includes(packet.op)) operations.push(packet);
        if (packet.op === 'send') current = packet;
        if (packet.op === 'approval') {
          approvalState = 'submitted';
          return route.fulfill({ json: { ok: true, outcome: 'queued' } });
        }
        if (packet.op === 'stop') return route.fulfill({ json: { ok: true, outcome: 'requested' } });
        if (!current || packet.sessionId !== current.sessionId || !['send', 'steer', 'get', 'refresh'].includes(packet.op)) {
          return route.fallback();
        }
        const supplement = operations.find(({ op }) => op === 'steer');
        const stopped = operations.some(({ op }) => op === 'stop');
        const result = reply(current, stopped ? '已停止测试生成' : '测试 ACP 回复', stopped ? 'stopped' : 'running');
        const turn = result.session.turns[0];
        turn.canSteer = !stopped && (!supplement || approvalState === 'submitted');
        if (supplement) {
          turn.steering = [{ id: supplement.steerId, prompt: supplement.prompt, state: 'submitted' }];
          if (packet.op !== 'steer') turn.approvals = [{ ...approval, state: approvalState,
            decision: approvalState === 'submitted' ? 'allow' : null }];
        }
        return route.fulfill({ json: result });
      });
      await openSettingsSection(dialog, '执行端', legacyBaseline);
      await dialog.getByRole('checkbox', { name: 'Antigravity', exact: true }).check();
      await dialog.getByRole('button', { name: '保存启用变更', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '切换 VPS 执行端', exact: true }).click();
      await page.getByRole('option', { name: 'Antigravity', exact: true }).click();
      await page.getByRole('complementary', { name: 'VPS 对话列表', exact: true })
        .getByRole('button', { name: '新建对话', exact: true }).click();
      const editor = page.getByRole('textbox', { name: '消息', exact: true });
      await editor.fill('生成测试内容');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await editor.fill('将当前回复缩短');
      await page.getByRole('button', { name: '发送补充', exact: true }).click();
      const card = page.getByRole('list', { name: '工具授权', exact: true });
      await card.getByText('/workspace/sample.txt', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '发送补充', exact: true }).count(), 0);
      const stop = page.getByRole('button', { name: '停止生成', exact: true });
      assert.equal(await stop.isEnabled(), true);
      await card.getByRole('button', { name: '允许一次', exact: true }).click();
      await card.getByText('允许一次 · 决定已提交', { exact: true }).waitFor();
      await stop.click();
      await page.getByText('已停止测试生成', { exact: true }).waitFor();
      assert.deepEqual(operations.map(({ op }) => op), ['send', 'steer', 'approval', 'stop']);
      assert.ok(operations.every(({ turnId, sessionId, targetId }) =>
        turnId === current.turnId && sessionId === current.sessionId && targetId === current.targetId));
      assert.equal(operations[2].approvalId, approvalId);
      assert.equal(operations[2].decision, 'allow');
      t.diagnostic('Antigravity supplement, delayed approval, and stopping were bound to the same chat turn.');
    }
    assert.deepEqual(pageErrors, []);
    assert.ok(requests.every((url) => url.startsWith(firstOrigin + '/') || url.startsWith(secondOrigin + '/') ||
      url.startsWith('blob:' + firstOrigin + '/') || url === 'about:srcdoc'));
    t.diagnostic('Native caption, responsive sidebar, menu actions, edit shortcuts, app icon, light/dark chrome, packaged provider helpers, chat, design, accounts, terminal, and preferences passed.');
  } finally {
    await desktop?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
