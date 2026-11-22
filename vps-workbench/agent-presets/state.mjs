import { exactFields, validateStageAgent, validateWorkflowDraft, workflowText, workflowUuid } from '../workflow-engine/state.mjs';

export const legacyAgentPresetKey = 'dsh-vps-chat:agent-presets:v1';
export const agentPresetKey = 'dsh-vps-chat:agent-presets:v2';
export const maxAgentPresets = 24;

const moduleDefinitions = {
  executor: { required: true, fields: ['provider', 'model'] },
  persona: { required: true, fields: ['instruction'] },
  output: { required: false, fields: ['instruction'] },
  mcp: { required: false, fields: ['servers'] },
  plugins: { required: false, fields: ['templates'] },
  memory: { required: false, fields: ['mode'] },
};
const moduleIds = Object.keys(moduleDefinitions);
const validRevision = (revision) => Number.isSafeInteger(revision) && revision >= 1;

function validatePresetStage(draft, instructionLabel = '预设指令') {
  try {
    const { stages: [{ name, provider, model, instruction }] } = validateWorkflowDraft({
      name: 'Agent 预设', stages: [draft],
    });
    return { name, provider, model, instruction };
  } catch (error) {
    throw new Error(error.message.replace(/^第 1 步指令/u, instructionLabel).replace(/^第 1 步/u, '预设'));
  }
}

function composeAgentPreset({ name, modules }) {
  if (!Array.isArray(modules) || modules.length > moduleIds.length ||
      Reflect.ownKeys(modules).length !== modules.length + 1) throw new Error('预设模块列表无效。');

  const configs = new Map();
  for (const descriptor of modules) {
    if (!exactFields(descriptor, 'id', 'config') || typeof descriptor.id !== 'string' ||
        !Object.hasOwn(moduleDefinitions, descriptor.id)) throw new Error('预设模块描述无效。');
    const { id, config } = descriptor;
    if (configs.has(id)) throw new Error(`预设模块重复（${id}）。`);
    if (!exactFields(config, ...moduleDefinitions[id].fields)) throw new Error(`预设模块配置无效（${id}）。`);
    configs.set(id, config);
  }
  for (const id of moduleIds) {
    if (moduleDefinitions[id].required && !configs.has(id)) throw new Error(`预设缺少必需模块（${id}）。`);
  }

  const executor = configs.get('executor');
  const baseStage = validatePresetStage({
    name, provider: executor.provider, model: executor.model, instruction: configs.get('persona').instruction,
  }, '角色指令');
  const { provider, model, instruction } = baseStage;
  configs.set('executor', { provider, model });
  configs.set('persona', { instruction });
  const output = configs.has('output') ? workflowText(configs.get('output').instruction, 1200, '输出规范') : null;
  if (output !== null) configs.set('output', { instruction: output });

  const mcp = configs.get('mcp');
  const plugins = configs.get('plugins');
  const memory = configs.get('memory');
  if (mcp && (!Array.isArray(mcp.servers) || !mcp.servers.length)) throw new Error('MCP 服务列表无效。');
  if (plugins && (!Array.isArray(plugins.templates) || !plugins.templates.length)) throw new Error('提示词模板列表无效。');
  const agent = mcp || plugins || memory ? validateStageAgent({
    mcpServers: mcp ? mcp.servers : [],
    plugins: plugins ? plugins.templates : [],
    memory: memory ? memory.mode : 'isolated',
  }, provider) : null;
  if (mcp) configs.set('mcp', { servers: agent.mcpServers });
  if (plugins) configs.set('plugins', { templates: agent.plugins });
  if (memory) configs.set('memory', { mode: agent.memory });

  const stage = output === null ? baseStage : validatePresetStage({
    ...baseStage,
    instruction: `${instruction}\n\n输出规范\n${output}`,
  }, '角色指令与输出规范（含标题）的总长度');

  return {
    draft: { name: baseStage.name, modules: moduleIds.filter((id) => configs.has(id)).map((id) => ({ id, config: configs.get(id) })) },
    fields: { ...baseStage, output, agent },
    stage: agent ? { ...stage, agent } : stage,
  };
}

export function validateAgentPresetDraft(draft) {
  if (!exactFields(draft, 'name', 'modules')) throw new Error('预设字段无效。');
  return composeAgentPreset(draft).draft;
}

export function agentPresetFields(preset) {
  return composeAgentPreset(preset).fields;
}

export function resolveAgentPreset(preset) {
  return composeAgentPreset(preset).stage;
}

function validatedAgentPresets(value, legacy = false) {
  if (!Array.isArray(value) || value.length > maxAgentPresets) throw new Error('保存的预设列表无效。');
  const fields = legacy ? ['name', 'provider', 'model', 'instruction'] : ['name', 'modules'];
  const ids = new Set();
  return Array.from(value, (record) => {
    if (!exactFields(record, 'id', 'revision', ...fields) ||
        !workflowUuid(record.id) || !validRevision(record.revision)) throw new Error('保存的预设记录无效。');
    const { id: originalId, revision, ...draft } = record;
    const id = originalId.toLowerCase();
    if (ids.has(id)) throw new Error('保存的预设编号重复。');
    ids.add(id);
    if (legacy) {
      const { name, provider, model, instruction } = draft;
      return { id, revision, ...validateAgentPresetDraft({ name, modules: [
        { id: 'executor', config: { provider, model } },
        { id: 'persona', config: { instruction } },
      ] }) };
    }
    return { id, revision, ...validateAgentPresetDraft(draft) };
  });
}

export function readAgentPresets(rawV2, rawV1 = null) {
  const legacy = rawV2 === null;
  const raw = legacy ? rawV1 : rawV2;
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > 200_000) throw new Error('无法读取保存的预设列表。');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('无法读取保存的预设列表。'); }
  return validatedAgentPresets(value, legacy);
}

export function applyAgentPresetChange(records, change) {
  const entries = validatedAgentPresets(records);
  const saving = change?.op === 'save';
  if (!(saving ? exactFields(change, 'op', 'id', 'revision', 'draft') :
    change?.op === 'delete' && exactFields(change, 'op', 'id', 'revision')) || !workflowUuid(change.id) ||
    !(validRevision(change.revision) || (saving && change.revision === null))) throw new Error('预设变更格式无效。');

  const id = change.id.toLowerCase();
  const index = entries.findIndex((entry) => entry.id === id);
  if (saving && change.revision === null) {
    if (index !== -1) throw new Error('此预设编号已存在。');
    if (entries.length >= maxAgentPresets) throw new Error('最多可保存 24 个预设。');
    return [...entries, { id, revision: 1, ...validateAgentPresetDraft(change.draft) }];
  }
  if (index === -1 || entries[index].revision !== change.revision) throw new Error('预设已变更，请重新加载后再操作。');
  if (!saving) return entries.filter((entry) => entry.id !== id);
  if (!validRevision(change.revision + 1)) throw new Error('预设版本已达到上限。');
  entries[index] = { id, revision: change.revision + 1, ...validateAgentPresetDraft(change.draft) };
  return entries;
}
