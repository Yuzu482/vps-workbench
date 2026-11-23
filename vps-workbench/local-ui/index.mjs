import { t } from '../../remote-workbench/vps-chat/client/interface-language.js';
import { ConnectionResult } from '../desktop/connection-panel.mjs';
import { TrialActions, trialResult, useConnectionTrial } from '../desktop/connection-trial.mjs';
import { trialPrompt, trialState } from '../desktop/setup-trial.mjs';
import { effortName } from '../../remote-workbench/vps-chat/client/model-catalog.js';
import { workbenchStorage } from '../../remote-workbench/vps-chat/client/workbench-storage.js';
import { localBackends } from '../local-sdk/providers.mjs';
import { componentMessages, createComponentPanel, useComponentInstall } from './components.mjs';

const location = 'local-sdk';
const defaultBackend = 'codex';
const backendOf = (profile) => profile?.backend ?? defaultBackend;
const labelFor = (profile) => localBackends[backendOf(profile)].label;
const usesClaudeSubscription = (profile) => profile?.backend === 'claude-sdk' && profile.authMode === 'subscription';
const subscriptionResults = {
  signed_in: { state: 'passed', detail: '已核验此配置的 Claude 个人订阅登录。模型响应需单独试跑。' },
  sign_in_required: { state: 'failed', detail: '此配置尚未登录。请打开 Claude 登录窗口，完成后重新检查。' },
  unknown: { state: 'confirm', detail: 'Claude 未返回可确认的登录状态。请核对登录窗口后重试。' },
};
const subscriptionStatusLabels = { signed_in: '订阅登录已核验', sign_in_required: '订阅待登录', unknown: '订阅登录待确认' };
const subscriptionUnavailable = '当前版本无法使用 Claude 个人订阅。';
const newProfileKey = 'dsh-vps-chat:local-new-profile:v1';
const viewProfileKey = 'dsh-vps-chat:local-view-profile:v1';
const routeFor = (profile) => profile && ({
  settings: { location, provider: backendOf(profile), profileId: profile.id }, targetId: profile.targetId,
});

export function createLocalWorkspace(React, Workbench) {
  const h = React.createElement;
  const button = (label, props, style = 'vc-settings-outline') =>
    h('button', { type: 'button', className: 'vc-button ' + style, ...props }, label);
  const ComponentPanel = createComponentPanel(React, button);

  return function LocalWorkspace({ native, active, settingsSurface, access, accessPending, newChatRequest, savePreference,
    componentSetup, ...props }) {
    const [status, setStatus] = React.useState(null);
    const [statusError, setStatusError] = React.useState(false);
    const [checking, setChecking] = React.useState(false);
    const [checked, setChecked] = React.useState(null);
    const [defaultId, setDefaultId] = React.useState(() => workbenchStorage.getItem(newProfileKey));
    const [viewId, setViewId] = React.useState(() => workbenchStorage.getItem(viewProfileKey));
    const [inspectId, setInspectId] = React.useState(null);
    const [registerBusy, setRegisterBusy] = React.useState(false);
    const [registerError, setRegisterError] = React.useState('');
    const [name, setName] = React.useState('');
    const [registerBackend, setRegisterBackend] = React.useState(defaultBackend);
    const [authMode, setAuthMode] = React.useState('api-key');
    const [modelId, setModelId] = React.useState('');
    const [effortId, setEffortId] = React.useState('');
    const [componentStatus, setComponentStatus] = React.useState(componentSetup.initial);
    const [accountFeedback, setAccountFeedback] = React.useState(null);
    const [accountBusy, setAccountBusy] = React.useState(false);
    const [subscriptionChecks, setSubscriptionChecks] = React.useState({});
    const [subscriptionAction, setSubscriptionAction] = React.useState(null);
    const [subscriptionFeedback, setSubscriptionFeedback] = React.useState({});
    const loading = React.useRef(null);
    const registering = React.useRef(false);
    const subscriptionRequest = React.useRef(null);
    const newRequest = React.useRef(0);
    const profiles = status?.profiles ?? [];
    const providers = status?.providers ?? (status ? [status] : []);
    const runtimeFor = (id) => providers.find(({ backend }) => backend === id);
    const formProvider = runtimeFor(registerBackend) ?? providers[0];
    const offersSubscription = formProvider?.backend === 'claude-sdk' && formProvider.personalSubscriptionAvailable === true;
    const models = formProvider?.models ?? [];
    const defaultProfile = profiles.find(({ id }) => id === defaultId) ?? profiles[0];
    const profile = profiles.find(({ id }) => id === viewId) ?? defaultProfile;
    const inspector = profiles.find(({ id }) => id === inspectId) ?? profile;
    const viewedRuntime = runtimeFor(backendOf(profile));
    const inspectedRuntime = runtimeFor(backendOf(inspector));
    const selectedModel = models.find(({ id }) => id === modelId) ?? models[0];
    const effort = selectedModel?.efforts.includes(effortId) ? effortId : selectedModel?.defaultEffort;
    const browsing = access?.mode !== 'execute';
    const subscription = usesClaudeSubscription(inspector);
    const subscriptionAvailable = inspectedRuntime?.personalSubscriptionAvailable === true;
    const subscriptionCheck = subscriptionChecks[inspector?.id];
    const mayTry = (item, config) => item?.runtimeAvailable && (usesClaudeSubscription(config)
      ? item.personalSubscriptionAvailable === true && subscriptionChecks[config.id]?.status === 'signed_in'
      : item.credentialConfigured || item.credentialPending);
    const runtimeReady = Boolean(!statusError && mayTry(viewedRuntime, profile));
    const diagnosticsBinding = (config, item) => JSON.stringify([config?.id, item?.runtimeAvailable,
      usesClaudeSubscription(config) ? item?.personalSubscriptionAvailable : mayTry(item, config), item?.models]);
    const binding = diagnosticsBinding(inspector, inspectedRuntime);
    const verified = checked === binding && !statusError;
    const trialTarget = mayTry(inspectedRuntime, inspector) && inspector && {
      profileId: inspector.id, targetId: inspector.targetId, model: inspector.model, effort: inspector.effort,
      ...(backendOf(inspector) !== defaultBackend && { backend: backendOf(inspector) }),
    };
    const connection = React.useRef({ profile });
    connection.current = { profile };
    const request = React.useCallback(async (op, payload, signal) => {
      signal.throwIfAborted();
      const presetProfile = op === 'preset' ? connection.current.profile : null;
      if (op === 'preset' && !presetProfile) return { ok: true, preset: null };
      const backend = presetProfile ? backendOf(presetProfile) : payload.settings?.provider;
      const result = await native.localSdkRequest({ location, backend, op: 'workbench',
        payload: presetProfile ? { op: 'list', ...routeFor(presetProfile) } : { op, ...payload } });
      signal.throwIfAborted();
      if (result?.ok !== true) throw Object.assign(new Error(result?.message || '无法读取本机记录。'), { code: result?.code });
      if (!presetProfile) return result;
      return { ok: true, preset: { ...result, name: presetProfile.name, ...routeFor(presetProfile) } };
    }, [native]);

    const trial = useConnectionTrial({ storageKey: 'dsh-vps-chat:setup-trial:local-sdk:v1', savePreference,
      async request(kind, { target: at, sessionId, turnId }) {
        const packet = await native.localSdkRequest({ location, backend: at.backend ?? defaultBackend, profileId: at.profileId, op: kind === 'start' ? 'send' : 'refresh',
          sessionId, targetId: at.targetId, turnId, ...(kind === 'start' && { prompt: trialPrompt }) });
        if (packet?.ok !== true && (['auth_required', 'runtime_unavailable', 'invalid_directory', 'invalid_profile', 'browse_only']
          .includes(packet?.code) || (kind === 'start' && packet?.code === 'subscription_unavailable'))) return 'failed';
        return packet?.location === location && packet.targetId === at.targetId && packet.session?.profileId === at.profileId
          ? trialState(packet, { sessionId, turnId }, 'completed') : 'unknown';
      },
    });
    const invalidateTrial = trial.invalidate;
    React.useLayoutEffect(() => invalidateTrial(),
      [invalidateTrial, binding, inspectedRuntime?.credentialConfigured, inspectedRuntime?.credentialPending, subscriptionCheck?.status]);

    async function loadStatus(explicit = false) {
      const token = {};
      loading.current = token;
      if (explicit) setChecking(true);
      try {
        const result = await native.localSdkStatus();
        if (loading.current !== token) return null;
        if (result?.ok !== true || result.location !== location) throw new Error('status_unavailable');
        setStatus(result);
        setStatusError(false);
        if (explicit) {
          const selected = result.profiles.find(({ id }) => id === inspector?.id) ?? result.profiles[0];
          const inspected = (result.providers ?? [result]).find(({ backend }) => backend === backendOf(selected));
          setChecked(diagnosticsBinding(selected, inspected));
        }
        return result;
      } catch {
        if (loading.current === token) {
          setStatusError(true);
          setChecked(null);
        }
        return null;
      } finally {
        if (loading.current === token) {
          loading.current = null;
          setChecking(false);
        }
      }
    }

    const inspecting = Boolean(settingsSurface.tab);
    React.useEffect(() => {
      if ((active || inspecting) && !status && !loading.current) void loadStatus();
    }, [active, inspecting]);
    React.useEffect(() => {
      setAccountFeedback(null);
    }, [inspector?.id]);

    async function refreshComponents(backend) {
      const [updated] = await Promise.all([loadStatus(), native.localComponentsStatus().then(setComponentStatus)]);
      const configured = updated?.profiles.find((item) => item.backend === backend);
      if (configured) setInspectId(configured.id);
    }
    const componentInstallation = useComponentInstall(React, { native, status: componentStatus, browsing: browsing || accessPending,
      onContinue: componentSetup.continue, onInstalled: refreshComponents });

    React.useLayoutEffect(() => {
      if (!active || !defaultProfile || newRequest.current === newChatRequest) return;
      newRequest.current = newChatRequest;
      setViewId(defaultProfile.id);
      void savePreference(viewProfileKey, defaultProfile.id).catch(() => {});
    }, [active, defaultProfile?.id, newChatRequest, savePreference]);
    React.useEffect(() => {
      if (profile && viewId === null) setViewId(profile.id);
    }, [profile?.id, viewId]);

    async function register(event) {
      event.preventDefault();
      if (browsing || accessPending || registering.current || !selectedModel || !effort || !name.trim()) return;
      if (authMode === 'subscription' && !offersSubscription) {
        setRegisterError(subscriptionUnavailable);
        return;
      }
      registering.current = true;
      setRegisterBusy(true);
      setRegisterError('');
      try {
        const result = await native.registerLocalSdkProfile({ backend: formProvider.backend, name: name.trim(), model: selectedModel.id, effort,
          ...(offersSubscription && authMode === 'subscription' && { authMode }) });
        if (!result?.ok) {
          if (result?.code !== 'directory_cancelled') setRegisterError(result?.message || '本机配置未能保存。');
          return;
        }
        setStatus((previous) => ({ ...previous, profiles: [...previous.profiles.filter(({ id }) => id !== result.profile.id), result.profile] }));
        setInspectId(result.profile.id);
        if (componentStatus) void native.localComponentsStatus().then(setComponentStatus).catch(() => {});
        setName('');
        setAuthMode('api-key');
        setChecked(null);
      } catch {
        setRegisterError('本机配置未能保存。');
      } finally {
        registering.current = false;
        setRegisterBusy(false);
      }
    }

    async function selectProfile(key, setter) {
      if (!inspector || registering.current) return;
      try {
        await savePreference(key, inspector.id);
        setter(inspector.id);
      } catch { setRegisterError('未能保存本机配置选择。'); }
    }

    function openProfile(next) {
      if (!next || next.id === profile?.id) return;
      setViewId(next.id);
      void savePreference(viewProfileKey, next.id).catch(() => {});
    }

    const viewedSubscriptionStatus = subscriptionChecks[profile?.id]?.status;
    const viewedCredentialStatus = usesClaudeSubscription(profile)
      ? viewedRuntime?.personalSubscriptionAvailable !== true ? '个人订阅不可用' : subscriptionStatusLabels[viewedSubscriptionStatus] ?? '订阅登录待核验'
      : viewedRuntime?.credentialSource === 'agy-local-login' ? '本机登录待验证' : viewedRuntime?.credentialConfigured ? '凭据已配置' : '凭据未配置';
    const runtimeStatus = statusError ? '状态读取失败' : !status ? '正在读取本机状态…' :
      (viewedRuntime?.runtimeAvailable ? 'SDK 可用' : 'SDK 不可用') + ' · ' + viewedCredentialStatus;
    const login = inspectedRuntime?.credentialSource === 'agy-local-login';
    const credentialVariable = backendOf(inspector) === 'claude-sdk' ? 'VPS_WORKBENCH_LOCAL_CLAUDE_API_KEY' : 'VPS_WORKBENCH_LOCAL_CODEX_API_KEY';
    const credentialResult = verified ? {
      state: mayTry(inspectedRuntime) ? 'confirm' : 'failed',
      detail: login ? '使用此配置的本机 Google 登录目录，登录状态以试跑结果为准。' : inspectedRuntime?.credentialConfigured
        ? '已配置本机 API 密钥，服务权限待试跑确认。' : '在「模型与账号」中配置本机密钥。',
    } : null;
    function credentials(showSubscriptionActions = false) {
      if (!subscription) {
        return h(ConnectionResult, { id: 'account', label: '本机账号凭据', detail: '检查本机进程的凭据配置。', result: credentialResult });
      }
      const result = !subscriptionAvailable ? { state: 'failed', detail: subscriptionUnavailable } :
        subscriptionAction?.profileId === inspector.id && subscriptionAction.kind === 'check'
          ? { state: 'checking', detail: '正在检查此配置的订阅登录…' }
          : subscriptionCheck?.result;
      return h(ConnectionResult, { id: 'account', label: 'Claude 个人订阅登录',
        detail: '此配置的订阅登录待核验。登录后可在这里检查。', result },
        showSubscriptionActions && subscriptionActions());
    }

    function profileSummary(includeDirectory = false) {
      if (!inspector) return h('p', null, '尚未登记本机配置。');
      return h('dl', { className: 'local-config-details' },
        h('dt', null, '名称'), h('dd', null, inspector.name),
        h('dt', null, t('执行端')), h('dd', null, labelFor(inspector)),
        backendOf(inspector) === 'claude-sdk' && h(React.Fragment, null,
          h('dt', null, t('认证方式')), h('dd', null, subscription ? 'Claude 个人订阅' : 'API Key')),
        includeDirectory && h(React.Fragment, null, h('dt', null, '只读工作目录'), h('dd', null, inspector.directory)),
        h('dt', null, t('默认模型')), h('dd', null, inspectedRuntime?.models.find(({ id }) => id === inspector.model)?.label ?? inspector.model),
        h('dt', null, t('推理强度')), h('dd', null, inspector.effort === 'default' ? '账号默认' : effortName(inspector.effort)));
    }

    async function changeAccount(event) {
      event?.preventDefault();
      if (browsing || accessPending || accountBusy || !inspector || subscription || !inspectedRuntime?.runtimeAvailable) return;
      const input = event?.currentTarget.elements.namedItem('local-api-key');
      setAccountBusy(true);
      setAccountFeedback(null);
      try {
        const result = login ? await native.loginLocalAntigravity(inspector.id) :
          await native.saveLocalCredential(backendOf(inspector), input.value.trim());
        if (!result.ok) {
          setAccountFeedback({ ok: false, message: componentMessages[result.code] ?? '账号设置未能完成。' });
          return;
        }
        if (input) input.value = '';
        setChecked(null);
        invalidateTrial();
        await loadStatus();
        setAccountFeedback({ ok: true, message: login ? '请在 Antigravity 登录窗口完成 Google 登录。然后可回到工作台主动试跑。' :
          '本机密钥已保存。可在连接设置主动试跑。' });
      } catch { setAccountFeedback({ ok: false, message: '账号设置未能完成。' }); }
      finally { setAccountBusy(false); }
    }

    async function actOnSubscription(kind) {
      const run = kind === 'login' ? native.loginLocalClaudeSubscription : native.checkLocalClaudeSubscription;
      if (browsing || accessPending || subscriptionRequest.current || !subscription || !subscriptionAvailable ||
          !inspectedRuntime?.runtimeAvailable || !run) return;
      const profileId = inspector.id;
      const action = { profileId, kind };
      subscriptionRequest.current = action;
      setSubscriptionAction(action);
      setSubscriptionFeedback((previous) => ({ ...previous, [profileId]: null }));
      if (kind === 'login') setSubscriptionChecks((previous) => ({ ...previous, [profileId]: null }));

      function reportFailure(code) {
        const message = componentMessages[code] ?? (code === 'subscription_unavailable' ? subscriptionUnavailable :
          kind === 'login' ? '无法打开 Claude 登录窗口。请重试。' : '无法检查 Claude 订阅登录。请重试。');
        if (kind === 'login') setSubscriptionFeedback((previous) => ({ ...previous, [profileId]: { ok: false, message } }));
        else setSubscriptionChecks((previous) => ({ ...previous, [profileId]: { result: { state: 'failed', detail: message } } }));
      }

      try {
        const result = await run.call(native, profileId);
        if (result?.ok !== true) {
          reportFailure(result?.code);
        } else if (kind === 'login') {
          setSubscriptionFeedback((previous) => ({ ...previous, [profileId]: {
            ok: true, message: '请在 Claude 登录窗口完成登录，返回后选择「检查订阅登录」。',
          } }));
        } else {
          const status = Object.hasOwn(subscriptionResults, result.status) ? result.status : 'unknown';
          setSubscriptionChecks((previous) => ({ ...previous, [profileId]: { status, result: subscriptionResults[status] } }));
        }
      } catch {
        reportFailure();
      } finally {
        subscriptionRequest.current = null;
        setSubscriptionAction(null);
      }
    }

    function subscriptionActions() {
      if (!subscriptionAvailable) return null;
      const disabled = browsing || accessPending || Boolean(subscriptionAction) || !inspectedRuntime?.runtimeAvailable;
      const activeAction = subscriptionAction?.profileId === inspector.id ? subscriptionAction.kind : null;
      const feedback = subscriptionFeedback[inspector.id];
      return h(React.Fragment, null,
        h('div', { className: 'vc-setup-actions' },
          button(activeAction === 'login' ? '正在打开登录…' : '打开 Claude 登录',
            { disabled: disabled || !native.loginLocalClaudeSubscription, onClick: () => void actOnSubscription('login') }),
          button(activeAction === 'check' ? '正在检查订阅登录…' : '检查订阅登录',
            { disabled: disabled || !native.checkLocalClaudeSubscription, onClick: () => void actOnSubscription('check') })),
        feedback && h('p', { role: feedback.ok ? 'status' : 'alert' }, feedback.message));
    }

    const localPanels = {
      connection: h(React.Fragment, null,
        h(ComponentPanel, { native, status: componentStatus, welcome: componentSetup.welcome, installation: componentInstallation }),
        inspector && h('section', { className: 'vc-settings-group', 'aria-label': t('本机配置') },
          h('h4', null, t('本机配置')),
          h('label', { className: 'vc-field' }, t('查看配置'),
            h('select', { 'aria-label': t('查看配置'), value: inspector.id, onChange: (event) => setInspectId(event.target.value) },
              profiles.map(({ id, name }) => h('option', { key: id, value: id }, name)))),
          profileSummary(true),
          h('div', { className: 'vc-setup-agent-actions vc-setup-actions' },
            button(inspector.id === profile?.id ? '正在查看此配置' : '打开此配置的会话', {
              disabled: inspector.id === profile?.id, onClick: () => void selectProfile(viewProfileKey, setViewId),
            }),
            button(inspector.id === defaultProfile?.id ? '新聊天默认配置' : '设为新聊天配置', {
              disabled: browsing || accessPending || inspector.id === defaultProfile?.id,
              onClick: () => void selectProfile(newProfileKey, setDefaultId),
            }))),
        h('form', { className: 'vc-settings-group', onSubmit: register },
          h('h4', null, t('注册本机配置')),
          h('label', { className: 'vc-field' }, t('本机执行端'), h('select', { 'aria-label': t('本机执行端'), value: formProvider?.backend ?? '',
            disabled: browsing || registerBusy || !formProvider, onChange: (event) => {
              setRegisterBackend(event.target.value); setModelId(''); setEffortId(''); setAuthMode('api-key');
            } }, providers.map(({ backend }) => h('option', { key: backend, value: backend }, localBackends[backend].label)))),
          offersSubscription && h('label', { className: 'vc-field' }, t('认证方式'),
            h('select', { 'aria-label': t('认证方式'), value: authMode, disabled: browsing || accessPending || registerBusy,
              onChange: (event) => setAuthMode(event.target.value) },
              h('option', { value: 'api-key' }, 'API Key'),
              h('option', { value: 'subscription' }, 'Claude 个人订阅'))),
          h('label', { className: 'vc-field' }, '配置名称', h('input', { value: name, maxLength: 80, required: true,
            disabled: browsing || registerBusy, onChange: (event) => setName(event.target.value) })),
          h('div', { className: 'vc-settings-address' },
            h('label', { className: 'vc-field' }, t('模型'), h('select', { value: selectedModel?.id ?? '',
              disabled: browsing || registerBusy || !selectedModel, onChange: (event) => { setModelId(event.target.value); setEffortId(''); } },
              models.map(({ id, label }) => h('option', { key: id, value: id }, label)))),
            h('label', { className: 'vc-field' }, t('推理强度'), h('select', { value: effort ?? '',
              disabled: browsing || registerBusy || !selectedModel, onChange: (event) => setEffortId(event.target.value) },
              selectedModel?.efforts.map((item) => h('option', { key: item, value: item }, item === 'default' ? '账号默认' : effortName(item)))))),
          registerError && h('p', { role: 'alert', className: 'vc-feedback' }, registerError),
          h('div', { className: 'vc-dialog-actions' },
            button(registerBusy ? '正在选择工作目录…' : '选择工作目录并保存', {
              type: 'submit', disabled: browsing || accessPending || registerBusy || !status || !selectedModel || !name.trim(),
            }, 'vc-primary')),
          h('p', null, '工作台在独立的本机存储中保存历史、SDK 线程和回执。已创建的会话继续使用原配置。')),
        h('section', { className: 'vc-setup-group vc-connection-checks', 'aria-label': '本机连接检查' },
          h('div', { className: 'vc-setup-overview' }, h('h4', null, '连接检查')),
          h('div', { className: 'vc-setup-actions' },
            button(checking ? t('检查中') : '测试本机配置', { disabled: checking, onClick: () => void loadStatus(true) })),
          h('ol', { className: 'vc-setup-steps' },
            h(ConnectionResult, { id: 'runtime', label: t('本机 SDK'), detail: '检查 Windows 上的 SDK 运行文件。',
              result: statusError ? { state: 'failed', detail: '本机 SDK 状态读取失败。请重试。' } : verified ? {
                state: inspectedRuntime?.runtimeAvailable ? 'passed' : 'failed',
                detail: inspectedRuntime?.runtimeAvailable ? `已找到本机 ${labelFor(inspector)} 运行文件。` : `当前安装缺少本机 ${labelFor(inspector)} 运行文件。`,
              } : null }),
            credentials(true),
            h(ConnectionResult, { id: 'model', label: '本机模型目录', detail: '检查本机 SDK 支持的模型选项。',
              result: verified ? { state: inspectedRuntime?.models.length ? 'passed' : 'failed',
                detail: backendOf(inspector) === defaultBackend ? '内置目录 · ' + inspectedRuntime?.models.length + ' 个模型选项' : '使用账号默认模型。' } : null }),
            h(ConnectionResult, { id: 'response', label: t('实际模型响应'), detail: '试跑使用所选配置的模型和本机网络。',
              result: trialResult(trial, trialTarget) },
            h(TrialActions, { trial, target: trialTarget,
              allowed: inspecting && !browsing && !accessPending && !checking && (!subscription || !subscriptionAction) }))))),
      tools: h('section', { className: 'vc-settings-group', 'aria-label': '本机配置摘要' },
        profileSummary(),
        button(t('编辑本机配置'), { onClick: () => settingsSurface.setTab('connection') })),
      accounts: h(React.Fragment, null,
        h('section', { className: 'vc-settings-group', 'aria-label': '凭据来源' },
          h('h4', null, '凭据来源'),
          profiles.length > 1 ? h('label', { className: 'vc-field' }, '查看本机账号配置',
            h('select', { value: inspector?.id, disabled: accountBusy, onChange: (event) => setInspectId(event.target.value) },
              profiles.map(({ id, name }) => h('option', { key: id, value: id }, name)))) : null,
          subscription ? h(React.Fragment, null,
            h('p', null, '此配置使用独立的 Claude 个人订阅登录。'),
            subscriptionActions()) : login ? h(React.Fragment, null,
            native.loginLocalAntigravity && inspector && inspectedRuntime?.runtimeAvailable ?
              button(accountBusy ? '正在打开登录…' : '在本机登录 Antigravity', {
                disabled: browsing || accessPending || accountBusy, onClick: () => void changeAccount(),
              }) : h('p', null, '在此配置的本机登录目录运行官方 agy acp --login。'),
            h('code', null, inspector?.accountDirectory ?? '请先登记配置。'),
            h('p', { role: 'status' }, '本机 Google 登录待试跑确认。')) : h(React.Fragment, null,
            native.saveLocalCredential && inspector && inspectedRuntime?.runtimeAvailable &&
              h('form', { key: inspector.id, onSubmit: changeAccount },
                h('p', null, '此密钥供该执行端的所有本机配置使用。保存后替换此执行端的应用内密钥。'),
                h('label', { className: 'vc-field' }, labelFor(inspector) + ' 本机 API 密钥',
                  h('input', { name: 'local-api-key', type: 'password', autoComplete: 'off', spellCheck: false,
                    required: true, maxLength: 520, disabled: browsing || accessPending || accountBusy })),
                button(accountBusy ? '正在保存…' : '保存本机密钥', { type: 'submit', disabled: browsing || accessPending || accountBusy })),
            h('p', null, '也可由可信启动器提供 ', h('code', null, credentialVariable), '。'),
            h('p', { role: 'status' }, inspectedRuntime?.credentialConfigured ? '本机 API 密钥已配置。' : '本机 API 密钥尚未配置。')),
          accountFeedback && h('p', { role: accountFeedback.ok ? 'status' : 'alert' }, accountFeedback.message),
          button('打开本机连接检查', { onClick: () => settingsSurface.setTab('connection') })),
        h('ol', { className: 'vc-setup-steps' }, credentials(),
          h(ConnectionResult, { id: 'response', label: t('实际模型响应'), detail: '试跑使用所选本机配置。',
            result: trialResult(trial, trialTarget) }))),
    };

    return h(Workbench, { ...props, active, visible: active, settingsSurface, access, accessPending, newChatRequest,
      local: { request, profile, profiles, profilesReady: Boolean(status || statusError), openProfile, settingsProfile: inspector,
        routeForTarget: (targetId) => routeFor(profiles.find((profile) => profile.targetId === targetId)),
        profileForBackend: (backend) => backendOf(profile) === backend ? profile : profiles.find((item) => backendOf(item) === backend),
        runtimeStatus, runtimeReady, registerBusy, panels: localPanels,
        exampleReady: runtimeReady && backendOf(profile) === 'codex' && inspector?.id === profile?.id && trialResult(trial, trialTarget)?.state === 'passed' } });
  };
}
