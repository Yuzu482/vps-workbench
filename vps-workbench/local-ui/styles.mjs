import { workbenchPaletteCss } from '../../remote-workbench/vps-chat/client/workbench-theme.js';

export const localWorkspaceStyles = `
${workbenchPaletteCss('[data-local-sdk]')}
[data-local-sdk] {
  --local-rail-width: var(--desktop-sidebar-width, 216px);
  min-width: 0; min-height: 0; height: 100%; position: relative;
  display: grid; grid-template-columns: var(--local-rail-width) minmax(0, 1fr);
  color: var(--vc-ink); background: var(--vc-canvas);
  font-size: 14px; line-height: 1.5;
  transition: grid-template-columns var(--desktop-sidebar-motion) ease;
}
[data-local-sdk][hidden] { display: none; }
[data-local-sdk] * { box-sizing: border-box; }
[data-local-sdk] :is(button, select, input, textarea) { font: inherit; color: inherit; }
[data-local-sdk] :is(button, select, input, textarea):focus-visible {
  outline: 2px solid var(--desktop-accent); outline-offset: 2px;
}
[data-local-sdk] .vc-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 32px; padding: 4px 10px; border: 1px solid var(--desktop-line);
  border-radius: 8px; background: var(--desktop-surface); cursor: pointer;
  text-decoration: none; font-size: 13px;
}
[data-local-sdk] .vc-button:hover:not(:disabled) { background: var(--desktop-hover); }
[data-local-sdk] .vc-button:disabled { opacity: .54; cursor: default; }
[data-local-sdk] .vc-menu-icon { display: inline-flex; width: 16px; height: 16px; flex: none; }
[data-local-sdk] .vc-rail {
  min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 10px;
  background: var(--desktop-chrome); overflow: hidden; border-inline-end: 1px solid var(--desktop-line);
}
[data-local-sdk] .local-rail-content {
  display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 14px;
  width: var(--desktop-sidebar-width, 216px); padding: 15px 12px 12px; min-height: 0; height: 100%;
}
[data-local-sdk] .local-new { justify-content: flex-start; }
[data-local-sdk] .local-history { min-height: 0; overflow: auto; scrollbar-width: thin; padding: 1px 3px; }
[data-local-sdk] .local-history h2 { margin: 0 0 8px; font-size: 13px; }
[data-local-sdk] .local-history h3 {
  margin: 12px 0 4px; font-weight: 600; font-size: 12px; color: var(--desktop-muted); overflow-wrap: anywhere;
}
[data-local-sdk] .local-history-row {
  display: block; width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  padding: 5px 7px; border: 1px solid transparent; border-radius: 6px;
  text-align: start; background: transparent; cursor: pointer;
}
[data-local-sdk] .local-history-row:hover { background: var(--desktop-hover); }
[data-local-sdk] .local-history-row[aria-current] { background: var(--desktop-active); border-color: var(--desktop-line); }
[data-local-sdk] .local-pane { min-height: 0; min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
[data-local-sdk] .local-header {
  min-width: 0; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center;
  gap: 4px 12px; padding: 9px clamp(12px, 2.8vw, 24px); border-bottom: 1px solid var(--desktop-line);
}
[data-local-sdk] .local-heading { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 0; }
[data-local-sdk] .local-header h1 { margin: 0; font-size: 15px; line-height: 1.35; }
[data-local-sdk] .local-subtitle { margin: 2px 0 0; }
[data-local-sdk] .local-nowrap { white-space: nowrap; }
[data-local-sdk] .local-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
[data-local-sdk] .local-feed { min-height: 0; overflow: auto; scrollbar-width: thin; }
[data-local-sdk] .local-wrap { width: min(100%, 792px); padding-inline: clamp(12px, 2.8vw, 24px); margin-inline: auto; }
[data-local-sdk] .local-empty { display: grid; place-content: center; min-height: 100%; padding-block: 12px; }
[data-local-sdk] .local-empty section { max-width: 340px; }
[data-local-sdk] .local-empty h2 { margin: 0 0 5px; font-size: clamp(17px, 4vw, 24px); letter-spacing: -.02em; }
[data-local-sdk] .local-empty p { margin: 5px 0 0; }
[data-local-sdk] .local-transcript { display: grid; gap: 20px; padding-block: 16px; }
[data-local-sdk] .local-turn { min-width: 0; }
[data-local-sdk] .local-prompt {
  width: fit-content; max-width: min(100%, 580px); margin: 0 0 10px auto; padding: 8px 12px;
  background: var(--desktop-active); border-radius: 14px 14px 4px 14px; white-space: pre-wrap; overflow-wrap: anywhere;
}
[data-local-sdk] .local-response { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0; overflow-wrap: anywhere; }
[data-local-sdk] .local-response :is(.vc-text, pre) { white-space: pre-wrap; }
[data-local-sdk] .local-response a { color: var(--desktop-accent); }
[data-local-sdk] .local-response .vc-markdown > :first-child { margin-top: 0; }
[data-local-sdk] .local-response .vc-markdown > :last-child { margin-bottom: 0; }
[data-local-sdk] .local-response :is(.vc-markdown-table, pre) { max-width: 100%; overflow: auto; }
[data-local-sdk] .local-response table { border-collapse: collapse; }
[data-local-sdk] .local-response :is(th, td) { border: 1px solid var(--desktop-line); padding: 3px 7px; }
[data-local-sdk] .local-response blockquote { margin-inline: 0; padding-inline-start: 10px; border-inline-start: 2px solid var(--desktop-line); }
[data-local-sdk] .local-response .standalone-code { padding: 6px 10px; border: 1px solid var(--desktop-line); border-radius: 8px; }
[data-local-sdk] .local-turn-status { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
[data-local-sdk] .local-muted { color: var(--desktop-muted); font-size: 12px; }
[data-local-sdk] .local-alert { color: var(--desktop-accent); font-size: 12px; overflow-wrap: anywhere; }
[data-local-sdk] .local-composer { padding-block: 6px 12px; }
[data-local-sdk] .local-composer-box { padding: 6px; border: 1px solid var(--desktop-line); border-radius: 12px; }
[data-local-sdk] .local-composer textarea {
  display: block; width: 100%; min-height: 52px; resize: vertical; max-height: min(33vh, 240px);
  padding: 5px 6px; border: 0; border-radius: 6px; background: transparent;
}
[data-local-sdk] .local-composer textarea::placeholder { color: var(--desktop-muted); }
[data-local-sdk] .local-composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 5px; padding-top: 4px; }
[data-local-sdk] .local-composer-note { margin: 0 0 4px; }
[data-local-sdk] .local-primary:not(:disabled) { background: var(--desktop-active); color: var(--desktop-accent); font-weight: 650; }
[data-local-sdk] .local-options {
  width: min(420px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow: auto;
  padding: 14px; border: 1px solid var(--desktop-line); border-radius: 12px;
  background: var(--desktop-surface); color: var(--desktop-ink); box-shadow: var(--desktop-shadow);
}
[data-local-sdk] .local-options::backdrop { background: #26190e4d; }
[data-local-sdk] .local-option-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
[data-local-sdk] .local-option-heading h2 { margin: 0; font-size: 17px; }
[data-local-sdk] .local-options label { display: grid; gap: 3px; min-width: 0; }
[data-local-sdk] .local-options :is(p, dl) { margin: 6px 0; }
[data-local-sdk] .local-options :is(select, input) {
  width: 100%; min-width: 0; min-height: 33px; border: 1px solid var(--desktop-line);
  background: var(--desktop-surface); padding: 3px 6px; border-radius: 6px;
}
[data-local-sdk] .local-options hr { margin: 12px 0; border: 0; border-block-start: 1px solid var(--desktop-line); }
[data-local-sdk] .local-config-details { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; }
[data-local-sdk] .local-config-details dd { margin: 0; overflow-wrap: anywhere; }
[data-local-sdk] .local-register { display: grid; gap: 8px; }
[data-local-sdk] .local-register h3 { margin: 0; font-size: 14px; }
[data-local-sdk] .local-register-row { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 8px; }
[data-local-sdk] .local-register .vc-button { justify-self: start; }
[data-local-sdk] .vc-history-toggle, [data-local-sdk] .local-rail-scrim { display: none; }
@media (width > 620px) {
  [data-sidebar-collapsed=true] [data-local-sdk] { --local-rail-width: 0px; }
  [data-sidebar-collapsed=true] [data-local-sdk] .vc-rail { visibility: hidden; }
}
@media (max-width: 620px) {
  [data-local-sdk] { grid-template-columns: minmax(0, 1fr); }
  [data-local-sdk] .vc-history-toggle { display: inline-flex; padding-inline: 7px; }
  [data-local-sdk] .local-header { justify-content: space-between; }
  [data-local-sdk] .local-heading { flex-basis: auto; }
  [data-local-sdk] .local-actions { margin-inline-start: auto; }
  [data-local-sdk] .vc-rail { display: none; }
  [data-local-sdk][data-history-open=true] .vc-rail {
    display: flex; position: absolute; inset: 0 auto 0 0; z-index: 2; box-shadow: var(--desktop-shadow);
  }
  [data-local-sdk][data-history-open=true] .local-rail-scrim {
    display: block; position: absolute; inset: 0; z-index: 1;
    border: 0; background: #26190e42; cursor: pointer;
  }
}
`;
