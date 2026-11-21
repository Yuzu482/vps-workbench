import { exactFields, workflowProviders, workflowText, workflowUuid } from '../workflow-engine/state.mjs';
import { workflowStagePrompt } from '../workflow-engine/runner.mjs';

export const changedWorkflowStage = {
  ok: false, code: 'workflow_stage_changed', message: '工作流阶段或它的记忆项目已变更。请核对配置后重新运行。',
};
export const changedWorkflowFileAccess = {
  ok: false, code: 'workflow_file_access_changed', message: '阶段的文件授权已撤销、变更或绑定到其他 VPS。请核对后重新运行。',
};

function unavailable(message) {
  return { ok: false, code: 'workflow_modules_unavailable', message };
}

export function checkStageResources({ provider, agent }, targetId, state) {
  const mcpServers = [];
  const pluginBlocks = [];
  for (const reference of agent?.mcpServers ?? []) {
    const { id } = reference;
    if (!workflowProviders[provider]?.mcp || reference.targetId !== targetId ||
        !state.servers.some((server) => server.id === id && server.targetId === targetId && server.enabled)) {
      return unavailable(`MCP 服务器「${id}」在当前 VPS 上未启用。请检查该阶段的模块。`);
    }
    mcpServers.push(id);
  }
  for (const { id, version, title } of agent?.plugins ?? []) {
    const plugin = state.plugins.find((item) => item.enabled && item.id === id && item.version === version);
    const template = plugin?.prompts.find((item) => item.title === title);
    if (!template) return unavailable(`插件模板「${title}」已停用、删除或换版。请重新选择该模板。`);
    pluginBlocks.push(`插件「${plugin.name}」的模板「${title}」\n${template.text}`);
  }
  try {
    const pluginInstructions = pluginBlocks.length ? workflowText(pluginBlocks.join('\n\n'), 2200, '插件模板组合') : '';
    return { ok: true, mcpServers, pluginInstructions };
  } catch (error) { return unavailable(error.message); }
}

export function prepareWorkflowStage(body, reference, readRun, state, isProject, readSavedWorkflow = () => null) {
  if (body.op !== 'send' || !exactFields(reference, 'runId') || !workflowUuid(reference.runId) || body.mode ||
      body.extensions || body.advanced || body.effort) return changedWorkflowStage;
  let run;
  try { run = readRun(reference.runId.toLowerCase()); } catch { return changedWorkflowStage; }
  if (run?.id !== reference.runId.toLowerCase() || ![2, 3, 4].includes(run.version) || run.phase !== 'running' || run.stopRequested) {
    return changedWorkflowStage;
  }
  const index = run.rows.findIndex(({ targetId, sessionId, turnId, state }) =>
    state === 'submitted' && targetId === body.targetId && sessionId === body.sessionId && turnId === body.turnId);
  const stage = run.workflow.stages[index];
  const projectId = run.projectId ?? null;
  if (!stage || stage.provider !== body.settings?.provider || stage.model !== (body.model ?? '') ||
      (stage.agent?.memory === 'shared' && projectId !== null && !isProject(projectId))) return changedWorkflowStage;
  const fileAccess = stage.fileAccess ?? null;
  if (fileAccess) {
    let approved;
    try { approved = readSavedWorkflow(run.workflowId, run.id)?.stages.find(({ id, provider }) => id === stage.id && provider === stage.provider); }
    catch { return changedWorkflowFileAccess; }
    if (fileAccess.targetId !== body.targetId || JSON.stringify(approved?.fileAccess) !== JSON.stringify(fileAccess)) {
      return changedWorkflowFileAccess;
    }
  }

  const resources = checkStageResources(stage, body.targetId, state);
  if (!resources.ok) return resources;
  const { mcpServers, pluginInstructions } = resources;
  try {
    return { ok: true, projectId, memory: stage.agent?.memory ?? 'isolated', mcpServers, fileAccess,
      prompt: workflowStagePrompt(run, index, pluginInstructions, true) };
  } catch {
    return unavailable('此阶段的任务和插件模板组合过长。请缩短任务或减少模板。');
  }
}
