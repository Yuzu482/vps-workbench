import assert from 'node:assert/strict';
import test from 'node:test';
import { readProjectMemberships } from '../../../remote-workbench/vps-chat/client/project-folders.js';
import { setWorkbenchStorage } from '../../../remote-workbench/vps-chat/client/workbench-storage.js';
import { createPreviewFixtures } from './index.mjs';

const sessionId = '00000000-0000-4000-8000-000000009001';
const turnId = '00000000-0000-4000-8000-000000009002';
const steerId = '00000000-0000-4000-8000-000000009003';

test('Antigravity preview accepts a supplement and then waits for the original tool approval', () => {
  const { chat } = createPreviewFixtures();
  const { preset } = chat({ op: 'preset' });
  const settings = { ...preset.settings, provider: 'antigravity' };
  const { targetId } = chat({ op: 'list', settings });
  const request = { settings, targetId, sessionId };
  const readTurn = ({ session }) => session.turns.at(-1);
  const started = readTurn(chat({ ...request, op: 'send', turnId, prompt: '预览工具审批' }));
  assert.equal(started.canSteer, true);
  const steered = readTurn(chat({ ...request, op: 'steer', turnId, steerId, prompt: '缩短当前回答。' }));
  assert.equal(steered.steering[0].state, 'submitted');
  const refresh = () => readTurn(chat({ ...request, op: 'refresh' }));
  let latest;
  for (let i = 0; i < 20; i++) latest = refresh();
  assert.equal(latest.state, 'running');
  assert.equal(latest.canStop, true);
  assert.equal(latest.canSteer, false);
  const [{ id: approvalId, state }] = latest.approvals;
  assert.equal(state, 'pending');
  const decision = { ...request, op: 'approval', turnId, approvalId };
  assert.equal(chat({ ...decision, decision: 'allow' }).outcome, 'submitted');
  assert.equal(chat({ ...decision, decision: 'deny' }).code, 'approval_unavailable');
  assert.equal(refresh().canSteer, true);
  assert.equal(chat({ ...request, op: 'stop', turnId }).outcome, 'requested');
  assert.equal(refresh().approvals[0].decision, 'allow');
});

test('preview bootstrap presents synthetic projects, settings, tools, and design history', async () => {
  const { chat, preferences, projects } = createPreviewFixtures();
  const { preset } = chat({ op: 'preset' });
  assert.match(preset.settings.host, /\.invalid$/);
  assert.equal(preset.settings.hostKeyConfirmed, true);
  assert.match(preset.targetId, /^[a-f0-9]{64}$/);
  const providers = ['codex', 'claude', 'claude-sdk', 'antigravity', 'claude-subscription'];
  const { host, port, user, identityPath, knownHostsPath, expectedIpv4, expectedIpv6 } = preset.settings;
  const material = [host, port, user, identityPath.toLowerCase(), knownHostsPath.toLowerCase(), expectedIpv4, expectedIpv6];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(material)));
  assert.deepEqual(JSON.parse(preferences[`dsh-vps-chat-tools:v1:${Buffer.from(digest).toString('hex')}`]), providers);
  setWorkbenchStorage({ getItem: (key) => preferences[key] ?? null });
  try {
    const membership = readProjectMemberships(preset.targetId);
    assert.ok(preset.sessions.every(({ id }) => projects.some(({ workspaceId }) => workspaceId === membership[id])));
  } finally {
    setWorkbenchStorage(undefined);
  }

  for (const provider of providers.slice(0, -1)) {
    const settings = { ...preset.settings, provider };
    const list = chat({ op: 'list', settings });
    assert.equal(list.ok, true);
    assert.ok(list.sessions.length > 0);
    const { models } = chat({ op: 'models', settings, targetId: list.targetId });
    assert.ok(models.every(({ id, displayName, efforts, defaultEffort }) =>
      /^[A-Za-z0-9_.:-]{1,100}$/.test(id) && displayName && (defaultEffort === null || efforts.includes(defaultEffort))));
    assert.equal(models.filter(({ isDefault }) => isDefault).length, provider === 'antigravity' ? 0 : 1);
  }

  const design = preset.sessions.find(({ mode }) => mode === 'design');
  const { session } = chat({ op: 'get', settings: preset.settings, targetId: preset.targetId, sessionId: design.id });
  assert.equal(session.canSend, true);
  assert.equal(session.turns[0].state, 'complete');
  assert.equal(session.turns[0].reply.match(/^~~~html$/gm).length, 2);
  assert.match(session.turns[0].reply, /id="event-action"/);
  assert.equal(chat({ op: 'list', settings: { ...preset.settings, host: 'example.org' } }).code, 'invalid_settings');
  assert.deepEqual(chat({ op: 'account-view', targetId: preset.targetId, action: 'codex-login' }),
    { ok: false, code: 'preview_only', message: '本地预览不启动账号窗口。' });
});

test('preview chat keeps stable receipts and stages local design output', () => {
  const { chat } = createPreviewFixtures();
  const { preset: { settings, targetId } } = chat({ op: 'preset' });
  const request = { settings, targetId, sessionId };
  assert.deepEqual(chat({ op: 'model-options', settings, targetId }), { ok: true, fields: ['verbosity'] });
  const turn = { ...request, turnId, mode: 'design', prompt: '生成首页。', advanced: { verbosity: 'low' } };
  const sent = chat({ op: 'send', ...turn });
  assert.equal(sent.session.canSend, false);
  assert.equal(sent.session.turns[0].canSteer, true);
  assert.deepEqual(chat({ op: 'send', ...turn }), sent);
  assert.equal(chat({ op: 'send', ...turn, advanced: { verbosity: 'high' } }).code, 'turn_conflict');
  assert.equal(chat({ op: 'send', ...turn, advanced: { temperature: 0.2 } }).code, 'invalid_request');
  const steered = chat({ op: 'steer', ...request, turnId, steerId, prompt: '调整标题。' });
  assert.deepEqual(steered.session.turns[0].steering, [{ id: steerId, prompt: '调整标题。', state: 'delivered' }]);
  let refreshed;
  for (let index = 0; index < 16; index++) refreshed = chat({ op: 'refresh', ...request });
  assert.equal(refreshed.session.canSend, true);
  assert.equal(refreshed.session.turns[0].state, 'complete');
  assert.equal(refreshed.session.turns[0].steering.length, 1);
  assert.match(refreshed.session.turns[0].reply, /^~~~html$/m);
  assert.equal(chat({ op: 'list', settings }).sessions[0].id, sessionId);

  const newTurn = { ...turn, turnId: steerId, prompt: '再次生成首页。' };
  assert.equal(chat({ op: 'send', ...newTurn }).ok, true);
  assert.deepEqual(chat({ op: 'stop', ...request, turnId: steerId }), { ok: true, outcome: 'requested' });
  assert.equal(chat({ op: 'refresh', ...request }).session.turns.at(-1).state, 'stopped');
  assert.equal(createPreviewFixtures().chat({ op: 'get', ...request }).code, 'session_missing');
});

test('VPS design fixtures keep each provider’s draft and branch in its own target', () => {
  const { chat } = createPreviewFixtures();
  const { preset } = chat({ op: 'preset' });
  for (const provider of ['claude-sdk', 'claude', 'antigravity']) {
    const settings = { ...preset.settings, provider };
    const { targetId } = chat({ op: 'list', settings });
    const scope = { settings, targetId, sessionId };
    const draft = { ...scope, op: 'send', mode: 'design', turnId, prompt: '生成活动页。' };
    const running = chat(draft).session.turns[0];
    assert.equal(running.canStop, provider !== 'claude');
    assert.equal(running.canSteer, provider === 'antigravity');
    for (let i = 0; i < 16; i++) chat({ ...scope, op: 'refresh' });
    const base = chat({ ...scope, op: 'design-history', turnId }).turn;
    assert.match(base.reply, /^~~~html$/m);
    const fork = { ...draft, turnId: steerId, prompt: '生成另一版活动页。',
      designBase: { parentTurnId: turnId, fork: true }, designContext: { text: '以活动首页为基准。', images: [] } };
    assert.equal(chat(fork).ok, true);
    for (let i = 0; i < 16; i++) chat({ ...scope, op: 'refresh' });
    const { history } = chat({ ...scope, op: 'design-history' });
    assert.deepEqual(history.map(({ id, parentTurnId, fork }) => [id, parentTurnId, fork]),
      [[turnId, null, false], [steerId, turnId, true]]);
    assert.equal(chat({ ...scope, op: 'design-history', targetId: preset.targetId }).code, 'invalid_settings');
  }
});

test('a historical design can be opened and forked after falling outside recent turns', () => {
  const { chat } = createPreviewFixtures();
  const { preset } = chat({ op: 'preset' });
  const scope = { settings: preset.settings, targetId: preset.targetId,
    sessionId: preset.sessions.find(({ mode }) => mode === 'design').id };
  const read = (turnId) => chat({ op: 'design-history', ...scope, ...(turnId ? { turnId } : {}) });
  const [base, originalTip] = read().history;
  function complete(packet) {
    assert.equal(chat({ op: 'send', mode: 'design', ...scope, ...packet }).ok, true);
    for (let poll = 0; poll < 16; poll++) chat({ op: 'refresh', ...scope });
  }
  for (let index = 9; index < 20; index++) complete({ turnId: `00000000-0000-4000-8000-0000000010${String(index).padStart(2, '0')}`,
    prompt: '延续当前分支。' });
  assert.equal(chat({ op: 'get', ...scope }).session.turns.some(({ id }) => id === base.id), false);
  const source = read(base.id).turn;
  assert.match(source.reply, /在纸页间/);
  assert.equal(read().history.length, 14);
  complete({ turnId, prompt: '从初稿重新做红色版本。', designBase: { parentTurnId: base.id, fork: true },
    designContext: { text: source.reply, images: [] } });
  assert.equal(read().history.at(-1).parentTurnId, base.id);
  assert.equal(read().history.at(-1).fork, true);
  complete({ turnId: steerId, prompt: '回到原先的配色方案继续。', designBase: { parentTurnId: originalTip.id, fork: false } });
  assert.equal(read().history.at(-1).parentTurnId, originalTip.id);
  assert.equal(read().history.at(-1).fork, false);
  assert.deepEqual(read(base.id).turn, source);
});

test('preview returns a scoped edit for the requested layer and retains its design lineage', () => {
  const { chat } = createPreviewFixtures();
  const { preset } = chat({ op: 'preset' });
  const route = { settings: preset.settings, targetId: preset.targetId,
    sessionId: preset.sessions.find(({ mode }) => mode === 'design').id };
  const parent = chat({ op: 'design-history', ...route }).history.at(-1).id;
  const proposal = { base: steerId, layer: 'e2', changes: { text: '改写标题' } };
  const context = { text: `<meta name="dsh-layer-revision" content='${JSON.stringify(proposal)}'>`, images: [] };
  assert.equal(chat({ op: 'send', ...route, mode: 'design', turnId, prompt: '更新选中的标题',
    designBase: { parentTurnId: parent, fork: false }, designContext: context }).ok, true);
  for (let poll = 0; poll < 16; poll++) chat({ op: 'refresh', ...route });
  const { turn } = chat({ op: 'design-history', ...route, turnId });
  assert.equal(turn.state, 'complete');
  assert.equal(turn.parentTurnId, parent);
  assert.match(turn.reply, /dsh-layer-revision/);
  assert.ok(turn.reply.includes(JSON.stringify({ ...proposal, changes: { text: '图层演示 · 已更新' } })));
});

test('preview terminal emits synthetic output and receipts without reflecting input', () => {
  const { chat, terminal } = createPreviewFixtures();
  const { preset: { settings, targetId } } = chat({ op: 'preset' });
  const connection = { settings, targetId, mode: 'new', requireRelay: false };
  assert.equal(terminal({ op: 'native-subscription-current', ...connection }).result.sessionId, null);
  assert.equal(terminal({ op: 'native-subscription-start', ...connection, requireRelay: true }).ok, false);
  const started = terminal({ op: 'native-subscription-start', ...connection });
  const { sessionId: id } = started.result;
  assert.equal(started.result.state, 'ready');
  assert.equal(terminal({ op: 'native-subscription-current', ...connection }).result.sessionId, id);
  assert.equal(terminal({ op: 'native-list' }).result.records[0].connection.Host, settings.host);
  const first = terminal({ op: 'native-poll', sessionId: id, after: 0 }).result;
  assert.equal(first.lastSequence, 1);
  assert.match(Buffer.from(first.events[0].data, 'base64').toString(), /本地演示/);

  const data = Buffer.from('unreflected text\r').toString('base64');
  assert.equal(terminal({ op: 'native-input', sessionId: id, data }).ok, true);
  const second = terminal({ op: 'native-poll', sessionId: id, after: 1 }).result.events[0];
  assert.equal(second.sequence, 2);
  const output = Buffer.from(second.data, 'base64').toString();
  assert.match(output, /已收到一条演示消息/);
  assert.doesNotMatch(output, /unreflected text/);
  assert.equal(terminal({ op: 'native-close', sessionId: id }).result.state, 'closed');
  const closed = terminal({ op: 'native-poll', sessionId: id, after: 2 }).result;
  assert.equal(closed.state, 'closed');
  assert.deepEqual(closed.events.map(({ type }) => type), ['output', 'exit']);
  assert.equal(terminal({ op: 'native-status', operationId: id }).result.state, 'finished');
});
