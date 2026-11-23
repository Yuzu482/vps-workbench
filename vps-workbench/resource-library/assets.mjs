import { Lexer, walkTokens } from 'marked';
import { createArtboard, extractHtmlFences, isClosedHtmlFence } from '../../remote-workbench/vps-chat/client/design-preview.js';
import { rasterDataUrl, readDesignProject } from '../../remote-workbench/vps-chat/client/design-state.js';
import { readLayerRevision } from '../../remote-workbench/vps-chat/client/design-layer-revision.js';

function codeLanguage(token) {
  const lines = token.raw.trimEnd().split(/\r?\n/);
  const start = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/.exec(lines[0]);
  const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1));
  if (lines.length < 3 || !start || !end || start[1][0] !== end[1][0] || start[1].length > end[1].length) {
    return null;
  }
  return start[2].replace(/[\p{C}]/gu, '').slice(0, 32);
}

export function extractResources(scope, row, session, { storage, includeBoardText = false } = {}) {
  if (session?.id !== row.id || !Array.isArray(session.turns)) throw new Error('Invalid session');
  const designMode = (session.mode ?? row.mode) === 'design';
  const designKey = `dsh-vps-design:v1:${scope}:${row.id}`;
  const design = designMode ? readDesignProject(designKey, storage) : null;
  const items = [];
  let partial = Boolean(design?.warning);
  for (const turn of session.turns.slice().reverse()) {
    if (turn.state !== 'complete' || typeof turn.id !== 'string' || typeof turn.reply !== 'string') continue;
    let resourceIndex = 0;
    const add = (asset) => items.push({
      id: `${row.id}:${turn.id}:${resourceIndex++}`,
      sessionId: row.id,
      sessionTitle: session.title || row.title || '未命名会话',
      turnId: turn.id,
      projectId: row.projectId,
      ...asset,
    });
    let tokens;
    try {
      tokens = Lexer.lex(turn.reply, { gfm: true });
    } catch {
      partial = true;
      continue;
    }
    const revision = designMode ? readLayerRevision(designKey, turn, storage) : null;
    const sources = revision ? revision.sources ?? [] : designMode ? extractHtmlFences(turn.reply) : [];
    const boards = new Map();
    if (sources.length) {
      const htmlFences = tokens.filter((token) => isClosedHtmlFence(token) && token.text.trim());
      sources.forEach((source, offset) => {
        const boardIndex = offset + 1;
        const board = createArtboard(source, design.project.versions[turn.id]?.[boardIndex] ?? revision?.boards[boardIndex],
          `画板 ${boardIndex}`);
        if (!board) {
          partial = true;
          return;
        }
        const asset = { kind: 'design', title: board.title, boardIndex, source: board.html,
          ...(includeBoardText && { text: board.layers.map(({ text }) => text).filter(Boolean).join('\n') }) };
        if (revision) add(asset);
        else boards.set(htmlFences[offset], asset);
      });
    }
    walkTokens(tokens, (token) => {
      const board = boards.get(token);
      if (board) {
        add(board);
      } else if (token.type === 'code' && token.text.trim() && !(revision && isClosedHtmlFence(token))) {
        const language = codeLanguage(token);
        if (language !== null) add({ kind: 'code', title: `${language || '纯文本'} 代码块`, language, source: token.text });
      } else if (token.type === 'image') {
        const source = rasterDataUrl(token.href);
        if (source) add({ kind: 'image', title: token.text.trim().slice(0, 100) || '嵌入图片', source });
      }
    });
  }
  return { items, partial };
}

export async function indexResources({ scope, sessions, readSession, signal, onResult }) {
  if (!scope) return;
  for (const row of sessions) {
    if (signal.aborted) return;
    let result;
    try {
      const session = await readSession(row, signal);
      if (signal.aborted) return;
      result = extractResources(scope, row, session);
    } catch {
      result = { items: [], partial: true };
    }
    if (signal.aborted) return;
    onResult(result);
  }
}
