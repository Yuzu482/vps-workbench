import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { serve } from './worker.mjs';

const savedId = '01234567-89ab-4cde-8f01-23456789abcd';
const differentId = '12345678-9abc-4def-8034-0123456789ab';
const sandbox = '/workspaces/e1e1e1e1';
const threadParams = { cwd: '/workspace', approvalPolicy: 'never', sandbox: 'read-only' };
const inputText = (threadId, text = 'fixture input') => ({
  threadId, approvalPolicy: 'never', input: [{ type: 'text', text, text_elements: [] }],
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(query, workflowFiles = false) {
  const input = new PassThrough(), packets = [], events = new EventEmitter();
  const output = new Writable({
    write(chunk, encoding, done) {
      const packet = JSON.parse(chunk.toString());
      packets.push(packet);
      events.emit('packet', packet);
      done();
    },
  });
  const exited = serve({ input, output, query, cwd: workflowFiles ? '/workspace' : sandbox, workflowFiles });
  function waitFor(predicate) {
    const old = packets.find(predicate);
    if (old) return Promise.resolve(old);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        events.off('packet', listener);
        reject(Error('worker frame did not arrive'));
      }, 2000);
      function listener(packet) {
        if (!predicate(packet)) return;
        clearTimeout(timeout);
        events.off('packet', listener);
        resolve(packet);
      }
      events.on('packet', listener);
    });
  }
  function send(method, params, id) {
    input.write(`${JSON.stringify({ method, params, id })}\n`);
  }
  const byId = (id) => waitFor((packet) => packet.id === id);
  const byMethod = (method) => waitFor((packet) => packet.method === method);
  async function startThread(id) {
    send('initialize', { clientInfo: { name: 'unit fixture' } }, 1);
    assert.deepEqual((await byId(1)).result, {});
    send('initialized', {});
    const options = workflowFiles ? { ...threadParams, sandbox: 'workspace-write' } : threadParams;
    send(id ? 'thread/resume' : 'thread/start', id ? { ...options, threadId: id, excludeTurns: true } : options, 2);
    return (await byId(2)).result.thread.id;
  }
  async function startTurn(threadId) {
    send('turn/start', inputText(threadId), 3);
    return (await byId(3)).result.turn.id;
  }
  return { input, packets, exited, send, startThread, startTurn, byId, byMethod };
}

const init = (session_id) => ({ type: 'system', subtype: 'init', session_id, model: 'claude-fixture' });
const delta = (session_id, text, parent_tool_use_id = null) => ({
  type: 'stream_event', session_id, parent_tool_use_id,
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});
const assistant = (session_id, text, options = {}) => ({
  type: 'assistant', session_id, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] }, ...options,
});
const result = (session_id, user_message_uuid, text) => ({
  type: 'result', subtype: 'success', is_error: false, session_id, user_message_uuid, result: text,
});

test('scoped workflow reads of hidden and nonexistent paths get the same missing destination', async () => {
  const worker = harness(({ prompt, options }) => (async function* () {
    const { value: user } = await prompt[Symbol.asyncIterator]().next();
    assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit']);
    assert.deepEqual(options.additionalDirectories, ['/attachments', '/output']);
    const check = options.hooks.PreToolUse[0].hooks[0];
    let missing;
    for (const [tool_name, field, tool_input] of [
      ['Read', 'file_path', { file_path: '/home/codex/.claude/.credentials.json', limit: 10 }],
      ['Read', 'file_path', { file_path: '/proc/1/environ' }],
      ['Read', 'file_path', { file_path: '/never-created/report.txt' }],
      ['Glob', 'path', { path: '/home/codex', pattern: '*' }],
      ['Grep', 'path', { path: '/home/codex', pattern: 'fixture' }],
    ]) {
      const { hookSpecificOutput: decision } = await check({ tool_name, tool_input });
      assert.equal(decision.permissionDecision, 'allow');
      missing ??= decision.updatedInput[field];
      assert.match(missing, /^\/workspace\/\.missing-[a-f\d-]+$/u);
      assert.deepEqual(decision.updatedInput, { ...tool_input, [field]: missing });
    }
    for (const [tool_name, tool_input] of [
      ['Write', { file_path: '/attachments/approved.txt' }],
      ['Glob', { pattern: '../outside/*' }],
      ['Glob', { pattern: '{..,subdir}/**' }],
      ['Write', { file_path: '/output/result.txt/' }],
      ['Edit', { file_path: '/output/../attachments/approved.txt' }],
      ['Bash', { command: 'echo fixture' }],
    ]) assert.equal((await check({ tool_name, tool_input })).hookSpecificOutput.permissionDecision, 'deny');
    yield init(options.sessionId);
    yield result(options.sessionId, user.uuid, 'fixture');
  })(), true);
  const thread = await worker.startThread();
  await worker.startTurn(thread);
  assert.equal(await worker.exited, 0);
});

test('keeps one bounded reference in a separate user content block', async () => {
  const worker = harness(({ prompt, options }) => (async function* () {
    const { value: user } = await prompt[Symbol.asyncIterator]().next();
    assert.deepEqual(user.message.content, [
      { type: 'text', text: 'current request' }, { type: 'text', text: 'project reference' },
    ]);
    yield init(options.sessionId);
    yield result(options.sessionId, user.uuid, 'answer');
  })());
  const threadId = await worker.startThread();
  const params = inputText(threadId, 'current request');
  params.input.push(inputText(threadId, '界'.repeat(2817)).input[0]);
  worker.send('turn/start', params, 3);
  assert.ok((await worker.byId(3)).error);
  params.input[1].text = 'project reference';
  worker.send('turn/start', params, 4);
  assert.ok((await worker.byId(4)).result.turn.id);
  assert.equal(await worker.exited, 0);
});

test('an opted-in turn uses one official-style input, projects main-session text and finalizes without duplicating it', async () => {
  let observed, cleanInputEnd = false, closeCalls = 0;
  const worker = harness(({ prompt, options }) => {
    observed = options;
    const messages = prompt[Symbol.asyncIterator]();
    async function* fake() {
      const { value: user } = await messages.next();
      assert.deepEqual(user.message, { role: 'user', content: [{ type: 'text', text: 'fixture input' }] });
      assert.equal(user.session_id, options.sessionId);
      assert.equal(user.parent_tool_use_id, null);
      yield init(options.sessionId);
      yield { type: 'rate_limit_event', session_id: 'other-session', rate_limit_info:
        { rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 2000000000 } };
      yield { type: 'rate_limit_event', session_id: options.sessionId, rate_limit_info:
        { rateLimitType: 'seven_day', utilization: 0.25, resetsAt: 2000000000 } };
      yield delta(options.sessionId, '第一段\u0000');
      yield delta(options.sessionId, 'subagent text', 'tool-fixture');
      yield delta(options.sessionId, '第二段');
      yield assistant(options.sessionId, '第一段第二段');
      yield result(options.sessionId, user.uuid, '第一段第二段');
      cleanInputEnd = (await messages.next()).done;
    }
    return Object.assign(fake(), { close() { closeCalls++; } });
  });
  const threadId = await worker.startThread();
  const turnId = await worker.startTurn(threadId);
  assert.equal(await worker.exited, 0);
  assert.equal(closeCalls, 1);
  assert.equal(cleanInputEnd, true);
  assert.equal(observed.sessionId, threadId);
  assert.equal(Object.hasOwn(observed, 'resume'), false);
  assert.equal(observed.pathToClaudeCodeExecutable, '/opt/claude');
  assert.equal(observed.cwd, sandbox);
  assert.equal(observed.includePartialMessages, true);
  assert.equal(observed.persistSession, true);
  assert.equal(Object.hasOwn(observed, 'effort'), false);
  assert.equal(Object.hasOwn(observed, 'env'), false);
  assert.deepEqual(observed.tools, []);
  assert.deepEqual(observed.settingSources, []);
  assert.equal((await observed.canUseTool()).behavior, 'deny');
  assert.equal(worker.packets.find((p) => p.method === 'turn/started').params.turn.id, turnId);
  assert.deepEqual(worker.packets.filter((p) => p.method === 'dsh/subscriptionLimit').map((p) => p.params), [
    { threadId, turnId, window: 'weekly', usedPercent: 25, resetsAt: 2000000000 },
  ]);
  const chunks = worker.packets.filter((p) => p.method === 'item/agentMessage/delta').map((p) => p.params);
  assert.deepEqual(chunks, [
    { threadId, turnId, itemId: turnId, delta: '第一段' },
    { threadId, turnId, itemId: turnId, delta: '第二段' },
  ]);
  assert.deepEqual(worker.packets.filter((p) => p.method === 'item/completed').map((p) => p.params.item), [
    { id: turnId, type: 'agentMessage', text: '第一段第二段' },
  ]);
  assert.deepEqual(worker.packets.at(-1).params.turn, { id: turnId, status: 'completed' });
});

test('resume passes only the expected SDK session and rejects frames from a different native emitter', async () => {
  let requested;
  const worker = harness(({ options }) => {
    requested = options;
    async function* fake() {
      yield init(differentId);
      yield delta(differentId, 'other conversation');
    }
    return Object.assign(fake(), { close() {} });
  });
  await worker.startTurn(await worker.startThread(savedId));
  assert.equal(await worker.exited, 1);
  assert.equal(requested.resume, savedId);
  assert.equal(Object.hasOwn(requested, 'sessionId'), false);
  assert.equal(requested.abortController.signal.aborted, true);
  assert.deepEqual(worker.packets.filter((p) => p.method), []);
});

test('advanced turn options reach the native query callback without replacing the sandbox environment', async () => {
  let observed;
  const worker = harness(({ prompt, options }) => {
    observed = options;
    return (async function* () {
      const { value: user } = await prompt[Symbol.asyncIterator]().next();
      yield init(savedId);
      yield result(savedId, user.uuid, 'answer');
    })();
  });
  const threadId = await worker.startThread(savedId);
  let id = 3;
  for (const settings of [
    { temperature: 1 }, { effort: true }, { maxOutputTokens: null }, { maxOutputTokens: '4096' },
    { maxOutputTokens: 4096.5 }, { maxOutputTokens: 1023 }, { maxOutputTokens: 65537 },
  ]) {
    worker.send('turn/start', { ...inputText(threadId), ...settings }, id);
    assert.ok((await worker.byId(id++)).error);
    assert.equal(observed, undefined);
  }
  worker.send('turn/start', { ...inputText(threadId), effort: 'high', maxOutputTokens: 65536 }, id);
  assert.ok((await worker.byId(id)).result.turn.id);
  assert.equal(await worker.exited, 0);
  assert.equal(observed.resume, savedId);
  assert.equal(observed.effort, 'high');
  assert.equal(Object.hasOwn(observed, 'model'), false);
  assert.deepEqual(observed.env, { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '65536' });
});

test('a matched interrupt is dispatched once and requires SDK evidence before reporting interruption', async () => {
  const proceed = deferred();
  let interrupts = 0;
  const worker = harness(({ prompt, options }) => {
    async function* fake() {
      const { value: user } = await prompt[Symbol.asyncIterator]().next();
      yield init(options.sessionId);
      yield delta(options.sessionId, '已有部分');
      await proceed.promise;
      yield assistant(options.sessionId, '已有部分', { aborted: true });
      yield result(options.sessionId, user.uuid, '');
    }
    return Object.assign(fake(), { async interrupt() { interrupts++; }, close() { proceed.resolve(); } });
  });
  const threadId = await worker.startThread(), turnId = await worker.startTurn(threadId);
  await worker.byMethod('item/agentMessage/delta');
  worker.send('turn/interrupt', { threadId, turnId: differentId }, 4);
  assert.ok((await worker.byId(4)).error);
  assert.equal(interrupts, 0);
  worker.send('turn/interrupt', { threadId, turnId }, 5);
  assert.deepEqual((await worker.byId(5)).result, {});
  worker.send('turn/interrupt', { threadId, turnId }, 6);
  assert.ok((await worker.byId(6)).error);
  assert.equal(interrupts, 1);
  assert.equal(worker.packets.some((p) => p.method === 'turn/completed'), false);
  proceed.resolve();
  assert.equal(await worker.exited, 0);
  assert.deepEqual(worker.packets.at(-1).params.turn, { id: turnId, status: 'interrupted' });
  assert.equal(worker.packets.find((p) => p.method === 'item/completed').params.item.text, '已有部分');
});

for (const receivedResult of [true, false]) {
  test(`interrupt acknowledgement alone does not announce interruption (${receivedResult ? 'completion' : 'EOF'})`, async () => {
    const proceed = deferred();
    const worker = harness(({ prompt, options }) => {
      async function* fake() {
        const { value: user } = await prompt[Symbol.asyncIterator]().next();
        yield init(options.sessionId);
        await proceed.promise;
        if (receivedResult) yield result(options.sessionId, user.uuid, 'finished first');
      }
      return Object.assign(fake(), { async interrupt() {}, close() { proceed.resolve(); } });
    });
    const threadId = await worker.startThread(), turnId = await worker.startTurn(threadId);
    await worker.byMethod('turn/started');
    worker.send('turn/interrupt', { threadId, turnId }, 4);
    assert.deepEqual((await worker.byId(4)).result, {});
    proceed.resolve();
    assert.equal(await worker.exited, receivedResult ? 0 : 1);
    const completed = worker.packets.find((p) => p.method === 'turn/completed');
    assert.equal(completed?.params.turn.status, receivedResult ? 'completed' : undefined);
  });
}

test('closing the controlling pipe aborts the SDK, with no invented terminal outcome', async () => {
  const hold = deferred();
  let controller;
  const worker = harness(({ options }) => {
    controller = options.abortController;
    async function* fake() {
      yield init(options.sessionId);
      await hold.promise;
    }
    return Object.assign(fake(), { close() { hold.resolve(); } });
  });
  await worker.startTurn(await worker.startThread());
  await worker.byMethod('turn/started');
  worker.input.end();
  assert.equal(await worker.exited, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(worker.packets.some((p) => p.method === 'turn/completed'), false);
});

test('rejects wrong thread and nontext turn, and closes on an over-limit frame without starting the SDK', async () => {
  let invoked = false;
  const worker = harness(() => { invoked = true; throw Error('unexpected query'); });
  const threadId = await worker.startThread();
  worker.send('turn/start', inputText(differentId), 3);
  assert.ok((await worker.byId(3)).error);
  worker.send('turn/start', { ...inputText(threadId), input: [{ type: 'image', url: 'fixture' }] }, 4);
  assert.ok((await worker.byId(4)).error);
  worker.input.write(Buffer.alloc(65537, 32));
  assert.equal(await worker.exited, 1);
  assert.equal(invoked, false);
});

test('only a bound result can fail a turn, and SDK diagnostic details stay out of the wire', async () => {
  const worker = harness(({ options }) => {
    async function* fake() {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: options.sessionId, errors: ['private diagnostic'] };
    }
    return Object.assign(fake(), { close() {} });
  });
  const turnId = await worker.startTurn(await worker.startThread());
  assert.equal(await worker.exited, 0);
  assert.deepEqual(worker.packets.at(-1).params.turn, { id: turnId, status: 'failed' });
  assert.equal(JSON.stringify(worker.packets).includes('private diagnostic'), false);
});

for (const withResult of [true, false]) {
  test(`a subscription denial is reported without exposing provider diagnostics (${withResult ? 'result' : 'EOF'})`, async () => {
    const worker = harness(({ prompt, options }) => {
      async function* fake() {
        const { value: user } = await prompt[Symbol.asyncIterator]().next();
        yield init(options.sessionId);
        yield assistant(options.sessionId, 'private provider detail', {
          error: 'oauth_org_not_allowed', user_message_uuid: user.uuid,
        });
        if (withResult) yield { ...result(options.sessionId, user.uuid, 'private provider detail'), is_error: true };
      }
      return Object.assign(fake(), { close() {} });
    });
    const turnId = await worker.startTurn(await worker.startThread());
    assert.equal(await worker.exited, 0);
    assert.deepEqual(worker.packets.at(-1).params.turn, { id: turnId, status: 'failed', error: 'oauth_org_not_allowed' });
    assert.equal(JSON.stringify(worker.packets).includes('private provider detail'), false);
  });
}

test('caps both incremental and final display text without emitting lone surrogates', async () => {
  const worker = harness(({ prompt, options }) => {
    async function* fake() {
      const { value: user } = await prompt[Symbol.asyncIterator]().next();
      const text = `a${'🕊'.repeat(5000)}\ud800`;
      yield init(options.sessionId);
      yield delta(options.sessionId, text);
      yield result(options.sessionId, user.uuid, text);
    }
    return Object.assign(fake(), { close() {} });
  });
  await worker.startTurn(await worker.startThread());
  assert.equal(await worker.exited, 0);
  const partial = worker.packets.find((p) => p.method === 'item/agentMessage/delta').params.delta;
  const terminal = worker.packets.find((p) => p.method === 'item/completed').params.item.text;
  assert.equal(partial, terminal);
  assert.equal(terminal, `a${'🕊'.repeat(4095)}`);
});

test('a result naming a different user message cannot finalize the current turn', async () => {
  const worker = harness(({ options }) => {
    async function* fake() {
      yield init(options.sessionId);
      yield result(options.sessionId, differentId, 'unrelated result');
    }
    return Object.assign(fake(), { close() {} });
  });
  await worker.startTurn(await worker.startThread());
  assert.equal(await worker.exited, 1);
  assert.equal(JSON.stringify(worker.packets).includes('unrelated result'), false);
  assert.equal(worker.packets.some((p) => p.method === 'turn/completed'), false);
});
