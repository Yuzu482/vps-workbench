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

export function selectSetupModel(catalog, requested = '') {
  const selected = requested ? catalog.find(({ id }) => id === requested) : catalog.find(({ isDefault }) => isDefault);
  if (requested && !selected) return { ok: false, message: `模型 ${requested} 已不在当前模型选项中。` };
  return { ok: true, model: selected?.id ?? '', name: selected?.displayName ?? '执行端默认模型' };
}

export function createSetupExample(provider, model) {
  const memory = { mcpServers: [], plugins: [], memory: 'isolated' };
  const facts = '以原始用户任务为准，保留「首次到访的读者」「免费报名」「60 分钟」。原始任务没有提供报名渠道，将报名渠道写为「待确认」。';
  return {
    name: '接入示例 · 读书会活动页',
    stages: [
      { id: 'brief', name: '整理简报', provider, model, agent: memory,
        instruction: `根据原始用户任务写三点活动页简报，覆盖受众、活动内容与时长、报名信息。${facts}直接输出文字。` },
      { id: 'review', name: '核对并汇总', provider, model, agent: memory,
        instruction: `把上一阶段简报与原始用户任务逐项核对，并纠正遗漏或新增的事实。${facts}输出核对后的简报和至多两条待确认事项。` },
    ],
    edges: [{ from: 'brief', to: 'review' }],
  };
}
