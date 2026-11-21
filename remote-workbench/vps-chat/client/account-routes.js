export const accountGroups = [
  {
    id: 'codex', label: 'Codex', icon: 'codex', detail: 'ChatGPT 账号与 VPS 上的 Codex CLI。',
    actions: [
      { id: 'chatgpt-account', label: 'ChatGPT 账号', title: '管理 ChatGPT 账号' },
      { id: 'codex-login', label: 'VPS 登录 Codex', title: 'Codex CLI 登录', terminal: true },
    ],
  },
  {
    id: 'claude-subscription', label: 'Claude 订阅', icon: 'claude-sdk',
    detail: 'SDK 与订阅终端共用此 VPS 用户的 Claude Code 登录。',
    actions: [
      { id: 'claude-account', label: 'Claude 账号', title: '管理 Claude 账号' },
      { id: 'claude-login', label: 'VPS 登录 Claude', title: 'Claude Code 订阅登录', terminal: true },
    ],
  },
  {
    id: 'claude', label: 'Claude API', icon: 'key', detail: '在 Console 管理密钥，并为 VPS 执行端设置密钥。',
    actions: [
      { id: 'claude-console', label: 'API 密钥控制台', title: '管理 Claude API 密钥' },
      { id: 'claude-api-key', label: '设置 VPS 密钥', title: '设置 VPS 上的 Claude API 密钥', terminal: true },
    ],
  },
  {
    id: 'antigravity', label: 'Antigravity', icon: 'antigravity', detail: 'Google 账号与 VPS 上的 Antigravity 专用登录。',
    actions: [
      { id: 'google-account', label: 'Google 账号', title: '管理 Google 账号' },
      { id: 'antigravity-login', label: 'VPS 登录 Antigravity', title: 'Antigravity CLI 登录', terminal: true },
    ],
  },
];

const actions = new Map(accountGroups.flatMap(group => group.actions.map(action => [action.id, action])));
export const defaultAccountAction = 'claude-account';
export const getAccountAction = (id) => actions.get(id);

const startupMessages = Object.freeze({
  account_encrypted_home_required: '执行端登录与密钥保存需要当前 VPS 用户的加密家目录。',
  account_browser_storage_unavailable: 'VPS 缺少可用的临时浏览器目录。',
  account_egress_unverified: 'VPS 出口未通过核验，请检查连接预设。',
  account_terminal_missing: '当前 VPS 缺少 xterm，无法打开账号操作窗口。',
  account_cli_missing: '当前 VPS 用户找不到此执行端的 CLI。',
});

export function accountStartupMessage(code) {
  return typeof code === 'string' && Object.hasOwn(startupMessages, code) ? startupMessages[code] : null;
}

export function validAccountRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = Object.hasOwn(value, 'action') ? ['op', 'targetId', 'action'] : ['op', 'targetId'];
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)) &&
    typeof value.targetId === 'string' && /^[a-f0-9]{64}$/.test(value.targetId) &&
    (!Object.hasOwn(value, 'action') || actions.has(value.action));
}
