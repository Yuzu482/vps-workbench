import { menuIcon } from './menu-icons.js';
import { afterPopupMotion } from './menu-motion.js';

export const editMenuGroups = [
  [['undo', '撤销', 'Ctrl+Z'], ['redo', '重做', 'Ctrl+Y']],
  [['cut', '剪切', 'Ctrl+X'], ['copy', '复制', 'Ctrl+C'], ['paste', '粘贴', 'Ctrl+V']],
  [['selectAll', '全选', 'Ctrl+A']],
];

export function contextMenuKey(event) {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !(event.nativeEvent ?? event).isComposing &&
    (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'));
}

export function contextMenuRequest(event, anchor, label, groups, { point, frame } = {}) {
  event.preventDefault();
  event.stopPropagation();
  const keyboard = event.type === 'keydown' || (event.clientX === 0 && event.clientY === 0);
  if (keyboard && !point) {
    const bounds = anchor.getBoundingClientRect();
    point = { x: bounds.left + 8, y: bounds.bottom };
  }
  return { anchor, label, groups, keyboard, frame, ...(point ?? { x: event.clientX, y: event.clientY }) };
}

function placeAtPointer(panel, { x, y }) {
  const edge = 8;
  const { clientWidth, clientHeight } = document.documentElement;
  const { offsetWidth: width, offsetHeight: height } = panel;
  const left = x + width + edge <= clientWidth ? x : x - width;
  const above = y + height + edge > clientHeight && y > clientHeight / 2;
  const top = above ? y - height : y;
  panel.style.left = `${Math.max(edge, Math.min(left, clientWidth - width - edge))}px`;
  panel.style.top = `${Math.max(edge, Math.min(top, clientHeight - height - edge))}px`;
  panel.dataset.side = above ? 'above' : 'below';
}

export function createContextMenu(React) {
  const h = React.createElement;
  return function ContextMenu({ request, dismiss, closing }) {
    const ref = React.useRef(null);

    function close() {
      if (ref.current.matches(':popover-open')) ref.current.hidePopover();
      request.anchor.focus({ preventScroll: true });
    }

    React.useLayoutEffect(() => {
      const panel = ref.current;
      const frameDocument = request.frame?.contentDocument;
      let cancel = () => {};
      const position = () => placeAtPointer(panel, request);
      // The browser's light dismissal only receives events in the popover's own document.
      const dismissFromFrame = () => { if (panel.matches(':popover-open')) panel.hidePopover(); };
      const prepareToggle = ({ newState }) => {
        const closing = newState === 'closed';
        panel.inert = closing;
        panel.setAttribute('aria-hidden', String(closing));
      };
      const onToggle = ({ newState }) => {
        if (newState !== 'closed' || panel.matches(':popover-open')) return;
        if (document.activeElement === document.body) request.anchor.focus({ preventScroll: true });
        cancel = afterPopupMotion(panel, () => dismiss(request));
      };
      panel.addEventListener('beforetoggle', prepareToggle);
      panel.addEventListener('toggle', onToggle);
      frameDocument?.addEventListener('pointerdown', dismissFromFrame, true);
      window.addEventListener('resize', position);
      panel.showPopover({ source: request.anchor });
      position();
      const first = request.keyboard ? panel.querySelector('[role=menuitem]:not([aria-disabled=true])') : null;
      (first ?? panel).focus({ preventScroll: true });
      return () => {
        cancel();
        frameDocument?.removeEventListener('pointerdown', dismissFromFrame, true);
        window.removeEventListener('resize', position);
        panel.removeEventListener('beforetoggle', prepareToggle);
        panel.removeEventListener('toggle', onToggle);
        if (panel.matches(':popover-open')) panel.hidePopover();
      };
    }, [request, dismiss]);

    React.useLayoutEffect(() => {
      const panel = ref.current;
      if (closing && panel.matches(':popover-open')) panel.hidePopover();
    }, [closing]);

    function handleKey(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      const items = Array.from(ref.current.querySelectorAll('[role=menuitem]'));
      const current = items.indexOf(event.target);
      const positions = { ArrowDown: current + 1, ArrowUp: current < 0 ? -1 : current - 1, Home: 0, End: -1 };
      if (!Object.hasOwn(positions, event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      items.at(positions[event.key] % items.length)?.focus({ preventScroll: true });
    }

    return h('div', { ref, popover: 'auto', tabIndex: -1, role: 'menu', 'aria-label': request.label,
      className: 'vc-context-menu vc-popup-motion', 'data-side': 'below', onKeyDown: handleKey,
      onContextMenu: (event) => event.preventDefault(),
    }, request.groups.filter((group) => group.length).map((group, index) => h(React.Fragment, { key: group[0].id },
      index > 0 ? h('hr', { role: 'separator' }) : null,
      group.map(({ id, label, detail, icon, shortcut, disabled, run }) => h('button', {
        key: id, type: 'button', role: 'menuitem', tabIndex: -1, 'aria-disabled': disabled || undefined, title: detail,
        onClick() { if (!disabled) { close(); run(); } },
      }, menuIcon(h, icon), h('span', null, label), shortcut ? h('kbd', null, shortcut) : null)))));
  };
}

export const contextMenuCss = `
  [data-vps-chat] .vc-context-menu {
    position:fixed; inset:auto; margin:0; box-sizing:border-box; width:max-content;
    min-width:min(200px,calc(100vw - 16px)); max-width:calc(100vw - 16px); max-height:calc(100vh - 16px);
    padding:5px; overflow:auto; overscroll-behavior:contain; border:1px solid var(--vc-line); border-radius:11px;
    background:var(--vc-surface); color:var(--vc-ink); box-shadow:var(--vc-shadow); outline:none;
  }
  [data-vps-chat] .vc-context-menu [role=menuitem] {
    display:flex; align-items:center; gap:9px; width:100%; min-height:32px; padding:5px 8px;
    border:0; border-radius:6px; background:transparent; color:inherit; font-size:13px; text-align:start;
    transition:background-color var(--vc-control-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-context-menu [role=menuitem]:is(:hover,:focus-visible):not([aria-disabled=true]) {background:var(--vc-hover)}
  [data-vps-chat] .vc-context-menu [role=menuitem]:focus-visible {outline-offset:-2px}
  [data-vps-chat] .vc-context-menu [aria-disabled=true] {color:var(--vc-muted); opacity:.65; cursor:default}
  [data-vps-chat] .vc-context-menu [role=menuitem] > span:not(.vc-menu-icon) {flex:1; min-width:0}
  [data-vps-chat] .vc-context-menu :is(.vc-menu-icon,kbd) {color:var(--vc-muted)}
  [data-vps-chat] .vc-context-menu kbd {font:inherit; font-size:11px; margin-inline-start:12px; white-space:nowrap}
  [data-vps-chat] .vc-context-menu hr {margin:4px 3px; border:0; border-block-start:1px solid var(--vc-line)}
  [data-vps-chat] .vc-context-notice {position:fixed; z-index:10; right:16px; bottom:17px; pointer-events:none}
  [data-vps-chat] .vc-context-notice:not(:empty) {
    max-width:calc(100% - 32px); padding:8px 13px;
    border:1px solid var(--vc-line); border-radius:9px; box-shadow:var(--vc-shadow);
    background:var(--vc-surface); color:var(--vc-ink); font-size:13px;
  }
`;
