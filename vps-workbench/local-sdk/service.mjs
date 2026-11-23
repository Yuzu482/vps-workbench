import { createHash, randomUUID } from 'node:crypto';
import { parameterLevels } from '../../remote-workbench/vps-chat/client/model-parameters.js';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isLocalBackend, usesLocalControls } from './providers.mjs';

const location = 'local-sdk';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const nativeId = /^[a-z0-9_:.\-]{1,128}$/i;
const digest = /^[a-f0-9]{64}$/;
const maxPromptLength = 8192;
const maxReplyLength = 256 * 1024;
const pending = new Set(['queued', 'running', 'stopping']);
const states = new Set([...pending, 'completed', 'failed', 'stopped', 'unknown']);
const steerStates = new Set(['submitted', 'delivered', 'next', 'rejected', 'unknown']);
const approvalStates = new Set(['pending', 'queued', 'submitted', 'unknown', 'closed']);
const decisions = new Set(['allow', 'deny']);
const steerLimit = 6;
const approvalLimit = 16;
const operations = Object.freeze({
  list: [],
  get: ['targetId', 'sessionId'],
  refresh: ['targetId', 'sessionId', 'turnId'],
  stop: ['targetId', 'sessionId', 'turnId'],
  send: ['targetId', 'sessionId', 'turnId', 'prompt'],
  steer: ['targetId', 'sessionId', 'turnId', 'steerId', 'prompt'],
  approval: ['targetId', 'sessionId', 'turnId', 'approvalId', 'decision'],
});
const messages = Object.freeze({
  invalid_request: '本机 SDK 请求无效。',
  invalid_profile: '请选择可用的本机配置、模型和推理档位。',
  invalid_directory: '本机只读工作目录不可用。',
  invalid_environment: '本机 Codex 运行环境不可用。',
  profile_not_found: '找不到该本机配置。',
  session_not_found: '该配置下找不到这条本机会话。',
  turn_not_found: '这条本机会话中找不到指定回执。',
  turn_conflict: '此轮次已关联另一条回执。',
  session_conflict: '该会话已绑定其他本机配置。',
  mode_conflict: '该会话已绑定其他模式。请新建对话。',
  design_branch_unavailable: '无法从此版本继续。请选择一个已完成的版本再试。',
  browse_only: '本机 SDK 处于仅浏览模式。',
  auth_required: '请配置本机 Codex API 密钥并检查账号权限。',
  network_error: '本机 Codex 无法连接模型服务。请检查本机网络和原回执。',
  mcp_http_unavailable: '当前 Antigravity ACP 未声明支持 HTTP MCP。请检查版本后重试。',
  image_input_unavailable: '当前本机 ACP 账号或模型未声明支持图片附件。请移除图片或改用文字资料。',
  start_failed: '本机 Codex 无法启动这一轮。',
  turn_failed: '本机 Codex 报告该轮失败。',
  stop_unconfirmed: '已请求停止。本轮结果尚未确认，可查询原回执。',
  unknown_outcome: '本轮结果未知。可查询原回执。',
  storage_unavailable: '本机 Codex 回执暂时无法读写。',
  resources_changed: '本轮的文件或工具授权已变化，请核对后重新发送。',
  steer_unavailable: '这轮当前无法接收补充指令。',
  steer_limit: '本轮已达到补充指令上限。',
  steer_conflict: '这条补充指令已绑定其他回执。',
  approval_unavailable: '这个工具审批已经关闭，或不属于当前轮。',
  approval_rejected: '这项操作的授权范围不允许批准，或已收到其他决定。',
});

function failure(code) {
  return { ok: false, code, message: messages[code] };
}

function stateResult(state, code) {
  return code ? { state, code, message: messages[code] } : { state };
}

function targetFor(backend, id, authMode) {
  const suffix = authMode === 'subscription' ? ':subscription' : '';
  return createHash('sha256').update(`${location}:${backend}:${id}${suffix}`).digest('hex');
}

function validProfileFields(profile, fields, allowPersonalSubscription) {
  return exact(profile, fields) || (allowPersonalSubscription &&
    exact(profile, [...fields, 'authMode']) && profile.authMode === 'subscription');
}

function plain(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, fields) {
  return plain(value) && Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
    });
}

function identifier(value) {
  return typeof value === 'string' && uuid.test(value);
}

function localSessionId(value) {
  return typeof value === 'string' && value.startsWith('local-') && identifier(value.slice(6));
}

function validText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function validNativeId(value) {
  return typeof value === 'string' && nativeId.test(value);
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseRequest(body, backend) {
  if (!plain(body)) return null;
  const op = Object.getOwnPropertyDescriptor(body, 'op')?.value;
  if (typeof op !== 'string' || !Object.hasOwn(operations, op)) return null;
  const fields = ['location', 'backend', 'profileId', 'op', ...operations[op]];
  if (op === 'list' && Object.hasOwn(body, 'targetId')) fields.push('targetId');
  if (!exact(body, fields) || body.location !== location || body.backend !== backend || !identifier(body.profileId)) return null;
  if (fields.includes('targetId') && (typeof body.targetId !== 'string' || !/^[a-f0-9]{64}$/.test(body.targetId))) return null;
  if (fields.includes('sessionId') && !localSessionId(body.sessionId)) return null;
  if (fields.includes('turnId') && !identifier(body.turnId)) return null;
  if ((op === 'send' || op === 'steer') && (!validText(body.prompt) || body.prompt.length > (op === 'steer' ? 1200 : maxPromptLength))) return null;
  if (op === 'steer' && !identifier(body.steerId) ||
      op === 'approval' && (!identifier(body.approvalId) || !decisions.has(body.decision))) return null;
  return {
    op,
    profileId: body.profileId.toLowerCase(),
    targetId: fields.includes('targetId') ? body.targetId : undefined,
    sessionId: fields.includes('sessionId') ? body.sessionId.toLowerCase() : undefined,
    turnId: fields.includes('turnId') ? body.turnId.toLowerCase() : undefined,
    prompt: op === 'send' || op === 'steer' ? body.prompt : undefined,
    steerId: body.steerId?.toLowerCase(), approvalId: body.approvalId?.toLowerCase(), decision: body.decision,
  };
}

function indexById(records) {
  return new Map(records.map((record) => [record.id, record]));
}

function validRows(rows, max, valid) {
  return Array.isArray(rows) && rows.length <= max && rows.every(valid) && new Set(rows.map(({ id }) => id)).size === rows.length;
}

function validSteering(rows) {
  return validRows(rows, steerLimit, (entry) => exact(entry, ['id', 'prompt', 'state']) && identifier(entry.id) &&
    validText(entry.prompt) && entry.prompt.length <= 1200 && steerStates.has(entry.state));
}

function validApprovals(rows) {
  return validRows(rows, approvalLimit, (entry) => exact(entry, ['id', 'title', 'detail', 'kind', 'canAllow', 'state', 'decision']) &&
    identifier(entry.id) && typeof entry.title === 'string' && entry.title.length <= 240 &&
    typeof entry.detail === 'string' && entry.detail.length <= 512 && typeof entry.kind === 'string' && entry.kind.length <= 32 &&
    typeof entry.canAllow === 'boolean' && approvalStates.has(entry.state) && (entry.decision === null || decisions.has(entry.decision)));
}

function settleInteractions(turn, uncertain) {
  for (const row of turn.approvals ?? []) {
    if (row.state === 'pending') row.state = 'closed';
    else if (row.state === 'queued') row.state = uncertain ? 'unknown' : 'closed';
    else if (row.state === 'submitted' && uncertain) row.state = 'unknown';
  }
  for (const row of turn.steering ?? []) if (row.state === 'submitted') row.state = 'unknown';
}

function validateStore(store, backend) {
  if (!exact(store, ['version', 'profiles', 'sessions']) || store.version !== 1 ||
      !Array.isArray(store.profiles) || !Array.isArray(store.sessions)) return false;
  if (!store.profiles.every((profile) => validProfileFields(profile,
    ['id', 'targetId', 'name', 'directory', 'model', 'effort'], backend === 'claude-sdk') &&
    identifier(profile.id) && profile.id === profile.id.toLowerCase() &&
    profile.targetId === targetFor(backend, profile.id, profile.authMode) &&
    validText(profile.name) && validText(profile.directory) && isAbsolute(profile.directory) &&
    validText(profile.model) && validText(profile.effort))) return false;
  const profiles = indexById(store.profiles);
  if (profiles.size !== store.profiles.length) return false;
  const sessions = new Set();
  const nativeIds = new Set();
  const turns = new Set();
  for (const session of store.sessions) {
    const fields = ['id', 'profileId', 'nativeThreadId', 'title', 'updatedAt', 'turns'];
    if (session?.mode === 'design') fields.push('mode');
    if (session?.background === true) fields.push('background');
    if (!exact(session, fields) ||
        !localSessionId(session.id) || session.id !== session.id.toLowerCase() || sessions.has(session.id) ||
        !profiles.has(session.profileId) || !validText(session.title) || !validDate(session.updatedAt) ||
        !Array.isArray(session.turns) || session.turns.length === 0) return false;
    if (session.nativeThreadId !== null) {
      if (!validNativeId(session.nativeThreadId) || nativeIds.has(session.nativeThreadId.toLowerCase())) return false;
      nativeIds.add(session.nativeThreadId.toLowerCase());
    }
    sessions.add(session.id);
    const earlier = new Set();
    for (const turn of session.turns) {
      const fields = ['id', 'prompt', 'reply', 'state'];
      if (Object.hasOwn(turn ?? {}, 'code')) fields.push('code', 'message');
      if (Object.hasOwn(turn ?? {}, 'execution')) fields.push('execution');
      if (Object.hasOwn(turn ?? {}, 'steering')) {
        if (!usesLocalControls(backend) || !validSteering(turn.steering)) return false;
        fields.push('steering');
      }
      if (Object.hasOwn(turn ?? {}, 'approvals')) {
        if (!usesLocalControls(backend) || !validApprovals(turn.approvals)) return false;
        fields.push('approvals');
      }
      if (!exact(turn, fields) || !identifier(turn.id) || turn.id !== turn.id.toLowerCase() || turns.has(turn.id) ||
          !validText(turn.prompt) || typeof turn.reply !== 'string' || !states.has(turn.state) ||
          (fields.includes('code') && (!Object.hasOwn(messages, turn.code) || turn.message !== messages[turn.code]))) return false;
      if (turn.execution) {
        const meta = turn.execution;
        const fields = ['fingerprint', 'model', 'effort', 'workspace'];
        if (Object.hasOwn(meta, 'usedTokens')) fields.push('usedTokens');
        if (Object.hasOwn(meta, 'verbosity')) fields.push('verbosity');
        if (session.mode === 'design') fields.push('branch');
        if (!exact(meta, fields) || !digest.test(meta.fingerprint) || !validText(meta.model) || !validText(meta.effort) ||
            !['profile', 'private'].includes(meta.workspace) || (fields.includes('usedTokens') &&
              (!Number.isSafeInteger(meta.usedTokens) || meta.usedTokens < 0)) ||
            (fields.includes('verbosity') && !parameterLevels.includes(meta.verbosity))) return false;
        if (session.mode === 'design') {
          const branch = meta.branch;
          if (!exact(branch, ['parentTurnId', 'fork', 'nativeThreadId']) ||
              (branch.parentTurnId !== null && !earlier.has(branch.parentTurnId)) ||
              typeof branch.fork !== 'boolean' || (branch.fork && branch.parentTurnId === null)) return false;
          if (branch.nativeThreadId !== null) {
            if (!validNativeId(branch.nativeThreadId) || nativeIds.has(branch.nativeThreadId.toLowerCase())) return false;
            nativeIds.add(branch.nativeThreadId.toLowerCase());
          }
        }
      } else if (fields.includes('execution') || session.mode === 'design') return false;
      turns.add(turn.id);
      earlier.add(turn.id);
    }
  }
  return true;
}

async function saveStore(path, state) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await checkStoreDirectory(dirname(path));
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function checkStoreDirectory(directory) {
  const actual = await realpath(directory);
  const matches = process.platform === 'win32' ? directory.toLowerCase() === actual.toLowerCase() : directory === actual;
  if (!matches || !(await lstat(directory)).isDirectory()) throw new Error('redirected store');
}

async function loadStore(path, backend) {
  try {
    let raw;
    try {
      await checkStoreDirectory(dirname(path));
      if (!(await lstat(path)).isFile()) throw new Error('redirected receipt file');
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, profiles: [], sessions: [] };
      throw error;
    }
    const state = JSON.parse(raw);
    if (!validateStore(state, backend)) throw new Error('invalid store');
    for (const session of state.sessions) {
      for (const turn of session.turns) {
        if (!pending.has(turn.state)) continue;
        Object.assign(turn, stateResult('unknown', 'unknown_outcome'));
        settleInteractions(turn, true);
      }
    }
    return state;
  } catch {
    throw Object.assign(new Error(messages.storage_unavailable), { code: 'storage_unavailable' });
  }
}

function knownStartCode(error) {
  switch (error?.code) {
    case 'auth_required':
    case 'invalid_directory':
    case 'invalid_environment':
      return error.code;
    default:
      return null;
  }
}

function sdkFailure(message) {
  if (typeof message !== 'string') return null;
  if (message === 'ACP MCP HTTP unavailable') return 'mcp_http_unavailable';
  if (message === 'ACP image input unavailable') return 'image_input_unavailable';
  if (/\b(?:401 Unauthorized|403 Forbidden|invalid_api_key)\b/i.test(message)) return 'auth_required';
  return /\b(?:ECONNREFUSED|ENOTFOUND|error sending request|connection reset|stream disconnected)\b/i.test(message)
    ? 'network_error' : null;
}

export async function openLocalSdk({ root, models, createThread, canExecute, credentialConfigured, backend = 'codex',
  personalSubscription = false }) {
  if (!isLocalBackend(backend)) throw new Error('unsupported local backend');
  const path = join(root, 'receipts.json');
  let store = await loadStore(path, backend);
  const availableModels = structuredClone(models);
  const active = new Map();
  const lanes = new Map();
  let transactions = Promise.resolve();
  let storageFailed = false;
  let closing = false;
  let revocation = 0;

  function transact(operation) {
    const result = transactions.then(operation);
    transactions = result.catch(() => {});
    return result;
  }

  async function commit(change) {
    const next = structuredClone(store);
    change(next);
    try {
      await saveStore(path, next);
      store = next;
    } catch {
      storageFailed = true;
      revokeExecution();
      throw Object.assign(new Error(messages.storage_unavailable), { code: 'storage_unavailable' });
    }
  }

  function sessionById(id, state = store) {
    return state.sessions.find((session) => session.id === id);
  }

  function replyFor(control) {
    const reply = [...control.text.values()].filter(Boolean).join('\n');
    if (reply.length <= maxReplyLength) return reply;
    return reply.slice(0, maxReplyLength).replace(/[\uD800-\uDBFF]$/, '') + '\n\n[其余回复已截断]';
  }

  const supportedProfile = ({ model, effort }) => availableModels.some((entry) =>
    entry.id === model && entry.efforts.includes(effort));

  function executionBlock(profile) {
    if (closing || !canExecute()) return 'browse_only';
    if (storageFailed) return 'storage_unavailable';
    if (!credentialConfigured(profile)) return 'auth_required';
    return null;
  }

  function view(profile, session) {
    const turns = session.turns.map(({ execution, ...turn }, index) => {
      const metadata = execution && { model: execution.model, effort: execution.effort,
        ...(execution.usedTokens !== undefined && { contextUsage: { usedTokens: execution.usedTokens, contextWindow: null } }),
        ...(execution.branch && { parentTurnId: execution.branch.parentTurnId, fork: execution.branch.fork, ordinal: index + 1 }) };
      const control = active.get(turn.id);
      const reply = control ? replyFor(control) || turn.reply : turn.reply;
      if (pending.has(turn.state) && (!control || storageFailed)) {
        return { ...turn, ...metadata, ...stateResult('unknown', 'unknown_outcome'), reply, canStop: false };
      }
      return {
        ...turn, ...metadata,
        state: control?.controller.signal.aborted && pending.has(turn.state) ? 'stopping' : turn.state,
        reply,
        canStop: pending.has(turn.state) && turn.state !== 'stopping' && !control?.controller.signal.aborted &&
          !closing && canExecute(),
        ...(usesLocalControls(backend) && { canSteer: canSteer(turn, control) }),
      };
    });
    return {
      ok: true,
      location,
      targetId: profile.targetId,
      session: {
        id: session.id, profileId: profile.id, title: session.title, mode: session.mode ?? 'chat',
        canSend: !executionBlock(profile) && supportedProfile(profile) && !turns.some((turn) => turn.state === 'unknown'), turns,
      },
    };
  }

  function status() {
    return {
      ok: true, location, backend, credentialConfigured: Boolean(credentialConfigured()),
      models: structuredClone(availableModels), profiles: structuredClone(store.profiles),
    };
  }

  async function registerProfile(body) {
    return transact(async () => {
      if (closing || !canExecute()) return failure('browse_only');
      if (storageFailed) return failure('storage_unavailable');
      if (!validProfileFields(body, ['name', 'directory', 'model', 'effort'], backend === 'claude-sdk' && personalSubscription) ||
          !validText(body.name) ||
          body.name.length > 80 || !validText(body.directory) || !isAbsolute(body.directory) || !supportedProfile(body)) {
        return failure('invalid_profile');
      }
      const { directory, model, effort, authMode } = body;
      const name = body.name.trim();
      const existing = store.profiles.find((profile) =>
        profile.name === name && profile.directory === directory && profile.model === model && profile.effort === effort &&
        profile.authMode === authMode);
      if (existing) return { ok: true, profile: { ...existing } };
      const id = randomUUID();
      const profile = { id, targetId: targetFor(backend, id, authMode), name, directory, model, effort, ...(authMode && { authMode }) };
      await commit((next) => next.profiles.push(profile));
      return { ok: true, profile: { ...profile } };
    }).catch(() => failure('storage_unavailable'));
  }

  async function updateTurn(sessionId, turnId, update, reply) {
    await commit((next) => {
      const session = sessionById(sessionId, next);
      const turn = session.turns.find(({ id }) => id === turnId);
      Object.assign(turn, update);
      if (update.state && !pending.has(update.state)) settleInteractions(turn, update.state === 'unknown');
      if (reply !== undefined) turn.reply = reply;
      session.updatedAt = new Date().toISOString();
    });
  }

  const eligibleControl = (turn, control) => turn?.state === 'running' && control &&
    !control.controller.signal.aborted && !closing && canExecute();
  const canSteer = (turn, control) => Boolean(eligibleControl(turn, control) && control.steer &&
    !turn.approvals?.some(({ state }) => state === 'pending' || state === 'queued') && !turn.steering?.some(({ state }) => state === 'submitted') &&
    (turn.steering?.length ?? 0) < steerLimit);

  function controlsFor(sessionId, turnId, control) {
    const { signal } = control.controller;
    const settle = (id, outcome) => transact(async () => {
      const turn = sessionById(sessionId)?.turns.find((turn) => turn.id === turnId);
      const row = turn?.approvals?.find((request) => request.id === id);
      if (!row || !['submitted', 'unknown', 'closed'].includes(outcome) ||
          (row.state !== 'queued' && !(row.state === 'pending' && outcome === 'closed'))) return;
      await updateTurn(sessionId, turnId, { approvals: turn.approvals.map((request) =>
        request.id === id ? { ...request, state: outcome } : request) });
    }).catch(() => {});
    return {
      steerWith(deliver) { control.steer = typeof deliver === 'function' && !signal.aborted ? deliver : null; },
      async ask({ title, detail, kind, canAllow }, toolSignal = signal) {
        if (signal.aborted || toolSignal.aborted) return null;
        const id = randomUUID();
        const row = { id, title, detail, kind, canAllow, state: 'pending', decision: null };
        if (!validApprovals([row])) return null;
        const cancel = AbortSignal.any([signal, toolSignal, AbortSignal.timeout(120_000)]);
        const pendingRequest = await transact(async () => {
          const turn = sessionById(sessionId)?.turns.find(({ id }) => id === turnId);
          if (!eligibleControl(turn, control) || cancel.aborted || (turn.approvals?.length ?? 0) >= approvalLimit) return null;
          const { promise, resolve } = Promise.withResolvers();
          await updateTurn(sessionId, turnId, { approvals: [...(turn.approvals ?? []), row] });
          control.approvals.set(id, { resolve, signal: cancel });
          return { promise, resolve };
        }).catch(() => null);
        if (!pendingRequest) return null;
        const revoke = () => pendingRequest.resolve(null);
        cancel.addEventListener('abort', revoke, { once: true });
        if (cancel.aborted) revoke();
        let passedToProvider = false;
        try {
          const decision = await pendingRequest.promise;
          if (!decision || cancel.aborted) return null;
          passedToProvider = true;
          return { decision, signal: cancel, settle: (outcome) => settle(id, outcome) };
        } finally {
          cancel.removeEventListener('abort', revoke);
          control.approvals.delete(id);
          if (!passedToProvider) await settle(id, 'closed');
        }
      },
    };
  }

  async function steer(profile, session, turn, { steerId, prompt }) {
    const rows = turn.steering ?? [];
    const original = rows.find(({ id }) => id === steerId);
    if (original) return original.prompt === prompt ? view(profile, session) : failure('steer_conflict');
    const control = active.get(turn.id);
    if (rows.length >= steerLimit) return failure('steer_limit');
    if (!canSteer(turn, control)) return failure('steer_unavailable');
    const deliver = control.steer;
    await updateTurn(session.id, turn.id, { steering: [...rows, { id: steerId, prompt, state: 'submitted' }] });
    const resolve = async () => {
      let state = 'rejected';
      try {
        if (eligibleControl(turn, control) && control.steer === deliver) state = await deliver({ id: steerId, prompt });
      } catch { state = 'unknown'; }
      await transact(async () => {
        const latest = sessionById(session.id)?.turns.find(({ id }) => id === turn.id);
        if (!latest?.steering?.some((row) => row.id === steerId && row.state === 'submitted')) return;
        const outcome = steerStates.has(state) && state !== 'submitted' ? state : 'unknown';
        await updateTurn(session.id, turn.id, { steering: latest.steering.map((row) =>
          row.id === steerId ? { ...row, state: outcome } : row) });
      });
    };
    control.delivery = resolve().catch(() => {});
    return view(profile, sessionById(session.id));
  }

  async function approval(session, turn, { approvalId, decision }) {
    const row = turn.approvals?.find(({ id }) => id === approvalId);
    if (row?.decision) return row.decision === decision ? { ok: true, outcome: row.state } : failure('approval_rejected');
    const control = active.get(turn.id);
    const waiter = control?.approvals.get(approvalId);
    if (row?.state !== 'pending' || !eligibleControl(turn, control) || !waiter || waiter.signal.aborted) return failure('approval_unavailable');
    if (decision === 'allow' && !row.canAllow) return failure('approval_rejected');
    await updateTurn(session.id, turn.id, { approvals: turn.approvals.map((row) =>
      row.id === approvalId ? { ...row, state: 'queued', decision } : row) });
    const live = eligibleControl(turn, control) && !waiter.signal.aborted;
    waiter.resolve(live ? decision : null);
    if (!live) {
      const latest = sessionById(session.id).turns.find(({ id }) => id === turn.id);
      await updateTurn(session.id, turn.id, { approvals: latest.approvals.map((row) =>
        row.id === approvalId ? { ...row, state: 'closed' } : row) });
    }
    return { ok: true, outcome: live ? 'queued' : 'closed' };
  }

  async function bindNative(sessionId, turnId, id) {
    await transact(async () => {
      const thread = (session) => session.mode === 'design'
        ? session.turns.find(({ id }) => id === turnId)?.execution.branch : session;
      const owner = thread(sessionById(sessionId));
      const current = owner.nativeThreadId;
      const conflicts = (candidate) => candidate !== owner && candidate.nativeThreadId?.toLowerCase() === id.toLowerCase();
      if (!validNativeId(id) || (current !== null && current !== id) ||
          store.sessions.some((session) => conflicts(session) || session.turns.some(({ execution }) =>
            execution?.branch && conflicts(execution.branch)))) {
        throw new Error('native thread mismatch');
      }
      if (current === null) await commit((next) => { thread(sessionById(sessionId, next)).nativeThreadId = id; });
    });
  }

  async function execute(profile, sessionId, turnId, control, input, options) {
    const { signal } = control.controller;
    let dispatched = false;
    let terminal = false;
    const finish = async (result) => {
      control.steer = null;
      for (const { resolve } of control.approvals.values()) resolve(null);
      await transact(() => updateTurn(sessionId, turnId, result, replyFor(control)));
      terminal = true;
    };
    try {
      const start = await transact(async () => {
        const session = sessionById(sessionId);
        const turn = session.turns.find(({ id }) => id === turnId);
        if (!pending.has(turn.state)) return null;
        const block = executionBlock(profile);
        if (signal.aborted || block === 'browse_only') return stateResult('stopped');
        if (session.turns.some((turn) => turn.state === 'unknown')) return stateResult('failed', 'unknown_outcome');
        if (block) return stateResult('failed', block);
        await updateTurn(sessionId, turnId, stateResult('running'));
        return { prompt: turn.prompt, execution: turn.execution, nativeThreadId: session.nativeThreadId };
      });
      if (!start) return;
      if (start.state) return await finish(start);

      const beforeCreate = executionBlock(profile);
      if (signal.aborted || beforeCreate === 'browse_only') return await finish(stateResult('stopped'));
      if (beforeCreate) return await finish(stateResult('failed', beforeCreate));
      if (options?.permittedResources && !options.permittedResources()) return await finish(stateResult('failed', 'resources_changed'));
      const thread = await createThread({ ...profile, ...(start.execution && {
        model: start.execution.model, effort: start.execution.effort,
      }) }, start.nativeThreadId, { workspace: start.execution?.workspace, sessionId, signal, mcpServers: options?.mcpServers,
        permittedResources: options?.permittedResources,
        verbosity: start.execution?.verbosity, turnId, bindSession: (id) => bindNative(sessionId, turnId, id),
        ...(usesLocalControls(backend) && options?.fingerprint && !options.background && { interaction: controlsFor(sessionId, turnId, control) }),
        rasterInput: Array.isArray(input) && input.some(({ type }) => type === 'raster') });
      const beforeDispatch = executionBlock(profile);
      if (signal.aborted || beforeDispatch === 'browse_only') return await finish(stateResult('stopped'));
      if (beforeDispatch) return await finish(stateResult('failed', beforeDispatch));
      if (options?.permittedResources && !options.permittedResources()) return await finish(stateResult('failed', 'resources_changed'));
      dispatched = true;
      const { events } = await thread.runStreamed(input ?? start.prompt, { signal });
      for await (const event of events) {
        if (terminal) continue;
        if (event.type === 'thread.started') await bindNative(sessionId, turnId, event.thread_id);
        if (event.type === 'item.updated' || event.type === 'item.completed') {
          const { item } = event;
          if (item?.type === 'agent_message' && typeof item.id === 'string' && typeof item.text === 'string') {
            control.text.set(item.id, item.text.slice(0, maxReplyLength + 1));
          }
        }
        if (event.type === 'turn.completed') {
          control.steer = null;
          if (control.delivery) await control.delivery;
          const session = sessionById(sessionId);
          const observed = session.mode === 'design'
            ? session.turns.find(({ id }) => id === turnId)?.execution.branch.nativeThreadId : session.nativeThreadId;
          if (!observed) throw new Error('missing native thread');
          const execution = session.turns.find(({ id }) => id === turnId)?.execution;
          const usedTokens = event.usage?.input_tokens;
          await finish({ ...stateResult('completed'), ...(execution && Number.isSafeInteger(usedTokens) && usedTokens >= 0 &&
            { execution: { ...execution, usedTokens } }) });
        }
        if (event.type === 'turn.stopped' && signal.aborted) await finish(stateResult('stopped'));
        if (event.type === 'turn.failed') await finish(stateResult('failed', sdkFailure(event.error?.message) ?? 'turn_failed'));
        if (event.type === 'error') throw new Error(event.message);
      }
      if (!terminal) {
        await finish(stateResult('unknown', signal.aborted ? 'stop_unconfirmed' : 'unknown_outcome'));
      }
    } catch (error) {
      if (terminal) return;
      if (storageFailed) return;
      const code = knownStartCode(error);
      const result = signal.aborted ? dispatched ? stateResult('unknown', 'stop_unconfirmed') : stateResult('stopped') :
        code ? stateResult('failed', code) :
        dispatched ? stateResult('unknown', sdkFailure(error?.message) ?? 'unknown_outcome') : stateResult('failed', 'start_failed');
      await finish(result);
    }
  }

  function schedule(profile, sessionId, turnId, revoked, input, options) {
    const control = { controller: new AbortController(), text: new Map(), approvals: new Map() };
    if (revoked) control.controller.abort();
    active.set(turnId, control);
    const previous = lanes.get(sessionId) ?? Promise.resolve();
    const task = previous.then(() => execute(profile, sessionId, turnId, control, input, options)).catch(() => {}).finally(() => {
      active.delete(turnId);
      if (lanes.get(sessionId) === task) lanes.delete(sessionId);
    });
    lanes.set(sessionId, task);
  }

  // The second argument is constructed by the desktop host after checking the route and configured resources.
  async function send(profile, session, query, options) {
    const { sessionId, turnId, prompt } = query;
    const mode = options?.mode ?? 'chat';
    const background = options?.background === true;
    const occupied = store.sessions.find((candidate) => candidate.turns.some((turn) => turn.id === turnId));
    if (occupied) {
      const prior = occupied.turns.find((turn) => turn.id === turnId);
      if (occupied.id !== sessionId || occupied.profileId !== profile.id || prior.prompt !== prompt ||
          prior.execution?.fingerprint !== options?.fingerprint) return failure('turn_conflict');
      return { ...view(profile, occupied), duplicate: true };
    }
    const block = executionBlock(profile);
    if (block) return failure(block);
    const model = options?.model ?? profile.model;
    const effort = options?.effort ?? profile.effort;
    if (!supportedProfile({ model, effort })) return failure('invalid_profile');
    if (session && ((session.mode ?? 'chat') !== mode || Boolean(session.background) !== background)) return failure('mode_conflict');
    if (session && view(profile, session).session.turns.some((turn) => turn.state === 'unknown')) return failure('unknown_outcome');
    const workspace = options?.workspace ?? 'profile';
    if (session && (session.turns[0].execution?.workspace ?? 'profile') !== workspace) return failure('session_conflict');
    let branch;
    let input = options?.input;
    if (mode === 'design') {
      const earlier = session?.turns ?? [];
      if (earlier.length >= 100 || earlier.some(({ state }) => pending.has(state))) return failure('design_branch_unavailable');
      const previous = earlier.findLast(({ state }) => state === 'completed');
      const base = options.base ? earlier.find(({ id }) => id === options.base.parentTurnId) : previous;
      if (options.base && (base?.state !== 'completed' || (!options.base.fork && base !== previous))) return failure('design_branch_unavailable');
      branch = { parentTurnId: base?.id ?? null, fork: options.base?.fork ?? false, nativeThreadId: null };
      input = options.designInput(base?.reply ?? '');
    }
    const execution = options && { fingerprint: options.fingerprint, model, effort, workspace,
      ...(branch && { branch }), ...(options.verbosity && { verbosity: options.verbosity }) };
    const currentRevocation = revocation;
    await commit((next) => {
      const updatedAt = new Date().toISOString();
      let saved = sessionById(sessionId, next);
      if (!saved) {
        const title = [...prompt.trim().replace(/\s+/g, ' ')].slice(0, 100).join('');
        saved = { id: sessionId, profileId: profile.id, nativeThreadId: null, title, updatedAt, turns: [],
          ...(mode === 'design' && { mode }), ...(background && { background }) };
        next.sessions.push(saved);
      }
      saved.turns.push({ id: turnId, prompt, reply: '', state: 'queued', ...(execution && { execution }) });
      saved.updatedAt = updatedAt;
    });
    schedule(profile, sessionId, turnId, currentRevocation !== revocation, input, options);
    return view(profile, sessionById(sessionId));
  }

  async function request(body, options) {
    const query = parseRequest(body, backend);
    if (!query) return failure('invalid_request');
    return transact(async () => {
      const profile = store.profiles.find(({ id }) => id === query.profileId);
      if (!profile) return failure('profile_not_found');
      if (query.targetId !== undefined && query.targetId !== profile.targetId) return failure('invalid_request');
      const { op, sessionId, turnId } = query;
      if (['send', 'stop', 'steer', 'approval'].includes(op) && (closing || !canExecute())) return failure('browse_only');
      if (op === 'list') {
        const sessions = store.sessions.filter(({ profileId, background }) => profileId === profile.id && !background)
          .map(({ id, title, updatedAt, mode }) => ({ id, title, updatedAt, ...(mode && { mode }) }))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { ok: true, location, targetId: profile.targetId, sessions };
      }
      const session = sessionById(sessionId);
      if (op === 'send') {
        if (session && session.profileId !== profile.id) return failure('session_conflict');
        return send(profile, session, query, options);
      }
      if (!session || session.profileId !== profile.id || Boolean(session.background) !== (options?.background === true))
        return failure('session_not_found');
      if (op === 'get') return view(profile, session);
      const turn = session.turns.find(({ id }) => id === turnId);
      if (!turn) return failure('turn_not_found');
      if (op === 'steer' || op === 'approval') {
        if (!usesLocalControls(backend) || session.background) return failure('invalid_request');
        return op === 'steer' ? steer(profile, session, turn, query) : approval(session, turn, query);
      }
      if (op === 'stop' && pending.has(turn.state) && turn.state !== 'stopping') {
        const control = active.get(turnId);
        if (control && !control.controller.signal.aborted) {
          try {
            const state = turn.state === 'queued' ? 'stopped' : 'stopping';
            await updateTurn(sessionId, turnId, stateResult(state), replyFor(control));
          } finally {
            control.controller.abort();
          }
        }
      }
      return view(profile, sessionById(sessionId));
    }).catch(() => failure('storage_unavailable'));
  }

  function revokeExecution() {
    revocation++;
    for (const { controller } of active.values()) controller.abort();
  }

  async function close() {
    closing = true;
    revokeExecution();
    await transactions;
    revokeExecution();
    await Promise.allSettled(lanes.values());
  }

  function searchSnapshot() {
    const profiles = indexById(store.profiles);
    return store.sessions.filter(({ background }) => !background).map(({ id, profileId, title, mode, turns }) => ({
      location, provider: backend, profileId, targetId: profiles.get(profileId).targetId, configuration: profiles.get(profileId).name,
      id: id.slice(6), title, mode: mode ?? 'chat',
      turns: turns.map(({ id, prompt, reply, state, steering }) => ({
        id, prompt, reply, state: state === 'completed' ? 'complete' : state,
        supplemental: steering?.filter(({ state }) => ['submitted', 'delivered', 'next'].includes(state)).map(({ prompt }) => prompt),
      })),
    }));
  }

  return { status, registerProfile, request, credentialConfigured, searchSnapshot, revokeExecution, close };
}
