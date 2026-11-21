import { createWorkbench } from './workbench.js';

window.__ModuleLoader__.load({
  id: 'dsh-vps-chat-workbench',
  factory: (require) => {
    const React = require('react');
    const { CodeBlock, writeClipboard } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const Workbench = createWorkbench({ React, CodeBlock, writeClipboard });

    function apply(ctx) {
      const list = ctx.workspaces.list;
      const projectCatalog = {
        subscribe: (listener) => list.subscribe(listener),
        getSnapshot: () => list.getSnapshot(),
      };
      let SubscriptionTerminal = null;
      const listeners = new Set();
      const terminalView = {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        getSnapshot: () => SubscriptionTerminal,
      };
      ctx.inject?.(['dshClaudeSubscriptionView'], (scope) => {
        const view = scope.dshClaudeSubscriptionView;
        if (view?.apiVersion !== 1 || typeof view.Component !== 'function') return undefined;
        SubscriptionTerminal = view.Component;
        for (const listener of listeners) listener();
        return () => {
          SubscriptionTerminal = null;
          for (const listener of listeners) listener();
        };
      });
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: 'VPS 对话',
        description: '通过 VPS 上的 Codex 或 Claude Code 对话',
        customFrame: true,
      }, ({ active } = {}) => h(Workbench, { projectCatalog, terminalView, active })));
    }

    return { apply, inject: ['desktopWorkbenches', 'workspaces'] };
  },
});
