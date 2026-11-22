import { createMarkdownReply } from './markdown.js';
import { createDesignCanvas } from './design-canvas.js';
import { readVersionHistory, validDesignTurn } from './design-version-state.js';
import {
  createComposerControls, readModelCatalog, reportedTurnSettings, validTurnMetadata,
} from './composer-controls.js';
import { extractHtmlFences } from './design-preview.js';
import { layerRevisionKey, readLayerRevision, readLayerRevisionOutcome, serializeLayerRevision } from './design-layer-revision.js';
import { contextMenuCss, contextMenuKey, contextMenuRequest, createContextMenu, editMenuGroups } from './context-menu.js';
import {
  conversationActionsCss, conversationOptionsKey, createConversationDialog, readConversationOptions, updateConversationOptions,
} from './conversation-actions.js';
import { menuIcon } from './menu-icons.js';
import {
  membershipKey, pinnedProjectsKey, projectFoldersCss, projectMembershipFor, projectMembershipId,
  projectMembershipIsolated, readPinnedProjects, readProjectMemberships, updateProjectMembership,
} from './project-folders.js';
import { createProviderPicker, providerPickerCss, readToolPreferences } from './provider-picker.js';
import { chatSurfaceCss } from './workbench-theme.js';
import { setToolTheme, themeRippleCss, transitionSubscriptionView, transitionToolView } from './theme-ripple.js';
import { createAccountDialog, accountDialogCss } from './account-view.js';
import { getAccountAction } from './account-routes.js';
import { createSettingsDialog, defaultSettings, settingFields } from './settings-dialog.js';
import { settingsCss } from './settings-style.js';
import { readPreferences, readToolProfiles, writePreferences, writeToolProfiles } from './workbench-preferences.js';
import { workbenchStorage } from './workbench-storage.js';
import { advancedModelOptionsCss, modelParametersKey, readStoredModelParameters } from './advanced-model-options.js';
import { readModelParameterFields, validModelParameters } from './model-parameters.js';

export function createWorkbench({ React, CodeBlock, writeClipboard, subscriptionRequiresRelay = true, hostThemeLabel,
  parseStreamingMarkdown, stabilizeStreamingRecord, sidebarActions = false, ResourceLibrary, onThemeReveal,
  editText, saveConversationPreference, saveModelParameters,
  ExtensionSettings, extensionsForTurn, automaticMemoryPolicy, conversationIsolated, projectMemoryNotes,
  AgentPresetSettings, WorkflowPanel, useWorkflows = () => null, SetupGuide, setupConnectionKey,
  VpsConnectionChecks, useVpsConnectionChecks = () => null, localSdk = false }) {
  const h = React.createElement;
  const MarkdownReply = createMarkdownReply(React, CodeBlock, parseStreamingMarkdown);
  const DesignCanvas = createDesignCanvas(React);
  const AccountDialog = createAccountDialog(React);
  const ProviderPicker = createProviderPicker(React);
  const SettingsDialog = createSettingsDialog(React, { hostThemeLabel });
  const ContextMenu = createContextMenu(React);
  const ConversationDialog = createConversationDialog(React);
  const { Toolbar: ComposerToolbar, Panel: ComposerPanel, AccessTrigger } = createComposerControls(React);
  const apiPath = '/dsh-vps-chat/api/';
  const maxPromptLength = 8192;
  const maxSteerLength = 1200;
  const unboundDraft = 'local-unconfigured';
  const localSendRejections = new Set(['auth_required', 'runtime_unavailable', 'invalid_profile', 'invalid_directory',
    'session_conflict', 'profile_not_found', 'browse_only']);
  const localStartFailures = new Set(['invalid_environment', 'invalid_directory', 'start_failed', 'resources_changed']);
  const emptyList = [];
  const defaultModelParameters = Object.freeze({});
  const streamPollInterval = 650;
  const legacyPollInterval = 2500;
  const refreshRetryDelays = [1000, 2500, 5000];
  const retryableRefreshErrors = new Set(['transport_unavailable', 'unknown', 'session_blocked', 'request_rejected']);
  const automaticStatusRetry = '连接暂时中断，正在查询原任务。';
  const splitBreakpoint = 960;
  const minimumThreadWidth = 300;
  const sessionDragType = 'application/x-vps-workbench-session';
  const minimumCanvasWidth = 330;
  const separatorWidth = 9;
  const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rejectedBeforeSend = new Set([
    'invalid_request', 'invalid_settings', 'session_blocked', 'turn_conflict', 'request_rejected', 'bridge_not_ready',
    'storage_before_send', 'mode_conflict', 'relay_required', 'workbench_browse_only', 'memory_scope_changed',
  ]);
  const statusLabels = {
    pending: localSdk ? '等待本机 SDK 确认' : '等待 VPS 确认',
    running: localSdk ? '本机执行端正在处理' : 'VPS 正在处理', stopping: '正在停止', stopped: '已停止',
    complete: '已完成', failed: '执行失败', unknown: '结果待确认',
  };
  const steerLabels = {
    queued: '已排队', submitted: '执行端已接收', delivered: '已送达', next: '已在后续响应生效', rejected: '未送达', unknown: '补充结果待确认',
  };
  const rejectedBeforeSteer = new Set([
    'steer_unavailable', 'steer_limit', 'steer_conflict', 'session_blocked', 'invalid_request', 'target_changed',
    'storage_before_send', 'request_rejected', 'bridge_not_ready', 'relay_required', 'workbench_browse_only',
    'design_branch_unavailable',
  ]);
  const approvalLabels = {
    pending: '等待确认', queued: '决定已排队', dispatching: '正在提交决定', submitted: '决定已提交',
    unknown: '提交结果待确认', closed: '请求已关闭',
  };
  const approvalOutcomes = new Set(['queued', 'dispatching', 'submitted', 'unknown', 'closed']);
  const approvalRejections = new Set([
    'approval_unavailable', 'approval_rejected', 'invalid_request', 'invalid_settings', 'target_changed',
    'workbench_browse_only', 'bridge_not_ready', 'relay_required',
  ]);
  const providers = {
    codex: {
      label: 'Codex', icon: 'codex', modelCatalog: true, design: true,
      setup: '在 VPS 上安装 Codex 并登录 ChatGPT。',
      capabilities: ExtensionSettings ? '支持对话、设计模式和工作台 MCP。' : '支持对话和设计模式。',
    },
    claude: {
      label: 'Claude API', icon: 'key', modelCatalog: true,
      setup: '在 VPS 的 LUKS2 加密用户目录中配置 API 密钥。使用 Claude 订阅时，请从「远端原生终端」登录官方 CLI。',
      capabilities: '通过 API 使用工作台对话。高级参数取决于当前连接。',
    },
    'claude-sdk': {
      label: 'Claude（订阅 SDK）', icon: 'claude-sdk', modelCatalog: true,
      setup: '在 VPS 上通过官方 Claude Code 登录自己的订阅，并配置 Claude Agent SDK。',
      capabilities: '通过 VPS 上的订阅 SDK 使用工作台对话。可选模型和参数取决于当前连接。',
    },
    antigravity: {
      label: 'Antigravity', icon: 'antigravity',
      setup: '在 VPS 上安装 agy，用专用配置登录 Google 并配置服务域名。',
      modelCatalog: true,
      capabilities: '通过 VPS 上的 Antigravity ACP 对话，支持补充当前轮次和确认工具请求。可选模型和思考档位取决于当前账号。',
    },
  };
  const subscriptionProvider = 'claude-subscription';
  const chatTools = Object.entries(providers).map(([id, provider]) => ({ ...provider, id }));
  const subscriptionTool = {
    id: subscriptionProvider, label: 'Claude Code（订阅终端）', icon: 'claude-code',
    setup: '在 VPS 上安装官方 Claude Code 并登录 Claude 订阅。',
    capabilities: '在 VPS 原生终端中选择模型和继续历史会话。',
  };
  const localProviderLabels = { codex: 'Codex', 'claude-sdk': 'Claude Agent SDK', antigravity: 'Antigravity ACP' };
  const toolIds = localSdk ? Object.keys(localProviderLabels) : [...chatTools.map(({ id }) => id), subscriptionProvider];
  const toolsWithModels = chatTools.filter(({ id, modelCatalog }) => toolIds.includes(id) && modelCatalog).map(({ id }) => id);

  const css = chatSurfaceCss(separatorWidth) + projectFoldersCss + accountDialogCss + providerPickerCss + themeRippleCss + settingsCss + contextMenuCss +
    (saveConversationPreference ? conversationActionsCss : '') +
    (saveModelParameters ? advancedModelOptionsCss : '');

  function newIdentifier() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }

  function createRpc() {
    let token;
    const commonHeaders = { 'X-DSH-VPS-CHAT': '1' };
    return async (op, payload, parentSignal) => {
      const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(115000)]);
      async function request(path, options) {
        try {
          return await fetch(path, { ...options, signal });
        } catch (cause) {
          if (parentSignal.aborted || (cause?.name !== 'TypeError' && cause?.name !== 'TimeoutError')) throw cause;
          const failure = new Error('暂时无法连接工作台服务。', { cause });
          failure.code = 'transport_unavailable';
          throw failure;
        }
      }
      if (!token) {
        const response = await request(apiPath + 'token', {
          credentials: 'same-origin', cache: 'no-store', headers: commonHeaders,
        });
        const data = await response.json();
        if (!response.ok || data?.ok !== true || typeof data.token !== 'string' || !data.token) {
          throw new Error('工作台服务未就绪。');
        }
        token = data.token;
      }
      const response = await request(apiPath + 'rpc', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { ...commonHeaders, 'X-DSH-VPS-CHAT-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...payload }),
      });
      if (response.status === 401 || response.status === 403) token = undefined;
      const data = await response.json();
      if (!response.ok || data?.ok !== true) {
        const message = typeof data?.message === 'string' ? data.message.slice(0, 300) : '工作台操作未完成。';
        const error = new Error(message);
        error.code = typeof data?.code === 'string' ? data.code : undefined;
        throw error;
      }
      return data;
    };
  }

  function validMode(mode) {
    return mode === undefined || mode === 'chat' || mode === 'design';
  }

  function modeTitle(mode) {
    return mode === 'design' ? '新设计' : '新对话';
  }

  function readList(data) {
    if (typeof data.targetId !== 'string' || !/^[0-9a-f]{64}$/.test(data.targetId) ||
        !Array.isArray(data.sessions) || !data.sessions.every((row) =>
          identifier.test(row?.id) && typeof row.title === 'string' && validMode(row.mode))) {
      throw new Error('会话列表暂不可用。');
    }
    return { targetId: data.targetId, sessions: data.sessions,
      memoryTargetId: typeof data.memoryTargetId === 'string' && /^[a-f0-9]{64}$/.test(data.memoryTargetId) ? data.memoryTargetId : null };
  }

  function validSteering(steering) {
    return steering === undefined || (Array.isArray(steering) && steering.length <= 6 &&
      steering.every((note) => typeof note?.id === 'string' && identifier.test(note.id) &&
        typeof note.prompt === 'string' && note.prompt.trim() && note.prompt.length <= maxSteerLength &&
        !note.prompt.includes('\0') && typeof note.state === 'string' && Object.hasOwn(steerLabels, note.state)) &&
      new Set(steering.map((note) => note.id.toLowerCase())).size === steering.length);
  }

  function validApprovals(approvals) {
    return approvals === undefined || (Array.isArray(approvals) && approvals.length <= 16 &&
      approvals.every((request) => typeof request?.id === 'string' && identifier.test(request.id) &&
        typeof request.title === 'string' && request.title.length <= 240 &&
        typeof request.detail === 'string' && request.detail.length <= 512 &&
        typeof request.kind === 'string' && request.kind.length <= 32 &&
        typeof request.canAllow === 'boolean' && typeof request.state === 'string' && Object.hasOwn(approvalLabels, request.state) &&
        (request.decision === null || request.decision === 'allow' || request.decision === 'deny')) &&
      new Set(approvals.map((request) => request.id.toLowerCase())).size === approvals.length);
  }

  function readSession(data, id, mode) {
    const { session } = data;
    const canSend = session?.canSend;
    if (session?.id !== id || typeof session.title !== 'string' || typeof canSend !== 'boolean' ||
        (session.canBranch !== undefined && typeof session.canBranch !== 'boolean') ||
        !validMode(session.mode) ||
        !Array.isArray(session.turns) || !session.turns.every((turn) => identifier.test(turn?.id) &&
          typeof turn.prompt === 'string' && typeof turn.reply === 'string' && Object.hasOwn(statusLabels, turn.state) &&
          (turn.streaming === undefined || typeof turn.streaming === 'boolean') &&
          (turn.canStop === undefined || typeof turn.canStop === 'boolean') &&
           (turn.canSteer === undefined || typeof turn.canSteer === 'boolean') && validSteering(turn.steering) &&
           validApprovals(turn.approvals) &&
          validTurnMetadata(turn) && validDesignTurn(turn) &&
          Array.isArray(turn.activity) && turn.activity.every((item) => typeof item?.title === 'string' && typeof item.text === 'string'))) {
      throw new Error('无法确认这段会话。');
    }
    if (session.turns.length && (session.mode ?? 'chat') !== mode) throw new Error('无法确认这段会话的模式。');
    return { session: { ...session, mode }, canSend };
  }

  function emptySession(id, mode) {
    return { session: { id, mode, title: modeTitle(mode), turns: [] }, canSend: true };
  }

  function isActive(state) {
    return state === 'pending' || state === 'running' || state === 'stopping';
  }

  function isSettled(state) {
    return state === 'complete' || state === 'failed' || state === 'stopped';
  }

  function isStopEligible(turn) {
    return turn?.canStop === true && (turn.state === 'pending' || turn.state === 'running');
  }

  function matchingSteer(turns, sent) {
    return turns.find((turn) => turn.id === sent.turnId)?.steering?.find((note) =>
      note.id.toLowerCase() === sent.id && note.prompt === sent.prompt);
  }

  function steerSessionKey(route, sessionId) {
    return `${route}:${sessionId}`;
  }

  function errorText(error, fallback) {
    return error?.code && typeof error.message === 'string' ? error.message : fallback;
  }

  function readPreset({ preset }) {
    if (preset === null) return null;
    const { settings, name } = preset ?? {};
    if (localSdk) {
      if (typeof name !== 'string' || !name.trim() || name.length > 80 ||
          settings?.location !== 'local-sdk' || !Object.hasOwn(localProviderLabels, settings.provider) || !identifier.test(settings.profileId)) {
        throw new Error('本机配置暂不可用。');
      }
      return { name, settings, ...readList(preset) };
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 64 ||
        settings?.hostKeyConfirmed !== true || typeof settings.provider !== 'string' ||
        !Object.hasOwn(providers, settings.provider) ||
        !settingFields.every(({ key }) => key === 'port' ? Number.isInteger(settings.port) : typeof settings[key] === 'string')) {
      throw new Error('VPS 预设暂不可用。');
    }
    return { name, settings, ...readList(preset) };
  }

  function ReplyCopy({ source }) {
    const [copying, setCopying] = React.useState(false);
    const [result, setResult] = React.useState(null);
    const current = result?.source === source ? result : null;

    async function copyReply() {
      setCopying(true);
      setResult(null);
      let copied = false;
      try {
        copied = (await writeClipboard(source)) === true;
      } catch {
        // The host may reject clipboard access.
      }
      setResult({ source, copied });
      setCopying(false);
    }

    return h('div', { className: 'vc-reply-actions' },
      h('span', { role: 'status', className: 'vc-copy-status', 'data-failed': current?.copied === false },
        current ? (current.copied ? '已复制' : '复制失败') : ''),
      h('button', { type: 'button', className: 'vc-button vc-copy-reply', disabled: copying, onClick: copyReply },
        '复制回复'));
  }

  function ToolApprovals({ requests, attempts, decide, disabled }) {
    return h('ul', { className: 'vc-approvals', 'aria-label': '工具授权' }, requests.map((request) => {
      const pending = request.state === 'pending';
      const attempt = pending ? attempts?.[request.id] : undefined;
      const state = attempt?.state ?? request.state;
      const decision = attempt?.decision ?? request.decision;
      const label = decision === 'allow' ? '允许一次' : decision === 'deny' ? '拒绝' : '';
      return h('li', { key: request.id, 'data-state': state },
        h('div', { className: 'vc-approval-heading' },
          h('strong', { dir: 'auto' }, request.title || '工具请求'),
          h('span', { className: 'vc-approval-state', role: 'status' },
            label ? `${label} · ` : '', approvalLabels[state])),
        request.detail ? h('pre', { dir: 'auto' }, request.detail) : null,
        pending && decide ? h('div', { className: 'vc-approval-actions', role: 'group',
          'aria-label': request.title || '工具请求' },
          h('button', { type: 'button', className: 'vc-button', disabled: disabled || Boolean(attempt),
            onClick: () => decide(request.id, 'deny') }, '拒绝'),
          request.canAllow ? h('button', { type: 'button', className: 'vc-button vc-primary',
            disabled: disabled || Boolean(attempt), onClick: () => decide(request.id, 'allow') }, '允许一次') : null) : null);
    }));
  }

  function Turn({ turn, providerName, state = turn.state, design, designStorageKey, pendingSteers, sendingSteer, openCanvas, canvasId,
    onStreamingRender, workflowEdit, approvals, approvalAttempts, decideApproval, approvalDisabled }) {
    const revision = React.useMemo(() => design && turn.state === 'complete'
      ? readLayerRevision(designStorageKey, turn) : null, [design, designStorageKey, turn.id, turn.state, turn.reply]);
    const boardCount = React.useMemo(() => design && turn.state === 'complete'
      ? (revision ? revision.sources?.length ?? 0 : extractHtmlFences(turn.reply).length) : 0,
    [design, turn.state, turn.reply, revision]);
    const steering = [...(turn.steering ?? [])];
    for (const note of pendingSteers) {
      if (note.turnId !== turn.id || steering.some((entry) => entry.id.toLowerCase() === note.id)) continue;
      steering.push({ ...note, state: sendingSteer === note.id ? 'submitting' : 'unknown' });
    }
    return h('article', { className: 'vc-turn', 'data-turn-id': turn.id, 'data-turn-state': state, tabIndex: -1 },
      h('div', { className: 'vc-user vc-text', 'aria-label': '你的消息' }, workflowEdit?.prompt ?? turn.prompt),
      steering.length ? h('ol', { className: 'vc-steering', 'aria-label': '本轮补充' },
        steering.map((note) => h('li', { key: note.id, 'data-steer-id': note.id, 'data-state': note.state },
          h('div', { className: 'vc-text' }, note.prompt),
          h('span', { className: 'vc-steer-state', role: 'status' },
            note.state === 'submitting' ? '正在发送补充' : steerLabels[note.state])))) : null,
      h('div', { className: 'vc-answer' },
        h('div', { className: 'vc-answer-head' },
          h('strong', null, providerName),
          turn.model || turn.effort ? h('span', { className: 'vc-answer-model' },
            turn.model || '推理强度', turn.effort ? ` · ${turn.effort}` : '') : null,
          h('span', { className: 'vc-answer-state', 'data-state': state }, statusLabels[state]),
          localSdk && turn.message ? h('span', { className: 'vc-answer-state', 'data-state': state }, turn.message) : null,
          turn.reply ? h(ReplyCopy, { source: turn.reply }) : null),
        turn.reply ? h(MarkdownReply, { source: turn.reply, collapseHtml: design, onStreamingRender,
          streaming: Boolean(onStreamingRender && turn.streaming && isActive(state)) }) : null,
        approvals?.length ? h(ToolApprovals, { requests: approvals, attempts: approvalAttempts,
          decide: decideApproval, disabled: approvalDisabled }) : null,
        workflowEdit?.review ? h('button', {
          type: 'button', className: 'vc-button', onClick: workflowEdit.review,
        }, '审阅工作流配置') : null,
        revision?.error ? h('p', { className: 'vc-context-note', role: 'status', 'data-error': true }, revision.error) : null,
        boardCount ? h('button', {
          type: 'button', className: 'vc-artifact-link', 'aria-label': '查看画板', 'aria-controls': canvasId,
          onClick: () => openCanvas(turn.id),
        },
        h('span', null, h('strong', null, '查看画板'), h('small', null, `${boardCount} 块画板`)),
        h('span', { className: 'vc-artifact-mark', 'aria-hidden': true })) : null,
        turn.activity.length ? h('details', { className: 'vc-activity vc-details-motion' },
          h('summary', null, '查看运行详情'),
          h('ol', null, turn.activity.map((item, index) => (
            h('li', { key: index }, item.title, item.text ? h('pre', null, item.text) : null)
          )))) : null));
  }

  function Workbench({ projectCatalog, terminalView, active = true, visible = true, resourcesOpen, setResourcesOpen,
    access, accessPending, changeAccess, extensions, agentPresets, workflowStore, onNewChat, newChatRequest = 0,
    settingsSurface, applicationPreferences, local }) {
    const workspaceSnapshot = React.useSyncExternalStore(projectCatalog.subscribe, projectCatalog.getSnapshot);
    const SubscriptionTerminal = React.useSyncExternalStore(terminalView.subscribe, terminalView.getSnapshot);
    const [subscriptionOpen, setSubscriptionOpen] = React.useState(false);
    const [subscriptionPreset, setSubscriptionPreset] = React.useState(null);
    const [subscriptionActivation, setSubscriptionActivation] = React.useState(0);
    const showingSubscription = subscriptionOpen && Boolean(SubscriptionTerminal) && Boolean(subscriptionPreset);
    const projects = React.useMemo(() => new Map(workspaceSnapshot.items.map(({ workspaceId, title }) =>
      [workspaceId, title || '未命名项目'])), [workspaceSnapshot.items]);
    const [projectFilter, setProjectFilter] = React.useState(null);
    const [expandedProjects, setExpandedProjects] = React.useState(emptyList);
    const [projectMemberships, setProjectMemberships] = React.useState({});
    const [pinnedProjects, setPinnedProjects] = React.useState(readPinnedProjects);
    const draggedSession = React.useRef(null);
    const [draggedSessionId, setDraggedSessionId] = React.useState(null);
    const [dropProject, setDropProject] = React.useState(null);
    const [contextMenus, setContextMenus] = React.useState(emptyList);
    const contextMenuSequence = React.useRef(0);
    const [contextNotice, setContextNotice] = React.useState(null);
    const [conversationEdits, setConversationEdits] = React.useState({});
    const conversationWrite = React.useRef(false);
    const [conversationDialog, setConversationDialog] = React.useState(null);
    const [archiveScope, setArchiveScope] = React.useState(null);
    const dismissContextMenu = React.useCallback((request) => {
      setContextMenus((current) => current.filter((menu) => menu !== request));
    }, []);
    React.useEffect(() => {
      if (!contextNotice) return undefined;
      const timer = setTimeout(() => setContextNotice(null), 2400);
      return () => clearTimeout(timer);
    }, [contextNotice]);
    const [projectWarning, setProjectWarning] = React.useState('');
    const [connection, setConnection] = React.useState(null);
    const [connectionName, setConnectionName] = React.useState('');
    const [toolPreferences, setToolPreferences] = React.useState({ key: '', ids: [] });
    const [hostPreferences, setPreferences] = React.useState(readPreferences);
    const preferences = applicationPreferences?.value ?? hostPreferences;
    const [toolProfiles, setToolProfiles] = React.useState({});
    const [localToolProfiles, setLocalToolProfiles] = React.useState({});
    const toolProfileWrites = React.useRef(Promise.resolve());
    const activeToolKey = React.useRef(toolPreferences.key);
    activeToolKey.current = toolPreferences.key;
    const [loadingPreset, setLoadingPreset] = React.useState(true);
    const [scope, setScope] = React.useState('');
    const [memoryTargetId, setMemoryTargetId] = React.useState(null);
    const [antigravityRoute, setAntigravityRoute] = React.useState(null);
    const [allRows, setAllRows] = React.useState({});
    const [selected, setSelected] = React.useState(null);
    const [view, setView] = React.useState(null);
    const [drafts, setDrafts] = React.useState({});
    const [supplementDrafts, setSupplementDrafts] = React.useState({});
    const [attempts, setAttempts] = React.useState({});
    const [steerAttempts, setSteerAttempts] = React.useState({});
    const [approvalAttempts, setApprovalAttempts] = React.useState({});
    const [stopRequests, setStopRequests] = React.useState({});
    const [working, setWorking] = React.useState('');
    const [feedback, setFeedback] = React.useState('');
    const [pollPaused, setPollPaused] = React.useState(false);
    const [settingsView, setSettingsView] = React.useState({ tab: false, visit: 0 });
    const [savedConfiguration, setSavedConfiguration] = React.useState(null);
    const settingsLabel = localSdk || VpsConnectionChecks ? '设置' : 'VPS 设置';
    const [setupOpen, setSetupOpen] = React.useState(false);
    const [accountOpen, setAccountOpen] = React.useState(null);
    const [requestedAccount, setRequestedAccount] = React.useState(null);
    const [settingsError, setSettingsError] = React.useState('');
    const [pinConfirmationRequired, setPinConfirmationRequired] = React.useState(false);
    const [historyOpen, setHistoryOpen] = React.useState(false);
    const [designPane, setDesignPane] = React.useState('split');
    const [playgroundView, setPlaygroundView] = React.useState(null);
    const [canvasHistoryOpen, setCanvasHistoryOpen] = React.useState(false);
    const [canvasRequest, setCanvasRequest] = React.useState(null);
    const [sourceTurn, setSourceTurn] = React.useState(null);
    const [materialsOpen, setMaterialsOpen] = React.useState(false);
    const [layout, setLayout] = React.useState({ width: 0, bodyWidth: 0 });
    const [requestedThreadWidth, setRequestedThreadWidth] = React.useState(null);
    const [resizing, setResizing] = React.useState(false);
    const [designSubmission, setDesignSubmission] = React.useState(null);
    const [designReceipt, setDesignReceipt] = React.useState(null);
    const [composerPanels, setComposerPanels] = React.useState([]);
    const expandedComposerKind = composerPanels.find(({ expanded }) => expanded)?.kind;
    const closeComposerPanel = React.useCallback((anchor) => {
      setComposerPanels((panels) => panels.filter((panel) => panel.anchor !== anchor));
    }, []);
    const trackComposerPanel = React.useCallback((anchor, expanded) => {
      setComposerPanels((panels) => panels.map((panel) =>
        panel.anchor === anchor && panel.expanded !== expanded ? { ...panel, expanded } : panel));
    }, []);
    const [modelCatalogs, setModelCatalogs] = React.useState({});
    const [modelSelections, setModelSelections] = React.useState({});
    const [modelParameterProfiles, setModelParameterProfiles] = React.useState({});
    const [modelParameterAvailability, setModelParameterAvailability] = React.useState(null);
    const [modelParameterRevision, setModelParameterRevision] = React.useState(0);
    const [savingModelParameters, setSavingModelParameters] = React.useState(false);
    const modelParameterWrite = React.useRef(false);
    const [acknowledgeSwitch, setAcknowledgeSwitch] = React.useState(null);
    const [sshRpc] = React.useState(createRpc);
    const rpc = localSdk ? local.request : sshRpc;
    const viewId = React.useId();
    const workbench = React.useRef(null);
    const body = React.useRef(null);
    const editor = React.useRef(null);
    const canvasHistoryTrigger = React.useRef(null);
    const resizeGesture = React.useRef(null);
    const modelReads = React.useRef(new Map());
    const presetRequest = React.useRef(null);
    const handledNewChat = React.useRef(0);
    const action = React.useRef(null);
    const polling = React.useRef(null);
    const submittedDraft = React.useRef(null);
    const composing = React.useRef(false);
    const composingSteer = React.useRef(null);
    const compositionEndedAt = React.useRef(-Infinity);
    const scroll = React.useRef(null);
    const followReply = React.useRef(true);
    const ready = Boolean(connection && scope);
    const tools = localSdk ? chatTools.filter(({ id }) => toolIds.includes(id)).map((tool) => ({ ...tool,
      label: localProviderLabels[tool.id], available: Boolean(local.profileForBackend?.(tool.id)) })) :
      [...chatTools.map((tool) => ({ ...tool, available: true })), { ...subscriptionTool, available: Boolean(SubscriptionTerminal) }];
    const configuredTools = tools.filter(({ id, available }) => available && (localSdk || toolPreferences.ids.includes(id)));
    const chatEnabled = ready && toolPreferences.ids.includes(connection.provider);
    const remoteEnabled = access?.mode !== 'browse' && !accessPending;
    const settingsTab = settingsSurface ? settingsSurface.tab : settingsView.tab;
    const configProfile = local?.settingsProfile;
    const configPreferences = React.useMemo(() => {
      if (!configProfile) return null;
      const key = 'dsh-vps-chat:local-tools:v1:' + configProfile.id;
      return { tools: { key, ids: [configProfile.backend ?? 'codex'] }, profiles: localToolProfiles[key] ?? readToolProfiles(key, toolIds) };
    }, [configProfile?.id, localToolProfiles]);
    const localConfiguration = configProfile && configProfile.id !== connection?.profileId && {
      ...local.routeForTarget(configProfile.targetId), memoryTargetId: (configProfile.backend ?? 'codex') === 'codex' ? configProfile.targetId : null,
      name: configProfile.name, ...configPreferences,
    };
    const configuration = localConfiguration || savedConfiguration || { settings: connection, targetId: scope, memoryTargetId,
      name: connectionName, tools: toolPreferences, profiles: toolProfiles };
    const configurationReady = Boolean(configuration.settings && configuration.targetId);
    const modelAllowed = remoteEnabled && chatEnabled && providers[connection.provider]?.modelCatalog === true;
    const activeTool = showingSubscription ? subscriptionProvider : chatEnabled ? connection.provider : undefined;
    const activePreferences = { ...preferences, ...toolProfiles[activeTool] };
    const providerId = connection?.provider ?? defaultSettings.provider;
    const providerName = localSdk ? localProviderLabels[providerId] : providers[providerId].label;
    const connectionDiagnostics = useVpsConnectionChecks({ rpc, readList, connection: configuration.settings,
      scope: configuration.targetId, memoryTargetId: configuration.memoryTargetId,
      toolIds: configuration.tools.ids, profiles: configuration.profiles, remoteEnabled,
      visible: Boolean(settingsSurface) || visible, savePreference: saveConversationPreference });
    const rows = allRows[scope] ?? emptyList;
    const storedConversationOptions = React.useMemo(() => {
      if (!saveConversationPreference || !scope) return {};
      try { return readConversationOptions(scope); }
      catch { return null; }
    }, [scope]);
    const conversationOptions = conversationEdits[scope] ?? storedConversationOptions;
    const titleFor = (row) => conversationOptions?.[row.id]?.title ?? row.title;
    const selectedRow = rows.find((row) => row.id === selected);
    const projectFor = (row) => row?.local ? row.projectId ?? ''
      : projectMembershipId(projectMembershipFor(projectMemberships, row?.id));
    const selectedProject = projectFor(selectedRow);
    const snapshot = view?.session.id === selected ? view : null;
    const mode = snapshot?.session.mode ?? selectedRow?.mode ?? 'chat';
    const design = mode === 'design';
    const interactiveChat = !design && (connection?.provider === 'antigravity' || localSdk && connection?.provider === 'claude-sdk');
    const memoryAvailable = Boolean(extensions && conversationIsolated && selected && chatEnabled && (!localSdk || providerId === 'codex'));
    const memoryIsolated = memoryAvailable && (snapshot?.session.memoryIsolation === true ||
      conversationIsolated(extensions.state, { targetId: scope, sessionId: selected }));
    const projectMemorySuppressed = selectedRow?.local ? selectedRow.projectMemoryIsolated === true
      : projectMembershipIsolated(projectMembershipFor(projectMemberships, selected));
    const memoryProject = projects.has(selectedProject) ? selectedProject
      : !selectedProject && !design && !projectWarning ? null : undefined;
    const automaticMemory = !memoryIsolated && !projectMemorySuppressed && memoryAvailable &&
      memoryProject !== undefined && memoryTargetId &&
      automaticMemoryPolicy(extensions.state, { targetId: memoryTargetId, projectId: memoryProject, scopedPersonal: localSdk })?.enabled;
    const automaticMemoryLabel = memoryProject === null ? '个人记忆' : '项目记忆';
    const turnExtensions = extensions && activeTool === 'codex' ? extensionsForTurn(extensions.state, {
      targetId: scope, projectId: projects.has(selectedProject) ? selectedProject : '',
      isolated: memoryIsolated || projectMemorySuppressed || automaticMemory,
    }) : null;
    const displayedMemory = automaticMemory ? projectMemoryNotes(extensions.state, {
      targetId: memoryTargetId, projectId: memoryProject, prompt: (drafts[selected] ?? '').trim(),
    }).length : turnExtensions?.memory.length ?? 0;
    const pluginPrompts = extensions?.state.plugins.flatMap(({ id, name, enabled, prompts }) =>
      enabled ? prompts.map((prompt, index) => ({ ...prompt, id: `${id}:${index}`, plugin: name })) : []) ?? emptyList;
    const codexTargetId = memoryTargetId ?? (connection?.provider === 'codex' ? scope : '');
    const antigravityConfigured = toolPreferences.ids.includes('antigravity');
    const antigravityTargetId = !remoteEnabled || !antigravityConfigured || !connection?.hostKeyConfirmed ? ''
      : connection.provider === 'antigravity' ? scope
        : antigravityRoute?.connection === connection && antigravityRoute?.scope === scope ? antigravityRoute.targetId : '';
    const moduleCatalog = extensions ? { servers: extensions.state.servers.filter((server) => Boolean(server.local) === localSdk),
      plugins: extensions.state.plugins, localSdk,
      codexTargetId, antigravityTargetId } : null;
    const category = projectFilter && !projects.has(projectFilter) ? null : projectFilter;
    const visibleRows = category === null ? rows : rows.filter((row) => {
      const scopeProject = projectFor(row);
      return (projects.has(scopeProject) ? scopeProject : '') === category;
    });
    const resourceSessions = React.useMemo(() => ResourceLibrary && resourcesOpen
      ? rows.filter((row) => !row.local).map((row) => {
        const projectId = projectMembershipId(projectMembershipFor(projectMemberships, row.id));
        return { ...row, title: conversationOptions?.[row.id]?.title ?? row.title,
          projectId: projects.has(projectId) ? projectId : '' };
      }) : emptyList, [resourcesOpen, rows, projects, projectMemberships, conversationOptions]);
    const readResourceSession = React.useCallback(async (row, signal) => {
      const response = await rpc('get', { settings: connection, targetId: scope, sessionId: row.id }, signal);
      return readSession(response, row.id, row.mode ?? 'chat').session;
    }, [rpc, connection, scope]);
    const readDesignRevision = React.useCallback(async (turnId, signal) => {
      const packet = await rpc('design-history', {
        settings: connection, targetId: scope, sessionId: selected, ...(turnId ? { turnId } : {}),
      }, signal);
      if (!turnId) {
        const key = `dsh-vps-design:v1:${scope}:${selected}`;
        return readVersionHistory(packet).map((entry) => {
          const outcome = readLayerRevisionOutcome(key, entry.id);
          return outcome && entry.state === 'complete' ? { ...entry, hasBoards: outcome === 'accepted' } : entry;
        });
      }
      if (packet.turn?.id !== turnId || packet.turn.state !== 'complete') throw new Error('这版画板暂不可用。');
      const result = readSession({ session: {
        id: selected, title: '', mode: 'design', turns: [packet.turn], canSend: false,
      } }, selected, 'design');
      return result.session.turns[0];
    }, [rpc, connection, scope, selected]);
    const roomy = layout.width > splitBreakpoint;
    const floatingChat = design && playgroundView !== null;
    const playgroundOpen = playgroundView === 'boards';
    const visiblePane = floatingChat ? 'playground' : designPane === 'split' && !roomy ? 'chat' : designPane;
    const split = design && visiblePane === 'split';
    const threadWidthLimit = Math.max(minimumThreadWidth, layout.bodyWidth - minimumCanvasWidth - separatorWidth);
    const clampThreadWidth = (width) => Math.max(minimumThreadWidth, Math.min(threadWidthLimit, Math.round(width)));
    const threadWidth = clampThreadWidth(requestedThreadWidth ?? layout.bodyWidth * 0.4);
    const designAvailable = chatEnabled && providers[connection.provider]?.design === true;
    const attached = design && designSubmission?.targetId === scope && designSubmission?.sessionId === selected
      ? designSubmission : null;
    const designStorageKey = design ? `dsh-vps-design:v1:${scope}:${selected}` : '';
    const draftId = selected ?? (localSdk ? unboundDraft : selected);
    const draft = drafts[draftId] ?? '';
    const prompt = draft.trim();
    const attempt = attempts[selected];
    const turns = snapshot?.session.turns ?? emptyList;
    const lastTurn = turns.at(-1);
    const lastState = lastTurn?.state;
    const canBranchDesign = sidebarActions && design && designAvailable && remoteEnabled &&
      (snapshot?.session.canBranch ?? (isSettled(lastState) && snapshot?.canSend)) && !working && !attempt && !pollPaused;
    const providerSwitchLocked = Boolean(working || attempt || isActive(lastState));
    React.useEffect(() => {
      if (!requestedAccount) return;
      setRequestedAccount(null);
      if ((!visible && !settingsTab && !setupOpen) || !remoteEnabled || !configurationReady ||
          providerSwitchLocked || !configuration.settings.hostKeyConfirmed) return;
      connectionDiagnostics?.clear();
      setAccountOpen({ actionId: requestedAccount.actionId, settings: configuration.settings });
    }, [requestedAccount]);
    const report = reportedTurnSettings(turns, Boolean(attempt && lastTurn?.id !== attempt.id));
    const modelKey = `${scope}:${selected}`;
    const catalog = modelCatalogs[scope];
    const savedModel = modelAllowed && toolProfiles[connection.provider]?.model;
    const defaultModel = savedModel?.targetId === scope ? savedModel : localSdk && local.profile?.targetId === scope
      ? { id: local.profile.model, effort: local.profile.effort, targetId: scope } : undefined;
    const unavailableModel = defaultModel && catalog?.models && !catalog.models.some(({ id }) => id === defaultModel.id);
    const sessionModel = modelSelections[modelKey];
    const modelSelection = sessionModel === null ? undefined : sessionModel ?? (unavailableModel ? undefined : defaultModel);
    const verifiedModel = catalog?.models?.find(({ id }) => id === modelSelection?.id);
    // A default selected from a verified catalog is scoped to this exact VPS target across reloads.
    const nextModel = modelAllowed && modelSelection
      ? verifiedModel ?? (modelSelection === defaultModel ? defaultModel : undefined)
      : undefined;
    const catalogEffort = verifiedModel?.efforts.includes(modelSelection?.effort)
      ? modelSelection.effort : verifiedModel?.defaultEffort;
    const nextEffort = connection?.provider === 'codex' && nextModel
      ? (verifiedModel ? catalogEffort : nextModel.effort) : undefined;
    const storedModelParameters = React.useMemo(() => saveModelParameters && scope
      ? readStoredModelParameters(scope, connection?.provider) : defaultModelParameters, [scope, connection?.provider]);
    const modelParameters = modelParameterProfiles[scope] ?? storedModelParameters;
    const parameterAvailability = modelParameterAvailability?.targetId === scope ? modelParameterAvailability : null;
    const chosenParameters = Object.keys(modelParameters ?? defaultModelParameters);
    const parametersBlocked = modelParameters === null || chosenParameters.some((key) => !parameterAvailability?.fields?.includes(key));
    const canMoveDraft = Boolean(selectedRow?.local && snapshot && !turns.length && !attempt);
    const steerKey = steerSessionKey(scope, selected);
    const pendingSteers = steerAttempts[steerKey] ?? emptyList;
    const activeSteer = pendingSteers.find((entry) => entry.turnId === lastTurn?.id);
    const supplementDraft = supplementDrafts[steerKey];
    const unconfirmedPrompt = pendingSteers.some((entry) => entry.prompt === prompt);
    const earlierSupplement = supplementDraft && supplementDraft.turnId !== lastTurn?.id;
    const stopRequest = stopRequests[selected]?.turnId === lastTurn?.id ? stopRequests[selected] : undefined;
    const stopPending = !isSettled(lastState) && (lastState === 'stopping' || stopRequest?.state === 'acknowledged');
    const stopUncertain = !isSettled(lastState) && lastState !== 'stopping' && stopRequest?.state === 'unknown';
    const showStop = remoteEnabled && ready && (stopPending || isStopEligible(lastTurn));
    const canStop = showStop && !stopPending && !stopUncertain && !working && !attempt && !pollPaused;
    const waitingForApproval = interactiveChat && isActive(lastState) && (lastTurn?.approvals ?? emptyList)
      .some(({ state }) => state === 'pending' || state === 'queued');
    const steerOffered = Boolean(remoteEnabled && ((interactiveChat && !lastTurn?.workflowStage) || (design && designAvailable)) &&
      lastTurn?.streaming === true && lastTurn.canSteer === true &&
      (lastState === 'pending' || lastState === 'running') && !stopPending && !stopUncertain && !waitingForApproval);
    const canSteer = Boolean(chatEnabled && steerOffered && !activeSteer && !earlierSupplement && !unconfirmedPrompt && !attempt && !working && !pollPaused &&
      prompt && draft.length <= maxSteerLength && !draft.includes('\0'));
    const currentApprovalAttempts = approvalAttempts[steerKey];
    const approvalOffered = interactiveChat && chatEnabled && remoteEnabled &&
      (lastState === 'pending' || lastState === 'running') && !stopPending && !stopUncertain && !lastTurn.workflowStage;
    const approvalDisabled = Boolean(working || attempt || pollPaused);
    const approvalUnconfirmed = approvalOffered && (lastTurn.approvals ?? emptyList).some((request) =>
      request.state === 'unknown' || currentApprovalAttempts?.[request.id]?.state === 'unknown');
    const canSend = Boolean(remoteEnabled && (!localSdk || local.runtimeReady && local.profile?.id === connection?.profileId) &&
      chatEnabled && !parametersBlocked && !savingModelParameters &&
      (!design || designAvailable) && !attached?.error &&
      (attached?.base ? canBranchDesign : snapshot?.canSend) && !attempt && !working && !pollPaused &&
      !unconfirmedPrompt && !isActive(lastState) && lastState !== 'unknown' && prompt && draft.length <= maxPromptLength);
    const shouldPoll = Boolean(visible && remoteEnabled && ready && selected && !working && !attempt && !pollPaused && isActive(lastState));
    const pollInterval = lastTurn?.streaming === true ? streamPollInterval : legacyPollInterval;
    const workflows = useWorkflows({ store: workflowStore, rpc, readList, connection, remoteEnabled,
      toolIds: toolPreferences.ids, scope, sessionId: selected, prepareChat: prepareWorkflowChat, local,
      savePreference: saveConversationPreference, report: setFeedback });

    const moduleCatalogEnabled = Boolean(extensions);
    React.useEffect(() => {
      if (!visible || !moduleCatalogEnabled || !antigravityConfigured || !remoteEnabled || !scope || !connection?.hostKeyConfirmed ||
          connection.provider === 'antigravity') return undefined;
      const controller = new AbortController();
      const { signal } = controller;
      void rpc('list', { settings: { ...connection, provider: 'antigravity' } }, signal).then((packet) => {
        const { targetId } = readList(packet);
        if (!signal.aborted && targetId !== scope && targetId !== codexTargetId) {
          setAntigravityRoute({ connection, scope, targetId });
        }
      }).catch(() => {});
      return () => controller.abort();
    }, [visible, moduleCatalogEnabled, antigravityConfigured, remoteEnabled, connection, scope, codexTargetId, rpc]);

    React.useLayoutEffect(() => {
      setToolTheme(workbench.current, activeTool);
      acknowledgeSwitch?.();
    }, [activeTool, acknowledgeSwitch]);

    React.useEffect(() => {
      if (!visible || !saveModelParameters || !chatEnabled || showingSubscription) return undefined;
      const controller = new AbortController();
      const { signal } = controller;
      setModelParameterAvailability({ targetId: scope });
      void rpc('model-options', { settings: connection, targetId: scope }, signal).then((packet) => {
        if (!signal.aborted) setModelParameterAvailability({
          targetId: scope, fields: readModelParameterFields(connection.provider, packet),
        });
      }).catch((error) => {
        if (!signal.aborted) setModelParameterAvailability({
          targetId: scope, error: errorText(error, '暂时无法确认高级参数的支持情况。'),
        });
      });
      return () => controller.abort();
    }, [visible, scope, connection, chatEnabled, showingSubscription, modelParameterRevision, rpc]);

    React.useEffect(() => () => {
      action.current?.abort();
      polling.current?.abort();
      for (const controller of modelReads.current.values()) controller.abort();
      modelReads.current.clear();
    }, []);

    React.useLayoutEffect(() => {
      const root = workbench.current;
      const mainBody = body.current;
      function measure() {
        const width = root.clientWidth;
        const bodyWidth = mainBody.clientWidth;
        setLayout((previous) => previous.width === width && previous.bodyWidth === bodyWidth
          ? previous : { width, bodyWidth });
      }
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      observer.observe(mainBody);
      return () => observer.disconnect();
    }, []);

    React.useLayoutEffect(() => {
      if (split || !resizeGesture.current) return;
      resizeGesture.current = null;
      setResizing(false);
    }, [split]);

    React.useEffect(() => {
      if (localSdk) setLoadingPreset(true);
    }, [local?.profile?.id]);

    React.useEffect(() => {
      if (!visible || !loadingPreset) return undefined;
      const controller = new AbortController();
      presetRequest.current = controller;
      async function loadPreset() {
        try {
          const preset = readPreset(await rpc('preset', {}, controller.signal));
          if (!preset || controller.signal.aborted) return;
          const preferences = localSdk ? { key: 'dsh-vps-chat:local-tools:v1:' + preset.settings.profileId, ids: [preset.settings.provider] }
            : await readToolPreferences(preset.settings, toolIds);
          if (controller.signal.aborted) return;
          setToolPreferences({ ...preferences, ids: preferences.ids ?? [preset.settings.provider] });
          setToolProfiles(readToolProfiles(preferences.key, toolIds));
          setSavedConfiguration(null);
          activateConnection(preset.settings, preset, preset.name);
        } catch (error) {
          if (!controller.signal.aborted) {
            setFeedback(localSdk ? '无法读取本机配置，请检查设置。' : error.code === 'target_changed'
              ? `VPS 预设的主机指纹需要重新核对。请打开「${settingsLabel}」。`
              : `无法读取 VPS 预设。请在「${settingsLabel}」中手动配置。`);
          }
        } finally {
          if (!controller.signal.aborted) setLoadingPreset(false);
        }
      }
      void loadPreset();
      return () => {
        controller.abort();
        if (presetRequest.current === controller) presetRequest.current = null;
      };
    }, [visible, loadingPreset, rpc, local?.profile?.id]);

    const settingsRequireTarget = ['connection', 'tools', 'accounts', 'agents', 'mcp', 'memory', 'tool-overrides'].includes(settingsTab);
    const readingConfiguration = Boolean(!localSdk && settingsSurface && settingsRequireTarget && !visible && !ready && !savedConfiguration);
    React.useEffect(() => {
      if (!readingConfiguration) return undefined;
      const controller = new AbortController();
      const { signal } = controller;
      async function loadConfiguration() {
        try {
          const preset = readPreset(await rpc('configuration', {}, signal));
          const tools = preset ? await readToolPreferences(preset.settings, toolIds) : { key: '', ids: [] };
          signal.throwIfAborted();
          setSavedConfiguration({ ...preset, tools: { ...tools, ids: tools.ids ?? [preset.settings.provider] },
            profiles: readToolProfiles(tools.key, toolIds) });
        } catch (error) {
          if (!signal.aborted) {
            setSavedConfiguration({ tools: { key: '', ids: [] }, profiles: {} });
            setSettingsError(errorText(error, 'VPS 配置无法读取。'));
          }
        }
      }
      void loadConfiguration();
      return () => controller.abort();
    }, [readingConfiguration, rpc]);

    React.useEffect(() => {
      if (!visible || working || (localSdk && (loadingPreset || local.profile?.id !== connection?.profileId)) ||
          handledNewChat.current === newChatRequest) return;
      if (startNewChat()) handledNewChat.current = newChatRequest;
    }, [visible, chatEnabled, working, newChatRequest, savedConfiguration, loadingPreset, local?.profile?.id]);

    function updateDraft(id, value) {
      if (submittedDraft.current?.sessionId === id) submittedDraft.current = null;
      setDrafts((previous) => ({ ...previous, [id]: value }));
      const composition = composingSteer.current;
      const turnId = steerOffered ? lastTurn.id
        : (composition?.key === steerKey ? composition.turnId : supplementDraft?.turnId);
      if (!composing.current) composingSteer.current = null;
      if (!turnId) return;
      setSupplementDrafts((previous) => {
        if (value.trim()) return { ...previous, [steerKey]: { text: value, turnId } };
        if (!Object.hasOwn(previous, steerKey)) return previous;
        const updated = { ...previous };
        delete updated[steerKey];
        return updated;
      });
    }

    function clearMatchingDraft(route, id, text) {
      setDrafts((previous) => previous[id] === text ? { ...previous, [id]: '' } : previous);
      const key = steerSessionKey(route, id);
      setSupplementDrafts((previous) => {
        if (previous[key]?.text !== text) return previous;
        const updated = { ...previous };
        delete updated[key];
        return updated;
      });
    }

    function clearSteerAttempts(key, ids) {
      setSteerAttempts((previous) => {
        const entries = previous[key];
        if (!entries?.some((entry) => ids.includes(entry.id))) return previous;
        const updated = { ...previous };
        const remaining = entries.filter((entry) => !ids.includes(entry.id));
        if (remaining.length) updated[key] = remaining;
        else delete updated[key];
        return updated;
      });
    }

    function clearAttempt(id, sent) {
      setAttempts((previous) => {
        if (previous[id] !== sent) return previous;
        const updated = { ...previous };
        delete updated[id];
        return updated;
      });
    }

    function accept(record, route, { sent, refreshed = false, steering } = {}) {
      const { id, title, mode: sessionMode, turns: messages } = record.session;
      if (refreshed && stabilizeStreamingRecord && messages.at(-1)?.streaming) {
        setView((previous) => stabilizeStreamingRecord(previous, record));
      } else {
        setView(record);
      }
      setStopRequests((previous) => {
        const stop = previous[id];
        const latest = messages.at(-1);
        if (latest?.state === 'stopping' && (stop?.turnId !== latest.id || stop.state !== 'acknowledged')) {
          return { ...previous, [id]: { turnId: latest.id, state: 'acknowledged' } };
        }
        if (!stop) return previous;
        const observed = messages.find((turn) => turn.id === stop.turnId);
        if (!isSettled(observed?.state) && !(localSdk && observed?.state === 'unknown') &&
            !(refreshed && stop.state === 'unknown' && isStopEligible(observed))) {
          return previous;
        }
        const updated = { ...previous };
        delete updated[id];
        return updated;
      });
      if (messages.length) {
        setAllRows((previous) => {
          const list = previous[route] ?? [];
          if (list[0]?.id === id && list[0].title === title && list[0].mode === sessionMode && !list[0].local) return previous;
          return { ...previous, [route]: [{ id, title, mode: sessionMode }, ...list.filter((row) => row.id !== id)] };
        });
      }
      if (sent && messages.some((message) => message.id === sent.id)) {
        if (sent.sharedDesign) setDesignReceipt({ targetId: route, sessionId: id, turnId: sent.id });
        clearAttempt(id, sent);
        clearMatchingDraft(route, id, sent.draft);
      }
      const latest = messages.at(-1);
      const submission = submittedDraft.current;
      if (localSdk && latest?.state === 'failed' && localStartFailures.has(latest.code) &&
          submission?.id === latest.id && submission.sessionId === id) {
        submittedDraft.current = null;
        setDrafts((previous) => previous[id] ? previous : { ...previous, [id]: submission.draft });
      }
      const key = steerSessionKey(route, id);
      setApprovalAttempts((previous) => {
        const unresolved = previous[key];
        if (!unresolved) return previous;
        const latest = messages.at(-1);
        const observed = new Set((latest?.approvals ?? []).filter((request) => request.state !== 'pending')
          .map((request) => request.id));
        const kept = Object.fromEntries(Object.entries(unresolved).filter(([approvalId, submission]) =>
          submission.turnId === latest?.id && !isSettled(latest.state) && !observed.has(approvalId)));
        if (Object.keys(kept).length === Object.keys(unresolved).length) return previous;
        const updated = { ...previous };
        if (Object.keys(kept).length) updated[key] = kept;
        else delete updated[key];
        return updated;
      });
      const resolved = [];
      for (const candidate of steering ?? steerAttempts[key] ?? emptyList) {
        const receipt = matchingSteer(messages, candidate);
        if (!receipt || receipt.state === 'unknown') continue;
        resolved.push(candidate.id);
        if (['queued', 'submitted', 'delivered', 'next'].includes(receipt.state)) clearMatchingDraft(route, id, candidate.draft);
      }
      if (resolved.length) clearSteerAttempts(key, resolved);
    }

    function targetChanged(error) {
      if (error.code !== 'target_changed') return false;
      setAccountOpen(null);
      dismissComposerPanel();
      setMaterialsOpen(false);
      setScope('');
      setMemoryTargetId(null);
      setConnection(previous => ({ ...previous, hostKeyConfirmed: false }));
      setSelected(null);
      setView(null);
      setFeedback('');
      setSettingsError(error.message);
      setSettingsOpen('connection');
      return true;
    }

    React.useEffect(() => {
      if (!shouldPoll) return undefined;
      const controller = new AbortController();
      polling.current = controller;
      let retries = 0;
      let timer = setTimeout(check, pollInterval);
      function retry() {
        if (retries >= refreshRetryDelays.length) return false;
        timer = setTimeout(check, refreshRetryDelays[retries++]);
        setFeedback(automaticStatusRetry);
        return true;
      }
      async function check() {
        if (controller.signal.aborted || action.current) return;
        try {
          const response = await rpc('refresh', { settings: connection, targetId: scope, sessionId: selected }, controller.signal);
          if (controller.signal.aborted) return;
          const record = readSession(response, selected, mode);
          const state = record.session.turns.at(-1)?.state;
          if (!localSdk && state === 'unknown' && retry()) return;
          accept(record, scope, { refreshed: true, steering: pendingSteers });
          retries = 0;
          setFeedback((previous) => previous === automaticStatusRetry ? '' : previous);
          if (isActive(state)) timer = setTimeout(check, pollInterval);
        } catch (error) {
          if (controller.signal.aborted || targetChanged(error)) return;
          if (retryableRefreshErrors.has(error.code) && retry()) return;
          setPollPaused(true);
          setFeedback(errorText(error, '状态更新中断。可重新查询这轮任务。'));
        }
      }
      return () => {
        clearTimeout(timer);
        controller.abort();
        if (polling.current === controller) polling.current = null;
      };
    }, [shouldPoll, connection, scope, selected, pollInterval, mode, pendingSteers, currentApprovalAttempts]);

    const followLatestReply = React.useCallback(() => {
      const panel = scroll.current;
      if (followReply.current && panel) panel.scrollTop = panel.scrollHeight;
    }, []);
    React.useLayoutEffect(() => {
      followLatestReply();
    }, [followLatestReply, selected, snapshot, attempt, pendingSteers, visiblePane, playgroundView, canvasHistoryOpen]);

    React.useLayoutEffect(() => {
      if (!sourceTurn || snapshot?.session.id !== sourceTurn.sessionId || (floatingChat && !canvasHistoryOpen)) return;
      const node = scroll.current?.querySelector(`[data-turn-id="${CSS.escape(sourceTurn.turnId)}"]`);
      if (!node) return;
      followReply.current = false;
      node.scrollIntoView({ block: 'nearest' });
      node.focus({ preventScroll: true });
      setSourceTurn(null);
    }, [sourceTurn, snapshot, floatingChat, canvasHistoryOpen]);

    const cycleAreaFocus = React.useCallback((event, fromCanvas = false) => {
      const root = workbench.current;
      if (!root || event.key !== 'F6' || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
          event.isComposing || event.nativeEvent?.isComposing || composing.current ||
          root.querySelector('dialog[open], .vc-composer-panel[role=dialog]:popover-open, .vc-tool-palette:popover-open')) return false;
      const areas = Array.from(root.querySelectorAll('[data-vc-focus-area]')).filter((area) =>
        area.getClientRects().length && !area.disabled && !area.closest('[inert]'));
      if (!areas.length) return false;
      const current = fromCanvas ? areas.findIndex((area) => area.dataset.vcFocusArea === 'canvas')
        : areas.indexOf(event.target?.closest?.('[data-vc-focus-area]'));
      const direction = event.shiftKey ? -1 : 1;
      const next = current < 0 ? (direction === 1 ? 0 : areas.length - 1) : (current + direction + areas.length) % areas.length;
      event.preventDefault();
      event.stopPropagation();
      areas[next].focus({ preventScroll: true });
      return true;
    }, []);

    function startResize(event) {
      if (event.button !== 0 || resizeGesture.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      resizeGesture.current = { id: event.pointerId, x: event.clientX, width: threadWidth, previous: requestedThreadWidth };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional for synthetic input. */ }
      setResizing(true);
    }

    function moveResize(event) {
      const gesture = resizeGesture.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      setRequestedThreadWidth(clampThreadWidth(gesture.width + event.clientX - gesture.x));
    }

    function endResize(event) {
      const gesture = resizeGesture.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      resizeGesture.current = null;
      if (event.type === 'pointercancel') setRequestedThreadWidth(gesture.previous);
      setResizing(false);
    }

    function resizeWithKey(event) {
      if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
      const step = event.shiftKey ? 48 : 16;
      const widths = { ArrowLeft: threadWidth - step, ArrowRight: threadWidth + step, Home: minimumThreadWidth, End: threadWidthLimit };
      if (!Object.hasOwn(widths, event.key)) return;
      event.preventDefault();
      setRequestedThreadWidth(clampThreadWidth(widths[event.key]));
    }

    async function perform(label, run) {
      if (action.current) return;
      polling.current?.abort();
      const controller = new AbortController();
      action.current = controller;
      setWorking(label);
      try {
        return await run(controller.signal);
      } finally {
        if (action.current === controller) {
          action.current = null;
          if (!controller.signal.aborted) setWorking('');
        }
      }
    }

    function prepareSelection(id, nextView) {
      setSelected(id);
      setView(nextView);
      setFeedback('');
      setPollPaused(false);
      setHistoryOpen(false);
      setDesignPane('split');
      setPlaygroundView(null);
      setCanvasHistoryOpen(false);
      setCanvasRequest(null);
      setSourceTurn(null);
      dismissComposerPanel();
      setMaterialsOpen(false);
      composing.current = false;
      composingSteer.current = null;
      compositionEndedAt.current = -Infinity;
      followReply.current = true;
    }

    function openTurnCanvas(turnId) {
      showPlaygroundBoards(false);
      setCanvasHistoryOpen(false);
      setCanvasRequest({ turnId });
      if (visiblePane === 'chat') setDesignPane(roomy ? 'split' : 'canvas');
    }

    function expandProject(projectId) {
      if (!sidebarActions || !projects.has(projectId)) return;
      setExpandedProjects((previous) => previous.includes(projectId) ? previous : [...previous, projectId]);
    }

    function toggleProject(projectId) {
      const expanded = expandedProjects.includes(projectId);
      setExpandedProjects(expanded ? expandedProjects.filter((id) => id !== projectId) : [...expandedProjects, projectId]);
      if (!expanded || category === projectId) setProjectFilter(expanded ? null : projectId);
    }

    function draftRow(list, draftMode, projectId) {
      return list.find((row) =>
        row.local && row.mode === draftMode && projectFor(row) === projectId && !row.projectMemoryIsolated &&
        !(extensions && conversationIsolated?.(extensions.state, { targetId: scope, sessionId: row.id })) &&
        !attempts[row.id] && !drafts[row.id]?.trim())
        ?? { id: newIdentifier(), mode: draftMode, title: modeTitle(draftMode), local: true, projectId };
    }

    async function saveMembership(sessionId, projectId, inheritMemory) {
      try {
        const key = membershipKey(scope);
        const next = updateProjectMembership(readProjectMemberships(scope), sessionId, projectId, inheritMemory);
        const value = Object.keys(next).length ? JSON.stringify(next) : null;
        if (saveConversationPreference) await saveConversationPreference(key, value);
        else if (value === null) workbenchStorage.removeItem(key);
        else workbenchStorage.setItem(key, value);
        setProjectMemberships(next);
        setProjectWarning('');
        return true;
      } catch {
        setProjectWarning('会话归类未能保存到本机。');
        return false;
      }
    }

    function canMoveSession(row, projectId) {
      return ready && row && !action.current && (!projectId || projects.has(projectId)) && projectId !== projectFor(row);
    }

    function needsMemoryChoice(from, to) {
      return Boolean(extensions && from !== to && projects.has(from) && projects.has(to));
    }

    async function moveSession(row, projectId, inheritMemory) {
      if (!canMoveSession(row, projectId) || (needsMemoryChoice(projectFor(row), projectId) &&
          typeof inheritMemory !== 'boolean')) return false;
      return perform('move-project', async (signal) => {
        if ((!row.local || attempts[row.id] || projectMembershipFor(projectMemberships, row.id)) &&
            !await saveMembership(row.id, projectId, inheritMemory)) return false;
        if (signal.aborted) return false;
        if (row.local) {
          setAllRows((previous) => ({
            ...previous, [scope]: previous[scope].map((entry) => entry.id === row.id
              ? { ...entry, projectId, projectMemoryIsolated: inheritMemory === false } : entry),
          }));
        }
        if (sidebarActions && row.id === selected) setProjectFilter(projectId || null);
        expandProject(projectId);
        if (saveConversationPreference) {
          notifyContext(projectId ? `已移入「${projects.get(projectId)}」` : '已移至未归类');
          restoreConversationFocus(row.id);
        }
        return true;
      });
    }

    function requestSessionMove(row, projectId) {
      if (!canMoveSession(row, projectId)) return;
      if (needsMemoryChoice(projectFor(row), projectId)) {
        setConversationDialog({ kind: 'move', id: row.id, scope, destinationId: projectId });
      } else void moveSession(row, projectId);
    }

    function startSessionDrag(event, row) {
      if (action.current) return event.preventDefault();
      event.dataTransfer.setData(sessionDragType, 'move');
      event.dataTransfer.effectAllowed = 'move';
      draggedSession.current = { scope, id: row.id };
      setDraggedSessionId(row.id);
    }

    function endSessionDrag() {
      draggedSession.current = null;
      setDraggedSessionId(null);
      setDropProject(null);
    }

    function dropSession(event, projectId, drop) {
      if (draggedSession.current?.scope !== scope || !event.dataTransfer.types.includes(sessionDragType)) return;
      const row = rows.find(({ id }) => id === draggedSession.current.id);
      if (!canMoveSession(row, projectId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (drop) {
        endSessionDrag();
        requestSessionMove(row, projectId);
      } else setDropProject(projectId);
    }

    function openContextMenu(event, anchor, label, groups, { canvas, ...placement } = {}) {
      const request = {
        ...contextMenuRequest(event, anchor, label, groups, placement), scope, canvas, id: ++contextMenuSequence.current,
      };
      // The new auto popover closes the old one. Its element stays mounted through the shared exit transition.
      setContextMenus((current) => [...current, request]);
    }

    function openCanvasMenu(event, anchor, label, groups, placement) {
      openContextMenu(event, anchor, label, groups, { ...placement, canvas: { sessionId: selected, view: playgroundView } });
    }

    async function copyBoardHtml(html, count = 1) {
      const copied = await writeClipboard(html).catch(() => false);
      if (count === 1) notifyContext(copied ? '已复制画板 HTML' : '复制画板 HTML 失败');
      else notifyContext(copied ? `已复制 ${count} 张画板的 HTML` : '无法复制所选画板，请试用 ZIP 导出。');
    }

    function notifyContext(text) { setContextNotice({ text }); }

    function restoreConversationFocus(id) {
      requestAnimationFrame(() => {
        if (!workbench.current || document.activeElement !== document.body) return;
        const target = workbench.current.querySelector(`.vc-session[data-session-id="${id}"]`);
        const archive = workbench.current.querySelector('.vc-archive-toggle');
        (target && !target.closest('[inert]') ? target : archive)?.focus({ preventScroll: true });
      });
    }

    async function changeConversationOptions(row, change, notice) {
      if (!scope || !row || row.local || conversationWrite.current) return false;
      if (!conversationOptions) {
        notifyContext('暂时无法读取本机的会话设置。');
        return false;
      }
      conversationWrite.current = true;
      try {
        const next = updateConversationOptions(conversationOptions, row.id, change);
        await saveConversationPreference(conversationOptionsKey(scope), Object.keys(next).length ? JSON.stringify(next) : null);
        setConversationEdits((previous) => ({ ...previous, [scope]: next }));
        if (notice) notifyContext(notice);
        restoreConversationFocus(row.id);
        return true;
      } catch {
        notifyContext('会话设置未能保存。');
        return false;
      } finally {
        conversationWrite.current = false;
      }
    }

    function openConversationMenu(event, row) {
      if (!saveConversationPreference || (event.type === 'keydown' && !contextMenuKey(event))) return;
      const { pinned, archived } = conversationOptions?.[row.id] ?? {};
      const saved = !row.local;
      const groups = [
        archived ? [] : [{ id: 'pin', icon: pinned ? 'unpin' : 'pin', label: pinned ? '取消置顶' : '置顶会话',
          disabled: !saved, run: () => void changeConversationOptions(row, { pinned: !pinned }) }],
        [{ id: 'rename', icon: 'rename', label: '重命名…', disabled: !saved,
          run: () => setConversationDialog({ kind: 'rename', id: row.id, scope }) },
        { id: 'move', icon: 'folder', label: '移动到项目…', disabled: !projects.size && !projectFor(row),
          run: () => setConversationDialog({ kind: 'move', id: row.id, scope }) }],
        [{ id: 'archive', icon: archived ? 'restore' : 'archive', label: archived ? '恢复会话' : '归档会话',
          disabled: !saved, run: () => void changeConversationOptions(row, { archived: !archived },
            archived ? '已恢复会话' : '已归档会话') }],
      ];
      openContextMenu(event, event.currentTarget, '会话操作', groups);
    }

    function openProjectMenu(event, projectId, expanded) {
      if (!saveConversationPreference || (event.type === 'keydown' && !contextMenuKey(event))) return;
      const pinned = pinnedProjects.has(projectId);
      openContextMenu(event, event.currentTarget, '项目操作', [[{
        id: 'pin', icon: pinned ? 'unpin' : 'pin', label: pinned ? '取消置顶项目' : '置顶项目',
        run: () => void changeProjectPin(projectId),
      }], [
        { id: 'new-chat', icon: 'new-chat', label: '在项目里新建聊天', disabled: !chatEnabled || Boolean(working),
          run: () => newSession('chat', { projectId }) },
        { id: 'toggle', icon: 'chevron', label: expanded ? '收起项目会话' : '展开项目会话',
          run: () => toggleProject(projectId) },
      ]]);
    }

    async function changeProjectPin(projectId) {
      if (conversationWrite.current || !projects.has(projectId)) return;
      conversationWrite.current = true;
      const next = new Set(pinnedProjects);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      try {
        await saveConversationPreference(pinnedProjectsKey, next.size ? JSON.stringify([...next]) : null);
        setPinnedProjects(next);
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) workbench.current
            ?.querySelector(`.vc-project-filter[data-project-id="${CSS.escape(projectId)}"]`)?.focus({ preventScroll: true });
        });
      } catch {
        notifyContext('项目置顶设置未能保存。');
      } finally {
        conversationWrite.current = false;
      }
    }

    function openEditorMenu(event) {
      if (!editText || (event.type === 'keydown' && !contextMenuKey(event))) return false;
      const input = event.currentTarget;
      if (input.disabled) return false;
      input.focus({ preventScroll: true });
      const selectedText = input.selectionStart < input.selectionEnd;
      const unavailable = {
        undo: input.readOnly || !document.queryCommandEnabled('undo'),
        redo: input.readOnly || !document.queryCommandEnabled('redo'),
        cut: input.readOnly || !selectedText, copy: !selectedText, paste: input.readOnly,
        selectAll: input.value.length === 0,
      };
      const groups = editMenuGroups.map((group) => group.map(([id, label, shortcut]) => ({
        id, label, shortcut, icon: id === 'selectAll' ? 'select-all' : id, disabled: unavailable[id],
        run: () => { void editText(id).catch(() => notifyContext(id === 'paste' ? '无法读取剪贴板。' : '编辑操作未完成。')); },
      })));
      openContextMenu(event, input, '编辑消息', groups);
      return true;
    }

    function openMessageMenu(event) {
      if (!saveConversationPreference || (event.type === 'keydown' && !contextMenuKey(event))) return;
      const target = event.target;
      const region = event.currentTarget;
      const article = target.closest('.vc-turn');
      const turn = shownTurns.find(({ id }) => id === article?.dataset.turnId);
      const selection = document.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const selectedText = range && region.contains(range.commonAncestorContainer) && range.intersectsNode(target)
        ? selection.toString() : '';
      const code = target.closest('.vc-code-block')?.querySelector('pre code')?.textContent;
      function copy(id, label, text, icon = 'copy') {
        return { id, label, icon, async run() {
          const copied = await writeClipboard(text).catch(() => false);
          notifyContext(copied ? '已复制' : '复制失败');
        } };
      }
      const userMessage = target.closest('.vc-user');
      const text = userMessage ? turn?.prompt : turn?.reply;
      const selectionItems = selectedText ? [copy('selection', '复制所选文字', selectedText)] : [];
      const messageItems = [];
      if (code) messageItems.push(copy('code', '复制代码', code, 'code'));
      if (text) messageItems.push(copy('message', userMessage ? '复制消息' : '复制回复', text));
      if (selectionItems.length || messageItems.length) {
        openContextMenu(event, event.type === 'keydown' ? target : article ?? region, '消息操作', [selectionItems, messageItems]);
      }
    }

    function setSettingsOpen(tab) {
      if (settingsSurface) {
        if (!tab) settingsSurface.close();
        else if (settingsTab) settingsSurface.setTab(tab);
        else settingsSurface.open(tab);
        return;
      }
      setSettingsView(previous => previous.tab === tab ? previous : {
        tab, visit: previous.visit + Number(Boolean(tab) && !previous.tab),
      });
    }

    function openSettings(tab = ready ? 'tools' : 'connection') {
      if (!settingsSurface) {
        presetRequest.current?.abort();
        setLoadingPreset(false);
        setHistoryOpen(false);
      }
      setSettingsError('');
      dismissComposerPanel();
      setMaterialsOpen(false);
      setSettingsOpen(tab);
    }

    function openAccount(actionId) {
      if (getAccountAction(actionId)) setRequestedAccount({ actionId });
    }

    function openSetup() {
      if (providerSwitchLocked) return;
      if (!settingsSurface) {
        presetRequest.current?.abort();
        setLoadingPreset(false);
      }
      setSettingsOpen(false);
      dismissComposerPanel();
      setMaterialsOpen(false);
      setSetupOpen(true);
    }

    function applySavedConfiguration(settings, list, tools) {
      const name = '本机保存的 VPS';
      const profiles = readToolProfiles(tools.key, toolIds);
      if (list.targetId === scope && ready) {
        setConnection(settings);
        setConnectionName(name);
        setToolPreferences(tools);
        setToolProfiles(profiles);
        setSavedConfiguration(null);
      } else {
        setSavedConfiguration({ ...list, settings, name, tools, profiles });
        if (visible && !ready) setLoadingPreset(true);
      }
    }

    async function applySetupConnection(settings, list, signal) {
      const saved = await readToolPreferences(settings, toolIds);
      const ids = toolIds.filter((id) => id === settings.provider || saved.ids?.includes(id));
      signal.throwIfAborted();
      await saveConversationPreference(saved.key, JSON.stringify(ids));
      signal.throwIfAborted();
      await saveConversationPreference(setupConnectionKey, JSON.stringify({ settings, targetId: list.targetId }));
      signal.throwIfAborted();
      setPinConfirmationRequired(false);
      applySavedConfiguration(settings, list, { ...saved, ids });
    }

    async function enableSetupTool(id) {
      const ids = toolIds.filter((tool) => tool === id || configuration.tools.ids.includes(tool));
      if (!await saveTools(ids, configuration.tools.key)) throw new Error('tool_preferences_unavailable');
    }

    function activateConnection(settings, { targetId: route, sessions: list, memoryTargetId: memoryRoute }, name = '') {
      const local = (allRows[route] ?? []).filter((row) => row.local && !list.some(({ id }) => id === row.id));
      const row = draftRow(local, 'chat', category ?? '');
      if (localSdk && !scope && drafts[unboundDraft]) {
        setDrafts((previous) => ({ ...previous, [row.id]: previous[unboundDraft], [unboundDraft]: '' }));
      }
      try {
        setProjectMemberships(readProjectMemberships(route));
        setProjectWarning('');
      } catch {
        setProjectMemberships({});
        setProjectWarning('暂时无法读取本机的会话归类。');
      }
      setAllRows((previous) => ({
        ...previous, [route]: [row, ...local.filter(({ id }) => id !== row.id), ...list],
      }));
      setConnection(settings);
      setConnectionName(name);
      setScope(route);
      setMemoryTargetId(memoryRoute);
      prepareSelection(row.id, emptySession(row.id, 'chat'));
    }

    function saveSettings(settings, { pinConfirmedAgain = false } = {}) {
      return perform('settings', async (signal) => {
        setSettingsError('');
        try {
          const op = settingsSurface ? 'configuration' : 'list';
          const list = readList(await rpc(op, { settings }, signal));
          signal.throwIfAborted();
          if (setupConnectionKey && configurationReady && !pinConfirmedAgain) {
            const previous = readList(await rpc(op, { settings: configuration.settings }, signal));
            signal.throwIfAborted();
            if (previous.targetId !== configuration.targetId) {
              setPinConfirmationRequired(true);
              throw Object.assign(new Error('SSH 主机指纹已变化。请重新核对并确认后保存。'), { code: 'target_changed' });
            }
          }
          const preferences = await readToolPreferences(settings, toolIds);
          signal.throwIfAborted();
          if (setupConnectionKey) {
            await saveConversationPreference(setupConnectionKey, JSON.stringify({ settings, targetId: list.targetId }));
            signal.throwIfAborted();
            setPinConfirmationRequired(false);
            applySavedConfiguration(settings, list, { ...preferences, ids: preferences.ids ?? [settings.provider] });
            return true;
          }
          const ids = preferences.ids ?? (preferences.key === toolPreferences.key ? toolPreferences.ids : []);
          setToolPreferences({ ...preferences, ids });
          setToolProfiles(readToolProfiles(preferences.key, toolIds));
          setSubscriptionOpen(false);
          activateConnection(settings, list, list.targetId === scope ? connectionName : '');
          setSettingsOpen(ids.length ? false : 'tools');
          return true;
        } catch (error) {
          if (signal.aborted) return false;
          setSettingsError(errorText(error, setupConnectionKey ? '连接配置未能保存。请检查本机设置后重试。' :
            '暂时无法读取会话。请检查连接设置和工作台服务。'));
          if (!setupConnectionKey) setSettingsOpen('connection');
          return false;
        }
      });
    }

    async function saveTools(ids, key) {
      if (!key || !configurationReady || providerSwitchLocked || key !== configuration.tools.key) return false;
      const next = toolIds.filter((id) => ids.includes(id));
      setSettingsError('');
      try {
        if (saveConversationPreference) await saveConversationPreference(key, JSON.stringify(next));
        else workbenchStorage.setItem(key, JSON.stringify(next));
      } catch {
        setSettingsError('执行端配置未能保存到本机。');
        return false;
      }
      setToolPreferences((previous) => previous.key === key ? { ...previous, ids: next } : previous);
      setSavedConfiguration((previous) => previous?.tools.key === key ? { ...previous, tools: { ...previous.tools, ids: next } } : previous);
      if (toolPreferences.key === key && !next.includes(subscriptionProvider)) setSubscriptionOpen(false);
      return true;
    }

    async function updatePreferences(patch) {
      const next = { ...preferences, ...patch };
      try {
        if (applicationPreferences) {
          if (!await applicationPreferences.change(patch)) throw new Error('preference_write_failed');
        } else {
          writePreferences(next);
          setPreferences(next);
        }
      } catch {
        setSettingsError('本地偏好未能保存。');
        return false;
      }
      setSettingsError('');
      return true;
    }

    async function updateTool(id, patch) {
      const key = configuration.tools.key;
      if (!configurationReady || !key || !toolIds.includes(id)) return false;
      const write = toolProfileWrites.current.then(() => {
        const profiles = readToolProfiles(key, toolIds);
        return writeToolProfiles(key, { ...profiles, [id]: { ...profiles[id], ...patch } }, toolIds, saveConversationPreference);
      });
      toolProfileWrites.current = write.catch(() => {});
      try {
        const saved = await write;
        if (key === activeToolKey.current) setToolProfiles(saved);
        if (localSdk) setLocalToolProfiles((previous) => ({ ...previous, [key]: saved }));
        setSavedConfiguration((previous) => previous?.tools.key === key ? { ...previous, profiles: saved } : previous);
      } catch {
        setSettingsError('执行端的独立设置未能保存到本机。');
        return false;
      }
      setSettingsError('');
      return true;
    }

    async function readProviderModels(provider, signal, route = { settings: connection, targetId: scope, memoryTargetId }) {
      if (!route.settings || !route.targetId || !toolsWithModels.includes(provider)) throw new Error('当前执行端不提供模型目录。');
      if (localSdk && provider !== route.settings.provider) {
        const profile = local.profileForBackend(provider);
        const target = profile && local.routeForTarget(profile.targetId);
        if (!target) throw new Error('请先登记对应的本机执行端配置。');
        return { targetId: target.targetId, models: readModelCatalog(await rpc('models', target, signal)) };
      }
      const settings = { ...route.settings, provider };
      let targetId = route.targetId;
      if (provider !== route.settings.provider) {
        const resolved = readList(await rpc(settingsSurface ? 'configuration' : 'list', { settings }, signal));
        if (VpsConnectionChecks && (!route.memoryTargetId || resolved.memoryTargetId !== route.memoryTargetId))
          throw new Error('SSH 主机指纹或 VPS 配置已变化。请重新核对连接。');
        targetId = resolved.targetId;
      }
      const models = readModelCatalog(await rpc('models', { settings, targetId }, signal));
      return { targetId, models };
    }

    async function readSettingsModels(provider, signal) {
      const result = await readProviderModels(provider, signal, configuration);
      if (!signal.aborted) setModelCatalogs(previous => ({ ...previous, [result.targetId]: { models: result.models } }));
      return result;
    }

    async function readMemoryModels(signal) {
      if (!remoteEnabled || !configurationReady || !configuration.memoryTargetId ||
          (!localSdk && !configuration.settings?.hostKeyConfirmed)) {
        throw new Error(localSdk ? '请选择本机配置并启用执行后读取记忆提炼模型。' : '请连接并确认当前 VPS 后读取记忆提炼模型。');
      }
      const settings = { ...configuration.settings, provider: 'codex' };
      return readModelCatalog(await rpc('models', { settings, targetId: configuration.memoryTargetId }, signal));
    }

    async function providerUpdate(provider, signal) {
      if (localSdk) {
        const profile = local.profileForBackend(provider);
        if (!profile) throw new Error('请先登记这个执行端的本机配置。');
        if (profile.id !== local.profile?.id) await rpc('list', local.routeForTarget(profile.targetId), signal);
        return () => local.openProfile(profile);
      }
      if (provider === subscriptionProvider) {
        const preset = {
          settings: connection, targetId: scope, name: connectionName, requireRelay: subscriptionRequiresRelay,
        };
        return () => {
          setSubscriptionPreset(previous => previous?.targetId === scope &&
            Object.entries(connection).every(([key, value]) => previous.settings[key] === value) ? previous : preset);
          setSubscriptionActivation(visit => visit + 1);
          setComposerPanels([]);
          setAccountOpen(null);
          setHistoryOpen(false);
          setSubscriptionOpen(true);
        };
      }
      if (provider === connection.provider) return () => setSubscriptionOpen(false);
      const settings = { ...connection, provider };
      const list = readList(await rpc('list', { settings }, signal));
      return () => {
        setSubscriptionOpen(false);
        activateConnection(settings, list, connectionName);
      };
    }

    function crossesSubscriptionView(provider) {
      return Boolean(settingsSurface && (showingSubscription || provider === subscriptionProvider));
    }

    function changeProvider(provider, origin) {
      if (!ready || providerSwitchLocked || !configuredTools.some(({ id }) => id === provider)) return;
      void perform('provider', async (signal) => {
        try {
          const update = await providerUpdate(provider, signal);
          if (signal.aborted) return;
          const motion = toolProfiles[provider]?.motion ?? preferences.motion;
          const animate = active && motion !== 'reduce';
          const commit = () => new Promise(resolve => {
            if (signal.aborted) return resolve();
            const done = () => {
              signal.removeEventListener('abort', done);
              resolve();
            };
            setFeedback('');
            update();
            // The new snapshot can be captured once React has mounted the new view and theme.
            signal.addEventListener('abort', done, { once: true });
            setAcknowledgeSwitch(() => done);
          });
          if (crossesSubscriptionView(provider)) {
            await transitionSubscriptionView(workbench.current, animate && activePreferences.motion !== 'reduce', commit, signal, onThemeReveal);
          } else {
            await transitionToolView(workbench.current, provider, animate ? origin : null, commit, signal, onThemeReveal);
          }
        } catch (error) {
          if (!signal.aborted) setFeedback(errorText(error, '暂时无法切换执行端。'));
        }
      });
    }

    function startNewChat() {
      if (savedConfiguration?.settings && savedConfiguration.targetId !== scope) {
        setLoadingPreset(true);
        return true;
      }
      return newSession('chat');
    }

    function newSession(sessionMode, { carryDraft = false, projectId = category ?? '', playground = false } = {}) {
      if (!chatEnabled || action.current || (sessionMode === 'design' && !designAvailable)) return;
      expandProject(projectId);
      polling.current?.abort();
      const row = draftRow(rows, sessionMode, projectId);
      if (carryDraft && row.id !== selected && draft) {
        setDrafts((previous) => ({ ...previous, [row.id]: previous[selected], [selected]: '' }));
      }
      setAllRows((previous) => ({
        ...previous, [scope]: [row, ...rows.filter(({ id }) => id !== row.id)],
      }));
      prepareSelection(row.id, emptySession(row.id, sessionMode));
      if (playground) setPlaygroundView('boards');
      return row.id;
    }

    function prepareWorkflowChat() {
      if (!remoteEnabled || (localSdk && !local.runtimeReady) || !chatEnabled || providerSwitchLocked || action.current) return null;
      const sessionId = newSession('chat', { projectId: '' });
      if (!sessionId) return null;
      setSubscriptionOpen(false);
      requestAnimationFrame(() => editor.current?.focus({ preventScroll: true }));
      return { targetId: scope, sessionId };
    }

    function showPlaygroundBoards(show) {
      dismissComposerPanel();
      setPlaygroundView((view) => show ? 'boards' : view && 'single');
    }

    function leavePlayground() {
      dismissComposerPanel();
      setPlaygroundView(null);
      setCanvasHistoryOpen(false);
      setDesignPane('chat');
      requestAnimationFrame(() => editor.current?.focus({ preventScroll: true }));
    }

    function closeCanvasHistory(event) {
      if (!canvasHistoryOpen || event.defaultPrevented || event.key !== 'Escape' ||
          event.nativeEvent.isComposing || composing.current || workbench.current?.querySelector(':popover-open')) return;
      event.preventDefault();
      setCanvasHistoryOpen(false);
      canvasHistoryTrigger.current?.focus({ preventScroll: true });
    }

    function openPlayground() {
      if (!designAvailable || action.current) return;
      if (!design) return newSession('design', { projectId: category ?? selectedProject, playground: true });
      showPlaygroundBoards(true);
    }

    function focusPlaygroundPrompt(suggestion) {
      if (typeof suggestion === 'string' && suggestion && !draft.trim()) updateDraft(selected, suggestion);
      if (!floatingChat) setDesignPane(roomy ? 'split' : 'chat');
      requestAnimationFrame(() => editor.current?.focus({ preventScroll: true }));
    }

    function changeComposerMode(nextMode) {
      if (nextMode === mode) return dismissComposerPanel();
      newSession(nextMode, { carryDraft: canMoveDraft, projectId: selectedProject });
    }

    function changeMemoryMode(isolated) {
      if (!memoryAvailable || isolated === memoryIsolated || providerSwitchLocked || extensions.busy) return;
      const fresh = !selectedRow?.local || snapshot?.session.turns.length > 0;
      const id = fresh ? newIdentifier() : selected;
      void perform('memory-context', async (signal) => {
        try {
          await extensions.change({ op: 'set-conversation-isolation', targetId: scope, sessionId: id, isolated });
          if (signal.aborted) return;
          if (fresh) {
            const row = { id, mode, title: modeTitle(mode), local: true, projectId: selectedProject };
            setAllRows((previous) => ({ ...previous, [scope]: [row, ...(previous[scope] ?? [])] }));
            if (draft) setDrafts((previous) => ({ ...previous, [id]: draft, [selected]: '' }));
            prepareSelection(id, emptySession(id, mode));
            setFeedback(isolated ? '已新建独立会话，原聊天仍可续聊。' : '已新建使用记忆设置的聊天。');
          } else dismissComposerPanel();
        } catch { if (!signal.aborted) setFeedback('无法保存这条会话的记忆设置。'); }
      });
    }

    async function loadModels() {
      if (!modelAllowed || catalog?.models || modelReads.current.has(scope)) return;
      const targetId = scope;
      const controller = new AbortController();
      modelReads.current.set(targetId, controller);
      setModelCatalogs((previous) => ({ ...previous, [targetId]: { loading: true } }));
      try {
        const { models } = await readProviderModels(connection.provider, controller.signal);
        if (!controller.signal.aborted) setModelCatalogs((previous) => ({ ...previous, [targetId]: { models } }));
      } catch (error) {
        if (!controller.signal.aborted) setModelCatalogs((previous) => ({
          ...previous, [targetId]: { error: errorText(error, localSdk ? '暂时无法读取本机 Codex 模型目录。' : '暂时无法读取 VPS 模型目录。') },
        }));
      } finally {
        if (modelReads.current.get(targetId) === controller) modelReads.current.delete(targetId);
      }
    }

    function dismissComposerPanel() {
      workbench.current?.querySelector('.vc-composer-panel[role=dialog]:popover-open')?.hidePopover();
    }

    function insertPluginPrompt(text) {
      if (!selected || action.current) return;
      const next = draft.trim() ? draft.trimEnd() + '\n\n' + text : text;
      if (next.length > (steerOffered ? maxSteerLength : maxPromptLength)) {
        setFeedback('模板与当前草稿合并后超出长度限制。');
        dismissComposerPanel();
        return;
      }
      updateDraft(selected, next);
      dismissComposerPanel();
      editor.current?.focus({ preventScroll: true });
    }

    function openComposerPanel(kind, anchor) {
      const existing = composerPanels.find((panel) => panel.kind === kind);
      if (existing?.anchor === anchor) {
        const panel = workbench.current.querySelector(`.vc-composer-panel[data-kind="${kind}"]`);
        if (panel.matches(':popover-open')) panel.hidePopover();
        // Light dismissal can close the popover before this same click reaches the trigger.
        else if (panel.inert) panel.showPopover({ source: anchor });
        return;
      }
      setComposerPanels((panels) => panels.filter((panel) => panel.kind !== kind).concat({ kind, anchor, expanded: true }));
      if (kind === 'model' && !catalog) void loadModels();
    }

    function chooseModel(id, effort) {
      if (!ready) return;
      const entry = catalog?.models?.find((candidate) => candidate.id === id);
      if (id && (!entry || (effort && !entry.efforts.includes(effort)))) return;
      setModelSelections(previous => {
        const next = { ...previous };
        if (id === undefined) delete next[modelKey];
        else next[modelKey] = id ? { id, effort } : null;
        return next;
      });
    }

    async function applyModelParameters(next) {
      const keys = Object.keys(next);
      if (!scope || modelParameterWrite.current || (keys.length && (!validModelParameters(connection.provider, next) ||
          keys.some((key) => !parameterAvailability?.fields?.includes(key))))) throw new Error('invalid_model_parameters');
      modelParameterWrite.current = true;
      setSavingModelParameters(true);
      try {
        await saveModelParameters(modelParametersKey(scope), keys.length ? JSON.stringify(next) : null);
        setModelParameterProfiles((previous) => ({ ...previous, [scope]: next }));
      } finally {
        modelParameterWrite.current = false;
        setSavingModelParameters(false);
      }
    }

    function openChat(row, source) {
      if (!ready || action.current) return;
      const rowMode = row.mode ?? 'chat';
      if (sidebarActions) {
        const project = projectFor(row);
        setProjectFilter(projects.has(project) ? project : null);
        expandProject(project);
      }
      if (row.id === selected && snapshot) {
        setHistoryOpen(false);
        if (source) revealSource(snapshot.session, source);
        return;
      }
      if (row.local && !attempts[row.id]) {
        polling.current?.abort();
        prepareSelection(row.id, emptySession(row.id, rowMode));
        return;
      }
      return perform('history', async (signal) => {
        prepareSelection(row.id, null);
        try {
          const response = await rpc('get', { settings: connection, targetId: scope, sessionId: row.id }, signal);
          if (!signal.aborted) {
            const record = readSession(response, row.id, rowMode);
            accept(record, scope, { sent: attempts[row.id] });
            if (source) revealSource(record.session, source);
          }
        } catch (error) {
          if (!signal.aborted && !targetChanged(error)) setFeedback(errorText(error, '暂时无法读取这段会话。'));
        }
      });
    }

    function revealSource(session, { turnId, boardIndex }) {
      if (!session.turns.some((turn) => turn.id === turnId)) return;
      if (session.mode === 'design' && boardIndex) {
        showPlaygroundBoards(false);
        setCanvasHistoryOpen(false);
        setDesignPane(roomy ? 'split' : 'canvas');
        setCanvasRequest({ turnId, boardIndex });
      } else {
        setDesignPane('chat');
        if (floatingChat) setCanvasHistoryOpen(true);
        setSourceTurn({ sessionId: session.id, turnId });
      }
    }

    function openResourceSource(source) {
      const row = rows.find(({ id, local }) => id === source.sessionId && !local);
      if (!ready || !row || action.current) return false;
      setSubscriptionOpen(false);
      void openChat(row, source);
      return true;
    }

    function send(explicitNewTurn = false) {
      if (!canSend || action.current || modelParameterWrite.current || (supplementDraft && !explicitNewTurn)) return;
      if (submittedDraft.current?.sessionId === selected && submittedDraft.current.draft === draft) return;
      return perform('send', async (signal) => {
        if (selectedRow?.local && (selectedProject || projectMembershipFor(projectMemberships, selected))) {
          if (!await saveMembership(selected, selectedProject, projectMemorySuppressed ? false : undefined)) return;
        }
        if (signal.aborted) return;
        const sent = {
          id: newIdentifier(), sessionId: selected, prompt, draft, sharedDesign: Boolean(attached?.context || attached?.base),
        };
        const editingWorkflow = !design && workflows?.editLabel;
        let outgoingPrompt = sent.prompt;
        if (editingWorkflow) {
          try {
            outgoingPrompt = await workflows.prepareEdit(sent.prompt, sent.id);
          } catch (error) {
            if (!signal.aborted) setFeedback(errorText(error, '未能保存本轮工作流编辑。'));
            return;
          }
          if (signal.aborted) return;
        }
        const revisionKey = attached?.revision ? layerRevisionKey(designStorageKey, sent.id) : null;
        const discardUnsentRevision = () => {
          if (revisionKey) void saveConversationPreference(revisionKey, null).catch(() => {});
        };
        if (revisionKey) {
          try {
            await saveConversationPreference(revisionKey, serializeLayerRevision(attached.revision));
          } catch {
            if (!signal.aborted) setFeedback('无法保存本轮的画板基线。请重试。');
            return;
          }
          if (signal.aborted) {
            discardUnsentRevision();
            return;
          }
        }
        submittedDraft.current = sent;
        setAttempts((previous) => ({ ...previous, [selected]: sent }));
        setFeedback('');
        setPollPaused(false);
        followReply.current = true;
        try {
          const response = await rpc('send', {
            settings: connection, targetId: scope, sessionId: selected, turnId: sent.id, prompt: outgoingPrompt,
            ...(design ? { mode, ...(attached?.context ? { designContext: attached.context } : {}) } : {}),
            ...(attached?.base ? { designBase: attached.base } : {}),
            ...(nextModel ? { model: nextModel.id, ...(nextEffort ? { effort: nextEffort } : {}) } : {}),
            ...(chosenParameters.length ? { advanced: modelParameters } : {}),
            ...(!editingWorkflow && turnExtensions ? { extensions: turnExtensions } : {}),
            ...(!editingWorkflow && memoryAvailable ? { projectMemory: { projectId: selectedProject || null } } : {}),
          }, signal);
          if (signal.aborted) return;
          const record = readSession(response, selected, mode);
          accept(record, scope, { sent });
          if (editingWorkflow) workflows.clearEdit();
          if (!record.session.turns.some((turn) => turn.id === sent.id)) setFeedback('未能确认提交回执。请查询这轮任务。');
        } catch (error) {
          if (signal.aborted) return;
          if (error.code === 'target_changed' || rejectedBeforeSend.has(error.code) || localSdk && localSendRejections.has(error.code)) {
            discardUnsentRevision();
            clearAttempt(selected, sent);
            if (submittedDraft.current === sent) submittedDraft.current = null;
            if (targetChanged(error)) return;
            if (error.code === 'invalid_request' && chosenParameters.length) setModelParameterRevision((value) => value + 1);
            if (error.code === 'session_blocked' || error.code === 'turn_conflict') setPollPaused(true);
            setFeedback(errorText(error, '发送请求已被拒绝。'));
          } else {
            if (editingWorkflow) workflows.clearEdit();
            setFeedback('发送结果待确认。请先查询这轮任务。');
          }
        }
      });
    }

    function steer() {
      if (!canSteer || action.current) return;
      return perform('steer', async (signal) => {
        const sent = { id: newIdentifier(), turnId: lastTurn.id, prompt, draft };
        setSupplementDrafts((previous) => ({ ...previous, [steerKey]: { text: draft, turnId: sent.turnId } }));
        setSteerAttempts((previous) => ({ ...previous, [steerKey]: [...(previous[steerKey] ?? []), sent] }));
        setFeedback('');
        followReply.current = true;
        try {
          const response = await rpc('steer', {
            settings: connection, targetId: scope, sessionId: selected, turnId: sent.turnId, steerId: sent.id, prompt: sent.prompt,
          }, signal);
          if (signal.aborted) return;
          accept(readSession(response, selected, mode), scope, { steering: [...pendingSteers, sent] });
        } catch (error) {
          if (signal.aborted || !rejectedBeforeSteer.has(error.code)) return;
          clearSteerAttempts(steerKey, [sent.id]);
          if (targetChanged(error)) return;
          setFeedback(errorText(error, '本轮补充未发送，草稿已保留。'));
        }
      });
    }

    function decideApproval(approvalId, decision) {
      if (!approvalOffered || approvalDisabled || action.current || currentApprovalAttempts?.[approvalId]) return;
      const request = lastTurn.approvals?.find((item) => item.id === approvalId && item.state === 'pending');
      if (!request || (decision !== 'deny' && (decision !== 'allow' || !request.canAllow))) return;
      const turnId = lastTurn.id;
      function recordDecision(state) {
        setApprovalAttempts((previous) => {
          const updated = { ...previous };
          const attempts = { ...previous[steerKey] };
          if (state) attempts[approvalId] = { turnId, decision, state };
          else delete attempts[approvalId];
          if (Object.keys(attempts).length) updated[steerKey] = attempts;
          else delete updated[steerKey];
          return updated;
        });
      }
      return perform('approval', async (signal) => {
        recordDecision('dispatching');
        setFeedback('');
        try {
          const response = await rpc('approval', {
            settings: connection, targetId: scope, sessionId: selected, turnId, approvalId, decision,
          }, signal);
          if (!signal.aborted) recordDecision(approvalOutcomes.has(response.outcome) ? response.outcome : 'unknown');
        } catch (error) {
          if (signal.aborted) return;
          if (!approvalRejections.has(error.code)) {
            recordDecision('unknown');
            return;
          }
          if (error.code === 'approval_unavailable') recordDecision('closed');
          else recordDecision(null);
          if (!targetChanged(error)) setFeedback(errorText(error, '工具授权决定未提交。'));
        }
      });
    }

    function stop() {
      if (!canStop || action.current) return;
      const turnId = lastTurn.id;
      return perform('stop', async (signal) => {
        setFeedback('');
        try {
          const response = await rpc('stop', {
            settings: connection, targetId: scope, sessionId: selected, turnId,
          }, signal);
          if (signal.aborted) return;
          if (response.outcome !== 'requested' && response.outcome !== 'settled') throw new Error('无法确认停止请求。');
          setStopRequests((previous) => ({ ...previous, [selected]: { turnId, state: 'acknowledged' } }));
        } catch (error) {
          if (signal.aborted || targetChanged(error)) return;
          setStopRequests((previous) => ({ ...previous, [selected]: { turnId, state: 'unknown' } }));
          setPollPaused(true);
        }
      });
    }

    function recheck() {
      if (!ready || !selected) return;
      return perform('recheck', async (signal) => {
        setFeedback('');
        try {
          const response = await rpc('get', { settings: connection, targetId: scope, sessionId: selected }, signal);
          if (signal.aborted) return;
          const record = readSession(response, selected, mode);
          accept(record, scope, { sent: attempt });
          if (attempt && !record.session.turns.some((turn) => turn.id === attempt.id)) {
            setFeedback('暂未找到这轮提交的回执。稍后可再次查询。');
            return;
          }
          const state = record.session.turns.at(-1)?.state;
          if (remoteEnabled && (isActive(state) || state === 'unknown' || approvalUnconfirmed || pendingSteers.some((entry) => {
            const receipt = matchingSteer(record.session.turns, entry);
            return !receipt || receipt.state === 'unknown';
          }))) {
            const refreshed = await rpc('refresh', { settings: connection, targetId: scope, sessionId: selected }, signal);
            if (signal.aborted) return;
            accept(readSession(refreshed, selected, mode), scope, { refreshed: true });
          }
          setPollPaused(false);
        } catch (error) {
          if (!signal.aborted && !targetChanged(error)) {
            setFeedback(errorText(error, '暂时无法确认原任务的状态。'));
            setPollPaused(true);
          }
        }
      });
    }

    function handleKey(event) {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey !== (activePreferences.sendKey === 'ctrl-enter') ||
          event.altKey || event.metaKey ||
          composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 ||
          event.timeStamp - compositionEndedAt.current < 40) return;
      event.preventDefault();
      if (!event.repeat) submitComposer();
    }

    function submitComposer() {
      if (steerOffered) void steer();
      else void send();
    }

    function fillExample() {
      if (!selected || draft || attempt || action.current) return;
      updateDraft(selected, design
        ? '为一家独立书店设计网站。制作首页和活动详情两个画板，突出本周推荐与读书会报名，采用米白与深绿配色。'
        : localSdk ? '请阅读本机只读工作目录的项目说明，用三条要点介绍这个项目，再列出值得先看的文件。'
          : '请阅读 VPS 工作区的项目说明，用三条要点介绍这个项目，再列出值得先看的文件。');
      editor.current?.focus();
    }

    const shownTurns = attempt && !turns.some((turn) => turn.id === attempt.id)
      ? [...turns, { id: attempt.id, prompt: attempt.prompt, reply: '', state: working === 'send' ? 'pending' : 'unknown', activity: [] }]
      : turns;
    const steerUnconfirmed = pendingSteers.length > 0 && working !== 'steer';
    const needsCheck = Boolean(selected && ((attempt && working !== 'send') || pollPaused || stopUncertain || steerUnconfirmed || approvalUnconfirmed ||
      lastState === 'unknown' || (!snapshot && feedback)));
    const blockedAfterTurn = snapshot?.canSend === false && !needsCheck && !isActive(lastState);
    const banner = feedback || (stopUncertain ? '停止请求结果待确认。请查询原任务。'
      : steerUnconfirmed ? '补充提交结果待确认。可查询原任务。'
        : approvalUnconfirmed ? '工具授权结果待确认。可查询原任务。'
          : needsCheck ? '请查询原任务状态后继续。' : blockedAfterTurn ? '请新建对话以继续使用。'
          : parametersBlocked ? '请在「模型 → 高级参数」确认该执行端的参数，或恢复默认后发送。' : '');
    const title = conversationOptions?.[selected]?.title ?? snapshot?.session.title ?? selectedRow?.title ??
      (localSdk ? '本地 Codex SDK' : 'VPS 对话');
    const routeStatus = ready ? `${connectionName ? `${connectionName} · ` : ''}VPS 已配置` : 'VPS 待配置';
    const stopBusy = working === 'stop' || stopPending;
    const steerBusy = working === 'steer';
    const waitingForReceipt = Boolean(attempt || working === 'send');
    const sendLabel = supplementDraft ? '作为新一轮发送' : '发送';
    const stopLabel = stopBusy ? '正在停止' : '停止生成';
    const sendKey = activePreferences.sendKey === 'ctrl-enter' ? 'Ctrl+Enter' : 'Enter';
    const newlineKey = activePreferences.sendKey === 'ctrl-enter' ? 'Enter' : 'Shift+Enter';
    const composerHint = !remoteEnabled ? '仅浏览 · 可以编辑并保留草稿'
      : working === 'send' ? (localSdk ? `正在发送至本机 ${providerName}` : '正在发送至 VPS')
        : stopBusy ? (localSdk ? '等待本机 SDK 确认停止' : '等待 VPS 确认停止')
      : steerBusy ? '正在提交给当前轮次'
        : waitingForApproval ? '等待工具审批 · 可以保留补充草稿或停止生成'
        : steerOffered ? (earlierSupplement ? '这是前一轮的补充草稿。编辑后可用于当前轮次。' : `${sendKey} 补充当前轮次 · ${newlineKey} 换行`)
          : supplementDraft ? (isActive(lastState) ? '补充草稿已保留。当前轮次结束后可手动发送。' : '补充草稿已保留，可手动作为新一轮发送。')
            : unavailableModel && sessionModel === undefined ? '默认模型已不在目录 · 将沿用会话设置'
              : `${sendKey} 发送 · ${newlineKey} 换行`;
    const chatPaneId = `${viewId}-chat`;
    const chatLogId = `${viewId}-messages`;
    const canvasPaneId = `${viewId}-canvas`;
    const hintId = `${viewId}-composer-hint`;
    const projectStatus = workspaceSnapshot.state === 'error' ? '暂时无法读取本地项目'
      : workspaceSnapshot.phase === 'pending' ? '正在读取本地项目'
        : '暂无本地项目';
    const projectChoices = [[null, '全部会话'], ['', '未归类'], ...projects];
    const currentProjectTitle = selectedProject
      ? projects.get(selectedProject) ?? (workspaceSnapshot.phase === 'pending' ? '正在读取项目' : '项目不可用')
      : '未归类';
    const toolPicker = localSdk && configuredTools.length <= 1 ? h('div', { className: 'vc-tool-picker' },
      h('div', { className: 'vc-tool-summary', title: local.profile?.name },
        h('span', { className: 'vc-tool-badge' }, menuIcon(h, providers[providerId].icon)), h('span', { className: 'vc-tool-label' }, providerName)))
      : ready && configuredTools.length ? h(ProviderPicker, {
      value: activeTool, tools: configuredTools, disabled: providerSwitchLocked, active,
      ariaLabel: localSdk ? '切换本机执行端' : undefined,
      select: changeProvider, closeOnSelect: crossesSubscriptionView, docked: sidebarActions,
    }) : null;
    const accessProvider = showingSubscription ? subscriptionProvider : connection?.provider;
    const accessButton = access ? h(AccessTrigger, { access, provider: accessProvider, localSdk,
      expanded: expandedComposerKind === 'access', open: openComposerPanel }) : null;
    const closeResources = React.useCallback(() => setResourcesOpen(false), [setResourcesOpen]);
    const groups = new Map([['', []], ...[...projects.keys()].map((id) => [id, []])]);
    const pinnedRows = [];
    const archivedRows = [];
    if (sidebarActions) {
      for (const row of rows) {
        const options = conversationOptions?.[row.id];
        if (options?.archived) archivedRows.push(row);
        else if (options?.pinned) pinnedRows.push(row);
        else (groups.get(projectFor(row)) ?? groups.get('')).push(row);
      }
    }
    const archiveOpen = archiveScope === scope;
    const dialogRow = conversationDialog?.scope === scope ? rows.find(({ id }) => id === conversationDialog.id) : null;
    const renderSession = (row) => {
      const label = titleFor(row);
      const { pinned, archived } = conversationOptions?.[row.id] ?? {};
      const dragEnabled = sidebarActions && ready && projects.size > 0 && !working;
      return h('button', {
        type: 'button', key: row.id, title: label, className: 'vc-session', 'data-session-id': row.id,
        'data-dragging': draggedSessionId === row.id ? '' : undefined, draggable: dragEnabled,
        disabled: Boolean(working), 'aria-current': row.id === selected ? 'true' : undefined,
        'aria-label': row.mode === 'design' ? `${label}，设计会话` : undefined,
        'aria-description': pinned && projects.has(projectFor(row)) ? `所属项目 ${projects.get(projectFor(row))}` : undefined,
        'aria-keyshortcuts': saveConversationPreference ? 'Shift+F10' : undefined,
        onClick: () => openChat(row), onContextMenu: (event) => openConversationMenu(event, row),
        onKeyDown: (event) => openConversationMenu(event, row),
        onDragStart: dragEnabled ? (event) => startSessionDrag(event, row) : undefined, onDragEnd: endSessionDrag,
      }, pinned && !archived ? menuIcon(h, 'pin') : null, h('span', { className: 'vc-session-title' }, label),
      row.mode === 'design' ? h('span', { className: 'vc-session-mode', 'aria-hidden': true }, '设计') : null);
    };
    function renderProject([projectId, label]) {
      const entries = groups.get(projectId);
      const expanded = expandedProjects.includes(projectId);
      const pinned = pinnedProjects.has(projectId);
      return h('div', { key: projectId, className: 'vc-session-group',
        'data-drop-target': dropProject === projectId ? '' : undefined,
        onDragOver: (event) => dropSession(event, projectId, false),
        onDrop: (event) => dropSession(event, projectId, true),
        onDragLeave(event) {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setDropProject((previous) => previous === projectId ? null : previous);
        },
      },
        h('button', { type: 'button', className: 'vc-project-filter', 'data-project-id': projectId, 'aria-expanded': expanded,
          onClick: () => toggleProject(projectId), title: label,
          'aria-description': pinned ? '已置顶' : undefined,
          'aria-keyshortcuts': saveConversationPreference ? 'Shift+F10' : undefined,
          onContextMenu: (event) => openProjectMenu(event, projectId, expanded),
          onKeyDown: (event) => openProjectMenu(event, projectId, expanded),
        }, h('span', { className: 'vc-session-group-title' },
          h('span', { className: 'vc-project-icon', 'aria-hidden': true }),
          h('span', { className: 'vc-project-name' }, label)),
        pinned ? menuIcon(h, 'pin') : null,
        h('span', { className: 'vc-project-count', 'aria-hidden': true }, entries.length),
        h('span', { className: 'vc-group-chevron', 'aria-hidden': true })),
        h('div', { className: 'vc-disclosure-motion', 'data-expanded': expanded, inert: !expanded },
          h('div', { className: 'vc-disclosure-clip' },
            h('div', { className: 'vc-project-session-rows', role: 'group', 'aria-label': label },
              entries.length ? entries.map(renderSession) : h('p', null, '此项目暂无会话')))));
    }
    const pinnedFolders = [...projects].filter(([id]) => pinnedProjects.has(id));
    const newActions = h('div', { className: 'vc-new-actions' },
      h('button', {
        type: 'button', className: 'vc-button vc-new vc-primary', onClick: onNewChat ?? startNewChat,
        disabled: !onNewChat && (!chatEnabled || Boolean(working)),
      }, sidebarActions ? h('span', { className: 'vc-menu-label' }, menuIcon(h, 'new-chat'), '新聊天') : '＋ 新对话'),
      sidebarActions ? null : h('button', {
        type: 'button', className: 'vc-button vc-new vc-new-design', onClick: () => newSession('design'),
        disabled: !designAvailable || Boolean(working),
      }, '新建设计'));

    const conversationMessages = h('div', {
      ref: scroll, id: chatLogId, className: 'vc-scroll', role: 'region', 'aria-label': '对话消息',
      tabIndex: -1, 'data-vc-focus-area': 'messages',
      onContextMenu: openMessageMenu, onKeyDown: openMessageMenu,
      onScroll: (event) => {
        if (floatingChat && !canvasHistoryOpen) return;
        const panel = event.currentTarget;
        followReply.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
      },
    },
    h('div', { className: 'vc-body' },
      shownTurns.length ? shownTurns.map((turn) => h(Turn, {
        key: turn.id, turn, providerName, design, designStorageKey, pendingSteers,
        workflowEdit: !design ? workflows?.describeEdit(turn) : null,
        approvals: interactiveChat ? turn.approvals : undefined,
        approvalAttempts: turn.id === lastTurn?.id ? currentApprovalAttempts : undefined,
        decideApproval: turn.id === lastTurn?.id && approvalOffered ? decideApproval : undefined,
        approvalDisabled,
        openCanvas: openTurnCanvas, canvasId: canvasPaneId,
        sendingSteer: steerBusy ? activeSteer?.id : undefined,
        state: stopPending && turn.id === lastTurn?.id && isActive(turn.state) ? 'stopping' : turn.state,
        onStreamingRender: parseStreamingMarkdown && turn.id === lastTurn?.id ? followLatestReply : undefined,
      }))
        : h('div', { className: 'vc-welcome' },
          h('h1', null, !ready ? (localSdk ? '开始一段对话' : `通过 VPS 与 ${providerName} 对话`) : !chatEnabled ? '选择一个执行端'
            : working === 'history' ? '正在读取会话'
            : design ? '从设计需求开始' : '开始一段对话'),
          !ready ? h(React.Fragment, null,
            h('p', null, localSdk ? '配置工作目录和模型后开始聊天。' : '在此输入消息、查看回复，模型请求由 VPS 发出。'),
            h('button', { type: 'button', className: 'vc-button vc-primary',
              onClick: SetupGuide ? openSetup : () => openSettings() }, localSdk ? '配置本机 SDK' : SetupGuide ? '开始 VPS 接入' : '配置 VPS'))
            : !chatEnabled ? h(React.Fragment, null,
              h('p', null, configuredTools.length ? '从切换菜单选择已配置的执行端。' : '配置执行端后即可对话。'),
              SetupGuide && !configuredTools.length ? h('button', { type: 'button', className: 'vc-button vc-primary',
                onClick: openSetup }, '打开接入向导') : null)
            : working !== 'history' && snapshot ? h(React.Fragment, null,
              h('p', null, design ? '描述用途、目标用户和视觉方向。原型会出现在设计画布。'
                : localSdk ? `向本机 ${providerName} 提问，或让它带你熟悉当前项目。` : '向 VPS 上的助手提问，或让它带你熟悉当前项目。'),
              !draft ? h('button', { type: 'button', className: 'vc-button vc-example', onClick: fillExample,
                'aria-label': design ? '填入设计示例' : '填入对话示例',
              }, design ? '独立书店网站示例' : '项目导读示例') : null) : null)));
    const conversationComposer = h('div', { className: 'vc-compose-area' },
      h('div', { className: 'vc-compose-wrap' },
        banner ? h('div', { className: 'vc-feedback', role: 'status' },
          h('span', null, banner),
          needsCheck ? h('button', {
            type: 'button', className: 'vc-button', onClick: recheck, disabled: Boolean(working),
          }, working === 'recheck' ? '正在查询' : '查询原任务') : null) : null,
        h('form', { className: 'vc-composer', onSubmit: (event) => { event.preventDefault(); submitComposer(); } },
          h('textarea', {
            ref: editor, 'data-vc-focus-area': 'composer',
            rows: 2, value: draft, maxLength: steerOffered ? maxSteerLength : maxPromptLength,
            'aria-label': localSdk ? '本地对话草稿' : '消息',
            'aria-describedby': chatEnabled ? hintId : undefined,
            placeholder: workflows?.editLabel ? '描述要如何配置工作流'
              : chatEnabled ? (steerOffered ? (design ? '补充当前设计的修改要求，最多 1,200 字符' : '补充当前轮次，最多 1,200 字符')
              : design ? '描述页面、目标用户和视觉方向' : `给 ${providerName} 发消息`)
              : ready ? '选择执行端后即可发送消息' : localSdk ? '配置本机 SDK 后可发送消息' : '配置 VPS 后即可发送消息',
            disabled: !localSdk && (!chatEnabled || !selected), readOnly: working === 'provider' || working === 'send' || steerBusy,
            onChange: (event) => updateDraft(draftId, event.target.value),
            onContextMenu: openEditorMenu,
            onKeyDown: (event) => { if (!openEditorMenu(event)) handleKey(event); }, onCompositionStart: () => {
              composing.current = true;
              composingSteer.current = steerOffered ? { key: steerKey, turnId: lastTurn.id } : null;
            },
            onCompositionEnd: (event) => {
              composing.current = false;
              compositionEndedAt.current = event.timeStamp;
            },
          }),
          workflows?.editLabel ? h('div', { className: 'vc-context-note' },
            h('span', { className: 'vc-context-attachment' }, `配置 · ${workflows.editLabel}`),
            h('button', { type: 'button', className: 'vc-button', 'aria-label': '取消工作流配置',
              disabled: Boolean(working || attempt), onClick: workflows.clearEdit }, '×')) : null,
          attached?.error || attached?.labels.length ? h('div', {
            className: 'vc-context-note', role: 'status', 'data-error': Boolean(attached.error),
          }, attached.error ? h('span', null, attached.error) : h(React.Fragment, null,
            h('span', null, isActive(lastState) ? '下一轮附带' : '随消息发送'),
            attached.labels.map((label) => h('span', { key: label, className: 'vc-context-attachment' }, label))),
          attached.base ? h('button', {
            type: 'button', className: 'vc-button', 'aria-label': '清除版本来源', title: '清除版本来源',
            disabled: Boolean(attempt || working || isActive(lastState)), onClick: attached.clearVersionTarget,
          }, '×') : null) : null,
          (displayedMemory || turnExtensions?.mcpServers.length) && remoteEnabled ? h('div',
            { className: 'vc-context-note', 'aria-label': '随消息发送的扩展' },
            displayedMemory ? h('span', { className: 'vc-context-attachment' },
              `长期记忆 ${displayedMemory} 条`) : null,
            turnExtensions?.mcpServers.length ? h('span', { className: 'vc-context-attachment' },
              `MCP ${turnExtensions.mcpServers.length} 个`) : null) : null,
          h(ComposerToolbar, {
            panel: expandedComposerKind, open: openComposerPanel, available: chatEnabled && Boolean(selected),
            historyButton: floatingChat ? h('button', {
              ref: canvasHistoryTrigger, type: 'button', className: 'vc-button vc-composer-option',
              'data-control': 'history', 'aria-expanded': canvasHistoryOpen, 'aria-controls': chatLogId,
              'aria-label': '对话历史', title: canvasHistoryOpen ? '收起对话历史' : '展开对话历史',
              onClick: () => setCanvasHistoryOpen((open) => !open),
            }, menuIcon(h, 'chat'), h('span', { className: 'vc-option-label' }, '历史')) : null,
            openMaterials: design && chatEnabled && snapshot ? () => setMaterialsOpen(true) : undefined,
            materialsDisabled: waitingForReceipt, wideActions: Boolean(steerOffered || supplementDraft),
            mode, report, attached, selection: modelSelection, catalog, showModeIcon: sidebarActions, localSdk,
            accessButton: showingSubscription ? null : accessButton,
            memoryMode: memoryAvailable ? memoryIsolated ? '独立上下文'
              : projectMemorySuppressed ? '项目记忆关闭' : automaticMemory ? automaticMemoryLabel : '记忆' : null,
            hasPluginPrompts: pluginPrompts.length > 0,
            templateLabel: settingsSurface ? '提示词模板' : undefined,
          },
            h('div', { className: 'vc-compose-buttons' },
              showStop ? h('button', {
                type: 'button', className: 'vc-button vc-compose-action vc-compose-icon-button vc-compose-stop',
                onClick: stop, disabled: !canStop, 'aria-busy': stopBusy, 'aria-label': stopLabel, title: stopLabel,
              }, h('span', { className: 'vc-compose-icon', 'aria-hidden': true })) : null,
              steerOffered ? h('button', {
                type: 'button', className: 'vc-button vc-primary vc-compose-action', onClick: steer,
                disabled: !canSteer, 'aria-busy': steerBusy,
              }, steerBusy ? '正在发送补充' : '发送补充')
                : !showStop ? h('button', {
                  type: supplementDraft ? 'button' : 'submit',
                  className: `vc-button vc-primary vc-compose-action${supplementDraft ? '' : ' vc-compose-icon-button'}`,
                  disabled: !canSend, 'aria-label': sendLabel, title: sendLabel,
                  onClick: supplementDraft ? () => void send(true) : undefined,
                }, supplementDraft ? sendLabel
                  : h('span', { className: 'vc-compose-icon', 'data-symbol': 'send', 'aria-hidden': true })) : null))),
        chatEnabled ? h('p', { id: hintId, className: 'vc-compose-hint', role: 'status' }, composerHint) : null));
    const conversation = h('div', {
      id: chatPaneId, className: floatingChat ? 'vc-conversation vc-canvas-conversation' : 'vc-conversation',
      role: floatingChat ? 'group' : undefined, 'aria-label': floatingChat ? '画布对话' : undefined,
      onKeyDown: floatingChat ? closeCanvasHistory : undefined,
    }, floatingChat ? h('div', {
      className: 'vc-canvas-history vc-disclosure-motion', 'data-expanded': canvasHistoryOpen, inert: !canvasHistoryOpen,
    }, h('div', { className: 'vc-disclosure-clip' }, conversationMessages)) : conversationMessages, conversationComposer);

    const showSettingsOverlay = (element) => visible || !settingsSurface ? element :
      settingsSurface.show(element, { 'data-vps-chat': '', 'data-vc-color': preferences.color,
        'data-vc-accent': preferences.accent, 'data-vc-motion': preferences.motion });
    const configuredProvider = configuration.settings?.provider;
    const localPanels = local?.exampleReady && workflows ? { ...local.panels,
      connection: h(React.Fragment, null, local.panels.connection,
        h('section', { className: 'vc-settings-group' },
          h('h4', null, '示例工作流'),
          h('p', null, '使用已验证的本机配置运行简报和审校示例。运行会使用本机 Codex 额度。'),
          h('button', { type: 'button', className: 'vc-button vc-settings-outline',
            disabled: !remoteEnabled || Boolean(workflows.example.blocked) || scope !== local.profile.targetId,
            onClick() {
              setSettingsOpen(false);
              void workflows.example.start('codex', local.profile.model, local.profile.targetId);
            },
          }, '运行示例工作流'))) } : local?.panels;
    return h('div', { ref: workbench, 'data-vps-chat': '', 'data-local-sdk': localSdk ? '' : undefined,
      'data-resizing': resizing, hidden: !visible, inert: !visible,
      'data-subscription-open': showingSubscription,
      'data-vc-color': activePreferences.color, 'data-vc-accent': activePreferences.accent,
      'data-vc-text-size': activePreferences.textSize, 'data-vc-width': activePreferences.width,
      'data-vc-motion': activePreferences.motion,
      onKeyDown: showingSubscription ? undefined : (event) => {
        if (historyOpen && event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing &&
            !workbench.current.querySelector('dialog[open], :popover-open')) {
          setHistoryOpen(false);
          workbench.current.parentElement.querySelector('.desktop-sidebar-button')?.focus({ preventScroll: true });
        } else cycleAreaFocus(event);
      } },
      h('style', null, css),
      h('aside', {
        className: 'vc-rail', 'data-open': historyOpen, 'data-design': design,
        style: showingSubscription ? { display: 'none' } : undefined,
        'aria-label': localSdk ? '本地对话历史' : 'VPS 对话列表', tabIndex: -1, 'data-vc-focus-area': 'history',
      },
        sidebarActions ? h('div', { className: 'vc-rail-content' }, newActions,
          ResourceLibrary ? h('button', { type: 'button', className: 'vc-button vc-resource-entry',
            'aria-haspopup': 'dialog', onClick: () => setResourcesOpen(true),
          }, menuIcon(h, 'library'), '项目资源库') : null,
          workflows ? h('button', { type: 'button', className: 'vc-button vc-resource-entry',
            'aria-label': '工作流', 'aria-haspopup': 'dialog', onClick: workflows.openPanel,
            disabled: localSdk && providerId !== 'codex', title: localSdk && providerId !== 'codex' ? '切换到本机 Codex 后可运行工作流' : undefined,
          }, menuIcon(h, 'fork'), '工作流', workflows.panel.running
            ? h('span', { className: 'vc-project-count', role: 'status' }, '运行中') : null) : null,
          h('button', { type: 'button', className: 'vc-button vc-resource-entry vc-playground-entry',
            disabled: !designAvailable || Boolean(working), onClick: openPlayground,
            'aria-current': floatingChat ? 'page' : undefined,
            title: designAvailable ? '打开设计工作台' : '切换到 Codex 后可打开设计工作台',
          }, menuIcon(h, 'canvas'), '设计工作台'),
          h('nav', { className: 'vc-list', 'aria-label': '会话记录' },
            h('h2', { className: 'vc-rail-label vc-session-list-heading' }, '会话'),
            pinnedRows.length ? h('section', { className: 'vc-pinned-sessions', 'aria-label': '置顶会话' },
              pinnedRows.map(renderSession)) : null,
            pinnedFolders.length ? h('section', { className: 'vc-pinned-projects', 'aria-label': '置顶项目' },
              pinnedFolders.map(renderProject)) : null,
            groups.get('').map(renderSession),
            [...projects].filter(([id]) => !pinnedProjects.has(id)).map(renderProject),
            archivedRows.length ? h('div', { className: 'vc-session-group vc-archived-sessions' },
              h('button', { type: 'button', className: 'vc-project-filter vc-archive-toggle', 'aria-expanded': archiveOpen,
                onClick: () => setArchiveScope(archiveOpen ? null : scope),
              }, h('span', { className: 'vc-session-group-title' }, menuIcon(h, 'archive'), '已归档'),
              h('span', { className: 'vc-project-count', 'aria-hidden': true }, archivedRows.length),
              h('span', { className: 'vc-group-chevron', 'aria-hidden': true })),
              h('div', { className: 'vc-disclosure-motion', 'data-expanded': archiveOpen, inert: !archiveOpen },
                h('div', { className: 'vc-disclosure-clip' },
                  h('div', { className: 'vc-project-session-rows', role: 'group', 'aria-label': '已归档会话' },
                    archivedRows.map(renderSession))))) : null,
            rows.length || projects.size ? null : h('p', null, '暂无会话')))
        : h(React.Fragment, null,
        h('div', { className: 'vc-rail-label' }, '会话'),
        newActions,
        h('div', { className: 'vc-projects' },
          h('h2', { className: 'vc-projects-heading', id: `${viewId}-project-label` }, '本地项目'),
          h('div', { className: 'vc-project-list', role: 'group', 'aria-labelledby': `${viewId}-project-label` },
            projectChoices.map(([value, label]) => h('button', {
              type: 'button', key: value === null ? 'all' : `project:${value}`, className: 'vc-project-filter',
              'aria-pressed': category === value, onClick: () => setProjectFilter(value), title: label,
            }, value ? h('span', { className: 'vc-project-icon', 'aria-hidden': true }) : null,
            h('span', { className: 'vc-project-name' }, label))),
            projects.size ? null : h('p', { className: 'vc-project-status', role: 'status' }, projectStatus))),
        h('nav', { className: 'vc-list', 'aria-label': '会话记录' },
          visibleRows.length ? visibleRows.map(renderSession)
            : h('p', null, category === null ? '暂无会话' : '此分类暂无会话')),
        h('button', {
          type: 'button', className: 'vc-button vc-account-entry', disabled: !ready || providerSwitchLocked,
          onClick: () => openSettings('accounts'),
        }, '账号管理'))),
      sidebarActions ? h('div', { className: 'vc-sidebar-actions', role: 'group', 'aria-label': localSdk ? '本机操作' : 'VPS 操作' },
        toolPicker,
        h('button', {
          type: 'button', className: 'vc-button vc-sidebar-settings', disabled: providerSwitchLocked,
          onClick: () => openSettings(), title: localSdk && local.profile ? '配置 · ' + local.profile.name : undefined,
        }, menuIcon(h, 'settings'), settingsLabel)) : null,
      h('main', { className: 'vc-main', 'aria-label': localSdk ? '本地 Codex SDK 对话' : undefined },
        h('header', { className: 'vc-header', 'data-design': design, 'data-playground': floatingChat },
          h('button', {
            type: 'button', className: 'vc-button vc-history-toggle', 'aria-expanded': historyOpen,
            hidden: showingSubscription, style: showingSubscription ? { display: 'none' } : undefined,
            onClick: () => setHistoryOpen((open) => !open),
          }, '会话'),
          h('div', { className: 'vc-heading' },
            h('div', { className: 'vc-heading-title' },
              showingSubscription ? h('strong', null, 'Claude Code（订阅）') : h('strong', { title }, title),
              !showingSubscription && ready && selectedRow && (projects.size > 0 || selectedProject) ? h('label', {
                className: 'vc-project-picker', title: `归入本地项目 · ${currentProjectTitle}`,
              }, h('span', { className: 'vc-project-icon', 'aria-hidden': true }),
              h('select', {
                value: selectedProject, 'aria-label': '归入本地项目', disabled: Boolean(working),
                onChange: (event) => requestSessionMove(selectedRow, event.target.value),
              },
              h('option', { value: '' }, '未归类'),
              selectedProject && !projects.has(selectedProject)
                ? h('option', { value: selectedProject, disabled: true }, currentProjectTitle) : null,
              [...projects].map(([id, name]) => h('option', { key: id, value: id }, name)))) : null),
            h('div', { className: 'vc-route', 'data-ready': ready },
              sidebarActions ? null : toolPicker,
              h('span', { className: 'vc-route-status', role: 'status' },
                localSdk ? local.runtimeStatus : loadingPreset ? '正在读取 VPS 预设' : working === 'provider' ? '正在切换执行端'
                  : ready ? routeStatus : `${providerName} · ${routeStatus}`))),
          !showingSubscription && floatingChat ? h('button', {
            type: 'button', className: 'vc-button vc-playground-back', onClick: leavePlayground,
          }, '返回设计对话') : null,
          !showingSubscription && design && !floatingChat ? h('div', { className: 'vc-design-panes vc-segments', role: 'group', 'aria-label': '工作区布局' },
            h('span', { className: 'vc-view-kind', 'aria-hidden': true }, '布局'),
            [['chat', '对话', chatPaneId], ['split', '并排', `${chatPaneId} ${canvasPaneId}`], ['canvas', '画布', canvasPaneId]]
              .filter(([pane]) => roomy || pane !== 'split')
              .map(([pane, name, controls]) => h('button', {
                key: pane, type: 'button', className: 'vc-button', 'aria-controls': controls, 'aria-pressed': visiblePane === pane,
                onClick: () => setDesignPane(pane),
              }, name))) : null,
          sidebarActions ? null : h('button', {
            type: 'button', className: 'vc-button vc-header-settings', onClick: () => openSettings(), disabled: providerSwitchLocked,
          }, settingsLabel)),
        showingSubscription && feedback ? h('p', { className: 'vc-project-warning', role: 'status' }, feedback) : null,
        !showingSubscription && projectWarning ? h('p', { className: 'vc-project-warning', role: 'status' }, projectWarning) : null,
        SubscriptionTerminal && subscriptionPreset ? h('section', {
          className: 'vc-subscription-session', 'aria-label': 'VPS 订阅会话', hidden: !showingSubscription,
          style: { display: showingSubscription ? 'block' : 'none', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' },
        }, h(SubscriptionTerminal, {
          active: active && showingSubscription, subscriptionPreset, activation: subscriptionActivation,
          remoteEnabled, accessButton: showingSubscription ? accessButton : null,
        })) : null,
        h('div', {
          ref: body, className: 'vc-main-body', 'data-design': design, 'data-pane': visiblePane,
          style: showingSubscription ? { display: 'none' } : split ? { '--vc-thread-width': `${threadWidth}px` } : undefined,
        },
          floatingChat ? null : conversation,
          split ? h('div', {
            className: 'vc-splitter', role: 'separator', tabIndex: 0, 'aria-label': '调整对话宽度',
            'aria-controls': chatPaneId, 'aria-orientation': 'vertical',
            'aria-valuemin': minimumThreadWidth, 'aria-valuemax': threadWidthLimit, 'aria-valuenow': threadWidth,
            'aria-valuetext': `${threadWidth} 像素`, onKeyDown: resizeWithKey,
            onPointerDown: startResize, onPointerMove: moveResize, onPointerUp: endResize,
            onPointerCancel: endResize, onLostPointerCapture: endResize,
          }) : null,
          design ? h(DesignCanvas, {
            key: `${scope}:${selected}`, id: canvasPaneId, turns, targetId: scope, sessionId: selected,
            request: canvasRequest,
            materialsOpen, setMaterialsOpen,
            playgroundEnabled: sidebarActions, playgroundOpen, setPlaygroundOpen: showPlaygroundBoards, onPrompt: focusPlaygroundPrompt,
            conversation: floatingChat ? conversation : null,
            openCanvasMenu: floatingChat ? openCanvasMenu : undefined, openExportMenu: openCanvasMenu, copyBoardHtml,
            canGenerate: remoteEnabled && designAvailable && !working, canBranch: canBranchDesign,
            readDesignRevision: sidebarActions ? readDesignRevision : undefined,
            scopedLayerRevisions: Boolean(sidebarActions && saveConversationPreference),
            onContext: setDesignSubmission,
            onCycleFocus: cycleAreaFocus,
            submitted: designReceipt?.targetId === scope && designReceipt.sessionId === selected ? designReceipt.turnId : null,
            waitingForReceipt,
            generating: Boolean(isActive(lastState) || working === 'send'), loading: working === 'history',
          }) : null)),
      composerPanels.map(({ kind, anchor }) => h(ComposerPanel, {
        key: kind, kind, anchor, close: closeComposerPanel, onExpanded: trackComposerPanel, report, mode,
        designAvailable, canChangeMode: chatEnabled && !working, empty: canMoveDraft, changeMode: changeComposerMode,
        memoryIsolated, automaticMemory: automaticMemory ? automaticMemoryLabel : null, projectMemorySuppressed,
        memoryBusy: providerSwitchLocked || extensions?.busy,
        memoryStartsNew: !selectedRow?.local || Boolean(snapshot?.session.turns.length),
        changeMemoryMode, openMemorySettings: () => { dismissComposerPanel(); openSettings('memory'); },
        modelAllowed, catalog, selection: modelSelection, chooseModel, retryModels: () => void loadModels(),
        advanced: saveModelParameters && chatEnabled && !showingSubscription ? {
          targetId: scope, provider: connection.provider, availability: parameterAvailability, values: modelParameters,
          apply: applyModelParameters, retry: () => setModelParameterRevision((value) => value + 1),
        } : null,
        toolDefault: unavailableModel ? undefined : defaultModel, followsTool: Boolean(defaultModel && modelSelection === defaultModel),
        access, accessProvider, accessBusy: accessPending || (remoteEnabled && providerSwitchLocked), changeAccess, localSdk,
        pluginPrompts, insertPluginPrompt, templateLabel: settingsSurface ? '提示词模板' : undefined,
      })),
      saveConversationPreference || floatingChat ? h('div', { className: 'vc-context-notice', role: 'status' }, contextNotice?.text) : null,
      contextMenus.map((request) => h(ContextMenu, {
        key: request.id, request, dismiss: dismissContextMenu,
        closing: showingSubscription || request.scope !== scope || Boolean(request.canvas &&
          (!design || request.canvas.sessionId !== selected || request.canvas.view !== playgroundView)),
      })),
      dialogRow && !showingSubscription ? h(ConversationDialog, {
        key: `${scope}:${conversationDialog.kind}:${dialogRow.id}`, kind: conversationDialog.kind,
        title: titleFor(dialogRow), projectId: projectFor(dialogRow), projects,
        destinationId: conversationDialog.destinationId, needsMemoryChoice,
        apply(value, inheritMemory) {
          if (conversationDialog.kind === 'rename') return changeConversationOptions(dialogRow, { title: value });
          return moveSession(dialogRow, value, inheritMemory);
        },
        dismiss: () => setConversationDialog(null),
      }) : null,
      accountOpen && remoteEnabled && configurationReady && accountOpen.settings === configuration.settings
        ? showSettingsOverlay(h(AccountDialog, { rpc, ...accountOpen, close: () => setAccountOpen(null) })) : null,
      ResourceLibrary && resourcesOpen && visible ? h(ResourceLibrary, { key: scope, scope, projects, sessions: resourceSessions,
        readSession: readResourceSession, onClose: closeResources, onOpenSource: openResourceSource, writeClipboard,
        initialProject: category || (projects.has(selectedProject) ? selectedProject : ''),
      }) : null,
      WorkflowPanel && workflows ? h(WorkflowPanel, {
        ...workflows.panel, agentPresets: agentPresets?.items ?? emptyList, moduleCatalog, projects, selectedProject,
        onManageAgentPresets: AgentPresetSettings && agentPresets && !providerSwitchLocked ? () => {
          workflows.panel.onClose();
          openSettings('agents');
        } : undefined,
      }) : null,
      showSettingsOverlay(h(SettingsDialog, {
        scope: configuration.targetId, settings: configuration.settings, visit: settingsView.visit,
        tab: settingsTab, ready: configurationReady, name: configuration.name, tools, activeTool: visible ? activeTool : undefined,
        savedTools: configuration.tools.ids, toolKey: configuration.tools.key,
        setTab: (tab) => { setSettingsError(''); setSettingsOpen(tab); },
        error: settingsError, busy: providerSwitchLocked || readingConfiguration || (visible && loadingPreset) || local?.registerBusy,
        close: () => setSettingsOpen(false), saveConnection: saveSettings, saveTools,
        VpsConnectionChecks, connectionDiagnostics, pinConfirmationRequired,
        navigateLocation: settingsSurface?.navigate, settingsLabel, localPanels,
        restoreFocus: settingsSurface?.restoreFocus,
        focusFallback: () => {
          const entry = Array.from(workbench.current?.querySelectorAll('.vc-sidebar-settings, .vc-header-settings') ?? [])
            .find((button) => button.getClientRects().length && !button.disabled);
          (entry ?? editor.current)?.focus({ preventScroll: true });
        },
        openSetup: SetupGuide ? openSetup : undefined,
        preferences, updatePreferences, profiles: configuration.profiles, updateTool, readModels: readSettingsModels,
        modelTools: remoteEnabled ? toolsWithModels : emptyList, openAccount, remoteEnabled,
        agentSettings: AgentPresetSettings && agentPresets ? { Component: AgentPresetSettings, props: {
          ...agentPresets, moduleCatalog: (savedConfiguration || localConfiguration) && moduleCatalog ? {
            ...moduleCatalog, codexTargetId: configuration.memoryTargetId,
            antigravityTargetId: configuredProvider === 'antigravity' ? configuration.targetId :
              connectionDiagnostics?.resultFor('antigravity')?.checked?.list.targetId ?? '',
          } : moduleCatalog,
          catalogScope: configuration.targetId, availableProviders: remoteEnabled && configurationReady ? configuration.tools.ids : emptyList,
          readModels: async (provider, signal) => (await readSettingsModels(provider, signal)).models,
        } } : null,
        extensionSettings: ExtensionSettings && extensions ? { Component: ExtensionSettings, props: {
          ...extensions, localSdk, targetId: configuredProvider === 'codex' ? configuration.targetId : '',
          memoryTargetId: configuration.memoryTargetId, connectionName: configuration.name, projects,
          selectedProject: configuration.targetId === scope ? selectedProject : null,
          readMemoryModels: remoteEnabled && configurationReady && configuration.memoryTargetId ? readMemoryModels : undefined,
          mcpTargetId: (localSdk ? ['codex'] : ['codex', 'antigravity']).includes(configuredProvider) ? configuration.targetId : '',
          mcpProvider: configuredProvider,
        } } : null,
      })),
      SetupGuide && setupOpen ? showSettingsOverlay(h(SetupGuide, {
        connection: configuration.settings, connectionName: configuration.name, scope: configuration.targetId,
        memoryTargetId: configuration.memoryTargetId, tools: chatTools, toolIds: configuration.tools.ids, toolProfiles: configuration.profiles,
        trial: connectionDiagnostics?.trial,
        rpc, readList, remoteEnabled, accessPending, applyConnection: applySetupConnection, enableTool: enableSetupTool,
        onEnableExecution: access?.mode === 'browse' ? () => changeAccess({ ...access, mode: 'execute' }) : undefined,
        extensions: extensions?.state, agentPresets, selectedProject: projects.has(selectedProject) ? selectedProject : null,
        openAccount, openSettings, onClose: () => setSetupOpen(false),
        workflow: visible && (!ready || configuration.targetId === scope) ? workflows?.example : undefined,
      })) : null);
  }

  return Workbench;
}
