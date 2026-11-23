import { t } from '../../remote-workbench/vps-chat/client/interface-language.js';
import React from 'react';

const h = React.createElement;
const types = { message: '消息', project: '项目', board: '画板', workflow: '工作流', artifact: '产物' };
const textBlock = (label, value) => value && h('section', { className: 'desktop-search-section' },
  h('h4', null, label), h('pre', null, value));

function GroupedResults({ packet, onSelect }) {
  const groups = new Map();
  for (const item of packet.results) {
    if (!groups.has(item.group.id)) groups.set(item.group.id, { label: item.group.label, items: [] });
    groups.get(item.group.id).items.push(item);
  }
  return h(React.Fragment, null,
    h('p', { role: 'status' }, packet.total ? t('{total} 项结果', { total: packet.total }) + (packet.total > 100 ? ' · ' + t('显示前 100 项') : '') : t('没有找到匹配的记录。')),
    packet.partial && h('p', { role: 'status' }, t('部分本机记录无法读取或超出索引上限。')),
    Array.from(groups, ([id, { label, items }]) => h('section', { key: id, 'aria-label': label },
      h('h4', null, label),
      h('ul', null, items.map(({ id: resultId, type, title, excerpt }) => h('li', { key: resultId },
        h('button', { type: 'button', 'data-search-result': resultId, onClick: () => onSelect(resultId) },
          h('span', { className: 'desktop-search-kind' }, t(types[type])),
          h('strong', null, title), excerpt && h('span', { className: 'desktop-search-excerpt' }, excerpt))))))));
}

export function GlobalSearchDialog({ request, onClose, onOpenConversation, onOpenWorkflow }) {
  const dialog = React.useRef(null);
  const input = React.useRef(null);
  const destination = React.useRef(null);
  const scroll = React.useRef(null);
  const priorResult = React.useRef(null);
  const indexRequested = React.useRef(false);
  const [query, setQuery] = React.useState('');
  const [epoch, setEpoch] = React.useState(0);
  const epochUsed = React.useRef(0);
  const [packet, setPacket] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [requested, setRequested] = React.useState(null);
  const [within, setWithin] = React.useState(null);
  const [resultError, setResultError] = React.useState('');
  const [detailError, setDetailError] = React.useState('');
  const canQuery = Boolean(query.trim() || within);

  React.useLayoutEffect(() => { dialog.current.showModal(); input.current.focus(); }, []);
  React.useLayoutEffect(() => {
    if (detail?.id === requested && destination.current) {
      scroll.current.scrollTop = 0;
      destination.current.focus({ preventScroll: true });
    }
  }, [detail, requested]);
  React.useEffect(() => {
    if (!canQuery) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      const refresh = !indexRequested.current || epochUsed.current !== epoch;
      try {
        const value = await request({ op: 'search', query, refresh, projectId: within?.projectId ?? null, groupId: within?.groupId ?? null });
        if (!live) return;
        if (!value?.ok) throw new Error(value?.message);
        indexRequested.current = true;
        epochUsed.current = epoch;
        setPacket({ key: searchKey, value });
      } catch (error) {
        if (live) setResultError(error.message || t('暂时无法读取本机搜索结果。'));
      }
    }, 170);
    return () => { live = false; clearTimeout(timer); };
  }, [canQuery, query, epoch, within, request]);
  React.useEffect(() => {
    if (!requested) return undefined;
    let live = true;
    void request({ op: 'detail', id: requested }).then((value) => {
      if (!live) return;
      if (!value?.ok) throw new Error(value?.message);
      setDetail(value.item);
    }).catch((error) => { if (live) setDetailError(error.message || t('暂时无法读取这条记录。')); });
    return () => { live = false; };
  }, [requested, request]);

  const searchKey = JSON.stringify([query, epoch, within]);
  const current = packet?.key === searchKey ? packet.value : null;
  const item = detail?.id === requested ? detail : null;
  function select(id) {
    priorResult.current = { id, top: scroll.current.scrollTop };
    setDetailError('');
    setRequested(id);
  }
  function back() {
    setRequested(null);
    requestAnimationFrame(() => {
      const previous = priorResult.current;
      const item = previous && scroll.current?.querySelector(`[data-search-result="${CSS.escape(previous.id)}"]`);
      if (item) {
        scroll.current.scrollTop = previous.top;
        item.focus({ preventScroll: true });
      } else input.current?.focus();
    });
  }
  function filterProject(project) {
    setWithin({ projectId: project.projectId, groupId: project.relatedGroup, title: project.title });
    setResultError('');
    setQuery('');
    setRequested(null);
    input.current?.focus();
  }
  function openInWorkbench(callback, value) {
    dialog.current.close();
    callback(value);
  }

  return h('dialog', { ref: dialog, className: 'desktop-search-dialog', 'aria-label': t('本地全局搜索'), onClose },
    h('div', { className: 'desktop-search-head' },
      h('label', null, t('本地全局搜索'), h('input', { type: 'search', ref: input, value: query, maxLength: 160,
        placeholder: t('搜索会话正文、项目、画板、工作流与产物'),
        onChange: (event) => { setQuery(event.target.value); setRequested(null); setResultError(''); } })),
      h('button', { type: 'button', onClick: () => dialog.current.close(), 'aria-label': t('关闭搜索') }, '×')),
    h('div', { className: 'desktop-search-actions' },
      within && h('button', { type: 'button', onClick: () => { setWithin(null); setRequested(null); setResultError(''); } },
        within.title + ' · ' + t('清除项目筛选')),
      h('button', { type: 'button', disabled: !canQuery,
        onClick: () => { setRequested(null); setResultError(''); setEpoch((value) => value + 1); } }, t('刷新索引'))),
    h('div', { ref: scroll, className: 'desktop-search-scroll' },
      requested ? h(React.Fragment, null,
        h('button', { type: 'button', onClick: back }, t('返回搜索结果')),
        detailError ? h('p', { role: 'alert' }, detailError) : !item ? h('p', { role: 'status' }, t('正在读取本机记录…')) :
          h('section', { className: 'desktop-search-detail', 'aria-label': t('搜索结果详情') },
            h('h3', { ref: destination, tabIndex: -1 }, item.title),
            h('p', { className: 'desktop-search-muted' }, item.group.label),
            item.type === 'message' && h(React.Fragment, null,
              textBlock(t('用户消息'), item.prompt), ...(item.supplemental ?? []).map((text, i) => h(React.Fragment, { key: i },
                textBlock(t('用户补充'), text))), textBlock(t('模型回复'), item.reply)),
            item.type === 'board' && h(React.Fragment, null,
              textBlock(t('画板版本 ID'), item.version),
              h('iframe', { sandbox: '', referrerPolicy: 'no-referrer', title: item.title, srcDoc: item.html })),
            item.type === 'project' && h('button', { type: 'button', onClick: () => filterProject(item) }, t('查看项目内的本机记录')),
            item.type === 'workflow' && h(React.Fragment, null,
              h('p', null, t('版本 {revision}', { revision: item.revision })),
              h('ol', null, item.stages.map((stage) => h('li', { key: stage.id },
                textBlock(stage.name, stage.instruction)))),
              h('button', { type: 'button', onClick: () => openInWorkbench(onOpenWorkflow, item) }, t('打开工作流'))),
            item.type === 'artifact' && h(React.Fragment, null,
              h('p', null, [item.workflow, item.stageName, item.size === undefined ? '' : t('{size} 字节', { size: item.size })].filter(Boolean).join(' · ')),
              textBlock(t('阶段轮次 ID'), item.turnId),
              item.text ? textBlock(t('本机已保存的内容'), item.text) : h('p', null, t('本机保存了产物名称和出处。')),
              h('button', { type: 'button', onClick: () => openInWorkbench(onOpenWorkflow, item) }, t('打开原运行阶段'))),
            item.nav && h('button', { type: 'button', onClick: () => openInWorkbench(onOpenConversation, item.nav) },
              item.type === 'board' ? t('在画布中打开') : t('在会话中打开')))) :
        resultError ? h('p', { role: 'alert' }, resultError) : current ? h(GroupedResults, { packet: current, onSelect: select }) :
          h('p', { role: canQuery ? 'status' : undefined }, canQuery ? t('正在搜索本机记录…') : t('输入要查找的内容。'))));
}
