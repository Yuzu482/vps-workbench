import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { startWorkbenchServer } from './server.mjs';
import { openAppData, memoryJournalKey } from './data.mjs';
import { localMemoryJournalKey } from '../local-sdk/workbench.mjs';
import { setupConnectionKey } from './setup-state.mjs';
import { localWorkflowRunKey, mixedWorkflowRunKey, workflowRunKey } from '../workflow-engine/state.mjs';
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
  assert.equal(runtime.action('resume').ok, true);
  await until(() => runtime.status().run?.phase === 'complete');
  assert.deepEqual(dispatched.map(({ op, body }) => [op, body.turnId]), [['send', first.rows[0].turnId]]);
});
