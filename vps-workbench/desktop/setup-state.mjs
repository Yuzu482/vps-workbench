import { readModelCatalog } from '../../remote-workbench/vps-chat/client/model-catalog.js';

export const setupConnectionKey = 'dsh-vps-chat:setup-connection:v1';
export function setupConnectionChanges(value, toolKey, tools) {
  if (typeof value !== 'string' || typeof tools !== 'string' || !/^dsh-vps-chat-tools:v1:[a-f0-9]{64}$/.test(toolKey)) {
    throw new Error('invalid_connection_preferences');
  }
  return { [setupConnectionKey]: value, [toolKey]: tools };
}

export const setupChecks = [
  ['ssh', 'SSH 连接与主机指纹', '核对主机指纹、SSH 登录和VPS 工作目录。'],
  ['egress', '预期 VPS 出口', '核对 IPv4、已配置的 IPv6 和执行端的服务路由。'],
  ['account', '账号登录', '检查 VPS 上所选执行端的登录状态或 API 密钥。'],
  ['model', '模型目录', '读取所选执行端的模型选项。'],
  ['response', '实际模型响应', '显式试跑后才会检查模型响应。'],
];

const accountDetails = {
  signed_in: 'VPS 上的执行端已识别当前登录。',
  key_configured: 'VPS 上已配置私有 API 密钥，服务权限待试跑确认。',
  manual: '已由用户确认在 VPS 登录，服务权限待试跑确认。',
};

export async function checkVpsConnection({ rpc, readList, settings, signal, updateStep,
  expectedTargetId, expectedMemoryTargetId, accountConfirmedFor, afterConfiguration, prepareAccount, selectModel = () => '' }) {
  let step = 'ssh';
  try {
    updateStep(step, 'checking', '正在使用已核对的主机指纹连接 VPS…');
    const list = readList(await rpc('configuration', { settings }, signal));
    signal.throwIfAborted();
    const { targetId } = list;
    if (expectedTargetId && targetId !== expectedTargetId || expectedMemoryTargetId && list.memoryTargetId !== expectedMemoryTargetId) {
      throw Object.assign(new Error('VPS 设置或主机指纹已变化。请重新核对并保存连接。'), { code: 'target_changed' });
    }
    afterConfiguration?.(list);
    async function probe(kind, mcpServers = []) {
      const reply = await rpc('setup-check', { settings, targetId, kind, mcpServers }, signal);
      signal.throwIfAborted();
      if (reply.targetId !== targetId) throw new Error('VPS 连接已变化，请重新检查。');
      return reply.status;
    }
    if (await probe('ssh') !== 'connected') throw new Error('VPS 未确认 SSH 连接。');
    updateStep(step, 'passed', 'SSH 指纹、用户认证和VPS 工作目录已核对。');

    step = 'egress';
    updateStep(step, 'checking', '正在核对 VPS 出口和执行端服务路由…');
    if (await probe('model') !== 'model_route_ready') throw new Error('VPS 未确认预期出口或执行端服务路由。');
    updateStep(step, 'passed', '预期出口与执行端服务路由已通过 VPS 预检。');

    step = 'account';
    const enabled = await prepareAccount?.(list);
    signal.throwIfAborted();
    if (enabled === false) {
      updateStep(step, 'failed', '请先为当前 VPS 启用所选执行端。', 'tool_disabled');
      return null;
    }
    updateStep(step, 'checking', '正在检查 VPS 上的执行端和登录状态…');
    const account = await probe('account');
    if (account === 'manual' && accountConfirmedFor !== targetId) {
      updateStep(step, 'confirm', '请确认已在 VPS 上登录。实际服务权限需通过模型试跑核验。');
      return { manualTarget: targetId };
    }
    if (!Object.hasOwn(accountDetails, account)) throw new Error('VPS 暂时无法确认账号状态。');
    updateStep(step, account === 'signed_in' ? 'passed' : account === 'manual' ? 'confirmed' : 'configured', accountDetails[account]);

    step = 'model';
    updateStep(step, 'checking', '正在读取执行端的模型选项…');
    const models = readModelCatalog(await rpc('models', { settings, targetId }, signal));
    signal.throwIfAborted();
    if (!models.length) throw new Error('当前执行端未返回可选模型。请检查 VPS 执行环境。');
    const model = selectSetupModel(models, selectModel(targetId));
    if (!model.ok) {
      updateStep(step, 'failed', model.message, 'model_unavailable');
      return null;
    }
    const source = ['claude', 'claude-sdk'].includes(settings.provider) ? '内置模型别名' : 'VPS 模型目录';
    updateStep(step, 'passed', `${model.name} · ${source}`);
    return { list, models, model, probe };
  } catch (error) {
    signal.throwIfAborted();
    updateStep(step, 'failed', error?.message || '检查未完成，请重试。', error?.code);
    return null;
  }
}

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
