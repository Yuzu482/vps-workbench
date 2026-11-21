import { automaticMemoryPolicy } from './state.mjs';

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

  function McpSettings({ state, submit, mcpTargetId: targetId, mcpProvider, disabled }) {
    const [id, setId] = React.useState('');
    const servers = state.servers.filter(server => server.targetId === targetId);
    const idExists = servers.some(server => server.id === id);

    async function add() {
      if (await submit({ op: 'save-server', server: { id, targetId, enabled: false } })) setId('');
    }

    return h(React.Fragment, null,
      h('p', null, mcpProvider === 'antigravity'
        ? '为 Antigravity 工作流登记 VPS 管理员已配置的 Python stdio 服务。'
        : '为 Codex 登记 VPS 管理员已配置的 Python stdio 服务。'),
      h('section', { className: 'vc-settings-group' },
        h('h4', null, '添加 MCP 服务'),
        field('服务 ID', { value: id, placeholder: '例如 docs', maxLength: 32, spellCheck: false,
          autoComplete: 'off', disabled: disabled || !targetId, onChange: event => setId(event.target.value) }),
        h('p', null, targetId ? '以小写字母开头，只包含小写字母、数字、下划线或短横线。'
          : '请连接 VPS 并核对 Codex 或 Antigravity 连接。'),
        idExists ? h('p', { role: 'status' }, '已添加此服务 ID。') : null,
        actions(button('添加', add, disabled || !targetId || idExists || !registryId.test(id), true))),
      servers.map(server => h('section', { key: server.id, className: 'vc-settings-group' },
        h('h4', null, server.id),
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
      h('p', null, '启用插件后，可从输入栏插入其中的纯文本提示词模板。'),
      h('section', { className: 'vc-settings-group' },
        h('h4', null, '导入插件'),
        field('粘贴 JSON 清单', { value: source, maxLength: maxImportBytes, disabled, spellCheck: false,
          onChange: event => setSource(event.target.value) }, 'textarea'),
        h('input', { hidden: true, ref: fileInput, type: 'file', accept: '.json,application/json', disabled, onChange: fileImport }),
        actions(button('导入粘贴内容', pasteImport, disabled || !source.trim(), true),
          button('选择 JSON 文件', () => fileInput.current?.click(), disabled))),
      state.plugins.map(plugin => h('section', { key: plugin.id, className: 'vc-settings-group' },
        h('h4', null, plugin.name), h('p', { className: 'vc-settings-description' }, `${plugin.id} · ${plugin.version}`),
        plugin.description ? h('p', { className: 'vc-extension-preview' }, plugin.description) : null,
        actions(toggle('启用插件', plugin.enabled, enabled => submit({ op: 'set-plugin', id: plugin.id, enabled }), disabled),
          button('移除插件', () => submit({ op: 'remove-plugin', id: plugin.id }), disabled)),
        h('details', { className: 'vc-settings-disclosure vc-details-motion' },
          h('summary', null, h('strong', { className: 'vc-settings-description' }, '提示词模板'),
            h('i', { className: 'vc-settings-chevron', 'aria-hidden': true })),
          h('div', { className: 'vc-settings-disclosed vc-extension-templates' },
            plugin.prompts.map(prompt => h('section', { key: prompt.title }, h('strong', null, prompt.title),
              h('p', { className: 'vc-extension-preview' }, prompt.text))))))));
  }

  function MemorySettings({ state, submit, targetId, memoryTargetId, projects, selectedProject, disabled }) {
    const [draft, setDraft] = React.useState(null);
    const [automaticProject, setAutomaticProject] = React.useState(selectedProject);
    React.useEffect(() => setAutomaticProject(selectedProject), [selectedProject]);
    const projectId = projects.has(automaticProject) ? automaticProject : '';
    const policy = automaticMemoryPolicy(state, { targetId: memoryTargetId, projectId });
    const personalNotes = state.memories.filter(note => note.source && note.targetId === memoryTargetId && note.projectId === null);
    const automaticNotes = state.memories.filter(note => note.source && note.targetId === memoryTargetId && note.projectId === projectId);
    const manualNotes = state.memories.filter(note => !note.source && note.targetId === targetId);
    const projectLabel = id => projects.get(id) ?? '已移除的项目';
    const scopeLabel = note => note.projectId !== null ? projectLabel(note.projectId) :
      (note.source ? '此 VPS 的个人自动记忆' : '此 VPS 的所有项目');
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
        h('option', { key: '', value: '' }, '此 VPS 的所有项目'), ...projectOptions,
        draft.projectId && !projects.has(draft.projectId) ? h('option', { key: draft.projectId, value: draft.projectId },
          projectLabel(draft.projectId)) : null,
      ]),
      toggle('启用此记忆', draft.enabled, enabled => edit('enabled', enabled), disabled),
      actions(button('保存记忆', save, disabled || !draft.title.trim() || !draft.text.trim(), true),
        button('取消', () => setDraft(null), disabled))) : null;

    return h(React.Fragment, null,
      h('section', { className: 'vc-settings-group' },
        toggle('开启个人自动记忆', state.personalMemory?.enabled ?? false,
          enabled => submit({ op: 'set-personal-memory', enabled }), disabled, {
            title: '个人自动记忆', description: '用于未归类的普通聊天。记忆按 VPS 保存和使用，提炼使用 VPS 上的 Codex 额度。',
          })),
      draft?.source && draft.projectId === null ? draftForm : null,
      personalNotes.map(noteCard),
      h('section', { className: 'vc-settings-group' },
        toggle('开启此项目的自动记忆', policy?.enabled ?? false,
          enabled => submit({ op: 'set-automatic-memory', targetId: memoryTargetId, projectId, enabled }),
          disabled || !memoryTargetId || !projectId, {
            title: '自动项目记忆', description: '同一 VPS 下，项目会话可以跨工具引用相关记忆，包括手动添加的项目记忆。',
          }),
        field('项目', { value: projectId, disabled: disabled || !projects.size || Boolean(draft?.source && draft.projectId !== null),
          onChange: event => setAutomaticProject(event.target.value) }, 'select', [
          h('option', { key: '', value: '' }, '选择项目'), ...projectOptions,
        ]),
        h('p', { className: 'vc-settings-description' }, '笔记保存在本机。提炼使用 VPS 上的 Codex 额度，可在输入栏选择独立上下文。'),
        !memoryTargetId ? h('p', null, '连接 VPS 后可设置自动项目记忆。') : null),
      draft?.source && draft.projectId !== null ? draftForm : null,
      automaticNotes.map(noteCard),
      h('section', { className: 'vc-settings-group' },
        toggle('随消息发送手动记忆', state.memoryEnabled,
          enabled => submit({ op: 'set-memory-enabled', enabled }), disabled, {
            title: '手动记忆', description: '会话未使用自动记忆时，随消息向 VPS 上的 Codex 发送匹配的手动笔记。',
          })),
      !targetId ? h('p', null, '请先连接 VPS 并切换到 Codex。') : null,
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
      try {
        await change(typeof action === 'function' ? await action() : action);
        return true;
      } catch {
        setError(section === 'plugins' ? '无法保存插件设置，请检查清单格式、内容长度及插件 ID。' : '无法保存，请检查设置内容和长度后重试。');
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
