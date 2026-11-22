const modelId = /^[A-Za-z0-9_.:-]{1,100}$/;
const effortId = /^[A-Za-z0-9_-]{1,24}$/;
const effortNames = { default: '账号默认', none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

export function effortName(value) {
  return Object.hasOwn(effortNames, value) ? effortNames[value] : value;
}

export function validTurnMetadata(turn) {
  const { contextUsage, model, effort } = turn;
  const usage = contextUsage == null || (typeof contextUsage === 'object' && !Array.isArray(contextUsage) &&
    Number.isSafeInteger(contextUsage.usedTokens) && contextUsage.usedTokens >= 0 &&
    (contextUsage.contextWindow === null || (Number.isSafeInteger(contextUsage.contextWindow) && contextUsage.contextWindow > 0)));
  return usage && (model == null || (typeof model === 'string' && modelId.test(model))) &&
    (effort == null || (typeof effort === 'string' && effortId.test(effort)));
}

export function readModelCatalog({ models }) {
  if (!Array.isArray(models) || models.length > 64 || !models.every((entry) =>
    typeof entry?.id === 'string' && modelId.test(entry.id) &&
    typeof entry.displayName === 'string' && entry.displayName.trim() && entry.displayName.length <= 80 &&
    !/[\p{Cc}]/u.test(entry.displayName) && typeof entry.isDefault === 'boolean' &&
    Array.isArray(entry.efforts) && entry.efforts.length <= 8 &&
    entry.efforts.every((effort) => typeof effort === 'string' && effortId.test(effort)) &&
    new Set(entry.efforts).size === entry.efforts.length &&
    (entry.defaultEffort === null || entry.efforts.includes(entry.defaultEffort))) ||
    new Set(models.map((entry) => entry.id)).size !== models.length) {
    throw new Error('模型目录格式无法确认。');
  }
  return models;
}
