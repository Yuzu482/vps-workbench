import { contextMenuKey } from './context-menu.js';

const cardWidth = 142;
const cardHeight = 46;
const columnWidth = 176;
const rowHeight = 58;
const padding = 8;
const emptyNodes = [];

const graphCss = `
  [data-vps-chat] .vc-version-graph {
    flex:none; min-width:0; background:var(--vc-surface); border-top:1px solid var(--vc-line);
  }
  [data-vps-chat] .vc-version-graph-bar {
    display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap;
    gap:3px 8px; min-height:32px; padding:4px 10px; font-size:12px;
  }
  [data-vps-chat] .vc-version-graph-actions {display:flex; flex-wrap:wrap; gap:4px}
  [data-vps-chat] .vc-version-graph-bar .vc-button {min-height:26px; padding:3px 7px; font-size:12px}
  [data-vps-chat] .vc-version-graph-status {
    display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:0; padding:4px 10px 8px;
    color:var(--vc-muted); font-size:12px; overflow-wrap:anywhere;
  }
  [data-vps-chat] .vc-version-graph-status[role=alert] {color:var(--vc-warn)}
  [data-vps-chat] .vc-version-graph-scroll {
    max-height:min(142px,25dvh); overflow:auto; overscroll-behavior:contain;
    border-top:1px solid var(--vc-line); background:var(--vc-stage);
  }
  [data-vps-chat] .vc-version-graph-scroll:focus-visible {outline-offset:-2px}
  [data-vps-chat] .vc-version-graph-plane {
    position:relative; min-width:100%; direction:ltr; cursor:grab; user-select:none;
  }
  [data-vps-chat] .vc-version-graph-scroll[data-panning=true] .vc-version-graph-plane {cursor:grabbing}
  [data-vps-chat] .vc-version-graph-edges {position:absolute; inset:0; pointer-events:none; fill:none}
  [data-vps-chat] .vc-version-graph-edges path {stroke:var(--vc-line-strong); stroke-width:1.5}
  [data-vps-chat] .vc-version-graph-edges path[data-fork=true] {stroke:var(--vc-accent); stroke-dasharray:3 3}
  [data-vps-chat] .vc-button.vc-version-graph-node {
    position:absolute; box-sizing:border-box; display:grid; align-content:center; gap:2px;
    padding:4px 8px 4px 23px; border:1px solid var(--vc-line-strong); border-radius:6px;
    background:var(--vc-surface); text-align:start; font-size:12px; line-height:1.15;
    transition:background-color var(--vc-control-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-version-graph-node::before {
    position:absolute; left:8px; top:calc(50% - 4px); width:8px; height:8px;
    border-radius:50%; background:var(--vc-line-strong); content:'';
  }
  [data-vps-chat] .vc-version-graph-node[data-fork=true]::before {
    border-radius:1px; rotate:45deg; background:var(--vc-accent);
  }
  [data-vps-chat] .vc-version-graph-node[aria-pressed=true] {
    border-color:var(--vc-accent); background:var(--vc-tint); color:var(--vc-accent);
    box-shadow:0 0 0 1px var(--vc-accent);
  }
  [data-vps-chat] .vc-version-graph-node span {min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  [data-vps-chat] .vc-version-graph-node span + span {color:var(--vc-muted); font-size:11px; font-weight:400}
  [data-vps-chat] .vc-version-graph-node[aria-disabled=true] {cursor:default; border-style:dashed}
`;

function layoutGraph(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, { node, children: [] }]));
  const roots = [];
  for (const entry of byId.values()) {
    const parent = byId.get(entry.node.parentId);
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }

  // Keep a continuation in its parent's row and reserve contiguous rows for each subtree.
  const pending = roots.reverse().map((entry) => ({ entry, depth: 0, newRow: true }));
  let row = -1;
  let maxDepth = 0;
  while (pending.length) {
    const { entry, depth, newRow } = pending.pop();
    if (newRow) row += 1;
    entry.x = padding + depth * columnWidth;
    entry.y = padding + row * rowHeight;
    maxDepth = Math.max(maxDepth, depth);
    const continuation = entry.children.find(({ node }) => !node.fork);
    for (let index = entry.children.length - 1; index >= 0; index -= 1) {
      const child = entry.children[index];
      if (child !== continuation) pending.push({ entry: child, depth: depth + 1, newRow: true });
    }
    if (continuation) pending.push({ entry: continuation, depth: depth + 1, newRow: false });
  }

  return { byId, width: padding * 2 + maxDepth * columnWidth + cardWidth,
    height: padding * 2 + Math.max(0, row) * rowHeight + cardHeight };
}

function edgePath(parent, entry) {
  const x1 = parent.x + cardWidth;
  const y1 = parent.y + cardHeight / 2;
  const x2 = entry.x;
  const y2 = entry.y + cardHeight / 2;
  const bend = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`;
}

function relationText(node, parent) {
  if (node.parentId == null) return '起始版本';
  if (!parent) return '父版本未显示';
  return `${node.fork ? 'Fork 自' : '更新自'}版本 ${parent.node.number}`;
}

function keepVisible(start, size, scroll, viewportSize) {
  return Math.max(start + size + padding - viewportSize, Math.min(scroll, start - padding));
}

export function createDesignVersionGraph(React) {
  const h = React.createElement;
  return function DesignVersionGraph({ nodes = emptyNodes, selectedId, onSelect, onFork, onContinue,
    onCancelDraft, onNodeMenu, canAct, canCancelDraft = true, loading, error, onRetry }) {
    const viewport = React.useRef(null);
    const pan = React.useRef(null);
    const descriptionId = React.useId();
    const { byId, width, height } = React.useMemo(() => layoutGraph(nodes), [nodes]);
    const selected = byId.get(selectedId);
    const selectedX = selected?.x;
    const selectedY = selected?.y;

    React.useEffect(() => {
      const scroll = viewport.current;
      if (!scroll || selectedX === undefined) return;
      scroll.scrollLeft = keepVisible(selectedX, cardWidth, scroll.scrollLeft, scroll.clientWidth);
      scroll.scrollTop = keepVisible(selectedY, cardHeight, scroll.scrollTop, scroll.clientHeight);
    }, [selectedId, selectedX, selectedY]);

    function startPan(event) {
      if (event.pointerType !== 'mouse' || event.button !== 0 ||
          !event.target.closest('.vc-version-graph-plane') || event.target.closest('button')) return;
      const scroll = event.currentTarget;
      if (scroll.scrollWidth <= scroll.clientWidth && scroll.scrollHeight <= scroll.clientHeight) return;
      pan.current = { id: event.pointerId, x: event.clientX + scroll.scrollLeft, y: event.clientY + scroll.scrollTop };
      scroll.setPointerCapture(event.pointerId);
      scroll.dataset.panning = 'true';
      event.preventDefault();
    }

    function movePan(event) {
      if (pan.current?.id !== event.pointerId) return;
      event.currentTarget.scrollLeft = pan.current.x - event.clientX;
      event.currentTarget.scrollTop = pan.current.y - event.clientY;
    }

    function stopPan(event) {
      if (pan.current?.id !== event.pointerId) return;
      pan.current = null;
      delete event.currentTarget.dataset.panning;
    }

    const action = (label, handler, disabled) => h('button', {
      className: 'vc-button', type: 'button', disabled, onClick: handler,
    }, label);
    const graphNodes = [...byId.values()].map((entry, index) => {
      const { node, x, y } = entry;
      const ready = node.status === 'ready';
      const menu = onNodeMenu && (ready || node.status === 'draft') ? (event) => onNodeMenu(event, node) : undefined;
      const title = node.status === 'draft' ? '分支草稿' : `版本 ${node.number} · ${node.title}`;
      const state = { running: '生成中', unknown: '待确认', failed: '已结束，暂无画板', draft: '待发送' }[node.status];
      const relation = relationText(node, byId.get(node.parentId));
      const description = `${descriptionId}-${index}`;
      return h('button', {
        key: node.id, className: 'vc-button vc-version-graph-node', type: 'button',
        style: { left: x, top: y, width: cardWidth, height: cardHeight },
        'data-version-id': node.id, 'data-parent-id': node.parentId ?? '', 'data-fork': node.fork,
        'data-status': node.status, 'aria-label': title, 'aria-describedby': description,
        'aria-pressed': selectedId === node.id, 'aria-disabled': !ready, tabIndex: ready ? undefined : -1,
        'aria-haspopup': menu ? 'menu' : undefined,
        onContextMenu: menu, onKeyDown: menu ? (event) => { if (contextMenuKey(event)) menu(event); } : undefined,
        onClick: ready ? () => onSelect(node.id) : undefined, title,
      }, h('span', null, title), h('span', { id: description }, state ? `${relation} · ${state}` : relation));
    });
    const edges = [...byId.values()].map((entry) => {
      const parent = byId.get(entry.node.parentId);
      return parent && h('path', { key: entry.node.id, d: edgePath(parent, entry), 'data-fork': entry.node.fork });
    });

    return h('section', { className: 'vc-version-graph', 'aria-label': '版本拓扑' },
      h('style', null, graphCss),
      h('div', { className: 'vc-version-graph-bar' }, h('strong', null, '版本拓扑'),
        selected?.node.status === 'ready' && h('div', { className: 'vc-version-graph-actions' },
          action('从此版本 Fork', () => onFork(selectedId), !canAct),
          selected.node.canContinue && action('继续此分支', () => onContinue(selectedId), !canAct)),
        selected?.node.status === 'draft' && action('取消分支草稿', onCancelDraft, !canCancelDraft)),
      error && h('p', { className: 'vc-version-graph-status', role: 'alert' }, error,
        action('重试', onRetry, loading)),
      loading && h('p', { className: 'vc-version-graph-status', role: 'status' }, '正在读取版本…'),
      !nodes.length && !loading && !error && h('p', { className: 'vc-version-graph-status' }, '暂无设计版本'),
      nodes.length > 0 && h('div', {
        ref: viewport, className: 'vc-version-graph-scroll', role: 'group', 'aria-label': '版本', tabIndex: 0,
        onPointerDown: startPan, onPointerMove: movePan, onLostPointerCapture: stopPan,
      }, h('div', { className: 'vc-version-graph-plane', style: { width, height } },
        h('svg', { className: 'vc-version-graph-edges', width, height, 'aria-hidden': true }, edges), graphNodes)));
  };
}
