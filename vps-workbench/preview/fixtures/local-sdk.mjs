import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { localModels } from '../../desktop/codex-runtime.mjs';
import { openLocalSdk } from '../../local-sdk/service.mjs';
import { createLocalWorkbench } from '../../local-sdk/workbench.mjs';
import { localBackends, providerDefaultModels, usesLocalControls } from '../../local-sdk/providers.mjs';

export async function createPreviewLocalSdk(access, { runtimeAvailable = () => true, personalSubscription = false, ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vps-workbench-preview-sdk-'));
  const directory = join(root, '示例工作目录');
  await mkdir(directory);
  const backends = new Map();
  const signedIn = new Set();
  for (const backend of Object.keys(localBackends)) {
    const service = await openLocalSdk({
    root: join(root, backend), backend, models: backend === 'codex' ? localModels : providerDefaultModels,
    personalSubscription,
    credentialConfigured: (profile) => runtimeAvailable(backend) &&
      (profile?.authMode !== 'subscription' || signedIn.has(profile.id)), canExecute: () => access().mode === 'execute',
    createThread(_profile, priorThreadId, { interaction } = {}) {
      const id = priorThreadId ?? randomUUID();
      return { async runStreamed(input, { signal }) {
        const prompt = typeof input === 'string' ? input : input.filter(({ type }) => type === 'text').map(({ text }) => text).join('\n');
        const heading = priorThreadId ? '续聊演示' : backend === 'codex' ? '本机 SDK 演示' : localBackends[backend].label + ' 演示';
        const message = { type: 'agent_message', id: 'preview-reply', text: '### ' + heading };
        let reply = message.text + '\n\n收到 ' + prompt + '\n\n此回复由工作台的本地测试夹具生成。';
        if (prompt.startsWith('以设计资料中明确')) {
          const fence = '\x60\x60\x60';
          reply = ['概览', '详情'].map((title, index) => fence + 'html\n<!doctype html><html><head><title>' + title +
            '</title><style>body{font:16px system-ui;padding:32px;background:#fbf5e9}</style></head>' +
            '<body><h1 id="heading">' + title + '</h1><button data-dsh-go="' + (index ? 1 : 2) + '">切换画板</button></body></html>\n' +
            fence).join('\n\n');
        } else if (prompt.includes('交接格式：只返回一个 JSON 对象')) {
          reply = JSON.stringify({ conclusion: backend === 'codex' ? '本机完成初稿。' : localBackends[backend].label + ' 完成阶段。', evidence: '依据本地演示简报。', pending: '待审校。' });
        } else if (prompt.startsWith('提炼用户明确')) {
          reply = JSON.stringify({ memories: [{ title: '演示偏好', text: '这是本机提炼夹具生成的笔记。' }] });
        }
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: id };
          yield { type: 'turn.started' };
          await wait(100, undefined, { signal });
          yield { type: 'item.updated', item: message };
          if (usesLocalControls(backend) && interaction && /补充|审批/.test(prompt)) {
            const arrival = Promise.withResolvers();
            interaction.steerWith(({ prompt: note }) => { arrival.resolve(note); return 'delivered'; });
            try {
              const supplement = await Promise.race([arrival.promise, wait(15000, '', { signal, ref: false })]);
              if (supplement) reply += '\n\n已收到补充 ' + supplement;
              if (prompt.includes('审批')) {
                const approval = await interaction.ask({ title: '读取工作目录中的文件', detail: '项目简报.md', kind: 'read', canAllow: true });
                await approval?.settle('submitted');
                reply += '\n\n工具决定 ' + (approval?.decision === 'allow' ? '已允许一次' : '已拒绝');
              }
            } finally { interaction.steerWith(null); }
          } else await wait(prompt === '本机停止轮' ? 4000 : 700, undefined, { signal });
          yield { type: 'item.completed', item: { ...message,
            text: reply } };
          yield { type: 'turn.completed', usage: { input_tokens: 248 } };
        })() };
      } };
    },
    });
    const workbench = createLocalWorkbench({ service, runtimeAvailable: () => runtimeAvailable(backend), backend, access, pollInterval: 100, ...options });
    backends.set(backend, { service, workbench, sdk: {
      get runtimeAvailable() { return runtimeAvailable(backend); },
    } });
  }
  function status() {
    const providers = [...backends.values()].map(({ service }) => {
      const current = service.status();
      return { ...current, runtimeAvailable: runtimeAvailable(current.backend), credentialSource: current.backend === 'antigravity' ? 'agy-local-login' :
        current.backend === 'claude-sdk' ? 'claude-api-key' : 'codex-api-key',
      ...(current.backend === 'claude-sdk' && personalSubscription && { personalSubscriptionAvailable: true }),
      profiles: current.profiles.map((profile) => ({ ...profile, backend: current.backend })) };
    });
    return { ...providers[0], providers, profiles: providers.flatMap(({ profiles }) => profiles) };
  }
  return {
    status, workflowRecords: backends,
    searchSnapshots: () => Array.from(backends.values()).flatMap(({ service }) => service.searchSnapshot()),
    async request(body, options) {
      const selected = backends.get(body?.backend ?? 'codex');
      if (!selected) return { ok: false, code: 'invalid_request' };
      const { service, workbench } = selected;
      if (['subscription-login', 'subscription-status'].includes(body.op)) {
        if (access().mode !== 'execute') return { ok: false, code: 'browse_only' };
        if (!personalSubscription || body.backend !== 'claude-sdk' || !service.status().profiles.some(({ id, authMode }) =>
          id === body.profileId && authMode === 'subscription')) return { ok: false, code: 'credential_unavailable' };
        if (body.op === 'subscription-status') return { ok: true, status: signedIn.has(body.profileId) ? 'signed_in' : 'sign_in_required' };
        signedIn.add(body.profileId);
        return { ok: true };
      }
      if (body.op === 'workbench' && body.location === 'local-sdk')
        return workbench.request(body.payload, options);
      if (body.op !== 'register') return service.request(body);
      const { name, model, effort, authMode } = body;
      const result = await service.registerProfile({ name, model, effort, directory,
        ...(Object.hasOwn(body, 'authMode') && { authMode }) });
      return result.ok ? { ...result, profile: status().profiles.find(({ id }) => id === result.profile.id) } : result;
    },
    revokeExecution() { for (const { service } of backends.values()) service.revokeExecution(); },
    changeExtractionModel: backends.get('codex').workbench.changeExtractionModel,
    async close() {
      for (const { workbench } of backends.values()) workbench.dispose();
      await Promise.all([...backends.values()].map(({ service }) => service.close()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
