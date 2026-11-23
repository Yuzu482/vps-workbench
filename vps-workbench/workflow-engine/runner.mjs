import { exactFields, maxWorkflowChatLength, validateWorkflowDraft, validateWorkflowProjectId, workflowText, workflowUuid } from './state.mjs';
import { mixedStagePrompt, validateMixedInput, validateMixedTask } from './mixed-context.mjs';

export { validateMixedInput } from './mixed-context.mjs';

const targetIdPattern = /^[a-f0-9]{64}$/;
const activeStates = new Set(['pending', 'running', 'stopping']);
const terminalStates = new Set(['complete', 'failed', 'stopped']);
const knownStates = new Set([...activeStates, ...terminalStates, 'unknown']);
const rowStates = new Set([...knownStates, 'waiting', 'submitted', 'canceling', 'skipped']);
const stopIntentStates = new Set(['canceling', 'stopping']);
const phases = new Set([...terminalStates, 'running', 'paused']);
const pauseMessage = '运行已暂停。继续时将核对原步骤记录。';
const cancelingMessage = '后续步骤已停用。可查询原步骤，或再次停止原步骤。';
// Match the chat composer's confirmed pre-dispatch rejections.
const rejectedBeforeSend = new Set([
  'invalid_request', 'invalid_settings', 'session_blocked', 'turn_conflict', 'request_rejected', 'bridge_not_ready',
  'storage_before_send', 'mode_conflict', 'relay_required', 'workbench_browse_only', 'memory_scope_changed', 'target_changed',
  'workflow_stage_changed', 'workflow_modules_unavailable', 'workflow_file_access_changed', 'workflow_attachment_unavailable',
  'runtime_unavailable', 'auth_required', 'invalid_profile', 'profile_not_found', 'session_conflict', 'browse_only',
]);
const rejectedBeforeStop = new Set(['bridge_not_ready', 'relay_required', 'workbench_browse_only', 'target_changed']);
const mixedPreflightRejected = new Set([
  'mixed_preflight', 'mixed_route_changed', 'auth_required', 'relay_required', 'workbench_browse_only', 'browse_only',
  'runtime_unavailable', 'workflow_stage_changed', 'workflow_file_access_changed', 'workflow_modules_unavailable',
  'workflow_attachment_unavailable',
]);
const mixedReceiptBlocked = new Map([
  ['auth_required', '账号未通过校验'],
  ['rate_limited', '模型服务达到速率限制'],
  ['quota_exceeded', '模型额度不足'],
  ['relay_required', 'VPS 出口或 SSH 中继检查未通过'],
  ['egress_mismatch', 'VPS 出口与配置不符'],
  ['execution_unclassified', '执行端返回失败，无法确认具体原因'],
]);

function validTarget(value) {
  return typeof value === 'string' && targetIdPattern.test(value);
}

const blockedStates = new Set(['failed', 'stopped', 'skipped']);
const isBound = (row) => row.state !== 'waiting' && !blockedStates.has(row.state) && row.state !== 'complete';
const runningMessage = '工作流正在运行。';

function dependencies(workflow) {
  const indices = new Map(workflow.stages.map(({ id }, i) => [id, i]));
  const parents = workflow.stages.map(() => []);
  for (const { from, to } of workflow.edges) parents[indices.get(to)].push(indices.get(from));
  return parents;
}

function settle(value, failureMessage) {
  const parents = dependencies(value.workflow);
  const rows = [...value.rows];
  let changed;
  do {
    changed = false;
    for (const [i, row] of rows.entries()) {
      if (row.state === 'waiting' && (value.stopRequested || parents[i].some((p) => blockedStates.has(rows[p].state)))) {
        rows[i] = { ...row, state: 'skipped' };
        changed = true;
      }
    }
  } while (changed);
  if (rows.some((row) => isBound(row) || row.state === 'waiting')) return { ...value, rows };
  let phase = 'complete';
  if (value.stopRequested) phase = 'stopped';
  else if (rows.some((row) => row.state === 'failed')) phase = 'failed';
  else if (rows.some((row) => row.state === 'stopped')) phase = 'stopped';
  const message = phase === 'stopped' ? '工作流已停止。' : phase === 'complete' ? '工作流已完成。' :
    failureMessage ?? (value.phase === 'failed' ? value.message : '步骤生成失败。');
  return { ...value, rows, phase, message };
}

function validateRun(value) {
  const invalid = () => new Error('保存的工作流运行记录无效。');
  const version = value?.version;
  const legacy = version === 1;
  const mixed = version === 5;
  const scoped = version === 4 || mixed;
  const withProject = version === 3 || scoped;
  const fields = ['version', 'id', 'workflow', 'task', 'phase', 'rows', 'message'];
  if (!legacy) fields.push('stopRequested');
  if (withProject) fields.push('projectId');
  if (scoped) fields.push('workflowId');
  if (mixed) fields.push('mixed');
  if (![1, 2, 3, 4, 5].includes(version) || !exactFields(value, ...fields) || (!legacy && typeof value.stopRequested !== 'boolean') ||
      (scoped && value.workflowId !== null && !workflowUuid(value.workflowId)) ||
      (mixed && value.workflowId === null) ||
      !workflowUuid(value.id) || !phases.has(value.phase) || !Array.isArray(value.rows) ||
      typeof value.message !== 'string' || value.message.length > 500) throw invalid();
  if (legacy !== exactFields(value.workflow, 'name', 'stages')) throw invalid();
  const workflow = validateWorkflowDraft(value.workflow);
  if (workflow.stages.length !== value.rows.length || (!withProject && workflow.stages.some(({ agent }) => agent)) ||
      (!mixed && workflow.stages.some(({ execution }) => execution)) ||
      ((!scoped || value.workflowId === null) && workflow.stages.some(({ fileAccess }) => fileAccess))) throw invalid();
  const ids = new Set([value.id.toLowerCase()]);
  const rows = Array.from(value.rows, (row, i) => {
    if (!exactFields(row, 'targetId', 'sessionId', 'turnId', 'state', 'reply') || !validTarget(row.targetId) ||
        !workflowUuid(row.sessionId) || !workflowUuid(row.turnId) || !rowStates.has(row.state) ||
        (legacy && row.state === 'skipped') || typeof row.reply !== 'string' || row.reply.length > maxWorkflowChatLength ||
        (['waiting', 'submitted', 'skipped'].includes(row.state) && row.reply !== '') ||
        workflow.stages[i].agent?.mcpServers.some((server) => server.targetId !== row.targetId) ||
        (workflow.stages[i].fileAccess && workflow.stages[i].fileAccess.targetId !== row.targetId)) throw invalid();
    const sessionId = row.sessionId.toLowerCase();
    const turnId = row.turnId.toLowerCase();
    if (sessionId === turnId || ids.has(sessionId) || ids.has(turnId)) throw invalid();
    ids.add(sessionId);
    ids.add(turnId);
    return { ...row, sessionId, turnId };
  });
  const result = { version: legacy ? 2 : version, id: value.id.toLowerCase(), workflow, task: workflowText(value.task, 4000, '运行任务'),
    phase: value.phase, rows, message: value.message, stopRequested: value.stopRequested };
  if (withProject) result.projectId = validateWorkflowProjectId(value.projectId);
  if (scoped) result.workflowId = value.workflowId?.toLowerCase() ?? null;
  if (mixed) {
    result.mixed = validateMixedInput(workflow, value.mixed);
    validateMixedTask(workflow, result.task);
  }
  if (legacy) {
    const open = rows.findIndex((row) => row.state !== 'complete');
    const state = rows[open]?.state;
    if ((open !== -1 && rows.slice(open + 1).some((row) => row.state !== 'waiting')) ||
        (value.phase === 'complete' && open !== -1) || (value.phase === 'failed' && state !== 'failed') ||
        (value.phase === 'stopped' && open !== -1 && !['waiting', 'failed', 'stopped'].includes(state)) ||
        (value.phase === 'running' && stopIntentStates.has(state)) ||
        (['paused', 'running'].includes(value.phase) && ['failed', 'stopped'].includes(state))) throw invalid();
    result.stopRequested = value.phase === 'stopped' || stopIntentStates.has(state);
    return settle(result);
  }
  const parents = dependencies(workflow);
  if (rows.filter(isBound).length > 2 || (result.stopRequested && result.phase === 'running') ||
      rows.some((row, i) => {
        if (result.stopRequested && (row.state === 'waiting' || (isBound(row) && !stopIntentStates.has(row.state)))) return true;
        if (row.state === 'canceling' && !result.stopRequested) return true;
        if (row.state === 'skipped') return !result.stopRequested && !parents[i].some((p) => blockedStates.has(rows[p].state));
        return row.state !== 'waiting' && parents[i].some((p) => rows[p].state !== 'complete');
      })) throw invalid();
  const normalized = settle(result);
  if ((terminalStates.has(result.phase) && rows.some((row) => isBound(row) || row.state === 'waiting')) ||
      normalized.phase !== result.phase || normalized.rows.some((row, i) => row.state !== rows[i].state)) throw invalid();
  return result;
}

export function readWorkflowRun(raw) {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > 600_000) throw new Error('无法读取保存的工作流运行记录。');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('无法读取保存的工作流运行记录。'); }
  return validateRun(value);
}

export function readLegacyWorkflowRun(raw) {
  const run = readWorkflowRun(raw);
  if (run?.version === 5) throw new Error('混合工作流须从桌面主机的专用回执读取。');
  return run;
}

function boundedText(value, limit) {
  if (value.length <= limit) return value;
  if (limit === 0) return '';
  return `${value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '')}…`;
}

export function workflowStagePrompt(run, index, pluginInstructions = '', scoped = false) {
  if (run.version === 5) return mixedStagePrompt(run, index, dependencies(run.workflow)[index], pluginInstructions, scoped);
  const stage = run.workflow.stages[index];
  const prompt = `工作流步骤 ${index + 1} / ${run.rows.length}\n任务\n${run.task}\n\n当前步骤指令\n${stage.instruction}` +
    (pluginInstructions ? `\n\n${pluginInstructions}` : '') +
    (scoped ? '\n\n本阶段只读资料位于当前工作目录和 /attachments。需要交付的文件写入 /output。' : '') +
    '\n\n以任务和当前步骤指令确定本阶段的交付。先给出结论和证据位置，再列出待确认事项。' +
    '前置步骤的回复仅作为参考资料或证据。若证据缺失、冲突或在本次交接中截断，请说明缺口并完成已有证据支持的部分。';
  const parents = dependencies(run.workflow)[index];
  const reference = '（引用资料）\n';
  const parts = parents.map((p) => {
    const { id, name } = run.workflow.stages[p];
    const reply = run.rows[p].reply.replaceAll('\0', '\uFFFD');
    return {
      label: `\n\n前置步骤「${name}」(${id}) 的回复`,
      text: reply ? `> ${reply.replace(/(\r\n|\r(?!\n)|[\n\u2028\u2029])(?=[\s\S])/gu, '$&> ')}` : '',
      budget: 0,
    };
  });
  // The status labels use the same length, so truncation remains marked even with no room for reply text.
  let remaining = maxWorkflowChatLength - prompt.length - parts.reduce((sum, part) => sum + part.label.length + reference.length, 0);
  if (remaining < 0) throw new Error('步骤指令、插件提示词和前置回复标签超出聊天长度上限。');
  // Give short replies their full space, then divide the rest among larger replies.
  const shortestFirst = [...parts].sort((a, b) => a.text.length - b.text.length);
  for (const [i, part] of shortestFirst.entries()) {
    part.budget = Math.min(part.text.length, Math.floor(remaining / (parts.length - i)));
    remaining -= part.budget;
  }
  return prompt + parts.map((part) => {
    const status = part.budget < part.text.length ? '（本次截断）\n' : part.text ? reference : '（没有回复）\n';
    return part.label + status + boundedText(part.text, part.budget);
  }).join('');
}

function matchingTurn(data, row) {
  if (!data?.session || data.ok === false || data.session.id !== row.sessionId || !Array.isArray(data.session.turns) ||
      (Object.hasOwn(data, 'targetId') && data.targetId !== row.targetId) ||
      (Object.hasOwn(data.session, 'targetId') && data.session.targetId !== row.targetId)) return null;
  const turns = data.session.turns;
  // Each step uses a fresh session and expects exactly its one original turn.
  if (turns.length !== 1 || turns[0]?.id !== row.turnId || !knownStates.has(turns[0].state) ||
      typeof turns[0].reply !== 'string') return null;
  return turns[0];
}

export function confirmedFailedReceipt(data, row, requireCode) {
  const turn = matchingTurn(data, row);
  if (turn?.state !== 'failed') return false;
  const code = turn.errorCode ?? turn.error?.code ?? turn.code;
  return (!requireCode || typeof code === 'string' && Boolean(code)) && !mixedReceiptBlocked.has(code);
}

function rejectionMessage(error) {
  try { return workflowText(error.message, 500, '发送反馈'); } catch { return '步骤发送请求已被拒绝。'; }
}

function abortable(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

class RouteError extends Error {}

function routeUnavailable(stage) {
  return new RouteError(`步骤「${stage.name}」的连接已变更或不可用。`);
}

export function createWorkflowRunner({ initialRun = null, resolveRoute, readModels, rpc, persist, onChange,
  canDispatch = () => true, pollInterval = 1000 }) {
  let run = initialRun === null ? null : validateRun(initialRun);
  if (run?.phase === 'running') run = { ...run, phase: 'paused', message: pauseMessage };
  let active = null;
  let control = null;
  let disposed = false;

  function notify() {
    if (!disposed) onChange(run, active !== null || control !== null);
  }

  // Every transaction computes its update from the last committed snapshot.
  // Persist can be asynchronous; parallel RPCs never persist stale sibling rows.
  let writes = Promise.resolve();
  let journal;
  function save(transform) {
    const owner = journal;
    const pending = writes.then(async () => {
      if (owner.error) throw owner.error;
      const next = transform(run);
      if (next === run) return;
      try {
        if (await persist(next) === false) throw new Error();
      } catch {
        owner.error = new Error('无法保存工作流运行记录。');
        owner.controller.abort(owner.error);
        if (run && !terminalStates.has(run.phase)) {
          let rows = run.rows;
          if (next.stopRequested && !run.stopRequested) rows = next.rows;
          run = settle({ ...run, rows, stopRequested: run.stopRequested || next.stopRequested,
            phase: 'paused', message: '无法保存运行记录。请重新查询原步骤。' });
          notify();
        }
        throw owner.error;
      }
      run = next;
      notify();
    });
    writes = pending.catch(() => {});
    return pending;
  }

  function saveRow(index, update, message) {
    return save((current) => {
      const previous = current.rows[index];
      if (Object.entries(update).every(([key, value]) => previous[key] === value)) return current;
      const rows = current.rows.map((row, i) => i === index ? { ...row, ...update } : row);
      return settle({ ...current, rows, message: message ?? current.message }, update.state === 'failed' ? message : undefined);
    });
  }

  async function routeFor(stage, signal, dispatch, pinned = null, routePin = null) {
    let route;
    try {
      signal.throwIfAborted();
      route = await abortable(resolveRoute(stage.provider, signal, { dispatch, pinned, ...(routePin === null ? {} : { stage, routePin }) }), signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new RouteError(`无法确认步骤「${stage.name}」的连接。`, { cause: error });
    }
    if (!validTarget(route?.targetId) || route.settings?.provider !== stage.provider ||
        (pinned !== null && route.targetId !== pinned) || (routePin !== null && route.routePin !== routePin)) {
      throw routeUnavailable(stage);
    }
    return route;
  }

  function dispatchAllowed(route) {
    try { return canDispatch(route) === true; } catch { return false; }
  }

  async function checkModel(stage, route, signal) {
    if (!stage.model) return;
    let models;
    try {
      signal.throwIfAborted();
      models = await abortable(readModels(route, signal), signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new RouteError(`无法读取步骤「${stage.name}」的模型。`, { cause: error });
    }
    if (!Array.isArray(models) || !models.some((model) => model?.id === stage.model)) {
      throw new RouteError(`步骤「${stage.name}」配置的模型已不可用。`);
    }
  }

  function request(op, route, row, signal, payload = {}) {
    signal.throwIfAborted();
    return abortable(rpc(op, { settings: route.settings, targetId: row.targetId, sessionId: row.sessionId, ...payload }, signal), signal);
  }

  async function observe(index, op, signal, sendRoute = null, sendPrompt = null) {
    const stage = run.workflow.stages[index];
    const row = run.rows[index];
    let turn;
    let problem = '无法确认原步骤记录。请继续查询原步骤。';
    try {
      const route = sendRoute ?? await routeFor(stage, signal, false, row.targetId, run.mixed?.routePins[index]);
      const payload = op === 'send' ? { turnId: row.turnId, prompt: sendPrompt ?? workflowStagePrompt(run, index),
        ...(stage.model ? { model: stage.model } : {}), workflowStage: { runId: run.id } } : {};
      turn = matchingTurn(await request(op, route, row, signal, payload), row);
      if (op === 'get' && turn && (turn.state === 'unknown' || activeStates.has(turn.state))) {
        turn = matchingTurn(await request('refresh', route, row, signal), row);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (op === 'send' && run.version === 5 && (mixedPreflightRejected.has(error?.code) ||
          (error?.beforeDispatch === true && mixedReceiptBlocked.has(error?.code)))) {
        // Only a confirmed pre-dispatch rejection permits a retry with the original receipt IDs.
        const reason = rejectionMessage(error);
        await saveRow(index, { state: 'waiting' }, reason);
        return reason;
      }
      if (op === 'send' && rejectedBeforeSend.has(error?.code)) {
        await saveRow(index, { state: 'failed' }, rejectionMessage(error));
        return;
      }
      if (error instanceof RouteError) problem = error.message;
    }
    signal.throwIfAborted();
    if (!turn || turn.state === 'unknown') {
      await saveRow(index, { state: run.stopRequested ? row.state : 'unknown' }, problem);
      return problem;
    }
    const receiptBlock = run.version === 5 && turn.state === 'failed' &&
      mixedReceiptBlocked.get(turn.errorCode ?? turn.error?.code ?? turn.code);
    if (receiptBlock && !run.stopRequested) {
      // The original turn exists. Preserve the binding and query it on resume, never replay it.
      const reason = receiptBlock + '。请核对原步骤回执，或停止本次运行。';
      await saveRow(index, { state: 'unknown', reply: boundedText(turn.reply, maxWorkflowChatLength) }, reason);
      return reason;
    }
    const state = run.stopRequested && !terminalStates.has(turn.state) ? row.state : turn.state;
    await saveRow(index, { state, reply: boundedText(turn.reply, maxWorkflowChatLength) },
      state === 'failed' ? '步骤生成失败。' : undefined);
    if (run.stopRequested && isBound(run.rows[index])) return cancelingMessage;
  }

  async function driveRow(index, signal) {
    const row = run.rows[index];
    if (row.state === 'waiting') {
      const stage = run.workflow.stages[index];
      let route;
      let prompt;
      try {
        if (run.version === 5) prompt = workflowStagePrompt(run, index);
        route = await routeFor(stage, signal, true, row.targetId, run.mixed?.routePins[index]);
        await checkModel(stage, route, signal);
        if (!dispatchAllowed(route)) throw routeUnavailable(stage);
      } catch (error) {
        signal.throwIfAborted();
        return error.message;
      }
      signal.throwIfAborted();
      await saveRow(index, { state: 'submitted' });
      if (signal.aborted || !dispatchAllowed(route)) {
        // This process has not invoked the RPC. Reuse its binding only after a durable rollback.
        await saveRow(index, { state: 'waiting' });
        return signal.aborted ? pauseMessage : routeUnavailable(stage).message;
      }
      const problem = await observe(index, 'send', signal, route, prompt);
      if (problem) return problem;
    } else {
      const problem = await observe(index, row.state === 'stopping' ? 'refresh' : 'get', signal);
      if (problem) return problem;
    }
    while (!run.stopRequested && isBound(run.rows[index])) {
      await delay(pollInterval, signal);
      const problem = await observe(index, 'refresh', signal);
      if (problem) return problem;
    }
  }

  async function advance(signal) {
    const parents = dependencies(run.workflow);
    const workers = new Map();
    const blocked = new Map();
    try {
      for (;;) {
        signal.throwIfAborted();
        if (terminalStates.has(run.phase)) break;
        const available = (i) => !workers.has(i) && !blocked.has(i);
        const launch = (i) => {
          const done = driveRow(i, signal).then((problem) => {
            if (problem) blocked.set(i, problem);
          }).finally(() => workers.delete(i));
          // Observe each rejection even when another worker is being awaited.
          done.catch(() => {});
          workers.set(i, done);
        };
        for (const [i, row] of run.rows.entries()) {
          if (isBound(row) && available(i)) launch(i);
        }
        // A bound but unconfirmed send still occupies a slot after its local query returns.
        let slots = 2 - run.rows.filter((row, i) => isBound(row) || workers.has(i)).length;
        if (!run.stopRequested) {
          for (const [i, row] of run.rows.entries()) {
            if (slots > 0 && available(i) && row.state === 'waiting' && parents[i].every((p) => run.rows[p].state === 'complete')) {
              launch(i);
              slots--;
            }
          }
        }
        if (!workers.size) break;
        await Promise.race(workers.values());
      }
    } finally {
      await Promise.allSettled(workers.values());
    }
    signal.throwIfAborted();
    if (!terminalStates.has(run.phase)) {
      await save((current) => ({ ...current, phase: 'paused', message: blocked.values().next().value ?? pauseMessage }));
    }
  }

  async function stopRow(index, signal) {
    const row = run.rows[index];
    if (row.state === 'stopping') return observe(index, 'refresh', signal);
    let route;
    try {
      route = await routeFor(run.workflow.stages[index], signal, false, row.targetId, run.mixed?.routePins[index]);
    } catch (error) {
      signal.throwIfAborted();
      return error.message;
    }
    signal.throwIfAborted();
    await saveRow(index, { state: 'stopping' });
    if (signal.aborted) {
      await saveRow(index, { state: 'canceling' });
      return cancelingMessage;
    }
    try {
      const data = await request('stop', route, row, signal, { turnId: row.turnId });
      if (data?.ok === false || (data?.outcome !== 'requested' && data?.outcome !== 'settled')) throw new Error();
    } catch (error) {
      signal.throwIfAborted();
      if (rejectedBeforeStop.has(error?.code)) {
        await saveRow(index, { state: 'canceling' });
        return rejectionMessage(error);
      }
      return '无法确认停止请求。请继续查询原步骤。';
    }
    return observe(index, 'refresh', signal);
  }

  async function withJournal(operation, signal) {
    journal = { controller: new AbortController(), error: null };
    try {
      return await operation(AbortSignal.any([signal, journal.controller.signal]));
    } finally {
      await writes;
      if (journal.error) throw journal.error;
    }
  }

  function begin(operation) {
    if (disposed || active || control) throw new Error('工作流正在处理另一项操作。');
    const controller = new AbortController();
    const task = { controller, done: null };
    task.done = Promise.resolve().then(() => withJournal(operation, controller.signal)).catch((error) => {
      if (!controller.signal.aborted) throw error;
    }).finally(() => {
      if (active === task) active = null;
      notify();
    });
    active = task;
    notify();
    return task.done;
  }

  function interrupt(operation, stopping = false) {
    if (disposed) return Promise.resolve();
    if (control && (!stopping || control.stopping)) return control.done;
    const previous = control ?? active;
    active?.controller.abort();
    const controller = new AbortController();
    const task = { controller, done: null, stopping };
    task.done = Promise.resolve(previous?.done).catch(() => {}).then(() => {
      if (!controller.signal.aborted && run && !terminalStates.has(run.phase)) return withJournal(operation, controller.signal);
    }).catch((error) => {
      if (!controller.signal.aborted) throw error;
    }).finally(() => {
      if (control === task) control = null;
      notify();
    });
    control = task;
    notify();
    return task.done;
  }

  notify();
  return {
    async start(draft, input, projectId = null, expectedTarget = null, workflowId = null, mixed = null) {
      if (run && !terminalStates.has(run.phase)) throw new Error('请先处理尚未结束的工作流运行。');
      const workflow = validateWorkflowDraft(draft);
      const task = workflowText(input, 4000, '运行任务');
      if (mixed === null && workflow.stages.some(({ execution }) => execution)) {
        throw new Error('显式绑定执行配置的工作流须从混合工作流入口启动。');
      }
      if (mixed !== null) {
        if (!workflowUuid(workflowId) || expectedTarget !== null) throw new Error('混合工作流须从保存的版本启动。');
        mixed = validateMixedInput(workflow, mixed);
        validateMixedTask(workflow, task);
      }
      if ((workflowId !== null && !workflowUuid(workflowId)) ||
          (workflowId === null && workflow.stages.some(({ fileAccess }) => fileAccess))) {
        throw new Error('请先保存文件授权，再运行工作流。');
      }
      const metadata = { version: mixed === null ? 4 : 5, projectId: validateWorkflowProjectId(projectId),
        workflowId: workflowId?.toLowerCase() ?? null, ...(mixed === null ? {} : { mixed }) };
      return begin(async (signal) => {
        const routes = [];
        for (const [index, stage] of workflow.stages.entries()) {
          const fileTarget = stage.fileAccess?.targetId;
          const route = await routeFor(stage, signal, true, fileTarget ?? expectedTarget ?? stage.agent?.mcpServers[0]?.targetId ?? null,
            mixed?.routePins[index]);
          if ((expectedTarget && expectedTarget !== route.targetId) ||
              stage.agent?.mcpServers.some((server) => server.targetId !== route.targetId)) throw routeUnavailable(stage);
          await checkModel(stage, route, signal);
          routes.push(route);
        }
        signal.throwIfAborted();
        const stale = routes.findIndex((route) => !dispatchAllowed(route));
        signal.throwIfAborted();
        if (stale !== -1) throw routeUnavailable(workflow.stages[stale]);
        const rows = routes.map(({ targetId }) => ({ targetId, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(),
          state: 'waiting', reply: '' }));
        await save(() => ({ ...metadata, id: crypto.randomUUID(), workflow, task, phase: 'running', rows, stopRequested: false, message: runningMessage }));
        await advance(signal);
      });
    },

    async retryFailed(source, index) {
      if (run && !terminalStates.has(run.phase)) throw new Error('请先处理尚未结束的工作流运行。');
      if (source.version !== 5 || source.phase !== 'failed' || source.stopRequested || source.rows[index]?.state !== 'failed') {
        throw new Error('只有已确认失败的混合阶段可以重试。');
      }
      return begin(async (signal) => {
        const fresh = source.rows.map((row, position) => position === index || row.state === 'skipped'
          ? { ...row, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), state: 'waiting', reply: '' } : row);
        const next = settle({ ...source, id: crypto.randomUUID(), phase: 'running', message: runningMessage, rows: fresh });
        for (const [position, row] of next.rows.entries()) {
          if (row.state !== 'waiting') continue;
          const stage = next.workflow.stages[position];
          const route = await routeFor(stage, signal, true, row.targetId, next.mixed.routePins[position]);
          await checkModel(stage, route, signal);
          if (!dispatchAllowed(route)) throw routeUnavailable(stage);
        }
        signal.throwIfAborted();
        await save(() => next);
        await advance(signal);
      });
    },

    async resume() {
      if (run?.phase !== 'paused') throw new Error('没有待继续的工作流运行。');
      return begin(async (signal) => {
        if (!run.stopRequested) await save((current) => ({ ...current, phase: 'running', message: runningMessage }));
        await advance(signal);
      });
    },

    pause() {
      return interrupt(() => save((current) => ({ ...current, phase: 'paused', message: current.stopRequested ? cancelingMessage : pauseMessage })));
    },

    stop() {
      return interrupt(async (signal) => {
        await save((current) => settle({ ...current, phase: 'paused', message: cancelingMessage, stopRequested: true,
          rows: current.rows.map((row) => isBound(row) && !stopIntentStates.has(row.state) ? { ...row, state: 'canceling' } : row) }));
        signal.throwIfAborted();
        const results = await Promise.allSettled(run.rows.map((row, i) => isBound(row) ? stopRow(i, signal) : undefined));
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        const problem = results.find((result) => result.value)?.value;
        if (problem && !terminalStates.has(run.phase)) await save((current) => ({ ...current, message: problem }));
      }, true);
    },

    dispose() {
      disposed = true;
      active?.controller.abort();
      control?.controller.abort();
      return Promise.allSettled([active?.done, control?.done, writes]);
    },
  };
}
