import { createArtboard, extractHtmlFences } from './design-preview.js';
import { emptyBoard, layerRevisionFields, layerRevisionMeta, maxLayerEdits, normalizeBoard, normalizeEdit } from './design-state.js';
import { workbenchStorage } from './workbench-storage.js';
import { parse } from 'parse5';

const revisionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const layerId = /^(?:e[0-9]{1,4}|n[0-9a-f]{16})$/;
const boardId = new RegExp(`${revisionId.source.slice(0, -1)}:[1-6]$`, 'i');
const maxSnapshotLength = 2 * 1024 * 1024;

export function layerRevisionKey(projectKey, turnId) {
  return `${projectKey}:revision:${turnId}`;
}

export function serializeLayerRevision(revision) {
  const snapshot = JSON.stringify(revision);
  if (snapshot.length > maxSnapshotLength) throw new Error('画板基线超过本机保存上限。');
  return snapshot;
}

export function readLayerRevisionOutcome(projectKey, turnId) {
  try {
    const value = workbenchStorage.getItem(`${layerRevisionKey(projectKey, turnId)}:outcome`);
    if (value === 'accepted') return workbenchStorage.getItem(layerRevisionKey(projectKey, turnId)) == null ? 'rejected' : value;
    return value === 'rejected' ? value : null;
  } catch {
    return null;
  }
}

export function saveLayerRevisionOutcome(projectKey, turnId, outcome) {
  const key = `${layerRevisionKey(projectKey, turnId)}:outcome`;
  if (workbenchStorage.getItem(key) !== outcome) workbenchStorage.setItem(key, outcome);
}

function validSnapshot(snapshot) {
  return revisionId.test(snapshot?.base ?? '') && revisionId.test(snapshot?.sourceId ?? '') &&
    layerId.test(snapshot?.layer ?? '') && Array.isArray(snapshot?.sources) &&
    snapshot.sources.length >= 1 && snapshot.sources.length <= 6 &&
    snapshot.sources.every((source) => typeof source === 'string' && source.trim()) &&
    Number.isInteger(snapshot.index) && snapshot.index >= 1 && snapshot.index <= snapshot.sources.length &&
    snapshot.boards && typeof snapshot.boards === 'object' && !Array.isArray(snapshot.boards);
}

function findMetadata(reply) {
  const metadata = [];
  for (const source of extractHtmlFences(reply, Infinity)) {
    const head = parse(source, { scriptingEnabled: false }).childNodes
      .find(({ tagName }) => tagName === 'html')?.childNodes.find(({ tagName }) => tagName === 'head');
    for (const node of head?.childNodes ?? []) {
      if (node.tagName !== 'meta' || !node.attrs.some(({ name, value }) =>
        name === 'name' && value.toLowerCase() === layerRevisionMeta)) continue;
      metadata.push(node.attrs.find(({ name }) => name === 'content')?.value);
    }
  }
  return metadata;
}

function reject(message) {
  return { outcome: 'rejected', error: message };
}

export function readLayerRevision(projectKey, turn) {
  let raw;
  try {
    raw = workbenchStorage.getItem(layerRevisionKey(projectKey, turn.id));
  } catch {
    return reject('无法核对本机图层基线。请检查工作台存储后重试。');
  }
  if (raw == null) {
    const recorded = readLayerRevisionOutcome(projectKey, turn.id);
    const containsMetadata = typeof turn.reply === 'string' && turn.reply.toLowerCase().includes(layerRevisionMeta) &&
      findMetadata(turn.reply).length > 0;
    return recorded || containsMetadata ? reject('缺少本轮冻结的画板基线。请从原画板重新发起迭代。') : null;
  }
  if (turn.state !== 'complete') return { outcome: 'waiting' };
  let snapshot;
  try {
    snapshot = raw.length <= maxSnapshotLength ? JSON.parse(raw) : null;
    if (!validSnapshot(snapshot)) throw new Error('invalid_snapshot');
  } catch {
    return reject('本机保存的图层基线不可用。请从原画板重新发起迭代。');
  }
  const boards = Object.fromEntries(snapshot.sources.map((_, i) => [i + 1,
    snapshot.boards[i + 1] ? normalizeBoard(snapshot.boards[i + 1]) : emptyBoard]));
  const original = boards[snapshot.index];
  const board = createArtboard(snapshot.sources[snapshot.index - 1], original);
  const layer = board?.layers.find(({ id }) => id === snapshot.layer);
  if (!layer) return reject('冻结的画板中找不到目标图层。请重新选择图层。');
  function rejectRevision(message) {
    return { ...reject(message), retryTarget: { id: `${snapshot.sourceId}:${snapshot.index}`, layer: layer.id } };
  }

  let proposal;
  try {
    const metadata = findMetadata(turn.reply);
    proposal = metadata.length === 1 && typeof metadata[0] === 'string' && metadata[0].length <= 4096
      ? JSON.parse(metadata[0]) : null;
  } catch {
    return rejectRevision('模型返回的图层修改记录无法解析。请用相同范围重试。');
  }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) ||
      Object.keys(proposal).length !== 3 || !Object.hasOwn(proposal, 'base') ||
      !Object.hasOwn(proposal, 'layer') || !Object.hasOwn(proposal, 'changes')) {
    return rejectRevision('模型未返回一份有效的图层修改记录。请重试，或重新选择「迭代此画板」。');
  }
  if (proposal.base !== snapshot.base || proposal.layer !== snapshot.layer) {
    return rejectRevision('模型返回的图层或基线与本轮选择不一致。请用相同范围重试。');
  }
  if (!proposal.changes || typeof proposal.changes !== 'object' || Array.isArray(proposal.changes)) {
    return rejectRevision('模型返回的属性格式无效。请用相同范围重试。');
  }
  const entries = Object.entries(proposal.changes);
  const fields = layerRevisionFields(layer.editable);
  const changes = normalizeEdit(proposal.changes);
  if (!entries.length || entries.some(([name, value]) => !fields.includes(name) || changes[name] !== value)) {
    return rejectRevision('模型返回了未开放的属性或超出范围的值。请缩小修改范围后重试。');
  }
  if (!Object.hasOwn(original.edits, layer.id) && Object.keys(original.edits).length >= maxLayerEdits) {
    return reject('目标画板上的本地修改已达到上限。');
  }
  const oldEdit = original.edits[layer.id] ?? {};
  if (entries.every(([name, value]) => value === (name === 'text' ? layer.text : oldEdit[name]))) {
    return rejectRevision('模型返回的属性与当前值相同。请明确希望怎样修改。');
  }
  boards[snapshot.index] = { ...original, edits: { ...original.edits, [layer.id]: { ...oldEdit, ...changes } } };
  const prefix = `${snapshot.sourceId}:`;
  const rebase = (id) => id.startsWith(prefix) ? `${turn.id}:${id.slice(prefix.length)}` : id;
  const links = Array.isArray(snapshot.links) ? snapshot.links.flatMap((link) =>
    typeof link?.from === 'string' && link.from.startsWith(prefix) && boardId.test(link.from) &&
    typeof link.to === 'string' && boardId.test(link.to) && layerId.test(link.layer)
      ? [{ from: rebase(link.from), to: rebase(link.to), layer: link.layer }] : []) : [];
  return { outcome: 'accepted', sources: snapshot.sources, boards, boardIndex: snapshot.index, links };
}
