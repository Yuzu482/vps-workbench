import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { startWorkbenchServer } from './server.mjs';
import { openAppData, memoryJournalKey } from './data.mjs';
import { localMemoryJournalKey } from '../local-sdk/workbench.mjs';
import { setupConnectionKey } from './setup-state.mjs';
import { localWorkflowRunKey, mixedWorkflowHistoryKey, mixedWorkflowRunKey, workflowRunKey } from '../workflow-engine/state.mjs';
import { openMixedWorkflow } from './mixed-workflow.mjs';

async function until(lookup) {
  for (let i = 0; i < 150; i++) {
    const value = await lookup();
    if (value) return value;
    await delay(75);
  }
  assert.fail('Expected the mixed workflow to reach a settled or paused state');
}

test('desktop dispatches mixed stages with separate accounts, reviews only supplied evidence and reconciles after restart',
  { timeout: 25_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-mixed-'));
    const conversations = join(root, 'conversations');
    const working = join(root, 'local-work');
    await mkdir(conversations);
    await mkdir(working);
    const fixture = createPreviewFixtures();
    const { settings, targetId, memoryTargetId } = fixture.chat({ op: 'preset' }).preset;
    const data = await openAppData(root);
    await data.setPreference(setupConnectionKey, JSON.stringify({ settings, targetId }));
    const localSent = [];
    const remoteSent = [];
    const reads = [];
    const sessions = new Map();
    let loseReviewReply = true;
    let egress = false;
    let mode = 'execute';
    let app;
    t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
    const localModel = { id: 'fixture-local', label: 'Fixture local', efforts: ['low'], defaultEffort: 'low' };
    function start() {
      return startWorkbenchServer({ webRoot: root, workbenchRoot: conversations, terminalRoot: root, runtimeRoot: root,
        localStateRoot: join(root, 'local'), localApiKey: 'fixture-only', data, access: () => ({ mode, workspace: 'default' }),
        makeLocalAgentRuntime: async () => { throw new Error('not used'); },
        makeLocalRuntime: async ({ apiKey }) => ({ runtimeAvailable: true, credentialConfigured: () => true, models: [localModel],
          createThread(profile, previous) {
            return { async runStreamed(input) {
              assert.equal(apiKey, 'fixture-only');
              assert.equal(previous ?? null, null);
              localSent.push({ input, profile });
              return { events: (async function* () {
                yield { type: 'thread.started', thread_id: randomUUID() };
                yield { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: JSON.stringify({
                  conclusion: 'DRAFT-RESULT', evidence: 'PRIVATE-TO-DRAFT', pending: 'DRAFT-PENDING',
                }) } };
                yield { type: 'turn.completed', usage: {} };
              })() };
            } };
          } }),
        makeBridge: () => ({ request(packet, options) {
          if (packet.op === 'setup-check' && packet.kind === 'model' && !egress) return { ok: false, code: 'setup_model_route' };
          if (packet.op === 'send') {
            remoteSent.push({ packet, options });
            const turn = { id: packet.turnId, state: 'complete', reply: remoteSent.length === 1 ? 'VPS-BLIND-RESULT' : 'SUMMARY' };
            const response = { ok: true, targetId: packet.targetId, session: { id: packet.sessionId, turns: [turn] } };
            sessions.set(packet.sessionId, response);
            if (loseReviewReply) {
              loseReviewReply = false;
              return { ok: false, code: 'bridge_uncertain' };
            }
            return response;
          }
          if (packet.op === 'workflow-artifacts') return { ok: true, files: [{ path: 'brief.txt', size: 7 }], truncated: false };
          if (['get', 'refresh'].includes(packet.op)) {
            reads.push(packet);
            return sessions.get(packet.sessionId);
          }
          return fixture.chat(packet);
        } }),
      });
    }
    app = await start();
    const request = (op, fields) => app.requestMixedWorkflow({ op, ...fields });
    const { profile } = await app.registerLocalProfile({ name: 'Local fixture', directory: working, model: localModel.id, effort: 'low' });
    const id = randomUUID();
    const stages = [
      { id: 'draft', name: '起草', provider: 'codex', model: '', instruction: '起草说明。',
        execution: { location: 'local-sdk', configId: profile.id, context: 'independent' } },
      { id: 'review', name: '审校', provider: 'codex', model: '', instruction: '只凭证据核对。',
        execution: { location: 'ssh-vps', configId: memoryTargetId, context: 'blind' } },
      { id: 'join', name: '汇总', provider: 'codex', model: '', instruction: '汇总两份结果。',
        execution: { location: 'ssh-vps', configId: memoryTargetId, context: 'independent' } },
    ];
    const edges = [{ from: 'draft', to: 'join' }, { from: 'review', to: 'join' }];
    await data.changeWorkflows({ op: 'save', id, revision: null, draft: { name: '混合验收', stages, edges } });
    assert.deepEqual((await request('targets')).targets.map(({ id: target }) => target), [profile.id, memoryTargetId]);
    const input = { workflowId: id, revision: 1, task: 'BRIEF-BASE', criteria: 'BRIEF-CRITERIA', constraints: 'BRIEF-LIMITS',
      evidence: [{ stageId: 'review', id: 'review-evidence', text: 'BLIND-SOURCE-EVIDENCE' }],
      transfers: [{ from: 'draft', to: 'join', fields: ['conclusion'] }] };
    mode = 'browse';
    assert.equal((await request('start', { input })).code, 'workbench_browse_only');
    mode = 'execute';
    assert.equal((await request('start', { input: { ...input, transfers: [] } })).ok, false);
    assert.equal((await request('start', { input })).ok, true);
    const snapshot = async (phase) => { const status = await request('status'); return !status.running && status.run?.phase === phase && status.run; };
    const preflight = await until(() => snapshot('paused'));
    assert.equal(preflight.rows[1].state, 'waiting');
    assert.equal(remoteSent.length, 0);
    assert.equal(localSent.length, 1, JSON.stringify(preflight.rows.map(({ state, reply }) => ({ state, reply }))));

    const forged = { ...preflight, phase: 'running', rows: preflight.rows.map((row, index) => ({ ...row,
      state: index === 2 ? 'waiting' : 'submitted', reply: '', sessionId: randomUUID(), turnId: randomUUID() })) };
    const legacyPayload = (index, routeSettings) => ({ op: 'send', settings: routeSettings, prompt: 'legacy fixture',
      model: forged.workflow.stages[index].model, workflowStage: { runId: forged.id },
      targetId: forged.rows[index].targetId, turnId: forged.rows[index].turnId, sessionId: forged.rows[index].sessionId });
    await data.setPreference(localWorkflowRunKey, JSON.stringify(forged));
    await data.setPreference(workflowRunKey, JSON.stringify(forged));
    const localRoute = { location: 'local-sdk', provider: 'codex', profileId: profile.id };
    assert.equal((await app.requestLocal({ location: 'local-sdk', backend: 'codex', op: 'workbench',
      payload: legacyPayload(0, localRoute) })).code, 'workflow_stage_changed');
    const headers = { Cookie: `${app.cookie.name}=${app.cookie.value}`, 'X-DSH-VPS-CHAT': '1', 'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json' };
    const { token } = await (await fetch(app.origin + '/dsh-vps-chat/api/token', { headers })).json();
    headers['X-DSH-VPS-CHAT-Token'] = token;
    const legacyResponse = await fetch(app.origin + '/dsh-vps-chat/api/rpc', { method: 'POST', headers,
      body: JSON.stringify(legacyPayload(1, settings)) });
    assert.equal((await legacyResponse.json()).code, 'workflow_stage_changed');
    await data.setPreference(localWorkflowRunKey, null);
    await data.setPreference(workflowRunKey, null);

    egress = true;
    assert.equal((await request('resume')).ok, true);
    const uncertain = await until(() => snapshot('paused'));
    assert.equal(uncertain.rows[1].state, 'unknown');
    assert.equal(remoteSent.length, 1);
    assert.match(remoteSent[0].packet.prompt, /BLIND-SOURCE-EVIDENCE/u);
    assert.doesNotMatch(remoteSent[0].packet.prompt, /DRAFT-RESULT|PRIVATE-TO-DRAFT/u);
    await app.close();
    app = await start();
    assert.equal((await request('status')).run.rows[1].turnId, uncertain.rows[1].turnId);
    await data.changeWorkflows({ op: 'delete', id, revision: 1 });
    await data.changeWorkflows({ op: 'save', id, revision: null, draft: { name: '同 ID 新定义', stages, edges } });
    assert.equal((await request('resume')).ok, true);
    const changed = await until(() => snapshot('paused'));
    assert.equal(changed.rows[1].state, 'complete');
    assert.equal(changed.rows[2].state, 'waiting');
    assert.equal(remoteSent.length, 1);
    await data.changeWorkflows({ op: 'delete', id, revision: 1 });
    await data.changeWorkflows({ op: 'save', id, revision: null, draft: { name: '混合验收', stages, edges } });
    assert.equal((await request('resume')).ok, true);
    const done = await until(() => snapshot('complete'));
    assert.ok(reads.some(({ sessionId }) => sessionId === uncertain.rows[1].sessionId));
    assert.equal(remoteSent.length, 2);
    assert.equal(localSent.length, 1);
    assert.equal(done.rows[2].reply, 'SUMMARY');
    const brief = '固定任务说明\n' + JSON.stringify({ task: input.task, criteria: input.criteria, constraints: input.constraints });
    assert.ok(localSent[0].input.includes(brief));
    for (const { packet, options } of remoteSent) {
      assert.ok(packet.prompt.includes(brief));
      assert.deepEqual(packet.settings, settings);
      assert.equal(packet.memoryIsolation, true);
      assert.deepEqual(packet.workflowFiles, { paths: [], attachments: [] });
      assert.equal(options.pinnedRelay, 'null');
    }
    assert.match(remoteSent[1].packet.prompt, /DRAFT-RESULT/u);
    assert.match(remoteSent[1].packet.prompt, /VPS-BLIND-RESULT/u);
    assert.doesNotMatch(remoteSent[1].packet.prompt, /PRIVATE-TO-DRAFT|DRAFT-PENDING/u);
    assert.equal(data.preference(memoryJournalKey), undefined);
    assert.equal(data.preference(localMemoryJournalKey), undefined);
    assert.equal(JSON.parse(data.preference(mixedWorkflowRunKey)).phase, 'complete');
    const remoteFiles = await request('artifacts', { query: { runId: done.id, stageIndex: 2 } });
    assert.equal(remoteFiles.files[0].path, 'brief.txt');
    const localFiles = await request('artifacts', { query: { runId: done.id, stageIndex: 0 } });
    assert.equal(localFiles.files[0].path, '阶段结果.md');
  });

test('a route lost after reservation rejects before dispatch and can resume the same IDs', async (t) => {
  const workflowId = randomUUID();
  const configId = randomUUID();
  const targetId = '1'.repeat(64);
  const stages = [{ id: 'a', name: '核对', provider: 'codex', model: 'fixture', instruction: '核对。',
    execution: { location: 'local-sdk', configId, context: 'independent' } }];
  const preferences = new Map([['dsh-vps-chat:workflows:v1', JSON.stringify([{ id: workflowId, revision: 1,
    name: '原绑定', stages, edges: [] }])]]);
  let refuseFinalRoute = true;
  const dispatched = [];
  const route = { targetId, routePin: 'a'.repeat(64), defaultModel: 'fixture', isCurrent: () => true,
    settings: { location: 'local-sdk', provider: 'codex', profileId: configId } };
  const runtime = openMixedWorkflow({ data: { preference: (key) => preferences.get(key),
    async setPreference(key, value) { preferences.set(key, value); } }, canExecute: () => true, targets: () => [],
    resolve() {
      const previous = JSON.parse(preferences.get(mixedWorkflowRunKey) ?? 'null');
      if (refuseFinalRoute && previous?.rows[0].state === 'submitted') {
        refuseFinalRoute = false;
        return null;
      }
      return route;
    },
    catalog: () => [{ id: 'fixture' }],
    dispatch(op, body) {
      dispatched.push({ op, body });
      return { ok: true, session: { id: body.sessionId, turns: [{ id: body.turnId, state: 'complete', reply: '已核对' }] } };
    },
  });
  t.after(() => runtime.dispose());
  assert.equal((await runtime.start({ workflowId, revision: 1, task: '核对报名', criteria: '可重查',
    constraints: '', evidence: [], transfers: [] })).ok, true);
  const first = await until(() => { const status = runtime.status(); return !status.running && status.run?.phase === 'paused' && status.run; });
  assert.equal(first.rows[0].state, 'waiting');
  assert.equal(dispatched.length, 0);
  assert.equal((await runtime.retry(first.id, 0)).code, 'mixed_busy');
  assert.equal(runtime.action('resume').ok, true);
  await until(() => runtime.status().run?.phase === 'complete');
  assert.deepEqual(dispatched.map(({ op, body }) => [op, body.turnId]), [['send', first.rows[0].turnId]]);
});

test('archives are atomic and historical retries require the exact failed receipt and original route', { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-run-history-'));
  const data = await openAppData(root);
  const workflowId = randomUUID();
  const configId = randomUUID();
  const targetId = '1'.repeat(64);
  const stages = ['prepare', 'review', 'publish'].map((id) => ({ id, name: id, provider: 'codex', model: 'fixture',
    instruction: '处理此阶段。', execution: { location: 'local-sdk', configId, context: 'independent' } }));
  const edges = [{ from: 'prepare', to: 'review' }, { from: 'review', to: 'publish' }];
  await data.changeWorkflows({ op: 'save', id: workflowId, revision: null, draft: { name: '归档路径', stages, edges } });
  let rejectWrite = false;
  let changeRoute = false;
  let resultState = 'failed';
  let firstFailure;
  const sends = [];
  const artifacts = [];
  const receipts = new Map();
  const start = (storage) => openMixedWorkflow({ data: { ...storage, async setPreferences(changes) {
    if (rejectWrite) throw new Error('fixture write denied');
    return storage.setPreferences(changes);
  } }, canExecute: () => true, targets: () => [],
  resolve: () => ({ targetId, routePin: (changeRoute ? 'b' : 'a').repeat(64), defaultModel: 'fixture', isCurrent: () => true,
    settings: { location: 'local-sdk', provider: 'codex', profileId: configId } }),
  catalog: () => [{ id: 'fixture' }],
  dispatch(op, body, _route, options) {
    assert.equal(options.isLive(), true);
    const boundRun = options.workflowRun();
    if (op === 'workflow-artifacts') {
      artifacts.push({ runId: boundRun.id, turnId: body.turnId });
      return { ok: true, files: [{ path: '结果.md', size: 6 }], truncated: false };
    }
    if (op === 'get') {
      const payload = structuredClone(receipts.get(body.sessionId));
      if (payload.session.turns[0].id === firstFailure) payload.session.turns[0].state = resultState;
      return payload;
    }
    assert.equal(op, 'send');
    sends.push(body.turnId);
    const index = boundRun.rows.findIndex(({ turnId }) => turnId === body.turnId);
    const fail = index === 1 && !firstFailure;
    if (fail) firstFailure = body.turnId;
    const result = { ok: true, targetId, session: { id: body.sessionId, turns: [{ id: body.turnId,
      state: fail ? 'failed' : 'complete', reply: fail ? '阶段返回失败。' : '完成。', ...(fail && { code: 'fixture_failure' }) }] } };
    receipts.set(body.sessionId, result);
    return result;
  } });
  let runtime = start(data);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  const phase = (name) => until(() => {
    const status = runtime.status();
    return !status.running && status.run?.phase === name && status.run;
  });
  assert.equal((await runtime.start({ workflowId, revision: 1, task: '运行原任务', criteria: '核对所有阶段',
    constraints: '', evidence: [], transfers: [] })).ok, true);
  const original = await phase('failed');
  assert.deepEqual(original.rows.map(({ state }) => state), ['complete', 'failed', 'skipped']);
  resultState = 'unknown';
  assert.equal((await runtime.retry(original.id, 1)).code, 'mixed_retry_unconfirmed');
  resultState = 'failed';
  changeRoute = true;
  assert.equal((await runtime.retry(original.id, 1)).code, 'mixed_route_changed');
  changeRoute = false;
  rejectWrite = true;
  assert.equal((await runtime.retry(original.id, 1)).ok, true);
  await until(() => !runtime.status().running && runtime.status().error);
  assert.equal(runtime.status().run.id, original.id);
  assert.equal(data.preference(mixedWorkflowHistoryKey), undefined);
  assert.equal(sends.length, 2);
  rejectWrite = false;
  assert.equal((await runtime.retry(original.id, 1)).ok, true);
  const retried = await phase('complete');
  assert.notEqual(retried.id, original.id);
  assert.deepEqual(retried.rows[0], original.rows[0]);
  assert.notEqual(retried.rows[1].turnId, original.rows[1].turnId);
  assert.notEqual(retried.rows[2].turnId, original.rows[2].turnId);
  assert.equal(sends.length, 4);
  await runtime.dispose();
  runtime = start(await openAppData(root));
  assert.equal(runtime.status().run.id, retried.id);
  assert.deepEqual(runtime.history().entries.map(({ id }) => id), [original.id]);
  assert.deepEqual(runtime.detail(original.id).run, original);
  assert.equal((await runtime.artifacts({ runId: original.id, stageIndex: 0 })).ok, true);
  assert.deepEqual(artifacts, [{ runId: original.id, turnId: original.rows[0].turnId }]);
  assert.equal((await runtime.retry(original.id, 0)).code, 'mixed_retry_unconfirmed');
});

test('desktop scopes local workflow attachments to each node and recovers the original mixed receipt', { timeout: 25000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-mixed-text-'));
  const workspace = join(root, 'registered');
  await mkdir(workspace);
  const fixtures = createPreviewFixtures();
  const { settings, targetId, memoryTargetId } = fixtures.chat({ op: 'preset' }).preset;
  const data = await openAppData(root);
  await data.setPreference(setupConnectionKey, JSON.stringify({ settings, targetId }));
  const localInputs = new Map(), remoteInputs = [], remoteReceipts = new Map(), remoteReads = [];
  let overlapping = 0, peak = 0;
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const model = (id, effort) => ({ id, label: id, efforts: [effort], defaultEffort: effort });
  const adapter = (backend, models) => ({
    runtimeAvailable: true, credentialConfigured: () => true, models,
    createThread(profile, prior, { workspace: scope, interaction, mcpServers }) {
      assert.equal(prior ?? null, null);
      assert.equal(scope, 'private');
      assert.equal(interaction, undefined);
      assert.ok(!mcpServers?.length);
      return { async runStreamed(input) {
        assert.ok(!localInputs.has(backend));
        localInputs.set(backend, { input, profile });
        return { events: (async function* () {
          peak = Math.max(peak, ++overlapping);
          try {
            yield { type: 'thread.started', thread_id: randomUUID() };
            await delay(150);
            yield { type: 'item.completed', item: { type: 'agent_message', id: 'result', text: JSON.stringify({
              conclusion: backend + ' result', evidence: backend + ' private detail', pending: backend + ' pending',
            }) } };
            yield { type: 'turn.completed' };
          } finally { overlapping--; }
        })() };
      } };
    },
  });
  const start = () => startWorkbenchServer({ webRoot: root, workbenchRoot: root, terminalRoot: root, runtimeRoot: root,
    data, localStateRoot: join(root, 'sdk'), access: () => ({ mode: 'execute', workspace: 'default' }),
    makeLocalRuntime: async () => adapter('codex', [model('fixture-codex', 'low')]),
    makeLocalAgentRuntime: async ({ backend }) => adapter(backend, [model('default', 'default')]),
    makeBridge: () => ({ request(body) {
      if (body.op === 'send') {
        remoteInputs.push(body);
        if (body.prompt.includes('VPS-SOURCE-STAGE')) return { ok: true, targetId: body.targetId, session: { id: body.sessionId,
          turns: [{ id: body.turnId, state: 'complete', reply: JSON.stringify({
            conclusion: 'VPS-approved-conclusion', evidence: 'VPS-private-details', pending: '',
          }) }] } };
        remoteReceipts.set(body.sessionId, { ok: true, targetId: body.targetId, session: { id: body.sessionId,
          turns: [{ id: body.turnId, state: 'complete', reply: 'VPS summary' }] } });
        return { ok: false, code: 'bridge_uncertain' };
      }
      if (['refresh', 'get'].includes(body.op)) {
        remoteReads.push(body);
        return remoteReceipts.get(body.sessionId);
      }
      return fixtures.chat(body);
    } }),
  });
  app = await start();
  const request = (op, fields) => app.requestMixedWorkflow({ op, ...fields });
  const profiles = new Map();
  for (const backend of ['codex', 'claude-sdk', 'antigravity']) {
    const registered = await app.registerLocalProfile({ backend, name: backend, directory: workspace,
      model: backend === 'codex' ? 'fixture-codex' : 'default', effort: backend === 'codex' ? 'low' : 'default' });
    assert.equal(registered.ok, true);
    profiles.set(backend, registered.profile);
  }
  const stage = (id, provider, context = 'independent') => ({
    id, provider, name: id, model: '', instruction: '只处理本阶段简报。',
    execution: { location: profiles.has(provider) ? 'local-sdk' : 'ssh-vps',
      configId: profiles.get(provider)?.id ?? memoryTargetId, context },
  });
  const textFile = (name, contents) => ({ name, data: Buffer.from(contents).toString('base64') });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hJcAAAAASUVORK5CYII=';
  const [claudeRef, agyRef, imageRef] = await data.saveWorkflowAttachments([
    textFile('claude-only.txt', 'CLAUDE-ATTACHMENT-CONTENT'),
    textFile('agy-only.txt', 'AGY-ATTACHMENT-CONTENT'),
    { name: 'agy-image.png', data: png },
    textFile('unused.txt', 'UNAUTHORIZED-ATTACHMENT'),
  ]);
  const grant = (provider, attachments) => ({ targetId: profiles.get(provider).targetId, paths: [], attachments });
  const stages = [
    stage('draft', 'codex'),
    { ...stage('review', 'claude-sdk'), fileAccess: grant('claude-sdk', [claudeRef]) },
    { ...stage('audit', 'antigravity'), fileAccess: grant('antigravity', [agyRef, imageRef]) },
    { ...stage('summary', 'codex'), execution: { location: 'ssh-vps', configId: memoryTargetId, context: 'independent' } },
  ];
  const edges = [{ from: 'review', to: 'audit' }, ...stages.slice(0, 3).map(({ id: from }) => ({ from, to: 'summary' }))];
  const id = randomUUID();
  const save = (steps, revision = null) => data.changeWorkflows({ op: 'save', id, revision, draft: { name: '附件混合验收', stages: steps, edges } });
  for (const unsupported of [{ model: 'custom' }, { execution: { ...stages[1].execution, context: 'blind' } },
    { fileAccess: { ...stages[1].fileAccess, paths: ['workspace.txt'] } },
    { agent: { mcpServers: [], plugins: [], memory: 'shared' } }]) {
    await assert.rejects(async () => save(stages.map((step) => step.id === 'review' ? { ...step, ...unsupported } : step)),
      /单独授权的附件|为盲审/u);
  }
  await save(stages.map((step) => step.id === 'review' ? { ...step, fileAccess: grant('antigravity', [claudeRef]) } : step));
  const { targets } = await request('targets');
  for (const [backend, profile] of profiles) {
    assert.deepEqual(targets.find(({ id }) => id === profile.id).providers, [backend]);
  }
  const wrong = { ...stages[1], execution: { ...stages[1].execution, configId: profiles.get('antigravity').id } };
  assert.equal((await request('catalog', { stage: wrong })).ok, false);

  const input = { workflowId: id, revision: 1, task: 'COMMON-TASK', criteria: 'COMMON-CRITERIA', constraints: 'COMMON-LIMIT',
    evidence: [], transfers: [{ from: 'review', to: 'audit', fields: ['conclusion'] },
      ...stages.slice(0, 3).map(({ id: from }) => ({ from, to: 'summary', fields: ['conclusion'] }))] };
  assert.equal((await request('start', { input })).code, 'workflow_file_access_changed');
  assert.equal(localInputs.size + remoteInputs.length, 0);
  await save(stages, 1);
  input.revision = 2;
  const admission = await request('start', { input });
  assert.equal(admission.ok, true, JSON.stringify(admission));
  const settled = (phase) => until(async () => {
    const { run, running } = await request('status');
    return !running && run?.phase === phase && run;
  });
  const paused = await settled('paused');
  assert.deepEqual(paused.rows.map(({ state }) => state), ['complete', 'complete', 'complete', 'unknown']);
  assert.ok(peak >= 2);
  assert.equal(localInputs.size, 3);
  for (const [backend, { input: prompt, profile }] of localInputs) {
    assert.equal(profile.id, profiles.get(backend).id);
    const text = typeof prompt === 'string' ? prompt : prompt.map(({ text }) => text).filter(Boolean).join('\n');
    assert.match(text, /COMMON-TASK[\s\S]*COMMON-CRITERIA[\s\S]*COMMON-LIMIT/u);
    assert.doesNotMatch(text, /private detail|已启用的记忆|UNAUTHORIZED-ATTACHMENT/u);
  }
  const claudeInput = localInputs.get('claude-sdk').input;
  assert.deepEqual(claudeInput.slice(1).map(({ text }) => JSON.parse(text)), [
    { attachment: 'claude-only.txt', evidence: 'CLAUDE-ATTACHMENT-CONTENT' },
  ]);
  const agyInput = localInputs.get('antigravity').input;
  assert.match(agyInput[0].text, /claude-sdk result/u);
  assert.doesNotMatch(JSON.stringify(agyInput), /CLAUDE-ATTACHMENT-CONTENT|claude-only[.]txt/u);
  assert.deepEqual(JSON.parse(agyInput[1].text), { attachment: 'agy-only.txt', evidence: 'AGY-ATTACHMENT-CONTENT' });
  assert.equal(agyInput[3].type, 'raster');
  assert.equal(agyInput[3].bytes.toString('base64'), png);
  assert.equal(typeof localInputs.get('codex').input, 'string');
  assert.equal(remoteInputs.length, 1);
  for (const backend of profiles.keys()) assert.ok(remoteInputs[0].prompt.includes(backend + ' result'));
  assert.doesNotMatch(JSON.stringify(remoteInputs[0]), /private detail|ATTACHMENT-CONTENT|claude-only|agy-only|agy-image/u);
  assert.deepEqual(remoteInputs[0].workflowFiles, { paths: [], attachments: [] });
  assert.doesNotMatch(JSON.stringify(paused), /ATTACHMENT-CONTENT|UNAUTHORIZED-ATTACHMENT/u);
  const row = paused.rows[1], claude = profiles.get('claude-sdk');
  const publicCall = (payload) => app.requestLocal({ op: 'workbench', location: 'local-sdk', backend: 'claude-sdk',
    payload: { ...payload, settings: { location: 'local-sdk', provider: 'claude-sdk', profileId: claude.id }, targetId: row.targetId } });
  assert.deepEqual((await publicCall({ op: 'list' })).sessions, []);
  assert.equal((await publicCall({ op: 'get', sessionId: row.sessionId })).code, 'session_not_found');
  assert.equal((await publicCall({ op: 'send', sessionId: randomUUID(), turnId: randomUUID(), model: 'default',
    prompt: 'untrusted', workflowStage: { runId: paused.id } })).code, 'workflow_stage_changed');
  assert.equal((await request('artifacts', { query: { runId: paused.id, stageIndex: 1 } })).code, 'mixed_text_only');
  assert.equal(data.preference(localMemoryJournalKey), undefined);
  assert.equal(data.preference(memoryJournalKey), undefined);
  await app.close();
  app = await start();
  assert.equal((await request('resume')).ok, true);
  const completed = await settled('complete');
  assert.deepEqual(completed.rows.slice(0, 3), paused.rows.slice(0, 3));
  assert.equal(completed.rows[3].turnId, paused.rows[3].turnId);
  assert.equal(remoteInputs.length, 1);
  assert.equal(remoteReads[0].sessionId, paused.rows[3].sessionId);
  // The reverse edge also carries only approved textual fields, even when VPS has an independently authorized snapshot.
  const [vpsRef] = await data.saveWorkflowAttachments([textFile('vps-only.txt', 'PRIVATE-VPS-ATTACHMENT')]);
  const reverseId = randomUUID();
  const vpsSource = { ...stages[3], instruction: 'VPS-SOURCE-STAGE',
    fileAccess: { targetId, paths: [], attachments: [vpsRef] } };
  await data.changeWorkflows({ op: 'save', id: reverseId, revision: null, draft: { name: '反向附件验收',
    stages: [vpsSource, stages[1]], edges: [{ from: 'summary', to: 'review' }] } });
  localInputs.delete('claude-sdk');
  assert.equal((await request('start', { input: { ...input, workflowId: reverseId, revision: 1,
    transfers: [{ from: 'summary', to: 'review', fields: ['conclusion'] }] } })).ok, true);
  const reverse = await settled('complete');
  assert.equal(reverse.workflowId, reverseId);
  assert.deepEqual(remoteInputs[1].workflowFiles.attachments, [textFile('vps-only.txt', 'PRIVATE-VPS-ATTACHMENT')]);
  const reverseInput = JSON.stringify(localInputs.get('claude-sdk').input);
  assert.ok(reverseInput.includes('VPS-approved-conclusion') && reverseInput.includes('CLAUDE-ATTACHMENT-CONTENT'));
  assert.doesNotMatch(reverseInput, /VPS-private-details|PRIVATE-VPS-ATTACHMENT|vps-only[.]txt/u);
  const isolatedId = randomUUID();
  await data.changeWorkflows({ op: 'save', id: isolatedId, revision: null,
    draft: { name: '损坏快照验收', stages: [stages[1]], edges: [] } });
  await writeFile(join(root, 'workflow-attachments', claudeRef.digest), Buffer.alloc(claudeRef.size, 65));
  assert.equal((await request('start', { input: { ...input, workflowId: isolatedId, revision: 1, transfers: [] } })).ok, true);
  const missing = await settled('paused');
  assert.equal(missing.rows[0].state, 'waiting');
  assert.match(missing.message, /阶段附件快照缺失或变更/u);
  assert.equal(localInputs.size, 3);
});
