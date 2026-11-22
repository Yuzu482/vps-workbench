import { randomUUID } from 'node:crypto';
import { workspaceFile } from './workspace-file.mjs';

const deny = () => ({ behavior: 'deny', message: '工作台未授权这项操作。' });
const safeHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '工作台未授权这项操作。' } };
const failure = (message) => ({ type: 'turn.failed', error: { message } });
const interrupted = ({ terminal_reason, is_interrupt }) => is_interrupt === true ||
  ['aborted_streaming', 'aborted_tools'].includes(terminal_reason);

function userMessage(session, id, content, supplement) {
  return { type: 'user', uuid: id, session_id: session, parent_tool_use_id: null, message: { role: 'user', content },
    ...(supplement && { priority: 'now', origin: { kind: 'human' } }) };
}

function contentFor(input) {
  if (typeof input === 'string') return input;
  return input.map((item) => item.type === 'text' ? item : { type: 'image', source: { type: 'base64',
    media_type: `image/${item.format}`, data: item.bytes.toString('base64') } });
}

function claudePermissions(root, controls, signal) {
  const checked = new Map();
  function fileFor(tool, input) {
    if (!controls || tool !== 'Read' || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => !['file_path', 'offset', 'limit'].includes(key)) ||
        ['offset', 'limit'].some((key) => key in input && !(Number.isSafeInteger(input[key]) && input[key] >= 0 && input[key] <= 20000))) return null;
    return workspaceFile(root, input.file_path);
  }
  async function authorize(tool, input, id, abort) {
    if (typeof id !== 'string' || !id.length || id.length > 128 || checked.size >= 16 || checked.has(id) || abort.aborted || signal.aborted) return false;
    checked.set(id, null);
    const file = await fileFor(tool, input);
    if (!file) return false;
    const permission = await controls.ask({ title: '读取工作目录中的文件', detail: file.name, kind: 'read', canAllow: true }, abort);
    if (!permission) return false;
    const latest = await fileFor(tool, input);
    if (permission.signal.aborted || latest?.target !== file.target) {
      await permission.settle('closed');
      return false;
    }
    await permission.settle('submitted');
    if (permission.decision !== 'allow' || permission.signal.aborted || abort.aborted || signal.aborted) return false;
    checked.set(id, { target: file.target, input: JSON.stringify(input) });
    return true;
  }
  return {
    hooks: { PreToolUse: [{ hooks: [async ({ tool_name, tool_input, tool_use_id }, id, options) =>
      await authorize(tool_name, tool_input, tool_use_id ?? id, options?.signal ?? signal) ? {} : safeHook] }] },
    async canUseTool(tool, input, { toolUseID, signal: toolSignal }) {
      const proof = checked.get(toolUseID);
      const file = await fileFor(tool, input);
      return proof && file?.target === proof.target && proof.input === JSON.stringify(input) && !signal.aborted && !toolSignal.aborted
        ? { behavior: 'allow', updatedInput: input } : deny();
    },
  };
}

export function claudeThread({ query, directory, nativeId, turnId, context, providerOptions }) {
  const session = nativeId ?? randomUUID();
  return {
    async runStreamed(input, { signal }) {
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), 10 * 60_000);
      deadline.unref?.();
      const first = userMessage(session, turnId, contentFor(input), false);
      const messages = [first];
      let wake, inputClosed = false, pending = null, originalResult = null;
      function closeInput() { inputClosed = true; wake?.(); }
      async function* stream() {
        while (!inputClosed && !abort.signal.aborted) {
          if (messages.length) yield messages.shift();
          else await new Promise((resolve) => { wake = resolve; });
        }
      }
      function steer(note) {
        if (inputClosed || abort.signal.aborted || signal.aborted || pending || originalResult) return 'rejected';
        const { promise, resolve } = Promise.withResolvers();
        pending = { id: note.id, resolve };
        messages.push(userMessage(session, note.id, note.prompt, true));
        wake?.();
        return promise;
      }
      function settle(state) {
        pending?.resolve(state);
        pending = null;
      }
      let handle, stopTimer;
      const stop = () => {
        context?.steerWith(null);
        stopTimer = setTimeout(() => abort.abort(), 5000);
        stopTimer.unref?.();
        void Promise.resolve().then(() => handle?.interrupt()).catch(() => abort.abort());
      };
      const cancel = () => { closeInput(); handle?.close(); };
      async function* events() {
        let initialized = false;
        let messageId = '', chunks = new Map();
        const completed = new Set();
        const item = (id, text, final = false) => ({ type: final ? 'item.completed' : 'item.updated',
          item: { type: 'agent_message', id, text } });
        try {
          if (signal.aborted) { yield { type: 'turn.stopped' }; return; }
          handle = query({ prompt: stream(), options: {
            ...providerOptions, cwd: directory, abortController: abort,
            ...(nativeId ? { resume: session } : { sessionId: session }), persistSession: true, includePartialMessages: true,
            settingSources: [], permissionMode: 'default', tools: context ? ['Read'] : [], allowedTools: [],
            mcpServers: {}, strictMcpConfig: true, verbatimPrompts: true,
            ...claudePermissions(directory, context, signal),
          } });
          abort.signal.addEventListener('abort', cancel, { once: true });
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
          for await (const message of handle) {
            if (message.parent_tool_use_id || message.agent_id) continue;
            if (message.type === 'system' && message.subtype === 'init') {
              if (initialized || message.session_id !== session) throw new Error('Claude session mismatch');
              initialized = true;
              yield { type: 'thread.started', thread_id: session };
              continue;
            }
            if (!initialized) {
              if (message.type === 'result' && (message.startup_failure_reason || message.is_error)) {
                yield failure(/auth|login|oauth|api.key|permission|401|403/i.test(JSON.stringify(message)) ? '401 Unauthorized' : 'startup failed');
                return;
              }
              continue;
            }
            if (message.session_id !== session) throw new Error('Claude session mismatch');
            if (message.type === 'stream_event') {
              const event = message.event;
              if (event?.type === 'message_start' && typeof event.message?.id === 'string') {
                messageId = event.message.id;
                chunks = new Map();
                if (!originalResult) context?.steerWith(steer);
              }
              if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && Number.isSafeInteger(event.index) &&
                  event.index >= 0 && event.index < 256 && typeof event.delta.text === 'string' && messageId && !completed.has(messageId)) {
                chunks.set(event.index, ((chunks.get(event.index) ?? '') + event.delta.text).slice(0, 262145));
                const text = [...chunks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('\n');
                yield item(messageId, text);
              }
            }
            if (message.type === 'assistant' && typeof message.message?.id === 'string' && Array.isArray(message.message.content)) {
              const text = message.message.content.filter((block) => block.type === 'text' && typeof block.text === 'string')
                .map(({ text }) => text).join('\n');
              completed.add(message.message.id);
              if (text) yield item(message.message.id, text, true);
            }
            if (message.type === 'result') {
              const ids = Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [message.user_message_uuid];
              const answersOriginal = ids.includes(turnId);
              const answersSupplement = Boolean(pending && ids.includes(pending.id));
              if (!answersOriginal && !answersSupplement) throw new Error('Claude input receipt mismatch');
              if (answersOriginal) originalResult = message;
              context?.steerWith(null);
              if (answersSupplement) settle(message.is_error ? 'rejected' : answersOriginal ? 'delivered' : 'next');
              if (signal.aborted && interrupted(message)) {
                settle('unknown');
                yield { type: 'turn.stopped' };
                return;
              }
              if (pending && !signal.aborted) continue;
              if (!originalResult) throw new Error('Claude original result missing');
              settle('unknown');
              const replaced = answersSupplement && !answersOriginal && !signal.aborted && interrupted(originalResult);
              const originalFailed = !replaced && (originalResult.is_error || originalResult.subtype !== 'success');
              if (originalFailed || message.is_error || message.subtype !== 'success') {
                yield failure(/oauth|auth|api.key|401|403/i.test(JSON.stringify(originalFailed ? originalResult : message)) ? '401 Unauthorized' : 'Claude turn failed');
              } else {
                if (!completed.size && !messageId && typeof message.result === 'string') yield item('result', message.result, true);
                yield { type: 'turn.completed', usage: message.usage };
              }
              return;
            }
          }
        } finally {
          context?.steerWith(null);
          settle('unknown');
          closeInput();
          signal.removeEventListener('abort', stop);
          abort.signal.removeEventListener('abort', cancel);
          clearTimeout(stopTimer);
          clearTimeout(deadline);
          handle?.close();
        }
      }
      return { events: events() };
    },
  };
}
