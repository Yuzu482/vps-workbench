import { afterPopupMotion } from './menu-motion.js';
import { menuIcon } from './menu-icons.js';
import { effortName } from './composer-controls.js';
import { accountGroups } from './account-routes.js';
import { accentOptions, defaultPreferences, preferenceOptions } from './workbench-preferences.js';

export const settingFields = [
  { key: 'host', label: 'VPS 主机' },
  { key: 'port', label: 'SSH 端口', type: 'number', min: 1, max: 65535 },
  { key: 'user', label: 'SSH 用户名' },
  { key: 'workspace', label: '远端项目目录' },
  { key: 'identityPath', label: 'SSH 私钥文件路径' },
  { key: 'knownHostsPath', label: 'known_hosts 文件路径' },
  { key: 'expectedIpv4', label: '预期 VPS 出口 IPv4' },
  { key: 'expectedIpv6', label: '预期 VPS 出口 IPv6（可选）', optional: true },
];
const fields = Object.fromEntries(settingFields.map(({ key, ...field }) => [key, field]));
export const defaultSettings = {
  host: '', port: '22', user: '', identityPath: '', knownHostsPath: '', workspace: '',
  expectedIpv4: '', expectedIpv6: '', hostKeyConfirmed: false, provider: 'codex',
};

export const connectionForm = (settings) => settings ? { ...settings, port: String(settings.port) } : defaultSettings;
export const editConnectionForm = (form, key, value) => ({
  ...form, [key]: value,
  ...(['host', 'port', 'knownHostsPath'].includes(key) ? { hostKeyConfirmed: false } : {}),
});
export function connectionSettings(form, provider = form.provider) {
  const values = Object.fromEntries(settingFields.map(({ key }) => [key, form[key].trim()]));
  return { ...values, port: Number(values.port), hostKeyConfirmed: form.hostKeyConfirmed, provider };
}
const formKey = (form) => JSON.stringify([form.provider, form.hostKeyConfirmed, ...settingFields.map(({ key }) => form[key])]);
const sameTools = (left, right) => left.length === right.length && left.every((id) => right.includes(id));

const pages = [
  ['connection', '连接', 'server'],
  ['tools', '执行端', 'model'],
  ['agents', 'Agent 预设', 'fork'],
  ['accounts', '账号', 'key'],
  ['appearance', '外观', 'canvas'],
  ['interaction', '交互', 'keyboard'],
];
const extensionPages = [
  ['mcp', 'MCP 服务器', 'server'],
  ['plugins', '插件', 'library'],
  ['memory', '长期记忆', 'context'],
];
const overridePage = ['tool-overrides', '按执行端覆盖', 'model'];
const desktopGroups = [
  ['connection', '连接', 'server', ['connection']],
  ['models', '模型与账号', 'model', ['tools', 'accounts']],
  ['agent', 'Agent 与工具', 'fork', ['agents', 'mcp', 'plugins']],
  ['memory', '记忆', 'library', ['memory']],
  ['preferences', '应用偏好', 'canvas', ['appearance', 'interaction', 'tool-overrides']],
];
const desktopLabels = { tools: '执行端与模型', accounts: '账号', plugins: '提示词模板' };
const locations = [['local-sdk', '本机 SDK'], ['ssh-vps', 'VPS SSH']];
const locationTabs = new Set(['connection', 'tools', 'accounts', 'agents', 'mcp', 'plugins', 'memory', 'tool-overrides']);
const noTools = [];
const appearanceRows = [
  ['color', '主题', '切换 VPS 对话的浅色或深色外观。'],
  ['textSize', '消息文字', '调整消息正文与输入框的字号。'],
  ['width', '对话宽度', '在宽窗口中放宽消息与输入框。'],
];
const interactionRows = [
  ['sendKey', '发送快捷键', '使用 Ctrl+Enter 时，Enter 用于换行。'],
  ['motion', '动画', '可减少菜单和工具切换时的动效。'],
];
const executorPreferenceRows = [
  ['color', '主题'], ['accent', '强调色'], ['textSize', '消息文字'],
  ['width', '对话宽度'], ['sendKey', '发送快捷键'], ['motion', '动画'],
];
const terminalPreferenceKeys = ['color', 'accent', 'motion'];
const preferencesForTool = (id) => id === 'claude-subscription'
  ? executorPreferenceRows.filter(([key]) => terminalPreferenceKeys.includes(key)) : executorPreferenceRows;
const accountProvider = (id) => id === 'claude-subscription' ? 'claude-sdk' : id;

function createDisclosure(React) {
  const h = React.createElement;
  return function Disclosure({ title, detail, value, children, name, className = '' }) {
    return h('details', { className: `vc-settings-disclosure vc-details-motion ${className}`, name },
      h('summary', null,
        h('span', { className: 'vc-settings-description' },
          h('strong', null, title), detail ? h('small', null, detail) : null),
        value ? h('span', { className: 'vc-settings-current' }, value) : null,
        h('i', { className: 'vc-settings-chevron', 'aria-hidden': true })),
      h('div', { className: 'vc-settings-disclosed' }, children));
  };
}

export function createConnectionFields(React) {
  const h = React.createElement;
  const Disclosure = createDisclosure(React);
  return function ConnectionSettings({ form, edit, busy, desktop = false }) {
    function field(key) {
      const { label, optional, ...attributes } = fields[key];
      return h('label', { key, className: 'vc-field' }, desktop && key === 'workspace' ? '工作目录' : label, h('input', {
        ...attributes, value: form[key], required: !optional, disabled: busy, autoComplete: 'off',
        spellCheck: false, maxLength: 2048, 'data-connection-field': key, onChange: (event) => edit(key, event.target.value),
      }));
    }
    return h(React.Fragment, null,
      h('section', { className: 'vc-settings-group' }, h('h4', null, '服务器'),
        h('div', { className: 'vc-settings-address' }, field('host'), field('port')),
        field('user'), desktop ? null : field('workspace')),
      desktop ? h('section', { className: 'vc-settings-group' }, h('h4', null, 'VPS 工作区'), field('workspace')) : null,
      h('section', { className: 'vc-settings-group' }, h('h4', null, 'SSH 验证'),
        field('identityPath'), field('knownHostsPath'),
        h('label', { className: 'vc-settings-confirm' },
          h('input', {
            type: 'checkbox', checked: form.hostKeyConfirmed, disabled: busy,
            onChange: (event) => edit('hostKeyConfirmed', event.target.checked),
          }),
          '我已核对这台 VPS 的 SSH 主机指纹与 known_hosts 文件。')),
      h('section', { className: 'vc-settings-group' }, h('h4', null, '出口校验'),
        field('expectedIpv4'),
        h(Disclosure, { title: 'IPv6 设置', value: form.expectedIpv6.trim() ? '已配置' : '可选' }, field('expectedIpv6'))));
  };
}

export function createSettingsDialog(React, { hostThemeLabel = '跟随 DSH' } = {}) {
  const h = React.createElement;
  const options = { ...preferenceOptions, color: preferenceOptions.color.map(([id, label]) =>
    [id, id === 'host' ? hostThemeLabel : label]) };
  const ConnectionSettings = createConnectionFields(React);
  const Disclosure = createDisclosure(React);
  const liveSave = () => h('span', { className: 'vc-settings-current vc-settings-save-hint' }, '实时保存');

  function PreferenceRows({ rows, values, change, disabled }) {
    return rows.map(([key, title, detail]) => h('div', { className: 'vc-preference-row', key },
      h('span', { className: 'vc-settings-description' }, h('strong', null, title), h('small', null, detail)),
      h('div', { className: 'vc-preference-options', role: 'group', 'aria-label': title },
        options[key].map(([id, label]) => h('button', {
          key: id, type: 'button', 'aria-pressed': values[key] === id, disabled, onClick: () => change({ [key]: id }),
        }, label)))));
  }

  function AccentOptions({ value, change, disabled }) {
    return h(Disclosure, {
      title: '强调色', detail: '用于按钮、选中状态和对话点缀。',
      value: accentOptions.find(({ id }) => id === value)?.label,
    }, h('div', { className: 'vc-accent-choices', role: 'group', 'aria-label': '强调色' },
      accentOptions.map(({ id, label, light }) => h('button', {
        key: id, type: 'button', disabled, 'aria-pressed': value === id,
        onClick: async (event) => {
          const details = event.currentTarget.closest('details');
          if (!await change({ accent: id }) || !details.isConnected) return;
          details.open = false;
          details.querySelector('summary').focus({ preventScroll: true });
        },
      }, h('i', { className: 'vc-accent-swatch', style: light && { background: light }, 'aria-hidden': true }), label))));
  }

  function ToolModelSettings({ id, model, readModels, change, busy, checked }) {
    const [loaded, setCatalog] = React.useState(null);
    const catalog = loaded ?? (checked?.model && { models: checked.models, targetId: checked.list.targetId });
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const request = React.useRef(null);
    React.useEffect(() => () => request.current?.abort(), []);
    async function load() {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setError('');
      setLoading(true);
      try {
        const next = await readModels(id, controller.signal);
        if (!controller.signal.aborted) setCatalog(next);
      } catch {
        if (!controller.signal.aborted) setError('暂时无法读取模型目录，请检查当前 VPS 和对应执行端。');
      } finally {
        request.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    const entry = catalog && model?.targetId === catalog.targetId
      ? catalog.models.find(item => item.id === model.id) : undefined;
    return h('div', { className: 'vc-tool-model' },
      h('div', { className: 'vc-preference-row' },
        h('span', { className: 'vc-settings-description' },
          h('strong', null, '默认模型', liveSave()),
          h('small', null, model ? `当前配置 · 已保存 ${model.id}` : '当前配置 · 沿用执行端默认。当前会话可另选模型。')),
        h('button', { type: 'button', className: 'vc-button vc-settings-outline', disabled: busy || loading, onClick: load },
          loading ? '正在读取' : catalog ? '刷新目录' : '读取模型目录')),
      error ? h('p', { className: 'vc-settings-inline-error', role: 'alert' }, error) : null,
      model && catalog && !entry ? h('p', { className: 'vc-settings-inline-error', role: 'status' },
        '已保存的模型与当前目录不匹配，可重新选择。') : null,
      catalog ? h('div', { className: 'vc-tool-profile-fields' },
        h('label', null, '模型',
          h('select', {
            'aria-label': '模型', disabled: busy, value: entry?.id ?? '',
            onChange: (event) => {
              const selected = catalog.models.find(item => item.id === event.target.value);
              change({ model: selected ? { id: selected.id, targetId: catalog.targetId, effort: selected.defaultEffort } : undefined });
            },
          }, h('option', { value: '' }, '使用执行端默认'),
          catalog.models.map(({ id, displayName }) => h('option', { key: id, value: id }, displayName)))),
        entry?.efforts.length ? h('label', null, '推理强度',
          h('select', {
            'aria-label': '推理强度', disabled: busy,
            value: entry.efforts.includes(model.effort) ? model.effort : entry.defaultEffort ?? '',
            onChange: (event) => change({ model: { ...model, effort: event.target.value || undefined } }),
          }, entry.defaultEffort === null ? h('option', { value: '' }, '使用模型默认') : null,
          entry.efforts.map(effort => h('option', { key: effort, value: effort }, effortName(effort))))) : null) : null);
  }

  function ToolPreferenceFields({ rows, profile, preferences, change, busy }) {
    return h('div', { className: 'vc-tool-profile-fields' },
        rows.map(([key, label]) => h('label', { key }, label,
          h('select', {
            'aria-label': label, value: profile[key] ?? '', disabled: busy,
            onChange: (event) => change({ [key]: event.target.value || undefined }),
          }, h('option', { value: '' }, `跟随通用 · ${options[key].find(([id]) => id === preferences[key])?.[1]}`),
          options[key].map(([value, label]) => h('option', { key: value, value }, label))))));
  }

  function ProfileReset({ keys, label, profile, change, busy }) {
    const [resetting, setResetting] = React.useState(false);
    return h('button', { type: 'button', className: 'vc-button vc-settings-outline',
      disabled: busy || resetting || !keys.some((key) => Object.hasOwn(profile, key)),
      async onClick(event) {
        const button = event.currentTarget;
        setResetting(true);
        try {
          if (await change(Object.fromEntries(keys.map((key) => [key, undefined]))) && button.isConnected &&
              (document.activeElement === button || document.activeElement === document.body)) {
            button.closest('details')?.querySelector('summary')?.focus({ preventScroll: true });
          }
        } finally { setResetting(false); }
      },
    }, label);
  }

  function ToolProfile({ tool, profile, preferences, change, readModels, canReadModels, busy, catalogCheck, scope, modelOnly }) {
    const rows = preferencesForTool(tool.id);
    return h(React.Fragment, null,
      h('p', { className: 'vc-tool-profile-note' }, tool.capabilities),
      !modelOnly && h(ToolPreferenceFields, { rows, profile, preferences, change, busy }),
      canReadModels ? h(ToolModelSettings, { key: scope, id: tool.id, model: profile.model, readModels, change, busy, checked: catalogCheck })
        : tool.modelCatalog ? h('p', { className: 'vc-tool-profile-note' }, '切换到「VPS 执行」后可读取此工具的模型。') : null,
      modelOnly ? tool.modelCatalog && h(ProfileReset, {
        keys: ['model'], label: '恢复默认模型与推理强度', profile, change, busy,
      }) : Object.keys(profile).length > 0 && h(ProfileReset, {
        keys: [...rows.map(([key]) => key), 'model'], label: '重置此工具设置', profile, change, busy,
      }));
  }

  function ToolOverrides({ tools, profiles, preferences, updateTool, busy }) {
    const group = React.useId();
    return h('div', { className: 'vc-tool-settings' }, tools.filter((tool) => tool.available).map((tool) => {
      const profile = profiles[tool.id] ?? {};
      const rows = preferencesForTool(tool.id);
      const keys = rows.map(([key]) => key);
      const change = (patch) => updateTool(tool.id, patch);
      return h(Disclosure, { key: tool.id, title: `${tool.label} 界面偏好`, name: group,
        value: keys.some((key) => Object.hasOwn(profile, key)) ? '已覆盖' : '跟随通用',
      }, h(ToolPreferenceFields, { rows, profile, preferences, change, busy }),
      h(ProfileReset, { keys, label: '恢复通用偏好', profile, change, busy }));
    }));
  }

  function ToolSettings({ tools, configured, setConfigured, profiles, preferences, updateTool, readModels, modelTools, activeTool, busy,
    diagnostics, scope, openBackendAccount }) {
    const group = React.useId();
    return h('fieldset', { className: 'vc-tool-settings', 'aria-label': '配置执行端' },
      tools.map(tool => {
        const { id, label, icon, setup, available } = tool;
        const checked = configured.includes(id);
        const profile = profiles[id] ?? {};
        const verification = diagnostics?.resultFor(id);
        return h('div', { key: id, className: 'vc-tool-config', 'data-settings-backend': id },
          h('label', {
            className: 'vc-tool-setting', 'data-tool-theme': id, 'data-configured': checked, 'data-available': available,
          }, menuIcon(h, icon), h('span', { className: 'vc-settings-description' },
            h('span', { className: 'vc-tool-setting-name' },
              label, id === activeTool ? h('span', { className: 'vc-tool-in-use' }, '使用中') : null),
            h('small', null, available ? setup : '原生终端插件未加载。'),
            diagnostics && tool.modelCatalog && h('small', null, verification?.results.model?.detail ??
              (profile.model ? '默认模型 · ' + profile.model.id : '模型目录未检查'))),
          h('input', {
            type: 'checkbox', className: 'vc-tool-toggle', 'aria-label': label, checked, disabled: busy || !available,
            onChange: (event) => {
              const enabled = event.target.checked;
              setConfigured(previous => enabled ? [...previous, id] : previous.filter(value => value !== id));
            },
          })),
          available ? h(Disclosure, {
            title: `${label} 独立设置`, className: 'vc-tool-disclosure', name: group,
            value: openBackendAccount ? profile.model ? '已设置模型' : '默认模型' :
              Object.keys(profile).length ? '已自定义' : '跟随通用',
          }, h(ToolProfile, {
            tool, profile, preferences, change: patch => updateTool(id, patch),
            readModels, canReadModels: modelTools.includes(id), busy, catalogCheck: verification?.checked, scope,
            modelOnly: Boolean(openBackendAccount),
          }), openBackendAccount && h('button', { type: 'button', className: 'vc-button vc-settings-outline',
            disabled: busy, onClick: () => openBackendAccount(accountProvider(id)) }, '查看此执行端账号')) : null);
      }));
  }

  function AccountSettings({ available, openAccount, remoteEnabled, diagnostics, openBackendModel }) {
    return h('div', { className: 'vc-account-groups' },
      !available ? h('p', { className: 'vc-account-availability', role: 'status' }, remoteEnabled
        ? '请先连接已核对指纹的默认 VPS。' : '请在输入栏的访问权限中切换为 VPS 执行。') : null,
      accountGroups.map(({ id, label, icon, detail, actions }) => {
        const provider = accountProvider(id);
        const result = diagnostics?.resultFor(provider);
        const account = result?.results.account;
        const manual = result?.checked?.manualTarget;
        const checked = account?.detail ?? result?.results.egress?.detail ?? result?.results.ssh?.detail;
        return h('section', { key: id, className: 'vc-account-group', 'aria-label': label,
          'data-settings-backend': provider, tabIndex: -1 },
          h('div', { className: 'vc-account-group-heading' }, menuIcon(h, icon),
            h('span', { className: 'vc-settings-description' }, h('strong', null, label), h('small', null, detail),
              diagnostics && h('small', { role: 'status' }, checked || '账号未检查'))),
          h('div', { className: 'vc-account-actions' },
          openBackendModel && h('button', { type: 'button', className: 'vc-button vc-settings-outline',
            onClick: () => openBackendModel(provider) }, '查看此执行端模型'),
          diagnostics && h('button', {
            type: 'button', className: 'vc-button vc-settings-outline', disabled: !available || diagnostics.checking,
            onClick: () => void diagnostics.test(manual, provider),
          }, manual ? '已在 VPS 登录，继续检查' : '检查账号和目录'), actions.map(action => h('button', {
            key: action.id, type: 'button', className: 'vc-button vc-settings-outline',
            disabled: !available, onClick: () => openAccount(action.id),
          }, action.label))));
      }));
  }

  return function SettingsDialog({ settings, tab: openTab, visit, scope, setTab, ready, name, tools = noTools, activeTool, savedTools = noTools,
    toolKey, error, busy, close, openSetup,
    saveConnection, saveTools, preferences, updatePreferences, profiles, updateTool, readModels, modelTools, openAccount,
    remoteEnabled = true, extensionSettings, agentSettings, VpsConnectionChecks, connectionDiagnostics, pinConfirmationRequired,
    navigateLocation, localPanels, settingsLabel = 'VPS 设置', focusFallback, restoreFocus }) {
    const dialog = React.useRef(null);
    const confirmDialog = React.useRef(null);
    const pointerOutside = React.useRef(false);
    const [lastTab, setLastTab] = React.useState(false);
    const tab = openTab || lastTab;
    const grouped = Boolean(navigateLocation || localPanels || VpsConnectionChecks);
    const location = localPanels ? 'local-sdk' : 'ssh-vps';
    const available = ([id]) => !['mcp', 'plugins', 'memory'].includes(id) || extensionSettings || localPanels?.[id];
    const tabs = [...pages, ...extensionPages, ...(grouped ? [overridePage] : [])].filter(([id]) => (id !== 'agents' || agentSettings || localPanels))
      .filter(available);
    const group = desktopGroups.find(([, , , ids]) => ids.includes(tab));
    const subtabs = group && tabs.filter(([id]) => group[3].includes(id));
    const scroll = React.useRef(null);
    const backendJump = React.useRef(null);
    const titleId = React.useId();
    const confirmId = React.useId();
    const panelId = React.useId();
    const [connectionDraft, setConnectionDraft] = React.useState(null);
    const [toolsDraft, setToolsDraft] = React.useState(null);
    const [transition, setTransition] = React.useState(null);
    const [draftError, setDraftError] = React.useState('');
    const [preferenceSaved, setPreferenceSaved] = React.useState(false);
    const preferenceChange = React.useRef(0);
    const [saving, setSaving] = React.useState(false);
    const write = React.useRef(false);
    const savedForm = connectionForm(settings);
    const origin = JSON.stringify([scope, formKey(savedForm)]);
    const pinChanged = pinConfirmationRequired || connectionDiagnostics?.current?.results.ssh?.code === 'target_changed';
    const editedForm = connectionDraft?.value ?? savedForm;
    const form = pinChanged && !connectionDraft?.pinConfirmedAgain ? { ...editedForm, hostKeyConfirmed: false } : editedForm;
    const configured = toolsDraft?.value ?? savedTools;
    const locked = busy || saving;
    const dirty = Boolean(connectionDraft || toolsDraft);
    const connectionDirty = Boolean(connectionDraft);
    const prefPage = tab === 'appearance' || tab === 'interaction';
    const savePage = !localPanels && (tab === 'connection' || tab === 'tools');
    const preferenceKeys = tab === 'appearance' ? ['color', 'accent', 'textSize', 'width'] : ['sendKey', 'motion'];
    const canReset = preferenceKeys.some(key => preferences[key] !== defaultPreferences[key]);
    const saveAllowed = form.hostKeyConfirmed && settingFields.every(({ key, optional }) => optional || form[key].trim()) &&
      Number.isInteger(Number(form.port)) && Number(form.port) >= 1 && Number(form.port) <= 65535;

    React.useLayoutEffect(() => {
      const element = dialog.current;
      if (openTab) {
        setLastTab(openTab);
        if (!element.open) {
          setPreferenceSaved(false);
          element.showModal();
          (element.querySelector('.vc-settings-nav [aria-current]') ?? element.querySelector('.vc-settings-close'))
            ?.focus({ preventScroll: true });
        }
      } else if (element.open) {
        element.close();
        if (restoreFocus) restoreFocus();
        else if (document.activeElement === document.body) focusFallback?.();
        return afterPopupMotion(element, () => setLastTab(false));
      }
    }, [openTab, visit]);

    React.useLayoutEffect(() => {
      if (!transition) return;
      confirmDialog.current.showModal();
      confirmDialog.current.querySelector('[data-continue-editing]').focus({ preventScroll: true });
    }, [transition]);
    React.useLayoutEffect(() => {
      if (!scroll.current) return;
      scroll.current.scrollTop = 0;
      if (!backendJump.current) return;
      const target = Array.from(scroll.current.querySelectorAll('[data-settings-backend]'))
        .find((element) => element.dataset.settingsBackend === backendJump.current);
      backendJump.current = null;
      const details = target?.querySelector('details');
      if (details) details.open = true;
      (details?.querySelector('summary') ?? target)?.focus();
    }, [tab]);

    function edit(key, value) {
      if (locked) return;
      connectionDiagnostics?.clear();
      setDraftError('');
      setConnectionDraft((previous) => {
        const next = editConnectionForm(form, key, value);
        const base = previous?.origin ?? origin;
        const pinConfirmedAgain = key === 'hostKeyConfirmed' ? value : next.hostKeyConfirmed && previous?.pinConfirmedAgain;
        return base === origin && formKey(next) === formKey(savedForm) && !pinConfirmedAgain
          ? null : { value: next, origin: base, pinConfirmedAgain };
      });
    }

    function setConfigured(update) {
      setDraftError('');
      setToolsDraft((previous) => {
        const next = update(previous?.value ?? savedTools);
        const key = previous?.key ?? toolKey;
        return key === toolKey && sameTools(next, savedTools) ? null : { value: next, key };
      });
    }

    async function persistDrafts({ connection = false, tools = false } = {}) {
      if (locked || write.current) return false;
      setDraftError('');
      if (tools && toolsDraft && (!ready || toolsDraft.key !== toolKey)) {
        setDraftError('执行端草稿属于先前的 VPS 配置。请回到该连接后保存。');
        return false;
      }
      if (connection && connectionDraft && connectionDraft.origin !== origin) {
        setDraftError('连接已变化，草稿仍属于先前的配置。请返回原连接或先放弃此草稿。');
        return false;
      }
      if (connection && !saveAllowed) {
        setDraftError('请填写连接信息，并核对 SSH 主机指纹后保存。');
        return false;
      }
      write.current = true;
      setSaving(true);
      try {
        if (tools && toolsDraft) {
          if (!await saveTools(toolsDraft.value, toolsDraft.key)) return false;
          setToolsDraft(null);
        }
        if (connection) {
          if (!await saveConnection(connectionSettings(form), { pinConfirmedAgain: connectionDraft?.pinConfirmedAgain })) return false;
          setConnectionDraft(null);
        }
        return true;
      } finally {
        write.current = false;
        setSaving(false);
      }
    }

    function requestTransition(proceed, trigger = document.activeElement, onlyTools = false) {
      if (locked || write.current || transition) return;
      if (onlyTools ? toolsDraft : dirty) {
        setDraftError('');
        setTransition({ proceed, trigger, onlyTools });
      } else void proceed();
    }

    function closeTransition(restoreFocus) {
      confirmDialog.current.close();
      setTransition(null);
      if (restoreFocus) transition.trigger?.focus({ preventScroll: true });
    }

    async function resolveTransition(save) {
      if (locked || write.current) return;
      const { proceed, onlyTools } = transition;
      if (save) {
        if (!await persistDrafts({ connection: !onlyTools && connectionDirty, tools: Boolean(toolsDraft) })) return;
      } else {
        setToolsDraft(null);
        if (!onlyTools) setConnectionDraft(null);
      }
      closeTransition(false);
      await proceed();
    }

    function onCancel(event) {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      if (locked) return;
      const focused = document.activeElement?.closest('details[open]');
      const details = focused && dialog.current.contains(focused) ? focused : scroll.current?.querySelector('details[open]');
      if (details) {
        details.open = false;
        details.querySelector('summary').focus({ preventScroll: true });
      } else requestTransition(close);
    }

    async function submit(event) {
      event.preventDefault();
      if (locked || !openTab || !savePage) return;
      if (tab === 'tools') {
        const saved = await persistDrafts({ tools: true });
        if (saved && !connectionDirty) close();
      } else {
        requestTransition(() => persistDrafts({ connection: true }), event.nativeEvent.submitter, true);
      }
    }

    function focusField(key) {
      const input = scroll.current.querySelector(`[data-connection-field="${key}"]`);
      if (input) input.focus();
    }

    const header = {
      connection: localPanels ? ['本机 SDK 连接', '本机 Codex 进程使用 Windows 网络。'] :
        ['VPS 连接', ready ? name || '当前连接' : '填写服务器与 SSH 验证信息以连接 VPS。'],
      tools: localPanels ? ['Codex 模型', '默认模型随本机配置保存。历史会话继续使用原配置。'] :
        ['执行端', '保存启用变更后，所选执行端会出现在当前 VPS 的切换菜单。独立设置实时保存。'],
      agents: ['Agent 预设', '保存常用的执行端、模型和角色指令，供工作流各阶段选用。'],
      accounts: localPanels ? ['本机 Codex 账号', '查看本机凭据与模型服务状态。'] :
        ['账号管理', '官方页面和执行端登录都在当前 VPS 的操作窗口中打开。'],
      appearance: ['外观', '应用偏好 · 执行端的独立设置优先生效。'],
      interaction: ['交互', '应用偏好 · 输入与动画设置。执行端的独立设置优先生效。'],
      'tool-overrides': ['按执行端覆盖', '为当前执行位置单独设置外观和交互。'],
      mcp: ['MCP 服务器', '为当前执行端选择已审核的 stdio 服务。'],
      plugins: [grouped ? '提示词模板' : '插件', '管理可插入输入栏的提示词模板。'],
      memory: ['长期记忆', '将选定的参考内容用于当前 VPS 和项目的后续对话。'],
    }[tab];
    const customPanel = extensionSettings && extensionPages.some(([id]) => id === tab);
    function showBackend(id, page) {
      backendJump.current = id;
      setTab(page);
    }
    function guardedAccount(action) { requestTransition(() => openAccount(action)); }
    async function changePreferences(patch) {
      const writing = ++preferenceChange.current;
      setPreferenceSaved(false);
      const saved = await updatePreferences(patch);
      if (preferenceChange.current === writing) setPreferenceSaved(saved);
      return saved;
    }
    return h('dialog', {
      ref: dialog, className: 'vc-settings vc-workbench-settings vc-popup-motion', 'aria-labelledby': titleId, onCancel,
      onPointerDown: (event) => { pointerOutside.current = event.target === event.currentTarget; },
      onClick: (event) => {
        if (pointerOutside.current && event.target === event.currentTarget) requestTransition(close);
      },
    }, tab ? h(React.Fragment, null,
      h('header', { className: 'vc-settings-header' }, h('h2', { id: titleId }, settingsLabel),
        dirty && h('span', { className: 'vc-settings-unsaved', role: 'status' }, '有未保存的设置'),
        openSetup ? h('button', { type: 'button', className: 'vc-button vc-setup-entry', disabled: locked,
          onClick: (event) => requestTransition(openSetup, event.currentTarget) }, menuIcon(h, 'server'), '接入向导') : null,
        h('button', { type: 'button', className: 'vc-button vc-settings-close', 'aria-label': '关闭设置', disabled: locked,
          onClick: (event) => requestTransition(close, event.currentTarget) }, '×')),
      h('div', { className: 'vc-settings-layout' },
      h('nav', { className: 'vc-settings-nav', 'aria-label': grouped ? '设置分类' : 'VPS 设置分类' },
        (grouped ? desktopGroups : tabs).map(([id, label, icon, ids]) => {
          const first = ids ? ids.find((item) => tabs.some(([key]) => key === item)) : id;
          return h('button', {
            key: id, type: 'button', className: 'vc-button', 'aria-current': (grouped ? group?.[0] === id : tab === id) ? 'page' : undefined,
            disabled: locked || !first || (!grouped && id === 'tools' && !ready && !toolsDraft),
            onClick: () => setTab(first),
          }, menuIcon(h, icon), label);
        })),
      h(localPanels ? 'div' : 'form', { className: 'vc-settings-form', onSubmit: localPanels ? undefined : submit },
        h('div', { className: 'vc-settings-scroll', ref: scroll },
          grouped && subtabs?.length > 1 ? h('nav', { className: 'vc-settings-subnav', 'aria-label': group[1] + '选项' },
            subtabs.map(([id, label]) => h('button', {
              key: id, type: 'button', className: 'vc-button', 'aria-current': tab === id ? 'page' : undefined,
              disabled: locked, onClick: () => setTab(id),
            }, desktopLabels[id] ?? label))) : null,
          h('section', { key: tab, className: 'vc-settings-pane', 'aria-labelledby': panelId },
            h('h3', { id: panelId, 'aria-label': header[0] }, header[0], prefPage ? liveSave() : null),
            localPanels && ['agents', 'mcp', 'plugins', 'memory', 'tool-overrides'].includes(tab) ? null
              : h('p', { className: 'vc-settings-intro' }, header[1]),
            grouped && navigateLocation && locationTabs.has(tab) ?
              h('div', { className: 'vc-settings-subnav vc-settings-locations', role: 'group', 'aria-label': '配置的执行位置' },
                locations.map(([id, label]) => h('button', { key: id, type: 'button', className: 'vc-button',
                  'aria-pressed': location === id, disabled: locked,
                  onClick: (event) => {
                    if (id !== location) requestTransition(() => navigateLocation(id, tab), event.currentTarget);
                  },
                }, label))) : null,
            localPanels?.[tab] ?? null,
            !localPanels && tab === 'connection' ? h(React.Fragment, null,
              VpsConnectionChecks && h('p', { className: 'vc-settings-current', role: 'status' },
                connectionDirty ? '连接配置未保存' : !ready ? '连接尚未保存' :
                  name === '本机保存的 VPS' ? '连接配置已保存' : '已载入 VPS 预设'),
              pinChanged && !form.hostKeyConfirmed ? h('p', { className: 'vc-feedback', role: 'alert' },
                '请重新核对 SSH 主机指纹并保存连接。') : null,
              VpsConnectionChecks && h(VpsConnectionChecks, { diagnostics: connectionDiagnostics, ready, dirty: connectionDirty,
                busy: locked, remoteEnabled, provider: form.provider, openAccount: guardedAccount,
                openTools: () => setTab('tools'), focusField }),
              h(ConnectionSettings, { form, edit, busy: locked, desktop: grouped })) : null,
            !localPanels && tab === 'tools' ? ready ? h(ToolSettings, {
              tools, configured, setConfigured, profiles, preferences, updateTool, readModels, modelTools, activeTool, busy: locked,
              diagnostics: connectionDiagnostics, scope: origin,
              openBackendAccount: grouped ? (id) => showBackend(id, 'accounts') : undefined,
            }) : h('p', { role: 'status' }, '保存 VPS 连接后可配置执行端与模型。') : null,
            tab === 'agents' && agentSettings ? h(agentSettings.Component, { ...agentSettings.props, busy }) : null,
            !localPanels && tab === 'accounts' ? h(AccountSettings, { available: remoteEnabled && ready && !locked && settings?.hostKeyConfirmed,
              openAccount: guardedAccount, remoteEnabled,
              diagnostics: !connectionDirty ? connectionDiagnostics : null,
              openBackendModel: grouped && ready ? (id) => showBackend(id, 'tools') : undefined }) : null,
            tab === 'appearance' ? h(React.Fragment, null,
              h(PreferenceRows, { rows: appearanceRows.slice(0, 1), values: preferences, change: changePreferences, disabled: locked }),
              h(AccentOptions, { value: preferences.accent, change: changePreferences, disabled: locked }),
              h(PreferenceRows, { rows: appearanceRows.slice(1), values: preferences, change: changePreferences, disabled: locked })) : null,
            tab === 'interaction' ? h(PreferenceRows, {
              rows: interactionRows, values: preferences, change: changePreferences, disabled: locked,
            }) : null,
            !localPanels && tab === 'tool-overrides' ? ready
              ? h(ToolOverrides, { tools, profiles, preferences, updateTool, busy: locked })
              : h('p', { role: 'status' }, '保存 VPS SSH 配置后可设置执行端偏好。') : null,
            customPanel ? h(extensionSettings.Component, { ...extensionSettings.props, section: tab,
              busy: busy || extensionSettings.props.busy }) : null)),
        h('footer', { className: 'vc-settings-footer' },
          draftError || error ? h('div', { className: 'vc-feedback', role: 'alert' }, draftError || error) : null,
          prefPage && preferenceSaved ? h('p', { className: 'vc-settings-current', role: 'status' }, '应用偏好已保存') : null,
          h('div', { className: 'vc-dialog-actions' },
            prefPage ? h('button', {
              type: 'button', className: 'vc-button vc-settings-outline', disabled: locked || !canReset,
              onClick: () => changePreferences(Object.fromEntries(preferenceKeys.map(key => [key, defaultPreferences[key]]))),
            }, '恢复默认') : null,
            h('button', {
              type: 'button', className: `vc-button ${savePage ? 'vc-settings-outline' : 'vc-primary'}`, disabled: locked,
              onClick(event) {
                if (tab === 'tools' && toolsDraft) {
                  setToolsDraft(null);
                  setDraftError('');
                  if (!connectionDirty) close();
                } else requestTransition(close, event.currentTarget);
              },
            }, tab === 'tools' && toolsDraft ? '放弃启用变更' : '完成'),
            tab === 'connection' && connectionDirty ? h('button', {
              type: 'button', className: 'vc-button vc-settings-outline', disabled: locked,
              onClick: () => { setConnectionDraft(null); setDraftError(''); },
            }, '放弃连接变更') : null,
            savePage ? h('button', {
              type: 'submit', className: 'vc-button vc-primary', disabled: locked || (tab === 'tools' ? !ready || !toolsDraft : !saveAllowed),
            }, tab === 'tools' ? '保存启用变更' : VpsConnectionChecks ? '保存连接配置' : '使用此 VPS') : null)))),
      transition ? h('dialog', { ref: confirmDialog, className: 'vc-settings-confirm-dialog vc-popup-motion',
        'aria-labelledby': confirmId, onCancel(event) {
          event.preventDefault();
          event.stopPropagation();
          if (!locked) closeTransition(true);
        } },
        h('h2', { id: confirmId }, '有未保存的设置'),
        h('p', null, transition.onlyTools ? '请先处理原连接的执行端启用变更。' :
          '保存连接配置和执行端启用变更，或放弃这些编辑后继续。'),
        draftError || error ? h('p', { className: 'vc-feedback', role: 'alert' }, draftError || error) : null,
        h('div', { className: 'vc-dialog-actions' },
          h('button', { type: 'button', className: 'vc-button vc-settings-outline', 'data-continue-editing': '',
            disabled: locked, onClick: () => closeTransition(true) }, '继续编辑'),
          h('button', { type: 'button', className: 'vc-button vc-settings-outline', disabled: locked,
            onClick: () => void resolveTransition(false) }, '放弃修改'),
          h('button', { type: 'button', className: 'vc-button vc-primary', disabled: locked,
            onClick: () => void resolveTransition(true) }, '保存并继续'))) : null) : null);
  };
}
