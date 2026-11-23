import { createHash } from 'node:crypto';
import { workspaceFile } from './workspace-file.mjs';

const maxFrame = 2 * 1024 * 1024;
const idPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;
const validId = (value) => typeof value === 'string' && idPattern.test(value);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const failures = (message) => ({ type: 'turn.failed', error: { message } });

async function* frames(output) {
  let buffered = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of output) {
    buffered = Buffer.concat([buffered, chunk]);
    let newline;
    while ((newline = buffered.indexOf(10)) >= 0) {
      if (newline >= maxFrame) throw new Error('oversized ACP frame');
      const row = JSON.parse(decoder.decode(buffered.subarray(0, newline)));
      buffered = buffered.subarray(newline + 1);
      if (!record(row) || row.jsonrpc !== '2.0') throw new Error('invalid ACP frame');
      yield row;
    }
    if (buffered.length >= maxFrame) throw new Error('oversized ACP frame');
  }
}

function transport(child, receive) {
  const pending = new Map();
  let next = 0, stopped = false;
  function write(packet) {
    if (stopped || !child.stdin.writable) throw new Error('closed ACP transport');
    const line = JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n';
    if (Buffer.byteLength(line) > maxFrame) throw new Error('oversized ACP packet');
    child.stdin.write(line);
  }
  function close() {
    if (stopped) return;
    stopped = true;
    for (const callback of pending.values()) callback.reject(new Error('closed ACP transport'));
    pending.clear();
    child.stdin.destroy();
    child.kill();
  }
  child.once('error', close);
  child.stdin.on('error', close);
  child.stderr.resume();
  void (async () => {
    try {
      for await (const packet of frames(child.stdout)) {
        if (typeof packet.method === 'string') receive(packet);
        else if (pending.has(packet.id)) {
          const waiter = pending.get(packet.id);
          pending.delete(packet.id);
          if (record(packet.error)) {
            const code = packet.error.code;
            const reason = code === -32000 && /auth|sign.in|login/i.test(String(packet.error.message))
              ? 'auth_required' : 'acp_rejected';
            waiter.reject(Object.assign(new Error(reason), { code: reason }));
          } else if (record(packet.result)) waiter.resolve(packet.result);
          else throw new Error('invalid ACP reply');
        }
      }
    } finally { close(); }
  })().catch(() => close());
  return {
    write, close,
    async request(method, params, timeout = 15000) {
      const id = ++next;
      const { promise, resolve, reject } = Promise.withResolvers();
      pending.set(id, { resolve, reject });
      const timer = setTimeout(() => reject(new Error('ACP timed out')), timeout);
      timer.unref?.();
      try {
        write({ id, method, params });
        return await promise;
      } finally { clearTimeout(timer); pending.delete(id); }
    },
  };
}

function optionsFor(options) {
  if (!Array.isArray(options) || options.length > 16) return {};
  const valid = options.filter((row) => validId(row?.optionId));
  const choice = (kind) => {
    const matching = valid.filter((row) => row.kind === kind);
    return matching.length === 1 && valid.filter((row) => row.optionId === matching[0].optionId).length === 1 ? matching[0].optionId : undefined;
  };
  return { allow: choice('allow_once'), deny: choice('reject_once') };
}

async function eligibleRead(root, tool) {
  if (tool?.name !== 'view_file' || tool.kind !== 'read' || !record(tool.rawInput) ||
      (tool.status !== undefined && tool.status !== 'pending') ||
      (tool._meta && Object.keys(tool._meta).length) || Object.keys(tool.rawInput).some((key) => !['AbsolutePath', 'StartLine', 'EndLine', 'IsSkillFile'].includes(key)) ||
      (tool.rawInput.IsSkillFile !== undefined && tool.rawInput.IsSkillFile !== false) ||
      ['StartLine', 'EndLine'].some((key) => key in tool.rawInput && !(Number.isSafeInteger(tool.rawInput[key]) && tool.rawInput[key] > 0))) return null;
  if (tool.locations && (!Array.isArray(tool.locations) || tool.locations.length > 8 ||
      tool.locations.some((place) => place?.path !== tool.rawInput.AbsolutePath))) return null;
  return workspaceFile(root, tool.rawInput.AbsolutePath);
}

export function antigravityThread({ launch, directory, nativeId, context, bindSession, mcpServers = [], permitted = () => false }) {
  return { async runStreamed(input, { signal }) {
    let session, live = false, firstEnded = false, stopTimer, wake, done = false, supportedPrompt;
    let text = '', supplement = null, lastSupplement = null;
    const waitingTools = new Map(), usedRequests = new Map(), usedTools = new Set(), updates = new Map();
    const queue = [];
    const emit = (event) => {
      if (event.type === 'item.updated' && queue.at(-1)?.type === 'item.updated') queue[queue.length - 1] = event;
      else queue.push(event);
      wake?.();
    };
    const mcpTools = new Set(mcpServers.flatMap(({ name, tools }) =>
      tools.flatMap((tool) => ['mcp__' + name + '__' + tool, name + '/' + tool])));
    const peer = transport(launch(), receive);
    const settle = (entry, optionId) => {
      if (!usedRequests.has(entry)) return false;
      const outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
      try { peer.write({ id: entry, result: { outcome } }); return true; } catch { peer.close(); return false; }
    };

    async function permission(id, params) {
      const fingerprint = createHash('sha256').update(JSON.stringify(params) ?? '').digest('hex');
      if (usedRequests.has(id)) {
        if (usedRequests.get(id) !== fingerprint) peer.close();
        return;
      }
      if (usedRequests.size >= 256) { peer.close(); return; }
      usedRequests.set(id, fingerprint);
      const call = params?.toolCall;
      const toolId = call?.toolCallId;
      const { allow, deny } = optionsFor(params?.options);
      if (!live || signal.aborted || params?.sessionId !== session || !validId(toolId) || usedTools.has(toolId) ||
          usedTools.size >= 16 || (!allow && !deny)) { settle(id); return; }
      usedTools.add(toolId);
      const earlier = updates.get(toolId);
      const changed = earlier && ['name', 'kind', 'rawInput', 'locations'].some((key) => key in earlier && key in call &&
        JSON.stringify(earlier[key]) !== JSON.stringify(call[key]));
      const tool = { ...earlier, ...call };
      if (!changed && allow && mcpTools.has(tool.name) && permitted()) { settle(id, allow); return; }
      if (!context) { settle(id); return; }
      const abort = new AbortController();
      waitingTools.set(toolId, { abort, tool });
      let choice, approval;
      try {
        const valid = !changed && Object.keys(params).every((key) => ['sessionId', 'toolCall', 'options'].includes(key));
        const file = valid && allow && await eligibleRead(directory, tool);
        approval = await context.ask({ title: file ? '读取工作目录中的文件' : '工具请求', detail: file ? file.name : '超出本机只读工作目录的授权范围。',
          kind: file ? 'read' : 'other', canAllow: Boolean(file) }, abort.signal);
        if (approval?.decision === 'allow' && file && (await eligibleRead(directory, tool))?.target === file.target) choice = allow;
        if (approval?.decision === 'deny') choice = deny;
      } finally {
        waitingTools.delete(toolId);
        const option = live && !signal.aborted && !abort.signal.aborted && !approval?.signal.aborted ? choice : undefined;
        const sent = settle(id, option);
        await approval?.settle(option ? sent ? 'submitted' : 'unknown' : 'closed');
      }
    }

    function receive(packet) {
      if (Object.hasOwn(packet, 'id')) {
        if (!Number.isSafeInteger(packet.id) && !validId(packet.id)) { peer.close(); return; }
        if (packet.method === 'session/request_permission') void permission(packet.id, packet.params).catch(() => peer.close());
        else peer.write({ id: packet.id, error: { code: -32601, message: 'Method not available' } });
        return;
      }
      const { params } = packet;
      if (!live || packet.method !== 'session/update' || params?.sessionId !== session || !record(params.update)) return;
      const update = params.update;
      if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate) && validId(update.toolCallId)) {
        const earlier = updates.get(update.toolCallId);
        const waiting = waitingTools.get(update.toolCallId);
        if (waiting && ['name', 'kind', 'rawInput', 'locations', 'status'].some((key) => key in update &&
            JSON.stringify(update[key]) !== JSON.stringify(waiting.tool[key]))) waiting.abort.abort();
        if ((updates.size < 32 || earlier) && JSON.stringify(update).length <= 16384) updates.set(update.toolCallId, { ...earlier, ...update });
      }
      if (['agent_message_chunk', 'agent_thought_chunk', 'plan'].includes(update.sessionUpdate) && !firstEnded && !signal.aborted) context?.steerWith(steer);
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
        text = (text + update.content.text).slice(0, 262145);
        emit({ type: 'item.updated', item: { id: 'acp-output', type: 'agent_message', text } });
      }
    }

    const prompt = (content) => peer.request('session/prompt', { sessionId: session, prompt: content }, 10 * 60_000);
    const successful = (response) => ['end_turn', 'max_tokens', 'max_turn_requests'].includes(response?.stopReason);
    function steer(note) {
      if (!live || firstEnded || supplement || signal.aborted || waitingTools.size) return 'rejected';
      const response = prompt([{ type: 'text', text: note.prompt }]).then((value) => ({ value,
        state: successful(value) ? 'delivered' : value.stopReason === 'cancelled' ? 'unknown' : 'rejected' }),
      ({ code }) => ({ state: code === 'acp_rejected' ? 'rejected' : 'unknown' }));
      supplement = lastSupplement = response;
      return response.then(({ state }) => state).finally(() => { supplement = null; });
    }

    const stop = () => {
      context?.steerWith(null);
      for (const { abort } of waitingTools.values()) abort.abort();
      if (!live) { peer.close(); return; }
      try { peer.write({ method: 'session/cancel', params: { sessionId: session } }); } catch { peer.close(); }
      stopTimer = setTimeout(() => peer.close(), 5000);
      stopTimer.unref?.();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();

    async function run() {
      try {
        const info = await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'vps-workbench', version: '1.0' } });
        if (info.protocolVersion !== 1) throw new Error('unsupported ACP version');
        supportedPrompt = info.agentCapabilities?.promptCapabilities;
        if (mcpServers.length && info.agentCapabilities?.mcpCapabilities?.http !== true) {
          emit(failures('ACP MCP HTTP unavailable')); return;
        }
        const params = { cwd: directory, mcpServers: mcpServers.map(({ name, url }) => ({ type: 'http', name, url, headers: [] })) };
        let profile;
        if (nativeId) {
          if (info.agentCapabilities?.loadSession !== true) throw new Error('ACP session load unavailable');
          profile = await peer.request('session/load', { ...params, sessionId: nativeId });
          if (profile.sessionId !== undefined && profile.sessionId !== nativeId) throw new Error('ACP session mismatch');
          session = nativeId;
        } else {
          profile = await peer.request('session/new', params);
          session = profile.sessionId;
        }
        if (!validId(session)) throw new Error('invalid ACP session');
        if (profile.modes?.currentModeId && !['default', 'plan'].includes(profile.modes.currentModeId))
          throw new Error('ACP session requested an unsupported permission mode');
        await bindSession?.(session);
        if (signal.aborted) { emit({ type: 'turn.stopped' }); return; }
        emit({ type: 'thread.started', thread_id: session });
        const items = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
        if (items.some(({ type }) => type === 'raster') && supportedPrompt?.image !== true) {
          emit(failures('ACP image input unavailable')); return;
        }
        const content = items.map((item) => item.type === 'text' ? item :
          ({ type: 'image', mimeType: `image/${item.format}`, data: item.bytes.toString('base64') }));
        live = true;
        const first = await prompt(content);
        firstEnded = true;
        context?.steerWith(null);
        const last = await lastSupplement;
        if (signal.aborted && (first.stopReason === 'cancelled' || last?.value?.stopReason === 'cancelled')) emit({ type: 'turn.stopped' });
        else if (last?.state === 'unknown') return;
        else if (successful(first)) emit({ type: 'turn.completed' });
        else emit(failures('ACP turn rejected'));
      } catch (error) {
        if (!live && signal.aborted) emit({ type: 'turn.stopped' });
        else if (error.code === 'auth_required') emit(failures('401 Unauthorized'));
        else if (!live || error.code === 'acp_rejected') emit(failures('ACP request failed'));
      } finally {
        live = false;
        context?.steerWith(null);
        for (const { abort } of waitingTools.values()) abort.abort();
        signal.removeEventListener('abort', stop);
        clearTimeout(stopTimer);
        peer.close();
        done = true;
        wake?.();
      }
    }

    return { events: (async function* () {
      void run();
      try {
        while (queue.length || !done) {
          if (queue.length) yield queue.shift();
          else await new Promise((resolve) => { wake = resolve; });
        }
      } finally { peer.close(); }
    })() };
  } };
}
