import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountView, accountSocketPath, readAccountRoute } from './account-view.js';
import { validAccountRequest } from '../client/account-routes.js';
import { modelParameterFields, validModelParameters } from '../client/model-parameters.js';
import { readSshRelay, relayEnvironment, relayRequired } from './ssh-relay.js';

export const name = 'dsh-vps-chat-workbench';
export const inject = ['webServer'];
export const prefix = '/dsh-vps-chat/api/';

const helperDirectory = fileURLToPath(new URL('../helper/', import.meta.url));
const accountPlayer = new URL('../client/account-player.mjs', import.meta.url);
const maxRequestBytes = 64 * 1024;
const maxDesignRequestBytes = 1280 * 1024;
const maxResponseBytes = 2 * 1024 * 1024;
const operations = Object.freeze({
  preset: ['op'],
  configuration: ['op', 'settings'],
  list: ['op', 'settings'],
  models: ['op', 'settings', 'targetId'],
  'setup-check': ['op', 'settings', 'targetId', 'kind', 'mcpServers'],
  'setup-trial': ['op', 'settings', 'targetId', 'kind', 'sessionId', 'turnId'],
  'workflow-artifacts': ['op', 'settings', 'targetId', 'sessionId', 'turnId', 'workflowRunId'],
  'model-options': ['op', 'settings', 'targetId'],
  get: ['op', 'settings', 'targetId', 'sessionId'],
  'design-history': ['op', 'settings', 'targetId', 'sessionId'],
  send: ['op', 'settings', 'targetId', 'sessionId', 'turnId', 'prompt'],
  refresh: ['op', 'settings', 'targetId', 'sessionId'],
  stop: ['op', 'settings', 'targetId', 'sessionId', 'turnId'],
  steer: ['op', 'settings', 'targetId', 'sessionId', 'turnId', 'steerId', 'prompt'],
  approval: ['op', 'settings', 'targetId', 'sessionId', 'turnId', 'approvalId', 'decision'],
  'account-view': ['op', 'targetId'],
});
const settingsFields = [
  'host', 'port', 'user', 'identityPath', 'knownHostsPath', 'workspace',
  'expectedIpv4', 'expectedIpv6', 'hostKeyConfirmed',
];
const proxyHeaders = new Set(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);
const invalidRequest = { ok: false, code: 'invalid_request', message: '请求内容无效。' };
const rejected = { ok: false, code: 'request_rejected', message: '本机工作台拒绝了此请求。' };
const notReady = { ok: false, code: 'bridge_not_ready', message: '本机 VPS 对话组件或 Python 运行环境不可用。' };
const uncertain = { ok: false, code: 'unknown', message: '暂时无法确认结果。请查询原回执。' };

const oneHeader = (req, key) => {
  let value;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() !== key) continue;
    if (value !== undefined) return null;
    value = req.rawHeaders[i + 1];
  }
  return value;
};

function fromLoopback(req, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  if (req.rawHeaders.some((field, i) => i % 2 === 0 && proxyHeaders.has(field.toLowerCase()))) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(oneHeader(req, 'host'));
}

function fromWorkbench(req, port) {
  if (!fromLoopback(req, port)) return false;
  const host = oneHeader(req, 'host');
  const origin = oneHeader(req, 'origin');
  const site = oneHeader(req, 'sec-fetch-site');
  // DSH Desktop's protocol adapter may omit both browser origin headers.
  return oneHeader(req, 'x-dsh-vps-chat') === '1' &&
    (origin === undefined || origin === `http://${host}`) &&
    (site === undefined || site === 'same-origin');
}

function sameToken(value, token) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

function hasExactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function validDesignContext(context) {
  if (!hasExactFields(context, ['text', 'images']) || typeof context.text !== 'string' ||
      context.text.length > 24000 || context.text.includes('\0') ||
      !Array.isArray(context.images) || context.images.length > 2 || (!context.text.trim() && !context.images.length)) return false;
  return context.images.every(image => {
    if (!hasExactFields(image, ['name', 'dataUrl']) || typeof image.name !== 'string' ||
        !image.name.trim() || image.name.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(image.name) ||
        typeof image.dataUrl !== 'string') return false;
    const prefix = /^data:image\/(?:png|jpeg|webp);base64,/.exec(image.dataUrl);
    if (!prefix) return false;
    const data = image.dataUrl.slice(prefix[0].length);
    return data.length > 0 && data.length <= 524288 && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
  });
}

function validExtensions(value) {
  if (!hasExactFields(value, ['memory', 'mcpServers'])) return false;
  const { memory, mcpServers } = value;
  return Array.isArray(memory) && memory.length <= 5 && Array.isArray(mcpServers) && mcpServers.length <= 8 &&
    (memory.length > 0 || mcpServers.length > 0) && new Set(mcpServers).size === mcpServers.length &&
    mcpServers.every((id) => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(id)) &&
    memory.every((item) => hasExactFields(item, ['title', 'text']) && typeof item.title === 'string' &&
      item.title.trim() && item.title.length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/.test(item.title) &&
      typeof item.text === 'string' && item.text.trim() && item.text.length <= 2000 &&
      !item.text.includes('\0') && Buffer.byteLength(item.text) <= 2400) &&
    Buffer.byteLength(JSON.stringify(memory)) <= 8192;
}

export function validWorkflowArtifactPath(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= 512 &&
    !/[\\\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
}

export const maxWorkflowArtifactBytes = 256 * 1024 * 1024;
export function validWorkflowArtifactQuery(value) {
  const hasPath = Object.hasOwn(value, 'path');
  const hasAfter = Object.hasOwn(value, 'after');
  const hasOffset = Object.hasOwn(value, 'offset');
  return (!hasPath || validWorkflowArtifactPath(value.path)) &&
    (!hasAfter || (!hasPath && !hasOffset && validWorkflowArtifactPath(value.after))) &&
    (!hasOffset || (hasPath && Number.isInteger(value.offset) &&
      value.offset >= 0 && value.offset < maxWorkflowArtifactBytes));
}

function validRequest(value, { allowExtensions, allowProjectMemory, allowModelParameters, allowDesignBranches, allowWorkflowStage, allowSetupCheck, allowWorkflowArtifacts }) {
  if (typeof value?.op !== 'string' || !Object.hasOwn(operations, value.op)) return false;
  if (value.op === 'account-view') {
    return validAccountRequest(value);
  }
  if (value.op === 'configuration') {
    if (!allowSetupCheck) return false;
    if (hasExactFields(value, ['op'])) return true;
  }
  const design = value.op === 'send' && value.mode === 'design';
  const history = value.op === 'design-history';
  const historyTurn = history && Object.hasOwn(value, 'turnId');
  const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const artifacts = value.op === 'workflow-artifacts';
  const artifactFields = artifacts ? ['path', 'after', 'offset'].filter((field) => Object.hasOwn(value, field)) : [];
  if (artifacts && (!allowWorkflowArtifacts || !value.settings?.provider ||
      typeof value.workflowRunId !== 'string' || !guid.test(value.workflowRunId) ||
      !validWorkflowArtifactQuery(value))) return false;
  const hasContext = Object.hasOwn(value, 'designContext');
  const hasDesignBase = Object.hasOwn(value, 'designBase');
  const hasModel = Object.hasOwn(value, 'model');
  const hasEffort = Object.hasOwn(value, 'effort');
  const hasAdvanced = Object.hasOwn(value, 'advanced');
  const hasExtensions = Object.hasOwn(value, 'extensions');
  const hasProjectMemory = Object.hasOwn(value, 'projectMemory');
  const hasWorkflowStage = Object.hasOwn(value, 'workflowStage');
  const fields = operations[value.op];
  if (value.op === 'setup-check') {
    const { kind, mcpServers, settings } = value;
    if (!allowSetupCheck || !Object.hasOwn(settings ?? {}, 'provider') || !['ssh', 'account', 'model', 'resources'].includes(kind) ||
        !Array.isArray(mcpServers) || mcpServers.length > 8 || new Set(mcpServers).size !== mcpServers.length ||
        (mcpServers.length && (kind !== 'resources' || !['codex', 'antigravity'].includes(settings.provider))) ||
        !mcpServers.every((id) => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(id))) return false;
  }
  if (value.op === 'setup-trial' && (!allowSetupCheck || !Object.hasOwn(value.settings ?? {}, 'provider') ||
      !['start', 'inspect'].includes(value.kind) || (value.kind === 'inspect' && (hasModel || hasEffort)) ||
      value.sessionId === value.turnId)) return false;
  if (value.op === 'model-options' && !allowModelParameters) return false;
  if (history && !allowDesignBranches) return false;
  if (hasDesignBase && (!allowDesignBranches || !design ||
      !hasExactFields(value.designBase, ['parentTurnId', 'fork']) ||
      typeof value.designBase.parentTurnId !== 'string' || !guid.test(value.designBase.parentTurnId) ||
      typeof value.designBase.fork !== 'boolean' ||
      (value.designBase.fork && (!hasContext || typeof value.designContext?.text !== 'string' ||
        !value.designContext.text.trim())))) return false;
  if (hasAdvanced && (!allowModelParameters || value.op !== 'send' ||
      !validModelParameters(value.settings?.provider, value.advanced))) return false;
  if (hasExtensions && (!allowExtensions || value.op !== 'send' || value.settings?.provider !== 'codex' ||
      !validExtensions(value.extensions))) return false;
  if (hasProjectMemory && (!allowProjectMemory || value.op !== 'send' || !value.settings?.provider ||
      !hasExactFields(value.projectMemory, ['projectId']) || (value.projectMemory.projectId !== null &&
      (typeof value.projectMemory.projectId !== 'string' || !value.projectMemory.projectId.trim() ||
       Buffer.byteLength(value.projectMemory.projectId) > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value.projectMemory.projectId))))) return false;
  if (hasWorkflowStage && (!allowWorkflowStage || value.op !== 'send' || !value.settings?.provider ||
      design || hasExtensions || hasProjectMemory || hasAdvanced || hasEffort ||
      !hasExactFields(value.workflowStage, ['runId']) || typeof value.workflowStage.runId !== 'string' ||
      !guid.test(value.workflowStage.runId))) return false;
  if (hasContext && (!design || !validDesignContext(value.designContext))) return false;
  if (hasModel && (!['send', 'setup-trial'].includes(value.op) || typeof value.model !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value.model))) return false;
  if (hasEffort && (!hasModel || typeof value.effort !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(value.effort))) return false;
  if (!hasExactFields(value, [
    ...fields, ...(design ? ['mode'] : []), ...(hasContext ? ['designContext'] : []),
    ...(hasDesignBase ? ['designBase'] : []), ...(historyTurn ? ['turnId'] : []),
    ...(hasModel ? ['model'] : []), ...(hasEffort ? ['effort'] : []), ...(hasExtensions ? ['extensions'] : []),
    ...(hasProjectMemory ? ['projectMemory'] : []), ...(hasAdvanced ? ['advanced'] : []),
    ...(hasWorkflowStage ? ['workflowStage'] : []), ...artifactFields,
  ])) return false;
  if (value.op === 'preset') return true;
  const settings = value.settings;
  if (Object.hasOwn(settings ?? {}, 'provider')) {
    if (!hasExactFields(settings, [...settingsFields, 'provider']) ||
        !['codex', 'claude', 'claude-sdk', 'antigravity'].includes(settings.provider)) return false;
  } else if (!hasExactFields(settings, settingsFields)) return false;
  if ((design || history || hasEffort) && settings.provider !== 'codex') return false;
  if (value.op === 'steer' && !['codex', 'antigravity'].includes(settings.provider)) return false;
  if (value.op === 'approval' && (settings.provider !== 'antigravity' ||
      typeof value.approvalId !== 'string' || !guid.test(value.approvalId) ||
      !['allow', 'deny'].includes(value.decision))) return false;
  if ((hasModel || value.op === 'models' || value.op === 'model-options') && !Object.hasOwn(settings, 'provider')) return false;
  if (settings.hostKeyConfirmed !== true || !Number.isInteger(settings.port) ||
      settings.port < 1 || settings.port > 65535 ||
      !settingsFields.slice(0, -1).filter(field => field !== 'port').every(field =>
        typeof settings[field] === 'string' && settings[field].length <= 2048 && !settings[field].includes('\0'))) return false;
  if (!['list', 'configuration'].includes(value.op) && (typeof value.targetId !== 'string' || !/^[0-9a-f]{64}$/.test(value.targetId))) return false;
  if (!['list', 'configuration', 'models', 'model-options', 'setup-check'].includes(value.op) &&
      (typeof value.sessionId !== 'string' || !guid.test(value.sessionId))) return false;
  if ((artifacts || historyTurn || ['send', 'stop', 'steer', 'approval', 'setup-trial'].includes(value.op)) &&
      (typeof value.turnId !== 'string' || !guid.test(value.turnId))) return false;
  if (value.op === 'steer' && (typeof value.steerId !== 'string' || !guid.test(value.steerId))) return false;
  return !['send', 'steer'].includes(value.op) || (typeof value.prompt === 'string' &&
    value.prompt.trim() && value.prompt.length <= (value.op === 'steer' ? 1200 : 8192) && !value.prompt.includes('\0'));
}

async function readRequest(req) {
  const length = oneHeader(req, 'content-length');
  const transfer = oneHeader(req, 'transfer-encoding');
  if (length === null || transfer === null ||
      (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxDesignRequestBytes)) ||
      (transfer !== undefined && (length !== undefined || transfer.toLowerCase() !== 'chunked'))) throw new Error('Invalid body');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxDesignRequestBytes) throw new Error('Request exceeds limit');
    chunks.push(chunk);
  }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  return { body, size };
}

function respond(res, status, packet) {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(packet);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function windowsEnvironment(pythonPath) {
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const env = {
    SystemRoot: windows,
    WINDIR: windows,
    PATH: [join(windows, 'System32'), dirname(pythonPath)].join(';'),
    DSH_VPS_CHAT_PYTHON: pythonPath,
  };
  for (const key of ['ProgramData', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function createBridge({
  root,
  pythonPath = join(process.env.LOCALAPPDATA ?? '', 'Programs/Python/Python311/python.exe'),
  executable = join(helperDirectory, 'DshVpsChatBridge.exe'),
  compatibilityDirectory,
  useCurrentAntigravity = false,
  readRoute = () => readAccountRoute(root, true),
} = {}) {
  let disposed = false;
  let active = 0;
  return {
    async request(body, { current = false } = {}) {
      if (disposed || typeof root !== 'string' || !isAbsolute(root) || !isAbsolute(pythonPath) ||
          !existsSync(pythonPath)) return notReady;
      const provider = body.settings?.provider;
      if (['configuration', 'setup-check', 'workflow-artifacts', 'approval'].includes(body.op) ||
          (provider === 'antigravity' && useCurrentAntigravity)) current = true;
      const advanced = body.op === 'send' && Object.hasOwn(body, 'advanced');
      const inspectingOptions = body.op === 'model-options';
      const scopedCodex = body.op === 'send' && provider === 'codex' &&
        (Object.hasOwn(body, 'workspaceAccess') || Object.hasOwn(body, 'extensions') || Object.hasOwn(body, 'designBase'));
      const localOnly = ['preset', 'configuration', 'list', 'get', 'design-history'].includes(body.op) ||
        (body.op === 'models' && ['claude', 'claude-sdk'].includes(provider));
      let useCompatibility = Boolean(compatibilityDirectory) && localOnly && !current && body.op !== 'design-history';
      let directClaude = false;
      let relay = {};
      if (!localOnly && compatibilityDirectory) {
        try {
          const policy = readRoute();
          directClaude = provider === 'claude' && policy === null;
          if (advanced && directClaude) {
            return { ...invalidRequest, message: '当前 Claude API 直连执行端无法应用高级参数。请恢复执行端默认后发送。' };
          }
          useCompatibility = !current && !scopedCodex && !advanced && !inspectingOptions &&
            (policy === null || provider === 'claude-sdk' || provider === 'antigravity');
          if (policy !== null) relay = relayEnvironment(policy);
        } catch { return relayRequired; }
      }
      const variant = provider === 'claude-sdk' ? 'sdk' : provider === 'antigravity' ? 'antigravity' : '';
      const helper = useCompatibility
        ? join(compatibilityDirectory, variant, 'DshVpsChatBridge.exe')
        : executable;
      if (!existsSync(helper)) return notReady;
      if (provider === 'claude-sdk' &&
          !existsSync(join(dirname(helper), 'dsh-claude-sdk-worker.mjs'))) {
        return { ...notReady, message: '当前插件包未包含 Claude SDK 执行组件。' };
      }
      if (provider === 'antigravity' &&
          !existsSync(join(dirname(helper), 'RemoteDshAntigravity.py'))) {
        return { ...notReady, message: '当前插件包未包含 Antigravity 执行组件。' };
      }
      if (active >= 6) return { ...rejected, message: '本机正在处理其他请求，请稍后查询。' };
      if (!localOnly && !compatibilityDirectory) {
        try { relay = relayEnvironment(readSshRelay(root)); } catch { return relayRequired; }
      }
      const payload = inspectingOptions ? { op: 'list', settings: body.settings } : body;
      active++;
      const packet = await new Promise(resolve => {
        let child;
        try {
          child = spawn(helper, [root], {
            cwd: dirname(helper), shell: false, windowsHide: true,
            env: { ...windowsEnvironment(pythonPath), ...relay }, stdio: ['pipe', 'pipe', 'ignore'],
          });
        } catch {
          active--;
          resolve(notReady);
          return;
        }
        let size = 0;
        let chunks = [];
        let stdinFailed = false;
        const timer = setTimeout(() => resolve(uncertain), 65_000);
        timer.unref();
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (size <= maxResponseBytes) chunks.push(chunk);
          else chunks = [];
        });
        child.stdin.on('error', () => { stdinFailed = true; });
        child.on('error', () => resolve(uncertain));
        child.once('close', code => {
          active--;
          clearTimeout(timer);
          if (code !== 0 || stdinFailed || size > maxResponseBytes) return resolve(uncertain);
          try {
            const packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            return resolve(typeof packet?.ok === 'boolean' ? packet : uncertain);
          } catch {
            return resolve(uncertain);
          }
        });
        child.stdin.end(JSON.stringify(payload), 'utf8');
      });
      if (!inspectingOptions || !packet.ok) return packet;
      // The local list probe derives the target from the settings and SSH pin file without contacting the VPS.
      if (packet.targetId !== body.targetId) return { ok: false, code: 'target_changed',
        message: 'VPS 设置或主机指纹已变化，请重新核对。' };
      return directClaude ? { ok: true, fields: [], reason: 'direct-claude' }
        : { ok: true, fields: modelParameterFields(provider) };
    },
    // An in-flight SSH launch may already have committed. Let the bounded
    // helper finish its receipt and reject new work after unmount.
    dispose() { disposed = true; },
  };
}

export function createHost({ port, root, bridge, accountEnabled = false, allowExtensions = false, allowProjectMemory = false,
  allowModelParameters = false, allowDesignBranches = false, allowWorkflowStage = false, allowSetupCheck = false,
  allowWorkflowArtifacts = false,
  readRoute = () => readAccountRoute(root),
  launchAccountBrowser, player = accountPlayer, authorize = () => null }) {
  const secret = randomBytes(32).toString('base64url');
  const account = accountEnabled ? createAccountView({
    port, bridge, launch: launchAccountBrowser,
    readRelay: readRoute,
    permitted: (req) => fromLoopback(req, port) && oneHeader(req, 'origin') === `http://${oneHeader(req, 'host')}`,
  }) : null;
  let disposed = false;
  return {
    async player(req, res) {
      if (disposed || !account || req.method !== 'GET' || req.url !== prefix + 'account-player.mjs' || !fromLoopback(req, port))
        return respond(res, 403, rejected);
      try {
        const bytes = await readFile(player);
        if (res.destroyed || disposed) return;
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': bytes.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(bytes);
      } catch { return respond(res, 503, notReady); }
    },
    upgrade(req, socket, head) {
      if (account) account.upgrade(req, socket, head);
      else socket.destroy();
    },
    revokeAccount() { account?.revoke(); },
    token(req, res) {
      if (disposed || req.method !== 'GET' || req.url !== prefix + 'token' ||
          !fromWorkbench(req, port)) return respond(res, 403, rejected);
      return respond(res, 200, { ok: true, token: secret });
    },
    async rpc(req, res) {
      const content = oneHeader(req, 'content-type');
      if (disposed || req.method !== 'POST' || req.url !== prefix + 'rpc' || !fromWorkbench(req, port) ||
          !sameToken(oneHeader(req, 'x-dsh-vps-chat-token'), secret) ||
          typeof content !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(content)) {
        return respond(res, 403, rejected);
      }
      let request;
      try { request = await readRequest(req); } catch { return respond(res, 400, invalidRequest); }
      const { body, size } = request;
      if (!validRequest(body, { allowExtensions, allowProjectMemory, allowModelParameters, allowDesignBranches, allowWorkflowStage, allowSetupCheck, allowWorkflowArtifacts }) ||
          (size > maxRequestBytes && !body.designContext))
        return respond(res, 400, invalidRequest);
      const denied = authorize(body.op);
      if (denied) return respond(res, 403, denied);
      try {
        const packet = body.op === 'account-view'
          ? (account ? await account.prepare(body.targetId, body.action) : notReady)
          : await bridge.request(body, body.workflowStage || ['workflow-artifacts', 'setup-trial'].includes(body.op) ? {
            isLive: () => !disposed && !req.aborted && !res.destroyed,
          } : undefined);
        return respond(res, 200, packet);
      } catch {
        return respond(res, 503, uncertain);
      }
    },
    dispose() { disposed = true; account?.dispose(); bridge.dispose?.(); },
  };
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const web = ctx.webServer;
    const accountEnabled = typeof web.registerUpgrade === 'function';
    const root = config?.root;
    const host = createHost({ port: web.port, root, bridge: createBridge({ root }), accountEnabled });
    const release = [];
    const dispose = () => {
      for (const unregister of release.reverse()) unregister();
      host.dispose();
    };
    try {
      release.push(web.register({ kind: 'exact', path: prefix + 'token', handler: host.token }));
      release.push(web.register({ kind: 'exact', path: prefix + 'rpc', handler: host.rpc }));
      if (accountEnabled) {
        release.push(web.register({ kind: 'exact', path: prefix + 'account-player.mjs', handler: host.player }));
        release.push(web.registerUpgrade({ path: accountSocketPath, handler: host.upgrade }));
      }
      return dispose;
    } catch (error) {
      dispose();
      throw error;
    }
  });
}
