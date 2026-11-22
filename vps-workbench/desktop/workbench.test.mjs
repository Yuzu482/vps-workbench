import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbenchRouteReader } from '../../remote-workbench/vps-chat/host/account-view.js';
import { openAppData } from './data.mjs';
import { readWorkflows, workflowKey, workflowRunKey } from '../workflow-engine/state.mjs';
import { createWorkflowRunner, workflowStagePrompt } from '../workflow-engine/runner.mjs';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { importWorkbenchSnapshot } from './migrate.mjs';
import { startWorkbenchServer } from './server.mjs';
import { createSetupExample, setupConnectionKey, setupExampleTask } from './setup-state.mjs';
import { trialPrompt, trialState } from './setup-trial.mjs';
import { createStreamingMarkdownParser, stabilizeStreamingRecord } from './streaming-render.mjs';
import {
  buildDesignContext, designStyleLevels, maxDesignContextText, readDesignProject, saveDesignProject, setDesignBoard,
} from '../../remote-workbench/vps-chat/client/design-state.js';
import { setWorkbenchStorage } from '../../remote-workbench/vps-chat/client/workbench-storage.js';
import { createArtboard } from '../../remote-workbench/vps-chat/client/design-preview.js';
import { layerRevisionKey, readLayerRevision, serializeLayerRevision } from '../../remote-workbench/vps-chat/client/design-layer-revision.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vps-workbench-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('design brief and style persist in their own conversation and apply only to design workflow', (t) => {
  const stored = new Map([['design-one', JSON.stringify({ system: '青色组品牌', references: '一次性截图说明' })]]);
  setWorkbenchStorage({ getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) });
  t.after(() => setWorkbenchStorage(undefined));
  const options = { workflow: true };
  const legacy = readDesignProject('design-one').project;
  assert.equal(legacy.style, 2);
  assert.equal(legacy.brief.enabled, false);
  assert.equal(buildDesignContext(legacy, null, [], {}).context, null);
  const project = { ...legacy, autoSystem: true, style: 4, brief: { ...legacy.brief, enabled: true, goal: '给新玩家设计商店' } };
  assert.equal(saveDesignProject('design-one', project), '');
  const saved = readDesignProject('design-one').project;
  const first = buildDesignContext(saved, null, [], { references: true }, undefined, options);
  assert.match(first.context.text, /设计工作方式 · 首稿/);
  assert.match(first.context.text, /给新玩家设计商店/);
  assert.match(first.context.text, /青色组品牌/);
  assert.match(first.context.text, /一次性截图说明/);
  const next = buildDesignContext(saved, { id: 'first', number: 1 }, [], {}, { continueBranch: true }, options);
  assert.match(next.context.text, /设计工作方式 · 继续分支/);
  assert.match(next.context.text, /给新玩家设计商店/);
  assert.match(next.context.text, /青色组品牌/);
  assert.doesNotMatch(next.context.text, /一次性截图说明/);
  assert.equal(readDesignProject('design-two').project.brief.goal, '');
  for (const [style, [label, instruction]] of designStyleLevels.entries()) {
    const { context } = buildDesignContext({ ...saved, style }, null, [], {}, null, options);
    assert.ok(context.text.includes(`风格倾向 · ${label}`) && context.text.includes(instruction));
  }
});

test('saving and reloading more than 24 edited versions preserves the oldest work', (t) => {
  const saved = new Map();
  setWorkbenchStorage({ getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) });
  t.after(() => setWorkbenchStorage(undefined));
  const id = (number) => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
  let project = readDesignProject('design-history').project;
  for (let index = 1; index <= 26; index++) {
    project = setDesignBoard(project, id(index), 1, {
      edits: { e1: { text: `版本 ${index}` } },
      comments: [{ layer: 'e1', label: '标题', text: `原始批注 ${index}` }],
    });
  }
  assert.equal(saveDesignProject('design-history', project), '');
  const restored = readDesignProject('design-history').project;
  assert.equal(Object.keys(restored.versions).length, 26);
  assert.equal(restored.versions[id(1)][1].edits.e1.text, '版本 1');
  assert.equal(restored.versions[id(1)][1].comments[0].text, '原始批注 1');
});

test('design context budgets source HTML after opted-in materials and includes only the targeted board edits', () => {
  const version = { id: 'base', number: 2 };
  const layer = { id: 'e2', tag: 'button', label: '购买入口', text: '立即购买' };
  const board = { title: '商店首页', version: 2, versionId: 'base', index: 2, layers: [layer], html: 'x'.repeat(20000) };
  const project = {
    style: 4, autoSystem: true, system: '规则'.repeat(5000), references: '参考'.repeat(3000), images: [],
    versions: { base: {
      1: { edits: { e1: { text: '只属于另一张画板' } }, additions: [], comments: [] },
      2: { edits: {}, additions: [], comments: [{ layer: 'e2', label: '购买入口', text: '提高对比' }] },
    } },
  };
  const result = buildDesignContext(project, version, [{ title: '其它画板' }, board],
    { revision: true, references: true }, { board, intent: 'iterate', layer: layer.id, fork: true }, { workflow: true });
  assert.equal(result.error, '');
  assert.ok(result.context.text.length <= maxDesignContextText);
  assert.match(result.context.text, /风格倾向 · 发散/);
  assert.match(result.context.text, /修改限在标记的元素/);
  assert.match(result.context.text, /当前图层文字：立即购买/);
  assert.match(result.context.text, /提高对比/);
  assert.match(result.context.text, /画板 HTML（摘录）/);
  assert.doesNotMatch(result.context.text, /只属于另一张画板/);
});

test('scoped design requests keep their output contract and selected element under the context budget', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const base = '00000000-0000-4000-8000-000000000002';
  const board = { ...createArtboard('<h1 style="color:red">店铺</h1>'), index: 1, version: 3, versionId: id };
  const project = { style: 4, autoSystem: true, system: '品牌约束', references: '', images: [], versions: {} };
  const { context, labels, error } = buildDesignContext(project, { id, number: 3 }, [board], {},
    { board, layer: 'e1', intent: 'iterate', revision: base, retryReason: '上次返回了未开放的属性。' }, { workflow: true });
  assert.equal(error, '');
  assert.ok(context.text.length <= maxDesignContextText);
  assert.ok(labels.includes('仅修改图层 · 店铺'));
  assert.match(context.text, /品牌约束/);
  assert.match(context.text, /风格倾向 · 发散/);
  assert.match(context.text, /当前图层行内样式：color:red/);
  assert.match(context.text, /上一份结果的校验反馈：上次返回了未开放的属性。/);
  assert.ok(context.text.includes(JSON.stringify({ base, layer: 'e1', changes: { text: '修改后的文案' } })));
  const annotated = { edits: {}, additions: [], comments: [{ layer: 'e1', label: '店铺', text: '已通过校验的批注' }] };
  const inherited = { id, number: 3, initialBoards: { 1: annotated } };
  const continued = buildDesignContext(project, inherited, [board], { revision: true },
    { continueBranch: true, approvedBoards: [{ ...board, board: annotated }] }, { workflow: true });
  assert.match(continued.context.text, /设计工作方式 · 继续分支/);
  assert.match(continued.context.text, /以下是版本 3 已应用并校验的画板/);
  assert.match(continued.context.text, /设计版本 3 的修改和批注/);
  assert.match(continued.context.text, /店铺：已通过校验的批注/);
});

test('scoped design revisions apply validated properties to the frozen board and preserve other boards and links', (t) => {
  const projectKey = 'design-example';
  const id = '00000000-0000-4000-8000-000000000041';
  const base = '00000000-0000-4000-8000-000000000042';
  const sourceId = '00000000-0000-4000-8000-000000000043';
  const snapshot = {
    base, sourceId, index: 2, layer: 'e2',
    sources: ['<h1>首页</h1>', '<section><button data-dsh-go="1">返回</button><p>原文</p></section>'],
    boards: { 1: { edits: { e1: { text: '人工修改的首页' } } }, 2: { edits: { e3: { color: '#203040' } } } },
    links: [{ from: `${sourceId}:2`, to: `${sourceId}:1`, layer: 'e2' }],
  };
  const entries = new Map([[layerRevisionKey(projectKey, id), serializeLayerRevision(snapshot)]]);
  setWorkbenchStorage({ getItem: (key) => entries.get(key) ?? null });
  t.after(() => setWorkbenchStorage(undefined));
  const meta = (value) => `<meta name="dsh-layer-revision" content='${JSON.stringify(value).replaceAll('&', '&amp;').replaceAll("'", '&#39;')}'>`;
  const fenced = (head, closed = true) => ['~~~html', `<!doctype html><html><head>${head}</head><body><h1>篡改其它内容</h1></body></html>`,
    ...(closed ? ['~~~'] : [])].join('\n');
  const valid = { base, layer: 'e2', changes: { text: "返回 <&>'", borderRadius: 12 } };
  const turn = { id, state: 'complete', reply: fenced(meta(valid)) };
  const result = readLayerRevision(projectKey, turn);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.boardIndex, 2);
  assert.deepEqual(result.links, [{ from: `${id}:2`, to: `${id}:1`, layer: 'e2' }]);
  assert.deepEqual(result.sources, snapshot.sources);
  assert.equal(createArtboard(result.sources[0], result.boards[1]).layers[0].text, '人工修改的首页');
  const revised = createArtboard(result.sources[1], result.boards[2]);
  assert.match(revised.html, /data-dsh-go="1"/);
  assert.match(revised.html, /border-radius:12px/);
  assert.match(revised.html, /返回 &lt;&amp;&gt;&#39;/);
  assert.doesNotMatch(revised.html, /篡改其它内容/);
  assert.deepEqual(result.boards[2].edits.e3, { color: '#203040' });
  assert.deepEqual(JSON.parse(entries.get(layerRevisionKey(projectKey, id))), snapshot);
  assert.equal(readLayerRevision(projectKey, { ...turn, state: 'running' }).outcome, 'waiting');
  assert.equal(readLayerRevision(projectKey, { ...turn, id: sourceId, reply: fenced('') }), null);
  assert.match(readLayerRevision(projectKey, { ...turn, id: sourceId }).error, /缺少本轮冻结的画板基线/);
  entries.set(`${layerRevisionKey(projectKey, sourceId)}:outcome`, 'accepted');
  assert.match(readLayerRevision(projectKey, { ...turn, id: sourceId, reply: fenced('') }).error, /缺少本轮冻结的画板基线/);
  for (const reply of [
    fenced('', true), fenced(meta(valid), false), fenced(meta(valid) + meta(valid)),
    [fenced(meta(valid)), ...Array(5).fill(fenced('')), fenced(meta(valid))].join('\n\n'),
    fenced(meta({ ...valid, base: sourceId })), fenced(meta({ ...valid, layer: 'e3' })),
    fenced(meta({ ...valid, changes: { removed: true } })), fenced(meta({ ...valid, changes: { borderRadius: -1 } })),
    fenced(meta({ ...valid, changes: { color: 'url(https://example.invalid)' } })),
    fenced(meta({ ...valid, changes: { text: '返回' } })),
  ]) {
    const rejected = readLayerRevision(projectKey, { ...turn, reply });
    assert.equal(rejected.outcome, 'rejected', reply);
    assert.equal(rejected.sources, undefined);
    assert.deepEqual(rejected.retryTarget, { id: `${sourceId}:2`, layer: 'e2' });
  }
  const container = { ...snapshot, layer: 'e1' };
  entries.set(layerRevisionKey(projectKey, id), serializeLayerRevision(container));
  assert.equal(readLayerRevision(projectKey, { ...turn, reply: fenced(meta({ ...valid, layer: 'e1' })) }).outcome, 'rejected');
  const manyLinks = Array.from({ length: 241 }, (_, index) =>
    ({ from: `${sourceId}:2`, to: `${sourceId}:1`, layer: `e${index + 1}` }));
  entries.set(layerRevisionKey(projectKey, id), serializeLayerRevision({ ...snapshot, links: manyLinks }));
  assert.equal(readLayerRevision(projectKey, turn).links.length, 241);
});

test('unchanged stream snapshots retain identity while content and receipts still update', () => {
  const completed = { id: 'earlier', reply: 'First reply', state: 'complete', activity: [] };
  const running = { id: 'current', reply: 'Draft', state: 'running', activity: [], canStop: true };
  const before = { session: { id: 'design', mode: 'design', turns: [completed, running] }, canSend: false };
  assert.equal(stabilizeStreamingRecord(before, structuredClone(before)), before);

  const changed = structuredClone(before);
  changed.session.turns[1].canStop = false;
  changed.session.turns[1].steering = [{ id: 'message', state: 'delivered', prompt: '补充约束' }];
  const observed = stabilizeStreamingRecord(before, changed);
  assert.equal(observed.session.turns[0], completed);
  assert.equal(observed.session.turns[1], changed.session.turns[1]);
  assert.deepEqual(observed, changed);

  const settled = structuredClone(changed);
  settled.canSend = true;
  settled.session.turns[1].state = 'complete';
  settled.session.turns[1].reply = 'Replaced by the authoritative final reply';
  assert.deepEqual(stabilizeStreamingRecord(observed, settled), settled);
  const otherSession = { ...before, session: { ...before.session, id: 'other' } };
  assert.equal(stabilizeStreamingRecord(before, otherSession), otherSession);
});

test('stream rendering batches queued text and releases canceled jobs and worker failures', (t) => {
  const frames = [];
  const messages = [];
  const listeners = new Map();
  const result = [];
  const mockGlobals = {
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    Worker: class {
      addEventListener(type, listener) { listeners.set(type, listener); }
      postMessage(message) { messages.push(message); }
      terminate() {}
    },
  };
  for (const [key, value] of Object.entries(mockGlobals)) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (saved) Object.defineProperty(globalThis, key, saved);
      else delete globalThis[key];
    });
  }
  const parse = createStreamingMarkdownParser();
  const canceled = parse('superseded before the frame', () => assert.fail('obsolete job ran'));
  canceled();
  const inFlight = parse('first update', () => assert.fail('canceled result was delivered'));
  frames.shift()();
  assert.equal(messages[0].source, 'first update');
  inFlight();
  parse('latest text', (tokens) => result.push(tokens));
  listeners.get('message')({ data: { id: messages[0].id, tokens: [] } });
  frames.shift()();
  assert.equal(messages[1].source, 'latest text');
  const tokens = [{ type: 'paragraph', raw: 'latest text' }];
  listeners.get('message')({ data: { id: messages[1].id, tokens } });
  parse('unavailable worker', (tokens) => result.push(tokens));
  frames.shift()();
  listeners.get('error')();
  parse('fallback without retries', (tokens) => result.push(tokens));
  assert.deepEqual(result, [tokens, null, null]);
  assert.equal(frames.length, 0);
});

test('standalone preferences and project IDs survive an app restart', async (t) => {
  const root = await fixture(t);
  const project = join(root, 'art');
  await mkdir(project);
  const data = await openAppData(root);
  const key = 'dsh-vps-chat:workbench:v1';
  await Promise.all([data.setPreference(key, '{"theme":"light"}'),
    data.setPreference(key, '{"theme":"dark"}'), data.addProject(project), data.addProject(project)]);
  const next = await openAppData(root);
  assert.deepEqual(next.preferences(), { [key]: '{"theme":"dark"}' });
  assert.equal(next.projects().length, 1);
  assert.deepEqual(next.projects(), data.projects());
  await next.removeProject(next.projects()[0].workspaceId);
  await next.setPreference(key, null);
  assert.deepEqual((await openAppData(root)).preferences(), {});
  assert.deepEqual(await readdir(project), []);
});

test('Windows retries a locked preferences replacement and persists the newest canvas position', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async (t) => {
  const root = await fixture(t);
  const data = await openAppData(root);
  const file = join(root, 'preferences.json');
  const key = `dsh-vps-design:v1:${'a'.repeat(64)}:${randomUUID()}`;
  const board = `${randomUUID()}:1`;
  const position = (x, y) => JSON.stringify({ playground: { positions: { [board]: { x, y } }, links: [] } });
  await data.setPreference(key, position(0, 0));
  const holder = spawn(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command', [
      "$handle = [IO.File]::Open($env:VPS_WORKBENCH_LOCK_TEST_FILE, 'Open', 'Read', 'ReadWrite')",
      "try { [Console]::WriteLine('locked'); [void][Console]::ReadLine() } finally { $handle.Dispose() }",
    ].join('; '),
  ], { windowsHide: true, env: { ...process.env, VPS_WORKBENCH_LOCK_TEST_FILE: file } });
  const exited = once(holder, 'close');
  try {
    const [ready] = await Promise.race([once(holder.stdout, 'data'), exited.then(() => [])]);
    assert.equal(ready?.toString().trim(), 'locked');
    const pending = Promise.all([data.setPreference(key, position(12, 18)), data.setPreference(key, position(36, 49))]);
    // Observe the staged replacement while its destination remains locked.
    void pending.catch(() => {});
    let staged = false;
    for (let attempt = 0; attempt < 50 && !staged; attempt++) {
      staged = (await readdir(root)).some((name) => name.endsWith('.tmp'));
      if (!staged) await delay(10);
    }
    assert.equal(staged, true);
    await delay(110);
    assert.equal(JSON.parse(await readFile(file, 'utf8'))[key], position(0, 0));
    holder.stdin.end();
    await pending;
    const restored = await openAppData(root);
    assert.equal(restored.preference(key), position(36, 49));
    assert.equal(await readFile(file + '.bak', 'utf8'), await readFile(file, 'utf8'));
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    holder.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
  }
});

test('recovers the latest committed preferences and projects and preserves corrupt originals', async (t) => {
  const root = await fixture(t);
  const project = join(root, 'art');
  await mkdir(project);
  const data = await openAppData(root);
  const key = 'dsh-vps-chat:workbench:v1';
  await data.setPreference(key, '{"theme":"light"}');
  await data.setPreference(key, '{"theme":"dark"}');
  await data.addProject(project);
  const saved = data.projects();
  const corrupt = new Map([['preferences.json', '{"broken":'], ['projects.json', '{"not":"a project list"}']]);
  for (const [name, value] of corrupt) await writeFile(join(root, name), value);
  const restored = await openAppData(root);
  assert.equal(restored.preference(key), '{"theme":"dark"}');
  assert.deepEqual(restored.projects(), saved);
  assert.deepEqual(restored.notices(), ['已从本机备份恢复设置。', '已从本机备份恢复项目列表。']);
  for (const [name, value] of corrupt) {
    const archive = (await readdir(root)).find((file) => file.startsWith(name + '.corrupt-'));
    assert.equal(await readFile(join(root, archive), 'utf8'), value);
    assert.equal(await readFile(join(root, name), 'utf8'), await readFile(join(root, name + '.bak'), 'utf8'));
  }
  assert.deepEqual((await openAppData(root)).notices(), []);
});

test('keeps a corrupt primary intact when no backup can be verified', async (t) => {
  const root = await fixture(t);
  const broken = join(root, 'preferences.json');
  await writeFile(broken, '{"broken":');
  await assert.rejects(openAppData(root), /invalid_local_data/);
  assert.equal(await readFile(broken, 'utf8'), '{"broken":');
});

test('a valid primary wins over a recovery copy left by an interrupted save', async (t) => {
  const root = await fixture(t);
  const key = 'dsh-vps-chat:workbench:v1';
  const main = join(root, 'preferences.json');
  const committed = JSON.stringify({ [key]: 'prior' });
  await writeFile(main, committed);
  await writeFile(main + '.bak', JSON.stringify({ [key]: 'staged' }));
  assert.equal((await openAppData(root)).preference(key), 'prior');
  assert.equal(await readFile(main + '.bak', 'utf8'), committed);
});

test('a failed primary save cannot publish the candidate as a recovery copy', async (t) => {
  const root = await fixture(t);
  const data = await openAppData(root);
  const main = join(root, 'preferences.json');
  const key = 'dsh-vps-chat:workbench:v1';
  await mkdir(main);
  await assert.rejects(data.setPreference(key, 'candidate'));
  assert.equal(data.preference(key), undefined);
  assert.deepEqual(await readdir(root), ['preferences.json']);
});

test('a failed backup leaves the primary committed and retries on the next save', async (t) => {
  const root = await fixture(t);
  let warnings = 0;
  const data = await openAppData(root, { onBackupFailure: () => { warnings++; } });
  const main = join(root, 'preferences.json');
  const backup = main + '.bak';
  const key = 'dsh-vps-chat:workbench:v1';
  await mkdir(backup);
  await data.setPreference(key, 'saved');
  await data.setPreference(key, 'saved');
  assert.equal(data.preference(key), 'saved');
  const committed = await readFile(main, 'utf8');
  assert.deepEqual(JSON.parse(committed), { [key]: 'saved' });
  assert.equal(warnings, 1);
  await rmdir(backup);
  await data.setPreference(key, 'saved');
  assert.equal(await readFile(backup, 'utf8'), committed);
});

test('concurrent workflow edits compare the saved revision inside the preferences queue', async (t) => {
  const root = await fixture(t);
  const data = await openAppData(root);
  const id = '00000000-0000-4000-8000-000000000111';
  const draft = { name: '原方案', stages: [{ name: '阶段', provider: 'codex', model: '', instruction: '整理目标。' }] };
  const save = (revision, name) => data.changeWorkflows({ op: 'save', id, revision, draft: { ...draft, name } });
  await data.setPreference(workflowKey, JSON.stringify([{ id, revision: 1, ...draft }]));
  const results = await Promise.allSettled([save(1, '确认后的方案'), save(1, '已过期的修改')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /已变更/u);
  const reopened = await openAppData(root);
  assert.deepEqual(readWorkflows(reopened.preference(workflowKey)),
    [{ id, revision: 2, name: '确认后的方案', stages: [{ id: 's1', ...draft.stages[0] }], edges: [] }]);
});

test('imports a separate conversation snapshot while preserving target and receipt identity', async (t) => {
  const root = await fixture(t);
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const target = 'a'.repeat(64);
  await mkdir(join(source, target), { recursive: true });
  await mkdir(destination);
  await writeFile(join(source, 'default-target.json'), '{}');
  await writeFile(join(source, target, 'task-fixture.json'), '{"originalOperation":"one"}');
  await writeFile(join(source, 'ssh-relay-required'), '');
  await writeFile(join(source, 'unrelated.txt'), 'ignore');
  assert.equal(await importWorkbenchSnapshot(source, destination), 3);
  assert.equal(await readFile(join(destination, target, 'task-fixture.json'), 'utf8'), '{"originalOperation":"one"}');
  assert.deepEqual((await readdir(destination)).sort(), [target, 'default-target.json', 'ssh-relay-required']);
  assert.throws(createWorkbenchRouteReader(destination), { code: 'ENOENT' });
  await assert.rejects(importWorkbenchSnapshot(source, destination), /workbench_data_exists/);
  await assert.rejects(importWorkbenchSnapshot(source, join(source, target)), /overlapping_workbench_data/);
});

test('imports a legacy relay configuration with its required policy already in place', async (t) => {
  const root = await fixture(t);
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  await mkdir(source);
  await mkdir(destination);
  const configuration = JSON.stringify({ version: 1, socksPort: 10808, expectedSshSource: '192.0.2.18' });
  await writeFile(join(source, 'ssh-relay.json'), configuration);
  assert.equal(await importWorkbenchSnapshot(source, destination), 1);
  assert.equal(await readFile(join(destination, 'ssh-relay-required'), 'utf8'), '');
  await rm(join(destination, 'ssh-relay.json'));
  assert.throws(createWorkbenchRouteReader(destination), { code: 'ENOENT' });
  assert.deepEqual(await readdir(source), ['ssh-relay.json']);
});

test('known relay policy cannot fall back after removal or corruption', async (t) => {
  const root = await fixture(t);
  const file = join(root, 'ssh-relay.json');
  const read = createWorkbenchRouteReader(root);
  assert.equal(read(), null);
  const valid = { version: 1, socksPort: 10808, expectedSshSource: '192.0.2.18' };
  await writeFile(file, JSON.stringify(valid));
  assert.deepEqual(read(), { socksPort: valid.socksPort, expectedSshSource: valid.expectedSshSource });
  await rm(file);
  assert.throws(read, { code: 'ENOENT' });
  assert.throws(createWorkbenchRouteReader(root), { code: 'ENOENT' });
  await writeFile(file, '{}');
  assert.throws(read);
});

test('standalone listener requires its local session and the workbench RPC token', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Workbench</title>');
  const calls = [];
  let access = { mode: 'execute', workspace: 'default' };
  const app = await startWorkbenchServer({
    webRoot: root, workbenchRoot: root, terminalRoot: root, runtimeRoot: root, access: () => access,
    makeBridge: () => ({
      request(body) { calls.push(body); return { ok: true, preset: null }; },
      dispose() {},
    }),
  });
  try {
    const cookie = app.cookie.name + '=' + app.cookie.value;
    const start = await fetch(app.origin);
    assert.equal(start.status, 403);
    const page = await fetch(app.origin, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self' ws:\/\/127\.0\.0\.1:/);
    const headers = { Cookie: cookie, 'X-DSH-VPS-CHAT': '1', 'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json' };
    const response = await fetch(app.origin + '/dsh-vps-chat/api/token', { headers });
    assert.equal(response.status, 200);
    const { token } = await response.json();
    const send = (headers, packet = { op: 'preset' }) => fetch(app.origin + '/dsh-vps-chat/api/rpc', {
      method: 'POST', headers, body: JSON.stringify(packet),
    });
    assert.equal((await send(headers)).status, 403);
    const authorized = { ...headers, 'X-DSH-VPS-CHAT-Token': token };
    assert.equal((await send({ ...authorized, Origin: 'https://outside.invalid' })).status, 403);
    assert.equal((await send({ ...authorized, 'X-Forwarded-For': '127.0.0.1' })).status, 403);
    assert.deepEqual(await (await send(authorized)).json(), { ok: true, preset: null });
    assert.deepEqual(calls, [{ op: 'preset' }]);
    const settings = {
      host: 'fixture.invalid', port: 22, user: 'fixture', identityPath: 'C:/Fixture/id', knownHostsPath: 'C:/Fixture/hosts',
      workspace: '/work/fixture', expectedIpv4: '192.0.2.10', expectedIpv6: '', hostKeyConfirmed: true, provider: 'codex',
    };
    const targetId = 'b'.repeat(64);
    const sessionId = '67a8a23a-d8bc-4abd-b4f7-698856d79fbc';
    const turnId = '9e994e42-6711-4121-aaf1-96e9fdcbcec5';
    const message = { op: 'send', settings, targetId, sessionId, turnId, prompt: 'permission fixture' };
    assert.equal((await send(authorized, { ...message, workflowStage: { runId: turnId } })).status, 400);
    const extensions = { mcpServers: ['fixture-status'], memory: [{ title: '参考', text: '示例记忆' }] };
    const extended = { ...message, extensions };
    access = { mode: 'browse', workspace: 'read-only' };
    assert.equal((await (await send(authorized, message)).json()).code, 'workbench_browse_only');
    assert.equal((await (await send(authorized, extended)).json()).code, 'workbench_browse_only');
    assert.equal((await (await send(authorized, { op: 'refresh', settings, targetId, sessionId })).json()).code, 'workbench_browse_only');
    assert.equal((await send(authorized, { op: 'get', settings, targetId, sessionId })).status, 200);
    assert.equal(calls.length, 2);
    const history = { op: 'design-history', settings, targetId, sessionId, turnId };
    assert.equal((await send(authorized, history)).status, 200);
    assert.deepEqual(calls.at(-1), history);
    assert.equal((await send(authorized, { ...history, turnId: 'invalid' })).status, 400);
    const terminalBootstrap = await fetch(app.origin + '/dsh-terminal-workbench/api/bootstrap', {
      headers: { Cookie: cookie, 'X-RTW-Bootstrap': '1', 'Sec-Fetch-Site': 'same-origin' },
    });
    const terminalToken = (await terminalBootstrap.json()).token;
    assert.equal(typeof terminalToken, 'string');
    const terminal = await fetch(app.origin + '/dsh-terminal-workbench/api/rpc', { method: 'POST',
      headers: { ...headers, 'X-RTW-Token': terminalToken, 'X-RTW-Nonce': turnId },
      body: JSON.stringify({ op: 'native-input', sessionId, data: 'Zml4dHVyZQ==' }),
    });
    assert.equal(terminal.status, 403);
    assert.equal((await terminal.json()).code, 'workbench_browse_only');
    access = { mode: 'execute', workspace: 'isolated' };
    assert.equal((await send(authorized, { ...message, workspaceAccess: 'read-only' })).status, 400);
    assert.equal((await send(authorized, message)).status, 200);
    assert.deepEqual(calls.at(-1), { ...message, workspaceAccess: 'isolated' });
    assert.equal((await send(authorized, extended)).status, 200);
    assert.deepEqual(calls.at(-1), { ...extended, workspaceAccess: 'isolated' });
    assert.equal((await send(authorized, { ...extended, extensions: { ...extensions, mcpServers: ['/bin/sh'] } })).status, 400);
    const claude = { ...message, settings: { ...settings, provider: 'claude' } };
    const designBase = { parentTurnId: 'a892f24a-1651-4c53-bd26-314945e1e85e', fork: true };
    const fork = { ...message, mode: 'design', designBase, designContext: { text: '源画板', images: [] } };
    assert.equal((await send(authorized, fork)).status, 200);
    assert.deepEqual(calls.at(-1), { ...fork, workspaceAccess: 'isolated' });
    assert.equal((await send(authorized, { ...fork, designContext: undefined })).status, 400);
    assert.equal((await send(authorized, { ...fork, mode: undefined })).status, 400);
    assert.equal((await send(authorized, { ...fork, settings: claude.settings })).status, 400);
    assert.equal((await send(authorized, { ...claude, extensions })).status, 400);
    assert.equal((await send(authorized, claude)).status, 200);
    assert.deepEqual(calls.at(-1), claude);
    const options = { op: 'model-options', settings, targetId };
    assert.equal((await send(authorized, options)).status, 200);
    assert.deepEqual(calls.at(-1), options);
    const advanced = { ...message, advanced: { verbosity: 'high' } };
    assert.equal((await send(authorized, advanced)).status, 200);
    assert.deepEqual(calls.at(-1), { ...advanced, workspaceAccess: 'isolated' });
    const capped = { ...claude, advanced: { maxOutputTokens: 2048, reasoningEffort: 'medium' } };
    assert.equal((await send(authorized, capped)).status, 200);
    assert.deepEqual(calls.at(-1), capped);
    for (const bad of [null, {}, { maxOutputTokens: 1023 }, { maxOutputTokens: '2048' },
      { maxOutputTokens: 8193 }, { maxOutputTokens: 1024.5 }, { reasoningEffort: 'xhigh' }, { temperature: 0.2 }]) {
      assert.equal((await send(authorized, { ...claude, advanced: bad })).status, 400);
    }
    const sdk = { ...capped, settings: { ...settings, provider: 'claude-sdk' }, advanced: { maxOutputTokens: 65_536 } };
    assert.equal((await send(authorized, sdk)).status, 200);
    assert.deepEqual(calls.at(-1), sdk);
    assert.equal((await send(authorized, { ...sdk, advanced: { maxOutputTokens: 65_537 } })).status, 400);
    assert.equal((await send(authorized, { ...advanced, advanced: { maxOutputTokens: 2048 } })).status, 400);
    assert.equal((await send(authorized, { ...options, advanced: { verbosity: 'low' } })).status, 400);
    access = { mode: 'browse', workspace: 'read-only' };
    assert.equal((await send(authorized, options)).status, 200);
    assert.equal((await send(authorized, advanced)).status, 403);
  } finally {
    await app.close();
  }
});

test('parallel workflow dispatch uses the existing authenticated desktop bridge and access mode', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Workbench</title>');
  const preview = createPreviewFixtures();
  const { settings: base, targetId } = preview.chat({ op: 'preset' }).preset;
  const data = await openAppData(root);
  for (const enabled of [false, true]) {
    await data.changeExtensions({ op: 'save-server', server: { id: 'fixture-status', targetId, enabled } });
  }
  const sends = [];
  let access = { mode: 'browse', workspace: 'isolated' };
  const app = await startWorkbenchServer({
    webRoot: root, workbenchRoot: root, terminalRoot: root, runtimeRoot: root, access: () => access, data,
    makeBridge: () => ({
      request(packet) {
        if (packet.op === 'send') sends.push(packet);
        return preview.chat(packet);
      },
      dispose() {},
    }),
  });
  const headers = {
    Cookie: app.cookie.name + '=' + app.cookie.value, 'X-DSH-VPS-CHAT': '1',
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
  };
  let run;
  try {
    const { token } = await (await fetch(app.origin + '/dsh-vps-chat/api/token', { headers })).json();
    assert.equal(typeof token, 'string');
    headers['X-DSH-VPS-CHAT-Token'] = token;
    async function rpc(op, payload, signal) {
      const response = await fetch(app.origin + '/dsh-vps-chat/api/rpc', {
        method: 'POST', headers, signal, body: JSON.stringify({ op, ...payload }),
      });
      const value = await response.json();
      if (!value.ok) throw Object.assign(new Error(value.message), { code: value.code });
      return value;
    }
    const runner = createWorkflowRunner({
      async resolveRoute(provider, signal) {
        const settings = { ...base, provider };
        const { targetId } = await rpc('list', { settings }, signal);
        return { settings, targetId };
      },
      rpc, persist: (value) => data.setPreference(workflowRunKey, JSON.stringify(value)),
      onChange(value) { run = value; }, pollInterval: 0,
    });
    const draft = {
      name: '权限测试',
      stages: [
        { id: 'a', name: '文案', provider: 'codex', model: '', instruction: '拟一条标题。',
          agent: { mcpServers: [{ id: 'fixture-status', targetId }], plugins: [], memory: 'isolated' } },
        { id: 'b', name: '校对', provider: 'claude-sdk', model: '', instruction: '列出核对项。' },
        { id: 'c', name: '汇总', provider: 'antigravity', model: '', instruction: '整理两个结果。' },
      ],
      edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }],
    };
    await runner.start(draft, '整理发布准备。');
    assert.equal(run.phase, 'failed');
    assert.equal(sends.length, 0);

    access = { mode: 'execute', workspace: 'isolated' };
    await runner.start(draft, '整理发布准备。');
    assert.equal(run.phase, 'complete');
    assert.deepEqual(sends.map(({ settings }) => settings.provider).sort(), ['antigravity', 'claude-sdk', 'codex']);
    assert.ok(sends.every(({ settings, targetId, sessionId }) =>
      settings.host === base.host && settings.hostKeyConfirmed && targetId && sessionId));
    const codex = sends.find(({ settings }) => settings.provider === 'codex');
    assert.equal(codex.workspaceAccess, 'isolated');
    assert.equal(codex.memoryIsolation, true);
    assert.deepEqual(codex.extensions, { memory: [], mcpServers: ['fixture-status'] });
    assert.ok(sends.every((send) => !Object.hasOwn(send, 'workflowStage')));
    runner.dispose();
  } finally {
    await app.close();
  }
});

test('setup example brief and reviewer both receive the original facts and flag the missing registration channel', () => {
  const workflow = createSetupExample('codex', 'fixture-codex');
  const previousReply = '可以通过邮箱报名。';
  const run = { workflow, task: setupExampleTask, rows: [{ reply: previousReply }, { reply: '' }] };
  for (const [index, stage] of workflow.stages.entries()) {
    for (const fact of ['首次到访的读者', '免费报名', '60 分钟']) {
      assert.ok(setupExampleTask.includes(fact));
      assert.ok(stage.instruction.includes(fact));
    }
    assert.match(stage.instruction, /原始用户任务/u);
    assert.match(stage.instruction, /报名渠道写为「待确认」/u);
    assert.equal(stage.agent.memory, 'isolated');
    const prompt = workflowStagePrompt(run, index);
    assert.ok(prompt.indexOf(setupExampleTask) < prompt.indexOf(stage.instruction));
    if (index === 1) {
      assert.match(stage.instruction, /逐项核对/u);
      assert.ok(prompt.includes(`> ${previousReply}`));
    }
  }
});

test('setup checks are scoped to the verified route and saved connections are revalidated', async (t) => {
  const root = await fixture(t);
  const data = await openAppData(root);
  const preview = createPreviewFixtures();
  const { settings, targetId } = preview.chat({ op: 'preset' }).preset;
  const calls = [];
  let access = { mode: 'execute', workspace: 'read-only' };
  const app = await startWorkbenchServer({
    webRoot: root, workbenchRoot: root, terminalRoot: root, runtimeRoot: root, access: () => access, data,
    makeBridge: () => ({
      request(packet, options) {
        calls.push(packet.op);
        if (packet.op === 'setup-backend') assert.deepEqual(options, { current: true });
        return preview.chat(packet);
      },
    }),
  });
  t.after(() => app.close());
  const headers = {
    Cookie: app.cookie.name + '=' + app.cookie.value, 'X-DSH-VPS-CHAT': '1',
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
  };
  const { token } = await (await fetch(app.origin + '/dsh-vps-chat/api/token', { headers })).json();
  headers['X-DSH-VPS-CHAT-Token'] = token;
  const rpc = (packet) => fetch(app.origin + '/dsh-vps-chat/api/rpc', { method: 'POST', headers, body: JSON.stringify(packet) });
  const ssh = { op: 'setup-check', kind: 'ssh', settings, targetId, mcpServers: [] };
  const trial = { op: 'setup-trial', kind: 'start', settings, targetId, sessionId: randomUUID(), turnId: randomUUID() };
  const backend = { op: 'setup-backend', kind: 'probe', settings, targetId };
  const install = { ...backend, kind: 'start', installId: randomUUID(), providers: ['claude-sdk'] };

  for (const invalid of [
    { ...ssh, kind: 'run' }, { ...ssh, prompt: 'unexpected' }, { ...ssh, mcpServers: ['extra'] },
    { ...ssh, kind: 'resources', mcpServers: ['../unexpected'] },
    { ...ssh, kind: 'resources', mcpServers: ['fixture-status', 'fixture-status'] },
    { ...ssh, settings: { ...settings, hostKeyConfirmed: false } },
    { ...trial, prompt: 'unexpected' }, { ...trial, kind: 'inspect', model: 'preview-codex' },
    { ...trial, sessionId: trial.turnId }, { ...trial, targetId: 'local-' + trial.sessionId },
    { ...backend, settings: { ...settings, provider: 'claude-sdk' } },
    { ...install, providers: ['claude-sdk', 'claude-sdk'] }, { ...install, source: 'https://fixture.invalid' },
    { op: 'configuration', settings, targetId },
    { op: 'configuration', settings: { ...settings, hostKeyConfirmed: false } },
  ]) assert.equal((await rpc(invalid)).status, 400);
  access = { ...access, mode: 'browse' };
  assert.equal((await rpc(ssh)).status, 403);
  assert.equal((await rpc(trial)).status, 403);
  assert.equal((await rpc(backend)).status, 403);
  assert.equal((await rpc(install)).status, 403);
  assert.deepEqual(calls, []);
  await data.setPreference(setupConnectionKey, JSON.stringify({ settings, targetId }));
  const configured = await (await rpc({ op: 'configuration' })).json();
  assert.deepEqual(configured.preset, { name: '本机保存的 VPS', settings, ok: true, targetId, memoryTargetId: targetId, sessions: [] });
  assert.deepEqual(calls, ['configuration']);
  access = { ...access, mode: 'execute' };
  assert.deepEqual(await (await rpc(ssh)).json(), { ok: true, targetId, status: 'connected' });
  await data.setPreference(setupConnectionKey, JSON.stringify({ settings, targetId }));
  assert.equal((await (await rpc({ op: 'preset' })).json()).preset.targetId, targetId);
  await data.setPreference(setupConnectionKey, JSON.stringify({ settings, targetId: 'c'.repeat(64) }));
  assert.equal((await (await rpc({ op: 'preset' })).json()).code, 'target_changed');
  assert.deepEqual(calls, ['configuration', 'setup-check', 'list', 'list']);
  assert.equal((await (await rpc({ ...trial, kind: 'inspect' })).json()).status, 'unknown');
  assert.equal(calls.at(-1), 'get');
  const started = await (await rpc(trial)).json();
  assert.equal(started.status, 'pending');
  assert.equal(started.turnId, trial.turnId);
  const fresh = await (await rpc({ ...trial, kind: 'inspect', turnId: randomUUID() })).json();
  assert.equal(fresh.status, 'unknown');
  assert.equal(calls.at(-1), 'get');
  const incomplete = { ok: true, session: { id: trial.sessionId, turns: [
    { id: trial.turnId, prompt: trialPrompt, state: 'running', reply: 'partial text' },
  ] } };
  assert.equal(trialState(incomplete, trial, 'complete'), 'pending');
  assert.equal(trialState(incomplete, { ...trial, turnId: randomUUID() }, 'complete'), 'unknown');
  assert.equal(calls.filter((op) => op === 'send').length, 1);
  const runner = createWorkflowRunner({
    resolveRoute: async () => ({ settings, targetId }),
    rpc: () => assert.fail('The sample must not dispatch to a changed target'),
    persist: () => assert.fail('The sample must not replace the run receipt for a changed target'),
    onChange() {},
  });
  await assert.rejects(runner.start(createSetupExample('codex', ''), setupExampleTask, null, 'c'.repeat(64)),
    /连接/u);
  runner.dispose();
  assert.equal((await (await rpc(backend)).json()).platform.architecture, 'x64');
  assert.equal((await (await rpc({ ...install, targetId: 'c'.repeat(64) })).json()).code, 'invalid_settings');
  assert.deepEqual((await (await rpc(install)).json()).install.providers, ['claude-sdk']);
});

test('dispatch uses saved scope and rechecks a grant revoked while opening its attachment', async (t) => {
  const root = await fixture(t);
  const data = await openAppData(root);
  const preview = createPreviewFixtures();
  const { settings, targetId } = preview.chat({ op: 'preset' }).preset;
  const attachment = { name: '参考.txt', data: 'c2VsZWN0ZWQ=' };
  const [ref] = await data.saveWorkflowAttachments([attachment, { name: 'unused.txt', data: 'aGlkZGVu' }]);
  assert.deepEqual(await data.readWorkflowAttachments([ref]), [attachment]);
  await assert.rejects(data.saveWorkflowAttachments([{ name: '../unsafe', data: 'YQ==' }]), /附件格式无效/);
  const workflowId = randomUUID();
  const draft = { name: '资料授权', stages: [{ id: 'stage', name: '审校', provider: 'codex', model: '',
    instruction: '核对文件。', fileAccess: { targetId, paths: ['docs/brief.txt'], attachments: [ref] } }], edges: [] };
  await data.changeWorkflows({ op: 'save', id: workflowId, revision: null, draft });
  const [runId, sessionId, turnId] = Array.from({ length: 3 }, () => randomUUID());
  const run = { version: 4, id: runId, workflowId, workflow: draft, task: '校对任务', projectId: null,
    phase: 'running', stopRequested: false, message: '运行中',
    rows: [{ targetId, sessionId, turnId, state: 'submitted', reply: '' }] };
  await data.setPreference(workflowRunKey, JSON.stringify(run));
  const sends = [];
  let release, materializing;
  const runtimeData = { ...data, async readWorkflowAttachments(refs) {
    if (materializing) await new Promise((resolve) => { release = resolve; materializing(); });
    return data.readWorkflowAttachments(refs);
  } };
  const app = await startWorkbenchServer({
    webRoot: root, workbenchRoot: root, terminalRoot: root, runtimeRoot: root, data: runtimeData,
    makeBridge: () => ({ request(packet, options) {
      if (packet.op === 'send') sends.push({ packet, options });
      return preview.chat(packet);
    } }),
  });
  t.after(() => app.close());
  const headers = { Cookie: app.cookie.name + '=' + app.cookie.value, 'X-DSH-VPS-CHAT': '1',
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  headers['X-DSH-VPS-CHAT-Token'] = (await (await fetch(app.origin + '/dsh-vps-chat/api/token', { headers })).json()).token;
  const rpc = (packet) => fetch(app.origin + '/dsh-vps-chat/api/rpc', { method: 'POST', headers, body: JSON.stringify(packet) });
  const send = { op: 'send', settings, targetId, sessionId, turnId, prompt: 'renderer placeholder', workflowStage: { runId } };
  assert.equal((await rpc({ ...send, workflowFiles: { paths: ['hidden.txt'], attachments: [] } })).status, 400);
  assert.equal((await (await rpc(send)).json()).ok, true);
  assert.deepEqual(sends[0]?.packet.workflowFiles, { paths: ['docs/brief.txt'], attachments: [attachment] });
  assert.match(sends[0].packet.prompt, /校对任务[\s\S]+\/output/u);
  assert.equal(sends[0].options.current, true);
  const checked = new Promise((resolve) => { materializing = resolve; });
  const stale = rpc(send);
  await checked;
  const { fileAccess: _removed, ...stage } = draft.stages[0];
  try { await data.changeWorkflows({ op: 'save', id: workflowId, revision: 1, draft: { ...draft, stages: [stage] } }); }
  finally { release(); }
  assert.equal((await (await stale).json()).code, 'workflow_file_access_changed');
  assert.equal(sends.length, 1);
});

test('workflow artifacts expose only the finished stage on its original route', async (t) => {
  const root = await fixture(t);
  const data = await openAppData(root);
  const { settings, targetId } = createPreviewFixtures().chat({ op: 'preset' }).preset;
  const runId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID();
  const run = { version: 4, id: runId, workflowId: null, projectId: null, phase: 'complete', message: '完成',
    stopRequested: false, task: '文件演练', workflow: { name: '文件演练', stages: [
      { id: 'check', name: '检查', provider: settings.provider, model: '', instruction: '检查产物。' },
    ], edges: [] }, rows: [{ sessionId, turnId, targetId, state: 'complete', reply: '文件已保存。' }] };
  await data.setPreference(workflowRunKey, JSON.stringify(run));
  const calls = [];
  const path = 'docs/summary.txt', file = { path, size: 4 };
  const second = { path: 'report/summary.txt', size: 3 };
  const service = await startWorkbenchServer({
    data, webRoot: root, workbenchRoot: root, terminalRoot: root, runtimeRoot: root,
    makeBridge: () => ({ request(body, options) {
      calls.push({ body, options });
      if (body.after === path) return { ok: true, files: [second], truncated: false };
      if (body.offset === 1) return { ok: true, file: { ...file, offset: 1, revision: 'a'.repeat(64), data: 'ZXN0' } };
      return body.path === path ? { ok: true, file: { ...file, data: 'dGVzdA==' } }
        : { ok: true, files: [file], truncated: false };
    } }),
  });
  t.after(() => service.close());
  const headers = { Cookie: service.cookie.name + '=' + service.cookie.value, 'X-DSH-VPS-CHAT': '1',
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  headers['X-DSH-VPS-CHAT-Token'] = (await (await fetch(service.origin + '/dsh-vps-chat/api/token', { headers })).json()).token;
  const rpc = (packet) => fetch(service.origin + '/dsh-vps-chat/api/rpc', { method: 'POST', headers, body: JSON.stringify(packet) });
  const list = { op: 'workflow-artifacts', workflowRunId: runId, settings, targetId, sessionId, turnId };
  assert.equal((await rpc({ ...list, path: '../other' })).status, 400);
  assert.equal((await rpc({ ...list, offset: 0 })).status, 400);
  assert.equal((await rpc({ ...list, path, after: path })).status, 400);
  assert.equal((await (await rpc({ ...list, workflowRunId: randomUUID() })).json()).code, 'workflow_output_changed');
  assert.equal((await (await rpc({ ...list, turnId: randomUUID() })).json()).code, 'workflow_output_changed');
  assert.equal((await (await rpc({ ...list, targetId: 'f'.repeat(64) })).json()).code, 'workflow_output_changed');
  assert.equal(calls.length, 0);
  assert.deepEqual(await (await rpc(list)).json(), { ok: true, files: [file], truncated: false });
  assert.deepEqual(await (await rpc({ ...list, path })).json(), { ok: true, file: { ...file, data: 'dGVzdA==' } });
  assert.deepEqual(await (await rpc({ ...list, after: path })).json(), { ok: true, files: [second], truncated: false });
  assert.deepEqual(await (await rpc({ ...list, path, offset: 1 })).json(),
    { ok: true, file: { ...file, offset: 1, revision: 'a'.repeat(64), data: 'ZXN0' } });
  assert.ok(calls.every(({ body, options }) => !Object.hasOwn(body, 'workflowRunId') && options.current));
  assert.equal(calls.length, 4);
});
