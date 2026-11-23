import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } from 'electron';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryJournalKey, openAppData } from './data.mjs';
import { extensionPreferenceKey } from '../extensions/state.mjs';
import { localWorkflowRunKey, mixedWorkflowHistoryKey, mixedWorkflowRunKey, workflowKey, workflowRunKey } from '../workflow-engine/state.mjs';
import { agentPresetKey, legacyAgentPresetKey } from '../agent-presets/state.mjs';
import { accessPreference, readAccess, validAccess } from './access.mjs';
import { importWorkbenchSnapshot } from './migrate.mjs';
import { agyHashVariable, agyPathVariable, canonicalLocalDirectory, claudeKeyVariable, localCredentialVariable,
  localMemoryJournalKey, openLocalCredentials, parseConversationLink, readLegacyWorkflowRun, startWorkbenchServer } from './server.mjs';

const localApiKey = process.env[localCredentialVariable];
const localAgentOptions = { claudeKey: process.env[claudeKeyVariable], agyPath: process.env[agyPathVariable], agyHash: process.env[agyHashVariable] };
for (const name of [localCredentialVariable, claudeKeyVariable, agyPathVariable, agyHashVariable]) delete process.env[name];

const directory = dirname(fileURLToPath(import.meta.url));
const linkFromArguments = (args) => args.find((arg) => parseConversationLink(arg)) ?? null;
let pendingChatLink = linkFromArguments(process.argv.slice(1));
const title = 'VPS 工作台';
const chromeThemes = {
  light: { color: '#f4eee6', symbolColor: '#423831', borderColor: '#9d8879' },
  dark: { color: '#29241f', symbolColor: '#eee5da', borderColor: '#957e6f' },
};
const chromeHeight = 44;
const opaqueColor = /^#[0-9a-f]{6}$/i;
const editActions = new Map([
  ['undo', (contents) => contents.undo()], ['redo', (contents) => contents.redo()],
  ['cut', (contents) => contents.cut()], ['copy', (contents) => contents.copy()],
  ['paste', (contents) => contents.paste()], ['selectAll', (contents) => contents.selectAll()],
]);
const editShortcuts = { z: 'undo', y: 'redo', x: 'cut', c: 'copy', v: 'paste', a: 'selectAll' };
const importErrorMessages = new Map([
  ['workbench_data_exists', '独立工作台已有本机记录。请选择一个空数据目录后再导入。'],
  ['workbench_snapshot_not_found', '所选目录中找不到 VPS 工作台记录。'],
  ['source_workbench_changed', '源目录在导入过程中发生变化。请结束正在写入的对话后重试。'],
]);

function canonicalDestination(path) {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('data_volume_unavailable');
    ancestor = parent;
  }
  return join(realpathSync(ancestor), relative(ancestor, path));
}
const buildMetadata = JSON.parse(await readFile(join(directory, '../package.json'), 'utf8'));
const personalClaudeSubscription = buildMetadata.personalClaudeSubscription === true;
const dataDirectory = personalClaudeSubscription ? 'VPS Workbench Personal' : 'VPS Workbench';
const root = canonicalDestination(resolve(process.env.VPS_WORKBENCH_DATA_DIR || join(app.getPath('appData'), dataDirectory)));
const dshRoot = canonicalDestination(resolve(app.getPath('appData'), 'dsh-desktop')).toLowerCase();
const workbenchRoot = join(root, 'conversations');
const terminalRoot = join(root, 'terminal');
const accountHosts = ['chatgpt.com', 'openai.com', 'claude.ai', 'claude.com', 'anthropic.com',
  'accounts.google.com', 'myaccount.google.com', 'antigravity.google'];
let window;
let runtime;
let data;
let quitting = false;
let directoryActionActive = false;

function trustedRenderer(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== runtime.origin + '/') {
    throw new Error('not_workbench_renderer');
  }
}

function publishProjects() {
  if (window && !window.isDestroyed()) window.webContents.send('workbench:projects', data.projects());
}

function report(message) {
  if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { title, message });
}

function publishStatus(message) {
  if (window && !window.isDestroyed()) window.webContents.send('workbench:local-status', message);
}

async function withDirectory(options, onSelected, onError) {
  if (directoryActionActive) return;
  directoryActionActive = true;
  try {
    const result = await dialog.showOpenDialog(window, { ...options, properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths.length) return await onSelected(result.filePaths[0]);
  } catch (error) {
    return onError(error);
  } finally {
    directoryActionActive = false;
  }
}

function addProject() {
  return withDirectory({ title: '添加本地项目目录' }, async (path) => {
    await data.addProject(path);
    publishProjects();
  }, () => report('无法保存该项目目录。'));
}

function importHistory() {
  return withDirectory({
    title: '选择原有 vps-chat-workbench 数据目录',
    defaultPath: join(app.getPath('appData'), 'dsh-desktop', 'harness', 'vps-chat-workbench'),
  }, async (path) => {
    await importWorkbenchSnapshot(path, workbenchRoot);
    await window.loadURL(runtime.origin + '/');
  }, (error) => report(importErrorMessages.get(error.message) ?? '未能导入工作台记录。'));
}

function overlay({ color, symbolColor }) {
  return { color, symbolColor, height: chromeHeight };
}

async function start() {
  for (const child of [workbenchRoot, terminalRoot]) {
    await mkdir(child, { recursive: true });
    if (!(await lstat(child)).isDirectory() || realpathSync(child).toLowerCase() !== child.toLowerCase())
      throw new Error('redirected_data_directory');
  }
  data = await openAppData(root, { onBackupFailure: () => publishStatus('本机数据已保存，备份暂时无法更新。') });
  const pythonPath = process.env.VPS_WORKBENCH_PYTHON;
  if (pythonPath && !isAbsolute(pythonPath)) throw new Error('python_must_be_absolute');
  runtime = await startWorkbenchServer({
    webRoot: join(directory, 'web'), workbenchRoot, terminalRoot,
    runtimeRoot: join(directory, '../helper'), pythonPath, access: () => readAccess(data.preference(accessPreference)),
    localStateRoot: join(root, 'local-sdk'), localApiKey, localAgentOptions,
    componentRoot: join(root, 'components'), componentMode: buildMetadata.componentMode, personalClaudeSubscription,
    localCredentials: openLocalCredentials({ root: join(root, 'local-credentials'), encryption: safeStorage }),
    data, onMemoryChanged: (state) => {
      if (window && !window.isDestroyed()) window.webContents.send('workbench:extensions-changed', state);
    },
    onMemoryError: publishStatus,
  });
  let chromeColors = chromeThemes[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1260, height: 850, minWidth: 365, minHeight: 480, show: false, title,
    icon: join(directory, 'icon.png'),
    titleBarStyle: 'hidden', titleBarOverlay: overlay(chromeColors), accentColor: chromeColors.borderColor,
    backgroundColor: chromeColors.color,
    webPreferences: {
      preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, spellcheck: false,
    },
  });
  const contents = window.webContents;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta || input.isComposing) return;
    const key = input.key.toLowerCase();
    const action = input.shift ? (key === 'z' ? 'redo' : undefined)
      : Object.hasOwn(editShortcuts, key) ? editShortcuts[key] : undefined;
    if (!action) return;
    event.preventDefault();
    editActions.get(action)(contents);
  });
  contents.session.setPermissionRequestHandler((requester, permission, callback) => {
    callback(requester === contents && permission === 'clipboard-sanitized-write');
  });
  contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, ({ url }, callback) => {
    const scoped = url.startsWith(runtime.origin + '/') ||
      url === runtime.origin.replace(/^http:/, 'ws:') + '/dsh-vps-chat/api/account-screen';
    callback({ cancel: /^(?:https?|wss?):/.test(url) && !scoped });
  });
  contents.on('will-navigate', (event, url) => {
    if (url !== runtime.origin + '/') event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (['http:', 'https:'].includes(target.protocol) &&
          !target.username && !target.password) {
        if (accountHosts.some((host) => target.hostname === host || target.hostname.endsWith('.' + host))) {
          report('请从「VPS 设置 → 账号」打开该账号页面。');
        } else {
          void shell.openExternal(target.href).catch(() => report('无法打开链接。'));
        }
      }
    } catch {}
    return { action: 'deny' };
  });
  ipcMain.handle('workbench:bootstrap', (event) => {
    trustedRenderer(event);
    const preferences = data.preferences();
    delete preferences[mixedWorkflowHistoryKey];
    return { preferences, projects: data.projects(), access: readAccess(data.preference(accessPreference)),
      dataNotices: data.notices(), localComponents: runtime.localComponentsStatus() };
  });
  ipcMain.handle('workbench:take-chat-link', (event) => {
    trustedRenderer(event);
    const link = pendingChatLink;
    pendingChatLink = null;
    return link;
  });
  ipcMain.handle('workbench:register-chat-links', (event) => {
    trustedRenderer(event);
    return process.platform === 'win32' && !process.defaultApp && app.setAsDefaultProtocolClient('vps-workbench');
  });
  ipcMain.handle('workbench:set-preference', (event, key, value) => {
    trustedRenderer(event);
    if ([accessPreference, extensionPreferenceKey, memoryJournalKey, localMemoryJournalKey, workflowKey, agentPresetKey,
      legacyAgentPresetKey, mixedWorkflowRunKey, mixedWorkflowHistoryKey].includes(key)) {
      throw new Error('use_dedicated_settings');
    }
    if ([localWorkflowRunKey, workflowRunKey].includes(key)) readLegacyWorkflowRun(value);
    return data.setPreference(key, value);
  });
  ipcMain.handle('workbench:workflows', (event, change) => {
    trustedRenderer(event);
    return data.changeWorkflows(change);
  });
  ipcMain.handle('workbench:mixed-workflow', (event, body) => {
    trustedRenderer(event);
    return runtime.requestMixedWorkflow(body);
  });
  ipcMain.handle('workbench:workflow-attachments', (event, files) => {
    trustedRenderer(event);
    return data.saveWorkflowAttachments(files);
  });
  ipcMain.handle('workbench:agent-presets', (event, change) => {
    trustedRenderer(event);
    return data.changeAgentPresets(change);
  });
  ipcMain.handle('workbench:extensions', (event, change) => {
    trustedRenderer(event);
    if (change?.op === 'accept-automatic-memory') throw new Error('invalid_extension_change');
    if (change?.op === 'set-memory-extraction-model') return runtime.changeMemoryExtractionModel(change);
    if (change?.op === 'save-server') {
      const target = change.server?.targetId;
      const profile = runtime.localStatus().profiles?.find(({ targetId }) => targetId === target);
      if (Boolean(change.server?.local) !== Boolean(profile) || (profile &&
          (profile.backend !== 'codex' || readAccess(data.preference(accessPreference)).mode !== 'execute'))) throw new Error('invalid_mcp_scope');
    }
    if (change?.op === 'set-scoped-personal-memory' && !runtime.localStatus().profiles?.some(({ targetId, backend }) => targetId === change.targetId && backend === 'codex'))
      throw new Error('invalid_local_profile');
    if (change?.op === 'set-automatic-memory' && !data.projects().some(({ workspaceId }) => workspaceId === change.projectId))
      throw new Error('invalid_project');
    return data.changeExtensions(change);
  });
  ipcMain.handle('workbench:local-sdk-status', (event) => {
    trustedRenderer(event);
    return runtime.localStatus();
  });
  ipcMain.handle('workbench:local-components-status', (event) => {
    trustedRenderer(event);
    return runtime.localComponentsStatus();
  });
  ipcMain.handle('workbench:local-components-install', (event, ids) => {
    trustedRenderer(event);
    return runtime.installLocalComponents(ids);
  });
  ipcMain.handle('workbench:local-components-cancel', (event) => {
    trustedRenderer(event);
    runtime.cancelLocalComponents();
  });
  ipcMain.handle('workbench:local-credential-save', (event, backend, key) => {
    trustedRenderer(event);
    return runtime.saveLocalCredential(backend, key);
  });
  ipcMain.handle('workbench:local-antigravity-login', (event, profileId) => {
    trustedRenderer(event);
    return runtime.loginLocalAntigravity(profileId);
  });
  ipcMain.handle('workbench:local-claude-subscription-login', (event, profileId) => {
    trustedRenderer(event);
    return runtime.loginLocalClaudeSubscription(profileId);
  });
  ipcMain.handle('workbench:local-claude-subscription-status', (event, profileId) => {
    trustedRenderer(event);
    return runtime.checkLocalClaudeSubscription(profileId);
  });
  ipcMain.handle('workbench:local-sdk-request', (event, body) => {
    trustedRenderer(event);
    return runtime.requestLocal(body);
  });
  ipcMain.handle('workbench:local-sdk-register', async (event, config) => {
    trustedRenderer(event);
    const status = runtime.localStatus();
    if (!status.ok) return status;
    if (readAccess(data.preference(accessPreference)).mode !== 'execute') {
      return { ok: false, code: 'workbench_browse_only', message: '当前为仅浏览模式。' };
    }
    const backend = config?.backend ?? 'codex';
    const provider = status.providers?.find((item) => item.backend === backend);
    if (!provider || !config || Object.keys(config).some((key) => !['name', 'model', 'effort', 'backend', 'authMode'].includes(key)) ||
        (Object.hasOwn(config, 'authMode') && !(config.authMode === 'subscription' && provider.personalSubscriptionAvailable)) ||
        typeof config.name !== 'string' || !config.name.trim() || config.name.length > 80 ||
        !provider.models.some(({ id, efforts }) => id === config.model && efforts.includes(config.effort))) {
      return { ok: false, code: 'invalid_profile', message: '请选择受支持的模型和推理档位，并填写配置名。' };
    }
    const selected = await withDirectory({ title: '选择本机执行端的只读工作目录' }, async (path) => {
      const directory = await canonicalLocalDirectory(path);
      return runtime.registerLocalProfile({ backend, name: config.name, model: config.model, effort: config.effort, directory,
        ...(config.authMode === 'subscription' && { authMode: 'subscription' }) });
    }, () => ({ ok: false, code: 'invalid_directory', message: '请选择可用的本机目录。' }));
    return selected ?? { ok: false, code: 'directory_cancelled', message: '未选择工作目录。' };
  });
  ipcMain.handle('workbench:set-access', async (event, access) => {
    trustedRenderer(event);
    if (!validAccess(access)) throw new Error('invalid_access');
    await data.setPreference(accessPreference, JSON.stringify(access));
    runtime.accessChanged();
    return readAccess(data.preference(accessPreference));
  });
  ipcMain.handle('workbench:write-clipboard', (event, text) => {
    trustedRenderer(event);
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('workbench:add-project', (event) => {
    trustedRenderer(event);
    return addProject();
  });
  ipcMain.handle('workbench:remove-project', async (event, id) => {
    trustedRenderer(event);
    if (typeof id !== 'string' || !data.projects().some(({ workspaceId }) => workspaceId === id)) return;
    try { await data.removeProject(id); publishProjects(); }
    catch { report('无法保存项目列表。'); }
  });
  ipcMain.handle('workbench:import-history', (event) => {
    trustedRenderer(event);
    return importHistory();
  });
  ipcMain.handle('workbench:edit', (event, command) => {
    trustedRenderer(event);
    editActions.get(command)?.(contents);
  });
  ipcMain.handle('workbench:quit', (event) => {
    trustedRenderer(event);
    app.quit();
  });
  ipcMain.handle('workbench:chrome-theme', (event, palette) => {
    trustedRenderer(event);
    const { color, symbolColor, borderColor } = palette ?? {};
    if (![color, symbolColor, borderColor].every((value) => typeof value === 'string' && opaqueColor.test(value))) return;
    if (color !== chromeColors.color || symbolColor !== chromeColors.symbolColor) {
      window.setTitleBarOverlay(overlay({ color, symbolColor }));
    }
    if (borderColor !== chromeColors.borderColor && process.platform === 'win32') {
      window.setAccentColor(borderColor);
    }
    chromeColors = { color, symbolColor, borderColor };
  });
  await contents.session.cookies.set(runtime.cookie);
  await window.loadURL(runtime.origin + '/');
  window.show();
}

app.setName(title);
if (process.platform === 'win32') app.setAppUserModelId('VPS.Workbench');
if (root.toLowerCase() === dshRoot || root.toLowerCase().startsWith(dshRoot + sep)) {
  throw new Error('The standalone workbench requires a separate data directory.');
}
mkdirSync(root, { recursive: true });
app.setPath('userData', root);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, args) => {
    const link = linkFromArguments(args);
    if (link) pendingChatLink = link;
    if (!window || window.isDestroyed()) return;
    if (link) window.webContents.send('workbench:chat-link-ready');
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void Promise.allSettled([data?.flush(), runtime?.close()]).finally(() => app.quit());
  });
  app.whenReady().then(start).catch(() => {
    dialog.showErrorBox(title, '启动失败。请检查本机工作台数据和程序文件。');
    app.quit();
  });
}
