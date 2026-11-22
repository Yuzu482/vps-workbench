import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { extractHtmlFences } from '../../remote-workbench/vps-chat/client/design-preview.js';
import { modelParameterFields, validModelParameters } from '../../remote-workbench/vps-chat/client/model-parameters.js';
import { validDesignContext, validWorkflowArtifactQuery } from '../../remote-workbench/vps-chat/host/index.js';
import { createProjectMemoryBridge } from '../desktop/project-memory.mjs';
import { canonicalLocalDirectory } from '../desktop/codex-runtime.mjs';
import { readWorkflowArtifacts } from '../desktop/workflow-artifacts.mjs';
import { changedWorkflowFileAccess, changedWorkflowStage, prepareWorkflowStage } from '../desktop/workflow-stage.mjs';
import { conversationIsolated, extensionPreferenceKey, extensionsForTurn, readExtensions } from '../extensions/state.mjs';
import { readLegacyWorkflowRun } from '../workflow-engine/runner.mjs';
import { exactFields, localWorkflowRunKey, maxWorkflowAttachmentBytes, readWorkflows, workflowKey, workflowUuid } from '../workflow-engine/state.mjs';
import { localBackends, usesLocalControls } from './providers.mjs';

export const localMemoryJournalKey = 'dsh-vps-chat:local-memory-journal:v1';
const location = 'local-sdk';
const digest = /^[a-f0-9]{64}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const bad = { ok: false, code: 'invalid_request', message: '本机 SDK 请求无效。' };
const denied = { ok: false, code: 'workbench_browse_only', message: '工作台处于仅浏览模式。' };
const missing = { ok: false, code: 'target_changed', message: '请选择原来的本机配置。' };
const toolUnavailable = { ok: false, code: 'workflow_modules_unavailable', message: '请核对本机配置中可用的工具。' };
const conflicted = { ok: false, code: 'turn_conflict', message: '此轮已绑定另一条回执。' };
const states = { completed: 'complete', queued: 'pending' };
const actions = {
  list: [], models: ['targetId'], 'model-options': ['targetId'],
  get: ['targetId', 'sessionId'], refresh: ['targetId', 'sessionId'], stop: ['targetId', 'sessionId', 'turnId'],
  'design-history': ['targetId', 'sessionId'],
  send: ['targetId', 'sessionId', 'turnId', 'prompt'],
  steer: ['targetId', 'sessionId', 'turnId', 'steerId', 'prompt'],
  approval: ['targetId', 'sessionId', 'turnId', 'approvalId', 'decision'],
  'workflow-artifacts': ['targetId', 'sessionId', 'turnId', 'workflowRunId'],
};
const optional = {
  list: ['targetId'], refresh: ['turnId'], 'design-history': ['turnId'], 'workflow-artifacts': ['after', 'path', 'offset'],
  send: ['mode', 'model', 'effort', 'advanced', 'designBase', 'designContext', 'extensions', 'projectMemory', 'workflowStage'],
};

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry)).digest('hex');
}

function validRequest(body, backend) {
  if (typeof body?.op !== 'string' || !Object.hasOwn(actions, body.op)) return false;
  const required = ['op', 'settings', ...actions[body.op]];
  if (!exactFields(body, ...required, ...(optional[body.op] ?? []).filter((key) => Object.hasOwn(body, key))) ||
      !exactFields(body.settings, 'location', 'provider', 'profileId') ||
      body.settings.location !== location || body.settings.provider !== backend || !workflowUuid(body.settings.profileId) ||
      ('targetId' in body && (typeof body.targetId !== 'string' || !digest.test(body.targetId))) ||
      ['sessionId', 'turnId', 'workflowRunId', 'steerId', 'approvalId'].some((key) => key in body && !workflowUuid(body[key]))) return false;
  if (body.op === 'steer') return usesLocalControls(backend) && typeof body.prompt === 'string' && body.prompt.trim() &&
    !body.prompt.includes('\0') && body.prompt.length <= 1200;
  if (body.op === 'approval') return usesLocalControls(backend) && ['allow', 'deny'].includes(body.decision);
  if (body.op === 'workflow-artifacts') return validWorkflowArtifactQuery(body);
  if (body.op !== 'send') return true;
  return typeof body.prompt === 'string' && body.prompt.trim() && !body.prompt.includes('\0') && body.prompt.length <= 8192 &&
    (body.mode === undefined || body.mode === 'design') &&
    (body.designContext === undefined || (body.mode === 'design' && validDesignContext(body.designContext))) &&
    (body.designBase === undefined || (body.mode === 'design' && exactFields(body.designBase, 'parentTurnId', 'fork') &&
      workflowUuid(body.designBase.parentTurnId) && typeof body.designBase.fork === 'boolean')) &&
    (body.model === undefined || (typeof body.model === 'string' && body.model.length <= 100)) &&
    (body.effort === undefined || (typeof body.effort === 'string' && body.effort.length <= 24 && body.model !== undefined)) &&
    (body.advanced === undefined || backend === 'codex' && validModelParameters(backend, body.advanced)) &&
    (body.projectMemory === undefined || (exactFields(body.projectMemory, 'projectId') &&
      (body.projectMemory.projectId === null || (typeof body.projectMemory.projectId === 'string' &&
        body.projectMemory.projectId.trim() && body.projectMemory.projectId.length <= 256 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(body.projectMemory.projectId))))) &&
    (body.workflowStage === undefined || (exactFields(body.workflowStage, 'runId') && workflowUuid(body.workflowStage.runId)));
}

function raster(data, format) {
  const bytes = Buffer.from(data, 'base64');
  if (format === 'png' && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ||
      format === 'jpeg' && bytes.subarray(0, 3).toString('hex') === 'ffd8ff' ||
      format === 'webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { type: 'raster', format, bytes };
  }
  return null;
}

function inlineAttachments(attachments) {
  return attachments.flatMap(({ name, data }) => {
    const format = /[.](png|jpe?g|webp)$/i.exec(name)?.[1].toLowerCase().replace(/^jpg$/, 'jpeg');
    if (format) {
      const image = raster(data, format);
      if (image) return [{ type: 'text', text: '附件（参考资料） ' + name }, image];
    }
    try {
      const text = utf8.decode(Buffer.from(data, 'base64'));
      if (!text.includes('\0')) return [{ type: 'text', text: JSON.stringify({ attachment: name, evidence: text }) }];
    } catch { /* Unsupported binary or encoding. */ }
    return [{ type: 'text', text: '无法读取的附件 ' + name }];
  });
}

async function approvedFiles(directory, paths, attachments) {
  if (!paths.length) return attachments;
  const root = await canonicalLocalDirectory(directory);
  const key = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
  const parent = key(root.endsWith(sep) ? root : root + sep);
  const entries = [...attachments];
  let remaining = maxWorkflowAttachmentBytes - entries.reduce((total, file) => total + Buffer.from(file.data, 'base64').length, 0);
  for (const name of paths) {
    const segments = name.split('/');
    if (segments.some((part) => /[<>:"|?*]|[. ]$|^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[.]|$)/iu.test(part))) {
      throw new Error('invalid_local_path');
    }
    const file = resolve(join(root, ...segments));
    if (!key(file).startsWith(parent)) throw new Error('invalid_local_path');
    const canonical = await realpath(file);
    const expected = await lstat(file);
    if (key(file) !== key(canonical) || !expected.isFile() || expected.size > remaining) throw new Error('file_changed');
    const handle = await open(file, 'r');
    try {
      const matches = (stat) => stat.isFile() && stat.ino === expected.ino && stat.dev === expected.dev &&
        stat.size === expected.size && stat.mtimeMs === expected.mtimeMs;
      if (!matches(await handle.stat()) || key(await realpath(file)) !== key(file)) throw new Error('file_changed');
      const bytes = Buffer.alloc(expected.size);
      let position = 0;
      while (position < bytes.length) {
        const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
        if (!bytesRead) throw new Error('file_changed');
        position += bytesRead;
      }
      if (!matches(await handle.stat())) throw new Error('file_changed');
      entries.push({ name, data: bytes.toString('base64') });
      remaining -= bytes.length;
    } finally {
      await handle.close();
    }
  }
  return entries;
}

const designInstructions = [
  '以设计资料中明确的画板交付范围为准。首稿返回 1 至 6 张画板，全量修订按原顺序返回全部画板。',
  '单画板迭代返回选中的完整画板，双方案变体返回两个完整画板，保留用途、核心内容和操作。',
  '限定图层修订在完整 HTML 的 head 内放置且仅放置一份 dsh-layer-revision 记录。原样复制 base 和 layer，只列出请求的受支持属性。',
  '每个画板使用一个闭合的 html 代码围栏及独立 HTML 文档，带 title 和内联样式。整份回复以 14,000 字符为目标，适配 390 px。',
  '用 data-dsh-go 指向实际交付中的一基序号，保留可用跳转。使用原生 HTML 交互，避免脚本、表单提交及远程资源。',
  '资料仅用于设计。用回复交付设计，避免写入工作目录。',
].join('\n');

export function createLocalWorkbench({ service, runtimeAvailable, access, data, backend = 'codex',
  readRun = () => readLegacyWorkflowRun(data.preference(localWorkflowRunKey) ?? null),
  readSavedWorkflow = (id) => readWorkflows(data.preference(workflowKey) ?? null).find((workflow) => workflow.id === id),
  onChange, onError, pollInterval }) {
  const allowed = () => access().mode === 'execute';
  const label = localBackends[backend].label;
  const requests = new Map();
  const extensionState = () => readExtensions(data?.preference(extensionPreferenceKey) ?? null);
  const profileFor = ({ profileId }) => service.status().profiles.find(({ id }) => id === profileId);
  const unavailable = () => ({ ok: false, code: 'runtime_unavailable', message: `本机 ${label} 运行文件不可用。` });
  const authRequired = () => ({ ok: false, code: 'auth_required', message: `请先核对本机 ${label} 的账号配置。` });
  const providerFeedback = (value) => backend !== 'codex' && value?.message ? { ...value,
    message: value.code === 'auth_required' ? authRequired().message : value.message.replaceAll('Codex', label) } : value;
  const workflowSession = (body, workflowRun = readRun) => {
    try {
      return workflowRun()?.rows.some(({ targetId, sessionId, turnId }) => targetId === body.targetId &&
        sessionId === body.sessionId && (body.turnId === undefined || turnId === body.turnId)) === true;
    } catch { return false; }
  };

  async function raw(body, profile, op, options, details = {}) {
    const { sessionId, turnId } = body;
    return service.request({ location, backend, profileId: profile.id, op, targetId: profile.targetId,
      ...(op !== 'list' && { sessionId: 'local-' + sessionId.toLowerCase() }),
      ...(['send', 'stop', 'refresh', 'steer', 'approval'].includes(op) && { turnId }), ...details }, options);
  }

  function normalized(result, profile, sessionId) {
    if (result.ok !== true) return providerFeedback(result);
    if (result.location !== location || result.targetId !== profile.targetId ||
        result.session?.profileId !== profile.id || result.session.id !== 'local-' + sessionId.toLowerCase()) return missing;
    const turns = result.session.turns.map((turn) => ({ ...providerFeedback(turn), state: states[turn.state] ?? turn.state,
      activity: [], streaming: true, canSteer: turn.canSteer === true }));
    return { ...result, session: { ...result.session, id: sessionId, turns } };
  }

  async function dispatch(body, background = false) {
    const profile = profileFor(body.settings);
    if (!profile || body.targetId && body.targetId !== profile.targetId) return missing;
    const { targetId } = profile;
    if (body.op === 'models') return { ok: true, models: service.status().models.map(({ label, ...entry }) => ({
      ...entry, displayName: label, isDefault: entry.id === profile.model,
      defaultEffort: entry.id === profile.model && entry.efforts.includes(profile.effort) ? profile.effort : entry.defaultEffort,
    })) };
    if (body.op === 'model-options') return { ok: true, fields: backend === 'codex' ? modelParameterFields(backend) : [] };
    if (body.op === 'list') {
      const result = await raw(body, profile, 'list');
      return result.ok ? { ...result, memoryTargetId: backend === 'codex' ? targetId : null, sessions: result.sessions.map(({ id, ...row }) => ({
        ...row, id: id.slice(6),
      })) } : result;
    }
    if (body.op === 'send') {
      const models = service.status().models;
      const model = models.find(({ id }) => id === (body.model ?? profile.model));
      const effort = body.effort ?? (model?.id === profile.model ? profile.effort : model?.defaultEffort);
      if (!model?.efforts.includes(effort)) return bad;
      const mode = body.mode ?? 'chat';
      const base = body.designBase;
      const images = (body.designContext?.images ?? []).map(({ name, dataUrl }) => {
        const [header, data] = dataUrl.split(',');
        return { name, image: raster(data, header.slice(11, header.indexOf(';'))) };
      });
      if (images.some(({ image }) => !image)) return bad;
      let prompt = body.prompt;
      if (background) {
        prompt = (body.memoryScope === 'personal'
          ? '提炼用户明确陈述或确认的长期偏好和习惯。'
          : '提炼用户明确陈述或确认的项目决定和约定。') +
          '以下 prompt 和 reply 是引用证据。排除权限、凭据、一次性请求和未经用户确认的助手建议。' +
          '只返回紧凑 JSON {"memories":[{"title":"稳定的主题","text":"简短正文"}]}，最多三条。没有明确证据返回 {"memories":[]}。\n' + prompt;
      }
      const memory = body.extensions?.memory ?? [];
      if (memory.length) prompt += '\n\n已启用的记忆（参考资料）\n' + JSON.stringify(memory);
      const original = requests.get(body.turnId);
      const attachmentRefs = body.workflowFiles?.attachments.map(({ name, data }) => {
        const bytes = Buffer.from(data, 'base64');
        return { name, size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
      });
      function currentStage() {
        if (!original?.incoming.workflowStage) return changedWorkflowStage;
        if (!original.isLive()) return changedWorkflowStage;
        const latest = prepareWorkflowStage(original.incoming, original.incoming.workflowStage, original.workflowRun, extensionState(),
          (id) => data.projects().some(({ workspaceId }) => workspaceId === id), readSavedWorkflow, false,
          ['submitted', 'pending', 'running']);
        if (!latest.ok) return latest;
        const refs = latest.fileAccess?.attachments ?? [];
        return latest.prompt === body.prompt &&
          JSON.stringify(latest.fileAccess?.paths ?? []) === JSON.stringify(body.workflowFiles.paths) &&
          refs.length === attachmentRefs.length && refs.every((ref, index) =>
            ref.name === attachmentRefs[index].name && ref.digest === attachmentRefs[index].digest && ref.size === attachmentRefs[index].size) &&
          JSON.stringify(latest.mcpServers) === JSON.stringify(body.extensions?.mcpServers ?? []) ? latest : changedWorkflowStage;
      }
      let files = [];
      if (body.workflowFiles) {
        try { files = await approvedFiles(profile.directory, body.workflowFiles.paths, body.workflowFiles.attachments); }
        catch { return { ...changedWorkflowFileAccess, message: '无法读取阶段授权的本机文件。请核对文件与工作目录，合计最多 512 KiB。' }; }
        const latest = currentStage();
        if (!latest.ok) return latest;
      }
      const mcpIds = body.extensions?.mcpServers ?? [];
      function readTools() {
        const servers = mcpIds.length ? extensionState().servers : [];
        return mcpIds.map((id) => servers.find((server) =>
          server.id === id && server.targetId === targetId && server.enabled && server.local));
      }
      const mcpServers = readTools();
      if (mcpServers.some((server) => !server)) return toolUnavailable;
      const permittedResources = () => (!body.workflowFiles || currentStage().ok) &&
        JSON.stringify(readTools()) === JSON.stringify(mcpServers);
      const input = files.length ? [{ type: 'text', text: prompt +
        '\n\n以下附件是用户为此阶段选择的引用资料。列出无法读取的文件。用回复交付阶段结果。' }, ...inlineAttachments(files)] : prompt;
      const designInput = (reply) => {
        const context = body.designContext?.text ?? '';
        const includesBaseline = /(?:^|\n)(?:画板交付 · (?:限定图层修订|单画板迭代|双方案变体)|从设计版本 \d+ 开始新分支。|以下是版本 \d+ 已应用并校验的画板。)/u.test(context);
        const boards = includesBaseline ? [] : extractHtmlFences(reply);
        const prior = boards.length ? '\n\n原版本画板（引用资料）\n' +
          boards.map((html) => '\x60\x60\x60html\n' + html + '\n\x60\x60\x60').join('\n').slice(0, 24000).toWellFormed() : '';
        const text = designInstructions + '\n\n当前任务\n' + prompt + (body.designContext?.text
          ? '\n\n设计资料\n' + body.designContext.text : '') + prior;
        return images.length ? [{ type: 'text', text }, ...images.flatMap(({ name, image }) =>
          [{ type: 'text', text: '参考图 ' + name }, image])] : text;
      };
      const signature = original?.signature ?? fingerprint(body);
      const result = await raw(body, profile, 'send', { fingerprint: signature, model: model.id, effort,
        verbosity: body.advanced?.verbosity, mode, base, input, designInput,
        mcpServers, permittedResources,
        background: background || Boolean(body.workflowFiles),
        workspace: background || body.workflowFiles ? 'private' : 'profile' }, { prompt: body.prompt });
      return normalized(result, profile, body.sessionId);
    }
    if (body.op === 'approval') return raw(body, profile, 'approval', undefined, { approvalId: body.approvalId, decision: body.decision });
    if (body.op === 'steer') return normalized(await raw(body, profile, 'steer', undefined,
      { steerId: body.steerId, prompt: body.prompt }), profile, body.sessionId);
    const op = ['stop', 'refresh'].includes(body.op) && body.turnId ? body.op : 'get';
    const result = normalized(await raw(body, profile, op, { background: background || workflowSession(body) }), profile, body.sessionId);
    if (body.op === 'get' && body.turnId) {
      if (result.ok || result.code === 'session_not_found') return { ok: true, memoryTargetId: targetId,
        existingTurn: result.session?.turns.some(({ id }) => id === body.turnId) ?? false, memoryIsolation: false };
    }
    if (!result.ok) return result;
    const turns = result.session.turns;
    if (body.op === 'stop') {
      const turn = turns.find(({ id }) => id === body.turnId);
      if (turn.state === 'unknown') return { ok: false, code: 'stop_unconfirmed', message: '请查询原轮次的停止结果。' };
      return { ok: true, outcome: turn.state === 'stopping' ? 'requested' : 'settled' };
    }
    if (body.op === 'design-history') {
      if (result.session.mode !== 'design') return bad;
      if (body.turnId) {
        const turn = turns.find(({ id, state }) => id === body.turnId && state === 'complete');
        return turn ? { ok: true, turn } : bad;
      }
      const head = turns.findLast(({ state }) => state === 'complete');
      return { ok: true, history: turns.map(({ id, prompt, reply, parentTurnId, fork, ordinal, state }) => ({
        id, title: prompt.trim().replace(/\s+/g, ' ').slice(0, 54), parentTurnId, fork, ordinal, state,
        hasBoards: state === 'complete' && extractHtmlFences(reply).length > 0, canContinue: head?.id === id,
      })) };
    }
    return result;
  }

  async function artifact(request, workflowRun = readRun) {
    const packet = await dispatch({ ...request, op: 'get', turnId: undefined }, workflowSession(request, workflowRun));
    const reply = packet.session?.turns.find(({ id }) => id === request.turnId)?.reply;
    if (!reply) return { ok: true, files: [], truncated: false };
    const path = '阶段结果.md';
    const bytes = Buffer.from(reply);
    if (!request.path) return { ok: true, files: request.after >= path ? [] : [{ path, size: bytes.length }], truncated: false };
    if (request.path !== path || request.offset >= bytes.length) return bad;
    return { ok: true, file: { path, size: bytes.length, data: bytes.subarray(request.offset ?? 0).toString('base64'),
      ...(request.offset !== undefined && { offset: request.offset, revision: createHash('sha256').update(bytes).digest('hex') }) } };
  }

  const memory = backend === 'codex' && data && createProjectMemoryBridge({ data, access: () => ({ ...access(), workspace: 'default' }),
    readRun, readSavedWorkflow, onChange, onError, pollInterval,
    locationName: '本机', journalKey: localMemoryJournalKey, scopedPersonal: true,
    backend: { request: (body) => dispatch(body) }, extractor: { request: (body) => dispatch(body, true) },
    prepareStage(...args) {
      return prepareWorkflowStage(...args, false);
    },
  });

  return {
    async request(body, { workflowRun = readRun, isLive = () => true } = {}) {
      if (!validRequest(body, backend)) return bad;
      if (body.op === 'workflow-artifacts') return readWorkflowArtifacts(body,
        { readRun: workflowRun, backend: { request: (packet) => artifact(packet, workflowRun) }, isAllowed: isLive });
      if (['send', 'stop', 'steer', 'approval'].includes(body.op) && !allowed()) return denied;
      if (body.op !== 'send') {
        if (workflowRun !== readRun) return dispatch(body, workflowSession(body, workflowRun));
        return memory && !['steer', 'approval'].includes(body.op) ? memory.request(body) : dispatch(body);
      }
      if (!(typeof runtimeAvailable === 'function' ? runtimeAvailable() : runtimeAvailable)) return unavailable();
      const profile = profileFor(body.settings);
      if (!profile || profile.targetId !== body.targetId) return missing;
      if (!service.credentialConfigured(profile)) return authRequired();
      const signature = fingerprint(body);
      const existing = requests.get(body.turnId);
      if (existing) return existing.signature === signature ? existing.result : conflicted;
      const { extensions: _ignored, ...incoming } = body;
      if (incoming.workflowStage && !memory) return bad;
      if (!incoming.workflowStage && memory) {
        const state = extensionState();
        const projectId = incoming.projectMemory?.projectId ?? '';
        const isolated = conversationIsolated(state, body);
        const configured = extensionsForTurn(state, { targetId: body.targetId, projectId, isolated });
        if (configured) incoming.extensions = configured;
      }
      const result = Promise.resolve().then(() => memory ? memory.request(incoming, { workflowRun, isLive }) : dispatch(incoming));
      requests.set(body.turnId, { signature, result, incoming, workflowRun, isLive });
      try { return await result; }
      finally { requests.delete(body.turnId); }
    },
    async changeExtractionModel(change) {
      const profile = service.status().profiles.find(({ targetId }) => targetId === change?.targetId);
      if (!profile || !memory || !allowed()) throw new Error('memory_extraction_target_unavailable');
      await memory.request({ op: 'list', settings: { location, provider: backend, profileId: profile.id }, targetId: profile.targetId });
      return memory.changeExtractionModel(change);
    },
    dispose: () => memory && memory.dispose(),
  };
}
