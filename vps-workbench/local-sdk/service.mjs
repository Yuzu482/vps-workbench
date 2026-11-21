import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const location = 'local-sdk';
const backend = 'codex';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const nativeId = /^[a-z0-9_-]{1,128}$/i;
const maxPromptLength = 8192;
const maxReplyLength = 256 * 1024;
const pending = new Set(['queued', 'running', 'stopping']);
const states = new Set([...pending, 'completed', 'failed', 'stopped', 'unknown']);
const operations = Object.freeze({
  list: [],
  get: ['targetId', 'sessionId'],
  refresh: ['targetId', 'sessionId', 'turnId'],
  stop: ['targetId', 'sessionId', 'turnId'],
  send: ['targetId', 'sessionId', 'turnId', 'prompt'],
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
  browse_only: '本机 SDK 处于仅浏览模式。',
  auth_required: '请配置本机 Codex API 密钥并检查账号权限。',
  network_error: '本机 Codex 无法连接模型服务。请检查本机网络和原回执。',
  start_failed: '本机 Codex 无法启动这一轮。',
  turn_failed: '本机 Codex 报告该轮失败。',
  stop_unconfirmed: '已请求停止。本轮结果尚未确认，可查询原回执。',
  unknown_outcome: '本轮结果未知。可查询原回执。',
  storage_unavailable: '本机 Codex 回执暂时无法读写。',
});

function failure(code) {
  return { ok: false, code, message: messages[code] };
}

function stateResult(state, code) {
  return code ? { state, code, message: messages[code] } : { state };
}

function targetFor(id) {
  return createHash('sha256').update(`${location}:${backend}:${id}`).digest('hex');
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

function parseRequest(body) {
  if (!plain(body)) return null;
  const op = Object.getOwnPropertyDescriptor(body, 'op')?.value;
  if (typeof op !== 'string' || !Object.hasOwn(operations, op)) return null;
  const fields = ['location', 'backend', 'profileId', 'op', ...operations[op]];
  if (op === 'list' && Object.hasOwn(body, 'targetId')) fields.push('targetId');
  if (!exact(body, fields) || body.location !== location || body.backend !== backend || !identifier(body.profileId)) return null;
  if (fields.includes('targetId') && (typeof body.targetId !== 'string' || !/^[a-f0-9]{64}$/.test(body.targetId))) return null;
  if (fields.includes('sessionId') && !localSessionId(body.sessionId)) return null;
  if (fields.includes('turnId') && !identifier(body.turnId)) return null;
  if (op === 'send' && (!validText(body.prompt) || body.prompt.length > maxPromptLength)) return null;
  return {
    op,
    profileId: body.profileId.toLowerCase(),
    targetId: fields.includes('targetId') ? body.targetId : undefined,
    sessionId: fields.includes('sessionId') ? body.sessionId.toLowerCase() : undefined,
    turnId: fields.includes('turnId') ? body.turnId.toLowerCase() : undefined,
    prompt: op === 'send' ? body.prompt : undefined,
  };
}

function indexById(records) {
  return new Map(records.map((record) => [record.id, record]));
}

function validateStore(store) {
  if (!exact(store, ['version', 'profiles', 'sessions']) || store.version !== 1 ||
      !Array.isArray(store.profiles) || !Array.isArray(store.sessions)) return false;
  if (!store.profiles.every((profile) => exact(profile, ['id', 'targetId', 'name', 'directory', 'model', 'effort']) &&
    identifier(profile.id) && profile.id === profile.id.toLowerCase() && profile.targetId === targetFor(profile.id) &&
    validText(profile.name) && validText(profile.directory) && isAbsolute(profile.directory) &&
    validText(profile.model) && validText(profile.effort))) return false;
  const profiles = indexById(store.profiles);
  if (profiles.size !== store.profiles.length) return false;
  const sessions = new Set();
  const nativeIds = new Set();
  const turns = new Set();
  for (const session of store.sessions) {
    if (!exact(session, ['id', 'profileId', 'nativeThreadId', 'title', 'updatedAt', 'turns']) ||
        !localSessionId(session.id) || session.id !== session.id.toLowerCase() || sessions.has(session.id) ||
        !profiles.has(session.profileId) || !validText(session.title) || !validDate(session.updatedAt) ||
        !Array.isArray(session.turns) || session.turns.length === 0) return false;
    if (session.nativeThreadId !== null) {
      if (!validNativeId(session.nativeThreadId) || nativeIds.has(session.nativeThreadId.toLowerCase())) return false;
      nativeIds.add(session.nativeThreadId.toLowerCase());
    }
    sessions.add(session.id);
    for (const turn of session.turns) {
      const fields = ['id', 'prompt', 'reply', 'state'];
      if (Object.hasOwn(turn ?? {}, 'code')) fields.push('code', 'message');
      if (!exact(turn, fields) || !identifier(turn.id) || turn.id !== turn.id.toLowerCase() || turns.has(turn.id) ||
          !validText(turn.prompt) || typeof turn.reply !== 'string' || !states.has(turn.state) ||
          (fields.includes('code') && (!Object.hasOwn(messages, turn.code) || turn.message !== messages[turn.code]))) return false;
      turns.add(turn.id);
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

async function loadStore(path) {
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
    if (!validateStore(state)) throw new Error('invalid store');
    for (const session of state.sessions) {
      for (const turn of session.turns) {
        if (!pending.has(turn.state)) continue;
        Object.assign(turn, stateResult('unknown', 'unknown_outcome'));
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
  if (/\b(?:401 Unauthorized|403 Forbidden|invalid_api_key)\b/i.test(message)) return 'auth_required';
  return /\b(?:ECONNREFUSED|ENOTFOUND|error sending request|connection reset|stream disconnected)\b/i.test(message)
    ? 'network_error' : null;
}

export async function openLocalSdk({ root, models, createThread, canExecute, credentialConfigured }) {
  const path = join(root, 'receipts.json');
  let store = await loadStore(path);
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

  function executionBlock() {
    if (closing || !canExecute()) return 'browse_only';
    if (storageFailed) return 'storage_unavailable';
    if (!credentialConfigured()) return 'auth_required';
    return null;
  }

  function view(profile, session) {
    const turns = session.turns.map((turn) => {
      const control = active.get(turn.id);
      const reply = control ? replyFor(control) || turn.reply : turn.reply;
      if (pending.has(turn.state) && (!control || storageFailed)) {
        return { ...turn, ...stateResult('unknown', 'unknown_outcome'), reply, canStop: false };
      }
      return {
        ...turn,
        state: control?.controller.signal.aborted && pending.has(turn.state) ? 'stopping' : turn.state,
        reply,
        canStop: pending.has(turn.state) && turn.state !== 'stopping' && !control?.controller.signal.aborted &&
          !closing && canExecute(),
      };
    });
    return {
      ok: true,
      location,
      targetId: profile.targetId,
      session: {
        id: session.id, profileId: profile.id, title: session.title, mode: 'chat',
        canSend: !executionBlock() && supportedProfile(profile) && !turns.some((turn) => turn.state === 'unknown'), turns,
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
      if (!exact(body, ['name', 'directory', 'model', 'effort']) || !validText(body.name) ||
          body.name.length > 80 || !validText(body.directory) || !isAbsolute(body.directory) || !supportedProfile(body)) {
        return failure('invalid_profile');
      }
      const { directory, model, effort } = body;
      const name = body.name.trim();
      const existing = store.profiles.find((profile) =>
        profile.name === name && profile.directory === directory && profile.model === model && profile.effort === effort);
      if (existing) return { ok: true, profile: { ...existing } };
      const id = randomUUID();
      const profile = { id, targetId: targetFor(id), name, directory, model, effort };
      await commit((next) => next.profiles.push(profile));
      return { ok: true, profile: { ...profile } };
    }).catch(() => failure('storage_unavailable'));
  }

  async function updateTurn(sessionId, turnId, update, reply) {
    await commit((next) => {
      const session = sessionById(sessionId, next);
      const turn = session.turns.find(({ id }) => id === turnId);
      Object.assign(turn, update);
      if (reply !== undefined) turn.reply = reply;
      session.updatedAt = new Date().toISOString();
    });
  }

  async function bindNative(sessionId, id) {
    await transact(async () => {
      const current = sessionById(sessionId).nativeThreadId;
      if (!validNativeId(id) || (current !== null && current !== id) ||
          store.sessions.some((session) => session.id !== sessionId && session.nativeThreadId?.toLowerCase() === id.toLowerCase())) {
        throw new Error('native thread mismatch');
      }
      if (current === null) await commit((next) => { sessionById(sessionId, next).nativeThreadId = id; });
    });
  }

  async function execute(profile, sessionId, turnId, control) {
    const { signal } = control.controller;
    let dispatched = false;
    let terminal = false;
    const finish = async (result) => {
      await transact(() => updateTurn(sessionId, turnId, result, replyFor(control)));
      terminal = true;
    };
    try {
      const start = await transact(async () => {
        const session = sessionById(sessionId);
        const turn = session.turns.find(({ id }) => id === turnId);
        if (!pending.has(turn.state)) return null;
        const block = executionBlock();
        if (signal.aborted || block === 'browse_only') return stateResult('stopped');
        if (session.turns.some((turn) => turn.state === 'unknown')) return stateResult('failed', 'unknown_outcome');
        if (block) return stateResult('failed', block);
        await updateTurn(sessionId, turnId, stateResult('running'));
        return { prompt: turn.prompt, nativeThreadId: session.nativeThreadId };
      });
      if (!start) return;
      if (start.state) return await finish(start);

      const beforeCreate = executionBlock();
      if (signal.aborted || beforeCreate === 'browse_only') return await finish(stateResult('stopped'));
      if (beforeCreate) return await finish(stateResult('failed', beforeCreate));
      const thread = await createThread({ ...profile }, start.nativeThreadId);
      const beforeDispatch = executionBlock();
      if (signal.aborted || beforeDispatch === 'browse_only') return await finish(stateResult('stopped'));
      if (beforeDispatch) return await finish(stateResult('failed', beforeDispatch));
      dispatched = true;
      const { events } = await thread.runStreamed(start.prompt, { signal });
      for await (const event of events) {
        if (terminal) continue;
        if (event.type === 'thread.started') await bindNative(sessionId, event.thread_id);
        if (event.type === 'item.updated' || event.type === 'item.completed') {
          const { item } = event;
          if (item?.type === 'agent_message' && typeof item.id === 'string' && typeof item.text === 'string') {
            control.text.set(item.id, item.text.slice(0, maxReplyLength + 1));
          }
        }
        if (event.type === 'turn.completed') {
          if (!sessionById(sessionId).nativeThreadId) throw new Error('missing native thread');
          await finish(stateResult('completed'));
        }
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

  function schedule(profile, sessionId, turnId, revoked) {
    const control = { controller: new AbortController(), text: new Map() };
    if (revoked) control.controller.abort();
    active.set(turnId, control);
    const previous = lanes.get(sessionId) ?? Promise.resolve();
    const task = previous.then(() => execute(profile, sessionId, turnId, control)).catch(() => {}).finally(() => {
      active.delete(turnId);
      if (lanes.get(sessionId) === task) lanes.delete(sessionId);
    });
    lanes.set(sessionId, task);
  }

  async function send(profile, session, query) {
    const { sessionId, turnId, prompt } = query;
    const occupied = store.sessions.find((candidate) => candidate.turns.some((turn) => turn.id === turnId));
    if (occupied) {
      const prior = occupied.turns.find((turn) => turn.id === turnId);
      if (occupied.id !== sessionId || occupied.profileId !== profile.id || prior.prompt !== prompt) return failure('turn_conflict');
      return { ...view(profile, occupied), duplicate: true };
    }
    const block = executionBlock();
    if (block) return failure(block);
    if (!supportedProfile(profile)) return failure('invalid_profile');
    if (session && view(profile, session).session.turns.some((turn) => turn.state === 'unknown')) return failure('unknown_outcome');
    const currentRevocation = revocation;
    await commit((next) => {
      const updatedAt = new Date().toISOString();
      let saved = sessionById(sessionId, next);
      if (!saved) {
        const title = [...prompt.trim().replace(/\s+/g, ' ')].slice(0, 100).join('');
        saved = { id: sessionId, profileId: profile.id, nativeThreadId: null, title, updatedAt, turns: [] };
        next.sessions.push(saved);
      }
      saved.turns.push({ id: turnId, prompt, reply: '', state: 'queued' });
      saved.updatedAt = updatedAt;
    });
    schedule(profile, sessionId, turnId, currentRevocation !== revocation);
    return view(profile, sessionById(sessionId));
  }

  async function request(body) {
    const query = parseRequest(body);
    if (!query) return failure('invalid_request');
    return transact(async () => {
      const profile = store.profiles.find(({ id }) => id === query.profileId);
      if (!profile) return failure('profile_not_found');
      if (query.targetId !== undefined && query.targetId !== profile.targetId) return failure('invalid_request');
      const { op, sessionId, turnId } = query;
      if ((op === 'send' || op === 'stop') && (closing || !canExecute())) return failure('browse_only');
      if (op === 'list') {
        const sessions = store.sessions.filter(({ profileId }) => profileId === profile.id)
          .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { ok: true, location, targetId: profile.targetId, sessions };
      }
      const session = sessionById(sessionId);
      if (op === 'send') {
        if (session && session.profileId !== profile.id) return failure('session_conflict');
        return send(profile, session, query);
      }
      if (!session || session.profileId !== profile.id) return failure('session_not_found');
      if (op === 'get') return view(profile, session);
      const turn = session.turns.find(({ id }) => id === turnId);
      if (!turn) return failure('turn_not_found');
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

  return { status, registerProfile, request, revokeExecution, close };
}
