(() => {
  const key = 'vps-workbench-preview-state';
  const revision = () => ['workbench-revision', 'workbench-preview-instance']
    .map((name) => document.querySelector(`meta[name="${name}"]`)?.content).join(':');
  const changes = new EventSource('/__preview/changes');
  changes.addEventListener('revision', (event) => { if (event.data !== revision()) location.reload(); });
  changes.addEventListener('reload', () => location.reload());
  addEventListener('pagehide', () => changes.close());

  const projectListeners = new Set();
  const extensionListeners = new Set();
  const extensionKey = 'dsh-vps-chat:extensions:v1';
  changes.addEventListener('extensions', (event) => {
    if (!state) return;
    const value = JSON.parse(event.data);
    state.preferences[extensionKey] = event.data;
    save();
    for (const listener of extensionListeners) listener(value);
  });
  let state;
  function save() {
    sessionStorage.setItem(key, JSON.stringify(state));
  }
  function report(message) {
    const status = document.getElementById('local-status');
    status.textContent = message;
    status.hidden = false;
  }
  async function setProjects(projects) {
    const response = await fetch('/__preview/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'set-projects', projects }) });
    if (!response.ok) throw new Error('preview_projects_unavailable');
    state.projects = projects;
    save();
    for (const listener of projectListeners) listener(projects);
  }

  async function mixedWorkflow(body) {
    const response = await fetch('/__preview/mixed-workflow', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    return response.json();
  }

  window.vpsWorkbench = {
    mixedWorkflow,
    async bootstrap() {
      const response = await fetch('/__preview/state');
      if (!response.ok) throw new Error('preview_state_unavailable');
      const defaults = await response.json();
      try { state = JSON.parse(sessionStorage.getItem(key)) ?? defaults; }
      catch { state = defaults; }
      state.projects = defaults.projects;
      if (defaults.preferences[extensionKey] === undefined) delete state.preferences[extensionKey];
      else state.preferences[extensionKey] = defaults.preferences[extensionKey];
      return { ...state, access: defaults.access, localComponents: defaults.localComponents };
    },
    async setAccess(access) {
      const response = await fetch('/__preview/access', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'set-access', ...access }) });
      if (!response.ok) throw new Error('preview_access_unavailable');
      return response.json();
    },
    async localSdkStatus() {
      const response = await fetch('/__preview/local-sdk');
      if (!response.ok) throw new Error('preview_local_sdk_unavailable');
      return response.json();
    },
    async localSdkRequest(body) {
      const response = await fetch('/__preview/local-sdk', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('preview_local_sdk_unavailable');
      return response.json();
    },
    registerLocalSdkProfile(config) {
      return this.localSdkRequest({ ...config, op: 'register' });
    },
    async localComponentsStatus() {
      const response = await fetch('/__preview/local-components');
      return response.ok ? response.json() : null;
    },
    async installLocalComponents(ids) {
      const response = await fetch('/__preview/local-components', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'install', ids }) });
      return response.json();
    },
    async cancelLocalComponents() {
      await fetch('/__preview/local-components', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'cancel' }) });
    },
    async setPreference(name, value) {
      if (name === 'dsh-vps-chat:workflows:v1') {
        const result = await mixedWorkflow({ op: 'save-definitions', value });
        if (!result.ok) throw new Error('preview_workflow_unavailable');
      }
      if (name === 'dsh-vps-chat:setup-connection:v1') {
        const response = await fetch('/__preview/connection', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'save-connection', value }) });
        if (!response.ok) throw new Error('preview_connection_unavailable');
      }
      if (['dsh-vps-chat:workflow-run:v1', 'dsh-vps-chat:local-workflow-run:v1'].includes(name) && value !== null) {
        const record = JSON.parse(value);
        const approvals = JSON.parse(state.preferences['dsh-vps-chat:workflows:v1'] ?? '[]');
        const approval = approvals.find(({ id }) => id === record.workflowId) ?? null;
        const response = await fetch('/__preview/workflow-run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'save-workflow-run', value, approval,
            ...(name === 'dsh-vps-chat:local-workflow-run:v1' && { location: 'local-sdk' }) }) });
        if (!response.ok) throw new Error('preview_workflow_unavailable');
      }
      const membership = /^dsh-vps-chat-projects:v1:([a-f0-9]{64})$/.exec(name);
      if (membership) {
        const response = await fetch('/__preview/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'set-memberships', targetId: membership[1], value }) });
        if (!response.ok) throw new Error('preview_memberships_unavailable');
      }
      if (value === null) delete state.preferences[name];
      else state.preferences[name] = value;
      save();
    },
    async saveWorkflowAttachments(files) {
      const response = await fetch('/__preview/workflow-attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'save-workflow-attachments', files }) });
      if (!response.ok) throw new Error('预览无法保存附件快照。');
      return response.json();
    },
    async changeExtensions(change) {
      const response = await fetch('/__preview/extensions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change) });
      if (!response.ok) throw new Error('preview_extensions_unavailable');
      const value = await response.json();
      state.preferences[extensionKey] = JSON.stringify(value);
      save();
      return value;
    },
    async writeClipboard(text) {
      await navigator.clipboard.writeText(text);
      return true;
    },
    async addProject() {
      const title = '示例项目 ' + (state.projects.length + 1);
      await setProjects([...state.projects, { workspaceId: 'local-' + crypto.randomUUID(), title }]);
    },
    async removeProject(id) {
      await setProjects(state.projects.filter(({ workspaceId }) => workspaceId !== id));
    },
    async importHistory() { report('界面预览使用模拟数据。可在桌面工作台导入记录。'); },
    async quit() { report('关闭此浏览器标签页即可离开预览。'); },
    async edit(command) {
      if (command !== 'paste') {
        document.execCommand(command);
        return;
      }
      const input = document.activeElement;
      if (!input?.matches('textarea, input') || input.disabled || input.readOnly) return;
      const { value, selectionStart, selectionEnd } = input;
      if (selectionStart === null) return;
      const text = await navigator.clipboard.readText();
      if (document.activeElement === input && input.value === value && input.selectionStart === selectionStart &&
          input.selectionEnd === selectionEnd && text) document.execCommand('insertText', false, text);
    },
    async setChromeTheme() {},
    onProjectsChanged(callback) {
      projectListeners.add(callback);
      return () => projectListeners.delete(callback);
    },
    onExtensionsChanged(callback) {
      extensionListeners.add(callback);
      return () => extensionListeners.delete(callback);
    },
  };
})();
