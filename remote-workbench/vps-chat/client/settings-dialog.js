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
const appearanceRows = [
  ['color', '主题', '切换 VPS 对话的浅色或深色外观。'],
  ['textSize', '消息文字', '调整消息正文与输入框的字号。'],
  ['width', '对话宽度', '在宽窗口中放宽消息与输入框。'],
];
const interactionRows = [
  ['sendKey', '发送快捷键', '使用 Ctrl+Enter 时，Enter 用于换行。'],
  ['motion', '动画', '可减少菜单和工具切换时的动效。'],
];

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
  return function ConnectionSettings({ form, edit, busy }) {
    function field(key) {
      const { label, optional, ...attributes } = fields[key];
      return h('label', { key, className: 'vc-field' }, label, h('input', {
        ...attributes, value: form[key], required: !optional, disabled: busy, autoComplete: 'off',
        spellCheck: false, maxLength: 2048, onChange: (event) => edit(key, event.target.value),
      }));
    }
    return h(React.Fragment, null,
      h('section', { className: 'vc-settings-group' }, h('h4', null, '服务器'),
        h('div', { className: 'vc-settings-address' }, field('host'), field('port')),
        field('user'), field('workspace')),
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
        onClick: (event) => {
          if (!change({ accent: id })) return;
          const details = event.currentTarget.closest('details');
          details.open = false;
          details.querySelector('summary').focus({ preventScroll: true });
        },
      }, h('i', { className: 'vc-accent-swatch', style: light && { background: light }, 'aria-hidden': true }), label))));
  }

  function ToolModelSettings({ id, model, readModels, change, busy }) {
    const [catalog, setCatalog] = React.useState(null);
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
          h('small', null, model ? `已保存 ${model.id}` : '由 VPS 或当前会话决定。')),
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
          }, h('option', { value: '' }, '沿用会话设置'),
          catalog.models.map(({ id, displayName }) => h('option', { key: id, value: id }, displayName)))),
        entry?.efforts.length ? h('label', null, '推理强度',
          h('select', {
            'aria-label': '推理强度', disabled: busy,
            value: entry.efforts.includes(model.effort) ? model.effort : entry.defaultEffort ?? '',
            onChange: (event) => change({ model: { ...model, effort: event.target.value || undefined } }),
          }, entry.defaultEffort === null ? h('option', { value: '' }, '使用模型默认') : null,
          entry.efforts.map(effort => h('option', { key: effort, value: effort }, effortName(effort))))) : null) : null);
  }

  function ToolProfile({ tool, profile, preferences, change, readModels, canReadModels, busy }) {
    const rows = [
      ['color', '主题'], ['accent', '强调色'],
      ...(tool.id === 'claude-subscription' ? [] : [['textSize', '消息文字'], ['width', '对话宽度'], ['sendKey', '发送快捷键']]),
      ['motion', '动画'],
    ];
    function reset(event) {
      const keys = [...rows.map(([key]) => key), 'model'];
      if (change(Object.fromEntries(keys.map(key => [key, undefined])))) {
        event.currentTarget.closest('details').querySelector('summary').focus();
      }
    }
    return h(React.Fragment, null,
      h('p', { className: 'vc-tool-profile-note' }, tool.capabilities),
      h('div', { className: 'vc-tool-profile-fields' },
        rows.map(([key, label]) => h('label', { key }, label,
          h('select', {
            'aria-label': label, value: profile[key] ?? '', disabled: busy,
            onChange: (event) => change({ [key]: event.target.value || undefined }),
          }, h('option', { value: '' }, `跟随通用 · ${options[key].find(([id]) => id === preferences[key])?.[1]}`),
          options[key].map(([value, label]) => h('option', { key: value, value }, label)))))),
      canReadModels ? h(ToolModelSettings, { id: tool.id, model: profile.model, readModels, change, busy })
        : tool.modelCatalog ? h('p', { className: 'vc-tool-profile-note' }, '切换到「VPS 执行」后可读取此工具的模型。') : null,
      Object.keys(profile).length ? h('button', {
        type: 'button', className: 'vc-button vc-settings-outline', disabled: busy, onClick: reset,
      }, '重置此工具设置') : null);
  }

  function ToolSettings({ tools, configured, setConfigured, profiles, preferences, updateTool, readModels, modelTools, activeTool, busy }) {
    const group = React.useId();
    return h('fieldset', { className: 'vc-tool-settings', 'aria-label': '配置执行端' },
      tools.map(tool => {
        const { id, label, icon, setup, available } = tool;
        const checked = configured.includes(id);
        const profile = profiles[id] ?? {};
        return h('div', { key: id, className: 'vc-tool-config' },
          h('label', {
            className: 'vc-tool-setting', 'data-tool-theme': id, 'data-configured': checked, 'data-available': available,
          }, menuIcon(h, icon), h('span', { className: 'vc-settings-description' },
            h('span', { className: 'vc-tool-setting-name' },
              label, id === activeTool ? h('span', { className: 'vc-tool-in-use' }, '使用中') : null),
            h('small', null, available ? setup : '原生终端插件未加载。')),
          h('input', {
            type: 'checkbox', className: 'vc-tool-toggle', 'aria-label': label, checked, disabled: busy || !available,
            onChange: (event) => {
              const enabled = event.target.checked;
              setConfigured(previous => enabled ? [...previous, id] : previous.filter(value => value !== id));
            },
          })),
          available ? h(Disclosure, {
            title: `${label} 独立设置`, className: 'vc-tool-disclosure', name: group,
            value: Object.keys(profile).length ? '已自定义' : '跟随通用',
          }, h(ToolProfile, {
            tool, profile, preferences, change: patch => updateTool(id, patch),
            readModels, canReadModels: modelTools.includes(id), busy,
          })) : null);
      }));
  }

  function AccountSettings({ available, openAccount, remoteEnabled }) {
    return h('div', { className: 'vc-account-groups' },
      !available ? h('p', { className: 'vc-account-availability', role: 'status' }, remoteEnabled
        ? '请先连接已核对指纹的默认 VPS。' : '请在输入栏的访问权限中切换为 VPS 执行。') : null,
      accountGroups.map(({ id, label, icon, detail, actions }) =>
        h('section', { key: id, className: 'vc-account-group', 'aria-label': label },
          h('div', { className: 'vc-account-group-heading' }, menuIcon(h, icon),
            h('span', { className: 'vc-settings-description' }, h('strong', null, label), h('small', null, detail))),
          h('div', { className: 'vc-account-actions' }, actions.map(action => h('button', {
            key: action.id, type: 'button', className: 'vc-button vc-settings-outline',
            disabled: !available, onClick: () => openAccount(action.id),
          }, action.label))))));
  }

  function Session({ settings, tab, setTab, ready, name, tools, activeTool, savedTools, error, busy, close,
    saveConnection, saveTools, preferences, updatePreferences, profiles, updateTool, readModels, modelTools, openAccount,
    remoteEnabled = true, extensionSettings, agentSettings }) {
    const [form, setForm] = React.useState(() => connectionForm(settings));
    const [configured, setConfigured] = React.useState(savedTools);
    const scroll = React.useRef(null);
    const panelId = React.useId();
    const prefPage = tab === 'appearance' || tab === 'interaction';
    const savePage = tab === 'connection' || tab === 'tools';
    const preferenceKeys = tab === 'appearance' ? ['color', 'accent', 'textSize', 'width'] : ['sendKey', 'motion'];
    const canReset = preferenceKeys.some(key => preferences[key] !== defaultPreferences[key]);

    React.useLayoutEffect(() => { scroll.current.scrollTop = 0; }, [tab]);

    function edit(key, value) {
      setForm(previous => editConnectionForm(previous, key, value));
    }

    function submit(event) {
      event.preventDefault();
      if (busy || !savePage) return;
      if (tab === 'tools') {
        if (ready) saveTools(configured);
      } else if (form.hostKeyConfirmed) {
        saveConnection(connectionSettings(form));
      }
    }

    const header = {
      connection: ['VPS 连接', ready ? name || '当前连接' : '填写服务器与 SSH 验证信息以连接 VPS。'],
      tools: ['执行端', '保存启用变更后，所选执行端会出现在当前 VPS 的切换菜单。独立设置实时保存。'],
      agents: ['Agent 预设', '保存常用的执行端、模型和角色指令，供工作流各阶段选用。'],
      accounts: ['账号管理', '官方页面和执行端登录都在默认 VPS 的操作窗口中打开。'],
      appearance: ['外观', '本机通用外观。执行端的独立设置优先生效。'],
      interaction: ['交互', '本机通用输入与动画偏好。执行端的独立设置优先生效。'],
      mcp: ['MCP 服务器', '为当前执行端选择 VPS 上已审核的 stdio 服务。'],
      plugins: ['插件', '管理可插入输入栏的提示词模板。'],
      memory: ['长期记忆', '将选定的参考内容用于当前 VPS 和项目的后续 Codex 消息。'],
    }[tab];
    const customPanel = extensionSettings && extensionPages.some(([id]) => id === tab);
    return h('div', { className: 'vc-settings-layout' },
      h('nav', { className: 'vc-settings-nav', 'aria-label': 'VPS 设置分类' },
        (extensionSettings ? [...pages, ...extensionPages] : pages).filter(([id]) => id !== 'agents' || agentSettings)
          .map(([id, label, icon]) => h('button', {
          key: id, type: 'button', className: 'vc-button', 'aria-current': tab === id ? 'page' : undefined,
          disabled: busy || (id === 'tools' && !ready), onClick: () => setTab(id),
        }, menuIcon(h, icon), label))),
      h('form', { className: 'vc-settings-form', onSubmit: submit },
        h('div', { className: 'vc-settings-scroll', ref: scroll },
          h('section', { key: tab, className: 'vc-settings-pane', 'aria-labelledby': panelId },
            h('h3', { id: panelId, 'aria-label': header[0] }, header[0], prefPage ? liveSave() : null),
            h('p', { className: 'vc-settings-intro' }, header[1]),
            tab === 'connection' ? h(ConnectionSettings, { form, edit, busy }) : null,
            tab === 'tools' ? h(ToolSettings, {
              tools, configured, setConfigured, profiles, preferences, updateTool, readModels, modelTools, activeTool, busy,
            }) : null,
            tab === 'agents' && agentSettings ? h(agentSettings.Component, { ...agentSettings.props, busy }) : null,
            tab === 'accounts' ? h(AccountSettings, { available: remoteEnabled && ready && !busy && settings?.hostKeyConfirmed,
              openAccount, remoteEnabled }) : null,
            tab === 'appearance' ? h(React.Fragment, null,
              h(PreferenceRows, { rows: appearanceRows.slice(0, 1), values: preferences, change: updatePreferences, disabled: busy }),
              h(AccentOptions, { value: preferences.accent, change: updatePreferences, disabled: busy }),
              h(PreferenceRows, { rows: appearanceRows.slice(1), values: preferences, change: updatePreferences, disabled: busy })) : null,
            tab === 'interaction' ? h(PreferenceRows, {
              rows: interactionRows, values: preferences, change: updatePreferences, disabled: busy,
            }) : null,
            customPanel ? h(extensionSettings.Component, { ...extensionSettings.props, section: tab,
              busy: busy || extensionSettings.props.busy }) : null)),
        h('footer', { className: 'vc-settings-footer' },
          error ? h('div', { className: 'vc-feedback', role: 'alert' }, error) : null,
          h('div', { className: 'vc-dialog-actions' },
            prefPage ? h('button', {
              type: 'button', className: 'vc-button vc-settings-outline', disabled: busy || !canReset,
              onClick: () => updatePreferences(Object.fromEntries(preferenceKeys.map(key => [key, defaultPreferences[key]]))),
            }, '恢复默认') : null,
            h('button', {
              type: 'button', className: `vc-button ${savePage ? 'vc-settings-outline' : 'vc-primary'}`, disabled: busy,
              onClick() {
                if (tab === 'tools') setConfigured(savedTools);
                close();
              },
            }, tab === 'tools' ? '放弃启用变更' : savePage ? '取消' : '完成'),
            savePage ? h('button', {
              type: 'submit', className: 'vc-button vc-primary', disabled: busy || (tab === 'tools' ? !ready : !form.hostKeyConfirmed),
            }, tab === 'tools' ? '保存启用变更' : busy ? '正在检查设置' : '使用此 VPS') : null))));
  }

  return function SettingsDialog(props) {
    const { tab, visit, scope, busy, close, openSetup } = props;
    const ref = React.useRef(null);
    const pointerOutside = React.useRef(false);
    const titleId = React.useId();
    const [lastTab, setLastTab] = React.useState(false);
    const shownTab = tab || lastTab;

    React.useLayoutEffect(() => {
      const dialog = ref.current;
      if (tab) {
        setLastTab(tab);
        if (!dialog.open) {
          dialog.showModal();
          (dialog.querySelector('.vc-settings-nav [aria-current]') ?? dialog.querySelector('.vc-settings-close'))
            ?.focus({ preventScroll: true });
        }
      } else if (dialog.open) {
        dialog.close();
        return afterPopupMotion(dialog, () => setLastTab(false));
      }
    }, [tab, visit]);

    function onCancel(event) {
      event.preventDefault();
      if (busy) return;
      const details = document.activeElement?.closest('details[open]');
      if (details && ref.current.contains(details)) {
        details.open = false;
        details.querySelector('summary').focus({ preventScroll: true });
      } else close();
    }

    return h('dialog', {
      ref, className: 'vc-settings vc-workbench-settings vc-popup-motion', 'aria-labelledby': titleId, onCancel,
      onPointerDown: (event) => { pointerOutside.current = event.target === event.currentTarget; },
      onClick: (event) => { if (pointerOutside.current && event.target === event.currentTarget && !busy) close(); },
    }, shownTab ? h(React.Fragment, null,
      h('header', { className: 'vc-settings-header' }, h('h2', { id: titleId }, 'VPS 设置'),
        openSetup ? h('button', { type: 'button', className: 'vc-button vc-setup-entry', disabled: busy, onClick: openSetup },
          menuIcon(h, 'server'), '接入向导') : null,
        h('button', {
          type: 'button', className: 'vc-button vc-settings-close', 'aria-label': '关闭设置', disabled: busy, onClick: close,
        }, '×')),
      h(Session, { ...props, key: `${visit}:${scope}`, tab: shownTab })) : null);
  };
}
