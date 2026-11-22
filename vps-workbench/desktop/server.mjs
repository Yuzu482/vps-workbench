import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
export { parseConversationLink } from '../../remote-workbench/vps-chat/client/chat-reference.js';
import { join } from 'node:path';
import { createBridge, createHost, prefix } from '../../remote-workbench/vps-chat/host/index.js';
import { accountSocketPath, createWorkbenchRouteReader } from '../../remote-workbench/vps-chat/host/account-view.js';
import { createStandaloneSubscriptionHost, SUBSCRIPTION_PREFIX } from '../terminal/subscription-host.mjs';
import { accessDenied, defaultAccess, permitsChat, permitsTerminal, withWorkspaceAccess } from './access.mjs';
import { createProjectMemoryBridge } from './project-memory.mjs';
import { readSetupPreset, setupConnectionKey } from './setup-state.mjs';
import { runSetupTrial } from './setup-trial.mjs';
import { readLegacyWorkflowRun } from '../workflow-engine/runner.mjs';
import { workflowRunKey } from '../workflow-engine/state.mjs';
import { readWorkflowArtifacts } from './workflow-artifacts.mjs';
import { ensurePrivateDirectory, localModels, openCodexRuntime } from './codex-runtime.mjs';
import { openLocalSdk } from '../local-sdk/service.mjs';
import { createLocalWorkbench } from '../local-sdk/workbench.mjs';
import { isLocalBackend, localBackends } from '../local-sdk/providers.mjs';
import { openLocalAgentRuntime } from './local-agent-runtime.mjs';
import { createComponentInstaller, validComponentSelection } from './component-install.mjs';
import { mixedLocalRoute, mixedVpsRoute, openMixedWorkflow, requestMixedWorkflow } from './mixed-workflow.mjs';
import { workflowProviders } from '../workflow-engine/state.mjs';
import { readToolPreferences } from '../../remote-workbench/vps-chat/client/tool-preferences.js';
import { readModelCatalog } from '../../remote-workbench/vps-chat/client/model-catalog.js';

export { canonicalLocalDirectory, localCredentialVariable } from './codex-runtime.mjs';
export { localMemoryJournalKey } from '../local-sdk/workbench.mjs';
export { agyHashVariable, agyPathVariable, claudeKeyVariable } from './local-agent-runtime.mjs';
export { openLocalCredentials } from './local-credentials.mjs';
export { readLegacyWorkflowRun } from '../workflow-engine/runner.mjs';

const staticRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/renderer.js', ['renderer.js', 'text/javascript; charset=utf-8']],
  ['/markdown-worker.js', ['markdown-worker.js', 'text/javascript; charset=utf-8']],
  ['/workbench.css', ['workbench.css', 'text/css; charset=utf-8']],
  ['/app-icon.png', ['app-icon.png', 'image/png']],
]);
const cookieName = 'vps-workbench-session';
const blockedHeaders = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];
const componentErrors = new Set(['component_cancelled', 'component_platform_unavailable', 'component_download_failed',
  'component_integrity_failed', 'component_archive_invalid', 'component_source_invalid', 'component_storage_failed']);

function hasSession(header, ticket) {
  if (typeof header !== 'string') return false;
  const values = header.split(';').map((field) => field.trim())
    .filter((field) => field.startsWith(cookieName + '='))
    .map((field) => field.slice(cookieName.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]) &&
    timingSafeEqual(Buffer.from(values[0]), Buffer.from(ticket));
}

export async function startWorkbenchServer({ webRoot, workbenchRoot, terminalRoot, runtimeRoot, pythonPath,
  makeBridge = createBridge, makeSubscriptionHost = createStandaloneSubscriptionHost, access = () => defaultAccess,
  data, onMemoryChanged, onMemoryError, localStateRoot, localApiKey, localAgentOptions, localCredentials,
  componentRoot, componentMode = 'bundled', makeComponentInstaller = createComponentInstaller, personalClaudeSubscription = false,
  makeLocalRuntime = openCodexRuntime, makeLocalAgentRuntime = openLocalAgentRuntime }) {
  const ticket = randomBytes(32).toString('base64url');
  const readRoute = createWorkbenchRouteReader(workbenchRoot);
  const local = new Map();
  const components = componentRoot && makeComponentInstaller({ root: componentRoot });
  let installation;
  let closing = false;
  let editingCredentials;
  const canExecute = () => !closing && access().mode === 'execute';
  async function loadRuntime(backend, stateRoot, provisioned) {
    const stored = await localCredentials?.read(backend);
    const options = { runtimeRoot, stateRoot, ...provisioned };
    if (backend === 'codex') {
      const apiKey = stored?.key ?? (stored?.state === 'unavailable' ? undefined : localApiKey);
      const runtime = await makeLocalRuntime({ ...options, apiKey });
      return { ...runtime, workflowCredentialPin: createHash('sha256').update(apiKey ?? '').digest('hex') };
    }
    return makeLocalAgentRuntime({ ...localAgentOptions, ...options, backend, personalSubscription: personalClaudeSubscription,
      claudeKey: stored?.key ?? (stored?.state === 'unavailable' ? undefined : localAgentOptions?.claudeKey) });
  }
  if (localStateRoot) {
    for (const backend of Object.keys(localBackends)) {
      const stateRoot = backend === 'codex' ? localStateRoot : join(localStateRoot, backend);
      try {
        const provisioned = components ? await components.installed(backend) : null;
        const record = { stateRoot, provisioned };
        record.sdk = await loadRuntime(backend, stateRoot, provisioned);
        const service = await openLocalSdk({ root: stateRoot, backend, models: record.sdk.models ?? localModels,
          personalSubscription: personalClaudeSubscription,
          createThread: (...args) => record.sdk.createThread(...args), canExecute,
          credentialConfigured: (profile) => record.sdk.credentialConfigured(profile) });
        const workbench = createLocalWorkbench({ service, runtimeAvailable: () => record.sdk.runtimeAvailable, backend, access, data,
          onChange: onMemoryChanged, onError: onMemoryError });
        local.set(backend, Object.assign(record, { service, workbench }));
      } catch {
        // Each backend can be opened independently, including the existing SSH route.
      }
    }
  }
  const localUnavailable = { ok: false, code: 'local_sdk_unavailable', message: '本机 SDK 记录无法读取。' };
  function localStatus() {
    if (!local.size) return localUnavailable;
    const providers = [...local.values()].map(({ service, sdk }) => {
      const { profiles, ...status } = service.status();
      const loginPending = sdk.credentialSource === 'agy-local-login' && sdk.runtimeAvailable;
      return { ...status, ...(loginPending && { credentialConfigured: false, credentialPending: true }),
        ...(status.backend === 'claude-sdk' && personalClaudeSubscription && { personalSubscriptionAvailable: true }),
        runtimeAvailable: sdk.runtimeAvailable, credentialSource: sdk.credentialSource ?? 'codex-api-key',
        profiles: profiles.map((profile) => ({ ...profile, backend: status.backend,
          ...(sdk.accountDirectory && { accountDirectory: sdk.accountDirectory(profile.id) }) })) };
    });
    return { ...providers[0], providers, profiles: providers.flatMap(({ profiles }) => profiles) };
  }
  async function claudeSubscriptionAuth(profileId, action) {
    if (!canExecute()) return { ok: false, code: 'browse_only' };
    const selected = local.get('claude-sdk');
    const profile = selected?.service.status().profiles.find(({ id, authMode }) => id === profileId && authMode === 'subscription');
    if (!personalClaudeSubscription || !profile || !selected.sdk[action]) return { ok: false, code: 'credential_unavailable' };
    try { return await selected.sdk[action](profile, canExecute); }
    catch { return { ok: false, code: 'credential_unavailable' }; }
  }
  function localComponentsStatus() {
    if (!components) return null;
    const items = components.status().map((item) => {
      const record = local.get(item.backend);
      const ready = record?.sdk.runtimeAvailable && record.service.status().profiles.length > 0;
      const source = record?.provisioned ? 'downloaded' : record?.sdk.runtimeAvailable ? 'existing' : null;
      return { ...item, ready: Boolean(ready), source, available: Boolean(record) };
    });
    return { supported: components.supported, mode: componentMode, items };
  }
  async function provisionLocalComponents(ids, signal) {
    const results = [];
    for (const backend of ids) {
      const selected = local.get(backend);
      let code;
      try {
        signal.throwIfAborted();
        if (!selected) throw Object.assign(new Error(), { code: 'component_storage_failed' });
        if (!selected.sdk.runtimeAvailable) {
          const provisioned = await components.install(backend, signal);
          signal.throwIfAborted();
          const sdk = await loadRuntime(backend, selected.stateRoot, provisioned);
          if (!sdk.runtimeAvailable) throw Object.assign(new Error(), { code: 'component_archive_invalid' });
          Object.assign(selected, { sdk, provisioned });
        }
        signal.throwIfAborted();
        if (!selected.service.status().profiles.length) {
          const directory = await ensurePrivateDirectory(join(localStateRoot, 'installed-workspaces', backend));
          signal.throwIfAborted();
          const model = selected.service.status().models[0];
          const result = await selected.service.registerProfile({ name: localBackends[backend].label,
            directory, model: model.id, effort: model.defaultEffort });
          if (!result.ok) throw Object.assign(new Error(), { code: 'component_storage_failed' });
        }
      } catch (error) {
        code = signal.aborted ? 'component_cancelled' :
          componentErrors.has(error.code) ? error.code : 'component_storage_failed';
      }
      results.push({ backend, ok: !code, ...(code && { code }) });
    }
    return { ok: results.every((item) => item.ok), results };
  }
  async function closeLocal() {
    closing = true;
    installation?.controller.abort();
    await installation?.result;
    await editingCredentials;
    for (const { workbench } of local.values()) workbench.dispose();
    await Promise.allSettled([...local.values()].map(({ service }) => service.close()));
  }
  const bridgeOptions = { pythonPath, executable: join(runtimeRoot, 'DshVpsChatBridge.exe'),
    compatibilityDirectory: join(runtimeRoot, 'compat'), useCurrentAntigravity: true, readRoute };
  const backend = makeBridge({ ...bridgeOptions, root: workbenchRoot });
  const chat = data ? createProjectMemoryBridge({ data, backend, access, onChange: onMemoryChanged, onError: onMemoryError,
    extractor: makeBridge({ ...bridgeOptions, root: join(workbenchRoot, 'project-memory') }) }) : backend;
  const providers = Object.keys(workflowProviders);
  async function vpsTarget() {
    const saved = data.preference(setupConnectionKey);
    const packet = saved === undefined ? await backend.request({ op: 'preset' }, { current: true }) :
      await readSetupPreset(saved, (settings) => backend.request({ op: 'configuration', settings }, { current: true }));
    const preset = packet?.ok === true && packet.preset;
    if (!preset?.settings.hostKeyConfirmed || !/^[a-f0-9]{64}$/.test(preset.memoryTargetId)) return null;
    let tools;
    const { key, ids } = await readToolPreferences(preset.settings, [...providers, 'claude-subscription'], (name) => {
      tools = data.preference(name);
      return tools;
    });
    return { ...preset, providers: (ids ?? [preset.settings.provider ?? 'claude']).filter((id) => providers.includes(id)),
      isCurrent: () => data.preference(setupConnectionKey) === saved && data.preference(key) === tools };
  }
  const mixed = data && openMixedWorkflow({ data, canExecute,
    async targets() {
      const items = (local.get('codex')?.service.status().profiles ?? []).map(({ id, name, targetId }) =>
        ({ id, targetId, label: name, location: 'local-sdk', providers: ['codex'] }));
      const vps = await vpsTarget().catch(() => null);
      if (vps) items.push({ id: vps.memoryTargetId, targetId: vps.memoryTargetId, label: vps.name,
        location: 'ssh-vps', providers: vps.providers });
      return { ok: true, targets: items };
    },
    async resolve(stage) {
      if (stage?.execution?.location === 'local-sdk') return mixedLocalRoute(stage, local.get('codex'));
      const vps = await vpsTarget();
      if (!vps?.providers.includes(stage?.provider)) return null;
      const settings = { ...vps.settings, provider: stage.provider };
      const reply = await backend.request({ op: 'configuration', settings }, { current: true });
      return mixedVpsRoute(stage, vps, vps.isCurrent, reply, readRoute);
    },
    async catalog(route) {
      const body = { op: 'models', settings: route.settings, targetId: route.targetId };
      const packet = route.settings.location === 'local-sdk' ? await local.get('codex').workbench.request(body) :
        await backend.request(body, { current: true, pinnedRelay: route.pinnedRelay });
      if (packet?.ok !== true) throw new Error('无法读取所选执行配置的模型目录。');
      const models = readModelCatalog(packet);
      if (!models.length) throw new Error('所选执行配置没有可用的模型。');
      return models;
    },
    async dispatch(op, payload, route, options) {
      const body = { op, ...payload };
      if (route.settings.location === 'local-sdk') return local.get('codex').workbench.request(body, options);
      if (op === 'workflow-artifacts') return readWorkflowArtifacts(body, { readRun: options.workflowRun,
        backend: { request: (packet) => backend.request(packet, { current: true, pinnedRelay: route.pinnedRelay }) },
        isAllowed: options.isLive });
      if (op === 'send') {
        for (const kind of ['model', 'account']) {
          if (!options.isLive()) return { ok: false, code: 'mixed_route_changed' };
          const check = await backend.request({ op: 'setup-check', kind, settings: body.settings, targetId: body.targetId,
            mcpServers: [] }, { current: true, pinnedRelay: route.pinnedRelay });
          const ready = kind === 'model' ? check?.status === 'model_route_ready' :
            ['signed_in', 'key_configured', 'manual'].includes(check?.status);
          if (check?.ok !== true || check.targetId !== body.targetId || !ready) return { ok: false, code: 'mixed_preflight',
            message: kind === 'model' ? '预期 VPS 出口或模型服务路由未通过检查。' : '请核对原 VPS 配置的账号登录。' };
        }
      }
      if (!options.isLive()) return { ok: false, code: 'mixed_route_changed' };
      return chat.request(body, { ...options, pinnedRelay: route.pinnedRelay });
    },
  });
  const bridge = {
    request(body, options) {
      if (body.op === 'configuration') {
        const saved = body.settings ? undefined : data?.preference(setupConnectionKey);
        const read = (request) => backend.request(request, { current: true });
        return saved === undefined ? read(body) :
          readSetupPreset(saved, (settings) => read({ op: 'configuration', settings }));
      }
      if (body.op === 'setup-trial') {
        return runSetupTrial(body, backend, () => permitsChat(access(), body.op) && (!options?.isLive || options.isLive()));
      }
      if (body.op === 'setup-backend') {
        if (!permitsChat(access(), body.op) || options?.isLive && !options.isLive()) return accessDenied;
        return backend.request(body, { current: true });
      }
      if (data && body.op === 'workflow-artifacts') {
        return readWorkflowArtifacts(body, {
          readRun: () => readLegacyWorkflowRun(data.preference(workflowRunKey) ?? null), backend,
          isAllowed: () => permitsChat(access(), body.op) && (!options?.isLive || options.isLive()),
        });
      }
      const saved = body.op === 'preset' ? data?.preference(setupConnectionKey) : undefined;
      if (saved !== undefined) {
        return readSetupPreset(saved, (settings) => chat.request({ op: 'list', settings }, { current: true }));
      }
      return chat.request(withWorkspaceAccess(body, access()), options);
    },
    dispose() { chat.dispose?.(); },
  };
  let origin;
  let port;
  let host;
  let terminal;
  function permitted(req) {
    return req.socket.remoteAddress === '127.0.0.1' && req.headers.host === '127.0.0.1:' + port &&
      !blockedHeaders.some((name) => Object.hasOwn(req.headers, name)) &&
      (!req.headers.origin || req.headers.origin === origin) &&
      hasSession(req.headers.cookie, ticket);
  }
  const securityHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  const server = createServer(async (req, res) => {
    try {
      if (!permitted(req)) {
        res.writeHead(403, securityHeaders).end();
        return;
      }
      if (req.url === prefix + 'token') return await host.token(req, res);
      if (req.url === prefix + 'rpc') return await host.rpc(req, res);
      if (req.url === prefix + 'account-player.mjs') return await host.player(req, res);
      if (req.url === SUBSCRIPTION_PREFIX + 'bootstrap') return await terminal.token(req, res);
      if (req.url === SUBSCRIPTION_PREFIX + 'rpc') return await terminal.rpc(req, res);
      const asset = staticRoutes.get(req.url);
      if (req.method !== 'GET' || !asset) {
        res.writeHead(404, securityHeaders).end();
        return;
      }
      const content = await readFile(join(webRoot, asset[0]));
      res.writeHead(200, { ...securityHeaders, 'Content-Type': asset[1], 'Content-Length': content.length,
        'Content-Security-Policy': [
          "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:", "font-src 'self' data:", "frame-src 'self' about: blob:",
          "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
          "connect-src 'self' ws://127.0.0.1:" + port,
        ].join('; '),
      }).end(content);
    } catch {
      if (!res.headersSent) res.writeHead(500, securityHeaders);
      res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!permitted(req) || req.url !== accountSocketPath || access().mode !== 'execute') {
      socket.destroy();
      return;
    }
    host.upgrade(req, socket, head);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    origin = 'http://127.0.0.1:' + port;
    host = createHost({ port, root: workbenchRoot, bridge, accountEnabled: true, allowExtensions: true,
      allowProjectMemory: Boolean(data), allowModelParameters: true, allowDesignBranches: true,
      allowWorkflowStage: Boolean(data), allowSetupCheck: true, allowWorkflowArtifacts: Boolean(data), allowBackendSetup: true, readRoute,
      authorize: (op) => permitsChat(access(), op) ? null : accessDenied });
    terminal = makeSubscriptionHost({ port, stateRoot: terminalRoot, workbenchRoot,
      executable: join(runtimeRoot, 'terminal', 'DshSshBridge.exe'),
      authorize: (op) => permitsTerminal(access(), op),
      readRoute() {
        const route = readRoute();
        return route === null ? { kind: 'direct' } : { ...route, kind: 'relay' };
      },
      verifyTarget: async (_root, settings) => {
        const reply = await bridge.request({ op: 'list', settings });
        if (reply.ok !== true || !/^[a-f0-9]{64}$/.test(reply.targetId ?? '')) throw new Error('target_unverified');
        return reply.targetId;
      },
    });
  } catch (error) {
    host?.dispose();
    bridge.dispose?.();
    server.close();
    await closeLocal();
    throw error;
  }
  return {
    origin,
    cookie: { url: origin, name: cookieName, value: ticket, path: '/', httpOnly: true, sameSite: 'strict' },
    localStatus,
    requestMixedWorkflow: (body) => requestMixedWorkflow(closing ? null : mixed, body),
    localComponentsStatus,
    installLocalComponents(ids) {
      if (!validComponentSelection(ids)) return { ok: false, code: 'invalid_component' };
      if (!canExecute()) return { ok: false, code: 'browse_only' };
      if (!components?.supported) return { ok: false, code: 'component_platform_unavailable' };
      if (installation || editingCredentials) return { ok: false, code: 'component_busy' };
      const controller = new AbortController();
      const result = provisionLocalComponents(ids, controller.signal).finally(() => { installation = null; });
      installation = { controller, result };
      return result;
    },
    cancelLocalComponents() { installation?.controller.abort(); },
    saveLocalCredential(backend, key) {
      if (!canExecute()) return { ok: false, code: 'browse_only' };
      if (installation || editingCredentials) return { ok: false, code: 'component_busy' };
      const selected = local.get(backend);
      if (!localCredentials || !selected?.sdk.runtimeAvailable) return { ok: false, code: 'credential_unavailable' };
      editingCredentials = (async () => {
        await localCredentials.write(backend, key, canExecute);
        selected.sdk = await loadRuntime(backend, selected.stateRoot, selected.provisioned);
        return { ok: true };
      })().catch((error) => ({ ok: false, code: ['invalid_key', 'browse_only'].includes(error.code) ? error.code : 'credential_unavailable' }))
        .finally(() => { editingCredentials = null; });
      return editingCredentials;
    },
    async loginLocalAntigravity(profileId) {
      if (!canExecute()) return { ok: false, code: 'browse_only' };
      const selected = local.get('antigravity');
      const profile = selected?.service.status().profiles.find(({ id }) => profileId === id);
      if (!profile || !selected.sdk.login) return { ok: false, code: 'credential_unavailable' };
      try { return await selected.sdk.login(profile, canExecute); }
      catch { return { ok: false, code: 'credential_unavailable' }; }
    },
    loginLocalClaudeSubscription: (profileId) => claudeSubscriptionAuth(profileId, 'loginSubscription'),
    checkLocalClaudeSubscription: (profileId) => claudeSubscriptionAuth(profileId, 'checkSubscription'),
    async requestLocal(body) {
      if (body?.location !== 'local-sdk' || !isLocalBackend(body.backend))
        return { ok: false, code: 'execution_location_mismatch', message: '请选择对应的本机配置。' };
      const selected = local.get(body.backend);
      if (!selected) return localUnavailable;
      if (body.op === 'workbench') {
        if (Object.keys(body).length !== 4 || !Object.hasOwn(body, 'payload')) return {
          ok: false, code: 'invalid_request', message: '本机工作台请求格式不正确。',
        };
        return selected.workbench.request(body.payload);
      }
      if (!selected.sdk.runtimeAvailable && body.op === 'send')
        return { ok: false, code: 'runtime_unavailable', message: '找不到所选执行端的本机运行时。' };
      return selected.service.request(body);
    },
    async registerLocalProfile({ backend = 'codex', ...profile }) {
      const selected = local.get(backend);
      if (!selected) return localUnavailable;
      const result = await selected.service.registerProfile(profile);
      return result.ok ? { ...result, profile: localStatus().profiles.find(({ id }) => id === result.profile.id) } : result;
    },
    changeMemoryExtractionModel(change) {
      const codex = local.get('codex');
      return codex?.service.status().profiles.some(({ targetId }) => targetId === change?.targetId)
        ? codex.workbench.changeExtractionModel(change) : chat.changeExtractionModel(change);
    },
    accessChanged() {
      if (access().mode !== 'browse') return;
      void mixed?.pause()?.catch(() => {});
      installation?.controller.abort();
      host.revokeAccount();
      for (const { service } of local.values()) service.revokeExecution();
    },
    async close() {
      await mixed?.dispose();
      terminal.dispose();
      host.dispose();
      await closeLocal();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
