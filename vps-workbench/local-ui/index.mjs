import { localWorkspaceStyles } from './styles.mjs';
import { ConnectionResult } from '../desktop/connection-panel.mjs';
import { TrialActions, trialResult, useConnectionTrial } from '../desktop/connection-trial.mjs';
import { trialPrompt, trialState } from '../desktop/setup-trial.mjs';
import { effortName } from '../../remote-workbench/vps-chat/client/model-catalog.js';
import { createSettingsDialog } from '../../remote-workbench/vps-chat/client/settings-dialog.js';
import { workbenchStorage } from '../../remote-workbench/vps-chat/client/workbench-storage.js';

const location = 'local-sdk';
const backend = 'codex';
const newProfileKey = 'dsh-vps-chat:local-new-profile:v1';
const sdkCheckBinding = (profile, status) => JSON.stringify([profile?.id, profile?.targetId,
  status?.runtimeAvailable, status?.credentialConfigured, status?.models]);
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

  function note(message) {
    return h('p', { className: 'local-muted' }, message);
  }

  function Turn({ turn, stale, browsing, acting, refresh, stop, onStreamingRender }) {
    const state = stale ? 'unknown' : turn.state;
    return h('article', { className: 'vc-turn', 'data-turn-state': state },
      h('div', { className: 'vc-user vc-text', 'aria-label': '用户消息', dir: 'auto' }, turn.prompt),
      h('div', { className: 'vc-answer', 'aria-label': 'Codex 回复' },
        h('div', { className: 'vc-answer-head' },
          h('strong', null, 'Codex'),
          h('span', { className: 'vc-answer-state', 'data-state': state }, labels[state] ?? labels.unknown),
          state === 'unknown' && h(Button, { className: 'vc-settings-outline', disabled: acting, onClick: refresh }, '查询回执'),
          !browsing && !stale && turn.canStop && stop && h(Button, { disabled: acting, onClick: stop }, '停止')),
        turn.reply && h(MarkdownReply, { source: turn.reply, streaming: pending.has(state), onStreamingRender }),
        errors[turn.code] && h('p', { className: 'vc-feedback' }, errors[turn.code])));
  }

  return function LocalWorkspace({
    native, active, access, accessPending, changeAccess, newConversation, sendKey, appearance,
    onNewChat, defaultLocation, savePreference, settingsSurface, changeAppearance,
  }) {
    const [status, setStatus] = React.useState(null);
    const [statusError, setStatusError] = React.useState(false);
    const [statusBusy, setStatusBusy] = React.useState(false);
    const [checkedBinding, setCheckedBinding] = React.useState(null);
    const [settingsProfileId, setSettingsProfileId] = React.useState(null);
    const [defaultProfileId, setDefaultProfileId] = React.useState(() => workbenchStorage.getItem(newProfileKey));
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
    const settingsTab = settingsSurface.tab;
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
    const historyToggle = React.useRef(null);
    const feed = React.useRef(null);
    const follow = React.useRef(true);
    const historyId = React.useId();
    const hintId = React.useId();
    const profiles = status?.profiles;
    const models = status?.models ?? [];
    const model = models.find(({ id }) => id === modelId) ?? models[0];
    const effort = model?.efforts.includes(effortId) ? effortId : model?.defaultEffort;
    const profile = profiles?.find(({ id }) => id === target.profileId);
    const defaultProfile = profiles?.find(({ id }) => id === defaultProfileId);
    const settingsProfile = profiles?.find(({ id }) => id === settingsProfileId) ?? profile ?? defaultProfile ?? profiles?.[0];
    const binding = sdkCheckBinding(settingsProfile, status);
    const confirmedStatus = checkedBinding === binding && !statusError ? status : null;
    const record = records.get(target.sessionId);
    const session = record?.session;
    const draft = record?.draft ?? '';
    const browsing = access?.mode !== 'execute';
    const trialTarget = settingsProfile && status?.runtimeAvailable && status.credentialConfigured && !statusError &&
      { profileId: settingsProfile.id, targetId: settingsProfile.targetId, model: settingsProfile.model, effort: settingsProfile.effort };
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
      [invalidateTrial, settingsProfile?.id, status?.runtimeAvailable, status?.credentialConfigured]);
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
        choose(newTarget(defaultProfile ?? profile ?? lastProfile.current ?? profiles?.[0]));
        editor.current?.focus({ preventScroll: true });
      }
    }

    async function loadStatus(check = false) {
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
        if (check) setCheckedBinding(sdkCheckBinding(settingsProfile, next));
      } catch {
        if (statusToken.current === token) setStatusError(true);
      } finally {
        if (statusToken.current === token) setStatusBusy(false);
      }
    }

    const needsStatus = active || ['connection', 'tools', 'accounts'].includes(settingsTab);
    React.useEffect(() => {
      if (needsStatus) void loadStatus();
      return () => { statusToken.current = null; };
    }, [needsStatus, native]);

    React.useLayoutEffect(() => {
      if (!active) setHistoryOpen(false);
    }, [active]);

    React.useEffect(() => {
      if (epoch.current === newConversation) return;
      epoch.current = newConversation;
      setHistoryOpen(false);
      choose(newTarget(defaultProfile ?? profile ?? lastProfile.current ?? profiles?.[0]));
      if (active) editor.current?.focus({ preventScroll: true });
    }, [newConversation]);

    React.useEffect(() => {
      if (target.profileId || !profiles?.length || targetRef.current !== target) return;
      const initial = defaultProfile ?? profiles[0];
      const next = { ...target, profileId: initial.id, targetId: initial.targetId };
      if (recordsRef.current.has(target.sessionId)) updateRecord(target, (previous) => ({ ...previous, target: next }));
      choose(next);
    }, [profiles, defaultProfile, target]);

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

    React.useLayoutEffect(() => {
      if (!active || !feed.current) return;
      if (session?.turns.length || record?.attempt) followReply();
      else feed.current.scrollTop = 0;
    }, [active, target, session, record?.attempt, record?.alert]);

    function selectHistory(item, configuration) {
      const at = { sessionId: item.id, profileId: configuration.id, targetId: configuration.targetId };
      const cached = recordsRef.current.get(item.id);
      if (cached && (cached.target.profileId !== at.profileId || cached.target.targetId !== at.targetId)) return;
      choose(cached?.target ?? at);
      if (historyOpen) closeHistory();
      if (!cached || (cached.history && !cached.session)) {
        updateRecord(at, (previous) => ({ ...previous, history: true, historyLoading: true, alert: '' }));
        void readReceipt(at, { op: 'get' });
      }
    }

    async function register(event) {
      event.preventDefault();
      if (browsing || accessPending || registering.current || !model || !effort || !name.trim()) return;
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
        setSettingsProfileId(result.profile.id);
        setName('');
      } catch {
        setRegisterError('本机配置未能保存。');
      } finally {
        registering.current = false;
        setRegisterBusy(false);
      }
    }

    async function setNewProfile() {
      if (!settingsProfile || browsing || accessPending) return;
      try {
        await savePreference(newProfileKey, settingsProfile.id);
        setDefaultProfileId(settingsProfile.id);
        setRegisterError('');
      } catch { setRegisterError('新聊天的本机配置未能保存。'); }
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
      const toggle = historyToggle.current;
      const trigger = toggle?.closest('#root')?.querySelector('.desktop-sidebar-button') ?? toggle;
      trigger?.focus({ preventScroll: true });
    }

    function showOptions() {
      setRegisterError('');
      settingsSurface.open('connection');
    }

    const statusLine = statusError ? '状态读取失败' : !status ? '正在读取本机状态…' :
      `${status.runtimeAvailable ? 'SDK 可用' : 'SDK 不可用'} · ${status.credentialConfigured ? '凭据已配置' : '凭据未配置'}`;
    const modelLabel = (id) => models.find((item) => item.id === id)?.label ?? id;
    const profileModel = profile ? modelLabel(profile.model) : '未配置模型';
    const profileEffort = profile ? effortName(profile.effort) : null;
    const accessLabel = browsing ? '仅浏览' : '允许执行';
    const attempt = record?.attempt;
    const acting = Boolean(record?.querying || record?.stopping);
    const composerStop = !browsing && runningTurn && runningTurn.id !== record?.staleTurn &&
      (runningTurn.canStop || record.stopping || runningTurn.state === 'stopping');
    const awaitingReceipt = attempt?.state === 'unknown' || Boolean(record?.staleTurn);
    const composerNote = awaitingReceipt ? '请查询原始回执' : attempt ? '等待发送回执' :
      browsing ? '仅浏览 · 草稿可编辑' : runningTurn ? 'Codex 正在生成回复' :
      ctrlEnter ? 'Ctrl+Enter 发送 · Enter 换行' : 'Enter 发送 · Shift+Enter 换行';
    const withoutProfile = historyItems(unconfiguredProfile, null, records);

    function historyRow(row, configuration) {
      return h('button', {
        type: 'button', key: row.id, className: 'vc-session', title: row.title,
        'aria-current': row.id === target.sessionId ? 'true' : undefined,
        onClick: () => selectHistory(row, configuration),
      }, h('span', { className: 'vc-session-title' }, row.title));
    }

    function vpsSettingsLink(tab, message, label) {
      return h('section', { className: 'vc-settings-group' },
        note(message),
        h(Button, { className: 'vc-settings-outline', onClick: () => settingsSurface.navigate('ssh-vps', tab) }, label));
    }

    const settings = h(SettingsDialog, {
      tab: settingsTab, setTab: settingsSurface.setTab, close: settingsSurface.close, busy: registerBusy,
      settingsLabel: '设置', navigateLocation: settingsSurface.navigate, preferences: appearance, updatePreferences: changeAppearance,
      restoreFocus: settingsSurface.restoreFocus,
      localPanels: {
        connection: h(React.Fragment, null, profileFields(), connectionChecks()),
        tools: h('section', { className: 'vc-settings-group', 'aria-label': '本机配置摘要' },
          profileSummary(),
          h(Button, { className: 'vc-settings-outline', onClick: () => settingsSurface.setTab('connection') }, '编辑本机配置')),
        accounts: accountDetails(),
        'tool-overrides': vpsSettingsLink('tool-overrides',
          '本机 Codex 使用通用应用偏好。VPS SSH 执行端可单独覆盖。', '打开 VPS 执行端偏好'),
        agents: vpsSettingsLink('agents', 'Agent 预设用于 VPS SSH 的工作流。', '打开 VPS Agent 预设'),
        mcp: vpsSettingsLink('mcp', '工作台 MCP 服务由支持它的 VPS SSH 执行端使用。', '打开 VPS MCP 服务器'),
        plugins: vpsSettingsLink('plugins', '提示词模板可插入 VPS SSH 对话草稿，也可用于其工作流。', '打开 VPS 提示词模板'),
        memory: vpsSettingsLink('memory', '个人自动记忆、项目记忆和手动记忆适用于 VPS SSH。', '打开 VPS 记忆'),
      },
    });
    return h('div', {
      'data-local-sdk': '', hidden: !active, inert: !active, 'data-tool-theme': 'codex',
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
    h('aside', { className: 'vc-rail', id: historyId, 'aria-label': '本地对话历史', 'data-open': historyOpen },
      h('div', { className: 'vc-rail-content' },
        h('div', { className: 'vc-new-actions' },
          h(Button, { className: 'vc-new vc-primary', onClick: newChat,
            title: defaultLocation && defaultLocation !== location ? '按默认位置新建对话' : '新建本地对话' },
          h('span', { className: 'vc-menu-label' }, icon(h, 'new-chat'), '新聊天'))),
        h('nav', { className: 'vc-list', 'aria-label': '会话记录' },
          h('h2', { className: 'vc-rail-label vc-session-list-heading' }, '会话'),
          !profiles?.length && note('尚无本机配置。'),
          withoutProfile.length > 0 && h('section', { className: 'local-history-group' },
            h('h3', { className: 'vc-rail-label' }, '未选配置的草稿'), withoutProfile.map((row) => historyRow(row, unconfiguredProfile))),
          profiles?.map((item) => {
            const history = histories.get(item.id);
            const rows = historyItems(item, history, records);
            return h('section', { key: item.id, className: 'local-history-group' },
              h('h3', { className: 'vc-rail-label' }, item.name),
              history?.error && note('历史读取失败。'),
              !rows.length && !history?.error && note(history ? '暂无对话' : '读取中…'),
              rows.map((row) => historyRow(row, item)));
          })))),
    historyOpen && h('button', { type: 'button', className: 'local-rail-scrim', tabIndex: -1, 'aria-label': '关闭历史', onClick: closeHistory }),
    h('div', { className: 'vc-sidebar-actions', role: 'group', 'aria-label': '本机操作' },
      h('div', { className: 'vc-tool-picker' },
        h('div', { className: 'vc-tool-summary' },
          h('span', { className: 'vc-tool-badge' }, icon(h, 'codex')),
          h('span', { className: 'vc-tool-label' }, 'Codex'))),
      h(Button, { className: 'vc-sidebar-settings', onClick: showOptions,
        title: profile ? '配置 · ' + profile.name : '本机配置', 'aria-label': '设置', 'aria-haspopup': 'dialog' },
      icon(h, 'settings'), '设置')),
    h('main', { className: 'vc-main', 'aria-label': '本地 Codex SDK 对话' },
      h('header', { className: 'vc-header' },
        h('button', { type: 'button', ref: historyToggle, className: 'vc-button vc-history-toggle',
          'aria-expanded': historyOpen, 'aria-controls': historyId, onClick: () => setHistoryOpen((open) => !open) }, '历史'),
        h('div', { className: 'vc-heading' },
          h('h1', null, '本地 Codex SDK'),
          h('div', { className: 'vc-route', 'data-ready': !statusError && status?.runtimeAvailable && status.credentialConfigured }, h('span', {
            className: 'vc-route-status', role: 'status',
            title: '本机配置状态。账户和网络以实际对话结果为准。',
          }, statusLine)))),
      h('div', { ref: feed, className: 'vc-scroll', role: 'region', tabIndex: 0, 'aria-label': '对话内容',
        onScroll() {
          const node = feed.current;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        },
      }, h('div', { className: 'vc-body' }, session?.turns.length || attempt ? h(React.Fragment, null,
        session?.turns.map((turn) => h(Turn, {
          key: turn.id, turn, stale: record.staleTurn === turn.id, browsing, acting: acting || accessPending,
          onStreamingRender: followReply, stop: composerStop && turn.id === runningTurn.id ? undefined : () => void stop(turn.id),
          refresh: () => void readReceipt(target, { turnId: turn.id }),
        })),
        attempt && h(Turn, { key: attempt.turnId, browsing, acting, stale: attempt.state === 'unknown',
          turn: { prompt: attempt.prompt, state: 'queued' },
          refresh: () => void readReceipt(target, { turnId: attempt.turnId, prompt: attempt.prompt }),
        })) : h('div', { className: 'vc-welcome' },
        h('h2', null, record?.historyLoading ? '正在读取对话…' : record?.history ? '本地历史对话' : '开始一段对话'),
        record?.history && !record.historyLoading && h(Button, { className: 'vc-example',
          onClick: () => void readReceipt(target, { op: 'get' }) }, '重新读取'),
        !record?.history && h('p', null, profile ? '给本机 Codex 发消息，使用只读工作目录。' : '配置工作目录和模型后开始聊天。'),
        !record?.history && !profile && h(Button, { className: 'vc-example', onClick: showOptions }, '配置本机 SDK')))),
      h('div', { className: 'vc-compose-area' }, h('div', { className: 'vc-compose-wrap' },
        record?.alert && h('div', { role: 'status', className: 'vc-feedback' }, record.alert),
        h('form', { className: 'vc-composer', onSubmit: (event) => { event.preventDefault(); void send(); } },
          h('textarea', { ref: editor, value: draft, rows: 2, maxLength: 8192,
            placeholder: profile ? '给 Codex 发消息' : '配置本机 SDK 后可发送消息',
            'aria-label': '本地对话草稿', 'aria-describedby': hintId, readOnly: Boolean(attempt),
            onChange: (event) => {
              const value = event.target.value;
              updateRecord(target, (prev) => ({ ...prev, draft: value, updatedAt: new Date().toISOString() }));
            },
            onKeyDown: onEditorKey, onCompositionStart: () => { composing.current = true; },
            onCompositionEnd: (event) => { composing.current = false; compositionEndedAt.current = event.timeStamp; },
          }),
          h('div', { className: 'vc-composer-toolbar' },
            h(Button, { className: 'vc-composer-option', 'data-control': 'access', 'data-browse': browsing,
              disabled: accessPending, 'aria-label': accessLabel, 'aria-pressed': browsing,
              title: browsing ? '切换为允许执行' : '切换为仅浏览',
              onClick: () => changeAccess?.({ ...access, mode: browsing ? 'execute' : 'browse' }) },
            icon(h, 'access'), h('span', { className: 'vc-option-label' }, accessLabel)),
            h('div', { className: 'vc-composer-end' },
              h('span', { className: 'vc-composer-option', 'data-control': 'model',
                title: profileEffort ? `${profileModel} · ${profileEffort}` : profileModel },
              h('span', { className: 'vc-option-label' }, profileModel),
              profileEffort && h('span', { className: 'vc-option-effort' }, profileEffort)),
              h('div', { className: 'vc-compose-buttons' }, composerStop ? h(Button, {
                className: 'vc-compose-action vc-compose-icon-button vc-compose-stop',
                disabled: acting || accessPending || !runningTurn.canStop, onClick: () => void stop(runningTurn.id),
                'aria-busy': Boolean(record.stopping), 'aria-label': '停止', title: '停止',
              }, h('span', { className: 'vc-compose-icon', 'aria-hidden': true })) : h(Button, {
                type: 'submit', className: 'vc-primary vc-compose-action vc-compose-icon-button',
                disabled: !canSend, 'aria-label': '发送', title: '发送',
              }, h('span', { className: 'vc-compose-icon', 'data-symbol': 'send', 'aria-hidden': true })))))),
        h('p', { id: hintId, className: 'vc-compose-hint', role: 'status' }, composerNote)))),
    active ? settings : settingsSurface.show(settings, { 'data-local-sdk': '', 'data-tool-theme': 'codex',
      'data-vc-color': appearance?.color, 'data-vc-accent': appearance?.accent, 'data-vc-motion': appearance?.motion }));

    function connectionChecks() {
      const checked = confirmedStatus;
      return h('section', { className: 'vc-setup-group vc-connection-checks', 'aria-label': '本机连接检查' },
        h('div', { className: 'vc-setup-overview' }, h('h4', null, '连接检查')),
        h('div', { className: 'vc-setup-actions' },
          h(Button, { className: 'vc-settings-outline', disabled: statusBusy, onClick: () => void loadStatus(true) },
            statusBusy ? '检查中' : '测试本机配置')),
        h('ol', { className: 'vc-setup-steps' },
          h(ConnectionResult, { id: 'runtime', label: '本机 SDK',
            detail: '检查 Windows 上的 SDK 运行文件。', result: statusError
              ? { state: 'failed', detail: '本机 SDK 状态读取失败。请重试。' } : checked && {
                state: checked.runtimeAvailable ? 'passed' : 'failed',
                detail: checked.runtimeAvailable ? '已找到本机 Codex SDK 和运行文件。' : '当前安装缺少本机 Codex 运行文件。',
              } }),
          credentialCheck(),
          h(ConnectionResult, { id: 'model', label: '本机模型目录',
            detail: '检查本机 SDK 支持的模型选项。', result: checked ? {
              state: models.length ? 'passed' : 'failed',
              detail: models.length ? `内置目录 · ${models.length} 个模型选项` : '当前本机 SDK 没有可选模型。',
            } : null }),
          h(ConnectionResult, { id: 'response', label: '实际模型响应', detail: '试跑使用所选配置的模型和本机网络。',
            result: trialResult(trial, trialTarget) },
          h(TrialActions, { trial, target: trialTarget, allowed: Boolean(settingsTab) && !browsing && !accessPending && !statusBusy }))));
    }

    function credentialCheck() {
      return h(ConnectionResult, { id: 'account', label: '本机账号凭据',
        detail: '检查本机进程的凭据配置。', result: confirmedStatus && {
          state: confirmedStatus.credentialConfigured ? 'confirm' : 'failed',
          detail: confirmedStatus.credentialConfigured ? '已配置本机 API 密钥，服务权限待试跑确认。' :
            '请在启动工作台的本机环境中配置 API 密钥。',
        } });
    }

    function accountDetails() {
      return h(React.Fragment, null,
        h('section', { className: 'vc-settings-group', 'aria-label': '凭据来源' },
          h('h4', null, '凭据来源'),
          h('p', null, '本机启动环境的 ', h('code', null, 'VPS_WORKBENCH_LOCAL_CODEX_API_KEY')),
          h('p', { role: 'status' }, !status || statusError ? '凭据配置待读取。' : status.credentialConfigured
            ? '本机 API 密钥已配置。' : '请在启动工作台的本机环境中设置此变量。'),
          h(Button, { className: 'vc-settings-outline', onClick: () => settingsSurface.setTab('connection') }, '打开本机连接检查')),
        h('ol', { className: 'vc-setup-steps' },
          credentialCheck(),
          h(ConnectionResult, { id: 'response', label: '实际模型响应', detail: '试跑使用所选本机配置。',
            result: trialResult(trial, trialTarget) })));
    }

    function profileSummary(includeDirectory = false) {
      if (!settingsProfile) return note('尚未登记本机配置。');
      return h('dl', { className: 'local-config-details' },
        h('dt', null, '名称'), h('dd', null, settingsProfile.name),
        includeDirectory && h(React.Fragment, null, h('dt', null, '工作目录'), h('dd', null, settingsProfile.directory)),
        h('dt', null, '默认模型'), h('dd', null, modelLabel(settingsProfile.model)),
        h('dt', null, '推理强度'), h('dd', null, effortName(settingsProfile.effort)));
    }

    function profileFields() {
      return h(React.Fragment, null,
        settingsProfile && h('section', { className: 'vc-settings-group', 'aria-label': '本机配置' },
          h('h4', null, '本机配置'),
          h('label', { className: 'vc-field' }, '查看配置',
            h('select', { 'aria-label': '查看配置', value: settingsProfile.id,
              onChange: (event) => setSettingsProfileId(event.target.value),
            }, profiles.map((item) => h('option', { key: item.id, value: item.id }, item.name)))),
          profileSummary(true),
          h(Button, { className: 'vc-settings-outline',
            disabled: browsing || accessPending || registerBusy || settingsProfile.id === defaultProfileId,
            onClick: () => void setNewProfile() },
          settingsProfile.id === defaultProfileId ? '新聊天默认配置' : '设为新聊天配置')),
        h('form', { className: 'vc-settings-group', onSubmit: (event) => void register(event) },
          h('h4', null, '注册本机配置'),
          h('label', { className: 'vc-field' }, '配置名称', h('input', { value: name, maxLength: 80, required: true,
            disabled: browsing || registerBusy, onChange: (event) => setName(event.target.value) })),
          h('div', { className: 'vc-settings-address' },
            h('label', { className: 'vc-field' }, '模型', h('select', { value: model?.id ?? '', disabled: browsing || registerBusy || !model,
              onChange: (event) => { setModelId(event.target.value); setEffortId(''); } },
            models.map((item) => h('option', { key: item.id, value: item.id }, item.label)))),
            h('label', { className: 'vc-field' }, '推理强度', h('select', { value: effort ?? '', disabled: browsing || registerBusy || !model,
              onChange: (event) => setEffortId(event.target.value) },
            model?.efforts.map((item) => h('option', { key: item, value: item }, effortName(item)))))),
          registerError && h('div', { role: 'alert', className: 'vc-feedback' }, registerError),
          h('div', { className: 'vc-dialog-actions' },
            h(Button, { type: 'submit', className: 'vc-primary',
              disabled: browsing || accessPending || registerBusy || statusBusy || !status || !model || !name.trim() },
            registerBusy ? '正在选择工作目录…' : '选择工作目录并保存')),
          note('工作台在独立的本机存储中保存历史、SDK 线程和回执。已创建的会话继续使用原配置。')));
    }
  };
}
