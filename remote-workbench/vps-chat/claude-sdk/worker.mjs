import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const sdkPath = '/opt/dsh-claude-sdk/sdk.mjs';
const claudePath = '/opt/claude';
const maxLineBytes = 65536;
const maxRequests = 32;
const maxText = 8192;
const maxReferenceBytes = 8448;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const modelName = /^[A-Za-z0-9_.:-]{1,100}$/;
const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const uuidIsValid = (value) => typeof value === 'string' && uuid.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const object = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const requestId = (value) => Number.isSafeInteger(value) && value > 0;

function fields(value, required, optional = []) {
  return object(value) && required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

async function* readPackets(input) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = [], size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (let offset = 0; offset < bytes.length;) {
      const end = bytes.indexOf(10, offset);
      const part = bytes.subarray(offset, end < 0 ? bytes.length : end);
      size += part.length;
      if (size > maxLineBytes) throw Error('frame limit');
      pending.push(part);
      if (end < 0) break;
      yield JSON.parse(decoder.decode(Buffer.concat(pending, size)));
      pending = [];
      size = 0;
      offset = end + 1;
    }
  }
  if (size) throw Error('incomplete frame');
}

function visibleText(value, limit = maxText) {
  if (typeof value !== 'string' || limit <= 0) return '';
  let result = '';
  for (const char of value.slice(0, limit * 4 + 128)) {
    const code = char.codePointAt(0);
    if ((code < 32 && char !== '\n' && char !== '\t') || (code >= 127 && code <= 159) ||
        (code >= 0xd800 && code <= 0xdfff) || (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)) continue;
    if (result.length + char.length > limit) break;
    result += char;
  }
  return result;
}

function assistantText(message) {
  if (!Array.isArray(message?.content)) return '';
  let text = '';
  for (const block of message.content.slice(0, 128)) {
    if (block?.type === 'text') text += visibleText(block.text, maxText - text.length);
    if (text.length === maxText) break;
  }
  return text;
}

function validModel(params) {
  return !Object.hasOwn(params, 'model') || (typeof params.model === 'string' && modelName.test(params.model));
}

function selectThread(params, resume, workflowFiles) {
  const common = ['cwd', 'approvalPolicy', 'sandbox'];
  return fields(params, resume ? [...common, 'threadId', 'excludeTurns'] : common, ['model']) &&
    params.cwd === '/workspace' && params.approvalPolicy === 'never' &&
    params.sandbox === (workflowFiles ? 'workspace-write' : 'read-only') && (!workflowFiles || !resume) &&
    (!resume || (uuidIsValid(params.threadId) && params.excludeTurns === true)) && validModel(params);
}

function readTurn(params, threadId) {
  if (!fields(params, ['threadId', 'approvalPolicy', 'input'], ['model', 'effort', 'maxOutputTokens']) ||
      params.threadId !== threadId || params.approvalPolicy !== 'never' || !validModel(params) ||
      (Object.hasOwn(params, 'effort') && !efforts.has(params.effort)) ||
      (Object.hasOwn(params, 'maxOutputTokens') &&
        (!Number.isInteger(params.maxOutputTokens) || params.maxOutputTokens < 1024 || params.maxOutputTokens > 65536)) ||
      !Array.isArray(params.input) || params.input.length < 1 || params.input.length > 2) return null;
  for (const item of params.input) {
    if (!fields(item, ['type', 'text', 'text_elements']) || item.type !== 'text' ||
        !Array.isArray(item.text_elements) || item.text_elements.length !== 0 || typeof item.text !== 'string' ||
        !item.text.trim() || item.text.includes('\0')) return null;
  }
  const [first, reference] = params.input;
  if (first.text.length > maxText || (reference && Buffer.byteLength(reference.text) > maxReferenceBytes)) return null;
  return params.input.map(({ text }) => ({ type: 'text', text }));
}

const denyTool = async () => ({ behavior: 'deny', message: 'Tools are disabled for this VPS chat session.' });
const workflowTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];

function safeFilePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\\\u0000-\u001f\u007f-\u009f]/u.test(value) && !value.split('/').includes('..');
}

async function insideWorkflowRoot(target, roots, writing, directoryOnly) {
  const root = roots.find((directory) => target === directory || target.startsWith(directory + '/'));
  if (!root || (writing && target === root)) return false;
  try {
    const base = await lstat(root);
    if (!base.isDirectory() || base.isSymbolicLink()) return false;
    let cursor = root;
    for (const segment of posix.relative(root, target).split('/').filter(Boolean)) {
      cursor = posix.join(cursor, segment);
      try {
        const entry = await lstat(cursor);
        if (entry.isSymbolicLink() || (directoryOnly && cursor === target && !entry.isDirectory())) return false;
      } catch (error) {
        if (error.code === 'ENOENT') return true;
        return false;
      }
    }
    return true;
  } catch { return false; }
}

function scopedWorkflowTools(cwd) {
  const roots = [cwd, '/attachments', '/output'];
  const missing = posix.join(cwd, '.missing-' + randomUUID());
  const denied = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'Only approved workflow inputs and the current output directory are available.' } };
  async function checkTool({ tool_name: name, tool_input: input }) {
    const writing = name === 'Write' || name === 'Edit';
    const searching = name === 'Glob' || name === 'Grep';
    const field = searching ? 'path' : 'file_path';
    const path = searching ? input?.path ?? cwd : input?.[field];
    const pattern = name === 'Glob' ? input?.pattern : name === 'Grep' ? input?.glob : undefined;
    if (!workflowTools.includes(name) || !object(input) || !safeFilePath(path) ||
        (pattern !== undefined && (!safeFilePath(pattern) || posix.isAbsolute(pattern) || /[{}()]/u.test(pattern)))) return denied;
    const directoryOnly = path.endsWith('/') || path.endsWith('/.');
    if (writing && directoryOnly) return denied;
    const target = posix.resolve(cwd, path);
    const visible = await insideWorkflowRoot(target, writing ? ['/output'] : roots, writing, directoryOnly);
    if (visible && target === path) return {};
    // Feed reads of non-projected paths to the native tool as a missing file.
    // The fallback is checked in the read-only workspace, where it cannot be created by the tool.
    if (!visible) {
      if (writing) return denied;
      const absent = await lstat(missing).then(() => false, ({ code }) => code === 'ENOENT');
      if (!absent) return denied;
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...input, [field]: visible ? target : missing } } };
  }
  return { tools: workflowTools, allowedTools: workflowTools, additionalDirectories: roots.slice(1),
    hooks: { PreToolUse: [{ hooks: [checkTool] }] } };
}

/** Serve one attached turn over the existing VPS stream driver's stdio protocol. */
export async function serve({ input, output, query, cwd = process.cwd(), workflowFiles = false }) {
  if (typeof query !== 'function') return 1;
  if (workflowFiles && cwd !== '/workspace') return 1;
  let phase = 'new', thread = null, turnId = null, sdkQuery = null, releasePrompt;
  let shuttingDown = false, interruptSent = false, settled = false, finishTimer;
  const controller = new AbortController();
  const promptOpen = new Promise((resolve) => { releasePrompt = resolve; });
  let end;
  const sdkDone = new Promise((resolve) => { end = resolve; });
  const emitted = (value) => {
    if (!shuttingDown) output.write(`${JSON.stringify(value)}\n`);
  };
  const result = (id, value) => emitted({ id, result: value });
  const reject = (id) => emitted({ id, error: { code: -32602, message: 'Invalid or unavailable request' } });
  const notify = (method, value) => emitted({ method, params: { threadId: thread.id, turnId, ...value } });

  async function drive(content, config) {
    let verified = false, abortedReply = false, accountRejected = false;
    let reply = '', snapshot = '', deltas = 0, outcome;
    function finish() {
      if (shuttingDown || settled) return;
      phase = 'done';
      if (!outcome) { end(1); return; }
      try {
        const { status, text } = outcome;
        if (text) notify('item/completed', { item: { id: turnId, type: 'agentMessage', text } });
        const turn = { id: turnId, status };
        if (status === 'failed' && accountRejected) turn.error = 'oauth_org_not_allowed';
        notify('turn/completed', { turn });
        settled = true;
        end(0);
      } catch { end(1); }
    }
    // Keep the stream open for the SDK's control protocol. There is exactly one input message.
    async function* singlePrompt() {
      yield {
        type: 'user', uuid: turnId, session_id: thread.id, parent_tool_use_id: null,
        message: { role: 'user', content },
      };
      await promptOpen;
    }
    try {
      sdkQuery = query({
        prompt: singlePrompt(),
        options: {
          cwd, pathToClaudeCodeExecutable: claudePath, abortController: controller,
          ...(thread.resume ? { resume: thread.id } : { sessionId: thread.id }),
          ...(config.model ? { model: config.model } : {}),
          ...(config.effort ? { effort: config.effort } : {}),
          ...(config.maxOutputTokens === undefined ? {} : {
            env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.maxOutputTokens) },
          }),
          persistSession: true, includePartialMessages: true, canUseTool: denyTool,
          ...(workflowFiles ? scopedWorkflowTools(cwd) : { tools: [] }),
          permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true, mcpServers: {}, stderr: () => {},
        },
      });
      for await (const message of sdkQuery) {
        if (shuttingDown) break;
        if (outcome) continue;
        const type = message?.type;
        const init = type === 'system' && message.subtype === 'init';
        if (!init && !['stream_event', 'assistant', 'result', 'rate_limit_event'].includes(type)) continue;
        if (type === 'rate_limit_event' && (!verified || message.session_id !== thread.id)) continue;
        if (message.session_id !== thread.id || (init && verified)) break;
        if (init) {
          verified = true;
          notify('turn/started', { turn: { id: turnId } });
          if (typeof message.model === 'string' && modelName.test(message.model)) {
            notify('model/rerouted', { toModel: message.model });
          }
        } else if (type === 'result') {
          if (Object.hasOwn(message, 'user_message_uuid') && message.user_message_uuid !== turnId) break;
          const success = message.subtype === 'success' && message.is_error === false && !accountRejected;
          const errorSubtype = typeof message.subtype === 'string' && message.subtype.startsWith('error_');
          const failure = accountRejected || (message.is_error === true && (message.subtype === 'success' || errorSubtype));
          if (!success && !failure) break;
          if (success && (!verified || typeof message.result !== 'string')) break;
          // A fulfilled interrupt request alone does not prove an interrupted turn.
          if (abortedReply && !interruptSent) break;
          const status = failure ? 'failed' : abortedReply ? 'interrupted' : 'completed';
          const text = status === 'completed' ? visibleText(message.result) || reply || snapshot : reply || snapshot;
          if (success && interruptSent && !abortedReply && !text) break;
          outcome = { status, text };
          phase = 'finishing';
          // Allow the CLI to finish writing its session before the parent closes stdio.
          releasePrompt();
          finishTimer = setTimeout(finish, 2000);
        } else if (!verified) {
          break;
        } else if (type === 'rate_limit_event') {
          const info = message.rate_limit_info;
          for (const [bucket, window] of [['five_hour', 'fiveHour'], ['seven_day', 'weekly']]) {
            const sample = info?.unifiedWindows?.[bucket] ?? (info?.rateLimitType === bucket ? info : null);
            if (typeof sample?.utilization === 'number' && sample.utilization >= 0 && sample.utilization <= 1 &&
                Number.isSafeInteger(sample.resetsAt) && sample.resetsAt > 0) {
              notify('dsh/subscriptionLimit', { window, usedPercent: sample.utilization * 100, resetsAt: sample.resetsAt });
            }
          }
        } else if (message.parent_tool_use_id === null) {
          if (type === 'assistant') {
            if (Object.hasOwn(message, 'user_message_uuid') && message.user_message_uuid !== turnId) break;
            if (message.error) {
              accountRejected ||= message.error === 'oauth_org_not_allowed';
              continue;
            }
            if (message.aborted === true) abortedReply = true;
            const text = assistantText(message.message);
            if (text) snapshot = text;
          } else if (message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') {
            const text = visibleText(message.event.delta.text, maxText - reply.length);
            if (!text) continue;
            reply += text;
            if (deltas++ < 1024) notify('item/agentMessage/delta', { itemId: turnId, delta: text });
          }
        }
      }
    } catch {
      // An SDK failure without a matched authoritative result leaves the original receipt uncertain.
    }
    if (accountRejected && !outcome) outcome = { status: 'failed', text: reply || snapshot };
    clearTimeout(finishTimer);
    finish();
  }

  let requests = 0;
  const ids = new Set();
  async function listen() {
    for await (const packet of readPackets(input)) {
      if (++requests > maxRequests) return 1;
      if (!fields(packet, ['method', 'params'], ['id']) || typeof packet.method !== 'string' || !object(packet.params)) return 1;
      const { method, id, params } = packet;
      if (method === 'initialized' && id === undefined && phase === 'initializing' && fields(params, [])) {
        phase = 'ready';
        continue;
      }
      if (!requestId(id) || ids.has(id)) return 1;
      ids.add(id);
      if (method === 'initialize' && phase === 'new' && fields(params, ['clientInfo']) && object(params.clientInfo)) {
        phase = 'initializing';
        result(id, {});
      } else if ((method === 'thread/start' || method === 'thread/resume') && phase === 'ready' &&
          selectThread(params, method === 'thread/resume', workflowFiles)) {
        const resume = method === 'thread/resume';
        thread = { id: resume ? params.threadId : randomUUID(), resume, model: params.model };
        phase = 'thread';
        result(id, { thread: { id: thread.id }, ...(thread.model ? { model: thread.model } : {}) });
      } else if (method === 'turn/start' && phase === 'thread') {
        const prompt = readTurn(params, thread.id);
        if (prompt === null) { reject(id); continue; }
        turnId = randomUUID();
        phase = 'turn';
        result(id, { turn: { id: turnId } });
        void drive(prompt, { model: params.model ?? thread.model, effort: params.effort, maxOutputTokens: params.maxOutputTokens });
      } else if (method === 'turn/interrupt' && phase === 'turn' && !interruptSent &&
          fields(params, ['threadId', 'turnId']) && params.threadId === thread.id && params.turnId === turnId &&
          typeof sdkQuery?.interrupt === 'function') {
        interruptSent = true;
        void Promise.resolve().then(() => sdkQuery.interrupt()).then(() => result(id, {}), () => reject(id));
      } else {
        reject(id);
      }
    }
    return 1;
  }

  const outputFailure = () => end(1);
  output.once?.('error', outputFailure);
  try {
    return await Promise.race([listen().catch(() => 1), sdkDone]);
  } finally {
    shuttingDown = true;
    clearTimeout(finishTimer);
    output.off?.('error', outputFailure);
    releasePrompt();
    if (!settled) controller.abort();
    try { sdkQuery?.close(); } catch { /* The transport has already closed. */ }
    input.destroy?.();
  }
}

async function main() {
  const credentialOverrides = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ];
  if ((process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === claudePath)) ||
      credentialOverrides.some((key) => Object.hasOwn(process.env, key))) return 1;
  const sdk = await import(sdkPath);
  return serve({ input: process.stdin, output: process.stdout, query: sdk.query, workflowFiles: process.env.DSH_WORKFLOW_FILES === '1' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main().catch(() => 1);
}
