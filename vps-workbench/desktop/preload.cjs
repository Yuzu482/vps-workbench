const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vpsWorkbench', {
  bootstrap: () => ipcRenderer.invoke('workbench:bootstrap'),
  mixedWorkflow: (body) => ipcRenderer.invoke('workbench:mixed-workflow', body),
  setPreference: (key, value) => ipcRenderer.invoke('workbench:set-preference', key, value),
  setAccess: (access) => ipcRenderer.invoke('workbench:set-access', access),
  localSdkStatus: () => ipcRenderer.invoke('workbench:local-sdk-status'),
  localComponentsStatus: () => ipcRenderer.invoke('workbench:local-components-status'),
  installLocalComponents: (ids) => ipcRenderer.invoke('workbench:local-components-install', ids),
  cancelLocalComponents: () => ipcRenderer.invoke('workbench:local-components-cancel'),
  saveLocalCredential: (backend, key) => ipcRenderer.invoke('workbench:local-credential-save', backend, key),
  loginLocalAntigravity: (profileId) => ipcRenderer.invoke('workbench:local-antigravity-login', profileId),
  loginLocalClaudeSubscription: (profileId) => ipcRenderer.invoke('workbench:local-claude-subscription-login', profileId),
  checkLocalClaudeSubscription: (profileId) => ipcRenderer.invoke('workbench:local-claude-subscription-status', profileId),
  localSdkRequest: (body) => ipcRenderer.invoke('workbench:local-sdk-request', body),
  registerLocalSdkProfile: (config) => ipcRenderer.invoke('workbench:local-sdk-register', config),
  changeExtensions: (change) => ipcRenderer.invoke('workbench:extensions', change),
  changeWorkflows: (change) => ipcRenderer.invoke('workbench:workflows', change),
  saveWorkflowAttachments: (files) => ipcRenderer.invoke('workbench:workflow-attachments', files),
  changeAgentPresets: (change) => ipcRenderer.invoke('workbench:agent-presets', change),
  onExtensionsChanged(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('workbench:extensions-changed', listener);
    return () => ipcRenderer.removeListener('workbench:extensions-changed', listener);
  },
  onLocalStatus(callback) {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('workbench:local-status', listener);
    return () => ipcRenderer.removeListener('workbench:local-status', listener);
  },
  writeClipboard: (value) => ipcRenderer.invoke('workbench:write-clipboard', value),
  takeChatLink: () => ipcRenderer.invoke('workbench:take-chat-link'),
  registerChatLinks: () => ipcRenderer.invoke('workbench:register-chat-links'),
  onChatLink(callback) {
    const listener = () => callback();
    ipcRenderer.on('workbench:chat-link-ready', listener);
    return () => ipcRenderer.removeListener('workbench:chat-link-ready', listener);
  },
  addProject: () => ipcRenderer.invoke('workbench:add-project'),
  removeProject: (id) => ipcRenderer.invoke('workbench:remove-project', id),
  importHistory: () => ipcRenderer.invoke('workbench:import-history'),
  edit: (command) => ipcRenderer.invoke('workbench:edit', command),
  quit: () => ipcRenderer.invoke('workbench:quit'),
  setChromeTheme: (colors) => ipcRenderer.invoke('workbench:chrome-theme', colors),
  onProjectsChanged(callback) {
    const listener = (_event, projects) => callback(projects);
    ipcRenderer.on('workbench:projects', listener);
    return () => ipcRenderer.removeListener('workbench:projects', listener);
  },
});
