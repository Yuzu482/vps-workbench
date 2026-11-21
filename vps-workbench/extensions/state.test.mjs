import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyExtensionChange, automaticMemoryPolicy, conversationIsolated, extensionPreferenceKey, extensionsForTurn,
  projectMemoryNotes, readExtensions } from './state.mjs';
import { createExtensionSettings } from './settings.mjs';

const targetId = 'a'.repeat(64);
const otherTargetId = 'b'.repeat(64);
const projectId = 'project-example';
const scope = { targetId, projectId };
const personalScope = { targetId, projectId: null };
const sessionId = 'd2dfe175-b131-4340-bb12-235e3da7dc83';
const invalid = /invalid_extensions/;
const empty = () => readExtensions(null);
const turn = (state, overrides) => extensionsForTurn(state, { targetId, projectId, ...overrides });

function server(id, target = targetId, enabled = false) {
  return { op: 'save-server', server: { id, targetId: target, enabled } };
}

function memory(id, overrides) {
  return { op: 'save-memory', memory: { id, targetId, projectId, title: id, text: `Example ${id}`, enabled: true, ...overrides } };
}

function plugin(overrides) {
  return { schema: 1, id: 'review-notes', name: 'Code review', version: '1.0.0', description: 'Example',
    prompts: [{ title: 'Review the changes', text: 'Identify defects and gaps in test coverage.' }], ...overrides };
}

function applyAll(state, ...actions) {
  return actions.reduce(applyExtensionChange, state);
}

function automatic(enabled = true, overrides) {
  return { op: 'set-automatic-memory', ...scope, enabled, ...overrides };
}

function personal(enabled = true) {
  return { op: 'set-personal-memory', enabled };
}

function isolated(isolated = true, overrides) {
  return { op: 'set-conversation-isolation', targetId: otherTargetId, sessionId, isolated, ...overrides };
}

function extract(index, candidates, overrides) {
  const turnId = `f2dfe175-b131-4340-bb12-${String(index).padStart(12, '0')}`;
  return { op: 'accept-automatic-memory', ...scope, revision: 1,
    source: { targetId: otherTargetId, sessionId, turnId, provider: 'claude-sdk' }, candidates, ...overrides };
}

const ingressNote = { title: 'Ingress routing', text: 'Ingress uses a private listener with local health checks.' };

test('preference defaults are immutable and malformed stored content is rejected', () => {
  assert.equal(extensionPreferenceKey, 'dsh-vps-chat:extensions:v1');
  assert.deepEqual(empty(), { servers: [], plugins: [], memories: [], memoryEnabled: false,
    automaticMemory: [], isolatedConversations: [], automaticMemoryHistory: [], personalMemory: { enabled: false, revision: 0 } });
  assert(Object.isFrozen(empty()));
  assert(Object.isFrozen(empty().memories));
  for (const raw of ['', '{', 'null', '{}', '[]', 12, ' '.repeat(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => readExtensions(raw), invalid);
  }
  const duplicate = server('docs').server;
  assert.throws(() => readExtensions(JSON.stringify({ ...empty(), servers: [duplicate, duplicate] })), invalid);
  assert.throws(() => readExtensions(JSON.stringify({ ...empty(), extra: 1 })), invalid);
});

test('MCP entries are disabled on add and only enabled registry IDs reach their target', () => {
  assert.throws(() => applyExtensionChange(empty(), server('docs', targetId, true)), invalid);
  const initial = applyAll(empty(), server('docs'), server('docs', otherTargetId), server('local-other'));
  assert.equal(turn(initial), null);
  const active = applyAll(initial, server('docs', targetId, true), server('local-other', targetId, true), server('docs', otherTargetId, true));
  assert.equal(initial.servers[0].enabled, false);
  assert.deepEqual(turn(active), { mcpServers: ['docs', 'local-other'], memory: [] });
  assert.deepEqual(turn(active, { targetId: otherTargetId }), { mcpServers: ['docs'], memory: [] });
  assert.equal(turn(active, { targetId: '' }), null);
  const removed = applyExtensionChange(active, { op: 'remove-server', targetId, id: 'docs' });
  assert.deepEqual(turn(removed), { mcpServers: ['local-other'], memory: [] });
  assert.equal(removed.servers.length, 2);
});

test('MCP entries reject command, URL, unknown fields and invalid identifiers', () => {
  for (const action of [server('UPPER'), server('9docs'), server('a'.repeat(33)), server('docs', 'A'.repeat(64)),
    { ...server('docs'), extra: 1 }, { op: 'save-server', server: { ...server('docs').server, command: 'python' } },
    { op: 'save-server', server: { ...server('docs').server, url: 'https://example.invalid' } }]) {
    assert.throws(() => applyExtensionChange(empty(), action), invalid);
  }
});

test('plugins accept bounded text manifests, require explicit enable and preserve disabled templates', () => {
  const imported = applyExtensionChange(empty(), { op: 'import-plugin', manifest: plugin() });
  assert.equal(imported.plugins[0].enabled, false);
  assert(Object.isFrozen(imported.plugins[0].prompts[0]));
  const enabled = applyExtensionChange(imported, { op: 'set-plugin', id: 'review-notes', enabled: true });
  assert.equal(imported.plugins[0].enabled, false);
  assert.equal(enabled.plugins[0].enabled, true);
  assert.deepEqual(readExtensions(JSON.stringify(enabled)), enabled);
  assert.equal(turn(enabled), null);
  const disabled = applyExtensionChange(enabled, { op: 'set-plugin', id: 'review-notes', enabled: false });
  assert.deepEqual(disabled.plugins[0], imported.plugins[0]);
  assert.deepEqual(applyExtensionChange(disabled, { op: 'remove-plugin', id: 'review-notes' }), empty());
  assert.throws(() => applyExtensionChange(imported, { op: 'import-plugin', manifest: plugin() }), invalid);
});

test('plugins reject schema mismatches, executable settings, raw prompt markup objects and oversize manifests', () => {
  const validPrompt = plugin().prompts[0];
  const badManifests = [plugin({ schema: 2 }), plugin({ enabled: true }), plugin({ scripts: ['start.js'] }),
    plugin({ network: 'https://example.invalid' }), plugin({ prompts: [] }),
    plugin({ prompts: [{ ...validPrompt, text: { html: '<b>Example</b>' } }] }),
    plugin({ prompts: [{ ...validPrompt, command: 'example' }] }), plugin({ prompts: [validPrompt, validPrompt] }),
    plugin({ prompts: Array.from({ length: 12 }, (_, index) => ({ title: String(index), text: '中'.repeat(800) })) })];
  for (const manifest of badManifests) {
    assert.throws(() => applyExtensionChange(empty(), { op: 'import-plugin', manifest }), invalid);
  }
});

test('memory opt-in retains notes and matches exact target and project before VPS-wide notes', () => {
  const saved = applyAll(empty(), memory('global', { projectId: null }), memory('project'),
    memory('other-project', { projectId: projectId.toUpperCase() }), memory('disabled', { enabled: false }),
    memory('project', { targetId: otherTargetId }));
  assert.equal(turn(saved), null);
  const enabled = applyExtensionChange(saved, { op: 'set-memory-enabled', enabled: true });
  assert.deepEqual(turn(enabled), { mcpServers: [], memory: [
    { title: 'project', text: 'Example project' }, { title: 'global', text: 'Example global' },
  ] });
  assert.deepEqual(turn(enabled, { projectId: '' }).memory.map(item => item.title), ['global']);
  assert.deepEqual(turn(enabled, { targetId: otherTargetId }).memory.map(item => item.title), ['project']);
  const disabled = applyExtensionChange(enabled, { op: 'set-memory-enabled', enabled: false });
  assert.equal(turn(disabled), null);
  assert.deepEqual(disabled.memories, enabled.memories);
  const edited = applyExtensionChange(disabled, memory('project', { text: 'Revised text', projectId: null }));
  assert.equal(edited.memories.length, disabled.memories.length);
  assert.equal(edited.memories.find(item => item.id === 'project' && item.targetId === targetId).text, 'Revised text');
  const removed = applyExtensionChange(edited, { op: 'remove-memory', targetId, id: 'project' });
  assert.equal(removed.memories.some(item => item.id === 'project' && item.targetId === otherTargetId), true);
  assert.equal(removed.memories.some(item => item.id === 'project' && item.targetId === targetId), false);
  assert.deepEqual(readExtensions(JSON.stringify(edited)), edited);
});

test('memory rejects invalid scope, text length and extra fields', () => {
  for (const action of [memory('note', { projectId: '' }), memory('note', { projectId: 'x\u0000y' }),
    memory('note', { title: 'a'.repeat(81) }), memory('note', { text: 'a'.repeat(2001) }),
    memory('note', { text: '中'.repeat(801) }), memory('note', { enabled: 'true' }),
    memory('note', { unrelated: 'extra' })]) {
    assert.throws(() => applyExtensionChange(empty(), action), invalid);
  }
  assert.doesNotThrow(() => applyExtensionChange(empty(), memory('note', { text: '中'.repeat(800) })));
});

test('turns have ceilings for MCP IDs, memory items and the UTF-8 JSON payload', () => {
  const servers = Array.from({ length: 10 }, (_, index) => [server(`docs-${index}`), server(`docs-${index}`, targetId, true)]).flat();
  const shortNotes = Array.from({ length: 7 }, (_, index) => memory(`note-${index}`));
  const optIn = { op: 'set-memory-enabled', enabled: true };
  const short = turn(applyAll(empty(), ...servers, ...shortNotes, optIn));
  assert.equal(short.mcpServers.length, 8);
  assert.equal(short.memory.length, 5);

  const largeNotes = Array.from({ length: 5 }, (_, index) => memory(`big-${index}`, { text: '\\'.repeat(1980) }));
  const mixed = turn(applyAll(empty(), ...servers, ...largeNotes, memory('short'), optIn));
  assert(Buffer.byteLength(JSON.stringify(mixed), 'utf8') <= 8192);
  assert.deepEqual(mixed.memory.map(note => note.title), ['big-0', 'big-1', 'short']);
});

test('stored collection counts are bounded', () => {
  const servers = Array.from({ length: 65 }, (_, index) => server(`docs-${index}`).server);
  const plugins = Array.from({ length: 33 }, (_, index) => ({ ...plugin({ id: `plugin-${index}` }), enabled: false }));
  const memories = Array.from({ length: 129 }, (_, index) => memory(`note-${index}`).memory);
  for (const collection of [{ servers }, { plugins }, { memories }]) {
    assert.throws(() => readExtensions(JSON.stringify({ ...empty(), ...collection })), invalid);
  }
});

test('0.3.0 preferences retain manual notes with automatic policy initially unset', () => {
  const legacy = { servers: [server('docs', targetId, true).server], plugins: [],
    memories: [memory('manual').memory], memoryEnabled: true };
  const migrated = readExtensions(JSON.stringify(legacy));
  assert.equal(automaticMemoryPolicy(migrated, scope), null);
  assert.deepEqual(automaticMemoryPolicy(migrated, personalScope), { enabled: false, revision: 0 });
  assert.equal(conversationIsolated(migrated, { targetId, sessionId }), false);
  assert.deepEqual(projectMemoryNotes(migrated, { ...scope, prompt: 'manual' }), []);
  assert.deepEqual(turn(migrated), { mcpServers: ['docs'], memory: [{ title: 'manual', text: 'Example manual' }] });
  assert.deepEqual(readExtensions(JSON.stringify(migrated)), migrated);
});

test('0.4.0 preferences retain project notes, source history and isolation with personal memory off', () => {
  const { personalMemory, ...legacy } = applyAll(empty(), automatic(), extract(1, [ingressNote]), isolated());
  const migrated = readExtensions(JSON.stringify(legacy));
  assert.deepEqual(automaticMemoryPolicy(migrated, scope), { enabled: true, revision: 1 });
  assert.deepEqual(automaticMemoryPolicy(migrated, personalScope), { enabled: false, revision: 0 });
  assert.equal(conversationIsolated(migrated, { targetId: otherTargetId, sessionId }), true);
  assert.deepEqual(projectMemoryNotes(migrated, { ...scope, prompt: 'Ingress' }), [ingressNote]);
  assert.deepEqual(migrated.automaticMemoryHistory, legacy.automaticMemoryHistory);
  assert.deepEqual(projectMemoryNotes(migrated, { ...personalScope, prompt: 'Ingress' }), []);
  assert.deepEqual(readExtensions(JSON.stringify(migrated)), migrated);
});

test('personal memory is an independent global opt-in with stale-result protection', () => {
  const candidate = extract(1, [ingressNote], personalScope);
  const projectOnly = applyAll(empty(), automatic(), personal(false));
  assert.deepEqual(applyAll(projectOnly, candidate), projectOnly);
  const enabled = applyAll(projectOnly, personal(), personal());
  assert.deepEqual(automaticMemoryPolicy(enabled, personalScope), { enabled: true, revision: 1 });
  assert.deepEqual(automaticMemoryPolicy(enabled, { ...personalScope, targetId: otherTargetId }), { enabled: true, revision: 1 });
  for (const incomplete of [{ projectId: null }, { ...personalScope, targetId: 'invalid' }, { targetId }]) {
    assert.equal(automaticMemoryPolicy(enabled, incomplete), null);
  }
  assert.deepEqual(automaticMemoryPolicy(enabled, scope), { enabled: true, revision: 1 });
  assert.throws(() => applyAll(enabled, { ...personal(), targetId }), invalid);
  assert.throws(() => applyAll(enabled, personal('true')), invalid);
  const disabled = applyAll(enabled, candidate, personal(false));
  assert.deepEqual(projectMemoryNotes(disabled, { ...personalScope, prompt: 'Ingress' }), []);
  assert.deepEqual(disabled.memories.map(({ title }) => title), [ingressNote.title]);
  const reenabled = applyAll(readExtensions(JSON.stringify(disabled)), personal());
  assert.deepEqual(automaticMemoryPolicy(reenabled, personalScope), { enabled: true, revision: 3 });
  assert.deepEqual(automaticMemoryPolicy(reenabled, scope), { enabled: true, revision: 1 });
  const late = extract(2, [{ title: 'Late', text: 'Late.' }], personalScope);
  assert.deepEqual(applyAll(reenabled, late), reenabled);
  assert.equal(applyAll(reenabled, { ...late, revision: 3 }).memories.length, 2);
});

test('personal retrieval and writes stay separate from project, other VPS and legacy VPS-wide notes', () => {
  const literalNullProject = { targetId, projectId: 'null' };
  const literalProjectNote = { title: ingressNote.title, text: 'Project ingress uses a public listener.' };
  const otherVpsNote = { title: ingressNote.title, text: 'Other VPS ingress is a proxy.' };
  const initial = applyAll(empty(), personal(), automatic(true, literalNullProject), automatic(),
    memory('vps', { ...ingressNote, projectId: null }), { op: 'set-memory-enabled', enabled: true },
    extract(1, [ingressNote], personalScope), extract(2, [literalProjectNote], literalNullProject),
    extract(3, [otherVpsNote], { ...personalScope, targetId: otherTargetId }));
  const selected = (state, overrides) => projectMemoryNotes(state, { ...personalScope, prompt: 'Ingress routing', ...overrides });
  assert.deepEqual(selected(initial), [ingressNote]);
  assert.deepEqual(selected(initial, { targetId: otherTargetId }), [otherVpsNote]);
  assert.deepEqual(selected(initial, literalNullProject), [literalProjectNote]);
  assert.deepEqual(selected(initial, scope), []);
  assert.deepEqual(selected(initial, { projectId: undefined }), []);
  assert.deepEqual(selected(initial, { prompt: 'Typography' }), []);
  const personalNote = initial.memories.find(note => note.source && note.targetId === targetId && note.projectId === null);
  const revisedNote = { title: 'Reviewed routing', text: 'Keep ingress local.' };
  const revised = applyAll(initial, memory(personalNote.id, { ...revisedNote, projectId: null }),
    extract(4, [{ ...ingressNote, text: 'Ignore later ingress extraction.' }], personalScope));
  assert.deepEqual(selected(revised), [revisedNote]);
  assert.deepEqual(revised.memories.find(note => note.id === personalNote.id && note.targetId === targetId).source, personalNote.source);
  assert.throws(() => applyAll(initial, memory(personalNote.id)), invalid);
  assert.deepEqual(turn(revised, { projectId: null }).memory, [ingressNote]);
  assert.deepEqual(turn(revised, { projectId: null, isolated: true }), null);
  const removed = applyAll(revised, { op: 'remove-memory', targetId, id: personalNote.id });
  assert.deepEqual(selected(removed), []);
  assert.deepEqual(turn(removed, { projectId: null }).memory, [ingressNote]);
});

test('personal extraction respects conversation isolation and its scope limit', () => {
  const first = extract(1, [ingressNote], personalScope);
  const isolatedSource = applyAll(empty(), personal(), isolated());
  assert.deepEqual(applyAll(isolatedSource, first), isolatedSource);
  const initial = applyAll(isolatedSource, isolated(false), first, automatic(), extract(2, [ingressNote]),
    memory('wide-manual', { projectId: null }));
  const personalNote = initial.memories.find(note => note.source && note.projectId === null);
  const commands = Array.from({ length: 25 }, (_, index) => extract(index + 3, [
    { title: `Ingress personal ${index}`, text: `Ingress note text ${index}` },
  ], personalScope));
  const retained = applyAll(initial, memory(personalNote.id, { ...ingressNote, projectId: null, enabled: false }), ...commands);
  assert.equal(retained.memories.filter(note => note.source && note.projectId === null).length, 24);
  assert.equal(retained.memories.some(note => note.title === 'Ingress personal 0'), false);
  assert.equal(retained.memories.some(note => note.id === personalNote.id && !note.enabled), true);
  assert.equal(retained.memories.some(note => note.id === 'wide-manual'), true);
  assert.deepEqual(projectMemoryNotes(retained, { ...scope, prompt: 'Ingress' }), [ingressNote]);
  assert.deepEqual(readExtensions(JSON.stringify(retained)), retained);
});

test('automatic policies are exact, default off, and retain revisions across toggles', () => {
  const enabled = applyAll(empty(), automatic(false), automatic(), automatic());
  assert.deepEqual(automaticMemoryPolicy(enabled, scope), { enabled: true, revision: 1 });
  assert.equal(automaticMemoryPolicy(enabled, { ...scope, projectId: projectId.toUpperCase() }), null);
  assert.equal(automaticMemoryPolicy(enabled, { ...scope, targetId: otherTargetId }), null);
  assert.throws(() => applyExtensionChange(enabled, automatic(true, { projectId: null })), invalid);
  const disabled = applyAll(enabled, automatic(false), automatic(false));
  assert.deepEqual(automaticMemoryPolicy(disabled, scope), { enabled: false, revision: 2 });
  const reenabled = applyAll(readExtensions(JSON.stringify(disabled)), automatic());
  assert.deepEqual(automaticMemoryPolicy(reenabled, scope), { enabled: true, revision: 3 });
  assert.deepEqual(applyAll(reenabled, extract(1, [ingressNote])), reenabled);
  assert.equal(applyAll(reenabled, extract(1, [ingressNote], { revision: 3 })).memories.length, 1);
});

test('isolation survives reload, is provider-target scoped and suppresses memory without suppressing MCP', () => {
  const initial = applyAll(empty(), automatic(), memory('manual'), { op: 'set-memory-enabled', enabled: true },
    server('docs'), server('docs', targetId, true), isolated(true, { sessionId: sessionId.toUpperCase() }));
  const reloaded = readExtensions(JSON.stringify(initial));
  assert.equal(conversationIsolated(reloaded, { targetId: otherTargetId, sessionId }), true);
  assert.equal(conversationIsolated(reloaded, { targetId, sessionId }), false);
  assert.throws(() => applyAll(reloaded, isolated(true, { sessionId: 'not-a-uuid' })), invalid);
  assert.deepEqual(turn(reloaded, { isolated: true }), { mcpServers: ['docs'], memory: [] });
  assert.deepEqual(applyAll(reloaded, extract(1, [ingressNote])), reloaded);
  const unisolated = applyAll(reloaded, isolated(false));
  assert.equal(conversationIsolated(unisolated, { targetId: otherTargetId, sessionId }), false);
  const accepted = applyAll(unisolated, extract(2, [ingressNote]));
  assert.deepEqual(turn(accepted).memory, [{ title: 'manual', text: 'Example manual' }]);
  assert.equal(accepted.memories.length, 2);
});

test('project selection ranks lexical matches in English and Chinese, without unrelated or cross-scope fallback', () => {
  const active = applyAll(empty(), automatic(), memory('backup', { title: 'Database backup', text: 'Check ingress first.' }),
    memory('same-text', { title: 'Ingress health', text: ingressNote.text }),
    memory('wider', { projectId: null, title: 'Ingress access', text: 'VPS-wide' }),
    memory('other-project', { projectId: projectId.toUpperCase(), title: 'Ingress routing', text: 'Other project' }),
    memory('other-target', { targetId: otherTargetId, title: 'Ingress routing', text: 'Other target' }),
    memory('disabled', { title: 'Ingress routing', enabled: false }),
    extract(1, [ingressNote, { title: '离线数据库备份', text: '备份保留七天并校验快照。' },
      { title: '凭据轮换', text: '每季度轮换凭据。' }]));
  const notes = (prompt, overrides) => projectMemoryNotes(active, { ...scope, prompt, ...overrides });
  assert.deepEqual(notes('Can we inspect ingress health?').map(note => note.title), ['Ingress health', 'Database backup']);
  assert.deepEqual(notes('如何校验数据库备份并恢复快照？').map(note => note.title), ['离线数据库备份']);
  assert.deepEqual(notes('What about typography?'), []);
  assert.deepEqual(notes('如何使用这个项目？'), []);
  assert.deepEqual(notes('Ingress routing', { projectId: projectId.toUpperCase() }), []);
  assert.deepEqual(notes('Ingress routing', { targetId: otherTargetId }), []);
  assert.deepEqual(projectMemoryNotes(applyAll(active, automatic(false)), { ...scope, prompt: 'Ingress' }), []);
});

test('generated notes deduplicate source and topic, retain stable identity, and protect manual notes and revisions', () => {
  const initial = applyAll(empty(), automatic(), memory('manual', { title: 'Build tool', text: 'Use esbuild.' }),
    extract(1, [ingressNote, { title: 'ingress routing', text: 'Ignored repeat topic.' },
      { title: ' Build Tool ', text: 'Use another tool.' }]));
  assert.equal(initial.memories.length, 2);
  const generated = initial.memories[1];
  assert.deepEqual(generated.source, extract(1).source);
  assert.deepEqual(applyAll(readExtensions(JSON.stringify(initial)), extract(1, [{ title: 'Replayed', text: 'Retry' }])), initial);
  const updated = applyAll(initial, extract(2, [{ ...ingressNote, title: 'ingress routing', text: 'Only the ingress is public.' }]));
  assert.equal(updated.memories[1].id, generated.id);
  assert.deepEqual(updated.memories[1].source, extract(2).source);
  assert.equal(updated.memories[1].text, 'Only the ingress is public.');
  const disabled = applyAll(updated, memory(generated.id, { ...ingressNote, enabled: false }), extract(3, [ingressNote]));
  assert.equal(disabled.memories[1].enabled, false);
  assert.deepEqual(disabled.memories[1].source, extract(2).source);
  assert.throws(() => applyAll(disabled, memory(generated.id, { projectId: null })), invalid);
  const revised = applyAll(disabled, memory(generated.id, { title: 'Reviewed route', text: 'Keep this ingress local.' }),
    extract(4, [ingressNote]));
  assert.equal(revised.memories.length, 2);
  assert.equal(revised.memories[1].text, 'Keep this ingress local.');
  assert.equal(revised.memories[0].text, 'Use esbuild.');
  const removed = applyAll(revised, { op: 'remove-memory', targetId, id: generated.id }, extract(4, [ingressNote]));
  assert.equal(removed.memories.length, 1);
});

test('automatic candidates reject malformed metadata and overlong content', () => {
  const state = applyAll(empty(), automatic());
  for (const change of [extract(1, Array(4).fill(ingressNote)), extract(1, [{ ...ingressNote, text: '中'.repeat(801) }]),
    extract(1, [{ ...ingressNote, title: 'line\nbreak' }]), extract(1, [{ ...ingressNote, enabled: true }]),
    extract(1, [ingressNote], { revision: 0 }), extract(1, [ingressNote], { source: { ...extract(1).source, provider: 'codex' } }),
    extract(1, [ingressNote], { source: { ...extract(1).source, provider: 'other' } })]) {
    assert.throws(() => applyAll(state, change), invalid);
  }
});

test('generated retention evicts oldest eligible notes without affecting manual data, reviewed notes or history bounds', () => {
  const manual = Array.from({ length: 128 }, (_, index) => memory(`manual-${index}`));
  const commands = Array.from({ length: 260 }, (_, index) => extract(index + 1, [
    { title: `Ingress task ${index + 1}`, text: `Unique route ${index + 1}` },
  ]));
  let state = applyAll(empty(), automatic(), ...manual, commands[0]);
  const retained = state.memories.at(-1);
  state = applyAll(state, memory(retained.id, { title: retained.title, text: retained.text, enabled: false }), ...commands.slice(1));
  assert.equal(state.memories.filter(note => !note.source).length, 128);
  assert.equal(state.memories.filter(note => note.source).length, 24);
  assert.equal(state.memories.find(note => note.id === retained.id).enabled, false);
  assert.equal(state.memories.some(note => note.title === 'Ingress task 2'), false);
  assert.equal(state.automaticMemoryHistory.length, 256);
  assert.deepEqual(readExtensions(JSON.stringify(state)), state);
  const notes = projectMemoryNotes(state, { ...scope, prompt: 'Ingress' });
  assert.equal(notes.length, 5);
  assert(Buffer.byteLength(JSON.stringify(notes), 'utf8') <= 8192);
});

test('new personal notes leave existing project notes in other scopes intact at the global limit', () => {
  let state = applyAll(empty(), personal());
  for (let i = 0; i < 128; i++) {
    const partition = `project-${Math.floor(i / 24)}`;
    if (i % 24 === 0) state = applyAll(state, automatic(true, { projectId: partition }));
    state = applyAll(state, extract(i + 1, [{ title: `Project convention ${i}`, text: `Project reference ${i}` }],
      { projectId: partition }));
  }
  assert.equal(state.memories.length, 128);
  const learned = applyAll(state, extract(129, [{ title: 'Preferred summary', text: 'Use three lines for summaries.' }],
    { targetId: otherTargetId, projectId: null }));
  assert.deepEqual(learned.memories, state.memories);
});

test('project-memory settings show a selected policy and source across providers', () => {
  const Settings = createExtensionSettings(React);
  const state = applyAll(empty(), automatic(), extract(1, [ingressNote]));
  const markup = renderToStaticMarkup(React.createElement(Settings, { section: 'memory', state,
    targetId: '', memoryTargetId: targetId, projects: new Map([[projectId, 'Example project']]), selectedProject: projectId }));
  assert.match(markup, /Example project/);
  assert.match(markup, /<input(?=[^>]*role="switch")(?=[^>]*aria-label="开启此项目的自动记忆")(?=[^>]*checked="")[^>]*>/);
  assert.match(markup, /提炼使用 VPS 上的 Codex 额度/);
  assert.match(markup, /来自 Claude SDK 对话/);
  assert.match(markup, /查看记忆和来源/);
  assert.match(markup, /Ingress routing/);
});

test('personal-memory settings have an independent switch and show personal sources with an empty project list', () => {
  const Settings = createExtensionSettings(React);
  const state = applyAll(empty(), personal(), extract(1, [ingressNote], personalScope));
  const props = { section: 'memory', state, targetId: '', memoryTargetId: targetId, projects: new Map() };
  const markup = renderToStaticMarkup(React.createElement(Settings, props));
  assert.match(markup, /<span>个人自动记忆<\/span>/);
  assert.match(markup, /<input(?=[^>]*role="switch")(?=[^>]*aria-label="开启个人自动记忆")(?=[^>]*checked="")[^>]*>/);
  assert.match(markup, /此 VPS 的个人自动记忆/);
  assert.match(markup, /来自 Claude SDK 对话/);
  assert.match(markup, /Ingress routing/);
  const disconnected = renderToStaticMarkup(React.createElement(Settings, { ...props, memoryTargetId: '' }));
  assert.match(disconnected, /<input(?=[^>]*role="switch")(?=[^>]*aria-label="开启个人自动记忆")(?=[^>]*checked="")[^>]*>/);
  assert.doesNotMatch(disconnected, /Ingress routing/);
});
