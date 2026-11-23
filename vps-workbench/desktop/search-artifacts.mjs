import { validWorkflowArtifactPath } from '../../remote-workbench/vps-chat/host/index.js';
import { searchTargetId, searchUuid } from './search-snapshots.mjs';

export const searchArtifactsKey = 'dsh-vps-chat:search-artifacts:v1';
const limit = 400;
const textLimit = 1200;
const valid = (item) => item && searchUuid.test(item.runId) && searchUuid.test(item.turnId) &&
  searchTargetId.test(item.targetId) && validWorkflowArtifactPath(item.path) &&
  typeof item.text === 'string' && item.text.length <= textLimit &&
  Number.isSafeInteger(item.size) && item.size >= 0;
const keyOf = ({ runId, turnId, path }) => JSON.stringify([runId, turnId, path]);

function textSample(file) {
  if (typeof file.data !== 'string' || file.size > 96 * 1024 || file.offset !== undefined) return '';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.data, 'base64'));
    return /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text) ? '' : text.slice(0, textLimit);
  } catch { return ''; }
}

export function createSearchArtifactJournal(data) {
  let entries = [];
  let pending = Promise.resolve();
  try {
    const raw = data?.preference(searchArtifactsKey);
    if (typeof raw === 'string' && raw.length <= 2_000_000) {
      const items = JSON.parse(raw);
      if (Array.isArray(items)) entries = items.slice(0, limit).filter(valid);
    }
  } catch { /* The cache can be rebuilt from later artifact views. */ }
  return {
    entries: () => entries,
    async remember(body, result) {
      if (!data || body?.op !== 'workflow-artifacts' || result?.ok !== true) return result;
      const files = result.file ? [result.file] : result.files;
      if (!Array.isArray(files)) return result;
      const byKey = new Map(entries.map((item) => [keyOf(item), item]));
      for (const file of files) {
        const item = { runId: body.workflowRunId, turnId: body.turnId, targetId: body.targetId,
          path: file.path, size: file.size, text: result.file ? textSample(file) : '' };
        if (!valid(item)) continue;
        const key = keyOf(item);
        const previous = byKey.get(key);
        if (!result.file && previous?.size === item.size) item.text = previous.text;
        byKey.delete(key);
        byKey.set(key, item);
      }
      entries = [...byKey.values()].slice(-limit);
      const saved = JSON.stringify(entries);
      pending = pending.then(() => data.setPreference(searchArtifactsKey, saved)).catch(() => {});
      await pending;
      return result;
    },
  };
}
