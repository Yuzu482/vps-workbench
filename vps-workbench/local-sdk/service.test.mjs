import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openLocalSdk } from './service.mjs';

const artifacts = fileURLToPath(new URL('../../test-artifacts/local-sdk-service/', import.meta.url));
const models = [{ id: 'fixture-model', label: 'Fixture', efforts: ['low', 'medium'], defaultEffort: 'low' }];
const uuid = (number) => `a0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const localId = (number) => 'local-' + uuid(number);
const sessionId = localId(1);
const turnId = uuid(11);

async function fixture(t, overrides = {}) {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'case-'));
  const root = join(directory, 'receipts');
  const path = join(root, 'receipts.json');
  const services = [];
  t.after(async () => {
    await Promise.all(services.map((service) => service.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    root, models, createThread: () => assert.fail('unexpected SDK call'),
    canExecute: () => true, credentialConfigured: () => true, ...overrides,
  };
  const start = async (extra) => {
    const service = await openLocalSdk({ ...options, ...extra });
    services.push(service);
    return service;
  };
  const data = { name: 'Example', directory, model: models[0].id, effort: 'low' };
  const profileFor = async (service, extra) => {
    const registered = await service.registerProfile({ ...data, ...extra });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    return registered.profile;
  };
  return { root, path, start, data, profileFor, read: async () => JSON.parse(await readFile(path, 'utf8')) };
}

function body(profile, op, extras = {}) {
  return {
    location: 'local-sdk', backend: 'codex', profileId: profile.id, op,
    ...(op === 'list' ? {} : { targetId: profile.targetId, sessionId }),
    ...(['refresh', 'stop', 'send'].includes(op) ? { turnId } : {}),
    ...(op === 'send' ? { prompt: 'Hello SDK' } : {}),
    ...extras,
  };
}

async function observe(service, profile, states, extras) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const response = await service.request(body(profile, 'refresh', extras));
    assert.equal(response.ok, true, JSON.stringify(response));
    if (states.includes(response.session.turns.find((turn) => turn.id === (extras?.turnId ?? turnId))?.state)) return response.session;
    await setTimeout(5);
  }
  assert.fail(`turn did not reach ${states.join(', ')}`);
}

function stream(generator) {
  return { runStreamed: async (prompt, { signal }) => ({ events: generator(prompt, signal) }) };
}

function began(id = 'native-session') {
  return { type: 'thread.started', thread_id: id };
}

function message(text, id = 'message', type = 'item.completed') {
  return { type, item: { type: 'agent_message', id, text } };
}

function aborted(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}

test('validates exact Local Codex requests and keeps browse and credential checks ahead of execution', async (t) => {
  let permitted = true;
  let credential = false;
  let calls = 0;
  const files = await fixture(t, {
    canExecute: () => permitted,
    credentialConfigured: () => credential,
    createThread: () => { calls++; },
  });
  const service = await files.start();
  assert.deepEqual(service.status(), {
    ok: true, location: 'local-sdk', backend: 'codex', credentialConfigured: false, models, profiles: [],
  });
  await assert.rejects(stat(files.path), { code: 'ENOENT' });
  assert.equal((await service.registerProfile({ ...files.data, directory: 'relative' })).code, 'invalid_profile');
  assert.equal((await service.registerProfile({ ...files.data, effort: 'high' })).code, 'invalid_profile');
  assert.equal((await service.registerProfile({ ...files.data, credential: 'ignored' })).code, 'invalid_profile');
  const profile = await files.profileFor(service);
  assert.deepEqual(await files.profileFor(service, { name: '  Example  ' }), profile);
  assert.match(profile.targetId, /^[a-f0-9]{64}$/);
  service.status().profiles[0].name = 'changed';
  assert.deepEqual(service.status().profiles, [profile]);
  assert.deepEqual(await service.request(body(profile, 'list', { targetId: profile.targetId })), {
    ok: true, location: 'local-sdk', targetId: profile.targetId, sessions: [],
  });
  const invalid = [
    body(profile, 'list', { targetId: 'f'.repeat(64) }),
    body(profile, 'send', { location: 'remote' }),
    body(profile, 'send', { backend: 'deepseek' }),
    body(profile, 'send', { op: 'design' }),
    body(profile, 'send', { attachments: [] }),
    body(profile, 'send', { workflow: {} }),
    body(profile, 'send', { sessionId: '../outside' }),
    body(profile, 'send', { sessionId: uuid(1) }),
    body(profile, 'send', { prompt: '  ' }),
    body(profile, 'send', { prompt: 'x'.repeat(8193) }),
    body(profile, 'get', { turnId }),
    body(profile, 'refresh', { turnId: undefined }),
    Object.create(body(profile, 'list')),
    Object.defineProperty(body(profile, 'list'), 'op', { get: () => assert.fail('unexpected getter') }),
  ];
  for (const request of invalid) assert.equal((await service.request(request)).code, 'invalid_request');
  assert.equal((await service.request(body(profile, 'send'))).code, 'auth_required');
  assert.equal((await service.request(body(profile, 'get'))).code, 'session_not_found');
  assert.deepEqual((await files.read()).sessions, []);

  permitted = false;
  credential = true;
  assert.equal(service.status().credentialConfigured, true);
  assert.equal((await service.registerProfile(files.data)).code, 'browse_only');
  assert.equal((await service.request(body(profile, 'send'))).code, 'browse_only');
  assert.equal((await service.request(body(profile, 'stop'))).code, 'browse_only');
  assert.equal((await service.request(body(profile, 'list'))).ok, true);
  assert.equal(calls, 0);
});

test('stores the receipt before SDK use, binds the native thread before continuing, and resumes it after reopening', async (t) => {
  const files = await fixture(t);
  const seen = [];
  const checks = [];
  const createThread = async (profile, native) => {
    const { sessions } = await files.read();
    seen.push(native);
    checks.push(sessions[0].profileId === profile.id, sessions[0].turns.at(-1).state === 'running');
    if (native === null) checks.push(sessions[0].turns[0].prompt === '  Prompt with spaces  ');
    return stream(async function* (prompt) {
      yield began();
      checks.push((await files.read()).sessions[0].nativeThreadId === 'native-session');
      yield { type: 'item.completed', item: { type: 'reasoning', text: 'internal detail' } };
      yield message('draft', 'message', 'item.updated');
      yield message(`Answer: ${prompt}`);
      yield { type: 'turn.completed' };
    });
  };
  let service = await files.start({ createThread });
  const profile = await files.profileFor(service);
  const first = body(profile, 'send', { prompt: '  Prompt with spaces  ' });
  const enqueued = await service.request(first);
  assert.equal(enqueued.session.turns[0].state, 'queued');
  assert.equal(enqueued.session.title, 'Prompt with spaces');
  const duplicate = await service.request(first);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await service.request({ ...first, prompt: 'different' })).code, 'turn_conflict');
  assert.equal((await service.request({ ...first, sessionId: localId(2) })).code, 'turn_conflict');
  const completed = await observe(service, profile, ['completed']);
  assert.deepEqual(completed.turns[0], {
    id: turnId, prompt: first.prompt, reply: `Answer: ${first.prompt}`, state: 'completed', canStop: false,
  });
  assert.equal(completed.canSend, true);
  assert.equal((await service.request(body(profile, 'get'))).session.id, sessionId);
  assert.equal((await service.request(body(profile, 'list'))).sessions[0].id, sessionId);
  await service.close();

  service = await files.start({ createThread });
  assert.deepEqual(service.status().profiles, [profile]);
  assert.equal((await service.request(first)).duplicate, true);
  assert.equal((await service.request(body(profile, 'send', { turnId: uuid(12) }))).ok, true);
  await observe(service, profile, ['completed'], { turnId: uuid(12) });
  assert.deepEqual(seen, [null, 'native-session']);
  assert.equal(checks.length, 7);
  assert.ok(checks.every(Boolean));
});

test('serializes one desktop session, rejects cross-profile use, and protects native thread ownership', async (t) => {
  const files = await fixture(t);
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const events = [];
  const service = await files.start({
    createThread: (_, native) => stream(async function* (prompt, signal) {
      events.push([prompt, native]);
      yield began('native-a');
      if (prompt === 'first') {
        await Promise.race([gate.promise, aborted(signal)]);
        events.push(['first exited']);
      }
      yield { type: 'turn.completed' };
    }),
  });
  const profile = await files.profileFor(service);
  const other = await files.profileFor(service, { name: 'Other' });
  assert.notEqual(profile.targetId, other.targetId);
  const [first, second] = await Promise.all([
    service.request(body(profile, 'send', { prompt: 'first' })),
    service.request(body(profile, 'send', { prompt: 'second', turnId: uuid(12) })),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal((await service.request(body(other, 'get'))).code, 'session_not_found');
  assert.equal((await service.request(body(other, 'send'))).code, 'session_conflict');
  assert.equal((await service.request(body(other, 'send', { sessionId: localId(2) }))).code, 'turn_conflict');
  gate.resolve();
  await observe(service, profile, ['completed'], { turnId: uuid(12) });
  assert.deepEqual(events, [['first', null], ['first exited'], ['second', 'native-a']]);
  const cross = { sessionId: localId(2), turnId: uuid(20) };
  assert.equal((await service.request(body(other, 'send', cross))).ok, true);
  const collided = await observe(service, other, ['unknown'], cross);
  assert.equal(collided.canSend, false);
  assert.equal((await files.read()).sessions[1].nativeThreadId, null);
  assert.equal((await service.request(body(other, 'send', { ...cross, turnId: uuid(21) }))).code, 'unknown_outcome');
});

test('cancels queued and active turns, keeps partial text, and settles revocation on close', async (t) => {
  const files = await fixture(t);
  const ready = Promise.withResolvers();
  const revocable = Promise.withResolvers();
  const signals = [];
  const service = await files.start({
    createThread: () => stream(async function* (prompt, signal) {
      signals.push(signal);
      yield began(prompt === 'Hello SDK' ? 'first-thread' : 'second-thread');
      yield message('partial', 'message', 'item.updated');
      (prompt === 'Hello SDK' ? ready : revocable).resolve();
      await aborted(signal);
      throw new Error('private process data');
    }),
  });
  const profile = await files.profileFor(service);
  await service.request(body(profile, 'send'));
  await ready.promise;
  const queued = { turnId: uuid(12) };
  await service.request(body(profile, 'send', queued));
  assert.equal((await service.request(body(profile, 'stop', queued))).session.turns[1].state, 'stopped');
  const stopped = await service.request(body(profile, 'stop'));
  assert.equal(stopped.session.turns[0].state, 'stopping');
  assert.equal(signals[0].aborted, true);
  const terminal = await observe(service, profile, ['unknown']);
  assert.equal(terminal.turns[0].code, 'stop_unconfirmed');
  assert.equal(terminal.turns[0].reply, 'partial');
  assert.equal(terminal.canSend, false);
  assert.equal((await service.request(body(profile, 'send', { turnId: uuid(13) }))).code, 'unknown_outcome');
  assert.equal(signals.length, 1);

  await service.request(body(profile, 'send', { sessionId: localId(2), turnId: uuid(13), prompt: 'revoke' }));
  await revocable.promise;
  service.revokeExecution();
  assert.equal(signals[1].aborted, true);
  await service.close();
  assert.equal((await files.read()).sessions[1].turns[0].code, 'stop_unconfirmed');
});

test('shows uncertain receipts after reopening without replay or browse writes', async (t) => {
  const files = await fixture(t);
  const service = await files.start({
    createThread: () => stream(async function* () {
      yield began();
      yield message('stored answer');
      yield { type: 'turn.completed' };
    }),
  });
  const profile = await files.profileFor(service);
  await service.request(body(profile, 'send'));
  await observe(service, profile, ['completed']);
  await service.close();

  const interrupted = await files.read();
  interrupted.sessions[0].turns[0].state = 'running';
  const original = JSON.stringify(interrupted);
  await writeFile(files.path, original, 'utf8');
  const readonly = await files.start({ canExecute: () => false });
  assert.equal((await readonly.request(body(profile, 'list'))).ok, true);
  const history = (await readonly.request(body(profile, 'get'))).session;
  assert.equal(history.turns[0].state, 'unknown');
  assert.equal(history.turns[0].reply, 'stored answer');
  assert.equal(history.canSend, false);
  assert.deepEqual((await readonly.request(body(profile, 'refresh'))).session, history);
  assert.equal(await readFile(files.path, 'utf8'), original);
  await readonly.close();

  const reopened = await files.start();
  assert.equal((await reopened.request(body(profile, 'send'))).duplicate, true);
  assert.equal((await reopened.request(body(profile, 'send', { turnId: uuid(12) }))).code, 'unknown_outcome');
});

test('sanitizes preflight and known failure events and preserves ambiguous stream outcomes', async (t) => {
  const files = await fixture(t);
  const text = 'secret process data';
  let next = 'preflight';
  const service = await files.start({
    createThread: () => {
      if (next === 'preflight') throw Object.assign(new Error(text), { code: 'auth_required' });
      return stream(async function* () {
        yield began();
        yield message('partial');
        if (next === 'auth_required') yield { type: 'turn.failed', error: { message: '401 Unauthorized ' + text } };
        else if (next === 'turn_failed') yield { type: 'turn.failed', error: { message: text } };
        else throw new Error((next === 'network_error' ? 'ECONNREFUSED ' : '') + text);
      });
    },
  });
  const profile = await files.profileFor(service);
  for (const [number, operation, code, expected] of [[11, 'preflight', 'auth_required', 'failed'],
    [12, 'auth_required', 'auth_required', 'failed'], [13, 'turn_failed', 'turn_failed', 'failed'],
    [14, 'network_error', 'network_error', 'unknown'], [15, 'ambiguous', 'unknown_outcome', 'unknown']]) {
    next = operation;
    const extras = { turnId: uuid(number), ...(number === 15 ? { sessionId: localId(2) } : {}) };
    await service.request(body(profile, 'send', extras));
    const result = await observe(service, profile, [expected], extras);
    assert.equal(result.turns.at(-1).code, code);
    assert.equal(JSON.stringify(result).includes(text), false);
    assert.equal(JSON.stringify(await files.read()).includes(text), false);
  }
});

test('keeps unsupported or damaged stores intact', async (t) => {
  const files = await fixture(t);
  await mkdir(files.root, { recursive: true });
  for (const raw of ['invalid-json', '{"version":0,"profiles":[],"sessions":[]}']) {
    await writeFile(files.path, raw, 'utf8');
    await assert.rejects(files.start(), { code: 'storage_unavailable' });
    assert.equal(await readFile(files.path, 'utf8'), raw);
  }
});

test('does not dispatch when the receipt cannot be written', async (t) => {
  let calls = 0;
  const files = await fixture(t, { createThread: () => { calls++; } });
  const service = await files.start();
  const profile = await files.profileFor(service);
  const backup = `${files.path}.backup`;
  await rename(files.path, backup);
  await mkdir(files.path);
  assert.equal((await service.request(body(profile, 'send'))).code, 'storage_unavailable');
  assert.equal((await service.request(body(profile, 'send', { turnId: uuid(12) }))).code, 'storage_unavailable');
  assert.equal((await service.request(body(profile, 'get'))).code, 'session_not_found');
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')).sessions, []);
});
