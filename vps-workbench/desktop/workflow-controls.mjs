import React from 'react';
import { readModelCatalog } from '../../remote-workbench/vps-chat/client/composer-controls.js';
import { workbenchStorage } from '../../remote-workbench/vps-chat/client/workbench-storage.js';
import {
  createWorkflowEditPrompt, preserveWorkflowAgents, readWorkflowProposal, workflowProviders, workflowUuid,
} from '../workflow-engine/state.mjs';
import { createWorkflowRunner } from '../workflow-engine/runner.mjs';
import { createSetupExample, setupExampleTask } from './setup-state.mjs';

const editKey = (targetId, sessionId, turnId) => `dsh-vps-chat:workflow-edit:v1:${targetId}:${sessionId}:${turnId}`;

function readEdit(key) {
  try {
    const value = JSON.parse(workbenchStorage.getItem(key));
    if (value && workflowUuid(value.id) && typeof value.prompt === 'string' &&
        (value.revision === null || (Number.isSafeInteger(value.revision) && value.revision > 0))) return value;
  } catch {}
  return null;
}

export function useWorkflowControls({ store, rpc, readList, connection, remoteEnabled, toolIds, local,
  scope, sessionId, prepareChat, savePreference, report }) {
  const [open, setOpen] = React.useState(false);
  const [preferRunPane, setPreferRunPane] = React.useState(false);
  const [searchSelection, setSearchSelection] = React.useState(null);
  const [edit, setEdit] = React.useState(null);
  const [proposal, setProposal] = React.useState(null);
  const [run, setRun] = React.useState(store.initialRun);
  const [running, setRunning] = React.useState(false);
  const [exampleError, setExampleError] = React.useState('');
  const [mixedTargets, setMixedTargets] = React.useState([]);
  const [mixedStatus, setMixedStatus] = React.useState(null);
  const mixedRequest = store.mixedRequest;
  React.useEffect(() => {
    if (!open || !mixedRequest) return;
    let live = true;
    let timer;
    async function update() {
      try {
        const status = await mixedRequest({ op: 'status' });
        if (live && status?.ok) setMixedStatus(status);
      } catch {
        if (live) setMixedStatus((current) => ({ ...current, error: '暂时无法读取混合工作流状态。' }));
      } finally { if (live) timer = setTimeout(update, 750); }
    }
    void mixedRequest({ op: 'targets' }).then((result) => {
      if (live && result.ok) setMixedTargets(result.targets);
    }).catch(() => { if (live) setMixedTargets([]); });
    void update();
    return () => { live = false; clearTimeout(timer); };
  }, [open, mixedRequest]);

  const callMixed = React.useCallback(async (packet) => {
    const result = await mixedRequest(packet);
    if (!result?.ok) throw new Error(result?.message || '混合工作流暂不可用。');
    return result;
  }, [mixedRequest]);
  const runner = React.useRef(null);
  const availableProviders = toolIds.filter((id) => Object.hasOwn(workflowProviders, id));
  const context = React.useRef(null);
  context.current = { connection, remoteEnabled, availableProviders, local, scope };
  const canDispatch = React.useCallback(({ settings }) => {
    const { connection, remoteEnabled, availableProviders, local, scope } = context.current;
    if (local) return Boolean(remoteEnabled && local.runtimeReady && availableProviders.includes(settings.provider) &&
      settings.location === 'local-sdk' && settings.profileId === connection?.profileId &&
      settings.profileId === local.profile?.id && local.profile?.targetId === scope);
    return Boolean(remoteEnabled && connection?.hostKeyConfirmed && availableProviders.includes(settings.provider) &&
      Object.entries(connection).every(([key, value]) => key === 'provider' || settings[key] === value));
  }, []);
  const resolveRoute = React.useCallback(async (provider, signal, { dispatch, pinned }) => {
    const active = context.current;
    if (active.local) {
      signal.throwIfAborted();
      const route = active.local.routeForTarget(pinned ?? active.scope);
      if (provider !== 'codex' || !route || (dispatch && (!canDispatch(route) || route.targetId !== active.scope))) {
        throw new Error('请核对步骤的原本机配置、模型和访问权限。');
      }
      return route;
    }
    if (dispatch && !active.remoteEnabled) throw new Error('请切换为 VPS 执行后继续。');
    if (dispatch && !active.availableProviders.includes(provider)) throw new Error('请先在 VPS 设置中启用此执行端。');
    if (!active.connection?.hostKeyConfirmed) throw new Error('请先配置并核对 VPS 连接。');
    const settings = { ...active.connection, provider };
    const { targetId } = readList(await rpc('list', { settings }, signal));
    const route = { settings, targetId };
    if (context.current.connection !== active.connection || (dispatch && !canDispatch(route))) {
      throw new Error('VPS 连接或执行权限在查询期间发生变化，请重新检查。');
    }
    return route;
  }, [rpc, readList, canDispatch]);
  const readModels = React.useCallback(async ({ settings, targetId }, signal) =>
    readModelCatalog(await rpc('models', { settings, targetId }, signal)), [rpc]);
  const readPanelModels = React.useCallback(async (provider, signal) =>
    readModels(await resolveRoute(provider, signal, { dispatch: true }), signal), [readModels, resolveRoute]);
  const readArtifacts = React.useCallback(async (activeRun, index, path, signal, { after, offset } = {}) => {
    const stage = activeRun?.workflow.stages[index];
    const row = activeRun?.rows[index];
    if (!stage || !row) throw new Error('这个工作流阶段的产物记录已变化。');
    const { settings, targetId } = await resolveRoute(stage.provider, signal,
      { dispatch: !context.current.local, pinned: row.targetId });
    if (targetId !== row.targetId) throw new Error('当前 VPS 与该阶段的原连接不匹配。');
    const packet = await rpc('workflow-artifacts', { settings, targetId, workflowRunId: activeRun.id,
      sessionId: row.sessionId, turnId: row.turnId, ...(path === undefined ? {} : { path }),
      ...(after === undefined ? {} : { after }), ...(offset === undefined ? {} : { offset }) }, signal);
    if (packet?.ok !== true) throw new Error(packet?.message || '无法读取阶段产物。');
    return packet;
  }, [resolveRoute, rpc]);

  const { initialRun, saveRun, error } = store;
  React.useEffect(() => {
    if (error) return undefined;
    const instance = createWorkflowRunner({ initialRun, resolveRoute, readModels, rpc, canDispatch, persist: saveRun,
      onChange(value, busy) { setRun(value); setRunning(busy); } });
    runner.current = instance;
    return () => {
      runner.current = null;
      instance.dispose();
    };
  }, [initialRun, saveRun, error, resolveRoute, readModels, rpc, canDispatch]);

  const activeEdit = edit && edit.targetId === scope && edit.sessionId === sessionId ? edit : null;
  function startChatEdit(workflow) {
    if (error) {
      report(error);
      return false;
    }
    const target = prepareChat();
    if (!target) {
      report('需要一个可发送消息的对话来配置工作流。');
      return false;
    }
    setEdit({ ...target, workflow });
    setProposal(null);
    setOpen(false);
    return true;
  }

  function describeEdit(turn) {
    const binding = scope && sessionId && readEdit(editKey(scope, sessionId, turn.id));
    if (!binding) return null;
    return {
      prompt: binding.prompt,
      review: turn.state === 'complete' ? () => {
        try {
          if (error) throw new Error(error);
          const previous = store.items.find(({ id, revision }) => id === binding.id && revision === binding.revision) ?? null;
          const draft = readWorkflowProposal(turn.reply, {
            requireStageIds: previous?.stages.some(({ agent, agentPreset, fileAccess }) => Boolean(agent || agentPreset || fileAccess)),
          });
          if (!draft) throw new Error('回复缺少可审阅的工作流配置。请让模型缩短草案，并重新输出一个完整的 vps-workflow 代码块。');
          setProposal({ id: binding.id, revision: binding.revision, draft: preserveWorkflowAgents(previous, draft) });
          setOpen(true);
        } catch (failure) {
          report(failure.message);
        }
      } : null,
    };
  }

  async function prepareEdit(prompt, turnId) {
    const { targetId, sessionId, workflow } = activeEdit;
    const draft = workflow ? { name: workflow.name, stages: workflow.stages, edges: workflow.edges } : null;
    const body = createWorkflowEditPrompt(prompt, draft);
    await savePreference(editKey(targetId, sessionId, turnId), JSON.stringify({
      id: workflow?.id ?? turnId, revision: workflow?.revision ?? null, prompt,
    }));
    return body;
  }

  function invoke(operation, ...args) {
    if (!runner.current) throw new Error(error || '工作流暂不可用。');
    return runner.current[operation](...args);
  }

  const exampleBlocked = error || (running || run?.phase === 'paused' || run?.phase === 'running'
    ? '请先继续或停止当前工作流。' : '');
  function showExampleRun() {
    setPreferRunPane(true);
    setOpen(true);
  }
  async function startExample(provider, model, targetId) {
    setExampleError('');
    showExampleRun();
    try { await invoke('start', createSetupExample(provider, model), setupExampleTask, null, targetId); }
    catch (failure) { setExampleError(failure.message); }
  }

  return {
    openPanel: () => { setPreferRunPane(false); setOpen(true); },
    openSearchResult(item) { setSearchSelection(item); setPreferRunPane(Boolean(item.runId)); setOpen(true); },
    editLabel: activeEdit && (activeEdit.workflow?.name ?? '新建工作流'),
    clearEdit: () => setEdit(null),
    prepareEdit,
    describeEdit,
    example: { blocked: exampleBlocked, start: startExample, showRun: showExampleRun },
    panel: {
      open, preferRunPane, searchSelection, clearSearchSelection: () => setSearchSelection(null),
      onClose: () => { setOpen(false); setSearchSelection(null); setProposal(null); setExampleError(''); }, workflows: store.items, exampleError,
      availableProviders, catalogScope: scope, readModels: readPanelModels, onChange: store.change, onEditInChat: startChatEdit,
      proposal, onDismissProposal: () => setProposal(null), run, running,
      mixed: mixedRequest ? { ...mixedStatus, targets: mixedTargets, canExecute: remoteEnabled,
        historyRequest: callMixed,
        async retry(runId, stageIndex) {
          const result = await callMixed({ op: 'retry', runId, stageIndex });
          void callMixed({ op: 'status' }).then(setMixedStatus).catch(() => {});
          return result;
        },
        catalog: async (stage) => (await callMixed({ op: 'catalog', stage })).models,
        readArtifacts: (run, stageIndex, path, _signal, { after, offset } = {}) => callMixed({ op: 'artifacts', query: {
          runId: run.id, stageIndex, ...(path !== undefined && { path }), ...(after !== undefined && { after }),
          ...(offset !== undefined && { offset }),
        } }),
        async start(input) {
          const result = await callMixed({ op: 'start', input });
          void callMixed({ op: 'status' }).then(setMixedStatus).catch(() => {});
          return result;
        },
        async action(op) {
          const result = await callMixed({ op });
          void callMixed({ op: 'status' }).then(setMixedStatus).catch(() => {});
          return result;
        } } : null,
      canStart: !error && remoteEnabled && (local ? local.runtimeReady && local.profile?.targetId === scope : connection?.hostKeyConfirmed) &&
        availableProviders.length > 0,
      localSdk: Boolean(local),
      onStart: (draft, task, projectId, workflowId) => invoke('start', draft, task, projectId, null, workflowId),
      readFileTarget: async (provider, signal) => (await resolveRoute(provider, signal, { dispatch: true })).targetId,
      saveAttachments: store.saveAttachments, readArtifacts,
      onResume: () => invoke('resume'), onPause: () => invoke('pause'), onStop: () => invoke('stop'),
    },
  };
}
