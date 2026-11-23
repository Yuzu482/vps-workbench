import { randomBytes } from 'node:crypto';
import { watch as watchDirectory } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewFixtures } from '../preview/fixtures/index.mjs';
import { buildWebAssets, webSourceDirectories } from './web-assets.mjs';
import { accessDenied, defaultAccess, permitsChat, permitsTerminal, validAccess } from './access.mjs';
import { createProjectMemoryBridge } from './project-memory.mjs';
import { applyExtensionChange, extensionPreferenceKey, readExtensions } from '../extensions/state.mjs';
import { membershipKey, parseProjectMemberships } from '../../remote-workbench/vps-chat/client/project-folders.js';
import { readWorkflowRun } from '../workflow-engine/runner.mjs';
import { readWorkflows, workflowKey, workflowProviders } from '../workflow-engine/state.mjs';
import { mixedLocalRoute, mixedVpsRoute, openMixedWorkflow, requestMixedWorkflow } from './mixed-workflow.mjs';
import { readModelCatalog } from '../../remote-workbench/vps-chat/client/model-catalog.js';
import { decodeWorkflowAttachments } from './workflow-attachments.mjs';
import { readWorkflowArtifacts } from './workflow-artifacts.mjs';
import { createPreviewLocalSdk } from '../preview/fixtures/local-sdk.mjs';
import { localBackends } from '../local-sdk/providers.mjs';
import { readSetupPreset, setupConnectionKey } from './setup-state.mjs';
import { runSetupTrial } from './setup-trial.mjs';
import { componentCatalog } from './component-catalog.mjs';
import { validComponentSelection } from './component-install.mjs';
import { createGlobalSearch } from './global-search.mjs';
import { createSearchArtifactJournal } from './search-artifacts.mjs';

const previewPort = 47823;
const localAgentsPort = 47828;
const localComponentsPort = 47829;
const previewPrefix = '/__preview/';
const chatPrefix = '/dsh-vps-chat/api/';
const terminalPrefix = '/dsh-terminal-workbench/api/';
const sampleArtifact = Buffer.from('# 阶段示例结果\n\n这是本地预览中的示例产物。\n');
const sampleArtifactPath = 'docs/阶段结果.md';

function previewArtifacts({ path, after, offset }) {
  const entry = { path: sampleArtifactPath, size: sampleArtifact.length };
  if (path === undefined) return { ok: true, files: !after || entry.path > after ? [entry] : [], truncated: false };
  if (path === sampleArtifactPath && (offset === undefined || offset < entry.size)) {
    const data = sampleArtifact.subarray(offset ?? 0).toString('base64');
    return { ok: true, file: { ...entry, data, ...(offset === undefined ? {} : { offset, revision: 'a'.repeat(64) }) } };
  }
  return { ok: false, code: 'workflow_output_unavailable', message: '示例产物已不可用。' };
}
const nativeSource = new URL('./preview-native.js', import.meta.url);
const mime = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['workbench.css', 'text/css; charset=utf-8'],
  ['renderer.js', 'text/javascript; charset=utf-8'],
  ['markdown-worker.js', 'text/javascript; charset=utf-8'],
  ['app-icon.png', 'image/png'],
]);
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self' data:", "frame-src 'self' about: blob:",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "connect-src 'self'",
  ].join('; '),
};

function reply(response, status, type, content) {
  response.writeHead(status, { ...headers, 'Content-Type': type }).end(content);
}

function json(response, value, status = 200) {
  reply(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

async function readPacket(request) {
  if (request.headers['content-type'] !== 'application/json') throw new Error('invalid_content_type');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value.op !== 'string') throw new Error('invalid_packet');
  return value;
}

async function buildPreview(instance) {
  const [desktop, source] = await Promise.all([buildWebAssets(), readFile(nativeSource)]);
  const index = Buffer.from(desktop.files.get('index.html')).toString('utf8');
  if (!index.includes('</head>')) throw new Error('Preview entry requires the shared document head.');
  const document = index.replace('<title>VPS 工作台</title>', '<title>VPS 工作台 · 界面预览</title>')
    .replace('</head>', `  <meta name="workbench-revision" content="${desktop.manifest.revision}">\n` +
      `    <meta name="workbench-preview-instance" content="${instance}">\n` +
      `    <script src="${previewPrefix}native.js"></script>\n  </head>`);
  return { ...desktop, source, document };
}

export async function startPreview({ localAgents = false, localComponents = false, componentFailure = null, componentDelay = 550,
  personalSubscription = false, mixedFailureStage,
  backendPlatform, backendFailure,
  port = localComponents ? localComponentsPort : localAgents ? localAgentsPort : previewPort, watch = true, log = () => {} } = {}) {
  const instance = randomBytes(8).toString('hex');
  let current = await buildPreview(instance);
  let access = defaultAccess;
  let previewLocal;
  let componentInstall;
  const installedComponents = new Set();
  const fixtures = createPreviewFixtures({ backendPlatform, backendFailure });
  let projects = fixtures.projects;
  const token = randomBytes(24).toString('base64url');
  const clients = new Set();
  const watchers = [];
  const workflowRuns = new Map();
  const workflowApprovals = new Map();
  const localWorkflowRuns = new Map();
  const localWorkflowApprovals = new Map();
  const attachments = new Map();
  const data = {
    preference: (key) => fixtures.preferences[key],
    setPreference: async (key, value) => { fixtures.preferences[key] = value; },
    setPreferences: async (changes) => { Object.assign(fixtures.preferences, changes); },
    projects: () => projects,
    readWorkflowAttachments: async (refs) => refs.map(({ digest, name, size }) => {
      const content = attachments.get(digest);
      if (content?.length !== size) throw new Error('preview_attachment_missing');
      return { name, data: content.toString('base64') };
    }),
    changeExtensions: async (change, { canCommit = () => true } = {}) => {
      if (!canCommit()) return null;
      const state = applyExtensionChange(readExtensions(fixtures.preferences[extensionPreferenceKey] ?? null), change);
      fixtures.preferences[extensionPreferenceKey] = JSON.stringify(state);
      return state;
    },
  };
  const artifactJournal = createSearchArtifactJournal(data);
  const search = createGlobalSearch({ data, artifacts: artifactJournal.entries, async source() {
    return { partial: false, sessions: [...(await localSdk()).searchSnapshots(), ...fixtures.searchSnapshots()] };
  } });
  const chat = createProjectMemoryBridge({
    data, backend: { request: fixtures.chat }, extractor: { request: fixtures.extractMemory }, access: () => access,
    readRun: (id) => workflowRuns.get(id),
    readSavedWorkflow: (id, runId) => {
      if (mixed.status().run?.id === runId) return savedWorkflow(id);
      const approved = workflowApprovals.get(runId);
      return approved?.id === id ? approved : null;
    },
    onChange: (state) => {
      for (const client of clients) client.write('event: extensions\ndata: ' + JSON.stringify(state) + '\n\n');
    },
  });
  const savedWorkflow = (id) => readWorkflows(data.preference(workflowKey) ?? null).find((record) => record.id === id);
  const previewPreset = () => ({ ...fixtures.chat({ op: 'preset' }).preset, providers: Object.keys(workflowProviders) });
  const localPacket = (body, options) => localSdk().then((sdk) => sdk.request({ op: 'workbench', location: 'local-sdk',
    backend: 'codex', payload: body }, options));
  let failedStage;
  function dispatchMixed(body, options) {
    if (mixedFailureStage && body.op === 'send' && !failedStage) {
      const run = options.workflowRun();
      const index = run.rows.findIndex(({ sessionId }) => sessionId === body.sessionId);
      if (run.workflow.stages[index]?.id === mixedFailureStage) {
        failedStage = { ok: true, targetId: body.targetId, session: { id: body.sessionId,
          turns: [{ id: body.turnId, state: 'failed', errorCode: 'fixture_failure', reply: '模拟阶段失败。' }] } };
        return failedStage;
      }
    }
    if (body.op === 'get' && failedStage?.session.id === body.sessionId && failedStage.targetId === body.targetId) return failedStage;
    if (body.op === 'workflow-artifacts' && body.settings.location !== 'local-sdk') return readWorkflowArtifacts(body,
      { readRun: options.workflowRun, backend: { request: previewArtifacts }, isAllowed: options.isLive })
      .then((result) => artifactJournal.remember(body, result));
    return body.settings.location === 'local-sdk'
      ? localPacket(body, options).then((result) => artifactJournal.remember(body, result)) : chat.request(body, options);
  }
  const mixed = openMixedWorkflow({ data, canExecute: () => access.mode === 'execute', pollInterval: 150,
    async targets() {
      const preset = previewPreset();
      const profiles = (await localSdk()).status().profiles.filter(({ backend }) => backend === 'codex');
      return { ok: true, targets: [{ id: preset.memoryTargetId, targetId: preset.memoryTargetId, location: 'ssh-vps',
        label: preset.name, providers: preset.providers }, ...profiles.map(({ id, targetId, name }) =>
        ({ id, targetId, label: name, location: 'local-sdk', providers: ['codex'] }))] };
    },
    async resolve(stage) {
      if (stage?.execution?.location === 'local-sdk') {
        const sdk = await localSdk();
        return mixedLocalRoute(stage, { sdk: { runtimeAvailable: true }, service: { status: sdk.status } });
      }
      const preset = previewPreset();
      if (!preset.providers.includes(stage?.provider)) return null;
      const reply = fixtures.chat({ op: 'configuration', settings: { ...preset.settings, provider: stage.provider } });
      return mixedVpsRoute(stage, preset, () => true, reply, () => null);
    },
    async catalog(route) {
      return readModelCatalog(await dispatchMixed({ op: 'models', settings: route.settings, targetId: route.targetId }));
    },
    dispatch: (op, body, _route, options) => dispatchMixed({ op, ...body }, options),
  });
  let origin;
  let authority;
  let closed = false;
  let timer;
  let building = false;
  let queued = false;

  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  }

  function localSdk() {
    previewLocal ??= createPreviewLocalSdk(() => access, { data, personalSubscription,
      runtimeAvailable: (backend) => !localComponents || installedComponents.has(backend),
      readRun: (id) => id ? localWorkflowRuns.get(id) : [...localWorkflowRuns.values()].at(-1),
      readSavedWorkflow: (id, runId) => {
        if (mixed.status().run?.id === runId) return savedWorkflow(id);
        const approved = localWorkflowApprovals.get(runId);
        return approved?.id === id ? approved : null;
      },
      onChange: (state) => {
        for (const client of clients) client.write('event: extensions\ndata: ' + JSON.stringify(state) + '\n\n');
      } });
    return previewLocal;
  }

  function componentState() {
    return { supported: true, mode: 'on-demand', preview: true,
      items: Object.entries(componentCatalog).map(([backend, { version }]) => ({
        backend, version, ready: installedComponents.has(backend), available: true,
      })) };
  }

  async function installComponents(ids) {
    if (!validComponentSelection(ids)) return { ok: false, code: 'invalid_component' };
    if (access.mode !== 'execute') return { ok: false, code: 'browse_only' };
    if (componentInstall) return { ok: false, code: 'component_busy' };
    const controller = new AbortController();
    componentInstall = controller;
    try {
      await delay(componentDelay, undefined, { signal: controller.signal }).catch(() => {});
      if (closed) return { ok: false, code: 'component_cancelled' };
      const local = await localSdk();
      const results = [];
      for (const backend of ids) {
        let code;
        if (controller.signal.aborted) code = 'component_cancelled';
        else if (componentFailure === backend) {
          code = 'component_download_failed';
          componentFailure = null;
        } else if (!installedComponents.has(backend)) {
          const { models: [model] } = local.status().providers.find((item) => item.backend === backend);
          const result = await local.request({ op: 'register', backend, name: localBackends[backend].label,
            model: model.id, effort: model.defaultEffort });
          if (result.ok) installedComponents.add(backend);
          else code = 'component_storage_failed';
        }
        results.push({ backend, ok: !code, ...(code && { code }) });
      }
      return { ok: results.every(({ ok }) => ok), results };
    } finally { componentInstall = null; }
  }

  async function rebuild() {
    if (building) { queued = true; return; }
    building = true;
    try {
      const next = await buildPreview(instance);
      if (closed) return;
      const changed = next.manifest.revision !== current.manifest.revision || !next.source.equals(current.source);
      current = next;
      if (changed) {
        for (const client of clients) client.write('event: reload\ndata: ' + next.manifest.revision + '\n\n');
        log('界面已更新 ' + next.manifest.revision.slice(0, 12));
      }
    } catch (error) {
      log('界面构建失败，预览继续显示上次成功的版本。\n' + error.message);
    } finally {
      building = false;
      if (queued && !closed) { queued = false; refresh(); }
    }
  }

  const server = createServer(async (request, response) => {
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== authority ||
        (request.headers.origin && request.headers.origin !== origin)) {
      return json(response, { ok: false, code: 'preview_origin_required' }, 403);
    }
    const { method, url } = request;
    if (method === 'GET') {
      if (url === previewPrefix + 'state') {
        return json(response, { preferences: fixtures.preferences, projects, access,
          ...(localComponents && { localComponents: componentState() }) });
      }
      if (url === previewPrefix + 'revision') return json(response, current.manifest);
      if (url === previewPrefix + 'native.js') return reply(response, 200, mime.get('renderer.js'), current.source);
      if (url === previewPrefix + 'changes') {
        response.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8' });
        clients.add(response);
        response.on('close', () => clients.delete(response));
        response.write(`event: revision\ndata: ${current.manifest.revision}:${instance}\n\n`);
        return;
      }
      if (url === chatPrefix + 'token' && request.headers['x-dsh-vps-chat'] === '1') {
        return json(response, { ok: true, token });
      }
      if (url === terminalPrefix + 'bootstrap' && request.headers['x-rtw-bootstrap'] === '1') {
        return json(response, { token });
      }
      if (url === '/') return reply(response, 200, mime.get('index.html'), current.document);
      const name = url?.slice(1);
      if (name !== 'index.html' && mime.has(name)) return reply(response, 200, mime.get(name), current.files.get(name));
    }

    if (localComponents && url === previewPrefix + 'local-components') {
      if (method === 'GET') return json(response, componentState());
      if (method === 'POST' && request.headers.origin === origin) {
        try {
          const packet = await readPacket(request);
          if (packet.op === 'cancel') {
            componentInstall?.abort();
            return json(response, { ok: true });
          }
          if (packet.op === 'install') return json(response, await installComponents(packet.ids));
        } catch {}
        return json(response, { ok: false, code: 'invalid_preview_request' }, 400);
      }
    }
    if (url === previewPrefix + 'local-sdk' &&
        (method === 'GET' || method === 'POST' && request.headers.origin === origin)) {
      try {
        const local = await localSdk();
        return json(response, method === 'GET' ? local.status() : await local.request(await readPacket(request)));
      } catch { return json(response, { ok: false, code: 'preview_local_sdk_unavailable' }, 400); }
    }
    if (method === 'POST' && url === previewPrefix + 'access' && request.headers.origin === origin) {
      try {
        const { op, ...next } = await readPacket(request);
        if (op !== 'set-access' || !validAccess(next)) throw new Error('invalid_access');
        access = next;
        if (access.mode === 'browse') {
          componentInstall?.abort();
          (await previewLocal)?.revokeExecution();
        }
        return json(response, access);
      } catch {
        return json(response, { ok: false, code: 'invalid_access' }, 400);
      }
    }
    if (method === 'POST' && url === previewPrefix + 'connection' && request.headers.origin === origin) {
      try {
        const { op, value } = await readPacket(request);
        if (op !== 'save-connection') throw new Error('invalid_preview_connection');
        const saved = await readSetupPreset(value, (settings) => fixtures.chat({ op: 'configuration', settings }));
        if (!saved.ok) throw new Error('invalid_preview_connection');
        await data.setPreference(setupConnectionKey, value);
        return json(response, { ok: true });
      } catch { return json(response, { ok: false, code: 'invalid_preview_connection' }, 400); }
    }
    if (method === 'POST' && request.headers.origin === origin && url === previewPrefix + 'extensions') {
      try {
        const change = await readPacket(request);
        if (change.op === 'accept-automatic-memory' || change.op === 'set-automatic-memory' &&
            !projects.some(({ workspaceId }) => workspaceId === change.projectId)) throw new Error('invalid_preview_change');
        if (change.op === 'save-server') {
          const local = await previewLocal;
          const knownLocal = local?.status().profiles.some(({ targetId }) => targetId === change.server?.targetId);
          if (Boolean(change.server?.local) !== Boolean(knownLocal) || (knownLocal && access.mode !== 'execute'))
            throw new Error('invalid_preview_change');
        }
        if (['set-memory-extraction-model', 'set-scoped-personal-memory'].includes(change.op)) {
          const local = await previewLocal;
          const knownLocal = local?.status().profiles.some(({ targetId }) => targetId === change.targetId);
          if (change.op === 'set-scoped-personal-memory' && !knownLocal) throw new Error('invalid_preview_change');
          if (change.op === 'set-memory-extraction-model') return json(response,
            await (knownLocal ? local : chat).changeExtractionModel(change));
        }
        return json(response, await data.changeExtensions(change));
      } catch { return json(response, { ok: false, code: 'invalid_preview_change' }, 400); }
    }
    if (method === 'POST' && request.headers.origin === origin && url === previewPrefix + 'workflow-run') {
      try {
        const packet = await readPacket(request);
        if (packet.op !== 'save-workflow-run') throw new Error('invalid_preview_workflow');
        const snapshot = readWorkflowRun(packet.value);
        if (![2, 3, 4].includes(snapshot?.version)) throw new Error('invalid_preview_workflow');
        const approved = packet.approval ? readWorkflows(JSON.stringify([packet.approval]))[0] : null;
        if (approved && snapshot.workflowId !== approved.id) throw new Error('invalid_preview_workflow');
        if (packet.location !== undefined && packet.location !== 'local-sdk') throw new Error('invalid_preview_workflow');
        const runs = packet.location === 'local-sdk' ? localWorkflowRuns : workflowRuns;
        const approvals = packet.location === 'local-sdk' ? localWorkflowApprovals : workflowApprovals;
        approvals.set(snapshot.id, approved);
        runs.delete(snapshot.id);
        runs.set(snapshot.id, snapshot);
        if (runs.size > 16) {
          const oldest = runs.keys().next().value;
          runs.delete(oldest);
          approvals.delete(oldest);
        }
        return json(response, { ok: true });
      } catch { return json(response, { ok: false, code: 'invalid_preview_workflow' }, 400); }
    }
    if (method === 'POST' && request.headers.origin === origin && url === previewPrefix + 'local-search') {
      try { return json(response, await search(await readPacket(request))); }
      catch { return json(response, { ok: false, message: '搜索请求无效。' }, 400); }
    }
    if (method === 'POST' && request.headers.origin === origin && url === previewPrefix + 'mixed-workflow') {
      try {
        const packet = await readPacket(request);
        if (packet.op === 'save-definitions') {
          readWorkflows(packet.value);
          await data.setPreference(workflowKey, packet.value);
          return json(response, { ok: true });
        }
        return json(response, await requestMixedWorkflow(mixed, packet));
      } catch { return json(response, { ok: false, code: 'invalid_preview_workflow' }, 400); }
    }
    if (method === 'POST' && request.headers.origin === origin && url === previewPrefix + 'workflow-attachments') {
      try {
        const packet = await readPacket(request);
        if (packet.op !== 'save-workflow-attachments') throw new Error('invalid_preview_attachments');
        const items = decodeWorkflowAttachments(packet.files);
        const refs = items.map(({ bytes, ...ref }) => { attachments.set(ref.digest, bytes); return ref; });
        return json(response, refs);
      } catch { return json(response, { ok: false, code: 'invalid_preview_attachments' }, 400); }
    }
    if (method === 'POST' && request.headers.origin === origin && url === previewPrefix + 'projects') {
      try {
        const packet = await readPacket(request);
        if (packet.op === 'set-memberships') {
          if (typeof packet.targetId !== 'string' || !/^[a-f0-9]{64}$/.test(packet.targetId) ||
              (packet.value !== null && typeof packet.value !== 'string')) throw new Error('invalid_preview_projects');
          parseProjectMemberships(packet.value);
          const key = membershipKey(packet.targetId);
          if (packet.value === null) delete fixtures.preferences[key];
          else fixtures.preferences[key] = packet.value;
          return json(response, { ok: true });
        }
        if (packet.op !== 'set-projects' || !Array.isArray(packet.projects) || packet.projects.length > 100 ||
            packet.projects.some(({ workspaceId, title }) => typeof workspaceId !== 'string' || workspaceId.length > 100 ||
              typeof title !== 'string' || !title.trim() || title.length > 100)) throw new Error('invalid_preview_projects');
        projects = packet.projects;
        return json(response, { ok: true });
      } catch { return json(response, { ok: false, code: 'invalid_preview_projects' }, 400); }
    }
    if (method === 'POST' && (url === chatPrefix + 'rpc' || url === terminalPrefix + 'rpc')) {
      const isChat = url === chatPrefix + 'rpc';
      const tokenHeader = isChat ? 'x-dsh-vps-chat-token' : 'x-rtw-token';
      if (request.headers[tokenHeader] !== token) return json(response, { ok: false, code: 'preview_token_required' }, 403);
      try {
        const packet = await readPacket(request);
        if (!(isChat ? permitsChat : permitsTerminal)(access, packet.op)) return json(response, accessDenied, 403);
        if (isChat && packet.op === 'configuration') {
          const saved = packet.settings ? undefined : data.preference(setupConnectionKey);
          return json(response, saved === undefined ? fixtures.chat(packet) :
            await readSetupPreset(saved, (settings) => fixtures.chat({ op: 'configuration', settings })));
        }
        if (isChat && packet.op === 'preset' && data.preference(setupConnectionKey)) {
          return json(response, await readSetupPreset(data.preference(setupConnectionKey), (settings) => chat.request({ op: 'list', settings })));
        }
        if (isChat && packet.op === 'setup-trial') {
          return json(response, await runSetupTrial(packet, { request: fixtures.chat }, () => !closed && permitsChat(access, packet.op)));
        }
        if (isChat && packet.op === 'workflow-artifacts') {
          return json(response, await readWorkflowArtifacts(packet, {
            readRun: () => workflowRuns.get(packet.workflowRunId), backend: { request: previewArtifacts },
          }));
        }
        return json(response, isChat ? await chat.request(packet, {
          isLive: () => !closed && !request.aborted && !response.destroyed,
        }) : fixtures.terminal(packet));
      } catch {
        return json(response, { ok: false, code: 'invalid_preview_request', message: '预览暂时无法处理此请求。' }, 400);
      }
    }
    return json(response, { ok: false, code: 'preview_route_unavailable' }, 404);
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  authority = `127.0.0.1:${server.address().port}`;
  origin = `http://${authority}`;

  async function close() {
    await mixed.dispose();
    if (closed) return;
    closed = true;
    componentInstall?.abort();
    chat.dispose();
    await (await previewLocal?.catch(() => null))?.close();
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    for (const client of clients) client.end();
    await new Promise((done) => { server.close(done); server.closeAllConnections(); });
  }

  try {
    if (localAgents) {
      const local = await localSdk();
      for (const { backend, models: [model] } of local.status().providers) {
        const saved = await local.request({ op: 'register', backend, name: `${localBackends[backend].label} 本机演示`,
          model: model.id, effort: model.defaultEffort });
        if (!saved.ok) throw new Error(`无法登记 ${localBackends[backend].label} 演示配置。`);
      }
      const selected = local.status().profiles.find(({ backend }) => backend === 'claude-sdk');
      fixtures.preferences['dsh-vps-chat:desktop-view-location:v1'] = 'local-sdk';
      fixtures.preferences['dsh-vps-chat:desktop-new-location:v1'] = 'local-sdk';
      fixtures.preferences['dsh-vps-chat:local-view-profile:v1'] = selected.id;
      fixtures.preferences['dsh-vps-chat:local-new-profile:v1'] = selected.id;
    }
    if (watch) {
      for (const directory of webSourceDirectories) {
        const watcher = watchDirectory(directory, { recursive: true }, (_event, name) => {
          if (!name || /(?:\.(?:[cm]?js|css|html|png)|package\.json)$/i.test(name)) refresh();
        });
        watcher.on('error', (error) => log('预览文件监听已停止：' + error.message));
        watchers.push(watcher);
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { origin, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const preview = await startPreview({ localAgents: process.argv.includes('--local-agents'),
    localComponents: process.argv.includes('--local-components'), log: console.log });
  console.log(`VPS 工作台 · 界面预览 ${preview.origin}/`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void preview.close(); });
}
