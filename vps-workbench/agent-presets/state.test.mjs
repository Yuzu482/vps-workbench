import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentPresetFields, agentPresetKey, applyAgentPresetChange, legacyAgentPresetKey, maxAgentPresets,
  readAgentPresets, resolveAgentPreset,
} from './state.mjs';
import { createAgentModulesEditor } from './settings.mjs';

const id = '12345678-90ab-cdef-abcd-ef1234567890';
const stage = { name: '代码审核', provider: 'codex', model: 'gpt-6-sol', instruction: '检查错误与边界条件。' };
function manifest({ name, provider, model, instruction, output = null }) {
  const modules = [
    { id: 'executor', config: { provider, model } },
    { id: 'persona', config: { instruction } },
  ];
  if (output !== null) modules.push({ id: 'output', config: { instruction: output } });
  return { name, modules };
}

const draft = manifest(stage);
const save = (fields = {}) => ({ op: 'save', id, revision: null, draft, ...fields });
const remove = (revision) => ({ op: 'delete', id, revision });

test('preset CRUD round trips local records and preserves input snapshots', () => {
  assert.equal(legacyAgentPresetKey, 'dsh-vps-chat:agent-presets:v1');
  assert.equal(agentPresetKey, 'dsh-vps-chat:agent-presets:v2');
  const empty = readAgentPresets(null);
  const created = applyAgentPresetChange(empty, save({ id: id.toUpperCase(), draft: manifest({
    ...stage, name: ` ${stage.name} `, instruction: `\n${stage.instruction}\n`,
  }) }));
  assert.deepEqual(empty, []);
  assert.deepEqual(created, [{ id, revision: 1, ...draft }]);
  assert.deepEqual(readAgentPresets(JSON.stringify(created)), created);

  const updatedName = '变更审核';
  const updated = applyAgentPresetChange(created, save({ revision: 1, draft: { ...draft, name: updatedName } }));
  assert.deepEqual(updated, [{ id, revision: 2, ...draft, name: updatedName }]);
  assert.deepEqual(applyAgentPresetChange(updated, remove(2)), []);
  assert.deepEqual(created, [{ id, revision: 1, ...draft }]);
  assert.equal(updated[0].revision, 2);
});

test('preset roles accept all structured providers and validate workflow-compatible models and text', () => {
  for (const provider of ['codex', 'claude', 'claude-sdk', 'antigravity']) {
    const model = 'X'.repeat(100);
    const valid = { name: '角'.repeat(64), provider, model, instruction: '指'.repeat(1198) + '\n令' };
    const [record] = applyAgentPresetChange([], save({ draft: manifest(valid) }));
    assert.deepEqual(resolveAgentPreset(record), valid);
  }
  const invalid = [
    { name: 'n'.repeat(65) }, { name: '第一行\n第二行' },
    { instruction: '' }, { instruction: 'x'.repeat(1201) }, { instruction: 'x\u0001' },
    { instruction: 'y\uD800' }, { model: 'X'.repeat(101) }, { model: 'bad/id' },
    { model: null }, { provider: 'shell' }, { provider: '__proto__' },
  ].map((fields) => manifest({ ...stage, ...fields }));
  invalid.push(null, stage, { ...draft, role: 'review' });
  const created = applyAgentPresetChange([], save());
  for (const badDraft of invalid) {
    assert.throws(() => applyAgentPresetChange(created, save({ revision: 1, draft: badDraft })), /无效|须为/u);
  }
  assert.deepEqual(created, [{ id, revision: 1, ...draft }]);
});

test('legacy records migrate only in the absence of v2 and preserve their stage fields and revision', () => {
  const legacy = JSON.stringify([{ ...stage, id: id.toUpperCase(), revision: 7 }]);
  const migrated = readAgentPresets(null, legacy);
  assert.deepEqual(migrated, [{ id, revision: 7, ...draft }]);
  assert.deepEqual(resolveAgentPreset(migrated[0]), stage);
  assert.deepEqual(agentPresetFields(migrated[0]), { ...stage, output: null, agent: null });
  assert.deepEqual(readAgentPresets(JSON.stringify(migrated), 'invalid v1'), migrated);
  assert.deepEqual(readAgentPresets('[]', legacy), []);
  assert.throws(() => readAgentPresets('invalid v2', legacy), /无法读取/u);
  assert.throws(() => readAgentPresets(legacy, legacy), /记录无效/u);
  assert.throws(() => readAgentPresets(null, JSON.stringify([{ ...stage, model: 'bad/id', id, revision: 7 }])), /模型无效/u);
  assert.throws(() => applyAgentPresetChange(migrated, save({ revision: 6 })), /已变更/u);
  assert.deepEqual(applyAgentPresetChange(migrated, save({ revision: 7 })), [{ id, revision: 8, ...draft }]);
});

test('module manifests resolve in canonical order and compose output into a detached stage snapshot', () => {
  const unicode = { ...stage, instruction: '按段落审查🔍\n保留中文。', output: '逐项标注风险 📝' };
  const canonical = { id, revision: 1, ...manifest(unicode) };
  const reordered = { ...canonical, modules: [...canonical.modules].reverse() };
  assert.deepEqual(readAgentPresets(JSON.stringify([reordered])), [canonical]);

  const created = applyAgentPresetChange([], save({ draft: { name: reordered.name, modules: reordered.modules } }));
  assert.deepEqual(created, [canonical]);
  assert.deepEqual(agentPresetFields(created[0]), { ...unicode, agent: null });
  const snapshot = resolveAgentPreset(created[0]);
  const effectiveInstruction = `${unicode.instruction}\n\n输出规范\n${unicode.output}`;
  assert.deepEqual(snapshot, { ...stage, instruction: effectiveInstruction });
  const updated = applyAgentPresetChange(created, save({ revision: 1, draft: manifest({ ...unicode, output: null }) }));
  assert.deepEqual(resolveAgentPreset(updated[0]), { ...stage, instruction: unicode.instruction });
  assert.equal(snapshot.instruction, effectiveInstruction);
});

const server = { id: 'docs', targetId: 'a'.repeat(64) };
const template = { id: 'formatter', version: ' 1.0 ', title: ' 审核摘要 ' };
const mcpModule = { id: 'mcp', config: { servers: [server] } };
const pluginModule = { id: 'plugins', config: { templates: [template] } };
const memoryModule = (mode) => ({ id: 'memory', config: { mode } });
const withModules = (...modules) => ({ ...draft, modules: [...draft.modules, ...modules] });

test('resource manifests round-trip, preserve exact references and default to isolated memory', () => {
  const [record] = applyAgentPresetChange([], save({ draft: withModules(pluginModule, mcpModule) }));
  assert.deepEqual(record, { id, revision: 1, ...withModules(mcpModule, pluginModule) });
  assert.deepEqual(readAgentPresets(JSON.stringify([record])), [record]);
  const agent = { mcpServers: [server], plugins: [template], memory: 'isolated' };
  assert.deepEqual(agentPresetFields(record), { ...stage, output: null, agent });
  const resolved = resolveAgentPreset(record);
  assert.deepEqual(resolved, { ...stage, agent });
  resolved.agent.mcpServers[0].id = 'changed';
  assert.deepEqual(resolveAgentPreset(record), { ...stage, agent });

  for (const memory of ['shared', 'isolated']) {
    const [explicit] = applyAgentPresetChange([record], save({ revision: 1, draft: withModules(memoryModule(memory)) }));
    assert.deepEqual(explicit, { id, revision: 2, ...withModules(memoryModule(memory)) });
    assert.deepEqual(resolveAgentPreset(explicit), { ...stage, agent: { mcpServers: [], plugins: [], memory } });
  }
  const claude = manifest({ ...stage, provider: 'claude' });
  const [pluginOnly] = applyAgentPresetChange([], save({ draft: { ...claude, modules: [...claude.modules, pluginModule] } }));
  assert.deepEqual(resolveAgentPreset(pluginOnly).agent, { mcpServers: [], plugins: [template], memory: 'isolated' });
  const antigravity = manifest({ ...stage, provider: 'antigravity' });
  const serverRef = { ...server, targetId: 'b'.repeat(64) };
  const [acp] = applyAgentPresetChange([], save({ draft: { ...antigravity,
    modules: [...antigravity.modules, { id: 'mcp', config: { servers: [serverRef] } }] } }));
  assert.deepEqual(resolveAgentPreset(acp).agent, { mcpServers: [serverRef], plugins: [], memory: 'isolated' });
});

test('invalid resource manifests cannot introduce unavailable configurations or executable metadata', () => {
  const invalid = [
    withModules({ id: 'mcp', config: { servers: [] } }),
    withModules({ id: 'mcp', config: { servers: null } }),
    withModules({ id: 'mcp', config: { servers: [{ ...server, targetId: 'bad' }] } }),
    withModules({ id: 'mcp', config: { servers: [server, server] } }),
    withModules({ id: 'mcp', config: { servers: [{ ...server, command: 'python' }] } }),
    withModules({ id: 'plugins', config: { templates: [] } }),
    withModules({ id: 'plugins', config: { templates: [template, template] } }),
    withModules({ id: 'plugins', config: { templates: [{ ...template, path: './plugin' }] } }),
    withModules(memoryModule('project')),
    withModules(memoryModule('shared'), memoryModule('isolated')),
  ];
  const claude = manifest({ ...stage, provider: 'claude' });
  invalid.push({ ...claude, modules: [...claude.modules, mcpModule] });
  for (const badDraft of invalid) {
    assert.throws(() => applyAgentPresetChange([], save({ draft: badDraft })), /无效|重复|须使用 Codex/u);
  }
});

test('resource editor keeps stale selections visible, blocks rebinding and emits exact references', () => {
  const pickerState = new Map();
  let pickerLabel;
  let idSequence = 0;
  const editor = createAgentModulesEditor({
    createElement: (type, props, ...children) => ({ type, props, children }),
    useId: () => `group-${idSequence++}`,
    useRef: () => ({ current: null }),
    useState: (initial) => {
      const label = pickerLabel;
      return [pickerState.get(label) ?? initial, (value) => pickerState.set(label, value)];
    },
  });

  function renderNode(node) {
    if (Array.isArray(node)) return node.map(renderNode);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type !== 'function') return { ...node, children: renderNode(node.children) };
    pickerLabel = node.props.label;
    return renderNode(node.type(node.props));
  }

  function render(props) {
    idSequence = 0;
    return renderNode(editor(props));
  }

  const elements = (value) => Array.isArray(value) ? value.flatMap(elements)
    : value && typeof value === 'object' ? [value, ...elements(value.children)] : [];
  const control = (view, label) => elements(view).find(({ props }) => props?.['aria-label'] === label);
  const nextServer = { id: 'index', targetId: 'b'.repeat(64) };
  const codexTargetId = nextServer.targetId;
  const installed = { id: template.id, version: template.version, name: 'Formatter', enabled: true,
    prompts: [{ title: template.title, text: 'Local prompt text' }] };
  const antigravityServer = { id: nextServer.id, targetId: 'c'.repeat(64) };
  const moduleCatalog = { codexTargetId, antigravityTargetId: antigravityServer.targetId,
    servers: [{ ...server, enabled: true }, { ...nextServer, enabled: true }, { ...antigravityServer, enabled: true }],
    plugins: [installed] };
  let emitted;
  const props = { provider: 'codex', onChange: (agent) => { emitted = agent; }, moduleCatalog };
  const initial = render(props);
  assert.equal(control(initial, 'MCP 服务').props['aria-expanded'], false);
  assert.equal(control(initial, 'index'), undefined);
  assert.equal(control(initial, '默认不共享').props.checked, true);
  assert.equal(control(initial, '独立上下文').props.checked, false);
  control(initial, 'MCP 服务').props.onClick();
  control(initial, '提示词模板').props.onClick();
  assert.equal(emitted, undefined);

  const open = render(props);
  assert.equal(control(open, 'MCP 服务').props['aria-expanded'], true);
  assert.equal(control(open, 'docs'), undefined);
  const serverOption = control(open, 'index');
  assert.equal(serverOption.props['aria-pressed'], false);
  serverOption.props.onClick();
  assert.deepEqual(emitted, { mcpServers: [nextServer], plugins: [], memory: 'isolated' });

  const selected = render({ ...props, agent: emitted });
  assert.equal(control(selected, 'index').props['aria-pressed'], true);
  assert.equal(control(selected, '默认不共享').props.disabled, true);
  assert.equal(control(selected, '独立上下文').props.checked, true);
  control(selected, 'index').props.onClick();
  assert.deepEqual(emitted, { mcpServers: [], plugins: [], memory: 'isolated' });

  const acp = { ...props, provider: 'antigravity' };
  assert.equal(control(render({ ...acp, moduleCatalog: { ...moduleCatalog, antigravityTargetId: '' } }), 'index'), undefined);
  assert.equal(control(render({ ...acp, agent: { ...emitted, mcpServers: [nextServer] } }), 'index'), undefined);
  control(render(acp), 'index').props.onClick();
  assert.deepEqual(emitted, { mcpServers: [antigravityServer], plugins: [], memory: 'isolated' });

  control(open, '共享记忆').props.onChange();
  assert.deepEqual(emitted, { mcpServers: [], plugins: [], memory: 'shared' });
  control(open, `${installed.name} · ${template.title}`).props.onClick();
  assert.deepEqual(emitted, { mcpServers: [], plugins: [template], memory: 'isolated' });

  const agent = { mcpServers: [server], plugins: [template], memory: 'shared' };
  const stale = render({ ...props, agent, moduleCatalog: { ...moduleCatalog, plugins: [{ ...installed, enabled: false }] } });
  assert.equal(control(stale, 'index'), undefined);
  assert.equal(control(stale, `${installed.name} · ${template.title}`), undefined);
  const staleReasons = elements(stale).filter(({ type }) => type === 'small').map(({ children }) => children[0]);
  assert.deepEqual(staleReasons, ['属于其他连接，可移除后重新选择', '提示词模板已停用']);
  control(stale, '移除MCP 服务 docs').props.onClick();
  assert.deepEqual(emitted, { ...agent, mcpServers: [] });
  const removePlugin = elements(stale).find(({ props }) => props?.['aria-label']?.startsWith('移除提示词模板'));
  removePlugin.props.onClick();
  assert.deepEqual(emitted, { ...agent, plugins: [] });
  assert.equal(control(render({ ...props, provider: 'claude', agent }), 'index'), undefined);
  assert.equal(control(render({ ...props, disabled: true, agent }), '移除MCP 服务 docs').props.disabled, true);

  const fullServers = Array.from({ length: 8 }, (_, index) => ({ id: `server-${index}`, targetId: codexTargetId }));
  const full = render({ ...props, agent: { ...agent, mcpServers: fullServers } });
  assert.equal(control(full, 'index').props.disabled, true);
  assert.equal(control(full, '移除MCP 服务 server-0').props.disabled, undefined);
});

test('module manifests reject missing, unknown, duplicate or invalid modules and extra metadata', () => {
  const [executor, persona] = draft.modules;
  const invalid = [
    [executor], [persona], [executor, persona, executor], [executor, persona, { id: 'plugin', config: {} }],
    [executor, persona, { id: '__proto__', config: {} }], [executor, null], [executor, persona, null],
    [{ ...executor, path: './executor.mjs' }, persona], [{ ...executor, config: { ...executor.config, npm: 'package' } }, persona],
    [executor, { ...persona, config: { ...persona.config, privileges: ['write'] } }],
    [executor, persona, { id: 'output', config: {} }], [executor, persona, { id: 'output', config: { instruction: 1 } }],
    Object.assign([executor, persona], { path: './executor.mjs' }), null,
  ];
  for (const modules of invalid) {
    assert.throws(() => applyAgentPresetChange([], save({ draft: { ...draft, modules } })), /无效|重复|缺少/u);
  }
});

test('output validation enforces the effective workflow instruction limit and rejects empty or invalid text', () => {
  const output = '结论';
  const length = 1200 - `\n\n输出规范\n${output}`.length;
  const exact = manifest({ ...stage, instruction: '角'.repeat(length), output: `\n${output}\n` });
  const [record] = applyAgentPresetChange([], save({ draft: exact }));
  assert.equal(resolveAgentPreset(record).instruction.length, 1200);
  assert.equal(agentPresetFields(record).output, output);
  const oversized = manifest({ ...stage, instruction: '角'.repeat(length + 1), output });
  assert.throws(() => applyAgentPresetChange([record], save({ revision: 1, draft: oversized })), /总长度须为 1 至 1200 个字符/u);
  assert.equal(record.revision, 1);
  for (const bad of [' ', '\u0001', '\uD800', '字'.repeat(1201)]) {
    assert.throws(() => applyAgentPresetChange([], save({ draft: manifest({ ...stage, output: bad }) })), /输出规范/u);
  }
});

test('stale revisions and duplicate or invalid identities cannot change saved roles', () => {
  const created = applyAgentPresetChange([], save());
  assert.throws(() => applyAgentPresetChange(created, save({ id: id.toUpperCase() })), /已存在/u);
  assert.throws(() => applyAgentPresetChange(created, save({ revision: 2 })), /已变更/u);
  assert.throws(() => applyAgentPresetChange(created, remove(2)), /已变更/u);
  assert.throws(() => applyAgentPresetChange([], remove(1)), /已变更/u);
  assert.throws(() => applyAgentPresetChange(created, remove(null)), /格式无效/u);
  assert.throws(() => applyAgentPresetChange(created, save({ id: 'not-a-uuid' })), /格式无效/u);
  assert.throws(() => applyAgentPresetChange(created, { ...remove(1), draft }), /格式无效/u);
  assert.throws(() => applyAgentPresetChange(created, { ...save(), field: 'extra' }), /格式无效/u);
  assert.throws(() => applyAgentPresetChange(created, { ...save(), op: 'replace' }), /格式无效/u);
  assert.throws(() => applyAgentPresetChange([{ ...created[0], revision: Number.MAX_SAFE_INTEGER }],
    save({ revision: Number.MAX_SAFE_INTEGER })), /达到上限/u);
  assert.deepEqual(created, [{ id, revision: 1, ...draft }]);
});

test('local decoding rejects invalid shapes and bounds the records and raw storage', () => {
  let records = [];
  for (let index = 0; index < maxAgentPresets; index += 1) {
    records = applyAgentPresetChange(records, save({ id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}` }));
  }
  assert.deepEqual(readAgentPresets(JSON.stringify(records)), records);
  assert.throws(() => applyAgentPresetChange(records, save()), /最多可保存 24 个/u);
  assert.throws(() => readAgentPresets(JSON.stringify([...records, { id, revision: 1, ...draft }])), /列表无效/u);
  for (const raw of [undefined, [], '[', ' '.repeat(200_001)]) {
    assert.throws(() => readAgentPresets(raw), /无法读取/u);
  }
  for (const value of [null, {}, [null], [{ ...records[0], revision: 0 }], [{ ...records[0], extra: true }],
    [{ ...records[0], model: '@invalid' }], [{ id, revision: 1, ...draft }, { id: id.toUpperCase(), revision: 1, ...draft }]]) {
    assert.throws(() => readAgentPresets(JSON.stringify(value)), /无效|重复/u);
  }
});
