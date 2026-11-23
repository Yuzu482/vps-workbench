import { t } from '../../remote-workbench/vps-chat/client/interface-language.js';
import React from 'react';
import { menuIcon } from '../../remote-workbench/vps-chat/client/menu-icons.js';
import { afterPopupMotion } from '../../remote-workbench/vps-chat/client/menu-motion.js';
import { connectionForm, connectionSettings, createConnectionFields, editConnectionForm } from '../../remote-workbench/vps-chat/client/settings-dialog.js';
import { resolveAgentPreset } from '../agent-presets/state.mjs';
import { automaticMemoryPolicy } from '../extensions/state.mjs';
import { workflowProviders } from '../workflow-engine/state.mjs';
import { checkStageResources } from './workflow-stage.mjs';
import { checkVpsConnection, selectSetupModel, setupChecks } from './setup-state.mjs';
import { ConnectionResult, setupAccountActions, vpsTrialTarget } from './connection-panel.mjs';
import { TrialActions, trialResult } from './connection-trial.mjs';
import { useVpsBackendSetup, VpsBackendSetup } from './vps-backend-setup.mjs';

const h = React.createElement;
const ConnectionFields = createConnectionFields(React);
const steps = setupChecks.filter(([id]) => id !== 'response');
const agentSteps = [
  ['agentModel', 'Agent 模型'],
  ['mcp', 'MCP 服务器'],
  ['plugins', '提示词模板'],
  ['memory', '记忆范围'],
];
const initialDetail = {
  ...Object.fromEntries(setupChecks.map(([id, , detail]) => [id, detail])),
  agentModel: '核对预设指定的模型。',
  mcp: '核对预设引用的 MCP 服务器。',
  plugins: '核对预设引用的提示词模板。',
  memory: '核对预设的记忆范围。',
};
const button = (text, onClick, extra) => h('button', { type: 'button', className: 'vc-button vc-settings-outline', onClick, ...extra }, text);

export function SetupGuide({ connection, connectionName, scope, memoryTargetId, tools, toolIds, toolProfiles, rpc, readList,
  remoteEnabled, accessPending, applyConnection, enableTool, onEnableExecution, extensions, agentPresets,
  selectedProject, openAccount, openSettings, onClose, workflow, trial }) {
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
  const backend = useVpsBackendSetup({ rpc, remoteEnabled });
  const enableRequest = React.useRef(false);
  const presets = (agentPresets?.items ?? []).map((record) => ({ ...resolveAgentPreset(record), id: record.id }))
    .filter((item) => item.provider === provider);
  const agent = presets.find((item) => item.id === presetId);
  const passedCount = steps.filter(([id]) => results[id]?.state === 'passed').length;
  const ready = verified?.provider === provider && verified.memoryTargetId === memoryTargetId && toolIds.includes(provider) && !editing;
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
    backend.reset();
    trial?.invalidate();
    setResults({});
    setVerified(null);
    setManualTarget(null);
  }

  function updateStep(id, state, detail, code) {
    setResults((current) => ({ ...current, [id]: { state, detail, code } }));
  }

  async function checkAgent(models, targetId, memoryTargetId, baseModel, probe, signal) {
    if (!agent || agentPresets?.error) {
      updateStep('agent', 'failed', agentPresets?.error || '所选 Agent 预设已变更，请重新选择。');
      return;
    }
    const selection = agent.model ? selectSetupModel(models, agent.model) : baseModel;
    updateStep('agentModel', selection.ok ? 'passed' : 'failed', selection.ok ? selection.name : selection.message);

    const mcpRefs = agent.agent?.mcpServers ?? [];
    const mcp = checkStageResources({ provider, agent: { mcpServers: mcpRefs } }, targetId, extensions);
    if (!mcp.ok) updateStep('mcp', 'failed', mcp.message);
    else if (!mcp.mcpServers.length) updateStep('mcp', 'passed', '预设未配置 MCP 服务器。');
    else {
      const names = mcp.mcpServers.join('、');
      updateStep('mcp', 'checking', `正在核对 ${names}。`);
      try {
        if (await probe('resources', mcp.mcpServers) !== 'resources_ready') throw new Error('VPS 未确认脚本可用。');
        updateStep('mcp', 'passed', `已核对 ${names}。`);
      } catch (error) {
        signal.throwIfAborted();
        updateStep('mcp', 'failed', `${names} · ${error?.message || '无法确认 MCP 脚本。'}`);
      }
    }

    const pluginRefs = agent.agent?.plugins ?? [];
    const plugins = checkStageResources({ provider, agent: { plugins: pluginRefs } }, targetId, extensions);
    updateStep('plugins', plugins.ok ? 'passed' : 'failed', plugins.ok
      ? pluginRefs.length ? `已核对 ${pluginRefs.map(({ title }) => title).join('、')}。` : '预设未配置提示词模板。'
      : plugins.message);

    const mode = agent.agent?.memory;
    if (mode === 'shared' && !memoryTargetId) updateStep('memory', 'failed', '当前 VPS 无法确认共享记忆范围。');
    else if (mode === 'shared') {
      const policy = automaticMemoryPolicy(extensions, { targetId: memoryTargetId, projectId: selectedProject });
      updateStep('memory', policy?.enabled ? 'passed' : 'confirm', policy?.enabled ? '共享记忆已启用。' : '当前范围未开启自动记忆。');
    } else updateStep('memory', 'passed', mode === 'isolated' ? '独立上下文。' : '默认不共享记忆。');
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
    try {
      const settings = editing ? connectionSettings(form, provider) : { ...connection, provider };
      const checked = await checkVpsConnection({ rpc, readList, settings, signal, updateStep,
        expectedTargetId: !editing && provider === connection?.provider ? scope : undefined,
        expectedMemoryTargetId: !editing ? memoryTargetId : undefined,
        accountConfirmedFor: confirmedTarget,
        afterConfiguration(list) { void backend.detect(settings, list.memoryTargetId ?? (provider === 'codex' ? list.targetId : null)); },
        async prepareAccount(list) {
          if (!editing) return toolIds.includes(provider);
          await applyConnection(settings, list, signal);
          setEditing(false);
          return true;
        },
        selectModel(targetId) {
          const saved = toolProfiles[provider]?.model;
          return !useDefaultModel && saved?.targetId === targetId ? saved.id : '';
        },
      });
      if (!checked?.model) {
        setManualTarget(checked?.manualTarget ?? null);
        return;
      }
      const { list: { targetId, memoryTargetId: verifiedMemoryId }, model: baseModel, models, probe } = checked;
      setVerified({ provider, targetId, memoryTargetId: verifiedMemoryId, model: baseModel.model,
        trialTarget: vpsTrialTarget(settings, checked, useDefaultModel ? undefined : toolProfiles[provider]?.model) });
      if (presetId) await checkAgent(models, targetId, verifiedMemoryId, baseModel, probe, signal);
    } catch (error) {
      if (!signal.aborted) updateStep('agent', 'failed', error?.message || 'Agent 检查未完成，请重试。', error?.code);
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
    setResults((current) => ({ ssh: current.ssh, egress: current.egress,
      account: { state: 'waiting', detail: '完成 VPS 登录后，回来重新检查。' } }));
    openAccount(setupAccountActions[provider]);
  }

  const fixAccount = connection && results.ssh?.state === 'passed' && ['failed', 'confirm', 'waiting'].includes(results.account?.state);
  const enableProvider = fixAccount && results.account.code === 'tool_disabled';
  const editVps = () => {
    setForm({ ...connectionForm(connection), hostKeyConfirmed: false });
    setEditing(true);
    reset();
  };
  const editSettings = (tab) => dismiss(() => openSettings(tab));
  const canRun = ready && remoteEnabled && !disabled && !workflow?.blocked && Boolean(workflow);
  const agentError = results.agent?.detail || agentPresets?.error;
  const agentNeedsAttention = agentError || agentSteps.some(([id]) => results[id]?.state === 'failed');

  function stepCard(id, label, ...actions) {
    const target = ready && verified.trialTarget;
    const result = id === 'response' ? trialResult(trial, target) : results[id];
    return h(ConnectionResult, { key: id, id, label, detail: initialDetail[id], result }, ...actions);
  }

  return h('dialog', { ref: dialog, className: 'vc-setup-guide vc-workbench-settings vc-popup-motion',
    'aria-labelledby': title, onCancel(event) { event.preventDefault(); dismiss(); } },
    h('header', { className: 'vc-settings-header' },
      h('h2', { id: title }, t('VPS 接入向导')),
      button('×', () => dismiss(), { className: 'vc-button vc-settings-close', 'aria-label': t('关闭接入向导') })),
    h('form', { className: 'vc-settings-form', onSubmit: check },
      h('div', { className: 'vc-settings-scroll vc-setup-scroll' },
        h('p', { className: 'vc-setup-notice' }, t('模型请求由 VPS 发出。基础接入通过后可运行内置示例。')),
        h('fieldset', { className: 'vc-setup-providers', disabled },
          h('legend', null, t('示例执行端')),
          h('div', null, tools.map(({ id, icon }) => h('label', { key: id, className: 'vc-setup-provider', 'data-picked': provider === id },
            h('input', { type: 'radio', name: providerGroup, value: id, checked: provider === id,
              onChange: () => { setProvider(id); setPresetId(''); setUseDefaultModel(false); reset(); } }),
            menuIcon(h, icon), workflowProviders[id].label)))),
        h('section', { className: 'vc-setup-group', 'aria-label': t('基础接入检查') },
          h('div', { className: 'vc-setup-overview' }, h('h3', null, t('基础接入检查')),
            h('span', { role: 'status' }, ready && passedCount < steps.length ? t('基础预检完成') : t('{passed} / {total} 项通过', { passed: passedCount, total: steps.length }))),
          h('ol', { className: 'vc-setup-steps' }, setupChecks.flatMap(([id, label]) => [stepCard(id, label,
            id === 'ssh' && editing ? h('div', { className: 'vc-setup-fields' }, h(ConnectionFields, {
              form, desktop: true, busy: disabled, edit(key, value) { setForm((previous) => editConnectionForm(previous, key, value)); reset(); },
            }), connectionName && button(t('取消修改'), () => { setEditing(false); reset(); }, { disabled })) : null,
            (id === 'ssh' && connection && !editing || id === 'egress' && results.egress?.state === 'failed' && !editing) ?
              h('div', { className: 'vc-setup-actions' },
              h('small', null, connectionName || t('当前 VPS')), button(t('编辑连接'), editVps, { disabled })) : null,
            id === 'account' && fixAccount ? h('div', { className: 'vc-setup-actions' },
              enableProvider ? button(t('启用此执行端'), () => void enable(), { disabled })
                : button(provider === 'claude' ? t('设置 VPS 密钥') : t('在 VPS 登录'), login, { disabled: disabled || !remoteEnabled }),
              manualTarget && button(t('已在 VPS 登录，继续检查'), () => void check(null, manualTarget), { disabled })) : null,
            id === 'model' && results.model?.code === 'model_unavailable' ? button(t('改用执行端默认模型'), () => {
              setUseDefaultModel(true); reset();
            }, { disabled }) : null,
            id === 'response' && trial ? h(TrialActions, { trial, target: ready && verified.trialTarget,
              allowed: !disabled && remoteEnabled }) : null), ...(id === 'ssh' ? [h(VpsBackendSetup, { key: 'backend',
                installer: backend, disabled: disabled || !remoteEnabled || editing && !form.hostKeyConfirmed })] : [])]))),
        h('section', { className: 'vc-setup-group', 'aria-label': t('额外 Agent 检查') },
          h('div', { className: 'vc-setup-overview' }, h('h3', null, t('额外 Agent 检查')),
            h('small', { className: 'vc-settings-current' }, t('可选'))),
          h('div', { className: 'vc-setup-actions vc-setup-agent-actions' },
            presets.length || presetId ? h('label', null, t('检查额外 Agent'), h('select', { value: presetId, disabled,
              onChange(event) {
                setPresetId(event.target.value);
                setResults((current) => Object.fromEntries(steps.filter(([id]) => current[id]).map(([id]) => [id, current[id]])));
              } },
            h('option', { value: '' }, t('只检查基础接入')),
            presetId && !agent ? h('option', { value: presetId, disabled: true }, t('已移除的预设')) : null,
            ...presets.map(({ id, name }) => h('option', { key: id, value: id }, name)))) :
              h('p', { className: 'vc-setup-notice' }, t('当前执行端暂无 Agent 预设。')),
            agentNeedsAttention ? button(t('检查 Agent 设置'), () => editSettings('agents'), { disabled }) : null),
          agentError ? h('p', { className: 'vc-setup-notice', role: 'alert' }, agentError) : null,
          presetId && h('ol', { className: 'vc-setup-steps' }, agentSteps.map(([id, label]) => stepCard(id, label)))),
        !remoteEnabled && h('p', { role: 'status', className: 'vc-setup-notice' }, t('当前为仅浏览。切换为 VPS 执行后可开始检查。')),
        ready && h('div', { className: 'vc-setup-example', role: 'status' },
          h('strong', null, t('接入示例 · 读书会活动页')),
          h('p', null, t('整理简报 → 核对并汇总。示例使用已验证的执行端和模型、内置角色及独立上下文，并消耗所选执行端的额度。')),
          workflow?.blocked && h('p', null, workflow.blocked))),
      h('footer', { className: 'vc-settings-footer vc-setup-footer' },
        !remoteEnabled && onEnableExecution ? button(t('切换为 VPS 执行'), onEnableExecution, { disabled: accessPending }) : null,
        ready && workflow?.blocked && workflow.showRun ? button(t('查看工作流'), () => dismiss(workflow.showRun)) : null,
        h('button', { type: 'submit', className: `vc-button ${ready ? 'vc-settings-outline' : 'vc-primary'}`,
          disabled: disabled || !remoteEnabled || Boolean(manualTarget) || (editing && !form.hostKeyConfirmed) },
        busy ? t('正在检查') : editing ? t('连接并检查') : Object.keys(results).length ? t('重新检查') : t('开始检查')),
        ready ? button(t('运行示例工作流'), () => {
          dismiss(() => workflow.start(verified.provider, verified.model, verified.targetId));
        }, { className: 'vc-button vc-primary', disabled: !canRun }) : null)));
}
