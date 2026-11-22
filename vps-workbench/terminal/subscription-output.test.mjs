import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOutputPage, writeTerminalBytes } from './subscription-output.mjs';

const id = 'fixture-session';
const output = (sequence, bytes) => ({ sequence, type: 'output', data: Buffer.from(bytes).toString('base64') });
const page = (events, overrides) => ({ sessionId: id, state: 'ready', gap: false,
  events, lastSequence: events.at(-1)?.sequence ?? 0, ...overrides });

test('terminal pages coalesce adjacent bytes and preserve control event boundaries', () => {
  const raw = Buffer.from('你好🌿\x1b[32m结果\x1b[0m');
  const { steps, lastSequence } = readOutputPage(page([
    output(1, raw.subarray(0, 2)), output(2, raw.subarray(2, 11)), output(3, raw.subarray(11)),
    { sequence: 4, type: 'disconnect' }, output(5, '尾行'), { sequence: 6, type: 'exit' },
  ]), id, 0);
  assert.equal(lastSequence, 6);
  assert.deepEqual(steps.map(({ type, sequence }) => [type, sequence]),
    [['output', 3], ['disconnect', 4], ['output', 5], ['exit', 6]]);
  assert.deepEqual(Buffer.from(steps[0].data), raw);
  assert.equal(Buffer.from(steps[2].data).toString('utf8'), '尾行');
});

test('terminal pages reject invalid tails before returning any writes or cursor changes', () => {
  for (const value of [
    page([output(1, 'valid'), output(3, 'gap')]),
    page([output(1, 'valid'), { sequence: 2, type: 'ready' }]),
    page([output(1, 'valid'), output(2, Buffer.alloc(4097))]),
    page([output(1, 'valid'), { sequence: 2, type: 'output', data: '&&==' }]),
    page([output(1, 'valid')], { sessionId: 'different' }),
    page([output(1, 'valid')], { gap: true }),
    page([output(1, 'valid')], { state: 'unknown' }),
    page([output(1, 'valid')], { lastSequence: 0 }),
    page([], { lastSequence: 1 }),
    page(Array.from({ length: 65 }, (_, i) => output(i + 1, 'too many'))),
  ]) assert.throws(() => readOutputPage(value, id, 0));
  assert.equal(readOutputPage(page([output(1, Buffer.alloc(4096))]), id, 0).steps[0].data.byteLength, 4096);
});

test('terminal write resolves after the renderer callback and propagates a failed write', async () => {
  const bytes = new Uint8Array([65]);
  let callback;
  let completed = false;
  const writing = writeTerminalBytes({
    write(data, done) { assert.equal(data, bytes); callback = done; },
  }, bytes).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  callback();
  await writing;
  assert.equal(completed, true);
  const failure = new Error('renderer write rejected');
  await assert.rejects(writeTerminalBytes({ write() { throw failure; } }, bytes), failure);
});
