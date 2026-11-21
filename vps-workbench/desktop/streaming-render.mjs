export function createStreamingMarkdownParser() {
  let worker;
  let unavailable = false;
  let sequence = 0;
  let frame = null;
  let active = null;
  let pending = null;

  function fail() {
    unavailable = true;
    worker?.terminate();
    const jobs = [active, pending];
    active = pending = null;
    for (const job of jobs) job?.complete?.(null);
  }

  function schedule() {
    if (unavailable || frame !== null || active || !pending) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!pending) return;
      active = pending;
      pending = null;
      try {
        if (!worker) {
          worker = new Worker('/markdown-worker.js', { type: 'module' });
          worker.addEventListener('message', ({ data }) => {
            if (data.id !== active?.id) return;
            const complete = active.complete;
            active = null;
            complete?.(Array.isArray(data.tokens) ? data.tokens : null);
            schedule();
          });
          worker.addEventListener('error', fail);
          worker.addEventListener('messageerror', fail);
        }
        worker.postMessage({ id: active.id, source: active.source });
      } catch {
        fail();
      }
    });
  }

  return (source, complete) => {
    if (unavailable) {
      complete(null);
      return undefined;
    }
    // The visible session only needs its newest unparsed snapshot.
    const job = { id: ++sequence, source, complete };
    pending = job;
    schedule();
    return () => {
      job.complete = null;
      if (pending === job) pending = null;
    };
  };
}

function sameJson(first, second, depth = 0) {
  if (first === second) return true;
  if (!first || !second || typeof first !== 'object' || typeof second !== 'object' ||
      depth >= 8 || Array.isArray(first) !== Array.isArray(second)) return false;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length &&
    keys.every((key) => Object.hasOwn(second, key) && sameJson(first[key], second[key], depth + 1));
}

export function stabilizeStreamingRecord(previous, next) {
  const before = previous?.session;
  const after = next.session;
  if (before?.id !== after.id || before.mode !== after.mode) return next;
  const turns = after.turns.map((turn, index) => sameJson(before.turns[index], turn) ? before.turns[index] : turn);
  const sameTurns = turns.length === before.turns.length && turns.every((turn, index) => turn === before.turns[index]);
  const record = { ...next, session: { ...after, turns: sameTurns ? before.turns : turns } };
  return sameTurns && sameJson(previous, record) ? previous : record;
}
