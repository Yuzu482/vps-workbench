import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = fileURLToPath(new URL('.', import.meta.url));
const { outputFiles } = await build({
  stdin: { contents: `
    export { extractResources, indexResources } from './assets.mjs';
    export { setWorkbenchStorage } from '../../remote-workbench/vps-chat/client/workbench-storage.js';
  `, resolveDir: directory },
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { extractResources, indexResources, setWorkbenchStorage } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const scope = 'verified-target';
const row = { id: 'session', title: 'Saved conversation', mode: 'chat', projectId: 'project' };
const turnId = '00000000-0000-4000-8000-000000000042';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

test('only closed code fences and safe embedded images from completed replies become resources', () => {
  const session = { id: row.id, turns: [
    { id: 'other', state: 'running', reply: '~~~js\nactive()\n~~~' },
    { id: 'stopped', state: 'stopped', reply: '~~~js\nstopped()\n~~~' },
    { id: turnId, state: 'complete', prompt: '~~~js\nuserText()\n~~~', reply: [
      '> ~~~TypeScript file.ts', '> const OriginalCase = true;', '> ~~~', '',
      '    indented code', '', `![Local](${png})`,
      '![Remote](https://example.invalid/test.png)',
      '![Vector](data:image/svg+xml;base64,PHN2Zz4=)',
      '', '```js', 'unclosed()',
    ].join('\n') },
  ] };
  const { items, partial } = extractResources(scope, row, session);
  assert.equal(partial, false);
  assert.deepEqual(items.map(({ kind, title, source, turnId }) => ({ kind, title, source, turnId })), [
    { kind: 'code', title: 'TypeScript 代码块', source: 'const OriginalCase = true;', turnId },
    { kind: 'image', title: 'Local', source: png, turnId },
  ]);
});

test('design cards retain source turn and board order and render local edits with the sanitized preview', () => {
  const designMode = { ...row, mode: 'design' };
  const designKey = `dsh-vps-design:v1:${scope}:${row.id}`;
  const requestedKeys = [];
  setWorkbenchStorage({ getItem: (key) => {
    requestedKeys.push(key);
    return key === designKey ? JSON.stringify({ versions: { [turnId]: { 2: { edits: { e1: { text: 'Locally edited' } } } } } }) : null;
  } });
  const session = { id: row.id, turns: [{ id: turnId, state: 'complete', reply: [
    '~~~html', '<title>First</title><h1>One</h1>', '~~~', '', '```css', 'div { color: red }', '```', '',
    '```html', `<title>Second</title><h1 onclick="fetch('a')">Two</h1><img src="https://example.invalid/img.png">`,
    '<script>fetch("https://example.invalid/script")</script>', '```',
  ].join('\n') }] };
  const { items, partial } = extractResources(scope, designMode, session);
  assert.equal(requestedKeys[0], designKey);
  assert.ok(requestedKeys.slice(1).every((key) => key.startsWith(`${designKey}:revision:${turnId}`)));
  assert.equal(partial, false);
  assert.deepEqual(items.map(({ kind, title, boardIndex, turnId }) => ({ kind, title, boardIndex, turnId })), [
    { kind: 'design', title: 'First', boardIndex: 1, turnId },
    { kind: 'code', title: 'css 代码块', boardIndex: undefined, turnId },
    { kind: 'design', title: 'Second', boardIndex: 2, turnId },
  ]);
  assert.match(items[2].source, /Locally edited/);
  assert.match(items[2].source, /script-src 'none'/);
  assert.doesNotMatch(items[2].source, /example\.invalid|onclick|<script|>Two</);
  setWorkbenchStorage(undefined);
});

test('design library indexes the validated scoped version and skips raw model HTML for rejected revisions', (t) => {
  const designMode = { ...row, mode: 'design' };
  const base = '00000000-0000-4000-8000-000000000011';
  const sourceId = '00000000-0000-4000-8000-000000000012';
  const designKey = `dsh-vps-design:v1:${scope}:${row.id}`;
  const snapshot = { base, sourceId, index: 2, layer: 'e1', sources: ['<h1>One</h1>', '<h1>Two</h1>'], boards: {} };
  setWorkbenchStorage({ getItem: (key) => key === `${designKey}:revision:${turnId}` ? JSON.stringify(snapshot) : null });
  t.after(() => setWorkbenchStorage(undefined));
  const proposal = JSON.stringify({ base, layer: 'e1', changes: { text: 'Revised two' } });
  const reply = `~~~html\n<head><meta name="dsh-layer-revision" content='${proposal}'></head><h1>Untrusted draft</h1>\n~~~`;
  const session = { id: row.id, turns: [{ id: turnId, state: 'complete', reply }] };
  const { items } = extractResources(scope, designMode, session);
  assert.deepEqual(items.map(({ kind, boardIndex }) => [kind, boardIndex]), [['design', 1], ['design', 2]]);
  assert.match(items[1].source, /Revised two/);
  assert.doesNotMatch(items[1].source, /Untrusted draft/);
  session.turns[0].reply = reply.replace(base, sourceId);
  assert.deepEqual(extractResources(scope, designMode, session).items, []);
});

test('session indexing is serial, keeps successful results after a failure, and discards late reads after abort', async () => {
  const controller = new AbortController();
  const rows = [row, { ...row, id: 'rejected' }, { ...row, id: 'late' }, { ...row, id: 'never' }];
  const calls = [];
  const results = [];
  let completeFirst;
  let completeLate;
  let reachedLate;
  const late = new Promise((resolve) => { reachedLate = resolve; });
  const indexing = indexResources({ scope, sessions: rows, signal: controller.signal,
    onResult: (result) => results.push(result),
    readSession(current, signal) {
      assert.equal(signal, controller.signal);
      calls.push(current.id);
      if (current.id === row.id) return new Promise((resolve) => { completeFirst = resolve; });
      if (current.id === 'rejected') return Promise.reject(new Error('Unavailable'));
      reachedLate();
      return new Promise((resolve) => { completeLate = resolve; });
    },
  });
  assert.deepEqual(calls, [row.id]);
  completeFirst({ id: row.id, turns: [{ id: turnId, state: 'complete', reply: '```text\nReady\n```' }] });
  await late;
  assert.deepEqual(calls, [row.id, 'rejected', 'late']);
  assert.deepEqual(results.map(({ items, partial }) => [items.length, partial]), [[1, false], [0, true]]);
  controller.abort();
  completeLate({ id: 'late', turns: [] });
  await indexing;
  assert.equal(results.length, 2);
  assert.deepEqual(calls, [row.id, 'rejected', 'late']);
});

test('an unavailable scope makes no session reads', async () => {
  await indexResources({ scope: '', sessions: [row], signal: new AbortController().signal,
    readSession: () => assert.fail('Unexpected session read'), onResult: () => assert.fail('Unexpected result') });
});
