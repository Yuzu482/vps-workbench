import { maxStageMcpServers, maxStagePlugins, workflowProviders } from '../workflow-engine/state.mjs';
import { agentPresetFields, maxAgentPresets, validateAgentPresetDraft } from './state.mjs';

const styles = `
  [data-vps-chat] .vc-settings-pane:has(.vc-agent-preset-settings) > .vc-settings-intro {margin-bottom:12px}
  .vc-agent-preset-settings {display:grid; gap:10px; container-type:inline-size}
  .vc-agent-preset-settings :is(textarea,input[type=search]) {
    box-sizing:border-box; width:100%; min-width:0; min-height:34px; padding:6px 8px;
    border:1px solid var(--vc-line); border-radius:7px; color:var(--vc-ink); background:var(--vc-canvas);
    font:inherit;
  }
  .vc-agent-preset-settings textarea {min-height:76px; resize:vertical}
  .vc-preset-header, .vc-preset-row, .vc-preset-actions {
    display:flex; align-items:center; flex-wrap:wrap; gap:6px 8px; min-width:0;
  }
  .vc-preset-header, .vc-preset-text-header {justify-content:space-between}
  .vc-preset-header h4 {margin:0; font-size:14px}
  .vc-preset-header .vc-button[aria-pressed=true] {border-color:var(--vc-accent); background:var(--vc-tint)}
  .vc-preset-gallery {
    display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); grid-auto-rows:49px;
    gap:6px; max-height:110px; overflow-y:auto; padding:3px; margin:2px -3px -3px;
  }
  .vc-preset-card, .vc-preset-provider {
    box-sizing:border-box; display:flex; align-items:center; gap:7px; min-width:0;
    padding:5px 8px; border:1px solid var(--vc-line); border-radius:8px;
    color:var(--vc-ink); background:var(--vc-canvas); font:inherit; text-align:start;
  }
  .vc-preset-card, .vc-preset-provider:has(input:enabled) {cursor:pointer}
  .vc-preset-card:disabled, .vc-preset-provider:has(input:disabled) {opacity:.55; cursor:default}
  .vc-preset-card:enabled:hover, .vc-preset-provider:has(input:enabled):hover {background:var(--vc-hover)}
  .vc-preset-card[aria-pressed=true], .vc-preset-provider:has(input:checked) {
    border-color:var(--vc-accent); background:var(--vc-tint);
  }
  .vc-preset-card:focus-visible, .vc-preset-provider:has(input:focus-visible) {
    outline:2px solid var(--vc-accent); outline-offset:1px;
  }
  .vc-preset-card-copy {display:grid; min-width:0; gap:2px; line-height:1.2}
  .vc-preset-card-copy > * {overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .vc-preset-card-copy small {color:var(--vc-muted); font-size:11px}
  .vc-preset-icon {
    display:grid; place-items:center; flex:none; width:20px; height:20px; color:var(--vc-muted);
  }
  .vc-preset-icon .vc-menu-icon {width:16px; height:16px}
  .vc-preset-icon:empty {border-radius:6px; background:var(--vc-tint)}
  .vc-preset-editor {
    display:grid; gap:8px; min-width:0; border-top:1px solid var(--vc-line); padding-top:8px;
  }
  .vc-agent-preset-settings .vc-preset-name {display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:9px}
  .vc-preset-providers {border:0; padding:0; margin:0; min-inline-size:0}
  .vc-preset-providers legend {padding:0; margin:0 0 4px; color:var(--vc-muted); font-size:12px}
  .vc-preset-provider-grid {display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px}
  .vc-preset-provider {min-height:33px; font-size:12px}
  .vc-preset-provider > span:last-child {min-width:0; overflow-wrap:anywhere}
  .vc-preset-provider input {
    position:absolute; width:1px; height:1px; padding:0; margin:0; clip-path:inset(50%); overflow:hidden;
  }
  .vc-preset-model {display:grid; gap:6px; min-width:0}
  .vc-preset-model output {min-width:0; overflow-wrap:anywhere; font-weight:600}
  .vc-preset-model-label {color:var(--vc-muted); font-size:12px}
  .vc-preset-model-saved {color:var(--vc-warn,var(--vc-muted)); font-size:12px}
  .vc-preset-model-controls {margin-inline-start:auto}
  .vc-preset-model-panel {
    display:grid; gap:6px; padding:7px; border:1px solid var(--vc-line);
    border-radius:8px; background:var(--vc-surface);
  }
  .vc-preset-catalog-search input[type=search] {flex:1 1 145px; width:auto}
  .vc-preset-model-options {
    display:grid; gap:2px; max-height:142px; overflow:auto; padding:2px; margin:-2px;
  }
  .vc-preset-model-options label {
    display:flex; align-items:center; gap:7px; min-width:0; padding:4px 6px; border-radius:5px;
    color:var(--vc-ink); cursor:pointer;
  }
  .vc-preset-model-options label:has(input:checked) {background:var(--vc-tint)}
  .vc-preset-model-options label:has(input:enabled):hover {background:var(--vc-hover)}
  .vc-preset-model-options label:has(input:focus-visible) {outline:2px solid var(--vc-accent)}
  .vc-preset-model-options input {margin:0; accent-color:var(--vc-accent)}
  .vc-preset-model-options span {min-width:0; overflow-wrap:anywhere}
  .vc-preset-texts {display:flex; align-items:start; flex-wrap:wrap; gap:8px}
  .vc-preset-texts > div {flex:1 1 220px; min-width:0}
  .vc-preset-text-header {display:flex; align-items:center; gap:5px; min-height:27px}
  .vc-preset-text-header label {color:var(--vc-muted); font-size:12px}
  .vc-agent-preset-settings .vc-preset-text-header .vc-button {min-height:27px; padding:2px 7px; font-size:12px}
  .vc-agent-preset-settings .vc-preset-text-header > .vc-button {min-height:26px; font-size:12px}
  .vc-preset-note {margin:0; color:var(--vc-muted); font-size:12px}
  @container (max-width:465px) {
    .vc-preset-provider-grid, .vc-preset-gallery {grid-template-columns:repeat(2,minmax(0,1fr))}
    .vc-preset-model-controls {margin-inline-start:0}
  }
  @media (prefers-reduced-motion:no-preference) {
    .vc-preset-card, .vc-preset-provider {transition:background-color 120ms,border-color 120ms}
  }
`;

const modulesStyles = `
  .vc-agent-modules {
    display:grid; gap:6px; min-inline-size:0; margin:0; padding:0 0 2px; border:0;
  }
  .vc-agent-modules legend {margin:0 0 5px; padding:0; color:var(--vc-muted); font-size:12px}
  .vc-agent-modules p {margin:4px 0 0; color:var(--vc-muted); font-size:12px; overflow-wrap:anywhere}
  .vc-agent-resource-groups {display:flex; align-items:start; flex-wrap:wrap; gap:6px}
  .vc-agent-resources {display:grid; flex:1 1 200px; gap:6px; min-width:0}
  .vc-agent-resources .vc-agent-resource-toggle {
    display:flex; align-items:center; justify-content:space-between; gap:7px; width:100%;
    min-height:30px; padding:3px 7px; color:var(--vc-ink); background:var(--vc-surface);
    border:1px solid var(--vc-line); border-radius:7px; font:inherit; font-size:12px; text-align:start;
  }
  .vc-agent-resource-toggle:enabled {cursor:pointer}
  .vc-agent-resource-meta {display:flex; align-items:center; gap:8px; color:var(--vc-muted)}
  .vc-agent-resource-chevron {
    width:6px; height:6px; border:solid currentColor; border-width:0 1px 1px 0; transform:rotate(45deg);
  }
  .vc-agent-resource-toggle[aria-expanded=true] .vc-agent-resource-chevron {transform:rotate(225deg)}
  .vc-agent-resource-panel[hidden] {display:none}
  .vc-agent-resource-chips {display:flex; align-items:start; flex-wrap:wrap; gap:4px; max-height:122px; overflow:auto; padding:2px; margin:-2px}
  .vc-agent-resource-chips + .vc-agent-resource-chips {margin-top:4px}
  .vc-agent-resource-chip, .vc-agent-memory label {
    display:inline-flex; align-items:center; gap:4px; box-sizing:border-box; max-width:100%;
    min-height:27px; padding:2px 7px; border:1px solid var(--vc-line); border-radius:6px;
    color:var(--vc-ink); background:var(--vc-canvas); font:inherit; font-size:12px;
    text-align:start; overflow-wrap:anywhere;
  }
  .vc-agent-resource-chip[data-selected],
  .vc-agent-memory label:has(input:checked) {border-color:var(--vc-accent); background:var(--vc-tint)}
  .vc-agent-resource-chip[data-stale] {border-color:var(--vc-line)}
  .vc-agent-resource-chip small {color:var(--vc-warn,var(--vc-muted)); font-size:11px}
  .vc-agent-resource-chip > span {min-width:0}
  .vc-agent-resource-chip button {
    background:transparent; border:0; border-radius:4px; color:inherit; font:inherit;
    min-height:21px; padding:0 3px; overflow-wrap:anywhere;
  }
  .vc-agent-resource-chip button[aria-pressed] {padding:0; text-align:start}
  .vc-agent-resource-chip .vc-agent-resource-remove {flex:none; min-width:22px; font-size:16px}
  .vc-agent-modules button:enabled:hover, .vc-agent-memory label:has(input:enabled):hover {background:var(--vc-hover)}
  .vc-agent-modules button:enabled, .vc-agent-memory label:has(input:enabled) {cursor:pointer}
  .vc-agent-modules button:disabled, .vc-agent-memory label:has(input:disabled) {opacity:.55}
  .vc-agent-modules button:focus-visible, .vc-agent-memory label:has(input:focus-visible) {
    outline:2px solid var(--vc-accent); outline-offset:1px;
  }
  .vc-agent-memory {padding:0; margin:2px 0 0; border:0; min-inline-size:0}
  .vc-agent-memory > div {display:flex; flex-wrap:wrap; gap:4px}
  .vc-agent-memory input {margin:0; accent-color:var(--vc-accent)}
  @media (prefers-reduced-motion:no-preference) {
    .vc-agent-resource-chevron {transition:transform 120ms}
  }
`;

function toManifest({ name, provider, model, instruction, output, agent }) {
  const modules = [
    { id: 'executor', config: { provider, model } },
    { id: 'persona', config: { instruction } },
  ];
  if (output !== null) modules.push({ id: 'output', config: { instruction: output } });
  if (agent?.mcpServers.length) modules.push({ id: 'mcp', config: { servers: agent.mcpServers } });
  if (agent?.plugins.length) modules.push({ id: 'plugins', config: { templates: agent.plugins } });
  if (agent) modules.push({ id: 'memory', config: { mode: agent.memory } });
  return { name, modules };
}

const errorMessage = (error, fallback) => error instanceof Error && error.message ? error.message : fallback;
const serverKey = ({ id, targetId }) => JSON.stringify([id, targetId]);
const pluginKey = ({ id, version, title }) => JSON.stringify([id, version, title]);

export function createAgentModulesEditor(React) {
  const h = React.createElement;

  function ResourcePicker({ label, help, selected, options, limit, identify, renderLabel, status, disabled, update }) {
    const [open, setOpen] = React.useState(false);
    const panelId = React.useId();
    const toggle = React.useRef(null);
    const selectedKeys = new Set(selected.map(identify));
    const choices = options.filter(({ key }) => !selectedKeys.has(key));
    const atLimit = selected.length >= limit;
    const remove = (key) => {
      update(selected.filter((item) => identify(item) !== key));
      toggle.current?.focus();
    };

    return h('div', { className: 'vc-agent-resources' },
      h('button', { type: 'button', ref: toggle, className: 'vc-agent-resource-toggle', disabled,
        'aria-label': label, 'aria-expanded': open, 'aria-controls': panelId,
        onClick: () => setOpen(!open),
      }, label, h('span', { className: 'vc-agent-resource-meta', 'aria-hidden': true },
        `${selected.length} / ${limit}`, h('span', { className: 'vc-agent-resource-chevron' }))),
      selected.length ? h('div', { role: 'group', className: 'vc-agent-resource-chips', 'aria-label': `已选${label}` },
      selected.map((reference) => {
        const key = identify(reference);
        const name = renderLabel(reference);
        const option = options.find((item) => item.key === key);
        const reason = status(reference);
        return h('span', { key, className: 'vc-agent-resource-chip', 'data-selected': '', 'data-stale': reason ? '' : undefined },
          option ? h('button', { type: 'button', disabled, 'aria-pressed': true, 'aria-label': option.name,
            onClick: () => remove(key) }, option.name)
            : h('span', null, name),
          reason ? h('small', null, reason) : null,
          h('button', { type: 'button', className: 'vc-agent-resource-remove', disabled,
            'aria-label': `移除${label} ${name}`,
            onClick: () => remove(key),
          }, '×'));
      })) : null,
      h('div', { className: 'vc-agent-resource-panel', id: panelId, hidden: !open },
        open && choices.length ? h('div', { role: 'group', className: 'vc-agent-resource-chips', 'aria-label': `可用${label}` },
          choices.map(({ key, reference, name }) => h('button', {
            key, type: 'button', className: 'vc-agent-resource-chip', disabled: disabled || atLimit,
            'aria-pressed': false, 'aria-label': name,
            onClick: () => {
              update([...selected, reference]);
              toggle.current?.focus();
            },
          }, name))) : null,
        open ? h('p', null, atLimit ? `已达上限（${limit}）` : !choices.length ? help : null) : null));
  }

  return function AgentModulesEditor({ agent, provider, moduleCatalog, onChange, disabled }) {
    const mcpServers = agent?.mcpServers ?? [];
    const plugins = agent?.plugins ?? [];
    const memory = agent?.memory ?? '';
    const memoryGroup = React.useId();
    const hasResources = Boolean(mcpServers.length || plugins.length);
    const { mcp, label: providerLabel } = workflowProviders[provider] ?? {};
    const { servers = [], plugins: installed = [], codexTargetId, antigravityTargetId } = moduleCatalog ?? {};
    const currentTargetId = provider === 'antigravity' ? antigravityTargetId : codexTargetId;
    const wrongTarget = currentTargetId && mcpServers.some(({ targetId }) => targetId !== currentTargetId);
    const serverOptions = mcp && currentTargetId && !wrongTarget ? servers.filter(({ enabled, targetId }) =>
      enabled && targetId === currentTargetId).map(({ id, targetId }) => {
      const reference = { id, targetId };
      return { key: serverKey(reference), reference, name: id };
    }) : [];
    const templateOptions = installed.filter(({ enabled }) => enabled).flatMap(({ id, version, name, prompts }) =>
      prompts.map(({ title }) => {
        const reference = { id, version, title };
        return { key: pluginKey(reference), reference, name: `${name} · ${title}` };
      }));

    function change(config) {
      const next = { mcpServers, plugins, memory, ...config };
      onChange(next.memory || next.mcpServers.length || next.plugins.length
        ? { ...next, memory: next.memory || 'isolated' }
        : null);
    }

    function serverStatus(reference) {
      if (!mcp) return '当前执行端不支持，需移除后保存';
      if (!currentTargetId) return `尚未核对 ${providerLabel} 连接`;
      if (reference.targetId !== currentTargetId) return '属于其他连接，可移除后重新选择';
      const current = servers.find((server) => serverKey(server) === serverKey(reference));
      return current?.enabled ? '' : current ? '服务已停用' : '服务不可用';
    }

    function templateStatus({ id, version, title }) {
      const current = installed.find((plugin) => plugin.id === id && plugin.version === version);
      if (!current || !current.prompts.some((prompt) => prompt.title === title)) return '模板或版本不可用';
      return current.enabled ? '' : '提示词模板已停用';
    }

    return h('fieldset', { className: 'vc-agent-modules' },
      h('legend', null, 'Agent 资源'),
      h('style', null, modulesStyles),
      h('div', { className: 'vc-agent-resource-groups' },
        h(ResourcePicker, {
          label: 'MCP 服务', selected: mcpServers, options: serverOptions, limit: maxStageMcpServers,
          identify: serverKey, renderLabel: ({ id }) => id, status: serverStatus, disabled,
          help: !mcp ? 'Codex 和 Antigravity 支持 MCP 服务。'
            : !currentTargetId ? `核对 ${providerLabel} 的 VPS 连接后可添加 MCP 服务。`
            : wrongTarget ? '移除其他连接的服务后，即可添加当前连接的服务。'
            : '没有可添加的 MCP 服务。',
          update: (mcpServers) => change({ mcpServers }),
        }),
        h(ResourcePicker, {
          label: '提示词模板', selected: plugins, options: templateOptions, limit: maxStagePlugins,
          identify: pluginKey, renderLabel: ({ id, version, title }) => `${title} · ${id} ${version}`,
          status: templateStatus, disabled, help: '没有可添加的提示词模板。',
          update: (plugins) => change({ plugins }),
        })),
      h('fieldset', { className: 'vc-agent-memory' },
        h('legend', null, '记忆模式'),
        h('div', null, [['', '默认不共享'], ['shared', '共享记忆'], ['isolated', '独立上下文']].map(([value, label]) =>
          h('label', { key: value }, h('input', { type: 'radio', name: memoryGroup, value, checked: value === memory,
            'aria-label': label, disabled: disabled || (!value && hasResources),
            onChange: () => change({ memory: value }) }), label))),
        memory === 'shared' ? h('p', null, '工作流使用启动时选中的项目记忆。未选项目时，使用已启用的个人记忆。') : null,
        memory === 'isolated' ? h('p', null, '仍接收上游步骤的结果，跳过共享记忆的读取与提炼。') : null));
  };
}

export function createAgentPresetSettings(React, { icon } = {}) {
  const h = React.createElement;
  const AgentModulesEditor = createAgentModulesEditor(React);
  const button = (label, onClick, disabled, { primary = false, ...props } = {}) => h('button', {
    type: 'button', className: `vc-button ${primary ? 'vc-primary' : 'vc-settings-outline'}`, onClick, disabled, ...props,
  }, label);
  const providerIcon = (provider) => h('span', { className: 'vc-preset-icon', 'aria-hidden': true },
    icon?.(h, provider === 'claude' ? 'claude-sdk' : provider));
  const note = (message, role) => h('p', { className: 'vc-preset-note', role }, message);
  const alert = (message) => h('p', { className: 'vc-settings-inline-error', role: 'alert' }, message);

  function ModelField({ provider, model, update, disabled, connected, readModels }) {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [catalog, setCatalog] = React.useState(null);
    const active = React.useRef(null);
    const search = React.useRef(null);
    const trigger = React.useRef(null);
    const panelId = React.useId();
    const radioGroup = React.useId();
    React.useLayoutEffect(() => () => active.current?.abort(), []);
    React.useLayoutEffect(() => {
      if (open) search.current?.focus();
    }, [open]);

    async function load() {
      if (active.current || disabled || !connected) return;
      const controller = new AbortController();
      active.current = controller;
      setCatalog({ status: 'loading' });
      try {
        const models = await readModels(provider, controller.signal);
        if (!controller.signal.aborted) setCatalog({ status: 'ready', models });
      } catch (error) {
        if (!controller.signal.aborted) setCatalog({ status: 'error', message: errorMessage(error, '无法读取模型目录。') });
      } finally {
        if (active.current === controller) active.current = null;
      }
    }

    function close() {
      if (active.current) {
        active.current.abort();
        active.current = null;
        setCatalog(null);
      }
      setOpen(false);
      setQuery('');
      trigger.current?.focus();
    }

    function toggle() {
      if (open) {
        close();
        return;
      }
      setOpen(true);
      void load();
    }

    const supportsModels = workflowProviders[provider].models;
    const defaultModel = supportsModels ? '默认模型' : 'VPS CLI 默认模型';
    const options = catalog?.models ?? [];
    const missing = model && catalog?.status === 'ready' && !options.some(({ id }) => id === model);
    const filter = query.trim().toLowerCase();
    const filtered = options.filter(({ id, displayName }) =>
      id.toLowerCase().includes(filter) || displayName?.toLowerCase().includes(filter));
    const modelChoice = (id, name) => h('label', { key: id },
      h('input', { type: 'radio', name: radioGroup, value: id, checked: model === id,
        'aria-label': id || defaultModel, disabled, onChange: () => update(id) }), h('span', null, name));

    return h('div', { className: 'vc-preset-model', onKeyDown: (event) => {
      if (open && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    } },
    h('div', { className: 'vc-preset-row' },
      h('span', { className: 'vc-preset-model-label' }, '模型'),
      h('output', { 'aria-label': '当前模型' }, model || defaultModel),
      missing ? h('span', { className: 'vc-preset-model-saved' }, '目录中不可用') : null,
      h('div', { className: 'vc-preset-row vc-preset-model-controls' },
        supportsModels && model && !open ? button('恢复默认模型', () => update(''), disabled) : null,
        supportsModels ? button(open ? '收起模型目录' : catalog?.status === 'ready' ? '展开模型目录' : '读取模型',
          toggle, disabled || !connected, {
          ref: trigger, 'aria-expanded': open, 'aria-controls': panelId,
        }) : null)),
    supportsModels && !connected ? note('连接并启用此执行端后可读取模型目录。') : null,
    supportsModels ? h('div', { id: panelId, hidden: !open },
      open ? h('div', { className: 'vc-preset-model-panel', 'aria-busy': catalog?.status === 'loading' },
        h('div', { className: 'vc-preset-row vc-preset-catalog-search' },
          h('input', { type: 'search', ref: search, value: query, disabled, 'aria-label': '筛选模型',
            placeholder: '筛选模型', onChange: (event) => setQuery(event.target.value) }),
          button('刷新目录', load, disabled || !connected || catalog?.status === 'loading')),
        h('div', { className: 'vc-preset-model-options', role: 'radiogroup', 'aria-label': '模型目录' },
          modelChoice('', defaultModel),
          ...filtered.map(({ id, displayName }) =>
            modelChoice(id, displayName && displayName !== id ? `${displayName} · ${id}` : id))),
        catalog?.status === 'loading' ? note('正在读取模型目录…', 'status') : null,
        catalog?.status === 'error' ? alert(`模型目录读取失败：${catalog.message}`) : null,
        catalog?.status === 'ready' && !filtered.length ? note(filter ? '没有匹配的模型。' : '目录中没有模型。') : null)
        : null) : null);
  }

  return function AgentPresetSettings({ items, change, busy, error, availableProviders, readModels, catalogScope, moduleCatalog }) {
    const [editing, setEditing] = React.useState(null);
    const [confirming, setConfirming] = React.useState(false);
    const [feedback, setFeedback] = React.useState(null);
    const [pending, setPending] = React.useState(false);
    const writing = React.useRef(false);
    const providerGroup = React.useId();
    const roleId = React.useId();
    const outputId = React.useId();
    const disabled = busy || pending;
    const record = items.find(({ id }) => id === editing?.id);
    const stored = record ? agentPresetFields(record) : null;
    const existing = editing?.revision != null;
    const stale = editing && (existing ? record?.revision !== editing.revision : Boolean(record));

    function select(item) {
      setEditing(item ? { id: item.id, revision: item.revision, draft: agentPresetFields(item) } : null);
      setConfirming(false);
      setFeedback(null);
    }

    function create() {
      setEditing({ id: crypto.randomUUID(), revision: null, draft: {
        name: '', provider: 'codex', model: '', instruction: '', output: null, agent: null,
      } });
      setConfirming(false);
      setFeedback(null);
    }

    function update(fields) {
      setEditing((current) => ({ ...current, draft: { ...current.draft, ...fields } }));
      setConfirming(false);
      setFeedback(null);
    }

    async function submit(op) {
      if (disabled || writing.current || stale || !editing) return;
      writing.current = true;
      setPending(true);
      setFeedback(null);
      try {
        const { id, revision, draft } = editing;
        const updated = await change(op === 'save'
          ? { op, id, revision, draft: validateAgentPresetDraft(toManifest(draft)) }
          : { op, id, revision });
        select(op === 'save' && Array.isArray(updated) ? updated.find((item) => item.id === id) : null);
        setFeedback({ message: op === 'save' ? '已保存预设。' : '已删除预设。' });
      } catch (cause) {
        setFeedback({ error: errorMessage(cause, '无法写入预设。') });
      } finally {
        writing.current = false;
        setPending(false);
      }
    }

    const draft = editing?.draft;
    const connected = Boolean(draft && availableProviders.includes(draft.provider));
    const full = items.length >= maxAgentPresets;
    const draftDisabled = disabled || stale;
    return h('div', { className: 'vc-agent-preset-settings', 'aria-busy': pending },
      h('style', null, styles),
      feedback?.error || error ? alert(feedback?.error || error) : null,
      h('div', null,
        h('div', { className: 'vc-preset-header' },
          h('div', { className: 'vc-preset-row' }, h('h4', null, '已保存的预设'),
            feedback?.message ? note(feedback.message, 'status') : null),
          button('新建预设', create, disabled || full, { 'aria-pressed': Boolean(editing && !existing) })),
        items.length ? h('div', { className: 'vc-preset-gallery', role: 'group', 'aria-label': '已保存的预设' },
          items.map((item) => {
            const { provider, model } = agentPresetFields(item);
            const detail = model || workflowProviders[provider].label;
            return h('button', { key: item.id, type: 'button', className: 'vc-preset-card', disabled,
              'data-preset-id': item.id, 'aria-label': item.name, 'aria-pressed': item.id === editing?.id,
              title: `${item.name} · ${detail}`,
              onClick: () => { if (item.id !== editing?.id) select(item); },
            }, providerIcon(provider), h('span', { className: 'vc-preset-card-copy' },
              h('strong', null, item.name), h('small', null, detail)));
          })) : note('点击「新建预设」保存常用的执行端和指令。'),
        full ? note(`最多可保存 ${maxAgentPresets} 个预设。`) : null),
      draft ? h('section', { className: 'vc-preset-editor', 'aria-label': existing ? '编辑预设' : '新预设' },
        stale ? h('div', { className: 'vc-preset-actions' },
          alert('此预设已变更。请重新加载后再操作。'),
          button('重新加载预设', () => select(record), disabled)) : null,
        h('label', { className: 'vc-field vc-preset-name' }, '预设名称',
          h('input', { value: draft.name, maxLength: 64, disabled: draftDisabled,
            onChange: (event) => update({ name: event.target.value }) })),
        h('fieldset', { className: 'vc-preset-providers' },
          h('legend', null, '执行端'),
          h('div', { className: 'vc-preset-provider-grid' }, Object.entries(workflowProviders).map(([provider, { label }]) =>
            h('label', { key: provider, className: 'vc-preset-provider' },
              h('input', { type: 'radio', name: providerGroup, value: provider, checked: provider === draft.provider,
                'aria-label': label, disabled: draftDisabled,
                onChange: () => update({ provider, model: stored?.provider === provider ? stored.model : '' }) }),
              providerIcon(provider), h('span', null, label))))),
        h(ModelField, { key: JSON.stringify([catalogScope, editing.id, editing.revision, draft.provider, connected, stale]),
          provider: draft.provider, model: draft.model, update: (model) => update({ model }),
          disabled: draftDisabled, connected, readModels }),
        h('div', { className: 'vc-preset-texts' },
          h('div', null,
            h('div', { className: 'vc-preset-text-header' }, h('label', { htmlFor: roleId }, '角色指令'),
              draft.output === null ? button('添加输出规范', () => update({ output: '' }), draftDisabled) : null),
            h('textarea', { id: roleId, value: draft.instruction, maxLength: 1200, disabled: draftDisabled,
              onChange: (event) => update({ instruction: event.target.value }) })),
          draft.output !== null ? h('div', null,
            h('div', { className: 'vc-preset-text-header' }, h('label', { htmlFor: outputId }, '输出规范'),
              button('移除输出规范', () => update({ output: null }), draftDisabled)),
            h('textarea', { id: outputId, value: draft.output, maxLength: 1200, disabled: draftDisabled,
              onChange: (event) => update({ output: event.target.value }) })) : null),
        h(AgentModulesEditor, { key: editing.id, agent: draft.agent, provider: draft.provider, moduleCatalog,
          disabled: draftDisabled,
          onChange: (agent) => update({ agent }) }),
        h('div', { className: 'vc-preset-actions' },
          button('保存预设', () => submit('save'), draftDisabled || !draft.name.trim() || !draft.instruction.trim(), { primary: true }),
          button('取消编辑', () => select(null), disabled),
          existing && !confirming ? button('删除预设', () => setConfirming(true), disabled || stale) : null),
        confirming ? h('div', { className: 'vc-preset-actions' },
          note(`删除「${record?.name ?? draft.name}」？`, 'status'),
          button('确认删除预设', () => submit('delete'), disabled || stale),
          button('取消删除', () => setConfirming(false), disabled)) : null) : null);
  };
}
