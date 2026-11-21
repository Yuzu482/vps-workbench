export const setupConnectionKey = 'dsh-vps-chat:setup-connection:v1';

const unavailablePreset = { ok: false, code: 'invalid_settings', message: '本机保存的 VPS 连接无法读取，请打开接入向导重新核对。' };

export async function readSetupPreset(raw, readList) {
  let saved;
  try { saved = JSON.parse(raw); } catch { return unavailablePreset; }
  if (!saved?.settings || !/^[a-f0-9]{64}$/.test(saved.targetId ?? '')) return unavailablePreset;
  const list = await readList(saved.settings);
  if (list?.ok !== true) return list ?? unavailablePreset;
  if (list.targetId !== saved.targetId) {
    return { ok: false, code: 'target_changed', message: '本机 SSH 指纹或 VPS 设置已变化。请重新核对后连接。' };
  }
  return { ok: true, preset: { ...list, settings: saved.settings, name: '本机保存的 VPS' } };
}

export const setupExampleTask = '为一家独立书店的周末读书会准备一份简短的活动页简报。活动面向首次到访的读者，免费报名，时长 60 分钟。只处理这段示例文字，无需访问文件、网络或工具。';

export function createSetupExample(provider, model) {
  const memory = { mcpServers: [], plugins: [], memory: 'isolated' };
  return {
    name: '接入示例 · 读书会活动页',
    stages: [
      { id: 'brief', name: '整理简报', provider, model, agent: memory,
        instruction: '只根据给定任务写三点活动页简报，覆盖受众、活动亮点和报名行动。直接输出文字。' },
      { id: 'review', name: '核对并汇总', provider, model, agent: memory,
        instruction: '核对上一阶段简报是否包含活动时长、费用和报名方式。输出可用的简报和至多两条待确认事项。' },
    ],
    edges: [{ from: 'brief', to: 'review' }],
  };
}
