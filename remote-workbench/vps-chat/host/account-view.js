import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join, win32 } from 'node:path';
import { Transform } from 'node:stream';
import { createWebSocketStream, WebSocketServer } from 'ws';
import { accountRelayCommand, readSshRelay, relayReady, relayRequired } from './ssh-relay.js';
import { accountStartupMessage, defaultAccountAction, getAccountAction } from '../client/account-routes.js';
export { validAccountRequest } from '../client/account-routes.js';

export const accountSocketPath = '/dsh-vps-chat/api/account-screen';
const remoteProgram = new URL('./RemoteClaudeAccount.py', import.meta.url);
const sshRelayFile = 'ssh-relay.json';
const workbenchRelayPolicyFile = 'ssh-relay-required';
const unavailable = { ok: false, code: 'account_unavailable', message: 'VPS 账号页面暂不可用。' };
const busy = { ok: false, code: 'account_busy', message: '已有 VPS 账号窗口，请先关闭它。' };

function pinnedTarget(settings) {
  const absolutePath = (value) => typeof value === 'string' && win32.isAbsolute(value) && !/["%\x00-\x1f\x7f]/.test(value);
  return settings?.hostKeyConfirmed === true && /^[a-z0-9][a-z0-9.:-]*$/i.test(settings.host ?? '') &&
    /^[a-z0-9_][a-z0-9_.-]*$/i.test(settings.user ?? '') &&
    Number.isInteger(settings.port) && settings.port > 0 && settings.port < 65536 &&
    absolutePath(settings.identityPath) && absolutePath(settings.knownHostsPath) &&
    isIP(settings.expectedIpv4) === 4 && (settings.expectedIpv6 === '' ||
      (typeof settings.expectedIpv6 === 'string' && /^[0-9a-f:.]+$/i.test(settings.expectedIpv6) && isIP(settings.expectedIpv6) === 6));
}

export function readAccountRoute(root, allowDirect = false) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('relay_required');
  let stat;
  try {
    stat = lstatSync(join(root, sshRelayFile));
  } catch (error) {
    if (allowDirect && error.code === 'ENOENT' && lstatSync(root).isDirectory()) return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 1024) throw new Error('relay_required');
  return readSshRelay(root);
}

export function createWorkbenchRouteReader(root) {
  let observedRelay = false;

  function requiresRelay() {
    if (typeof root !== 'string' || !isAbsolute(root) || !lstatSync(root).isDirectory()) {
      throw new Error('relay_required');
    }
    observedRelay ||= Boolean(lstatSync(join(root, sshRelayFile), { throwIfNoEntry: false }));
    const policyPath = join(root, workbenchRelayPolicyFile);
    let policy = lstatSync(policyPath, { throwIfNoEntry: false });
    if (!policy && observedRelay) {
      // The empty file is complete when created. Exclusive creation preserves a competing publication.
      try {
        closeSync(openSync(policyPath, 'wx', 0o600));
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      policy = lstatSync(policyPath);
    }
    if (!policy) return false;
    observedRelay = true;
    if (!policy.isFile() || policy.size !== 0 || policy.nlink !== 1) throw new Error('relay_required');
    return true;
  }

  // Record configured relay policy at startup while keeping local browsing available on errors.
  try { requiresRelay(); } catch {}
  return () => {
    const route = readAccountRoute(root, !requiresRelay());
    if (route) {
      observedRelay = true;
      requiresRelay();
      return route;
    }
    return requiresRelay() ? readAccountRoute(root) : null;
  };
}

export function launchAccountBrowser(settings, source, relay, action = defaultAccountAction) {
  if (!pinnedTarget(settings) || !getAccountAction(action)) throw new Error('invalid_target');
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const ssh = join(windows, 'System32', 'OpenSSH', 'ssh.exe');
  const args = [settings.expectedIpv4, settings.expectedIpv6 || '-', action].join(' ');
  const program = Buffer.from(source, 'utf8').toString('base64');
  const command = `exec /usr/bin/python3 -I -c 'import base64;exec(compile(base64.b64decode("${program}"),"dsh-account-browser","exec"))' ${args}`;
  const { option, remote } = relay === null ? {
    option: 'ProxyCommand=none',
    remote: `printf '%s\\n' '${relayReady.toString('ascii').trim()}'; ${command}`,
  } : accountRelayCommand(settings, relay, command);
  const options = [
    option, 'ProxyJump=none', 'IdentityAgent=none', 'IdentitiesOnly=yes', 'IdentityFile=none',
    'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=NUL', 'UpdateHostKeys=no',
    'BatchMode=yes', 'PreferredAuthentications=publickey', 'ForwardAgent=no',
    'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ControlMaster=no',
    'CanonicalizeHostname=no', 'ConnectTimeout=8', 'ConnectionAttempts=1',
    'ServerAliveInterval=10', 'ServerAliveCountMax=2',
    `UserKnownHostsFile="${settings.knownHostsPath.replaceAll('\\', '/')}"`,
  ];
  return spawn(ssh, [
    '-F', 'NUL', '-T', ...options.flatMap((option) => ['-o', option]),
    '-i', settings.identityPath, '-p', String(settings.port), '-l', settings.user, '--', settings.host, remote,
  ], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
  });
}

function acceptsTicket(protocol, ticket) {
  return typeof protocol === 'string' && /^dsh-account\.[\w-]{43}$/.test(protocol) &&
    timingSafeEqual(Buffer.from(protocol), Buffer.from(ticket.protocol));
}

export function createAccountView({ port, bridge, permitted, readRelay, launch = launchAccountBrowser }) {
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  let ticket;
  let active;
  let preparing = false;
  let disposed = false;
  let generation = 0;

  function relay(socket, { settings, source, route, action }) {
    let ssh;
    try {
      const current = readRelay();
      if ((route === null) !== (current === null) || route?.socksPort !== current?.socksPort ||
          route?.expectedSshSource !== current?.expectedSshSource) {
        socket.terminate();
        return;
      }
      ssh = launch(settings, source, current, action);
    } catch { socket.terminate(); return; }
    const stream = createWebSocketStream(socket);
    active = socket;
    const bootstrap = setTimeout(() => socket.terminate(), 78_000);
    let finished = false;
    let verified = false;
    let frameStarted = false;
    let startupOutput = '';
    function stop(issue) {
      if (finished) return;
      finished = true;
      clearTimeout(bootstrap);
      ssh.stdin.end();
      if (ssh.exitCode === null && ssh.signalCode === null) {
        const deadline = setTimeout(() => ssh.kill(), 3000);
        deadline.unref();
        ssh.once('close', () => clearTimeout(deadline));
      }
      if (accountStartupMessage(issue)) socket.close(1011, issue);
      else socket.terminate();
    }
    ssh.once('error', stop);
    ssh.once('close', (code) => {
      if (active === socket) active = undefined;
      const reason = code === 1 && verified && !frameStarted
        ? /^DSH_ACCOUNT_ERROR ([a-z_]+)$/m.exec(startupOutput)?.[1] : undefined;
      stop(reason);
    });
    ssh.stdin.on('error', stop);
    ssh.stderr.setEncoding('utf8');
    ssh.stderr.on('data', (text) => {
      // Only fixed preflight codes cross into the local viewer.
      if (!frameStarted && startupOutput.length < 4096)
        startupOutput += text.slice(0, 4096 - startupOutput.length);
    });
    stream.on('error', stop);
    stream.once('close', stop);
    socket.once('close', stop);
    let pending = Buffer.alloc(0);
    const checked = new Transform({
      transform(chunk, _encoding, callback) {
        if (verified) return callback(null, chunk);
        const data = Buffer.concat([pending, chunk]);
        if (data.length < relayReady.length) { pending = data; return callback(); }
        if (!data.subarray(0, relayReady.length).equals(relayReady)) return callback(new Error('relay_source_mismatch'));
        verified = true;
        pending = null;
        stream.pipe(ssh.stdin);
        callback(null, data.subarray(relayReady.length));
      },
    });
    checked.once('data', () => {
      frameStarted = true;
      startupOutput = '';
      clearTimeout(bootstrap);
    });
    checked.on('error', stop);
    ssh.stdout.pipe(checked).pipe(stream, { end: false });
  }

  return {
    async prepare(targetId, action = defaultAccountAction) {
      if (disposed || !getAccountAction(action)) return unavailable;
      if (active || preparing) return busy;
      preparing = true;
      const expectedGeneration = generation;
      try {
        let route;
        try { route = readRelay(); } catch { return relayRequired; }
        const result = await bridge.request({ op: 'preset' });
        const preset = result?.ok === true ? result.preset : null;
        if (!preset || preset.targetId !== targetId || !pinnedTarget(preset.settings)) {
          return { ...unavailable, message: '请先连接已核对指纹的默认 VPS。' };
        }
        const source = await readFile(remoteProgram, 'utf8');
        if (disposed || expectedGeneration !== generation) return unavailable;
        const protocol = 'dsh-account.' + randomBytes(32).toString('base64url');
        ticket = { protocol, expiresAt: Date.now() + 15_000, settings: preset.settings, source, route, action };
        return { ok: true, protocol, port };
      } finally {
        preparing = false;
      }
    },
    revoke() {
      generation++;
      ticket = undefined;
      active?.terminate();
    },
    upgrade(req, socket, head) {
      if (disposed || active || !ticket || ticket.expiresAt <= Date.now() ||
          req.url !== accountSocketPath || !permitted(req) ||
          !acceptsTicket(req.headers['sec-websocket-protocol'], ticket)) {
        socket.destroy();
        return;
      }
      const grant = ticket;
      ticket = undefined;
      server.handleUpgrade(req, socket, head, (viewer) => relay(viewer, grant));
    },
    dispose() {
      disposed = true;
      ticket = undefined;
      active?.terminate();
      server.close();
    },
  };
}
