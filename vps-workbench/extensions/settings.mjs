import { automaticMemoryPolicy, validLocalMcpEndpoint } from './state.mjs';
import { effortName } from '../../remote-workbench/vps-chat/client/model-catalog.js';

const styles = `
  .vc-extension-settings {display:grid; gap:10px}
  .vc-extension-settings .vc-settings-group {margin:0}
  .vc-extension-settings .vc-settings-group > summary {cursor:pointer; font-weight:650}
  .vc-extension-settings textarea,.vc-extension-settings select {
    box-sizing:border-box; width:100%; min-width:0; min-height:34px; padding:6px 8px;
    border:1px solid var(--vc-line); border-radius:7px; color:var(--vc-ink); background:var(--vc-canvas);
    font:inherit;
  }
  .vc-extension-settings textarea {min-height:88px; resize:vertical}
  .vc-extension-settings .vc-extension-actions {display:flex; align-items:center; flex-wrap:wrap; gap:8px}
  .vc-extension-settings .vc-extension-switch-row {
    display:flex; align-items:center; justify-content:space-between; gap:10px; width:fit-content; min-height:34px;
    padding:5px 8px; border-radius:8px; color:var(--vc-muted); cursor:pointer;
    transition:background-color var(--vc-control-duration) ease;
  }
  .vc-extension-settings .vc-extension-switch-row:not(:has(input:disabled)):hover {background:var(--vc-hover)}
  .vc-extension-settings .vc-extension-switch-row:has(input:disabled) {cursor:default}
  .vc-extension-settings .vc-extension-switch-row[data-feature] {
    width:auto; padding:7px 8px; margin:-7px -8px; gap:16px;
  }
  .vc-extension-settings .vc-extension-switch-copy {display:grid; gap:4px; min-width:0; font-size:12px}
  .vc-extension-settings .vc-extension-switch-row[data-feature] .vc-extension-switch-copy > :first-child {
    color:var(--vc-ink); font-size:14px; font-weight:680;
  }
  .vc-extension-settings .vc-extension-switch-description {font-size:13px; line-height:1.48; overflow-wrap:anywhere}
  .vc-extension-settings .vc-extension-preview {white-space:pre-wrap; overflow-wrap:anywhere}
  .vc-extension-settings .vc-extension-templates {display:grid; gap:10px}
  .vc-extension-settings .vc-extension-templates > section {display:grid; gap:4px; padding:8px 0; border-top:1px solid var(--vc-line)}
`;

const blankNote = projectId => ({ id: '', title: '', text: '', projectId, enabled: true });
const registryId = /^[a-z][a-z0-9_-]{0,31}$/;
const maxImportBytes = 32 * 1024;
const memoryProviderLabels = { codex: 'Codex', claude: 'Claude API', 'claude-sdk': 'Claude SDK', antigravity: 'Antigravity' };

function saveNote({ id, targetId, projectId, title, text, enabled }) {
  return { op: 'save-memory', memory: { id, targetId, projectId, title, text, enabled } };
}

export function createExtensionSettings(React) {
  const h = React.createElement;

  function button(label, onClick, disabled, primary = false) {
    return h('button', {
      type: 'button', className: `vc-button ${primary ? 'vc-primary' : 'vc-settings-outline'}`, onClick, disabled,
    }, label);
  }

  function Switch({ label, checked, edit, disabled, title, description }) {
    const descriptionId = React.useId();
    return h('label', { className: 'vc-extension-switch-row', 'data-feature': title ? '' : undefined },
      h('span', { className: 'vc-extension-switch-copy' }, h('span', null, title ?? label),
        description ? h('span', { className: 'vc-extension-switch-description', id: descriptionId }, description) : null),
      h('input', { type: 'checkbox', role: 'switch', className: 'vc-settings-switch', 'aria-label': label,
        'aria-describedby': description ? descriptionId : undefined,
        checked, disabled, onChange: event => edit(event.target.checked) }));
  }

  function toggle(label, checked, edit, disabled, details) {
    return h(Switch, { label, checked, edit, disabled, ...details });
  }

  function field(label, props, tag = 'input', children) {
    return h('label', { className: 'vc-field' }, label, h(tag, props, children));
  }

  function actions(...children) {
    return h('div', { className: 'vc-extension-actions' }, ...children);
  }

  function McpSettings({ state, submit, mcpTargetId: targetId, mcpProvider, disabled, localSdk }) {
    const [id, setId] = React.useState('');
    const [url, setUrl] = React.useState('');
    const [toolNames, setToolNames] = React.useState('');
    const tools = toolNames.trim().split(/[\s,，]+/u).filter(Boolean);
    const configured = { url: url.trim(), tools };
    const servers = state.servers.filter(server => server.targetId === targetId && Boolean(server.local) === Boolean(localSdk));
    const idExists = servers.some(server => server.id === id);

    async function add() {
      if (await submit({ op: 'save-server', server: { id, targetId, enabled: false, ...(localSdk && { local: configured }) } })) {
        setId('');
        setUrl('');
        setToolNames('');
      }
    }

    return h(React.Fragment, null,
      h('p', null, mcpProvider === 'antigravity'
        ? '为 Antigravity 工作流登记 VPS 管理员已配置的 Python stdio 服务。'
        : localSdk ? '使用已有的本机 HTTP MCP 服务。Claude 和 Antigravity 由工作流阶段逐项授权工具。'
          : '为 Codex 登记 VPS 管理员已配置的 Python stdio 服务。'),
      h('section', { className: 'vc-settings-group' },
        h('h4', null, '添加 MCP 服务'),
        field('服务 ID', { value: id, placeholder: '例如 docs', maxLength: 32, spellCheck: false,
          autoComplete: 'off', disabled: disabled || !targetId, onChange: event => setId(event.target.value) }),
        h('p', null, targetId ? '以小写字母开头，只包含小写字母、数字、下划线或短横线。'
          : localSdk ? '登记本机配置后可添加服务。' : '请连接 VPS 并核对 Codex 或 Antigravity 连接。'),
        localSdk ? h(React.Fragment, null,
          field('本机 HTTP 地址', { value: url, maxLength: 256, placeholder: 'http://127.0.0.1:8000/mcp',
            disabled: disabled || !targetId, onChange: event => setUrl(event.target.value) }),
          field('允许调用的工具', { value: toolNames, maxLength: 2100, placeholder: '例如 search, read',
            disabled: disabled || !targetId, onChange: event => setToolNames(event.target.value) })) : null,
        idExists ? h('p', { role: 'status' }, '已添加此服务 ID。') : null,
        actions(button('添加', add, disabled || !targetId || idExists || !registryId.test(id) ||
          localSdk && !validLocalMcpEndpoint(configured.url, tools), true))),
      servers.map(server => h('section', { key: server.id, className: 'vc-settings-group' },
        h('h4', null, server.id),
        server.local ? h('p', null, server.local.url + ' · ' + server.local.tools.join('、')) : null,
        actions(toggle('启用服务', server.enabled, enabled => submit({ op: 'save-server', server: { ...server, enabled } }), disabled),
          button('移除服务', () => submit({ op: 'remove-server', id: server.id, targetId }), disabled)))));
  }

  function PluginSettings({ state, submit, disabled }) {
    const [source, setSource] = React.useState('');
    const fileInput = React.useRef(null);

    function manifestAction(raw) {
      if (new TextEncoder().encode(raw).byteLength > maxImportBytes) throw new Error('invalid_manifest');
      return { op: 'import-plugin', manifest: JSON.parse(raw) };
    }

    async function pasteImport() {
      if (await submit(() => manifestAction(source))) setSource('');
    }

    function fileImport(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      submit(async () => {
        if (file.size > maxImportBytes) throw new Error('invalid_manifest');
        return manifestAction(await file.text());
      });
    }

    return h(React.Fragment, null,
      h('p', null, '启用后，可从输入栏插入清单中的纯文本提示词模板。'),
      h('section', { className: 'vc-settings-group' },
        h('h4', null, '导入提示词模板清单'),
        field('粘贴 JSON 清单', { value: source, maxLength: maxImportBytes, disabled, spellCheck: false,
          onChange: event => setSource(event.target.value) }, 'textarea'),
        h('input', { hidden: true, ref: fileInput, type: 'file', accept: '.json,application/json', disabled, onChange: fileImport }),
        actions(button('导入粘贴的提示词模板', pasteImport, disabled || !source.trim(), true),
          button('从 JSON 文件导入', () => fileInput.current?.click(), disabled))),
      state.plugins.map(plugin => h('section', { key: plugin.id, className: 'vc-settings-group' },
        h('h4', null, plugin.name), h('p', { className: 'vc-settings-description' }, `${plugin.id} · ${plugin.version}`),
        plugin.description ? h('p', { className: 'vc-extension-preview' }, plugin.description) : null,
        actions(toggle('启用提示词模板', plugin.enabled, enabled => submit({ op: 'set-plugin', id: plugin.id, enabled }), disabled),
          button('移除提示词模板', () => submit({ op: 'remove-plugin', id: plugin.id }), disabled)),
        h('details', { className: 'vc-settings-disclosure vc-details-motion' },
          h('summary', null, h('strong', { className: 'vc-settings-description' }, '提示词模板'),
            h('i', { className: 'vc-settings-chevron', 'aria-hidden': true })),
          h('div', { className: 'vc-settings-disclosed vc-extension-templates' },
            plugin.prompts.map(prompt => h('section', { key: prompt.title }, h('strong', null, prompt.title),
              h('p', { className: 'vc-extension-preview' }, prompt.text))))))));
  }

  function MemoryExtractionModel({ state, memoryTargetId, readMemoryModels, submit, disabled, localSdk }) {
    const saved = state.memoryExtractionModels.find(({ targetId }) => targetId === memoryTargetId);
    const savedModel = saved?.model ?? '';
    const savedEffort = saved?.effort ?? '';
    const [model, setModel] = React.useState(savedModel);
    const [effort, setEffort] = React.useState(savedEffort);
    const [models, setModels] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const request = React.useRef(null);
    React.useEffect(() => {
      setModel(savedModel);
      setEffort(savedEffort);
    }, [savedModel, savedEffort]);
    React.useEffect(() => () => request.current?.abort(), []);
    const ready = Boolean(memoryTargetId && readMemoryModels);
    const selected = models?.find(({ id }) => id === model);
    const offeredEfforts = selected?.efforts ?? [];
    const available = !model || Boolean(selected && (!effort || offeredEfforts.includes(effort)));
    const dirty = model !== savedModel || effort !== savedEffort;

    async function load() {
      const controller = new AbortController();
      request.current?.abort();
      request.current = controller;
      setLoading(true);
      setError('');
      setModels(null);
      try {
        const result = await readMemoryModels(controller.signal);
        if (!controller.signal.aborted) setModels(result);
      } catch {
        if (!controller.signal.aborted) setError(localSdk ? '无法读取本机 Codex 模型目录。' : '无法读取此 VPS 的 Codex 模型目录。');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    function save() {
      return submit({ op: 'set-memory-extraction-model', targetId: memoryTargetId,
        ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    }

    return h('section', { className: 'vc-settings-group' },
      h('h4', null, '记忆提炼模型'),
      h('p', { className: 'vc-settings-description' }, localSdk ? '个人和项目自动记忆共用此本机配置的提炼设置。'
        : '个人和项目自动记忆共用此 VPS 的提炼设置，聊天模型单独设置。'),
      field('Codex 模型', { value: model, disabled: disabled || !ready || loading || (!models && !model),
        onChange: event => { setModel(event.target.value); setEffort(''); } }, 'select', [
        h('option', { key: '', value: '' }, localSdk ? '使用本机配置的默认模型' : '使用 VPS 默认模型'),
        model && !selected ? h('option', { key: model, value: model }, models ? `${model}（当前不可用）` : model) : null,
        ...Array.from(models ?? [], ({ id, displayName }) => h('option', { key: id, value: id }, displayName)),
      ]),
      field('提炼推理强度', { value: effort, disabled: disabled || !ready || loading || (!offeredEfforts.length && !effort),
        onChange: event => setEffort(event.target.value) }, 'select', [
        h('option', { key: '', value: '' }, '使用模型默认强度'),
        effort && !offeredEfforts.includes(effort) ? h('option', { key: effort, value: effort },
          models ? `${effortName(effort)}（当前不可用）` : effortName(effort)) : null,
        ...offeredEfforts.map(id => h('option', { key: id, value: id }, effortName(id))),
      ]),
      !ready ? h('p', { className: 'vc-settings-description' }, localSdk ? '选择本机配置并开启本机执行后可调整。'
        : '连接 VPS 并切换为 VPS 执行后可调整提炼模型。') : null,
      models?.length === 0 ? h('p', { role: 'status' }, '当前配置没有返回可选的 Codex 模型。') : null,
      error ? h('p', { className: 'vc-settings-inline-error', role: 'alert' }, error) : null,
      actions(button(loading ? '正在读取模型目录…' : '读取 Codex 模型目录', load, disabled || !ready || loading),
        button('保存提炼设置', save, disabled || !ready || loading || !dirty || !available, true)));
  }

  function MemorySettings({ state, submit, targetId, memoryTargetId, connectionName, readMemoryModels, projects, selectedProject, disabled, localSdk }) {
    const [draft, setDraft] = React.useState(null);
    const [automaticProject, setAutomaticProject] = React.useState(selectedProject);
    React.useEffect(() => setAutomaticProject(selectedProject), [selectedProject]);
    const projectId = projects.has(automaticProject) ? automaticProject : '';
    const policy = automaticMemoryPolicy(state, { targetId: memoryTargetId, projectId });
    const personalPolicy = automaticMemoryPolicy(state, { targetId: memoryTargetId, projectId: null, scopedPersonal: localSdk });
    const location = localSdk ? '本机 SDK' : 'VPS SSH';
    const scope = localSdk ? '此本机配置' : '此 VPS';
    const allProjects = localSdk ? '此本机配置的所有项目' : '此 VPS 的所有项目';
    const personalNotes = state.memories.filter(note => note.source && note.targetId === memoryTargetId && note.projectId === null);
    const automaticNotes = state.memories.filter(note => note.source && note.targetId === memoryTargetId && note.projectId === projectId);
    const manualNotes = state.memories.filter(note => !note.source && note.targetId === targetId);
    const projectLabel = id => projects.get(id) ?? '已移除的项目';
    const scopeLabel = note => note.projectId !== null ? projectLabel(note.projectId) :
      (note.source ? (localSdk ? '此本机配置的个人自动记忆' : '此 VPS 的个人自动记忆') : allProjects);
    const projectOptions = Array.from(projects, ([value, label]) => h('option', { key: value, value }, label));

    function edit(key, value) {
      setDraft(previous => ({ ...previous, [key]: value }));
    }

    async function save() {
      if (await submit(() => saveNote({ ...draft, id: draft.id || `note-${crypto.randomUUID().slice(0, 23)}`,
        targetId: draft.targetId ?? targetId }))) setDraft(null);
    }

    function noteCard(note) {
      const { id, targetId, source } = note;
      return h('section', { className: 'vc-settings-group', key: `${targetId}:${id}` },
        h('h4', null, note.title),
        h('p', { className: 'vc-settings-description' }, scopeLabel(note)),
        source ? h('details', { className: 'vc-settings-disclosure vc-details-motion' },
          h('summary', null, h('strong', { className: 'vc-settings-description' }, '查看记忆和来源'),
            h('i', { className: 'vc-settings-chevron', 'aria-hidden': true })),
          h('div', { className: 'vc-settings-disclosed' },
            h('p', { className: 'vc-extension-preview' }, note.text),
            h('p', { className: 'vc-settings-description vc-extension-preview' },
              `来自 ${memoryProviderLabels[source.provider]} 对话\n会话 ${source.sessionId}\n消息 ${source.turnId}`))) : null,
        actions(toggle('启用此记忆', note.enabled, enabled => submit(saveNote({ ...note, enabled })), disabled || Boolean(draft)),
          button('编辑', () => setDraft(note), disabled || Boolean(draft)),
          button('移除', () => submit({ op: 'remove-memory', targetId, id }), disabled || Boolean(draft))));
    }

    const draftForm = draft ? h('section', { className: 'vc-settings-group' },
      h('h4', null, draft.id ? '编辑记忆' : '添加记忆'),
      field('标题', { value: draft.title, maxLength: 80, disabled, onChange: event => edit('title', event.target.value) }),
      field('内容', { value: draft.text, maxLength: 2000, disabled, onChange: event => edit('text', event.target.value) }, 'textarea'),
      h('p', null, '正文最多 2,000 个字符和 2,400 个 UTF-8 字节。'),
      draft.source ? h('p', null, scopeLabel(draft)) : field('生效范围', { value: draft.projectId ?? '', disabled,
        onChange: event => edit('projectId', event.target.value || null) }, 'select', [
        h('option', { key: '', value: '' }, allProjects), ...projectOptions,
        draft.projectId && !projects.has(draft.projectId) ? h('option', { key: draft.projectId, value: draft.projectId },
          projectLabel(draft.projectId)) : null,
      ]),
      toggle('启用此记忆', draft.enabled, enabled => edit('enabled', enabled), disabled),
      actions(button('保存记忆', save, disabled || !draft.title.trim() || !draft.text.trim(), true),
        button('取消', () => setDraft(null), disabled))) : null;

    return h(React.Fragment, null,
      h('p', { className: 'vc-settings-current' }, memoryTargetId ? [ '作用范围', location, connectionName || scope ].join(' · ')
        : '完成 ' + location + ' 配置后可查看记忆。'),
      h('section', { className: 'vc-settings-group' },
        toggle('开启个人自动记忆', localSdk ? personalPolicy?.enabled ?? false : state.personalMemory?.enabled ?? false,
          enabled => submit(localSdk ? { op: 'set-scoped-personal-memory', targetId: memoryTargetId, enabled } :
            { op: 'set-personal-memory', enabled }), disabled || (localSdk && !memoryTargetId), {
            title: '个人自动记忆', description: localSdk ? '用于此配置下未归类的普通聊天。提炼使用本机 Codex 的额度。'
              : '用于未归类的普通聊天。记忆按 VPS 保存和使用，提炼使用 VPS 上的 Codex 额度。',
          })),
      draft?.source && draft.projectId === null ? draftForm : null,
      personalNotes.map(noteCard),
      h('section', { className: 'vc-settings-group' },
        toggle('开启此项目的自动记忆', policy?.enabled ?? false,
          enabled => submit({ op: 'set-automatic-memory', targetId: memoryTargetId, projectId, enabled }),
          disabled || !memoryTargetId || !projectId, {
            title: '自动项目记忆', description: localSdk ? '此配置下同一项目的对话和 Agent 可以引用相关记忆。'
              : '同一 VPS 下，项目会话可以跨工具引用相关记忆，包括手动添加的项目记忆。',
          }),
        field('记忆所属项目', { 'aria-label': '记忆所属项目', value: projectId,
          disabled: disabled || !projects.size || Boolean(draft?.source && draft.projectId !== null),
          onChange: event => setAutomaticProject(event.target.value) }, 'select', [
          h('option', { key: '', value: '' }, '选择项目'), ...projectOptions,
        ]),
        h('p', { className: 'vc-settings-description' }, localSdk ? '笔记保存在本机。输入栏可将会话切换为独立上下文。'
          : '笔记保存在本机。提炼使用 VPS 上的 Codex 额度，可在输入栏选择独立上下文。'),
        !memoryTargetId ? h('p', null, '完成连接配置后可设置自动项目记忆。') : null),
      draft?.source && draft.projectId !== null ? draftForm : null,
      automaticNotes.map(noteCard),
      h(MemoryExtractionModel, { state, memoryTargetId, readMemoryModels, submit, disabled, localSdk }),
      h('section', { className: 'vc-settings-group' },
        toggle('随消息发送手动记忆', state.memoryEnabled,
          enabled => submit({ op: 'set-memory-enabled', enabled }), disabled, {
            title: '手动记忆', description: localSdk ? '会话未使用自动记忆时，随消息向本机 Codex 发送匹配的手动笔记。'
              : '会话未使用自动记忆时，随消息向 VPS 上的 Codex 发送匹配的手动笔记。',
          })),
      !targetId ? h('p', null, '选择 Codex 执行配置后可添加笔记。') : null,
      draft && !draft.source ? draftForm : actions(button('添加记忆',
        () => setDraft(blankNote(projects.has(selectedProject) ? selectedProject : null)), disabled || !targetId || Boolean(draft))),
      manualNotes.map(noteCard));
  }

  const panels = { mcp: McpSettings, plugins: PluginSettings, memory: MemorySettings };

  return function ExtensionSettings(props) {
    const { section, busy, change, targetId, memoryTargetId, mcpTargetId = targetId, mcpProvider = 'codex' } = props;
    const [error, setError] = React.useState('');
    const [pending, setPending] = React.useState(false);
    const request = React.useRef(false);
    React.useEffect(() => setError(''), [section, targetId, memoryTargetId, mcpTargetId, mcpProvider]);

    async function submit(action) {
      if (request.current || busy) return false;
      request.current = true;
      setError('');
      setPending(true);
      let op;
      try {
        const update = typeof action === 'function' ? await action() : action;
        op = update.op;
        await change(update);
        return true;
      } catch {
        setError(op === 'set-memory-extraction-model' ? '无法保存记忆提炼设置。请核对连接和 Codex 模型目录，或恢复默认。'
          : section === 'plugins' ? '无法保存提示词模板，请检查清单格式、内容长度和清单 ID。' : '无法保存，请检查设置内容和长度后重试。');
        return false;
      } finally {
        request.current = false;
        setPending(false);
      }
    }

    const Panel = panels[section];
    if (!Panel) return null;
    return h('div', { className: 'vc-extension-settings', 'aria-busy': pending },
      h('style', null, styles),
      error ? h('p', { className: 'vc-settings-inline-error', role: 'alert' }, error) : null,
      h(Panel, { ...props, mcpTargetId, mcpProvider,
        key: section === 'mcp' ? `${mcpProvider}:${mcpTargetId}` : `${targetId}:${memoryTargetId}`,
        disabled: busy || pending, submit }));
  };
}
