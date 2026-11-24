export const trialPrompt = '连接试跑。请只回复 OK，无需读取文件、调用工具或访问其他网络服务。';

export const trialDiagnostics = {
  invalid_request: '试跑参数无效。请重新检查模型与连接设置。',
  invalid_settings: '连接设置无效。请重新核对 SSH 配置。',
  target_changed: '原试跑的 VPS 或主机指纹已变化。请核对原连接。',
  relay_required: '原试跑的 SSH 中继不可用。请核对中继配置。',
  vps_python_missing: '本机 Python 不可用。请在连接检查中选择解释器。',
  bridge_not_ready: '本机 VPS 桥接组件不可用。请检查工作台安装。',
  storage_before_send: '本机未能保存试跑记录。请检查存储。',
  workbench_browse_only: '仅浏览模式下不能启动试跑。',
  launch_failed: 'VPS 未能启动试跑进程。请检查对应执行端和 SDK 安装。',
  sdk_setup: 'VPS 上的 Claude Agent SDK 或隔离运行环境初始化失败。请检查 VPS 后端安装和账号配置。',
  egress: '试跑时 VPS 出口或服务路由未通过校验。请核对预期出口。',
  oauth_org_not_allowed: 'Claude 拒绝当前订阅的 Claude Code 请求。请在 VPS 核对订阅与登录。',
  agy_setup: 'VPS 上 Antigravity 安装或服务域名配置不可用。',
  agy_auth: 'VPS 上 Antigravity 需要重新登录。',
  agy_acp: 'VPS 上 Antigravity ACP 未能启动或恢复。',
  agy_options: 'VPS 上 Antigravity 的所选模型或推理档位不可用。',
  mcp_setup: 'VPS 执行环境未能准备 MCP 服务。',
  remote_exit: 'VPS 试跑进程以错误状态结束。',
  stopped: '原试跑已停止。',
  empty_reply: '执行端已结束，但没有可用的回复文本。',
  timeout: '等待试跑回执超时。请查询原回执。',
};

export function boundedTrialDiagnostic(code, exitCode) {
  return {
    ...(Object.hasOwn(trialDiagnostics, code) && { code }),
    ...(Number.isInteger(exitCode) && exitCode !== 0 && Math.abs(exitCode) <= 255 && { exitCode }),
  };
}

function matchingTrialTurn(packet, { sessionId, turnId }) {
  const session = packet?.ok && packet.session;
  return session?.id === sessionId && Array.isArray(session.turns)
    ? session.turns.find((turn) => turn?.id === turnId && turn.prompt === trialPrompt) : undefined;
}

export function trialState(packet, receipt, completed) {
  const turn = matchingTrialTurn(packet, receipt);
  if (turn?.state === completed) return typeof turn.reply === 'string' && turn.reply.trim() ? 'passed' : 'failed';
  if (['failed', 'stopped'].includes(turn?.state)) return 'failed';
  return ['pending', 'queued', 'running', 'stopping'].includes(turn?.state) ? 'pending' : 'unknown';
}

export async function runSetupTrial(body, backend, isAllowed) {
  const { kind, settings, targetId, sessionId, turnId, model, effort } = body;
  const session = { settings, targetId, sessionId };
  const receipt = { targetId, sessionId, turnId };
  const reply = (status, diagnostic) => ({ ok: true, ...receipt, status, ...diagnostic });
  function observed(packet) {
    const status = trialState(packet, receipt, 'complete');
    if (packet?.ok === false) return reply(status, boundedTrialDiagnostic(packet.code));
    if (status !== 'failed') return reply(status);
    const turn = matchingTrialTurn(packet, receipt);
    const code = turn.state === 'stopped' ? 'stopped' : turn.state === 'complete' ? 'empty_reply' : turn.failureCode;
    return reply(status, boundedTrialDiagnostic(code, turn.exitCode));
  }
  if (!isAllowed()) return reply(kind === 'start' ? 'failed' : 'unknown');
  const options = { current: true, reportTimeout: true };
  if (kind === 'start') {
    const isolation = ['codex', 'antigravity'].includes(settings.provider) ? { workspaceAccess: 'isolated' } :
      { workflowFiles: { paths: [], attachments: [] } };
    const packet = await backend.request({ op: 'send', ...session, turnId, prompt: trialPrompt,
      ...(model && { model }), ...(effort && { effort }),
      ...isolation, memoryIsolation: true }, options);
    if (packet?.ok === false && ['invalid_request', 'invalid_settings', 'target_changed', 'relay_required',
      'vps_python_missing', 'bridge_not_ready', 'storage_before_send'].includes(packet.code)) {
      return reply('failed', boundedTrialDiagnostic(packet.code));
    }
    return observed(packet);
  }
  const saved = await backend.request({ op: 'get', ...session }, options);
  const state = trialState(saved, receipt, 'complete');
  if (state === 'failed' || state === 'passed' || !isAllowed() || saved?.ok === false) return observed(saved);
  if (!matchingTrialTurn(saved, receipt)) return reply('unknown');
  return observed(await backend.request({ op: 'refresh', ...session }, options));
}
