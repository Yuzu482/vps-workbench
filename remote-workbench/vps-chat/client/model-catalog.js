const modelId = /^[A-Za-z0-9_.:-]{1,100}$/;
const effortId = /^[A-Za-z0-9_-]{1,24}$/;
const effortNames = { default: '账号默认', none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

export function effortName(value) {
  return Object.hasOwn(effortNames, value) ? effortNames[value] : value;
}

export function validContextUsage(usage) {
  return usage && typeof usage === 'object' && !Array.isArray(usage) &&
    Number.isSafeInteger(usage.usedTokens) && usage.usedTokens >= 0 &&
    (usage.contextWindow === null || (Number.isSafeInteger(usage.contextWindow) && usage.contextWindow > 0)) &&
    (usage.kind === undefined || usage.kind === 'request_input' ||
      (usage.kind === 'turn_input' && usage.contextWindow === null));
}

export function validTurnMetadata(turn) {
  const { contextUsage, model, effort } = turn;
  const usage = contextUsage == null || validContextUsage(contextUsage);
  return usage && (model == null || (typeof model === 'string' && modelId.test(model))) &&
    (effort == null || (typeof effort === 'string' && effortId.test(effort)));
}

const validWindow = (value) => Number.isSafeInteger(value) && value > 0;

// Published model capacities are separate from the effective limit reported by a route.
// OpenAI: https://developers.openai.com/api/docs/models
// Anthropic: https://platform.claude.com/docs/en/build-with-claude/context-windows
const openAiWindows = new Map([
  ['gpt-5.4', 1_050_000], ['gpt-5.4-mini', 400_000], ['gpt-5.5', 1_050_000],
  ['gpt-5.6', 1_050_000], ['gpt-5.6-sol', 1_050_000], ['gpt-6.1-sol', 1_050_000],
  ['gpt-6-sol', 1_050_000], ['gpt-6-astra', 1_050_000], ['gpt-6-luna', 1_050_000],
  ['gpt-6.2-sol', 1_050_000], ['gpt-6.2-astra', 1_050_000], ['gpt-6.1-terra', 1_050_000],
]);
const claudeWindows = new Map([
  ['claude-sonnet-4-6', 1_000_000], ['claude-opus-4-6', 1_000_000],
  ['claude-opus-4-7', 1_000_000], ['claude-opus-4-8', 1_000_000],
  ['claude-fable-5-2', 1_000_000], ['claude-sonnet-5-5', 1_000_000],
  ['claude-opus-5-5', 1_000_000], ['claude-haiku-5-5', 1_000_000],
]);
const publishedWindows = { codex: openAiWindows, claude: claudeWindows, 'claude-sdk': claudeWindows };

export function currentModelContext({ provider, selection, catalog, report }) {
  const id = selection?.id ?? report.model ?? catalog?.models?.find(({ isDefault }) => isDefault)?.id;
  const entry = catalog?.models?.find((model) => model.id === id);
  const published = publishedWindows[provider]?.get(id);
  const sameReportedModel = id ? report.usageModel === id : provider === 'antigravity';
  const fromTurn = sameReportedModel && !report.earlierUsage &&
    (selection?.effort == null || selection.effort === report.effort) && report.usage?.contextWindow;
  if (validWindow(fromTurn)) return { id, limit: fromTurn, source: 'runtime', published };
  if (validWindow(entry?.contextWindow)) return { id, limit: entry.contextWindow, source: 'catalog', published };
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  if (provider === 'codex' && id === 'gpt-6.1-sol') return { id, limit: 500_000, source: 'codex-default', published };
  return { id, limit: published, source: published ? 'published' : null, published };
}

export function readModelCatalog({ models }) {
  if (!Array.isArray(models) || models.length > 64 || !models.every((entry) =>
    typeof entry?.id === 'string' && modelId.test(entry.id) &&
    typeof entry.displayName === 'string' && entry.displayName.trim() && entry.displayName.length <= 80 &&
    !/[\p{Cc}]/u.test(entry.displayName) && typeof entry.isDefault === 'boolean' &&
    Array.isArray(entry.efforts) && entry.efforts.length <= 8 &&
    entry.efforts.every((effort) => typeof effort === 'string' && effortId.test(effort)) &&
    new Set(entry.efforts).size === entry.efforts.length &&
    (entry.defaultEffort === null || entry.efforts.includes(entry.defaultEffort)) &&
    (entry.contextWindow === undefined || entry.contextWindow === null || validWindow(entry.contextWindow))) ||
    new Set(models.map((entry) => entry.id)).size !== models.length) {
    throw new Error('模型目录格式无法确认。');
  }
  return models;
}
