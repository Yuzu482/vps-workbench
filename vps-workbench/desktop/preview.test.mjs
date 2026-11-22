import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startPreview } from './preview-server.mjs';
import { writeWebAssets } from './web-assets.mjs';

test('loopback preview serves the same UI build as the Windows package', async (t) => {
  const preview = await startPreview({ port: 0, watch: false });
  t.after(() => preview.close());
  const web = await mkdtemp(join(tmpdir(), 'workbench-web-assets-'));
  t.after(() => rm(web, { recursive: true, force: true }));
  await writeWebAssets(web);
  const { revision, hashes } = JSON.parse(await readFile(join(web, 'revision.json'), 'utf8'));
  const readPreview = (path, options) => fetch(preview.origin + path, options);
  const manifest = await (await readPreview('/__preview/revision')).json();
  assert.deepEqual(manifest, { revision, hashes });
  for (const [name, expected] of Object.entries(hashes)) {
    if (name === 'index.html') continue;
    const asset = await readPreview('/' + name);
    assert.equal(asset.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'), expected);
  }
  const root = await readPreview('/');
  assert.match(await root.text(), /<script src="\/__preview\/native\.js"><\/script>/);
  assert.match(root.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal((await readPreview('/__preview/state', { headers: { Origin: 'https://external.invalid' } })).status, 403);
  assert.equal((await readPreview('/dsh-vps-chat/api/rpc', { method: 'POST' })).status, 403);
  const token = await (await readPreview('/dsh-vps-chat/api/token', { headers: { 'X-DSH-VPS-CHAT': '1' } })).json();
  const headers = { 'Content-Type': 'application/json', 'X-DSH-VPS-CHAT-Token': token.token };
  const rpc = async (op) => await (await readPreview('/dsh-vps-chat/api/rpc', {
    method: 'POST', headers, body: JSON.stringify({ op }),
  })).json();
  assert.match((await rpc('preset')).preset.settings.host, /\.invalid$/);
  assert.equal((await rpc('account-view')).code, 'preview_only');
  assert.equal((await readPreview('/dsh-vps-chat/api/account-player.mjs')).status, 404);
});

test('the local agent preview starts with three distinct local profiles and selects Claude', async (t) => {
  const preview = await startPreview({ localAgents: true, port: 0, watch: false });
  t.after(() => preview.close());
  const get = async (path) => (await fetch(preview.origin + path)).json();
  const [{ profiles }, { preferences }] = await Promise.all([get('/__preview/local-sdk'), get('/__preview/state')]);
  assert.deepEqual(profiles.map(({ backend }) => backend), ['codex', 'claude-sdk', 'antigravity']);
  assert.equal(new Set(profiles.map(({ targetId }) => targetId)).size, profiles.length);
  const claude = profiles.find(({ backend }) => backend === 'claude-sdk');
  assert.equal(preferences['dsh-vps-chat:desktop-view-location:v1'], 'local-sdk');
  assert.equal(preferences['dsh-vps-chat:desktop-new-location:v1'], 'local-sdk');
  assert.equal(preferences['dsh-vps-chat:local-view-profile:v1'], claude.id);
  assert.equal(preferences['dsh-vps-chat:local-new-profile:v1'], claude.id);
});

test('preview learns a project decision and reuses it across tools with a clean-session override', async (t) => {
  const preview = await startPreview({ port: 0, watch: false });
  t.after(() => preview.close());
  const get = async (path) => (await fetch(preview.origin + path, { headers: { 'X-DSH-VPS-CHAT': '1' } })).json();
  const { token } = await get('/dsh-vps-chat/api/token');
  const headers = { Origin: preview.origin, 'Content-Type': 'application/json', 'X-DSH-VPS-CHAT-Token': token };
  const post = async (path, packet) => {
    const response = await fetch(preview.origin + path, { method: 'POST', headers, body: JSON.stringify(packet) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const rpc = (packet) => post('/dsh-vps-chat/api/rpc', packet);
  const change = (packet) => post('/__preview/extensions', packet);
  const { preset } = await rpc({ op: 'preset' });
  const { projects: [{ workspaceId: projectId }] } = await get('/__preview/state');
  const assign = ({ targetId, sessionId }) => post('/__preview/projects', { op: 'set-memberships', targetId,
    value: JSON.stringify({ [sessionId]: projectId }) });
  await change({ op: 'set-automatic-memory', targetId: preset.memoryTargetId, projectId, enabled: true });
  const source = { op: 'send', settings: preset.settings, targetId: preset.targetId, sessionId: randomUUID(), turnId: randomUUID(),
    prompt: '本项目的图标尺寸定稿为 32×32 像素。', projectMemory: { projectId } };
  await assign(source);
  await rpc(source);
  const poll = { op: 'refresh', settings: source.settings, targetId: source.targetId, sessionId: source.sessionId };
  let receipt;
  for (let check = 0; check < 4; check++) receipt = await rpc(poll);
  assert.equal(receipt.session.turns.at(-1).state, 'complete');
  for (let check = 0; check < 30; check++) {
    const { preferences } = await get('/__preview/state');
    if (JSON.parse(preferences['dsh-vps-chat:extensions:v1']).memories.length > 0) break;
    await delay(10);
  }
  for (const provider of ['claude-sdk', 'claude', 'antigravity']) {
    const settings = { ...preset.settings, provider };
    const { targetId, memoryTargetId } = await rpc({ op: 'list', settings });
    assert.notEqual(targetId, preset.targetId);
    assert.equal(memoryTargetId, preset.memoryTargetId);
    const send = { ...source, settings, targetId, sessionId: randomUUID(), turnId: randomUUID(), prompt: '请核对图标尺寸' };
    await assign(send);
    const result = await rpc(send);
    assert.equal(result.session.turns[0].prompt, send.prompt);
    assert.ok(result.session.turns[0].activity.some(({ title }) => title === '长期记忆'));
    const sessionId = randomUUID();
    await change({ op: 'set-conversation-isolation', targetId, sessionId, isolated: true });
    const independent = await rpc({ ...send, sessionId, turnId: randomUUID() });
    assert.equal(independent.session.memoryIsolation, true);
    assert.equal(independent.session.turns[0].activity.some(({ title }) => title === '长期记忆'), false);
  }
});

test('preview can learn and recall a personal preference with an empty project list', async (t) => {
  const preview = await startPreview({ port: 0, watch: false });
  t.after(() => preview.close());
  const get = async (path) => (await fetch(preview.origin + path, { headers: { 'X-DSH-VPS-CHAT': '1' } })).json();
  const { token } = await get('/dsh-vps-chat/api/token');
  const headers = { Origin: preview.origin, 'Content-Type': 'application/json', 'X-DSH-VPS-CHAT-Token': token };
  const post = async (path, packet) => {
    const result = await fetch(preview.origin + path, { method: 'POST', headers, body: JSON.stringify(packet) });
    assert.equal(result.status, 200);
    return result.json();
  };
  const rpc = (packet) => post('/dsh-vps-chat/api/rpc', packet);
  const memorySettings = (packet) => post('/__preview/extensions', packet);
  const { preset } = await rpc({ op: 'preset' });
  await post('/__preview/projects', { op: 'set-projects', projects: [] });
  const enabled = await memorySettings({ op: 'set-personal-memory', enabled: true });
  assert.equal(enabled.personalMemory.enabled, true);
  assert.deepEqual((await get('/__preview/state')).projects, []);
  const settings = preset.settings;
  const targetId = preset.targetId;
  const sessionId = randomUUID();
  await rpc({ op: 'send', settings, targetId, sessionId, turnId: randomUUID(),
    prompt: '我习惯用三行要点写摘要。', projectMemory: { projectId: null } });
  let saved;
  for (let check = 0; check < 4; check++) saved = await rpc({ op: 'refresh', settings, targetId, sessionId });
  assert.equal(saved.session.turns.at(-1).state, 'complete');
  for (let check = 0; check < 30; check++) {
    const { preferences } = await get('/__preview/state');
    const entries = JSON.parse(preferences['dsh-vps-chat:extensions:v1']).memories;
    if (entries.some(({ projectId }) => projectId === null)) break;
    await delay(10);
  }
  const fresh = await rpc({ op: 'send', settings, targetId, sessionId: randomUUID(), turnId: randomUUID(),
    prompt: '按我的摘要格式偏好写摘要。', projectMemory: { projectId: null } });
  assert.ok(fresh.session.turns[0].activity.some(({ title }) => title === '长期记忆'));
});

test('preview binds workflow sends to the submitted snapshot and uses its per-stage context', async (t) => {
  const preview = await startPreview({ port: 0, watch: false });
  t.after(() => preview.close());
  const get = async (path) => (await fetch(preview.origin + path, { headers: { 'X-DSH-VPS-CHAT': '1' } })).json();
  const { token } = await get('/dsh-vps-chat/api/token');
  const headers = { Origin: preview.origin, 'Content-Type': 'application/json', 'X-DSH-VPS-CHAT-Token': token };
  const post = async (path, packet) => {
    const result = await fetch(preview.origin + path, { method: 'POST', headers, body: JSON.stringify(packet) });
    assert.equal(result.status, 200);
    return result.json();
  };
  const rpc = (packet) => post('/dsh-vps-chat/api/rpc', packet);
  const change = (packet) => post('/__preview/extensions', packet);
  const { preset } = await rpc({ op: 'preset' });
  const { projects: [{ workspaceId: projectId }] } = await get('/__preview/state');
  await change({ op: 'set-automatic-memory', targetId: preset.memoryTargetId, projectId, enabled: true });
  await change({ op: 'save-memory', memory: { id: 'icons', targetId: preset.memoryTargetId, projectId,
    title: '活动图标尺寸', text: '统一使用 32×32。', enabled: true } });
  await change({ op: 'import-plugin', manifest: { schema: 1, id: 'page-check', name: '页面检查', version: '1',
    description: '', prompts: [{ title: '排版检查', text: '用两行给出版面建议。' }] } });
  await change({ op: 'set-plugin', id: 'page-check', enabled: true });
  const runId = randomUUID();
  const requests = [0, 1].map(() => ({ op: 'send', settings: preset.settings, targetId: preset.targetId,
    sessionId: randomUUID(), turnId: randomUUID(), prompt: '不使用此客户端草稿', workflowStage: { runId } }));
  const run = { version: 3, id: runId, projectId, phase: 'running', message: '', stopRequested: false,
    task: '核对活动图标尺寸', workflow: { name: '设计交接', edges: [],
      stages: ['shared', 'isolated'].map((memory) => ({
        id: memory, name: memory, provider: 'codex', model: '', instruction: '核对设计稿。',
        agent: { mcpServers: [], plugins: memory === 'isolated' ? [{ id: 'page-check', version: '1', title: '排版检查' }] : [], memory },
        agentPreset: { id: randomUUID(), name: '仅本地展示的 Agent 名称' },
      })) },
    rows: requests.map(({ targetId, sessionId, turnId }) => ({ targetId, sessionId, turnId, state: 'submitted', reply: '' })) };
  assert.equal((await rpc(requests[0])).code, 'workflow_stage_changed');
  assert.equal((await post('/__preview/workflow-run', { op: 'save-workflow-run', value: JSON.stringify(run) })).ok, true);
  const [shared, isolated] = await Promise.all(requests.map(rpc));
  assert.equal(shared.ok, true);
  assert.equal(isolated.ok, true);
  assert.ok(shared.session.turns[0].activity.some(({ title }) => title === '长期记忆'));
  assert.equal(isolated.session.memoryIsolation, true);
  assert.ok(isolated.session.turns[0].activity.every(({ title }) => title !== '长期记忆'));
  assert.match(isolated.session.turns[0].prompt, /两行给出版面建议/);
  assert.doesNotMatch(isolated.session.turns[0].prompt, /不使用此客户端草稿|仅本地展示的 Agent 名称/);
});
