export const localBackends = Object.freeze({
  codex: { label: 'Codex', interactive: false },
  'claude-sdk': { label: 'Claude Agent SDK', interactive: true },
  antigravity: { label: 'Antigravity ACP', interactive: true },
});

export const isLocalBackend = (value) => typeof value === 'string' && Object.hasOwn(localBackends, value);
export const usesLocalControls = (value) => isLocalBackend(value) && localBackends[value].interactive;

const apiKeys = new Map([
  ['codex', /^sk-(?!ant-)[a-z0-9_-]{10,512}$/iu],
  ['claude-sdk', /^sk-ant-[a-zA-Z0-9_-]{10,512}$/u],
]);
export const validLocalApiKey = (backend, value) => typeof value === 'string' && apiKeys.get(backend)?.test(value) === true;

export const providerDefaultModels = Object.freeze([{ id: 'default', label: '账号默认模型', efforts: ['default'], defaultEffort: 'default' }]);
