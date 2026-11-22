import React from 'react';
import { workbenchStorage } from '../../remote-workbench/vps-chat/client/workbench-storage.js';

const h = React.createElement;
const states = ['pending', 'unknown', 'failed', 'passed'];
const outstanding = (receipt) => receipt?.state === 'pending' || receipt?.state === 'unknown';
const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

function readReceipt(key) {
  try {
    const saved = JSON.parse(workbenchStorage.getItem(key));
    if (saved && states.includes(saved.state) && id.test(saved.turnId) &&
        typeof saved.sessionId === 'string' && id.test(saved.sessionId.replace(/^local-/u, '')) &&
        typeof saved.target?.targetId === 'string') return saved;
  } catch {}
  return null;
}

export function useConnectionTrial({ storageKey, savePreference, request }) {
  const [receipt, setReceipt] = React.useState(() => readReceipt(storageKey));
  const last = React.useRef(receipt);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [fresh, setFresh] = React.useState(false);
  const generation = React.useRef(0);
  const running = React.useRef(false);
  const invalidate = React.useCallback(() => {
    generation.current++;
    setFresh(false);
  }, []);

  async function save(value) {
    await savePreference(storageKey, JSON.stringify(value));
    last.current = value;
    setReceipt(value);
  }

  async function act(kind, target) {
    if (running.current || (kind === 'start' ? !target || outstanding(last.current) : !last.current)) return;
    running.current = true;
    setBusy(true);
    setError('');
    const startedIn = generation.current;
    try {
      if (kind === 'start') {
        const prefix = target.profileId ? 'local-' : '';
        await save({ target, sessionId: prefix + crypto.randomUUID(), turnId: crypto.randomUUID(), state: 'unknown' });
      }
      const sent = last.current;
      let state = await request(kind, sent);
      for (let remaining = 3; state === 'pending' && remaining > 0; remaining--) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        state = await request('inspect', sent);
      }
      await save({ ...sent, state: states.includes(state) ? state : 'unknown' });
      if (startedIn === generation.current) setFresh(true);
    } catch {
      setError(outstanding(last.current) ? '试跑结果待确认。请查询原回执。' :
        '诊断记录未能保存。请检查本机存储后重试。');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return { receipt, busy, error, fresh, invalidate, start: (target) => act('start', target), inspect: () => act('inspect') };
}

export function TrialActions({ trial, target, allowed }) {
  const query = outstanding(trial.receipt);
  return h('div', { className: 'vc-setup-actions vc-trial-actions' },
    query ? h('button', { type: 'button', className: 'vc-button vc-settings-outline',
      onClick: trial.inspect, disabled: !allowed || trial.busy }, '查询原回执') :
      h('button', { type: 'button', className: 'vc-button vc-settings-outline',
        onClick: () => trial.start(target), disabled: !target || !allowed || trial.busy }, '试跑模型'),
    h('small', null, '试跑会新建诊断会话并消耗所用账号的额度。'),
    trial.error && h('small', { role: 'alert' }, trial.error));
}

export function trialResult(trial, target) {
  if (!trial) return null;
  const same = target && JSON.stringify(trial.receipt?.target) === JSON.stringify(target);
  if (!same) return outstanding(trial.receipt)
    ? { state: 'confirm', detail: '上一次试跑待确认。可查询发起试跑时的原回执。' } : null;
  if (trial.busy) return { state: 'checking', detail: '正在检查试跑回执…' };
  switch (trial.receipt.state) {
    case 'passed': return trial.fresh ? { state: 'passed', detail: '试跑已收到完整模型回复。' } :
      { state: 'confirm', detail: '上次试跑已收到回复。可重新试跑以确认当前状态。' };
    case 'failed': return { state: 'failed', detail: '试跑未收到完整回复。请核对账号额度、模型选项和网络。' };
    default: return { state: 'confirm', detail: '尚未收到完整回复。请查询原回执。' };
  }
}
