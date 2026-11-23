import { interfaceLanguageKey, normalizeInterfaceLanguage, setInterfaceLanguage, t }
  from '../../remote-workbench/vps-chat/client/interface-language.js';
import React from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createWorkbench } from '../../remote-workbench/vps-chat/client/workbench.js';
import { menuIcon } from '../../remote-workbench/vps-chat/client/menu-icons.js';
import { parseConversationLink } from '../../remote-workbench/vps-chat/client/chat-reference.js';
import { GlobalSearchDialog } from './global-search-dialog.mjs';
import { readPreferences, workbenchPreferenceKey } from '../../remote-workbench/vps-chat/client/workbench-preferences.js';
import { setWorkbenchStorage } from '../../remote-workbench/vps-chat/client/workbench-storage.js';
import { createResourceLibrary } from '../resource-library/index.mjs';
import { createStandaloneSubscriptionView } from '../terminal/subscription-view.mjs';
import {
  automaticMemoryPolicy, conversationIsolated, extensionPreferenceKey, extensionsForTurn, projectMemoryNotes, readExtensions,
} from '../extensions/state.mjs';
import { createExtensionSettings } from '../extensions/settings.mjs';
import { agentPresetKey, applyAgentPresetChange, legacyAgentPresetKey, readAgentPresets } from '../agent-presets/state.mjs';
import { createAgentPresetSettings } from '../agent-presets/settings.mjs';
import {
  applyWorkflowChange, localWorkflowRunKey, maxWorkflowAttachmentBytes, maxWorkflowAttachments, readWorkflows,
  validWorkflowFileName, workflowKey, workflowRunKey,
} from '../workflow-engine/state.mjs';
import { readLegacyWorkflowRun } from '../workflow-engine/runner.mjs';
import { createWorkflowPanel } from '../workflow-panel/index.mjs';
import { DesktopChrome } from './chrome.mjs';
import { createStreamingMarkdownParser, stabilizeStreamingRecord } from './streaming-render.mjs';
import { useWorkflowControls } from './workflow-controls.mjs';
import { SetupGuide } from './setup-guide.mjs';
import { setupConnectionKey } from './setup-state.mjs';
import { VpsConnectionChecks, useVpsConnectionChecks } from './connection-panel.mjs';
import { createLocalWorkspace } from '../local-ui/index.mjs';
import { componentWelcomeKey } from '../local-ui/components.mjs';

const h = React.createElement;
const native = window.vpsWorkbench;
const locations = [['ssh-vps', 'VPS SSH'], ['local-sdk', '本机 SDK']];
const newLocationKey = 'dsh-vps-chat:desktop-new-location:v1';
const viewLocationKey = 'dsh-vps-chat:desktop-view-location:v1';
const readLocation = (value) => value === 'local-sdk' ? value : 'ssh-vps';
const writeClipboard = (text) => native.writeClipboard(text);
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const updateTheme = () => { document.documentElement.dataset.theme = systemTheme.matches ? 'dark' : 'light'; };
updateTheme();
systemTheme.addEventListener('change', updateTheme);

function showLocalStatus(message) {
  const status = document.getElementById('local-status');
  status.textContent = message;
  status.hidden = false;
}

function applyLanguage(language) {
  setInterfaceLanguage(language);
  document.documentElement.lang = language;
  document.title = t('VPS 工作台');
}

function reportChromeError() { showLocalStatus(t('未能完成工作台操作')); }

function ConversationLinkDialog({ onOpen, onClose }) {
  const dialog = React.useRef(null);
  const [error, setError] = React.useState('');
  React.useLayoutEffect(() => { dialog.current.showModal(); }, []);
  return h('dialog', { ref: dialog, className: 'desktop-link-dialog', 'aria-label': t('打开对话链接'), onClose },
    h('form', { onSubmit(event) {
      event.preventDefault();
      const link = parseConversationLink(new FormData(event.currentTarget).get('link'));
      if (!link) { setError(t('请输入有效的 VPS Workbench 对话链接。')); return; }
      dialog.current.close();
      onOpen(link);
    } },
    h('label', null, t('对话链接'), h('input', { name: 'link', maxLength: 256, required: true, autoFocus: true,
      placeholder: 'vps-workbench://…', onChange: () => setError('') })),
    error ? h('p', { role: 'alert' }, error) : null,
    h('div', { className: 'desktop-link-actions' },
      native.registerChatLinks ? h('button', { type: 'button', onClick: async () => {
        try { setError(await native.registerChatLinks() ? t('已关联 Windows 对话链接。') : t('Windows 未能关联此程序。')); }
        catch { setError(t('Windows 未能关联此程序。')); }
      } }, t('关联 Windows 链接')) : null,
      h('button', { type: 'button', onClick: () => dialog.current.close() }, t('取消')),
      h('button', { type: 'submit' }, t('打开')))));
}

async function saveWorkflowAttachments(files) {
  if (!Array.isArray(files) || !files.length || files.length > maxWorkflowAttachments ||
      files.some((file) => !validWorkflowFileName(file.name) || file.size <= 0) ||
      files.reduce((size, file) => size + file.size, 0) > maxWorkflowAttachmentBytes) {
    throw new Error('每阶段最多选择 8 个附件，总计最多 512 KiB。');
  }
  const snapshots = await Promise.all(files.map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunks = [];
    for (let start = 0; start < bytes.length; start += 8192) {
      chunks.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
    }
    return { name: file.name, data: btoa(chunks.join('')) };
  }));
  return native.saveWorkflowAttachments(snapshots);
}

function CodeBlock({ code, lang, className, copyLabel, copiedLabel }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    if (await writeClipboard(code).catch(() => false)) setCopied(true);
  }
  return h('div', { className: 'standalone-code ' + className },
    h('header', null, lang ? h('span', null, lang) : null,
      h('button', { type: 'button', onClick: copy, className: 'vc-button' }, copied ? copiedLabel : copyLabel)),
    h('pre', null, h('code', null, code)));
}

function createCatalog(initial) {
  let snapshot = { phase: 'ready', items: initial };
  const listeners = new Set();
  native.onProjectsChanged((items) => {
    snapshot = { phase: 'ready', items };
    for (const listener of listeners) listener();
  });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const root = createRoot(document.getElementById('root'));
try {
  const { preferences, projects, access: initialAccess, dataNotices = [], localComponents = null } = await native.bootstrap();
  if (dataNotices.length) showLocalStatus(dataNotices.join(' '));
  const values = new Map(Object.entries(preferences));
  const initialLanguage = normalizeInterfaceLanguage(values.get(interfaceLanguageKey));
  applyLanguage(initialLanguage);
  const showComponentWelcome = localComponents?.mode === 'on-demand' && localComponents.supported &&
    localComponents.items.every(({ ready }) => !ready) && !values.get(componentWelcomeKey);
  function persist(key, value) {
    void native.setPreference(key, value).catch(() => showLocalStatus(t('本机设置保存失败')));
  }
  setWorkbenchStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); persist(key, value); },
    removeItem(key) { values.delete(key); persist(key, null); },
  });
  async function saveLocalPreference(key, value) {
    await native.setPreference(key, value);
    if (value === null) values.delete(key);
    else values.set(key, value);
  }
  const projectCatalog = createCatalog(projects);
  const Subscription = createStandaloneSubscriptionView(React);
  const terminalView = { subscribe: () => () => {}, getSnapshot: () => Subscription };
  const ExtensionSettings = createExtensionSettings(React);
  const AgentPresetSettings = createAgentPresetSettings(React, { icon: menuIcon });
  const WorkflowPanel = createWorkflowPanel(React, { icon: menuIcon });
  const readSavedAgentPresets = () => readAgentPresets(values.get(agentPresetKey) ?? null, values.get(legacyAgentPresetKey) ?? null);
  let initialAgentPresets = [];
  let agentPresetError = '';
  try { initialAgentPresets = readSavedAgentPresets(); }
  catch { agentPresetError = '本机的 Agent 预设无法读取。'; }
  let initialWorkflows = [];
  let initialWorkflowRun = null;
  let workflowError = '';
  try {
    initialWorkflows = readWorkflows(values.get(workflowKey) ?? null);
    initialWorkflowRun = readLegacyWorkflowRun(values.get(workflowRunKey) ?? null);
  } catch {
    workflowError = '本机的工作流配置或运行回执无法读取。';
    showLocalStatus(workflowError);
  }
  const saveWorkflowRun = (run) => saveLocalPreference(workflowRunKey, JSON.stringify(run));
  let initialLocalRun = null;
  let localRunError = '';
  try { initialLocalRun = readLegacyWorkflowRun(values.get(localWorkflowRunKey) ?? null); }
  catch { localRunError = '本机 SDK 的工作流运行回执无法读取。'; }
  const saveLocalRun = (run) => saveLocalPreference(localWorkflowRunKey, JSON.stringify(run));
  let startingExtensions;
  try { startingExtensions = readExtensions(values.get(extensionPreferenceKey) ?? null); }
  catch {
    startingExtensions = readExtensions(null);
    showLocalStatus('扩展设置无法读取。');
  }
  const workbenchOptions = { React, CodeBlock, writeClipboard, subscriptionRequiresRelay: false,
    hostThemeLabel: '跟随系统', parseStreamingMarkdown: createStreamingMarkdownParser(), stabilizeStreamingRecord,
    sidebarActions: true, ResourceLibrary: createResourceLibrary(React),
    editText: native.edit, saveConversationPreference: saveLocalPreference, saveModelParameters: saveLocalPreference,
    ExtensionSettings, extensionsForTurn, automaticMemoryPolicy, conversationIsolated, projectMemoryNotes,
    AgentPresetSettings, WorkflowPanel, useWorkflows: useWorkflowControls,
    onThemeReveal: (element, progress) => element.dispatchEvent(
      new CustomEvent('workbench:theme-reveal', { detail: progress })),
  };
  const Workbench = createWorkbench({ ...workbenchOptions, SetupGuide, setupConnectionKey, VpsConnectionChecks, useVpsConnectionChecks });
  const LocalWorkspace = createLocalWorkspace(React, createWorkbench({ ...workbenchOptions, localSdk: true }));
  const noTerminal = { subscribe: () => () => {}, getSnapshot: () => null };
  function DesktopApp() {
    const [newLocation, setNewLocation] = React.useState(() => readLocation(values.get(newLocationKey)));
    const [location, setLocation] = React.useState(() => readLocation(values.get(viewLocationKey)));
    const [visited, setVisited] = React.useState(() => new Set(showComponentWelcome ? [location, 'local-sdk'] : [location]));
    const [localNew, setLocalNew] = React.useState(0);
    const [sshNew, setSshNew] = React.useState(0);
    const [settings, setSettings] = React.useState(() => showComponentWelcome ? { location: 'local-sdk', tab: 'connection' } : null);
    const [componentWelcome, setComponentWelcome] = React.useState(showComponentWelcome);
    const settingsLayer = React.useRef(null);
    const settingsTrigger = React.useRef(null);
    const [appearance, setAppearance] = React.useState(readPreferences);
    const [language, setLanguage] = React.useState(initialLanguage);
    async function changeLanguage(next) {
      if (normalizeInterfaceLanguage(next) !== next) return false;
      if (next === language) return true;
      try {
        await saveLocalPreference(interfaceLanguageKey, next);
        applyLanguage(next);
        setLanguage(next);
        return true;
      } catch {
        return false;
      }
    }
    const appearanceDraft = React.useRef(appearance);
    const appearanceWrites = React.useRef(Promise.resolve());
    const [resourcesOpen, setResourcesOpen] = React.useState(false);
    const [chatLinkDialog, setChatLinkDialog] = React.useState(false);
    const [chatLink, setChatLink] = React.useState(null);
    const [searchOpen, setSearchOpen] = React.useState(false);
    const [workflowSearch, setWorkflowSearch] = React.useState(null);
    React.useEffect(() => {
      if (!native.localSearch) return undefined;
      function shortcut(event) {
        if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey &&
            !event.isComposing && event.key.toLowerCase() === 'k' && !document.querySelector('dialog:modal')) {
          event.preventDefault();
          setSearchOpen(true);
        }
      }
      window.addEventListener('keydown', shortcut);
      return () => window.removeEventListener('keydown', shortcut);
    }, []);
    const openChatLink = React.useCallback((link) => {
      setVisited((previous) => previous.has(link.location) ? previous : new Set([...previous, link.location]));
      setLocation(link.location);
      setChatLink(link);
      void saveLocalPreference(viewLocationKey, link.location).catch(reportChromeError);
    }, []);
    const onChatLinkResult = React.useCallback((link, error) => {
      setChatLink((previous) => previous === link ? null : previous);
      if (error) showLocalStatus(error);
    }, []);
    React.useEffect(() => {
      if (!native.takeChatLink) return undefined;
      const read = async () => {
        const link = parseConversationLink(await native.takeChatLink());
        if (link) openChatLink(link);
      };
      const unsubscribe = native.onChatLink?.(() => void read().catch(reportChromeError));
      void read().catch(reportChromeError);
      return unsubscribe;
    }, [openChatLink]);
    const [access, setAccess] = React.useState(initialAccess);
    const [extensions, setExtensions] = React.useState(startingExtensions);
    const [agentItems, setAgentItems] = React.useState(initialAgentPresets);
    const [workflowItems, setWorkflowItems] = React.useState(initialWorkflows);
    const [extensionsBusy, setExtensionsBusy] = React.useState(false);
    React.useEffect(() => native.onExtensionsChanged(setExtensions), []);
    React.useEffect(() => native.onLocalStatus?.(showLocalStatus), []);
    const editingExtensions = React.useRef(false);
    const [accessPending, setAccessPending] = React.useState(false);
    const saving = React.useRef(false);
    function openLocation(next) {
      if (next === location) return;
      setVisited((previous) => previous.has(next) ? previous : new Set([...previous, next]));
      setLocation(next);
      void saveLocalPreference(viewLocationKey, next).catch(reportChromeError);
    }
    function openSearchWorkflow({ group, workflowId, runId, runLocation, stageIndex, mixed }) {
      const destination = runLocation ?? (group.location === 'shared' ? location : group.location);
      openLocation(destination);
      setWorkflowSearch({ location: destination, workflowId, runId, stageIndex, mixed });
    }
    function onWorkflowSearchOpened(value) {
      setWorkflowSearch((previous) => previous === value ? null : previous);
    }
    function navigateSettings(next, tab) {
      setVisited((previous) => previous.has(next) ? previous : new Set([...previous, next]));
      setSettings({ location: next, tab });
    }
    function settingsSurface(target) {
      return {
        tab: settings?.location === target ? settings.tab : false,
        open(tab) {
          if (!settings) settingsTrigger.current = document.activeElement;
          navigateSettings(target, tab);
        },
        setTab(tab) { setSettings((previous) => previous?.location === target ? { ...previous, tab } : previous); },
        close() { setSettings(null); },
        restoreFocus() {
          const trigger = settingsTrigger.current ?? document.querySelector('.desktop-location-tabs button[aria-pressed="true"]');
          if (!settings && !document.querySelector('dialog:modal') && trigger?.isConnected) {
            trigger.focus({ preventScroll: true });
          }
        },
        navigate: navigateSettings,
        show(element, attributes) {
          return settingsLayer.current && createPortal(h('div', { ...attributes, className: 'desktop-settings-surface' }, element),
            settingsLayer.current);
        },
      };
    }
    async function completeComponentWelcome(accounts) {
      if (componentWelcome) {
        await saveLocalPreference(componentWelcomeKey, 'seen');
        setComponentWelcome(false);
      }
      if (accounts) navigateSettings('local-sdk', 'accounts');
      else setSettings(null);
    }
    async function changeAppearance(patch) {
      const next = { ...appearanceDraft.current, ...patch };
      appearanceDraft.current = next;
      setAppearance(next);
      const write = appearanceWrites.current.then(() => saveLocalPreference(workbenchPreferenceKey, JSON.stringify(next)));
      appearanceWrites.current = write.catch(() => {});
      try {
        await write;
        return true;
      } catch {
        if (appearanceDraft.current === next) {
          const saved = readPreferences();
          appearanceDraft.current = saved;
          setAppearance(saved);
        }
        showLocalStatus(t('应用偏好未能保存。请重试。'));
        return false;
      }
    }
    function changeNewLocation(next) {
      setNewLocation(next);
      void saveLocalPreference(newLocationKey, next).catch(reportChromeError);
    }
    function startChat() {
      openLocation(newLocation);
      if (newLocation === 'local-sdk') setLocalNew((epoch) => epoch + 1);
      else setSshNew((epoch) => epoch + 1);
    }
    async function changeAccess(next) {
      if (saving.current) return;
      saving.current = true;
      setAccessPending(true);
      try { setAccess(await native.setAccess(next)); }
      catch { showLocalStatus('访问权限未能保存。'); }
      finally { saving.current = false; setAccessPending(false); }
    }
    async function changeExtensions(change) {
      if (editingExtensions.current) throw new Error('extension_settings_busy');
      editingExtensions.current = true;
      setExtensionsBusy(true);
      try {
        const next = await native.changeExtensions(change);
        setExtensions(next);
        return next;
      } finally {
        editingExtensions.current = false;
        setExtensionsBusy(false);
      }
    }
    async function changeWorkflows(change) {
      if (workflowError) throw new Error(workflowError);
      const updated = native.changeWorkflows ? await native.changeWorkflows(change)
        : applyWorkflowChange(readWorkflows(values.get(workflowKey) ?? null), change);
      if (!native.changeWorkflows) await saveLocalPreference(workflowKey, JSON.stringify(updated));
      setWorkflowItems(updated);
      return updated;
    }
    async function changeAgentPresets(change) {
      if (agentPresetError) throw new Error(agentPresetError);
      const updated = native.changeAgentPresets ? await native.changeAgentPresets(change)
        : applyAgentPresetChange(readSavedAgentPresets(), change);
      if (!native.changeAgentPresets) await saveLocalPreference(agentPresetKey, JSON.stringify(updated));
      setAgentItems(updated);
      return updated;
    }
    const sshVisible = location === 'ssh-vps';
    const openSearch = native.localSearch ? () => setSearchOpen(true) : undefined;
    return h(React.Fragment, null,
      h(DesktopChrome, { native, projectCatalog, location, newLocation, locations: locations.map(([id, label]) => [id, t(label)]), openLocation, changeNewLocation,
        onError: reportChromeError,
        onOpenChatLink: () => setChatLinkDialog(true), onOpenSearch: openSearch,
        onOpenResources: () => setResourcesOpen(true),
        onOpenLanguage: () => settingsSurface(location).open('appearance') }),
      h('div', { className: 'desktop-location-bar' },
        h('div', { role: 'group', 'aria-label': t('打开会话历史'), className: 'desktop-location-tabs' },
          locations.map(([id, label]) => h('button', { key: id, type: 'button',
            'aria-pressed': id === location, onClick: () => openLocation(id) }, t(label)))),
        h('label', null, t('新建位置'),
          h('select', { 'aria-label': t('新建位置'), value: newLocation, onChange: (event) => changeNewLocation(event.target.value) },
            locations.map(([id, label]) => h('option', { key: id, value: id }, t(label)))))),
      visited.has('ssh-vps') ? h(Workbench, { projectCatalog, terminalView, resourcesOpen, setResourcesOpen, onQuickSearch: openSearch,
        workflowSearch: workflowSearch?.location === 'ssh-vps' ? workflowSearch : null, onWorkflowSearchOpened,
        chatLink: chatLink?.location === 'ssh-vps' ? chatLink : null, onChatLinkResult,
        access, accessPending, changeAccess, visible: sshVisible, active: sshVisible, newChatRequest: sshNew,
        settingsSurface: settingsSurface('ssh-vps'),
        applicationPreferences: { value: appearance, change: changeAppearance, language, changeLanguage },
        onNewChat: newLocation === 'local-sdk' ? startChat : undefined,
        extensions: { state: extensions, change: changeExtensions, busy: extensionsBusy },
        agentPresets: { items: agentItems, change: changeAgentPresets, error: agentPresetError },
        workflowStore: { items: workflowItems, change: changeWorkflows, initialRun: initialWorkflowRun,
          saveRun: saveWorkflowRun, saveAttachments: saveWorkflowAttachments, mixedRequest: native.mixedWorkflow, error: workflowError } }) : null,
      visited.has('local-sdk') ? h(LocalWorkspace, { native, active: !sshVisible, access, accessPending, changeAccess,
        workflowSearch: workflowSearch?.location === 'local-sdk' ? workflowSearch : null, onWorkflowSearchOpened,
        chatLink: chatLink?.location === 'local-sdk' ? chatLink : null, onChatLinkResult,
        projectCatalog, terminalView: noTerminal, resourcesOpen, setResourcesOpen, onQuickSearch: openSearch,
        newChatRequest: localNew, onNewChat: startChat,
        settingsSurface: settingsSurface('local-sdk'),
        componentSetup: { initial: localComponents, welcome: componentWelcome, continue: completeComponentWelcome },
        applicationPreferences: { value: appearance, change: changeAppearance, language, changeLanguage }, savePreference: saveLocalPreference,
        extensions: { state: extensions, change: changeExtensions, busy: extensionsBusy },
        agentPresets: { items: agentItems, change: changeAgentPresets, error: agentPresetError },
        workflowStore: { items: workflowItems, change: changeWorkflows, initialRun: initialLocalRun,
          saveRun: saveLocalRun, saveAttachments: saveWorkflowAttachments, mixedRequest: native.mixedWorkflow,
          error: workflowError || localRunError } }) : null,
      chatLinkDialog ? h(ConversationLinkDialog, { onOpen: openChatLink, onClose: () => setChatLinkDialog(false) }) : null,
      searchOpen ? h(GlobalSearchDialog, { request: native.localSearch, onClose: () => setSearchOpen(false),
        onOpenConversation: openChatLink, onOpenWorkflow: openSearchWorkflow }) : null,
      h('div', { ref: settingsLayer, className: 'desktop-settings-surface' }));
  }
  root.render(h(DesktopApp));
} catch {
  root.render(h('p', { role: 'alert', className: 'standalone-start-error' }, t('工作台暂时无法读取本机设置。')));
}
