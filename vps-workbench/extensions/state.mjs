export const extensionPreferenceKey = 'dsh-vps-chat:extensions:v1';

const idPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const targetPattern = /^[a-f0-9]{64}$/;
const modelPattern = /^[A-Za-z0-9_.:-]{1,100}$/;
const effortPattern = /^[A-Za-z0-9_-]{1,24}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const memoryProviders = new Set(['codex', 'claude', 'claude-sdk', 'antigravity']);
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const allControls = /[\u0000-\u001f\u007f-\u009f]/;
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).byteLength;
const jsonBytes = value => bytes(JSON.stringify(value));
const maxStoredBytes = 2 * 1024 * 1024;
const manifestKeys = ['schema', 'id', 'name', 'version', 'description', 'prompts'];
const baseStateKeys = ['servers', 'plugins', 'memories', 'memoryEnabled'];
const projectStateKeys = ['automaticMemory', 'isolatedConversations', 'automaticMemoryHistory'];
const maxManualMemories = 128;
const maxGeneratedMemories = 128;
const maxScopeGeneratedMemories = 24;
const maxMemoryHistory = 256;
const maxMemoryCandidates = 3;
const maxTurnMemories = 5;
const maxTurnExtensionBytes = 8192;

function requireValid(condition) {
  if (!condition) throw new TypeError('invalid_extensions');
}

function fields(value, ...keys) {
  requireValid(value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}

function validText(value, maxChars, maxBytes, { multiline = false, empty = false } = {}) {
  return typeof value === 'string' && value.length <= maxChars && bytes(value) <= maxBytes &&
    !(multiline ? controls : allControls).test(value) && (empty || value.trim().length > 0);
}

function validateId(value, pattern = idPattern) {
  requireValid(typeof value === 'string' && pattern.test(value));
}

function validateProjectId(value) {
  requireValid(value === null || validText(value, 256, 256));
}

function validateProjectScope(targetId, projectId) {
  validateId(targetId, targetPattern);
  requireValid(validText(projectId, 256, 256));
}

function validateEnabled(value) {
  requireValid(typeof value === 'boolean');
}

function serverEntry(value) {
  const hasLocal = Object.hasOwn(value ?? {}, 'local');
  fields(value, 'id', 'targetId', 'enabled', ...(hasLocal ? ['local'] : []));
  const { id, targetId, enabled } = value;
  validateId(id);
  validateId(targetId, targetPattern);
  validateEnabled(enabled);
  if (!hasLocal) return Object.freeze({ id, targetId, enabled });
  const { local } = value;
  fields(local, 'url', 'tools');
  requireValid(validLocalMcpEndpoint(local.url, local.tools));
  return Object.freeze({ id, targetId, enabled, local: Object.freeze({ url: local.url, tools: Object.freeze([...local.tools]) }) });
}

export function validLocalMcpEndpoint(url, tools) {
  const endpoint = typeof url === 'string' && url.length <= 256 && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/[A-Za-z0-9._/-]*$/.exec(url);
  return Boolean(endpoint && Number(endpoint[1]) <= 65535 && Array.isArray(tools) && tools.length > 0 && tools.length <= 32 &&
    tools.every((tool) => typeof tool === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tool)) && new Set(tools).size === tools.length);
}

function noteContent(value) {
  const { title, text } = value;
  requireValid(validText(title, 80, 320) && validText(text, 2000, 2400, { multiline: true }));
  return { title, text };
}

const memoryKeys = ['id', 'targetId', 'projectId', 'title', 'text', 'enabled'];

function manualMemoryEntry(value) {
  fields(value, ...memoryKeys);
  const { id, targetId, projectId, enabled } = value;
  validateId(id);
  validateId(targetId, targetPattern);
  validateProjectId(projectId);
  validateEnabled(enabled);
  return Object.freeze({ id, targetId, projectId, ...noteContent(value), enabled });
}

function sourceEntry(value) {
  fields(value, 'targetId', 'sessionId', 'turnId', 'provider');
  const { targetId, sessionId, turnId, provider } = value;
  validateId(targetId, targetPattern);
  validateId(sessionId, uuidPattern);
  validateId(turnId, uuidPattern);
  requireValid(memoryProviders.has(provider));
  return Object.freeze({ targetId, sessionId: sessionId.toLowerCase(), turnId: turnId.toLowerCase(), provider });
}

function memoryEntry(value) {
  if (!value || !Object.hasOwn(value, 'source')) return manualMemoryEntry(value);
  fields(value, ...memoryKeys, 'source', 'topic', 'edited');
  const { source, topic, edited, ...manual } = value;
  const note = manualMemoryEntry(manual);
  const origin = sourceEntry(source);
  requireValid(validText(topic, 80, 320) && (origin.provider !== 'codex' || origin.targetId === note.targetId));
  validateEnabled(edited);
  return Object.freeze({ ...note, source: origin, topic, edited });
}

function validateRevision(revision) {
  requireValid(Number.isSafeInteger(revision) && revision > 0);
}

function policyEntry(value) {
  fields(value, 'targetId', 'projectId', 'enabled', 'revision');
  const { targetId, projectId, enabled, revision } = value;
  validateId(targetId, targetPattern);
  validateProjectId(projectId);
  validateEnabled(enabled);
  validateRevision(revision);
  return Object.freeze({ targetId, projectId, enabled, revision });
}

function personalPolicyEntry(value) {
  fields(value, 'enabled', 'revision');
  const { enabled, revision } = value;
  validateEnabled(enabled);
  if (revision !== 0 || enabled) validateRevision(revision);
  return Object.freeze({ enabled, revision });
}

function memoryExtractionEntry(value) {
  const keys = ['model', 'effort'].filter(key => Object.hasOwn(value ?? {}, key));
  fields(value, 'targetId', ...keys);
  const { targetId, model, effort } = value;
  validateId(targetId, targetPattern);
  if (keys.includes('model')) validateId(model, modelPattern);
  if (keys.includes('effort')) {
    requireValid(model !== undefined);
    validateId(effort, effortPattern);
  }
  return Object.freeze({ ...value });
}

export function readMemoryExtractionChange(change) {
  const { op, ...choice } = change ?? {};
  requireValid(op === 'set-memory-extraction-model');
  return memoryExtractionEntry(choice);
}

function isolationEntry(value) {
  fields(value, 'targetId', 'sessionId');
  const { targetId, sessionId } = value;
  validateId(targetId, targetPattern);
  validateId(sessionId, uuidPattern);
  return Object.freeze({ targetId, sessionId: sessionId.toLowerCase() });
}

const memoryScopeKey = ({ targetId, projectId }) => projectId === null ? `${targetId}:personal` : `${targetId}:project:${projectId}`;
const conversationKey = item => `${item.targetId}:${item.sessionId}`;
const sourceKey = item => `${conversationKey(item)}:${item.turnId}`;
const inAutomaticScope = (note, targetId, projectId) => note.targetId === targetId && note.projectId === projectId &&
  (projectId !== null || Boolean(note.source));

function pluginEntry(value, enabled) {
  fields(value, ...manifestKeys);
  const { schema, id, name, version, description, prompts } = value;
  validateId(id);
  validateEnabled(enabled);
  requireValid(schema === 1 && validText(name, 80, 320) && validText(version, 40, 160) &&
    validText(description, 400, 1200, { multiline: true, empty: true }) &&
    Array.isArray(prompts) && prompts.length > 0 && prompts.length <= 12);
  const templates = Object.freeze(Array.from(prompts, prompt => {
    fields(prompt, 'title', 'text');
    return Object.freeze(noteContent(prompt));
  }));
  requireValid(new Set(templates.map(item => item.title)).size === templates.length);
  const manifest = { schema, id, name, version, description, prompts: templates };
  requireValid(jsonBytes(manifest) <= 24 * 1024);
  return Object.freeze({ ...manifest, enabled });
}

function storedPlugin(value) {
  fields(value, ...manifestKeys, 'enabled');
  const { enabled, ...manifest } = value;
  return pluginEntry(manifest, enabled);
}

function validateList(value, max, validate, identity = item => `${item.targetId ?? ''}:${item.id}`) {
  requireValid(Array.isArray(value) && value.length <= max);
  const items = Array.from(value, validate);
  const identities = new Set(items.map(identity));
  requireValid(identities.size === items.length);
  return Object.freeze(items);
}

function validateState(value) {
  const hasPersonalPolicy = value && Object.hasOwn(value, 'personalMemory');
  const hasProjectState = hasPersonalPolicy || value && projectStateKeys.some(key => Object.hasOwn(value, key));
  const hasExtractionModels = value && Object.hasOwn(value, 'memoryExtractionModels');
  fields(value, ...baseStateKeys, ...(hasProjectState ? projectStateKeys : []), ...(hasPersonalPolicy ? ['personalMemory'] : []),
    ...(hasExtractionModels ? ['memoryExtractionModels'] : []));
  validateEnabled(value.memoryEnabled);
  const memories = validateList(value.memories, maxManualMemories + maxGeneratedMemories, memoryEntry);
  const generated = memories.filter(note => note.source);
  requireValid((hasProjectState || !generated.length) && generated.length <= maxGeneratedMemories &&
    memories.length - generated.length <= maxManualMemories);
  const topics = new Map();
  for (const note of generated) {
    requireValid(hasPersonalPolicy || note.projectId !== null);
    const scope = memoryScopeKey(note);
    const scopeTopics = topics.get(scope) ?? new Set();
    const topic = normalizedText(note.topic);
    requireValid(scopeTopics.size < maxScopeGeneratedMemories && !scopeTopics.has(topic));
    scopeTopics.add(topic);
    topics.set(scope, scopeTopics);
  }
  return Object.freeze({
    servers: validateList(value.servers, 64, serverEntry),
    plugins: validateList(value.plugins, 32, storedPlugin),
    memories,
    memoryEnabled: value.memoryEnabled,
    automaticMemory: validateList(hasProjectState ? value.automaticMemory : [], 256, policyEntry, memoryScopeKey),
    isolatedConversations: validateList(hasProjectState ? value.isolatedConversations : [], 2048, isolationEntry, conversationKey),
    automaticMemoryHistory: validateList(hasProjectState ? value.automaticMemoryHistory : [], maxMemoryHistory, sourceEntry, sourceKey),
    personalMemory: personalPolicyEntry(hasPersonalPolicy ? value.personalMemory : { enabled: false, revision: 0 }),
    memoryExtractionModels: validateList(hasExtractionModels ? value.memoryExtractionModels : [], 256, entry => {
      const choice = memoryExtractionEntry(entry);
      requireValid(choice.model !== undefined);
      return choice;
    }, choice => choice.targetId),
  });
}

export function readExtensions(raw) {
  if (raw == null) return validateState({ servers: [], plugins: [], memories: [], memoryEnabled: false });
  requireValid(typeof raw === 'string' && raw.length <= maxStoredBytes && bytes(raw) <= maxStoredBytes);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError('invalid_extensions');
  }
  return validateState(parsed);
}

function targetEntryMatches(item, { id, targetId }) {
  return item.targetId === targetId && item.id === id;
}

function replaceEntry(items, replacement) {
  if (!items.some(item => targetEntryMatches(item, replacement))) return [...items, replacement];
  return items.map(item => targetEntryMatches(item, replacement) ? replacement : item);
}

function findProjectPolicy(state, targetId, projectId) {
  return state.automaticMemory.find(item => item.targetId === targetId && item.projectId === projectId);
}

function findAutomaticPolicy(state, targetId, projectId, scopedPersonal = false) {
  if (typeof targetId !== 'string' || !targetPattern.test(targetId)) return null;
  return findProjectPolicy(state, targetId, projectId) ?? (projectId === null && !scopedPersonal ? state.personalMemory : null);
}

function isIsolated(state, targetId, sessionId) {
  return typeof sessionId === 'string' && state.isolatedConversations.some(item =>
    item.targetId === targetId && item.sessionId === sessionId.toLowerCase());
}

function normalizedText(value) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function generatedId(notes, targetId, turnId, index) {
  const stem = `auto-${turnId.replaceAll('-', '').slice(0, 20)}-${index}`;
  let id = stem;
  let suffix = 0;
  while (notes.some(note => note.targetId === targetId && note.id === id)) id = `${stem}-${++suffix}`;
  return id;
}

function addGeneratedNote(notes, note) {
  const allGenerated = notes.filter(item => item.source);
  const inScope = allGenerated.filter(item => inAutomaticScope(item, note.targetId, note.projectId));
  const atScopeLimit = inScope.length >= maxScopeGeneratedMemories;
  const atGlobalLimit = allGenerated.length >= maxGeneratedMemories;
  if (!atScopeLimit && !atGlobalLimit) return [...notes, note];
  const evict = inScope.find(item => item.enabled && !item.edited);
  return evict ? [...notes.filter(item => item !== evict), note] : notes;
}

function acceptAutomaticMemory(next, change) {
  fields(change, 'op', 'targetId', 'projectId', 'revision', 'source', 'candidates');
  const { targetId, projectId, revision, candidates } = change;
  validateId(targetId, targetPattern);
  validateProjectId(projectId);
  validateRevision(revision);
  const source = sourceEntry(change.source);
  requireValid(source.provider !== 'codex' || source.targetId === targetId);
  requireValid(Array.isArray(candidates) && candidates.length <= maxMemoryCandidates);
  const notes = Array.from(candidates, candidate => {
    fields(candidate, 'title', 'text');
    const { title, text } = noteContent(candidate);
    return { title: title.trim(), text: text.trim() };
  });
  const policy = findAutomaticPolicy(next, targetId, projectId);
  if (!policy?.enabled || policy.revision !== revision || isIsolated(next, source.targetId, source.sessionId) ||
      next.automaticMemoryHistory.some(item => sourceKey(item) === sourceKey(source))) return;

  const seenTopics = new Set();
  for (const [index, candidate] of notes.entries()) {
    const topic = normalizedText(candidate.title);
    if (seenTopics.has(topic)) continue;
    seenTopics.add(topic);
    const sameScope = next.memories.filter(note => inAutomaticScope(note, targetId, projectId));
    const sameTitle = note => normalizedText(note.title) === topic;
    const existing = sameScope.find(note => note.source && normalizedText(note.topic) === topic);
    if (existing && (!existing.enabled || existing.edited)) continue;
    if (sameScope.some(note => note !== existing && (sameTitle(note) ||
        normalizedText(note.text) === normalizedText(candidate.text)))) continue;
    if (existing) {
      if (normalizedText(existing.text) === normalizedText(candidate.text)) continue;
      next.memories = [...next.memories.filter(note => note !== existing), { ...existing, ...candidate, source }];
    } else {
      const id = generatedId(next.memories, targetId, source.turnId, index);
      next.memories = addGeneratedNote(next.memories, {
        id, targetId, projectId, ...candidate, enabled: true, source, topic: candidate.title, edited: false,
      });
    }
  }
  next.automaticMemoryHistory = [...next.automaticMemoryHistory, source].slice(-maxMemoryHistory);
}

export function applyExtensionChange(state, change) {
  const next = { ...validateState(state) };
  switch (change?.op) {
    case 'save-server': {
      fields(change, 'op', 'server');
      const server = serverEntry(change.server);
      const saved = next.servers.find(item => targetEntryMatches(item, server));
      requireValid(!server.enabled || saved && JSON.stringify(saved.local) === JSON.stringify(server.local));
      next.servers = replaceEntry(next.servers, server);
      break;
    }
    case 'remove-server':
    case 'remove-memory': {
      fields(change, 'op', 'targetId', 'id');
      validateId(change.id);
      validateId(change.targetId, targetPattern);
      const key = change.op === 'remove-server' ? 'servers' : 'memories';
      next[key] = next[key].filter(item => !targetEntryMatches(item, change));
      break;
    }
    case 'import-plugin':
      fields(change, 'op', 'manifest');
      next.plugins = [...next.plugins, pluginEntry(change.manifest, false)];
      break;
    case 'set-plugin':
      fields(change, 'op', 'id', 'enabled');
      validateId(change.id);
      validateEnabled(change.enabled);
      requireValid(next.plugins.some(item => item.id === change.id));
      next.plugins = next.plugins.map(item => item.id === change.id ? { ...item, enabled: change.enabled } : item);
      break;
    case 'remove-plugin':
      fields(change, 'op', 'id');
      validateId(change.id);
      next.plugins = next.plugins.filter(item => item.id !== change.id);
      break;
    case 'save-memory': {
      fields(change, 'op', 'memory');
      const memory = manualMemoryEntry(change.memory);
      const existing = next.memories.find(item => targetEntryMatches(item, memory));
      if (existing?.source) {
        requireValid(memory.projectId === existing.projectId);
        const { source, topic, edited } = existing;
        next.memories = replaceEntry(next.memories, { ...memory, source, topic,
          edited: edited || memory.title !== existing.title || memory.text !== existing.text });
      } else {
        next.memories = replaceEntry(next.memories, memory);
      }
      break;
    }
    case 'set-memory-enabled':
      fields(change, 'op', 'enabled');
      validateEnabled(change.enabled);
      next.memoryEnabled = change.enabled;
      break;
    case 'set-automatic-memory': {
      fields(change, 'op', 'targetId', 'projectId', 'enabled');
      const { targetId, projectId, enabled } = change;
      validateProjectScope(targetId, projectId);
      validateEnabled(enabled);
      const current = findProjectPolicy(next, targetId, projectId);
      if ((current?.enabled ?? false) !== enabled) {
        next.automaticMemory = [...next.automaticMemory.filter(item => item !== current), {
          targetId, projectId, enabled, revision: (current?.revision ?? 0) + 1,
        }];
      }
      break;
    }
    case 'set-personal-memory': {
      fields(change, 'op', 'enabled');
      const { enabled } = change;
      validateEnabled(enabled);
      if (enabled !== next.personalMemory.enabled) {
        next.personalMemory = { enabled, revision: next.personalMemory.revision + 1 };
      }
      break;
    }
    case 'set-scoped-personal-memory': {
      fields(change, 'op', 'targetId', 'enabled');
      validateId(change.targetId, targetPattern);
      validateEnabled(change.enabled);
      const previous = findProjectPolicy(next, change.targetId, null);
      if ((previous?.enabled ?? false) !== change.enabled) {
        next.automaticMemory = [...next.automaticMemory.filter(item => item !== previous), {
          targetId: change.targetId, projectId: null, enabled: change.enabled, revision: (previous?.revision ?? 0) + 1,
        }];
      }
      break;
    }
    case 'set-memory-extraction-model': {
      const choice = readMemoryExtractionChange(change);
      const remaining = next.memoryExtractionModels.filter(({ targetId }) => targetId !== choice.targetId);
      next.memoryExtractionModels = choice.model === undefined ? remaining : [...remaining, choice];
      break;
    }
    case 'set-conversation-isolation': {
      fields(change, 'op', 'targetId', 'sessionId', 'isolated');
      const { targetId, sessionId, isolated } = change;
      validateEnabled(isolated);
      const conversation = isolationEntry({ targetId, sessionId });
      const items = next.isolatedConversations.filter(item => conversationKey(item) !== conversationKey(conversation));
      next.isolatedConversations = isolated ? [...items, conversation] : items;
      break;
    }
    case 'accept-automatic-memory':
      acceptAutomaticMemory(next, change);
      break;
    default:
      requireValid(false);
  }
  return validateState(next);
}

export function automaticMemoryPolicy(state, { targetId, projectId, scopedPersonal } = {}) {
  const policy = findAutomaticPolicy(validateState(state), targetId, projectId, scopedPersonal);
  return policy ? { enabled: policy.enabled, revision: policy.revision } : null;
}

export function conversationIsolated(state, { targetId, sessionId } = {}) {
  return isIsolated(validateState(state), targetId, sessionId);
}

const normalizedWord = /[\p{L}\p{M}\p{N}]+/gu;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const wordStops = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'do', 'does', 'for', 'from', 'how', 'i',
  'in', 'is', 'it', 'my', 'of', 'on', 'or', 'our', 'please', 'should', 'that', 'the', 'this', 'to', 'use', 'we',
  'what', 'when', 'where', 'which', 'will', 'with', 'would', 'you', 'your', 'project',
  '一个', '一下', '什么', '使用', '可以', '处理', '如何', '应该', '我们', '我的', '是否', '目前', '这个', '需要', '项目',
]);

function searchTerms(text) {
  const separated = text.normalize('NFKC').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  const terms = new Set();
  for (const word of separated.toLowerCase().match(normalizedWord) ?? []) {
    let nonCjk = '';
    let previousCjk = '';
    for (const character of word) {
      if (cjk.test(character)) {
        if (nonCjk.length >= 2) terms.add(nonCjk);
        nonCjk = '';
        if (previousCjk) terms.add(previousCjk + character);
        previousCjk = character;
      } else {
        nonCjk += character;
        previousCjk = '';
      }
    }
    if (nonCjk.length >= 2) terms.add(nonCjk);
  }
  for (const word of wordStops) terms.delete(word);
  return terms;
}

function rankNote(note, query) {
  const title = searchTerms(note.title);
  const body = searchTerms(note.text);
  let score = 0;
  for (const term of query) {
    if (title.has(term)) score += 4;
    else if (body.has(term)) score += 1;
  }
  return score;
}

export function projectMemoryNotes(state, { targetId, projectId, prompt } = {}) {
  const checked = validateState(state);
  if (!findAutomaticPolicy(checked, targetId, projectId)?.enabled || typeof prompt !== 'string') return [];
  const query = searchTerms(prompt.slice(0, 8192));
  if (!query.size) return [];
  const eligible = checked.memories.filter(note => note.enabled && inAutomaticScope(note, targetId, projectId));
  const manualTitles = new Set(eligible.filter(note => !note.source).map(note => normalizedText(note.title)));
  const relevant = eligible.filter(note => !note.source || !manualTitles.has(normalizedText(note.title)))
    .map(note => ({ note, score: rankNote(note, query) }))
    // A prompt without a lexical match receives no automatic memory context.
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(Boolean(a.note.source)) - Number(Boolean(b.note.source)));
  const memory = [];
  const titles = new Set();
  const texts = new Set();
  for (const { note: { title, text } } of relevant) {
    if (memory.length === maxTurnMemories) break;
    const titleKey = normalizedText(title);
    const textKey = normalizedText(text);
    if (titles.has(titleKey) || texts.has(textKey)) continue;
    const note = { title, text };
    if (jsonBytes({ mcpServers: [], memory: [...memory, note] }) > maxTurnExtensionBytes) continue;
    memory.push(note);
    titles.add(titleKey);
    texts.add(textKey);
  }
  return memory;
}

export function extensionsForTurn(state, { targetId, projectId, isolated } = {}) {
  const { servers, memories, memoryEnabled } = validateState(state);
  if (typeof targetId !== 'string' || !targetPattern.test(targetId)) return null;
  const mcpServers = servers.filter(server => server.targetId === targetId && server.enabled)
    .slice(0, 8).map(server => server.id);
  const memory = [];
  if (memoryEnabled && !isolated) {
    const eligible = memories.filter(note => note.targetId === targetId && note.enabled && !note.source);
    const projectNotes = eligible.filter(note => note.projectId !== null && note.projectId === projectId);
    const targetNotes = eligible.filter(note => note.projectId === null);
    for (const { title, text } of [...projectNotes, ...targetNotes]) {
      if (memory.length === maxTurnMemories) break;
      const note = { title, text };
      if (jsonBytes({ mcpServers, memory: [...memory, note] }) <= maxTurnExtensionBytes) memory.push(note);
    }
  }
  return mcpServers.length || memory.length ? { mcpServers, memory } : null;
}
