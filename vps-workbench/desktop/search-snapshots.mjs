import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const searchTargetId = /^[a-f0-9]{64}$/u;
export const searchUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const providers = new Set(['codex', 'claude', 'claude-sdk', 'antigravity']);
const conversationName = /^conversation-([a-f0-9-]{36})[.]json$/u;
const safePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

async function entries(directory) {
  const status = await lstat(directory);
  if (!status.isDirectory() || !safePath(await realpath(directory), resolve(directory))) throw new Error('unsafe_search_directory');
  return readdir(directory, { withFileTypes: true });
}

async function readFileBounded(path, limit, budget) {
  if (budget.files <= 0 || budget.bytes <= 0) {
    budget.partial = true;
    return null;
  }
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.size > limit || !safePath(await realpath(path), resolve(path))) {
      budget.partial = true;
      return null;
    }
    if (status.size > budget.bytes) { budget.partial = true; return null; }
    const handle = await open(path, 'r');
    budget.files--;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino) {
        budget.partial = true;
        return null;
      }
      const bytes = Buffer.alloc(Math.min(limit, budget.bytes, opened.size) + 1);
      const { bytesRead } = await handle.read(bytes);
      if (bytesRead !== opened.size || bytesRead > limit || bytesRead > budget.bytes) {
        budget.partial = true;
        return null;
      }
      budget.bytes -= bytesRead;
      return bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'ENOENT') budget.partial = true;
    return null;
  }
}

async function json(path, limit, budget) {
  const bytes = await readFileBounded(path, limit, budget);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { budget.partial = true; return null; }
}

export async function readVpsSearchSnapshots(root) {
  const budget = { files: 14000, bytes: 80 * 1024 * 1024, partial: false };
  const sessions = [];
  let groups;
  try { groups = await entries(root); }
  catch (error) { return { sessions, partial: error.code !== 'ENOENT' }; }
  const preset = await json(join(root, 'default-target.json'), 64 * 1024, budget);
  const volumes = groups.filter((entry) => searchTargetId.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()));
  volumes.sort((left, right) => Number(right.name === preset?.targetId) - Number(left.name === preset?.targetId));
  outer: for (const { name: targetId } of volumes) {
    const directory = join(root, targetId);
    let records;
    try { records = await entries(directory); }
    catch { budget.partial = true; continue; }
    const names = new Set(records.map(({ name }) => name));
    for (const { name } of records) {
      const id = conversationName.exec(name)?.[1];
      if (!id || !searchUuid.test(id)) continue;
      if (budget.files <= 0 || budget.bytes <= 0 || sessions.length >= 4000) { budget.partial = true; break outer; }
      const record = await json(join(directory, name), 1024 * 1024, budget);
      if (!record) continue;
      if (record.MemoryExtraction || record.OuterOnly || record.ClaudeAccountSourceId) continue;
      if (record.Version !== 1 || record.Id !== id || !providers.has(record.Provider) ||
          !Array.isArray(record.Turns) || record.Turns.length > 100) { budget.partial = true; continue; }
      const mode = record.Provider === 'codex' && names.has('design-' + id) &&
        (await readFileBounded(join(directory, 'design-' + id), 1, budget))?.[0] === 1 ? 'design' : 'chat';
      const turns = [];
      const seen = new Set();
      for (const saved of record.Turns) {
        const { TaskId: turnId, Prompt: prompt } = saved ?? {};
        if (!searchUuid.test(turnId) || seen.has(turnId) || typeof prompt !== 'string' ||
            prompt.length > 8192 || !prompt.trim() || prompt.includes('\0')) { budget.partial = true; continue; }
        seen.add(turnId);
        const output = await json(join(directory, 'turn-' + turnId + '.json'), 192 * 1024, budget);
        const reply = typeof output?.reply === 'string' && output.reply.length <= 24000 ? output.reply : '';
        const supplemental = [];
        if (names.has('steering-' + turnId + '.json')) {
          const notes = await json(join(directory, 'steering-' + turnId + '.json'), 48 * 1024, budget);
          if (Array.isArray(notes)) for (const note of notes.slice(0, 6)) {
            const observed = Array.isArray(output?.steering) ? output.steering.find((item) => item?.id === note?.id)?.state : null;
            if (['submitted', 'delivered', 'next'].includes(observed ?? note?.state) &&
                typeof note.prompt === 'string' && note.prompt.length <= 1200) supplemental.push(note.prompt);
          }
        }
        turns.push({ id: turnId, prompt, reply, supplemental, state: output?.state === 'complete' && saved.ThreadId ? 'complete' : 'saved' });
      }
      if (turns.length) sessions.push({ id, turns, targetId, location: 'ssh-vps', provider: record.Provider, mode,
        configuration: preset?.targetId === targetId ? preset.name : undefined,
        title: turns[0].prompt.trim().replace(/\s+/gu, ' ').slice(0, 54) });
    }
  }
  return { sessions, partial: budget.partial };
}
