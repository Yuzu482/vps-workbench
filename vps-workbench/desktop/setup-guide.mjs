import React from 'react';
import { readModelCatalog } from '../../remote-workbench/vps-chat/client/composer-controls.js';
import { menuIcon } from '../../remote-workbench/vps-chat/client/menu-icons.js';
import { afterPopupMotion } from '../../remote-workbench/vps-chat/client/menu-motion.js';
import { connectionForm, connectionSettings, createConnectionFields, editConnectionForm } from '../../remote-workbench/vps-chat/client/settings-dialog.js';
import { resolveAgentPreset } from '../agent-presets/state.mjs';
import { automaticMemoryPolicy } from '../extensions/state.mjs';
import { workflowProviders } from '../workflow-engine/state.mjs';
import { checkStageResources } from './workflow-stage.mjs';

const h = React.createElement;
const ConnectionFields = createConnectionFields(React);
const steps = [
  ['ssh', 'SSH 连接'],
  ['account', '账号登录'],
  ['model', '模型可用性'],
  ['resources', 'Agent 资源'],
];
const labels = { waiting: '待检查', checking: '检查中', passed: '已通过', failed: '需处理', confirm: '待确认' };
const accountActions = { codex: 'codex-login', claude: 'claude-api-key', 'claude-sdk': 'claude-login', antigravity: 'antigravity-login' };
const initialDetail = {
  ssh: '核对 SSH 指纹，登录并检查远端项目目录。',
  account: '使用所选执行端在 VPS 上的登录或 API 密钥。',
  model: '核对模型选项与当前执行端的配置。',
  resources: '检查选中 Agent 的 MCP、插件模板和记忆范围。',
};
const button = (text, onClick, extra) => h('button', { type: 'button', className: 'vc-button vc-settings-outline', onClick, ...extra }, text);

export function SetupGuide({ connection, connectionName, tools, toolIds, toolProfiles, rpc, readList,
  remoteEnabled, accessPending, applyConnection, enableTool, onEnableExecution, extensions, agentPresets,
  selectedProject, openAccount, openSettings, onClose, workflow }) {
  const title = React.useId();
  const providerGroup = React.useId();
  const dialog = React.useRef(null);
  const pending = React.useRef(null);
  const cancelMotion = React.useRef(null);
  const closing = React.useRef(false);
  const [editing, setEditing] = React.useState(!connection || !connectionName);
  const [form, setForm] = React.useState(() => connectionForm(connection));
  const [provider, setProvider] = React.useState(() => toolIds.includes(connection?.provider)
    ? connection.provider : tools.find((item) => toolIds.includes(item.id))?.id ?? connection?.provider ?? 'codex');
  const [presetId, setPresetId] = React.useState('');
  const [useDefaultModel, setUseDefaultModel] = React.useState(false);
  const [results, setResults] = React.useState({});
  const [verified, setVerified] = React.useState(null);
  const [manualTarget, setManualTarget] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [enabling, setEnabling] = React.useState(false);
  const enableRequest = React.useRef(false);
  const presets = (agentPresets?.items ?? []).map((record) => ({ ...resolveAgentPreset(record), id: record.id }))
    .filter((item) => item.provider === provider);
  const agent = presets.find((item) => item.id === presetId);
  const passedCount = steps.filter(([id]) => results[id]?.state === 'passed').length;
  const ready = verified && verified.extensions === extensions && verified.presets === agentPresets?.items;
  const disabled = busy || enabling || accessPending;

  React.useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => {
      cancelMotion.current?.();
      pending.current?.abort();
      if (element.open) element.close();
    };
  }, []);

  function dismiss(after) {
    if (closing.current) return;
    closing.current = true;
    pending.current?.abort();
    const element = dialog.current;
    element.close();
    cancelMotion.current = afterPopupMotion(element, () => {
      onClose();
      after?.();
    });
  }

  function reset() {
    setResults({});
    setVerified(null);
    setManualTarget(null);
  }

  function updateStep(id, state, detail, code) {
    setResults((current) => ({ ...current, [id]: { state, detail, code } }));
  }

  async function check(event, confirmedTarget = null) {
    event?.preventDefault();
    if (closing.current || pending.current || disabled || !remoteEnabled || (editing && !form.hostKeyConfirmed)) return;
    const controller = new AbortController();
    const { signal } = controller;
    pending.current = controller;
    setBusy(true);
    setResults({});
    setManualTarget(null);
    setVerified(null);
    let step = 'ssh';
    try {
      updateStep(step, 'checking', '正在使用已核对的指纹连接 VPS…');
      const settings = editing ? connectionSettings(form, provider) : { ...connection, provider };
      const list = readList(await rpc('list', { settings }, signal));
      const { targetId, memoryTargetId } = list;
      async function probe(kind, mcpServers = []) {
        const reply = await rpc('setup-check', { settings, targetId, kind, mcpServers }, signal);
        signal.throwIfAborted();
        if (reply.targetId !== targetId) throw new Error('VPS 连接已变化，请重新检查。');
        return reply.status;
      }
      if (await probe('ssh') !== 'connected') throw new Error('VPS 未确认 SSH 连接。');
      if (editing) {
        await applyConnection(settings, list, signal);
        setEditing(false);
      }
      signal.throwIfAborted();
      updateStep(step, 'passed', 'SSH 指纹、用户认证和远端项目目录已核对。');

      step = 'account';
      if (!editing && !toolIds.includes(provider)) {
        updateStep(step, 'failed', '请先为当前 VPS 启用所选执行端。', 'tool_disabled');
        return;
      }
      updateStep(step, 'checking', '正在检查 VPS 上的执行端和登录状态…');
      const account = await probe('account');
      if (account === 'manual' && confirmedTarget !== targetId) {
        setManualTarget(targetId);
        updateStep(step, 'confirm', '请在 VPS 登录 Antigravity。示例运行会核对当前账号是否能收到模型回复。');
        return;
      }
      const accountDetails = {
        signed_in: 'VPS 上的执行端已识别当前登录。',
        key_configured: 'VPS 上已配置私有 API 密钥。服务权限将在示例运行时验证。',
        manual: '已确认在 VPS 完成登录。服务权限将在示例运行时验证。',
      };
      if (!Object.hasOwn(accountDetails, account)) throw new Error('VPS 暂时无法确认账号状态。');
      updateStep(step, 'passed', accountDetails[account]);

      step = 'model';
      updateStep(step, 'checking', '正在核对执行端的模型选项…');
      let model = '';
      let modelName = 'VPS CLI 默认模型';
      if (provider !== 'codex' && await probe('model') !== 'model_route_ready') {
        throw new Error('VPS 未确认此执行端的模型服务路由。');
      }
      if (workflowProviders[provider].models) {
        const models = readModelCatalog(await rpc('models', { settings, targetId }, signal));
        signal.throwIfAborted();
        if (models.length === 0) throw new Error('当前执行端未返回可选模型。请检查 VPS 执行环境。');
        const saved = toolProfiles[provider]?.model;
        const requested = useDefaultModel ? '' : agent?.model || (saved?.targetId === targetId ? saved.id : '');
        const selected = requested ? models.find(({ id }) => id === requested) : models.find(({ isDefault }) => isDefault);
        if (requested && !selected) {
          updateStep(step, 'failed', `模型 ${requested} 已不在当前模型选项中。`, 'model_unavailable');
          return;
        }
        model = selected?.id ?? '';
        modelName = selected?.displayName ?? '执行端默认模型';
      }
      updateStep(step, 'passed', `${modelName} · 示例运行将验证实际响应。`);

      step = 'resources';
      updateStep(step, 'checking', '正在核对 Agent 的资源引用…');
      if (presetId && !agent) throw new Error('所选 Agent 预设已变更，请重新选择。');
      if (agentPresets?.error) throw new Error(agentPresets.error);
      const resources = checkStageResources({ provider, agent: agent?.agent }, targetId, extensions);
      if (!resources.ok) {
        updateStep(step, 'failed', resources.message, resources.code);
        return;
      }
      if (resources.mcpServers.length && await probe('resources', resources.mcpServers) !== 'resources_ready') {
        throw new Error('VPS 未确认 MCP 脚本是否可用。');
      }
      signal.throwIfAborted();
      const policy = agent?.agent?.memory === 'shared' && memoryTargetId &&
        automaticMemoryPolicy(extensions, { targetId: memoryTargetId, projectId: selectedProject });
      const memory = agent?.agent?.memory === 'shared' ? (policy?.enabled ? '共享记忆已启用' : '当前范围未开启自动记忆')
        : agent?.agent?.memory === 'isolated' || !agent ? '独立上下文' : '默认不共享';
      const summary = [
        agent?.name ?? '内置示例 Agent',
        resources.mcpServers.length ? `${resources.mcpServers.length} 个 MCP 脚本已核对` : null,
        agent?.agent?.plugins.length ? `${agent.agent.plugins.length} 个插件模板已核对` : null,
        memory,
      ].filter(Boolean).join(' · ');
      updateStep(step, 'passed', summary);
      setVerified({ targetId, model, extensions, presets: agentPresets?.items });
    } catch (error) {
      if (!signal.aborted) updateStep(step, 'failed', error?.message || '检查未完成，请重试。', error?.code);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  async function enable() {
    if (enableRequest.current || closing.current) return;
    enableRequest.current = true;
    setEnabling(true);
    try {
      await enableTool(provider);
      updateStep('account', 'waiting', '执行端已启用。请重新检查 VPS 登录。');
    } catch {
      updateStep('account', 'failed', '本机未能保存执行端设置。请重试。', 'tool_disabled');
    } finally {
      enableRequest.current = false;
      setEnabling(false);
    }
  }

  function login() {
    setVerified(null);
    setManualTarget(null);
    setResults((current) => ({ ssh: current.ssh, account: { state: 'waiting', detail: '完成 VPS 登录后，回来重新检查。' } }));
    openAccount(accountActions[provider]);
  }

  const fixAccount = connection && results.ssh?.state === 'passed' && ['failed', 'confirm', 'waiting'].includes(results.account?.state);
  const enableProvider = fixAccount && results.account.code === 'tool_disabled';
  const editVps = () => { setForm(connectionForm(connection)); setEditing(true); reset(); };
  const editSettings = (tab) => dismiss(() => openSettings(tab));
  const canRun = ready && remoteEnabled && !disabled && !workflow?.blocked && Boolean(workflow);
  return h('dialog', { ref: dialog, className: 'vc-setup-guide vc-workbench-settings vc-popup-motion',
    'aria-labelledby': title, onCancel(event) { event.preventDefault(); dismiss(); } },
    h('header', { className: 'vc-settings-header' },
      h('h2', { id: title }, 'VPS 接入向导'),
      button('×', () => dismiss(), { className: 'vc-button vc-settings-close', 'aria-label': '关闭接入向导' })),
    h('form', { className: 'vc-settings-form', onSubmit: check },
      h('div', { className: 'vc-settings-scroll vc-setup-scroll' },
        h('div', { className: 'vc-setup-overview' },
          h('p', null, '模型请求由 VPS 发出。检查完成后可运行一份两阶段的示例。'),
          h('span', { role: 'status' }, `${passedCount} / ${steps.length} 项通过`)),
        h('fieldset', { className: 'vc-setup-providers', disabled },
          h('legend', null, '示例执行端'),
          h('div', null, tools.map(({ id, icon }) => h('label', { key: id, className: 'vc-setup-provider', 'data-picked': provider === id },
            h('input', { type: 'radio', name: providerGroup, value: id, checked: provider === id,
              onChange: () => { setProvider(id); setPresetId(''); setUseDefaultModel(false); reset(); } }),
            menuIcon(h, icon), workflowProviders[id].label)))),
        h('ol', { className: 'vc-setup-steps' }, steps.map(([id, label]) => {
          const result = results[id];
          const state = result?.state ?? 'waiting';
          return h('li', { key: id, className: 'vc-setup-step', 'data-state': state, 'aria-label': label },
            h('div', { className: 'vc-setup-step-header' },
              h('span', { className: 'vc-setup-marker', 'aria-hidden': true }, state === 'passed' ? '✓' : state === 'failed' ? '!' : ''),
              h('strong', null, label), h('span', { className: 'vc-setup-status' }, labels[state])),
            h('p', { role: state === 'failed' ? 'alert' : undefined }, result?.detail ?? initialDetail[id]),
            id === 'ssh' && editing ? h('div', { className: 'vc-setup-fields' }, h(ConnectionFields, {
              form, busy: disabled, edit(key, value) { setForm((previous) => editConnectionForm(previous, key, value)); reset(); },
            }), connectionName && button('取消修改', () => { setEditing(false); reset(); }, { disabled })) : null,
            id === 'ssh' && connection && !editing ? h('div', { className: 'vc-setup-actions' },
              h('small', null, connectionName || '当前 VPS'), button('编辑连接', editVps, { disabled })) : null,
            id === 'account' && fixAccount ? h('div', { className: 'vc-setup-actions' },
              enableProvider ? button('启用此执行端', () => void enable(), { disabled })
                : button(provider === 'claude' ? '设置 VPS 密钥' : '在 VPS 登录', login, { disabled: disabled || !remoteEnabled }),
              manualTarget && button('已在 VPS 登录，继续检查', () => void check(null, manualTarget), { disabled })) : null,
            id === 'model' && result?.code === 'model_unavailable' ? button('改用执行端默认模型', () => {
              setUseDefaultModel(true); reset();
            }, { disabled }) : null,
            id === 'resources' ? h('div', { className: 'vc-setup-actions' },
              presets.length > 0 ? h('label', null, '检查额外 Agent', h('select', { value: presetId, disabled,
                onChange: (event) => { setPresetId(event.target.value); setUseDefaultModel(false); reset(); } },
              h('option', { value: '' }, '只检查内置示例'), ...presets.map(({ id, name }) => h('option', { key: id, value: id }, name)))) : null,
              state === 'failed' && button('检查 Agent 设置', () => editSettings('agents'), { disabled })) : null);
        })),
        !remoteEnabled && h('p', { role: 'status', className: 'vc-setup-notice' }, '当前为仅浏览。切换为 VPS 执行后可开始检查。'),
        ready && h('div', { className: 'vc-setup-example', role: 'status' },
          h('strong', null, '接入示例 · 读书会活动页'),
          h('p', null, '整理简报 → 核对并汇总。示例使用内置角色和独立上下文，并消耗所选执行端的额度。'),
          workflow?.blocked && h('p', null, workflow.blocked))),
      h('footer', { className: 'vc-settings-footer vc-setup-footer' },
        !remoteEnabled && onEnableExecution ? button('切换为 VPS 执行', onEnableExecution, { disabled: accessPending }) : null,
        ready && workflow?.blocked && workflow.showRun ? button('查看工作流', () => dismiss(workflow.showRun)) : null,
        h('button', { type: 'submit', className: `vc-button ${ready ? 'vc-settings-outline' : 'vc-primary'}`,
          disabled: disabled || !remoteEnabled || Boolean(manualTarget) || (editing && !form.hostKeyConfirmed) },
        busy ? '正在检查' : editing ? '连接并检查' : Object.keys(results).length ? '重新检查' : '开始检查'),
        ready ? button('运行示例工作流', () => {
          dismiss(() => workflow.start(provider, verified.model, verified.targetId));
        }, { className: 'vc-button vc-primary', disabled: !canRun }) : null)));
}
