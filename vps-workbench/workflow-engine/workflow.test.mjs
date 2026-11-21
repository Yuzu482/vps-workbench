import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkflowChange, createWorkflowEditPrompt, readWorkflowProposal, readWorkflows,
  linearWorkflowEdges, preserveWorkflowAgents, validateStageAgent, validateWorkflowEdges, validateWorkflowDraft,
  validateWorkflowFileAccess, validateWorkflowProjectId, workflowEditPrefix } from './state.mjs';
import { createWorkflowRunner, readWorkflowRun, workflowStagePrompt } from './runner.mjs';

const id = 'ab4a55d8-bbbd-4c5f-91be-ac93a4a4173b';
const draft = { name: '写作审校', stages: [
  { name: '写作', provider: 'codex', model: 'writer-v1', instruction: '先写初稿。' },
  { name: '审校', provider: 'claude-sdk', model: '', instruction: '检查初稿并指出问题。' },
] };
const canonical = { ...draft, stages: draft.stages.map((stage, i) => ({ id: 's' + (i + 1), ...stage })),
  edges: [{ from: 's1', to: 's2' }] };
const target = (provider) => (provider === 'codex' ? 'a' : 'b').repeat(64);
const fence = (value) => `\`\`\`vps-workflow\n${JSON.stringify(value)}\n\`\`\``;
const agent = {
  mcpServers: [{ id: 'files', targetId: target('codex') }],
  plugins: [{ id: 'checklist', version: ' v1 ', title: ' 写作检查清单 📝 ' }],
  memory: 'isolated',
};
const agentPreset = { id: '8ad5ae88-af1c-4f37-a532-f50e542a3e36', name: '本机写作 Agent' };
const reviewPreset = { id: 'f1f91b18-7423-4473-b02e-17daa63819ec', name: '本机审校 Agent' };

test('saved workflow updates preserve revision conflicts and enforce exact schemas', () => {
  const created = applyWorkflowChange(readWorkflows(null), { op: 'save', id, revision: null, draft: { ...draft, name: ' 写作审校 ' } });
  assert.deepEqual(readWorkflows(JSON.stringify(created)), [{ id, revision: 1, ...canonical }]);
  assert.deepEqual(readWorkflows(JSON.stringify([{ id, revision: 1, ...draft }])), created);
  assert.throws(() => applyWorkflowChange(created, { op: 'save', id, revision: null, draft }), /已存在/);
  const updated = applyWorkflowChange(created, { op: 'save', id, revision: 1, draft });
  assert.throws(() => applyWorkflowChange(updated, { op: 'delete', id, revision: 1 }), /已变更/);
  assert.deepEqual(applyWorkflowChange(updated, { op: 'delete', id, revision: 2 }), []);
  assert.throws(() => readWorkflows(JSON.stringify([...created, ...created])), /编号重复/);
  assert.throws(() => validateWorkflowDraft({ ...draft, settings: {} }), /字段|名称/);
  assert.throws(() => validateWorkflowDraft({ ...draft, stages: [{ ...draft.stages[0], provider: '__proto__' }] }), /服务商无效/);
  assert.equal(validateWorkflowDraft({ ...draft, stages: [{ ...draft.stages[0], provider: 'antigravity' }] }).stages[0].model,
    draft.stages[0].model);
  assert.deepEqual(validateWorkflowDraft({ ...draft, stages: [{ ...draft.stages[0], provider: 'antigravity', model: '' }] }).stages[0].model, '');
});

test('model proposals are parsed from one valid fence and never contain extra fields', () => {
  assert.equal(readWorkflowProposal('普通回复'), null);
  assert.deepEqual(readWorkflowProposal(`说明\r\n${fence(draft).replaceAll('\n', '\r\n')}`), canonical);
  assert.deepEqual(readWorkflowProposal(fence(canonical)), canonical);
  assert.throws(() => readWorkflowProposal(fence(draft), { requireStageIds: true }), /保留的步骤使用原有 ID/);
  assert.deepEqual(readWorkflowProposal(fence(canonical), { requireStageIds: true }), canonical);
  assert.equal(readWorkflowProposal(`\`\`\`\`markdown\n${fence(draft)}\n\`\`\`\``), null);
  assert.equal(readWorkflowProposal(fence(canonical).replace(/^/gm, '> ')), null);
  assert.throws(() => readWorkflowProposal(`${fence(draft)}\n${fence(draft)}`), /只包含一个/);
  for (const closing of ['', '`', '``', '``…', '```…']) {
    assert.throws(() => readWorkflowProposal(`\`\`\`vps-workflow\n${JSON.stringify(canonical)}\n${closing}`),
      /不完整.*缩短步骤指令.*拆分或调整工作流/u);
  }
  assert.throws(() => readWorkflowProposal(fence({ ...draft, command: 'ignored' })), /字段|名称/);
  const prompt = createWorkflowEditPrompt(' 调整第二步 ', draft);
  assert.ok(prompt.startsWith(workflowEditPrefix));
  assert.ok(prompt.includes('调整第二步'));
  assert.ok(prompt.endsWith(JSON.stringify(canonical)));
  const long = { ...draft, stages: Array(8).fill({ ...draft.stages[0], instruction: '\\'.repeat(1200) }) };
  assert.throws(() => createWorkflowEditPrompt('调整第二步', long), /缩短本轮要求/);
});

test('proposal length counts both fence lines and non-ASCII UTF-16 code units', () => {
  const value = graph(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'], []);
  for (const stage of value.stages.slice(0, -1)) stage.instruction = '证'.repeat(1000);
  const last = value.stages.at(-1);
  last.instruction = '📝';
  last.instruction += '据'.repeat(8192 - fence(value).length);
  const exact = fence(value);
  assert.equal(exact.length, 8192);
  assert.equal([...exact].length, 8191);
  assert.deepEqual(readWorkflowProposal(exact), value);
  assert.throws(() => readWorkflowProposal(`${exact}\n`), /过长.*缩短步骤指令.*拆分或调整工作流/u);

  last.instruction = last.instruction.slice(0, -2);
  const crlf = fence(value).replaceAll('\n', '\r\n');
  assert.equal(crlf.length, 8192);
  assert.deepEqual(readWorkflowProposal(crlf), value);
  last.instruction += '据';
  assert.throws(() => readWorkflowProposal(fence(value).replaceAll('\n', '\r\n')), /过长/u);

  last.instruction += '据'.repeat(8180 - JSON.stringify(value).length);
  assert.equal(JSON.stringify(value).length, 8180);
  assert.throws(() => readWorkflowProposal(fence(value)), /过长.*缩短步骤指令.*拆分或调整工作流/u);
});

test('the partial edit example returns the full draft and review applies only to the original revision', () => {
  const original = { name: '写作与审校', stages: [
    { id: 'write', name: '写作', provider: 'codex', model: '', instruction: '写出初稿。' },
    { id: 'review', name: '审校', provider: 'claude', model: '', instruction: '核对初稿。' },
  ], edges: [{ from: 'write', to: 'review' }] };
  const configured = { ...original, stages: [{ ...original.stages[0], agent }, original.stages[1]] };
  const records = applyWorkflowChange([], { op: 'save', id, revision: null, draft: configured });
  const prompt = createWorkflowEditPrompt('给审校阶段增加证据位置', configured);
  assert.match(prompt, /只返回一个完整的顶层代码块.*\n.*紧凑 JSON.*8192 个 UTF-16/u);
  assert.match(prompt, /新增步骤时，用户未指定模型就填 "model":""/u);
  assert.match(prompt, /“给审校阶段增加证据位置”只修改 review 的 instruction/u);
  assert.ok(prompt.endsWith(JSON.stringify(original)));

  const example = prompt.split('\n').find((line) => line.startsWith('{"name"'));
  const proposed = readWorkflowProposal(`\`\`\`vps-workflow\n${example}\n\`\`\``, { requireStageIds: true });
  const expectedStage = { ...original.stages[1], instruction: '核对初稿并标明证据位置。' };
  assert.deepEqual(proposed, { ...original, stages: [original.stages[0], expectedStage] });
  const reviewed = preserveWorkflowAgents(records[0], proposed);
  const change = { op: 'save', id, revision: 1, draft: reviewed };
  const updated = applyWorkflowChange(records, change);
  assert.deepEqual(updated, [{ id, revision: 2, ...configured, stages: [configured.stages[0], expectedStage] }]);
  assert.throws(() => applyWorkflowChange(updated, change), /工作流已变更/u);
});

test('stage Agent snapshots validate MCP refs for Codex and Antigravity and preserve bounded manifest text', () => {
  const normalized = validateStageAgent(agent, 'codex');
  assert.deepEqual(normalized, agent);
  assert.notEqual(normalized.mcpServers[0], agent.mcpServers[0]);
  assert.notEqual(normalized.plugins[0], agent.plugins[0]);
  assert.deepEqual(validateStageAgent({ ...agent, mcpServers: [], memory: 'shared' }, 'claude'),
    { mcpServers: [], plugins: agent.plugins, memory: 'shared' });
  assert.throws(() => validateStageAgent(agent, 'claude'), /MCP.*Codex/);
  assert.throws(() => validateStageAgent(agent, 'claude-sdk'), /MCP.*Codex/);
  const antigravityAgent = { ...agent, mcpServers: [{ id: 'files', targetId: target('antigravity') }] };
  assert.deepEqual(validateStageAgent(antigravityAgent, 'antigravity'), antigravityAgent);
  for (const invalid of [
    null, { mcpServers: [], plugins: [] }, { ...agent, memory: 'global' }, { ...agent, capabilities: [] },
    { ...agent, mcpServers: [agent.mcpServers[0], agent.mcpServers[0]] },
    { ...agent, mcpServers: [{ id: 'files', targetId: 'A'.repeat(64) }] },
    { ...agent, mcpServers: [{ id: 'files', targetId: target('codex'), command: 'extra' }] },
    { ...agent, mcpServers: [...agent.mcpServers, { id: 'search', targetId: target('claude') }] },
    { ...agent, mcpServers: Array.from({ length: 9 }, (_, i) => ({ id: `server${i}`, targetId: target('codex') })) },
    { ...agent, plugins: [agent.plugins[0], agent.plugins[0]] },
    { ...agent, plugins: [{ ...agent.plugins[0], id: 'bad/plugin' }] },
    { ...agent, plugins: [{ ...agent.plugins[0], prompts: [] }] },
    { ...agent, plugins: [{ ...agent.plugins[0], version: 'v\n1' }] },
    { ...agent, plugins: [{ ...agent.plugins[0], title: 'invalid\uD800' }] },
    { ...agent, plugins: [{ ...agent.plugins[0], version: 'a'.repeat(41) }] },
    { ...agent, plugins: [{ ...agent.plugins[0], title: '📝'.repeat(41) }] },
    { ...agent, plugins: Array.from({ length: 5 }, (_, i) => ({ ...agent.plugins[0], id: `plugin${i}` })) },
  ]) assert.throws(() => validateStageAgent(invalid, 'codex'));

  const configured = { ...draft, stages: [{ ...draft.stages[0], agent }, draft.stages[1]] };
  const legacy = validateWorkflowDraft(configured);
  assert.deepEqual(legacy.stages[0].agent, agent);
  assert.equal(Object.hasOwn(legacy.stages[1], 'agent'), false);
  assert.deepEqual(validateWorkflowDraft(legacy), legacy);
  const records = applyWorkflowChange([], { op: 'save', id, revision: null, draft: configured });
  assert.deepEqual(readWorkflows(JSON.stringify(records)), [{ id, revision: 1, ...legacy }]);
  const antigravityWorkflow = { ...configured, stages: [
    { ...configured.stages[0], provider: 'antigravity', agent: antigravityAgent }, configured.stages[1],
  ] };
  const antigravityRecords = applyWorkflowChange([], { op: 'save', id, revision: null, draft: antigravityWorkflow });
  assert.deepEqual(readWorkflows(JSON.stringify(antigravityRecords))[0].stages[0].agent, antigravityAgent);
});

test('workflow project IDs preserve exact text and enforce the UTF-8 byte limit', () => {
  assert.equal(validateWorkflowProjectId(null), null);
  for (const projectId of [' 项目 📝 ', `${'界'.repeat(85)}x`, '📝'.repeat(64)]) {
    assert.equal(validateWorkflowProjectId(projectId), projectId);
  }
  for (const invalid of ['', undefined, 1, 'x'.repeat(257), '界'.repeat(86), 'x\ny', 'x\u0085y', 'x\uD800']) {
    assert.throws(() => validateWorkflowProjectId(invalid), /项目 ID 无效/);
  }
});

test('workflow Agent preset identity persists independently from modules and validates exact local fields', () => {
  const input = { ...canonical, stages: [
    { ...canonical.stages[0], agentPreset: { id: agentPreset.id.toUpperCase(), name: ` ${agentPreset.name} ` } },
    canonical.stages[1],
  ] };
  const expected = { ...canonical, stages: [{ ...canonical.stages[0], agentPreset }, canonical.stages[1]] };
  assert.deepEqual(validateWorkflowDraft(input), expected);
  const records = applyWorkflowChange([], { op: 'save', id, revision: null, draft: input });
  assert.deepEqual(readWorkflows(JSON.stringify(records)), [{ id, revision: 1, ...expected }]);
  const oldRaw = JSON.stringify([{ id, revision: 1, ...canonical }]);
  assert.equal(JSON.stringify(readWorkflows(oldRaw)), oldRaw);

  const withPreset = (value) => ({ ...input, stages: [{ ...input.stages[0], agentPreset: value }, input.stages[1]] });
  assert.equal(validateWorkflowDraft(withPreset({ ...agentPreset, name: '📝'.repeat(32) })).stages[0].agentPreset.name.length, 64);
  for (const invalid of [
    null, undefined, [], { name: agentPreset.name }, { id: agentPreset.id }, { ...agentPreset, provider: 'codex' },
    { ...agentPreset, id: 'invalid' }, { ...agentPreset, id: ` ${agentPreset.id}` }, { ...agentPreset, name: '' },
    { ...agentPreset, name: '多行\n名称' }, { ...agentPreset, name: '制表\t名称' }, { ...agentPreset, name: '\uD800' },
    { ...agentPreset, name: '📝'.repeat(33) },
  ]) assert.throws(() => validateWorkflowDraft(withPreset(invalid)), /Agent 预设/);
});

test('saved workflows can reload full Agent snapshots and escaped text across all 24 workflows', () => {
  const stageAgent = {
    mcpServers: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}${'a'.repeat(30)}`, targetId: target('codex') })),
    plugins: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}${'b'.repeat(30)}`, version: '\\'.repeat(40), title: '"'.repeat(80) })),
    memory: 'isolated',
  };
  const stages = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}${'a'.repeat(38)}`, name: '"'.repeat(64),
    provider: 'codex', model: 'm'.repeat(100), instruction: '\\'.repeat(1200), agent: stageAgent,
    agentPreset: { id: agentPreset.id, name: '"'.repeat(64) } }));
  const edges = stages.flatMap(({ id: from }, i) => stages.slice(i + 1).map(({ id: to }) => ({ from, to })));
  const workflows = Array.from({ length: 24 }, (_, i) => ({ id: `${id.slice(0, -2)}${i.toString(16).padStart(2, '0')}`,
    revision: Number.MAX_SAFE_INTEGER, name: '"'.repeat(80), stages, edges }));
  const raw = JSON.stringify(workflows);
  assert.ok(raw.length > 1_000_000);
  assert.deepEqual(readWorkflows(raw), workflows);
});

test('editing and reviewing a proposal keeps Agent choices local and preserves kept step IDs', () => {
  const saved = { id, revision: 3, ...canonical, stages: [
    { ...canonical.stages[0], agent, agentPreset }, { ...canonical.stages[1], agentPreset: reviewPreset },
  ] };
  const snapshot = { ...canonical, stages: saved.stages };
  const prompt = createWorkflowEditPrompt('交换步骤显示顺序并增加一步', snapshot);
  assert.ok(prompt.endsWith(JSON.stringify(canonical)));
  assert.ok(!prompt.includes(agent.mcpServers[0].targetId));
  assert.ok(!prompt.includes(agent.plugins[0].title));
  for (const preset of [agentPreset, reviewPreset]) {
    assert.ok(!prompt.includes(preset.id));
    assert.ok(!prompt.includes(preset.name));
  }
  assert.throws(() => readWorkflowProposal(fence(snapshot)), /字段/);
  assert.throws(() => readWorkflowProposal(fence({ ...canonical, stages: [canonical.stages[0], saved.stages[1]] })), /字段/);
  assert.throws(() => preserveWorkflowAgents(saved, snapshot), /字段/);

  const reordered = { ...canonical, stages: [canonical.stages[1], { ...canonical.stages[0], name: '修改后' },
    { ...canonical.stages[0], id: 'extra' }] };
  const proposal = readWorkflowProposal(fence(reordered));
  const preserved = preserveWorkflowAgents(saved, proposal);
  assert.deepEqual(preserved.stages[1].agent, agent);
  assert.deepEqual(preserved.stages[0].agentPreset, reviewPreset);
  assert.deepEqual(preserved.stages[1].agentPreset, agentPreset);
  assert.equal(Object.hasOwn(preserved.stages[0], 'agent'), false);
  assert.equal(Object.hasOwn(preserved.stages[2], 'agent'), false);
  assert.equal(Object.hasOwn(preserved.stages[2], 'agentPreset'), false);
  assert.equal(Object.hasOwn(proposal.stages[1], 'agent'), false);
  assert.equal(Object.hasOwn(proposal.stages[0], 'agentPreset'), false);
  assert.deepEqual(preserveWorkflowAgents(null, proposal), proposal);
  assert.deepEqual(preserveWorkflowAgents(saved, { ...proposal, stages: [proposal.stages[0], proposal.stages[2]], edges: [] }),
    { ...proposal, stages: [{ ...proposal.stages[0], agentPreset: reviewPreset }, proposal.stages[2]], edges: [] });

  const changedProvider = { ...canonical, stages: [{ ...canonical.stages[0], provider: 'claude' }, canonical.stages[1]] };
  assert.throws(() => preserveWorkflowAgents(saved, changedProvider), /请保留 Codex.*移除/);
  const antigravity = { ...canonical, stages: [{ ...canonical.stages[0], provider: 'antigravity' }, canonical.stages[1]] };
  assert.throws(() => preserveWorkflowAgents(saved, antigravity), /请保留 Codex.*移除/);
  const antigravitySaved = { ...saved, stages: [{ ...saved.stages[0], provider: 'antigravity',
    agent: { ...agent, mcpServers: [{ id: 'files', targetId: target('antigravity') }] } }, saved.stages[1]] };
  assert.throws(() => preserveWorkflowAgents(antigravitySaved, canonical), /请保留 Antigravity.*移除/);
  const portable = { ...saved, stages: [{ ...saved.stages[0], agent: { ...agent, mcpServers: [] } }, saved.stages[1]] };
  assert.deepEqual(preserveWorkflowAgents(portable, changedProvider).stages[0].agent, portable.stages[0].agent);
});

function replyFor(payload, state, reply) {
  return { session: { id: payload.sessionId, turns: [{ id: payload.turnId, state, reply }] } };
}

function fixture(overrides = {}) {
  let raw = overrides.raw ?? null;
  let view;
  const calls = [];
  const dependencies = {
    pollInterval: 0,
    resolveRoute: async (provider) => ({ settings: { provider }, targetId: target(provider) }),
    readModels: async () => [{ id: 'writer-v1' }],
    rpc: async (op, payload) => {
      if (op === 'send') {
        const durable = readWorkflowRun(raw);
        assert.ok(durable.rows.some((row) => row.state === 'submitted' && row.sessionId === payload.sessionId && row.turnId === payload.turnId));
        return replyFor(payload, 'complete', '上游答复');
      }
      assert.fail(`Unexpected ${op}`);
    },
    ...overrides,
  };
  const runner = createWorkflowRunner({ ...dependencies, initialRun: readWorkflowRun(raw), onChange: (run, busy) => { view = { run, busy }; },
    async persist(next) {
      if (await dependencies.persist?.(next) === false) return false;
      raw = JSON.stringify(next);
    },
    rpc(op, payload, signal) {
      calls.push({ op, ...payload });
      return dependencies.rpc(op, payload, signal);
    },
  });
  return { runner, get raw() { return raw; }, get view() { return view; }, calls };
}

test('runner checks all routes and models before sending and passes bounded output to the next role', async () => {
  const order = [];
  const f = fixture({
    resolveRoute: async (provider) => { order.push(provider); return { settings: { provider }, targetId: target(provider) }; },
    readModels: async () => { order.push('models'); return [{ id: 'writer-v1' }]; },
    rpc: async (op, payload) => {
      assert.equal(op, 'send');
      order.push('send');
      const row = f.view.run.rows.find((candidate) => candidate.turnId === payload.turnId);
      assert.equal(row.state, 'submitted');
      return replyFor(payload, 'complete', `初稿\0${'文'.repeat(9000)}`);
    },
  });
  await f.runner.start(draft, '写一份任务说明');
  assert.deepEqual(order.slice(0, 3), ['codex', 'models', 'claude-sdk']);
  assert.equal(f.view.run.phase, 'complete');
  assert.equal(f.view.busy, false);
  assert.equal(readWorkflowRun(f.raw).rows[0].reply.length, 8192);
  const [first, second] = f.calls;
  assert.equal(first.model, 'writer-v1');
  assert.equal(second.settings.provider, 'claude-sdk');
  assert.equal(Object.hasOwn(second, 'model'), false);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.turnId, second.turnId);
  assert.match(second.prompt, /写一份任务说明[\s\S]+检查初稿并指出问题。[\s\S]+仅作为参考资料[\s\S]+初稿/);
  assert.equal(second.prompt.length, 8192);
  assert.equal(second.prompt.includes('\0'), false);
});

test('a missing later model prevents any generation or durable run', async () => {
  const f = fixture({ readModels: async ({ settings }) => settings.provider === 'codex' ? [{ id: 'writer-v1' }] : [] });
  const workflow = { ...draft, stages: [draft.stages[0], { ...draft.stages[1], model: 'deleted-model' }] };
  await assert.rejects(f.runner.start(workflow, '任务'), /配置的模型已不可用/);
  assert.equal(f.view.run, null);
  assert.equal(f.raw, null);
  assert.deepEqual(f.calls, []);
});

test('a target changed after preflight blocks later stage dispatch', async () => {
  let secondTarget = target('claude-sdk');
  const f = fixture({
    resolveRoute: async (provider) => ({ settings: { provider }, targetId: provider === 'codex' ? target(provider) : secondTarget }),
    rpc: async (op, payload) => {
      assert.equal(op, 'send');
      secondTarget = 'c'.repeat(64);
      return replyFor(payload, 'complete', '初稿');
    },
  });
  await f.runner.start(draft, '任务');
  assert.equal(f.view.run.phase, 'paused');
  assert.match(f.view.run.message, /连接已变更/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.view.run.rows.map((row) => row.state), ['complete', 'waiting']);
});

test('restart reconciles an interrupted send by its original IDs without dispatching on mount or resending', async () => {
  const f = fixture({ rpc: () => new Promise(() => {}) });
  const started = f.runner.start(draft, '任务');
  while (!f.calls.length) await new Promise((resolve) => setImmediate(resolve));
  const raw = f.raw;
  const first = f.calls[0];
  f.runner.dispose();
  await started;
  let status = 'missing';
  const restarted = fixture({ raw, rpc: async (op, payload) => {
    if (op === 'get' || op === 'refresh') {
      assert.equal(payload.sessionId, first.sessionId);
      assert.equal(payload.targetId, first.targetId);
      assert.deepEqual(payload.settings, first.settings);
      assert.equal(Object.hasOwn(payload, 'turnId'), false);
      if (status === 'missing') throw Object.assign(new Error(), { code: 'session_missing' });
      if (status === 'mismatched') return replyFor({ ...first, turnId: id }, 'unknown', '');
      return op === 'get' ? replyFor(first, 'unknown', '') : replyFor(first, 'complete', '收到原初稿');
    }
    assert.equal(op, 'send');
    assert.notEqual(payload.turnId, first.turnId);
    return replyFor(payload, 'complete', '校对完成');
  } });
  assert.equal(restarted.view.run.phase, 'paused');
  assert.deepEqual(restarted.calls, []);
  await restarted.runner.resume();
  assert.equal(restarted.view.run.rows[0].state, 'unknown');
  await assert.rejects(restarted.runner.start(draft, '新任务'), /尚未结束/);
  status = 'mismatched';
  await restarted.runner.resume();
  assert.equal(restarted.view.run.rows[0].state, 'unknown');
  assert.deepEqual(restarted.calls.map((call) => call.op), ['get', 'get']);
  status = 'matched';
  await restarted.runner.resume();
  assert.equal(restarted.view.run.phase, 'complete');
  assert.deepEqual(restarted.calls.map((call) => call.op), ['get', 'get', 'get', 'refresh', 'send']);
});

test('pause during submitted-intent persistence restores the original unsent waiting row', async () => {
  const intentStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = fixture({ async persist(next) {
    if (next.rows[0].state !== 'submitted') return;
    intentStarted.resolve(next.rows[0]);
    await release.promise;
  } });
  const starting = f.runner.start(draft, '任务');
  const intent = await intentStarted.promise;
  const paused = f.runner.pause();
  release.resolve();
  await Promise.all([starting, paused]);
  assert.deepEqual(f.calls, []);
  const restored = readWorkflowRun(f.raw);
  assert.equal(restored.phase, 'paused');
  assert.deepEqual(restored.rows[0], { ...intent, state: 'waiting' });
  await f.runner.resume();
  assert.deepEqual(f.calls.map(({ op }) => op), ['send', 'send']);
  assert.equal(f.calls[0].turnId, intent.turnId);
  assert.equal(f.calls[0].sessionId, intent.sessionId);
});

test('pause cancels preflight without replacing a prior terminal run', async () => {
  const previous = fixture();
  await previous.runner.start(draft, '原任务');
  const readingRoute = Promise.withResolvers();
  const f = fixture({ raw: previous.raw, async resolveRoute() {
    readingRoute.resolve();
    return new Promise(() => {});
  } });
  const starting = f.runner.start(draft, '新任务');
  await readingRoute.promise;
  await Promise.all([starting, f.runner.pause()]);
  assert.equal(f.raw, previous.raw);
  assert.equal(f.view.run.phase, 'complete');
  assert.equal(f.view.busy, false);
  assert.deepEqual(f.calls, []);
});

test('dispatch gate rejects mixed preflight settings and rolls back after an eligibility race', async () => {
  let revision = 1;
  const mixed = fixture({
    async resolveRoute(provider) {
      if (provider === 'claude-sdk') revision++;
      return { settings: { provider, revision }, targetId: target(provider) };
    },
    canDispatch: ({ settings }) => settings.revision === revision,
  });
  await assert.rejects(mixed.runner.start(draft, '任务'), /连接已变更/);
  assert.equal(mixed.raw, null);
  assert.deepEqual(mixed.calls, []);

  let allowed = true;
  const f = fixture({ canDispatch: () => allowed, async persist(next) {
    if (next.rows[0].state === 'submitted') allowed = false;
  } });
  await f.runner.start(draft, '任务');
  const paused = readWorkflowRun(f.raw);
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.rows[0].state, 'waiting');
  assert.match(paused.message, /连接已变更/);
  assert.deepEqual(f.calls, []);
});

test('stop intent survives a route lookup failure and restart without allowing downstream dispatch', async () => {
  let original;
  let lookupFails = false;
  const f = fixture({
    async resolveRoute(provider, signal, { dispatch }) {
      if (!dispatch && lookupFails) {
        assert.equal(readWorkflowRun(f.raw).rows[0].state, 'canceling');
        throw new Error('offline');
      }
      return { settings: { provider }, targetId: target(provider) };
    },
    async rpc(op, payload) {
      assert.equal(op, 'send');
      original = payload;
      return new Promise(() => {});
    },
  });
  const starting = f.runner.start(draft, '任务');
  while (!original) await new Promise((resolve) => setImmediate(resolve));
  lookupFails = true;
  await Promise.all([starting, f.runner.stop()]);
  assert.deepEqual(f.calls.map(({ op }) => op), ['send']);
  assert.equal(readWorkflowRun(f.raw).rows[0].state, 'canceling');

  let settled = false;
  const restarted = fixture({ raw: f.raw, async rpc(op, payload) {
    assert.equal(payload.sessionId, original.sessionId);
    if (op === 'get') return replyFor(original, 'running', '本机仍记录为运行中');
    assert.equal(op, 'refresh');
    return settled ? replyFor(original, 'complete', '此前已完成') : replyFor(original, 'running', '处理中');
  } });
  assert.deepEqual(restarted.calls, []);
  await restarted.runner.resume();
  assert.equal(readWorkflowRun(restarted.raw).rows[0].state, 'canceling');
  assert.equal(restarted.view.run.phase, 'paused');
  settled = true;
  await restarted.runner.resume();
  assert.equal(readWorkflowRun(restarted.raw).phase, 'stopped');
  assert.deepEqual(restarted.calls.map(({ op }) => op), ['get', 'refresh', 'get', 'refresh']);

  const retriedStop = fixture({ raw: f.raw, async rpc(op, payload) {
    assert.equal(payload.sessionId, original.sessionId);
    if (op === 'stop') {
      assert.equal(payload.turnId, original.turnId);
      assert.equal(readWorkflowRun(retriedStop.raw).rows[0].state, 'stopping');
      return { outcome: 'requested' };
    }
    assert.equal(op, 'refresh');
    return replyFor(original, 'stopped', '');
  } });
  await retriedStop.runner.stop();
  assert.equal(readWorkflowRun(retriedStop.raw).phase, 'stopped');
  assert.deepEqual(retriedStop.calls.map(({ op }) => op), ['stop', 'refresh']);
});

test('a failed stop intent write blocks stop dispatch and keeps downstream stages disarmed in memory', async () => {
  let original;
  const f = fixture({
    persist: async (next) => next.rows[0].state !== 'canceling',
    async rpc(op, payload) {
      if (op === 'send' && !original) {
        original = payload;
        return new Promise(() => {});
      }
      assert.equal(op, 'get');
      return replyFor(original, 'complete', '原结果');
    },
  });
  const starting = f.runner.start(draft, '任务');
  while (!original) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.runner.stop(), /无法保存/);
  await starting;
  assert.equal(f.view.run.phase, 'paused');
  assert.equal(f.view.run.rows[0].state, 'canceling');
  assert.deepEqual(f.calls.map(({ op }) => op), ['send']);
  await f.runner.resume();
  assert.equal(readWorkflowRun(f.raw).phase, 'stopped');
  assert.deepEqual(f.calls.map(({ op }) => op), ['send', 'get']);
});

test('pause aborts local observation and stop reconciles a contradictory receipt without advancing', async () => {
  let sent;
  let settled = false;
  const f = fixture({ rpc: async (op, payload) => {
    if (op === 'send') {
      sent = payload;
      return new Promise(() => {});
    }
    if (op === 'stop') {
      assert.equal(payload.turnId, sent.turnId);
      assert.equal(payload.sessionId, sent.sessionId);
      return { outcome: 'requested' };
    }
    assert.equal(op, 'refresh');
    return settled ? replyFor(sent, 'complete', '停止前完成') : replyFor({ ...sent, turnId: id }, 'complete', '其他轮次');
  } });
  const started = f.runner.start(draft, '任务');
  while (!sent) await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([f.runner.pause(), f.runner.stop(), started]);
  assert.equal(f.view.run.phase, 'paused');
  assert.equal(f.view.run.rows[0].state, 'stopping');
  settled = true;
  await f.runner.resume();
  assert.equal(readWorkflowRun(f.raw).phase, 'stopped');
  assert.deepEqual(f.calls.map((call) => call.op), ['send', 'stop', 'refresh', 'refresh']);
});

test('a failed intent write prevents the send', async () => {
  const f = fixture({ persist: async (next) => !next.rows.some(({ state }) => state === 'submitted') });
  await assert.rejects(f.runner.start(draft, '任务'), /无法保存/);
  assert.equal(f.view.run.phase, 'paused');
  assert.equal(f.view.run.rows[0].state, 'waiting');
  assert.deepEqual(f.calls, []);
});

test('confirmed pre-dispatch rejection records failure while transport errors stay unresolved', async () => {
  const rpcFailure = (code) => async () => {
    throw Object.assign(new Error('当前访问设置拒绝了请求。'), { code });
  };
  const rejected = fixture({ rpc: rpcFailure('workbench_browse_only') });
  await rejected.runner.start(draft, '任务');
  assert.equal(readWorkflowRun(rejected.raw).phase, 'failed');
  assert.equal(rejected.view.run.rows[0].state, 'failed');
  assert.equal(rejected.view.run.message, '当前访问设置拒绝了请求。');
  assert.deepEqual(rejected.calls.map(({ op }) => op), ['send']);

  const uncertain = fixture({ rpc: rpcFailure('transport_unavailable') });
  await uncertain.runner.start(draft, '任务');
  assert.equal(readWorkflowRun(uncertain.raw).phase, 'paused');
  assert.equal(uncertain.view.run.rows[0].state, 'unknown');
  assert.deepEqual(uncertain.calls.map(({ op }) => op), ['send']);
});

test('a contradictory turn response pauses instead of handing off the reply', async () => {
  const f = fixture({ rpc: async (_, payload) => ({ ...replyFor(payload, 'complete', '其他目标的文本'), targetId: 'c'.repeat(64) }) });
  await f.runner.start(draft, '任务');
  assert.equal(f.view.run.phase, 'paused');
  assert.equal(f.view.run.rows[0].state, 'unknown');
  assert.equal(f.view.run.rows[0].reply, '');
  assert.equal(f.calls.length, 1);
});

function graph(ids, pairs) {
  return { name: '图工作流', stages: ids.map((id) => ({ id, name: id, provider: 'codex', model: '', instruction: '执行 ' + id })),
    edges: pairs.map(([from, to]) => ({ from, to })) };
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('timed out waiting for workflow observation');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('v4 Agent runs journal project and module snapshots and resume only original submitted receipts', async () => {
  const g = graph(['first', 'second', 'plain'], [['first', 'second'], ['second', 'plain']]);
  g.stages[0].agent = structuredClone(agent);
  g.stages[0].agentPreset = { ...agentPreset };
  g.stages[1].agent = { mcpServers: [], plugins: [], memory: 'shared' };
  const interrupted = fixture({ rpc: () => new Promise(() => {}) });
  const starting = interrupted.runner.start(g, '任务', ' 项目 📝 ');
  await until(() => interrupted.calls.length === 1);
  interrupted.runner.dispose();
  await starting;

  const snapshot = readWorkflowRun(interrupted.raw);
  const original = interrupted.calls[0];
  assert.equal(snapshot.version, 4);
  assert.equal(snapshot.projectId, ' 项目 📝 ');
  assert.equal(snapshot.rows[0].state, 'submitted');
  assert.deepEqual(snapshot.workflow.stages[0].agent, agent);
  assert.deepEqual(snapshot.workflow.stages[0].agentPreset, agentPreset);
  assert.equal(Object.hasOwn(snapshot.workflow.stages[1], 'agentPreset'), false);
  assert.deepEqual(original.workflowStage, { runId: snapshot.id });
  assert.deepEqual([original.targetId, original.sessionId, original.turnId],
    [snapshot.rows[0].targetId, snapshot.rows[0].sessionId, snapshot.rows[0].turnId]);
  assert.equal(Object.hasOwn(original, 'agent'), false);
  assert.equal(Object.hasOwn(original, 'projectId'), false);
  assert.equal(original.prompt, workflowStagePrompt(snapshot, 0));
  g.stages[0].agent.plugins[0].title = '修改后的预设';
  g.stages[0].agentPreset.name = '修改后的预设';
  g.stages[1].agent.memory = 'isolated';

  const restarted = fixture({ raw: interrupted.raw, async rpc(op, payload) {
    if (op === 'get') return replyFor(original, 'complete', '原始第一步答复');
    assert.equal(op, 'send');
    const durable = readWorkflowRun(restarted.raw);
    assert.equal(durable.id, snapshot.id);
    assert.equal(durable.projectId, snapshot.projectId);
    assert.deepEqual(durable.workflow, snapshot.workflow);
    const row = durable.rows.find(({ turnId }) => turnId === payload.turnId);
    assert.equal(row.state, 'submitted');
    assert.equal(row.sessionId, payload.sessionId);
    return replyFor(payload, 'complete', '继续完成');
  } });
  assert.deepEqual(restarted.calls, []);
  await restarted.runner.resume();
  assert.equal(readWorkflowRun(restarted.raw).phase, 'complete');
  const [get, configuredSend, plainSend] = restarted.calls;
  assert.deepEqual(restarted.calls.map(({ op }) => op), ['get', 'send', 'send']);
  assert.equal(get.targetId, original.targetId);
  assert.equal(get.sessionId, original.sessionId);
  assert.equal(Object.hasOwn(get, 'workflowStage'), false);
  assert.deepEqual(configuredSend.workflowStage, { runId: snapshot.id });
  assert.match(configuredSend.prompt, /原始第一步答复/);
  assert.deepEqual(plainSend.workflowStage, { runId: snapshot.id });
  assert.ok(!JSON.stringify([original, ...restarted.calls]).includes(agentPreset.id));
  assert.ok(!JSON.stringify([original, ...restarted.calls]).includes(agentPreset.name));

  const { projectId, ...older } = snapshot;
  assert.throws(() => readWorkflowRun(JSON.stringify({ ...older, version: 2 })), /运行记录无效/);
  assert.throws(() => readWorkflowRun(JSON.stringify(older)), /运行记录无效/);
  assert.throws(() => readWorkflowRun(JSON.stringify({ ...snapshot, projectId: '无效\n项目' })), /项目 ID 无效/);
  const wrongTarget = { ...snapshot.rows[0], targetId: target('claude') };
  assert.throws(() => readWorkflowRun(JSON.stringify({ ...snapshot, rows: [wrongTarget, ...snapshot.rows.slice(1)] })), /运行记录无效/);
  const v1 = { version: 1, id: snapshot.id, workflow: { ...draft, stages: [{ ...draft.stages[0], agent }, draft.stages[1]] },
    task: snapshot.task, phase: 'running', rows: snapshot.rows.slice(0, 2), message: '' };
  assert.throws(() => readWorkflowRun(JSON.stringify(v1)), /运行记录无效/);
});

test('MCP target mismatches prevent new runs and unconfigured workflows still use a scoped receipt', async () => {
  const configured = { ...draft, stages: [{ ...draft.stages[0], agent }, draft.stages[1]] };
  const moved = fixture({ async resolveRoute(provider) { return { settings: { provider }, targetId: 'c'.repeat(64) }; } });
  await assert.rejects(moved.runner.start(configured, '任务', null), /连接已变更/);
  assert.equal(moved.raw, null);
  assert.deepEqual(moved.calls, []);
  const antigravity = { ...configured, stages: [
    { ...configured.stages[0], provider: 'antigravity', model: '' }, configured.stages[1],
  ] };
  const mismatched = fixture();
  await assert.rejects(mismatched.runner.start(antigravity, '任务', null), /连接已变更/);
  assert.equal(mismatched.raw, null);
  assert.deepEqual(mismatched.calls, []);
  const correct = fixture();
  antigravity.stages[0].agent = { ...agent, mcpServers: [{ id: 'files', targetId: target('antigravity') }] };
  await correct.runner.start(antigravity, '任务', null);
  assert.equal(readWorkflowRun(correct.raw).rows[0].targetId, target('antigravity'));
  assert.ok(correct.calls.every((call) => call.workflowStage?.runId));

  const local = fixture();
  await assert.rejects(local.runner.start(configured, '任务', '不合法\t项目'), /项目 ID 无效/);
  assert.equal(local.raw, null);
  await local.runner.start(configured, '任务');
  assert.equal(readWorkflowRun(local.raw).projectId, null);

  const plain = fixture();
  await plain.runner.start(draft, '任务', '所选项目');
  const run = readWorkflowRun(plain.raw);
  assert.equal(run.version, 4);
  assert.equal(run.projectId, '所选项目');
  assert.ok(plain.calls.every((call) => call.workflowStage?.runId === run.id));
});

test('identity-only runs keep the preset snapshot out of model lookups and RPCs', async () => {
  const modelRoutes = [];
  const f = fixture({
    async readModels(route) {
      modelRoutes.push(route);
      return [{ id: 'writer-v1' }];
    },
  });
  const workflow = { ...canonical, stages: [{ ...canonical.stages[0], agentPreset }, canonical.stages[1]] };
  await f.runner.start(workflow, '任务', '所选项目');
  const run = readWorkflowRun(f.raw);
  assert.equal(run.phase, 'complete');
  assert.equal(run.version, 4);
  assert.equal(run.projectId, '所选项目');
  assert.deepEqual(run.workflow, workflow);
  assert.deepEqual(run, JSON.parse(f.raw));
  assert.ok(modelRoutes.length > 0);
  for (const route of modelRoutes) assert.deepEqual(route, { settings: { provider: 'codex' }, targetId: target('codex') });
  assert.ok(f.calls.every((call) => call.workflowStage?.runId === run.id && !Object.hasOwn(call, 'agentPreset')));
  assert.ok(!JSON.stringify(f.calls).includes(agentPreset.id));
  assert.ok(!JSON.stringify(f.calls).includes(agentPreset.name));
});

test('file grants stay local, follow stable stage IDs, and require the approved target and a saved workflow', async () => {
  const fileAccess = {
    targetId: target('codex'), paths: ['规格/稿件.txt'],
    attachments: [{ digest: '8'.repeat(64), name: '附件.txt', size: 1 }],
  };
  const workflow = { ...canonical, stages: [{ ...canonical.stages[0], fileAccess }, canonical.stages[1]] };
  assert.deepEqual(validateWorkflowDraft(workflow).stages[0].fileAccess, fileAccess);
  for (const path of ['/absolute', 'a/../b', 'a\\b', 'a//b', './doc', 'bad\0path', '界'.repeat(86)]) {
    assert.throws(() => validateWorkflowFileAccess({ ...fileAccess, paths: [path] }), /文件路径/u);
  }
  assert.throws(() => validateWorkflowFileAccess({ ...fileAccess, attachments: [{ ...fileAccess.attachments[0], size: 524289 }] }),
    /512 KiB/);
  assert.doesNotMatch(createWorkflowEditPrompt('调整步骤', workflow), /fileAccess|稿件\.txt|附件\.txt/u);
  const proposal = { ...canonical, name: '重命名' };
  assert.deepEqual(preserveWorkflowAgents(workflow, proposal).stages[0].fileAccess, fileAccess);
  const unsaved = fixture();
  await assert.rejects(unsaved.runner.start(workflow, '任务'), /保存文件授权/u);
  assert.deepEqual(unsaved.calls, []);
  const moved = fixture({ async resolveRoute(provider) { return { settings: { provider }, targetId: '9'.repeat(64) }; } });
  await assert.rejects(moved.runner.start(workflow, '任务', null, null, id), /连接已变更/u);
  assert.deepEqual(moved.calls, []);
});

test('a stopped Agent run uses existing stop and refresh payloads', async () => {
  const g = graph(['first'], []);
  g.stages[0].agent = agent;
  let original;
  const f = fixture({ rpc(op, payload) {
    if (op === 'send') {
      original = payload;
      return new Promise(() => {});
    }
    if (op === 'stop') return { outcome: 'requested' };
    return replyFor(original, 'stopped', '');
  } });
  const starting = f.runner.start(g, '任务', '项目');
  await until(() => f.calls.length === 1);
  await Promise.all([starting, f.runner.stop()]);
  const [send, stop, refresh] = f.calls;
  assert.deepEqual(f.calls.map(({ op }) => op), ['send', 'stop', 'refresh']);
  assert.ok(send.workflowStage);
  assert.equal(Object.hasOwn(stop, 'workflowStage'), false);
  assert.equal(stop.sessionId, send.sessionId);
  assert.equal(stop.turnId, send.turnId);
  assert.equal(Object.hasOwn(refresh, 'workflowStage'), false);
  assert.equal(refresh.sessionId, send.sessionId);
  assert.equal(readWorkflowRun(f.raw).phase, 'stopped');
});

test('confirmed Agent gate rejections skip dependants without retrying sends', async () => {
  const configured = { ...draft, stages: [{ ...draft.stages[0], agent }, draft.stages[1]] };
  for (const code of ['workflow_stage_changed', 'workflow_modules_unavailable', 'storage_before_send']) {
    const f = fixture({ async rpc() { throw Object.assign(new Error('当前步骤模块无法使用。'), { code }); } });
    await f.runner.start(configured, '任务');
    const run = readWorkflowRun(f.raw);
    assert.equal(run.phase, 'failed');
    assert.equal(run.message, '当前步骤模块无法使用。');
    assert.deepEqual(run.rows.map(({ state }) => state), ['failed', 'skipped']);
    assert.deepEqual(f.calls.map(({ op }) => op), ['send']);
  }
});

test('plugin instructions stay intact ahead of bounded parent replies', () => {
  const g = graph(['long', 'short', 'join'], [['long', 'join'], ['short', 'join']]);
  g.stages[2].instruction = '指'.repeat(1200);
  const run = { workflow: g, task: '任'.repeat(4000), rows: [{ reply: '📝'.repeat(4096) }, { reply: '短答复' }, { reply: '' }] };
  const plugin = '插件'.repeat(1100);
  const prompt = workflowStagePrompt(run, 2, plugin);
  assert.match(prompt, new RegExp(`指{1200}\\n\\n${plugin}\\n\\n以任务`));
  assert.match(prompt, /前置步骤「long」\(long\) 的回复（本次截断）\n> 📝+…/u);
  assert.match(prompt, /前置步骤「short」\(short\) 的回复（引用资料）\n> 短答复$/u);
  assert.ok(prompt.length === 8192 || prompt.length === 8191);
  assert.doesNotMatch(prompt, /[\uD800-\uDFFF]/u);

  const empty = { ...run, rows: run.rows.map(() => ({ reply: '' })) };
  const room = 8192 - workflowStagePrompt(empty, 2, 'p').length + 1;
  const noRoom = workflowStagePrompt(run, 2, 'p'.repeat(room));
  assert.equal(noRoom.length, 8192);
  assert.match(noRoom, /「long」\(long\) 的回复（本次截断）\n\n\n前置步骤「short」\(short\) 的回复（本次截断）\n$/u);
  assert.doesNotMatch(noRoom, /📝|短答复/u);
  assert.throws(() => workflowStagePrompt(run, 2, 'p'.repeat(room + 1)), /超出聊天长度上限/);
  assert.throws(() => workflowStagePrompt(run, 0, 'p'.repeat(8192)), /超出聊天长度上限/);
});

test('stage handoff quotes both replies and labels only text clipped by this handoff', () => {
  const workflow = graph(['source', 'review', 'join'], [['source', 'join'], ['review', 'join']]);
  const rows = [{ reply: '证据：草稿第 1 页\r\n原文省略…' }, { reply: '待核实的证据 📝' }, { reply: '' }];
  const run = { workflow, task: '整理审校结果', rows };
  const prompt = workflowStagePrompt(run, 2, 'p');
  assert.match(prompt, /整理审校结果[\s\S]*执行 join[\s\S]*以任务和当前步骤指令确定本阶段的交付。先给出结论和证据位置，再列出待确认事项/u);
  assert.match(prompt, /若证据缺失、冲突或在本次交接中截断，请说明缺口并完成已有证据支持的部分/u);
  assert.match(prompt, /（引用资料）\n> 证据：草稿第 1 页\r\n> 原文省略…[\s\S]*（引用资料）\n> 待核实的证据 📝$/u);
  assert.doesNotMatch(prompt, /（本次截断）/u);

  const exactPlugin = 'p'.repeat(8192 - prompt.length + 1);
  const exact = workflowStagePrompt(run, 2, exactPlugin);
  assert.equal(exact.length, 8192);
  assert.doesNotMatch(exact, /（本次截断）/u);
  const clipped = workflowStagePrompt(run, 2, `${exactPlugin}p`);
  assert.ok(clipped.length <= 8192);
  assert.match(clipped, /「source」\(source\) 的回复（本次截断）[\s\S]*「review」\(review\) 的回复（引用资料）/u);
  assert.doesNotMatch(clipped, /[\uD800-\uDFFF]/u);

  const missing = workflowStagePrompt({ ...run, rows: [rows[0], { reply: '' }, rows[2]] }, 2);
  assert.match(missing, /「review」\(review\) 的回复（没有回复）\n$/u);
  assert.doesNotMatch(missing, /（本次截断）/u);
});

test('the exact DAG schema rejects ambiguous legacy records, invalid endpoints, duplicates and cycles', () => {
  const g = graph(['join', 'left', 'right'], [['right', 'join'], ['left', 'join']]);
  assert.deepEqual(validateWorkflowDraft(g), g);
  assert.deepEqual(validateWorkflowEdges(g.stages.map(({ id }) => ({ id })), []), []);
  assert.deepEqual(linearWorkflowEdges(g.stages), [{ from: 'join', to: 'left' }, { from: 'left', to: 'right' }]);
  assert.throws(() => validateWorkflowDraft({ name: g.name, stages: g.stages }));
  assert.throws(() => validateWorkflowDraft({ ...draft, edges: [] }));
  for (const [from, to] of [['right', 'join'], ['join', 'right'], ['right', 'right'], ['missing', 'join']]) {
    assert.throws(() => validateWorkflowEdges(g.stages, [...g.edges, { from, to }]));
  }
  for (const invalid of ['left', '-abc', 'step 1', '', 'a'.repeat(41), '编号']) {
    assert.throws(() => validateWorkflowEdges([{ id: 'left' }, { id: invalid }], []));
  }
  assert.throws(() => validateWorkflowEdges(g.stages, [{ from: 'right', to: 'left', extra: true }]));
  assert.throws(() => readWorkflowProposal(fence({ ...g, name: 'x'.repeat(8193) })), /过长/);
});

test('forks dispatch simultaneously, release capacity independently, and join uses only the labeled direct parents', async () => {
  const g = graph(['join', 'left', 'right', 'root', 'leaf'], [
    ['root', 'left'], ['root', 'right'], ['left', 'join'], ['right', 'join'], ['left', 'leaf'],
  ]);
  const gates = new Map(), seen = [], prompts = new Map();
  let active = 0, peak = 0;
  const f = fixture({ async rpc(op, p) {
    const idx = readWorkflowRun(f.raw).rows.findIndex((r) => r.turnId === p.turnId && r.state === 'submitted');
    const id = g.stages[idx].id;
    assert.equal(op, 'send');
    active++;
    peak = Math.max(active, peak);
    seen.push(id);
    prompts.set(id, p.prompt);
    if (id === 'left' || id === 'right') {
      const gate = Promise.withResolvers();
      gates.set(id, gate);
      await gate.promise;
    }
    active--;
    const result = id === 'root' ? 'ROOT_ONLY' : id === 'left' ? 'L'.repeat(8192) : 'R'.repeat(8192);
    return replyFor(p, 'complete', result);
  } });
  const starting = f.runner.start(g, '原始任务');
  await until(() => gates.size === 2);
  assert.deepEqual(seen, ['root', 'left', 'right']);
  gates.get('left').resolve();
  await until(() => seen.includes('leaf'));
  assert.ok(!seen.includes('join'));
  gates.get('right').resolve();
  await starting;
  assert.equal(peak, 2);
  assert.equal(readWorkflowRun(f.raw).phase, 'complete');
  const join = prompts.get('join');
  assert.match(join, /原始任务[\s\S]*执行 join/);
  assert.match(join, /「left」[\s\S]*L{3300,}…/);
  assert.match(join, /「right」[\s\S]*R{3300,}…/);
  assert.ok(!join.includes('ROOT_ONLY'));
  assert.equal(join.length, 8192);
});

test('failure skips only descendants and an independent branch can still finish', async () => {
  const g = graph(['join', 'bad', 'good', 'deeper', 'last'], [
    ['bad', 'join'], ['good', 'join'], ['join', 'deeper'], ['good', 'last'],
  ]);
  const f = fixture({ async rpc(op, p) {
    return replyFor(p, p.prompt.includes('执行 bad') ? 'failed' : 'complete', '');
  } });
  await f.runner.start(g, '任务');
  const result = readWorkflowRun(f.raw);
  assert.deepEqual(result.rows.map((row) => row.state), ['skipped', 'failed', 'complete', 'skipped', 'complete']);
  assert.equal(result.phase, 'failed');
  assert.equal(f.calls.length, 3);
});

test('valid v1 snapshots migrate in place by original binding, while canceled runs remain disarmed', () => {
  for (const [phase, state, expectedPhase, stopped] of [
    ['paused', 'unknown', 'paused', false], ['running', 'submitted', 'running', false],
    ['paused', 'canceling', 'paused', true], ['paused', 'stopping', 'paused', true],
    ['stopped', 'complete', 'stopped', true], ['failed', 'failed', 'failed', false],
  ]) {
    const rows = draft.stages.map((s, i) => ({ targetId: target(s.provider), sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(), state: i === 0 ? state : 'waiting', reply: '' }));
    const raw = JSON.stringify({ version: 1, id, workflow: draft, task: '任务', phase, rows, message: '' });
    const migrated = readWorkflowRun(raw);
    assert.deepEqual(migrated.workflow, canonical);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.phase, expectedPhase);
    assert.equal(migrated.stopRequested, stopped);
    assert.deepEqual(migrated.rows[0], rows[0]);
    assert.equal(migrated.rows[1].state, stopped || phase === 'failed' ? 'skipped' : 'waiting');
    assert.deepEqual(readWorkflowRun(JSON.stringify(migrated)), migrated);
    assert.deepEqual(fixture({ raw }).calls, []);
  }
});

const parallelJoin = graph(['a', 'b', 'join'], [['a', 'join'], ['b', 'join']]);

test('a second intent write failure aborts its sibling observation and suppresses unjournaled sends', async () => {
  const submitted = Promise.withResolvers();
  const f = fixture({
    async persist(next) {
      if (next.rows[1].state === 'submitted') {
        await submitted.promise;
        return false;
      }
    },
    rpc() {
      submitted.resolve();
      return new Promise(() => {});
    },
  });
  await assert.rejects(f.runner.start(parallelJoin, '任务'), /无法保存/);
  assert.equal(f.calls.length, 1);
  const durable = readWorkflowRun(f.raw);
  assert.deepEqual(durable.rows.map((r) => r.state), ['submitted', 'waiting', 'waiting']);
  assert.equal(durable.rows[0].turnId, f.calls[0].turnId);
  assert.equal(f.view.run.phase, 'paused');
  assert.equal(f.view.busy, false);
});

test('two uncertain sends reserve both slots, including across a restart with another independent root', async () => {
  const roots = graph(['a', 'b', 'c'], []);
  const f = fixture({ async rpc() { throw new Error('transport'); } });
  await f.runner.start(roots, '任务');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(readWorkflowRun(f.raw).rows.map((row) => row.state), ['unknown', 'unknown', 'waiting']);
  const resumed = fixture({ raw: f.raw, async rpc() { throw new Error('still offline'); } });
  await resumed.runner.resume();
  assert.deepEqual(resumed.calls.map((call) => call.op), ['get', 'get']);
  assert.deepEqual(readWorkflowRun(resumed.raw).rows.map((row) => row.state), ['unknown', 'unknown', 'waiting']);
});

async function interruptedPair() {
  const f = fixture({ rpc: () => new Promise(() => {}) });
  const starting = f.runner.start(parallelJoin, '任务');
  await until(() => f.calls.length === 2);
  f.runner.dispose();
  await starting;
  assert.equal(new Set(f.calls.map((p) => p.turnId)).size, 2);
  assert.equal(new Set(f.calls.map((p) => p.sessionId)).size, 2);
  return { raw: f.raw, originals: f.calls };
}

test('restart concurrently reconciles each original, refreshes matching stale receipts, and never resends either parent', async () => {
  const { raw, originals } = await interruptedPair();
  const gate = Promise.withResolvers();
  let secondKnown = false;
  const f = fixture({ raw, async rpc(op, p) {
    const original = originals.find((r) => r.sessionId === p.sessionId);
    if (op === 'send') return replyFor(p, 'complete', 'done');
    if (op === 'get') {
      await gate.promise;
      return replyFor(original, original === originals[0] ? 'running' : 'unknown', '');
    }
    return replyFor(original, original === originals[0] || secondKnown ? 'complete' : 'unknown', '');
  } });
  assert.deepEqual(f.calls, []);
  const resuming = f.runner.resume();
  await until(() => f.calls.length === 2);
  assert.deepEqual(f.calls.map((p) => [p.op, p.targetId, p.sessionId]), originals.map((p) => ['get', p.targetId, p.sessionId]));
  gate.resolve();
  await resuming;
  assert.deepEqual(readWorkflowRun(f.raw).rows.map((r) => r.state), ['complete', 'unknown', 'waiting']);
  assert.deepEqual(f.calls.map((c) => c.op), ['get', 'get', 'refresh', 'refresh']);
  await assert.rejects(f.runner.start(draft, '新的任务'), /尚未结束/);
  secondKnown = true;
  await f.runner.resume();
  assert.equal(readWorkflowRun(f.raw).phase, 'complete');
  const sent = f.calls.filter((call) => call.op === 'send');
  assert.equal(sent.length, 1);
  assert.ok(originals.every((r) => r.turnId !== sent[0].turnId));
});

test('stop disarms the entire graph before lookup and tracks each original stop receipt across restart', async () => {
  const { raw, originals } = await interruptedPair();
  const gate = Promise.withResolvers();
  const lookups = [];
  const f = fixture({ raw, async resolveRoute(provider) {
    lookups.push(readWorkflowRun(f.raw));
    await gate.promise;
    return { settings: { provider }, targetId: target(provider) };
  }, async rpc(op, p) {
    const original = originals.find((r) => r.sessionId === p.sessionId);
    if (op === 'stop') return { outcome: 'requested' };
    return replyFor(original, original === originals[0] ? 'stopped' : 'unknown', '');
  } });
  const stopping = f.runner.stop();
  await until(() => lookups.length === 2);
  for (const snapshot of lookups) {
    assert.equal(snapshot.stopRequested, true);
    assert.deepEqual(snapshot.rows.map((row) => row.state), ['canceling', 'canceling', 'skipped']);
  }
  gate.resolve();
  await stopping;
  assert.deepEqual(f.calls.filter((c) => c.op === 'stop').map((c) => c.turnId), originals.map((c) => c.turnId));
  assert.deepEqual(readWorkflowRun(f.raw).rows.map((r) => r.state), ['stopped', 'stopping', 'skipped']);
  const resumed = fixture({ raw: f.raw, async rpc() { return replyFor(originals[1], 'complete', '完成于停止请求之前'); } });
  await resumed.runner.resume();
  assert.equal(readWorkflowRun(resumed.raw).phase, 'stopped');
  assert.deepEqual(resumed.calls.map((c) => [c.op, c.sessionId]), [['refresh', originals[1].sessionId]]);
});

test('a definite desktop access rejection leaves stop retryable on the original branch receipts', async () => {
  const { raw, originals } = await interruptedPair();
  let allowed = false;
  const f = fixture({ raw, async rpc(op, payload) {
    if (op === 'stop' && !allowed) throw Object.assign(new Error('工作台处于仅浏览模式。'), { code: 'workbench_browse_only' });
    if (op === 'stop') return { outcome: 'requested' };
    assert.equal(op, 'refresh');
    return replyFor(originals.find(({ sessionId }) => sessionId === payload.sessionId), 'stopped', '');
  } });
  await f.runner.stop();
  const paused = readWorkflowRun(f.raw);
  assert.equal(paused.stopRequested, true);
  assert.deepEqual(paused.rows.map(({ state }) => state), ['canceling', 'canceling', 'skipped']);
  assert.ok(f.calls.every(({ op }) => op === 'stop'));
  allowed = true;
  const count = f.calls.length;
  await f.runner.stop();
  assert.equal(readWorkflowRun(f.raw).phase, 'stopped');
  assert.deepEqual(f.calls.slice(count).filter(({ op }) => op === 'stop').map(({ turnId }) => turnId).sort(),
    originals.map(({ turnId }) => turnId).sort());
});
