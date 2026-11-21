import { workbenchStorage } from './workbench-storage.js';

export const membershipKey = (targetId) => `dsh-vps-chat-projects:v1:${targetId}`;
export const pinnedProjectsKey = 'dsh-vps-chat:pinned-projects:v1';
const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const projectMembershipFor = (memberships, sessionId) => memberships[sessionId?.toLowerCase()];
export const projectMembershipId = (entry) => typeof entry === 'string' ? entry : entry?.projectId ?? '';
export const projectMembershipIsolated = (entry) => entry?.memory === 'isolated';

function validMembership(entry) {
  if (typeof entry === 'string') return Boolean(entry);
  return entry && !Array.isArray(entry) && typeof entry.projectId === 'string' && entry.projectId &&
    projectMembershipIsolated(entry) && Object.keys(entry).length === 2;
}

export function parseProjectMemberships(data) {
  if (data == null) return {};
  const memberships = JSON.parse(data);
  if (!memberships || typeof memberships !== 'object' || Array.isArray(memberships)) {
    throw new Error('本机的会话归类数据无效。');
  }
  const normalized = new Map();
  for (const [id, entry] of Object.entries(memberships)) {
    const key = id.toLowerCase();
    if (!sessionIdPattern.test(id) || !validMembership(entry) || normalized.has(key)) {
      throw new Error('本机的会话归类数据无效。');
    }
    normalized.set(key, entry);
  }
  return Object.fromEntries(normalized);
}

export function readProjectMemberships(targetId) {
  return parseProjectMemberships(workbenchStorage.getItem(membershipKey(targetId)));
}

export function updateProjectMembership(previous, sessionId, projectId, inheritMemory) {
  const memberships = { ...previous };
  const id = sessionId.toLowerCase();
  if (!projectId) delete memberships[id];
  else if (inheritMemory === false) memberships[id] = { projectId, memory: 'isolated' };
  else if (inheritMemory === true || projectMembershipId(memberships[id]) !== projectId) memberships[id] = projectId;
  return memberships;
}

export function readPinnedProjects() {
  try {
    const ids = JSON.parse(workbenchStorage.getItem(pinnedProjectsKey) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : []);
  } catch { return new Set(); }
}

export const projectFoldersCss = `
  [data-vps-chat] .vc-projects {
    display:grid; flex:none; gap:5px; padding-block-end:10px; border-bottom:1px solid var(--vc-line);
  }
  [data-vps-chat] .vc-projects-heading {
    margin:0; padding-inline:8px; font-size:12px; font-weight:650; color:var(--vc-muted);
  }
  [data-vps-chat] .vc-project-list {
    display:grid; align-content:start; gap:2px; max-block-size:min(205px,28vh); overflow:auto;
    overscroll-behavior:contain; scrollbar-width:thin;
  }
  [data-vps-chat] .vc-project-filter {
    display:flex; align-items:center; gap:8px; width:100%; min-width:0; min-height:28px;
    padding:4px 8px; border:0; border-radius:7px; background:transparent;
    text-align:start; font-size:13px; color:var(--vc-muted);
  }
  [data-vps-chat] .vc-project-filter:hover {background:var(--vc-hover); color:var(--vc-ink)}
  [data-vps-chat] .vc-project-filter[aria-pressed=true] {background:var(--vc-tint); color:var(--vc-accent); font-weight:650}
  [data-vps-chat] .vc-project-filter:focus-visible {outline-offset:-2px}
  [data-vps-chat] .vc-project-name {min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  [data-vps-chat] .vc-project-status {margin:2px 8px; font-size:12px; color:var(--vc-muted)}
  [data-vps-chat] .vc-project-icon {
    display:block; position:relative; flex:none; width:13px; height:9px; margin-top:3px;
    border:1px solid currentColor; border-radius:2px;
  }
  [data-vps-chat] .vc-project-icon::before {
    content:''; position:absolute; inset:-4px auto auto -1px; width:6px; height:4px;
    border:1px solid currentColor; border-bottom:0; border-radius:2px 2px 0 0;
  }
  [data-vps-chat] .vc-heading-title {display:flex; align-items:center; gap:8px; min-width:0}
  [data-vps-chat] .vc-heading-title > strong {min-width:0}
  [data-vps-chat] .vc-project-picker {
    display:block; position:relative; flex:0 1 auto; min-width:0; max-width:min(50%,180px);
    border-radius:6px; color:var(--vc-muted); line-height:1.35;
  }
  [data-vps-chat] .vc-project-picker:hover {background:var(--vc-hover); color:var(--vc-accent)}
  [data-vps-chat] .vc-project-picker .vc-project-icon {
    position:absolute; inset:calc(50% - 6px) auto auto 5px; pointer-events:none;
  }
  [data-vps-chat] .vc-project-picker::after {
    content:''; position:absolute; inset:calc(50% - 4px) 7px auto auto; width:5px; height:5px;
    border:solid currentColor; border-width:0 1px 1px 0; rotate:45deg; pointer-events:none;
  }
  [data-vps-chat] .vc-project-picker select {
    display:block; appearance:none; field-sizing:content; max-width:100%; min-width:0;
    padding:3px 18px 3px 23px; border:0; border-radius:6px; background:transparent; cursor:pointer;
    overflow:hidden; text-overflow:ellipsis; font-size:12px;
  }
  [data-vps-chat] .vc-project-picker option {background:var(--vc-surface); color:var(--vc-ink)}
  [data-vps-chat] .vc-project-warning {
    margin:0; padding:6px var(--vc-gutter); background:var(--vc-warn-bg); color:var(--vc-warn); font-size:12px;
  }
`;
