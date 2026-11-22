import { mixedStagePrompt, validateMixedInput, validateMixedTask } from './mixed-context.mjs';
import { validateWorkflowDraft, workflowText } from './state.mjs';

export function simulateMixedWorkflow(record, input) {
  const workflow = validateWorkflowDraft({ name: record.name, stages: record.stages, edges: record.edges });
  const task = workflowText(input.task, 4000, '运行任务');
  validateMixedTask(workflow, task);
  const { revision, criteria, constraints, evidence, transfers } = input;
  const mixed = validateMixedInput(workflow, { revision, criteria, constraints, evidence, transfers,
    definitionPin: '0'.repeat(64), routePins: workflow.stages.map(() => '0'.repeat(64)) });
  const rows = workflow.stages.map((stage, index) => {
    const label = `模拟阶段 ${index + 1}`;
    const conclusion = label + ' 的结论。';
    return { reply: transfers.some(({ from, fields }) => from === stage.id && fields.length > 0)
      ? JSON.stringify({ conclusion, evidence: label + ' 的证据。', pending: label + ' 的待处理事项。' }) : conclusion };
  });
  const run = { workflow, task, mixed, rows };
  return { run, prompts: workflow.stages.map((_stage, index) => mixedStagePrompt(run, index, undefined, '',
    workflow.stages[index].execution.location === 'ssh-vps')) };
}
