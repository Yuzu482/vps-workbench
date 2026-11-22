import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const executable = resolve(process.env.VPS_WORKBENCH_TEST_EXE ||
  `dist/VPS-Workbench-${version}-win-x64/VPS Workbench.exe`);

const offlineTransport = String.raw`
import ast, base64, hashlib, json
from pathlib import Path

root = Path(__file__).parent
def build_command(host, port, user, identity, pins, identifier, *_rest):
    assert host == 'fixture.invalid' and port == 22 and user == 'fixture'
    assert Path(pins).name == 'known_hosts' and Path(pins).read_text() == 'fixture pin'
    return [host, identifier]

def run_ssh(argv, payload, timeout, stdout_limit):
    assert timeout <= 44 and stdout_limit <= 16 * 1024
    assert argv[-1].startswith('/bin/sh -c ') or argv[-1] == 'python3 -I -B -'
    tree = ast.parse(payload)
    entries = {stmt.targets[0].id:stmt.value for stmt in tree.body if isinstance(stmt, ast.Assign)}
    def decoded(entry):
        expr = entries[entry]
        if entry == 'request':
            expr = expr.args[0]
        return base64.b64decode(ast.literal_eval(expr.args[0]))
    packet = json.loads(decoded('request'))
    archive = decoded('archive')
    assert b'def dispatch(' in decoded('source')
    if packet['kind'] == 'status':
        assert not archive
    else:
        assert hashlib.sha256(archive).hexdigest() == (root / 'vps-backend.sha256').read_text().strip()
    with (root / 'ssh-calls.jsonl').open('a', encoding='utf-8') as log:
        log.write(json.dumps(packet) + '\n')
    target = packet['targetId']
    reply = {'ok': True, 'targetId': target}
    if packet['kind'] == 'probe':
        if (root / 'fail-probe').exists():
            return 0, json.dumps({'ok': False, 'targetId': target, 'code': 'unsafe_ssh_path'}).encode()
        reply['platform'] = {
            'system': 'Linux', 'distribution': 'debian', 'distributionVersion': '12',
            'architecture': 'arm64', 'packageManager': 'apt', 'sandbox': 'passed', 'workspace': 'passed',
            'blocker': None, 'missing': [], 'providers': {'codex': {'runtime': 'found', 'onSshPath': False}}}
    elif packet['kind'] == 'start':
        assert packet['providers'] == ['codex', 'antigravity']
        assert packet['workspace'] == '/home/fixture/work'
        if (root / 'reject-start').exists():
            reply['install'] = {'id': packet['installId'], 'providers': packet['providers'],
                'state': 'failed', 'results': {}, 'code': 'unsafe_directory'}
            return 0, json.dumps(reply).encode()
        (root / 'original.json').write_text(json.dumps(packet), encoding='utf-8')
        # The original may have been accepted even though SSH loses the reply.
        return None, b''
    else:
        original = json.loads((root / 'original.json').read_text(encoding='utf-8'))
        assert packet['installId'] == original['installId'] and target == original['targetId']
        reply['install'] = {'id': original['installId'], 'providers': original['providers'],
            'state': 'succeeded', 'results': {'codex': {'runtime': 'existing'}, 'antigravity': {'runtime': 'installed'}}}
    return 0, json.dumps(reply).encode()
`;

test('packaged Windows VPS bridge binds the selected install and only queries the original after a lost result', {
  timeout: 40_000, skip: process.platform !== 'win32',
}, async (t) => {
  const packaged = join(dirname(executable), 'resources', 'app', 'helper');
  const root = await mkdtemp(join(tmpdir(), 'workbench-backend-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = join(root, 'helper');
  const state = join(root, 'state');
  await mkdir(helper);
  await mkdir(state);
  for (const name of ['DshVpsChatBridge.exe', 'DshVpsChatBridge.dll', 'DshVpsChatBridge.deps.json', 'DshVpsChatBridge.runtimeconfig.json',
    'RemoteSsh.Core.dll', 'VpsBackendClient.py', 'RemoteVpsBackend.py', 'vps-backend.tar.gz', 'vps-backend.sha256']) {
    await copyFile(join(packaged, name), join(helper, name));
  }
  const archive = await readFile(join(helper, 'vps-backend.tar.gz'));
  assert.equal(createHash('sha256').update(archive).digest('hex'), (await readFile(join(helper, 'vps-backend.sha256'), 'utf8')).trim());
  await writeFile(join(helper, 'RemoteTaskStatus.py'), offlineTransport);
  const settings = { host: 'fixture.invalid', port: 22, user: 'fixture', workspace: '/home/fixture/work',
    identityPath: join(root, 'key'), knownHostsPath: join(root, 'external-known-hosts'), expectedIpv4: '192.0.2.19',
    expectedIpv6: '', provider: 'codex', hostKeyConfirmed: true };
  await writeFile(settings.identityPath, 'fixture only');
  await writeFile(settings.knownHostsPath, 'fixture pin');

  function rpc(packet) {
    return new Promise((resolve, reject) => {
      const child = spawn(join(helper, 'DshVpsChatBridge.exe'), [state], {
        cwd: helper, env: { ...process.env, DSH_VPS_CHAT_PYTHON: process.env.VPS_WORKBENCH_TEST_PYTHON || '' },
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
      const output = [];
      child.stdout.on('data', (chunk) => output.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        try {
          assert.equal(code, 0);
          resolve(JSON.parse(Buffer.concat(output).toString('utf8')));
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(packet));
    });
  }
  assert.ok(process.env.VPS_WORKBENCH_TEST_PYTHON, 'set VPS_WORKBENCH_TEST_PYTHON to the local fixture interpreter path');
  const { targetId } = await rpc({ op: 'configuration', settings });
  assert.match(targetId, /^[a-f0-9]{64}$/);
  const binding = { op: 'setup-backend', settings, targetId };
  const initial = await rpc({ ...binding, kind: 'probe' });
  assert.equal(initial.platform.architecture, 'arm64');
  assert.deepEqual(initial.platform.providers.codex, { runtime: 'found', onSshPath: false });
  assert.equal(initial.install, null);
  const installId = randomUUID();
  const start = { ...binding, kind: 'start', installId, providers: ['antigravity', 'codex'] };
  assert.equal((await rpc({ ...start, providers: ['codex', 'codex'] })).code, 'invalid_request');
  const unknown = await rpc(start);
  assert.equal(unknown.install.state, 'unknown');
  assert.equal(unknown.install.id, installId);
  assert.equal((await rpc({ ...start, installId: randomUUID() })).code, 'backend_pending');
  const unavailable = join(helper, 'fail-probe');
  await writeFile(unavailable, 'offline fixture');
  const reconnect = await rpc({ ...binding, kind: 'probe' });
  await rm(unavailable);
  assert.equal(reconnect.install.id, installId);
  assert.equal(reconnect.platform, null);
  assert.match(reconnect.probeError, /PATH/u);
  assert.equal((await rpc({ ...start, providers: ['claude'] })).code, 'backend_conflict');
  // Duplicate start observes the original. It does not launch another command.
  const observed = await rpc(start);
  assert.equal(observed.install.state, 'succeeded');
  const confirmed = await rpc({ ...binding, kind: 'status', installId });
  assert.deepEqual(confirmed, observed);
  const calls = (await readFile(join(helper, 'ssh-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(({ kind }) => kind), ['probe', 'start', 'probe', 'status']);
  assert.equal(calls.at(-1).installId, installId);
  const reject = join(helper, 'reject-start');
  const failedId = randomUUID();
  await writeFile(reject, 'offline fixture');
  const refused = await rpc({ ...start, installId: failedId });
  assert.equal(refused.install.id, failedId);
  assert.equal(refused.install.state, 'failed');
  assert.equal(refused.install.code, 'unsafe_directory');
  await rm(reject);
  const retryId = randomUUID();
  assert.equal((await rpc({ ...start, installId: retryId })).install.id, retryId);
  assert.equal(JSON.parse(await readFile(join(helper, 'original.json'), 'utf8')).installId, retryId);
  assert.equal(await readFile(settings.knownHostsPath, 'utf8'), 'fixture pin');
});
