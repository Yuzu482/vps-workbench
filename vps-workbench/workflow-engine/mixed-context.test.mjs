import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkflowChange, createWorkflowEditPrompt, mixedWorkflowRunKey, preserveWorkflowAgents,
  readWorkflowProposal, readWorkflows, validateWorkflowDraft, workflowRunKey, localWorkflowRunKey } from './state.mjs';
import { createWorkflowRunner, readWorkflowRun, validateMixedInput, workflowStagePrompt } from './runner.mjs';
import { simulateMixedWorkflow } from './mixed-preview.mjs';

const workId = 'ab4a55d8-bbbd-4c5f-91be-ac93a4a4173b';
const local = { location: 'local-sdk', configId: 'fa70cd1d-a8c0-4c62-8fdc-86ec87d8af0a', context: 'independent' };
const ssh = { location: 'ssh-vps', configId: 'b'.repeat(64), context: 'independent' };
const blind = { ...ssh, context: 'blind' };
const pinFor = ({ execution }) => execution.location === 'local-sdk' ? '0'.repeat(64) : 'f'.repeat(64);
const stage = (id, execution) => ({ id, name: id, provider: 'codex', model: '', instruction: '完成本步骤。', execution });
const edge = (from, to) => ({ from, to });
const transfer = (from, to, fields) => ({ from, to, fields });
const evidence = { id: 'reference-A', text: '盲审专用的用户证据。', stageId: 'blind' };
const reply = JSON.stringify({ conclusion: '已完成核对。', evidence: '证据编号 XYZ', pending: '待核对的内部描述' });
const pair = { name: '本机和 VPS', stages: [stage('source', local), stage('next', ssh)], edges: [edge('source', 'next')] };
const confirmed = (workflow, transfers, evidence = []) => ({
  revision: 1, definitionPin: '0'.repeat(64), criteria: '依据可复核。', constraints: '', evidence, transfers,
  routePins: workflow.stages.map(pinFor),
});

function harness(rpc, initialRun = null) {
  let run = initialRun;
  const routeChecks = [];
  let changed = false;
  const runner = createWorkflowRunner({
    initialRun,
    async resolveRoute(provider, signal, options) {
      routeChecks.push(options);
      return { targetId: options.stage.execution.location === 'local-sdk' ? 'a'.repeat(64) : 'c'.repeat(64),
        settings: { provider }, routePin: changed ? '1'.repeat(64) : pinFor(options.stage) };
    },
    rpc,
    persist(next) { run = readWorkflowRun(JSON.stringify(next)); },
    onChange() {},
  });
  return { runner, routeChecks, get run() { return run; }, changeRoute() { changed = true; } };
}

const receipt = (payload, state, reply, turnId = payload.turnId, extras = {}) => ({
  session: { id: payload.sessionId, turns: [{ id: turnId, state, reply, ...extras }] },
});

test('offline simulation applies the real prompt rules without binding receipts or mutation', () => {
  const workflow = { ...pair, stages: [pair.stages[0], stage('blind', blind), pair.stages[1]],
    edges: [edge('source', 'blind'), edge('source', 'next'), edge('blind', 'next')] };
  const input = { revision: 1, task: '写出活动说明。', criteria: '保留报名条件。', constraints: '',
    evidence: [evidence], transfers: [transfer('source', 'next', ['conclusion'])] };
  const before = structuredClone({ workflow, input });
  const { run, prompts } = simulateMixedWorkflow(workflow, input);
  assert.deepEqual({ workflow, input }, before);
  assert.ok(run.rows.every((row) => !Object.hasOwn(row, 'turnId')));
  assert.ok(prompts.every((text) => text.includes(input.task)));
  assert.match(prompts[1], /盲审专用的用户证据/u);
  assert.doesNotMatch(prompts[1], /模拟阶段 1 的结论|\/attachments/u);
  assert.match(prompts[2], /模拟阶段 1 的结论/u);
  assert.match(prompts[2], /模拟阶段 2 的结论/u);
  assert.doesNotMatch(prompts[2], /模拟阶段 1 的证据|盲审专用的用户证据/u);
  assert.throws(() => simulateMixedWorkflow(workflow, { ...input, transfers: [] }), /确认跨配置/u);
  assert.throws(() => simulateMixedWorkflow(workflow, { ...input,
    evidence: [{ ...evidence, text: '资料保存在 /home/private 文件中。' }] }), /敏感内容/u);
});

test('execution metadata roundtrips and stays out of model proposals and references', () => {
  const entries = applyWorkflowChange([], { op: 'save', id: workId, revision: null, draft: pair });
  assert.deepEqual(readWorkflows(JSON.stringify(entries)), [{ id: workId, revision: 1, ...pair }]);
  assert.equal(new Set([mixedWorkflowRunKey, workflowRunKey, localWorkflowRunKey]).size, 3);
  assert.throws(() => validateWorkflowDraft({ ...pair, stages: [stage('source', { ...ssh, configId: ssh.configId.toUpperCase() })] }),
    /执行位置、配置或上下文无效/u);
  assert.throws(() => validateWorkflowDraft({ name: '盲审', edges: [], stages: [{
    ...stage('blind', blind), agent: { memory: 'shared', mcpServers: [], plugins: [] },
  }] }), /盲审.*移除/u);
  const marker = String.fromCharCode(96).repeat(3);
  const proposal = (value) => [marker + 'vps-workflow', JSON.stringify(value), marker].join('\n');
  assert.throws(() => readWorkflowProposal(proposal(pair)), /字段或服务商无效/u);
  assert.doesNotMatch(createWorkflowEditPrompt('补充校验', pair), /local-sdk|ssh-vps|configId|independent/u);
  const withoutExecution = { ...pair, stages: pair.stages.map(({ execution, ...stage }) => stage) };
  assert.deepEqual(preserveWorkflowAgents(pair, readWorkflowProposal(proposal(withoutExecution))), pair);
});

test('mixed confirmation covers exactly the routing boundaries and blind input slots', () => {
  const differentLocalConfig = { ...local, configId: workId };
  const workflow = {
    name: '不同配置和盲审',
    stages: [stage('source', local), stage('local', differentLocalConfig), stage('next', ssh), stage('blind', blind)],
    edges: [edge('source', 'local'), edge('local', 'next'), edge('source', 'blind')],
  };
  const input = confirmed(workflow, [
    transfer('local', 'next', ['pending', 'evidence']),
    transfer('source', 'local', []),
  ], [evidence]);
  assert.deepEqual(validateMixedInput(workflow, input).transfers, [
    transfer('source', 'local', []), transfer('local', 'next', ['evidence', 'pending']),
  ]);
  for (const invalid of [
    { transfers: [] },
    { transfers: [input.transfers[0], transfer('source', 'blind', [])] },
    { transfers: [input.transfers[0], input.transfers[0]] },
    { transfers: [input.transfers[0], transfer('source', 'local', ['evidence', 'evidence'])] },
    { transfers: [input.transfers[0], transfer('source', 'local', ['rawReply'])] },
    { evidence: [] },
    { evidence: [{ ...evidence, stageId: 'next' }] },
    { evidence: [{ ...evidence, text: 'C:\\Users\\work\\private.txt' }] },
    { evidence: [{ ...evidence, text: '请使用 https://192.168.4.10/dashboard' }] },
    { criteria: '' },
    { criteria: 'OPENAI_API_KEY=example-secret-value' },
    { constraints: '证据在 /srv/hidden/results.csv' },
    { routePins: ['F'.repeat(64), ...input.routePins.slice(1)] },
    { extra: true },
  ]) assert.throws(() => validateMixedInput(workflow, { ...input, ...invalid }));
});

test('exact approved fields cross configurations while blind receives only scoped user evidence', async () => {
  const workflow = { ...pair, stages: [...pair.stages, stage('blind', blind)], edges: [...pair.edges, edge('source', 'blind')] };
  const requests = [];
  const h = harness((op, payload) => {
    assert.equal(op, 'send');
    requests.push(payload);
    return receipt(payload, 'complete', requests.length === 1 ? reply : '完成');
  });
  await h.runner.start(workflow, '核对任务', null, null, workId,
    confirmed(workflow, [transfer('source', 'next', ['evidence'])], [evidence]));
  assert.equal(h.run.version, 5);
  assert.equal(h.run.phase, 'complete');
  assert.equal(requests.length, 3);
  assert.match(requests[0].prompt, /交接格式.*conclusion、evidence、pending/u);
  const recipient = requests.find(({ prompt }) => prompt.includes('跨配置交接'));
  assert.match(recipient.prompt, /证据编号 XYZ/u);
  assert.doesNotMatch(recipient.prompt, /已完成核对|待核对的内部描述|盲审专用/u);
  const reviewer = requests.find(({ prompt }) => prompt.includes('（盲审）'));
  assert.match(reviewer.prompt, /盲审专用的用户证据/u);
  assert.doesNotMatch(reviewer.prompt, /证据编号 XYZ|同一配置的前置步骤回复|跨配置交接/u);
  assert.ok(h.routeChecks.every(({ stage, routePin }) => routePin === pinFor(stage)));
});

test('dependency-only approval tolerates unstructured output and forwards nothing across the routes', async () => {
  const prompts = [];
  const h = harness((op, payload) => {
    assert.equal(op, 'send');
    prompts.push(payload.prompt);
    return receipt(payload, 'complete', '未经确认的原文');
  });
  await h.runner.start(pair, '核对任务', null, null, workId, confirmed(pair, [transfer('source', 'next', [])]));
  assert.equal(h.run.phase, 'complete');
  assert.doesNotMatch(prompts[0], /交接格式/u);
  assert.doesNotMatch(prompts[1], /未经确认的原文|跨配置交接/u);
  assert.throws(() => readWorkflowRun(JSON.stringify({ ...h.run, version: 4, mixed: undefined })), /运行记录无效/u);
});

test('malformed or sensitive handoff pauses before reserving the destination send', async () => {
  for (const untrusted of [
    '任意未结构化回复',
    '{"conclusion":"one","\\u0063onclusion":"two","evidence":"x","pending":"y"}',
    '{"conclusion":"one","evidence":"x","pending":"y","extra":"z"}',
    JSON.stringify({ conclusion: '证据可查', evidence: '路径 /home/user/private.txt', pending: '' }),
    JSON.stringify({ conclusion: '证据可查', evidence: 'token=example-secret', pending: '' }),
  ]) {
    let sends = 0;
    const h = harness((op, payload) => {
      assert.equal(op, 'send');
      sends++;
      return receipt(payload, 'complete', untrusted);
    });
    await h.runner.start(pair, '核对任务', null, null, workId, confirmed(pair, [transfer('source', 'next', ['evidence'])]));
    assert.equal(sends, 1);
    assert.equal(h.run.phase, 'paused');
    assert.equal(h.run.rows[1].state, 'waiting');
    assert.match(h.run.message, /交接.*(?:JSON 对象|疑似凭据或内部路径)/u);
    assert.doesNotMatch(h.run.message, /\/home\/user|example-secret/u);
  }
});

test('mixed route change refuses to query or stop the original receipt on a different pin', async () => {
  let original;
  const h = harness((op, payload) => {
    assert.equal(op, 'send');
    original = payload;
    throw new Error('connection failed after send');
  });
  const input = confirmed(pair, [transfer('source', 'next', ['conclusion'])]);
  await assert.rejects(h.runner.start(pair, '核对任务', null, null, workId), /入口/u);
  await assert.rejects(h.runner.start(pair, '资料在 /tmp/private/report', null, null, workId, input), /内部路径/u);
  await h.runner.start(pair, '核对任务', null, null, workId, input);
  assert.equal(h.run.phase, 'paused');
  assert.equal(h.run.rows[0].state, 'unknown');
  h.changeRoute();
  await h.runner.resume();
  assert.equal(h.run.phase, 'paused');
  assert.match(h.run.message, /连接已变更/u);
  await h.runner.stop();
  assert.equal(h.run.phase, 'paused');
  assert.equal(h.run.stopRequested, true);
  const resumed = harness((op, payload) => {
    assert.equal(payload.sessionId, original.sessionId);
    if (op === 'stop') {
      assert.equal(payload.turnId, original.turnId);
      return { outcome: 'settled' };
    }
    assert.equal(op, 'refresh');
    return receipt(payload, 'stopped', '', original.turnId);
  }, h.run);
  await resumed.runner.stop();
  assert.equal(resumed.run.phase, 'stopped');
  assert.ok(resumed.routeChecks.every(({ dispatch, pinned, stage, routePin }) =>
    !dispatch && pinned === original.targetId && routePin === pinFor(stage)));
});

test('confirmed preflight may retry original IDs, but bound rate-limit receipt never resends', async () => {
  let original;
  const operations = [];
  const h = harness((op, payload) => {
    operations.push(op);
    if (operations.length === 1) {
      original = payload;
      throw Object.assign(new Error('请检查账号与 VPS 出口。'), { code: 'mixed_preflight' });
    }
    assert.equal(payload.sessionId, original.sessionId);
    return receipt(payload, 'failed', '', original.turnId, { errorCode: 'rate_limited' });
  });
  await h.runner.start(pair, '核对任务', null, null, workId, confirmed(pair, [transfer('source', 'next', [])]));
  assert.equal(h.run.rows[0].state, 'waiting');
  await h.runner.resume();
  assert.equal(h.run.rows[0].state, 'unknown');
  assert.match(h.run.message, /速率限制/u);
  await h.runner.resume();
  assert.deepEqual(operations, ['send', 'send', 'get']);
  assert.equal(h.run.rows[0].turnId, original.turnId);
});

test('host-side prompt reconstruction also excludes plugin instructions and attachments hints from blind stages', () => {
  const workflow = { name: '盲审', stages: [stage('blind', blind)], edges: [] };
  const mixed = validateMixedInput(workflow, confirmed(workflow, [], [evidence]));
  const prompt = workflowStagePrompt({ version: 5, workflow, task: '核对任务', rows: [{}], mixed }, 0, 'HOST_PLUGIN', true);
  assert.match(prompt, /盲审专用/u);
  assert.doesNotMatch(prompt, /HOST_PLUGIN|\/attachments/u);
});

test('mixed handoffs share the prompt budget while preserving source IDs and marking clipped fields', () => {
  const workflow = {
    name: '汇合',
    stages: ['a', 'b', 'c'].map((id) => stage(id, local)).concat([stage('local', ssh), stage('join', ssh)]),
    edges: ['a', 'b', 'c', 'local'].map((id) => edge(id, 'join')),
  };
  const fields = ['conclusion', 'evidence', 'pending'];
  const mixed = validateMixedInput(workflow, confirmed(workflow, ['a', 'b', 'c'].map((id) => transfer(id, 'join', fields))));
  const long = JSON.stringify({ conclusion: '据'.repeat(1200), evidence: '文'.repeat(1200), pending: '待核对' });
  const rows = [{ reply: long }, { reply: long }, { reply: long }, { reply: '已经核验本配置记录' }, { reply: '' }];
  const run = { version: 5, workflow, task: '查'.repeat(4000), rows, mixed };
  const prompt = workflowStagePrompt(run, 4);
  assert.ok(prompt.length <= 8192);
  for (const id of ['a', 'b', 'c']) {
    assert.match(prompt, new RegExp(id + ' · evidence\n（本次截断）', 'u'));
    assert.match(prompt, new RegExp(id + ' · pending\n（引用资料）\n> 待核对', 'u'));
  }
  assert.match(prompt, /同一配置的前置步骤回复（local）\n（引用资料）\n> 已经核验本配置记录/u);
  rows[3].reply = '内部资料在 C:\\private\\audit.txt';
  assert.throws(() => workflowStagePrompt(run, 4), (error) => {
    assert.match(error.message, /同一配置.*疑似凭据或内部路径/u);
    assert.doesNotMatch(error.message, /audit\.txt/u);
    return true;
  });
});
