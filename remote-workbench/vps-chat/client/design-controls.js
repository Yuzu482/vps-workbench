import { compareArtboards, comparisonLabels, markComparisonLayers } from './design-comparison.js';
import {
  designBriefFields, designStyleLevels, designText, makeDesignReference, readDesignSystems, saveDesignSystem,
} from './design-state.js';
import { menuIcon } from './menu-icons.js';
import { afterPopupMotion } from './menu-motion.js';

const referenceExtensions = /\.(?:txt|md|json|html?|css|js|jsx|ts|tsx|vue|svelte)$/i;

export function createDesignControls(React) {
  const h = React.createElement;

  function DesignStyleControl({ value, change }) {
    const id = React.useId();
    const popup = React.useRef(null);
    const trigger = React.useRef(null);
    const [label, description] = designStyleLevels[value];

    React.useLayoutEffect(() => {
      const panel = popup.current;
      const place = () => {
        const bounds = trigger.current.getBoundingClientRect();
        const width = Math.min(300, window.innerWidth - 16);
        panel.style.left = `${Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8))}px`;
        panel.style.top = `${bounds.bottom + 6}px`;
      };
      const toggle = ({ newState }) => {
        panel.inert = newState === 'closed';
        if (newState === 'open') place();
      };
      panel.addEventListener('beforetoggle', toggle);
      window.addEventListener('resize', place);
      return () => {
        panel.removeEventListener('beforetoggle', toggle);
        window.removeEventListener('resize', place);
      };
    }, []);

    return h(React.Fragment, null,
      h('button', { ref: trigger, type: 'button', className: 'vc-button vc-design-style-trigger',
        popoverTarget: id, 'aria-haspopup': 'dialog', 'aria-label': `设计风格 · ${label}`, title: `设计风格 · ${label}` },
      menuIcon(h, 'effort'), h('span', null, `风格 · ${label}`)),
      h('div', { ref: popup, id, popover: 'auto', role: 'dialog', 'aria-label': '设计风格',
        className: 'vc-design-style-popover vc-popup-motion', 'data-side': 'below', inert: true },
        h('label', { htmlFor: `${id}-slider` }, '风格倾向'),
        h('output', { htmlFor: `${id}-slider` }, label),
        h('input', {
          id: `${id}-slider`, type: 'range', min: 0, max: designStyleLevels.length - 1, step: 1, value,
          'aria-valuetext': label, 'aria-describedby': `${id}-description`, autoFocus: true,
          onChange: (event) => change(event.target.valueAsNumber),
        }),
        h('div', { className: 'vc-style-endpoints', 'aria-hidden': true }, h('span', null, '保守'), h('span', null, '发散')),
        h('p', { id: `${id}-description` }, description),
        h('p', { className: 'vc-style-scope' }, '用于这段会话的设计指令。')));
  }

  function MaterialsDialog({ project, update, choices, setChoices, close, workflow, imageReferences = true }) {
    const ref = React.useRef(null);
    const mounted = React.useRef(true);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [library, setLibrary] = React.useState([]);
    const [systemName, setSystemName] = React.useState('');
    const [chosenSystem, setChosenSystem] = React.useState('');

    React.useLayoutEffect(() => {
      const dialog = ref.current;
      const trigger = document.activeElement;
      let cancelClose = () => {};
      const finishClosing = () => {
        dialog.inert = true;
        cancelClose = afterPopupMotion(dialog, close);
      };
      mounted.current = true;
      try { setLibrary(readDesignSystems()); } catch { setError('本机设计系统库无法读取。'); }
      dialog.addEventListener('close', finishClosing);
      dialog.showModal();
      return () => {
        mounted.current = false;
        cancelClose();
        dialog.removeEventListener('close', finishClosing);
        if (dialog.open) dialog.close();
        const active = document.activeElement;
        if (trigger?.isConnected && (active === document.body || dialog.contains(active))) trigger.focus({ preventScroll: true });
      };
    }, []);

    async function importSystem(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      setError('');
      setBusy(true);
      try {
        if (file.size > 64000) throw new Error('DESIGN.md 文件超过大小限制。');
        const text = await file.text();
        if (text.length > 10000 || text.includes('\0')) throw new Error('请导入不超过 10,000 字符的纯文本 DESIGN.md。');
        if (mounted.current) update((previous) => ({ ...previous, system: text }));
      } catch (failure) {
        if (mounted.current) setError(failure.message || '无法读取 DESIGN.md。');
      } finally {
        if (mounted.current) setBusy(false);
      }
    }

    async function importImages(event) {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (!files.length) return;
      setError('');
      if (files.length + project.images.length > 2) {
        setError('每次最多选择两张参考图片。');
        return;
      }
      setBusy(true);
      try {
        const images = [];
        for (const file of files) images.push(await makeDesignReference(file));
        if (mounted.current) update((previous) => ({ ...previous, images: [...previous.images, ...images].slice(0, 2) }));
      } catch (failure) {
        if (mounted.current) setError(failure.message || '无法读取图片。');
      } finally {
        if (mounted.current) setBusy(false);
      }
    }

    async function importReference(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      setError('');
      if (!referenceExtensions.test(file.name) || file.size > 24000) {
        setError('请选择小于 24 KB 的纯文本或前端源文件。');
        return;
      }
      setBusy(true);
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        const fileName = file.name.replace(/[\p{C}]/gu, '').slice(0, 120);
        const next = [project.references, `${fileName}\n${text}`].filter(Boolean).join('\n\n');
        if (!text.trim() || next.length > 6000 || text.includes('\0')) {
          throw new Error('文字参考合计需在 6,000 字符以内。');
        }
        if (mounted.current) update((previous) => ({ ...previous, references: next }));
      } catch (failure) {
        if (mounted.current) setError(failure instanceof TypeError ? '请选择 UTF-8 纯文本文件。' : failure.message);
      } finally {
        if (mounted.current) setBusy(false);
      }
    }

    function saveCurrentSystem() {
      setError('');
      try {
        setLibrary(saveDesignSystem(systemName, project.system));
        setSystemName('');
      } catch (failure) {
        setError(failure.name === 'QuotaExceededError' ? '本机空间不足，无法保存设计系统。' : failure.message);
      }
    }

    function editText(key, value, limit) {
      update((previous) => ({ ...previous, [key]: designText(value, limit) }));
    }

    function fileImport(label, icon, props) {
      return h('label', { className: 'vc-design-file' },
        h('input', { type: 'file', ...props }),
        h('span', { className: 'vc-menu-label' }, menuIcon(h, icon), label));
    }

    function materialSwitch(label, checked, change, { key, disabled } = {}) {
      return h('label', { key, className: 'vc-design-switch-row' },
        h('span', null, label),
        h('input', { type: 'checkbox', role: 'switch', className: 'vc-settings-switch', checked, disabled,
          onChange: (event) => change(event.target.checked) }));
    }

    function dismiss() {
      if (!busy) ref.current.close();
    }

    return h('dialog', {
      ref, className: 'vc-settings vc-design-materials vc-popup-motion', 'aria-label': '设计资料',
      onCancel: (event) => { event.preventDefault(); dismiss(); },
    },
    h('h2', { className: 'vc-menu-label' }, menuIcon(h, 'attachment'), '设计资料'),
    h('p', null, workflow ? '简报和视觉规则可在本会话复用。参考资料仍按轮次选用。'
      : '资料保存在本机。勾选的内容会随下一条设计消息提交给 VPS。'),
    workflow ? h('fieldset', { className: 'vc-design-brief' },
      h('legend', null, '设计简报'),
      h('div', { className: 'vc-design-brief-fields' }, designBriefFields.map(([key, label, limit, placeholder]) =>
        h('label', { key }, label, h('textarea', { value: project.brief[key], rows: 2, maxLength: limit, placeholder,
          onChange: (event) => {
            const value = designText(event.target.value, limit);
            update((previous) => ({ ...previous, brief: { ...previous.brief, [key]: value } }));
          } })))),
      materialSwitch('后续设计轮次附带简报', project.brief.enabled, (enabled) =>
        update((previous) => ({ ...previous, brief: { ...previous.brief, enabled } })))) : null,
    h('div', { className: 'vc-design-imports', role: 'group', 'aria-label': '导入设计资料' },
      fileImport('添加参考图片', 'image', {
        multiple: true, accept: 'image/png,image/jpeg,image/webp',
        disabled: busy || !imageReferences || project.images.length >= 2, onChange: importImages,
      }),
      fileImport('导入文字参考', 'file', {
        accept: '.txt,.md,.json,.html,.htm,.css,.js,.jsx,.ts,.tsx,.vue,.svelte', disabled: busy, onChange: importReference,
      }),
      fileImport('导入 DESIGN.md', 'canvas', {
        accept: '.md,text/markdown,text/plain', disabled: busy, onChange: importSystem,
      })),
    !imageReferences ? h('p', null, '当前 VPS 执行端支持文字参考。参考图片不会随本轮发送。') : null,
    h('label', null, '设计系统',
      h('textarea', {
        'aria-label': '设计系统', value: project.system, maxLength: 10000, rows: 6, disabled: busy,
        placeholder: '填写颜色、排版、布局和组件约定，可直接使用 DESIGN.md 格式',
        onChange: (event) => editText('system', event.target.value, 10000),
      })),
    workflow ? materialSwitch('后续设计轮次应用设计系统', project.autoSystem, (autoSystem) => {
      update((previous) => ({ ...previous, autoSystem }));
      setChoices({ ...choices, system: false });
    }) : null,
    library.length ? h('div', { className: 'vc-design-library' },
      h('label', null, '本机设计系统', h('select', {
        value: chosenSystem, disabled: busy, onChange: (event) => setChosenSystem(event.target.value),
      }, h('option', { value: '' }, '选择已保存的设计系统'),
      library.map(({ name }) => h('option', { key: name, value: name }, name)))),
      h('button', {
        type: 'button', className: 'vc-button', disabled: busy || !chosenSystem,
        onClick: () => {
          const selected = library.find(({ name }) => name === chosenSystem);
          if (selected) update((previous) => ({ ...previous, system: selected.text }));
        },
      }, '使用设计系统')) : null,
    project.system.trim() ? h('div', { className: 'vc-design-library' },
      h('label', null, '设计系统名称',
        h('input', {
          value: systemName, maxLength: 60, disabled: busy, onChange: (event) => setSystemName(event.target.value),
        })),
      h('button', {
        type: 'button', className: 'vc-button', disabled: busy || !systemName.trim(), onClick: saveCurrentSystem,
      }, '保存到设计系统库')) : null,
    h('label', null, '文字参考',
      h('textarea', {
        'aria-label': '文字参考', value: project.references, maxLength: 6000, rows: 4, disabled: busy,
        placeholder: '粘贴资料摘录、页面要点或设计参考说明',
        onChange: (event) => editText('references', event.target.value, 6000),
      })),
    project.images.length ? h('ul', { className: 'vc-design-image-list' }, project.images.map((image, index) =>
      h('li', { key: `${index}:${image.name}` },
        h('img', { alt: '', src: image.dataUrl, width: 36, height: 36 }),
        h('span', null, image.name),
        h('button', {
          type: 'button', className: 'vc-button', 'aria-label': `移除 ${image.name}`, disabled: busy,
          onClick: () => update((previous) => ({ ...previous, images: previous.images.filter((_, position) => position !== index) })),
        }, '移除')))) : null,
    h('fieldset', { className: 'vc-design-share' },
      h('legend', null, '随下一条消息发送'),
      [['system', '设计系统'], ['references', '参考资料'], ['revision', '当前版本的画布修改和批注']].map(([key, label]) =>
        materialSwitch(label, choices[key] || (key === 'system' && workflow && project.autoSystem),
          (checked) => setChoices({ ...choices, [key]: checked }),
          { key, disabled: key === 'system' && workflow && project.autoSystem }))),
    error ? h('p', { className: 'vc-feedback', role: 'alert' }, error) : null,
    h('div', { className: 'vc-dialog-actions' },
      h('button', { type: 'button', className: 'vc-button', onClick: dismiss, disabled: busy }, busy ? '正在读取' : '完成')));
  }

  function ComparisonSide({ label, number, entry, width, scale, stage, height, changes, side, picked, toggle, pending }) {
    const html = React.useMemo(() => entry
      ? markComparisonLayers(entry.preview.html, changes, side) : '', [entry, changes, side]);
    return h('section', { 'aria-label': label },
      h('header', null, h('strong', null, `${label} · 版本 ${number}`),
        h('span', { className: 'vc-comparison-board-title' }, entry?.preview.title ?? '此侧无对应画板'),
        entry?.preview.html ? h('label', { className: 'vc-comparison-pick' },
          h('input', { type: 'checkbox', checked: picked, onChange: toggle, disabled: pending,
            'aria-label': `带入${label}画板 ${entry.preview.title}` }), '带入画板') : null),
      h('div', { ref: stage, className: 'vc-design-comparison-frame', tabIndex: 0, 'aria-label': `${label}预览滚动区` },
        html ? h('div', { className: 'vc-comparison-sized-frame', style: { width: width * scale, height } },
          h('iframe', { title: `${label}画板预览`, tabIndex: -1, srcDoc: html, sandbox: '', referrerPolicy: 'no-referrer',
            style: { width, height: height / Math.min(1, scale), transform: `scale(${scale})` } }))
          : h('p', null, '无可用预览')));
  }

  function DesignComparison({ original, candidate, firstBoard, width, close, carry }) {
    const ref = React.useRef(null);
    const beforeStage = React.useRef(null);
    const afterStage = React.useRef(null);
    const cancelMotion = React.useRef(null);
    const busy = React.useRef(false);
    const pairs = React.useMemo(() => compareArtboards(original, candidate), [original, candidate]);
    const [pairIndex, setPairIndex] = React.useState(() => Math.max(0, pairs.findIndex(({ after }) => after?.index === firstBoard)));
    const [zoom, setZoom] = React.useState('fit');
    const [size, setSize] = React.useState({ width, height: 240 });
    const [selected, setSelected] = React.useState([]);
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState('');
    const pair = pairs[pairIndex];
    const scale = zoom === 'fit' ? Math.min(1, size.width / width) : Number(zoom) / 100;
    React.useLayoutEffect(() => {
      const dialog = ref.current;
      dialog.showModal();
      const stages = [beforeStage.current, afterStage.current];
      const resize = () => {
        if (!dialog.open) return;
        setSize({ width: Math.max(1, Math.min(...stages.map((stage) => stage.clientWidth))),
          height: Math.max(1, Math.min(...stages.map((stage) => stage.clientHeight))) });
      };
      const observer = new ResizeObserver(resize);
      for (const stage of stages) observer.observe(stage);
      resize();
      return () => {
        observer.disconnect();
        cancelMotion.current?.();
        if (dialog.open) dialog.close();
      };
    }, []);

    function dismiss() {
      if (busy.current || !ref.current?.open) return;
      ref.current.close();
      ref.current.inert = true;
      cancelMotion.current = afterPopupMotion(ref.current, close);
    }

    function toggle(entry) {
      setError('');
      if (selected.includes(entry)) setSelected(selected.filter((item) => item !== entry));
      else if (selected.length === 6) setError('一个新版本最多带入 6 张画板。');
      else setSelected([...selected, entry]);
    }

    async function save() {
      if (busy.current || !selected.length) return;
      busy.current = true;
      setPending(true);
      setError('');
      try {
        await carry(selected);
        busy.current = false;
        dismiss();
      } catch (failure) {
        setError(failure.message);
      } finally {
        busy.current = false;
        setPending(false);
      }
    }

    const side = (entry, options) => h(ComparisonSide, { entry, width, scale, height: size.height, changes: pair.layers,
      picked: selected.includes(entry), toggle: () => toggle(entry), pending, ...options });
    return h('dialog', { ref, className: 'vc-settings vc-design-comparison vc-popup-motion', 'aria-label': '对比来源版本',
      onCancel: (event) => { event.preventDefault(); dismiss(); } },
      h('h2', null, '对比来源版本'),
      h('div', { className: 'vc-comparison-controls' },
        h('label', null, '画板变化', h('select', { 'aria-label': '画板变化', value: pairIndex, onChange: (event) => setPairIndex(Number(event.target.value)) },
          pairs.map(({ before, after, status }, offset) => h('option', { key: offset, value: offset },
            `${comparisonLabels[status]} · ${after?.preview.title ?? before.preview.title}`)))),
        h('label', null, '同步缩放', h('select', { 'aria-label': '同步缩放', value: zoom, onChange: (event) => setZoom(event.target.value) },
          [['fit', '适应两栏'], ['25', '25%'], ['50', '50%'], ['75', '75%'], ['100', '100%'], ['125', '125%']].map(([value, label]) =>
            h('option', { key: value, value }, label))))),
      h('div', { className: 'vc-design-comparison-grid' },
        side(pair.before, { label: '父版', number: original.number, stage: beforeStage, side: 'left' }),
        side(pair.after, { label: '子版', number: candidate.number, stage: afterStage, side: 'right' })),
      h('details', { className: 'vc-comparison-changes' },
        h('summary', null, `图层变化（${pair.layers.length}）`),
        pair.layers.length ? h('ul', null, pair.layers.map(({ status, left, right }, offset) =>
          h('li', { key: offset }, h('strong', { 'data-change': status }, comparisonLabels[status]), ' ',
            left && right && left.label !== right.label ? `${left.label} → ${right.label}` : right?.label ?? left?.label)))
          : h('p', null, pair.status === 'changed' ? '画板的标题、顺序、样式表或整体结构有变化。' : '没有检测到可标记的图层变化。')),
      selected.length ? h('div', { className: 'vc-comparison-changes' },
        h('span', null, '带入顺序'),
        h('ol', { 'aria-label': '带入顺序' }, selected.map((entry) => h('li', { key: `${entry.versionId}:${entry.index}` },
          h('button', { type: 'button', className: 'vc-button', disabled: pending, onClick: () => toggle(entry),
            'aria-label': `移除${entry.versionId === original.id ? '父版' : '子版'}画板 ${entry.preview.title}` },
          `${entry.versionId === original.id ? '父版' : '子版'} · ${entry.preview.title} ×`))))) : null,
      error ? h('p', { className: 'vc-canvas-status', role: 'alert' }, error) : null,
      h('div', { className: 'vc-dialog-actions' },
        h('button', { type: 'button', className: 'vc-button', onClick: dismiss, disabled: pending }, '完成'),
        h('button', { type: 'button', className: 'vc-button vc-primary', onClick: () => void save(), disabled: pending || !selected.length },
          pending ? '正在保存…' : `带入新版本（${selected.length}）`)));
  }

  function LayerInspector({ layers, layer, edit, board, select, patch, add, duplicate, align, addComment, removeComment,
    commentRequest, onCommentFocus, useComment, canUseComment }) {
    const text = React.useRef(null);
    const comment = React.useRef(null);
    React.useLayoutEffect(() => {
      if (commentRequest) {
        comment.current?.focus();
        onCommentFocus();
      }
    }, [commentRequest, onCommentFocus]);
    const numeric = [
      ['x', '水平位移', -2160, 2160], ['y', '垂直位移', -2160, 2160],
      ['width', '宽度', 1, 2160], ['height', '高度', 1, 2160], ['fontSize', '字号', 8, 144],
    ];
    const selectEdit = (key, label, options) => h('label', { key }, label, h('select', {
      'aria-label': label, value: edit[key] ?? '', onChange: (event) => patch({ [key]: event.target.value }),
    }, h('option', { value: '' }, '原样'), options.map(([value, name]) => h('option', { key: value, value }, name))));

    function submitComment(event) {
      event.preventDefault();
      const value = designText(comment.current.value, 500).trim();
      if (!value || board.comments.length >= 40) return;
      addComment(value);
      comment.current.value = '';
    }

    return h('aside', { className: 'vc-design-inspector', 'aria-label': '图层编辑' },
      h('label', null, '图层',
        h('select', { 'aria-label': '图层', value: layer?.id ?? '', onChange: (event) => select(event.target.value) },
          h('option', { value: '' }, '选择图层'),
          layers.map((entry) => h('option', { key: entry.id, value: entry.id },
            `${'　'.repeat(Math.min(entry.depth, 5))}${entry.label} · ${entry.tag}`)))),
      h('div', { className: 'vc-layer-buttons' },
        h('button', { type: 'button', className: 'vc-button', disabled: board.additions.length >= 30, onClick: () => add('text') }, '添加文字'),
        h('button', { type: 'button', className: 'vc-button', disabled: board.additions.length >= 30, onClick: () => add('shape') }, '添加形状'),
        h('button', {
          type: 'button', className: 'vc-button', disabled: !layer?.editable || board.additions.length >= 30, onClick: duplicate,
        }, '复制图层'),
        h('button', { type: 'button', className: 'vc-button', disabled: !layer, onClick: () => patch({ removed: true }) }, '删除图层')),
      layer ? h('div', { className: 'vc-layer-fields', key: layer.id },
        layer.editable ? h('label', { className: 'vc-layer-wide' }, '图层文字',
          h('textarea', { ref: text, 'aria-label': '图层文字', key: layer.text, defaultValue: layer.text, rows: 2, maxLength: 500 }),
          h('button', { type: 'button', className: 'vc-button', onClick: () => patch({ text: text.current.value }) }, '应用文字')) : null,
        [['color', '文字颜色', '#202d2b'], ['background', '填充颜色', '#dceee8']].map(([key, label, fallback]) =>
          h('label', { key }, label, h('input', {
            type: 'color', 'aria-label': label, value: edit[key] ?? fallback, onChange: (event) => patch({ [key]: event.target.value }),
          }))),
        numeric.map(([key, label, min, max]) => h('label', { key }, label, h('input', {
          'aria-label': label, type: 'number', min, max, step: 1, value: edit[key] ?? '',
          onChange: (event) => patch({ [key]: event.target.valueAsNumber }),
        }))),
        selectEdit('family', '字体', [['sans-serif', '无衬线'], ['serif', '衬线'], ['monospace', '等宽']]),
        selectEdit('weight', '字重', [['400', '常规'], ['600', '中粗'], ['700', '粗体']]),
        selectEdit('align', '文字对齐', [['left', '靠左'], ['center', '居中'], ['right', '靠右']]),
        h('div', { className: 'vc-layer-buttons vc-layer-wide', role: 'group', 'aria-label': '画板水平对齐' },
          [['left', '左对齐'], ['center', '水平居中'], ['right', '右对齐']].map(([side, label]) =>
            h('button', { key: side, type: 'button', className: 'vc-button', onClick: () => align(side) }, label)))) : null,
      h('form', { className: 'vc-design-comments', onSubmit: submitComment },
        h('label', null, layer ? '图层批注' : '画板批注',
          h('textarea', { ref: comment, key: layer?.id, 'aria-label': '添加批注', maxLength: 500, rows: 2 })),
        h('button', { type: 'submit', className: 'vc-button', disabled: board.comments.length >= 40 }, '保存批注')),
      board.comments.length ? h('ul', { className: 'vc-design-comment-list', 'aria-label': '已保存批注' },
        board.comments.map((entry, index) => h('li', { key: index },
          h('strong', null, entry.label),
          h('p', null, entry.text),
          useComment ? h('button', {
            type: 'button', className: 'vc-button', 'aria-label': `用第 ${index + 1} 条批注迭代`,
            disabled: !canUseComment || Boolean(entry.layer && !layers.some((layer) => layer.id === entry.layer)),
            onClick: () => useComment(entry),
          }, '用批注迭代') : null,
          h('button', {
            type: 'button', className: 'vc-button', 'aria-label': `删除第 ${index + 1} 条批注`, onClick: () => removeComment(index),
          }, '删除')))) : null);
  }

  return { MaterialsDialog, LayerInspector, DesignStyleControl, DesignComparison };
}
