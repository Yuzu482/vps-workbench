const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const states = new Set(['pending', 'running', 'stopping', 'complete', 'failed', 'stopped', 'unknown']);
const activeStates = new Set(['pending', 'running', 'stopping', 'unknown']);
const validId = (id) => typeof id === 'string' && guid.test(id);

export function validDesignTurn(turn) {
  if (!['parentTurnId', 'fork', 'ordinal'].some((key) => Object.hasOwn(turn, key))) return true;
  return (turn.parentTurnId === null || validId(turn.parentTurnId)) && turn.parentTurnId !== turn.id &&
    typeof turn.fork === 'boolean' && (!turn.fork || turn.parentTurnId !== null) &&
    Number.isSafeInteger(turn.ordinal) && turn.ordinal > 0 && turn.ordinal <= 100;
}

export function readVersionHistory(data) {
  const { history } = data;
  if (!Array.isArray(history) || history.length > 100) throw new Error('无法读取设计历史。');
  const seen = new Set();
  return history.map((entry, index) => {
    if (!entry || !validId(entry.id) || seen.has(entry.id) || !validDesignTurn(entry) ||
        entry.ordinal !== index + 1 || (entry.parentTurnId !== null && !seen.has(entry.parentTurnId)) ||
        typeof entry.title !== 'string' || entry.title.length > 240 || !states.has(entry.state) ||
        typeof entry.hasBoards !== 'boolean' || typeof entry.canContinue !== 'boolean') {
      throw new Error('无法确认设计版本的来源。');
    }
    seen.add(entry.id);
    return entry;
  });
}

export function designVersionNodes(history, turns, versions) {
  const summaries = new Map(history.map((entry) => [entry.id, entry]));
  const visible = new Set(versions.map(({ id }) => id));
  turns.forEach((turn, index) => {
    const saved = summaries.get(turn.id);
    const previous = turns[index - 1];
    summaries.set(turn.id, {
      id: turn.id,
      parentTurnId: Object.hasOwn(turn, 'parentTurnId') ? turn.parentTurnId
        : saved ? saved.parentTurnId : previous?.id ?? null,
      fork: turn.fork ?? saved?.fork ?? false,
      ordinal: turn.ordinal ?? saved?.ordinal ?? index + 1,
      title: saved?.title || turn.prompt.trim().replace(/\s+/g, ' ').slice(0, 54) || '设计稿',
      state: turn.state,
      hasBoards: turn.state === 'complete' && visible.has(turn.id),
      canContinue: turn.state === 'complete' && (saved ? saved.canContinue : index === turns.length - 1),
    });
  });
  const rows = [...summaries.values()].sort((a, b) => a.ordinal - b.ordinal);
  const candidates = rows.filter((row) => row.hasBoards || activeStates.has(row.state) ||
    (row.fork && (row.state === 'failed' || row.state === 'stopped')));
  const candidateIds = new Set(candidates.map(({ id }) => id));
  return candidates.map((row) => {
    let parentId = row.parentTurnId;
    let fork = row.fork;
    // A clarification without a board still belongs to its native branch.
    while (parentId && !candidateIds.has(parentId)) {
      const parent = summaries.get(parentId);
      if (!parent || parent.ordinal >= row.ordinal) {
        parentId = null;
        break;
      }
      fork ||= parent.fork;
      parentId = parent.parentTurnId;
    }
    const status = row.hasBoards ? 'ready' : row.state === 'unknown' ? 'unknown' : activeStates.has(row.state) ? 'running' : 'failed';
    return { id: row.id, parentId, number: row.ordinal, title: row.title, status, fork, canContinue: row.canContinue };
  });
}
