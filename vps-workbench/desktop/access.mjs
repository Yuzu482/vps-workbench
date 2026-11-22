export const accessPreference = 'dsh-vps-chat:desktop-access:v1';
export const defaultAccess = Object.freeze({ mode: 'execute', workspace: 'default' });
export const accessDenied = { ok: false, code: 'workbench_browse_only', message: '工作台处于仅浏览模式。切换为 VPS 执行后可继续。' };

const localChatOperations = new Set(['preset', 'configuration', 'list', 'get', 'model-options', 'design-history']);
const localTerminalOperations = new Set(['native-list', 'native-subscription-route']);

export function validAccess(value) {
  return value && Object.keys(value).length === 2 && ['execute', 'browse'].includes(value.mode) &&
    ['default', 'read-only', 'isolated'].includes(value.workspace);
}

export function readAccess(value) {
  if (value === undefined || value === null) return defaultAccess;
  try {
    const stored = JSON.parse(value);
    if (validAccess(stored)) return stored;
  } catch {}
  return { ...defaultAccess, mode: 'browse' };
}

export function permitsChat({ mode }, op) {
  return mode === 'execute' || localChatOperations.has(op);
}

export function permitsTerminal({ mode }, op) {
  return mode === 'execute' || localTerminalOperations.has(op);
}

export function withWorkspaceAccess(body, { workspace }) {
  return body.op === 'send' && ['codex', 'antigravity'].includes(body.settings?.provider) && workspace !== 'default'
    ? { ...body, workspaceAccess: workspace } : body;
}
