import {
  maxWorkflowArtifactBytes, validWorkflowArtifactPath, validWorkflowArtifactQuery,
} from '../../remote-workbench/vps-chat/host/index.js';

const finished = new Set(['complete', 'failed', 'stopped']);
const changedRun = { ok: false, code: 'workflow_output_changed', message: '找不到与此连接和阶段匹配的产物记录。请核对最近一次工作流运行。' };
const unreadable = { ok: false, code: 'workflow_output_unavailable', message: '暂时无法读取阶段产物。' };
const maxPreviewBytes = 1024 * 1024;

function matchesRun(body, run) {
  if (![4, 5].includes(run?.version) || run.id !== body.workflowRunId || !validWorkflowArtifactQuery(body)) return false;
  const index = run.rows.findIndex(({ state, targetId, sessionId, turnId }) =>
    finished.has(state) && targetId === body.targetId && sessionId === body.sessionId && turnId === body.turnId);
  return index >= 0 && run.workflow.stages[index].provider === body.settings?.provider;
}

function fileEntry(entry) {
  return validWorkflowArtifactPath(entry?.path) && Number.isSafeInteger(entry?.size) && entry.size >= 0;
}

export async function readWorkflowArtifacts(body, { readRun, backend, isAllowed = () => true }) {
  function allowed() {
    try { return isAllowed() && matchesRun(body, readRun()); } catch { return false; }
  }
  if (!allowed()) return changedRun;
  const { workflowRunId: _runId, ...request } = body;
  const reply = await backend.request(request, { current: true });
  if (!allowed()) return changedRun;
  if (reply?.ok === false && typeof reply.message === 'string' && reply.message.length <= 320 &&
      typeof reply.code === 'string' && /^[a-z_]{1,64}$/.test(reply.code)) {
    return { ok: false, message: reply.message, code: reply.code };
  }
  if (reply?.ok !== true) return unreadable;
  if (request.path === undefined) {
    const { files, truncated } = reply;
    if (!Array.isArray(files) || files.length > 256 || typeof truncated !== 'boolean' || !files.every(fileEntry) ||
        files.some(({ path }, index) => path <= (files[index - 1]?.path ?? request.after ?? ''))) return unreadable;
    return { ok: true, files: files.map(({ path, size }) => ({ path, size })), truncated };
  }
  const { file } = reply;
  if (!fileEntry(file) || file.path !== request.path) return unreadable;
  const chunk = request.offset !== undefined;
  if (chunk ? (file.size > maxWorkflowArtifactBytes || file.offset !== request.offset ||
      request.offset >= Math.max(1, file.size) || !/^[a-f0-9]{64}$/.test(file.revision ?? '')) :
    file.size > maxPreviewBytes) return unreadable;
  const count = Math.min(maxPreviewBytes, file.size - (request.offset ?? 0));
  if (typeof file.data !== 'string' || file.data.length !== 4 * Math.ceil(count / 3)) return unreadable;
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.length !== count || bytes.toString('base64') !== file.data) return unreadable;
  return { ok: true, file: { path: file.path, size: file.size, data: file.data,
    ...(chunk ? { offset: file.offset, revision: file.revision } : {}) } };
}
