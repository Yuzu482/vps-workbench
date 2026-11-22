import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBridge, createHost, prefix } from '../../remote-workbench/vps-chat/host/index.js';
import { accountSocketPath, createWorkbenchRouteReader } from '../../remote-workbench/vps-chat/host/account-view.js';
import { createStandaloneSubscriptionHost, SUBSCRIPTION_PREFIX } from '../terminal/subscription-host.mjs';
import { accessDenied, defaultAccess, permitsChat, permitsTerminal, withWorkspaceAccess } from './access.mjs';
import { createProjectMemoryBridge } from './project-memory.mjs';
import { readSetupPreset, setupConnectionKey } from './setup-state.mjs';
import { runSetupTrial } from './setup-trial.mjs';
import { readWorkflowRun } from '../workflow-engine/runner.mjs';
import { workflowRunKey } from '../workflow-engine/state.mjs';
import { readWorkflowArtifacts } from './workflow-artifacts.mjs';
import { localModels, openCodexRuntime } from './codex-runtime.mjs';
import { openLocalSdk } from '../local-sdk/service.mjs';
import { createLocalWorkbench } from '../local-sdk/workbench.mjs';

export { canonicalLocalDirectory, localCredentialVariable } from './codex-runtime.mjs';
export { localMemoryJournalKey } from '../local-sdk/workbench.mjs';

const staticRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/renderer.js', ['renderer.js', 'text/javascript; charset=utf-8']],
  ['/markdown-worker.js', ['markdown-worker.js', 'text/javascript; charset=utf-8']],
  ['/workbench.css', ['workbench.css', 'text/css; charset=utf-8']],
  ['/app-icon.png', ['app-icon.png', 'image/png']],
]);
const cookieName = 'vps-workbench-session';
const blockedHeaders = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];

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
  data, onMemoryChanged, onMemoryError, localStateRoot, localApiKey, makeLocalRuntime = openCodexRuntime }) {
  const ticket = randomBytes(32).toString('base64url');
  const readRoute = createWorkbenchRouteReader(workbenchRoot);
  let local;
  let runtimeAvailable = false;
  if (localStateRoot) {
    try {
      const sdk = await makeLocalRuntime({ runtimeRoot, stateRoot: localStateRoot, apiKey: localApiKey });
      runtimeAvailable = sdk.runtimeAvailable;
      local = await openLocalSdk({ root: localStateRoot, models: localModels, createThread: sdk.createThread,
        canExecute: () => access().mode === 'execute', credentialConfigured: sdk.credentialConfigured });
    } catch {
      // Failure to open local state leaves the original SSH workbench available.
    }
  }
  const localWorkbench = local && createLocalWorkbench({ service: local, runtimeAvailable, access, data,
    onChange: onMemoryChanged, onError: onMemoryError });
  const localUnavailable = { ok: false, code: 'local_sdk_unavailable', message: '本机 SDK 记录无法读取。' };
  const bridgeOptions = { pythonPath, executable: join(runtimeRoot, 'DshVpsChatBridge.exe'),
    compatibilityDirectory: join(runtimeRoot, 'compat'), useCurrentAntigravity: true, readRoute };
  const backend = makeBridge({ ...bridgeOptions, root: workbenchRoot });
  const chat = data ? createProjectMemoryBridge({ data, backend, access, onChange: onMemoryChanged, onError: onMemoryError,
    extractor: makeBridge({ ...bridgeOptions, root: join(workbenchRoot, 'project-memory') }) }) : backend;
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
      if (data && body.op === 'workflow-artifacts') {
        return readWorkflowArtifacts(body, {
          readRun: () => readWorkflowRun(data.preference(workflowRunKey) ?? null), backend,
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
      allowWorkflowStage: Boolean(data), allowSetupCheck: true, allowWorkflowArtifacts: Boolean(data), readRoute,
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
    localWorkbench?.dispose();
    await local?.close();
    throw error;
  }
  return {
    origin,
    cookie: { url: origin, name: cookieName, value: ticket, path: '/', httpOnly: true, sameSite: 'strict' },
    localStatus() { return local ? { ...local.status(), runtimeAvailable } : localUnavailable; },
    async requestLocal(body) {
      if (body?.location !== 'local-sdk' || body.backend !== 'codex')
        return { ok: false, code: 'execution_location_mismatch', message: '请选择本机 SDK 的 Codex 配置。' };
      if (body.op === 'workbench') {
        if (Object.keys(body).length !== 4 || !Object.hasOwn(body, 'payload')) return {
          ok: false, code: 'invalid_request', message: '本机工作台请求格式不正确。',
        };
        return localWorkbench ? localWorkbench.request(body.payload) : localUnavailable;
      }
      if (local && !runtimeAvailable && body.op === 'send')
        return { ok: false, code: 'runtime_unavailable', message: '找不到打包的本机 Codex 运行时。' };
      return local ? local.request(body) : localUnavailable;
    },
    async registerLocalProfile(profile) { return local ? local.registerProfile(profile) : localUnavailable; },
    changeMemoryExtractionModel(change) {
      return local?.status().profiles.some(({ targetId }) => targetId === change?.targetId)
        ? localWorkbench.changeExtractionModel(change) : chat.changeExtractionModel(change);
    },
    accessChanged() {
      if (access().mode !== 'browse') return;
      host.revokeAccount();
      local?.revokeExecution();
    },
    async close() {
      terminal.dispose();
      host.dispose();
      localWorkbench?.dispose();
      await local?.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
