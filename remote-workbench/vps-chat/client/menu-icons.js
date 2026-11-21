// Product artwork from the installed Codex, Claude and Antigravity applications.
import antigravityLogo from './icons/antigravity.png';
import codexLogo from './icons/codex.png';
import claudeLogo from './icons/claude.png';

const productLogos = {
  antigravity: antigravityLogo, codex: codexLogo, 'claude-sdk': claudeLogo, 'claude-code': claudeLogo,
};
const controlPaths = {
  'new-chat': 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m-1 8 1-4 7-7a2 2 0 0 1 3 3l-7 7-4 1Z',
  settings: 'M10 3h4l.5 2.5 2 .9 2.3-1L21 9l-2 1.6v2.8l2 1.6-2.2 3.6-2.3-1-2 .9L14 21h-4l-.5-2.5-2-.9-2.3 1L3 15l2-1.6v-2.8L3 9l2.2-3.6 2.3 1 2-.9L10 3Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  library: 'M4 19V6m5 13V6m5 13V6m6 13-3-13M3 21h18',
  access: 'M12 3 4 6v5c0 4.6 3 7.7 8 10 5-2.3 8-5.4 8-10V6l-8-3Z M9 12l2 2 4-4',
  pin: 'm9 3 12 12-3 1-4 1-2 4-9-9 4-2 1-4 1-3Zm-.5 13-5 5',
  unpin: 'm3 3 18 18M9 7l1-4 11 11-4 1m-4 4-1 2-9-9 4-2m1.5 6-5 5',
  rename: 'M4 16v4h4L20 8l-4-4L4 16Zm10-10 4 4',
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  archive: 'M4 8h16v12H4zM3 4h18v4H3zM10 12h4',
  restore: 'M4 12v8h16v-8M3 8V4h18v4M12 17V8m-3 3 3-3 3 3',
  undo: 'm8 5-5 5 5 5M3 10h11a6 6 0 0 1 6 6v2',
  redo: 'm16 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v2',
  cut: 'M7 10a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0 10a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm2-5L20 4M9 9l11 11',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  paste: 'M9 5H5v16h14V5h-4M9 3h6v5H9zM8 12h8m-8 4h5',
  'select-all': 'M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 9h8m-8 3h8m-8 3h6',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  download: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',
  play: 'M8 5l12 7-12 7Z',
  link: 'm10 13 4-4m-5 7-2 2a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2-1 2-2a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0',
  fork: 'M6 8v8m0-5h7a5 5 0 0 0 5-5m-2 0 2-2 2 2M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  variants: 'M10 4h10v10H10zM6 8H4v12h12v-2',
  fit: 'M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 8h8v8H8Z',
  'zoom-in': 'M15.5 15.5 21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-10 0h6m-3-3v6',
  'zoom-out': 'M15.5 15.5 21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-10 0h6',
  chevron: 'm9 6 6 6-6 6',
};

export function menuIcon(h, name) {
  if (Object.hasOwn(productLogos, name)) {
    return h('span', { className: 'vc-menu-icon vc-tool-icon', 'data-icon': name, 'aria-hidden': true },
      h('img', { src: productLogos[name], alt: '', draggable: false }));
  }
  if (Object.hasOwn(controlPaths, name)) {
    return h('span', { className: 'vc-menu-icon', 'data-icon': name, 'aria-hidden': true },
      h('svg', { viewBox: '0 0 24 24', width: '100%', height: '100%', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', focusable: 'false' },
      h('path', { d: controlPaths[name] })));
  }
  return h('span', { className: 'vc-menu-icon', 'data-icon': name, 'aria-hidden': true });
}

export const menuIconsCss = `
  [data-vps-chat] .vc-menu-label {display:inline-flex; align-items:center; gap:8px; min-width:0}
  [data-vps-chat] .vc-menu-icon {position:relative; display:inline-block; width:16px; height:16px; flex:none}
  [data-vps-chat] .vc-menu-icon::before,
  [data-vps-chat] .vc-menu-icon::after {content:''; position:absolute; box-sizing:border-box}
  [data-vps-chat] .vc-menu-icon[data-icon=chat]::before {
    inset:2px 1px 3px; border:1.5px solid currentColor; border-radius:4px 4px 4px 1px;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=chat]::after {
    width:4px; height:3px; left:3px; bottom:1px; border-inline-start:1.5px solid currentColor; transform:skewY(-35deg);
  }
  [data-vps-chat] .vc-menu-icon[data-icon=canvas]::before,
  [data-vps-chat] .vc-menu-icon[data-icon=image]::before {
    inset:2px 1px; border:1.5px solid currentColor; border-radius:3px;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=canvas]::after {
    inset:3px 3px 5px 5px; border-block-end:1px solid currentColor; border-inline-start:1px solid currentColor;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=image]::before {
    background:radial-gradient(circle at 3px 3px,currentColor 1px,transparent 1.5px);
  }
  [data-vps-chat] .vc-menu-icon[data-icon=image]::after {
    bottom:4px; left:6px; width:6px; height:5px; border-width:1.3px 0 0 1.3px;
    border-style:solid; transform:rotate(45deg);
  }
  [data-vps-chat] .vc-menu-icon[data-icon=file]::before {
    inset:1px 3px; border:1.5px solid currentColor; border-radius:2px;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=file]::after {
    inset:6px 5px 5px; border-block:1px solid currentColor;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=attachment]::before {
    inset:0 4px; border:1.5px solid currentColor; border-radius:5px; transform:rotate(38deg);
  }
  [data-vps-chat] .vc-menu-icon[data-icon=attachment]::after {
    inset:3px 6px 4px; border:1px solid currentColor; border-block-start:0; border-radius:0 0 3px 3px; transform:rotate(38deg);
  }
  [data-vps-chat] .vc-menu-icon[data-icon=model]::before {
    inset:2px; border:1.5px solid currentColor; border-radius:3px;
    background:radial-gradient(circle,currentColor 1.25px,transparent 1.75px);
  }
  [data-vps-chat] .vc-tool-icon {width:18px; height:18px}
  [data-vps-chat] .vc-tool-icon img {display:block; width:100%; height:100%; object-fit:contain}
  [data-vps-chat] .vc-tool-icon[data-icon=claude-code]::after {
    content:'›_'; inset:auto -2px -1px auto; width:11px; height:9px;
    border:1px solid var(--vc-line); border-radius:3px; background:var(--vc-surface);
    color:var(--vc-accent); font:700 7px/7px ui-monospace,monospace; text-align:center;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=key] {rotate:-39deg}
  [data-vps-chat] .vc-menu-icon[data-icon=key]::before {
    width:7px; height:7px; left:0; top:4px; border:1.5px solid currentColor; border-radius:50%;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=key]::after {
    inset:6.5px 0 4px 6px; border-top:1.5px solid currentColor; border-right:1.5px solid currentColor;
    background:linear-gradient(currentColor,currentColor) 65% 0 / 1.5px 2px no-repeat;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=effort]::before {
    inset:3px 1px; border-block:1.5px solid currentColor;
    background:linear-gradient(currentColor,currentColor) center / 100% 1px no-repeat;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=effort]::after {
    top:2px; left:4px; width:2px; height:3px; background:currentColor; box-shadow:5px 5px currentColor,1px 10px currentColor;
  }
  [data-vps-chat] .vc-menu-icon[data-icon=context]::before {
    inset:2px; border:1.5px solid currentColor; border-inline-end-color:transparent; border-radius:50%; transform:rotate(-30deg);
  }
  [data-vps-chat] .vc-menu-icon[data-icon=check]::before {
    inset:1px 5px 4px; border:solid var(--vc-accent); border-width:0 1.5px 1.5px 0; transform:rotate(45deg);
  }
`;
