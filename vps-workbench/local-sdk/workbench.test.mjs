import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { localModels } from '../desktop/codex-runtime.mjs';
import { memoryJournalKey, openAppData } from '../desktop/data.mjs';
import { extensionPreferenceKey, readExtensions } from '../extensions/state.mjs';
import { createWorkflowRunner, readWorkflowRun } from '../workflow-engine/runner.mjs';
import { localWorkflowRunKey } from '../workflow-engine/state.mjs';
import { openLocalSdk } from './service.mjs';
import { createLocalWorkbench, localMemoryJournalKey } from './workbench.mjs';

const html = (title) => '\x60\x60\x60html\n<!doctype html><html><head><title>' + title +
  '</title></head><body><h1>' + title + '</h1></body></html>\n\x60\x60\x60';
const inputText = (input) => typeof input === 'string' ? input
  : input.filter(({ type }) => type === 'text').map(({ text }) => text).join('\n');
async function until(check) {
  for (let i = 0; i < 160; i++) {
    const value = await check();
    if (value) return value;
    await wait(12);
  }
  throw new Error('fixture did not settle');
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-workbench-test-')));
  const directory = join(root, 'project');
  await mkdir(directory);
  const data = await openAppData(join(root, 'data'));
  const calls = [];
  const access = { mode: 'execute', workspace: 'default' };
  async function boot() {
    const service = await openLocalSdk({ root: join(root, 'sdk'), models: localModels, canExecute: () => access.mode === 'execute',
      credentialConfigured: () => true, createThread(profile, threadId, options) {
        return { async runStreamed(input) {
          calls.push({ profile, threadId, options, input });
          const prompt = inputText(input);
          const text = prompt.startsWith('以设计资料中明确') ? html('稿件 ' + calls.length)
            : prompt.startsWith('提炼用户明确') ? JSON.stringify({ memories: [{ title: '图标尺寸', text: '图标使用 64×64。' }] })
              : prompt.startsWith('工作流步骤') ? '本机阶段产物 ' + prompt.slice(0, 13) : '本机回答';
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: threadId ?? randomUUID() };
            await wait(15);
            yield { type: 'item.completed', item: { type: 'agent_message', id: 'reply', text } };
            yield { type: 'turn.completed', usage: { input_tokens: 23 } };
          })() };
        } };
      } });
    const workbench = createLocalWorkbench({ service, runtimeAvailable: true, access: () => access, data, pollInterval: 10 });
    return { service, workbench, async close() { workbench.dispose(); await service.close(); } };
  }
  let host = await boot();
  t.after(async () => {
    await host.close();
    await data.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 });
  });
  const register = async (name) =>
    (await host.service.registerProfile({ name, directory, model: localModels[0].id, effort: 'medium' })).profile;
  const profile = await register('示例工作目录');
  const route = { targetId: profile.targetId, settings: { location: 'local-sdk', provider: 'codex', profileId: profile.id } };
  const request = (op, details = {}) => host.workbench.request({ op, ...route, ...details });
  const send = (prompt, details = {}) => {
    const ids = { sessionId: randomUUID(), turnId: randomUUID(), ...details };
    const result = request('send', { prompt, ...ids });
    return { ...ids, result };
  };
  const finish = ({ sessionId, turnId }) => until(async () => {
    const packet = await request('refresh', { sessionId, turnId });
    return packet.session?.turns.find((turn) => turn.id === turnId && turn.state === 'complete');
  });
  return { root, directory, data, profile, route, calls, access, register, request, send, finish,
    extraction: (change) => host.workbench.changeExtractionModel(change),
    legacy: (packet) => host.service.request({ location: 'local-sdk', backend: 'codex', profileId: profile.id, ...packet }),
    async restart() { await host.close(); host = await boot(); } };
}

test('desktop workbench opens legacy chats and persists independent design branches on the original profile', async (t) => {
  const f = await fixture(t);
  const legacyId = randomUUID();
  const first = await f.legacy({ op: 'send', sessionId: 'local-' + legacyId, turnId: randomUUID(), targetId: f.route.targetId, prompt: '旧版对话' });
  await f.finish({ sessionId: legacyId, turnId: first.session.turns[0].id });
  assert.equal((await f.request('list')).sessions[0].id, legacyId);
  const { fields } = await f.request('model-options');
  assert.deepEqual(fields, ['verbosity']);
  assert.equal((await f.send('无效参数', { advanced: { temperature: 0.1 } }).result).code, 'invalid_request');
  const advanced = { verbosity: 'low' };
  const continued = f.send('续聊', { sessionId: legacyId, model: 'gpt-6-sol', effort: 'high', advanced });
  assert.equal((await continued.result).ok, true);
  await f.finish(continued);
  assert.ok(f.calls[1].threadId);
  assert.equal(f.calls[1].profile.effort, 'high');
  assert.equal(f.calls[1].options.verbosity, 'low');
  assert.equal((await f.request('send', { sessionId: legacyId, turnId: continued.turnId, prompt: '续聊',
    model: 'gpt-6-sol', effort: 'high', advanced })).duplicate, true);
  assert.equal((await f.request('send', { sessionId: legacyId, turnId: continued.turnId, prompt: '续聊',
    model: 'gpt-6-sol', effort: 'high', advanced: { verbosity: 'high' } })).code, 'turn_conflict');

  const initial = f.send('制作图标页', { mode: 'design', designContext: { text: '参考用图', images: [
    { name: 'image.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  ] } });
  assert.equal((await initial.result).ok, true);
  const base = await f.finish(initial);
  assert.equal(f.calls.at(-1).options.rasterInput, true);
  const next = f.send('修改整体排版', { sessionId: initial.sessionId, mode: 'design' });
  assert.equal((await next.result).ok, true);
  await f.finish(next);
  assert.match(inputText(f.calls.at(-1).input), /<title>稿件 3<\/title>/u);
  const fork = f.send('从第一稿分支', { sessionId: initial.sessionId, mode: 'design', designBase: { parentTurnId: base.id, fork: true } });
  assert.equal((await fork.result).ok, true);
  await f.finish(fork);
  assert.equal(f.calls.at(-1).threadId, null);
  assert.match(inputText(f.calls.at(-1).input), /<title>稿件 3<\/title>/u);
  assert.doesNotMatch(inputText(f.calls.at(-1).input), /<title>稿件 4<\/title>/u);
  const other = await f.register('其它配置');
  assert.equal((await f.request('get', { sessionId: initial.sessionId, settings: { ...f.route.settings, profileId: other.id } })).code, 'target_changed');
  const count = f.calls.length;
  await f.restart();
  const history = (await f.request('design-history', { sessionId: initial.sessionId })).history;
  assert.deepEqual(history.map(({ parentTurnId, fork }) => [parentTurnId, fork]), [[null, false], [initial.turnId, false], [initial.turnId, true]]);
  assert.equal((await f.request('design-history', { sessionId: initial.sessionId, turnId: next.turnId })).turn.state, 'complete');
  assert.equal((await f.request('send', { sessionId: legacyId, turnId: continued.turnId, prompt: '续聊',
    model: 'gpt-6-sol', effort: 'high', advanced })).duplicate, true);
  assert.equal(f.calls.length, count);
});

test('resuming a local chat rechecks the tools enabled for its original profile', async (t) => {
  const f = await fixture(t);
  const server = { id: 'read-only-docs', targetId: f.route.targetId, enabled: false,
    local: { url: 'http://127.0.0.1:7345/mcp', tools: ['search'] } };
  await f.data.changeExtensions({ op: 'save-server', server });
  await f.data.changeExtensions({ op: 'save-server', server: { ...server, enabled: true } });
  const first = f.send('使用已启用的资料检索。');
  await first.result;
  await f.finish(first);
  assert.deepEqual(f.calls[0].options.mcpServers.map(({ id }) => id), [server.id]);
  await f.data.changeExtensions({ op: 'save-server', server });
  const next = f.send('使用同一会话继续。', { sessionId: first.sessionId,
    extensions: { memory: [], mcpServers: [server.id, 'injected'] } });
  assert.equal((await next.result).ok, true);
  await f.finish(next);
  assert.ok(f.calls[1].threadId);
  assert.deepEqual(f.calls[1].options.mcpServers, []);
});

test('local workflow attaches only approved snapshots, dispatches the selected tools and exports its stage results', async (t) => {
  const f = await fixture(t);
  const { targetId } = f.route;
  const server = { id: 'docs', targetId, enabled: false, local: { url: 'http://127.0.0.1:7345/mcp', tools: ['search'] } };
  await f.data.changeExtensions({ op: 'save-server', server });
  await f.data.changeExtensions({ op: 'save-server', server: { ...server, enabled: true } });
  await mkdir(join(f.directory, 'docs'));
  await writeFile(join(f.directory, 'docs', 'brief.md'), '已明确授权的项目资料');
  await writeFile(join(f.directory, 'docs', 'other.txt'), '不属于阶段的文件');
  const attachments = await f.data.saveWorkflowAttachments([{ name: 'review.txt', data: Buffer.from('本机附件内容').toString('base64') }]);
  const stage = (id) => ({ id, name: id, provider: 'codex', model: '', instruction: '处理分配的任务' });
  const flow = { name: '本机分支归并', stages: [
    { ...stage('s1'), agent: { memory: 'isolated', mcpServers: [{ id: 'docs', targetId }], plugins: [] },
      fileAccess: { targetId, paths: ['docs/brief.md'], attachments } },
    { ...stage('s2'), model: 'gpt-6-sol' }, stage('s3'),
  ], edges: [{ from: 's1', to: 's3' }, { from: 's2', to: 's3' }] };
  const id = randomUUID();
  await f.data.changeWorkflows({ op: 'save', id, revision: null, draft: flow });
  const readRun = () => readWorkflowRun(f.data.preference(localWorkflowRunKey) ?? null);
  const runner = createWorkflowRunner({ resolveRoute: () => f.route, readModels: () => localModels,
    rpc: async (op, payload) => {
      const result = await f.request(op, payload);
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
      return result;
    },
    persist: (run) => f.data.setPreference(localWorkflowRunKey, JSON.stringify(run)),
    onChange() {}, canDispatch: () => true, pollInterval: 10 });
  t.after(() => runner.dispose());
  await runner.start(flow, '完成两路检查并汇总。', null, null, id);
  const run = await until(() => readRun()?.phase === 'complete' && readRun());
  const first = f.calls.find((call) => inputText(call.input).includes('已明确授权的项目资料'));
  assert.deepEqual(first.options.mcpServers.map(({ local }) => local.tools), [['search']]);
  assert.equal(first.options.workspace, 'private');
  assert.match(inputText(first.input), /本机附件内容/u);
  assert.doesNotMatch(inputText(first.input), /不属于阶段的文件|\/attachments|\/output/u);
  assert.match(inputText(f.calls.at(-1).input), /前置步骤「s1」[\s\S]+前置步骤「s2」/u);
  assert.equal((await f.request('list')).sessions.length, 0);
  const { sessionId, turnId } = run.rows[2];
  const query = { workflowRunId: run.id, sessionId, turnId };
  const artifact = (await f.request('workflow-artifacts', query)).files[0];
  assert.equal(artifact.path, '阶段结果.md');
  const file = (await f.request('workflow-artifacts', { ...query, path: artifact.path })).file;
  assert.match(Buffer.from(file.data, 'base64').toString('utf8'), /本机阶段产物/u);
  assert.equal((await f.request('workflow-artifacts', { ...query, turnId: randomUUID() })).code, 'workflow_output_changed');
  assert.equal((await f.request('send', { sessionId, turnId: randomUUID(), prompt: '冒充此阶段' })).code, 'mode_conflict');

  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), '不应读取');
  await symlink(outside, join(f.directory, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  const unsafe = { name: '重定向文件', stages: [{ ...stage('s1'), fileAccess: { targetId, paths: ['redirect/secret.txt'], attachments: [] } }], edges: [] };
  await f.data.changeWorkflows({ op: 'save', id, revision: 1, draft: unsafe });
  const count = f.calls.length;
  await runner.start(unsafe, '读取资料', null, null, id);
  await until(() => readRun()?.rows[0]?.state === 'failed');
  assert.equal(f.calls.length, count);
});

test('personal and project memory use the local target, explicit policy and private extraction', async (t) => {
  const f = await fixture(t);
  const { targetId } = f.route;
  await f.data.changeExtensions({ op: 'set-personal-memory', enabled: true });
  const basic = f.send('请记住图标尺寸为 64×64。', { projectMemory: { projectId: null } });
  await basic.result;
  await f.finish(basic);
  assert.equal(f.data.preference(localMemoryJournalKey), undefined);
  await f.data.changeExtensions({ op: 'set-scoped-personal-memory', targetId, enabled: true });
  await f.extraction({ op: 'set-memory-extraction-model', targetId, model: 'gpt-6-sol', effort: 'low' });
  const stated = f.send('确认图标尺寸为 64×64。', { projectMemory: { projectId: null } });
  assert.equal((await stated.result).ok, true);
  await f.finish(stated);
  await until(() => readExtensions(f.data.preference(extensionPreferenceKey)).memories.some(({ source }) => source?.turnId === stated.turnId));
  const extract = f.calls.find(({ input }) => inputText(input).startsWith('提炼用户明确'));
  assert.equal(extract.profile.model, 'gpt-6-sol');
  assert.equal(extract.options.workspace, 'private');
  assert.equal(f.data.preference(memoryJournalKey), undefined);

  const recall = f.send('沿用图标尺寸。', { projectMemory: { projectId: null } });
  assert.equal((await recall.result).ok, true);
  await f.finish(recall);
  assert.match(f.calls.find(({ input }) => inputText(input).startsWith('沿用图标尺寸')).input, /已启用的记忆[\s\S]+64×64/u);
  const sessionId = randomUUID();
  await f.data.changeExtensions({ op: 'set-conversation-isolation', targetId, sessionId, isolated: true });
  const isolated = f.send('独立上下文的图标尺寸。', { sessionId, projectMemory: { projectId: null } });
  assert.equal((await isolated.result).ok, true);
  await f.finish(isolated);
  assert.doesNotMatch(f.calls.find(({ input }) => inputText(input).startsWith('独立上下文')).input, /已启用的记忆/u);
});
