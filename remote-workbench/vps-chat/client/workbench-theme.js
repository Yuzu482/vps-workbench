import { composerControlsCss } from './composer-controls.js';
import { menuIconsCss } from './menu-icons.js';
import { menuMotionCss } from './menu-motion.js';
import { accentOptions } from './workbench-preferences.js';

const darkTheme = ':is(.dark,[data-theme=dark],[data-ds-dark-theme])';
const darkWorkbench = `:is([data-vps-chat][data-vc-color=dark],${darkTheme} [data-vps-chat]:not([data-vc-color=light]))`;
const accentOverride = '[data-vc-accent]:not([data-vc-accent=tool])';

const toolPalettes = {
  codex: { light: '#434e99', dark: '#b2bfff', darkInk: '#24294c' },
  claude: { light: '#216656', dark: '#8cd9bf', darkInk: '#14342c' },
  'claude-sdk': { light: '#99492f', dark: '#f1ac91', darkInk: '#3f241a' },
  'claude-subscription': { light: '#82541d', dark: '#eac084', darkInk: '#382814' },
  antigravity: { light: '#2867b5', dark: '#9bc7ff', darkInk: '#182d4c' },
};

const toolTheme = `
  ${Object.entries(toolPalettes).map(([id, palette]) => `
    :is([data-vps-chat][data-tool-theme="${id}"],[data-vps-chat] [data-tool-theme="${id}"]) {
      --vc-tool-light:${palette.light};
      --vc-tool-dark:${palette.dark};
      --vc-tool-dark-ink:${palette.darkInk};
    }
  `).join('')}
  :is([data-vps-chat][data-tool-theme],[data-vps-chat] [data-tool-theme]) {
    --vc-accent:var(--vc-tool-light);
    --vc-on-accent:#fffdf9;
    --vc-tone-strength:12%;
    --vc-tint:color-mix(in srgb,var(--vc-accent) var(--vc-tone-strength),var(--vc-surface));
  }
  :is(${darkWorkbench}[data-tool-theme],${darkWorkbench} [data-tool-theme]) {
    --vc-accent:var(--vc-tool-dark);
    --vc-on-accent:var(--vc-tool-dark-ink);
    --vc-tone-strength:20%;
  }
  ${accentOptions.filter(({ light }) => light).map(({ id, light, dark, ink }) => `
    [data-vps-chat][data-vc-accent="${id}"] {
      --vc-custom-light:${light}; --vc-custom-dark:${dark}; --vc-custom-ink:${ink};
    }
  `).join('')}
  [data-vps-chat]${accentOverride} {
    --vc-accent:var(--vc-custom-light);
    --vc-on-accent:#fffdf9;
    --vc-tone-strength:12%;
    --vc-tint:color-mix(in srgb,var(--vc-accent) var(--vc-tone-strength),var(--vc-surface));
  }
  ${darkWorkbench}${accentOverride} {
    --vc-accent:var(--vc-custom-dark);
    --vc-on-accent:var(--vc-custom-ink);
    --vc-tone-strength:20%;
  }
  [data-vps-chat]:is([data-tool-theme],${accentOverride}) {
    --vc-canvas:color-mix(in srgb,var(--vc-accent) 5%,var(--vc-base-canvas));
    --vc-rail:color-mix(in srgb,var(--vc-accent) 8%,var(--vc-base-rail));
    --vc-surface:color-mix(in srgb,var(--vc-accent) 3%,var(--vc-base-surface));
    --vc-line:color-mix(in srgb,var(--vc-accent) 16%,var(--vc-rail));
    --vc-line-strong:color-mix(in srgb,var(--vc-accent) 56%,var(--vc-surface));
    --vc-hover:color-mix(in srgb,var(--vc-accent) var(--vc-tone-strength),var(--vc-rail));
    --vc-bubble:color-mix(in srgb,var(--vc-accent) var(--vc-tone-strength),var(--vc-canvas));
    --vc-slider-fill:var(--vc-accent);
    --vc-slider-track:var(--vc-tint);
    --vc-slider-step-used:var(--vc-on-accent);
  }
`;

const paletteCss = `
    [data-vps-chat] {
      --vc-base-canvas:#f8f5ef;
      --vc-base-rail:#eee9e1;
      --vc-base-surface:#fffdf9;
      --vc-canvas:var(--vc-base-canvas);
      --vc-rail:var(--vc-base-rail);
      --vc-surface:var(--vc-base-surface);
      --vc-ink:#2e2824;
      --vc-muted:#6b6056;
      --vc-line:#e0d7cc;
      --vc-line-strong:#9d8879;
      --vc-tint:#f3e3d9;
      --vc-hover:#ede5db;
      --vc-bubble:#efe7dd;
      --vc-accent:#884730;
      --vc-on-accent:#fffdf9;
      --vc-warn:#823a1f;
      --vc-warn-bg:#f8e5d7;
      --vc-stage:#ebe4da;
      --vc-stage-dot:#d1c4b6;
      --vc-overlay:#2d211bb0;
      --vc-shadow:0 10px 28px #462c2426;
      --vc-card-shadow:0 2px 4px #462c2410, 0 8px 22px #462c240a;
      --vc-slider-track:#e6d8ce;
      --vc-slider-fill:#a86245;
      --vc-slider-step:#716158;
      --vc-slider-step-used:#f7e7df;
      --vc-slider-thumb:#fffdf9;
      --vc-slider-thumb-shadow:0 1px 4px #4d2a2350;
      --vc-title-font:Georgia,'Noto Serif CJK SC','Songti SC','SimSun',serif;
      --vc-gutter:clamp(16px,4cqi,44px);
      --vc-header-height:60px;
      color-scheme:light;
    }
    ${darkWorkbench} {
      color-scheme:dark;
      --vc-base-canvas:#25211e;
      --vc-base-rail:#201c19;
      --vc-base-surface:#2e2824;
      --vc-ink:#f3eadd;
      --vc-muted:#c4b5a6;
      --vc-line:#49403a;
      --vc-line-strong:#957e6f;
      --vc-tint:#473229;
      --vc-hover:#3b322c;
      --vc-bubble:#38302a;
      --vc-accent:#eba98d;
      --vc-on-accent:#2a1c15;
      --vc-warn:#f5bb94;
      --vc-warn-bg:#493025;
      --vc-stage:#1f1b18;
      --vc-stage-dot:#463c34;
      --vc-shadow:0 10px 28px #0f0b08a0;
      --vc-card-shadow:0 4px 14px #0f0b0865;
      --vc-slider-track:#4b4038;
      --vc-slider-fill:#c7896e;
      --vc-slider-step:#b3a294;
      --vc-slider-step-used:#4a3025;
      --vc-slider-thumb:#fdebe0;
      --vc-slider-thumb-shadow:0 1px 4px #0f0b08a0;
    }
    ${toolTheme}
`;

export function workbenchPaletteCss(scope = '[data-vps-chat]') {
  return paletteCss.replaceAll('[data-vps-chat]', scope);
}

export function workbenchCss(separatorWidth) {
  return `
    ${workbenchPaletteCss()}
    [data-vps-chat] {
      --vc-chat-font-size:14px;
      --vc-thread-measure:816px;
      --vc-composer-measure:728px;
      box-sizing:border-box; position:relative; display:grid; grid-template-columns:216px minmax(0,1fr);
      grid-template-rows:minmax(0,1fr); container-type:inline-size; isolation:isolate;
      flex:1; width:100%; height:100%; min-width:0; min-height:0; overflow:hidden;
      color:var(--vc-ink); background:var(--vc-canvas);
      font:14px/1.55 'Segoe UI Variable','Segoe UI','Microsoft YaHei UI','PingFang SC','Noto Sans CJK SC',system-ui,sans-serif;
    }
    [data-vps-chat][data-subscription-open=true] > .vc-main {grid-column:1 / -1}
    [data-vps-chat][data-vc-text-size=large] {--vc-chat-font-size:16px}
    [data-vps-chat][data-vc-text-size=largest] {--vc-chat-font-size:18px}
    [data-vps-chat][data-vc-width=wide] {--vc-thread-measure:1080px; --vc-composer-measure:960px}
    [data-vps-chat] *, [data-vps-chat] *::before, [data-vps-chat] *::after {box-sizing:border-box}
    [data-vps-chat] :is(button,input,select,textarea) {font:inherit; color:inherit}
    [data-vps-chat] button {cursor:pointer}
    [data-vps-chat] button:is(:disabled,[aria-disabled=true]) {cursor:default; opacity:.55}
    [data-vps-chat] :focus-visible {outline:2px solid var(--vc-accent); outline-offset:2px}
    [data-vps-chat] :is(.vc-rail,.vc-scroll,.vc-canvas):focus-visible {outline-offset:-2px}
    [data-vps-chat] .vc-button {
      min-height:32px; border:1px solid transparent; border-radius:8px;
      padding:5px 10px; background:transparent; white-space:nowrap; font-weight:600;
    }
    [data-vps-chat] .vc-button:hover:not(:disabled,[aria-disabled=true]) {background:var(--vc-hover)}
    [data-vps-chat] .vc-primary {
      background:var(--vc-accent); border-color:var(--vc-accent); color:var(--vc-on-accent);
    }
    [data-vps-chat] .vc-primary:hover:not(:disabled) {background:var(--vc-accent); filter:brightness(.92)}
    [data-vps-chat] .vc-rail {
      display:flex; flex-direction:column; gap:14px; min-height:0; padding:18px 12px 14px;
      background:var(--vc-rail); border-right:1px solid var(--vc-line);
    }
    [data-vps-chat] .vc-rail-label {font-size:12px; font-weight:650; letter-spacing:.025em; color:var(--vc-muted); padding:0 6px}
    [data-vps-chat] .vc-new-actions {display:grid; gap:7px; padding-bottom:14px; border-bottom:1px solid var(--vc-line)}
    [data-vps-chat] .vc-new {width:100%; min-height:36px; text-align:left}
    [data-vps-chat] .vc-new-design {background:transparent; color:var(--vc-accent)}
    [data-vps-chat] .vc-list {min-height:0; overflow:auto; display:grid; align-content:start; gap:3px; flex:1}
    [data-vps-chat] .vc-list p {margin:4px 6px; font-size:13px; color:var(--vc-muted)}
    [data-vps-chat] .vc-session {
      display:flex; align-items:center; gap:8px; min-width:0; width:100%; max-width:100%;
      white-space:nowrap; padding:8px 10px; border:0; border-radius:8px; background:transparent; text-align:left;
    }
    [data-vps-chat] .vc-session-title {min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis}
    [data-vps-chat] .vc-session-mode {color:var(--vc-accent); font-size:12px}
    [data-vps-chat] .vc-session:hover {background:var(--vc-hover)}
    [data-vps-chat] .vc-session[aria-current=true] {background:var(--vc-tint); color:var(--vc-accent); font-weight:650}
    [data-vps-chat] .vc-main {display:flex; flex-direction:column; min-height:0; min-width:0}
    [data-vps-chat] .vc-main-body {display:flex; flex:1; min-height:0; min-width:0}
    [data-vps-chat] .vc-conversation {display:flex; flex-direction:column; flex:1; min-height:0; min-width:0}
    [data-vps-chat] .vc-design-surface {
      position:relative; isolation:isolate; display:flex; flex:1; min-height:0; min-width:0; container-type:size;
    }
    [data-vps-chat] .vc-canvas-conversation {
      --vc-dock-inset:clamp(8px,1.5cqi,18px);
      position:absolute; z-index:3;
      inset:auto var(--vc-dock-inset) var(--vc-dock-inset);
      max-inline-size:min(640px,var(--vc-composer-measure));
      max-block-size:calc(100% - 2 * var(--vc-dock-inset));
      margin-inline:auto; pointer-events:none;
    }
    [data-vps-chat] .vc-canvas-conversation .vc-compose-area {padding:0; min-block-size:0}
    [data-vps-chat] .vc-canvas-conversation :is(.vc-composer,.vc-feedback) {pointer-events:auto}
    [data-vps-chat] .vc-canvas-history {min-block-size:0}
    [data-vps-chat] .vc-canvas-history > .vc-disclosure-clip {display:flex; flex-direction:column}
    [data-vps-chat] .vc-canvas-history .vc-scroll {
      flex:0 1 auto; max-block-size:min(320px,40vh); margin-block-end:8px; scrollbar-width:thin;
      border:1px solid var(--vc-line); border-radius:14px; background:var(--vc-surface);
    }
    [data-vps-chat] .vc-canvas-history[data-expanded=true] .vc-scroll {pointer-events:auto}
    [data-vps-chat] .vc-canvas-history .vc-body {padding:16px clamp(12px,3cqi,24px)}
    [data-vps-chat] .vc-canvas-history .vc-turn:last-child {margin-block-end:0}
    [data-vps-chat] .vc-canvas-history .vc-welcome {margin-block-start:4px}
    [data-vps-chat] .vc-playground-back {flex:none; white-space:nowrap}
    @container (max-width:520px) {
      [data-vps-chat] .vc-canvas-conversation [data-control=history] .vc-option-label {display:none}
      [data-vps-chat] .vc-canvas-conversation .vc-composer-toolbar {flex-wrap:wrap}
      [data-vps-chat] .vc-canvas-conversation .vc-composer-tools {min-width:0; flex-wrap:wrap}
    }
    @container (max-width:400px) {
      [data-vps-chat] .vc-canvas-conversation .vc-composer-option:not([data-control=model]) .vc-option-label {display:none}
      [data-vps-chat] .vc-canvas-conversation .vc-composer-option {padding-inline:4px; min-height:30px}
      [data-vps-chat] .vc-canvas-conversation .vc-composer-materials {width:26px}
      [data-vps-chat] .vc-canvas-conversation .vc-composer-tools {gap:2px}
      [data-vps-chat] .vc-canvas-conversation .vc-context-indicator {width:22px; height:30px}
      [data-vps-chat] .vc-canvas-conversation .vc-context-note:not([data-error=true]) {
        flex-wrap:nowrap; overflow-x:auto; scrollbar-width:thin; white-space:nowrap;
      }
      [data-vps-chat] .vc-canvas-conversation .vc-context-note:not([data-error=true]) > * {flex:none}
    }
    @media (max-height:600px) {
      [data-vps-chat] .vc-canvas-conversation .vc-compose-area {
        max-block-size:max(0px,100cqh - 2 * var(--vc-dock-inset));
        overflow:auto; scrollbar-width:thin; overscroll-behavior:contain;
      }
      [data-vps-chat] .vc-canvas-conversation .vc-composer {padding:7px 9px; gap:3px}
      [data-vps-chat] .vc-canvas-conversation .vc-composer textarea {min-height:32px; max-height:90px}
      [data-vps-chat] .vc-canvas-conversation .vc-compose-hint {
        position:absolute; width:1px; height:1px; margin:0; overflow:hidden; clip-path:inset(50%);
      }
    }
    [data-vps-chat] .vc-main-body[data-design=true][data-pane=split] {--vc-gutter:clamp(16px,2cqi,28px)}
    [data-vps-chat] .vc-main-body[data-design=true][data-pane=split] .vc-conversation {
      flex:0 0 var(--vc-thread-width,40%);
    }
    [data-vps-chat] .vc-main-body[data-design=true][data-pane=canvas] > .vc-conversation,
    [data-vps-chat] .vc-main-body[data-design=true][data-pane=chat] > .vc-canvas {display:none}
    [data-vps-chat] .vc-splitter {
      flex:0 0 ${separatorWidth}px; position:relative; min-width:0; border:0; background:var(--vc-surface);
      touch-action:none; cursor:col-resize;
    }
    [data-vps-chat] .vc-splitter::before {
      position:absolute; inset:0 calc(50% - .5px); width:1px; background:var(--vc-line); content:'';
    }
    [data-vps-chat] .vc-splitter::after {
      position:absolute; top:calc(50% - 12px); left:calc(50% - 1.5px); height:24px; width:3px;
      border-radius:2px; background:var(--vc-line-strong); content:'';
    }
    [data-vps-chat] .vc-splitter:is(:hover,:focus-visible)::before,
    [data-vps-chat][data-resizing=true] .vc-splitter::before,
    [data-vps-chat] .vc-splitter:is(:hover,:focus-visible)::after,
    [data-vps-chat][data-resizing=true] .vc-splitter::after {background:var(--vc-accent)}
    [data-vps-chat] .vc-splitter:focus-visible {outline-offset:-2px}
    [data-vps-chat][data-resizing=true] {user-select:none}
    [data-vps-chat][data-resizing=true] .vc-canvas-frame {pointer-events:none}
    [data-vps-chat] .vc-canvas {
      display:flex; flex-direction:column; flex:1; min-height:0; min-width:0;
      background:var(--vc-surface);
    }
    [data-vps-chat] .vc-canvas-header {
      display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:7px 12px;
      padding:9px 13px; border-bottom:1px solid var(--vc-line);
    }
    [data-vps-chat] .vc-canvas-header h2 {margin:0; font-size:15px; font-weight:700}
    [data-vps-chat] .vc-canvas-actions {display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:12px}
    [data-vps-chat] .vc-canvas-actions select {
      min-width:90px; max-width:100%; min-height:31px; padding:4px 7px; border:1px solid var(--vc-line); border-radius:6px;
      background:var(--vc-surface);
    }
    [data-vps-chat] .vc-canvas-actions button {padding:5px 8px; min-height:31px}
    [data-vps-chat] .vc-segments {
      display:flex; flex:none; gap:2px; padding:2px; border:1px solid var(--vc-line);
      border-radius:8px; background:var(--vc-hover);
    }
    [data-vps-chat] .vc-segments .vc-button {min-height:26px; border:0; padding:3px 8px; border-radius:5px; background:transparent}
    [data-vps-chat] .vc-segments .vc-button:hover:not(:disabled) {background:var(--vc-surface)}
    [data-vps-chat] .vc-segments .vc-button[aria-pressed=true] {background:var(--vc-tint); color:var(--vc-accent)}
    [data-vps-chat] .vc-view-kind {align-self:center; padding-inline:6px 4px; color:var(--vc-muted); font-size:11px}
    [data-vps-chat] .vc-design-panes {font-size:12px}
    [data-vps-chat] .vc-canvas-stage {
      display:flex; justify-content:center; flex:1; min-width:0; min-height:0; padding:clamp(12px,2.3cqi,27px);
      overflow:auto; background-color:var(--vc-stage);
      background-image:radial-gradient(var(--vc-stage-dot) .7px,transparent .7px); background-size:18px 18px;
    }
    [data-vps-chat] .vc-canvas-viewport {
      flex:none; max-width:100%; height:100%; background:var(--vc-surface); overflow:hidden;
      border-radius:7px; box-shadow:0 0 0 1px var(--vc-line-strong),var(--vc-shadow);
    }
    [data-vps-chat] .vc-canvas-frame {
      display:block; max-width:none; border:0; transform-origin:top left; background:#fff;
    }
    [data-vps-chat] .vc-canvas-empty {
      align-self:center; min-width:0; max-width:320px; padding:20px 24px; text-align:center; color:var(--vc-muted);
      border:1px solid var(--vc-line); border-radius:10px; background:var(--vc-surface);
    }
    [data-vps-chat] .vc-canvas-empty strong {font-size:16px; color:var(--vc-ink)}
    [data-vps-chat] .vc-canvas-empty p {margin:6px 0 0}
    [data-vps-chat] .vc-header {
      display:flex; align-items:center; gap:10px; flex:none; min-height:var(--vc-header-height);
      padding:8px clamp(12px,2cqi,25px); background:var(--vc-canvas);
      border-bottom:1px solid var(--vc-line); min-width:0;
    }
    [data-vps-chat] .vc-heading {flex:1; min-width:0}
    [data-vps-chat] .vc-heading :is(strong,h1) {
      display:block; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:inherit; font-weight:650;
    }
    [data-vps-chat] .vc-header-settings {flex:none}
    [data-vps-chat] .vc-route {
      display:flex; align-items:center; gap:6px; color:var(--vc-muted); font-size:12px; overflow-wrap:anywhere;
    }
    [data-vps-chat] .vc-route-status {
      position:relative; min-width:0; padding-inline-start:10px;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    [data-vps-chat] .vc-route-status::before {
      content:''; position:absolute; inset:calc(50% - 3px) auto auto 0;
      width:6px; height:6px; background:currentColor; border-radius:50%;
    }
    [data-vps-chat] .vc-route[data-ready=true] .vc-route-status::before {background:var(--vc-accent)}
    [data-vps-chat] .vc-history-toggle {display:none}
    [data-vps-chat] .vc-scroll {flex:1; min-height:0; overflow:auto; overscroll-behavior:contain}
    [data-vps-chat] .vc-body {max-width:var(--vc-thread-measure); margin:auto; padding:29px var(--vc-gutter)}
    [data-vps-chat] .vc-welcome {max-width:484px; margin:clamp(12px,10vh,100px) auto 0; text-align:center}
    [data-vps-chat] .vc-welcome > :is(h1,h2) {
      margin:0 0 11px; font-family:var(--vc-title-font); font-size:clamp(22px,3.1cqi,32px); line-height:1.25;
      font-weight:600; letter-spacing:-.012em;
      text-wrap:balance;
    }
    [data-vps-chat] .vc-welcome p {margin:0 0 18px; color:var(--vc-muted)}
    [data-vps-chat] .vc-example {font-size:13px; color:var(--vc-accent); background:var(--vc-surface); border-color:var(--vc-line)}
    [data-vps-chat] .vc-turn {display:grid; gap:15px; margin:0 0 29px; min-width:0}
    [data-vps-chat] .vc-user {
      min-width:0; justify-self:end; max-width:min(86%,640px); padding:10px 15px;
      border-radius:13px 13px 4px 13px; background:var(--vc-bubble);
    }
    [data-vps-chat] .vc-answer {
      display:grid; grid-template-columns:minmax(0,1fr); gap:8px; min-width:0; padding:4px 0 6px;
    }
    [data-vps-chat] .vc-answer-head {display:flex; align-items:center; flex-wrap:wrap; gap:5px 12px}
    [data-vps-chat] .vc-text {white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.7}
    [data-vps-chat] :is(.vc-text,.vc-markdown,.vc-composer textarea) {font-size:var(--vc-chat-font-size)}
    [data-vps-chat] .vc-answer-state {font-size:12px; color:var(--vc-muted)}
    [data-vps-chat] .vc-answer-state:is([data-state=unknown],[data-state=failed]) {color:var(--vc-warn)}
    [data-vps-chat] .vc-steering {
      justify-self:end; min-width:0; max-width:min(86%,640px); display:grid; gap:6px; list-style:none; margin:0; padding:0;
    }
    [data-vps-chat] .vc-steering li {padding:7px 11px; border-inline-start:2px solid var(--vc-accent); background:var(--vc-surface); border-radius:6px}
    [data-vps-chat] .vc-steer-state {font-size:12px; color:var(--vc-muted)}
    [data-vps-chat] .vc-steering li:is([data-state=unknown],[data-state=rejected]) .vc-steer-state {color:var(--vc-warn)}
    [data-vps-chat] .vc-approvals {display:grid; gap:8px; list-style:none; margin:0; padding:0; min-width:0}
    [data-vps-chat] .vc-approvals li {display:grid; gap:7px; padding:9px 11px; border:1px solid var(--vc-line);
      border-radius:8px; background:var(--vc-surface); min-width:0; overflow-wrap:anywhere}
    [data-vps-chat] .vc-approval-heading {display:flex; flex-wrap:wrap; gap:4px 10px; align-items:baseline; font-size:13px}
    [data-vps-chat] .vc-approval-state {font-size:12px; color:var(--vc-muted)}
    [data-vps-chat] .vc-approvals li[data-state=unknown] .vc-approval-state {color:var(--vc-warn)}
    [data-vps-chat] .vc-approvals pre {margin:0; white-space:pre-wrap; font-size:12px; line-height:1.5; tab-size:4}
    [data-vps-chat] .vc-approval-actions {display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px}
    [data-vps-chat] .vc-approval-actions .vc-button {font-size:12px; min-height:30px; padding:4px 10px}
    [data-vps-chat] .vc-reply-actions {display:flex; align-items:center; gap:8px; margin-inline-start:auto; font-size:12px}
    [data-vps-chat] .vc-copy-reply {min-height:28px; padding:3px 8px; background:transparent; color:var(--vc-muted)}
    [data-vps-chat] .vc-copy-status {color:var(--vc-muted)}
    [data-vps-chat] .vc-copy-status[data-failed=true] {color:var(--vc-warn)}
    [data-vps-chat] .vc-markdown {min-width:0; line-height:1.7; overflow-wrap:anywhere}
    [data-vps-chat] .vc-markdown :where(p,ul,ol,blockquote,hr,.vc-markdown-table) {margin:0 0 12px}
    [data-vps-chat] .vc-markdown :where(h1,h2,h3,h4,h5,h6) {margin:16px 0 8px; line-height:1.3; font-size:1em; font-weight:700}
    [data-vps-chat] .vc-markdown :where(h1) {font-size:1.5em}
    [data-vps-chat] .vc-markdown :where(h2) {font-size:1.3em}
    [data-vps-chat] .vc-markdown :where(h3) {font-size:1.15em}
    [data-vps-chat] .vc-markdown > :first-child {margin-block-start:0}
    [data-vps-chat] .vc-markdown > :last-child {margin-block-end:0}
    [data-vps-chat] .vc-markdown :where(ul,ol) {padding-inline-start:1.55em}
    [data-vps-chat] .vc-markdown ul {list-style-type:disc}
    [data-vps-chat] .vc-markdown ol {list-style-type:decimal}
    [data-vps-chat] .vc-markdown li > :where(p,ul,ol) {margin-block:0 .35em}
    [data-vps-chat] .vc-markdown blockquote {padding-inline-start:.8em; border-inline-start:3px solid var(--vc-line); color:var(--vc-muted)}
    [data-vps-chat] .vc-markdown hr {border:0; border-block-start:1px solid var(--vc-line)}
    [data-vps-chat] .vc-markdown a {color:var(--vc-accent); text-decoration:underline; text-underline-offset:.15em}
    [data-vps-chat] .vc-markdown :not(pre) > code {padding:.12em .35em; border-radius:4px; background:var(--vc-bubble)}
    [data-vps-chat] .vc-markdown-table {max-width:100%; overflow-x:auto}
    [data-vps-chat] .vc-markdown-table table {width:100%; border-collapse:collapse; text-align:start}
    [data-vps-chat] .vc-markdown-table th {background:var(--vc-rail)}
    [data-vps-chat] .vc-markdown-table :is(th,td) {padding:6px 10px; border:1px solid var(--vc-line)}
    [data-vps-chat] .vc-code-block {min-width:0; max-width:100%}
    [data-vps-chat] .vc-code-block pre {white-space:pre; word-break:normal; overflow-wrap:normal; overflow-x:auto}
    [data-vps-chat] .vc-main-body[data-design=true] .vc-code-block pre {max-height:240px; overflow:auto}
    [data-vps-chat] .vc-design-source {margin-block:8px 12px; color:var(--vc-muted)}
    [data-vps-chat] .vc-design-source summary {cursor:pointer; width:fit-content; color:var(--vc-accent)}
    [data-vps-chat] .vc-artifact-link {
      display:flex; gap:10px; align-items:center; justify-content:space-between;
      width:min(100%,340px); min-height:52px; padding:8px 12px;
      border:1px solid var(--vc-line); border-radius:10px; color:var(--vc-ink);
      background:var(--vc-surface); text-align:start;
    }
    [data-vps-chat] .vc-artifact-link:hover {border-color:var(--vc-line-strong); background:var(--vc-hover)}
    [data-vps-chat] .vc-artifact-link strong {display:block; font-size:13px}
    [data-vps-chat] .vc-artifact-link small {display:block; color:var(--vc-muted); font-size:12px}
    [data-vps-chat] .vc-artifact-mark {
      position:relative; width:30px; height:28px; border:1px solid var(--vc-line-strong);
      border-radius:5px; background:var(--vc-tint); color:var(--vc-accent); flex:none;
    }
    [data-vps-chat] .vc-artifact-mark::before {
      position:absolute; inset:5px 8px; border:1px solid currentColor; border-radius:2px; content:'';
    }
    [data-vps-chat] .vc-activity {max-width:100%; color:var(--vc-muted); font-size:12px}
    [data-vps-chat] .vc-activity summary {cursor:pointer; width:fit-content}
    [data-vps-chat] .vc-activity ol {margin:7px 0 0; padding-inline-start:18px}
    [data-vps-chat] .vc-activity pre {
      max-height:140px; margin:3px 0 8px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere;
    }
    [data-vps-chat] .vc-compose-area {flex:none; padding:0 var(--vc-gutter) 17px}
    [data-vps-chat] .vc-compose-wrap {max-width:var(--vc-composer-measure); margin:auto}
    [data-vps-chat] .vc-feedback {
      display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px 10px;
      margin:0 0 8px; color:var(--vc-warn); background:var(--vc-warn-bg);
      border-radius:9px; padding:8px 10px; font-size:13px; overflow-wrap:anywhere;
    }
    [data-vps-chat] .vc-context-note {
      display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin:0 4px; color:var(--vc-muted); font-size:12px;
    }
    [data-vps-chat] .vc-quote-preview {
      display:flex; align-items:center; gap:7px; min-width:0; padding:4px 7px;
      border-inline-start:2px solid var(--vc-accent); border-radius:5px;
      margin-block:4px; font-size:.85em;
    }
    [data-vps-chat] .vc-quote-preview > span:last-of-type {
      min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
    }
    [data-vps-chat] .vc-quote-preview > button { margin-inline-start:auto; flex:none; }
    [data-vps-chat] .vc-context-attachment {
      padding:3px 7px; border:1px solid var(--vc-line); border-radius:6px; color:var(--vc-accent);
      background:var(--vc-tint); overflow-wrap:anywhere;
    }
    [data-vps-chat] .vc-context-note[data-error=true] {color:var(--vc-warn)}
    [data-vps-chat] .vc-settings {
      width:min(530px,calc(100% - 26px)); max-height:calc(100% - 26px); padding:22px; overflow:auto;
      border:1px solid var(--vc-line); border-radius:16px; background:var(--vc-surface); color:var(--vc-ink);
    }
    [data-vps-chat] .vc-settings::backdrop {background:var(--vc-overlay)}
    [data-vps-chat] .vc-settings h2 {margin:0 0 8px; font-size:20px}
    [data-vps-chat] .vc-settings p {margin:0 0 15px; color:var(--vc-muted)}
    [data-vps-chat] .vc-dialog-actions {display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px}
    @container (max-width:620px) {
      [data-vps-chat] .vc-main {grid-column:1/-1}
      [data-vps-chat] .vc-history-toggle {display:block}
      [data-vps-chat] .vc-rail {
        display:none; position:absolute; z-index:4; inset:var(--vc-header-height) auto 0 0;
        width:min(240px,86%); box-shadow:var(--vc-shadow);
      }
      [data-vps-chat] .vc-rail[data-open=true] {display:flex}
      [data-vps-chat] .vc-header[data-design=true] {flex-wrap:wrap; padding-bottom:8px}
      [data-vps-chat] .vc-header[data-design=true] .vc-design-panes {order:1; margin-inline-end:auto}
    }
    @container (max-width:460px) {
      [data-vps-chat] .vc-header[data-design=true] {display:grid; grid-template-columns:auto minmax(0,1fr) auto}
      [data-vps-chat] .vc-header[data-design=true] .vc-design-panes {grid-row:2; grid-column:1/-1; justify-self:start}
      [data-vps-chat] .vc-rail[data-design=true] {margin-block-start:25px}
    }
    @container (max-width:390px) {
      [data-vps-chat] .vc-header {gap:6px; padding-inline:9px}
      [data-vps-chat] .vc-header > .vc-button {padding-inline:8px}
      [data-vps-chat] .vc-settings {padding:15px}
    }
    @media (max-height:560px) {
      @container (max-width:620px) {
        [data-vps-chat] .vc-body:has(> .vc-welcome) {padding-block:8px}
        [data-vps-chat] .vc-welcome {margin-block-start:6px}
        [data-vps-chat] .vc-welcome :is(h1,h2,p) {margin-block-end:8px}
      }
    }
  `;
}

export function chatSurfaceCss(separatorWidth = 9) {
  return workbenchCss(separatorWidth) + composerControlsCss + menuIconsCss + menuMotionCss + themeComposerCss;
}

export const themeComposerCss = `
  [data-vps-chat] :is(.vc-composer,.vc-composer-panel,.vc-design-materials) {
    --vc-surface:inherit;
    --vc-canvas:inherit;
    --vc-ink:inherit;
    --vc-muted:inherit;
    --vc-line:inherit;
    --vc-line-strong:inherit;
    --vc-hover:inherit;
    --vc-tint:inherit;
    --vc-accent:inherit;
    --vc-on-accent:inherit;
    --vc-shadow:inherit;
    --vc-warn:inherit;
    --vc-warn-bg:inherit;
    color-scheme:inherit;
  }
  [data-vps-chat] .vc-composer {box-shadow:var(--vc-card-shadow)}
  [data-vps-chat] .vc-effort-track {background:var(--vc-slider-track)}
  [data-vps-chat] .vc-effort-progress::before {background:var(--vc-slider-fill)}
  [data-vps-chat] .vc-effort-steps span {background:var(--vc-slider-step)}
  [data-vps-chat] .vc-effort-steps span[data-used=true] {background:var(--vc-slider-step-used)}
  [data-vps-chat] .vc-effort-thumb {background:var(--vc-slider-thumb); box-shadow:var(--vc-slider-thumb-shadow)}
`;
