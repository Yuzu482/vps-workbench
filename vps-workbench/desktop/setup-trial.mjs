export const trialPrompt = '连接试跑。请只回复 OK，无需读取文件、调用工具或访问其他网络服务。';

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
  const reply = (status) => ({ ok: true, ...receipt, status });
  if (!isAllowed()) return reply('unknown');
  if (kind === 'start') {
    const packet = await backend.request({ op: 'send', ...session, turnId, prompt: trialPrompt,
      ...(model && { model }), ...(effort && { effort }),
      workflowFiles: { paths: [], attachments: [] }, memoryIsolation: true }, { current: true });
    if (packet?.ok === false && ['invalid_request', 'invalid_settings', 'target_changed', 'relay_required'].includes(packet.code))
      return { ...reply('failed'), code: packet.code };
    return reply(trialState(packet, receipt, 'complete'));
  }
  const saved = await backend.request({ op: 'get', ...session }, { current: true });
  const state = trialState(saved, receipt, 'complete');
  if (state === 'failed' || state === 'passed' || !isAllowed()) return reply(state);
  if (!matchingTrialTurn(saved, receipt)) return reply('unknown');
  return reply(trialState(await backend.request({ op: 'refresh', ...session }, { current: true }), receipt, 'complete'));
}
