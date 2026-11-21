import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { localModels } from '../../desktop/codex-runtime.mjs';
import { openLocalSdk } from '../../local-sdk/service.mjs';

export async function createPreviewLocalSdk(access) {
  const root = await mkdtemp(join(tmpdir(), 'vps-workbench-preview-sdk-'));
  const directory = join(root, '示例工作目录');
  await mkdir(directory);
  const service = await openLocalSdk({
    root, models: localModels,
    credentialConfigured: () => true, canExecute: () => access().mode === 'execute',
    createThread(_profile, priorThreadId) {
      const id = priorThreadId ?? randomUUID();
      return { async runStreamed(prompt, { signal }) {
        const heading = priorThreadId ? '续聊演示' : '本机 SDK 演示';
        const message = { type: 'agent_message', id: 'preview-reply', text: '### ' + heading };
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: id };
          yield { type: 'turn.started' };
          await wait(100, undefined, { signal });
          yield { type: 'item.updated', item: message };
          await wait(700, undefined, { signal });
          yield { type: 'item.completed', item: { ...message,
            text: message.text + '\n\n收到 ' + prompt + '\n\n此回复由工作台的本地测试夹具生成。' } };
          yield { type: 'turn.completed' };
        })() };
      } };
    },
  });
  return {
    status: () => ({ ...service.status(), runtimeAvailable: true }),
    request(body) {
      if (body.op !== 'register') return service.request(body);
      const { name, model, effort } = body;
      return service.registerProfile({ name, model, effort, directory });
    },
    revokeExecution: service.revokeExecution,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
