import { isLocalClaudeOrAcpStage } from '../workflow-engine/state.mjs';
import { mixedHandoffValues, mixedIncoming, mixedTransferLabels as transferFields } from '../workflow-engine/mixed-context.mjs';
import { simulateMixedWorkflow } from '../workflow-engine/mixed-preview.mjs';

export const executionLocations = Object.freeze({ 'local-sdk': '本机 SDK', 'ssh-vps': 'VPS SSH' });
export const executionContexts = Object.freeze({ independent: '独立上下文', blind: '盲审' });

export function targetForStage(stage, targets) {
  const execution = stage?.execution;
  return execution && targets?.find(({ id, location }) => id === execution.configId && location === execution.location);
}

function stageName(stage) {
  return stage.name.trim() || '未命名阶段';
}

export function getMixedStartReason(workflow, targets) {
  for (const stage of workflow.stages) {
    if (!stage.execution) return `请选择阶段「${stageName(stage)}」的执行位置与配置。`;
    const target = targetForStage(stage, targets);
    if (!target) return `阶段「${stageName(stage)}」的执行配置已不可用，请重新选择。`;
    if (!target.providers?.includes(stage.provider)) return `请为阶段「${stageName(stage)}」选择此配置已启用的执行工具。`;
    if (stage.execution.context === 'blind' && (stage.agent || stage.fileAccess || stage.agentPreset)) {
      return `请先在阶段「${stageName(stage)}」清除盲审不使用的 Agent 资源和文件授权。`;
    }
  }
  return '';
}

function runEdges({ stages, edges }) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  return edges.map(({ from, to }) => {
    const source = byId.get(from);
    const destination = byId.get(to);
    const blind = destination.execution?.context === 'blind';
    const cross = source.execution && destination.execution &&
      (source.execution.location !== destination.execution.location || source.execution.configId !== destination.execution.configId);
    return { key: JSON.stringify([from, to]), source, destination, blind, needsApproval: !blind && cross };
  });
}

function routeLabel(stage, targets) {
  const location = stage.execution?.location;
  return location ? `${executionLocations[location]} · ${targetForStage(stage, targets)?.label ?? '配置不可用'}` : '待设置';
}

function stageTools(h, stage) {
  const grants = stage.agent?.mcpServers?.filter(({ tools }) => tools?.length) ?? [];
  return grants.length ? h('ul', { 'aria-label': '阶段 MCP 授权' }, grants.map(({ id, tools }) =>
    h('li', { key: id }, id + ' · ' + tools.join('、')))) : null;
}

function stageFiles(h, stage, note) {
  const { paths = [], attachments = [] } = stage.fileAccess ?? {};
  return paths.length || attachments.length ? h('ul', { 'aria-label': '只读授权文件' },
    paths.map((path) => h('li', { key: 'path:' + path }, path)),
    attachments.map(({ name, digest }) => h('li', { key: 'attachment:' + digest + name }, `附件 · ${name}`)))
    : note('此阶段没有显式授权文件。');
}

export function createMixedStageDetails(React, { note }) {
  const h = React.createElement;
  return function MixedStageDetails({ run, index, simulatedPrompt }) {
    const stage = run.workflow.stages[index];
    const row = run.rows[index];
    const evidence = run.mixed.evidence.find(({ stageId }) => stageId === stage.id);
    const links = mixedIncoming(run, index);
    const simulated = simulatedPrompt !== undefined;
    return h('details', { className: 'vc-workflow-stage-details vc-details-motion' },
      h('summary', null, `查看阶段详情 · ${stageName(stage)}`),
      h('div', { className: 'vc-workflow-stage-detail-body' },
        h('h4', null, '授权资料'),
        stageFiles(h, stage, note), stageTools(h, stage),
        evidence && h('div', null, h('strong', null, `盲审证据 · ${evidence.id}`),
          h('pre', { className: 'vc-workflow-text', tabIndex: 0 }, evidence.text)),
        h('h4', null, '上游交接'),
        !simulated && links.some(({ kind }) => kind === 'fields') && note('显示已校验的获准字段。模型输入可能按长度预算截断。'),
        links.length ? h('ul', { className: 'vc-workflow-list' }, links.map((edge) => {
          const { source, parent, kind, fields } = edge;
          const upstream = run.rows[parent];
          let values = [];
          let issue;
          if (!simulated && upstream.state === 'complete' && kind === 'fields') {
            try { values = mixedHandoffValues(edge, upstream.reply); }
            catch (error) { issue = error.message; }
          }
          const range = kind === 'wait' ? '仅等待完成' : kind === 'reply' ? '同配置回复' : fields.map((field) => transferFields[field]).join('、');
          return h('li', { key: source.id }, h('strong', null, stageName(source) + ' · ' + range),
            issue ? note(issue) : values.map(([field, value]) => note(transferFields[field] + ' · ' + (value || '空'))));
        })) : note('没有上游阶段。'),
        simulated ? h(React.Fragment, null,
          h('h4', null, '模拟模型输入'),
          h('pre', { className: 'vc-workflow-text', tabIndex: 0 }, simulatedPrompt))
          : h('dl', { className: 'vc-workflow-details' },
            h('dt', null, '会话 ID'), h('dd', null, h('code', null, row.sessionId)),
            h('dt', null, '轮次 ID'), h('dd', null, h('code', null, row.turnId)))));
  };
}

export function createMixedRunBrief(React, { button, field, note, actions, providerLabel, defaultModel }) {
  const h = React.createElement;
  const MixedStageDetails = createMixedStageDetails(React, { note });

  return function MixedRunBrief({ workflow, targets, disabled, startReason, onStart }) {
    const [task, setTask] = React.useState('');
    const [criteria, setCriteria] = React.useState('');
    const [constraints, setConstraints] = React.useState('');
    const [evidenceText, setEvidenceText] = React.useState(() => new Map());
    const [approvals, setApprovals] = React.useState({});
    const [simulation, setSimulation] = React.useState(null);
    const blindStages = workflow.stages.filter(({ execution }) => execution?.context === 'blind');
    const edges = runEdges(workflow);
    const requiredApprovals = edges.filter(({ needsApproval }) => needsApproval);
    const ready = task.trim() && criteria.trim() &&
      blindStages.every(({ id }) => evidenceText.get(id)?.trim()) &&
      requiredApprovals.every(({ key }) => approvals[key]?.confirmed);
    const canLaunch = !disabled && !startReason && ready;
    const canSimulate = !disabled && !getMixedStartReason(workflow, targets) && ready;

    function briefInput() {
      return { workflowId: workflow.id, revision: workflow.revision, task: task.trim(), criteria: criteria.trim(),
        constraints: constraints.trim(), evidence: blindStages.map(({ id }) => ({
          id: `evidence-${id}`, stageId: id, text: evidenceText.get(id)?.trim() ?? '',
        })), transfers: requiredApprovals.flatMap(({ key, source, destination }) => approvals[key]?.confirmed ? [{
          from: source.id, to: destination.id, fields: approvals[key].fields,
        }] : []) };
    }

    const currentInput = briefInput();
    const simulationKey = JSON.stringify([currentInput, canSimulate ? '' : 'unavailable']);
    const result = simulation?.key === simulationKey ? simulation : null;

    function simulate() {
      if (!canSimulate) return;
      try { setSimulation({ key: simulationKey, value: simulateMixedWorkflow(workflow, currentInput) }); }
      catch (error) { setSimulation({ key: simulationKey, error: error.message }); }
    }

    async function startRun() {
      if (!canLaunch) return;
      const result = await onStart(currentInput);
      if (result?.ok === true) setApprovals({});
    }

    function changeField(key, name, checked) {
      setApprovals((previous) => {
        const selected = new Set(previous[key]?.fields ?? []);
        if (checked) selected.add(name);
        else selected.delete(name);
        return { ...previous, [key]: { confirmed: false, fields: Object.keys(transferFields).filter((item) => selected.has(item)) } };
      });
    }

    const textField = (label, value, onChange, maxLength, required = false) => field(label,
      h('textarea', { value, onChange: (event) => onChange(event.target.value), maxLength, required }));

    return h('fieldset', { className: 'vc-workflow-card', disabled },
      h('legend', null, '运行简报'),
      note('运行任务、验收标准与约束会发送到列表中的每个执行配置。'),
      textField('运行任务', task, setTask, 4000, true),
      textField('验收标准', criteria, setCriteria, 500, true),
      textField('约束（可选）', constraints, setConstraints, 500),
      h('ul', { className: 'vc-workflow-list vc-workflow-mixed-routes', 'aria-label': '各阶段执行配置' },
        workflow.stages.map((stage, index) => {
          const label = routeLabel(stage, targets);
          return h('li', { key: stage.id },
            h('strong', null, `第 ${index + 1} 阶段 · ${stageName(stage)}`),
            note(stage.execution ? [label, providerLabel(stage.provider, stage.execution.location),
              isLocalClaudeOrAcpStage(stage) ? '账号默认模型 · 文本输出' : stage.model || defaultModel(stage.provider),
              executionContexts[stage.execution.context]].join(' · ') : label),
            stageFiles(h, stage, note), stageTools(h, stage));
        })),
      blindStages.length > 0 && h('section', { className: 'vc-workflow-mixed-section', 'aria-label': '盲审证据' },
        h('h4', null, '盲审证据'),
        note('每个盲审阶段只接收运行简报、自己的阶段指令和在此填写的证据。'),
        blindStages.map((stage) => h(React.Fragment, { key: stage.id }, textField(`「${stageName(stage)}」的证据`,
          evidenceText.get(stage.id) ?? '', (text) => setEvidenceText((previous) => new Map(previous).set(stage.id, text)), 1500, true)))),
      edges.length > 0 && h('section', { className: 'vc-workflow-mixed-section', 'aria-label': '阶段间传递' },
        h('h4', null, '阶段间传递'),
        requiredApprovals.length > 0 && note('逐条确认传递的文本字段。附件和工具由接收阶段单独授权。未选字段的连线仅等待上游完成。'),
        edges.map(({ key, source, destination, blind, needsApproval }) => {
          const approval = approvals[key];
          const edgeStage = (stage) => `第 ${workflow.stages.indexOf(stage) + 1} 阶段 · ${stageName(stage)}`;
          const name = `${edgeStage(source)} → ${edgeStage(destination)}`;
          return h('fieldset', { key, className: 'vc-workflow-files' },
            h('legend', null, name),
            note(`${routeLabel(source, targets)} → ${routeLabel(destination, targets)}`),
            blind ? note('盲审连线仅等待上游完成。') : !needsApproval ? note('接收同一配置的上游回复。') : h(React.Fragment, null,
              h('div', { className: 'vc-workflow-transfer-options' }, Object.entries(transferFields).map(([value, label]) =>
                h('label', { key: value }, h('input', { type: 'checkbox', checked: approval?.fields.includes(value) ?? false,
                  onChange: (event) => changeField(key, value, event.target.checked) }), label))),
              h('label', { className: 'vc-workflow-transfer-confirm' }, h('input', { type: 'checkbox',
                checked: approval?.confirmed ?? false,
                onChange: (event) => {
                  const confirmed = event.target.checked;
                  setApprovals((previous) => ({ ...previous, [key]: { fields: previous[key]?.fields ?? [], confirmed } }));
                } }), `确认${approval?.fields.length ? '传递所选字段' : '仅等待上游完成'}`)));
        })),
      actions(button('模拟运行', simulate, { disabled: !canSimulate }),
        button('开始运行', startRun, { primary: true, disabled: !canLaunch })),
      result?.error && note(result.error, 'alert'),
      result?.value && h('section', { className: 'vc-workflow-mixed-section', 'aria-label': '模拟运行结果' },
        h('h4', null, '模拟运行结果'),
        note('使用本地示例交接推演。文件只列授权清单，实际模型目录、模板内容和产物在正式运行时核对。'),
        result.value.run.workflow.stages.map(({ id }, index) => h(MixedStageDetails, { key: id, run: result.value.run,
          index, simulatedPrompt: result.value.prompts[index] }))),
      startReason && note(startReason));
  };
}
