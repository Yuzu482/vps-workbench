export const executionLocations = Object.freeze({ 'local-sdk': '本机 SDK', 'ssh-vps': 'VPS SSH' });
export const executionContexts = Object.freeze({ independent: '独立上下文', blind: '盲审' });
const transferFields = Object.freeze({ conclusion: '结论', evidence: '证据', pending: '待处理事项' });

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
  return edges.flatMap(({ from, to }) => {
    const source = byId.get(from);
    const destination = byId.get(to);
    const blind = destination.execution?.context === 'blind';
    const cross = source.execution && destination.execution &&
      (source.execution.location !== destination.execution.location || source.execution.configId !== destination.execution.configId);
    return blind || cross ? [{ key: JSON.stringify([from, to]), source, destination, blind }] : [];
  });
}

function routeLabel(stage, targets) {
  const location = stage.execution?.location;
  return location ? `${executionLocations[location]} · ${targetForStage(stage, targets)?.label ?? '配置不可用'}` : '待设置';
}

export function createMixedRunBrief(React, { button, field, note, actions, providerLabel, defaultModel }) {
  const h = React.createElement;

  return function MixedRunBrief({ workflow, targets, disabled, startReason, onStart }) {
    const [task, setTask] = React.useState('');
    const [criteria, setCriteria] = React.useState('');
    const [constraints, setConstraints] = React.useState('');
    const [evidenceText, setEvidenceText] = React.useState(() => new Map());
    const [approvals, setApprovals] = React.useState({});
    const blindStages = workflow.stages.filter(({ execution }) => execution?.context === 'blind');
    const edges = runEdges(workflow);
    const requiredApprovals = edges.filter(({ blind }) => !blind);
    const canLaunch = !disabled && !startReason && task.trim() && criteria.trim() &&
      blindStages.every(({ id }) => evidenceText.get(id)?.trim()) &&
      requiredApprovals.every(({ key }) => approvals[key]?.confirmed);

    async function startRun() {
      if (!canLaunch) return;
      const result = await onStart({ workflowId: workflow.id, revision: workflow.revision, task: task.trim(), criteria: criteria.trim(),
        constraints: constraints.trim(), evidence: blindStages.map(({ id }) => ({
          id: `evidence-${id}`, stageId: id, text: evidenceText.get(id).trim(),
        })), transfers: requiredApprovals.map(({ key, source, destination }) => ({
          from: source.id, to: destination.id, fields: approvals[key].fields,
        })) });
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
            note(stage.execution ? [label, providerLabel(stage.provider), stage.model || defaultModel(stage.provider),
              executionContexts[stage.execution.context]].join(' · ') : label));
        })),
      blindStages.length > 0 && h('section', { className: 'vc-workflow-mixed-section', 'aria-label': '盲审证据' },
        h('h4', null, '盲审证据'),
        note('每个盲审阶段只接收运行简报、自己的阶段指令和在此填写的证据。'),
        blindStages.map((stage) => h(React.Fragment, { key: stage.id }, textField(`「${stageName(stage)}」的证据`,
          evidenceText.get(stage.id) ?? '', (text) => setEvidenceText((previous) => new Map(previous).set(stage.id, text)), 1500, true)))),
      edges.length > 0 && h('section', { className: 'vc-workflow-mixed-section', 'aria-label': '阶段间传递' },
        h('h4', null, '阶段间传递'),
        requiredApprovals.length > 0 && note('逐条确认传递范围。未选字段的连线仅等待上游完成。'),
        edges.map(({ key, source, destination, blind }) => {
          const approval = approvals[key];
          const edgeStage = (stage) => `第 ${workflow.stages.indexOf(stage) + 1} 阶段 · ${stageName(stage)}`;
          const name = `${edgeStage(source)} → ${edgeStage(destination)}`;
          return h('fieldset', { key, className: 'vc-workflow-files' },
            h('legend', null, name),
            note(`${routeLabel(source, targets)} → ${routeLabel(destination, targets)}`),
            blind ? note('盲审连线仅等待上游完成。') : h(React.Fragment, null,
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
      actions(button('开始运行', startRun, { primary: true, disabled: !canLaunch })),
      startReason && note(startReason));
  };
}
