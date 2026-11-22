import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { startWorkbenchServer } from '../desktop/server.mjs';
import { claudeThread } from './claude.mjs';
import { antigravityThread } from './antigravity.mjs';
import { providerDefaultModels } from './providers.mjs';

async function eventually(check) {
  for (let count = 0; count < 200; count++) {
    const value = await check();
    if (value) return value;
    await wait(15);
  }
  throw new Error('fixture never reached the expected state');
}

async function fixture(t, makeThread) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-agents-test-')));
  const directory = join(root, 'project');
  await mkdir(directory);
  await writeFile(join(directory, 'brief.txt'), 'Worktree fixture');
  const ssh = [];
  const callbacks = [];
  let mode = 'execute';
  const opts = {
    webRoot: root, workbenchRoot: join(root, 'ssh'), terminalRoot: root, runtimeRoot: root,
    localStateRoot: join(root, 'local'), access: () => ({ mode, workspace: 'default' }),
    makeBridge: () => ({ request(request) { ssh.push(request); } }),
    makeLocalRuntime: async () => ({ runtimeAvailable: false, credentialConfigured: () => false }),
    makeLocalAgentRuntime: async ({ backend, stateRoot }) => ({ runtimeAvailable: true, credentialConfigured: () => true,
      models: providerDefaultModels, accountDirectory: (id) => join(stateRoot, 'accounts', id),
      createThread(profile, nativeId, options) {
        callbacks.push({ backend, profile, nativeId, options });
        return makeThread(backend, profile, nativeId, options);
      },
    }),
  };
  let host = await startWorkbenchServer(opts);
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const profiles = Object.fromEntries(await Promise.all(['claude-sdk', 'antigravity'].map(async (backend) => [backend,
    (await host.registerLocalProfile({ backend, directory, name: 'local ' + backend, model: 'default', effort: 'default' })).profile])));
  const settings = (backend) => ({ location: 'local-sdk', provider: backend, profileId: profiles[backend].id });
  const request = (backend, op, details = {}) => host.requestLocal({ location: 'local-sdk', backend, op: 'workbench',
    payload: { op, settings: settings(backend), targetId: profiles[backend].targetId, ...details } });
  return {
    profiles, callbacks, request, ssh, settings,
    async restart() { await host.close(); host = await startWorkbenchServer(opts); },
    browse() { mode = 'browse'; host.accessChanged(); },
    turn(backend, prompt, sessionId = randomUUID()) {
      const turnId = randomUUID();
      const send = () => request(backend, 'send', { sessionId, turnId, prompt });
      const read = async () => (await request(backend, 'refresh', { sessionId, turnId })).session?.turns.find(({ id }) => id === turnId);
      return { send, read, sessionId, turnId };
    },
  };
}

function fixtureClaude({ prompt, options }) {
  const native = options.sessionId ?? options.resume;
  const input = prompt[Symbol.asyncIterator]();
  const data = (packet) => ({ ...packet, session_id: native });
  const stream = (event) => data({ type: 'stream_event', event });
  const result = (ids) => data({ type: 'result', subtype: 'success', is_error: false, user_message_uuids: ids,
    usage: { input_tokens: 12 } });
  const stop = Promise.withResolvers();
  const events = (async function* () {
    assert.equal(options.permissionMode, 'default');
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.tools, ['Read']);
    const first = (await input.next()).value;
    assert.equal(first.session_id, native);
    yield data({ type: 'system', subtype: 'init' });
    yield stream({ type: 'message_start', message: { id: 'test-message' } });
    yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在生成 🌿' } });
    if (first.message.content === '停止 Claude') {
      await stop.promise;
      yield { ...result([first.uuid]), terminal_reason: 'aborted_streaming' };
      return;
    }
    if (first.message.content === '续聊') { yield result([first.uuid]); return; }
    const next = (await input.next()).value;
    assert.equal(next.priority, 'now');
    assert.equal(next.origin.kind, 'human');
    assert.equal(next.message.content, '加入证据位置');
    if (['后续响应', '原轮失败'].includes(first.message.content)) {
      yield first.message.content === '原轮失败' ? { ...result([first.uuid]), is_error: true, terminal_reason: 'api_error' } : result([first.uuid]);
      yield data({ type: 'assistant', message: { id: 'after', content: [{ type: 'text', text: '已在下一段处理' }] } });
      yield result([next.uuid]);
      return;
    }
    const { hooks } = options.hooks.PreToolUse[0];
    const inputFile = { file_path: join(options.cwd, 'brief.txt') };
    const tool = { tool_name: 'Read', tool_input: inputFile, tool_use_id: 'read-1' };
    const denied = await hooks[0]({ ...tool, tool_name: 'Bash', tool_use_id: 'unsafe' });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(await hooks[0](tool), {});
    assert.equal((await options.canUseTool('Read', inputFile, { toolUseID: 'read-1', signal: options.abortController.signal })).behavior, 'allow');
    yield data({ type: 'assistant', message: { id: 'test-message', content: [{ type: 'text', text: '已加入证据位置。' }] } });
    yield result([first.uuid, next.uuid]);
  })();
  events.interrupt = async () => { stop.resolve(); };
  events.close = () => { void input.return().catch(() => {}); };
  return events;
}

test('Claude SDK uses correlated input and permission receipts and resumes only its original local profile', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, (backend, profile, nativeId, { turnId, interaction }) => {
    assert.equal(backend, 'claude-sdk');
    return claudeThread({ query: fixtureClaude, directory: profile.directory, nativeId, turnId, context: interaction });
  });
  const turn = f.turn('claude-sdk', '初始任务');
  await turn.send();
  await eventually(async () => (await turn.read())?.canSteer);
  const ids = { sessionId: turn.sessionId, turnId: turn.turnId };
  assert.equal((await f.request('antigravity', 'get', { sessionId: turn.sessionId })).code, 'session_not_found');
  assert.equal((await f.request('claude-sdk', 'get', { settings: f.settings('antigravity'), sessionId: turn.sessionId })).code, 'invalid_request');
  assert.equal((await f.request('claude-sdk', 'get', { sessionId: turn.sessionId, targetId: f.profiles.antigravity.targetId })).code, 'target_changed');
  const note = { ...ids, steerId: randomUUID(), prompt: '加入证据位置' };
  assert.equal((await f.request('claude-sdk', 'steer', note)).ok, true);
  assert.equal((await f.request('claude-sdk', 'steer', note)).ok, true);
  assert.equal((await f.request('claude-sdk', 'steer', { ...note, prompt: '异义重试' })).code, 'steer_conflict');
  const approval = await eventually(async () => (await turn.read())?.approvals?.find(({ state }) => state === 'pending'));
  assert.deepEqual([approval.detail, approval.canAllow], ['brief.txt', true]);
  const decision = { ...ids, approvalId: approval.id, decision: 'allow' };
  assert.equal((await f.request('claude-sdk', 'approval', decision)).outcome, 'queued');
  const reply = await eventually(async () => { const row = await turn.read(); return row?.state === 'complete' && row; });
  assert.equal(reply.reply, '已加入证据位置。');
  assert.equal(reply.steering[0].state, 'delivered');
  assert.equal((await f.request('claude-sdk', 'approval', decision)).outcome, 'submitted');
  assert.equal((await f.request('claude-sdk', 'approval', { ...decision, decision: 'deny' })).code, 'approval_rejected');
  assert.notEqual(f.profiles.antigravity.accountDirectory, f.profiles['claude-sdk'].accountDirectory);
  await f.restart();
  assert.equal((await turn.read()).steering[0].state, 'delivered');
  assert.equal((await turn.send()).ok, true);
  assert.equal(f.callbacks.length, 1);
  const resumed = f.turn('claude-sdk', '续聊', turn.sessionId);
  await resumed.send();
  await eventually(async () => (await resumed.read())?.state === 'complete');
  assert.match(f.callbacks[1].nativeId, /^[0-9a-f-]{36}$/u);
  const next = f.turn('claude-sdk', '后续响应');
  await next.send();
  await eventually(async () => (await next.read())?.canSteer);
  assert.equal((await f.request('claude-sdk', 'steer', { sessionId: next.sessionId, turnId: next.turnId,
    steerId: randomUUID(), prompt: '加入证据位置' })).ok, true);
  const split = await eventually(async () => { const row = await next.read(); return row?.state === 'complete' && row; });
  assert.equal(split.steering[0].state, 'next');
  const failed = f.turn('claude-sdk', '原轮失败');
  await failed.send();
  await eventually(async () => (await failed.read())?.canSteer);
  await f.request('claude-sdk', 'steer', { sessionId: failed.sessionId, turnId: failed.turnId,
    steerId: randomUUID(), prompt: '加入证据位置' });
  const failedResult = await eventually(async () => { const row = await failed.read(); return row?.state === 'failed' && row; });
  assert.equal(failedResult.steering[0].state, 'next');
  const stopped = f.turn('claude-sdk', '停止 Claude');
  await stopped.send();
  await eventually(async () => (await stopped.read())?.canSteer);
  await f.request('claude-sdk', 'stop', { sessionId: stopped.sessionId, turnId: stopped.turnId });
  await eventually(async () => (await stopped.read())?.state === 'stopped');
  assert.deepEqual(f.ssh, []);
});

const acpFixture = String.raw`
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const input = createInterface({ input: process.stdin });
let workspace, first, task, session = process.argv[1] || 'acp:' + randomUUID(), isLoaded = false;
const write = (packet) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
const reply = (id, result) => write({ id, result });
const chunk = (text) => write({ method: 'session/update', params: { sessionId: session,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
for await (const line of input) {
  const packet = JSON.parse(line);
  const { id, method, params } = packet;
  if (method === 'initialize') {
    assert.equal(params.protocolVersion, 1);
    assert.deepEqual(params.clientCapabilities, {});
    reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  } else if (method === 'session/new' || method === 'session/load') {
    workspace = params.cwd;
    assert.deepEqual(params.mcpServers, []);
    if (method === 'session/load') { assert.match(params.sessionId, /^acp:[0-9a-f-]{36}$/); session = params.sessionId; isLoaded = true; }
    reply(id, { sessionId: session });
  } else if (method === 'session/prompt') {
    assert.equal(params.sessionId, session);
    const text = params.prompt[0].text;
    if (text === '断线') { chunk('未确认'); process.exit(0); }
    if (text === '续聊') { assert.equal(isLoaded, true); chunk('本机会话已恢复'); reply(id, { stopReason: 'end_turn' }); }
    else if (!first) { first = id; task = text; chunk('正在处理'); }
    else {
      assert.equal(text, '补充位置');
      chunk('收到补充');
      reply(id, { stopReason: 'end_turn' });
      const approval = { toolCall: { toolCallId: 'read-1', name: 'view_file', kind: 'read', rawInput: { AbsolutePath: join(workspace, 'brief.txt') } },
        options: [{kind: 'allow_always', optionId: 'always'}, {kind: 'allow_once', optionId: 'once'}, {kind: 'reject_once', optionId: 'deny'}] };
      write({ method: 'session/request_permission', id: 'foreign', params: { ...approval, sessionId: 'foreign' } });
      write({ method: 'session/request_permission', id: 'read-permission', params: { ...approval, sessionId: session } });
      if (task === '变更审批对象') setTimeout(() => write({ method: 'session/update', params: { sessionId: session,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', rawInput: { AbsolutePath: join(workspace, 'changed.txt') } } } }), 350);
    }
  } else if (method === 'session/cancel') {
    assert.equal(params.sessionId, session);
    reply(first, { stopReason: 'cancelled' });
  } else if (id === 'foreign') assert.deepEqual(packet.result.outcome, { outcome: 'cancelled' });
  else if (id === 'read-permission' && task === '变更审批对象') {
    assert.deepEqual(packet.result.outcome, { outcome: 'cancelled' });
    reply(first, { stopReason: 'end_turn' });
  }
  else if (id === 'read-permission' && packet.result.outcome.outcome === 'selected') {
    assert.deepEqual(packet.result.outcome, { outcome: 'selected', optionId: task === '审批断线' ? 'once' : 'deny' });
    if (task === '审批断线') { process.exit(0); }
    chunk('已拒绝'); reply(first, { stopReason: 'end_turn' });
  }
}
`;

test('Antigravity ACP drives a real local stdio fixture with bound steering, denials, stop and receipt recovery', { timeout: 25000 }, async (t) => {
  let duplicate;
  const f = await fixture(t, (backend, profile, nativeId, { interaction, bindSession }) => {
    assert.equal(backend, 'antigravity');
    return antigravityThread({ directory: profile.directory, nativeId, context: interaction, bindSession,
      launch: () => spawn(process.execPath, ['--input-type=module', '-e', acpFixture, ...(duplicate ? [duplicate] : [])],
        { cwd: profile.directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) });
  });
  const turn = f.turn('antigravity', '查看项目');
  await turn.send();
  await eventually(async () => (await turn.read())?.canSteer);
  const ids = { sessionId: turn.sessionId, turnId: turn.turnId };
  assert.equal((await f.request('antigravity', 'steer', { ...ids, steerId: randomUUID(), prompt: '补充位置' })).ok, true);
  const approval = await eventually(async () => (await turn.read())?.approvals?.find(({ state }) => state === 'pending'));
  assert.equal((await f.request('claude-sdk', 'approval', { ...ids, approvalId: approval.id, decision: 'allow' })).code, 'session_not_found');
  assert.equal((await f.request('antigravity', 'approval', { ...ids, approvalId: approval.id, decision: 'deny' })).outcome, 'queued');
  const reply = await eventually(async () => { const row = await turn.read(); return row?.state === 'complete' && row; });
  assert.equal(reply.steering[0].state, 'delivered');
  assert.equal(reply.reply, '正在处理收到补充已拒绝');
  await f.restart();
  const resumed = f.turn('antigravity', '续聊', turn.sessionId);
  await resumed.send();
  await eventually(async () => (await resumed.read())?.state === 'complete');
  assert.match(f.callbacks[1].nativeId, /^acp:[0-9a-f-]{36}$/u);
  duplicate = f.callbacks[1].nativeId;
  const conflict = f.turn('antigravity', '避免重复原生 ID');
  await conflict.send();
  await eventually(async () => (await conflict.read())?.state === 'failed');
  duplicate = null;
  const lost = f.turn('antigravity', '断线', turn.sessionId);
  await lost.send();
  await eventually(async () => (await lost.read())?.state === 'unknown');
  await f.restart();
  const calls = f.callbacks.length;
  assert.equal((await lost.send()).ok, true);
  assert.equal((await lost.read()).state, 'unknown');
  assert.equal(f.callbacks.length, calls);
  const pending = f.turn('antigravity', '审批断线');
  const pendingIds = { sessionId: pending.sessionId, turnId: pending.turnId };
  await pending.send();
  await eventually(async () => (await pending.read())?.canSteer);
  await f.request('antigravity', 'steer', { ...pendingIds, steerId: randomUUID(), prompt: '补充位置' });
  const pendingApproval = await eventually(async () => (await pending.read())?.approvals?.find(({ state }) => state === 'pending'));
  const allow = { ...pendingIds, approvalId: pendingApproval.id, decision: 'allow' };
  assert.equal((await f.request('antigravity', 'approval', allow)).outcome, 'queued');
  await eventually(async () => (await pending.read())?.state === 'unknown');
  await f.restart();
  assert.equal((await f.request('antigravity', 'approval', allow)).outcome, 'unknown');
  assert.equal((await pending.read()).approvals[0].state, 'unknown');
  const change = f.turn('antigravity', '变更审批对象');
  const changeIds = { sessionId: change.sessionId, turnId: change.turnId };
  await change.send();
  await eventually(async () => (await change.read())?.canSteer);
  await f.request('antigravity', 'steer', { ...changeIds, steerId: randomUUID(), prompt: '补充位置' });
  const changed = await eventually(async () => (await change.read())?.approvals?.find(({ state }) => state === 'closed'));
  assert.equal((await f.request('antigravity', 'approval', { ...changeIds, approvalId: changed.id, decision: 'allow' })).code, 'approval_unavailable');
  await eventually(async () => (await change.read())?.state === 'complete');
  const stop = f.turn('antigravity', '停止夹具');
  await stop.send();
  await eventually(async () => (await stop.read())?.canSteer);
  f.browse();
  assert.equal((await f.request('antigravity', 'steer', { sessionId: stop.sessionId, turnId: stop.turnId,
    steerId: randomUUID(), prompt: '无执行授权' })).code, 'workbench_browse_only');
  await eventually(async () => (await stop.read())?.state === 'stopped');
  assert.deepEqual(f.ssh, []);
});
