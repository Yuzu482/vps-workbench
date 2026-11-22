export const workflowPanelStyles = `
[data-vps-chat] .vc-workflow-dialog {
  box-sizing:border-box; width:min(1120px, calc(100vw - 48px));
  height:min(820px, calc(100dvh - 80px)); max-width:none; max-height:none;
  margin:auto; padding:0; overflow:hidden; border:1px solid var(--vc-line);
  border-radius:16px; background:var(--vc-canvas); color:var(--vc-ink);
  box-shadow:0 24px 80px #18100f45;
}
[data-vps-chat] .vc-workflow-dialog[open] {display:grid; grid-template-rows:auto minmax(0, 1fr)}
[data-vps-chat] .vc-workflow-dialog::backdrop {background:#19120e72}
[data-vps-chat] .vc-workflow-dialog * {box-sizing:border-box}
.vc-workflow-dialog :is(h2,h3,h4,p,dl,dd) {margin:0}
.vc-workflow-dialog h2 {font-size:19px}
.vc-workflow-dialog h3 {font-size:15px}
.vc-workflow-dialog h4 {font-size:12px; color:var(--vc-muted)}
.vc-workflow-header {
  display:flex; align-items:center; justify-content:space-between; gap:14px;
  padding:12px 20px; border-bottom:1px solid var(--vc-line); background:var(--vc-surface);
}
.vc-workflow-body {display:grid; grid-template-columns:minmax(0,1.9fr) minmax(300px,1fr); min-height:0}
.vc-workflow-body[data-proposal=true] {grid-template-columns:minmax(0,1fr)}
.vc-workflow-view-switch {display:none}
.vc-workflow-pane {
  min-width:0; min-height:0; overflow:auto; padding:16px 20px;
  display:flex; flex-direction:column; gap:14px; font-size:13px;
}
.vc-workflow-run-pane {border-inline-start:1px solid var(--vc-line); background:var(--vc-surface)}
.vc-workflow-edit-pane {gap:12px}
.vc-workflow-actions {display:flex; flex-wrap:wrap; align-items:center; gap:6px}
.vc-workflow-draft-confirm {display:grid; gap:14px}
.vc-workflow-dialog .vc-workflow-draft-confirm h2 {font-size:16px}
.vc-workflow-title-row {display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px}
.vc-workflow-proposal-name {display:grid; gap:4px}
.vc-workflow-command-row {
  display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:8px;
}
.vc-workflow-edit-name {border-top:1px solid var(--vc-line); padding-top:12px}
.vc-workflow-dialog .vc-button {font-size:12px}
.vc-workflow-dialog .vc-button:not(.vc-primary) {border-color:var(--vc-line); background:var(--vc-surface)}
.vc-workflow-dialog .vc-button:not(.vc-primary):hover:not(:disabled) {background:var(--vc-hover)}
.vc-workflow-field {display:grid; gap:5px; min-width:0; color:var(--vc-muted)}
.vc-workflow-field > span {font-size:12px}
.vc-workflow-field :is(input, select, textarea) {
  width:100%; min-width:0; padding:7px 8px; border:1px solid var(--vc-line); border-radius:7px;
  background:var(--vc-surface); color:var(--vc-ink); font:inherit;
}
.vc-workflow-field textarea {min-height:66px; resize:vertical}
.vc-workflow-graph {
  min-width:0; flex:none; border:1px solid var(--vc-line); border-radius:12px;
  background:var(--vc-surface);
}
.vc-workflow-graph-head {
  display:flex; flex-wrap:wrap; align-items:center; gap:7px 12px; padding:8px 10px;
}
.vc-workflow-graph-head h3 {font-size:13px}
.vc-workflow-graph-add {margin-inline-start:auto}
.vc-workflow-add-stage::before {content:'+'; margin-inline-end:5px; color:var(--vc-accent); font-weight:700}
.vc-workflow-graph-note {padding:0 10px 8px}
.vc-workflow-graph-note[role=alert] {color:var(--vc-ink); font-weight:600}
.vc-workflow-graph-scroll {
  overflow:auto; max-height:min(360px, 46dvh); border-top:1px solid var(--vc-line);
  border-radius:0 0 11px 11px;
  background:radial-gradient(circle, color-mix(in srgb, var(--vc-line-strong) 34%, transparent) 1px, transparent 1.2px)
    0 0 / 13px 13px, var(--vc-canvas);
}
.vc-workflow-board {position:relative}
.vc-workflow-wires {position:absolute; inset:0; width:100%; height:100%; pointer-events:none; color:var(--vc-accent)}
.vc-workflow-graph-list {margin:0; padding:0; list-style:none}
.vc-workflow-graph-step {position:absolute; min-width:0}
.vc-workflow-node {
  display:grid; grid-template-rows:19px 16px 16px; align-content:center; gap:4px;
  width:100%; height:100%; min-width:0; padding:8px 12px;
  border:1px solid var(--vc-line); border-radius:10px; background:var(--vc-surface); color:var(--vc-ink);
  font:inherit; text-align:start; cursor:pointer; transition:background-color .16s ease, border-color .16s ease, opacity .16s ease;
}
.vc-workflow-port {
  position:absolute; top:50%; z-index:1; display:grid; place-items:center; width:22px; height:25px;
  padding:0; border:0; border-radius:7px; transform:translateY(-50%); background:transparent;
}
button.vc-workflow-port {cursor:pointer; touch-action:none}
button.vc-workflow-port:disabled {cursor:default}
.vc-workflow-port-input {left:-11px}
.vc-workflow-port-output {right:-11px}
.vc-workflow-port::before {
  content:''; box-sizing:border-box; width:12px; height:12px; border:2px solid var(--vc-accent);
  border-radius:50%; background:var(--vc-surface);
}
.vc-workflow-port-input::before {border-radius:3px}
.vc-workflow-port:is([data-connected=true], [aria-pressed=true], [data-targeted=true])::before {background:var(--vc-accent)}
button.vc-workflow-port:focus-visible {outline:2px solid var(--vc-accent); outline-offset:1px}
button.vc-workflow-port:not(:disabled):hover::before,
.vc-workflow-port:is([aria-pressed=true], [data-targeted=true])::before {
  box-shadow:0 0 0 4px color-mix(in srgb, var(--vc-accent) 25%, transparent);
}
.vc-workflow-dependency-count {
  margin-inline-start:auto; min-width:14px; border-radius:4px; font-size:10px; line-height:16px;
  color:var(--vc-on-accent); background:var(--vc-accent); text-align:center;
  pointer-events:none;
}
.vc-workflow-node[draggable=true] {cursor:grab}
.vc-workflow-node[data-dragged=true] {opacity:.5; cursor:grabbing}
.vc-workflow-node:hover {border-color:var(--vc-line-strong)}
.vc-workflow-node:focus-visible {outline:2px solid var(--vc-accent); outline-offset:2px}
.vc-workflow-node[aria-pressed=true] {
  border-color:var(--vc-accent); background:color-mix(in srgb, var(--vc-accent) 11%, var(--vc-surface));
}
.vc-workflow-graph-step[data-insert=before] .vc-workflow-node {box-shadow:-5px 0 0 -2px var(--vc-accent)}
.vc-workflow-graph-step[data-insert=after] .vc-workflow-node {box-shadow:5px 0 0 -2px var(--vc-accent)}
.vc-workflow-node-top, .vc-workflow-node-agent {display:flex; align-items:center; min-width:0; gap:6px}
.vc-workflow-step-number {
  display:grid; place-items:center; flex:0 0 19px; height:19px; border-radius:5px;
  background:var(--vc-rail); color:var(--vc-muted); font-size:11px; font-weight:650;
}
.vc-workflow-node[aria-pressed=true] .vc-workflow-step-number {background:var(--vc-accent); color:var(--vc-on-accent)}
.vc-workflow-node strong, .vc-workflow-node-agent-name {
  display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;
}
.vc-workflow-node strong {font-size:13px}
.vc-workflow-node-provider {display:grid; place-items:center; flex:none; width:16px; height:16px}
.vc-workflow-node-agent-name {font-size:11px; color:var(--vc-muted)}
.vc-workflow-node-memory {
  justify-self:start; padding:1px 5px; border-radius:4px; background:var(--vc-rail);
  color:var(--vc-muted); font-size:10px; line-height:14px; white-space:nowrap;
}
.vc-workflow-node-memory[data-memory=shared] {background:var(--vc-tint); color:var(--vc-accent)}
.vc-workflow-node-memory[data-memory=isolated] {color:var(--vc-ink)}
.vc-workflow-agent-tooltip {
  position:absolute; z-index:2; display:grid; gap:6px; width:max-content;
  max-width:min(340px, calc(100% - 16px)); max-height:calc(100% - 16px);
  padding:9px 11px; overflow:hidden; overflow-wrap:anywhere; visibility:hidden; pointer-events:none;
  border:1px solid var(--vc-line-strong); border-radius:8px; background:var(--vc-surface); color:var(--vc-ink);
  box-shadow:0 6px 20px #18100f28; font-size:12px; line-height:1.4;
  animation:vc-workflow-agent-tooltip-in var(--vc-control-duration, 0ms) var(--vc-motion-curve, ease) both;
}
.vc-workflow-agent-tooltip strong {font-size:13px}
.vc-workflow-agent-tooltip dl {display:grid; grid-template-columns:auto minmax(0,1fr); gap:3px 8px}
.vc-workflow-agent-tooltip :is(dt,p) {color:var(--vc-muted)}
@keyframes vc-workflow-agent-tooltip-in {from {opacity:0} to {opacity:1}}
.vc-workflow-model {display:grid; grid-template-columns:minmax(0, 1fr) auto; align-items:end; gap:6px}
.vc-workflow-list {display:grid; gap:10px; padding:0; margin:0; list-style:none}
.vc-workflow-card {
  min-width:0; display:grid; gap:8px; padding:11px; margin:0;
  border:1px solid var(--vc-line); border-radius:9px; background:var(--vc-canvas);
  overflow-wrap:anywhere;
}
.vc-workflow-card > legend {padding:0 4px; font-weight:600}
.vc-workflow-inspector {background:var(--vc-surface)}
.vc-workflow-presets {display:grid; gap:5px; min-width:0}
.vc-workflow-preset-grid {
  display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%, 174px),1fr)); gap:6px;
  min-width:0; max-height:min(286px, 42dvh); padding:3px; margin:-3px;
  overflow-x:hidden; overflow-y:auto; scroll-padding-block:3px;
}
.vc-workflow-preset-card {
  display:grid; align-content:start; gap:5px; min-width:0; padding:6px 8px;
  border:1px solid var(--vc-line); border-radius:8px;
  background:var(--vc-canvas); color:var(--vc-ink); font:inherit; text-align:start;
  overflow-wrap:anywhere; cursor:pointer; transition:background-color .12s, border-color .12s;
}
.vc-workflow-preset-card:enabled:hover {border-color:var(--vc-line-strong); background:var(--vc-hover)}
.vc-workflow-preset-card[aria-pressed=true] {border-color:var(--vc-accent); background:var(--vc-tint)}
.vc-workflow-preset-card[aria-pressed=true]:enabled:hover {border-color:var(--vc-accent)}
.vc-workflow-preset-card:focus-visible {outline:2px solid var(--vc-accent); outline-offset:1px}
.vc-workflow-preset-card:disabled {opacity:.55; cursor:default}
.vc-workflow-preset-name {display:flex; align-items:start; justify-content:space-between; gap:5px; line-height:1.25}
.vc-workflow-preset-name strong {min-width:0}
.vc-workflow-preset-selected {flex:none; color:var(--vc-accent); font-weight:700}
.vc-workflow-preset-details {
  display:grid; min-width:0; gap:3px; color:var(--vc-muted); font-size:11px; line-height:1.25;
}
.vc-workflow-preset-provider {display:flex; align-items:center; gap:4px; color:var(--vc-ink); font-weight:600}
.vc-workflow-preset-provider > span {min-width:0}
.vc-workflow-preset-icon {display:grid; flex:none; place-items:center; width:14px; height:14px}
.vc-workflow-preset-icon .vc-menu-icon {width:14px; height:14px}
.vc-workflow-preset-memory {
  justify-self:start; padding:1px 4px; border-radius:4px; background:var(--vc-rail);
}
.vc-workflow-preset-memory[data-memory=shared] {background:var(--vc-tint); color:var(--vc-accent)}
.vc-workflow-preset-memory[data-memory=isolated] {color:var(--vc-ink)}
.vc-workflow-preset-chips {display:flex; flex-wrap:wrap; align-items:baseline; gap:3px; min-width:0}
.vc-workflow-preset-chips > span:not(.vc-workflow-preset-chip-label) {
  min-width:0; max-width:100%; padding:1px 4px; border-radius:4px; background:var(--vc-rail); color:var(--vc-ink);
}
.vc-workflow-dependencies {display:grid; gap:6px; border-top:1px solid var(--vc-line); padding-top:8px}
.vc-workflow-dependencies ul {display:grid; gap:4px; margin:0; padding:0; list-style:none}
.vc-workflow-dependencies li {display:flex; align-items:center; justify-content:space-between; gap:8px}
.vc-workflow-files {
  min-width:0; display:grid; gap:7px; margin:0; padding:7px 9px 9px;
  border:1px solid var(--vc-line); border-radius:8px; background:var(--vc-canvas);
}
.vc-workflow-files legend {padding:0 4px; color:var(--vc-muted); font-size:12px}
.vc-workflow-files > button {justify-self:start}
.vc-workflow-file-path-row {display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:6px}
.vc-workflow-file-list {display:grid; gap:4px; margin:0; padding:0; list-style:none}
.vc-workflow-file-list li {
  min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:3px 6px; border-radius:6px; background:var(--vc-rail);
}
.vc-workflow-file-list button {flex:none}
.vc-workflow-files input::file-selector-button {
  margin-inline-end:8px; padding:3px 7px; border:1px solid var(--vc-line); border-radius:5px;
  color:var(--vc-ink); background:var(--vc-canvas); font:inherit;
}
.vc-workflow-files input:enabled::file-selector-button {cursor:pointer}
.vc-workflow-files input:enabled::file-selector-button:hover {background:var(--vc-hover)}
.vc-workflow-output-path {display:grid; gap:3px}
.vc-workflow-output-path code {font-size:11px; user-select:text}
.vc-workflow-artifacts {display:grid; gap:6px; min-width:0; justify-items:start}
.vc-workflow-artifact-content:not([hidden]) {display:grid; gap:6px; width:100%; min-width:0}
.vc-workflow-artifact-content > button {justify-self:start}
.vc-workflow-artifact-list {
  display:grid; gap:4px; min-width:0; max-height:180px; padding:2px; margin:0; overflow:auto; list-style:none;
}
.vc-workflow-artifact-list li {display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px}
.vc-workflow-dialog .vc-workflow-artifact-list button {min-width:0; text-align:start; overflow-wrap:anywhere; white-space:normal}
.vc-workflow-dialog .vc-workflow-artifact-list button[aria-pressed=true] {border-color:var(--vc-accent); background:var(--vc-tint)}
.vc-workflow-artifact-download {justify-self:start; color:var(--vc-accent)}
.vc-workflow-fields {display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px}
.vc-workflow-note {font-size:12px; color:var(--vc-muted); overflow-wrap:anywhere}
.vc-workflow-error {
  padding:8px; border:1px solid var(--vc-line); border-radius:7px;
  color:var(--vc-ink); background:var(--vc-rail); overflow-wrap:anywhere;
}
.vc-workflow-text {
  max-height:280px; overflow:auto; margin:0; padding:8px; border-radius:7px;
  background:var(--vc-rail); white-space:pre-wrap; overflow-wrap:anywhere; user-select:text;
}
.vc-workflow-details {display:grid; grid-template-columns:auto minmax(0,1fr); gap:5px 12px}
.vc-workflow-details dt {color:var(--vc-muted)}
.vc-workflow-independent-modules .vc-agent-memory {display:none}
.vc-workflow-mixed-routes {gap:6px}
.vc-workflow-mixed-section, .vc-workflow-mixed-routes > li {display:grid; gap:5px; min-width:0}
.vc-workflow-mixed-section {border-top:1px solid var(--vc-line); padding-top:8px}
.vc-workflow-transfer-options {display:flex; flex-wrap:wrap; gap:6px 10px}
.vc-workflow-transfer-options label, .vc-workflow-transfer-confirm {display:flex; align-items:baseline; gap:5px; min-width:0}
.vc-workflow-transfer-options input, .vc-workflow-transfer-confirm input {margin:0; accent-color:var(--vc-accent)}
@media (max-width:760px) {
  [data-vps-chat] .vc-workflow-dialog {width:calc(100vw - 20px); height:calc(100dvh - 54px)}
  .vc-workflow-header, .vc-workflow-pane {padding-inline:12px}
  .vc-workflow-body {grid-template-columns:minmax(0,1fr)}
  .vc-workflow-body[data-proposal=false] {grid-template-rows:auto minmax(0,1fr)}
  .vc-workflow-view-switch {
    display:flex; gap:6px; padding:6px 12px; background:var(--vc-surface); border-bottom:1px solid var(--vc-line);
  }
  .vc-workflow-view-switch > button {flex:1}
  .vc-workflow-dialog .vc-workflow-view-switch > button[aria-pressed=true] {
    color:var(--vc-accent); background:var(--vc-tint); border-color:var(--vc-line-strong);
  }
  .vc-workflow-body[data-view=configuration] .vc-workflow-run-pane,
  .vc-workflow-body[data-view=run] .vc-workflow-edit-pane {display:none}
  .vc-workflow-run-pane {border-inline-start:0}
}
@media (max-width:400px) {
  .vc-workflow-fields, .vc-workflow-model, .vc-workflow-file-path-row {grid-template-columns:minmax(0,1fr)}
  .vc-workflow-model > button, .vc-workflow-file-path-row > button {justify-self:start}
}
[data-vps-chat][data-vc-motion=reduce] :is(.vc-workflow-node, .vc-workflow-preset-card) {transition:none}
@media (prefers-reduced-motion:reduce) {
  .vc-workflow-node, .vc-workflow-preset-card {transition:none}
}
`;
