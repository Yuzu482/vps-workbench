import React from 'react';
import { editMenuGroups } from '../../remote-workbench/vps-chat/client/context-menu.js';
import { connectChromeColors } from './chrome-colors.mjs';

const h = React.createElement;
const narrowViewport = window.matchMedia('(max-width: 620px)');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function glyph(name) {
  return h('span', { className: 'desktop-glyph', 'data-glyph': name, 'aria-hidden': true });
}

function TitleMenu({ kind, label, children, items }) {
  const trigger = React.useRef(null);
  const panel = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const menuItems = () => Array.from(panel.current.querySelectorAll('[role=menuitem]'));

  React.useLayoutEffect(() => {
    const element = panel.current;
    const onToggle = (event) => {
      const visible = event.newState === 'open';
      element.inert = !visible;
      setOpen(visible);
    };
    element.addEventListener('beforetoggle', onToggle);
    return () => element.removeEventListener('beforetoggle', onToggle);
  }, []);

  function openMenu(last = false) {
    const element = panel.current;
    if (element.matches(':popover-open')) return;
    element.style.setProperty('--desktop-menu-origin', `${trigger.current.getBoundingClientRect().left}px`);
    element.showPopover({ source: trigger.current });
    menuItems().at(last ? -1 : 0)?.focus();
  }

  function closeMenu() {
    if (panel.current.matches(':popover-open')) panel.current.hidePopover();
    trigger.current.focus({ preventScroll: true });
  }

  function onMenuKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const menus = Array.from(trigger.current.closest('.desktop-title-controls').querySelectorAll('[aria-haspopup="menu"]'));
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const next = menus[(menus.indexOf(trigger.current) + offset + menus.length) % menus.length];
      event.preventDefault();
      closeMenu();
      next.focus({ preventScroll: true });
      next.click();
      return;
    }
    const entries = menuItems();
    const current = entries.indexOf(event.target);
    const positions = {
      ArrowDown: (current + 1) % entries.length,
      ArrowUp: (current - 1 + entries.length) % entries.length,
      Home: 0,
      End: entries.length - 1,
    };
    if (!Object.hasOwn(positions, event.key)) return;
    event.preventDefault();
    entries[positions[event.key]]?.focus();
  }

  return h(React.Fragment, null,
    h('button', {
      ref: trigger, className: `desktop-title-button desktop-${kind}-trigger`, type: 'button', title: label,
      'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id,
      onClick: () => panel.current.matches(':popover-open') ? closeMenu() : openMenu(),
      onKeyDown(event) {
        if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') ||
            event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        openMenu(event.key === 'ArrowUp');
      },
    }, children),
    h('div', {
      ref: panel, id, role: 'menu', className: 'desktop-title-menu vc-popup-motion',
      popover: 'auto', 'data-side': 'below', inert: true,
      'aria-label': label, onKeyDown: onMenuKey,
    }, items.map((item) => {
      if (item.type === 'separator') return h('hr', { key: item.key, role: 'separator' });
      if (item.type === 'heading') return h('div', { key: item.key, className: 'desktop-menu-heading',
        'aria-hidden': true }, item.label);
      return h('button', {
        key: item.key, type: 'button', role: 'menuitem', tabIndex: -1, title: item.title,
        'aria-label': item.accessibleLabel,
        onClick() {
          closeMenu();
          item.run();
        },
      }, item.icon ? glyph(item.icon) : null,
      h('span', { className: 'desktop-menu-label' }, item.label),
      item.shortcut ? h('kbd', null, item.shortcut) : null);
    })));
}

export function DesktopChrome({ native, projectCatalog, location, newLocation, locations, openLocation, changeNewLocation,
  onError, onOpenResources, onOpenChatLink, onOpenSearch }) {
  const header = React.useRef(null);
  const sidebar = React.useRef(null);
  const sidebarButton = React.useRef(null);
  const historyButton = React.useRef(null);
  const lastContentFocus = React.useRef(null);
  const [sidebarId, setSidebarId] = React.useState('desktop-workbench-sidebar');
  const [layout, setLayout] = React.useState({ history: false, subscription: false });
  const { items: projects } = React.useSyncExternalStore(projectCatalog.subscribe, projectCatalog.getSnapshot);
  const sidebarVisible = !layout.subscription && layout.history;
  const run = (action) => { void action().catch(onError); };

  React.useLayoutEffect(() => {
    const root = header.current.parentElement;
    const workbench = root.querySelector(location === 'local-sdk' ? ':scope > [data-local-sdk]' : ':scope > [data-vps-chat]:not([data-local-sdk])');
    // The standalone toggle uses the same narrow history state and automatic closing as the Workbench.
    const toggle = workbench.querySelector('.vc-history-toggle');
    historyButton.current = toggle;
    sidebar.current = workbench.querySelector('.vc-rail');
    if (!sidebar.current.id) sidebar.current.id = 'desktop-workbench-sidebar';
    setSidebarId(sidebar.current.id);
    const chromeColors = connectChromeColors(root, workbench, native.setChromeTheme, onError, reducedMotion);

    function rememberFocus(event) { lastContentFocus.current = event.target; }
    function synchronize() {
      const { vcColor, vcMotion, subscriptionOpen } = workbench.dataset;
      const theme = vcColor === 'light' || vcColor === 'dark' ? vcColor : systemDark.matches ? 'dark' : 'light';
      root.dataset.chromeTheme = theme;
      root.dataset.chromeMotion = vcMotion;
      chromeColors.sync(theme);
      const history = toggle.getAttribute('aria-expanded') === 'true';
      const subscription = subscriptionOpen === 'true';
      setLayout((previous) => previous.history === history && previous.subscription === subscription
        ? previous : { history, subscription });
    }
    function closeHistoryOnNarrow(event) {
      if (event.matches && toggle.getAttribute('aria-expanded') === 'true') toggle.click();
    }
    const attributes = new MutationObserver(synchronize);
    attributes.observe(workbench, {
      attributeFilter: ['data-vc-color', 'data-vc-accent', 'data-vc-motion', 'data-tool-theme', 'data-theme-ripple',
        'data-subscription-open', 'data-subscription-transition'],
    });
    attributes.observe(toggle, { attributeFilter: ['aria-expanded'] });
    workbench.addEventListener('focusin', rememberFocus);
    narrowViewport.addEventListener('change', closeHistoryOnNarrow);
    systemDark.addEventListener('change', synchronize);
    reducedMotion.addEventListener('change', synchronize);
    synchronize();
    return () => {
      attributes.disconnect();
      chromeColors.disconnect();
      workbench.removeEventListener('focusin', rememberFocus);
      narrowViewport.removeEventListener('change', closeHistoryOnNarrow);
      systemDark.removeEventListener('change', synchronize);
      reducedMotion.removeEventListener('change', synchronize);
    };
  }, [native, onError, location]);

  React.useLayoutEffect(() => {
    const rail = sidebar.current;
    if (!sidebarVisible && rail.contains(document.activeElement)) sidebarButton.current.focus({ preventScroll: true });
    rail.inert = !sidebarVisible;
  }, [sidebarVisible, location]);

  function toggleSidebar() {
    historyButton.current.click();
  }

  const fileItems = [
    { key: 'open-chat-link', label: '打开对话链接…', run: onOpenChatLink },
    ...(location === 'local-sdk' ? [] : [
      { key: 'import', label: '导入 DSH 对话数据…', icon: 'import', run: () => run(native.importHistory) },
      { key: 'location-separator', type: 'separator' },
    ]),
    { key: 'history-location', type: 'heading', label: '打开会话历史' },
    ...locations.map(([id, label]) => ({ key: 'open-' + id,
      label: label + ' 历史' + (id === location ? ' · 当前' : ''), run: () => openLocation(id) })),
    { key: 'new-location', type: 'heading', label: '新建位置' },
    ...locations.map(([id, label]) => ({ key: 'new-' + id,
      label: '新建时使用 ' + label + (id === newLocation ? ' · 默认' : ''), run: () => changeNewLocation(id) })),
    { key: 'quit-separator', type: 'separator' },
    { key: 'quit', label: '退出工作台', icon: 'exit', shortcut: 'Alt+F4', run: () => run(native.quit) },
  ];
  const editItems = editMenuGroups.flat().map(([key, label, shortcut]) => ({ key, label, shortcut, run() {
    const target = lastContentFocus.current;
    if (target?.isConnected && !target.closest('[inert]') && target.getClientRects().length) {
      target.focus({ preventScroll: true });
    }
    run(() => native.edit(key));
  } }));
  editItems.splice(5, 0, { key: 'selection-separator', type: 'separator' });
  editItems.splice(2, 0, { key: 'clipboard-separator', type: 'separator' });
  const projectItems = [
    { key: 'resources', label: '项目资源库', icon: 'folder', run: onOpenResources },
    { key: 'local-directories-separator', type: 'separator' },
    { key: 'add', label: '添加目录…', icon: 'plus', run: () => run(native.addProject) },
  ];
  if (projects.length) {
    projectItems.push({ key: 'project-separator', type: 'separator' },
      { key: 'project-heading', type: 'heading', label: '移出项目' },
      ...projects.map(({ workspaceId, title }) => ({
        key: `project:${workspaceId}`, label: title, title: `移出 ${title}`, accessibleLabel: `移出 ${title}`,
        icon: 'minus', run: () => run(() => native.removeProject(workspaceId)),
      })));
  }
  const sidebarLabel = sidebarVisible ? '收起会话侧栏' : '展开会话侧栏';

  return h('header', { ref: header, className: 'desktop-titlebar' },
    h('div', { className: 'desktop-title-controls', role: 'group', 'aria-label': '工作台操作' },
      h('button', {
        ref: sidebarButton, type: 'button', className: 'desktop-title-button desktop-sidebar-button',
        title: sidebarLabel, 'aria-label': sidebarLabel, 'aria-controls': sidebarId,
        'aria-expanded': sidebarVisible, disabled: layout.subscription, onClick: toggleSidebar,
        onKeyDown(event) {
          if (event.key === 'Escape' && sidebarVisible && !event.nativeEvent.isComposing) {
            event.preventDefault();
            toggleSidebar();
          }
        },
      }, glyph('sidebar')),
      h('div', { className: 'desktop-brand' },
        h('img', { className: 'desktop-app-icon', src: '/app-icon.png', draggable: false, alt: '' }),
        h('span', { className: 'desktop-app-title' }, 'VPS 工作台')),
      h('span', { className: 'desktop-title-divider', 'aria-hidden': true }),
      h(TitleMenu, { kind: 'file', label: '文件', items: fileItems }, '文件', glyph('chevron')),
      h(TitleMenu, { kind: 'edit', label: '编辑', items: editItems }, '编辑', glyph('chevron')),
      h(TitleMenu, { kind: 'projects', label: '项目', items: projectItems }, '项目', glyph('chevron')),
      onOpenSearch && h('button', { type: 'button', className: 'desktop-title-button desktop-search-trigger',
        'aria-keyshortcuts': 'Control+k', title: '本地全局搜索 (Ctrl+K)', 'aria-label': '本地全局搜索',
        onClick: onOpenSearch }, glyph('search'))));
}
