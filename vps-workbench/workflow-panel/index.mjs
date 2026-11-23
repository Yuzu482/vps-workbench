import { localBackends, isLocalBackend } from '../local-sdk/providers.mjs';
import { afterPopupMotion } from '../../remote-workbench/vps-chat/client/menu-motion.js';
import { createAgentModulesEditor } from '../agent-presets/settings.mjs';
import { resolveAgentPreset } from '../agent-presets/state.mjs';
import { createRunArtifacts } from './run-artifacts.mjs';
import { createStageFileAccessEditor } from './file-access.mjs';
import { createMixedRunBrief, createMixedStageDetails, executionContexts, executionLocations, getMixedStartReason, targetForStage } from './mixed.mjs';
import { linearWorkflowEdges, validateWorkflowDraft, validateWorkflowEdges, workflowProviders, isLocalClaudeOrAcpStage } from '../workflow-engine/state.mjs';
import { createStageGraph } from './stage-graph.mjs';
import { workflowPanelStyles } from './styles.mjs';

const phases = { running: '运行中', paused: '已暂停', complete: '已完成', failed: '失败', stopped: '已停止' };
const rowStates = {
  waiting: '等待开始', submitted: '正在确认提交', pending: '等待回复', running: '运行中',
  canceling: '等待停止', stopping: '正在停止', unknown: '待核查', complete: '已完成', failed: '失败', stopped: '已停止',
  skipped: '已跳过',
};
const artifactRowStates = new Set(['complete', 'failed', 'stopped']);
const defaultModel = (provider) => provider === 'antigravity' ? 'VPS CLI 默认模型' : '默认模型';
const providerLabel = (provider, location) => (location === 'local-sdk' ? localBackends[provider]?.label : null) ??
  workflowProviders[provider]?.label ?? provider;
const blankStage = (id) => ({ id, name: '', provider: 'codex', model: '', instruction: '' });
const blankDraft = () => ({ name: '', stages: [blankStage('s1')], edges: [] });
const asDraft = ({ name, stages, edges }) => ({ name, stages, edges });
const messageOf = (error, fallback) => error instanceof Error && error.message ? error.message : fallback;
const personalMemoryLabel = '个人记忆（未归类）';
const emptyProjects = new Map();
const usesExplicitExecution = (workflow) => workflow?.stages.some(({ execution }) => Boolean(execution));

function modelCatalogKey(stage) {
  return stage.execution ? JSON.stringify([stage.execution.location, stage.execution.configId, stage.provider]) : stage.provider;
}

function withAgent(stage, agent) {
  const next = { ...stage };
  if (agent) next.agent = agent;
  else delete next.agent;
  return next;
}

function usesSharedMemory(workflow) {
  return workflow?.stages.some(({ agent }) => agent?.memory === 'shared');
}

function agentSummary({ mcpServers, plugins, memory }) {
  return `${mcpServers.length} 个 MCP 服务 · ${plugins.length} 个提示模板 · ${memory === 'shared' ? '共享记忆' : '独立记忆'}`;
}

function agentMemoryLabel(agent) {
  if (agent?.memory === 'shared') return '共享记忆';
  return agent?.memory === 'isolated' ? '独立上下文' : '默认不共享';
}

function pluginTemplateLabel({ id, version, title }, moduleCatalog) {
  const plugin = moduleCatalog?.plugins?.find((item) => item.enabled && item.id === id && item.version === version &&
    item.prompts.some((prompt) => prompt.title === title));
  return `${plugin?.name || id} · ${title}`;
}

function isLinear({ stages, edges }) {
  const chain = linearWorkflowEdges(stages);
  return chain.length === edges.length && chain.every(({ from, to }) =>
    edges.some((edge) => edge.from === from && edge.to === to));
}

function stageDependencies(stages, edges, id) {
  return stages.flatMap((stage, index) => edges.some(({ from, to }) => from === stage.id && to === id)
    ? [{ id: stage.id, number: index + 1, name: stage.name.trim() || '未命名阶段' }] : []);
}

export function createWorkflowPanel(React, { icon } = {}) {
  const h = React.createElement;
  const StageGraph = createStageGraph(React, { defaultModel, providerLabel, agentMemoryLabel, pluginTemplateLabel });
  const AgentModulesEditor = createAgentModulesEditor(React);
  const StageFileAccessEditor = createStageFileAccessEditor(React);
  const button = (label, onClick, { primary, ...props } = {}) =>
    h('button', { type: 'button', className: primary ? 'vc-button vc-primary' : 'vc-button', onClick, ...props }, label);
  const field = (label, input) => h('label', { className: 'vc-workflow-field' }, h('span', null, label), input);
  const note = (text, role) => h('p', { className: 'vc-workflow-note', role }, text);
  const alert = (message) => message && h('p', { className: 'vc-workflow-error', role: 'alert' }, message);
  const actions = (...children) => h('div', { className: 'vc-workflow-actions' }, ...children);
  const RunArtifacts = createRunArtifacts(React, { button, note, alert });
  const MixedRunBrief = createMixedRunBrief(React, { button, field, note, actions, providerLabel, defaultModel });
  const MixedStageDetails = createMixedStageDetails(React, { note });

  function PresetGallery({ stage, choices, moduleCatalog, onApply, onManage }) {
    const galleryId = React.useId();
    const stageAgent = JSON.stringify(stage.agent ?? null);
    const matches = choices.filter(({ provider, model, instruction, agent }) =>
      provider === stage.provider && model === stage.model && instruction === stage.instruction &&
      JSON.stringify(agent ?? null) === stageAgent);
    const selectedId = matches.find(({ id }) => id === stage.agentPreset?.id)?.id ?? matches[0]?.id;

    const chips = (label, items) => items.length > 0 && h('span', { className: 'vc-workflow-preset-chips' },
      h('span', { className: 'vc-workflow-preset-chip-label' }, label), items);

    return h('div', { className: 'vc-workflow-presets', role: 'group', 'aria-labelledby': galleryId },
      h('div', { className: 'vc-workflow-title-row' },
        h('h4', { id: galleryId }, '套用 Agent 预设'), onManage && button('管理预设', onManage)),
      choices.length ? h('div', { className: 'vc-workflow-preset-grid' }, choices.map((preset) => {
        const { id, name, provider, model, agent } = preset;
        const detailsId = `${galleryId}-${id}`;
        const servers = (agent?.mcpServers ?? []).map(({ id: serverId }) =>
          h('span', { key: serverId }, serverId));
        const templates = (agent?.plugins ?? []).map((template) => {
          const { id: pluginId, version, title } = template;
          return h('span', { key: JSON.stringify([pluginId, version, title]), title: `${pluginId} ${version} · ${title}` },
            pluginTemplateLabel(template, moduleCatalog));
        });
        const selected = id === selectedId;
        return h('button', { key: id, type: 'button', className: 'vc-workflow-preset-card', 'data-preset-id': id,
          'aria-label': name, 'aria-describedby': detailsId, 'aria-pressed': selected, onClick: () => onApply(preset),
        }, h('span', { className: 'vc-workflow-preset-name' }, h('strong', null, name),
          selected && h('span', { className: 'vc-workflow-preset-selected', 'aria-hidden': true }, '✓')),
        h('span', { id: detailsId, className: 'vc-workflow-preset-details' },
          h('span', { className: 'vc-workflow-preset-provider' }, icon &&
            h('span', { className: 'vc-workflow-preset-icon', 'aria-hidden': true },
              icon(h, provider === 'claude' ? 'claude-sdk' : provider)), h('span', null, providerLabel(provider))),
          h('span', null, model || defaultModel(provider)),
          h('span', { className: 'vc-workflow-preset-memory', 'data-memory': agent?.memory }, agentMemoryLabel(agent)),
          chips('MCP', servers), chips('提示词模板', templates)));
      })) : note(onManage ? '还没有预设。可在「管理预设」中新建。' : '还没有可套用的预设。'));
  }

  function StageEditor({ stage, index, count, dependencies, available, catalog, load, presetChoices, onManageAgentPresets,
    moduleCatalog, onChange, onMove, onDelete, onDisconnect, disabled, fileEditor, mixed }) {
    const number = index + 1;
    const { execution } = stage;
    const locationTargets = mixed?.targets?.filter(({ location }) => location === execution?.location) ?? [];
    const target = targetForStage(stage, locationTargets);
    const allowed = execution ? target?.providers ?? [] : available;
    const local = execution?.location === 'local-sdk';
    const attachmentsOnly = isLocalClaudeOrAcpStage(stage);
    const providers = local ? (target ? [...new Set([...allowed, stage.provider])] : Object.keys(localBackends)) : Object.keys(workflowProviders);
    const connected = allowed.includes(stage.provider) && (!execution || mixed?.canExecute !== false);
    const blind = execution?.context === 'blind';
    const matchingScope = execution?.location === 'local-sdk' ? fileEditor.localSdk && target?.targetId && target.targetId === fileEditor.catalogScope
      : !fileEditor.localSdk && target?.id === moduleCatalog?.codexTargetId;
    const canEditGrants = !blind && !attachmentsOnly && Boolean(!execution || (target && matchingScope));
    const canEditFiles = canEditGrants || (!blind && attachmentsOnly && Boolean(target?.targetId));
    const showOldFiles = stage.fileAccess && !canEditFiles;
    const models = catalog?.models ?? [];
    const supportsModels = !attachmentsOnly && workflowProviders[stage.provider]?.models;
    const savedModel = stage.model && !models.some(({ id }) => id === stage.model);
    const missingCatalogModel = savedModel && catalog?.status === 'ready';
    const setValue = (key) => (event) => onChange({ ...stage, [key]: event.target.value });

    function applyPreset({ id, name, provider, model, instruction, agent }) {
      onChange(withAgent({ ...stage, name: stage.name.trim() ? stage.name : name, provider, model, instruction,
        agentPreset: { id, name } }, agent && structuredClone(agent)));
    }

    function changeLocation(location) {
      if (!location) {
        const next = { ...stage };
        delete next.execution;
        onChange(next);
        return;
      }
      const provider = location === 'local-sdk' && !isLocalBackend(stage.provider) ? 'codex' : stage.provider;
      onChange({ ...stage, provider, model: '', execution: { location, configId: '', context: execution?.context ?? 'independent' } });
    }

    function clearAgent() {
      const next = withAgent(stage, null);
      delete next.agentPreset;
      onChange(next);
    }

    const agentEditor = canEditGrants && h(AgentModulesEditor, { key: stage.id, agent: stage.agent ?? null,
      provider: stage.provider, moduleCatalog, disabled,
      onChange: (agent) => onChange(withAgent(stage, execution && agent ? { ...agent, memory: 'isolated' } : agent)) });

    return h('fieldset', { className: 'vc-workflow-card vc-workflow-inspector', disabled },
      h('legend', null, `第 ${number} 阶段`),
      !execution && h(PresetGallery, { stage, choices: presetChoices, moduleCatalog, onApply: applyPreset, onManage: onManageAgentPresets }),
      mixed && h('div', { className: 'vc-workflow-fields' },
        field('执行位置', h('select', { value: execution?.location ?? '', onChange: (event) => changeLocation(event.target.value) },
          h('option', { value: '' }, '沿用当前工作区'),
          Object.entries(executionLocations).map(([value, label]) => h('option', { key: value, value }, label)))),
        execution && field('执行配置', h('select', { value: execution.configId, required: true,
          onChange: (event) => {
            const configId = event.target.value;
            const selected = locationTargets.find(({ id }) => id === configId);
            const provider = local ? selected?.providers[0] ?? stage.provider : stage.provider;
            onChange({ ...stage, provider, model: '', execution: { ...execution, configId } });
          } },
          h('option', { value: '', disabled: true }, locationTargets.length ? '选择已登记的配置' : '没有已登记的配置'),
          execution.configId && !target && h('option', { value: execution.configId, disabled: true }, '原配置不可用'),
          locationTargets.map(({ id, label }) => h('option', { key: id, value: id }, label)))),
        execution && field('阶段上下文', h('select', { value: execution.context,
          onChange: (event) => onChange({ ...stage, execution: { ...execution, context: event.target.value } }) },
          Object.entries(executionContexts).map(([value, label]) => h('option', { key: value, value }, label))))),
      execution && note(blind ? '盲审接收运行简报、当前阶段指令和启动时指定的证据。' : '此阶段使用独立会话和独立记忆。'),
      h('div', { className: 'vc-workflow-fields' },
        field('阶段名称', h('input', { value: stage.name, onChange: setValue('name'), required: true, maxLength: 64 })),
        field('执行工具', h('select', { value: stage.provider, onChange: (event) =>
          onChange({ ...stage, provider: event.target.value, model: '' }) },
        providers.map((provider) => h('option', { key: provider, value: provider },
          providerLabel(provider, execution?.location) + (allowed.includes(provider) ? '' : '（未启用）')))))),
      supportsModels ? h('div', { className: 'vc-workflow-model' },
        field('模型', h('select', { value: stage.model, onChange: setValue('model') },
          h('option', { value: '' }, defaultModel(stage.provider)),
          savedModel && h('option', { value: stage.model, disabled: true },
            `${stage.model}${missingCatalogModel ? '（目录中不可用）' : '（已保存）'}`),
          models.map(({ id, displayName }) =>
            h('option', { key: id, value: id }, displayName && displayName !== id ? `${displayName} · ${id}` : id)))),
        button(catalog?.status === 'ready' ? '刷新模型' : '读取模型', () => load(stage), {
          'aria-label': `读取第 ${number} 阶段的模型目录`,
          disabled: !connected || catalog?.status === 'loading',
        })) : note(attachmentsOnly ? '使用账号默认模型和独立会话。只读取单独授权给本阶段的附件。' : defaultModel(stage.provider)),
      execution && mixed?.canExecute === false ? note('仅浏览模式下无法读取模型目录或运行阶段。')
        : !connected && note(execution && !target ? '请选择此阶段的已登记执行配置。' : '执行工具尚未启用。可以保存工作流，启用后可运行。'),
      catalog?.status === 'loading' && note('正在读取模型目录…', 'status'),
      catalog?.status === 'error' && alert(`模型目录读取失败：${catalog.error}`),
      missingCatalogModel && note('已保存的模型当前不可用。运行前请选择可用模型。'),
      field('角色与指令', h('textarea', { value: stage.instruction, onChange: setValue('instruction'), required: true, maxLength: 1200 })),
      agentEditor && (execution ? h('div', { className: 'vc-workflow-independent-modules' }, agentEditor) : agentEditor),
      canEditFiles && h(StageFileAccessEditor, { ...fileEditor, stage, connected,
        ...(attachmentsOnly && { attachmentsOnly, localSdk: true, catalogScope: target.targetId,
          readFileTarget: () => target.targetId }) }),
      !canEditGrants && (stage.agent || stage.agentPreset || showOldFiles) && h('div', { className: 'vc-workflow-dependencies' },
        h('h4', null, '现有资源授权'),
        note(blind ? '保存盲审阶段前须清除以下授权。' : attachmentsOnly ? '请清除旧的 Agent 模块，或选定本机配置后重新授权附件。' : '切换主工作区至此配置后可编辑授权。'),
        stage.agent && note(agentSummary(stage.agent)),
        showOldFiles && note(`${stage.fileAccess.paths.length} 个文件路径 · ${stage.fileAccess.attachments.length} 个附件`),
        actions((stage.agent || stage.agentPreset) && button('清除 Agent 资源及预设', clearAgent),
          showOldFiles && button('清除此阶段文件授权', () => fileEditor.onChange()))),
      h('div', { className: 'vc-workflow-dependencies' },
        h('h4', null, '上游阶段'),
        dependencies.length ? h('ul', null, dependencies.map(({ id, number: upstream, name }) =>
          h('li', { key: id }, h('span', null, `第 ${upstream} 阶段 · ${name}`),
            button('移除连接', () => onDisconnect(id, stage.id), { 'aria-label': `移除第 ${upstream} 阶段到第 ${number} 阶段的连接` }))))
          : note('无上游阶段')),
      actions(
        onMove && button('上移', () => onMove(index - 1), { disabled: index === 0, 'aria-label': `上移第 ${number} 阶段` }),
        onMove && button('下移', () => onMove(index + 1), { disabled: index === count - 1, 'aria-label': `下移第 ${number} 阶段` }),
        button('删除阶段', onDelete, { disabled: count <= 1, 'aria-label': `删除第 ${number} 阶段` })));
  }

  function Proposal({ proposal, isRevision, busy, error, moduleCatalog, onAccept, onDismiss }) {
    const { draft } = proposal;
    const [active, setActive] = React.useState(0);
    const stage = draft.stages[active];
    const dependencies = stageDependencies(draft.stages, draft.edges, stage.id);
    return h('section', { className: 'vc-workflow-pane vc-workflow-proposal', 'aria-label': '待确认的工作流提案' },
      h('div', { className: 'vc-workflow-title-row' },
        h('div', { className: 'vc-workflow-proposal-name' },
          h('h3', null, draft.name), note(isRevision ? '保存后更新此工作流。' : '保存后创建此工作流。')),
        actions(button('保存提案', onAccept, { primary: true, disabled: busy }),
          button('拒绝提案', onDismiss, { disabled: busy }))),
      alert(error),
      h(StageGraph, { stages: draft.stages, edges: draft.edges, active, onSelect: setActive, moduleCatalog }),
      h('section', { className: 'vc-workflow-card', 'aria-label': '提案阶段详情' },
        h('strong', null, `第 ${active + 1} 阶段 · ${stage.name}`),
        h('dl', { className: 'vc-workflow-details' },
          h('dt', null, '执行工具'), h('dd', null, providerLabel(stage.provider)),
          h('dt', null, '模型'), h('dd', null, stage.model || defaultModel(stage.provider)),
          stage.agent && h(React.Fragment, null,
            h('dt', null, 'Agent 模块'), h('dd', null, agentSummary(stage.agent))),
          stage.fileAccess && h(React.Fragment, null,
            h('dt', null, '现有阶段文件授权'),
            h('dd', null, `${stage.fileAccess.paths.length} 个远端路径 · ${stage.fileAccess.attachments.length} 个本地附件`)),
          h('dt', null, '上游阶段'), h('dd', null, dependencies.map(({ number, name }) => `第 ${number} 阶段 · ${name}`).join('、') || '无')),
        h('h4', null, '角色与指令'),
        h('div', { className: 'vc-workflow-text', tabIndex: 0 }, stage.instruction)));
  }

  function RunSummary({ run, projects, running, launchAction, controlAction, performLaunch, performControl,
    onResume, onPause, onStop, onRetry, readArtifacts, targets, jump, archived = false, canExecute = true }) {
    const [confirmRetry, setConfirmRetry] = React.useState(null);
    const focusedStage = React.useRef(null);
    React.useEffect(() => {
      const stage = focusedStage.current;
      if (stage && jump?.runId === run?.id) {
        stage.scrollIntoView({ block: 'nearest' });
        stage.focus({ preventScroll: true });
      }
    }, [jump, run?.id]);
    if (!run) return null;
    const resumable = run.phase === 'paused' || run.phase === 'running';
    const checkingStop = run.stopRequested;
    const retryStop = checkingStop && run.rows.some(({ state }) => state === 'canceling');
    return h(React.Fragment, null,
      h('div', { className: 'vc-workflow-title-row' },
        h('h3', null, archived ? '历史运行详情' : run.mixed ? '最近的混合运行' : '最近运行'),
        h('span', { role: 'status' }, resumable && checkingStop ? '等待确认停止' : phases[run.phase] ?? run.phase)),
      h('strong', null, run.workflow.name),
      !run.mixed && usesSharedMemory(run.workflow) && Object.hasOwn(run, 'projectId') &&
        note(`记忆项目 · ${run.projectId === null ? personalMemoryLabel : projects.get(run.projectId) ?? '已移除的项目'}`),
      run.task && h('div', { className: 'vc-workflow-text', 'aria-label': '最近运行的任务', tabIndex: 0 }, run.task),
      run.mixed && h('dl', { className: 'vc-workflow-details' },
        h('dt', null, '运行 ID'), h('dd', null, h('code', null, run.id)),
        h('dt', null, '工作流版本'), h('dd', null, run.mixed.revision),
        h('dt', null, '验收标准'), h('dd', null, run.mixed.criteria),
        run.mixed.constraints && h(React.Fragment, null, h('dt', null, '约束'), h('dd', null, run.mixed.constraints))),
      run.message && note(run.message, 'status'),
      resumable && !canExecute && note('切换到执行模式后可继续或停止此工作流。'),
      resumable && actions(
        running && !checkingStop && button('暂停运行', () => performControl('pause', onPause), { disabled: Boolean(controlAction) }),
        !running && button(checkingStop ? '查询停止结果' : '查询并继续', () => performLaunch('resume', onResume), {
          primary: true, disabled: !canExecute || Boolean(launchAction || controlAction),
        }),
        (!checkingStop || retryStop) &&
          button(checkingStop ? '重试停止' : '停止运行', () => performControl('stop', onStop),
            { disabled: !canExecute || Boolean(controlAction) })),
      h('ol', { className: 'vc-workflow-list', 'aria-label': '运行阶段' },
        run.workflow.stages.map((stage, index) => {
          const row = run.rows[index];
          const name = stage.name || `第 ${index + 1} 阶段`;
          const target = targetForStage(stage, targets);
          const retry = run.mixed && run.phase === 'failed' && row?.state === 'failed';
          const confirming = confirmRetry === row?.turnId;
          const focused = jump?.runId === run.id && jump.stageIndex === index;
          return h('li', { key: stage.id, className: 'vc-workflow-card', ...(focused && { ref: focusedStage, tabIndex: -1 }) },
            h('div', { className: 'vc-workflow-title-row' },
              h('strong', null, `第 ${index + 1} 阶段 · ${name}`),
              h('span', null, rowStates[row?.state] ?? row?.state ?? rowStates.waiting)),
            note(`${providerLabel(stage.provider, stage.execution?.location)} · ${isLocalClaudeOrAcpStage(stage) ? '账号默认模型' : stage.model || defaultModel(stage.provider)}`),
            stage.execution && note(`${executionLocations[stage.execution.location]} · ${target?.label ?? '原配置'} · ${executionContexts[stage.execution.context]}`),
            stage.agent && note(agentSummary(run.mixed ? { ...stage.agent, memory: 'isolated' } : stage.agent)),
            run.mixed && h(MixedStageDetails, { run, index }),
            retry && (confirming ? h('div', { className: 'vc-workflow-card', role: 'group', 'aria-label': '确认重试阶段' },
              note('工作台会核对原失败回执。重试将创建新运行，复用已完成阶段，并可能消耗模型额度。'),
              actions(button('取消', () => setConfirmRetry(null)),
                button('确认重试', async () => {
                  if (await onRetry?.(run.id, index)) setConfirmRetry(null);
                }, { primary: true, disabled: !onRetry })))
              : actions(button('重试阶段…', () => setConfirmRetry(row.turnId), { disabled: !onRetry }))),
            run.version === 4 && row?.turnId && h('div', { className: 'vc-workflow-output-path', role: 'group',
              'aria-label': `第 ${index + 1} 阶段输出目录`, tabIndex: 0 },
              h('span', { className: 'vc-workflow-note' }, '输出目录'),
              h('code', null, `~/.remote-ssh-chat/workflow-outputs/${row.turnId}`)),
            !isLocalClaudeOrAcpStage(stage) && [4, 5].includes(run.version) && row?.turnId && artifactRowStates.has(row.state) && typeof readArtifacts === 'function' &&
              h(RunArtifacts, { key: `${run.id ?? ''}:${row.turnId}`, run, index, readArtifacts }),
            row?.reply && h('pre', { className: 'vc-workflow-text', tabIndex: 0,
              'aria-label': `第 ${index + 1} 阶段输出` }, row.reply));
        })));
  }

  function MixedRunHistory({ request, currentId, summaryProps, jump }) {
    const [expanded, setExpanded] = React.useState(false);
    const [entries, setEntries] = React.useState(null);
    const [selectedId, setSelectedId] = React.useState(null);
    const [detail, setDetail] = React.useState(null);
    const [historyError, setHistoryError] = React.useState('');
    React.useEffect(() => {
      if (jump?.runId && jump.runId !== currentId) {
        setExpanded(true);
        setSelectedId(jump.runId);
      }
    }, [jump, currentId]);
    React.useEffect(() => {
      if (!expanded) return undefined;
      let live = true;
      setHistoryError('');
      void request({ op: 'history' }).then(({ entries: records }) => {
        if (live) setEntries(records);
      }).catch((error) => { if (live) setHistoryError(messageOf(error, '无法读取混合工作流历史。')); });
      return () => { live = false; };
    }, [expanded, request, currentId]);
    React.useEffect(() => {
      if (!expanded || !selectedId) return undefined;
      let live = true;
      void request({ op: 'detail', runId: selectedId }).then(({ run }) => {
        if (live) setDetail({ id: selectedId, run });
      }).catch((error) => { if (live) setDetail({ id: selectedId, error: messageOf(error, '无法读取运行详情。') }); });
      return () => { live = false; };
    }, [expanded, request, selectedId, currentId]);
    const selected = detail?.id === selectedId ? detail : null;
    return h('section', { className: 'vc-workflow-card', 'aria-label': '混合运行历史' },
      actions(button(expanded ? '收起运行历史' : '查看运行历史', () => setExpanded(!expanded), { 'aria-expanded': expanded })),
      expanded && h(React.Fragment, null,
        !entries && !historyError && note('正在读取运行历史…', 'status'),
        alert(historyError),
        entries?.length === 0 && note('开始下一次运行后，已结束的原记录会出现在这里。'),
        entries?.length > 0 && h('ul', { className: 'vc-workflow-list', 'aria-label': '历史运行列表' }, entries.map((entry) =>
          h('li', { key: entry.id },
            button(entry.name, () => setSelectedId(entry.id), { 'aria-pressed': selectedId === entry.id }),
            note(`版本 ${entry.revision} · ${phases[entry.phase]} · 归档于 ${new Date(entry.archivedAt).toLocaleString()}`)))),
        selectedId && !selected && note('正在读取运行详情…', 'status'),
        alert(selected?.error),
        selected?.run && h(RunSummary, { key: selected.run.id, ...summaryProps, run: selected.run, archived: true })));
  }

  return function WorkflowPanel({ open, preferRunPane, onClose, workflows, availableProviders, catalogScope, readModels, onChange, onEditInChat,
    proposal, onDismissProposal, run, running, canStart, onStart, onResume, onPause, onStop, exampleError,
    agentPresets = [], onManageAgentPresets, moduleCatalog, projects = emptyProjects, selectedProject,
    readFileTarget, saveAttachments, readArtifacts, localSdk, mixed, searchSelection, clearSearchSelection }) {
    const titleId = React.useId();
    const memoryProjectErrorId = React.useId();
    const configurationId = React.useId();
    const runPaneId = React.useId();
    const draftTitleId = React.useId();
    const draftDescriptionId = React.useId();
    const dialog = React.useRef(null);
    const draftDialog = React.useRef(null);
    const stayButton = React.useRef(null);
    const closeButton = React.useRef(null);
    const cancelExit = React.useRef(null);
    const closeCallback = React.useRef(onClose);
    const activeProposal = React.useRef(proposal);
    const catalogRequests = React.useRef(new Map());
    const writeRequest = React.useRef(false);
    const fileRequest = React.useRef(null);
    const launchRequest = React.useRef(false);
    const controlRequest = React.useRef(false);
    const [selectedId, setSelectedId] = React.useState(null);
    const [stageIndex, setStageIndex] = React.useState(0);
    const [editing, setEditing] = React.useState(null);
    const [catalogs, setCatalogs] = React.useState({});
    const [writeBusy, setWriteBusy] = React.useState(false);
    const [fileBusy, setFileBusy] = React.useState(false);
    const [closing, setClosing] = React.useState(false);
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [transition, setTransition] = React.useState(null);
    const [transitionError, setTransitionError] = React.useState('');
    const [compactView, setCompactView] = React.useState(run || mixed?.run ? 'run' : 'configuration');
    const [runJump, setRunJump] = React.useState(null);
    const [editError, setEditError] = React.useState('');
    const [proposalError, setProposalError] = React.useState(null);
    const [runError, setRunError] = React.useState('');
    const [task, setTask] = React.useState('');
    const [memoryProjectOverride, setMemoryProjectOverride] = React.useState(null);
    const [launchAction, setLaunchAction] = React.useState(null);
    const [controlAction, setControlAction] = React.useState(null);
    const presetChoices = React.useMemo(
      () => agentPresets.map((preset) => ({ id: preset.id, ...resolveAgentPreset(preset) })), [agentPresets]);

    React.useLayoutEffect(() => { closeCallback.current = onClose; }, [onClose]);
    React.useLayoutEffect(() => { activeProposal.current = proposal; }, [proposal]);
    React.useLayoutEffect(() => {
      const element = dialog.current;
      if (!open) return undefined;
      setClosing(false);
      element.showModal();
      closeButton.current.focus();
      return () => {
        cancelExit.current?.();
        cancelExit.current = null;
        if (element.open) element.close();
      };
    }, [open]);
    React.useLayoutEffect(() => {
      if (open && preferRunPane) setCompactView('run');
      if (!open) setRunJump(null);
    }, [open, preferRunPane]);
    React.useLayoutEffect(() => {
      if (!transition || !open) return undefined;
      const element = draftDialog.current;
      element.showModal();
      stayButton.current.focus();
      return () => { if (element.open) element.close(); };
    }, [transition, open]);
    React.useLayoutEffect(() => {
      setCatalogs({});
      const requests = catalogRequests.current;
      return () => {
        for (const controller of requests.values()) controller.abort();
        requests.clear();
      };
    }, [catalogScope]);

    const selected = selectedId === null ? workflows[0] : workflows.find(({ id }) => id === selectedId);
    const working = editing && (editing.id === selectedId || editing.id === selected?.id) ? editing : null;
    const draft = working?.draft ?? (selected ? asDraft(selected) : null);
    const activeStage = Math.min(stageIndex, (draft?.stages.length ?? 1) - 1);
    const stage = draft?.stages[activeStage];
    const linear = draft && isLinear(draft);
    const stale = Boolean(working?.revision != null && working.revision !== selected?.revision);
    const explicitExecution = usesExplicitExecution(selected);
    const unavailable = selected?.stages.filter(({ provider }) => !availableProviders.includes(provider)) ?? [];
    const missingModel = selected?.stages.find((item) => {
      const catalog = catalogs[modelCatalogKey(item)];
      return item.model && catalog?.status === 'ready' && !catalog.models.some(({ id }) => id === item.model);
    });
    const unresolved = run?.phase === 'paused' || run?.phase === 'running';
    const mixedRun = mixed?.run;
    const mixedUnresolved = mixedRun?.phase === 'paused' || mixedRun?.phase === 'running';
    const currentRun = mixedUnresolved ? mixedRun : unresolved ? run : null;
    const sharedMemory = usesSharedMemory(selected);
    const defaultMemoryProject = projects.has(selectedProject) ? selectedProject : '';
    const memoryProject = memoryProjectOverride && memoryProjectOverride.workflowId === selected?.id
      ? memoryProjectOverride.projectId : defaultMemoryProject;
    const missingMemoryProject = Boolean(sharedMemory && memoryProject && !projects.has(memoryProject));
    const activeStageConnected = availableProviders.includes(stage?.provider);
    React.useLayoutEffect(() => () => fileRequest.current?.abort(),
      [open, proposal, catalogScope, working?.draft ?? selected, stage, stale, activeStageConnected]);

    function dismiss() {
      if (!dialog.current.open) return;
      fileRequest.current?.abort();
      setClosing(true);
      dialog.current.close();
      cancelExit.current = afterPopupMotion(dialog.current, () => closeCallback.current());
    }

    function choose(id, index = 0) {
      fileRequest.current?.abort();
      setSelectedId(id);
      setStageIndex(index);
      setEditing(null);
      setConfirmDelete(false);
      setEditError('');
    }

    function requestTransition(trigger, description, proceed) {
      if (writeRequest.current || fileRequest.current || transition) return;
      if (working) {
        setTransitionError('');
        setTransition({ trigger, description, proceed });
      } else proceed();
    }

    React.useEffect(() => {
      if (!open || !searchSelection || writeBusy || fileBusy || transition) return;
      clearSearchSelection();
      if (searchSelection.runId) {
        setCompactView('run');
        setRunJump(searchSelection);
        return;
      }
      if (!workflows.some(({ id }) => id === searchSelection.workflowId)) {
        setEditError('此工作流已删除，请刷新搜索结果。');
        return;
      }
      requestTransition(closeButton.current, '打开搜索结果', () => {
        choose(searchSelection.workflowId);
        setCompactView('configuration');
      });
    }, [open, searchSelection, writeBusy, fileBusy, transition, workflows]);

    function closeTransition(restoreFocus = false) {
      setTransition(null);
      if (restoreFocus) {
        draftDialog.current.close();
        transition?.trigger.focus({ preventScroll: true });
      }
    }

    function stay() {
      if (!writeRequest.current) closeTransition(true);
    }

    function discardAndContinue() {
      if (writeRequest.current) return;
      closeTransition();
      choose(selected?.id ?? null);
      transition.proceed();
    }

    async function saveAndContinue() {
      if (!working || writeRequest.current) return;
      if (stale) {
        setTransitionError('工作流已在别处更新或删除，请保留草稿，或放弃修改后读取已保存版本。');
        return;
      }
      const saved = await write({ op: 'save', ...working }, { transition: true });
      if (!saved) return;
      closeTransition();
      transition.proceed(saved.find(({ id }) => id === working.id));
    }

    function create() {
      try {
        const id = globalThis.crypto.randomUUID();
        choose(id);
        setEditing({ id, revision: null, draft: blankDraft() });
      } catch (error) {
        setEditError(messageOf(error, '无法生成工作流标识。'));
      }
    }

    function update(next) {
      fileRequest.current?.abort();
      const { id, revision } = working ?? selected;
      setSelectedId(id);
      setEditing({ id, revision, draft: next });
      setConfirmDelete(false);
      setEditError('');
    }

    function selectStage(index) {
      if (index !== activeStage) fileRequest.current?.abort();
      setStageIndex(index);
    }

    function changeStageFileAccess(fileAccess) {
      const next = { ...stage };
      if (fileAccess) next.fileAccess = fileAccess;
      else delete next.fileAccess;
      update({ ...draft, stages: draft.stages.map((item) => item.id === stage.id ? next : item) });
    }

    async function requestStageFileAccess(operation) {
      if (fileRequest.current || writeRequest.current || !open || proposal || stale) return false;
      const controller = new AbortController();
      fileRequest.current = controller;
      setFileBusy(true);
      try {
        const next = await operation(controller.signal);
        if (controller.signal.aborted) return false;
        changeStageFileAccess(next);
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        throw error;
      } finally {
        fileRequest.current = null;
        setFileBusy(false);
      }
    }

    function moveStage(index, next) {
      if (!linear || next < 0 || next >= draft.stages.length || index === next) return;
      const stages = draft.stages.slice();
      const [moved] = stages.splice(index, 1);
      stages.splice(next, 0, moved);
      update({ ...draft, stages, edges: linearWorkflowEdges(stages) });
      setStageIndex(next);
    }

    function addStage(linkFromSelected) {
      if (draft.stages.length >= 8) return;
      try {
        const next = blankStage(globalThis.crypto.randomUUID());
        const edges = linkFromSelected ? [...draft.edges, { from: stage.id, to: next.id }] : draft.edges;
        update({ ...draft, stages: [...draft.stages, next], edges });
        setStageIndex(draft.stages.length);
      } catch (error) {
        setEditError(messageOf(error, '无法生成阶段标识。'));
      }
    }

    function deleteStage() {
      if (draft.stages.length <= 1) return;
      update({ ...draft, stages: draft.stages.filter(({ id }) => id !== stage.id),
        edges: draft.edges.filter(({ from, to }) => from !== stage.id && to !== stage.id) });
      setStageIndex(Math.min(activeStage, draft.stages.length - 2));
    }

    function connectStages(from, to) {
      try {
        const edges = validateWorkflowEdges(draft.stages, [...draft.edges, { from, to }]);
        update({ ...draft, edges });
        setStageIndex(draft.stages.findIndex(({ id }) => id === to));
        return '';
      } catch (error) {
        return messageOf(error, '无法添加连接。');
      }
    }

    function disconnectStages(source, target) {
      update({ ...draft, edges: draft.edges.filter(({ from, to }) => from !== source || to !== target) });
    }

    function saveDraft() {
      if (!working || stale || fileRequest.current) return;
      const { id, revision } = working;
      void write({ op: 'save', id, revision, draft });
    }

    async function load(item) {
      const key = modelCatalogKey(item);
      if (catalogRequests.current.has(key)) return;
      const controller = new AbortController();
      catalogRequests.current.set(key, controller);
      setCatalogs((previous) => ({ ...previous, [key]: { ...previous[key], status: 'loading' } }));
      try {
        if (item.execution && !mixed) throw new Error('当前工作台无法读取此执行配置。');
        const models = item.execution ? await mixed.catalog(item) : await readModels(item.provider, controller.signal);
        if (controller.signal.aborted) return;
        if (!Array.isArray(models)) throw new Error('返回的模型目录格式无效。');
        const ids = new Set();
        const options = models.map((model) => {
          if (!model || typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) {
            throw new Error('返回的模型目录包含无效或重复的标识。');
          }
          ids.add(model.id);
          return { id: model.id, displayName: typeof model.displayName === 'string' ? model.displayName : '' };
        });
        setCatalogs((previous) => ({ ...previous, [key]: { status: 'ready', models: options } }));
      } catch (error) {
        if (!controller.signal.aborted) {
          setCatalogs((previous) => ({ ...previous, [key]: { ...previous[key], status: 'error',
            error: messageOf(error, '请重试。') } }));
        }
      } finally {
        if (catalogRequests.current.get(key) === controller) catalogRequests.current.delete(key);
      }
    }

    async function write(request, { currentProposal, transition: savingBeforeTransition = false } = {}) {
      if (writeRequest.current || fileRequest.current) return null;
      writeRequest.current = true;
      setWriteBusy(true);
      if (currentProposal) setProposalError(null);
      else if (savingBeforeTransition) setTransitionError('');
      else setEditError('');
      try {
        const change = request.op === 'save'
          ? { ...request, draft: validateWorkflowDraft(request.draft) }
          : request;
        const saved = await onChange(change);
        choose(change.op === 'save' ? change.id : saved[0]?.id ?? null, change.op === 'save' && !currentProposal ? activeStage : 0);
        if (currentProposal && activeProposal.current === currentProposal) onDismissProposal();
        return saved;
      } catch (error) {
        const message = messageOf(error, '无法更新工作流。');
        if (currentProposal) setProposalError({ proposal: currentProposal, message });
        else if (savingBeforeTransition) setTransitionError(message);
        else setEditError(message);
        return null;
      } finally {
        writeRequest.current = false;
        setWriteBusy(false);
      }
    }

    function editInChat(workflow) {
      setEditError('');
      if (usesExplicitExecution(workflow)) {
        setEditError('请在工作流面板编辑已绑定执行配置的阶段。');
        return;
      }
      try {
        if (!onEditInChat(workflow)) setEditError('无法打开工作流编辑会话。');
      } catch (error) {
        setEditError(messageOf(error, '无法打开工作流编辑会话。'));
      }
    }

    async function perform(action, callback, request, setAction) {
      if (request.current) return false;
      request.current = true;
      setAction(action);
      setRunError('');
      try {
        const result = await callback();
        if (result === false) setRunError('操作未执行，请检查当前运行状态。');
        return result;
      } catch (error) {
        setRunError(messageOf(error, '无法操作工作流运行。'));
        return false;
      } finally {
        request.current = false;
        setAction(null);
      }
    }

    const launch = (action, callback) => perform(action, callback, launchRequest, setLaunchAction);
    const control = (action, callback) => perform(action, callback, controlRequest, setControlAction);
    const start = () => {
      if (fileRequest.current || explicitExecution || mixed?.running || mixedUnresolved) return false;
      return onStart(asDraft(selected), task.trim(), sharedMemory && memoryProject ? memoryProject : null, selected.id);
    };

    let startReason = '';
    if (fileBusy) startReason = '文件授权更新完成后可以运行。';
    else if (working) startReason = '保存工作流后可以运行。';
    else if (!selected) startReason = '请选择一个已保存的工作流。';
    else if (explicitExecution && !mixed) startReason = '当前工作台无法运行带执行配置的工作流。';
    else if (explicitExecution && mixed.canExecute === false) startReason = '仅浏览模式下无法运行混合工作流。';
    else if (explicitExecution) startReason = getMixedStartReason(selected, mixed.targets);
    else if (unavailable.length) startReason = `需要启用 ${[...new Set(unavailable.map(({ provider }) => providerLabel(provider)))].join('、')}。`;
    if (!startReason && missingModel) startReason = `阶段「${missingModel.name}」的模型 ${missingModel.model} 当前不可用。`;
    if (!startReason && (unresolved || mixedUnresolved)) startReason = '请继续或停止当前运行。';
    if (!startReason && !explicitExecution && !canStart) startReason = '当前连接暂不可运行工作流。';
    const operationsBusy = Boolean(launchAction || controlAction || running || mixed?.running || writeBusy);
    const startDisabled = Boolean(startReason || missingMemoryProject || !task.trim() || operationsBusy);

    return h('dialog', { ref: dialog, className: 'vc-workflow-dialog vc-popup-motion', 'aria-labelledby': titleId,
      onCancel: (event) => { event.preventDefault(); dismiss(); } },
    h('style', null, workflowPanelStyles),
    h('dialog', { ref: draftDialog, className: 'vc-settings vc-conversation-dialog vc-popup-motion',
      'aria-labelledby': draftTitleId, 'aria-describedby': draftDescriptionId,
      onCancel(event) { event.preventDefault(); event.stopPropagation(); stay(); } },
    h('div', { className: 'vc-workflow-draft-confirm' },
      h('h2', { id: draftTitleId }, '工作流有未保存的修改'),
      h('p', { id: draftDescriptionId, className: 'vc-workflow-note' }, `${transition?.description ?? ''}前请选择如何处理当前草稿。`),
      alert(transitionError),
      h('div', { className: 'vc-dialog-actions' },
        button('留在当前', stay, { ref: stayButton, disabled: writeBusy }),
        button('放弃修改', discardAndContinue, { disabled: writeBusy }),
        button('保存并继续', saveAndContinue, { primary: true, disabled: writeBusy })))),
    h('header', { className: 'vc-workflow-header' },
      h('h2', { id: titleId }, proposal ? '确认工作流提案' : '工作流'),
      actions(fileBusy ? h('span', { className: 'vc-workflow-note', role: 'status' }, '正在更新文件授权…')
        : !proposal && working ? h('span', { className: 'vc-workflow-note', role: 'status' }, '未保存') : null,
        !proposal && draft ? button('保存工作流', saveDraft, { primary: true, disabled: writeBusy || fileBusy || !working || stale }) : null,
        button('关闭', dismiss, { ref: closeButton, 'aria-label': '关闭工作流' }))),
    h('div', { className: 'vc-workflow-body', 'data-proposal': Boolean(proposal), 'data-view': compactView },
      proposal ? h(Proposal, { key: `${proposal.id}:${proposal.revision}`, proposal, busy: writeBusy || fileBusy, isRevision: proposal.revision != null, moduleCatalog,
        error: proposalError?.proposal === proposal ? proposalError.message : '',
        onAccept: (event) => requestTransition(event.currentTarget, '接受工作流提案',
          () => write({ op: 'save', id: proposal.id, revision: proposal.revision, draft: proposal.draft }, { currentProposal: proposal })),
        onDismiss: () => { setProposalError(null); onDismissProposal(); },
      }) : h(React.Fragment, null,
        h('div', { className: 'vc-workflow-view-switch', role: 'group', 'aria-label': '工作流面板' },
          button('配置', () => setCompactView('configuration'), { 'aria-controls': configurationId, 'aria-pressed': compactView === 'configuration' }),
          button('运行', () => setCompactView('run'), { 'aria-controls': runPaneId, 'aria-pressed': compactView === 'run' })),
        h('section', { id: configurationId, className: 'vc-workflow-pane vc-workflow-edit-pane', 'aria-label': '工作流配置' },
          h('div', { className: 'vc-workflow-command-row' },
            field('已保存的工作流', h('select', { value: selected?.id ?? '', disabled: writeBusy || fileBusy,
              onChange(event) {
                const id = event.target.value || null;
                requestTransition(event.currentTarget, '切换工作流', () => choose(id));
              } },
            h('option', { value: '', disabled: true }, working ? '新工作流' : workflows.length ? '选择工作流' : '没有已保存的工作流'),
            workflows.map(({ id, name }) => h('option', { key: id, value: id }, name)))),
            button('新建工作流', (event) => requestTransition(event.currentTarget, '新建工作流', create),
              { primary: !draft, disabled: writeBusy || fileBusy })),
          actions(
            button('在聊天中创建', (event) => requestTransition(event.currentTarget, '在聊天中创建工作流', () => editInChat(null)),
              { disabled: writeBusy || fileBusy }),
            selected && !explicitExecution && !usesExplicitExecution(draft) && button('在聊天中编辑', (event) => requestTransition(event.currentTarget, '在聊天中编辑工作流',
              (saved) => editInChat(saved ?? selected)), { disabled: writeBusy || fileBusy })),
          stale && alert('工作流已在别处更新或删除。当前草稿仍保留。'),
          stale && actions(button('读取已保存版本', (event) => requestTransition(event.currentTarget, '读取已保存版本',
            () => choose(selected?.id ?? null)), { disabled: writeBusy || fileBusy })),
          alert(editError),
          draft && h(React.Fragment, null,
            h('div', { className: 'vc-workflow-edit-name' },
              field('工作流名称', h('input', { value: draft.name, required: true, disabled: writeBusy, maxLength: 80,
                onChange: (event) => update({ ...draft, name: event.target.value }) }))),
            h(StageGraph, { key: `${working?.id ?? selected?.id}:${selected?.revision ?? 0}`,
              stages: draft.stages, edges: draft.edges, active: activeStage, moduleCatalog, targets: mixed?.targets,
              onSelect: selectStage, onMove: linear ? moveStage : null, onAdd: addStage, onConnect: connectStages, disabled: writeBusy }),
            h(StageEditor, { stage, index: activeStage, count: draft.stages.length, available: availableProviders, mixed,
              dependencies: stageDependencies(draft.stages, draft.edges, stage.id), onDisconnect: disconnectStages,
              catalog: catalogs[modelCatalogKey(stage)], load, disabled: writeBusy, presetChoices, onManageAgentPresets, moduleCatalog,
              fileEditor: { key: `${working?.id ?? selected?.id}:${working?.revision ?? selected?.revision ?? 0}:${stage.id}:${stage.provider}`,
                open, catalogScope, readFileTarget, saveAttachments, localSdk, busy: fileBusy, disabled: writeBusy || stale,
                onChange: changeStageFileAccess, onRequest: requestStageFileAccess },
              onChange: (next) => update({ ...draft, stages: draft.stages.map((item, position) => position === activeStage ? next : item) }),
              onMove: linear ? (next) => moveStage(activeStage, next) : null, onDelete: deleteStage }),
            selected && !confirmDelete && actions(
              button('删除工作流', (event) => requestTransition(event.currentTarget, '删除工作流',
                () => setConfirmDelete(true)), { disabled: writeBusy || fileBusy || stale })),
            confirmDelete && actions(
              h('span', null, `删除「${selected?.name ?? draft.name}」？`),
              button('确认删除', () => write({ op: 'delete', id: selected.id, revision: selected.revision }),
                { disabled: writeBusy || fileBusy || stale || !selected }),
              button('取消删除', () => setConfirmDelete(false), { disabled: writeBusy })))),
        h('section', { id: runPaneId, className: 'vc-workflow-pane vc-workflow-run-pane', 'aria-label': '工作流运行' },
          h('div', { className: 'vc-workflow-title-row' },
            h('h3', null, '运行工作流'),
            currentRun && note(`当前运行 · ${currentRun.stopRequested ? '等待确认停止' : phases[currentRun.phase]}`, 'status')),
          explicitExecution ? (mixed ? h(MixedRunBrief, { key: `${selected.id}:${selected.revision}`,
            workflow: selected, targets: mixed.targets, disabled: operationsBusy, startReason,
            onStart: (brief) => launch('start', () => mixed.start(brief)) }) : note(startReason)) : h(React.Fragment, null,
            field('运行任务', h('textarea', { value: task, onChange: (event) => setTask(event.target.value) })),
            sharedMemory && field('记忆项目', h('select', { value: memoryProject,
              disabled: Boolean(launchAction), 'aria-invalid': missingMemoryProject || undefined,
              'aria-describedby': missingMemoryProject ? memoryProjectErrorId : undefined,
              onChange: (event) => setMemoryProjectOverride({ workflowId: selected.id, projectId: event.target.value }),
            }, missingMemoryProject && h('option', { value: memoryProject, disabled: true }, '已移除的项目'),
            h('option', { value: '' }, personalMemoryLabel),
            Array.from(projects, ([id, title]) => h('option', { key: id, value: id }, title)))),
            missingMemoryProject && h('p', { id: memoryProjectErrorId, className: 'vc-workflow-error', role: 'alert' },
              '所选记忆项目已移除，请重新选择。'),
            actions(button('开始运行', () => launch('start', start), { primary: true, disabled: startDisabled }),
              running && launchAction === 'start' && !unresolved
                ? button('取消准备', () => control('pause', onPause), { disabled: Boolean(controlAction) }) : null),
            startReason && note(startReason)),
          alert(exampleError),
          (explicitExecution || mixedRun) && alert(mixed?.error),
          alert(runError),
          h(RunSummary, { key: mixedRun?.id, run: mixedRun, projects, running: mixed?.running, launchAction, controlAction,
            jump: runJump?.mixed ? runJump : null,
            performLaunch: launch, performControl: control, targets: mixed?.targets, canExecute: mixed?.canExecute,
            onRetry: mixed?.canExecute && !operationsBusy && !currentRun ? (id, index) => launch('retry', () => mixed.retry(id, index)) : undefined,
            readArtifacts: open && !closing && mixed?.canExecute ? mixed.readArtifacts : undefined,
            onResume: () => mixed.action('resume'), onPause: () => mixed.action('pause'), onStop: () => mixed.action('stop') }),
          open && !closing && mixed?.historyRequest && h(MixedRunHistory, { request: mixed.historyRequest, currentId: mixedRun?.id,
            jump: runJump?.mixed && mixed?.running !== undefined ? runJump : null,
            summaryProps: { projects, targets: mixed.targets, jump: runJump?.mixed ? runJump : null,
              onRetry: mixed.canExecute && !operationsBusy && !currentRun ? (id, index) => launch('retry', () => mixed.retry(id, index)) : undefined,
              readArtifacts: mixed.canExecute ? mixed.readArtifacts : undefined } }),
          h(RunSummary, { run, projects, running, launchAction, controlAction, performLaunch: launch, performControl: control,
            jump: runJump && !runJump.mixed ? runJump : null,
            onResume, onPause, onStop, readArtifacts: open && !closing ? readArtifacts : undefined })))));
  };
}
