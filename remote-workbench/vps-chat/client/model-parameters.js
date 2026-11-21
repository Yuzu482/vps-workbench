export const parameterLevels = Object.freeze(['low', 'medium', 'high']);

export function outputTokenRange(provider) {
  return { min: 1024, max: provider === 'claude' ? 8192 : 65_536 };
}

const claudeFields = Object.freeze(['maxOutputTokens', 'reasoningEffort']);
const providerFields = Object.freeze({
  codex: Object.freeze(['verbosity']),
  claude: claudeFields,
  'claude-sdk': claudeFields,
  antigravity: Object.freeze(['reasoningEffort']),
});
const emptyFields = Object.freeze([]);

export function modelParameterFields(provider) {
  return Object.hasOwn(providerFields, provider) ? providerFields[provider] : emptyFields;
}

export function validModelParameters(provider, parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
  const entries = Object.entries(parameters);
  const allowed = modelParameterFields(provider);
  const { min, max } = outputTokenRange(provider);
  return entries.length > 0 && entries.every(([key, value]) => allowed.includes(key) &&
    (key === 'maxOutputTokens'
      ? Number.isSafeInteger(value) && value >= min && value <= max
      : parameterLevels.includes(value)));
}

export function readModelParameterFields(provider, { fields }) {
  const allowed = modelParameterFields(provider);
  if (!Array.isArray(fields) || fields.length > allowed.length || new Set(fields).size !== fields.length ||
      fields.some((field) => !allowed.includes(field))) throw new Error('高级参数列表无法确认。');
  return fields;
}
