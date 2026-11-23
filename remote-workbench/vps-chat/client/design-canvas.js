import { createDesignExport, downloadDesign } from '../design-export/index.js';
import { createArtboard, extractHtmlFences } from './design-preview.js';
import { carriedBoard } from './design-comparison.js';
import { createDesignControls } from './design-controls.js';
import {
  buildDesignContext, emptyBoard, maxLayerEdits, normalizeDesignStyle, normalizeEdit, readDesignProject, saveDesignProject,
  addLocalDesignVersion, serializeDesignProject, setDesignBoard, setPlaygroundLink, setPlaygroundPositions,
} from './design-state.js';
import { createDesignPlayground } from './design-playground.js';
import { designExportMenu } from './design-export-menu.js';
import { createDesignPrototype } from './design-prototype.js';
import { createDesignVersionGraph } from './design-version-graph.js';
import { designVersionNodes } from './design-version-state.js';
import { readLayerRevision, saveLayerRevisionOutcome } from './design-layer-revision.js';
import { contextMenuKey } from './context-menu.js';
import { menuIcon } from './menu-icons.js';

const viewportWidths = { desktop: 1080, mobile: 390 };
const defaultChoices = { system: false, references: false, revision: false };
const emptyHistory = { undo: [], redo: [] };
const noPlaygroundBoards = new Map();
const noHistory = [];

const canvasCss = `
  [data-vps-chat] .vc-canvas-toolbar {position:relative; flex:none}
  [data-vps-chat] .vc-canvas[data-compact=true] .vc-canvas-header {padding:6px 9px; gap:4px 8px}
  [data-vps-chat] .vc-canvas[data-compact=true] .vc-canvas-header h2 {font-size:13px}
  [data-vps-chat] .vc-canvas[data-compact=true] .vc-canvas-actions {gap:4px}
  [data-vps-chat] .vc-canvas[data-compact=true] .vc-canvas-topology {
    position:absolute; z-index:4; inset:100% 8px auto; overflow:hidden;
    border-radius:12px; background:var(--vc-surface); box-shadow:var(--vc-shadow);
  }
  [data-vps-chat] .vc-artboard-bar {
    display:flex; flex-wrap:wrap; justify-content:space-between; gap:6px 10px; padding:6px 12px; border-bottom:1px solid var(--vc-line);
  }
  [data-vps-chat] .vc-artboard-bar :is(button,select) {font-size:12px; min-height:28px; padding:3px 7px}
  [data-vps-chat] :is(.vc-artboard-tabs,.vc-artboard-controls) {display:flex; align-items:center; flex-wrap:wrap; gap:4px; min-width:0}
  [data-vps-chat] .vc-artboard-tabs button {max-width:138px; overflow:hidden; text-overflow:ellipsis}
  [data-vps-chat] .vc-artboard-tabs button:not([aria-pressed=true]) {border-color:transparent}
  [data-vps-chat] .vc-artboard-bar button[aria-pressed=true] {background:var(--vc-tint); color:var(--vc-accent)}
  [data-vps-chat] .vc-canvas-content {display:flex; flex:1; min-height:0; min-width:0}
  [data-vps-chat] .vc-canvas-content .vc-canvas-stage {justify-content:flex-start}
  [data-vps-chat] .vc-canvas-content .vc-canvas-viewport {max-width:none; margin-inline:auto}
  [data-vps-chat] .vc-canvas-content .vc-canvas-empty {margin-inline:auto}
  [data-vps-chat] .vc-design-inspector {
    width:205px; flex:none; overflow:auto; padding:10px; border-inline-start:1px solid var(--vc-line);
    background:var(--vc-surface); font-size:12px;
  }
  [data-vps-chat] .vc-layer-buttons {display:flex; flex-wrap:wrap; gap:4px; margin-block:6px}
  [data-vps-chat] .vc-layer-buttons button,
  [data-vps-chat] .vc-design-inspector button {font-size:12px; padding:4px 6px}
  [data-vps-chat] .vc-layer-fields {display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; margin-block:8px}
  [data-vps-chat] .vc-layer-wide {grid-column:1/-1}
  [data-vps-chat] :is(.vc-design-inspector,.vc-design-materials) label {display:grid; gap:3px; min-width:0}
  [data-vps-chat] :is(.vc-design-inspector,.vc-design-materials) :is(select,textarea,input:not([type=checkbox])),
  [data-vps-chat] .vc-artboard-bar select {
    min-width:0; max-width:100%; border:1px solid var(--vc-line); border-radius:6px; padding:4px;
    background:var(--vc-surface); color:var(--vc-ink);
  }
  [data-vps-chat] .vc-design-inspector :is(select,textarea,input:not([type=checkbox])) {width:100%}
  [data-vps-chat] .vc-design-inspector input[type=color] {min-height:28px}
  [data-vps-chat] .vc-design-comments {display:grid; gap:4px; margin-top:9px; padding-top:8px; border-top:1px solid var(--vc-line)}
  [data-vps-chat] .vc-design-comment-list,
  [data-vps-chat] .vc-design-image-list {padding:0; margin:8px 0; list-style:none}
  [data-vps-chat] .vc-design-comment-list li {padding:6px 0; border-top:1px solid var(--vc-line)}
  [data-vps-chat] .vc-design-comment-list p {margin:3px 0; white-space:pre-wrap; overflow-wrap:anywhere}
  [data-vps-chat] .vc-design-materials > label {margin-block:8px}
  [data-vps-chat] .vc-design-brief {min-width:0; margin:12px 0; padding:8px 10px 10px; border:1px solid var(--vc-line); border-radius:8px}
  [data-vps-chat] .vc-design-brief-fields {display:grid; grid-template-columns:repeat(auto-fit,minmax(min(185px,100%),1fr)); gap:7px}
  [data-vps-chat] .vc-design-materials .vc-design-switch-row {
    display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:34px;
    padding:4px 7px; border-radius:8px; cursor:pointer; transition:background-color var(--vc-control-duration) ease;
  }
  [data-vps-chat] .vc-design-switch-row > span {min-width:0; overflow-wrap:anywhere}
  [data-vps-chat] .vc-design-switch-row:not(:has(input:disabled)):hover {background:var(--vc-hover)}
  [data-vps-chat] .vc-design-switch-row:has(input:disabled) {color:var(--vc-muted); cursor:default}
  [data-vps-chat] .vc-design-brief .vc-design-switch-row {margin-block-start:7px}
  [data-vps-chat] .vc-design-share .vc-design-switch-row + .vc-design-switch-row {border-block-start:1px solid var(--vc-line)}
  [data-vps-chat] :is(.vc-design-style-trigger,.vc-design-review-trigger) {display:inline-flex; align-items:center; gap:6px}
  [data-vps-chat] .vc-design-style-popover {
    position:fixed; inset:auto; box-sizing:border-box; width:min(300px,calc(100vw - 16px)); margin:0; padding:12px;
    max-height:min(220px,68vh); overflow:auto; border:1px solid var(--vc-line); border-radius:11px;
    background:var(--vc-surface); color:var(--vc-ink); box-shadow:var(--vc-shadow); font-size:13px;
  }
  [data-vps-chat] .vc-design-style-popover label {font-weight:650}
  [data-vps-chat] .vc-design-style-popover output {float:inline-end; color:var(--vc-accent)}
  [data-vps-chat] .vc-design-style-popover input {
    display:block; width:100%; margin:9px 0 5px; accent-color:var(--vc-accent); cursor:pointer;
  }
  [data-vps-chat] .vc-style-endpoints {display:flex; justify-content:space-between; color:var(--vc-muted); font-size:11px}
  [data-vps-chat] .vc-design-style-popover p {margin:8px 0 0; line-height:1.5}
  [data-vps-chat] .vc-design-style-popover .vc-style-scope {color:var(--vc-muted); font-size:11px}
  [data-vps-chat] .vc-design-comparison {width:min(1120px,calc(100vw - 24px)); max-width:none; max-height:90vh; overflow:auto}
  [data-vps-chat] .vc-design-comparison h2 {margin:0 0 10px}
  [data-vps-chat] .vc-comparison-controls {display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-bottom:10px}
  [data-vps-chat] .vc-comparison-controls label {display:grid;gap:4px;min-width:0;color:var(--vc-muted)}
  [data-vps-chat] .vc-comparison-controls select {width:100%;min-width:0;padding:5px;color:var(--vc-ink);background:var(--vc-surface);border:1px solid var(--vc-line);border-radius:6px}
  [data-vps-chat] .vc-design-comparison-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  [data-vps-chat] .vc-design-comparison-grid section {display:flex;flex-direction:column;min-width:0;border:1px solid var(--vc-line);border-radius:8px;overflow:hidden}
  [data-vps-chat] .vc-design-comparison-grid header {display:grid;gap:4px;padding:8px;background:var(--vc-surface)}
  [data-vps-chat] .vc-comparison-board-title {overflow-wrap:anywhere}
  [data-vps-chat] .vc-comparison-pick {display:flex;align-items:center;gap:4px}
  [data-vps-chat] .vc-comparison-pick input {accent-color:var(--vc-accent)}
  [data-vps-chat] .vc-design-comparison-frame {margin-top:auto;height:clamp(144px,38vh,410px);overflow:auto;background:#fff}
  [data-vps-chat] .vc-comparison-sized-frame {overflow:hidden}
  [data-vps-chat] .vc-design-comparison-frame iframe {display:block;border:0;transform-origin:top left}
  [data-vps-chat] .vc-design-comparison-frame p {height:100%;box-sizing:border-box;padding:10px;color:var(--vc-muted);background:var(--vc-surface);margin:0}
  [data-vps-chat] .vc-comparison-changes {margin:8px 0;overflow-wrap:anywhere}
  [data-vps-chat] .vc-comparison-changes ul {max-height:112px;overflow:auto;margin:4px 0;padding-inline-start:22px}
  [data-vps-chat] .vc-comparison-changes ol {display:flex;flex-wrap:wrap;gap:4px 8px;margin:4px 0;padding-left:20px}
  [data-vps-chat] .vc-comparison-changes [data-change] {color:var(--vc-accent)}
  @container (max-width:450px) {
    [data-vps-chat] :is(.vc-design-style-trigger,.vc-design-review-trigger) {justify-content:center; min-width:30px}
    [data-vps-chat] :is(.vc-design-style-trigger,.vc-design-review-trigger) > span:not(.vc-menu-icon) {display:none}
  }
  [data-vps-chat] .vc-design-imports {display:grid; gap:3px; margin-block:4px 12px}
  [data-vps-chat] .vc-design-file {
    position:relative; align-content:center; min-height:33px; padding:4px 8px;
    border-radius:6px; font-size:13px; cursor:pointer;
  }
  [data-vps-chat] .vc-design-file:hover:not(:has(input:disabled)) {background:var(--vc-hover)}
  [data-vps-chat] .vc-design-file:has(input:focus-visible) {outline:2px solid var(--vc-accent)}
  [data-vps-chat] .vc-design-file:has(input:disabled) {opacity:.55; cursor:default}
  [data-vps-chat] .vc-design-materials .vc-design-file input {
    position:absolute; width:1px; height:1px; margin:0; padding:0; border:0; clip-path:inset(50%);
  }
  [data-vps-chat] .vc-design-materials textarea {width:100%; resize:vertical}
  [data-vps-chat] .vc-design-library {display:flex; gap:8px; align-items:end; margin-block:8px}
  [data-vps-chat] .vc-design-library label {flex:1}
  [data-vps-chat] .vc-design-library button {flex:none}
  [data-vps-chat] .vc-design-share {border:1px solid var(--vc-line); border-radius:8px; margin-block:12px}
  [data-vps-chat] .vc-design-image-list li {display:flex; gap:8px; align-items:center; padding:4px}
  [data-vps-chat] .vc-design-image-list img {object-fit:cover; border-radius:5px}
  [data-vps-chat] .vc-design-image-list span {min-width:0; flex:1; overflow-wrap:anywhere}
  [data-vps-chat] .vc-canvas-status {margin:0; padding:5px 12px; color:var(--vc-warn); font-size:12px}
  [data-vps-chat] .vc-canvas-status[data-outcome] {color:var(--vc-muted); display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px}
  [data-vps-chat] .vc-export-trigger {display:flex; align-items:center; gap:6px}
  [data-vps-chat] .vc-export-trigger::after {
    content:''; width:6px; height:6px; margin-top:-3px; border:solid currentColor; border-width:0 1.5px 1.5px 0; transform:rotate(45deg);
  }
  @container (max-width:700px) {
    [data-vps-chat] .vc-canvas-content {flex-direction:column}
    [data-vps-chat] .vc-design-inspector {width:100%; max-height:43%; border-inline-start:0; border-top:1px solid var(--vc-line)}
  }
`;

function clampOffset(value) {
  return Math.min(2160, Math.max(-2160, Math.round(value)));
}

function clampSize(value) {
  return Math.min(2160, Math.max(1, Math.round(value)));
}

function restoreGesture(gesture) {
  if (gesture.style === null) gesture.node.removeAttribute('style');
  else gesture.node.setAttribute('style', gesture.style);
}

function sameEntries(entries, previous) {
  return entries === previous || (entries.length === previous?.length && entries.every((entry, index) => entry === previous[index]));
}

function collectVersions(turns, previous, showcaseStreaming, verifyOutput, storageKey) {
  const replies = new Map();
  const versions = [];
  for (const turn of turns) {
    const provisional = turn.state !== 'complete';
    if (provisional && !(showcaseStreaming && turn.streaming &&
        ['pending', 'running', 'stopping'].includes(turn.state))) continue;
    const cached = previous?.replies.get(turn.id);
    const unchanged = cached && cached.reply === turn.reply && cached.state === turn.state;
    const revision = unchanged ? cached.revision : readLayerRevision(storageKey, turn);
    const sources = unchanged ? cached.version?.sources : revision ? revision.sources : extractHtmlFences(turn.reply);
    let version;
    if (sources?.length && (unchanged || !verifyOutput || sources.some((source) => createArtboard(source)?.hasSurface))) {
      const number = turn.ordinal ?? versions.length + 1;
      version = cached?.version?.number === number && cached.version.provisional === provisional &&
          cached.version.initialBoards === revision?.boards && sameEntries(sources, cached.version.sources)
        ? cached.version
        : { id: turn.id, sources, number, provisional,
          initialBoards: revision?.boards, initialLinks: revision?.links, revisedBoardIndex: revision?.boardIndex };
      versions.push(version);
    }
    replies.set(turn.id, unchanged && version === cached.version ? cached : { reply: turn.reply, state: turn.state, revision, version });
  }
  return { replies, versions: sameEntries(versions, previous?.versions) ? previous.versions : versions };
}

function boardEdits(version, saved, index) {
  return saved[version?.id]?.[index] ?? version?.initialBoards?.[index] ?? emptyBoard;
}

function collectArtboards(version, saved, previous) {
  const entries = (version?.sources ?? []).map((source, offset) => {
    const board = boardEdits(version, saved, offset + 1);
    const cached = previous?.entries[offset];
    if (cached?.source === source && cached.board === board) return cached;
    const title = `画板 ${offset + 1}`;
    const preview = createArtboard(source, board, title) ?? { title, html: '', layers: [] };
    return { source, board, preview };
  });
  return sameEntries(entries, previous?.entries) ? previous : { entries, boards: entries.map((entry) => entry.preview) };
}

function collectPlaygroundBoards(versions, saved, previous) {
  const next = new Map();
  for (const version of versions) {
    version.sources.forEach((source, offset) => {
      const index = offset + 1;
      const id = `${version.id}:${index}`;
      const board = boardEdits(version, saved, index);
      const cached = previous.get(id);
      if (cached?.source === source && cached.board === board && cached.version === version.number &&
          cached.provisional === version.provisional) {
        next.set(id, cached);
        return;
      }
      const preview = createArtboard(source, board, `画板 ${index}`);
      if (preview?.html) next.set(id, { source, board, id, index, versionId: version.id, version: version.number,
        provisional: version.provisional, localCopy: version.localCopy, ...preview });
    });
  }
  return next;
}

export function createDesignCanvas(React) {
  const h = React.createElement;
  const { MaterialsDialog, LayerInspector, DesignStyleControl, DesignComparison } = createDesignControls(React);
  const DesignPlayground = createDesignPlayground(React);
  const { ConnectorDialog, PrototypePlayer } = createDesignPrototype(React);
  const DesignVersionGraph = createDesignVersionGraph(React);

  return function DesignCanvas({ id, turns, generating, loading, targetId, sessionId, onContext, onCycleFocus,
    submitted, waitingForReceipt, request, materialsOpen, setMaterialsOpen, playgroundEnabled, playgroundOpen,
    setPlaygroundOpen, canGenerate, canBranch, readDesignRevision, onPrompt, conversation, openCanvasMenu, openExportMenu, copyBoardHtml,
    scopedLayerRevisions, savePreference }) {
    const floatingConversation = Boolean(conversation);
    const storageKey = `dsh-vps-design:v1:${targetId}:${sessionId}`;
    const [{ project, warning }, setSaved] = React.useState(() => readDesignProject(storageKey));
    const latestProject = React.useRef(project);
    const histories = React.useRef(new Map());
    const [selectedVersion, setSelectedVersion] = React.useState('');
    const [selectedBoard, setSelectedBoard] = React.useState(null);
    const [selection, setSelection] = React.useState(null);
    const [commentRequest, setCommentRequest] = React.useState(null);
    const [comparison, setComparison] = React.useState(null);
    const [viewport, setViewport] = React.useState('desktop');
    const [zoom, setZoom] = React.useState('fit');
    const [editing, setEditing] = React.useState(false);
    const [choices, setChoices] = React.useState(defaultChoices);
    const [exporting, setExporting] = React.useState(false);
    const exportInFlight = React.useRef(false);
    const [playgroundTarget, setPlaygroundTarget] = React.useState(null);
    const [topologyPreference, setTopologyPreference] = React.useState(null);
    const [compactCanvas, setCompactCanvas] = React.useState(false);
    const topologyOpen = topologyPreference ?? !compactCanvas;
    const [versionHistory, setVersionHistory] = React.useState(noHistory);
    const [historyLoading, setHistoryLoading] = React.useState(false);
    const [historyError, setHistoryError] = React.useState('');
    const [historyRevision, reloadHistory] = React.useReducer((value) => value + 1, 0);
    const [olderTurns, setOlderTurns] = React.useState(noHistory);
    const [loadingVersion, setLoadingVersion] = React.useState(false);
    const [revealBoard, setRevealBoard] = React.useState(null);
    const [followSubmitted, setFollowSubmitted] = React.useState(null);
    const readingVersion = React.useRef(null);
    const topologyId = React.useId();
    const clearVersionTarget = React.useCallback(() => setPlaygroundTarget(null), []);
    const [linkSource, setLinkSource] = React.useState(null);
    const [playFrom, setPlayFrom] = React.useState(null);
    const [alert, setAlert] = React.useState('');
    const [space, setSpace] = React.useState(null);
    const [frameLoad, setFrameLoad] = React.useState(0);
    const stage = React.useRef(null);
    const panel = React.useRef(null);
    const openedRequest = React.useRef(null);
    const frame = React.useRef(null);
    const frameMenu = React.useRef(null);
    const pointerGesture = React.useRef(null);

    const previousVersions = React.useRef(null);
    const previousArtboards = React.useRef(null);
    const previousPlayground = React.useRef(noPlaygroundBoards);
    const versionTurns = React.useMemo(() => {
      const observed = new Set(turns.map(({ id }) => id));
      return [...olderTurns.filter(({ id }) => !observed.has(id)), ...turns];
    }, [turns, olderTurns]);
    const versionCache = React.useMemo(() => collectVersions(versionTurns, previousVersions.current, playgroundOpen, playgroundEnabled, storageKey),
      [versionTurns, playgroundOpen, playgroundEnabled, storageKey]);
    const nativeVersions = versionCache.versions;
    const localVersions = React.useMemo(() => (project.localVersions ?? []).map((version, offset) => ({
      ...version, number: `本机 ${offset + 1}`, localCopy: true,
    })), [project.localVersions]);
    const versions = React.useMemo(() => [...nativeVersions, ...localVersions], [nativeVersions, localVersions]);
    const isLocalCopy = (id) => localVersions.some((version) => version.id === id);
    const selected = versions.find((version) => version.id === selectedVersion);
    const active = selected ?? nativeVersions.at(-1) ?? localVersions.at(-1);
    const index = selectedBoard?.version === active?.id ? selectedBoard?.index ?? 1 : active?.revisedBoardIndex ?? 1;
    const boardKey = active ? `${active.id}:${index}` : '';
    const board = boardEdits(active, project.versions, index);
    const artboardCache = React.useMemo(() => collectArtboards(active, project.versions, previousArtboards.current), [active, project.versions]);
    const { boards } = artboardCache;
    const preview = boards[index - 1];
    const layer = preview?.layers.find((entry) => selection?.board === boardKey && entry.id === selection.id);
    const edit = board.edits[layer?.id] ?? {};
    const history = histories.current.get(boardKey) ?? emptyHistory;
    const collectPlayground = Boolean(playgroundOpen || playgroundTarget || linkSource || playFrom);
    const playgroundBoards = React.useMemo(() => collectPlayground
      ? collectPlaygroundBoards(versions, project.versions, previousPlayground.current) : noPlaygroundBoards,
    [collectPlayground, versions, project.versions]);
    const playgroundEntries = React.useMemo(() => [...playgroundBoards.values()], [playgroundBoards]);
    const inheritedLinks = React.useMemo(() => versions.flatMap((version) => version.initialLinks ?? []), [versions]);
    const effectiveLinks = React.useMemo(() => {
      const byLayer = new Map();
      for (const link of [...inheritedLinks, ...project.playground.links]) {
        const key = `${link.from}:${link.layer}`;
        if (link.to) byLayer.set(key, link);
        else byLayer.delete(key);
      }
      return [...byLayer.values()];
    }, [inheritedLinks, project.playground.links]);
    const playgroundLinks = React.useMemo(() => effectiveLinks.filter(({ from, layer, to }) =>
      playgroundBoards.get(from)?.layers.some(({ id }) => id === layer) && playgroundBoards.has(to)),
    [effectiveLinks, playgroundBoards]);
    const drawnLinks = React.useMemo(() => [...new Map(playgroundLinks.map((link) =>
      [`${link.from}>${link.to}`, link])).values()], [playgroundLinks]);
    const targetBoard = playgroundBoards.get(playgroundTarget?.id);
    const submission = React.useMemo(() => {
      const base = playgroundTarget?.base;
      const branch = playgroundTarget?.versionBoards
        ? { versionBoards: playgroundTarget.versionBoards.map((entry) => playgroundBoards.get(entry.id) ?? entry) }
        : targetBoard ? { board: targetBoard, intent: playgroundTarget.intent, layer: playgroundTarget.layer,
          revision: playgroundTarget.revision, retryReason: playgroundTarget.retryReason, fork: base?.fork }
          : playgroundTarget?.continueLabel ? { continueBranch: true } : null;
      const sourceId = base?.parentTurnId ?? targetBoard?.versionId;
      const sourceVersion = sourceId ? versions.find((entry) => entry.id === sourceId) :
        active?.localCopy ? nativeVersions.at(-1) : active;
      const attachApproved = sourceVersion?.initialBoards && (branch?.continueBranch || !playgroundTarget);
      const sourceBoards = sourceVersion === active || (!active?.localCopy && !(choices.revision || attachApproved))
        ? boards : collectArtboards(sourceVersion, project.versions).boards;
      const target = attachApproved ? { ...branch, approvedBoards: sourceBoards.flatMap((preview, offset) => preview.html
        ? [{ ...preview, versionId: sourceVersion.id, version: sourceVersion.number, index: offset + 1,
          board: boardEdits(sourceVersion, project.versions, offset + 1) }] : []) } : branch;
      const result = buildDesignContext(project, sourceVersion, sourceBoards, choices, target, { workflow: playgroundEnabled });
      if (playgroundTarget?.continueLabel) result.labels.push(playgroundTarget.continueLabel);
      if (base && !branch) result.error = '这版画板暂不可用，请重新选择版本。';
      if (playgroundTarget?.layer && !targetBoard?.layers.some(({ id }) => id === playgroundTarget.layer)) {
        result.error = '选中的图层已不可用。请重新选择要修改的图层。';
      }
      const revision = branch?.revision && sourceVersion && !result.error ? {
        base: branch.revision, sourceId: sourceVersion.id, index: targetBoard.index, layer: branch.layer,
        sources: sourceVersion.sources,
        boards: Object.fromEntries(sourceVersion.sources.map((_, offset) => [offset + 1,
          boardEdits(sourceVersion, project.versions, offset + 1)])),
        links: effectiveLinks.filter(({ from }) => from.startsWith(`${sourceVersion.id}:`)),
      } : undefined;
      return { ...result, base, revision };
    }, [project, active, boards, choices, targetBoard, playgroundTarget, playgroundBoards, versions, nativeVersions, playgroundEnabled, effectiveLinks]);
    const nodes = React.useMemo(() => [
      ...designVersionNodes(versionHistory, turns, nativeVersions),
      ...localVersions.map(({ id, parentId, number }) => ({ id, parentId, number, title: '带入的画板',
        localCopy: true, status: 'ready', canContinue: false })),
    ], [versionHistory, turns, nativeVersions, localVersions]);
    const lastNativeTurn = turns.at(-1);
    const lastRevision = versionCache.replies.get(lastNativeTurn?.id)?.revision;
    const retryLayer = lastRevision?.retryTarget;
    const retryBoard = retryLayer && findPlaygroundBoard(retryLayer.id);
    const canRetryLayer = scopedLayerRevisions && !playgroundTarget && retryBoard?.layers.some(({ id }) => id === retryLayer.layer);
    const noNewBoard = playgroundEnabled && lastNativeTurn?.state === 'complete' && !versions.some(({ id }) => id === lastNativeTurn.id);
    const historyCursor = lastNativeTurn && `${lastNativeTurn.id}:${lastNativeTurn.state}`;
    const forkDraft = playgroundTarget?.base?.fork ? {
      id: `draft:${playgroundTarget.base.parentTurnId}`, parentId: playgroundTarget.base.parentTurnId, fork: true,
      number: (lastNativeTurn?.ordinal ?? turns.length) + 1, title: '待发送的新分支', status: 'draft', canContinue: false,
    } : null;
    const width = viewportWidths[viewport];
    const scale = zoom === 'fit' ? (space ? Math.min(1, space.width / width) : 1) : Number(zoom) / 100;
    const singleMenuEnabled = Boolean(openCanvasMenu && !playgroundOpen);
    const hasTopology = Boolean(playgroundOpen && readDesignRevision && turns.length);

    React.useLayoutEffect(() => {
      frameMenu.current = singleMenuEnabled ? openFrameBoardMenu : null;
    });

    // Reuse previews across stream updates and board layout changes.
    React.useLayoutEffect(() => {
      previousVersions.current = versionCache;
      previousArtboards.current = artboardCache;
      previousPlayground.current = playgroundBoards;
    }, [versionCache, artboardCache, playgroundBoards]);

    React.useEffect(() => {
      for (const [turnId, { revision }] of versionCache.replies) {
        if (revision && revision.outcome !== 'waiting') {
          try { saveLayerRevisionOutcome(storageKey, turnId, revision.outcome); }
          catch { /* The authoritative reply and frozen baseline can still be read. */ }
        }
      }
    }, [storageKey, versionCache.replies]);

    React.useLayoutEffect(() => {
      if (!request || openedRequest.current === request) return;
      const version = versions.find((entry) => entry.id === request.turnId);
      if (!version) {
        if (!readDesignRevision) return;
        openedRequest.current = request;
        void resolveVersion(request.turnId).then((loaded) => {
          if (!loaded || openedRequest.current !== request) return;
          const board = Number.isInteger(request.boardIndex) && request.boardIndex >= 1 &&
            request.boardIndex <= loaded.sources.length ? request.boardIndex : loaded.revisedBoardIndex ?? 1;
          chooseVersion(loaded.id, board);
          panel.current?.focus({ preventScroll: true });
        });
        return;
      }
      openedRequest.current = request;
      setSelectedVersion(nativeVersions.at(-1)?.id === request.turnId ? '' : request.turnId);
      const index = request.boardIndex;
      setSelectedBoard(Number.isInteger(index) && index >= 1 && index <= version.sources.length
        ? { version: version.id, index } : null);
      setSelection(null);
      panel.current?.focus({ preventScroll: true });
    }, [request, versions]);

    React.useLayoutEffect(() => {
      if (!floatingConversation) return undefined;
      const element = panel.current;
      const measure = () => setCompactCanvas(element.clientWidth < 640 || element.clientHeight < 480);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }, [floatingConversation]);

    React.useLayoutEffect(() => {
      const element = stage.current;
      if (!element) return undefined;
      const observer = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setSpace((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
        }
      });
      observer.observe(element);
      return () => observer.disconnect();
    }, [playgroundOpen]);

    React.useLayoutEffect(() => {
      onContext(submission.context || submission.labels.length || submission.error
        ? { ...submission, targetId, sessionId, clearVersionTarget } : null);
    }, [submission, targetId, sessionId, onContext, clearVersionTarget]);

    React.useLayoutEffect(() => {
      if (submitted) {
        if (playgroundTarget?.base) setFollowSubmitted(submitted);
        setChoices(defaultChoices);
        setPlaygroundTarget(null);
      }
    }, [submitted]);

    React.useLayoutEffect(() => {
      if (!followSubmitted || !versions.some(({ id }) => id === followSubmitted)) return;
      chooseVersion(followSubmitted);
      setFollowSubmitted(null);
    }, [followSubmitted, versions]);

    React.useEffect(() => {
      if (!playgroundOpen || !topologyOpen || !historyCursor || !readDesignRevision) return undefined;
      const controller = new AbortController();
      setHistoryLoading(true);
      setHistoryError('');
      readDesignRevision(null, controller.signal).then((next) => {
        if (!controller.signal.aborted) {
          setVersionHistory(next);
          setHistoryLoading(false);
        }
      }).catch(() => {
        if (!controller.signal.aborted) {
          setHistoryError('版本历史暂时无法读取。');
          setHistoryLoading(false);
        }
      });
      return () => controller.abort();
    }, [playgroundOpen, topologyOpen, historyCursor, historyRevision, readDesignRevision]);

    React.useEffect(() => () => readingVersion.current?.abort(), []);

    function chooseBoard(nextIndex) {
      setSelectedBoard({ version: active?.id, index: nextIndex });
      setSelection(null);
    }

    React.useLayoutEffect(() => () => {
      const gesture = pointerGesture.current;
      if (gesture?.key !== boardKey) return;
      pointerGesture.current = null;
      restoreGesture(gesture);
    }, [boardKey, editing, preview?.html]);

    React.useLayoutEffect(() => {
      const document = frame.current?.contentDocument;
      const frameWindow = document?.defaultView;
      if (!frameWindow || !active || !preview?.html) return undefined;
      const sheet = document.createElement('style');
      sheet.textContent = `
        [data-dsh-highlight] {outline:2px solid #1e9c87 !important;outline-offset:2px !important}
        [data-dsh-handle] {position:fixed !important;z-index:2147483647 !important;touch-action:none !important;
          width:26px !important;height:26px !important;padding:0 !important;display:grid !important;place-items:center !important;
          background:#146d5e !important;color:#fff !important;border:2px solid #fff !important;border-radius:5px !important;
          font:16px system-ui !important;box-sizing:border-box !important;cursor:move !important}
        [data-dsh-handle=resize] {cursor:nwse-resize !important}
      `;
      document.head?.append(sheet);
      const highlighted = layer && editing ? document.querySelector(`[data-dsh-layer="${layer.id}"]`) : null;
      highlighted?.setAttribute('data-dsh-highlight', '');
      const handles = highlighted ? [['move', '移动图层', '↕'], ['resize', '调整图层大小', '↘']].map(([kind, label, glyph]) => {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.dataset.dshHandle = kind;
        handle.setAttribute('aria-label', label);
        handle.title = label;
        handle.textContent = glyph;
        document.documentElement.append(handle);
        return handle;
      }) : [];

      function placeHandles() {
        if (!highlighted) return;
        const bounds = highlighted.getBoundingClientRect();
        const { clientWidth, clientHeight } = document.documentElement;
        const visible = bounds.right > 0 && bounds.bottom > 0 && bounds.left < clientWidth && bounds.top < clientHeight;
        handles.forEach((handle, index) => {
          const x = index ? bounds.right - 13 : bounds.left - 13;
          const y = index ? bounds.bottom - 13 : bounds.top - 13;
          handle.style.setProperty('visibility', visible ? 'visible' : 'hidden', 'important');
          handle.style.setProperty('left', `${Math.max(0, Math.min(clientWidth - 26, x))}px`, 'important');
          handle.style.setProperty('top', `${Math.max(0, Math.min(clientHeight - 26, y))}px`, 'important');
        });
      }
      placeHandles();

      function beginDrag(event) {
        if (!editing || event.button !== 0 || pointerGesture.current) return;
        const kind = event.target?.closest?.('[data-dsh-handle]')?.dataset.dshHandle;
        const node = kind ? highlighted : event.target?.closest?.('[data-dsh-layer]');
        if (!node) return;
        event.preventDefault();
        const id = node.dataset.dshLayer;
        const current = board.edits[id] ?? {};
        const computed = frameWindow.getComputedStyle(node);
        const translation = computed.translate.split(' ');
        const offset = (part, extent) => (Number.parseFloat(part) || 0) * (part?.endsWith('%') ? extent / 100 : 1);
        pointerGesture.current = {
          key: boardKey, id, node, pointerId: event.pointerId, kind,
          startX: event.clientX, startY: event.clientY, style: node.getAttribute('style'),
          x: current.x ?? offset(translation[0], node.offsetWidth), y: current.y ?? offset(translation[1], node.offsetHeight),
          width: Number.parseFloat(computed.width) || node.offsetWidth, height: Number.parseFloat(computed.height) || node.offsetHeight,
          inline: computed.display === 'inline' || current.inlineBlock === true,
        };
        try { node.setPointerCapture(event.pointerId); } catch { /* The pointer can end before capture. */ }
        if (id !== layer?.id) setSelection({ board: boardKey, id });
      }

      function moveDrag(event) {
        const gesture = pointerGesture.current;
        if (!gesture || gesture.pointerId !== event.pointerId || gesture.key !== boardKey) return;
        const dx = event.clientX - gesture.startX;
        const dy = event.clientY - gesture.startY;
        if (!gesture.change && Math.abs(dx) + Math.abs(dy) < 3) return;
        const { style } = gesture.node;
        if (gesture.inline) style.setProperty('display', 'inline-block', 'important');
        if (gesture.kind === 'resize') {
          gesture.change = { width: clampSize(gesture.width + dx), height: clampSize(gesture.height + dy), inlineBlock: gesture.inline };
          style.setProperty('width', `${gesture.change.width}px`, 'important');
          style.setProperty('height', `${gesture.change.height}px`, 'important');
        } else {
          gesture.change = { x: clampOffset(gesture.x + dx), y: clampOffset(gesture.y + dy), inlineBlock: gesture.inline };
          style.setProperty('translate', `${gesture.change.x}px ${gesture.change.y}px`, 'important');
        }
        placeHandles();
      }

      function endDrag(event) {
        const gesture = pointerGesture.current;
        if (!gesture || gesture.pointerId !== event.pointerId || gesture.key !== boardKey) return;
        pointerGesture.current = null;
        restoreGesture(gesture);
        placeHandles();
        if (event.type === 'pointerup' && gesture.change) patchLayer(gesture.id, gesture.change);
      }

      function interact(event) {
        const node = event.target;
        if (event.type === 'contextmenu' || (event.type === 'keydown' && singleMenuEnabled && contextMenuKey(event))) {
          frameMenu.current?.(event, frame.current);
          return;
        }
        if (event.type === 'keydown' && onCycleFocus?.(event, true)) return;
        if (event.type === 'keydown' && handleHistoryShortcut(event)) return;
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        if (editing) {
          if (event.type !== 'click') return;
          const id = node?.closest?.('[data-dsh-layer]')?.getAttribute('data-dsh-layer');
          event.preventDefault();
          if (id) setSelection({ board: boardKey, id });
          return;
        }
        const destination = node?.closest?.('[data-dsh-go]')?.getAttribute('data-dsh-go');
        if (!destination || !/^[1-6]$/.test(destination)) return;
        event.preventDefault();
        const next = Number(destination);
        if (next <= boards.length) chooseBoard(next);
      }
      document.addEventListener('click', interact, true);
      document.addEventListener('keydown', interact, true);
      if (singleMenuEnabled) document.addEventListener('contextmenu', interact, true);
      document.addEventListener('pointerdown', beginDrag, true);
      document.addEventListener('pointermove', moveDrag, true);
      document.addEventListener('pointerup', endDrag, true);
      document.addEventListener('pointercancel', endDrag, true);
      document.addEventListener('lostpointercapture', endDrag, true);
      document.addEventListener('scroll', placeHandles, true);
      frameWindow.addEventListener('resize', placeHandles);
      return () => {
        highlighted?.removeAttribute('data-dsh-highlight');
        handles.forEach((handle) => handle.remove());
        sheet.remove();
        document.removeEventListener('click', interact, true);
        document.removeEventListener('keydown', interact, true);
        if (singleMenuEnabled) document.removeEventListener('contextmenu', interact, true);
        document.removeEventListener('pointerdown', beginDrag, true);
        document.removeEventListener('pointermove', moveDrag, true);
        document.removeEventListener('pointerup', endDrag, true);
        document.removeEventListener('pointercancel', endDrag, true);
        document.removeEventListener('lostpointercapture', endDrag, true);
        document.removeEventListener('scroll', placeHandles, true);
        frameWindow.removeEventListener('resize', placeHandles);
      };
    }, [frameLoad, preview?.html, active?.id, index, editing, layer?.id, boards.length, board, history,
      onCycleFocus, playgroundOpen, singleMenuEnabled]);

    function updateProject(change) {
      const next = change(latestProject.current);
      latestProject.current = next;
      setSaved({ project: next, warning: saveDesignProject(storageKey, next) });
    }

    function findPlaygroundBoard(id) {
      return playgroundBoards.get(id) ?? (id === boardKey && active && preview?.html
        ? { ...preview, id, versionId: active.id, index, provisional: active.provisional } : undefined);
    }

    function selectPlaygroundBoard(id, layerId) {
      const entry = findPlaygroundBoard(id);
      if (!entry) return;
      setFollowSubmitted(null);
      setSelectedVersion(entry.versionId);
      setSelectedBoard({ version: entry.versionId, index: entry.index });
      setSelection(layerId ? { board: id, id: layerId } : null);
    }

    function chooseVersion(id, boardIndex = versions.find((version) => version.id === id)?.revisedBoardIndex ?? 1) {
      setSelectedVersion(id);
      setSelectedBoard({ version: id, index: boardIndex });
      setSelection(null);
      setRevealBoard({ id: `${id}:${boardIndex}` });
    }

    async function resolveVersion(id) {
      readingVersion.current?.abort();
      readingVersion.current = null;
      setLoadingVersion(false);
      const local = versions.find((version) => version.id === id && !version.provisional);
      if (local || !readDesignRevision) return local;
      const controller = new AbortController();
      readingVersion.current = controller;
      setLoadingVersion(true);
      setAlert('');
      try {
        const turn = await readDesignRevision(id, controller.signal);
        if (controller.signal.aborted) return undefined;
        const version = collectVersions([turn], null, false, playgroundEnabled, storageKey).versions[0];
        if (!version) throw new Error('unusable_version');
        setOlderTurns((previous) => [...previous.filter((entry) => entry.id !== id), turn]
          .slice(-12).sort((a, b) => a.ordinal - b.ordinal));
        return version;
      } catch {
        if (!controller.signal.aborted) setAlert('这版画板暂时无法加载。');
        return undefined;
      } finally {
        if (readingVersion.current === controller) {
          readingVersion.current = null;
          setLoadingVersion(false);
        }
      }
    }

    async function openHistoricalVersion(id) {
      setFollowSubmitted(null);
      const version = await resolveVersion(id);
      if (version) chooseVersion(id, version.revisedBoardIndex);
    }

    function comparisonSource(id) {
      const parentId = nodes.find((entry) => entry.id === id && entry.status === 'ready')?.parentId;
      return nodes.find((entry) => entry.id === parentId && entry.status === 'ready') ??
        (parentId && isLocalCopy(id) ? { id: parentId } : undefined);
    }

    async function compareVersion(id) {
      const source = comparisonSource(id);
      if (!source || loadingVersion) return;
      const candidate = await resolveVersion(id);
      if (!candidate) return;
      const original = await resolveVersion(source.id);
      if (!original) return;
      const capture = (version) => ({
        id: version.id, number: version.number, origins: version.origins,
        entries: collectArtboards(version, latestProject.current.versions).entries,
      });
      setComparison({ original: capture(original), candidate: capture(candidate), firstBoard: id === active?.id ? index : 1, width });
    }

    async function carryComparisonBoards(entries) {
      const id = globalThis.crypto.randomUUID();
      const origins = entries.map(({ versionId, index }) => ({ versionId, index }));
      const destinations = new Map(origins.map(({ versionId, index }, offset) =>
        [`${versionId}:${index}`, `${id}:${offset + 1}`]));
      const current = latestProject.current;
      const overrides = [...inheritedLinks, ...current.playground.links];
      const copies = entries.map(({ source, board, versionId, index }) => {
        const currentBoard = current.versions[versionId]?.[index] ?? board;
        return { board: currentBoard, ...carriedBoard(source, createArtboard(source)?.html ?? '',
          `${versionId}:${index}`, overrides, destinations) };
      });
      const next = addLocalDesignVersion(current, {
        id, parentId: comparison.candidate.id, origins, sources: copies.map(({ source }) => source),
      }, copies.map(({ board }) => board), copies.flatMap(({ links }) => links));
      const serialized = serializeDesignProject(next);
      try {
        if (savePreference) await savePreference(storageKey, serialized);
        else if (saveDesignProject(storageKey, next)) throw new Error('storage');
      } catch {
        throw new Error('本机保存失败。选中的画板仍保留，可以再试一次。');
      }
      latestProject.current = next;
      setSaved({ project: next, warning: '' });
      setFollowSubmitted(null);
      clearVersionTarget();
      chooseVersion(id);
    }

    async function stageVersionBranch(id, fork) {
      const node = nodes.find((entry) => entry.id === id && entry.status === 'ready');
      if (!canBranch || waitingForReceipt || loadingVersion || !node || node.localCopy || (!fork && !node.canContinue)) return;
      const version = await resolveVersion(id);
      if (!version) return;
      const versionBoards = fork ? [...collectPlaygroundBoards([version], latestProject.current.versions,
        previousPlayground.current).values()] : undefined;
      if (fork && !versionBoards.length) return setAlert('这版没有可用于创建分支的画板。');
      chooseVersion(id, version.revisedBoardIndex);
      setTopologyPreference(!compactCanvas);
      setPlaygroundTarget({
        base: { parentTurnId: id, fork },
        ...(fork ? { versionBoards } : { continueLabel: `继续 · 版本 ${version.number}` }),
      });
      onPrompt('');
    }

    function designBaseFor(versionId) {
      if (!readDesignRevision) return undefined;
      const selectedNode = nodes.find((node) => node.id === versionId);
      return { parentTurnId: versionId, fork: !(selectedNode?.canContinue || versionId === lastNativeTurn?.id) };
    }

    function clearPlaygroundTarget() {
      if (!waitingForReceipt && !generating) setPlaygroundTarget(null);
    }

    function editPlaygroundBoard(id, layerId) {
      const entry = findPlaygroundBoard(id);
      if (!entry || entry.provisional) return;
      selectPlaygroundBoard(id, layerId);
      setPlaygroundOpen(false);
      setEditing(true);
    }

    function attachPlaygroundBoard(id, intent, layerId, suggestion, retryReason) {
      const entry = findPlaygroundBoard(id);
      if (!entry || entry.provisional || isLocalCopy(entry.versionId) || !canGenerate || generating || waitingForReceipt ||
          (readDesignRevision && !canBranch) || (layerId && !entry.layers.some((entry) => entry.id === layerId))) return;
      selectPlaygroundBoard(id, layerId);
      const base = designBaseFor(entry.versionId);
      if (base?.fork && !compactCanvas) setTopologyPreference(true);
      setPlaygroundTarget({ id, intent, base, layer: layerId, retryReason,
        revision: scopedLayerRevisions && layerId && intent === 'iterate' ? globalThis.crypto.randomUUID() : undefined });
      onPrompt(suggestion ?? (intent === 'variants' ? '请基于选中的画板生成两种设计变体。' : ''));
    }

    function attachDesignLayer() {
      if (layer) attachPlaygroundBoard(boardKey, 'iterate', layer.id);
    }

    function openBoardMenu(event, anchor, entry, { layerId, ...placement } = {}) {
      const { id, html, provisional, versionId } = entry;
      const editingLocked = provisional || generating || loading || waitingForReceipt;
      const generationLocked = editingLocked || isLocalCopy(versionId) || !canGenerate || Boolean(readDesignRevision && !canBranch);
      const forkLocked = editingLocked || isLocalCopy(versionId) || !canBranch || loadingVersion ||
        !nodes.some((node) => node.id === versionId && node.status === 'ready');
      const layerItems = layerId && entry.layers.some((layer) => layer.id === layerId) ? [{
        id: 'edit-layer', label: '编辑此图层', icon: 'rename', disabled: editingLocked,
        run: () => editPlaygroundBoard(id, layerId),
      }, {
        id: 'comment-layer', label: '批注此图层', icon: 'chat', disabled: editingLocked,
        run: () => {
          editPlaygroundBoard(id, layerId);
          setCommentRequest({ board: id, layer: layerId });
        },
      }, {
        id: 'iterate-layer', label: '迭代此图层', icon: 'rename', disabled: generationLocked,
        run: () => attachPlaygroundBoard(id, 'iterate', layerId),
      }] : [];
      openCanvasMenu(event, anchor, '画板操作', [
        [
          { id: 'edit', label: '编辑画板', icon: 'rename', disabled: editingLocked, run: () => editPlaygroundBoard(id) },
          ...layerItems,
          { id: 'iterate', label: '迭代此画板', icon: 'chat', disabled: generationLocked,
            run: () => attachPlaygroundBoard(id, 'iterate') },
          { id: 'variants', label: '生成变体', icon: 'variants', disabled: generationLocked,
            run: () => attachPlaygroundBoard(id, 'variants') },
          { id: 'fork', label: '从所属版本 Fork', icon: 'fork', disabled: forkLocked, run: () => void stageVersionBranch(versionId, true) },
        ],
        [
          { id: 'link', label: '连接画板', icon: 'link', disabled: editingLocked, run: () => setLinkSource(id) },
          { id: 'play', label: '播放原型', icon: 'play', disabled: loading || provisional, run: () => setPlayFrom(id) },
        ],
        [
          { id: 'copy', label: '复制画板 HTML', icon: 'copy', disabled: provisional || !html, run: () => void copyBoardHtml(html) },
          { id: 'download', label: '下载此画板 HTML', icon: 'download', disabled: provisional || !html || exporting,
            run: () => void exportBoards('html', [entry]) },
        ],
      ], placement);
    }

    async function copySelectedBoards(entries) {
      try {
        const output = await createDesignExport(entries, 'html', { playgroundLinks });
        await copyBoardHtml(await output.text(), entries.length);
      } catch {
        setAlert('无法生成所选画板的 HTML。');
      }
    }

    function openSelectionMenu(event, anchor, entries) {
      const unavailable = entries.some((entry) => entry.provisional || !entry.html);
      const { summary, actions } = designExportMenu(entries,
        (format, list) => void exportBoards(format, list, { playgroundLinks }), { busy: exporting, contextSelection: true });
      openCanvasMenu(event, anchor, '所选画板操作', [
        [{ id: 'copy-selection', label: '复制所选画板 HTML', icon: 'copy', disabled: unavailable,
          run: () => void copySelectedBoards(entries) }],
        actions,
      ], { summary });
    }

    function openFrameBoardMenu(event, iframe) {
      const entry = findPlaygroundBoard(boardKey);
      if (!entry || !iframe || pointerGesture.current) return;
      if (!editing && event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const keyboard = event.type === 'keydown' || (event.clientX === 0 && event.clientY === 0);
      const target = keyboard && event.target !== iframe.contentDocument?.body && event.target.getBoundingClientRect?.();
      const bounds = iframe.getBoundingClientRect();
      const x = keyboard ? (target?.left ?? 0) + 8 : event.clientX;
      const y = keyboard ? target?.bottom ?? 8 : event.clientY;
      const layerId = event.target.closest?.('[data-dsh-layer]')?.getAttribute('data-dsh-layer');
      openBoardMenu(event, iframe, entry, { frame: iframe, layerId, point: { x: bounds.left + x * scale, y: bounds.top + y * scale } });
    }

    function openBackgroundMenu(event, anchor, viewActions, placement) {
      openCanvasMenu(event, anchor, '画布操作', [
        viewActions,
        [
          { id: 'prompt', label: '编写设计提示', icon: 'chat', disabled: !canGenerate || generating || loading || waitingForReceipt,
            run: () => onPrompt('') },
          { id: 'materials', label: '设计资料', icon: 'attachment', disabled: waitingForReceipt, run: () => setMaterialsOpen(true) },
        ],
        hasTopology ? [{
          id: 'topology', label: topologyOpen ? '收起版本拓扑' : '显示版本拓扑', icon: 'fork',
          run: () => setTopologyPreference(!topologyOpen),
        }] : [],
      ], placement);
    }

    function openSingleBackgroundMenu(event) {
      if (event.type === 'keydown' && !contextMenuKey(event)) return;
      openBackgroundMenu(event, event.currentTarget, [
        { id: 'fit', label: '适应画板', icon: 'fit', disabled: !preview?.html, run: () => setZoom('fit') },
        { id: 'actual-size', label: '实际大小', icon: 'zoom-in', disabled: !preview?.html, run: () => setZoom('100') },
        { id: 'gallery', label: '查看全部画板', icon: 'canvas', run: () => setPlaygroundOpen(true) },
      ], { frame: frame.current });
    }

    function openVersionMenu(event, node) {
      if (node.status === 'draft') {
        openCanvasMenu(event, event.currentTarget, '版本操作', [[{
          id: 'cancel-draft', label: '取消分支草稿', icon: 'undo', disabled: generating || waitingForReceipt,
          run: clearPlaygroundTarget,
        }]]);
        return;
      }
      const parent = comparisonSource(node.id);
      const branchLocked = node.localCopy || !canBranch || loadingVersion || waitingForReceipt || generating;
      openCanvasMenu(event, event.currentTarget, '版本操作', [
        [
          { id: 'open', label: '查看此版本', icon: 'canvas', run: () => void openHistoricalVersion(node.id) },
          ...(parent ? [{
            id: 'parent', label: '查看父版本', icon: 'fork', run: () => void openHistoricalVersion(parent.id),
          }, {
            id: 'compare', label: '对比来源版本', icon: 'variants', disabled: loadingVersion, run: () => void compareVersion(node.id),
          }] : []),
        ],
        [
          { id: 'fork', label: '从此版本 Fork', icon: 'fork', disabled: branchLocked, run: () => void stageVersionBranch(node.id, true) },
          { id: 'continue', label: '继续此分支', icon: 'redo', disabled: branchLocked || !node.canContinue,
            detail: node.canContinue ? undefined : '只能从分支末端继续。', run: () => void stageVersionBranch(node.id, false) },
        ],
      ]);
    }

    function saveBoard(next) {
      updateProject((previous) => setDesignBoard(previous, active.id, index, next));
    }

    function changeBoard(next) {
      if (!active || JSON.stringify(board) === JSON.stringify(next)) return false;
      if (Object.keys(next.edits).length > maxLayerEdits) {
        setAlert('这个画板的本地修改已达到上限。');
        return false;
      }
      histories.current.set(boardKey, { undo: [...history.undo, board].slice(-24), redo: [] });
      saveBoard(next);
      return true;
    }

    function undo() {
      if (!history.undo.length) return;
      histories.current.set(boardKey, { undo: history.undo.slice(0, -1), redo: [...history.redo, board] });
      saveBoard(history.undo.at(-1));
    }

    function redo() {
      if (!history.redo.length) return;
      histories.current.set(boardKey, { undo: [...history.undo, board], redo: history.redo.slice(0, -1) });
      saveBoard(history.redo.at(-1));
    }

    function handleHistoryShortcut(event) {
      if (!editing || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) ||
          event.key.toLowerCase() !== 'z' || event.target?.closest?.('input,textarea,select,[contenteditable=true]')) return false;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return true;
    }

    function patchLayer(id, change) {
      if (!preview?.layers.some((entry) => entry.id === id)) return;
      const edits = { ...board.edits };
      if (['width', 'height', 'x', 'y'].some((key) => Number.isFinite(change[key]))) {
        const node = frame.current?.contentDocument?.querySelector(`[data-dsh-layer="${id}"]`);
        if (node && node.ownerDocument.defaultView?.getComputedStyle(node).display === 'inline') {
          change = { ...change, inlineBlock: true };
        }
      }
      const result = normalizeEdit({ ...edits[id], ...change });
      if (Object.keys(result).length) edits[id] = result;
      else delete edits[id];
      changeBoard({ ...board, edits });
    }

    function patch(change) {
      if (layer) patchLayer(layer.id, change);
    }

    function layerNode() {
      return layer ? frame.current?.contentDocument?.querySelector(`[data-dsh-layer="${layer.id}"]`) : null;
    }

    function addLayer(kind) {
      if (board.additions.length >= 30) return;
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const id = 'n' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const offset = 28 + board.additions.length * 8;
      const original = kind === 'duplicate' ? layerNode()?.getBoundingClientRect() : null;
      const next = kind === 'duplicate' && layer?.editable
        ? { ...edit, text: layer.text, x: clampOffset((original?.left ?? offset) + 14), y: clampOffset((original?.top ?? offset) + 14) }
        : kind === 'shape'
          ? { x: offset, y: offset, width: 120, height: 64, background: '#dceee8' }
          : { x: offset, y: offset, text: '新文字', color: '#202d2b', fontSize: 24 };
      if (changeBoard({ ...board, additions: [...board.additions, id], edits: { ...board.edits, [id]: normalizeEdit(next) } })) {
        setSelection({ board: boardKey, id });
      }
    }

    function align(side) {
      const bounds = layerNode()?.getBoundingClientRect();
      if (!bounds) return;
      const free = width - bounds.width;
      const position = side === 'center' ? free / 2 : side === 'right' ? free : 0;
      patch({ x: clampOffset((edit.x ?? 0) + position - bounds.left) });
    }

    async function exportBoards(format, entries, options) {
      if (exportInFlight.current || !entries.length || entries.some((entry) => entry.provisional || !entry.html)) return;
      exportInFlight.current = true;
      setExporting(true);
      setAlert('');
      try {
        await downloadDesign(entries, format, options);
      } catch {
        setAlert('导出失败。请检查当前画板后重试。');
      } finally {
        exportInFlight.current = false;
        setExporting(false);
      }
    }

    const exportDisabled = exporting || active?.provisional || !boards.length || boards.some((board) => !board.html);

    function showExportFormats(event, entries, options) {
      const anchor = event.currentTarget;
      const { left, bottom } = anchor.getBoundingClientRect();
      const { summary, actions } = designExportMenu(entries, (format, list) => void exportBoards(format, list, options), { busy: exporting });
      openExportMenu(event, anchor, '导出格式', [actions], {
        point: { x: left, y: bottom }, frame: frame.current, summary, tracksExpansion: true,
        focusLast: event.key === 'ArrowUp' || event.key === 'End',
      });
    }

    function exportCurrentVersion(event) {
      if (exportDisabled) return;
      const entries = boards.map((entry, index) => ({ ...entry, id: `${active.id}:${index + 1}`, version: active.number }));
      showExportFormats(event, entries, active.localCopy ? { playgroundLinks: effectiveLinks } : undefined);
    }

    const topology = hasTopology ? h('div', {
      id: topologyId, className: 'vc-canvas-topology vc-disclosure-motion', 'data-expanded': topologyOpen, inert: !topologyOpen,
    }, h('div', { className: 'vc-disclosure-clip' }, h(DesignVersionGraph, {
      nodes: forkDraft ? [...nodes, forkDraft] : nodes,
      selectedId: forkDraft?.parentId === active?.id ? forkDraft?.id : active?.id,
      onSelect: (id) => void openHistoricalVersion(id),
      onFork: (id) => void stageVersionBranch(id, true),
      onContinue: (id) => void stageVersionBranch(id, false),
      onNodeMenu: openCanvasMenu ? openVersionMenu : undefined,
      onCancelDraft: clearPlaygroundTarget, canAct: canBranch && !loadingVersion,
      canCancelDraft: !waitingForReceipt && !generating,
      loading: historyLoading || loadingVersion, error: historyError, onRetry: reloadHistory,
    }))) : null;
    const canvasTitle = playgroundOpen || conversation ? '设计工作台' : '设计画布';
    const header = h('header', { className: 'vc-canvas-header' },
      h('h2', null, canvasTitle),
      h('div', { className: 'vc-canvas-actions' },
        playgroundEnabled ? h('div', { className: 'vc-segments', role: 'group', 'aria-label': '画板浏览' },
          h('span', { className: 'vc-view-kind', 'aria-hidden': true }, '浏览'),
          [[true, '多画板'], [false, '单画板']].map(([open, label]) => h('button', {
            key: label, type: 'button', className: 'vc-button', 'aria-pressed': Boolean(playgroundOpen) === open,
            onClick: () => setPlaygroundOpen(open),
          }, label))) : null,
        hasTopology ? h('button', {
          type: 'button', className: 'vc-button', 'aria-controls': topologyId, 'aria-expanded': topologyOpen,
          onClick: () => setTopologyPreference(!topologyOpen),
        }, '版本拓扑') : null,
        playgroundEnabled ? h(DesignStyleControl, { value: project.style,
          change: (value) => updateProject((previous) => ({ ...previous, style: normalizeDesignStyle(value) })) }) : null,
        playgroundEnabled && active && comparisonSource(active.id) ? h('button', {
          type: 'button', className: 'vc-button vc-design-review-trigger', disabled: loadingVersion,
          'aria-label': '对比来源版本', title: '对比来源版本',
          onClick: () => void compareVersion(active.id),
        }, menuIcon(h, 'variants'), h('span', null, '对比来源版本')) : null,
        !playgroundOpen ? h('select', {
          'aria-label': '设计版本', value: selected?.id ?? '', disabled: !versions.length,
          onChange: (event) => { setSelectedVersion(event.target.value); setSelectedBoard(null); setSelection(null); },
        }, h('option', { value: '' }, '跟随最新'),
        versions.map((version) => h('option', { key: version.id, value: version.id }, `版本 ${version.number}`))) : null,
        h('div', { className: 'vc-segments', role: 'group', 'aria-label': '预览宽度' },
          [['desktop', '桌面'], ['mobile', '移动']].map(([value, label]) => h('button', {
            key: value, type: 'button', className: 'vc-button', 'aria-pressed': viewport === value,
            onClick: () => setViewport(value),
          }, label))),
        !conversation ? h('button', {
          type: 'button', className: 'vc-button', disabled: waitingForReceipt, onClick: () => setMaterialsOpen(true),
        }, '设计资料') : null,
        h('button', {
          type: 'button', className: 'vc-button vc-export-trigger', 'aria-haspopup': 'menu', 'aria-expanded': false,
          'aria-disabled': exportDisabled, onClick: exportCurrentVersion,
          onKeyDown(event) {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.nativeEvent.isComposing) exportCurrentVersion(event);
          },
        }, '导出当前版本')));

    const canvas = h('section', {
      ref: panel, id, className: 'vc-canvas', 'aria-label': canvasTitle,
      'data-compact': floatingConversation && compactCanvas,
      tabIndex: -1, 'data-vc-focus-area': 'canvas', onKeyDown: playgroundOpen ? undefined : handleHistoryShortcut,
    },
      h('style', null, canvasCss),
      h('div', { className: 'vc-canvas-toolbar' }, header, topology),
      !playgroundOpen && preview?.html ? h('div', { className: 'vc-artboard-bar' },
        h('div', { className: 'vc-artboard-tabs', role: 'group', 'aria-label': '画板' },
          boards.map((entry, offset) => h('button', {
            key: offset, type: 'button', className: 'vc-button', title: entry.title, 'aria-pressed': index === offset + 1,
            onClick: () => chooseBoard(offset + 1),
          }, entry.title))),
        h('div', { className: 'vc-artboard-controls' },
          h('select', { 'aria-label': '画布缩放', value: zoom, onChange: (event) => setZoom(event.target.value) },
            [['fit', '适应'], ['50', '50%'], ['75', '75%'], ['100', '100%']].map(([value, label]) =>
              h('option', { key: value, value }, label))),
          h('button', {
            type: 'button', className: 'vc-button', 'aria-pressed': editing, onClick: () => setEditing((previous) => !previous),
          }, '编辑画布'),
          editing ? h(React.Fragment, null,
            h('button', { type: 'button', className: 'vc-button', disabled: !history.undo.length, onClick: undo }, '撤销'),
            h('button', { type: 'button', className: 'vc-button', disabled: !history.redo.length, onClick: redo }, '重做'),
            playgroundEnabled && layer ? h('button', { type: 'button', className: 'vc-button',
              disabled: active.localCopy || !canGenerate || generating || waitingForReceipt, onClick: attachDesignLayer }, '迭代选中图层') : null) : null)) : null,
      alert || warning || exporting ? h('p', { className: 'vc-canvas-status', role: 'status' }, alert || warning || '正在导出画板') : null,
      noNewBoard && !loading ? h('p', { className: 'vc-canvas-status', 'data-outcome': true, role: 'status' },
        h('span', null, lastRevision?.error ?? '本轮回复已完成，暂无可显示的新画板。可在对话历史查看回复。'),
        canRetryLayer ? h('button', {
          type: 'button', className: 'vc-button', disabled: !canGenerate || generating || waitingForReceipt || (readDesignRevision && !canBranch),
          onClick: () => attachPlaygroundBoard(retryLayer.id, 'iterate', retryLayer.layer, lastNativeTurn.prompt, lastRevision.error),
        }, '按校验反馈重试') : null) : null,
      playgroundOpen ? h(DesignPlayground, {
        boards: playgroundEntries, positions: project.playground.positions, selectedId: boardKey, revealBoard, conversation,
        onSelect: selectPlaygroundBoard,
        onMove: (moves) => updateProject((previous) => setPlaygroundPositions(previous, moves)),
        onEdit: editPlaygroundBoard,
        onIterate: (id) => attachPlaygroundBoard(id, 'iterate'),
        onVariants: (id) => attachPlaygroundBoard(id, 'variants'),
        onLink: setLinkSource, onPlay: setPlayFrom, onPrompt: () => onPrompt(''),
        onBoardMenu: openCanvasMenu ? openBoardMenu : undefined,
        onSelectionMenu: openCanvasMenu ? openSelectionMenu : undefined,
        onBackgroundMenu: openCanvasMenu ? openBackgroundMenu : undefined,
        onMoreMenu: openCanvasMenu,
        onExportSelection: (event, entries) => showExportFormats(event, entries, { playgroundLinks }),
        exporting,
        onClearAttachment: clearPlaygroundTarget, attachedId: targetBoard?.id,
        links: drawnLinks, generating, loading,
        canGenerate: canGenerate && !waitingForReceipt && (!readDesignRevision || !turns.length || canBranch), previewWidth: width,
      }) : h('div', { className: 'vc-canvas-content' },
        h('div', { className: 'vc-design-surface' },
          h('div', {
            className: 'vc-canvas-stage', ref: stage,
            ...(singleMenuEnabled ? {
              role: 'region', 'aria-label': '单画板画布', tabIndex: 0,
              onContextMenu: openSingleBackgroundMenu, onKeyDown: openSingleBackgroundMenu,
            } : {}),
          },
            preview?.html ? h('div', {
              className: 'vc-canvas-viewport', 'data-viewport': viewport, style: { width: width * scale },
            },
            h('iframe', {
              ref: frame, className: 'vc-canvas-frame', title: '设计原型预览', sandbox: 'allow-same-origin', referrerPolicy: 'no-referrer',
              srcDoc: preview.html, onLoad: () => setFrameLoad((previous) => previous + 1), style: {
                width, height: space ? space.height / scale : '100%', transform: `scale(${scale})`,
              },
            })) : h('div', { className: 'vc-canvas-empty' },
              h('strong', null, loading ? '正在读取设计' : generating ? '正在生成设计' : '暂无原型'),
              h('p', null, active ? '这版 HTML 无法预览。' : generating
                ? '收到完整回复后，画板会出现在这里。'
                : '在对话中描述你要做的页面，完成的画板会显示在这里。'))),
          conversation),
        editing && preview?.html ? h(LayerInspector, {
          key: boardKey, layers: preview.layers, layer, edit, board, patch, align, add: addLayer,
          select: (id) => setSelection({ board: boardKey, id }),
          duplicate: () => addLayer('duplicate'),
          commentRequest: commentRequest?.board === boardKey && commentRequest.layer === layer?.id ? commentRequest : null,
          onCommentFocus: () => setCommentRequest(null),
          useComment: playgroundEnabled ? (entry) => attachPlaygroundBoard(boardKey, 'iterate', entry.layer || undefined, entry.text) : null,
          canUseComment: !active?.localCopy && canGenerate && !generating && !waitingForReceipt && (!readDesignRevision || canBranch),
          addComment: (text) => changeBoard({
            ...board, comments: [...board.comments, { layer: layer?.id ?? '', label: layer?.label ?? preview.title, text }],
          }),
          removeComment: (offset) => changeBoard({ ...board, comments: board.comments.filter((_, index) => index !== offset) }),
        }) : null));
    return h(React.Fragment, null, canvas, materialsOpen
      ? h(MaterialsDialog, { project, update: updateProject, choices, setChoices, workflow: playgroundEnabled,
        close: () => setMaterialsOpen(false) }) : null,
    comparison ? h(DesignComparison, { ...comparison, carry: carryComparisonBoards, close: () => setComparison(null) }) : null,
    linkSource && playgroundBoards.has(linkSource) ? h(ConnectorDialog, {
      source: playgroundBoards.get(linkSource), boards: playgroundEntries, links: playgroundLinks,
      save: (from, layer, to) => {
        const inherited = inheritedLinks.some((link) => link.from === from && link.layer === layer);
        updateProject((previous) => setPlaygroundLink(previous, from, layer, to || (inherited ? '' : null)));
      },
      dismiss: () => setLinkSource(null),
    }) : null,
    playFrom && playgroundBoards.has(playFrom) ? h(PrototypePlayer, {
      start: playFrom, boards: playgroundBoards, links: playgroundLinks, width, dismiss: () => setPlayFrom(null),
    }) : null);
  };
}
