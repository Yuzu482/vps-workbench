export const resourceStyles = `
.vc-resource-library, .vc-resource-library * { box-sizing: border-box; }
.vc-resource-library {
  width: min(1090px, calc(100vw - 48px)); height: min(760px, calc(100dvh - 88px));
  max-width: none; max-height: none; margin: auto; padding: 0; overflow: hidden;
  border: 1px solid var(--vc-line); border-radius: 18px;
  background: var(--vc-canvas); color: var(--vc-ink); box-shadow: 0 24px 80px #18100f45;
}
.vc-resource-library[open] { display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
.vc-resource-library::backdrop { background: #19120e72; }
.vc-resource-library button, .vc-resource-library input, .vc-resource-library select { font: inherit; }
.vc-resource-library :is(button, input, select, iframe, pre):focus-visible {
  outline: 2px solid var(--vc-accent); outline-offset: 2px;
}
.vc-resource-header {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 19px 24px 14px; background: var(--vc-surface);
}
.vc-resource-header h2 { margin: 0; color: var(--vc-ink); font-size: 22px; line-height: 1.25; }
.vc-resource-status { min-height: 18px; margin: 4px 0 0; color: var(--vc-muted); font-size: 12px; }
.vc-resource-library .vc-resource-button {
  min-height: 36px; padding: 6px 10px; border: 1px solid var(--vc-line); border-radius: 8px;
  background: var(--vc-surface); color: var(--vc-ink); font-size: 12px; font-weight: 600; cursor: pointer;
}
.vc-resource-library .vc-resource-button:hover:not(:disabled) { background: var(--vc-rail); }
.vc-resource-library .vc-resource-button:disabled { opacity: .5; cursor: default; }
.vc-resource-library .vc-resource-open {
  border-color: var(--vc-accent); color: var(--vc-accent);
  background: color-mix(in srgb, var(--vc-accent) 10%, var(--vc-surface));
}
.vc-resource-library .vc-resource-close { width: 36px; flex: none; padding: 0; font-size: 22px; font-weight: 400; }
.vc-resource-filters {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 180px) minmax(0, 126px); gap: 12px;
  padding: 0 24px 16px; border-bottom: 1px solid var(--vc-line); background: var(--vc-surface);
}
.vc-resource-filters label { display: grid; min-width: 0; gap: 5px; color: var(--vc-muted); font-size: 12px; }
.vc-resource-filters :is(input, select) {
  width: 100%; min-width: 0; height: 36px; padding: 0 9px; border: 1px solid var(--vc-line);
  border-radius: 8px; background: var(--vc-canvas); color: var(--vc-ink); font-size: 13px;
}
.vc-resource-filters input::placeholder { color: var(--vc-muted); }
.vc-resource-body { min-height: 0; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); }
.vc-resource-catalog, .vc-resource-detail { min-width: 0; min-height: 0; overflow: auto; padding: 18px 24px; }
.vc-resource-detail { border-inline-start: 1px solid var(--vc-line); background: var(--vc-surface); }
.vc-resource-group { margin-bottom: 22px; }
.vc-resource-group h3 { margin: 0 0 9px; color: var(--vc-ink); font-size: 14px; overflow-wrap: anywhere; }
.vc-resource-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(148px, 100%), 1fr)); gap: 10px; }
.vc-resource-library .vc-resource-card {
  position: relative; min-width: 0; overflow: hidden; border: 1px solid var(--vc-line);
  border-radius: 10px; background: var(--vc-surface);
}
.vc-resource-library .vc-resource-card:hover, .vc-resource-library .vc-resource-card:focus-within,
.vc-resource-library .vc-resource-card:has(button[aria-pressed="true"]) {
  border-color: var(--vc-accent);
}
.vc-resource-library .vc-resource-card:focus-within {
  outline: 2px solid var(--vc-accent); outline-offset: 2px;
}
.vc-resource-thumb {
  position: relative; display: grid; place-items: center; width: 100%; height: 100px; overflow: hidden;
  border-bottom: 1px solid var(--vc-line); background: var(--vc-rail); color: var(--vc-muted);
  font-size: 14px; font-weight: 600; pointer-events: none;
}
.vc-resource-thumb[data-kind="design"] { background: color-mix(in srgb, var(--vc-accent) 9%, var(--vc-rail)); }
.vc-resource-thumb iframe {
  position: absolute; top: 0; left: 0; width: 250%; height: 250%; transform: scale(.4);
  transform-origin: top left; background: #fff; border: 0; pointer-events: none;
}
.vc-resource-thumb img { display: block; width: 100%; height: 100px; object-fit: contain; }
.vc-resource-thumb pre {
  place-self: start stretch; min-width: 0; max-height: 100%; margin: 0; padding: 10px;
  overflow: hidden; white-space: pre; color: var(--vc-muted); font: 11px/1.45 Consolas, monospace;
}
.vc-resource-library .vc-resource-card-copy {
  display: grid; width: 100%; min-width: 0; gap: 4px; padding: 9px 10px;
  border: 0; background: transparent; text-align: start; cursor: pointer;
}
.vc-resource-library .vc-resource-card-copy:focus-visible { outline: none; }
.vc-resource-card-copy::after { position: absolute; inset: 0; content: ''; }
.vc-resource-card-copy[aria-pressed="true"] {
  background: color-mix(in srgb, var(--vc-accent) 10%, var(--vc-surface));
}
.vc-resource-card-copy strong, .vc-resource-card-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-resource-card-copy strong { color: var(--vc-ink); font-size: 13px; }
.vc-resource-card-copy span { color: var(--vc-muted); font-size: 11px; }
.vc-resource-detail h3 { margin: 0; font-size: 17px; color: var(--vc-ink); overflow-wrap: anywhere; }
.vc-resource-detail-meta { margin: 5px 0 0; color: var(--vc-muted); font-size: 12px; overflow-wrap: anywhere; }
.vc-resource-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
.vc-resource-copy-status { color: var(--vc-muted); font-size: 12px; }
.vc-resource-preview {
  overflow: hidden; border: 1px solid var(--vc-line); border-radius: 9px; background: var(--vc-rail);
}
.vc-resource-preview iframe { display: block; width: 100%; height: clamp(240px, 47dvh, 460px); border: 0; background: #fff; }
.vc-resource-preview img { display: block; max-width: 100%; max-height: 440px; margin: auto; object-fit: contain; }
.vc-resource-preview pre {
  min-height: 100px; max-height: 460px; margin: 0; padding: 14px; overflow: auto;
  color: var(--vc-ink); font: 12px/1.6 Consolas, monospace; tab-size: 2;
}
.vc-resource-empty {
  display: grid; min-height: 112px; place-items: center; padding: 18px; border: 1px dashed var(--vc-line);
  border-radius: 10px; color: var(--vc-muted); text-align: center; font-size: 13px;
}
.vc-resource-library .vc-resource-retry { margin: 4px 0 13px; }
.vc-resource-pages { display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--vc-muted); font-size: 12px; }
@media (max-width: 760px) {
  .vc-resource-library { width: calc(100vw - 24px); height: calc(100dvh - 72px); }
  .vc-resource-header, .vc-resource-filters, .vc-resource-catalog, .vc-resource-detail { padding-inline: 14px; }
  .vc-resource-body { display: block; overflow: auto; }
  .vc-resource-catalog, .vc-resource-detail { overflow: visible; }
  .vc-resource-detail { border-inline-start: 0; border-top: 1px solid var(--vc-line); }
}
@media (max-width: 480px) {
  .vc-resource-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .vc-resource-filters label:first-child { grid-column: 1 / -1; }
}
`;
