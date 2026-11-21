import { afterPopupMotion } from './menu-motion.js';

const prototypeCss = `
  [data-vps-chat] .vc-settings.vc-prototype-player {width:min(900px,calc(100% - 26px)); max-width:none; padding:0; overflow:hidden}
  [data-vps-chat] .vc-prototype-top {
    display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; padding:12px 14px; border-bottom:1px solid var(--vc-line);
  }
  [data-vps-chat] .vc-prototype-top :is(h2,p) {margin:0}
  [data-vps-chat] .vc-prototype-top h2 {font-size:15px}
  [data-vps-chat] .vc-prototype-top p {font-size:12px; color:var(--vc-muted); overflow-wrap:anywhere}
  [data-vps-chat] .vc-prototype-heading {flex:1; min-width:150px}
  [data-vps-chat] .vc-prototype-screen {padding:12px; background:var(--vc-stage); display:grid; justify-items:center}
  [data-vps-chat] .vc-prototype-screen iframe {
    display:block; width:100%; height:min(67vh,720px); border:1px solid var(--vc-line); border-radius:9px; background:#fff;
  }
  [data-vps-chat] .vc-prototype-description {font-size:13px; color:var(--vc-muted); overflow-wrap:anywhere}
`;

export function createDesignPrototype(React) {
  const h = React.createElement;

  function useDialog(dismiss) {
    const dialog = React.useRef(null);
    const cancelMotion = React.useRef(null);
    React.useLayoutEffect(() => {
      dialog.current.showModal();
      return () => cancelMotion.current?.();
    }, []);
    const close = React.useCallback(() => {
      const node = dialog.current;
      if (!node?.open) return;
      node.close();
      cancelMotion.current = afterPopupMotion(node, dismiss);
    }, [dismiss]);
    return { dialog, close, onCancel(event) { event.preventDefault(); close(); } };
  }

  function ConnectorDialog({ source, boards, links, save, dismiss }) {
    const { dialog, close, onCancel } = useDialog(dismiss);
    const heading = React.useId();
    const triggers = source.layers.filter(({ tag, editable }) => editable || ['a', 'button', 'img', 'input', 'summary'].includes(tag));
    const [layer, setLayer] = React.useState(links.find((link) => link.from === source.id)?.layer ??
      triggers.find(({ tag }) => tag === 'button' || tag === 'a')?.id ?? triggers[0]?.id ?? '');
    const destinationFor = (id) => links.find((link) => link.from === source.id && link.layer === id)?.to ?? '';
    const [target, setTarget] = React.useState(() => destinationFor(layer));
    const targets = boards.filter((board) => board.id !== source.id && !board.provisional);
    function commit(to) {
      save(source.id, layer, to);
      close();
    }
    return h('dialog', { ref: dialog, className: 'vc-settings vc-conversation-dialog vc-popup-motion',
      'aria-labelledby': heading, onCancel },
    h('form', { onSubmit(event) { event.preventDefault(); if (layer && targets.some(({ id }) => id === target)) commit(target); } },
      h('h2', { id: heading }, '连接画板'),
      h('p', { className: 'vc-prototype-description' }, `从「${source.title}」选择一个可点击元素和要打开的画板。`),
      h('label', null, '触发元素', h('select', { 'aria-label': '触发元素', value: layer, disabled: !triggers.length,
        onChange(event) { setLayer(event.target.value); setTarget(destinationFor(event.target.value)); },
      }, !triggers.length ? h('option', { value: '' }, '此画板暂无可用元素') : null,
      triggers.map(({ id, label, tag }) => h('option', { key: id, value: id }, `${label} · ${tag}`)))),
      h('label', null, '目标画板', h('select', { 'aria-label': '目标画板', value: target, disabled: !targets.length,
        onChange: (event) => setTarget(event.target.value),
      }, h('option', { value: '' }, '选择画板'),
      targets.map(({ id, title, version }) => h('option', { key: id, value: id }, `${title} · 版本 ${version}`)))),
      h('div', { className: 'vc-dialog-actions' },
        h('button', { type: 'button', className: 'vc-button', onClick: close }, '取消'),
        destinationFor(layer) ? h('button', { type: 'button', className: 'vc-button', onClick: () => commit('') }, '移除连接') : null,
        h('button', { type: 'submit', className: 'vc-button vc-primary',
          disabled: !layer || !targets.some(({ id }) => id === target) }, '保存连接'))));
  }

  function PrototypePlayer({ start, boards, links, width, dismiss }) {
    const { dialog, close, onCancel } = useDialog(dismiss);
    const heading = React.useId();
    const [visited, setVisited] = React.useState([start]);
    const [loaded, setLoaded] = React.useState(null);
    const current = boards.get(visited.at(-1)) ?? boards.get(start);

    React.useLayoutEffect(() => {
      if (!loaded || loaded.boardId !== current.id) return undefined;
      const { doc } = loaded;
      const linked = [];
      for (const { from, layer, to } of links) {
        if (from !== current.id) continue;
        const node = doc.querySelector(`[data-dsh-layer="${layer}"]`);
        if (!node) continue;
        linked.push([node, node.getAttribute('tabindex'), node.getAttribute('role')]);
        node.setAttribute('data-vc-prototype-to', to);
        node.setAttribute('tabindex', '0');
        if (!node.matches('button, a, input')) node.setAttribute('role', 'link');
      }
      const style = doc.createElement('style');
      style.textContent = `
        :is([data-vc-prototype-to],[data-dsh-go]) {cursor:pointer !important}
        :is([data-vc-prototype-to],[data-dsh-go]):is(:focus-visible,:hover) {
          outline:2px solid #1e9c87 !important; outline-offset:2px !important;
        }
      `;
      doc.head?.append(style);
      function navigate(event) {
        if (event.type === 'keydown') {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
          if (event.key !== 'Enter' && event.key !== ' ') return;
        }
        const trigger = event.target?.closest?.('[data-vc-prototype-to],[data-dsh-go]');
        if (!trigger) return;
        const to = trigger.getAttribute('data-vc-prototype-to') ?? `${current.versionId}:${trigger.getAttribute('data-dsh-go')}`;
        const target = boards.get(to);
        if (!target || target.provisional || to === current.id) return;
        event.preventDefault();
        setVisited((previous) => [...previous.slice(-79), to]);
      }
      doc.addEventListener('click', navigate, true);
      doc.addEventListener('keydown', navigate, true);
      return () => {
        for (const [node, tabindex, role] of linked) {
          node.removeAttribute('data-vc-prototype-to');
          if (tabindex === null) node.removeAttribute('tabindex');
          else node.setAttribute('tabindex', tabindex);
          if (role === null) node.removeAttribute('role');
          else node.setAttribute('role', role);
        }
        style.remove();
        doc.removeEventListener('click', navigate, true);
        doc.removeEventListener('keydown', navigate, true);
      };
    }, [loaded, current, boards, links, close]);

    return h('dialog', { ref: dialog, className: 'vc-settings vc-prototype-player vc-popup-motion',
      'aria-labelledby': heading, onCancel },
    h('style', null, prototypeCss),
    h('header', { className: 'vc-prototype-top' },
      h('div', { className: 'vc-prototype-heading' },
        h('h2', { id: heading }, '原型播放'),
        h('p', { role: 'status' }, current.title)),
      h('button', { type: 'button', className: 'vc-button', disabled: visited.length === 1,
        onClick: () => setVisited((previous) => previous.slice(0, -1)) }, '返回上一画板'),
      h('button', { type: 'button', className: 'vc-button', onClick: () => setVisited([start]) }, '从头播放'),
      h('button', { type: 'button', className: 'vc-button', 'aria-label': '关闭原型', onClick: close }, '关闭')),
    h('div', { className: 'vc-prototype-screen' },
      h('iframe', { key: current.id, title: '交互原型预览', sandbox: 'allow-same-origin', referrerPolicy: 'no-referrer',
        srcDoc: current.html, style: { maxWidth: width },
        onLoad: (event) => {
          const doc = event.currentTarget.contentDocument;
          if (doc) setLoaded({ doc, boardId: current.id });
        },
      })));
  }

  return { ConnectorDialog, PrototypePlayer };
}
