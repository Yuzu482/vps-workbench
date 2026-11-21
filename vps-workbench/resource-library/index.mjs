import { afterPopupMotion } from '../../remote-workbench/vps-chat/client/menu-motion.js';
import { indexResources } from './assets.mjs';
import { resourceStyles } from './styles.mjs';

const assetTypes = { design: '画板', code: '代码', image: '图片' };
const allProjects = 'all';
const unassignedProject = 'unassigned';
const projectValue = (id) => `project:${id}`;
const pageSize = 18;
const thumbnailLimit = 4;

function projectGroup(projects, id) {
  return projects.has(id) ? projectValue(id) : unassignedProject;
}

function matchingResources(items, projects, projectFilter, type, query) {
  const text = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const group = projectGroup(projects, item.projectId);
    return (projectFilter === allProjects || group === projectFilter) && (type === 'all' || type === item.kind) &&
      (!text || [item.title, item.sessionTitle, projects.get(item.projectId), assetTypes[item.kind]].some((label) =>
        label?.toLocaleLowerCase().includes(text)));
  });
}

function countText(scope, scanned, total, matches, partial) {
  if (!scope) return '当前连接的会话不可用。';
  if (scanned < total) return `正在读取 ${scanned} / ${total} 段会话 · ${matches} 项资源`;
  if (partial) return `${matches} 项资源 · ${partial} 段会话或设计记录未能完整读取`;
  return `${matches} 项资源`;
}

export function createResourceLibrary(React) {
  const h = React.createElement;

  function Artboard({ item, thumbnail }) {
    return h('iframe', {
      sandbox: '', srcDoc: item.source, referrerPolicy: 'no-referrer',
      title: thumbnail ? '' : item.title, tabIndex: thumbnail ? -1 : 0,
    });
  }

  function Thumbnail({ item, showArtboard }) {
    let child;
    if (item.kind === 'code') child = h('pre', null, item.source.slice(0, 360));
    if (item.kind === 'image') child = h('img', { src: item.source, alt: '', loading: 'lazy' });
    if (item.kind === 'design') child = showArtboard ? h(Artboard, { item, thumbnail: true }) : '画板';
    return h('div', { className: 'vc-resource-thumb', 'data-kind': item.kind, 'aria-hidden': true }, child);
  }

  function Preview({ item }) {
    let content;
    if (item.kind === 'design') content = h(Artboard, { item });
    if (item.kind === 'image') content = h('img', { src: item.source, alt: item.title });
    if (item.kind === 'code') content = h('pre', { tabIndex: 0 }, h('code', null, item.source));
    return h('div', { className: 'vc-resource-preview', key: item.id }, content);
  }

  return function ResourceLibrary({ scope, projects, sessions, readSession, onClose, onOpenSource, writeClipboard, initialProject }) {
    const titleId = React.useId();
    const detailId = React.useId();
    const dialogRef = React.useRef(null);
    const queryRef = React.useRef(null);
    const detailRef = React.useRef(null);
    const cancelExit = React.useRef(null);
    const [project, setProject] = React.useState(() =>
      projects.has(initialProject) ? projectValue(initialProject) : allProjects);
    const [type, setType] = React.useState('all');
    const [query, setQuery] = React.useState('');
    const [selectedId, setSelectedId] = React.useState('');
    const [page, setPage] = React.useState(0);
    const [copyStatus, setCopyStatus] = React.useState(null);
    const [attempt, setAttempt] = React.useState(0);
    const [index, setIndex] = React.useState(null);

    React.useLayoutEffect(() => {
      const dialog = dialogRef.current;
      dialog.showModal();
      queryRef.current.focus();
      return () => {
        cancelExit.current?.();
        if (dialog.open) dialog.close();
      };
    }, []);

    const run = React.useMemo(() => ({ scope, sessions, readSession, attempt }), [scope, sessions, readSession, attempt]);
    React.useLayoutEffect(() => {
      if (!run.scope || !run.sessions.length) return undefined;
      const controller = new AbortController();
      void indexResources({ ...run, signal: controller.signal, onResult: ({ items, partial }) => {
        setIndex((previous) => {
          if (controller.signal.aborted) return previous;
          const old = previous?.run === run ? previous : { items: [], scanned: 0, partial: 0 };
          return { run, items: old.items.concat(items), scanned: old.scanned + 1, partial: old.partial + Number(partial) };
        });
      } });
      return () => controller.abort();
    }, [run]);

    const current = index?.run === run ? index : null;
    const scanned = current?.scanned ?? 0;
    const partial = current?.partial ?? 0;
    const projectFilter = project === unassignedProject || projects.has(project.slice('project:'.length))
      ? project : allProjects;
    const matches = React.useMemo(() => matchingResources(current?.items ?? [], projects, projectFilter, type, query),
      [current, projects, projectFilter, type, query]);
    const pageCount = Math.ceil(matches.length / pageSize);
    const currentPage = Math.min(page, Math.max(0, pageCount - 1));
    const visible = matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
    const selected = visible.find((item) => item.id === selectedId) ?? visible[0];
    const groups = new Map();
    const thumbnails = new Set(visible.filter((item) => item.kind === 'design').slice(0, thumbnailLimit));
    for (const item of visible) {
      const group = projectGroup(projects, item.projectId);
      if (!groups.has(group)) groups.set(group, { title: projects.get(item.projectId) ?? '未归类', items: [] });
      groups.get(group).items.push(item);
    }

    function filter(set, value) {
      set(value);
      setPage(0);
    }

    function select(item) {
      setSelectedId(item.id);
      setCopyStatus(null);
      if (dialogRef.current.ownerDocument.defaultView.matchMedia('(max-width: 760px)').matches) {
        detailRef.current?.scrollIntoView({ block: 'start' });
      } else if (detailRef.current) detailRef.current.scrollTop = 0;
    }

    async function copy(item) {
      setCopyStatus(null);
      let copied = false;
      try { copied = await writeClipboard(item.source); } catch { /* Feedback is shown below. */ }
      setCopyStatus({ item, text: copied ? '已复制' : '无法复制，请重试。' });
    }

    function dismiss() {
      const dialog = dialogRef.current;
      if (!dialog.open) return;
      dialog.close();
      cancelExit.current = afterPopupMotion(dialog, onClose);
    }

    function openSource(item) {
      const source = { sessionId: item.sessionId, turnId: item.turnId };
      if (item.boardIndex !== undefined) source.boardIndex = item.boardIndex;
      if (onOpenSource(source)) dismiss();
    }

    let empty = '已保存的会话还没有可浏览的资源。';
    if (!scope) empty = '连接可用后，才能读取已保存的会话。';
    else if (scanned < sessions.length) empty = '正在查找画板、代码块和嵌入图片…';
    else if (current?.items.length) empty = '没有符合当前筛选条件的资源。';
    else if (partial) empty = '没有读到资源。可以重试读取会话。';

    return h('dialog', { className: 'vc-resource-library vc-popup-motion', ref: dialogRef, 'aria-labelledby': titleId,
      onCancel: (event) => { event.preventDefault(); dismiss(); } },
    h('style', null, resourceStyles),
    h('header', { className: 'vc-resource-header' },
      h('div', null,
        h('h2', { id: titleId }, '项目资源库'),
        h('p', { className: 'vc-resource-status', role: 'status' }, countText(scope, scanned, sessions.length, matches.length, partial))),
      h('button', { type: 'button', className: 'vc-resource-button vc-resource-close', onClick: dismiss,
        'aria-label': '关闭资源库', title: '关闭资源库' }, '×')),
    h('div', { className: 'vc-resource-filters' },
      h('label', null, '搜索资源', h('input', { ref: queryRef, type: 'search', value: query,
        placeholder: '名称、会话或语言', onChange: (event) => filter(setQuery, event.target.value) })),
      h('label', null, '项目', h('select', { value: projectFilter, onChange: (event) => filter(setProject, event.target.value) },
        h('option', { value: allProjects }, '全部项目'),
        Array.from(projects, ([id, title]) => h('option', { key: id, value: projectValue(id) }, title)),
        h('option', { value: unassignedProject }, '未归类'))),
      h('label', null, '类型', h('select', { value: type, onChange: (event) => filter(setType, event.target.value) },
        h('option', { value: 'all' }, '全部类型'),
        Object.entries(assetTypes).map(([value, title]) => h('option', { key: value, value }, title))))),
    h('div', { className: 'vc-resource-body' },
      h('section', { className: 'vc-resource-catalog', 'aria-label': '资源列表' },
        partial > 0 && scanned === sessions.length && h('button', { type: 'button',
          className: 'vc-resource-button vc-resource-retry', onClick: () => {
            setPage(0);
            setAttempt((number) => number + 1);
          } }, '重新读取会话'),
        !visible.length && h('div', { className: 'vc-resource-empty' }, empty),
        Array.from(groups, ([group, { title, items }]) => h('section', { className: 'vc-resource-group', key: group },
          h('h3', null, title),
          h('div', { className: 'vc-resource-grid' }, items.map((item) =>
            h('div', { className: 'vc-resource-card', key: item.id },
              h(Thumbnail, { item, showArtboard: thumbnails.has(item) }),
              h('button', { type: 'button', className: 'vc-resource-card-copy', onClick: () => select(item),
                'aria-pressed': item === selected },
              h('strong', null, item.title),
              h('span', null, item.sessionTitle))))))),
        pageCount > 1 && h('nav', { className: 'vc-resource-pages', 'aria-label': '资源分页' },
          h('button', { type: 'button', className: 'vc-resource-button', disabled: currentPage === 0,
            onClick: () => setPage(currentPage - 1) }, '上一页'),
          h('span', null, `第 ${currentPage + 1} / ${pageCount} 页`),
          h('button', { type: 'button', className: 'vc-resource-button', disabled: currentPage + 1 === pageCount,
            onClick: () => setPage(currentPage + 1) }, '下一页'))),
      h('section', { className: 'vc-resource-detail', ref: detailRef, 'aria-labelledby': selected ? detailId : undefined,
        'aria-label': selected ? undefined : '资源预览' },
      selected ? h(React.Fragment, null,
        h('h3', { id: detailId }, selected.title),
        h('p', { className: 'vc-resource-detail-meta' }, `${assetTypes[selected.kind]} · ${selected.sessionTitle}`),
        h('div', { className: 'vc-resource-tools' },
          h('button', { type: 'button', className: 'vc-resource-button vc-resource-open',
            onClick: () => openSource(selected) }, '打开来源会话'),
          h('button', { type: 'button', className: 'vc-resource-button', onClick: () => void copy(selected) },
            selected.kind === 'image' ? '复制图片数据' : '复制源码'),
          h('span', { className: 'vc-resource-copy-status', role: 'status' }, copyStatus?.item === selected ? copyStatus.text : '')),
        h(Preview, { item: selected })) : h('div', { className: 'vc-resource-empty' }, '选择资源查看内容。'))));
  };
}
