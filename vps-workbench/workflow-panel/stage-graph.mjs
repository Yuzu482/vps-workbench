import { createPortal } from 'react-dom';
import { menuIcon } from '../../remote-workbench/vps-chat/client/menu-icons.js';
import { executionContexts, executionLocations, targetForStage } from './mixed.mjs';

const card = { width: 156, height: 82, columnGap: 68, rowGap: 24, padding: 22 };
const nodeName = (stage) => stage.name.trim() || '未命名阶段';
const agentName = (stage) => stage.agentPreset?.name ?? '自定义 Agent';
const configurationName = (stage, targets) => targetForStage(stage, targets)?.label ??
  (stage.execution.configId ? '原配置' : '待选择配置');

function placeAgentTooltip(tooltip, anchor, dialog, viewport) {
  const bounds = dialog.getBoundingClientRect();
  const node = anchor.getBoundingClientRect();
  const clippingBounds = [bounds, viewport.getBoundingClientRect(),
    viewport.closest('.vc-workflow-pane').getBoundingClientRect(),
    viewport.closest('.vc-workflow-body').getBoundingClientRect()];
  const visible = clippingBounds.every(({ left, right, top, bottom }) =>
    node.right > left && node.left < right && node.bottom > top && node.top < bottom);
  tooltip.style.visibility = visible ? 'visible' : 'hidden';
  if (!visible) return;

  // Place in the dialog's coordinates, including during its opening scale transition.
  const scaleX = bounds.width / dialog.offsetWidth || 1;
  const scaleY = bounds.height / dialog.offsetHeight || 1;
  const inset = 8;
  const gap = 7;
  const center = ((node.left + node.right) / 2 - bounds.left) / scaleX - dialog.clientLeft;
  const top = (node.top - bounds.top) / scaleY - dialog.clientTop;
  const bottom = (node.bottom - bounds.top) / scaleY - dialog.clientTop;
  const maxLeft = dialog.clientWidth - tooltip.offsetWidth - inset;
  const maxTop = dialog.clientHeight - tooltip.offsetHeight - inset;
  const fitsBelow = bottom + gap <= maxTop;
  const moreRoomBelow = dialog.clientHeight - bottom >= top;
  const y = fitsBelow || moreRoomBelow ? bottom + gap : top - gap - tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(inset, Math.min(center - tooltip.offsetWidth / 2, maxLeft))}px`;
  tooltip.style.top = `${Math.max(inset, Math.min(y, maxTop))}px`;
}

function layoutGraph(stages, edges) {
  const columns = new Map();
  function column(id) {
    if (!columns.has(id)) {
      const level = edges.filter(({ to }) => to === id).reduce((max, edge) => Math.max(max, column(edge.from) + 1), 0);
      columns.set(id, level);
    }
    return columns.get(id);
  }
  const longEdges = edges.filter(({ from, to }) => column(to) - column(from) > 1);
  const counts = [];
  const nodes = new Map(stages.map(({ id }) => {
    const level = column(id);
    const row = counts[level] ?? 0;
    counts[level] = row + 1;
    return [id, {
      x: card.padding + level * (card.width + card.columnGap),
      y: card.padding + longEdges.length * 8 + row * (card.height + card.rowGap),
    }];
  }));
  const rows = Math.max(...counts);
  return {
    nodes, longEdges,
    width: card.padding * 2 + counts.length * card.width + (counts.length - 1) * card.columnGap,
    height: card.padding * 2 + rows * card.height + (rows - 1) * card.rowGap + longEdges.length * 8,
  };
}

function portPoint(node, input) {
  return { x: node.x + (input ? 0 : card.width), y: node.y + card.height / 2 };
}

function arrow(context, x, y) {
  context.moveTo(x - 7, y - 4);
  context.lineTo(x, y);
  context.lineTo(x - 7, y + 4);
}

function drawGraph(canvas, layout, edges, activeId, wire) {
  const win = canvas.ownerDocument.defaultView;
  const scale = win.devicePixelRatio || 1;
  const width = Math.ceil(layout.width * scale);
  const height = Math.ceil(layout.height * scale);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, layout.width, layout.height);
  context.strokeStyle = win.getComputedStyle(canvas).color;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  const ordered = edges.filter(({ from, to }) => from !== activeId && to !== activeId)
    .concat(edges.filter(({ from, to }) => from === activeId || to === activeId));
  for (const edge of ordered) {
    const start = portPoint(layout.nodes.get(edge.from), false);
    const end = portPoint(layout.nodes.get(edge.to), true);
    const startX = start.x + 8;
    const endX = end.x - 9;
    const lane = layout.longEdges.indexOf(edge);
    const active = edge.from === activeId || edge.to === activeId;
    context.globalAlpha = active ? 1 : 0.68;
    context.lineWidth = active ? 2 : 1.5;
    context.beginPath();
    context.moveTo(startX, start.y);
    if (lane === -1) {
      const center = (startX + endX) / 2;
      context.bezierCurveTo(center, start.y, center, end.y, endX, end.y);
    } else {
      const top = 16 + lane * 8;
      const offset = 13 + lane % 6 * 3;
      context.lineTo(startX + offset, start.y);
      context.lineTo(startX + offset, top);
      context.lineTo(endX - offset, top);
      context.lineTo(endX - offset, end.y);
      context.lineTo(endX, end.y);
    }
    arrow(context, endX, end.y);
    context.stroke();
  }

  if (wire && layout.nodes.has(wire.from)) {
    const start = portPoint(layout.nodes.get(wire.from), false);
    const length = Math.max(24, Math.abs(wire.x - start.x) / 2);
    context.globalAlpha = 1;
    context.lineWidth = 2;
    context.setLineDash([5, 4]);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.bezierCurveTo(start.x + length, start.y, wire.x - length, wire.y, wire.x, wire.y);
    context.stroke();
    context.setLineDash([]);
  }
}

export function createStageGraph(React, { defaultModel, providerLabel, agentMemoryLabel, pluginTemplateLabel }) {
  const h = React.createElement;
  return function StageGraph({ stages, edges, active, onSelect, onMove, onAdd, onConnect, moduleCatalog, targets, disabled = false }) {
    const graphId = React.useId();
    const viewport = React.useRef(null);
    const board = React.useRef(null);
    const canvas = React.useRef(null);
    const tooltip = React.useRef(null);
    const sourceIndex = React.useRef(null);
    const gesture = React.useRef(null);
    const frame = React.useRef(null);
    const suppressClick = React.useRef(false);
    const [dragged, setDragged] = React.useState(null);
    const [boundary, setBoundary] = React.useState(null);
    const [pending, setPending] = React.useState(null);
    const [wire, setWire] = React.useState(null);
    const [feedback, setFeedback] = React.useState(null);
    const [hovered, setHovered] = React.useState(null);
    const [focused, setFocused] = React.useState(null);
    const layout = React.useMemo(() => layoutGraph(stages, edges), [stages, edges]);
    const sortable = Boolean(onMove && stages.length > 1 && !disabled);
    const editable = Boolean(onConnect && !disabled);
    const source = editable && layout.nodes.has(pending) ? pending : null;
    const activeId = stages[active]?.id;
    const activeNode = layout.nodes.get(activeId);
    const details = hovered ?? focused;
    const detailStage = details && stages.find(({ id }) => id === details.id);
    const detailDialog = detailStage && details.anchor.closest('dialog[open]');
    const tooltipId = `${graphId}-agent-tooltip`;
    const dismissDetails = React.useCallback(() => {
      setHovered(null);
      setFocused(null);
    }, []);

    React.useLayoutEffect(() => {
      const strip = viewport.current;
      const selected = strip.querySelector('.vc-workflow-node[aria-pressed="true"]');
      if (!selected || !strip.clientWidth) return;
      const view = strip.getBoundingClientRect();
      const bounds = selected.getBoundingClientRect();
      if (bounds.left < view.left + 16) strip.scrollLeft += bounds.left - view.left - 20;
      else if (bounds.right > view.right - 16) strip.scrollLeft += bounds.right - view.right + 20;
      if (bounds.top < view.top + 8) strip.scrollTop += bounds.top - view.top - 10;
      else if (bounds.bottom > view.bottom - 12) strip.scrollTop += bounds.bottom - view.bottom + 16;
    }, [activeId, activeNode?.x, activeNode?.y]);

    React.useLayoutEffect(() => {
      drawGraph(canvas.current, layout, edges, activeId, wire);
    }, [layout, edges, activeId, wire]);

    React.useLayoutEffect(() => {
      if (!detailDialog) return undefined;
      const win = detailDialog.ownerDocument.defaultView;
      const position = () => placeAgentTooltip(tooltip.current, details.anchor, detailDialog, viewport.current);
      const onScroll = () => {
        setHovered(null);
        position();
      };
      const onEscape = (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !detailDialog.open) return;
        event.preventDefault();
        dismissDetails();
      };
      position();
      detailDialog.addEventListener('scroll', onScroll, true);
      detailDialog.addEventListener('close', dismissDetails);
      win.addEventListener('resize', position);
      win.addEventListener('keydown', onEscape);
      return () => {
        detailDialog.removeEventListener('scroll', onScroll, true);
        detailDialog.removeEventListener('close', dismissDetails);
        win.removeEventListener('resize', position);
        win.removeEventListener('keydown', onEscape);
      };
    }, [details, detailStage, detailDialog, moduleCatalog, layout, dismissDetails]);

    React.useEffect(() => () => {
      if (frame.current !== null) globalThis.cancelAnimationFrame(frame.current);
    }, []);

    function clearCardDrag() {
      sourceIndex.current = null;
      setDragged(null);
      setBoundary(null);
    }

    function cardTarget(event, index, drop = false) {
      const from = sourceIndex.current;
      if (!sortable || from === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const { left, width } = event.currentTarget.getBoundingClientRect();
      const insert = index + Number(event.clientX >= left + width / 2);
      if (drop) {
        clearCardDrag();
        onMove(from, insert - Number(from < insert));
      } else {
        setBoundary(insert);
      }
    }

    function scrollBoard(x, y) {
      const strip = viewport.current;
      const rect = strip.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) {
        if (x < rect.left + 28) strip.scrollLeft -= 10;
        else if (x > rect.right - 28) strip.scrollLeft += 10;
      }
      if (y >= rect.top && y <= rect.bottom) {
        if (y < rect.top + 20) strip.scrollTop -= 8;
        else if (y > rect.bottom - 24) strip.scrollTop += 8;
      }
    }

    function connect(from, to) {
      if (!editable) return;
      const error = onConnect(from, to);
      setPending(null);
      setFeedback({ message: error || '已添加连接。', error: Boolean(error) });
    }

    function drawWire() {
      frame.current = null;
      const current = gesture.current;
      if (!current?.moved) return;
      const { x, y, from } = current;
      const strip = viewport.current;
      const previous = strip.scrollLeft;
      const previousTop = strip.scrollTop;
      scrollBoard(x, y);
      const bounds = board.current.getBoundingClientRect();
      const target = board.current.ownerDocument.elementFromPoint(x, y)?.closest('[data-workflow-input]');
      setWire({ from, x: x - bounds.left, y: y - bounds.top, to: target?.dataset.workflowInput });
      if (strip.scrollLeft !== previous || strip.scrollTop !== previousTop) frame.current = globalThis.requestAnimationFrame(drawWire);
    }

    function endWire(event, canceled = false) {
      const current = gesture.current;
      if (current?.pointer !== event.pointerId) return;
      gesture.current = null;
      if (frame.current !== null) globalThis.cancelAnimationFrame(frame.current);
      frame.current = null;
      setWire(null);
      if (!current.moved || canceled) return;
      suppressClick.current = true;
      const target = board.current.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest('[data-workflow-input]');
      setPending(null);
      if (target && board.current.contains(target)) connect(current.from, target.dataset.workflowInput);
    }

    function port(stage, index, input) {
      const count = edges.filter(({ from, to }) => input ? to === stage.id : from === stage.id).length;
      const side = input ? 'input' : 'output';
      const label = `第 ${index + 1} 阶段${input ? '输入' : '输出'}端口`;
      const props = {
        className: `vc-workflow-port vc-workflow-port-${side}`,
        title: label, 'data-connected': count > 0, 'data-targeted': (input ? wire?.to : wire?.from) === stage.id,
      };
      if (!onConnect) return h('span', { ...props, 'aria-hidden': true });
      return h('button', {
        ...props, type: 'button', 'aria-label': label, disabled,
        'aria-pressed': input ? undefined : source === stage.id,
        'data-workflow-input': input ? stage.id : undefined,
        onClick(event) {
          dismissDetails();
          if (suppressClick.current && event.detail > 0) {
            suppressClick.current = false;
            return;
          }
          suppressClick.current = false;
          setFeedback(null);
          if (!input) setPending(source === stage.id ? null : stage.id);
          else if (source) connect(source, stage.id);
          else setFeedback({ message: '请先选择要连接的输出端口。' });
        },
        onPointerDown(event) {
          dismissDetails();
          suppressClick.current = false;
          if (input || !editable || !event.isPrimary || event.button !== 0) return;
          gesture.current = { from: stage.id, pointer: event.pointerId,
            startX: event.clientX, startY: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        },
        onPointerMove(event) {
          const current = gesture.current;
          if (current?.pointer !== event.pointerId) return;
          const x = event.clientX;
          const y = event.clientY;
          if (!current.moved && Math.hypot(x - current.startX, y - current.startY) < 4) return;
          if (!current.moved) setFeedback(null);
          Object.assign(current, { x, y, moved: true });
          if (frame.current === null) drawWire();
        },
        onPointerUp: endWire,
        onPointerCancel: (event) => endWire(event, true),
        onLostPointerCapture: (event) => endWire(event, true),
      });
    }

    function renderAgentDetails() {
      if (!detailDialog) return null;
      const { provider, model, agent, execution } = detailStage;
      const servers = (agent?.mcpServers ?? []).map(({ id }) => id);
      const templates = (agent?.plugins ?? []).map((template) => pluginTemplateLabel(template, moduleCatalog));
      const hasResources = servers.length > 0 || templates.length > 0;
      return createPortal(h('div', { ref: tooltip, id: tooltipId, role: 'tooltip', className: 'vc-workflow-agent-tooltip' },
        h('strong', null, execution ? nodeName(detailStage) : agentName(detailStage)),
        h('dl', null,
          execution && h(React.Fragment, null,
            h('dt', null, '执行位置'), h('dd', null, executionLocations[execution.location]),
            h('dt', null, '执行配置'), h('dd', null, configurationName(detailStage, targets)),
            h('dt', null, '阶段上下文'), h('dd', null, executionContexts[execution.context])),
          h('dt', null, '执行工具'), h('dd', null, providerLabel(provider)),
          h('dt', null, '模型'), h('dd', null, model || defaultModel(provider)),
          hasResources && h(React.Fragment, null,
            h('dt', null, 'MCP 服务'), h('dd', null, servers.join('、') || '无'),
            h('dt', null, '提示词模板'), h('dd', null, templates.join('、') || '无'))),
        !hasResources && h('p', null, '未配置 MCP 服务或提示词模板')), detailDialog);
    }

    const sourceIndexInDraft = source ? stages.findIndex(({ id }) => id === source) : -1;
    return h('section', { className: 'vc-workflow-graph', 'aria-label': '工作流流程图',
      onKeyDown(event) {
        if (event.key !== 'Escape' || !source) return;
        event.preventDefault();
        setPending(null);
        setFeedback(null);
      } },
    h('div', { className: 'vc-workflow-graph-head' },
      h('h3', null, '阶段依赖'),
      onAdd && h('div', { className: 'vc-workflow-actions vc-workflow-graph-add' },
        h('button', { type: 'button', className: 'vc-button vc-workflow-add-stage',
          'aria-label': '添加阶段', title: '添加当前阶段的下游阶段',
          onClick: () => onAdd(true), disabled: disabled || stages.length >= 8 }, '添加阶段'),
        h('button', { type: 'button', className: 'vc-button',
          onClick: () => onAdd(false), disabled: disabled || stages.length >= 8 }, '添加独立阶段'))),
    onConnect && h('p', { className: 'vc-workflow-note vc-workflow-graph-note', role: feedback?.error ? 'alert' : 'status' },
      feedback?.message ?? (source ? `已选择第 ${sourceIndexInDraft + 1} 阶段输出，请选择输入端口。`
        : '从输出端口拖到输入端口，或依次选择两个端口。')),
    h('div', { ref: viewport, className: 'vc-workflow-graph-scroll',
      onDragOver: (event) => { if (sortable && sourceIndex.current !== null) scrollBoard(event.clientX, event.clientY); } },
    h('div', { ref: board, className: 'vc-workflow-board', style: { width: layout.width, height: layout.height } },
      h('canvas', { ref: canvas, className: 'vc-workflow-wires', 'aria-hidden': true }),
      h('ol', { className: 'vc-workflow-graph-list', 'aria-label': '工作流阶段' }, stages.map((stage, index) => {
        const name = nodeName(stage);
        const { execution } = stage;
        const agent = execution ? configurationName(stage, targets) : agentName(stage);
        const context = execution ? `${executionLocations[execution.location]} · ${execution.context === 'blind' ? '盲审' : '独立'}`
          : agentMemoryLabel(stage.agent);
        const providerId = `${graphId}-${stage.id}-provider`;
        const agentId = `${graphId}-${stage.id}-agent`;
        const memoryId = `${graphId}-${stage.id}-memory`;
        const isDetailAnchor = detailDialog && detailStage.id === stage.id;
        const incoming = edges.filter(({ to }) => to === stage.id).length;
        const { x, y } = layout.nodes.get(stage.id);
        const insert = boundary === index ? 'before'
          : boundary === stages.length && index === stages.length - 1 ? 'after' : undefined;
        return h('li', { className: 'vc-workflow-graph-step', key: stage.id, 'data-insert': insert,
          style: { left: x, top: y, width: card.width, height: card.height },
          onDragOver: (event) => cardTarget(event, index), onDrop: (event) => cardTarget(event, index, true),
        }, h('button', { type: 'button', className: 'vc-workflow-node', 'aria-label': `第 ${index + 1} 阶段 · ${name}`,
          'aria-pressed': active === index, 'data-dragged': dragged === index, 'data-agent-name': agent,
          'aria-describedby': isDetailAnchor ? `${memoryId} ${tooltipId}` : `${providerId} ${agentId} ${memoryId}`,
          onClick: () => onSelect(index), draggable: sortable,
          onPointerEnter(event) {
            if (event.pointerType === 'touch' || sourceIndex.current !== null || gesture.current?.moved) return;
            setHovered({ id: stage.id, anchor: event.currentTarget });
          },
          onPointerLeave: () => setHovered((item) => item?.id === stage.id ? null : item),
          onFocus(event) {
            if (!event.currentTarget.matches(':focus-visible')) return;
            setHovered(null);
            setFocused({ id: stage.id, anchor: event.currentTarget });
          },
          onBlur() {
            setHovered((item) => item?.id === stage.id ? null : item);
            setFocused((item) => item?.id === stage.id ? null : item);
          },
          onKeyDown(event) {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
            if (next < 0 || next >= stages.length) return;
            event.preventDefault();
            onSelect(next);
            viewport.current.querySelectorAll('.vc-workflow-node')[next].focus();
          },
          onDragStart(event) {
            if (!sortable) { event.preventDefault(); return; }
            dismissDetails();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-vps-workbench-stage', String(index));
            sourceIndex.current = index;
            setDragged(index);
          },
          onDragEnd: clearCardDrag,
        }, h('span', { className: 'vc-workflow-node-top' },
          h('span', { className: 'vc-workflow-step-number', 'aria-hidden': true }, index + 1),
          h('strong', { title: name }, name),
          incoming > 1 && h('span', { className: 'vc-workflow-dependency-count', title: `${incoming} 个上游阶段` }, incoming)),
        h('span', { className: 'vc-workflow-node-agent' },
          h('span', { id: providerId, className: 'vc-workflow-node-provider', role: 'img', 'aria-label': providerLabel(stage.provider, stage.execution?.location) },
            menuIcon(h, stage.provider === 'claude' ? 'claude-sdk' : stage.provider)),
          h('span', { id: agentId, className: 'vc-workflow-node-agent-name' }, agent)),
        h('span', { id: memoryId, className: 'vc-workflow-node-memory', 'data-memory': execution ? 'isolated' : stage.agent?.memory }, context)),
        port(stage, index, true), port(stage, index, false));
      })))), renderAgentDetails());
  };
}
