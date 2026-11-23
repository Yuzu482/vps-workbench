import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGlobalSearch } from './global-search.mjs';
import { createSearchArtifactJournal } from './search-artifacts.mjs';
import { readVpsSearchSnapshots } from './search-snapshots.mjs';
import { workflowKey, workflowRunKey } from '../workflow-engine/state.mjs';

test('offline search reads saved turns and board versions, scopes sources and indexes saved artifact metadata', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-search-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'conversations');
  const vpsId = 'a'.repeat(64), localId = 'b'.repeat(64);
  const remoteDir = join(stateRoot, vpsId);
  const redirected = join(root, 'outside');
  await mkdir(remoteDir, { recursive: true });
  await mkdir(redirected);
  await symlink(redirected, join(stateRoot, 'f'.repeat(64)), process.platform === 'win32' ? 'junction' : 'dir');
  const sessionId = randomUUID(), first = randomUUID(), recent = randomUUID();
  const privateId = randomUUID(), redirectedId = randomUUID();
  const save = (directory, name, value) => writeFile(join(directory, name), JSON.stringify(value));
  const turns = Array.from({ length: 18 }, (_, index) => ({ TaskId: index === 17 ? recent : randomUUID(),
    ThreadId: sessionId, Prompt: '替换后的后续设计' }));
  await save(remoteDir, `conversation-${sessionId}.json`, { Version: 1, Id: sessionId, Provider: 'codex', Host: 'metadata.never.include',
    Turns: [{ TaskId: first, ThreadId: sessionId, Prompt: '早期版本初稿' }, ...turns] });
  await save(remoteDir, `conversation-${privateId}.json`, { Version: 1, Id: privateId, Provider: 'codex', MemoryExtraction: true,
    Turns: [{ TaskId: randomUUID(), Prompt: '提炼专属隐藏资料' }] });
  await save(redirected, `conversation-${redirectedId}.json`, { Version: 1, Id: redirectedId, Provider: 'codex',
    Turns: [{ TaskId: randomUUID(), Prompt: '目录重定向外部信息' }] });
  await writeFile(join(remoteDir, `design-${sessionId}`), Buffer.from([1]));
  await save(remoteDir, `turn-${first}.json`, { state: 'complete',
    reply: '包含离线回复\n\n~~~html\n<!doctype html><html><head><title>早期检索画板</title></head>'+
      '<body><h1>玻璃展台</h1><script src="https://example.test/code.js"></script></body></html>\n~~~' });
  await save(remoteDir, `steering-${first}.json`, [{ state: 'delivered', prompt: '原消息的补充指令' }]);
  await save(stateRoot, 'default-target.json', { targetId: vpsId, name: '东京演示配置' });
  const localSession = { id: randomUUID(), targetId: localId, location: 'local-sdk', provider: 'codex',
    configuration: '本机草图配置', title: '本机记录', mode: 'chat',
    turns: [{ id: randomUUID(), state: 'complete', prompt: '生成玻璃展台的说明', reply: '已按本机资料生成。' }] };
  const workflowId = randomUUID(), runId = randomUUID();
  const workflow = { name: '展台发布流程', stages: [{ id: 'a', name: '整理展台', provider: 'codex', model: '', instruction: '注明灯光条件。' }], edges: [] };
  const row = { targetId: vpsId, sessionId, turnId: first, state: 'complete', reply: '阶段完成。' };
  const preferences = new Map([
    [`dsh-vps-chat-projects:v1:${vpsId}`, JSON.stringify({ [sessionId]: 'local-test-project' })],
    [workflowKey, JSON.stringify([{ id: workflowId, revision: 1, ...workflow }])],
    [workflowRunKey, JSON.stringify({ version: 4, id: runId, workflowId, workflow, task: '执行',
      phase: 'complete', projectId: null, rows: [row], message: '', stopRequested: false })],
  ]);
  const data = { preference: (key) => preferences.get(key), setPreference: async (key, value) => preferences.set(key, value),
    projects: () => [{ workspaceId: 'local-test-project', title: '展览项目' }] };
  const journal = createSearchArtifactJournal(data);
  const bytes = Buffer.from('已缓存的暗场操作说明');
  await journal.remember({ op: 'workflow-artifacts', workflowRunId: runId, turnId: first, targetId: vpsId },
    { ok: true, file: { path: '导出/灯光指南.md', size: bytes.length, data: bytes.toString('base64') } });
  const reopened = createSearchArtifactJournal(data);
  let scans = 0;
  const request = createGlobalSearch({ data, artifacts: reopened.entries, async source() {
    scans++;
    const snapshot = await readVpsSearchSnapshots(stateRoot);
    return { ...snapshot, sessions: [localSession, ...snapshot.sessions] };
  } });
  const query = (text, scope = {}) => request({ op: 'search', query: text, refresh: false, projectId: null, groupId: null, ...scope });
  const result = await query('玻璃展台');
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.deepEqual(new Set(result.results.map(({ group }) => group.location)), new Set(['local-sdk', 'ssh-vps']));
  const board = result.results.find(({ type }) => type === 'board');
  const detail = (await request({ op: 'detail', id: board.id })).item;
  assert.equal(detail.nav.turnId, first);
  assert.equal(detail.nav.boardIndex, 1);
  assert.match(detail.html, /Content-Security-Policy/u);
  assert.doesNotMatch(detail.html, /example\.test\/code\.js/u);
  const project = (await query('展览项目')).results.find(({ type }) => type === 'project');
  assert.equal((await query('', { projectId: 'local-test-project', groupId: project.group.id })).total, 20);
  assert.equal((await query('灯光条件')).results[0].type, 'workflow');
  assert.equal((await query('暗场操作')).results[0].title, '导出/灯光指南.md');
  assert.equal((await query('原消息的补充')).results[0].type, 'message');
  for (const text of ['提炼专属隐藏资料', '目录重定向外部信息', 'metadata.never.include']) assert.equal((await query(text)).total, 0);
  assert.equal(scans, 1);
  await query('展台', { refresh: true });
  assert.equal(scans, 2);
});
