import { menuIcon } from './menu-icons.js';
import { afterPopupMotion } from './menu-motion.js';
import { createAdvancedModelOptions } from './advanced-model-options.js';
import { effortName } from './model-catalog.js';

export { effortName, readModelCatalog, validTurnMetadata } from './model-catalog.js';

const numbers = new Intl.NumberFormat('zh-CN');
const percentages = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const panelNames = { mode: '模式', model: '模型', access: '访问权限', plugins: '插件模板', memory: '会话记忆' };
const scopedWorkspaceProviders = new Set(['codex', 'antigravity']);
const workspaceChoices = [
  ['default', '执行端默认', '沿用执行端的沙箱规则'],
  ['read-only', '强制只读', '以只读方式挂载原项目，仍可运行只读命令'],
  ['isolated', '隔离项目文件', '用空的只读目录替代原项目'],
];
export function reportedTurnSettings(turns, submitting) {
  const result = { usage: null, usageModel: null, earlierUsage: false, model: null, effort: null };
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (!result.usage && turn.contextUsage) {
      result.usage = turn.contextUsage;
      result.usageModel = turn.model;
      result.earlierUsage = submitting || index !== turns.length - 1;
    }
    if (!result.model && turn.model) {
      result.model = turn.model;
      result.effort = turn.effort;
    }
    if (result.usage && result.model) break;
  }
  return result;
}

export const composerControlsCss = `
  [data-vps-chat] :is(.vc-composer,.vc-composer-panel,.vc-design-materials) {
    --vc-surface:#252d2a; --vc-canvas:#1d2521; --vc-ink:#e9eeeb; --vc-muted:#acbbb3;
    --vc-line:#3b4942; --vc-line-strong:#667970; --vc-hover:#33413a; --vc-tint:#374d42;
    --vc-accent:#b5dac5; --vc-on-accent:#22352b; --vc-shadow:0 9px 24px #0a171462;
    --vc-warn:#ffccab; --vc-warn-bg:#483329;
    color-scheme:dark; color:var(--vc-ink);
  }
  [data-vps-chat] .vc-composer {
    container-type:inline-size; display:grid; gap:6px; min-width:0; padding:10px 12px;
    border:1px solid var(--vc-line); border-radius:17px; background:var(--vc-surface);
    box-shadow:0 4px 12px #15221d16;
  }
  [data-vps-chat] .vc-composer:focus-within {border-color:var(--vc-line-strong)}
  [data-vps-chat] .vc-composer textarea {
    field-sizing:content; min-height:38px; max-height:min(165px,27vh); width:100%;
    resize:none; overflow:auto; border:0; outline:none; background:transparent; padding:5px 3px;
    caret-color:var(--vc-accent); line-height:1.48;
  }
  [data-vps-chat] .vc-composer textarea::placeholder {color:var(--vc-muted)}
  [data-vps-chat] .vc-composer-toolbar {display:flex; align-items:center; justify-content:space-between; gap:5px 10px; min-width:0}
  [data-vps-chat] .vc-composer-tools {display:flex; flex:none; align-items:center; gap:3px}
  [data-vps-chat] .vc-composer-end {
    display:flex; align-items:center; justify-content:flex-end; gap:3px; min-width:0; max-width:100%; margin-inline-start:auto;
  }
  [data-vps-chat] .vc-composer-option {
    display:inline-flex; align-items:center; gap:5px; min-height:34px; min-width:0; max-width:100%; padding:3px 8px;
    border:1px solid transparent; border-radius:8px; background:transparent; color:var(--vc-muted); font-size:12px;
    transition:background-color var(--vc-control-duration) ease,color var(--vc-control-duration) ease;
  }
  [data-vps-chat] .vc-composer-option[data-control=model] {color:var(--vc-ink)}
  [data-vps-chat] .vc-composer-option[data-control=mode][data-design=true] {color:var(--vc-accent)}
  [data-vps-chat] .vc-composer-option[aria-expanded=true] {background:var(--vc-hover); color:var(--vc-accent)}
  [data-vps-chat] .vc-composer-option:is([data-control=mode],[data-control=model],[data-control=access])::after {
    content:''; flex:none; width:5px; height:5px; margin-top:-3px; transform:rotate(45deg);
    border:solid currentColor; border-width:0 1.5px 1.5px 0;
    transition:transform var(--vc-control-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-composer-option[aria-expanded=true]::after {transform:rotate(225deg)}
  [data-vps-chat] .vc-composer-option[data-control=access][data-browse=true] {color:var(--vc-accent)}
  [data-vps-chat] .vc-option-label {min-width:0; text-overflow:ellipsis; overflow:hidden}
  [data-vps-chat] .vc-composer-option[data-control=model] .vc-option-label {max-width:clamp(52px,26cqi,178px)}
  [data-vps-chat] .vc-context-indicator {display:grid; place-items:center; flex:none; width:30px; height:34px; cursor:help}
  [data-vps-chat] .vc-composer-materials {color:var(--vc-accent)}
  [data-vps-chat] .vc-composer-add {font-size:19px; line-height:1; font-weight:500}
  [data-vps-chat] .vc-context-meter {
    width:13px; height:13px; flex:none; border-radius:50%;
    background:conic-gradient(var(--vc-accent) var(--vc-used),var(--vc-line-strong) 0);
    mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1px));
  }
  [data-vps-chat] .vc-option-effort {flex:none; color:var(--vc-muted); font-size:11px; font-weight:500}
  [data-vps-chat] .vc-compose-buttons {display:flex; flex:none; align-items:center; gap:5px; margin-inline-start:4px}
  [data-vps-chat] .vc-compose-action {min-height:34px; border-color:transparent; border-radius:10px; font-size:12px}
  [data-vps-chat] .vc-compose-icon-button {display:grid; place-items:center; width:34px; padding:0}
  [data-vps-chat] .vc-compose-stop {color:var(--vc-accent); background:var(--vc-tint)}
  [data-vps-chat] .vc-compose-icon {position:relative; width:15px; height:15px}
  [data-vps-chat] .vc-compose-icon::before {
    position:absolute; content:''; inset:4px; border-radius:1px; background:currentColor;
  }
  [data-vps-chat] .vc-compose-icon[data-symbol=send]::before {inset:3px 6.5px 0}
  [data-vps-chat] .vc-compose-icon[data-symbol=send]::after {
    position:absolute; content:''; inset:2px 3px 4px; transform:rotate(45deg);
    border:solid currentColor; border-width:2px 0 0 2px; border-radius:1px;
  }
  [data-vps-chat] .vc-compose-hint {margin:6px 2px 0; color:var(--vc-muted); font-size:11px; text-align:end}
  @container (max-width:355px) {
    [data-vps-chat] .vc-composer-option {gap:4px; padding-inline:5px}
    [data-vps-chat] .vc-composer-option[data-control=access] .vc-option-label {display:none}
    [data-vps-chat] .vc-composer-materials {width:30px; justify-content:center}
    [data-vps-chat] :is(.vc-composer-materials .vc-option-label,.vc-option-effort) {display:none}
    [data-vps-chat] .vc-composer-toolbar {gap:5px}
    [data-vps-chat] .vc-composer-toolbar[data-wide-actions=true] {flex-wrap:wrap}
  }
  [data-vps-chat] .vc-answer-model {
    font-size:12px; color:var(--vc-accent); overflow-wrap:anywhere; max-width:100%;
  }
  [data-vps-chat] .vc-settings.vc-composer-panel {
    position:fixed; inset:auto; margin:0; width:354px; max-width:calc(100vw - 20px);
    padding:14px; border-radius:14px; box-shadow:var(--vc-shadow); overscroll-behavior:contain;
  }
  [data-vps-chat] .vc-composer-panel.vc-context-tooltip {width:306px; padding:11px 12px}
  [data-vps-chat] .vc-settings.vc-composer-panel[data-kind=model] {width:300px; padding:10px 12px}
  [data-vps-chat] .vc-composer-panel-heading {display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:9px}
  [data-vps-chat] .vc-composer-panel::backdrop {background:transparent; pointer-events:none}
  [data-vps-chat] .vc-composer-panel-heading h2 {margin:0; font-size:15px; font-weight:650}
  [data-vps-chat] .vc-composer-panel-close {min-height:24px; padding:0 6px; border-color:transparent; color:var(--vc-muted); font-size:16px}
  [data-vps-chat] .vc-composer-panel p {margin-bottom:10px; font-size:12px}
  [data-vps-chat] .vc-composer-panel > :last-child {margin-bottom:0}
  [data-vps-chat] .vc-composer-panel dl {
    display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 12px; margin:10px 0; font-size:12px;
  }
  [data-vps-chat] .vc-composer-panel dt {color:var(--vc-muted)}
  [data-vps-chat] .vc-composer-panel dd {margin:0; overflow-wrap:anywhere}
  [data-vps-chat] .vc-model-list {
    position:relative; display:grid; gap:2px; max-height:min(260px,42vh); padding:2px;
    margin-top:7px; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin;
  }
  [data-vps-chat] .vc-model-choice {
    position:relative; border-radius:7px; font-size:12px; cursor:pointer;
    display:grid; grid-template-columns:16px minmax(0,1fr) 16px; align-items:center;
    gap:8px; min-height:34px; padding:5px 8px; overflow-wrap:anywhere;
  }
  [data-vps-chat] .vc-model-choice input {
    position:absolute; inset-block-start:50%; inset-inline-start:8px;
    width:1px; height:1px; margin:0; clip-path:inset(50%);
  }
  [data-vps-chat] .vc-model-choice:hover:not(:has(input:disabled)) {background:var(--vc-hover)}
  [data-vps-chat] .vc-model-choice:has(input:checked) {background:var(--vc-tint); color:var(--vc-accent)}
  [data-vps-chat] .vc-model-choice:has(input:focus-visible) {
    outline:2px solid var(--vc-accent); outline-offset:-2px;
  }
  [data-vps-chat] .vc-model-choice:has(input:disabled) {cursor:default}
  [data-vps-chat] .vc-model-choice small {display:block; margin-top:2px; color:var(--vc-muted); font-size:11px}
  [data-vps-chat] .vc-model-header {
    display:grid; grid-template-columns:minmax(48px,1fr) minmax(0,auto) minmax(48px,1fr);
    align-items:start; gap:4px; margin-bottom:4px;
  }
  [data-vps-chat] .vc-model-mark {display:grid; place-items:center; width:26px; height:24px; color:var(--vc-muted)}
  [data-vps-chat] .vc-model-actions {display:flex; align-items:center; justify-self:end}
  [data-vps-chat] .vc-model-trigger {
    display:grid; justify-items:center; justify-self:center; min-width:0; max-width:100%; padding:3px 8px; gap:2px;
    border-color:transparent; background:transparent; border-radius:7px; text-align:center;
  }
  [data-vps-chat] .vc-effort-current {color:var(--vc-accent); font-size:14px; line-height:1.2; font-weight:650}
  [data-vps-chat] .vc-model-trigger-name {
    display:flex; align-items:center; justify-content:center; gap:5px; min-width:0; max-width:100%;
    color:var(--vc-muted); font-size:12px; font-weight:500;
  }
  [data-vps-chat] .vc-model-trigger-label {overflow:hidden; text-overflow:ellipsis}
  [data-vps-chat] .vc-model-trigger-name::after {
    content:''; flex:none; width:4px; height:4px; margin-top:-2px;
    border:solid currentColor; border-width:0 1.5px 1.5px 0; transform:rotate(45deg);
    transition:transform var(--vc-popup-duration) var(--vc-motion-curve),
      margin-top var(--vc-popup-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-model-trigger[aria-expanded=true] .vc-model-trigger-name::after {margin-top:2px; transform:rotate(225deg)}
  [data-vps-chat] .vc-model-trigger:disabled .vc-model-trigger-name::after {display:none}
  [data-vps-chat] .vc-model-actions .vc-button {
    display:grid; place-items:center; width:24px; min-height:24px; padding:0;
    border-color:transparent; background:transparent; color:var(--vc-muted); font-size:16px;
  }
  [data-vps-chat] .vc-effort-scale {
    position:relative; display:grid; align-items:center; margin-top:4px; --vc-thumb-radius:11px;
    --vc-slider-motion:var(--vc-slider-duration);
    transition:--vc-effort-used var(--vc-slider-motion) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-effort-scale:has(input:active:not(:disabled)) {--vc-slider-motion:var(--vc-slider-drag-duration)}
  [data-vps-chat] .vc-effort-scale:has(input:disabled) {opacity:.6}
  [data-vps-chat] .vc-effort-track {
    position:absolute; inset-inline:0; top:50%; height:20px; transform:translateY(-50%);
    border-radius:100px; background:#3b4a43; pointer-events:none; overflow:hidden;
  }
  [data-vps-chat] .vc-effort-progress {position:absolute; inset:0 var(--vc-thumb-radius)}
  [data-vps-chat] .vc-effort-progress::before {
    content:''; position:absolute; inset-block:0; inset-inline-start:calc(-1 * var(--vc-thumb-radius));
    width:calc(var(--vc-effort-used) + var(--vc-thumb-radius));
    background:#749e88;
  }
  [data-vps-chat] .vc-effort-steps {
    position:absolute; inset-inline:calc(var(--vc-thumb-radius) - 2px); top:50%; transform:translateY(-50%);
    display:flex; justify-content:space-between; pointer-events:none;
  }
  [data-vps-chat] .vc-effort-steps span {
    width:4px; height:4px; border-radius:50%; background:#84968b;
    transition:background-color var(--vc-control-duration) ease;
  }
  [data-vps-chat] .vc-effort-steps span[data-used=true] {background:#c8dfd3}
  [data-vps-chat] .vc-effort-thumb-lane {
    position:absolute; inset:0 var(--vc-thumb-radius); pointer-events:none;
  }
  [data-vps-chat] .vc-effort-thumb {
    position:absolute; top:50%; inset-inline-start:var(--vc-effort-used); translate:-50% -50%;
    width:calc(2 * var(--vc-thumb-radius)); height:calc(2 * var(--vc-thumb-radius)); border-radius:50%;
    background:#edf5ef; box-shadow:0 1px 4px #101a1499;
    transition:scale var(--vc-control-duration) var(--vc-motion-curve);
  }
  [data-vps-chat] .vc-effort-scale:has(input:hover:not(:disabled)) .vc-effort-thumb {scale:1.06}
  [data-vps-chat] .vc-effort-scale:has(input:active:not(:disabled)) .vc-effort-thumb {scale:1.1}
  [data-vps-chat] .vc-effort-slider {
    position:relative; appearance:none; width:100%; min-width:0; height:28px;
    margin:0; padding:0; border:0; border-radius:100px; background:transparent; cursor:pointer;
  }
  [data-vps-chat] .vc-effort-slider::-webkit-slider-runnable-track {
    height:20px; background:transparent;
  }
  [data-vps-chat] .vc-effort-slider::-webkit-slider-thumb {
    appearance:none; width:calc(2 * var(--vc-thumb-radius)); height:calc(2 * var(--vc-thumb-radius)); margin-top:-1px; border-radius:50%;
    opacity:0;
  }
  [data-vps-chat] .vc-effort-slider:disabled {cursor:default}
  [data-vps-chat] .vc-composer-panel progress {
    display:block; width:100%; height:6px; margin:0 0 10px; border:0; border-radius:6px; overflow:hidden; accent-color:var(--vc-accent);
  }
  [data-vps-chat] .vc-composer-panel progress::-webkit-progress-bar {background:var(--vc-hover)}
  [data-vps-chat] .vc-composer-panel progress::-webkit-progress-value {background:var(--vc-accent)}
  [data-vps-chat] .vc-mode-options {display:grid; gap:5px; margin:0}
  [data-vps-chat] .vc-mode-options button {
    display:flex; justify-content:space-between; align-items:center; gap:8px;
    border-color:transparent; background:transparent; text-align:start;
  }
  [data-vps-chat] .vc-mode-options button[aria-pressed=true] {color:var(--vc-accent); background:var(--vc-tint)}
  [data-vps-chat] .vc-mode-detail {display:flex; align-items:center; gap:6px; color:var(--vc-muted); font-size:12px}
  [data-vps-chat] .vc-mode-options button[aria-pressed=false] .vc-menu-icon[data-icon=check] {visibility:hidden}
  [data-vps-chat] .vc-access-heading {margin:10px 0 4px; font-size:12px; color:var(--vc-muted)}
  [data-vps-chat] .vc-access-options button {width:100%; white-space:normal;}
  [data-vps-chat] .vc-access-options button small {display:block; color:var(--vc-muted); font-weight:400}
`;

function occupancy(usage) {
  if (!usage?.contextWindow) return null;
  const value = usage.usedTokens / usage.contextWindow;
  return value > 0 && value < 0.001 ? '<0.1%' : percentages.format(value);
}

function panelBoundary(anchor) {
  return anchor.closest('.vc-canvas') ?? anchor.closest('.vc-conversation');
}

function positionPanel(dialog, anchor) {
  const { left, right, top, bottom } = panelBoundary(anchor).getBoundingClientRect();
  const button = anchor.getBoundingClientRect();
  const start = Math.max(left, 0) + 10;
  const end = Math.min(right, window.innerWidth) - 10;
  const above = button.top - Math.max(top, 0) - 18;
  const below = Math.min(bottom, window.innerHeight) - button.bottom - 18;
  const opensAbove = above >= below;
  dialog.dataset.side = opensAbove ? 'above' : 'below';
  dialog.style.maxWidth = `${Math.max(0, end - start)}px`;
  dialog.style.maxHeight = `${Math.max(0, opensAbove ? above : below)}px`;
  dialog.style.left = `${Math.max(start, Math.min(button.left, end - dialog.offsetWidth))}px`;
  dialog.style.top = `${opensAbove ? button.top - dialog.offsetHeight - 8 : button.bottom + 8}px`;
}

export function createComposerControls(React) {
  const h = React.createElement;
  const AdvancedModelOptions = createAdvancedModelOptions(React);

  function AccessTrigger({ access, provider, expanded, open, localSdk }) {
    const label = access.mode === 'browse' ? '仅浏览' : localSdk ? '本机执行' : (scopedWorkspaceProviders.has(provider) &&
      workspaceChoices.find(([id]) => access.workspace !== 'default' && id === access.workspace)?.[1]) || 'VPS 执行';
    return h('button', {
      type: 'button', className: 'vc-button vc-composer-option', 'data-control': 'access', 'data-browse': access.mode === 'browse',
      'aria-label': '访问权限', 'aria-description': label, 'aria-expanded': expanded, 'aria-haspopup': 'dialog',
      title: `访问权限 · ${label}`, onClick: (event) => open('access', event.currentTarget),
    }, menuIcon(h, 'access'), h('span', { className: 'vc-option-label' }, label));
  }

  function Toolbar({ panel, open, openMaterials, materialsDisabled, available, mode, report, attached, selection, catalog,
    wideActions, showModeIcon, accessButton, hasPluginPrompts, templateLabel, memoryMode, historyButton, children, localSdk }) {
    const tooltipId = React.useId();
    const tooltipRef = React.useRef(null);
    const dismissTimer = React.useRef(0);
    const [contextAnchor, setContextAnchor] = React.useState(null);
    const showTooltip = Boolean(contextAnchor && !panel);
    const clearTooltip = React.useCallback(() => {
      clearTimeout(dismissTimer.current);
      setContextAnchor(null);
    }, []);
    React.useEffect(() => () => clearTimeout(dismissTimer.current), []);

    function keepTooltip() {
      clearTimeout(dismissTimer.current);
    }

    function showContext(anchor) {
      keepTooltip();
      setContextAnchor(anchor);
      const tooltip = tooltipRef.current;
      if (tooltip && !tooltip.matches(':popover-open')) tooltip.showPopover({ source: anchor });
    }

    function hideTooltip() {
      keepTooltip();
      const tooltip = tooltipRef.current;
      if (tooltip?.matches(':popover-open')) tooltip.hidePopover();
      else if (!tooltip) clearTooltip();
    }

    function dismissTooltipSoon() {
      keepTooltip();
      dismissTimer.current = window.setTimeout(hideTooltip, 160);
    }

    const { usage } = report;
    const contextTitle = usage
      ? `${report.earlierUsage ? '上次上下文用量' : '上下文'} ${occupancy(usage) ?? `${numbers.format(usage.usedTokens)} tokens`}` : undefined;
    const used = usage?.contextWindow ? Math.min(100, usage.usedTokens * 100 / usage.contextWindow) : 0;
    const chosen = catalog?.models?.find((entry) => entry.id === selection?.id);
    const reported = catalog?.models?.find((entry) => entry.id === report.model);
    const modeName = mode === 'design' ? '设计' : '对话';
    const modelName = chosen?.displayName ?? selection?.id ?? reported?.displayName ?? report.model;
    const effort = selection ? selection.effort ?? chosen?.defaultEffort : report.effort;
    const modelTitle = modelName && effort ? `${modelName} · ${effortName(effort)}` : modelName;
    const option = (key, description, ...contents) => h('button', {
        type: 'button', className: 'vc-button vc-composer-option',
        'aria-label': key === 'plugins' && templateLabel || panelNames[key],
        'aria-haspopup': 'dialog', 'aria-expanded': panel === key, 'data-control': key, 'data-design': mode === 'design',
        'aria-description': description, disabled: !available,
        onClick: (event) => open(key, event.currentTarget), title: description ?? panelNames[key],
      }, ...contents);

    return h('div', { className: 'vc-composer-toolbar', role: 'group', 'aria-label': '发送设置', 'data-wide-actions': wideActions },
      h('div', { className: 'vc-composer-tools' },
        historyButton,
        openMaterials ? h('button', {
          type: 'button', className: 'vc-button vc-composer-option vc-composer-materials', 'aria-haspopup': 'dialog',
          'aria-label': '添加设计资料', title: '添加设计资料', onClick: openMaterials, disabled: materialsDisabled,
        }, h('span', { className: 'vc-composer-add', 'aria-hidden': true }, '+'),
        h('span', { className: 'vc-option-label' }, '资料')) : null,
        option('mode', modeName, showModeIcon ? menuIcon(h, mode === 'design' ? 'canvas' : 'chat') : null,
          h('span', { className: 'vc-option-label' }, modeName)), accessButton,
        memoryMode ? option('memory', memoryMode, menuIcon(h, 'library'),
          h('span', { className: 'vc-option-label' }, memoryMode)) : null,
        hasPluginPrompts ? option('plugins', '插入提示词', menuIcon(h, 'library'),
          h('span', { className: 'vc-option-label' }, templateLabel ?? '插件')) : null),
      h('div', { className: 'vc-composer-end' },
        h('span', {
          className: 'vc-context-indicator', role: 'img', 'data-control': 'context', 'aria-label': '上下文用量',
          'aria-description': contextTitle, 'aria-describedby': showTooltip ? tooltipId : undefined,
          onPointerEnter: (event) => { if (event.pointerType !== 'touch') showContext(event.currentTarget); },
          onPointerLeave: dismissTooltipSoon,
        },
          h('span', { className: 'vc-context-meter', 'aria-hidden': true, style: { '--vc-used': `${used}%` } })),
        option('model', modelTitle, h('span', { className: 'vc-option-label' }, modelName ?? '模型'),
          modelName && effort ? h('span', { className: 'vc-option-effort' }, effortName(effort)) : null),
        children),
      showTooltip ? h(Panel, {
        kind: 'context', tooltip: true, id: tooltipId, anchor: contextAnchor, close: clearTooltip, report, attached, mode, localSdk,
        surfaceRef: tooltipRef,
        onPointerEnter: keepTooltip, onPointerLeave: dismissTooltipSoon,
      }) : null);
  }

  function ContextDetails({ report, attached, design, localSdk }) {
    const { usage, usageModel, earlierUsage } = report;
    const percent = occupancy(usage);
    const source = localSdk ? '本机执行端' : 'VPS';
    return h(React.Fragment, null,
      usage ? h(React.Fragment, null,
        h('dl', null,
          h('dt', null, '数据来源'), h('dd', null, (earlierUsage ? '较早轮次的 ' : '当前轮次的 ') + source + ' 报告'),
          h('dt', null, '已用'), h('dd', null, `${numbers.format(usage.usedTokens)} tokens`),
          h('dt', null, '上下文窗口'), h('dd', null, usage.contextWindow === null ? source + ' 尚未报告' : `${numbers.format(usage.contextWindow)} tokens`),
          percent ? h(React.Fragment, null, h('dt', null, '占用比例'), h('dd', null, percent)) : null,
          usageModel ? h(React.Fragment, null, h('dt', null, '报告模型'), h('dd', null, usageModel)) : null),
        percent ? h('progress', {
          'aria-label': '上下文占用', max: usage.contextWindow, value: Math.min(usage.usedTokens, usage.contextWindow),
          'aria-valuetext': `${numbers.format(usage.usedTokens)} / ${numbers.format(usage.contextWindow)} tokens`,
        }) : null,
        earlierUsage ? h('p', null, '当前轮次尚未报告用量。') : null) : h('p', null, '尚无 ' + source + ' 上下文用量报告。'),
      design ? h('dl', null, h('dt', null, '待发送设计资料'),
        h('dd', null, attached?.error || (attached?.labels?.length ? attached.labels.join('、') : '未选中'))) : null);
  }

  function ModeChoices({ mode, designAvailable, canChangeMode, empty, change }) {
    return h(React.Fragment, null,
      h('p', null, empty ? '可切换当前草稿的工作方式。' : '切换会打开新会话，现有会话保留原模式。'),
      h('div', { className: 'vc-mode-options', role: 'group', 'aria-label': '可用模式' },
        [['chat', '对话', '通用对话'], ['design', '设计', designAvailable ? '对话与画布' : '需要 Codex']].map(([value, label, hint]) =>
          h('button', {
            key: value, type: 'button', className: 'vc-button', 'aria-label': label, 'aria-pressed': mode === value,
            disabled: !canChangeMode || (value === 'design' && !designAvailable), onClick: () => change(value),
          }, h('span', { className: 'vc-menu-label' }, menuIcon(h, value === 'design' ? 'canvas' : 'chat'), label),
          h('span', { className: 'vc-mode-detail' }, hint, menuIcon(h, 'check'))))));
  }

  function AccessChoices({ access, provider, busy, change, localSdk }) {
    function choices(field, options) {
      return h('div', { className: 'vc-mode-options vc-access-options' }, options.map(([id, label, detail]) =>
        h('button', { key: id, type: 'button', className: 'vc-button', 'aria-label': label,
          'aria-pressed': access[field] === id, disabled: busy || access[field] === id,
          onClick: () => change({ ...access, [field]: id }),
        }, h('span', null, label, h('small', null, detail)), menuIcon(h, 'check'))));
    }
    return h(React.Fragment, null,
      h('h3', { className: 'vc-access-heading' }, '工作台'),
      choices('mode', [localSdk ? ['execute', '本机执行', '可向所选本机执行端发起操作'] : ['execute', 'VPS 执行', '可向当前执行端发起远端操作'],
        ['browse', '仅浏览', '查看已保存的会话与项目资源']]),
      h('h3', { className: 'vc-access-heading' }, localSdk ? '本机工作区' : 'VPS 工作区'),
        localSdk ? h('p', null, '本机执行端使用所选配置的只读工作目录。') :
        scopedWorkspaceProviders.has(provider) ? choices('workspace', workspaceChoices)
        : h('p', null, '此工具采用执行端原生的工作区权限。'));
  }

  function ModelChoices({ allowed, catalog, selection, toolDefault, followsTool, report, choose, retry, closeButton, advanced }) {
    const groupId = React.useId();
    const modelButton = React.useRef(null);
    const modelList = React.useRef(null);
    const [listOpen, setListOpen] = React.useState(false);
    const chosen = catalog?.models?.find((entry) => entry.id === selection?.id);
    const chosenId = followsTool ? '@tool-default' : chosen?.id ?? '';
    const model = chosen ?? catalog?.models?.find((entry) => report.model ? entry.id === report.model : entry.isDefault);
    const modelName = model?.displayName ?? report.model ?? '沿用会话设置';
    const levels = model?.efforts ?? [];
    const requested = chosen ? selection.effort : (report.model === model?.id ? report.effort : null);
    const effort = levels.includes(requested) ? requested : model?.defaultEffort ?? null;
    const options = model?.defaultEffort ? levels : [null, ...levels];
    const levelIndex = Math.max(0, options.indexOf(effort));
    const maxLevel = options.length - 1;
    const formatEffort = (value) => value ? effortName(value) : '默认';
    const listId = `${groupId}-models`;
    const recentModel = report.model
      ? `最近运行 ${report.model}${report.effort ? ` · ${effortName(report.effort)}` : ''}` : '';

    React.useLayoutEffect(() => {
      const panel = modelButton.current.closest('[popover]');
      const resetList = (event) => {
        if (event.newState === 'open') setListOpen(false);
      };
      panel.addEventListener('beforetoggle', resetList);
      return () => panel.removeEventListener('beforetoggle', resetList);
    }, []);

    React.useEffect(() => {
      const list = modelList.current;
      const row = list?.querySelector('input:checked')?.parentElement;
      if (!row) return;
      const bottom = row.offsetTop + row.offsetHeight - list.clientHeight;
      list.scrollTop = Math.min(row.offsetTop, Math.max(list.scrollTop, bottom));
    }, [listOpen, catalog?.models, chosenId]);

    function modelChoice(id, label, detail) {
      const checked = id === chosenId;
      return h('label', { key: id, className: 'vc-model-choice' },
        h('input', {
          type: 'radio', name: `${groupId}-model`, value: id, checked, disabled: !allowed || !listOpen,
          'aria-label': label, 'aria-description': detail || undefined,
          onChange: () => choose(id === '@tool-default' ? undefined : id, null),
        }),
        menuIcon(h, 'model'),
        h('span', null, label, detail ? h('small', null, detail) : null),
        checked ? menuIcon(h, 'check') : null);
    }

    return h('div', { onKeyDown: (event) => {
      if (event.key !== 'Escape' || !listOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setListOpen(false);
      modelButton.current?.focus({ preventScroll: true });
    } },
      h('div', { className: 'vc-model-header' },
        h('span', { className: 'vc-model-mark', 'aria-hidden': true }, menuIcon(h, 'effort')),
        h('button', {
          ref: modelButton, className: 'vc-button vc-model-trigger', type: 'button', title: modelName,
          'aria-label': `切换模型，${modelName}`, 'aria-expanded': listOpen, 'aria-controls': listId,
          disabled: !allowed || !catalog?.models?.length, onClick: () => setListOpen((open) => !open),
        }, levels.length ? h('span', { className: 'vc-effort-current' }, formatEffort(effort)) : null,
        h('span', { className: 'vc-model-trigger-name' }, h('span', { className: 'vc-model-trigger-label' }, modelName))),
        h('div', { className: 'vc-model-actions' },
          levels.length ? h('button', {
            type: 'button', className: 'vc-button', 'aria-label': '恢复模型默认', title: '恢复模型默认',
            disabled: !chosen || !selection?.effort, onClick: () => choose(chosen.id, null),
          }, '↺') : null,
          closeButton)),
      levels.length ? h('div', { className: 'vc-effort-scale',
        style: { '--vc-effort-used': `${maxLevel ? levelIndex * 100 / maxLevel : 0}%` },
      },
        h('span', { className: 'vc-effort-track', 'aria-hidden': true },
          h('span', { className: 'vc-effort-progress' }),
          maxLevel ? h('span', { className: 'vc-effort-steps' },
            options.map((_, index) => h('span', { key: index, 'data-used': index <= levelIndex }))) : null),
        h('span', { className: 'vc-effort-thumb-lane', 'aria-hidden': true }, h('span', { className: 'vc-effort-thumb' })),
        h('input', {
          type: 'range', className: 'vc-effort-slider', min: 0, max: maxLevel, step: 1, value: levelIndex,
          'aria-label': '思考强度', 'aria-valuetext': formatEffort(effort), disabled: !allowed || maxLevel === 0,
          onChange: (event) => choose(model.id, options[Number(event.target.value)] ?? null),
        }))
        : model ? h('p', null, '此模型沿用 VPS 的思考设置。') : null,
      !allowed ? h('p', null, '当前执行端沿用会话设置。') : null,
      allowed && !model && catalog?.models?.some((entry) => entry.efforts.length) ? h('p', null, '选择模型后可调整思考强度。') : null,
      h('div', {
        className: 'vc-model-disclosure vc-disclosure-motion', 'data-expanded': listOpen, inert: !listOpen, 'aria-hidden': !listOpen,
      },
        h('div', { className: 'vc-disclosure-clip' },
          h('div', { ref: modelList, id: listId, className: 'vc-model-list', role: 'radiogroup', 'aria-label': '模型选择' },
            toolDefault ? modelChoice('@tool-default', '使用执行端默认',
              catalog?.models?.find(({ id }) => id === toolDefault.id)?.displayName ?? toolDefault.id) : null,
            modelChoice('', '沿用会话设置', recentModel),
            catalog?.models?.map((entry) => modelChoice(entry.id, entry.displayName, entry.isDefault ? 'VPS 默认模型' : ''))))),
      allowed && catalog?.loading ? h('p', { role: 'status' }, '正在读取 VPS 模型目录。') : null,
      allowed && catalog?.error ? h('div', { className: 'vc-feedback', role: 'alert' },
        h('span', null, catalog.error),
        h('button', { type: 'button', className: 'vc-button', onClick: retry }, '重试读取模型')) : null,
      allowed && catalog?.models?.length === 0 ? h('p', null, 'VPS 当前未提供可切换的模型。') : null,
      advanced ? h(AdvancedModelOptions, { ...advanced, key: advanced.targetId }) : null);
  }

  function MemoryChoices({ isolated, automatic, projectMemorySuppressed, busy, startsNew, change, settings }) {
    const optedOut = projectMemorySuppressed && !isolated;
    const choices = [
      [false, optedOut ? '项目记忆关闭' : '跟随记忆设置', optedOut ? '移入此项目时选择了仅移动'
        : automatic ? `自动提炼并引用相关${automatic}` : '在长期记忆设置中开启自动记忆'],
      [true, '独立上下文', '使用这条会话的历史，关闭自动记忆的读取和写入'],
    ];
    return h(React.Fragment, null,
      h('div', { className: 'vc-mode-options vc-access-options' }, choices.map(([value, label, detail]) =>
        h('button', { key: label, type: 'button', className: 'vc-button', 'aria-label': label,
          'aria-pressed': isolated === value, disabled: busy || isolated === value, onClick: () => change(value),
        }, h('span', null, label, h('small', null, detail)), menuIcon(h, 'check')))),
      startsNew ? h('p', null, '切换时会打开新会话，当前聊天保留在侧栏。') : null,
      h('button', { type: 'button', className: 'vc-button', onClick: settings }, '管理长期记忆'));
  }

  function Panel({ kind, anchor, close, onExpanded, report, attached, mode, designAvailable, canChangeMode, empty, changeMode,
    modelAllowed, catalog, selection, toolDefault, followsTool, chooseModel, retryModels, advanced,
    access, accessProvider, accessBusy, changeAccess, pluginPrompts, insertPluginPrompt, templateLabel,
    memoryIsolated, automaticMemory, projectMemorySuppressed, memoryBusy, memoryStartsNew, changeMemoryMode, openMemorySettings,
    tooltip = false, id, surfaceRef, onPointerEnter, onPointerLeave, localSdk }) {
    const localRef = React.useRef(null);
    const ref = surfaceRef ?? localRef;
    React.useLayoutEffect(() => {
      const panel = ref.current;
      let cancelClose = () => {};
      const update = () => {
        if (panel.matches(':popover-open') && anchor.isConnected) positionPanel(panel, anchor);
      };
      const focusPanel = () => {
        if (!tooltip && !panel.contains(document.activeElement))
          panel.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
      };
      const focusAnchor = () => {
        const active = document.activeElement;
        if (!tooltip && (active === document.body || panel.contains(active)) && anchor.isConnected) anchor.focus({ preventScroll: true });
      };
      const prepareToggle = (event) => {
        const expanded = event.newState === 'open';
        if (expanded) {
          cancelClose();
          panel.inert = false;
        }
        onExpanded?.(anchor, expanded);
      };
      const syncPopover = (event) => {
        if (event.newState === 'open') {
          update();
          focusPanel();
          return;
        }
        if (panel.matches(':popover-open')) return;
        focusAnchor();
        panel.inert = true;
        cancelClose = afterPopupMotion(panel, () => close(anchor));
      };
      const dismissTooltip = (event) => {
        if (event.key === 'Escape' && panel.matches(':popover-open')) panel.hidePopover();
      };
      panel.addEventListener('beforetoggle', prepareToggle);
      panel.addEventListener('toggle', syncPopover);
      if (tooltip) window.addEventListener('keydown', dismissTooltip);
      panel.showPopover({ source: anchor });
      update();
      focusPanel();
      const layout = new ResizeObserver(update);
      layout.observe(panel);
      layout.observe(anchor.closest('form'));
      layout.observe(panelBoundary(anchor));
      window.addEventListener('resize', update);
      return () => {
        window.removeEventListener('resize', update);
        layout.disconnect();
        cancelClose();
        panel.removeEventListener('beforetoggle', prepareToggle);
        panel.removeEventListener('toggle', syncPopover);
        window.removeEventListener('keydown', dismissTooltip);
        if (panel.matches(':popover-open')) panel.hidePopover();
        focusAnchor();
      };
    }, [anchor, close, onExpanded, ref, tooltip]);
    const name = tooltip ? '上下文用量' : kind === 'plugins' && templateLabel || panelNames[kind];
    const closeButton = tooltip ? null : h('button', {
      type: 'button', className: 'vc-button vc-composer-panel-close', 'aria-label': '关闭', title: '关闭',
      onClick: () => ref.current.hidePopover(),
    }, '×');
    return h('div', {
      ref, id, popover: tooltip ? 'manual' : 'auto', role: tooltip ? 'tooltip' : 'dialog',
      className: `vc-settings vc-composer-panel vc-popup-motion${tooltip ? ' vc-context-tooltip' : ''}`, 'aria-label': name, 'data-kind': kind,
      onPointerEnter, onPointerLeave,
    }, kind === 'model' ? h(ModelChoices, {
      allowed: modelAllowed, catalog, selection, toolDefault, followsTool, report, choose: chooseModel, retry: retryModels, closeButton, advanced,
    }) : h(React.Fragment, null,
      h('div', { className: 'vc-composer-panel-heading' },
        h('h2', { className: 'vc-menu-label' }, menuIcon(h, kind === 'mode' ? 'effort' : ['plugins', 'memory'].includes(kind) ? 'library' : kind), name), closeButton),
      tooltip ? h(ContextDetails, { report, attached, design: mode === 'design', localSdk })
        : kind === 'access' ? h(AccessChoices, { access, provider: accessProvider, busy: accessBusy, change: changeAccess, localSdk })
          : kind === 'memory' ? h(MemoryChoices, { isolated: memoryIsolated, automatic: automaticMemory,
            projectMemorySuppressed, busy: memoryBusy,
            startsNew: memoryStartsNew, change: changeMemoryMode, settings: openMemorySettings })
          : kind === 'plugins' ? h('div', { className: 'vc-mode-options', 'aria-label': '可用模板' },
            pluginPrompts.map(({ id, title, text, plugin }) => h('button', {
              type: 'button', className: 'vc-button', key: id, onClick: () => insertPluginPrompt(text),
              'aria-description': plugin,
            }, h('span', { className: 'vc-menu-label' }, menuIcon(h, 'file'), title))))
          : h(ModeChoices, { mode, designAvailable, canChangeMode, empty, change: changeMode })));
  }

  return { Toolbar, Panel, AccessTrigger };
}
