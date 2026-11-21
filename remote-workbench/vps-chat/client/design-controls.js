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

  function MaterialsDialog({ project, update, choices, setChoices, close, workflow }) {
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
      h('label', { className: 'vc-design-auto-check' }, h('input', { type: 'checkbox', checked: project.brief.enabled,
        onChange: (event) => {
          const enabled = event.target.checked;
          update((previous) => ({ ...previous, brief: { ...previous.brief, enabled } }));
        },
      }), '后续设计轮次附带简报')) : null,
    h('div', { className: 'vc-design-imports', role: 'group', 'aria-label': '导入设计资料' },
      fileImport('添加参考图片', 'image', {
        multiple: true, accept: 'image/png,image/jpeg,image/webp',
        disabled: busy || project.images.length >= 2, onChange: importImages,
      }),
      fileImport('导入文字参考', 'file', {
        accept: '.txt,.md,.json,.html,.htm,.css,.js,.jsx,.ts,.tsx,.vue,.svelte', disabled: busy, onChange: importReference,
      }),
      fileImport('导入 DESIGN.md', 'canvas', {
        accept: '.md,text/markdown,text/plain', disabled: busy, onChange: importSystem,
      })),
    h('label', null, '设计系统',
      h('textarea', {
        'aria-label': '设计系统', value: project.system, maxLength: 10000, rows: 6, disabled: busy,
        placeholder: '填写颜色、排版、布局和组件约定，可直接使用 DESIGN.md 格式',
        onChange: (event) => editText('system', event.target.value, 10000),
      })),
    workflow ? h('label', { className: 'vc-design-auto-check' }, h('input', {
      type: 'checkbox', checked: project.autoSystem,
      onChange: (event) => {
        const autoSystem = event.target.checked;
        update((previous) => ({ ...previous, autoSystem }));
        setChoices({ ...choices, system: false });
      },
    }), '后续设计轮次应用设计系统') : null,
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
        h('label', { key }, h('input', {
          type: 'checkbox', checked: choices[key] || (key === 'system' && workflow && project.autoSystem),
          disabled: key === 'system' && workflow && project.autoSystem,
          onChange: (event) => setChoices({ ...choices, [key]: event.target.checked }),
        }), label))),
    error ? h('p', { className: 'vc-feedback', role: 'alert' }, error) : null,
    h('div', { className: 'vc-dialog-actions' },
      h('button', { type: 'button', className: 'vc-button', onClick: dismiss, disabled: busy }, busy ? '正在读取' : '完成')));
  }

  function ComparisonSide({ label, version, firstBoard, width }) {
    const stage = React.useRef(null);
    const [index, setIndex] = React.useState(Math.min(firstBoard, version.boards.length) - 1);
    const [space, setSpace] = React.useState({ width, height: 300 });
    const board = version.boards[index];
    const scale = Math.min(1, space.width / width);
    React.useLayoutEffect(() => {
      const observer = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setSpace({ width, height });
      });
      observer.observe(stage.current);
      return () => observer.disconnect();
    }, []);
    return h('section', { 'aria-label': label },
      h('header', null, h('strong', null, `${label} · 版本 ${version.number}`),
        h('select', { value: index, 'aria-label': `${label}画板`, onChange: (event) => setIndex(Number(event.target.value)) },
          version.boards.map(({ title }, offset) => h('option', { key: offset, value: offset }, title)))),
      h('div', { ref: stage, className: 'vc-design-comparison-frame' }, board?.html
        ? h('iframe', { title: `${label}画板预览`, srcDoc: board.html, sandbox: '', referrerPolicy: 'no-referrer',
          style: { width, height: space.height / scale, transform: `scale(${scale})` } })
        : h('p', null, '这张画板暂无可用预览。')));
  }

  function DesignComparison({ original, candidate, firstBoard, width, close }) {
    const ref = React.useRef(null);
    const cancelMotion = React.useRef(null);
    React.useLayoutEffect(() => {
      const dialog = ref.current;
      dialog.showModal();
      return () => {
        cancelMotion.current?.();
        if (dialog.open) dialog.close();
      };
    }, []);
    function dismiss() {
      if (!ref.current.open) return;
      ref.current.close();
      ref.current.inert = true;
      cancelMotion.current = afterPopupMotion(ref.current, close);
    }
    return h('dialog', { ref, className: 'vc-settings vc-design-comparison vc-popup-motion', 'aria-label': '对比来源版本',
      onCancel: (event) => { event.preventDefault(); dismiss(); } },
    h('h2', null, '对比来源版本'),
    h('div', { className: 'vc-design-comparison-grid' },
      h(ComparisonSide, { label: '来源', version: original, firstBoard, width }),
      h(ComparisonSide, { label: '当前', version: candidate, firstBoard, width })),
    h('div', { className: 'vc-dialog-actions' },
      h('button', { type: 'button', className: 'vc-button', onClick: dismiss }, '完成')));
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
