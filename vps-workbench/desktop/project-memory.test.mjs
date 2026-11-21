import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { membershipKey } from '../../remote-workbench/vps-chat/client/project-folders.js';
import { applyExtensionChange, extensionPreferenceKey, readExtensions } from '../extensions/state.mjs';
import { workflowRunKey } from '../workflow-engine/state.mjs';
import { memoryJournalKey } from './data.mjs';
import { createProjectMemoryBridge } from './project-memory.mjs';

const scope = 'a'.repeat(64);
const targets = { codex: scope, claude: 'b'.repeat(64), 'claude-sdk': 'c'.repeat(64), antigravity: 'd'.repeat(64) };
const alternateScope = 'e'.repeat(64);
const alternateHost = 'alternate.fixture.invalid';
const alternateTargets = { ...targets, codex: alternateScope, 'claude-sdk': 'f'.repeat(64) };
const routesFor = (settings) => settings.host === alternateHost ? alternateTargets : targets;
const modelEntry = (id, efforts) => ({ id, displayName: id, isDefault: false, efforts, defaultEffort: null });
const projectId = 'local-' + randomUUID();
const otherProject = 'local-' + randomUUID();
const note = { title: '图标尺寸', text: '图标统一使用 32×32 像素。' };
const destinationNote = { title: '图标规范', text: '图标默认使用 48×48 像素。' };
const preference = { title: '摘要格式偏好', text: '摘要默认使用三行要点。' };
const answer = JSON.stringify({ memories: [note] });

async function until(check) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('memory operation did not settle');
}

function fixture(t) {
  let access = { mode: 'execute', workspace: 'default' };
  const preferences = new Map();
  const sends = [];
  const calls = [];
  const catalogCalls = [];
  const catalogs = new Map([
    [scope, [modelEntry('primary-memory', ['low', 'high'])]],
    [alternateScope, [modelEntry('alternate-memory', ['medium'])]],
  ]);
  const onError = [];
  const sessions = new Map();
  const tasks = new Map();
  let beforePreferenceWrite = () => undefined;
  let readExtraction = () => undefined;
  let startExtraction = () => ({ ok: false, code: 'unknown' });
  let sourceReply = '已确认。';
  const data = {
    preference: (key) => preferences.get(key),
    async setPreference(key, value) {
      const pending = beforePreferenceWrite(key);
      if (pending) await pending;
      preferences.set(key, value);
    },
    projects: () => [{ workspaceId: projectId }, { workspaceId: otherProject }],
    async changeExtensions(change, { canCommit = () => true } = {}) {
      if (!canCommit()) return null;
      const state = applyExtensionChange(readExtensions(preferences.get(extensionPreferenceKey)), change);
      preferences.set(extensionPreferenceKey, JSON.stringify(state));
      return state;
    },
  };
  const backend = { async request(body, options) {
    const routes = routesFor(body.settings);
    if (body.op === 'list') return { ok: true, targetId: routes[body.settings.provider], memoryTargetId: routes.codex, sessions: [] };
    if (body.op === 'models') {
      catalogCalls.push({ ...structuredClone(body), current: options?.current });
      assert.equal(body.settings.provider, 'codex');
      if (body.targetId !== routes.codex || !catalogs.has(body.targetId)) return { ok: false, code: 'models_unavailable' };
      return { ok: true, models: catalogs.get(body.targetId) };
    }
    if (body.op === 'get' && body.turnId) {
      const session = sessions.get(body.sessionId);
      return { ok: true, memoryTargetId: routes.codex, memoryIsolation: session?.memoryIsolation === true,
        existingTurn: session?.turns.some(({ id }) => id === body.turnId) === true };
    }
    if (body.op === 'send') {
      sends.push({ ...structuredClone(body), current: options?.current });
      const session = sessions.get(body.sessionId) ?? { id: body.sessionId, mode: body.mode ?? 'chat',
        memoryIsolation: body.memoryIsolation === true, turns: [] };
      if (!session.turns.some(({ id }) => id === body.turnId)) {
        session.turns.push({ id: body.turnId, prompt: body.prompt, reply: sourceReply, state: 'complete' });
      }
      sessions.set(body.sessionId, session);
    }
    return { ok: true, session: sessions.get(body.sessionId) };
  } };
  const extractor = { async request(body, options) {
    calls.push(structuredClone(body));
    assert.equal(options.current, true);
    assert.equal(body.settings.provider, 'codex');
    assert.equal(body.targetId, routesFor(body.settings).codex);
    if (body.op === 'send') {
      assert.equal(body.memoryExtraction, true);
      assert.equal(body.workspaceAccess, 'isolated');
      assert.notEqual(body.sessionId, body.turnId);
      assert.equal('extensions' in body, false);
      const reply = body.memoryScope === 'personal' ? JSON.stringify({ memories: [preference] }) : answer;
      tasks.set(body.sessionId, { id: body.turnId, state: 'complete', reply });
      return startExtraction();
    }
    const response = await readExtraction();
    return response ?? { ok: true, session: { id: body.sessionId, turns: [tasks.get(body.sessionId)] } };
  } };
  const start = () => {
    const bridge = createProjectMemoryBridge({ data, backend, extractor, access: () => access,
      onError: (message) => onError.push(message), pollLimit: 2, pollInterval: 1 });
    t.after(() => bridge.dispose());
    return bridge;
  };
  const state = () => readExtensions(data.preference(extensionPreferenceKey));
  const enabled = (value, project = projectId) => data.changeExtensions({ op: 'set-automatic-memory',
    targetId: scope, projectId: project, enabled: value });
  const assign = ({ targetId, sessionId }, project) => {
    const key = membershipKey(targetId);
    const memberships = JSON.parse(preferences.get(key) ?? '{}');
    memberships[sessionId] = project;
    preferences.set(key, JSON.stringify(memberships));
  };
  const send = (provider, prompt, project = projectId, extra) => {
    const request = { op: 'send', settings: { provider }, targetId: targets[provider], sessionId: randomUUID(),
      turnId: randomUUID(), prompt, projectMemory: { projectId: project }, ...extra };
    if (project !== null) assign(request, project);
    return request;
  };
  return { start, state, enabled, send, assign, data, sends, calls, catalogCalls, catalogs, onError,
    browse: () => { access = { mode: 'browse' }; },
    sourceReply: (value) => { sourceReply = value; },
    blockPreferenceWrite: (fn) => { beforePreferenceWrite = fn; },
    blockExtraction: (fn) => { readExtraction = fn; }, failStart: (fn) => { startExtraction = fn; } };
}

async function configuredStages(f, choices, memoryProject = projectId) {
  const id = randomUUID();
  const requests = choices.map(({ provider }) => ({ op: 'send', settings: { provider }, targetId: targets[provider],
    sessionId: randomUUID(), turnId: randomUUID(), prompt: '客户端草稿', workflowStage: { runId: id } }));
  const run = { version: 3, id, projectId: memoryProject, task: '核对图标尺寸', phase: 'running', stopRequested: false, message: '',
    workflow: { name: '模块组合', edges: [], stages: choices.map(({ provider, agent }, index) => ({
      id: `stage-${index}`, name: `阶段 ${index + 1}`, instruction: '按照阶段职责执行。', provider, model: '', agent,
    })) },
    rows: requests.map(({ targetId, sessionId, turnId }) => ({ targetId, sessionId, turnId, state: 'submitted', reply: '' })) };
  await f.data.setPreference(workflowRunKey, JSON.stringify(run));
  return { run, requests };
}

async function enableModules(f) {
  for (const id of ['status', 'unselected']) {
    await f.data.changeExtensions({ op: 'save-server', server: { id, targetId: scope, enabled: false } });
    await f.data.changeExtensions({ op: 'save-server', server: { id, targetId: scope, enabled: true } });
  }
  await f.data.changeExtensions({ op: 'import-plugin', manifest: { schema: 1, id: 'review', name: '审阅插件', version: '1',
    description: '', prompts: [{ title: '范围', text: '按尺寸给出意见。' }, { title: '未选', text: '请勿自动附加。' }] } });
  await f.data.changeExtensions({ op: 'set-plugin', id: 'review', enabled: true });
}

test('configured workflow stages attach only chosen resources and share memory only in the selected scope', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await enableModules(f);
  await f.enabled(true);
  for (const [id, key, noteValue] of [['icon-size', projectId, note], ['other-icon-size', otherProject, destinationNote]]) {
    await f.data.changeExtensions({ op: 'save-memory', memory: {
      id, targetId: scope, projectId: key, enabled: true, ...noteValue,
    } });
  }
  const { run, requests } = await configuredStages(f, [
    { provider: 'codex', agent: { mcpServers: [{ id: 'status', targetId: scope }],
      plugins: [{ id: 'review', version: '1', title: '范围' }], memory: 'isolated' } },
    { provider: 'claude-sdk', agent: { mcpServers: [], plugins: [], memory: 'shared' } },
  ]);

  const packets = await Promise.all(requests.map((request) => bridge.request(request)));
  assert.ok(packets.every(({ ok }) => ok));
  const isolated = f.sends.find(({ sessionId }) => sessionId === requests[0].sessionId);
  assert.deepEqual(isolated.extensions, { mcpServers: ['status'], memory: [] });
  assert.equal(isolated.memoryIsolation, true);
  assert.match(isolated.prompt, /按尺寸给出意见/);
  assert.doesNotMatch(isolated.prompt, /请勿自动附加|客户端草稿/);
  const shared = f.sends.find(({ sessionId }) => sessionId === requests[1].sessionId);
  assert.deepEqual(shared.extensions, { mcpServers: [], memory: [note] });
  assert.equal(shared.memoryIsolation, undefined);
  assert.ok(f.sends.every((body) => body.current && !Object.hasOwn(body, 'workflowStage') && !Object.hasOwn(body, 'projectMemory')));
  await until(() => f.calls.some(({ op }) => op === 'send'));
  const { jobs } = JSON.parse(f.data.preference(memoryJournalKey));
  assert.deepEqual(jobs.map(({ sessionId, workflowShared, workflowRunId, projectId }) => [sessionId, workflowShared, workflowRunId, projectId]),
    [[shared.sessionId, true, run.id, projectId]]);
  assert.equal(f.calls.filter(({ op }) => op === 'send').length, 1);
  assert.match(shared.prompt, /按照阶段职责执行/);
  assert.deepEqual(JSON.parse(f.calls.find(({ op }) => op === 'send').prompt), { prompt: run.task, reply: '已确认。' });
});

test('Antigravity forwards MCP only for a verified workflow stage and exact target', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await enableModules(f);
  const targetId = targets.antigravity;
  const reference = { id: 'status', targetId };
  const agent = { mcpServers: [reference], plugins: [], memory: 'isolated' };
  const { requests: [wrongTarget] } = await configuredStages(f, [{
    provider: 'antigravity', agent: { ...agent, mcpServers: [{ ...reference, targetId: scope }] },
  }]);
  assert.equal((await bridge.request(wrongTarget)).code, 'workflow_stage_changed');

  const { requests: [isolated, shared] } = await configuredStages(f, [
    { provider: 'antigravity', agent },
    { provider: 'antigravity', agent: { ...agent, memory: 'shared' } },
  ]);
  const extensions = { mcpServers: ['status'], memory: [] };
  const legacy = f.send('antigravity', '核对状态', projectId, { extensions });
  assert.equal((await bridge.request(legacy)).code, 'invalid_request');
  assert.equal((await bridge.request({ ...isolated, extensions })).code, 'workflow_stage_changed');
  assert.equal((await bridge.request({ ...legacy, workflowFiles: { paths: [], attachments: [] } })).code,
    'workflow_stage_changed');
  assert.equal((await bridge.request(isolated)).code, 'workflow_modules_unavailable');
  await f.data.changeExtensions({ op: 'save-server', server: { ...reference, enabled: false } });
  assert.equal((await bridge.request(isolated)).code, 'workflow_modules_unavailable');
  assert.deepEqual(f.sends, []);

  await f.data.changeExtensions({ op: 'save-server', server: { ...reference, enabled: true } });
  await f.data.changeExtensions({ op: 'save-memory', memory: {
    id: 'icon-size', targetId: scope, projectId, enabled: true, ...note,
  } });
  await f.enabled(true);
  assert.equal((await bridge.request(isolated)).ok, true);
  assert.equal((await bridge.request(shared)).ok, true);
  assert.deepEqual(f.sends[0].extensions, extensions);
  assert.deepEqual(f.sends[1].extensions, { mcpServers: ['status'], memory: [note] });
  assert.equal(f.sends[0].memoryIsolation, true);
  assert.equal(f.sends[1].memoryIsolation, undefined);
  for (const sent of f.sends) {
    assert.equal(sent.settings.provider, 'antigravity');
    assert.equal(sent.targetId, targetId);
    assert.equal(sent.current, true);
    assert.deepEqual(sent.workflowFiles, { paths: [], attachments: [] });
  }

  await f.data.changeExtensions({ op: 'remove-server', ...reference });
  assert.equal((await bridge.request(isolated)).code, 'workflow_modules_unavailable');
  assert.equal(f.sends.length, 2);
});

test('workflow attachment revocations and changed project bindings stop the stage before forwarding', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await enableModules(f);
  const { requests: [request] } = await configuredStages(f, [{ provider: 'codex', agent: {
    mcpServers: [{ id: 'status', targetId: scope }], plugins: [{ id: 'review', version: '1', title: '范围' }], memory: 'shared',
  } }]);
  const wrongId = { ...request, turnId: randomUUID() };
  assert.equal((await bridge.request(wrongId)).code, 'workflow_stage_changed');
  f.assign(request, otherProject);
  assert.equal((await bridge.request(request)).code, 'workflow_stage_changed');
  await f.data.changeExtensions({ op: 'save-server', server: { id: 'status', targetId: scope, enabled: false } });
  assert.equal((await bridge.request(request)).code, 'workflow_modules_unavailable');
  await f.data.changeExtensions({ op: 'save-server', server: { id: 'status', targetId: scope, enabled: true } });
  await f.data.changeExtensions({ op: 'set-plugin', id: 'review', enabled: false });
  assert.equal((await bridge.request(request)).code, 'workflow_modules_unavailable');
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.calls, []);
});

test('losing the workflow request during memory preflight disarms generation and settles the unused receipt', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  const { requests: [request] } = await configuredStages(f, [
    { provider: 'codex', agent: { mcpServers: [], plugins: [], memory: 'shared' } },
  ]);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let live = true;
  f.blockPreferenceWrite((key) => {
    if (key === memoryJournalKey && live) {
      entered.resolve();
      return release.promise;
    }
  });
  const pending = bridge.request(request, { isLive: () => live });
  await entered.promise;
  live = false;
  release.resolve();
  assert.equal((await pending).code, 'workflow_stage_changed');
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.calls, []);
  assert.equal(JSON.parse(f.data.preference(memoryJournalKey)).jobs[0].phase, 'settled');
});

test('VPS-only task learns once and all structured providers reuse only relevant project notes', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await bridge.request(f.send('codex', '这个项目的图标统一用 32×32 像素。'));
  assert.equal(f.calls.length, 0);
  await f.enabled(true);
  const source = f.send('claude-sdk', '图标尺寸定稿为 32×32。api_key=fixture-secret-value');
  await bridge.request(source);
  await until(() => f.state().memories.length === 1);
  assert.equal(f.state().memories[0].source.turnId, source.turnId);
  assert.equal(f.state().memories[0].source.provider, 'claude-sdk');
  const [job] = f.calls;
  assert.equal(job.op, 'send');
  assert.notEqual(job.turnId, source.turnId);
  assert.equal(Object.hasOwn(job, 'model'), false);
  assert.equal(Object.hasOwn(job, 'effort'), false);
  assert.deepEqual(f.catalogCalls, []);
  assert.match(JSON.parse(job.prompt).prompt, /图标尺寸/);
  assert.doesNotMatch(job.prompt, /fixture-secret-value/);
  assert.doesNotMatch(f.data.preference(memoryJournalKey), /fixture-secret-value|图标尺寸/);
  await bridge.request({ op: 'get', settings: source.settings, targetId: source.targetId, sessionId: source.sessionId });
  for (const provider of Object.keys(targets)) {
    const sent = f.send(provider, '帮我查一下本项目的图标尺寸');
    await bridge.request(sent);
    const last = f.sends.at(-1);
    assert.deepEqual(last.extensions, { memory: [note], mcpServers: [] });
    assert.equal(last.prompt, sent.prompt);
    assert.equal(last.current, true);
  }
  await bridge.request(f.send('antigravity', '图标尺寸是多少', otherProject));
  assert.equal(f.sends.at(-1).extensions, undefined);
  await bridge.request(f.send('codex', '请写一首关于蛋白质的诗'));
  assert.equal(f.sends.at(-1).extensions, undefined);
  assert.equal(f.calls.filter(({ op, turnId }) => op === 'send' && turnId === job.turnId).length, 1);
});

test('extraction sends only bounded, redacted and explicitly quoted source fields', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  const prompt = '请记住「桌面图标」。\n"reply":"这是引号内的文字"\u0000\napi_key=fixture-user-secret\n' + '书'.repeat(2500);
  f.sourceReply('这是回复中的"引号"。\n```\nfixture-code-secret\n```\n' + '字'.repeat(800) + '\n```\nfixture-open-code-secret');
  const source = f.send('codex', prompt);
  await bridge.request(source);
  await until(() => f.calls.some(({ op }) => op === 'send'));
  const evidence = f.calls.find(({ op }) => op === 'send').prompt;
  const parsed = JSON.parse(evidence);
  assert.deepEqual(Object.keys(parsed), ['prompt', 'reply']);
  assert.match(parsed.prompt, /\n"reply":"这是引号内的文字"\n\[已隐藏凭据\]/u);
  assert.match(parsed.reply, /"引号"。\n\[代码块\]/u);
  assert.doesNotMatch(evidence, /fixture-(?:user|code|open-code)-secret|\\u0000/u);
  assert.ok(Buffer.byteLength(evidence) <= 7900);
  assert.ok(parsed.prompt.length < 2500);
  assert.ok(parsed.reply.length < 1600);
  assert.equal(f.sends.at(-1).prompt, prompt);
});

test('an extraction publishes notes only from bounded JSON replies', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  let reply = '```json\n' + answer + '\n```';
  f.blockExtraction(() => {
    const sent = f.calls.findLast(({ op }) => op === 'send');
    return { ok: true, session: { id: sent.sessionId, turns: [{ id: sent.turnId, state: 'complete', reply }] } };
  });
  await bridge.request(f.send('codex', '图标定稿 32×32'));
  await until(() => JSON.parse(f.data.preference(memoryJournalKey)).jobs[0].phase === 'settled');
  assert.deepEqual(f.state().memories, []);

  reply = JSON.stringify({ memories: Array.from({ length: 3 }, () => ({ title: '字'.repeat(80), text: '字'.repeat(800) })) }) + ' '.repeat(400);
  assert.ok(reply.length < 8192 && Buffer.byteLength(reply) > 8192);
  await bridge.request(f.send('codex', '图标继续沿用 32×32'));
  await until(() => JSON.parse(f.data.preference(memoryJournalKey)).jobs.every(({ phase }) => phase === 'settled'));
  assert.deepEqual(f.state().memories, []);
  assert.equal(f.onError.length, 2);
  assert.ok(f.onError.every(message => message.includes('提炼结果格式无效')));
});

test('memory extraction models are verified for each Codex VPS and never inherit the chat model', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  await f.data.changeExtensions({ op: 'set-automatic-memory', targetId: alternateScope, projectId, enabled: true });
  const primarySettings = { provider: 'antigravity' };
  const alternateSettings = { provider: 'claude-sdk', host: alternateHost };
  await bridge.request({ op: 'list', settings: primarySettings });
  await bridge.request({ op: 'list', settings: alternateSettings });
  const choose = (targetId, model, effort) => bridge.changeExtractionModel({ op: 'set-memory-extraction-model',
    targetId, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) });

  await assert.rejects(choose(targets.antigravity, 'primary-memory'), /memory_extraction_target_unavailable/);
  await assert.rejects(choose(alternateScope, 'primary-memory'), /memory_extraction_model_unavailable/);
  await assert.rejects(choose(scope, 'primary-memory', 'medium'), /memory_extraction_model_unavailable/);
  await assert.rejects(choose(scope, undefined, 'low'), /invalid_extensions/);
  assert.deepEqual(f.state().memoryExtractionModels, []);

  await choose(scope, 'primary-memory', 'low');
  await choose(alternateScope, 'alternate-memory');
  const primary = f.send('codex', '图标定稿 32×32', projectId, { model: 'chat-model', effort: 'high' });
  const alternate = f.send('claude-sdk', '图标定稿 32×32', projectId, { settings: alternateSettings,
    targetId: alternateTargets['claude-sdk'], model: 'sonnet' });
  await bridge.request(primary);
  await bridge.request(alternate);
  await until(() => f.state().memories.length === 2);
  const extractions = f.calls.filter(({ op }) => op === 'send');
  assert.equal(extractions[0].model, 'primary-memory');
  assert.equal(extractions[0].effort, 'low');
  assert.equal(extractions[1].model, 'alternate-memory');
  assert.equal(Object.hasOwn(extractions[1], 'effort'), false);
  assert.equal(extractions[1].settings.host, alternateHost);
  assert.deepEqual(f.sends.slice(-2).map(({ model, effort }) => [model, effort]), [['chat-model', 'high'], ['sonnet', undefined]]);
  assert.ok(f.catalogCalls.every(({ targetId, settings, current }) =>
    current && settings.provider === 'codex' && routesFor(settings).codex === targetId));
  assert.ok(f.calls.filter(({ op }) => op === 'refresh').every(packet =>
    !Object.hasOwn(packet, 'model') && !Object.hasOwn(packet, 'effort')));

  await choose(scope);
  await bridge.request(f.send('codex', '这轮使用提炼默认值', projectId, { model: 'chat-model', effort: 'high' }));
  await until(() => f.calls.filter(({ op }) => op === 'send').length === 3);
  const defaultExtraction = f.calls.findLast(({ op }) => op === 'send');
  assert.equal(Object.hasOwn(defaultExtraction, 'model'), false);
  assert.equal(Object.hasOwn(defaultExtraction, 'effort'), false);
  assert.deepEqual(f.state().memoryExtractionModels, [{ targetId: alternateScope, model: 'alternate-memory' }]);
});

test('a removed or unavailable extraction model stops the job before send without falling back or replaying', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  await bridge.request({ op: 'list', settings: { provider: 'codex' } });
  const choice = { op: 'set-memory-extraction-model', targetId: scope, model: 'primary-memory', effort: 'low' };
  await bridge.changeExtractionModel(choice);
  f.catalogs.set(scope, [modelEntry('primary-memory', ['high'])]);
  const source = f.send('codex', '图标定稿 32×32');
  await bridge.request(source);
  await until(() => JSON.parse(f.data.preference(memoryJournalKey)).jobs[0].phase === 'settled');
  assert.match(f.onError[0], /已不提供所选的记忆提炼模型或推理强度/u);
  assert.equal(Object.hasOwn(JSON.parse(f.data.preference(memoryJournalKey)).jobs[0], 'taskId'), false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state().memories, []);
  assert.equal(f.state().memoryExtractionModels[0].effort, 'low');

  f.catalogs.delete(scope);
  await assert.rejects(bridge.changeExtractionModel(choice), /memory_extraction_catalog_unavailable/);
  await bridge.request(f.send('codex', '图标定稿 32×32'));
  await until(() => JSON.parse(f.data.preference(memoryJournalKey)).jobs.every(({ phase }) => phase === 'settled'));
  assert.match(f.onError.at(-1), /无法读取此 VPS 的 Codex 模型目录/u);
  assert.deepEqual(f.calls, []);
  f.catalogs.set(scope, [modelEntry('primary-memory', ['low'])]);
  await bridge.request({ op: 'refresh', settings: source.settings, targetId: source.targetId, sessionId: source.sessionId });
  assert.deepEqual(f.calls, []);
  f.browse();
  await assert.rejects(bridge.changeExtractionModel(choice), /memory_extraction_target_unavailable/);
});

test('a vague follow-up can recall notes using the previous prompt from its own session', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  const source = f.send('claude-sdk', '确认这个项目的图标尺寸为 32×32。');
  await bridge.request(source);
  await until(() => f.state().memories.length === 1);
  const short = '请沿用刚才的设置。';
  await bridge.request({ ...source, turnId: randomUUID(), prompt: short });
  assert.equal(f.sends.at(-1).prompt, short);
  assert.deepEqual(f.sends.at(-1).extensions?.memory, [note]);
  await bridge.request(f.send('claude-sdk', short));
  assert.equal(f.sends.at(-1).extensions, undefined);
  const unrelated = { ...source, turnId: randomUUID(), prompt: '帮我写一首关于月亮的诗。' };
  await bridge.request(unrelated);
  assert.equal(f.sends.at(-1).extensions, undefined);
});

test('independent context suppresses automatic and manual notes and retains selected MCP', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  await f.data.changeExtensions({ op: 'save-server', server: { id: 'status', targetId: scope, enabled: false } });
  await f.data.changeExtensions({ op: 'save-server', server: { id: 'status', targetId: scope, enabled: true } });
  const source = f.send('codex', '图标尺寸是什么？', projectId, { extensions: { memory: [note], mcpServers: ['status'] } });
  await f.data.changeExtensions({ op: 'set-conversation-isolation', targetId: scope, sessionId: source.sessionId, isolated: true });
  await bridge.request(source);
  assert.equal(f.sends[0].memoryIsolation, true);
  assert.deepEqual(f.sends[0].extensions, { memory: [], mcpServers: ['status'] });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state().memories, []);
  f.browse();
  assert.equal((await bridge.request(source)).code, 'workbench_browse_only');
  assert.equal(f.sends.length, 1);
});

test('replayed turns and recovered isolated sessions are never new extraction sources', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  const earlier = f.send('codex', '图标 32×32');
  await bridge.request(earlier);
  await f.enabled(true);
  await bridge.request(earlier);
  const { projectMemory, ...clean } = f.send('codex', '图标 48×48', projectId, { memoryIsolation: true });
  await bridge.request(clean);
  await bridge.request({ ...clean, projectMemory, turnId: randomUUID() });
  assert.equal(f.sends.at(-1).memoryIsolation, true);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state().memories, []);
});

test('an extraction completing after project opt-out cannot publish or restart', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  let release;
  f.blockExtraction(() => new Promise((resolve) => { release = resolve; }));
  await f.enabled(true);
  const source = f.send('antigravity', '图标尺寸定稿 32×32');
  await bridge.request(source);
  await until(() => Boolean(release));
  await f.enabled(false);
  await f.enabled(true);
  release();
  await until(() => JSON.parse(f.data.preference(memoryJournalKey)).jobs[0].phase === 'settled');
  await bridge.request({ op: 'refresh', settings: source.settings, targetId: source.targetId, sessionId: source.sessionId });
  assert.deepEqual(f.state().memories, []);
  assert.equal(f.calls.filter(({ op }) => op === 'send').length, 1);
});

test('after restart a reserved request reconciles its original receipt without resending', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  let release;
  f.failStart(() => new Promise((resolve) => { release = resolve; }));
  await f.enabled(true);
  const source = f.send('codex', '图标统一 32×32');
  await bridge.request({ op: 'list', settings: source.settings });
  await bridge.changeExtractionModel({ op: 'set-memory-extraction-model', targetId: scope, model: 'primary-memory', effort: 'low' });
  await bridge.request(source);
  await until(() => Boolean(release));
  f.catalogs.delete(scope);
  assert.equal(f.catalogCalls.length, 2);
  bridge.dispose();
  release({ ok: false, code: 'unknown' });
  const next = f.start();
  await next.request({ op: 'get', settings: source.settings, targetId: source.targetId, sessionId: source.sessionId });
  await until(() => f.state().memories.length === 1);
  assert.equal(f.calls.filter(({ op }) => op === 'send').length, 1);
  assert.equal(f.catalogCalls.length, 2);
});

test('one opt-in learns and recalls personal preferences in uncategorized ordinary chats', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  f.data.projects = () => [];
  const ordinary = f.send('codex', '我习惯用三行要点写摘要。', null);
  await bridge.request(ordinary);
  assert.equal(f.calls.length, 0);
  await f.data.changeExtensions({ op: 'set-personal-memory', enabled: true });
  const source = f.send('codex', ordinary.prompt, null);
  await bridge.request(source);
  await until(() => f.state().memories.length === 1);
  assert.equal(f.state().memories[0].projectId, null);
  assert.equal(f.state().memories[0].source.turnId, source.turnId);
  assert.equal(f.calls[0].memoryScope, 'personal');
  const plain = f.send('claude-sdk', '按我的摘要格式偏好写一段摘要。', null);
  await bridge.request(plain);
  assert.deepEqual(f.sends.at(-1).extensions, { memory: [preference], mcpServers: [] });

  const orphan = f.send('codex', plain.prompt, projectId);
  await bridge.request(orphan);
  assert.equal(f.sends.at(-1).extensions, undefined);
  const design = f.send('codex', plain.prompt, null, { mode: 'design' });
  await bridge.request(design);
  assert.equal(f.sends.at(-1).extensions, undefined);

  const isolated = f.send('antigravity', plain.prompt, null);
  await f.data.changeExtensions({ op: 'set-conversation-isolation', targetId: isolated.targetId,
    sessionId: isolated.sessionId, isolated: true });
  await bridge.request(isolated);
  assert.equal(f.sends.at(-1).memoryIsolation, true);
  assert.equal(f.sends.at(-1).extensions, undefined);
  assert.ok(JSON.parse(f.data.preference(memoryJournalKey)).jobs.every(({ sessionId }) =>
    [plain.sessionId, source.sessionId].includes(sessionId)));
});

test('a saved project membership blocks personal recall and cancels an in-flight personal extraction', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  let release;
  f.blockExtraction(() => new Promise((resolve) => { release = resolve; }));
  await f.data.changeExtensions({ op: 'set-personal-memory', enabled: true });
  const source = f.send('codex', '我习惯用三行要点写摘要。', null);
  await bridge.request(source);
  await until(() => Boolean(release));
  await f.data.setPreference(membershipKey(source.targetId), JSON.stringify({ [source.sessionId]: projectId }));
  release();
  await until(() => JSON.parse(f.data.preference(memoryJournalKey)).jobs[0].phase === 'settled');
  assert.equal(f.state().memories.length, 0);
  const assigned = f.send('codex', source.prompt, null, { sessionId: source.sessionId });
  await bridge.request(assigned);
  assert.equal(f.sends.at(-1).extensions, undefined);
  assert.equal(f.calls.filter(({ op }) => op === 'send').length, 1);
});

test('a new send with an outdated project label cannot read or generate notes for its former project', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  const source = f.send('codex', '图标尺寸定稿 32×32');
  await bridge.request(source);
  await until(() => f.state().memories.length === 1);
  const stale = f.send('claude-sdk', '查一下图标尺寸', projectId, { extensions: { memory: [note], mcpServers: [] } });
  f.assign(stale, otherProject);
  await bridge.request(stale);
  assert.equal(f.sends.at(-1).extensions, undefined);
  assert.equal(JSON.parse(f.data.preference(memoryJournalKey)).jobs.some(({ turnId }) => turnId === stale.turnId), false);
});

test('moving with inheritance uses the destination policy and discards a late extraction for the former project', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  await f.enabled(true, otherProject);
  await f.data.changeExtensions({ op: 'save-memory', memory: { id: 'destination-note', targetId: scope,
    projectId: otherProject, enabled: true, ...destinationNote } });
  let release;
  f.blockExtraction(() => new Promise((resolve) => { release = resolve; }));
  const source = f.send('codex', '图标尺寸定稿 32×32');
  await bridge.request(source);
  await until(() => Boolean(release));

  await f.data.setPreference(membershipKey(source.targetId), JSON.stringify({ [source.sessionId.toUpperCase()]: otherProject }));
  f.blockExtraction(() => undefined);
  release();
  await until(() => JSON.parse(f.data.preference(memoryJournalKey)).jobs[0].phase === 'settled');
  assert.equal(f.state().memories.some(({ source: origin }) => origin?.turnId === source.turnId), false);

  const next = { ...source, turnId: randomUUID(), prompt: '查一下图标尺寸', projectMemory: { projectId: otherProject },
    extensions: { memory: [note], mcpServers: [] } };
  await bridge.request(next);
  assert.deepEqual(f.sends.at(-1).extensions, { memory: [destinationNote], mcpServers: [] });
  assert.equal(f.sends.at(-1).sessionId, source.sessionId);
  await until(() => f.state().memories.some(({ source: origin }) => origin?.turnId === next.turnId));
  assert.equal(f.state().memories.find(({ source: origin }) => origin?.turnId === next.turnId).projectId, otherProject);
});

test('moving with inheritance also replaces stale manual notes when the destination uses manual memory', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.data.changeExtensions({ op: 'set-memory-enabled', enabled: true });
  await f.data.changeExtensions({ op: 'save-memory', memory: { id: 'destination-note', targetId: scope,
    projectId: otherProject, enabled: true, ...destinationNote } });
  const source = f.send('codex', '查一下图标尺寸', projectId, { extensions: { memory: [note], mcpServers: [] } });
  f.assign(source, otherProject);

  await bridge.request(source);
  assert.equal(f.sends.at(-1).extensions, undefined);
  await bridge.request({ ...source, turnId: randomUUID(), projectMemory: { projectId: otherProject } });
  assert.deepEqual(f.sends.at(-1).extensions, { memory: [destinationNote], mcpServers: [] });
  assert.deepEqual(f.calls, []);
});

test('a move while reserving the source stops dispatch under the former memory policy', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  await f.enabled(true);
  let release;
  f.blockPreferenceWrite((key) => {
    if (key === memoryJournalKey && !release) return new Promise((resolve) => { release = resolve; });
  });
  const source = f.send('codex', '查一下图标尺寸');
  const pending = bridge.request(source);
  await until(() => Boolean(release));
  f.assign(source, { projectId: otherProject, memory: 'isolated' });
  release();

  assert.equal((await pending).code, 'memory_scope_changed');
  assert.equal(JSON.parse(f.data.preference(memoryJournalKey)).jobs[0].phase, 'settled');
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.calls, []);
});

test('a move without inheritance strips memory from scoped and legacy sends while resuming the original thread', async (t) => {
  const f = fixture(t);
  const bridge = f.start();
  const source = f.send('codex', '之前的图标为 32×32');
  await bridge.request(source);
  await f.enabled(true, otherProject);
  await f.data.changeExtensions({ op: 'set-memory-enabled', enabled: true });
  await f.data.changeExtensions({ op: 'save-memory', memory: { id: 'destination-note', targetId: scope,
    projectId: otherProject, enabled: true, ...destinationNote } });
  f.assign(source, { projectId: otherProject, memory: 'isolated' });

  const { projectMemory, ...request } = source;
  const legacy = { ...request, turnId: randomUUID(), prompt: '查一下图标尺寸',
    extensions: { memory: [note], mcpServers: ['status'] } };
  const scoped = { ...legacy, turnId: randomUUID(), projectMemory: { projectId: otherProject } };
  for (const incoming of [scoped, legacy]) {
    const result = await bridge.request(incoming);
    assert.equal(result.session.id, source.sessionId);
    assert.equal(result.session.turns[0].id, source.turnId);
    assert.equal(result.session.memoryIsolation, false);
    const sent = f.sends.at(-1);
    assert.equal('memoryIsolation' in sent, false);
    assert.deepEqual(sent.extensions, { memory: [], mcpServers: ['status'] });
  }
  assert.equal(f.data.preference(memoryJournalKey), undefined);
  assert.deepEqual(f.calls, []);

  const unassigned = { ...legacy, sessionId: randomUUID(), turnId: randomUUID() };
  await bridge.request(unassigned);
  assert.deepEqual(f.sends.at(-1).extensions, legacy.extensions);
});

test('re-enabling personal memory retires obsolete watches before reserving a new source', async (t) => {
  const f = fixture(t);
  await f.data.changeExtensions({ op: 'set-personal-memory', enabled: true });
  await f.data.changeExtensions({ op: 'set-personal-memory', enabled: false });
  await f.data.changeExtensions({ op: 'set-personal-memory', enabled: true });
  const jobs = Array.from({ length: 128 }, () => ({ targetId: scope, sessionId: randomUUID(), turnId: randomUUID(),
    projectId: null, memoryTargetId: scope, revision: 1, phase: 'watching' }));
  await f.data.setPreference(memoryJournalKey, JSON.stringify({ jobs }));
  const bridge = f.start();
  await bridge.request(f.send('codex', '我习惯用三行要点写摘要。', null));
  await until(() => f.state().memories.length === 1);
  assert.equal(f.calls.filter(({ op }) => op === 'send').length, 1);
  assert.ok(JSON.parse(f.data.preference(memoryJournalKey)).jobs.filter(({ revision }) => revision === 1)
    .every(({ phase }) => phase === 'settled'));
});
