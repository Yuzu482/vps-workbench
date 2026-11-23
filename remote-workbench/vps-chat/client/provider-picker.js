import { menuIcon } from './menu-icons.js';
import { workbenchStorage } from './workbench-storage.js';
import { readToolPreferences as readStoredToolPreferences } from './tool-preferences.js';

export const readToolPreferences = (settings, knownTools) =>
  readStoredToolPreferences(settings, knownTools, (key) => workbenchStorage.getItem(key));

function positionPalette(palette, button, count, openingIndex, docked) {
  const workbench = button.closest('[data-vps-chat]');
  const bounds = workbench.getBoundingClientRect();
  const inlineRail = docked && workbench.dataset.subscriptionOpen !== 'true' &&
    window.matchMedia('(width > 620px)').matches;
  palette.toggleAttribute('data-inline-rail', inlineRail);
  const anchor = button.getBoundingClientRect();
  const reveal = docked ? button.querySelector('.vc-tool-badge').getBoundingClientRect() : anchor;
  const padding = 5;
  const height = 42;
  const start = Math.max(0, bounds.left) + (inlineRail ? 0 : 6);
  const end = Math.min(window.innerWidth, bounds.right) - 6;
  const slot = Math.min(inlineRail ? 36 : 40, Math.max(24, (end - start - padding * 2) / count));
  const width = count * slot + padding * 2;
  const center = reveal.left + reveal.width / 2;
  const align = padding + (Math.min(openingIndex, count - 1) + .5) * slot;
  const preferredLeft = docked && !inlineRail ? anchor.left : center - align;
  const left = Math.max(start, Math.min(preferredLeft, end - width));
  const preferredTop = docked && !inlineRail ? anchor.top - height - 8 : reveal.top + (reveal.height - height) / 2;
  const top = Math.max(docked ? bounds.top + 6 : 6, Math.min(preferredTop, window.innerHeight - height - 6));
  const revealWidth = Math.min(reveal.width, width);
  const revealStart = Math.max(0, Math.min(center - left - revealWidth / 2, width - revealWidth));
  palette.style.setProperty('--vc-tool-slot', slot + 'px');
  palette.style.setProperty('--vc-reveal-start', revealStart + 'px');
  palette.style.setProperty('--vc-reveal-end', (width - revealStart - revealWidth) + 'px');
  palette.style.setProperty('--vc-tool-left', left + 'px');
  palette.style.setProperty('--vc-tool-top', top + 'px');
  if (!docked) {
    const reserved = Math.max(anchor.width, left + width + 4 - anchor.left);
    button.parentElement.style.setProperty('--vc-tool-reserved', reserved + 'px');
  }
}

export function createProviderPicker(React) {
  const h = React.createElement;
  return function ProviderPicker({ value, tools, disabled, active, select, closeOnSelect, docked = false, ariaLabel = '切换 VPS 执行端' }) {
    const id = React.useId();
    const button = React.useRef(null);
    const palette = React.useRef(null);
    const openingIndex = React.useRef(0);
    const optionPositions = React.useRef(new Map());
    const [open, setOpen] = React.useState(false);
    const current = tools.find((tool) => tool.id === value);
    const options = docked && current ? [current, ...tools.filter((tool) => tool !== current)] : tools;
    const selected = options.indexOf(current);

    function focusOption(index) {
      palette.current.children[index + 1]?.focus({ preventScroll: true });
    }

    function closePalette(restoreFocus, instant = false) {
      const panel = palette.current;
      if (instant) {
        panel.dataset.instantClose = '';
        panel.inert = true;
      }
      if (panel.matches(':popover-open')) panel.hidePopover();
      if (restoreFocus) button.current.focus({ preventScroll: true });
    }

    function openPalette(index = Math.max(0, selected)) {
      const panel = palette.current;
      if (disabled || !active || options.length === 0 || panel.matches(':popover-open')) return;
      delete panel.dataset.instantClose;
      openingIndex.current = Math.max(0, selected);
      positionPalette(panel, button.current, tools.length, openingIndex.current, docked);
      panel.inert = false;
      panel.showPopover({ source: button.current });
      setOpen(true);
      focusOption(index);
    }

    React.useLayoutEffect(() => {
      const panel = palette.current;
      const toggle = () => {
        const visible = panel.matches(':popover-open');
        panel.inert = !visible;
        setOpen(visible);
      };
      panel.addEventListener('toggle', toggle);
      return () => panel.removeEventListener('toggle', toggle);
    }, []);

    React.useLayoutEffect(() => {
      if (!active) closePalette(false);
    }, [active]);

    React.useLayoutEffect(() => {
      if (!open) return undefined;
      const panel = palette.current;
      const anchor = button.current;
      const update = () => positionPalette(panel, anchor, tools.length, openingIndex.current, docked);
      const observer = new ResizeObserver(update);
      observer.observe(anchor.closest(docked ? '.vc-sidebar-actions' : '.vc-header'));
      window.addEventListener('resize', update);
      return () => {
        window.removeEventListener('resize', update);
        observer.disconnect();
      };
    }, [open, tools.length, docked]);

    React.useLayoutEffect(() => {
      if (docked && open && selected >= 0 && palette.current.matches(':popover-open')) focusOption(selected);
    }, [docked, open, value, selected]);

    React.useLayoutEffect(() => {
      const panel = palette.current;
      const previous = optionPositions.current;
      const next = new Map();
      if (docked && open && panel.matches(':popover-open')) {
        const { length } = options;
        const motion = getComputedStyle(panel);
        const duration = Number.parseFloat(motion.getPropertyValue('--vc-popup-duration'));
        const easing = motion.getPropertyValue('--vc-motion-curve').trim() || 'ease-out';
        for (let index = 0; index < length; index++) {
          const option = panel.children[index + 1];
          const left = option.offsetLeft;
          const before = previous.get(option);
          const inMotion = before?.animation?.playState === 'running';
          const offset = inMotion ? Number.parseFloat(getComputedStyle(option).translate) || 0 : 0;
          before?.animation?.cancel();
          const distance = before ? before.left - left + offset : 0;
          const animation = duration > 0 && Math.abs(distance) >= 1
            ? option.animate([{ translate: `${distance}px` }, { translate: '0px' }], { duration, easing })
            : null;
          next.set(option, { left, animation });
        }
      }
      for (const [option, { animation }] of previous) {
        if (!next.has(option)) animation?.cancel();
      }
      optionPositions.current = next;
    }, [docked, open, value, options.length]);

    function onPaletteKey(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
      if (event.key === 'Tab') {
        closePalette(true);
        return;
      }
      const index = Number(event.target.dataset.index ?? selected);
      const steps = {
        ArrowRight: (index + 1) % tools.length, ArrowLeft: (index - 1 + tools.length) % tools.length,
        Home: 0, End: tools.length - 1,
      };
      if (event.key !== 'Escape' && !Object.hasOwn(steps, event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') closePalette(true);
      else focusOption(steps[event.key]);
    }

    const icon = menuIcon(h, current?.icon ?? 'model');
    return h('span', { className: 'vc-tool-picker' },
      h('button', {
        ref: button, type: 'button', className: 'vc-tool-trigger',
        'aria-label': ariaLabel, 'aria-description': current?.label ?? '请选择执行端',
        'aria-controls': id, 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-disabled': disabled,
        'data-provider': current?.id ?? '', title: current?.label ?? '选择执行端',
        onClick: () => openPalette(),
        onKeyDown: (event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || disabled) return;
          event.preventDefault();
          openPalette(selected < 0 && event.key === 'ArrowLeft' ? tools.length - 1 : Math.max(0, selected));
        },
      }, docked ? h(React.Fragment, null,
        h('span', { className: 'vc-tool-badge' }, icon),
        h('span', { className: 'vc-tool-label' }, current?.label ?? '选择执行端'),
        h('span', { className: 'vc-tool-caret', 'aria-hidden': true })) : icon),
      h('div', {
        ref: palette, id, popover: 'auto', className: 'vc-tool-palette', role: 'listbox',
        'aria-label': '已配置的 VPS 执行端', 'aria-orientation': 'horizontal', onKeyDown: onPaletteKey,
        'data-docked': docked, 'data-selected': selected >= 0, style: { '--vc-selected-index': Math.max(0, selected) },
      },
      h('span', { className: 'vc-tool-highlight', 'aria-hidden': true }),
      options.map((tool, index) => h('button', {
        key: tool.id, type: 'button', role: 'option', tabIndex: -1, className: 'vc-tool-option',
        'aria-label': tool.label, 'aria-selected': index === selected, 'aria-disabled': disabled,
        'data-index': index, 'data-tool-theme': tool.id, title: tool.label,
        onClick: (event) => {
          if (disabled) return;
          if (index === selected) {
            if (docked) closePalette(true);
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          const origin = event.detail > 0 ? { x: event.clientX, y: event.clientY } :
            { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
          if (closeOnSelect?.(tool.id)) closePalette(true, true);
          select(tool.id, origin);
        },
      }, menuIcon(h, tool.icon)))));
  };
}

export const providerPickerCss = `
  [data-vps-chat] .vc-tool-picker {
    display:inline-flex; flex:none; inline-size:30px;
    transition:inline-size var(--vc-popup-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-tool-picker:has(.vc-tool-palette:popover-open) {inline-size:var(--vc-tool-reserved,30px)}
  [data-vps-chat] .vc-tool-trigger {
    display:grid; place-items:center; flex:none; width:30px; height:30px; padding:0;
    color:var(--vc-accent); background:transparent; border:0; border-radius:50%;
    transition:background-color var(--vc-control-duration) ease;
  }
  [data-vps-chat] .vc-tool-trigger:hover:not([aria-disabled=true]) {background:var(--vc-tint)}
  [data-vps-chat] .vc-tool-palette {
    --vc-tool-slot:40px;
    position:fixed; inset:var(--vc-tool-top,0) auto auto var(--vc-tool-left,0); margin:0; padding:4px;
    height:42px; width:max-content; max-width:none; grid-auto-flow:column; grid-auto-columns:var(--vc-tool-slot);
    align-items:center; isolation:isolate; overflow:visible;
    border:1px solid var(--vc-line); border-radius:999px; background:var(--vc-surface);
    color:var(--vc-ink); box-shadow:var(--vc-shadow);
    clip-path:inset(0 var(--vc-reveal-end,0px) 0 var(--vc-reveal-start,0px) round 999px);
    opacity:0; pointer-events:none;
    transition:clip-path var(--vc-popup-duration) var(--vc-motion-curve),
      opacity var(--vc-popup-duration) var(--vc-motion-curve),
      left var(--vc-popup-duration) var(--vc-motion-curve), top var(--vc-popup-duration) var(--vc-motion-curve),
      display var(--vc-popup-duration), overlay var(--vc-popup-duration);
    transition-behavior:allow-discrete;
  }
  [data-vps-chat] .vc-tool-palette:popover-open {
    display:grid; opacity:1; pointer-events:auto; clip-path:inset(-18px round 999px);
  }
  [data-vps-chat] .vc-tool-palette[data-instant-close] {transition:none; display:none}
  @starting-style {
    [data-vps-chat] .vc-tool-palette:popover-open {
      clip-path:inset(0 var(--vc-reveal-end,0px) 0 var(--vc-reveal-start,0px) round 999px); opacity:0;
    }
  }
  [data-vps-chat] .vc-tool-highlight {
    position:absolute; inset:4px auto 4px 6px; z-index:-1;
    width:calc(var(--vc-tool-slot) - 4px); border-radius:999px; background:var(--vc-accent);
    transform:translateX(calc(var(--vc-selected-index) * var(--vc-tool-slot)));
    transition:transform var(--vc-popup-duration) var(--vc-motion-curve),
      opacity var(--vc-popup-duration) var(--vc-motion-curve),
      background-color var(--vc-popup-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-tool-palette[data-selected=false] .vc-tool-highlight {opacity:0}
  [data-vps-chat] .vc-tool-option {
    place-self:stretch; display:grid; place-items:center; min-width:0; padding:0; position:relative;
    border:0; border-radius:999px; background:transparent; color:var(--vc-accent);
    transition:color var(--vc-control-duration) ease, background-color var(--vc-control-duration) ease;
  }
  [data-vps-chat] .vc-tool-palette[data-docked=true] .vc-tool-highlight {display:none}
  [data-vps-chat] .vc-tool-palette[data-docked=true] .vc-tool-option[aria-selected=true] {
    z-index:1; isolation:isolate;
  }
  [data-vps-chat] .vc-tool-palette[data-docked=true] .vc-tool-option[aria-selected=true]::before {
    content:''; position:absolute; inset:0 2px; z-index:-1; border-radius:inherit; background:var(--vc-accent);
  }
  [data-vps-chat] .vc-tool-palette[data-inline-rail] .vc-tool-option .vc-tool-icon {width:24px; height:24px}
  [data-vps-chat] .vc-tool-option[aria-disabled=true] {opacity:1}
  [data-vps-chat] .vc-tool-option:hover:not([aria-selected=true],[aria-disabled=true]) {background:var(--vc-tint)}
  [data-vps-chat] .vc-tool-option[aria-selected=true] {color:var(--vc-on-accent)}
  [data-vps-chat] .vc-tool-option:focus-visible {outline-offset:-2px}
  [data-vps-chat] .vc-tool-option[aria-selected=true]:focus-visible {outline-color:var(--vc-on-accent)}
`;

