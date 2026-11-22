import { afterPopupMotion } from '../../remote-workbench/vps-chat/client/menu-motion.js';
import { createAgentModulesEditor } from '../agent-presets/settings.mjs';
import { resolveAgentPreset } from '../agent-presets/state.mjs';
import { createRunArtifacts } from './run-artifacts.mjs';
import { createStageFileAccessEditor } from './file-access.mjs';
import { linearWorkflowEdges, validateWorkflowDraft, validateWorkflowEdges, workflowProviders } from '../workflow-engine/state.mjs';
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
const providerLabel = (provider) => workflowProviders[provider]?.label ?? provider;
const blankStage = (id) => ({ id, name: '', provider: 'codex', model: '', instruction: '' });
const blankDraft = () => ({ name: '', stages: [blankStage('s1')], edges: [] });
const asDraft = ({ name, stages, edges }) => ({ name, stages, edges });
const messageOf = (error, fallback) => error instanceof Error && error.message ? error.message : fallback;
const personalMemoryLabel = '个人记忆（未归类）';
const emptyProjects = new Map();

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
    moduleCatalog, onChange, onMove, onDelete, onDisconnect, disabled, fileEditor }) {
    const number = index + 1;
    const connected = available.includes(stage.provider);
    const models = catalog?.models ?? [];
    const supportsModels = workflowProviders[stage.provider]?.models;
    const savedModel = stage.model && !models.some(({ id }) => id === stage.model);
    const missingCatalogModel = savedModel && catalog?.status === 'ready';
    const setValue = (key) => (event) => onChange({ ...stage, [key]: event.target.value });

    function applyPreset({ id, name, provider, model, instruction, agent }) {
      onChange(withAgent({ ...stage, name: stage.name.trim() ? stage.name : name, provider, model, instruction,
        agentPreset: { id, name } }, agent && structuredClone(agent)));
    }

    return h('fieldset', { className: 'vc-workflow-card vc-workflow-inspector', disabled },
      h('legend', null, `第 ${number} 阶段`),
      h(PresetGallery, { stage, choices: presetChoices, moduleCatalog, onApply: applyPreset, onManage: onManageAgentPresets }),
      h('div', { className: 'vc-workflow-fields' },
        field('阶段名称', h('input', { value: stage.name, onChange: setValue('name'), required: true, maxLength: 64 })),
        field('执行工具', h('select', { value: stage.provider, onChange: (event) =>
          onChange({ ...stage, provider: event.target.value, model: '' }) },
        Object.keys(workflowProviders).map((provider) => h('option', { key: provider, value: provider },
          providerLabel(provider) + (available.includes(provider) ? '' : '（未启用）')))))),
      supportsModels ? h('div', { className: 'vc-workflow-model' },
        field('模型', h('select', { value: stage.model, onChange: setValue('model') },
          h('option', { value: '' }, defaultModel(stage.provider)),
          savedModel && h('option', { value: stage.model, disabled: true },
            `${stage.model}${missingCatalogModel ? '（目录中不可用）' : '（已保存）'}`),
          models.map(({ id, displayName }) =>
            h('option', { key: id, value: id }, displayName && displayName !== id ? `${displayName} · ${id}` : id)))),
        button(catalog?.status === 'ready' ? '刷新模型' : '读取模型', () => load(stage.provider), {
          'aria-label': `读取第 ${number} 阶段的模型目录`,
          disabled: !connected || catalog?.status === 'loading',
        })) : note(defaultModel(stage.provider)),
      !connected && note('执行工具尚未启用。可以保存工作流，启用后可运行。'),
      catalog?.status === 'loading' && note('正在读取模型目录…', 'status'),
      catalog?.status === 'error' && alert(`模型目录读取失败：${catalog.error}`),
      missingCatalogModel && note('已保存的模型当前不可用。运行前请选择可用模型。'),
      field('角色与指令', h('textarea', { value: stage.instruction, onChange: setValue('instruction'), required: true, maxLength: 1200 })),
      h(AgentModulesEditor, { key: stage.id, agent: stage.agent ?? null, provider: stage.provider, moduleCatalog, disabled,
        onChange: (agent) => onChange(withAgent(stage, agent)) }),
      h(StageFileAccessEditor, { ...fileEditor, stage, connected }),
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
    onResume, onPause, onStop, readArtifacts }) {
    if (!run) return null;
    const resumable = run.phase === 'paused' || run.phase === 'running';
    const checkingStop = run.stopRequested;
    const retryStop = checkingStop && run.rows.some(({ state }) => state === 'canceling');
    return h(React.Fragment, null,
      h('div', { className: 'vc-workflow-title-row' },
        h('h3', null, '最近运行'),
        h('span', { role: 'status' }, resumable && checkingStop ? '等待确认停止' : phases[run.phase] ?? run.phase)),
      h('strong', null, run.workflow.name),
      usesSharedMemory(run.workflow) && Object.hasOwn(run, 'projectId') &&
        note(`记忆项目 · ${run.projectId === null ? personalMemoryLabel : projects.get(run.projectId) ?? '已移除的项目'}`),
      run.task && h('div', { className: 'vc-workflow-text', 'aria-label': '最近运行的任务', tabIndex: 0 }, run.task),
      run.message && note(run.message, 'status'),
      resumable && actions(
        running && !checkingStop && button('暂停运行', () => performControl('pause', onPause), { disabled: Boolean(controlAction) }),
        !running && button(checkingStop ? '查询停止结果' : '查询并继续', () => performLaunch('resume', onResume), {
          primary: true, disabled: Boolean(launchAction || controlAction),
        }),
        (!checkingStop || retryStop) &&
          button(checkingStop ? '重试停止' : '停止运行', () => performControl('stop', onStop), { disabled: Boolean(controlAction) })),
      h('ol', { className: 'vc-workflow-list', 'aria-label': '运行阶段' },
        run.workflow.stages.map((stage, index) => {
          const row = run.rows[index];
          const name = stage.name || `第 ${index + 1} 阶段`;
          return h('li', { key: stage.id, className: 'vc-workflow-card' },
            h('div', { className: 'vc-workflow-title-row' },
              h('strong', null, `第 ${index + 1} 阶段 · ${name}`),
              h('span', null, rowStates[row?.state] ?? row?.state ?? rowStates.waiting)),
            note(`${providerLabel(stage.provider)} · ${stage.model || defaultModel(stage.provider)}`),
            stage.agent && note(agentSummary(stage.agent)),
            run.version === 4 && row?.turnId && h('div', { className: 'vc-workflow-output-path', role: 'group',
              'aria-label': `第 ${index + 1} 阶段输出目录`, tabIndex: 0 },
              h('span', { className: 'vc-workflow-note' }, '输出目录'),
              h('code', null, `~/.remote-ssh-chat/workflow-outputs/${row.turnId}`)),
            run.version === 4 && row?.turnId && artifactRowStates.has(row.state) && typeof readArtifacts === 'function' &&
              h(RunArtifacts, { key: `${run.id ?? ''}:${row.turnId}`, run, index, readArtifacts }),
            row?.reply && h('pre', { className: 'vc-workflow-text', tabIndex: 0,
              'aria-label': `第 ${index + 1} 阶段输出` }, row.reply));
        })));
  }

  return function WorkflowPanel({ open, preferRunPane, onClose, workflows, availableProviders, catalogScope, readModels, onChange, onEditInChat,
    proposal, onDismissProposal, run, running, canStart, onStart, onResume, onPause, onStop, exampleError,
    agentPresets = [], onManageAgentPresets, moduleCatalog, projects = emptyProjects, selectedProject,
    readFileTarget, saveAttachments, readArtifacts }) {
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
    const [compactView, setCompactView] = React.useState(run ? 'run' : 'configuration');
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
    const unavailable = selected?.stages.filter(({ provider }) => !availableProviders.includes(provider)) ?? [];
    const missingModel = selected?.stages.find(({ provider, model }) =>
      model && catalogs[provider]?.status === 'ready' && !catalogs[provider].models.some(({ id }) => id === model));
    const unresolved = run?.phase === 'paused' || run?.phase === 'running';
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

    function closeTransition(restoreFocus = false) {
      draftDialog.current.close();
      setTransition(null);
      if (restoreFocus) transition?.trigger.focus({ preventScroll: true });
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

    async function load(provider) {
      if (catalogRequests.current.has(provider)) return;
      const controller = new AbortController();
      catalogRequests.current.set(provider, controller);
      setCatalogs((previous) => ({ ...previous, [provider]: { ...previous[provider], status: 'loading' } }));
      try {
        const models = await readModels(provider, controller.signal);
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
        setCatalogs((previous) => ({ ...previous, [provider]: { status: 'ready', models: options } }));
      } catch (error) {
        if (!controller.signal.aborted) {
          setCatalogs((previous) => ({ ...previous, [provider]: { ...previous[provider], status: 'error',
            error: messageOf(error, '请重试。') } }));
        }
      } finally {
        if (catalogRequests.current.get(provider) === controller) catalogRequests.current.delete(provider);
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
      try {
        if (!onEditInChat(workflow)) setEditError('无法打开工作流编辑会话。');
      } catch (error) {
        setEditError(messageOf(error, '无法打开工作流编辑会话。'));
      }
    }

    async function perform(action, callback, request, setAction) {
      if (request.current) return;
      request.current = true;
      setAction(action);
      setRunError('');
      try {
        const result = await callback();
        if (result === false) setRunError('操作未执行，请检查当前运行状态。');
      } catch (error) {
        setRunError(messageOf(error, '无法操作工作流运行。'));
      } finally {
        request.current = false;
        setAction(null);
      }
    }

    const launch = (action, callback) => perform(action, callback, launchRequest, setLaunchAction);
    const control = (action, callback) => perform(action, callback, controlRequest, setControlAction);
    const start = () => {
      if (fileRequest.current) return false;
      return onStart(asDraft(selected), task.trim(), sharedMemory && memoryProject ? memoryProject : null, selected.id);
    };

    let startReason = '';
    if (fileBusy) startReason = '文件授权更新完成后可以运行。';
    else if (working) startReason = '保存工作流后可以运行。';
    else if (!selected) startReason = '请选择一个已保存的工作流。';
    else if (unavailable.length) startReason = `需要启用 ${[...new Set(unavailable.map(({ provider }) => providerLabel(provider)))].join('、')}。`;
    else if (missingModel) startReason = `阶段「${missingModel.name}」的模型 ${missingModel.model} 当前不可用。`;
    else if (unresolved) startReason = '请继续或停止当前运行。';
    else if (!canStart) startReason = '当前连接暂不可运行工作流。';
    const startDisabled = Boolean(startReason || missingMemoryProject || !task.trim() || launchAction || controlAction || running || writeBusy);

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
            selected && button('在聊天中编辑', (event) => requestTransition(event.currentTarget, '在聊天中编辑工作流',
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
              stages: draft.stages, edges: draft.edges, active: activeStage, moduleCatalog,
              onSelect: selectStage, onMove: linear ? moveStage : null, onAdd: addStage, onConnect: connectStages, disabled: writeBusy }),
            h(StageEditor, { stage, index: activeStage, count: draft.stages.length, available: availableProviders,
              dependencies: stageDependencies(draft.stages, draft.edges, stage.id), onDisconnect: disconnectStages,
              catalog: catalogs[stage.provider], load, disabled: writeBusy, presetChoices, onManageAgentPresets, moduleCatalog,
              fileEditor: { key: `${working?.id ?? selected?.id}:${working?.revision ?? selected?.revision ?? 0}:${stage.id}:${stage.provider}`,
                open, catalogScope, readFileTarget, saveAttachments, busy: fileBusy, disabled: writeBusy || stale,
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
            unresolved ? note(`当前运行 · ${run.stopRequested ? '等待确认停止' : phases[run.phase]}`, 'status') : null),
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
          actions(button('开始运行', () => launch('start', start),
            { primary: true, disabled: startDisabled }),
          running && launchAction === 'start' && !unresolved
            ? button('取消准备', () => control('pause', onPause), { disabled: Boolean(controlAction) }) : null),
          startReason && note(startReason),
          alert(exampleError),
          alert(runError),
          h(RunSummary, { run, projects, running, launchAction, controlAction, performLaunch: launch, performControl: control,
            onResume, onPause, onStop, readArtifacts: open && !closing ? readArtifacts : undefined })))));
  };
}
