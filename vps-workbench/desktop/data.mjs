import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applyExtensionChange, extensionPreferenceKey, readExtensions } from '../extensions/state.mjs';
import { applyWorkflowChange, readWorkflows, workflowKey } from '../workflow-engine/state.mjs';
import { agentPresetKey, applyAgentPresetChange, legacyAgentPresetKey, readAgentPresets } from '../agent-presets/state.mjs';
import { openWorkflowAttachmentStore } from './workflow-attachments.mjs';

export const memoryJournalKey = 'dsh-vps-chat:project-memory-journal:v1';
const maxPreferences = 64 * 1024 * 1024;
const maxPreferenceValue = 6 * 1024 * 1024;
const maxProjects = 256 * 1024;
const preferenceKey = /^dsh-vps-(?:chat|design)[A-Za-z0-9:_-]{1,180}$/;

async function readSnapshot(file, limit, valid) {
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error('invalid_local_data_file');
    if (info.size > limit) return { valid: false };
    const bytes = await readFile(file);
    if (bytes.length > limit) return { valid: false };
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return { valid: false }; }
    return valid(value) ? { valid: true, bytes, value } : { valid: false };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function replaceFile(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      // On Windows a reader can temporarily open the old file without sharing deletion.
      if (process.platform !== 'win32' || attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(30 * 2 ** attempt);
    }
  }
}

async function writeAtomic(file, bytes) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    await replaceFile(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadState(file, fallback, limit, valid, label, notices, pendingBackups) {
  const primary = await readSnapshot(file, limit, valid);
  const backupFile = file + '.bak';
  if (primary?.valid) {
    try {
      const backup = await readSnapshot(backupFile, limit, valid);
      if (!backup?.valid || !backup.bytes.equals(primary.bytes)) await writeAtomic(backupFile, primary.bytes);
    } catch {
      pendingBackups.set(file, primary.bytes);
      notices.push(`无法更新本机${label}备份。`);
    }
    return primary.value;
  }
  const backup = await readSnapshot(backupFile, limit, valid);
  if (!primary && !backup) return fallback;
  if (!backup?.valid) throw new Error('invalid_local_data');
  if (primary) await copyFile(file, file + '.corrupt-' + randomUUID(), constants.COPYFILE_EXCL);
  await writeAtomic(file, backup.bytes);
  notices.push(`已从本机备份恢复${label}。`);
  return backup.value;
}

function validPreference(key, value) {
  return typeof key === 'string' && preferenceKey.test(key) &&
    typeof value === 'string' && Buffer.byteLength(value) <= maxPreferenceValue;
}

function validPreferences(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => validPreference(key, item));
}

function validProjects(value) {
  return Array.isArray(value) && value.every((project) => project && typeof project.workspaceId === 'string' &&
    typeof project.path === 'string' && typeof project.title === 'string');
}

export async function openAppData(root, { onBackupFailure = () => {} } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const preferencesFile = join(root, 'preferences.json');
  const projectsFile = join(root, 'projects.json');
  const attachments = openWorkflowAttachmentStore(root);
  const notices = [];
  const pendingBackups = new Map();
  let preferences = await loadState(preferencesFile, {}, maxPreferences, validPreferences, '设置', notices, pendingBackups);
  let projects = await loadState(projectsFile, [], maxProjects, validProjects, '项目列表', notices, pendingBackups);
  const reportedBackupFailures = new Set(pendingBackups.keys());

  let queue = Promise.resolve();
  function update(action) {
    const pending = queue.then(action);
    queue = pending.catch(() => {});
    return pending;
  }
  async function finishBackup(file) {
    const bytes = pendingBackups.get(file);
    if (!bytes) return;
    try {
      await writeAtomic(file + '.bak', bytes);
    } catch {
      if (!reportedBackupFailures.has(file)) {
        reportedBackupFailures.add(file);
        onBackupFailure();
      }
      return;
    }
    pendingBackups.delete(file);
    reportedBackupFailures.delete(file);
  }
  async function commitState(file, value, limit, accept) {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    if (bytes.length > limit) throw new Error('local_data_too_large');
    // Recovery copies only contain a committed primary. Keep the in-memory state
    // aligned with the primary even if copying it fails.
    await writeAtomic(file, bytes);
    accept();
    pendingBackups.set(file, bytes);
    await finishBackup(file);
  }
  function setPreferences(changes) {
    const entries = Object.entries(changes);
    if (!entries.every(([key, value]) => validPreference(key, value === null ? '' : value))) {
      throw new Error('invalid_preference');
    }
    return update(async () => {
      if (entries.every(([key, value]) => (preferences[key] ?? null) === value)) return finishBackup(preferencesFile);
      const next = { ...preferences };
      for (const [key, value] of entries) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      await commitState(preferencesFile, next, maxPreferences, () => { preferences = next; });
    });
  }
  return {
    notices: () => [...notices],
    preferences: () => ({ ...preferences }),
    preference: (key) => preferences[key],
    projects: () => projects.map(({ workspaceId, title }) => ({ workspaceId, title })),
    saveWorkflowAttachments: (files) => update(() => attachments.save(files)),
    readWorkflowAttachments: (refs) => attachments.materialize(refs),
    setPreferences,
    setPreference(key, value) {
      if (!validPreference(key, value === null ? '' : value)) throw new Error('invalid_preference');
      return setPreferences({ [key]: value });
    },
    changeExtensions(change, { canCommit = () => true } = {}) {
      return update(async () => {
        if (!canCommit()) return null;
        const current = readExtensions(preferences[extensionPreferenceKey] ?? null);
        const changed = applyExtensionChange(current, change);
        const next = { ...preferences, [extensionPreferenceKey]: JSON.stringify(changed) };
        await commitState(preferencesFile, next, maxPreferences, () => { preferences = next; });
        return changed;
      });
    },
    changeWorkflows(change) {
      return update(async () => {
        const changed = applyWorkflowChange(readWorkflows(preferences[workflowKey] ?? null), change);
        if (change.op === 'save') {
          const saved = changed.find(({ id }) => id === change.id.toLowerCase());
          for (const stage of saved.stages) {
            if (stage.fileAccess?.attachments.length) await attachments.materialize(stage.fileAccess.attachments);
          }
        }
        const next = { ...preferences, [workflowKey]: JSON.stringify(changed) };
        await commitState(preferencesFile, next, maxPreferences, () => { preferences = next; });
        return changed;
      });
    },
    changeAgentPresets(change) {
      return update(async () => {
        const current = readAgentPresets(preferences[agentPresetKey] ?? null, preferences[legacyAgentPresetKey] ?? null);
        const changed = applyAgentPresetChange(current, change);
        const next = { ...preferences, [agentPresetKey]: JSON.stringify(changed) };
        await commitState(preferencesFile, next, maxPreferences, () => { preferences = next; });
        return changed;
      });
    },
    addProject(path) {
      return update(async () => {
        const directory = await realpath(path);
        if (!(await stat(directory)).isDirectory()) throw new Error('invalid_project');
        const existing = projects.find((project) => project.path.toLowerCase() === directory.toLowerCase());
        if (existing) return finishBackup(projectsFile);
        const next = [...projects, { workspaceId: 'local-' + randomUUID(), path: directory,
          title: basename(directory) || directory }];
        await commitState(projectsFile, next, maxProjects, () => { projects = next; });
      });
    },
    removeProject(id) {
      return update(async () => {
        const next = projects.filter((project) => project.workspaceId !== id);
        if (next.length === projects.length) return finishBackup(projectsFile);
        await commitState(projectsFile, next, maxProjects, () => { projects = next; });
      });
    },
    flush: () => queue,
  };
}
