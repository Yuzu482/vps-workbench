import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readModelCatalog } from '../../remote-workbench/vps-chat/client/model-catalog.js';
import {
  membershipKey, parseProjectMemberships, projectMembershipFor, projectMembershipId, projectMembershipIsolated,
} from '../../remote-workbench/vps-chat/client/project-folders.js';
import { memoryJournalKey } from './data.mjs';
import {
  automaticMemoryPolicy, conversationIsolated, extensionPreferenceKey, extensionsForTurn, projectMemoryNotes, readExtensions,
  readMemoryExtractionChange,
} from '../extensions/state.mjs';
import { readWorkflows, workflowKey, workflowRunKey } from '../workflow-engine/state.mjs';
import { readWorkflowRun } from '../workflow-engine/runner.mjs';
import { withWorkspaceAccess } from './access.mjs';
import { changedWorkflowFileAccess, changedWorkflowStage, prepareWorkflowStage } from './workflow-stage.mjs';

const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const providers = new Set(['codex', 'claude', 'claude-sdk', 'antigravity']);
const running = new Set(['pending', 'running', 'stopping']);
const disabled = { ok: false, code: 'workbench_browse_only', message: '工作台处于仅浏览模式。' };
const changed = { ok: false, code: 'memory_scope_changed', message: '记忆设置已变化，请重新发送。' };
const rejectedBeforeSend = new Set([
  'invalid_request', 'invalid_settings', 'target_changed', 'mode_conflict', 'turn_conflict', 'storage_before_send',
  'session_blocked', 'bridge_not_ready', 'relay_required', 'request_rejected', 'design_branch_unavailable',
]);
const emptyJournal = () => ({ jobs: [] });
const sessionKey = ({ targetId, sessionId }) => `${targetId}:${sessionId}`;
const jobKey = ({ targetId, sessionId, turnId }) => `${sessionKey({ targetId, sessionId })}:${turnId}`;
const referencesPriorTurn = /^(?:请)?(?:继续(?:吧)?|接着(?:做|来)|照旧|(?:按(?:照)?|沿用|用)(?:原来|之前|上次|上一轮|刚才)的(?:方案|设计|风格|设置|约定|要求|规范|规格|做法)(?:继续|做)?)[\s。！？.!?]*$/u;

// Keep originals in their conversation. The auxiliary request receives only a bounded, redacted turn.
function safeText(value, limit) {
  return value.replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g, '[已隐藏凭据]')
    .replace(/\b(?:sk-(?:ant-|proj-)?|gh[pousr]_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{12,}\b/g, '[已隐藏凭据]')
    .replace(/\b(?:api[_ -]?key|password|access[_ -]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '[已隐藏凭据]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').trim().slice(0, limit);
}

function boundedEvidence(value, maxBytes) {
  value = value.toWellFormed();
  let bytes = 2;
  let end = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return value.slice(0, end).trimEnd();
}

function extractionPrompt(turn) {
  if (typeof turn.prompt !== 'string' || typeof turn.reply !== 'string') return null;
  const prompt = boundedEvidence(safeText(turn.prompt, 2500), 5000);
  const reply = boundedEvidence(safeText(turn.reply.replace(/```[\s\S]*?(?:```|$)/g, '[代码块]'), 1600), 2850);
  if (!prompt || !reply) return null;
  // The renderer/source turn can contain arbitrary text. Only these two quoted JSON values are evidence.
  return JSON.stringify({ prompt, reply });
}

function readCandidates(reply) {
  if (typeof reply !== 'string' || reply.length > 8192 || Buffer.byteLength(reply) > 8192) return null;
  try {
    const parsed = JSON.parse(reply);
    const candidates = parsed?.memories;
    if (!parsed || Object.keys(parsed).length !== 1 || !Array.isArray(candidates) || candidates.length > 3) return null;
    if (candidates.some((note) => !note || Object.keys(note).length !== 2 || typeof note.title !== 'string' ||
      typeof note.text !== 'string' || !note.title.trim() || note.title.length > 80 || /[\r\n\t]/.test(note.title) ||
      !note.text.trim() || note.text.length > 2000 || Buffer.byteLength(note.text) > 2400)) return null;
    return candidates.filter(({ title, text }) => title === safeText(title, 80) && text === safeText(text, 2000));
  } catch { return null; }
}

function journalFrom(raw) {
  if (!raw) return emptyJournal();
  const value = JSON.parse(raw);
  if (!Array.isArray(value?.jobs) || value.jobs.length > 256 ||
      value.jobs.some((job) => !digest.test(job?.targetId) || !digest.test(job.memoryTargetId) ||
        !uuid.test(job.sessionId) || !uuid.test(job.turnId) || (job.projectId !== null && typeof job.projectId !== 'string') ||
        !Number.isSafeInteger(job.revision) || !['watching', 'reserved', 'settled'].includes(job.phase) ||
        (Object.hasOwn(job, 'workflowShared') && job.workflowShared !== true) ||
        (Object.hasOwn(job, 'workflowRunId') && (job.workflowShared !== true || !uuid.test(job.workflowRunId))) ||
        (job.phase === 'reserved' && (!uuid.test(job.taskId) || !uuid.test(job.extractionSessionId)))))
    throw new Error('invalid_memory_journal');
  return value;
}

function replaceTurnMemory(body, memory, mcpServers) {
  const servers = mcpServers ?? (body.settings.provider === 'codex' ? body.extensions?.mcpServers ?? [] : []);
  delete body.extensions;
  if (memory.length || servers.length) body.extensions = { memory, mcpServers: servers };
}

export function createProjectMemoryBridge({ data, backend, extractor, access, onChange = () => {}, onError = () => {},
  pollInterval = 2000, pollLimit = 80, readRun = () => readWorkflowRun(data.preference(workflowRunKey) ?? null),
  readSavedWorkflow = (id) => readWorkflows(data.preference(workflowKey) ?? null).find((workflow) => workflow.id === id),
  journalKey = memoryJournalKey, prepareStage = prepareWorkflowStage, locationName = 'VPS', scopedPersonal = false }) {
  let journal;
  let journalUnavailable = false;
  try { journal = journalFrom(data.preference(journalKey)); }
  catch { journalUnavailable = true; journal = emptyJournal(); }
  let writes = Promise.resolve();
  let worker = Promise.resolve();
  const queued = new Set();
  const watches = new Map();
  const extractionRoutes = new Map();
  const stop = new AbortController();

  function update(change) {
    const pending = writes.then(async () => {
      const next = change(journal);
      if (next === journal) return;
      await data.setPreference(journalKey, JSON.stringify(next));
      journal = next;
    });
    writes = pending.catch(() => {});
    return pending;
  }

  const state = () => readExtensions(data.preference(extensionPreferenceKey) ?? null);
  const canExecute = () => !stop.signal.aborted && access().mode === 'execute';
  const isProject = (id) => data.projects().some(({ workspaceId }) => workspaceId === id);
  const extractionChoice = (targetId) => state().memoryExtractionModels.find(choice => choice.targetId === targetId);

  async function checkExtractionChoice(settings, { targetId, model, effort }) {
    let models;
    try {
      const packet = await backend.request({ op: 'models', settings, targetId }, { current: true });
      if (packet?.ok !== true) return 'memory_extraction_catalog_unavailable';
      models = readModelCatalog(packet);
    } catch { return 'memory_extraction_catalog_unavailable'; }
    const entry = models.find(({ id }) => id === model);
    return entry && (effort === undefined || entry.efforts.includes(effort)) ? null : 'memory_extraction_model_unavailable';
  }

  function readMembership({ targetId, sessionId }) {
    try {
      const memberships = parseProjectMemberships(data.preference(membershipKey(targetId)));
      return projectMembershipFor(memberships, sessionId);
    } catch { return null; }
  }

  function inMemoryScope(projectId, assignment, workflowShared = false) {
    // A workflow can select a project for its new session before it has a sidebar assignment.
    if (workflowShared && assignment === undefined) return projectId === null || isProject(projectId);
    return assignment !== null && !projectMembershipIsolated(assignment) &&
      (projectMembershipId(assignment) || null) === projectId && (projectId === null || isProject(projectId));
  }

  function currentPolicy(job, current = state()) {
    if (!inMemoryScope(job.projectId, readMembership(job), job.workflowShared)) return false;
    const policy = automaticMemoryPolicy(current, { targetId: job.memoryTargetId, projectId: job.projectId, scopedPersonal });
    return policy?.enabled && policy.revision === job.revision && !conversationIsolated(current, job);
  }

  const eligible = (job) => canExecute() && currentPolicy(job);

  function settle(job) {
    return update((previous) => ({ ...previous, jobs: previous.jobs.map((existing) =>
      jobKey(existing) === jobKey(job) ? { ...existing, phase: 'settled' } : existing) }));
  }

  function stopWatching(key) {
    const watch = watches.get(key);
    if (watch) clearTimeout(watch.timer);
    watches.delete(key);
  }

  function watchSource(job, body) {
    const key = jobKey(job);
    const existing = watches.get(key);
    if (existing) {
      existing.observedAt = Date.now();
      return;
    }
    if (!currentPolicy(job)) {
      void settle(job).catch(() => {});
      return;
    }
    if (!canExecute()) return;
    const interval = Math.max(5000, pollInterval * 2);
    const watch = { observedAt: Date.now(), interval, timer: null };
    watches.set(key, watch);
    function schedule() {
      if (!watches.has(key)) return;
      watch.timer = setTimeout(async () => {
        try {
          if (!currentPolicy(job)) {
            stopWatching(key);
            await settle(job);
            return;
          }
          if (!canExecute()) return stopWatching(key);
          // The renderer already refreshes the active conversation. Take over only after it leaves.
          if (Date.now() - watch.observedAt >= interval) {
            const query = { op: 'refresh', settings: body.settings, targetId: job.targetId, sessionId: job.sessionId };
            observe(query, await backend.request(query, { current: true }));
            watch.interval = Math.min(30000, watch.interval * 2);
          }
        } catch { /* A later status read can still reconcile the original turn. */ }
        schedule();
      }, watch.interval);
      watch.timer.unref();
    }
    schedule();
  }

  async function extract(job, body, source) {
    if (!eligible(job)) return settle(job);
    const settings = { ...body.settings, provider: 'codex' };
    if (job.phase === 'watching') {
      let userPrompt = source.prompt;
      if (job.workflowShared) {
        let run;
        try { run = readRun(job.workflowRunId); } catch { return settle(job); }
        if ((job.workflowRunId && run?.id !== job.workflowRunId) || (run?.projectId ?? null) !== job.projectId ||
            !run?.rows.some(({ targetId, sessionId, turnId }) =>
              targetId === job.targetId && sessionId === job.sessionId && turnId === job.turnId)) return settle(job);
        userPrompt = run.task;
      }
      const prompt = extractionPrompt({ prompt: userPrompt, reply: source.reply });
      if (!prompt) return settle(job);
      const choice = extractionChoice(job.memoryTargetId);
      const { model, effort } = choice ?? {};
      function sameChoice() {
        const latest = extractionChoice(job.memoryTargetId);
        return latest?.model === model && latest?.effort === effort;
      }
      if (choice) {
        const problem = await checkExtractionChoice(settings, choice);
        if (!eligible(job) || !sameChoice()) return settle(job);
        if (problem) {
          onError(problem === 'memory_extraction_catalog_unavailable'
            ? (scopedPersonal ? '无法读取本机 Codex 模型目录，本轮未提炼记忆。' : '无法读取此 VPS 的 Codex 模型目录，本轮未提炼记忆。')
            : `${locationName}已不提供所选的记忆提炼模型或推理强度，请在记忆设置中调整。`);
          return settle(job);
        }
      }
      const reserved = { ...job, phase: 'reserved', taskId: randomUUID(), extractionSessionId: randomUUID() };
      await update((previous) => ({ ...previous, jobs: previous.jobs.map((item) =>
        jobKey(item) === jobKey(job) ? reserved : item) }));
      job = reserved;
      if (!eligible(job) || !sameChoice()) return settle(job);
      // Reserve the ID before dispatch, so reopening only looks up this receipt.
      const launched = await extractor.request({ op: 'send', settings, targetId: job.memoryTargetId,
        sessionId: job.extractionSessionId,
        turnId: job.taskId, prompt, memoryExtraction: true, workspaceAccess: 'isolated',
        ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }),
        ...(job.projectId === null ? { memoryScope: 'personal' } : {}) }, { current: true });
      if (launched?.ok === false && launched.code !== 'unknown') {
        onError(`本轮自动记忆提炼未完成，请检查${locationName}的 Codex。`);
        return settle(job);
      }
    }
    for (let attempt = 0; attempt < pollLimit && eligible(job); attempt++) {
      const packet = await extractor.request({ op: 'refresh', settings, targetId: job.memoryTargetId,
        sessionId: job.extractionSessionId }, { current: true });
      const result = packet?.session?.id === job.extractionSessionId
        ? packet.session.turns?.find(({ id }) => id === job.taskId) : null;
      if (result?.state === 'complete') {
        const candidates = readCandidates(result.reply);
        if (!candidates) onError('提炼结果格式无效，本轮记忆未更新。');
        else if (eligible(job)) {
          const updated = await data.changeExtensions({ op: 'accept-automatic-memory',
            targetId: job.memoryTargetId, projectId: job.projectId, revision: job.revision,
            source: { targetId: job.targetId, sessionId: job.sessionId, turnId: job.turnId, provider: body.settings.provider },
            candidates }, { canCommit: () => eligible(job) });
          if (updated) onChange(updated);
        }
        return settle(job);
      }
      if ((result && !running.has(result.state) && result.state !== 'unknown') ||
          (packet?.ok === false && packet.code === 'session_missing')) {
        onError(`本轮自动记忆提炼未完成，请检查${locationName}的 Codex。`);
        return settle(job);
      }
      await delay(pollInterval, undefined, { signal: stop.signal, ref: false });
    }
    if (!eligible(job) && !stop.signal.aborted) return settle(job);
    if (!stop.signal.aborted) onError('本轮自动记忆提炼仍待确认。');
  }

  function observe(body, packet) {
    if (packet?.ok !== true || packet.session?.id !== body.sessionId || !providers.has(body.settings.provider)) return;
    const turns = packet.session.turns;
    if (!Array.isArray(turns)) return;
    const matching = journal.jobs.filter((job) => sessionKey(job) === sessionKey(body) && job.phase !== 'settled');
    for (const job of matching) {
      const source = turns.find(({ id }) => id === job.turnId);
      const key = jobKey(job);
      if (packet.session.memoryIsolation === true || (job.projectId === null && packet.session.mode === 'design')) {
        stopWatching(key);
        void settle(job).catch(() => {});
        continue;
      }
      if (!source || queued.has(key)) continue;
      if (source.state === 'unknown' || running.has(source.state)) {
        if (job.phase === 'watching' && running.has(source.state)) watchSource(job, body);
        continue;
      }
      stopWatching(key);
      queued.add(key);
      worker = worker.then(async () => {
        if (stop.signal.aborted) return;
        if (source.state !== 'complete') await settle(job);
        else await extract(job, body, source);
      }).catch(() => {
        if (!stop.signal.aborted) onError('本轮自动记忆暂未更新。');
      }).finally(() => queued.delete(key));
    }
  }

  async function reserveSource(job) {
    let reserved = false;
    await update((previous) => {
      if (previous.jobs.some((item) => jobKey(item) === jobKey(job))) return previous;
      const current = state();
      const jobs = previous.jobs.map((item) => item.phase === 'settled' || currentPolicy(item, current)
        ? item : { ...item, phase: 'settled' });
      const watching = jobs.filter(({ phase }) => phase !== 'settled');
      if (watching.length >= 128) return previous;
      reserved = true;
      return { jobs: [...watching, ...jobs.filter(({ phase }) => phase === 'settled').slice(-127), job] };
    });
    return reserved;
  }

  return {
    async changeExtractionModel(change) {
      const choice = readMemoryExtractionChange(change);
      const settings = extractionRoutes.get(choice.targetId);
      if (!canExecute() || !settings) throw new Error('memory_extraction_target_unavailable');
      if (choice.model !== undefined) {
        const problem = await checkExtractionChoice(settings, choice);
        if (problem) throw new Error(problem);
      }
      const result = await data.changeExtensions(change, { canCommit: canExecute });
      if (!result) throw new Error('memory_extraction_target_unavailable');
      return result;
    },
    async request(incoming, { isLive = () => true } = {}) {
      if (Object.hasOwn(incoming, 'workflowFiles')) return changedWorkflowStage;
      let { projectMemory, workflowStage, ...body } = incoming;
      let workflow;
      let attachments = [];
      if (Object.hasOwn(incoming, 'workflowStage')) {
        if (!canExecute()) return disabled;
        if (!isLive() || projectMemory !== undefined) return changedWorkflowStage;
        workflow = prepareStage(incoming, workflowStage, readRun, state(), isProject, readSavedWorkflow);
        if (!workflow.ok) return workflow;
        if (access().workspace === 'isolated' && workflow.fileAccess?.paths.length) return changedWorkflowFileAccess;
        if (workflow.fileAccess?.attachments.length) {
          try { attachments = await data.readWorkflowAttachments(workflow.fileAccess.attachments); }
          catch { return { ok: false, code: 'workflow_attachment_unavailable', message: '阶段附件快照缺失或变更，请重新选择附件。' }; }
        }
        body.prompt = workflow.prompt;
        if (workflow.memory === 'shared') projectMemory = { projectId: workflow.projectId };
        else body.memoryIsolation = true;
      }
      if (body.op === 'preset' || body.op === 'list') {
        const packet = await backend.request(body, { current: true });
        const route = body.op === 'preset' ? packet?.preset : packet;
        if (packet?.ok === true && route && digest.test(route.targetId)) {
          const settings = route.settings ?? body.settings;
          if (settings && digest.test(route.memoryTargetId)) {
            extractionRoutes.delete(route.memoryTargetId);
            if (extractionRoutes.size >= 64) extractionRoutes.delete(extractionRoutes.keys().next().value);
            extractionRoutes.set(route.memoryTargetId, { ...settings, provider: 'codex' });
          }
          // Reconcile original receipts again after restarting or reconnecting to this exact target.
          for (const job of journal.jobs) if (job.phase !== 'settled' && job.targetId === route.targetId &&
              job.memoryTargetId === route.memoryTargetId)
            watchSource(job, { settings });
        }
        return packet;
      }

      if (body.op === 'send' && body.settings?.provider === 'antigravity' && body.extensions?.mcpServers?.length) {
        return { ok: false, code: 'invalid_request', message: 'Antigravity 的 MCP 服务须由工作流阶段授权。' };
      }
      let current = ['get', 'refresh', 'stop', 'steer', 'approval', 'design-history'].includes(body.op) ||
        body.op === 'send' && body.mode === 'design';
      let staged;
      if (body.op === 'send' && !projectMemory && body.extensions?.memory?.length) {
        const assignment = readMembership(body);
        if (assignment === null || projectMembershipIsolated(assignment)) replaceTurnMemory(body, []);
      }
      if (body.op === 'send' && projectMemory) {
        if (!canExecute()) return disabled;
        const { settings, targetId, sessionId, turnId } = body;
        const preflight = await backend.request({ op: 'get', settings, targetId, sessionId, turnId }, { current: true });
        if (preflight?.ok !== true) return preflight;
        if (!digest.test(preflight.memoryTargetId) || typeof preflight.existingTurn !== 'boolean' ||
            typeof preflight.memoryIsolation !== 'boolean') return changed;
        if (!canExecute()) return disabled;
        const projectId = projectMemory.projectId;
        const snapshot = state();
        const localIsolation = conversationIsolated(snapshot, body);
        const isolated = preflight.memoryIsolation || localIsolation;
        const scope = { targetId: preflight.memoryTargetId, projectId };
        const scopeMatches = inMemoryScope(projectId, readMembership(body), Boolean(workflow));
        if (workflow && (!scopeMatches || isolated)) return changedWorkflowStage;
        const policy = !isolated && scopeMatches && (projectId !== null || body.mode !== 'design') &&
          automaticMemoryPolicy(snapshot, { ...scope, scopedPersonal });
        if (isolated || policy?.enabled) {
          let priorPrompt;
          if (policy?.enabled && referencesPriorTurn.test(body.prompt.trim()) &&
              !projectMemoryNotes(snapshot, { ...scope, prompt: body.prompt }).length) {
            const history = await backend.request({ op: 'get', settings, targetId, sessionId }, { current: true });
            if (!canExecute()) return disabled;
            const turns = history?.ok && history.session?.id === sessionId && history.session.turns;
            if (Array.isArray(turns)) {
              const repeated = turns.findIndex((turn) => turn?.id === turnId);
              const earlier = repeated < 0 ? turns : turns.slice(0, repeated);
              const previous = earlier.findLast((turn) => turn?.state === 'complete' && typeof turn.prompt === 'string');
              if (previous) priorPrompt = safeText(previous.prompt, 1000);
            }
          }
          const job = { targetId, sessionId, turnId, projectId, memoryTargetId: scope.targetId,
            revision: policy?.revision, phase: 'watching',
            ...(workflow ? { workflowShared: true, workflowRunId: workflowStage.runId.toLowerCase() } : {}) };
          if (policy?.enabled && !preflight.existingTurn) {
            if (journalUnavailable) return { ...changed, message: '记忆回执不可用。可关闭自动记忆或使用独立会话。' };
            if (await reserveSource(job)) staged = job;
          }
          if (!canExecute()) {
            if (workflow && staged) await settle(staged);
            return disabled;
          }
          const latest = state();
          if (localIsolation !== conversationIsolated(latest, body) || policy?.enabled && !eligible(job)) {
            if (staged) await settle(staged);
            return changed;
          }
          const mcpServers = workflow ? [] : (body.settings.provider === 'codex'
            ? extensionsForTurn(latest, { targetId, projectId, isolated: true })?.mcpServers ?? [] : []);
          let memory = isolated ? [] : projectMemoryNotes(latest, { ...scope, prompt: body.prompt });
          if (!isolated && !memory.length && priorPrompt) memory = projectMemoryNotes(latest, { ...scope, prompt: priorPrompt });
          replaceTurnMemory(body, memory, mcpServers);
          if (isolated) body.memoryIsolation = true;
          current = true;
        } else if (!scopeMatches) {
          replaceTurnMemory(body, []);
        } else if (projectId !== null) {
          const memory = extensionsForTurn(snapshot, { targetId: workflow ? scope.targetId : targetId, projectId })?.memory ?? [];
          replaceTurnMemory(body, memory);
        }
      }
      if (workflow) {
        const latest = prepareStage(incoming, workflowStage, readRun, state(), isProject, readSavedWorkflow);
        const stillBound = latest.ok && latest.prompt === workflow.prompt && latest.memory === workflow.memory &&
          latest.projectId === workflow.projectId &&
           JSON.stringify(latest.fileAccess) === JSON.stringify(workflow.fileAccess) &&
           latest.mcpServers.length === workflow.mcpServers.length &&
           latest.mcpServers.every((server, index) => server === workflow.mcpServers[index]) &&
          (!projectMemory || inMemoryScope(latest.projectId, readMembership(body), true));
        const problem = !canExecute() ? disabled : !latest.ok ? latest : !stillBound || !isLive() ? changedWorkflowStage
          : access().workspace === 'isolated' && latest.fileAccess?.paths.length ? changedWorkflowFileAccess : null;
        if (problem) {
          if (staged) await settle(staged);
          return problem;
        }
        replaceTurnMemory(body, body.extensions?.memory ?? [], latest.mcpServers);
        body.workflowFiles = { paths: latest.fileAccess?.paths ?? [], attachments };
        delete body.workspaceAccess;
        body = withWorkspaceAccess(body, access());
        current = true;
      }
      const packet = await backend.request(body, { current });
      if (staged && packet?.ok === false && rejectedBeforeSend.has(packet.code)) await settle(staged);
      if (['send', 'get', 'refresh'].includes(body.op)) observe(body, packet);
      return packet;
    },
    dispose() {
      stop.abort();
      for (const key of watches.keys()) stopWatching(key);
      backend.dispose?.();
      extractor.dispose?.();
    },
  };
}
