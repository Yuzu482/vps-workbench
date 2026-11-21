import { contextMenuKey } from './context-menu.js';
import { playgroundPositionLimit } from './design-state.js';

const desktopSize = { width: 324, height: 240, previewHeight: 700 };
const mobileSize = { width: 180, height: 348, previewHeight: 700 };
const initialCamera = { x: 0, y: 0, scale: 1 };
const emptyPositions = {};
const emptyLinks = [];
const minScale = .001;
const maxScale = 5;
const zoomStep = 1.25;
const maxVisiblePreviews = 24;
const keyboardDirections = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const pointSize = { width: 0, height: 0 };

const playgroundCss = `
  [data-vps-chat] .vc-playground {
    display:flex; flex:1; flex-direction:column; min-width:0; min-height:0;
    container:design-playground / inline-size;
  }
  [data-vps-chat] .vc-playground-viewport {
    position:relative; flex:1; min-width:0; min-height:0; overflow:clip; isolation:isolate;
    touch-action:none; user-select:none; cursor:crosshair;
    background-color:var(--vc-stage);
    background-image:radial-gradient(var(--vc-stage-dot) .9px, transparent .9px);
    background-size:18px 18px;
  }
  [data-vps-chat] .vc-playground-viewport:focus-visible {outline-offset:-2px}
  [data-vps-chat] .vc-playground-viewport[data-panning=true] {cursor:grab}
  [data-vps-chat] .vc-playground-viewport[data-dragging=true] {cursor:grabbing}
  [data-vps-chat] .vc-playground-marquee {
    position:absolute; z-index:3; pointer-events:none; box-sizing:border-box;
    border:1px solid var(--vc-accent); border-radius:2px;
    background:color-mix(in srgb,var(--vc-accent) 16%,transparent);
  }
  [data-vps-chat] .vc-playground-card {
    position:absolute; display:flex; flex-direction:column; box-sizing:border-box;
    border-radius:8px; background:var(--vc-surface); color:var(--vc-ink);
    box-shadow:0 0 0 1px var(--vc-line-strong),var(--vc-card-shadow);
    cursor:pointer;
  }
  [data-vps-chat] .vc-playground-card[data-selected=true] {
    z-index:1; box-shadow:0 0 0 2px var(--vc-accent),var(--vc-card-shadow);
  }
  [data-vps-chat] .vc-playground-card[data-moving=true] {z-index:2; cursor:grabbing}
  [data-vps-chat] .vc-playground-card[data-provisional=true] {outline:1px dashed var(--vc-accent)}
  [data-vps-chat] .vc-playground-card[data-provisional=true] .vc-playground-card-title {color:var(--vc-muted)}
  [data-vps-chat] .vc-playground-card-title {
    flex:none; height:min(28px,36%); overflow:hidden; padding:0 8px; border:0; border-radius:8px 8px 0 0;
    background:transparent; color:inherit; cursor:grab; text-align:start; text-overflow:ellipsis;
    white-space:nowrap; font-size:12px; font-weight:600;
  }
  [data-vps-chat] .vc-playground-card[data-moving=true] .vc-playground-card-title {cursor:grabbing}
  [data-vps-chat] .vc-playground-card-title:focus-visible {outline-offset:-3px}
  [data-vps-chat] .vc-playground-card-title:hover {background:var(--vc-hover)}
  [data-vps-chat] .vc-playground-card[data-selected=true] .vc-playground-card-title {
    background:var(--vc-tint); color:var(--vc-accent);
  }
  [data-vps-chat] .vc-playground-card[data-compact=true] .vc-playground-card-title {padding-inline:3px; font-size:10px}
  [data-vps-chat] .vc-playground-preview {
    position:relative; flex:1; min-height:0; overflow:hidden; border-radius:0 0 8px 8px;
    background:var(--vc-canvas); pointer-events:none;
  }
  [data-vps-chat] .vc-playground-preview iframe {
    position:absolute; inset:0 auto auto 0; display:block; border:0; background:var(--vc-surface);
    transform-origin:top left; pointer-events:none;
  }
  [data-vps-chat] .vc-playground-link {
    position:absolute; height:1px; background:var(--vc-accent); opacity:.54;
    transform-origin:left center; pointer-events:none;
  }
  [data-vps-chat] .vc-playground-link::after {
    content:''; position:absolute; right:1px; top:-3px; width:6px; height:6px;
    border:solid var(--vc-accent); border-width:1px 1px 0 0; transform:rotate(45deg);
  }
  [data-vps-chat] .vc-playground-empty {
    position:absolute; inset:0; display:grid; place-content:center; justify-items:center; gap:8px;
    padding:16px; text-align:center; cursor:default; pointer-events:none;
  }
  [data-vps-chat] .vc-playground-empty p {margin:0; color:var(--vc-muted); font-size:13px}
  [data-vps-chat] .vc-playground-empty button {pointer-events:auto}
  [data-vps-chat] .vc-playground-progress {
    position:absolute; z-index:3; inset:8px 0 auto; width:fit-content; margin:0 auto; padding:4px 9px;
    border:1px solid var(--vc-line); border-radius:8px; background:var(--vc-surface);
    color:var(--vc-muted); font-size:12px; pointer-events:none;
  }
  [data-vps-chat] .vc-playground-progress[data-empty=true] {top:50%; transform:translateY(-50%)}
  [data-vps-chat] .vc-playground-controls {
    display:flex; flex-wrap:wrap; flex:none; align-items:center; justify-content:space-between;
    gap:3px 12px; padding:5px 9px; border-top:1px solid var(--vc-line); background:var(--vc-surface);
  }
  [data-vps-chat] :is(.vc-playground-actions,.vc-playground-secondary,.vc-playground-camera,.vc-playground-attachment,.vc-playground-selection) {
    display:flex; align-items:center; flex-wrap:wrap; gap:2px; min-width:0; font-size:12px;
  }
  [data-vps-chat] .vc-playground-selection {gap:6px; color:var(--vc-accent); font-weight:600}
  [data-vps-chat] .vc-playground-controls .vc-button {
    min-height:28px; padding:3px 7px;
    transition:background-color var(--vc-control-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-playground-controls .vc-playground-more {display:none}
  [data-vps-chat] .vc-playground-camera {margin-inline-start:auto; color:var(--vc-muted); flex-wrap:nowrap}
  [data-vps-chat] .vc-playground-camera output {min-width:38px; text-align:center; font-variant-numeric:tabular-nums}
  [data-vps-chat] .vc-playground-camera .vc-playground-step {min-width:27px; font-size:16px; line-height:1}
  [data-vps-chat] .vc-playground-attachment {max-width:100%; color:var(--vc-accent)}
  [data-vps-chat] .vc-playground-attachment span {
    max-width:180px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
  }
  @container design-playground (max-width:700px) {
    [data-vps-chat] .vc-playground-actions[data-more=true] .vc-playground-secondary {display:none}
    [data-vps-chat] .vc-playground-controls .vc-playground-more {display:inline-flex}
    [data-vps-chat] .vc-playground-attachment {order:1}
    [data-vps-chat] .vc-playground-controls:has(.vc-playground-actions[data-more=true]) .vc-playground-attachment {display:none}
    [data-vps-chat] .vc-playground-attachment span {max-width:calc(100cqi - 56px)}
  }
`;

function projectPosition(position, camera) {
  return { x: position.x * camera.scale + camera.x, y: position.y * camera.scale + camera.y };
}

function sceneBounds(positions, size) {
  if (!positions.size) return null;
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const { x, y } of positions.values()) {
    bounds.left = Math.min(bounds.left, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.right = Math.max(bounds.right, x + size.width);
    bounds.bottom = Math.max(bounds.bottom, y + size.height);
  }
  return bounds;
}

function translateBoards(positions, dx, dy) {
  const { left, right, top, bottom } = sceneBounds(positions, pointSize);
  const offset = (delta, start, end) => Math.max(-playgroundPositionLimit - start,
    Math.min(playgroundPositionLimit - end, Math.round(delta)));
  const x = offset(dx, left, right);
  const y = offset(dy, top, bottom);
  return new Map([...positions].map(([id, point]) => [id, { x: point.x + x, y: point.y + y }]));
}

function addsToSelection(event) {
  return event.shiftKey || event.ctrlKey || event.metaKey;
}

function fitScene(bounds, space) {
  const { width, contentHeight } = space;
  const padding = Math.min(32, width / 8, contentHeight / 8);
  const scale = Math.min(1.25, (space.width - padding * 2) / (bounds.right - bounds.left),
    (contentHeight - padding * 2) / (bounds.bottom - bounds.top));
  return {
    x: (width - (bounds.left + bounds.right) * scale) / 2,
    y: (contentHeight - (bounds.top + bounds.bottom) * scale) / 2,
    scale,
  };
}

function zoomAt(camera, factor, point) {
  const scale = Math.min(maxScale, Math.max(Math.min(minScale, camera.scale), camera.scale * factor));
  if (scale === camera.scale) return camera;
  const ratio = scale / camera.scale;
  return { x: point.x - (point.x - camera.x) * ratio, y: point.y - (point.y - camera.y) * ratio, scale };
}

function isNearViewport(position, width, height, space) {
  const overscan = 180;
  return width >= 48 && position.x + width >= -overscan && position.y + height >= -overscan &&
    position.x <= space.width + overscan && position.y <= space.height + overscan;
}

function linkStyle(from, to, width, height) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const edge = Math.min(width / 2 / Math.abs(dx), height / 2 / Math.abs(dy));
  const length = distance * (1 - edge * 2);
  if (!(length > 8)) return null;
  return {
    left: from.x + width / 2 + dx * edge,
    top: from.y + height / 2 + dy * edge,
    width: length,
    transform: `rotate(${Math.atan2(dy, dx)}rad)`,
  };
}

export function createDesignPlayground(React) {
  const h = React.createElement;
  const PreviewFrame = React.memo(function PreviewFrame({ title, html, width, height, scale }) {
    return h('iframe', {
      title, sandbox: '', referrerPolicy: 'no-referrer', tabIndex: -1, loading: 'lazy', srcDoc: html,
      style: { width, height, transform: `scale(${scale})` },
    });
  });

  return function DesignPlayground({
    boards, positions = emptyPositions, links = emptyLinks, selectedId, onSelect, onMove,
    onEdit, onIterate, onVariants, onLink, onPlay, onPrompt, onClearAttachment, attachedId,
    onBoardMenu, onSelectionMenu, onBackgroundMenu, onMoreMenu, onExportSelection, exporting,
    generating, loading, canGenerate, revealBoard, conversation, previewWidth = 1080,
  }) {
    const viewport = React.useRef(null);
    const gesture = React.useRef(null);
    const ignoreClick = React.useRef(false);
    const animation = React.useRef(0);
    const revealed = React.useRef(null);
    const panKey = React.useRef(false);
    const [space, setSpace] = React.useState(null);
    const [camera, setCamera] = React.useState(null);
    const [drag, setDrag] = React.useState(null);
    const [panReady, setPanReady] = React.useState(false);
    const [selection, setSelection] = React.useState(null);
    const size = previewWidth === 390 ? mobileSize : desktopSize;
    const layout = React.useMemo(() => new Map(boards.map((board, index) => [board.id, positions[board.id] ?? {
      x: (index % 3) * (desktopSize.width + 54),
      y: Math.floor(index / 3) * (mobileSize.height + 52),
    }])), [boards, positions]);
    const readyIds = React.useMemo(() => new Set(boards.filter(({ provisional }) => !provisional).map(({ id }) => id)), [boards]);
    const selectedIds = React.useMemo(() => {
      const ids = selection?.primary === selectedId && selection.reveal === revealBoard ? selection.ids : [selectedId];
      return new Set([...ids].filter((id) => layout.has(id)));
    }, [selection, selectedId, revealBoard, layout]);
    const displayedIds = drag?.selection ?? selectedIds;
    const bounds = React.useMemo(() => sceneBounds(layout, size), [layout, size]);
    const visiblePreviews = React.useMemo(() => {
      if (!space || !camera) return new Set();
      const visible = [];
      for (const [id, position] of layout) {
        const origin = projectPosition(position, camera);
        if (isNearViewport(origin, size.width * camera.scale, size.height * camera.scale, space)) {
          const dx = origin.x + size.width * camera.scale / 2 - space.width / 2;
          const dy = origin.y + size.height * camera.scale / 2 - space.height / 2;
          visible.push([id, selectedIds.has(id) ? -1 : dx * dx + dy * dy]);
        }
      }
      visible.sort((a, b) => a[1] - b[1]);
      return new Set(visible.slice(0, maxVisiblePreviews).map(([id]) => id));
    }, [layout, size, space, camera, selectedIds]);
    const view = drag?.camera ?? camera ?? initialCamera;
    const cardWidth = size.width * view.scale;
    const cardHeight = size.height * view.scale;
    const selectedBoards = boards.filter(({ id }) => selectedIds.has(id));
    const selected = selectedBoards.length === 1 ? selectedBoards[0] : null;
    const attachment = boards.find((board) => board.id === attachedId);
    const hasScene = Boolean(camera && bounds);
    const busy = generating || loading;
    const locked = busy || selected?.provisional;
    const status = loading ? '正在加载画板' : generating ? '正在生成画板' : '';

    React.useLayoutEffect(() => {
      const element = viewport.current;
      const dock = element.parentElement.querySelector('.vc-canvas-conversation .vc-compose-area');
      const observer = new ResizeObserver(() => {
        const { width, height, top } = element.getBoundingClientRect();
        if (width > 0 && height > 0) {
          const contentHeight = dock
            ? Math.max(height / 3, Math.min(height, Math.round(dock.getBoundingClientRect().top - top) - 10)) : height;
          setSpace((current) => current?.width === width && current.height === height && current.contentHeight === contentHeight
            ? current : { width, height, contentHeight });
        }
      });
      observer.observe(element);
      if (dock) observer.observe(dock);
      return () => observer.disconnect();
    }, []);

    React.useLayoutEffect(() => {
      if (!camera && space && bounds) setCamera(fitScene(bounds, space));
    }, [camera, space, bounds]);

    React.useLayoutEffect(() => {
      if (!revealBoard || revealed.current === revealBoard || !space || !camera || !layout.has(revealBoard.id)) return;
      revealed.current = revealBoard;
      reveal(revealBoard.id);
    }, [revealBoard, space, camera, layout]);

    React.useLayoutEffect(() => {
      setSelection((current) => current && (current.primary !== selectedId || current.reveal !== revealBoard) ? null : current);
    }, [selectedId, revealBoard]);

    React.useEffect(() => () => cancelAnimationFrame(animation.current), []);

    React.useEffect(() => {
      const node = viewport.current;
      function press(event) {
        if (event.code !== 'Space' || event.defaultPrevented || event.isComposing || event.altKey ||
            event.ctrlKey || event.metaKey || gesture.current || !(node.contains(event.target) ||
              (event.target === document.body && node.matches(':hover')))) return;
        if (!event.target.matches?.('.vc-playground-card-title')) event.preventDefault();
        panKey.current = true;
        setPanReady(true);
      }
      function release() {
        panKey.current = false;
        setPanReady(false);
      }
      function keyUp(event) {
        if (event.code === 'Space') release();
      }
      window.addEventListener('keydown', press);
      window.addEventListener('keyup', keyUp);
      window.addEventListener('blur', release);
      return () => {
        window.removeEventListener('keydown', press);
        window.removeEventListener('keyup', keyUp);
        window.removeEventListener('blur', release);
      };
    }, []);

    React.useEffect(() => {
      if (!hasScene) return undefined;
      const node = viewport.current;
      function wheel(event) {
        event.preventDefault();
        if (gesture.current) return;
        const box = node.getBoundingClientRect();
        const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1;
        if (!event.deltaY) {
          if (event.deltaX) setCamera((current) => ({ ...current, x: current.x - event.deltaX * deltaUnit }));
          return;
        }
        const point = { x: event.clientX - box.left, y: event.clientY - box.top };
        const delta = Math.max(-240, Math.min(240, event.deltaY * deltaUnit));
        setCamera((current) => zoomAt(current ?? initialCamera, Math.exp(-delta * .0018), point));
      }
      node.addEventListener('wheel', wheel, { passive: false });
      return () => node.removeEventListener('wheel', wheel);
    }, [hasScene]);

    function selectBoards(ids, preferred = selectedId) {
      const primary = ids.has(preferred) ? preferred : ids.values().next().value;
      setSelection({ primary: primary ?? selectedId, reveal: revealBoard, ids });
      if (primary) onSelect(primary);
    }

    function toggleBoard(board) {
      if (board.provisional) return;
      const next = new Set([...selectedIds].filter((id) => readyIds.has(id)));
      if (!next.delete(board.id)) next.add(board.id);
      selectBoards(next);
    }

    function moveGroup(board) {
      const ids = selectedIds.has(board.id) ? [...selectedIds].filter((id) => readyIds.has(id)) : [board.id];
      return new Map(ids.map((id) => [id, layout.get(id)]));
    }

    function startPointer(event, board) {
      if (!event.isPrimary || (event.button !== 0 && event.button !== 1) || gesture.current) return;
      ignoreClick.current = false;
      if (!camera) return;
      const pan = event.button === 1 || panKey.current || (!board && event.pointerType === 'touch');
      if (!pan && board && (busy || board.provisional || addsToSelection(event))) return;
      const node = viewport.current;
      const capture = pan ? node : event.target.closest('button') ?? event.currentTarget;
      if (!board || pan) node.focus({ preventScroll: true });
      if (pan) event.preventDefault();
      try {
        capture.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      const box = node.getBoundingClientRect();
      const kind = pan ? 'pan' : board ? 'move' : 'select';
      const moving = kind === 'move' ? moveGroup(board) : null;
      gesture.current = {
        pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        capture, camera, kind, draft: null, moving, moveSelection: moving && new Set(moving.keys()),
        startX: event.clientX - box.left, startY: event.clientY - box.top,
        additive: addsToSelection(event),
      };
    }

    function marqueeSelection(active, dx, dy) {
      const { startX, startY, camera } = active;
      const left = Math.min(startX, startX + dx);
      const top = Math.min(startY, startY + dy);
      const width = Math.abs(dx);
      const height = Math.abs(dy);
      const next = new Set(active.additive ? [...selectedIds].filter((id) => readyIds.has(id)) : []);
      for (const [id, position] of layout) {
        if (!readyIds.has(id)) continue;
        const { x, y } = projectPosition(position, camera);
        if (x < left + width && x + size.width * camera.scale > left &&
            y < top + height && y + size.height * camera.scale > top) next.add(id);
      }
      return { marquee: { left, top, width, height }, selection: next };
    }

    function movePointer(event) {
      const active = gesture.current;
      if (active?.pointerId !== event.pointerId) return;
      const dx = event.clientX - active.clientX;
      const dy = event.clientY - active.clientY;
      if (!active.draft && Math.hypot(dx, dy) < 4) return;
      if (active.kind === 'pan') {
        active.draft = { camera: { ...active.camera, x: active.camera.x + dx, y: active.camera.y + dy } };
      } else if (active.kind === 'move') {
        active.draft = { positions: translateBoards(active.moving, dx / active.camera.scale, dy / active.camera.scale),
          selection: active.moveSelection };
      } else {
        active.draft = marqueeSelection(active, dx, dy);
      }
      if (!animation.current) {
        animation.current = requestAnimationFrame(() => {
          animation.current = 0;
          setDrag(gesture.current?.draft ?? null);
        });
      }
    }

    function commitMove(original, moved) {
      if (busy || [...original].some(([id, { x, y }]) => !readyIds.has(id) ||
          layout.get(id)?.x !== x || layout.get(id).y !== y)) return false;
      if ([...moved].some(([id, { x, y }]) => x !== original.get(id).x || y !== original.get(id).y)) onMove(moved);
      return true;
    }

    function endPointer(commit) {
      const active = gesture.current;
      if (!active) return;
      gesture.current = null;
      cancelAnimationFrame(animation.current);
      animation.current = 0;
      if (active.capture.hasPointerCapture(active.pointerId)) active.capture.releasePointerCapture(active.pointerId);
      setDrag(null);
      ignoreClick.current = Boolean(active.draft || active.kind === 'pan');
      if (!commit || !active.draft) return;
      const { positions: moved, selection, camera: movedCamera } = active.draft;
      if (movedCamera) {
        setCamera(movedCamera);
      } else if (moved) {
        if (commitMove(active.moving, moved)) selectBoards(selection);
      } else {
        selectBoards(selection);
      }
    }

    function zoom(factor) {
      if (!space || gesture.current) return;
      const center = { x: space.width / 2, y: space.contentHeight / 2 };
      setCamera((current) => zoomAt(current ?? initialCamera, factor, center));
    }

    function fitAll() {
      if (bounds && space && !gesture.current) setCamera(fitScene(bounds, space));
    }

    function reveal(boardId) {
      if (!space || !camera) return;
      const position = projectPosition(layout.get(boardId), camera);
      if (position.x >= 0 && position.x + Math.min(40, cardWidth) <= space.width &&
          position.y >= 0 && position.y + Math.min(28, cardHeight) <= space.contentHeight) return;
      setCamera({
        ...camera,
        x: camera.x + (space.width - cardWidth) / 2 - position.x,
        y: camera.y + Math.max(12, (space.contentHeight - cardHeight) / 2) - position.y,
      });
    }

    function boardContext(event, anchor, board) {
      if (gesture.current) return;
      if (onSelectionMenu && selectedIds.has(board.id) && selectedBoards.length > 1) {
        onSelectionMenu(event, anchor, selectedBoards);
      } else onBoardMenu?.(event, anchor, board);
    }

    function boardKeys(event, board) {
      if (onBoardMenu && contextMenuKey(event)) {
        boardContext(event, event.currentTarget, board);
        return;
      }
      if (event.altKey || event.nativeEvent.isComposing || gesture.current) return;
      if (event.key === 'Enter' && addsToSelection(event)) {
        event.preventDefault();
        toggleBoard(board);
        return;
      }
      if (event.ctrlKey || event.metaKey) return;
      if (event.key === 'F2' && !busy && !board.provisional) {
        event.preventDefault();
        onSelect(board.id);
        onEdit(board.id);
        return;
      }
      if (!Object.hasOwn(keyboardDirections, event.key) || busy || board.provisional) return;
      const direction = keyboardDirections[event.key];
      event.preventDefault();
      const step = (event.shiftKey ? 48 : 12) / (camera?.scale ?? 1);
      const group = moveGroup(board);
      if (commitMove(group, translateBoards(group, direction[0] * step, direction[1] * step))) {
        selectBoards(new Set(group.keys()));
      }
    }

    function viewportKeys(event) {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape' && (gesture.current || selectedIds.size > 0)) {
        event.preventDefault();
        event.stopPropagation();
        if (gesture.current) endPointer(false);
        else selectBoards(new Set());
        return;
      }
      if (!gesture.current && !event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && readyIds.size) {
        event.preventDefault();
        event.stopPropagation();
        selectBoards(readyIds);
        return;
      }
      if (onBackgroundMenu && event.target === event.currentTarget && contextMenuKey(event)) {
        backgroundMenu(event);
        return;
      }
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || !bounds) return;
      if (event.key === '+' || event.key === '=') zoom(zoomStep);
      else if (event.key === '-') zoom(1 / zoomStep);
      else if (event.key === '0') fitAll();
      else if (Object.hasOwn(keyboardDirections, event.key) && !gesture.current) {
        const [dx, dy] = keyboardDirections[event.key];
        const step = event.shiftKey ? 160 : 48;
        setCamera((current) => ({ ...(current ?? initialCamera), x: (current?.x ?? 0) - dx * step, y: (current?.y ?? 0) - dy * step }));
      } else return;
      event.preventDefault();
    }

    function boardPoint(id) {
      return projectPosition(drag?.positions?.get(id) ?? layout.get(id), view);
    }

    function backgroundMenu(event) {
      if (!onBackgroundMenu || event.target !== event.currentTarget || gesture.current) return;
      onBackgroundMenu(event, event.currentTarget, [
        { id: 'select-all', label: '全选画板', icon: 'select-all', disabled: !readyIds.size, run: () => selectBoards(readyIds) },
        { id: 'clear-selection', label: '清除画板选择', icon: 'canvas', disabled: !selectedIds.size, run: () => selectBoards(new Set()) },
        { id: 'fit-all', label: '适应全部画板', icon: 'fit', disabled: !bounds || !space, run: fitAll },
        { id: 'zoom-in', label: '放大画布', icon: 'zoom-in', disabled: !camera || view.scale >= maxScale, run: () => zoom(zoomStep) },
        { id: 'zoom-out', label: '缩小画布', icon: 'zoom-out', disabled: !camera || view.scale <= minScale, run: () => zoom(1 / zoomStep) },
      ]);
    }

    function toolbarButton(label, run, disabled, content = label, extraClass = '') {
      return h('button', { type: 'button', className: `vc-button ${extraClass}`, title: label,
        'aria-label': label, disabled: Boolean(disabled), onClick: run }, content);
    }

    const boardActions = selected ? [
      { id: 'iterate', label: '迭代所选', icon: 'chat', disabled: locked || !canGenerate, run: () => onIterate(selected.id) },
      { id: 'variants', label: '生成变体', icon: 'variants', disabled: locked || !canGenerate, run: () => onVariants(selected.id) },
      { id: 'link', label: '连接画板', icon: 'link', disabled: locked, run: () => onLink(selected.id) },
      { id: 'play', label: '播放原型', icon: 'play', disabled: loading || selected.provisional, run: () => onPlay(selected.id) },
    ] : [];
    const cannotExportSelection = exporting || selectedBoards.some(({ provisional, html }) => provisional || !html);

    function exportSelection(event) {
      if (!cannotExportSelection) onExportSelection(event, selectedBoards);
    }

    function openMore(event) {
      const anchor = event.currentTarget;
      const { left, bottom } = anchor.getBoundingClientRect();
      const attachmentActions = attachment ? [{ id: 'clear-attachment', label: '移除画板附件', icon: 'undo',
        detail: attachment.title, disabled: busy, run: onClearAttachment }] : [];
      onMoreMenu(event, anchor, '更多画板操作', [boardActions, attachmentActions],
        { point: { x: left, y: bottom }, tracksExpansion: true });
    }

    const zoomPercent = view.scale < .1 ? Math.round(view.scale * 1000) / 10 : Math.round(view.scale * 100);
    return h('div', { className: 'vc-playground' },
      h('style', null, playgroundCss),
      h('div', { className: 'vc-design-surface' },
        h('div', {
          ref: viewport, className: 'vc-playground-viewport', role: 'region', tabIndex: 0, 'aria-label': '多画板画布',
          'aria-keyshortcuts': 'Control+A Meta+A Escape Shift+F10 ArrowLeft ArrowRight ArrowUp ArrowDown = - 0',
          'data-panning': panReady, 'data-dragging': Boolean(drag?.camera), onKeyDown: viewportKeys, onContextMenu: backgroundMenu,
          onClick: (event) => {
            if (event.target === event.currentTarget && !ignoreClick.current && !addsToSelection(event)) selectBoards(new Set());
          },
          onPointerDown: (event) => { if (event.target === event.currentTarget) startPointer(event); },
          onPointerMove: movePointer,
          onPointerUp: (event) => {
            if (event.pointerId !== gesture.current?.pointerId) return;
            movePointer(event);
            endPointer(true);
          },
          onPointerCancel: (event) => { if (event.pointerId === gesture.current?.pointerId) endPointer(false); },
          onLostPointerCapture: (event) => { if (event.pointerId === gesture.current?.pointerId) endPointer(false); },
        },
          drag?.marquee ? h('div', { className: 'vc-playground-marquee', style: drag.marquee, 'aria-hidden': true }) : null,
          camera && links.map(({ from, to }) => {
            if (!layout.has(from) || !layout.has(to)) return null;
            const style = linkStyle(boardPoint(from), boardPoint(to), cardWidth, cardHeight);
            return style && h('div', {
              key: `${from}:${to}`, className: 'vc-playground-link', style, 'aria-hidden': true,
              'data-board-link-from': from, 'data-board-link-to': to,
            });
          }),
          camera && boards.map((board) => {
            const point = boardPoint(board.id);
            const detail = `${board.title} · 版本 ${board.version}${board.provisional ? ' · 生成中' : ''}`;
            return h('article', {
              key: board.id, className: 'vc-playground-card', title: detail,
              'data-board-id': board.id, 'data-selected': displayedIds.has(board.id),
              'data-moving': Boolean(drag?.positions?.has(board.id)), 'data-provisional': Boolean(board.provisional),
              'data-compact': cardWidth < 105,
              style: { left: point.x, top: point.y, width: cardWidth, height: cardHeight },
              onPointerDown: (event) => startPointer(event, board),
              onContextMenu: onBoardMenu ? (event) => {
                boardContext(event, event.currentTarget.querySelector('.vc-playground-card-title'), board);
              } : undefined,
              onClick: (event) => {
                if (event.detail !== 0 && ignoreClick.current) return;
                if (addsToSelection(event)) toggleBoard(board);
                else selectBoards(new Set([board.id]), board.id);
              },
              onDoubleClick: (event) => { if (!ignoreClick.current && !addsToSelection(event) && !busy && !board.provisional) onEdit(board.id); },
            },
              h('button', {
                type: 'button', className: 'vc-playground-card-title', 'aria-pressed': displayedIds.has(board.id),
                'aria-haspopup': onBoardMenu ? 'menu' : undefined,
                'aria-keyshortcuts': busy || board.provisional ? 'Shift+F10'
                  : 'Shift+F10 Shift+Enter Control+Enter Meta+Enter F2 ArrowLeft ArrowRight ArrowUp ArrowDown',
                onKeyDown: (event) => boardKeys(event, board),
                onFocus: (event) => { if (event.currentTarget.matches(':focus-visible')) reveal(board.id); },
              }, board.title),
              h('div', { className: 'vc-playground-preview', 'aria-hidden': true },
                visiblePreviews.has(board.id) && board.html ? h(PreviewFrame, {
                  title: detail, html: board.html, width: previewWidth, height: size.previewHeight, scale: cardWidth / previewWidth,
                }) : null));
          }),
          status ? h('p', { className: 'vc-playground-progress', role: 'status', 'data-empty': !boards.length }, status) : null,
          !boards.length && !status && !conversation ? h('div', { className: 'vc-playground-empty' },
            h('p', null, '描述要生成的界面。'),
            toolbarButton('编写设计提示', onPrompt, !canGenerate, '编写设计提示', 'vc-primary')) : null),
        conversation),
      h('div', { className: 'vc-playground-controls' },
        selectedBoards.length > 1 ? h('div', { className: 'vc-playground-selection' },
          h('output', { 'aria-label': '已选画板', 'aria-live': 'polite' }, `已选 ${selectedBoards.length} 张画板`),
          h('button', { type: 'button', className: 'vc-button vc-export-trigger', 'aria-haspopup': 'menu', 'aria-expanded': false,
            'aria-disabled': Boolean(cannotExportSelection), onClick: exportSelection,
            onKeyDown(event) {
              if (['ArrowDown', 'ArrowUp'].includes(event.key) && !event.nativeEvent.isComposing) exportSelection(event);
            },
          }, `导出所选（${selectedBoards.length}）`),
          toolbarButton('清除画板选择', () => selectBoards(new Set()), false, '×')) : null,
        selected ? h('div', { className: 'vc-playground-actions', role: 'group', 'aria-label': '所选画板操作', 'data-more': Boolean(onMoreMenu) },
          toolbarButton('编辑画板', () => onEdit(selected.id), locked),
          h('div', { className: 'vc-playground-secondary' }, boardActions.map(({ id, label, run, disabled }) =>
            h('button', { key: id, type: 'button', className: 'vc-button', disabled, onClick: run }, label))),
          onMoreMenu ? h('button', { type: 'button', className: 'vc-button vc-playground-more',
            'aria-haspopup': 'menu', 'aria-expanded': false, 'aria-label': '更多画板操作', onClick: openMore }, '更多') : null) : null,
        attachment ? h('div', { className: 'vc-playground-attachment' },
          h('span', { title: attachment.title }, `已附加 ${attachment.title}`),
          toolbarButton('移除画板附件', onClearAttachment, busy, '×')) : null,
        h('div', { className: 'vc-playground-camera', role: 'group', 'aria-label': '画布缩放' },
          toolbarButton('缩小画布', () => zoom(1 / zoomStep), !camera || view.scale <= minScale, '−', 'vc-playground-step'),
          h('output', { 'aria-label': '当前缩放比例', 'aria-live': 'off' }, `${zoomPercent}%`),
          toolbarButton('放大画布', () => zoom(zoomStep), !camera || view.scale >= maxScale, '+', 'vc-playground-step'),
          toolbarButton('适应全部画板', fitAll, !bounds || !space, '适应全部'))));
  };
}
