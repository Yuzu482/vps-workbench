import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { startWorkbenchServer } from '../desktop/server.mjs';
import { readVersionHistory } from '../../remote-workbench/vps-chat/client/design-version-state.js';
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

async function fixture(t, makeThread, personalClaudeSubscription = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-agents-test-')));
  const directory = join(root, 'project');
  await mkdir(directory);
  await writeFile(join(directory, 'brief.txt'), 'Worktree fixture');
  const ssh = [];
  const callbacks = [];
  let mode = 'execute';
  const opts = {
    webRoot: root, workbenchRoot: join(root, 'ssh'), terminalRoot: root, runtimeRoot: root,
    localStateRoot: join(root, 'local'), access: () => ({ mode, workspace: 'default' }), personalClaudeSubscription,
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
    registerSubscription: () => host.registerLocalProfile({ backend: 'claude-sdk', directory,
      name: 'local subscription', model: 'default', effort: 'default', authMode: 'subscription' }),
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

// Both native protocol fixtures check the user input they actually received.
function designAnswer(text, image) {
  assert.match(text, /14,000 字符/u);
  assert.match(text, /闭合的 html 代码围栏/u);
  const name = text.match(/当前任务\n([^\n]+)/u)[1];
  if (name === '初稿') {
    assert.match(text, /文字参考甲/u);
    assert.equal(image, 'iVBORw0KGgo=');
  } else if (name === '评审' || name === '从初稿分支') {
    assert.match(text, /<title>初稿<\/title>/u);
    assert.doesNotMatch(text, /文字评审乙/u);
    if (name === '评审') return '文字评审乙';
  } else if (name === '按评审修改') {
    assert.match(text, /所选版本的回复（引用资料）\n文字评审乙/u);
    assert.match(text, /<title>初稿<\/title>/u);
  } else throw new Error('unexpected design task');
  return '\x60\x60\x60html\n<html><head><title>' + name + '</title></head><body>画板</body></html>\n\x60\x60\x60';
}

const acpFixture = String.raw`
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const designAnswer = ${designAnswer.toString()};
const input = createInterface({ input: process.stdin });
const supportsImages = process.argv[1] === 'test-images';
const supportsMcp = process.argv[1] === 'test-mcp';
let workspace, first, task, session = (!supportsImages && !supportsMcp && process.argv[1]) || 'acp:' + randomUUID(), isLoaded = false;
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
    reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true,
      ...(supportsImages && { promptCapabilities: { image: true } }), ...(supportsMcp && { mcpCapabilities: { http: true } }) } });
  } else if (method === 'session/new' || method === 'session/load') {
    workspace = params.cwd;
    assert.deepEqual(params.mcpServers, supportsMcp
      ? [{ type: 'http', name: 'docs', url: 'http://127.0.0.1:3000/stage-mcp', headers: [] }] : []);
    if (method === 'session/load') { assert.match(params.sessionId, /^acp:[0-9a-f-]{36}$/); session = params.sessionId; isLoaded = true; }
    reply(id, { sessionId: session });
  } else if (method === 'session/prompt') {
    assert.equal(params.sessionId, session);
    const text = params.prompt[0].text;
    if (text.startsWith('以设计资料中明确')) {
      assert.equal(isLoaded, false);
      const image = params.prompt.find((part) => part.type === 'image');
      if (image) assert.equal(image.mimeType, 'image/png');
      chunk(designAnswer(text, image?.data));
      reply(id, { stopReason: 'end_turn' });
      continue;
    }
    if (text === 'MCP fixture') {
      first = id;
      for (const name of ['allowed', 'blocked']) write({ method: 'session/request_permission', id: name,
        params: { sessionId: session, toolCall: { toolCallId: name, name: 'mcp__docs__' + name, kind: 'other' },
          options: [{ kind: 'allow_once', optionId: 'once' }] } });
      continue;
    }
    if (text === '批准的图文附件') {
      assert.equal(supportsImages, true);
      assert.deepEqual(params.prompt.slice(1), [
        { type: 'text', text: '授权文本' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      ]);
      chunk('收到授权图文'); reply(id, { stopReason: 'end_turn' });
      continue;
    }
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
  } else if (id === 'allowed') {
    assert.deepEqual(packet.result.outcome, { outcome: 'selected', optionId: 'once' });
  } else if (id === 'blocked') {
    assert.deepEqual(packet.result.outcome, { outcome: 'cancelled' });
    chunk('MCP bound'); reply(first, { stopReason: 'end_turn' });
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

function designClaude({ prompt, options }) {
  const events = (async function* () {
    assert.ok(options.sessionId);
    assert.equal(options.resume, undefined);
    assert.deepEqual(options.tools, ['Read']);
    assert.deepEqual(options.allowedTools, []);
    const { value } = await prompt.next();
    const content = value.message.content;
    const text = typeof content === 'string' ? content : content[0].text;
    const image = Array.isArray(content) ? content.find((part) => part.type === 'image') : undefined;
    if (image) assert.equal(image.source.media_type, 'image/png');
    yield { type: 'system', subtype: 'init', session_id: options.sessionId };
    yield { type: 'result', subtype: 'success', session_id: options.sessionId,
      user_message_uuid: value.uuid, result: designAnswer(text, image?.source.data) };
  })();
  events.close = () => { void prompt.return(); };
  return events;
}

test('local design branches bind native inputs, profiles and receipts across restarts', { timeout: 30000 }, async (t) => {
  for (const [backend, subscription] of [['claude-sdk', false], ['claude-sdk', true], ['antigravity', false]]) {
    await t.test(backend + (subscription ? ' subscription' : ''), async (t) => {
      let acpImages = true;
      const f = await fixture(t, (agent, profile, nativeId, { interaction, turnId, bindSession }) => {
        assert.ok(interaction);
        assert.equal(agent, backend);
        assert.equal(profile.authMode === 'subscription', subscription);
        assert.equal(nativeId, null);
        const options = { directory: profile.directory, nativeId, context: interaction, turnId, bindSession };
        if (agent === 'claude-sdk') return claudeThread({ ...options, query: designClaude });
        return antigravityThread({ ...options, launch: () => spawn(process.execPath,
          ['--input-type=module', '-e', acpFixture, ...(acpImages ? ['test-images'] : [])],
          { cwd: profile.directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) });
      }, true);
      const otherClaude = (await f.registerSubscription()).profile;
      const profile = subscription ? otherClaude : f.profiles[backend];
      const settings = { ...f.settings(backend), profileId: profile.id };
      const sessionId = randomUUID();
      const request = (op, fields = {}) => f.request(backend, op, { settings, targetId: profile.targetId, sessionId, ...fields });
      const send = async (prompt, fields = {}) => {
        const turnId = randomUUID();
        const packet = { turnId, prompt, mode: 'design', ...fields };
        assert.equal((await request('send', packet)).ok, true);
        const turn = await eventually(async () => {
          const current = (await request('refresh', { turnId })).session?.turns.find(({ id }) => id === turnId);
          return current && !['pending', 'running'].includes(current.state) && current;
        });
        return { packet, turn };
      };
      const designContext = { text: '文字参考甲', images: [{ name: '样图.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] };
      const first = await send('初稿', { designContext });
      assert.match(first.turn.reply, /<title>初稿<\/title>/u);
      const review = await send('评审');
      assert.equal(review.turn.reply, '文字评审乙');
      const edit = await send('按评审修改', { designContext: {
        text: '以下是版本 1 已应用并校验的画板。\n<!doctype html><html><title>初稿</title></html>', images: [],
      } });
      assert.match(edit.turn.reply, /<title>按评审修改<\/title>/u);
      await f.restart();
      const fork = await send('从初稿分支', { designBase: { parentTurnId: first.turn.id, fork: true } });
      assert.match(fork.turn.reply, /<title>从初稿分支<\/title>/u);
      const rows = readVersionHistory(await request('design-history'));
      assert.deepEqual(rows.map(({ parentTurnId, fork, hasBoards }) => [parentTurnId, fork, hasBoards]),
        [[null, false, true], [first.turn.id, false, false], [review.turn.id, false, true], [first.turn.id, true, true]]);
      assert.equal((await request('design-history', { turnId: edit.turn.id })).turn.reply, edit.turn.reply);
      assert.equal((await request('send', first.packet)).duplicate, true);
      assert.equal((await request('send', { ...first.packet, designContext: { text: '变更参考', images: [] } })).code, 'turn_conflict');
      assert.equal(f.callbacks.length, 4);
      const foreign = subscription ? f.profiles['claude-sdk'] : otherClaude;
      assert.equal((await f.request('claude-sdk', 'design-history', { sessionId, targetId: foreign.targetId,
        settings: { ...f.settings('claude-sdk'), profileId: foreign.id } })).code, 'session_not_found');
      if (backend === 'antigravity') {
        acpImages = false;
        const rejected = await send('初稿', { designContext });
        assert.equal(rejected.turn.code, 'image_input_unavailable');
        assert.equal(rejected.turn.reply, '');
      }
      f.browse();
      assert.equal((await request('design-history')).ok, true);
      assert.equal((await request('send', { ...first.packet, turnId: randomUUID() })).code, 'workbench_browse_only');
      assert.deepEqual(f.ssh, []);
    });
  }
});

test('non-interactive ACP attachment input requires an advertised image capability', { timeout: 10000 }, async (t) => {
  for (const supported of [true, false]) {
    await t.test(supported ? 'image input' : 'image capability absent', async () => {
      const thread = antigravityThread({ directory: process.cwd(),
        launch: () => spawn(process.execPath, ['--input-type=module', '-e', acpFixture, ...(supported ? ['test-images'] : [])], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        }) });
      const { events } = await thread.runStreamed([
        { type: 'text', text: '批准的图文附件' }, { type: 'text', text: '授权文本' },
        { type: 'raster', format: 'png', bytes: Buffer.from('iVBORw0KGgo=', 'base64') },
      ], { signal: new AbortController().signal });
      const result = [];
      for await (const event of events) result.push(event);
      if (supported) {
        assert.equal(result.at(-1).type, 'turn.completed', JSON.stringify(result));
        assert.ok(result.some(({ item }) => item?.text === '收到授权图文'));
      } else {
        assert.equal(result.at(-1).type, 'turn.failed');
        assert.match(result.at(-1).error.message, /ACP image input unavailable/u);
        assert.ok(!result.some(({ item }) => item));
      }
    });
  }
});

test('native adapters advertise the scoped MCP endpoint and deny every ungranted tool', { timeout: 10000 }, async () => {
  const mcpServers = [{ name: 'docs', url: 'http://127.0.0.1:3000/stage-mcp', tools: ['allowed'] }];
  const signal = new AbortController().signal;
  const turnId = randomUUID();
  let permitted = true;
  const claude = claudeThread({ directory: process.cwd(), turnId, mcpServers, permitted: () => permitted,
    query({ prompt, options }) {
      const events = (async function* () {
        assert.deepEqual(options.tools, []);
        assert.deepEqual(options.mcpServers, { docs: { type: 'http', url: mcpServers[0].url } });
        assert.deepEqual(options.allowedTools, ['mcp__docs__allowed']);
        assert.equal(options.strictMcpConfig, true);
        const check = options.hooks.PreToolUse[0].hooks[0];
        assert.deepEqual(await check({ tool_name: 'mcp__docs__allowed' }), {});
        for (const name of ['Bash', 'Read', 'mcp__docs__blocked', 'mcp__other__allowed']) {
          assert.equal((await check({ tool_name: name })).hookSpecificOutput.permissionDecision, 'deny');
          assert.equal((await options.canUseTool(name, {}, { signal, toolUseID: 'fixture' })).behavior, 'deny');
        }
        assert.equal((await options.canUseTool('mcp__docs__allowed', {}, { signal, toolUseID: 'fixture' })).behavior, 'allow');
        permitted = false;
        assert.equal((await check({ tool_name: 'mcp__docs__allowed' })).hookSpecificOutput.permissionDecision, 'deny');
        const { value } = await prompt.next();
        yield { type: 'system', subtype: 'init', session_id: options.sessionId };
        yield { type: 'result', subtype: 'success', session_id: options.sessionId, user_message_uuid: value.uuid };
      })();
      events.close = () => { void prompt.return(); };
      return events;
    },
  });
  async function consume(thread) {
    const { events } = await thread.runStreamed('MCP fixture', { signal });
    const results = [];
    for await (const event of events) results.push(event);
    return results;
  }
  assert.equal((await consume(claude)).at(-1).type, 'turn.completed');
  for (const supported of [true, false]) {
    const acp = antigravityThread({ directory: process.cwd(), mcpServers, permitted: () => true,
      launch: () => spawn(process.execPath, ['--input-type=module', '-e', acpFixture, ...(supported ? ['test-mcp'] : [])],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) });
    const events = await consume(acp);
    assert.equal(events.at(-1).type, supported ? 'turn.completed' : 'turn.failed');
    if (supported) assert.ok(events.some(({ item }) => item?.text === 'MCP bound'));
    else assert.equal(events.at(-1).error.message, 'ACP MCP HTTP unavailable');
  }
});
