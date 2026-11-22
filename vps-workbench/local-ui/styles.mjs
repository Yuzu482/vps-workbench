import { chatSurfaceCss } from '../../remote-workbench/vps-chat/client/workbench-theme.js';
import { settingsCss } from '../../remote-workbench/vps-chat/client/settings-style.js';

export const localWorkspaceStyles = `
${(chatSurfaceCss() + settingsCss).replaceAll('[data-vps-chat]', '[data-local-sdk]')}
[data-local-sdk] .local-history-group { display: grid; grid-template-columns: minmax(0, 1fr); }
[data-local-sdk] .local-history-group .vc-rail-label { margin: 6px 0 2px; overflow-wrap: anywhere; }
[data-local-sdk] .vc-composer-option:is([data-control=access], [data-control=model])::after { content: none; }
[data-local-sdk] .vc-composer-option .vc-option-label { white-space: nowrap; }
[data-local-sdk] .vc-composer-option[data-control=access] .vc-option-label { display: inline; }
[data-local-sdk] .local-muted { color: var(--vc-muted); font-size: 12px; }
[data-local-sdk] .local-config-details {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0;
}
[data-local-sdk] .local-config-details dt { color: var(--vc-muted); }
[data-local-sdk] .local-config-details dd { margin: 0; overflow-wrap: anywhere; }
[data-local-sdk] .local-rail-scrim { display: none; }
@media (max-width: 620px) {
  [data-local-sdk] .local-rail-scrim {
    display: block; position: absolute; z-index: 3; inset: 0 0 var(--desktop-actions-height) 0;
    border: 0; background: transparent;
  }
}
`;
