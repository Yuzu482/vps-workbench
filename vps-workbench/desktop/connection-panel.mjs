import { t } from '../../remote-workbench/vps-chat/client/interface-language.js';
import React from 'react';
import { checkVpsConnection, setupChecks } from './setup-state.mjs';
import { TrialActions, trialResult, useConnectionTrial } from './connection-trial.mjs';

const h = React.createElement;
export const setupAccountActions = {
  codex: 'codex-login', claude: 'claude-api-key', 'claude-sdk': 'claude-login', antigravity: 'antigravity-login',
};
export const checkLabels = { waiting: '待检查', checking: '检查中', passed: '已通过', failed: '失败', confirm: '待确认',
  configured: '密钥已配置', confirmed: '已人工确认' };

export function ConnectionResult({ id, label, detail, result, children }) {
  const state = result?.state ?? 'waiting';
  return h('li', { className: 'vc-setup-step', 'data-state': state, 'aria-label': t(label) },
    h('div', { className: 'vc-setup-step-header' },
      h('span', { className: 'vc-setup-marker', 'aria-hidden': true }, state === 'passed' ? '✓' : state === 'failed' ? '!' : ''),
      h('strong', null, t(label)), h('span', { className: 'vc-setup-status' }, id === 'response' && state === 'waiting'
        ? t('未试跑') : t(checkLabels[state]))),
    h('p', { role: state === 'failed' ? 'alert' : undefined }, t(result?.detail ?? detail)), children);
}

export function vpsTrialTarget(settings, { list, models, model }, defaultModel) {
  const ordered = Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
  const entry = models.find(({ id }) => id === model.model);
  const effort = settings.provider === 'codex' && defaultModel?.targetId === list.targetId && defaultModel.id === model.model &&
    entry?.efforts.includes(defaultModel.effort) ? defaultModel.effort : undefined;
  return { settings: ordered, targetId: list.targetId, ...(model.model && { model: model.model }), ...(effort && { effort }) };
}

export function useVpsConnectionChecks({ rpc, readList, connection, scope, memoryTargetId, toolIds, profiles, remoteEnabled, visible, savePreference }) {
  const context = JSON.stringify([connection, scope, memoryTargetId, toolIds,
    Object.entries(profiles).map(([id, profile]) => [id, profile.model])]);
  const request = React.useRef(null);
  const [attempts, setAttempts] = React.useState({});
  const resultFor = (provider) => attempts[provider]?.context === context ? attempts[provider] : null;
  const trial = useConnectionTrial({ storageKey: 'dsh-vps-chat:setup-trial:ssh-vps:v1', savePreference,
    async request(kind, { target, sessionId, turnId }) {
      const { settings, targetId, ...model } = target;
      try {
        const reply = await rpc('setup-trial', { kind, settings, targetId, sessionId, turnId,
          ...(kind === 'start' && model) }, AbortSignal.timeout(115000));
        return reply.targetId === targetId && reply.sessionId === sessionId && reply.turnId === turnId ? reply.status : 'unknown';
      } catch (error) {
        if (kind === 'start' && ['workbench_browse_only', 'invalid_request'].includes(error.code)) return 'failed';
        throw error;
      }
    },
  });

  const invalidateTrial = trial.invalidate;
  const clear = React.useCallback(() => {
    request.current?.abort();
    request.current = null;
    setAttempts({});
    invalidateTrial();
  }, [invalidateTrial]);
  React.useLayoutEffect(() => {
    clear();
  }, [clear, context, visible, remoteEnabled]);
  React.useEffect(() => () => request.current?.abort(), []);

  async function test(accountConfirmedFor, provider = connection?.provider) {
    if (request.current || !visible || !remoteEnabled || !scope || !connection?.hostKeyConfirmed ||
        (provider !== connection.provider && !memoryTargetId)) return;
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    const settings = { ...connection, provider };
    const model = profiles[provider]?.model;
    setAttempts((previous) => ({ ...previous, [provider]: { context, checking: true, results: {} } }));
    function update(change) {
      setAttempts((previous) => signal.aborted || !previous[provider] ? previous :
        { ...previous, [provider]: change(previous[provider]) });
    }
    try {
      const checked = await checkVpsConnection({ rpc, readList, settings, signal,
        expectedTargetId: provider === connection.provider ? scope : undefined, expectedMemoryTargetId: memoryTargetId,
        accountConfirmedFor, prepareAccount: () => toolIds.includes(provider),
        selectModel: (targetId) => model?.targetId === targetId ? model.id : '',
        updateStep(id, state, detail, code) {
          update((previous) => ({ ...previous, results: { ...previous.results, [id]: { state, detail, code } } }));
        },
      });
      update((previous) => ({ ...previous, checked }));
    } catch {
      // The check helper already associates failures with the current step.
    } finally {
      if (request.current === controller) request.current = null;
      update((previous) => ({ ...previous, checking: false }));
    }
  }

  const current = resultFor(connection?.provider);
  const trialTarget = current?.checked?.model ? vpsTrialTarget(connection, current.checked, profiles[connection.provider]?.model) : null;
  return { clear, test, current, trial, trialTarget, resultFor,
    checking: Object.values(attempts).some((attempt) => attempt.context === context && attempt.checking) };
}

export function VpsConnectionChecks({ diagnostics, ready, dirty, busy, remoteEnabled, provider, openAccount, openTools, focusField }) {
  const { current, test, trial, trialTarget } = diagnostics;
  const action = (label, onClick, disabled) => h('button', {
    type: 'button', className: 'vc-button vc-settings-outline', onClick, disabled,
  }, label);
  const account = current?.results.account;
  const canTest = ready && !dirty && !busy && remoteEnabled && !diagnostics.checking;
  const status = current?.checking ? t('检查中') : current?.checked?.model ? '预检通过' :
    Object.values(current?.results ?? {}).some(({ state }) => state === 'failed') ? t('检查失败') :
      current?.checked?.manualTarget ? '待确认登录' : '未检查';

  return h('section', { className: 'vc-setup-group vc-connection-checks', 'aria-label': t('VPS 连接检查') },
    h('div', { className: 'vc-setup-overview' }, h('h4', null, '连接检查'),
      h('span', { role: 'status' }, status)),
    h('div', { className: 'vc-setup-actions' },
      action(t('测试连接'), () => void test(), !canTest),
      h('small', null, !remoteEnabled ? '仅浏览模式下可查看已保存的连接。' :
        !ready || dirty ? '保存当前连接配置后即可测试。' : '检查 SSH、出口、账号和目录。')),
    h('ol', { className: 'vc-setup-steps' }, setupChecks.map(([id, label, detail]) => {
      const result = id === 'response' ? trialResult(trial, !dirty && trialTarget) : current?.results[id];
      let repair = null;
      if (result?.state === 'failed' && id === 'ssh') {
        const field = result.code === 'setup_workspace_unavailable' ? 'workspace' :
          result.code === 'target_changed' ? 'knownHostsPath' : 'host';
        repair = action('检查 SSH 配置', () => focusField(field), busy);
      } else if (result?.state === 'failed' && id === 'egress') {
        repair = action('核对预期出口', () => focusField('expectedIpv4'), busy);
      } else if (id === 'account' && ['failed', 'confirm'].includes(account?.state)) {
        repair = account.code === 'tool_disabled' ? action(t('启用此执行端'), openTools, busy) :
          h('div', { className: 'vc-setup-actions' },
          action(provider === 'claude' ? t('设置 VPS 密钥') : t('在 VPS 登录'), () => openAccount(setupAccountActions[provider]), !canTest),
          current?.checked?.manualTarget && action(t('已在 VPS 登录，继续检查'), () => void test(current.checked.manualTarget), !canTest));
      } else if (id === 'model' && result?.state === 'failed') {
        repair = action('检查模型设置', openTools, busy);
      } else if (id === 'response') {
        repair = h(TrialActions, { trial, target: !dirty && trialTarget, allowed: remoteEnabled && !busy });
      }
      return h(ConnectionResult, { key: id, id, label, detail, result }, repair);
    })));
}
