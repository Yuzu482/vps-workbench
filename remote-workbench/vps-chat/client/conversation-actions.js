import { afterPopupMotion } from './menu-motion.js';
import { workbenchStorage } from './workbench-storage.js';

const sessionIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxTitleLength = 120;
export const conversationOptionsKey = (targetId) => `dsh-vps-chat-conversations:v1:${targetId}`;

export function readConversationOptions(targetId) {
  const saved = JSON.parse(workbenchStorage.getItem(conversationOptionsKey(targetId)) ?? '{}');
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid_conversation_options');
  return Object.fromEntries(Object.entries(saved).filter(([id, value]) => sessionIdPattern.test(id) && value &&
    typeof value === 'object' && !Array.isArray(value)).map(([id, value]) => [id, {
      ...(typeof value.title === 'string' && value.title.trim() && value.title.length <= maxTitleLength
        ? { title: value.title } : {}),
      ...(value.pinned === true ? { pinned: true } : {}),
      ...(value.archived === true ? { archived: true } : {}),
    }]));
}

export function updateConversationOptions(options, sessionId, change) {
  const entry = { ...options[sessionId], ...change };
  const next = { ...options };
  for (const key of Object.keys(entry)) if (!entry[key]) delete entry[key];
  if (Object.keys(entry).length) next[sessionId] = entry;
  else delete next[sessionId];
  return next;
}

export function createConversationDialog(React) {
  const h = React.createElement;
  return function ConversationDialog({ kind, title, projectId, destinationId, projects, needsMemoryChoice, apply, dismiss }) {
    const rename = kind === 'rename';
    const dialog = React.useRef(null);
    const field = React.useRef(null);
    const cancel = React.useRef(null);
    const cancelMotion = React.useRef(null);
    const heading = React.useId();
    const [value, setValue] = React.useState(rename ? title.slice(0, maxTitleLength) : destinationId ?? projectId);
    const [confirmMemory, setConfirmMemory] = React.useState(Boolean(destinationId));
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');

    React.useLayoutEffect(() => {
      dialog.current.showModal();
      if (rename) field.current.select();
      return () => cancelMotion.current?.();
    }, [rename]);
    React.useLayoutEffect(() => {
      (confirmMemory ? cancel.current : field.current)?.focus({ preventScroll: true });
    }, [confirmMemory]);

    function close() {
      const element = dialog.current;
      if (!element?.open) return;
      element.close();
      cancelMotion.current = afterPopupMotion(element, dismiss);
    }

    const valid = rename ? Boolean(value.trim()) : value !== projectId && (!value || projects.has(value));
    async function submit(event) {
      event.preventDefault();
      if (!valid || busy) return;
      if (!rename && !confirmMemory && needsMemoryChoice(projectId, value)) {
        setConfirmMemory(true);
        setError('');
        return;
      }
      const choice = event.nativeEvent.submitter?.value;
      if (confirmMemory && choice !== 'inherit' && choice !== 'move-only') return;
      setBusy(true);
      setError('');
      try {
        if (await apply(rename ? value.trim() : value, confirmMemory ? choice === 'inherit' : undefined)) close();
        else setError('暂时无法保存。请重试。');
      } finally {
        setBusy(false);
      }
    }

    const fieldProps = { ref: field, value, disabled: busy, onChange: (event) => setValue(event.target.value) };
    return h('dialog', { ref: dialog,
      className: `vc-settings vc-conversation-dialog vc-popup-motion${confirmMemory ? ' vc-move-memory-dialog' : ''}`,
      'aria-labelledby': heading,
      onCancel(event) { event.preventDefault(); if (!busy) close(); },
    }, h('form', { onSubmit: submit },
      h('h2', { id: heading }, rename ? '重命名会话' : confirmMemory ? '移动会话并选择记忆' : '移动到项目'),
      confirmMemory ? h('div', { className: 'vc-move-memory-detail' },
        h('p', null, `将「${title}」从「${projects.get(projectId) ?? '原项目'}」移到「${projects.get(value) ?? '目标项目'}」。`),
        h('p', null, '继承后，后续消息可按目标项目设置引用和提炼记忆。独立上下文优先。仅移动会关闭此会话在目标项目中的共享记忆。'))
        : h('label', null, h('span', null, rename ? '会话名称' : '目标项目'),
        rename ? h('input', { ...fieldProps, maxLength: maxTitleLength, required: true })
          : h('select', fieldProps, h('option', { value: '' }, '未归类'),
            projectId && !projects.has(projectId) ? h('option', { value: projectId, disabled: true }, '原项目不可用') : null,
            [...projects].map(([id, name]) => h('option', { key: id, value: id }, name)))),
      error ? h('p', { role: 'alert' }, error) : null,
      h('div', { className: 'vc-dialog-actions' },
        h('button', { ref: cancel, type: 'button', className: 'vc-button', disabled: busy, onClick: close }, '取消'),
        confirmMemory ? h('button', { type: 'submit', value: 'move-only', className: 'vc-button',
          disabled: busy || !valid }, '仅移动') : null,
        h('button', { type: 'submit', value: 'inherit', className: 'vc-button vc-primary', disabled: busy || !valid },
          rename ? '保存' : confirmMemory ? '移入并继承记忆' : '移动'))));
  };
}

export const conversationActionsCss = `
  [data-vps-chat] .vc-settings.vc-conversation-dialog {width:min(376px,calc(100% - 26px)); box-shadow:var(--vc-shadow)}
  [data-vps-chat] .vc-settings.vc-move-memory-dialog {width:min(434px,calc(100% - 26px))}
  [data-vps-chat] .vc-move-memory-detail {display:grid; gap:8px; overflow-wrap:anywhere}
  [data-vps-chat] .vc-move-memory-detail p + p {color:var(--vc-muted); font-size:13px; line-height:1.55}
  [data-vps-chat] .vc-conversation-dialog form {display:grid; gap:15px}
  [data-vps-chat] .vc-conversation-dialog :is(h2,p) {margin:0}
  [data-vps-chat] .vc-conversation-dialog label {display:grid; gap:5px; color:var(--vc-muted); font-size:13px}
  [data-vps-chat] .vc-conversation-dialog :is(input,select) {
    min-width:0; min-height:34px; padding:5px 9px; border:1px solid var(--vc-line); border-radius:7px;
    background:var(--vc-canvas); color:var(--vc-ink);
  }
  [data-vps-chat] .vc-conversation-dialog [role=alert] {color:var(--vc-warn)}
  [data-vps-chat] :is(.vc-pinned-sessions,.vc-pinned-projects) {display:grid; gap:2px; margin-block-end:4px}
  [data-vps-chat] :is(.vc-session,.vc-project-filter) .vc-menu-icon[data-icon=pin] {
    flex:none; width:13px; height:13px; color:var(--vc-accent);
  }
  [data-vps-chat] .vc-session[draggable=true] {cursor:grab}
  [data-vps-chat] .vc-session[data-dragging] {opacity:.56; cursor:grabbing}
  [data-vps-chat] .vc-session-group[data-drop-target] > .vc-project-filter {
    color:var(--vc-accent); background:var(--vc-tint); box-shadow:inset 0 0 0 1px var(--vc-accent);
  }
  [data-vps-chat] .vc-session-group.vc-archived-sessions {margin-block-start:8px; padding-block-start:6px; border-top:1px solid var(--vc-line)}
`;
