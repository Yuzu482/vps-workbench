import { createArtboard } from '../client/design-preview.js';
import { portableHtml, projectArchive } from './portable.js';
import { snapshotBoard } from './snapshot.js';
import { makePdf } from './pdf.js';
import { makePresentation } from './pptx.js';

const maxPlaygroundBoards = 500;

function playgroundRoutes(boards, links) {
  const destinations = new Map();
  for (const [index, board] of boards.entries()) {
    if (typeof board?.id !== 'string' || !board.id) continue;
    // An ambiguous ID must never point to a different board by accident.
    destinations.set(board.id, destinations.has(board.id) ? undefined : index + 1);
  }
  const overrides = new Map();
  for (const link of links) {
    if (![link?.from, link?.layer, link?.to].every((value) => typeof value === 'string' && value)) continue;
    overrides.set(`${link.from}:${link.layer}`, link.to);
  }
  return (board) => (layerId, builtIn) => {
    const custom = layerId ? overrides.get(`${board.id}:${layerId}`) : undefined;
    if (!custom && !builtIn) return undefined;
    const target = custom ?? (typeof board.versionId === 'string' ? `${board.versionId}:${builtIn}` : undefined);
    return target === board.id ? 0 : destinations.get(target) ?? 0;
  };
}

export async function createDesignExport(boards, format, options) {
  const isPlayground = (format === 'html' || format === 'zip') && Array.isArray(options?.playgroundLinks);
  const maximum = isPlayground ? maxPlaygroundBoards : 6;
  if (!Array.isArray(boards) || boards.length < 1 || boards.length > maximum) {
    throw new Error(isPlayground ? '请选择一到 500 个画板导出。' : '请选择一到六个画板导出。');
  }
  const routes = isPlayground ? playgroundRoutes(boards, options.playgroundLinks) : null;
  const approved = boards.map((board, index) => {
    const previewOptions = routes ? { prototypeDestination: routes(board) } : undefined;
    const html = typeof board?.html === 'string' && createArtboard(board.html, undefined, undefined, previewOptions)?.html;
    if (!html) throw new Error('此画板无法导出。');
    const title = typeof board.title === 'string' ? board.title.trim().slice(0, 120) : '';
    return { title: title || `画板 ${index + 1}`, html };
  });
  if (format === 'html') return new Blob([portableHtml(approved)], { type: 'text/html;charset=utf-8' });
  if (format === 'zip') return projectArchive(approved);
  if (format !== 'pdf' && format !== 'pptx') throw new Error('不支持此导出格式。');
  const snapshots = [];
  for (const board of approved) snapshots.push(await snapshotBoard(board));
  return format === 'pdf' ? makePdf(snapshots) : makePresentation(snapshots);
}

export async function downloadDesign(boards, format, options) {
  const output = await createDesignExport(boards, format, options);
  const url = URL.createObjectURL(output);
  const link = document.createElement('a');
  link.href = url;
  link.download = `dsh-design.${format}`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
