import { createHash } from 'node:crypto';
import { createWorkflowRunner, readWorkflowRun, validateMixedInput } from '../workflow-engine/runner.mjs';
import { exactFields, mixedWorkflowRunKey, readWorkflows, validateWorkflowDraft, workflowKey, workflowText } from '../workflow-engine/state.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const problem = (code, message) => ({ ok: false, code, message });
const changed = problem('mixed_route_changed', '原执行配置、授权或连接已变化。请核对后查询原阶段。');
const forbidden = problem('workbench_browse_only', '当前为仅浏览模式。');
const pending = (run) => run?.phase === 'paused' || run?.phase === 'running';
const refused = (reply) => Object.assign(new Error(reply.message || '执行配置拒绝了该操作。'),
  { code: reply.code, beforeDispatch: reply.beforeDispatch === true });

export function openMixedWorkflow({ data, canExecute, targets, resolve, catalog, dispatch, pollInterval }) {
  let run = null;
  let running = false;
  let preparing = false;
  let launch;
  let failure = '';
  let unreadable = false;
  try {
    run = readWorkflowRun(data.preference(mixedWorkflowRunKey) ?? null);
    if (run && run.version !== 5) throw new Error('invalid_mixed_receipt');
  } catch { run = null; unreadable = true; failure = '无法读取混合工作流回执。'; }
  const saved = (id) => readWorkflows(data.preference(workflowKey) ?? null).find((record) => record.id === id);
  const approved = () => launch ?? (run && { id: run.workflowId, definitionPin: run.mixed.definitionPin });
  function isLive(route, operation) {
    try {
      if (!canExecute() || !route.isCurrent()) return false;
      if (operation !== 'send') return true;
      const binding = approved();
      return binding && hash(saved(binding.id) ?? null) === binding.definitionPin;
    } catch { return false; }
  }
  async function resolveRoute(provider, signal, { stage, pinned, routePin, dispatch: submitting }) {
    signal.throwIfAborted();
    const route = await resolve(stage);
    signal.throwIfAborted();
    if (!route || route.settings.provider !== provider || (pinned && route.targetId !== pinned) ||
        route.routePin !== routePin || !isLive(route, submitting ? 'send' : 'get')) throw new Error(changed.message);
    return route;
  }
  const runner = createWorkflowRunner({ initialRun: run, resolveRoute, readModels: (route) => catalog(route), pollInterval,
    canDispatch: (route) => isLive(route, 'send'),
    async persist(snapshot) { await data.setPreference(mixedWorkflowRunKey, JSON.stringify(snapshot)); },
    onChange(snapshot, active) { run = snapshot; running = active; },
    async rpc(op, body, signal) {
      const index = run.rows.findIndex((row) => row.targetId === body.targetId && row.sessionId === body.sessionId &&
        (body.turnId === undefined || row.turnId === body.turnId));
      if (index < 0) throw refused(changed);
      const stage = run.workflow.stages[index];
      const row = run.rows[index];
      let route;
      try { route = await resolveRoute(stage.provider, signal, { stage, pinned: body.targetId,
        routePin: run.mixed.routePins[index], dispatch: op === 'send' }); }
      catch { signal.throwIfAborted(); throw refused(changed); }
      const isAllowed = () => !signal.aborted && isLive(route, op);
      if (!isAllowed()) throw refused(changed);
      const reply = await dispatch(op, { ...body, settings: route.settings,
        ...(op === 'refresh' && stage.execution.location === 'local-sdk' && { turnId: row.turnId }) }, route,
      { isLive: isAllowed, workflowRun: () => run });
      if (reply?.ok === false) throw refused(reply);
      if (stage.execution.location === 'ssh-vps' && reply?.session?.turns?.some((turn) => turn.state === 'failed' && !turn.errorCode)) {
        return { ...reply, session: { ...reply.session, turns: reply.session.turns.map((turn) =>
          turn.state === 'failed' && !turn.errorCode && !turn.error?.code && !turn.code
            ? { ...turn, errorCode: 'execution_unclassified' } : turn) } };
      }
      return reply;
    },
  });

  function observe(promise) {
    void promise.catch((error) => { failure = error.message || '混合工作流已暂停。'; });
    return { ok: true };
  }
  return {
    status() { return { ok: true, run, running: running || preparing, error: failure }; },
    targets,
    async catalog(stage) {
      if (!canExecute()) return forbidden;
      const route = await resolve(stage);
      if (!canExecute()) return forbidden;
      if (!route || !route.isCurrent()) return changed;
      return { ok: true, models: await catalog(route) };
    },
    async artifacts(query) {
      const fields = ['runId', 'stageIndex', ...['path', 'after', 'offset'].filter((field) => Object.hasOwn(query ?? {}, field))];
      if (!exactFields(query, ...fields) || query.runId !== run?.id || !Number.isInteger(query.stageIndex)) return changed;
      const { stageIndex, runId, ...pagination } = query;
      const stage = run.workflow.stages[stageIndex];
      const row = run.rows[stageIndex];
      if (!stage || !row || !canExecute()) return forbidden;
      const route = await resolve(stage);
      const isAllowed = () => run?.id === runId && canExecute() && route?.routePin === run.mixed.routePins[stageIndex] &&
        route.targetId === row.targetId && route.isCurrent();
      if (!isAllowed()) return changed;
      return dispatch('workflow-artifacts', { ...pagination, settings: route.settings, targetId: row.targetId,
        sessionId: row.sessionId, turnId: row.turnId, workflowRunId: runId }, route, { isLive: isAllowed, workflowRun: () => run });
    },
    async start(input) {
      if (!canExecute()) return forbidden;
      if (unreadable || running || preparing || pending(run)) return problem('mixed_busy', '请先处理原混合工作流。');
      if (!exactFields(input, 'workflowId', 'revision', 'task', 'criteria', 'constraints', 'evidence', 'transfers'))
        return problem('mixed_preflight', '请确认任务简报和交接范围。');
      failure = '';
      preparing = true;
      try {
        const { workflowId, task: inputTask, ...spec } = input;
        const record = saved(workflowId);
        if (!record || record.revision !== spec.revision) return changed;
        const workflow = validateWorkflowDraft({ name: record.name, stages: record.stages, edges: record.edges });
        const task = workflowText(inputTask, 4000, '运行任务');
        const definitionPin = hash(record);
        const mixed = validateMixedInput(workflow, { ...spec, definitionPin,
          routePins: workflow.stages.map(() => '0'.repeat(64)) });
        const routes = [];
        for (const stage of workflow.stages) {
          if (!canExecute()) return forbidden;
          const route = await resolve(stage);
          if (!canExecute()) return forbidden;
          if (!route?.isCurrent()) return changed;
          const models = await catalog(route);
          const model = stage.model || route.defaultModel || models.find((item) => item.isDefault)?.id;
          if (!model || !models.some(({ id }) => id === model)) return problem('mixed_preflight',
            `阶段「${stage.name}」没有可固定的模型。请读取目录并明确选择一个模型。`);
          stage.model = model;
          routes.push(route);
        }
        if (!canExecute() || hash(saved(workflowId) ?? null) !== definitionPin || !routes.every((route) => route.isCurrent())) return changed;
        launch = { id: workflowId, definitionPin };
        mixed.routePins = routes.map((route) => route.routePin);
        const started = runner.start(workflow, task, null, null, workflowId, mixed);
        return observe(started.finally(() => { launch = null; }));
      } catch (error) {
        return problem('mixed_preflight', error.message || '请检查混合工作流的配置。');
      } finally { preparing = false; }
    },
    action(action) {
      if (unreadable || !pending(run) || preparing) return changed;
      if (action !== 'pause' && !canExecute()) return forbidden;
      failure = '';
      if (action === 'pause') return observe(runner.pause());
      if (action === 'stop') return observe(runner.stop());
      if (action === 'resume' && !running) return observe(runner.resume());
      return changed;
    },
    pause() { if (running || pending(run)) return runner.pause(); },
    dispose: () => runner.dispose(),
  };
}

export async function requestMixedWorkflow(mixed, body) {
  if (mixed) {
    try {
      if (body?.op === 'status' && exactFields(body, 'op')) return mixed.status();
      if (body?.op === 'targets' && exactFields(body, 'op')) return await mixed.targets();
      if (body?.op === 'catalog' && exactFields(body, 'op', 'stage')) return await mixed.catalog(body.stage);
      if (body?.op === 'artifacts' && exactFields(body, 'op', 'query')) return await mixed.artifacts(body.query);
      if (body?.op === 'start' && exactFields(body, 'op', 'input')) return await mixed.start(body.input);
      if (['pause', 'stop', 'resume'].includes(body?.op) && exactFields(body, 'op')) return mixed.action(body.op);
    } catch { return problem('mixed_preflight', '暂时无法使用所选执行配置。请核对连接和账号。'); }
  }
  return problem('invalid_request', '混合工作流操作不可用。');
}

export function mixedLocalRoute(stage, codex) {
  if (stage?.execution?.location !== 'local-sdk' || stage.provider !== 'codex' || !codex?.sdk.runtimeAvailable) return null;
  const profile = codex.service.status().profiles.find(({ id }) => id === stage.execution.configId);
  if (!profile) return null;
  const routePin = hash(['local-sdk', profile, codex.sdk.workflowCredentialPin]);
  return { routePin, targetId: profile.targetId, defaultModel: profile.model,
    settings: { location: 'local-sdk', provider: 'codex', profileId: profile.id },
    isCurrent: () => codex.sdk.runtimeAvailable && hash(['local-sdk',
      codex.service.status().profiles.find(({ id }) => id === profile.id), codex.sdk.workflowCredentialPin]) === routePin };
}

export function mixedVpsRoute(stage, preset, currentPreset, reply, readRelay) {
  const { provider, execution } = stage ?? {};
  if (execution?.location !== 'ssh-vps' || execution.configId !== preset?.memoryTargetId ||
      !preset.providers.includes(provider) || reply?.ok !== true || reply.memoryTargetId !== preset.memoryTargetId ||
      !/^[a-f0-9]{64}$/.test(reply.targetId)) return null;
  const pinnedRelay = JSON.stringify(readRelay());
  const settings = { ...preset.settings, provider };
  return { routePin: hash(['ssh-vps', reply.targetId, settings, pinnedRelay]), targetId: reply.targetId, settings, pinnedRelay,
    isCurrent: () => currentPreset() && JSON.stringify(readRelay()) === pinnedRelay };
}
