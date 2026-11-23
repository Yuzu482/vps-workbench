import { createHash } from 'node:crypto';
import { extractResources } from '../resource-library/assets.mjs';
import { readWorkflowRun } from '../workflow-engine/runner.mjs';
import { exactFields, localWorkflowRunKey, mixedWorkflowHistoryKey, mixedWorkflowRunKey, readWorkflows,
  workflowKey, workflowRunKey } from '../workflow-engine/state.mjs';
import { membershipKey, parseProjectMemberships, projectMembershipFor, projectMembershipId } from '../../remote-workbench/vps-chat/client/project-folders.js';
import { conversationOptionsKey } from '../../remote-workbench/vps-chat/client/conversation-actions.js';
import { readMixedRunHistory } from './mixed-run-history.mjs';

const maxEntries = 16000;
const maxCorpusCharacters = 36 * 1024 * 1024;
const fieldLimit = 64000;
const typeLabels = { message: '消息', project: '项目', board: '画板', workflow: '工作流', artifact: '产物' };
const providerLabels = { codex: 'Codex', claude: 'Claude API', 'claude-sdk': 'Claude Agent SDK', antigravity: 'Antigravity ACP' };
const shared = { id: 'desktop', label: '本机 · 共享工作区', location: 'shared' };
const tokens = (text) => text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
const tidy = (text) => typeof text === 'string' ? text.slice(0, fieldLimit).replace(/[\x00-\x08\x0e-\x1f]/gu, '') : '';
const idFor = (key) => createHash('sha256').update(JSON.stringify(key)).digest('hex');

function groupFor({ location, targetId, configuration, provider }) {
  const label = location === 'local-sdk' ? '本机 SDK' : 'VPS SSH';
  return { id: location + ':' + targetId, location,
    label: [label, tidy(configuration).trim().slice(0, 100) || '配置 ' + targetId.slice(0, 12), providerLabels[provider]].filter(Boolean).join(' · ') };
}

function snippet(fields, terms) {
  const original = fields.find((field) => terms.some((term) => tokens(field).includes(term))) ?? fields[0] ?? '';
  const line = original.replace(/\s+/gu, ' ');
  const index = terms.map((term) => tokens(line).indexOf(term)).find((offset) => offset >= 0) ?? 0;
  const offset = Math.max(0, index - 36);
  return (offset > 0 ? '…' : '') + line.slice(offset, offset + 150) + (line.length > offset + 150 ? '…' : '');
}

export function createGlobalSearch({ data, source, artifacts = () => [] }) {
  let cache;
  let pending;
  async function build() {
    const { sessions, partial } = await source();
    const list = new Map();
    const routes = new Map();
    const configurations = new Map();
    const memberships = new Map();
    const conversationNames = new Map();
    const projects = new Map((data?.projects?.() ?? []).map((project) => [project.workspaceId, project]));
    const projectGroups = new Map();
    const storage = { getItem: (key) => data?.preference(key) ?? null };
    let incomplete = partial;
    let used = 0;
    const add = (key, type, group, name, fields, detail) => {
      if (list.size >= maxEntries) { incomplete = true; return; }
      const id = idFor(key);
      const body = fields.map(tidy).filter(Boolean);
      const title = tidy(name).trim().slice(0, 150) || typeLabels[type];
      const search = tokens([title, typeLabels[type], ...body].join('\n'));
      const cost = search.length + (detail.html?.length ?? 0);
      if (used + cost > maxCorpusCharacters) { incomplete = true; return; }
      used += cost;
      list.set(id, { id, type, title, group, fields: body, titleSearch: tokens(title), search, detail });
    };
    for (const session of sessions) {
      const { location, provider, targetId, profileId, id, turns } = session;
      const group = groupFor(session);
      routes.set(targetId, group);
      if (profileId) configurations.set(profileId, group);
      if (!memberships.has(targetId)) {
        try { memberships.set(targetId, parseProjectMemberships(storage.getItem(membershipKey(targetId)))); }
        catch { memberships.set(targetId, {}); incomplete = true; }
        try { conversationNames.set(targetId, JSON.parse(storage.getItem(conversationOptionsKey(targetId)))); }
        catch { incomplete = true; }
      }
      const projectId = projectMembershipId(projectMembershipFor(memberships.get(targetId), id));
      const project = projects.get(projectId);
      if (project) {
        if (!projectGroups.has(projectId)) projectGroups.set(projectId, new Map());
        projectGroups.get(projectId).set(group.id, group);
      }
      const title = conversationNames.get(targetId)?.[id]?.title || session.title;
      const nav = { location, provider, targetId, sessionId: id };
      for (const turn of turns) {
        add([group.id, id, turn.id], 'message', group, title,
          [turn.prompt, turn.reply, ...(turn.supplemental ?? []), project?.title], { nav: { ...nav, turnId: turn.id }, projectId,
            prompt: turn.prompt, reply: turn.reply, supplemental: turn.supplemental });
      }
      if (session.mode !== 'design' || list.size >= maxEntries || used >= maxCorpusCharacters) continue;
      const design = extractResources(targetId, { id, title }, session, { includeBoardText: true, storage });
      incomplete ||= design.partial;
      for (const item of design.items.filter(({ kind }) => kind === 'design')) {
        add([group.id, id, item.turnId, item.boardIndex], 'board', group, item.title,
          [title, item.text, project?.title], { nav: { ...nav, turnId: item.turnId, boardIndex: item.boardIndex },
            projectId, html: item.source, version: item.turnId });
      }
    }
    for (const [id, project] of projects) {
      const groups = projectGroups.get(id)?.values() ?? [shared];
      for (const group of groups) add(['project', id, group.id], 'project', group, project.title, [],
        { projectId: id, relatedGroup: group.id === shared.id ? undefined : group.id });
    }
    const groupForStage = (stage) => {
      const execution = stage?.execution;
      if (!execution) return shared;
      return configurations.get(execution.configId) ?? routes.get(execution.configId) ??
        groupFor({ location: execution.location, targetId: execution.configId, provider: stage.provider });
    };
    try {
      for (const item of readWorkflows(storage.getItem(workflowKey))) {
        const groups = new Map(item.stages.map((stage) => {
          const group = groupForStage(stage);
          return [group.id, group];
        }));
        for (const group of groups.values()) add(['workflow', item.id, group.id], 'workflow', group, item.name,
          item.stages.flatMap(({ name, instruction }) => [name, instruction]), { workflowId: item.id, revision: item.revision,
            stages: item.stages.map(({ id, name, instruction, provider, model }) => ({ id, name, instruction, provider, model })),
            edges: item.edges });
      }
    } catch { incomplete = true; }
    const runs = new Map();
    for (const [key, location] of [[mixedWorkflowRunKey, null], [workflowRunKey, 'ssh-vps'], [localWorkflowRunKey, 'local-sdk']]) {
      try {
        const run = readWorkflowRun(storage.getItem(key));
        if (run) runs.set(run.id, { run, location });
      } catch { incomplete = true; }
    }
    try {
      for (const { run } of readMixedRunHistory(storage.getItem(mixedWorkflowHistoryKey))) {
        if (!runs.has(run.id)) runs.set(run.id, { run, location: null });
      }
    } catch { incomplete = true; }
    const savedArtifacts = new Map(artifacts().map((item) => [JSON.stringify([item.runId, item.turnId, item.path]), item]));
    for (const [runId, { run, location }] of runs) {
      for (const [index, row] of run.rows.entries()) {
        const stage = run.workflow.stages[index];
        const route = stage.execution?.location ?? location;
        if (route === 'local-sdk' && row.reply && ['complete', 'failed', 'stopped'].includes(row.state)) {
          const key = JSON.stringify([runId, row.turnId, '阶段结果.md']);
          if (!savedArtifacts.has(key)) savedArtifacts.set(key, { runId, turnId: row.turnId, targetId: row.targetId,
            path: '阶段结果.md', text: row.reply });
        }
      }
    }
    for (const item of savedArtifacts.values()) {
      const record = runs.get(item.runId);
      if (!record) continue;
      const { run, location } = record;
      const index = run.rows.findIndex(({ turnId, targetId }) => turnId === item.turnId && targetId === item.targetId);
      if (index === -1) continue;
      const stage = run.workflow.stages[index];
      const route = stage.execution?.location ?? location;
      const group = routes.get(item.targetId) ?? (stage.execution ? groupForStage(stage) :
        groupFor({ location: route, targetId: item.targetId, provider: stage.provider }));
      add(['artifact', item.runId, item.turnId, item.path], 'artifact', group, item.path, [run.workflow.name, stage.name, item.text],
        { runId: item.runId, stageIndex: index, stageName: stage.name, workflow: run.workflow.name, text: item.text,
          size: item.size, turnId: item.turnId, runLocation: route, mixed: Boolean(run.mixed) });
    }
    return { list, incomplete, created: Date.now() };
  }

  async function index(refresh = false) {
    if (pending) return pending;
    if (!refresh && cache && Date.now() - cache.created < 10000) return cache;
    pending = build().then((value) => { cache = value; return value; }).finally(() => { pending = null; });
    return pending;
  }

  return async function request(body) {
    try {
      if (body?.op === 'detail' && exactFields(body, 'op', 'id') && typeof body.id === 'string') {
        const item = (cache ?? await index()).list.get(body.id);
        if (item) {
          const { id, type, title, group, detail } = item;
          return { ok: true, item: { id, type, title, group, ...detail } };
        }
      }
      if (body?.op === 'search' && exactFields(body, 'op', 'query', 'refresh', 'projectId', 'groupId') &&
          typeof body.query === 'string' && body.query.length <= 160 && typeof body.refresh === 'boolean' &&
          [body.projectId, body.groupId].every((value) => value === null || typeof value === 'string' && value.length <= 150)) {
        const terms = tokens(body.query).split(' ').filter(Boolean);
        if (!terms.length && body.projectId === null) return { ok: true, results: [], total: 0, partial: false };
        const { list, incomplete } = await index(body.refresh);
        const matches = [];
        for (const item of list.values()) {
          if (body.projectId !== null && (item.type === 'project' || item.detail.projectId !== body.projectId)) continue;
          if (body.groupId !== null && item.group.id !== body.groupId) continue;
          if (terms.every((term) => item.search.includes(term))) matches.push(item);
        }
        matches.sort((left, right) => Number(terms.every((term) => right.titleSearch.includes(term))) -
          Number(terms.every((term) => left.titleSearch.includes(term))));
        return { ok: true, total: matches.length, partial: incomplete,
          results: matches.slice(0, 100).map(({ id, type, title, group, fields }) =>
            ({ id, type, title, group, excerpt: snippet(fields, terms) })) };
      }
    } catch { return { ok: false, message: '本机搜索索引暂不可用，请重试。' }; }
    return { ok: false, message: '该搜索结果已变化，请重新搜索。' };
  };
}
