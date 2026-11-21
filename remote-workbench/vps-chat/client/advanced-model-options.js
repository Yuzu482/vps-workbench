import { menuIcon } from './menu-icons.js';
import { outputTokenRange, parameterLevels, validModelParameters } from './model-parameters.js';
import { workbenchStorage } from './workbench-storage.js';

export const modelParametersKey = (targetId) => `dsh-vps-chat:model-parameters:v1:${targetId}`;

export function readStoredModelParameters(targetId, provider) {
  try {
    const raw = workbenchStorage.getItem(modelParametersKey(targetId));
    if (raw === null) return {};
    const value = JSON.parse(raw);
    return validModelParameters(provider, value) ? value : null;
  } catch { return null; }
}

export function createAdvancedModelOptions(React) {
  const h = React.createElement;
  const scaleNames = { reasoningEffort: ['低', '中', '高'], verbosity: ['简洁', '标准', '详细'] };
  const labels = { reasoningEffort: '思考强度', verbosity: '回答详略', maxOutputTokens: '输出 Token 上限' };

  return function AdvancedModelOptions({ provider, availability, values, apply, retry }) {
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const fields = availability?.fields;
    const tokenRange = outputTokenRange(provider);
    const configured = values === null || Object.keys(values).length > 0;
    const inactive = values === null || Boolean(values && fields && Object.keys(values).some((key) => !fields.includes(key)));

    async function save(next) {
      if (busy) return;
      setBusy(true);
      setNotice('');
      try {
        await apply(next);
        setNotice(Object.keys(next).length ? '已应用到后续请求。' : '已恢复执行端默认。');
      } catch { setNotice('暂时无法保存，请重试。'); }
      finally { setBusy(false); }
    }

    function submit(event) {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const next = Object.fromEntries(fields.map((field) => [field, data.get(field)])
        .filter(([, value]) => value)
        .map(([field, value]) => [field, field === 'maxOutputTokens' ? Number(value) : value]));
      void save(next);
    }

    function fieldControl(field) {
      const input = { name: field, defaultValue: values?.[field] ?? '', disabled: busy };
      return h('label', { className: 'vc-model-parameter', key: field },
        h('span', null, labels[field]),
        field === 'maxOutputTokens'
          ? h('input', { ...input, type: 'number', inputMode: 'numeric', ...tokenRange,
            step: 1, placeholder: '执行端默认', autoComplete: 'off' })
          : h('select', input, h('option', { value: '' }, '执行端默认'),
            parameterLevels.map((level, index) => h('option', { value: level, key: level }, scaleNames[field][index]))),
        field === 'maxOutputTokens' ? h('small', null,
          `单次模型调用，范围 ${tokenRange.min}–${tokenRange.max}。整轮工具日志和聊天显示各有容量限制。`) : null);
    }

    return h('details', { className: 'vc-advanced-model vc-details-motion' },
      h('summary', null, h('span', { className: 'vc-menu-label' }, menuIcon(h, 'effort'), '高级参数'),
        configured ? h('span', { className: 'vc-advanced-model-state' }, inactive ? '待确认' : '已配置') : null,
        h('span', { className: 'vc-group-chevron', 'aria-hidden': true })),
      h('div', { className: 'vc-advanced-model-body' },
        h('p', null, '应用到当前 VPS 执行端的后续请求。'),
        availability?.error ? h('div', { className: 'vc-advanced-model-retry', role: 'status' },
          h('span', null, availability.error), h('button', { type: 'button', className: 'vc-button', onClick: retry }, '重试'))
          : !fields ? h('p', { role: 'status' }, '正在读取参数支持情况。')
            : !fields.length ? h('p', null, '当前 Claude API 直连模式使用 VPS 的默认参数。') : null,
        inactive ? h('p', { role: 'status' }, '现有参数无法应用，请重新设置或恢复默认。') : null,
        h('form', { key: JSON.stringify(values) + (fields?.join(',') ?? ''), onSubmit: submit },
          fields?.map(fieldControl),
          h('div', { className: 'vc-advanced-model-temperature' }, h('span', null, '温度'), h('small', null, '由执行端管理')),
          fields?.length || configured ? h('div', { className: 'vc-dialog-actions' },
            configured ? h('button', { type: 'button', className: 'vc-button', onClick: () => void save({}), disabled: busy }, '恢复默认') : null,
            fields?.length ? h('button', { type: 'submit', className: 'vc-button vc-primary', disabled: busy }, '应用') : null) : null),
        notice ? h('p', { className: 'vc-advanced-model-notice', role: 'status' }, notice) : null));
  };
}

export const advancedModelOptionsCss = `
  [data-vps-chat] .vc-advanced-model {margin-top:8px; border-top:1px solid var(--vc-line)}
  [data-vps-chat] .vc-advanced-model > summary {
    display:flex; align-items:center; gap:8px; min-height:32px; padding:4px 5px;
    list-style:none; border-radius:6px; cursor:pointer; font-size:12px; color:var(--vc-ink);
  }
  [data-vps-chat] .vc-advanced-model > summary::-webkit-details-marker {display:none}
  [data-vps-chat] .vc-advanced-model > summary:hover {background:var(--vc-hover)}
  [data-vps-chat] .vc-advanced-model > summary .vc-group-chevron {margin-inline-start:auto}
  [data-vps-chat] .vc-advanced-model[open] > summary .vc-group-chevron {transform:rotate(45deg)}
  [data-vps-chat] .vc-advanced-model-state {color:var(--vc-accent); font-size:11px}
  [data-vps-chat] .vc-advanced-model-body {padding:3px 4px 4px}
  [data-vps-chat] .vc-advanced-model-body form {display:grid; gap:8px}
  [data-vps-chat] .vc-advanced-model-body .vc-dialog-actions {margin:0; gap:4px}
  [data-vps-chat] .vc-advanced-model-body .vc-button {min-height:27px; font-size:12px}
  [data-vps-chat] .vc-model-parameter, [data-vps-chat] .vc-advanced-model-temperature {
    display:grid; grid-template-columns:minmax(0,1fr) minmax(100px,45%); align-items:center; gap:4px 8px; font-size:12px;
  }
  [data-vps-chat] .vc-model-parameter :is(input,select) {
    width:100%; min-width:0; min-height:29px; padding:3px 6px; border:1px solid var(--vc-line); border-radius:6px;
    background:var(--vc-canvas); color:var(--vc-ink); font:inherit;
  }
  [data-vps-chat] .vc-model-parameter small {grid-column:1/-1; color:var(--vc-muted); font-size:11px}
  [data-vps-chat] .vc-advanced-model-temperature small {color:var(--vc-muted); font-size:11px; text-align:end}
  [data-vps-chat] .vc-advanced-model-retry {display:flex; align-items:center; gap:5px; margin-bottom:6px; font-size:12px}
  [data-vps-chat] .vc-advanced-model-body .vc-advanced-model-notice {margin:5px 0 0; color:var(--vc-accent)}
`;
