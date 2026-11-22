import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { localModels } from '../../desktop/codex-runtime.mjs';
import { openLocalSdk } from '../../local-sdk/service.mjs';
import { createLocalWorkbench } from '../../local-sdk/workbench.mjs';

export async function createPreviewLocalSdk(access, options) {
  const root = await mkdtemp(join(tmpdir(), 'vps-workbench-preview-sdk-'));
  const directory = join(root, '示例工作目录');
  await mkdir(directory);
  const service = await openLocalSdk({
    root, models: localModels,
    credentialConfigured: () => true, canExecute: () => access().mode === 'execute',
    createThread(_profile, priorThreadId) {
      const id = priorThreadId ?? randomUUID();
      return { async runStreamed(input, { signal }) {
        const prompt = typeof input === 'string' ? input : input.filter(({ type }) => type === 'text').map(({ text }) => text).join('\n');
        const heading = priorThreadId ? '续聊演示' : '本机 SDK 演示';
        const message = { type: 'agent_message', id: 'preview-reply', text: '### ' + heading };
        let reply = message.text + '\n\n收到 ' + prompt + '\n\n此回复由工作台的本地测试夹具生成。';
        if (prompt.startsWith('以设计资料中明确')) {
          const fence = '\x60\x60\x60';
          reply = ['概览', '详情'].map((title, index) => fence + 'html\n<!doctype html><html><head><title>' + title +
            '</title><style>body{font:16px system-ui;padding:32px;background:#fbf5e9}</style></head>' +
            '<body><h1 id="heading">' + title + '</h1><button data-dsh-go="' + (index ? 1 : 2) + '">切换画板</button></body></html>\n' +
            fence).join('\n\n');
        } else if (prompt.startsWith('提炼用户明确')) {
          reply = JSON.stringify({ memories: [{ title: '演示偏好', text: '这是本机提炼夹具生成的笔记。' }] });
        }
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: id };
          yield { type: 'turn.started' };
          await wait(100, undefined, { signal });
          yield { type: 'item.updated', item: message };
          await wait(prompt === '本机停止轮' ? 4000 : 700, undefined, { signal });
          yield { type: 'item.completed', item: { ...message,
            text: reply } };
          yield { type: 'turn.completed', usage: { input_tokens: 248 } };
        })() };
      } };
    },
  });
  const workbench = createLocalWorkbench({ service, runtimeAvailable: true, access, pollInterval: 100, ...options });
  return {
    status: () => ({ ...service.status(), runtimeAvailable: true }),
    request(body) {
      if (body.op === 'workbench' && body.location === 'local-sdk' && body.backend === 'codex')
        return workbench.request(body.payload);
      if (body.op !== 'register') return service.request(body);
      const { name, model, effort } = body;
      return service.registerProfile({ name, model, effort, directory });
    },
    revokeExecution: service.revokeExecution,
    changeExtractionModel: workbench.changeExtractionModel,
    async close() {
      workbench.dispose();
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
