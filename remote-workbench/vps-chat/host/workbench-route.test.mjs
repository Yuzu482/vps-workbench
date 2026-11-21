import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkbenchRouteReader, readAccountRoute } from './account-view.js';

const relay = { socksPort: 10808, expectedSshSource: '192.0.2.18' };
const configuration = JSON.stringify({ version: 1, ...relay });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vps-route-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config: join(root, 'ssh-relay.json'), policy: join(root, 'ssh-relay-required') };
}

test('fresh Workbench profiles support direct routing until a relay is observed', async (t) => {
  const { root, config, policy } = await fixture(t);
  const reader = createWorkbenchRouteReader(root);
  const otherReader = createWorkbenchRouteReader(root);
  assert.equal(reader(), null);
  assert.equal(otherReader(), null);
  await assert.rejects(readFile(policy), { code: 'ENOENT' });

  await writeFile(config, configuration);
  assert.deepEqual(reader(), relay);
  assert.equal(await readFile(policy, 'utf8'), '');
  assert.equal(await readFile(config, 'utf8'), configuration);
  await rm(config);

  assert.throws(reader, { code: 'ENOENT' });
  assert.throws(otherReader, { code: 'ENOENT' });
  assert.throws(createWorkbenchRouteReader(root), { code: 'ENOENT' });
  assert.equal(readAccountRoute(root, true), null);
  assert.throws(() => readAccountRoute(root), { code: 'ENOENT' });
});

test('Workbench startup records a configured relay before any route use', async (t) => {
  const { root, config, policy } = await fixture(t);
  await writeFile(config, configuration);
  const reader = createWorkbenchRouteReader(root);
  assert.equal(await readFile(policy, 'utf8'), '');
  await writeFile(config, '{}');
  assert.throws(reader, /relay_required/);
  assert.throws(createWorkbenchRouteReader(root), /relay_required/);

  await rm(config);
  assert.throws(createWorkbenchRouteReader(root), { code: 'ENOENT' });
  const correctedRelay = { ...relay, socksPort: 10809 };
  await writeFile(config, JSON.stringify({ version: 1, ...correctedRelay }));
  assert.deepEqual(createWorkbenchRouteReader(root)(), correctedRelay);
});

test('an invalid relay at startup still requires a relay after removal', async (t) => {
  const { root, config, policy } = await fixture(t);
  await writeFile(config, 'malformed');
  const reader = createWorkbenchRouteReader(root);
  assert.equal(await readFile(policy, 'utf8'), '');
  assert.throws(reader, SyntaxError);
  await rm(config);
  assert.throws(createWorkbenchRouteReader(root), { code: 'ENOENT' });
});

test('unusable policy paths block route use and are preserved', async (t) => {
  const { root, config, policy } = await fixture(t);
  await writeFile(config, configuration);
  const target = join(root, 'unrelated');
  await mkdir(target);
  await symlink(target, policy, 'junction');
  const reader = createWorkbenchRouteReader(root);
  assert.throws(reader, /relay_required/);
  await rm(policy);
  await writeFile(policy, 'unrecognized policy');
  assert.throws(reader, /relay_required/);
  assert.equal(await readFile(policy, 'utf8'), 'unrecognized policy');
  await rm(policy);
  await rm(config);

  assert.throws(reader, { code: 'ENOENT' });
  assert.equal(await readFile(policy, 'utf8'), '');
  assert.throws(createWorkbenchRouteReader(root), { code: 'ENOENT' });
});

test('a redirected conversation root cannot publish the policy', async (t) => {
  const { root } = await fixture(t);
  const target = join(root, 'unrelated');
  const redirected = join(root, 'redirected');
  await mkdir(target);
  await writeFile(join(target, 'ssh-relay.json'), configuration);
  await symlink(target, redirected, 'junction');
  assert.throws(createWorkbenchRouteReader(redirected), /relay_required/);
  await assert.rejects(readFile(join(target, 'ssh-relay-required')), { code: 'ENOENT' });
});

test('a missing conversation directory does not prevent later use of a fresh profile', async (t) => {
  const { root } = await fixture(t);
  const profile = join(root, 'conversations');
  const reader = createWorkbenchRouteReader(profile);
  assert.throws(reader, { code: 'ENOENT' });
  await mkdir(profile);
  assert.equal(reader(), null);
});
