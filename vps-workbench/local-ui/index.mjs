import { localWorkspaceStyles } from './styles.mjs';
import { ConnectionResult } from '../desktop/connection-panel.mjs';
import { TrialActions, trialResult, useConnectionTrial } from '../desktop/connection-trial.mjs';
import { trialPrompt, trialState } from '../desktop/setup-trial.mjs';
import { createSettingsDialog } from '../../remote-workbench/vps-chat/client/settings-dialog.js';

const location = 'local-sdk';
const backend = 'codex';
const pending = new Set(['queued', 'running', 'stopping']);
const safeRejections = new Set([
  'invalid_request', 'profile_not_found', 'session_conflict', 'browse_only', 'workbench_browse_only',
  'auth_required', 'runtime_unavailable', 'invalid_environment', 'invalid_directory', 'unknown_outcome', 'invalid_profile',
]);
const safeStartFailures = new Set(['invalid_environment', 'invalid_directory', 'start_failed']);
const labels = {
  queued: '等待运行', running: '生成中', stopping: '正在停止', completed: '已完成',
  failed: '运行失败', stopped: '已停止', unknown: '结果待确认',
};
const errors = {
  browse_only: '工作台处于仅浏览模式。',
  workbench_browse_only: '工作台处于仅浏览模式。',
  auth_required: '请配置本机 Codex API 密钥并检查账号权限。',
  network_error: '本机 Codex 无法连接模型服务。请检查本机网络和原回执。',
  stop_unconfirmed: '已请求停止。本轮结果尚未确认，可查询原回执。',
  runtime_unavailable: 'Codex SDK 运行时不可用。',
  invalid_environment: '当前环境无法启动 Codex SDK。',
  invalid_directory: '配置的本机工作目录不可用。',
  invalid_profile: '请选择受支持的模型和推理强度，并填写配置名称。',
  profile_not_found: '找不到此本机配置。',
  unknown_outcome: '此对话有一条待确认的回执。',
  start_failed: 'Codex SDK 未能启动本轮对话。',
  turn_failed: 'Codex SDK 报告本轮对话失败。',
  storage_unavailable: '暂时无法读取或写入本机回执。',
};
const unconfiguredProfile = { id: undefined };

function newTarget(profile = null) {
  return { sessionId: 'local-' + crypto.randomUUID(), profileId: profile?.id, targetId: profile?.targetId };
}

function requestBody(target, op, details) {
  const route = { location, backend, profileId: target.profileId, op };
  if (op === 'list') return route;
  return { ...route, targetId: target.targetId, sessionId: target.sessionId, ...details };
}

function sessionFrom(result, target, turnId, prompt) {
  const { session } = result ?? {};
  if (result?.ok !== true || result.location !== location || result.targetId !== target.targetId ||
      session?.id !== target.sessionId || session.profileId !== target.profileId ||
      session.mode !== 'chat' || !Array.isArray(session.turns)) return null;
  if (turnId && !session.turns.some((turn) => turn.id === turnId && (prompt === undefined || turn.prompt === prompt))) return null;
  return session;
}

function applySession(record, session) {
  let draft = record.draft;
  if (record.attempt) {
    const turn = session.turns.find(({ id }) => id === record.attempt.turnId);
    if (turn?.prompt !== record.attempt.prompt) return record;
    if (draft === record.attempt.prompt && !(turn.state === 'failed' && safeStartFailures.has(turn.code))) draft = '';
  } else if (!draft && record.session) {
    const running = new Set(record.session.turns.filter((turn) => pending.has(turn.state)).map(({ id }) => id));
    const rejected = session.turns.find((turn) =>
      running.has(turn.id) && turn.state === 'failed' && safeStartFailures.has(turn.code));
    if (rejected) draft = rejected.prompt;
  }
  return { ...record, session, draft, attempt: null, staleTurn: null, alert: '' };
}

function historyItems(profile, snapshot, records) {
  const rows = new Map((snapshot?.items ?? []).map((row) => [row.id, row]));
  for (const record of records.values()) {
    if (record.target.profileId !== profile.id) continue;
    const id = record.target.sessionId;
    if (record.session) {
      rows.set(id, { id, title: record.session.title, updatedAt: record.updatedAt ?? rows.get(id)?.updatedAt ?? '' });
    } else if (record.draft || record.attempt) {
      rows.set(id, { id, title: record.attempt ? '待确认的对话' : '草稿 · ' + record.draft.trim(), updatedAt: record.updatedAt });
    }
  }
  return [...rows.values()].sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
}

export function createLocalWorkspace(React, { MarkdownReply, icon }) {
  const h = React.createElement;
  const SettingsDialog = createSettingsDialog(React, { hostThemeLabel: '跟随系统' });

  function Button({ children, className = '', ...props }) {
    return h('button', { type: 'button', className: 'vc-button ' + className, ...props }, children);
  }

  function note(message, className = 'local-muted') {
    return h('p', { className }, message);
  }

  function Turn({ turn, stale, browsing, acting, refresh, stop, onStreamingRender }) {
    const state = stale ? 'unknown' : turn.state;
    return h('article', { className: 'local-turn', 'data-turn-state': state },
      h('div', { className: 'local-prompt', 'aria-label': '用户消息' }, turn.prompt),
      h('div', { className: 'local-response', 'aria-label': 'Codex 回复' },
        turn.reply && h(MarkdownReply, { source: turn.reply, streaming: pending.has(state), onStreamingRender }),
        h('div', { className: 'local-turn-status' },
          h('span', { className: 'local-muted' }, labels[state] ?? labels.unknown),
          errors[turn.code] && h('span', { className: 'local-alert' }, errors[turn.code]),
          state === 'unknown' && h(Button, { disabled: acting, onClick: refresh }, '查询回执'),
          !browsing && !stale && turn.canStop && h(Button, { disabled: acting, onClick: stop }, '停止'))));
  }

  return function LocalWorkspace({
    native, active, access, accessPending, changeAccess, newConversation, sendKey, appearance,
    onNewChat, defaultLocation, savePreference, settingsJump, navigateSettings, changeAppearance,
  }) {
    const [status, setStatus] = React.useState(null);
    const [statusError, setStatusError] = React.useState(false);
    const [statusBusy, setStatusBusy] = React.useState(false);
    const statusToken = React.useRef(null);
    const [target, setTarget] = React.useState(() => newTarget());
    const targetRef = React.useRef(target);
    const [records, setRecords] = React.useState(() => new Map());
    const recordsRef = React.useRef(records);
    const [histories, setHistories] = React.useState(() => new Map());
    const reads = React.useRef(new Map());
    const writes = React.useRef(new Map());
    const [historyOpen, setHistoryOpen] = React.useState(false);
    const [registerBusy, setRegisterBusy] = React.useState(false);
    const [settingsTab, setSettingsTab] = React.useState(false);
    const observedSettingsJump = React.useRef(null);
    const [registerError, setRegisterError] = React.useState('');
    const [name, setName] = React.useState('');
    const [modelId, setModelId] = React.useState('');
    const [effortId, setEffortId] = React.useState('');
    const epoch = React.useRef(newConversation);
    const lastProfile = React.useRef(null);
    const registering = React.useRef(false);
    const composing = React.useRef(false);
    const compositionEndedAt = React.useRef(-Infinity);
    const editor = React.useRef(null);
    const settingsEntry = React.useRef(null);
    const historyToggle = React.useRef(null);
    const feed = React.useRef(null);
    const follow = React.useRef(true);
    const historyId = React.useId();
    const profiles = status?.profiles;
    const models = status?.models ?? [];
    const model = models.find(({ id }) => id === modelId) ?? models[0];
    const effort = model?.efforts.includes(effortId) ? effortId : model?.defaultEffort;
    const profile = profiles?.find(({ id }) => id === target.profileId);
    const record = records.get(target.sessionId);
    const session = record?.session;
    const draft = record?.draft ?? '';
    const browsing = access?.mode !== 'execute';
    const trialTarget = profile && status?.runtimeAvailable && status.credentialConfigured && !statusError &&
      { profileId: profile.id, targetId: profile.targetId, model: profile.model, effort: profile.effort };
    const trial = useConnectionTrial({ storageKey: 'dsh-vps-chat:setup-trial:local-sdk:v1', savePreference,
      async request(kind, { target: at, sessionId, turnId }) {
        const packet = await native.localSdkRequest(requestBody({ ...at, sessionId },
          kind === 'start' ? 'send' : 'refresh', { turnId, ...(kind === 'start' && { prompt: trialPrompt }) }));
        if (packet?.ok !== true && ['auth_required', 'runtime_unavailable', 'invalid_directory', 'invalid_profile', 'browse_only']
          .includes(packet?.code)) return 'failed';
        return packet?.location === location && packet.targetId === at.targetId && packet.session?.profileId === at.profileId
          ? trialState(packet, { sessionId, turnId }, 'completed') : 'unknown';
      },
    });
    const invalidateTrial = trial.invalidate;
    React.useLayoutEffect(() => invalidateTrial(),
      [invalidateTrial, profile?.id, status?.runtimeAvailable, status?.credentialConfigured]);
    const bound = Boolean(session || record?.history || record?.attempt);
    const runningTurn = session?.turns.findLast((turn) => pending.has(turn.state));
    const canSend = active && !accessPending && !browsing && profile && !statusError &&
      status?.runtimeAvailable && status?.credentialConfigured &&
      !record?.attempt && !record?.staleTurn && !record?.historyLoading && (!bound || session?.canSend) && !runningTurn &&
      draft.trim() && draft.length <= 8192 && !draft.includes('\0');
    const ctrlEnter = sendKey === 'ctrl-enter';

    function updateRecord(at, change) {
      const next = new Map(recordsRef.current);
      const previous = next.get(at.sessionId) ?? { target: at, draft: '' };
      next.set(at.sessionId, change(previous));
      recordsRef.current = next;
      setRecords(next);
    }

    function choose(at) {
      targetRef.current = at;
      setTarget(at);
      follow.current = true;
    }

    function newChat() {
      setHistoryOpen(false);
      if (onNewChat) onNewChat();
      else {
        choose(newTarget(profile ?? lastProfile.current ?? profiles?.[0]));
        editor.current?.focus({ preventScroll: true });
      }
    }

    async function loadStatus() {
      const token = Symbol();
      statusToken.current = token;
      setStatusBusy(true);
      try {
        const next = await native.localSdkStatus();
        if (statusToken.current !== token) return;
        if (next?.ok !== true || next.location !== location || next.backend !== backend ||
            !Array.isArray(next.profiles) || !Array.isArray(next.models)) throw new Error('Invalid local SDK status');
        setStatus(next);
        setStatusError(false);
      } catch {
        if (statusToken.current === token) setStatusError(true);
      } finally {
        if (statusToken.current === token) setStatusBusy(false);
      }
    }

    React.useEffect(() => {
      if (active) void loadStatus();
      else setHistoryOpen(false);
      return () => { statusToken.current = null; };
    }, [active, native]);

    React.useLayoutEffect(() => {
      if (!active) {
        setSettingsTab(false);
      } else if (settingsJump && settingsJump !== observedSettingsJump.current) {
        observedSettingsJump.current = settingsJump;
        setSettingsTab(settingsJump.tab);
      }
    }, [active, settingsJump]);

    React.useEffect(() => {
      if (epoch.current === newConversation) return;
      epoch.current = newConversation;
      setHistoryOpen(false);
      choose(newTarget(profile ?? lastProfile.current ?? profiles?.[0]));
      if (active) editor.current?.focus({ preventScroll: true });
    }, [newConversation]);

    React.useEffect(() => {
      if (target.profileId || !profiles?.length || targetRef.current !== target) return;
      const next = { ...target, profileId: profiles[0].id, targetId: profiles[0].targetId };
      if (recordsRef.current.has(target.sessionId)) updateRecord(target, (previous) => ({ ...previous, target: next }));
      choose(next);
    }, [profiles, target]);

    React.useEffect(() => {
      if (profile) lastProfile.current = profile;
    }, [profile]);

    React.useEffect(() => {
      if (!active || !profiles?.length) return;
      let current = true;
      for (const item of profiles) {
        Promise.resolve().then(() => native.localSdkRequest(requestBody({ profileId: item.id }, 'list')))
          .then((result) => {
            if (!current) return;
            if (result?.ok !== true || result.location !== location || result.targetId !== item.targetId ||
                !Array.isArray(result.sessions)) throw new Error('Invalid local SDK history');
            setHistories((previous) => new Map(previous).set(item.id, { items: result.sessions }));
          }).catch(() => {
            if (current) setHistories((previous) => new Map(previous)
              .set(item.id, { items: previous.get(item.id)?.items, error: true }));
          });
      }
      return () => { current = false; };
    }, [active, profiles, native]);

    async function readReceipt(at, { op = 'refresh', turnId, prompt, quiet = false } = {}) {
      const id = at.sessionId;
      if (reads.current.has(id) || writes.current.has(id)) return;
      const token = Symbol();
      reads.current.set(id, token);
      if (!quiet) updateRecord(at, (prev) => ({ ...prev, querying: true, alert: '' }));
      try {
        const result = await native.localSdkRequest(requestBody(at, op, turnId ? { turnId } : undefined));
        if (reads.current.get(id) !== token) return;
        const snapshot = sessionFrom(result, at, turnId, prompt);
        if (!snapshot) throw new Error('Receipt unavailable');
        updateRecord(at, (prev) => ({ ...applySession(prev, snapshot), historyLoading: false, querying: false }));
      } catch {
        if (reads.current.get(id) !== token) return;
        updateRecord(at, (prev) => ({
          ...prev, historyLoading: false, querying: false,
          staleTurn: prev.attempt ? null : turnId ?? prev.staleTurn,
          alert: op === 'get' ? '暂时无法读取此本机对话。' : '暂时无法确认原始回执。',
        }));
      } finally {
        if (reads.current.get(id) === token) reads.current.delete(id);
      }
    }

    React.useEffect(() => {
      if (!active || browsing || !status?.credentialConfigured) return;
      const at = targetRef.current;
      const item = recordsRef.current.get(at.sessionId);
      if ((!item?.session && !item?.historyLoading) || item.attempt || item.staleTurn ||
          item.session?.canSend || item.session?.turns.some(({ state }) => state === 'unknown')) return;
      reads.current.delete(at.sessionId);
      void readReceipt(at, { op: 'get', quiet: true });
    }, [active, browsing, status?.credentialConfigured]);

    React.useEffect(() => {
      if (!active) return;
      const timer = setInterval(() => {
        for (const item of recordsRef.current.values()) {
          if (item.attempt || item.staleTurn) continue;
          const turn = item.session?.turns.findLast(({ state }) => pending.has(state));
          if (turn) void readReceipt(item.target, { turnId: turn.id, quiet: true });
        }
      }, 350);
      return () => clearInterval(timer);
    }, [active, native]);

    function followReply(force = false) {
      if (active && feed.current && (force || follow.current)) feed.current.scrollTop = feed.current.scrollHeight;
    }

    React.useLayoutEffect(() => { followReply(); }, [active, target, session, record?.attempt, record?.alert]);

    function selectHistory(item, configuration) {
      const at = { sessionId: item.id, profileId: configuration.id, targetId: configuration.targetId };
      const cached = recordsRef.current.get(item.id);
      if (cached && (cached.target.profileId !== at.profileId || cached.target.targetId !== at.targetId)) return;
      choose(cached?.target ?? at);
      setHistoryOpen(false);
      historyToggle.current?.focus({ preventScroll: true });
      if (!cached || (cached.history && !cached.session)) {
        updateRecord(at, (previous) => ({ ...previous, history: true, historyLoading: true, alert: '' }));
        void readReceipt(at, { op: 'get' });
      }
    }

    function switchProfile(at, nextProfile) {
      if (targetRef.current.sessionId !== at.sessionId || at.profileId === nextProfile.id || writes.current.has(at.sessionId)) return;
      const previous = recordsRef.current.get(at.sessionId);
      if (previous?.session || previous?.history || previous?.attempt) return;
      const next = newTarget(nextProfile);
      if (previous?.draft) {
        const updated = new Map(recordsRef.current);
        updated.delete(at.sessionId);
        updated.set(next.sessionId, { target: next, draft: previous.draft, updatedAt: previous.updatedAt });
        recordsRef.current = updated;
        setRecords(updated);
      }
      choose(next);
    }

    async function register(event) {
      event.preventDefault();
      if (browsing || accessPending || registering.current || !model || !effort || !name.trim()) return;
      const at = target;
      registering.current = true;
      setRegisterBusy(true);
      setRegisterError('');
      try {
        const result = await native.registerLocalSdkProfile({ name: name.trim(), model: model.id, effort });
        if (!result?.ok || !result.profile) {
          if (result?.code !== 'directory_cancelled') setRegisterError(errors[result?.code] ?? '本机配置未能保存。');
          return;
        }
        setStatus((previous) => {
          if (!previous) return previous;
          const items = new Map(previous.profiles.map((item) => [item.id, item]));
          return { ...previous, profiles: [...items.set(result.profile.id, result.profile).values()] };
        });
        switchProfile(at, result.profile);
        setName('');
      } catch {
        setRegisterError('本机配置未能保存。');
      } finally {
        registering.current = false;
        setRegisterBusy(false);
      }
    }

    async function send() {
      if (!canSend || targetRef.current !== target || writes.current.has(target.sessionId)) return;
      const at = target;
      const prompt = draft;
      const turnId = crypto.randomUUID();
      writes.current.set(at.sessionId, 'send');
      reads.current.delete(at.sessionId);
      follow.current = true;
      updateRecord(at, (prev) => ({ ...prev, updatedAt: new Date().toISOString(),
        attempt: { turnId, prompt, state: 'sending' }, querying: false, alert: '' }));
      try {
        const result = await native.localSdkRequest(requestBody(at, 'send', { turnId, prompt }));
        const snapshot = sessionFrom(result, at, turnId, prompt);
        if (snapshot) {
          updateRecord(at, (prev) => applySession(prev, snapshot));
        } else if (result?.ok === false && safeRejections.has(result.code)) {
          updateRecord(at, (prev) => ({
            ...prev, attempt: null, alert: errors[result.code] ?? '本轮消息被拒绝，草稿已保留。',
            session: result.code === 'unknown_outcome' && prev.session ? { ...prev.session, canSend: false } : prev.session,
          }));
          writes.current.delete(at.sessionId);
          if (result.code === 'unknown_outcome') void readReceipt(at, { op: 'get' });
        } else {
          throw new Error('Unconfirmed send');
        }
      } catch {
        updateRecord(at, (prev) => ({ ...prev, attempt: { turnId, prompt, state: 'unknown' },
          alert: '发送结果待确认。可以查询这次发送的原始回执。' }));
      } finally {
        writes.current.delete(at.sessionId);
      }
    }

    async function stop(turnId) {
      const at = target;
      if (!active || browsing || accessPending || writes.current.has(at.sessionId)) return;
      writes.current.set(at.sessionId, 'stop');
      reads.current.delete(at.sessionId);
      updateRecord(at, (prev) => ({ ...prev, stopping: true, querying: false, alert: '' }));
      try {
        const result = await native.localSdkRequest(requestBody(at, 'stop', { turnId }));
        const snapshot = sessionFrom(result, at, turnId);
        if (!snapshot) {
          if (result?.ok === false && ['browse_only', 'workbench_browse_only'].includes(result.code)) {
            updateRecord(at, (prev) => ({ ...prev, alert: errors[result.code] }));
            return;
          }
          throw new Error('Unconfirmed stop');
        }
        updateRecord(at, (prev) => applySession(prev, snapshot));
      } catch {
        updateRecord(at, (prev) => ({ ...prev, staleTurn: turnId, alert: '停止结果待确认。' }));
      } finally {
        writes.current.delete(at.sessionId);
        updateRecord(at, (prev) => ({ ...prev, stopping: false }));
      }
    }

    function onEditorKey(event) {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey !== ctrlEnter ||
          composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 ||
          event.timeStamp - compositionEndedAt.current < 40) return;
      if (canSend) {
        event.preventDefault();
        void send();
      }
    }

    function closeHistory() {
      setHistoryOpen(false);
      historyToggle.current?.focus({ preventScroll: true });
    }

    function showOptions() {
      setRegisterError('');
      setSettingsTab('connection');
    }

    const statusLine = statusError ? '状态读取失败' : !status ? '正在读取本机状态…' :
      `${status.runtimeAvailable ? 'SDK 可用' : 'SDK 不可用'} · ${status.credentialConfigured ? '凭据已配置' : '凭据未配置'}`;
    const modelLabel = (id) => models.find((item) => item.id === id)?.label ?? id;
    const optionsLabel = profile ? '配置 · ' + profile.name : '本机配置';
    const attempt = record?.attempt;
    const acting = Boolean(record?.querying || record?.stopping);
    const awaitingReceipt = attempt?.state === 'unknown' || Boolean(record?.staleTurn);
    const composerNote = awaitingReceipt ? '请查询原始回执' : attempt ? '等待发送回执' :
      browsing ? '仅浏览 · 草稿可编辑' : runningTurn ? 'Codex 正在生成回复' :
      ctrlEnter ? 'Ctrl+Enter 发送 · Enter 换行' : 'Enter 发送 · Shift+Enter 换行';
    const withoutProfile = historyItems(unconfiguredProfile, null, records);

    function historyRow(row, configuration) {
      return h('button', {
        type: 'button', key: row.id, className: 'local-history-row', title: row.title,
        'aria-current': row.id === target.sessionId ? 'true' : undefined,
        onClick: () => selectHistory(row, configuration),
      }, row.title);
    }

    return h('div', {
      'data-local-sdk': '', hidden: !active, inert: !active, 'data-history-open': String(historyOpen), 'data-tool-theme': 'codex',
      'data-vc-color': appearance?.color, 'data-vc-accent': appearance?.accent, 'data-vc-motion': appearance?.motion,
      'data-vc-text-size': appearance?.textSize, 'data-vc-width': appearance?.width,
      onKeyDown(event) {
        if (event.key === 'Escape' && historyOpen && !settingsTab && !event.nativeEvent.isComposing) {
          event.preventDefault();
          closeHistory();
        }
      },
    },
    h('style', null, localWorkspaceStyles),
    h('aside', { className: 'vc-rail', id: historyId, 'aria-label': '本地对话历史' },
      h('div', { className: 'local-rail-content' },
        h(Button, { className: 'local-new', onClick: newChat,
          title: defaultLocation && defaultLocation !== location ? '按默认位置新建对话' : '新建本地对话' },
        icon?.(h, 'new-chat'), '新建对话'),
        h('div', { className: 'local-history' },
          h('h2', null, '本地对话历史'),
          !profiles?.length && note('尚无本机配置。'),
          withoutProfile.length > 0 && h('section', null,
            h('h3', null, '未选配置的草稿'), withoutProfile.map((row) => historyRow(row, unconfiguredProfile))),
          profiles?.map((item) => {
            const history = histories.get(item.id);
            const rows = historyItems(item, history, records);
            return h('section', { key: item.id },
              h('h3', null, item.name),
              history?.error && note('历史读取失败。'),
              !rows.length && !history?.error && note(history ? '暂无对话' : '读取中…'),
              rows.map((row) => historyRow(row, item)));
          })))),
    historyOpen && h('button', { type: 'button', className: 'local-rail-scrim', tabIndex: -1, 'aria-label': '关闭历史', onClick: closeHistory }),
    h('main', { className: 'local-pane', 'aria-label': '本地 Codex SDK 对话' },
      h('header', { className: 'local-header' },
        h('div', { className: 'local-heading' },
          h('button', { type: 'button', ref: historyToggle, className: 'vc-button vc-history-toggle',
            'aria-expanded': historyOpen, 'aria-controls': historyId, onClick: () => setHistoryOpen((open) => !open) }, '历史'),
          h('div', null, h('h1', null, '本地 Codex SDK'), h('p', {
            className: 'local-muted local-subtitle local-nowrap',
            title: '本机配置状态。账户和网络以实际对话结果为准。',
          }, statusLine))),
        h('div', { className: 'local-actions' },
          h(Button, { ref: settingsEntry, onClick: showOptions, title: optionsLabel, 'aria-label': '设置', 'aria-haspopup': 'dialog' },
            icon?.(h, 'settings'), '设置'),
          h(Button, { disabled: accessPending, 'aria-pressed': browsing, title: browsing ? '切换为允许执行' : '切换为仅浏览',
            onClick: () => changeAccess?.({ ...access, mode: browsing ? 'execute' : 'browse' }) },
          browsing ? '仅浏览' : '允许执行'))),
      h('div', { ref: feed, className: 'local-feed', tabIndex: 0, 'aria-label': '对话内容',
        onScroll() {
          const node = feed.current;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        },
      }, session?.turns.length || attempt ? h('div', { className: 'local-wrap local-transcript' },
        session?.turns.map((turn) => h(Turn, {
          key: turn.id, turn, stale: record.staleTurn === turn.id, browsing, acting: acting || accessPending,
          onStreamingRender: followReply, stop: () => void stop(turn.id), refresh: () => void readReceipt(target, { turnId: turn.id }),
        })),
        attempt && h(Turn, { key: attempt.turnId, browsing, acting, stale: attempt.state === 'unknown',
          turn: { prompt: attempt.prompt, state: 'queued' },
          refresh: () => void readReceipt(target, { turnId: attempt.turnId, prompt: attempt.prompt }),
        })) : h('div', { className: 'local-wrap local-empty' },
        h('section', null,
          h('h2', null, record?.historyLoading ? '正在读取对话…' : record?.history ? '本地历史对话' : '开始本地对话'),
          record?.history && !record.historyLoading && h(Button, { onClick: () => void readReceipt(target, { op: 'get' }) }, '重新读取'),
          !record?.history && !profile && note('在配置中选择工作目录、模型和推理强度。'),
          !record?.history && profile && note(`${profile.name} · ${modelLabel(profile.model)} · ${profile.effort}`),
          !record?.history && status && note('凭据与 SDK 状态只反映本机配置。账户和网络尚未验证。')))),
      h('form', { className: 'local-wrap local-composer', onSubmit: (event) => { event.preventDefault(); void send(); } },
        record?.alert && h('p', { role: 'status', className: 'local-alert local-composer-note' }, record.alert),
        h('div', { className: 'local-composer-box' },
          h('textarea', { ref: editor, value: draft, rows: 2, maxLength: 8192, placeholder: '输入消息',
            'aria-label': '本地对话草稿', readOnly: Boolean(attempt),
            onChange: (event) => {
              const value = event.target.value;
              updateRecord(target, (prev) => ({ ...prev, draft: value, updatedAt: new Date().toISOString() }));
            },
            onKeyDown: onEditorKey, onCompositionStart: () => { composing.current = true; },
            onCompositionEnd: (event) => { composing.current = false; compositionEndedAt.current = event.timeStamp; },
          }),
          h('div', { className: 'local-composer-footer' },
            h('span', { className: 'local-muted' }, composerNote),
            h(Button, { type: 'submit', className: 'local-primary', disabled: !canSend }, '发送'))))),
    h(SettingsDialog, {
      tab: settingsTab, setTab: setSettingsTab, close: () => setSettingsTab(false), busy: registerBusy,
      settingsLabel: '设置', navigateLocation: navigateSettings, preferences: appearance, updatePreferences: changeAppearance,
      focusFallback: () => settingsEntry.current?.focus({ preventScroll: true }),
      localPanels: {
        connection: h(React.Fragment, null, connectionChecks(), profileFields()),
        tools: profileFields(),
        accounts: connectionChecks(),
        agents: note('本机 SDK 支持只读文本会话。Agent 预设、MCP 和提示词模板可在 VPS SSH 的设置中管理。'),
        memory: note('本机 Codex 历史保存在独立的本机配置中。项目记忆可在 VPS SSH 的设置中管理。'),
      },
    }));

    function connectionChecks() {
      return h(React.Fragment, null,
        h(Button, { disabled: statusBusy, onClick: () => void loadStatus() }, statusBusy ? '检查中' : '测试本机配置'),
        h('ol', { className: 'vc-setup-steps local-connection-checks' },
          h(ConnectionResult, { id: 'runtime', label: '本机 SDK',
            detail: '检查 Windows 上的 SDK 运行文件。', result: statusError
              ? { state: 'failed', detail: '本机 SDK 状态读取失败。请重试。' } : status && {
                state: status.runtimeAvailable ? 'passed' : 'failed',
                detail: status.runtimeAvailable ? '已找到本机 Codex SDK 和运行文件。' : '当前安装缺少本机 Codex 运行文件。',
              } }),
          h(ConnectionResult, { id: 'account', label: '本机账号凭据',
            detail: '检查本机进程的凭据配置。', result: status && !statusError ? {
              state: status.credentialConfigured ? 'confirm' : 'failed',
              detail: status.credentialConfigured ? '已配置本机 API 密钥，服务权限待试跑确认。' :
                '请在启动工作台的本机环境中配置 VPS_WORKBENCH_LOCAL_CODEX_API_KEY。',
            } : null }),
          h(ConnectionResult, { id: 'model', label: '本机模型目录',
            detail: '检查本机 SDK 支持的模型选项。', result: status && !statusError ? {
              state: models.length ? 'passed' : 'failed',
              detail: models.length ? `内置目录 · ${models.length} 个模型选项` : '当前本机 SDK 没有可选模型。',
            } : null }),
          h(ConnectionResult, { id: 'response', label: '实际模型响应', detail: '试跑使用所选配置的模型和本机网络。',
            result: trialResult(trial, trialTarget) },
          h(TrialActions, { trial, target: trialTarget, allowed: active && !browsing && !accessPending && !statusBusy }))));
    }

    function profileFields() {
      return h('div', { className: 'local-profile' },
        !bound && profiles?.length > 0 && h('label', null, '对话配置',
          h('select', { value: profile?.id ?? '',
            onChange: (event) => {
              const next = profiles.find(({ id }) => id === event.target.value);
              if (next) switchProfile(target, next);
            },
          }, profiles.map((item) => h('option', { key: item.id, value: item.id }, item.name)))),
        bound && note('此对话沿用原配置。新建对话后可选择其他配置。'),
        profile && h('dl', { className: 'local-config-details' },
          h('dt', null, '名称'), h('dd', null, profile.name),
          h('dt', null, '工作目录'), h('dd', null, profile.directory),
          h('dt', null, '默认模型'), h('dd', null, modelLabel(profile.model)),
          h('dt', null, '推理强度'), h('dd', null, profile.effort)),
        h('hr'),
        h('form', { className: 'local-register', onSubmit: (event) => void register(event) },
          h('h3', null, '注册本机配置'),
          h('label', null, '配置名称', h('input', { value: name, maxLength: 80, required: true,
            disabled: browsing || registerBusy, onChange: (event) => setName(event.target.value) })),
          h('div', { className: 'local-register-row' },
            h('label', null, '模型', h('select', { value: model?.id ?? '', disabled: browsing || registerBusy || !model,
              onChange: (event) => { setModelId(event.target.value); setEffortId(''); } },
            models.map((item) => h('option', { key: item.id, value: item.id }, item.label)))),
            h('label', null, '推理强度', h('select', { value: effort ?? '', disabled: browsing || registerBusy || !model,
              onChange: (event) => setEffortId(event.target.value) },
            model?.efforts.map((item) => h('option', { key: item, value: item }, item))))),
          registerError && h('div', { role: 'status', className: 'local-alert' }, registerError),
          h(Button, { type: 'submit', className: 'local-primary',
            disabled: browsing || accessPending || registerBusy || statusBusy || !status || !model || !name.trim() },
          registerBusy ? '正在选择工作目录…' : '选择工作目录并保存')));
    }
  };
}
