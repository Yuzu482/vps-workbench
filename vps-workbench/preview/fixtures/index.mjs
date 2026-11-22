import { createHash, randomUUID } from 'node:crypto';
import { checkList, eventBoard, storeBoard } from './examples.mjs';
import { modelParameterFields, validModelParameters } from '../../../remote-workbench/vps-chat/client/model-parameters.js';
import { validateWorkflowDraft, workflowEditPrefix, workflowKey } from '../../workflow-engine/state.mjs';

const settings = Object.freeze({
  host: 'workbench-preview.invalid', port: 22, user: 'preview', workspace: '/home/preview/bookshop',
  identityPath: 'C:/Preview/example-key', knownHostsPath: 'C:/Preview/known_hosts',
  expectedIpv4: '192.0.2.10', expectedIpv6: '2001:db8::10', hostKeyConfirmed: true, provider: 'codex',
});
const previewName = '本地演示';
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fixtureId = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const active = (turn) => turn?.state === 'running';
const ok = (body) => ({ ok: true, ...body });
const terminalOk = (result) => ok({ result });
const fail = (code, message) => ({ ok: false, code, message });
const invalidRequest = () => fail('invalid_request', '预览请求格式无效。');

function model(id, displayName, isDefault, efforts = [], defaultEffort = null) {
  return { id, displayName, isDefault, efforts, defaultEffort };
}

const models = {
  codex: [
    model('preview-codex', 'Codex · 示例模型', true, ['low', 'medium', 'high', 'xhigh'], 'medium'),
    model('preview-codex-mini', 'Codex Mini · 示例模型', false, ['low', 'medium'], 'low'),
  ],
  claude: [model('preview-sonnet', 'Sonnet · 示例模型', true), model('preview-haiku', 'Haiku · 示例模型', false)],
  'claude-sdk': [model('preview-sonnet-sdk', 'Sonnet SDK · 示例模型', true)],
  antigravity: [],
};
const chatProviders = Object.keys(models);
const targetFor = (provider) => hash(`${settings.host}:${provider}`);
const exampleWorkflow = {
  name: '活动页发布',
  stages: [
    { id: 's1', name: '整理发布简报', provider: 'codex', model: 'preview-codex', instruction: '提炼活动页的受众、内容和验收标准。' },
    { id: 's2', name: '撰写页面文案', provider: 'claude-sdk', model: 'preview-sonnet-sdk', instruction: '根据发布简报写出页面文案。' },
    { id: 's3', name: '核对上线清单', provider: 'codex', model: 'preview-codex-mini', instruction: '根据发布简报列出链接、报名和移动端检查项。' },
    { id: 's4', name: '汇总交付', provider: 'antigravity', model: '', instruction: '汇总页面文案和上线清单，列出待确认项。' },
  ],
  edges: [{ from: 's1', to: 's2' }, { from: 's1', to: 's3' }, { from: 's2', to: 's4' }, { from: 's3', to: 's4' }],
};

function workflowExample(prompt) {
  const marker = '\n\n当前草案，作为参考\n';
  const offset = prompt.lastIndexOf(marker);
  if (offset < 0) return exampleWorkflow;
  try {
    const draft = validateWorkflowDraft(JSON.parse(prompt.slice(offset + marker.length)));
    const stages = draft.stages.map(({ agent, agentPreset, ...stage }) => stage);
    stages.at(-1).instruction = exampleWorkflow.stages.at(-1).instruction;
    return { ...draft, name: exampleWorkflow.name, stages };
  } catch { return exampleWorkflow; }
}

function seededSession(number, title, prompt, reply, selectedModel, mode = 'chat') {
  return {
    id: fixtureId(number), title, mode,
    turns: [{
      id: fixtureId(100 + number), prompt, reply, state: 'complete', model: selectedModel,
      contextUsage: { usedTokens: 1840, contextWindow: 32000 },
      activity: [{ title: '预览记录', text: '载入内置示例会话。' }],
    }],
  };
}

function seed(provider) {
  if (provider !== 'codex') {
    return [seededSession(10 + chatProviders.indexOf(provider), '执行端示例对话',
      '给我一份浏览项目的检查清单。', checkList, models[provider][0]?.id)];
  }
  const design = seededSession(2, '纸间书店 · 网站设计', '为一家独立书店设计首页和读书会详情页。',
    `首页突出荐书，详情页集中展示时间、集合地点和预约入口。\n\n${storeBoard}\n\n${eventBoard}`,
    'preview-codex', 'design');
  const first = design.turns[0];
  design.turns.push(
    { ...first, id: fixtureId(202), parentTurnId: first.id, fork: false, prompt: '尝试更温暖的秋季配色。',
      reply: storeBoard.replace('纸间书店 · 首页', '纸间书店 · 秋日首页').replace('#f2eee5', '#f3dfcb') },
    { ...first, id: fixtureId(203), parentTurnId: first.id, fork: true, prompt: '从初稿探索冷青色方向。',
      reply: storeBoard.replace('纸间书店 · 首页', '纸间书店 · 青色分支').replace('#f2eee5', '#dcebe6') },
  );
  return [
    seededSession(1, '纸间书店 · 周末发布清单', '帮我整理周末活动页的上线检查清单。', checkList, 'preview-codex'),
    design,
    seededSession(3, '读书会 · 开场流程', '读书会的前十五分钟可以怎么安排？',
      '先留五分钟签到，然后请每位参加者用一句话介绍自己带来的书。最后公布散步路线和返回时间。', 'preview-codex-mini'),
  ];
}

function readSettings(value) {
  return value?.host === settings.host && value.hostKeyConfirmed === true && typeof value.provider === 'string' &&
    Object.hasOwn(models, value.provider);
}

function validId(id) {
  return typeof id === 'string' && idPattern.test(id);
}

function validPrompt(prompt, limit) {
  return typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= limit && !prompt.includes('\0');
}

function finishTurn(turn, state, reply = turn.reply) {
  turn.reply = reply;
  turn.state = state;
  turn.streaming = false;
  turn.canStop = false;
  turn.canSteer = false;
  for (const request of turn.approvals ?? []) if (request.state === 'pending') request.state = 'closed';
}

function previewLayerRevision(context) {
  const example = /<meta name="dsh-layer-revision" content='([^\r\n']+)'>/.exec(context?.text ?? '')?.[1];
  if (!example) return null;
  try {
    const { base, layer, changes } = JSON.parse(example);
    if (!validId(base) || !/^(?:e[0-9]{1,4}|n[0-9a-f]{16})$/.test(layer)) return null;
    return { base, layer, changes: typeof changes?.text === 'string'
      ? { text: '图层演示 · 已更新' } : { borderRadius: 12 } };
  } catch {
    return null;
  }
}

function readSession(session) {
  const { polls, ...visible } = session;
  const isDesign = session.mode === 'design';
  const canSend = !active(session.turns.at(-1));
  return ok({ session: { ...structuredClone(visible), canSend,
    ...(isDesign ? { turns: designTurns(session).slice(-12), canBranch: canSend } : {}) } });
}

function designTurns(session) {
  return session.turns.map(({ explicitBase, revisionDigest, layerRevision, ...turn }, index) => ({ ...turn,
    parentTurnId: turn.parentTurnId ?? session.turns[index - 1]?.id ?? null, fork: turn.fork === true, ordinal: index + 1 }));
}

function designHistory(session) {
  const turns = designTurns(session);
  const roots = new Map();
  const tips = new Map();
  for (const turn of turns) {
    const root = !turn.fork && roots.get(turn.parentTurnId) || turn.id;
    roots.set(turn.id, root);
    tips.set(root, turn.id);
  }
  return turns.map(({ id, prompt, state, reply, parentTurnId, fork, ordinal }) => ({
    id, parentTurnId, fork, ordinal, state, title: prompt.trim().replace(/\s+/g, ' ').slice(0, 54),
    hasBoards: state === 'complete' && /^~~~html$/m.test(reply),
    canContinue: state === 'complete' && tips.get(roots.get(id)) === id,
  }));
}

export function createPreviewFixtures() {
  const projects = [
    { workspaceId: 'local-preview-bookshop', title: '纸间书店' },
    { workspaceId: 'local-preview-reading-group', title: '周末读书会' },
  ];
  const keyMaterial = [settings.host, settings.port, settings.user, settings.identityPath.toLowerCase(),
    settings.knownHostsPath.toLowerCase(), settings.expectedIpv4, settings.expectedIpv6];
  const toolsKey = `dsh-vps-chat-tools:v1:${hash(JSON.stringify(keyMaterial))}`;
  const preferences = {
    [toolsKey]: JSON.stringify([...chatProviders, 'claude-subscription']),
    [workflowKey]: JSON.stringify([{ id: fixtureId(34), revision: 1, ...exampleWorkflow }]),
    [`dsh-vps-chat-projects:v1:${targetFor('codex')}`]: JSON.stringify({
      [fixtureId(1)]: projects[0].workspaceId,
      [fixtureId(2)]: projects[0].workspaceId,
      [fixtureId(3)]: projects[1].workspaceId,
    }),
  };
  const sessions = new Map(chatProviders.map((provider) => [provider,
    new Map(seed(provider).map((session) => [session.id, session]))]));

  function list(provider) {
    return {
      targetId: targetFor(provider),
      memoryTargetId: targetFor('codex'),
      sessions: Array.from(sessions.get(provider).values()).reverse().map(({ id, title, mode }) => ({ id, title, mode })),
    };
  }

  function send(packet, records, session) {
    const { provider } = packet.settings;
    const { sessionId, turnId, prompt, mode = 'chat', advanced, designBase } = packet;
    if (!validId(turnId) || !validPrompt(prompt, 8192) ||
        (mode !== 'chat' && (mode !== 'design' || provider !== 'codex')) ||
        (Object.hasOwn(packet, 'advanced') && !validModelParameters(provider, advanced))) return invalidRequest();
    if (session?.mode && session.mode !== mode) return fail('mode_conflict', '这个示例会话采用另一种模式。');
    const explicit = Object.hasOwn(packet, 'designBase');
    if (explicit && (mode !== 'design' || !designBase || Object.keys(designBase).length !== 2 ||
        !validId(designBase.parentTurnId) || typeof designBase.fork !== 'boolean' ||
        (designBase.fork && !validPrompt(packet.designContext?.text, 24000)))) return invalidRequest();
    const revisionDigest = explicit ? hash(JSON.stringify(packet.designContext ?? null)) : undefined;
    const repeated = session?.turns.find(({ id }) => id === turnId);
    if (repeated) return repeated.prompt === prompt && repeated.explicitBase?.parentTurnId === designBase?.parentTurnId &&
      repeated.explicitBase?.fork === designBase?.fork && repeated.revisionDigest === revisionDigest && modelParameterFields(provider).every((field) =>
      repeated.advanced?.[field] === advanced?.[field]) ? readSession(session) : fail('turn_conflict', '该轮次已有预览记录。');
    if (active(session?.turns.at(-1))) return fail('session_blocked', '这个示例会话正在生成回复。');
    if (explicit) {
      const parent = session && designHistory(session).find(({ id }) => id === designBase.parentTurnId);
      if (!parent?.hasBoards || (!designBase.fork && !parent.canContinue)) {
        return fail('design_branch_unavailable', '此版本无法继续。请选择分支末端或从这里 Fork。');
      }
    }
    if ((!session && records.size >= 40) || session?.turns.length >= 24) {
      return fail('request_rejected', '当前预览已达到记录上限。');
    }
    const catalog = models[provider];
    const selected = packet.model === undefined ? catalog[0] : catalog.find(({ id }) => id === packet.model);
    if ((packet.model !== undefined && !selected) ||
        (packet.effort !== undefined && !selected?.efforts.includes(packet.effort))) return invalidRequest();
    const record = session ?? { id: sessionId, title: prompt.trim().replace(/\s+/g, ' ').slice(0, 56), mode, turns: [] };
    if (!session && packet.memoryIsolation === true) record.memoryIsolation = true;
    const memoryCount = packet.extensions?.memory?.length ?? 0;
    record.turns.push({
      id: turnId, prompt, reply: mode === 'design' ? '正在生成本地示例画板。' : '正在生成本地示例回复。',
      state: 'running', streaming: true, canStop: true,
      canSteer: mode === 'design' || (provider === 'antigravity' && !packet.workflowFiles),
      ...(explicit ? { ...designBase, explicitBase: designBase, revisionDigest } : {}),
      ...(mode === 'design' ? { layerRevision: previewLayerRevision(packet.designContext) } : {}),
      model: selected?.id, effort: packet.effort ?? advanced?.reasoningEffort ?? selected?.defaultEffort,
      ...(advanced ? { advanced } : {}),
      contextUsage: { usedTokens: 620, contextWindow: 32000 },
      activity: [{ title: '本地预览', text: '正在生成固定示例内容。' },
        ...(memoryCount ? [{ title: '长期记忆', text: `引用了 ${memoryCount} 条示例笔记。` }] : [])],
    });
    record.polls = 0;
    records.delete(sessionId);
    records.set(sessionId, record);
    return readSession(record);
  }

  function refresh(session, turn, provider) {
    if (!active(turn)) return readSession(session);
    if (turn.approvals?.some(({ state }) => state === 'pending')) return readSession(session);
    session.polls++;
    const design = session.mode === 'design';
    const acp = provider === 'antigravity' && turn.canSteer;
    if (acp && session.polls === 5 && /审批|approval/i.test(turn.prompt)) {
      turn.canSteer = false;
      turn.approvals = [{ id: randomUUID(), title: '读取示例文件', detail: '/workspace/preview-sample.txt',
        kind: 'read', canAllow: true, state: 'pending', decision: null }];
      return readSession(session);
    }
    if (session.polls >= (design || acp ? 16 : 4)) {
      if (turn.prompt.startsWith(workflowEditPrefix)) {
        const fence = String.fromCharCode(96).repeat(3);
        finishTurn(turn, 'complete', `本地预览提供一份示例配置。\n\n${fence}vps-workflow\n${JSON.stringify(workflowExample(turn.prompt), null, 2)}\n${fence}`);
        return readSession(session);
      }
      if (turn.layerRevision) {
        const meta = `<meta name="dsh-layer-revision" content='${JSON.stringify(turn.layerRevision)}'>`;
        finishTurn(turn, 'complete', `本地示例已返回图层修改。\n\n~~~html\n<!doctype html><html><head>${meta}<title>图层修改</title></head><body>图层修改示例</body></html>\n~~~`);
        return readSession(session);
      }
      const intro = design ? '示例画板已完成。可以在画布上选中标题、按钮或说明文字。'
        : '这是一条本地演示回复。下面是内置的测试清单。';
      const content = design ? turn.fork ? storeBoard
        .replace('纸间书店 · 首页', `纸间书店 · 分支 ${session.turns.length}`)
        .replace('#f2eee5', '#e2edec') : storeBoard : checkList;
      finishTurn(turn, 'complete', `${intro}\n\n${content}`);
    } else if (session.polls >= 2) {
      turn.reply = design ? '正在准备标题、操作按钮与活动信息。' : '## 本地演示回复\n\n正在整理检查清单。';
    }
    return readSession(session);
  }

  function steer(packet, session, turn) {
    const { steerId, prompt } = packet;
    if (!validId(steerId) || !validPrompt(prompt, 1200)) return invalidRequest();
    const notes = turn.steering ?? [];
    const earlier = notes.find(({ id }) => id === steerId);
    if (earlier) return earlier.prompt === prompt ? readSession(session) : fail('steer_conflict', '该补充已有预览记录。');
    if (!active(turn) || !turn.canSteer) return fail('steer_unavailable', '这轮演示暂时无法接收补充。');
    if (notes.length >= 6) return fail('steer_limit', '这轮演示最多接收六条补充。');
    turn.steering = [...notes, { id: steerId, prompt, state: packet.settings.provider === 'antigravity' ? 'submitted' : 'delivered' }];
    return readSession(session);
  }

  function decideApproval(packet, turn) {
    const { approvalId, decision } = packet;
    if (packet.settings.provider !== 'antigravity' || !validId(approvalId) || !['allow', 'deny'].includes(decision)) {
      return invalidRequest();
    }
    const request = turn.approvals?.find(({ id }) => id === approvalId);
    if (request?.state === 'submitted' && request.decision === decision) return ok({ outcome: 'submitted' });
    if (!active(turn) || request?.state !== 'pending') return fail('approval_unavailable', '这条演示审批已结束。');
    request.state = 'submitted';
    request.decision = decision;
    turn.canSteer = true;
    return ok({ outcome: 'submitted' });
  }

  function chat(packet) {
    if (packet?.op === 'preset') return ok({ preset: { name: previewName, settings: { ...settings }, ...list('codex') } });
    if (packet?.op === 'configuration' && !packet.settings) return ok({ preset: {
      name: previewName, settings: { ...settings }, targetId: targetFor('codex'), memoryTargetId: targetFor('codex'), sessions: [],
    } });
    if (packet?.op === 'account-view') return fail('preview_only', '本地预览不启动账号窗口。');
    if (!readSettings(packet?.settings)) return fail('invalid_settings', '预览仅使用内置的 workbench-preview.invalid 主机。');
    const { provider } = packet.settings;
    if (packet.op === 'configuration') return ok({ targetId: targetFor(provider), memoryTargetId: targetFor('codex'), sessions: [] });
    if (packet.op === 'list') return ok(list(provider));
    if (packet.targetId !== targetFor(provider)) return fail('invalid_settings', '无法找到这个演示连接。');
    if (packet.op === 'models') return ok({ models: structuredClone(models[provider]) });
    if (packet.op === 'setup-check') {
      const status = { ssh: 'connected', account: provider === 'claude' ? 'key_configured' : 'signed_in',
        model: 'model_route_ready', resources: 'resources_ready' }[packet.kind];
      return status ? ok({ targetId: packet.targetId, status }) : invalidRequest();
    }
    if (packet.op === 'model-options') return ok({ fields: modelParameterFields(provider) });
    if (!validId(packet.sessionId)) return invalidRequest();
    const records = sessions.get(provider);
    const session = records.get(packet.sessionId);
    if (packet.op === 'get' && packet.turnId) return ok({ memoryTargetId: targetFor('codex'),
      memoryIsolation: session?.memoryIsolation === true, existingTurn: session?.turns.some(({ id }) => id === packet.turnId) === true });
    if (packet.op === 'send') return send(packet, records, session);
    if (!session) return fail('session_missing', '未找到这段演示会话。');
    const turn = session.turns.at(-1);
    if (packet.op === 'design-history') {
      if (session.mode !== 'design') return fail('design_branch_unavailable', '这段会话没有设计版本。');
      if (!Object.hasOwn(packet, 'turnId')) return ok({ history: designHistory(session) });
      const requested = designTurns(session).find(({ id, state }) => id === packet.turnId && state === 'complete');
      return requested ? ok({ turn: structuredClone(requested) }) : fail('design_branch_unavailable', '这版画板暂不可用。');
    }
    if (packet.op === 'get') return readSession(session);
    if (packet.op === 'refresh') return refresh(session, turn, provider);
    if (turn?.id !== packet.turnId) return invalidRequest();
    if (packet.op === 'steer') return steer(packet, session, turn);
    if (packet.op === 'approval') return decideApproval(packet, turn);
    if (packet.op === 'stop') {
      if (!active(turn)) return ok({ outcome: 'settled' });
      finishTurn(turn, 'stopped');
      return ok({ outcome: 'requested' });
    }
    return invalidRequest();
  }

  let terminalSession;
  let terminalCount = 0;
  const receipts = new Map();

  function appendTerminal(session, type, output = '') {
    const event = { sequence: ++session.lastSequence, type };
    if (type === 'output') event.data = Buffer.from(output).toString('base64');
    session.events.push(event);
    if (session.events.length > 256) session.events.shift();
  }

  function terminal(packet) {
    const { op, sessionId, operationId } = packet ?? {};
    if ((op === 'native-subscription-start' || op === 'native-subscription-current') &&
        (!readSettings(packet.settings) || packet.targetId !== targetFor(packet.settings.provider) ||
         !['new', 'picker'].includes(packet.mode) || packet.requireRelay !== false)) {
      return fail('subscription_preflight_rejected', '终端预览仅支持内置的演示连接。');
    }
    switch (op) {
      case 'native-subscription-start': {
        if (terminalSession?.state === 'ready') return fail('subscription_preflight_rejected', '演示终端已打开。');
        const id = fixtureId(1000 + ++terminalCount);
        terminalSession = { sessionId: id, state: 'ready', lastSequence: 0, events: [] };
        const where = packet.mode === 'picker' ? '已打开一段示例会话。' : '已打开新的示例会话。';
        appendTerminal(terminalSession, 'output', `\x1b[?2004hClaude Code · 本地演示\r\n${where}\r\n此终端仅显示示例响应。\r\n\r\n❯ `);
        receipts.set(id, {
          operationId: id, state: 'busy', exitCode: null, connection: { Host: settings.host },
          options: { workspace: settings.workspace }, createdAt: new Date().toISOString(),
        });
        if (receipts.size > 16) receipts.delete(receipts.keys().next().value);
        return terminalOk({ sessionId: id, state: 'ready' });
      }
      case 'native-subscription-current':
        if (!terminalSession || terminalSession.state === 'closed') {
          return terminalOk({ sessionId: null, acknowledged: 0, gap: false });
        }
        return terminalOk({ sessionId: terminalSession.sessionId, state: terminalSession.state,
          acknowledged: terminalSession.events[0].sequence - 1, gap: false });
      case 'native-list':
        return terminalOk({ records: structuredClone(Array.from(receipts.values()).reverse()), invalid: false, truncated: false });
      case 'native-status': {
        if (!validId(operationId)) return invalidRequest();
        const receipt = receipts.get(operationId);
        return terminalOk({ operationId, state: receipt?.state ?? 'not_found', exitCode: receipt?.exitCode ?? null });
      }
      default:
        break;
    }

    if (typeof sessionId !== 'string' || sessionId !== terminalSession?.sessionId) return invalidRequest();
    const session = terminalSession;
    if (op === 'native-poll') {
      const { after } = packet;
      if (!Number.isSafeInteger(after) || after < 0 || after > session.lastSequence) return invalidRequest();
      return terminalOk({ sessionId, state: session.state, lastSequence: session.lastSequence,
        gap: after < session.events[0].sequence - 1,
        events: session.events.filter(({ sequence }) => sequence > after).slice(0, 64).map((event) => ({ ...event })),
      });
    }
    if (op === 'native-close') {
      if (session.state !== 'closed') {
        session.state = 'closed';
        Object.assign(receipts.get(sessionId), { state: 'finished', exitCode: 0 });
        appendTerminal(session, 'output', '\r\n演示终端已关闭。\r\n');
        appendTerminal(session, 'exit');
      }
      return terminalOk({ state: 'closed' });
    }
    if (op === 'native-resize') {
      const { columns, rows } = packet;
      if (session.state !== 'ready' || !Number.isInteger(columns) || columns < 1 || columns > 500 ||
          !Number.isInteger(rows) || rows < 1 || rows > 300) return invalidRequest();
      return terminalOk({ sessionId, state: session.state, lastSequence: session.lastSequence });
    }
    if (op !== 'native-input' || session.state !== 'ready' || typeof packet.data !== 'string' ||
        packet.data.length > 5464 || !base64Pattern.test(packet.data)) return invalidRequest();
    const bytes = Buffer.from(packet.data, 'base64');
    if (!bytes.length || bytes.length > 4096) return invalidRequest();
    if (bytes.includes(13)) appendTerminal(session, 'output', '\r\n已收到一条演示消息。\r\n\r\n❯ ');
    else if (bytes.includes(27)) appendTerminal(session, 'output', '\r\n已中断这次演示输入。\r\n❯ ');
    return terminalOk({ accepted: true });
  }

  const extractions = new Map();
  function extractMemory(packet) {
    if (packet.op === 'send' && packet.memoryExtraction === true) {
      const { prompt } = JSON.parse(packet.prompt);
      const size = /(?:图标).*?(\d{1,3})\s*[×xX*]\s*(\d{1,3})/.exec(prompt);
      const lines = /摘要.*?([一二两三四五六七八九十\d]+)\s*行/.exec(prompt) ?? /([一二两三四五六七八九十\d]+)\s*行.*?摘要/.exec(prompt);
      const preference = lines && /(?:习惯|偏好|默认|以后|喜欢)/.test(prompt)
        ? [{ title: '摘要格式偏好', text: `摘要默认使用${lines[1]}行要点。` }] : [];
      const projectNotes = size && /(?:定稿|统一|确定|规范)/.test(prompt)
        ? [{ title: '图标尺寸', text: `项目图标统一使用 ${size[1]}×${size[2]} 像素。` }] : [];
      const memories = packet.memoryScope === 'personal' ? preference : projectNotes;
      extractions.set(packet.sessionId, { id: packet.turnId, state: 'complete', reply: JSON.stringify({ memories }) });
      if (extractions.size > 32) extractions.delete(extractions.keys().next().value);
    }
    const turn = extractions.get(packet.sessionId);
    return turn ? ok({ session: { id: packet.sessionId, turns: [turn] } }) : fail('session_missing', '示例提炼记录不存在。');
  }

  return { preferences, projects, chat, terminal, extractMemory };
}
