import { readWorkflowRun } from '../workflow-engine/runner.mjs';
import { exactFields } from '../workflow-engine/state.mjs';

const limit = 30;
const maxBytes = 5 * 1024 * 1024;
const terminal = new Set(['complete', 'failed', 'stopped']);

export function readMixedRunHistory(raw) {
  if (raw === undefined || raw === null) return [];
  const invalid = () => new Error('无法读取混合工作流历史，原记录已保留。');
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maxBytes) throw invalid();
  try {
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > limit) throw invalid();
    const ids = new Set();
    return entries.map((entry) => {
      if (!exactFields(entry, 'archivedAt', 'run') || typeof entry.archivedAt !== 'string' ||
          new Date(entry.archivedAt).toISOString() !== entry.archivedAt) throw invalid();
      const run = readWorkflowRun(JSON.stringify(entry.run));
      if (run?.version !== 5 || !terminal.has(run.phase) || ids.has(run.id)) throw invalid();
      ids.add(run.id);
      return { archivedAt: entry.archivedAt, run };
    });
  } catch { throw invalid(); }
}

export function archiveMixedRun(history, run) {
  if (!terminal.has(run.phase)) throw new Error('请先处理原混合工作流。');
  const entries = [{ archivedAt: new Date().toISOString(), run }, ...history.filter((entry) => entry.run.id !== run.id)].slice(0, limit);
  while (Buffer.byteLength(JSON.stringify(entries)) > maxBytes) entries.pop();
  return entries;
}
