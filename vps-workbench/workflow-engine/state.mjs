export const workflowKey = 'dsh-vps-chat:workflows:v1';
export const workflowRunKey = 'dsh-vps-chat:workflow-run:v1';
export const workflowEditPrefix = '根据用户要求提出一份工作流草案。';

export const workflowProviders = Object.freeze({
  codex: Object.freeze({ label: 'Codex', models: true, mcp: true }),
  claude: Object.freeze({ label: 'Claude API', models: true }),
  'claude-sdk': Object.freeze({ label: 'Claude 订阅 SDK', models: true }),
  antigravity: Object.freeze({ label: 'Antigravity', models: true, mcp: true }),
});

const modelId = /^[A-Za-z0-9_.:-]{1,100}$/;
const stageId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const moduleId = /^[a-z][a-z0-9_-]{0,31}$/;
const targetId = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const invalidIdentifierText = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u;
const utf8 = new TextEncoder();
const maxWorkflows = 24;
// Covers all saved stages with full Agent snapshots and escaped text.
const maxWorkflowStoreLength = 4 * 1024 * 1024;
export const maxStageMcpServers = 8;
export const maxStagePlugins = 4;
export const maxWorkflowFilePaths = 16;
export const maxWorkflowAttachments = 8;
export const maxWorkflowAttachmentBytes = 512 * 1024;

export function workflowUuid(value) {
  return typeof value === 'string' && uuid.test(value);
}

export function exactFields(value, ...keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function workflowText(value, limit, label, multiline = true) {
  if (typeof value !== 'string' || controls.test(value) || /[\uD800-\uDFFF]/u.test(value) ||
      (!multiline && /[\r\n\t]/u.test(value))) {
    throw new Error(`${label}包含无效字符。`);
  }
  const clean = value.trim();
  if (!clean || clean.length > limit) throw new Error(`${label}须为 1 至 ${limit} 个字符。`);
  return clean;
}

export function validateWorkflowProjectId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 256 || invalidIdentifierText.test(value) ||
      utf8.encode(value).length > 256) throw new Error('工作流项目 ID 无效。');
  return value;
}

export function validWorkflowFileName(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' &&
    !/[\\/\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value) && utf8.encode(value).length <= 255;
}

export function validateWorkflowFileAccess(value) {
  if (!exactFields(value, 'targetId', 'paths', 'attachments') || typeof value.targetId !== 'string' ||
      !targetId.test(value.targetId) || !Array.isArray(value.paths) || value.paths.length > maxWorkflowFilePaths ||
      !Array.isArray(value.attachments) || value.attachments.length > maxWorkflowAttachments) {
    throw new Error('阶段文件授权格式无效。');
  }
  const paths = Array.from(value.paths, (path) => {
    if (typeof path !== 'string' || utf8.encode(path).length > 512 || !path.split('/').every(validWorkflowFileName)) {
      throw new Error('每项授权须为相对于 VPS 项目目录的单个文件路径。');
    }
    return path;
  });
  const names = new Set();
  let bytes = 0;
  const attachments = Array.from(value.attachments, (item) => {
    if (!exactFields(item, 'digest', 'name', 'size') || typeof item.digest !== 'string' || !targetId.test(item.digest) ||
        !validWorkflowFileName(item.name) || !Number.isSafeInteger(item.size) || item.size <= 0 || names.has(item.name)) {
      throw new Error('阶段附件引用或文件名无效。');
    }
    names.add(item.name);
    bytes += item.size;
    if (bytes > maxWorkflowAttachmentBytes) throw new Error('每阶段本地附件总计最多 512 KiB。');
    return { digest: item.digest, name: item.name, size: item.size };
  });
  if (new Set(paths).size !== paths.length) throw new Error('阶段文件路径不能重复。');
  return { targetId: value.targetId, paths, attachments };
}

function manifestText(value, maxLength, maxBytes) {
  return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0 &&
    !invalidIdentifierText.test(value) && utf8.encode(value).length <= maxBytes;
}

export function validateStageAgent(value, provider) {
  if (!exactFields(value, 'mcpServers', 'plugins', 'memory') ||
      !Array.isArray(value.mcpServers) || value.mcpServers.length > maxStageMcpServers ||
      !Array.isArray(value.plugins) || value.plugins.length > maxStagePlugins ||
      (value.memory !== 'shared' && value.memory !== 'isolated')) throw new Error('步骤 Agent 模块配置无效。');
  if (value.mcpServers.length && !workflowProviders[provider]?.mcp) {
    throw new Error('配置了 MCP 服务器的步骤须使用 Codex 或 Antigravity。');
  }
  const serverIds = new Set();
  let serverTarget = null;
  const mcpServers = Array.from(value.mcpServers, (server) => {
    if (!exactFields(server, 'id', 'targetId') || typeof server.id !== 'string' || !moduleId.test(server.id) ||
        typeof server.targetId !== 'string' || !targetId.test(server.targetId) || serverIds.has(server.id) ||
        (serverTarget !== null && server.targetId !== serverTarget)) throw new Error('步骤 MCP 服务器无效、重复或不属于同一连接。');
    serverIds.add(server.id);
    serverTarget = server.targetId;
    return { id: server.id, targetId: server.targetId };
  });
  const pluginRefs = new Set();
  const plugins = Array.from(value.plugins, (plugin) => {
    if (!exactFields(plugin, 'id', 'version', 'title') || typeof plugin.id !== 'string' || !moduleId.test(plugin.id) ||
        !manifestText(plugin.version, 40, 160) || !manifestText(plugin.title, 80, 320)) throw new Error('步骤插件引用无效。');
    const { id, version, title } = plugin;
    const ref = JSON.stringify([id, version, title]);
    if (pluginRefs.has(ref)) throw new Error('步骤插件引用重复。');
    pluginRefs.add(ref);
    return { id, version, title };
  });
  return { mcpServers, plugins, memory: value.memory };
}

function validateStageAgentPreset(value, label) {
  if (!exactFields(value, 'id', 'name') || !workflowUuid(value.id)) throw new Error(`${label}的 Agent 预设无效。`);
  return { id: value.id.toLowerCase(), name: workflowText(value.name, 64, `${label}的 Agent 预设名称`, false) };
}

export function linearWorkflowEdges(stages) {
  return stages.slice(1).map((stage, i) => ({ from: stages[i].id, to: stage.id }));
}

export function validateWorkflowEdges(stages, edges) {
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 8) throw new Error('工作流须包含 1 至 8 个步骤。');
  const children = new Map();
  for (const stage of stages) {
    if (typeof stage?.id !== 'string' || !stageId.test(stage.id) || children.has(stage.id)) {
      throw new Error('步骤 ID 无效或重复。');
    }
    children.set(stage.id, new Set());
  }
  if (!Array.isArray(edges) || edges.length > 64) throw new Error('工作流连线无效。');
  const result = Array.from(edges, (edge) => {
    if (!exactFields(edge, 'from', 'to') || !children.has(edge.from) || !children.has(edge.to) ||
        edge.from === edge.to || children.get(edge.from).has(edge.to)) throw new Error('工作流连线端点无效或连线重复。');
    children.get(edge.from).add(edge.to);
    return { from: edge.from, to: edge.to };
  });
  const visiting = new Set();
  const finished = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('工作流连线不能形成循环。');
    if (finished.has(id)) return;
    visiting.add(id);
    for (const child of children.get(id)) visit(child);
    visiting.delete(id);
    finished.add(id);
  }
  for (const id of children.keys()) visit(id);
  return result;
}

function validateDraft(value, allowAgentMetadata) {
  const legacy = exactFields(value, 'name', 'stages');
  if ((!legacy && !exactFields(value, 'name', 'stages', 'edges')) || !Array.isArray(value.stages) ||
      value.stages.length < 1 || value.stages.length > 8) throw new Error('工作流须包含名称和 1 至 8 个步骤。');
  const name = workflowText(value.name, 80, '工作流名称', false);
  const stages = Array.from(value.stages, (stage, index) => {
    const label = `第 ${index + 1} 步`;
    const fields = ['name', 'provider', 'model', 'instruction'];
    if (!legacy) fields.push('id');
    const hasAgent = allowAgentMetadata && Object.hasOwn(stage ?? {}, 'agent');
    const hasAgentPreset = allowAgentMetadata && Object.hasOwn(stage ?? {}, 'agentPreset');
    const hasFileAccess = allowAgentMetadata && Object.hasOwn(stage ?? {}, 'fileAccess');
    if (hasAgent) fields.push('agent');
    if (hasAgentPreset) fields.push('agentPreset');
    if (hasFileAccess) fields.push('fileAccess');
    if (!exactFields(stage, ...fields) || typeof stage.provider !== 'string' ||
        !Object.hasOwn(workflowProviders, stage.provider)) throw new Error(`${label}的字段或服务商无效。`);
    const { provider, model } = stage;
    if (typeof model !== 'string' || (model !== '' && (!workflowProviders[provider].models || !modelId.test(model)))) {
      throw new Error(`${label}的模型无效。`);
    }
    const normalized = { id: legacy ? `s${index + 1}` : stage.id, name: workflowText(stage.name, 64, `${label}名称`, false), provider, model,
      instruction: workflowText(stage.instruction, 1200, `${label}指令`) };
    if (hasAgent) normalized.agent = validateStageAgent(stage.agent, provider);
    if (hasAgentPreset) normalized.agentPreset = validateStageAgentPreset(stage.agentPreset, label);
    if (hasFileAccess) {
      const fileAccess = validateWorkflowFileAccess(stage.fileAccess);
      if (fileAccess.paths.length || fileAccess.attachments.length) normalized.fileAccess = fileAccess;
    }
    return normalized;
  });
  return { name, stages, edges: validateWorkflowEdges(stages, legacy ? linearWorkflowEdges(stages) : value.edges) };
}

export function validateWorkflowDraft(value) {
  return validateDraft(value, true);
}

const validRevision = (revision) => Number.isSafeInteger(revision) && revision >= 1;

function validatedWorkflows(value) {
  if (!Array.isArray(value) || value.length > maxWorkflows) throw new Error('保存的工作流列表无效。');
  const ids = new Set();
  return Array.from(value, (record) => {
    if (!(exactFields(record, 'id', 'revision', 'name', 'stages') || exactFields(record, 'id', 'revision', 'name', 'stages', 'edges')) ||
        !workflowUuid(record.id) || !validRevision(record.revision)) throw new Error('保存的工作流记录无效。');
    const { id: originalId, revision, ...draft } = record;
    const id = originalId.toLowerCase();
    if (ids.has(id)) throw new Error('保存的工作流编号重复。');
    ids.add(id);
    return { id, revision, ...validateWorkflowDraft(draft) };
  });
}

export function readWorkflows(raw) {
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > maxWorkflowStoreLength) throw new Error('无法读取保存的工作流列表。');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('无法读取保存的工作流列表。'); }
  return validatedWorkflows(value);
}

export function applyWorkflowChange(records, change) {
  const entries = validatedWorkflows(records);
  const saving = change?.op === 'save';
  if (!(saving ? exactFields(change, 'op', 'id', 'revision', 'draft') :
    change?.op === 'delete' && exactFields(change, 'op', 'id', 'revision')) || !workflowUuid(change.id) ||
    !(validRevision(change.revision) || (saving && change.revision === null))) throw new Error('工作流变更格式无效。');
  const id = change.id.toLowerCase();
  const index = entries.findIndex((entry) => entry.id === id);
  if (saving && change.revision === null) {
    if (index !== -1) throw new Error('此工作流编号已存在。');
    if (entries.length >= maxWorkflows) throw new Error('最多可保存 24 个工作流。');
    return [...entries, { id, revision: 1, ...validateWorkflowDraft(change.draft) }];
  }
  if (index === -1 || entries[index].revision !== change.revision) throw new Error('工作流已变更，请重新加载后再操作。');
  if (!saving) return entries.filter((entry) => entry.id !== id);
  if (!validRevision(change.revision + 1)) throw new Error('工作流版本已达到上限。');
  entries[index] = { id, revision: change.revision + 1, ...validateWorkflowDraft(change.draft) };
  return entries;
}

export function createWorkflowEditPrompt(request, draft = null) {
  const goal = workflowText(request, 2000, '工作流编辑要求');
  const prompt = [
    `${workflowEditPrefix}只返回一个以三个反引号和 vps-workflow 开始、以三个反引号结束的代码块。`,
    '代码块正文须为 JSON，且只能包含以下字段，须有 1 至 8 个步骤。',
    '{"name":"工作流名称","stages":[{"id":"s1","name":"步骤名称","provider":"codex","model":"","instruction":"步骤指令"}],"edges":[]}',
    '每步的 id 唯一，以英文字母或数字开头，可含字母、数字、下划线或短横线，最多 40 个字符。用 {"from":"s1","to":"s2"} 表示 s2 等待 s1。可并行、分支和汇合，禁止循环或重复连线。',
    'provider 只允许 codex、claude、claude-sdk、antigravity。“model”填空字符串时使用该执行端的默认模型。只有用户明确指定时才填写模型 ID。',
    '编辑现有草案时，保留现有步骤 ID 和用户未要求修改的连线、名称、步骤顺序、服务商、模型和指令。',
    '不要添加密钥、连接信息、命令或额外字段。草案仅供用户审阅。',
    '用户要求',
    goal,
  ].join('\n');
  if (draft === null) return prompt;
  const metadata = validateWorkflowDraft(draft);
  metadata.stages = metadata.stages.map(({ agent, agentPreset, fileAccess, ...stage }) => stage);
  const reference = `${prompt}\n\n当前草案，作为参考\n${JSON.stringify(metadata)}`;
  if (reference.length > 8192) throw new Error('编辑请求超出聊天长度上限。请缩短本轮要求，或在编辑器中拆分或调整工作流。');
  return reference;
}

export function readWorkflowProposal(reply, { requireStageIds = false } = {}) {
  if (typeof reply !== 'string') return null;
  const fenceLines = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  let fence = null;
  let source = null;
  for (const line of reply.matchAll(fenceLines)) {
    const marker = line[1];
    const info = line[2].trim();
    if (fence) {
      if (marker[0] !== fence.marker[0] || marker.length < fence.marker.length || info) continue;
      if (fence.proposal) {
        if (marker.length !== 3 || line.index - fence.start > 8192) throw new Error('工作流草案代码块格式无效或过长。');
        source = reply.slice(fence.start, line.index);
      }
      fence = null;
      continue;
    }
    const proposal = /^vps-workflow(?:\s|$)/u.test(info);
    if (proposal && source !== null) throw new Error('回复须只包含一个工作流草案代码块。');
    if (proposal && (marker !== '```' || info !== 'vps-workflow')) throw new Error('工作流草案代码块格式无效。');
    fence = { marker, proposal, start: line.index + line[0].length };
  }
  if (fence?.proposal) throw new Error('工作流草案代码块不完整。');
  if (source === null) return null;
  let value;
  try { value = JSON.parse(source); } catch { throw new Error('工作流草案须使用有效的 JSON。'); }
  if (requireStageIds && exactFields(value, 'name', 'stages')) {
    throw new Error('当前工作流含有本机 Agent 设置。请让模型在草案中提供工作流连线，并为保留的步骤使用原有 ID。');
  }
  return validateDraft(value, false);
}

export function preserveWorkflowAgents(previousWorkflow, proposedDraft) {
  const draft = validateDraft(proposedDraft, false);
  if (previousWorkflow === null) return draft;
  const { name, stages, edges } = previousWorkflow;
  const previous = validateWorkflowDraft({ name, stages, ...(Object.hasOwn(previousWorkflow, 'edges') ? { edges } : {}) });
  const previousById = new Map(previous.stages.map((stage) => [stage.id, stage]));
  for (const stage of draft.stages) {
    const { agent, agentPreset, fileAccess, provider } = previousById.get(stage.id) ?? {};
    if (agent?.mcpServers.length && stage.provider !== provider) {
      throw new Error(`步骤「${stage.name}」已配置 MCP 服务器。请保留 ${workflowProviders[provider].label}，或先在编辑器中移除该步骤的 MCP 服务器。`);
    }
    if (agent) stage.agent = agent;
    if (agentPreset) stage.agentPreset = agentPreset;
    if (fileAccess) stage.fileAccess = fileAccess;
  }
  return draft;
}
