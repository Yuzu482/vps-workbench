export const settingsCss = `
  [data-vps-chat] .vc-settings.vc-workbench-settings {
    --vc-popup-shift:9px;
    width:min(850px,calc(100% - 32px)); height:min(656px,calc(100dvh - 34px));
    max-width:none; max-height:none; padding:0; overflow:hidden;
    grid-template-rows:auto minmax(0,1fr);
    border:1px solid var(--vc-line); border-radius:17px;
    box-shadow:0 24px 70px #17111651;
  }
  [data-vps-chat] .vc-workbench-settings[open] {display:grid}
  [data-vps-chat] .vc-workbench-settings::backdrop {
    background:color-mix(in srgb,var(--vc-overlay) 81%,transparent);
  }
  [data-vps-chat] .vc-settings-header {
    display:flex; align-items:center; justify-content:space-between;
    padding:12px 19px 12px 22px; border-bottom:1px solid var(--vc-line);
  }
  [data-vps-chat] .vc-settings-header h2 {font-size:17px; letter-spacing:.01em; margin:0; font-weight:680}
  [data-vps-chat] .vc-settings-unsaved {color:var(--vc-accent); font-size:12px; margin-inline-start:8px; margin-inline-end:auto}
  [data-vps-chat] .vc-settings-confirm-dialog {
    width:min(418px,calc(100% - 28px)); padding:17px 18px; border:1px solid var(--vc-line); border-radius:14px;
    color:var(--vc-ink); background:var(--vc-surface); box-shadow:0 18px 45px #17111651;
  }
  [data-vps-chat] .vc-settings-confirm-dialog::backdrop {background:color-mix(in srgb,var(--vc-overlay) 68%,transparent)}
  [data-vps-chat] .vc-settings-confirm-dialog h2 {font-size:17px; margin:0}
  [data-vps-chat] .vc-settings-confirm-dialog p {margin:6px 0 14px; overflow-wrap:anywhere}
  [data-vps-chat] .vc-settings-close {
    width:34px; height:34px; display:grid; place-items:center; padding:0; min-height:0;
    color:var(--vc-muted); font:400 22px/1 system-ui,sans-serif; border-radius:9px;
  }
  [data-vps-chat] .vc-settings-layout {
    display:grid; grid-template-columns:172px minmax(0,1fr); min-height:0; min-width:0;
  }
  [data-vps-chat] .vc-settings-nav {
    display:flex; flex-direction:column; gap:4px; padding:15px 12px;
    border-inline-end:1px solid var(--vc-line);
    background:color-mix(in srgb,var(--vc-rail) 56%,var(--vc-surface));
  }
  [data-vps-chat] .vc-settings-nav .vc-button {
    display:flex; align-items:center; gap:10px; min-height:40px; text-align:left;
    color:var(--vc-muted); border:0; border-radius:9px; font-weight:630;
    transition:color var(--vc-control-duration) ease, background-color var(--vc-control-duration) ease;
  }
  [data-vps-chat] .vc-settings-nav .vc-button[aria-current] {background:var(--vc-tint); color:var(--vc-accent)}
  [data-vps-chat] .vc-settings-subnav {
    display:flex; flex-wrap:wrap; gap:4px; margin-bottom:12px; padding:4px;
    border-radius:9px; background:var(--vc-canvas);
  }
  [data-vps-chat] .vc-settings-subnav .vc-button {
    min-height:30px; padding:3px 9px; border:0; border-radius:6px; font-size:12px; color:var(--vc-muted);
  }
  [data-vps-chat] .vc-settings-subnav .vc-button:is([aria-current],[aria-pressed=true]) {
    color:var(--vc-accent); background:var(--vc-tint); font-weight:650;
  }
  [data-vps-chat] .vc-settings-locations {width:fit-content}
  [data-vps-chat] .vc-settings-nav [data-icon=server]::before {
    inset:2px 1px 8px; border:1.4px solid currentColor; border-radius:2px;
  }
  [data-vps-chat] .vc-settings-nav [data-icon=server]::after {
    inset:9px 1px 1px; border:1.4px solid currentColor; border-radius:2px;
  }
  [data-vps-chat] .vc-settings-nav [data-icon=keyboard]::before {
    inset:3px 0; border:1.4px solid currentColor; border-radius:3px;
  }
  [data-vps-chat] .vc-settings-nav [data-icon=keyboard]::after {
    inset:6px 3px 5px; border-bottom:1.4px solid currentColor;
    background:repeating-linear-gradient(90deg,currentColor 0 1.5px,transparent 1.5px 3.5px) 0 0/100% 1.5px no-repeat;
  }
  [data-vps-chat] .vc-settings-form {
    display:grid; grid-template-rows:minmax(0,1fr) auto; min-height:0; min-width:0;
  }
  [data-vps-chat] .vc-settings-scroll {
    padding:23px 25px 22px; min-width:0; overflow:auto;
    overscroll-behavior:contain; scrollbar-gutter:stable;
  }
  @keyframes vc-settings-page-in {from {opacity:0; translate:0 5px} to {opacity:1; translate:0 0}}
  [data-vps-chat] .vc-settings-pane {animation:vc-settings-page-in var(--vc-popup-duration) var(--vc-motion-curve) both}
  [data-vps-chat] .vc-settings-pane h3 {font-size:24px; line-height:1.25; font-weight:690; margin:0 0 6px}
  [data-vps-chat] .vc-settings-pane p {font-size:13px; margin:0; overflow-wrap:anywhere}
  [data-vps-chat] .vc-settings-pane .vc-settings-intro {margin:0 0 19px}
  [data-vps-chat] .vc-settings-group {
    display:grid; gap:10px; padding:15px; margin-bottom:10px;
    border:1px solid var(--vc-line); border-radius:11px;
  }
  [data-vps-chat] .vc-settings-group h4 {font-size:14px; margin:0; font-weight:680}
  [data-vps-chat] .vc-settings-address {display:grid; grid-template-columns:minmax(0,1fr) minmax(86px,.3fr); gap:10px}
  [data-vps-chat] .vc-workbench-settings .vc-field,
  [data-vps-chat] .vc-tool-profile-fields label {
    display:grid; gap:4px; min-width:0; font-size:12px; color:var(--vc-muted);
  }
  [data-vps-chat] .vc-workbench-settings .vc-field :is(input,select),
  [data-vps-chat] .vc-tool-profile-fields select {
    min-width:0; width:100%; min-height:34px; padding:6px 8px;
    border:1px solid var(--vc-line); border-radius:7px; color:var(--vc-ink); background:var(--vc-canvas);
  }
  [data-vps-chat] .vc-settings-confirm {
    display:flex; align-items:start; gap:8px; font-size:12px; color:var(--vc-muted); cursor:pointer;
  }
  [data-vps-chat] .vc-settings-confirm input {margin:3px 0 0; accent-color:var(--vc-accent)}
  [data-vps-chat] .vc-settings-footer {
    padding:11px 23px; border-top:1px solid var(--vc-line);
    background:color-mix(in srgb,var(--vc-surface) 85%,var(--vc-canvas)); overflow-wrap:anywhere;
  }
  [data-vps-chat] .vc-settings-footer .vc-feedback {margin-bottom:8px}
  [data-vps-chat] .vc-settings-outline {border-color:var(--vc-line); background:var(--vc-surface)}
  [data-vps-chat] .vc-preference-row {
    display:flex; align-items:center; justify-content:space-between; gap:12px 14px;
    padding:13px 0; border-bottom:1px solid var(--vc-line); flex-wrap:wrap;
  }
  [data-vps-chat] .vc-settings-description {
    display:block; min-width:0; flex:1; overflow-wrap:anywhere;
  }
  [data-vps-chat] .vc-settings-description small {display:block; font-size:12px; color:var(--vc-muted); margin-top:2px}
  [data-vps-chat] .vc-preference-options {
    display:flex; flex-wrap:wrap; gap:2px; padding:3px;
    background:var(--vc-canvas); border:1px solid var(--vc-line); border-radius:9px;
  }
  [data-vps-chat] :is(.vc-preference-options,.vc-accent-choices) button {
    min-height:30px; padding:3px 9px; color:var(--vc-muted); border:1px solid transparent;
    border-radius:6px; background:transparent; font-size:12px; font-weight:620;
    transition:background-color var(--vc-control-duration) ease, color var(--vc-control-duration) ease;
  }
  [data-vps-chat] :is(.vc-preference-options,.vc-accent-choices) button:hover {background:var(--vc-hover)}
  [data-vps-chat] :is(.vc-preference-options,.vc-accent-choices) button[aria-pressed=true] {
    background:var(--vc-surface); color:var(--vc-accent); border-color:var(--vc-line);
  }
  [data-vps-chat] .vc-settings-disclosure {border-bottom:1px solid var(--vc-line)}
  [data-vps-chat] .vc-settings-disclosure > summary {
    display:flex; align-items:center; gap:9px; padding:13px 0; list-style:none;
    cursor:pointer; border-radius:6px;
  }
  [data-vps-chat] .vc-settings-disclosure > summary::-webkit-details-marker {display:none}
  [data-vps-chat] .vc-settings-disclosure > summary:hover {color:var(--vc-accent)}
  [data-vps-chat] .vc-settings-chevron {
    flex:none; width:7px; height:7px; margin:0 3px 3px;
    border-bottom:1.5px solid currentColor; border-right:1.5px solid currentColor;
    transform:rotate(45deg); transition:transform var(--vc-popup-duration) var(--vc-motion-curve),
      margin-bottom var(--vc-popup-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-settings-disclosure[open] > summary .vc-settings-chevron {transform:rotate(225deg); margin-bottom:-3px}
  [data-vps-chat] .vc-settings-current {color:var(--vc-muted); font-size:12px; white-space:nowrap}
  [data-vps-chat] .vc-settings-save-hint {display:inline-block; margin-inline-start:8px; font-weight:400}
  [data-vps-chat] .vc-settings-disclosed {padding:2px 2px 12px}
  [data-vps-chat] .vc-settings-group .vc-settings-disclosure {border:0}
  [data-vps-chat] .vc-settings-group .vc-settings-disclosure > summary {padding:3px 0}
  [data-vps-chat] .vc-settings-group .vc-settings-disclosed {padding:8px 2px 3px}
  [data-vps-chat] .vc-accent-choices {display:grid; grid-template-columns:repeat(auto-fit,minmax(78px,1fr)); gap:6px}
  [data-vps-chat] .vc-accent-choices button {
    display:grid; justify-items:center; align-content:center; gap:5px;
    min-height:55px; border-color:var(--vc-line); border-radius:9px; background:var(--vc-canvas);
  }
  [data-vps-chat] .vc-accent-swatch {
    width:16px; height:16px; border-radius:50%;
    background:conic-gradient(#2867b5,#704a99,#a85e35,#267b69,#2867b5);
  }
  [data-vps-chat] .vc-tool-settings {
    display:grid; gap:9px; min-width:0; margin:0; padding:0; border:0;
  }
  [data-vps-chat] .vc-tool-config {
    min-width:0; border:1px solid var(--vc-line); border-radius:11px; overflow:hidden;
  }
  [data-vps-chat] .vc-tool-setting {
    display:grid; grid-template-columns:26px minmax(0,1fr) auto; align-items:center; gap:10px;
    min-height:56px; padding:9px 12px; cursor:pointer;
  }
  [data-vps-chat] .vc-tool-setting[data-configured=true] {background:color-mix(in srgb,var(--vc-tint) 72%,var(--vc-surface))}
  [data-vps-chat] .vc-tool-setting[data-available=false] {cursor:default}
  [data-vps-chat] .vc-tool-setting > .vc-menu-icon {justify-self:center; color:var(--vc-accent)}
  [data-vps-chat] .vc-tool-setting-name {display:block; font-weight:680}
  [data-vps-chat] .vc-tool-in-use {
    display:inline-block; margin-inline-start:7px; font-size:11px; color:var(--vc-accent); font-weight:620;
  }
  [data-vps-chat] :is(.vc-tool-toggle,.vc-settings-switch) {
    appearance:none; position:relative; box-sizing:border-box; flex:none; width:38px; height:22px; margin:0;
    border:1px solid var(--vc-line-strong); border-radius:999px; background:var(--vc-canvas);
    cursor:pointer; transition:background-color var(--vc-control-duration) ease, border-color var(--vc-control-duration) ease;
  }
  [data-vps-chat] :is(.vc-tool-toggle,.vc-settings-switch)::before {
    content:''; position:absolute; inset:3px auto 3px 3px; aspect-ratio:1; border-radius:50%;
    background:var(--vc-muted); transition:transform var(--vc-control-duration) var(--vc-motion-curve),
      background-color var(--vc-control-duration) ease;
  }
  [data-vps-chat] :is(.vc-tool-toggle,.vc-settings-switch):hover:not(:disabled) {border-color:var(--vc-accent)}
  [data-vps-chat] :is(.vc-tool-toggle,.vc-settings-switch):checked {background:var(--vc-accent); border-color:var(--vc-accent)}
  [data-vps-chat] :is(.vc-tool-toggle,.vc-settings-switch):checked::before {transform:translateX(16px); background:var(--vc-on-accent)}
  [data-vps-chat] :is(.vc-tool-toggle,.vc-settings-switch):disabled {opacity:.55; cursor:default}
  [data-vps-chat] .vc-tool-disclosure {border:0; border-top:1px solid var(--vc-line)}
  [data-vps-chat] .vc-tool-disclosure > summary {padding:8px 12px; min-height:34px; font-size:12px}
  [data-vps-chat] .vc-tool-disclosure > summary:focus-visible {outline-offset:-2px}
  [data-vps-chat] .vc-tool-disclosure .vc-settings-disclosed {display:grid; gap:10px; padding:5px 12px 12px}
  [data-vps-chat] .vc-tool-disclosure .vc-settings-outline {justify-self:start; font-size:12px}
  [data-vps-chat] .vc-tool-profile-fields {display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px}
  [data-vps-chat] .vc-tool-model .vc-preference-row {border-bottom:0; padding:8px 0}
  [data-vps-chat] .vc-settings-pane .vc-settings-inline-error {color:var(--vc-warn); margin:0 0 7px}
  [data-vps-chat] .vc-account-groups {display:grid; gap:9px}
  [data-vps-chat] .vc-account-group {
    display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:9px 14px;
    min-height:62px; padding:10px 12px; border:1px solid var(--vc-line); border-radius:11px;
  }
  [data-vps-chat] .vc-account-group-heading {
    display:flex; flex:1 1 208px; align-items:center; gap:10px; min-width:0;
  }
  [data-vps-chat] .vc-account-group-heading > .vc-menu-icon {color:var(--vc-accent)}
  [data-vps-chat] .vc-account-actions {display:flex; flex-wrap:wrap; gap:6px}
  [data-vps-chat] .vc-account-actions .vc-button {min-height:32px; font-size:12px; padding-inline:8px}
  [data-vps-chat] .vc-account-availability {color:var(--vc-warn)}
  @media (forced-colors:active) {
    [data-vps-chat] :is(.vc-tool-toggle,.vc-settings-switch) {appearance:auto}
    [data-vps-chat] :is(.vc-tool-toggle,.vc-settings-switch)::before {display:none}
  }
  @media (max-width:630px) {
    [data-vps-chat] .vc-settings.vc-workbench-settings {width:calc(100% - 18px); height:calc(100dvh - 20px)}
    [data-vps-chat] .vc-settings-layout {grid-template-columns:minmax(0,1fr); grid-template-rows:auto minmax(0,1fr)}
    [data-vps-chat] .vc-settings-header {padding:7px 10px 7px 13px}
    [data-vps-chat] .vc-settings-nav {
      display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:3px; padding:5px;
      border-inline-end:0; border-bottom:1px solid var(--vc-line);
    }
    [data-vps-chat] .vc-settings-nav .vc-button {justify-content:center; gap:4px; min-height:36px; padding:3px; font-size:12px}
    [data-vps-chat] .vc-settings-nav .vc-menu-icon {width:13px; height:13px}
    [data-vps-chat] .vc-settings-scroll {padding:14px 12px; scrollbar-gutter:auto}
    [data-vps-chat] .vc-settings-pane h3 {font-size:21px}
    [data-vps-chat] .vc-preference-row {align-items:start; flex-direction:column; gap:7px}
    [data-vps-chat] .vc-settings-footer {padding:8px 11px}
  }
  @media (max-width:390px) {
    [data-vps-chat] .vc-settings-group {padding:10px}
    [data-vps-chat] .vc-tool-profile-fields {grid-template-columns:minmax(0,1fr)}
    [data-vps-chat] .vc-settings-nav .vc-menu-icon {display:none}
    [data-vps-chat] .vc-settings-nav .vc-button {text-wrap:balance; overflow-wrap:anywhere; line-height:1.2}
  }
`;
