// Authenticated HTTP adapter for the Dev.14 native Claude Code terminal.
import { spawn as spawnProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, isAbsolute, join } from 'node:path';
import { createNativeReceiptStore, createNativeTerminal } from './vendor/native.mjs';

export const SUBSCRIPTION_PREFIX = '/dsh-terminal-workbench/api/';

const maxBody = 16 * 1024;
const maxPins = 256 * 1024;
const targetIdPattern = /^[a-f0-9]{64}$/;
const forwarded = new Set(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);
const terminalOperations = new Set(['native-input', 'native-poll', 'native-resize', 'native-close', 'native-acknowledge']);
const errorCodes = new Set(['invalid_request', 'session_mismatch', 'unavailable', 'write_uncertain', 'subscription_preflight_rejected',
  'workbench_browse_only']);

function fault(code) {
  return Object.assign(new Error(code), { code });
}

function exact(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}

function headers(req, key) {
  const values = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === key) values.push(req.rawHeaders[index + 1]);
  }
  return values;
}

function allowed(req, port) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  if (req.rawHeaders.some((value, index) => index % 2 === 0 && forwarded.has(value.toLowerCase()))) return false;

  const host = headers(req, 'host');
  const origin = headers(req, 'origin');
  const site = headers(req, 'sec-fetch-site');
  return host.length === 1 && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host[0]) &&
    (origin.length === 0 || origin.length === 1 && origin[0] === `http://${host[0]}`) &&
    (site.length === 0 || site.length === 1 && site[0] === 'same-origin');
}

function send(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(body);
}

async function readBody(req) {
  const length = headers(req, 'content-length');
  const transfer = headers(req, 'transfer-encoding');
  if (length.length > 1 || transfer.length > 1 || (length.length && transfer.length) ||
      (length.length && (!/^\d+$/.test(length[0]) || Number(length[0]) > maxBody)) ||
      (transfer.length && transfer[0].toLowerCase() !== 'chunked')) throw fault('invalid_request');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw fault('invalid_request');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function readCheckedFile(path, info, limit) {
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw fault('unavailable');
  const bytes = readFileSync(path);
  if (!bytes.length || bytes.length > limit) throw fault('unavailable');
  return bytes;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createRouteReader(root) {
  const path = join(root, 'ssh-relay.json');
  let relayObserved = false;
  return () => {
    const parent = lstatSync(root);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw fault('unavailable');

    let info;
    try {
      info = lstatSync(path);
    } catch (failure) {
      if (failure.code === 'ENOENT' && !relayObserved) return { kind: 'direct' };
      throw fault('unavailable');
    }

    relayObserved = true;
    const options = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readCheckedFile(path, info, 1024)));
    if (!exact(options, ['version', 'socksPort', 'expectedSshSource']) || options.version !== 1 ||
        !Number.isInteger(options.socksPort) || options.socksPort < 1 || options.socksPort > 65535 ||
        typeof options.expectedSshSource !== 'string' || isIP(options.expectedSshSource) !== 4) {
      throw fault('unavailable');
    }
    return { kind: 'relay', socksPort: options.socksPort, expectedSshSource: options.expectedSshSource };
  };
}

function usesRoute(options, route) {
  return options.socksPort === (route.socksPort ?? null) &&
    options.expectedSshSource === (route.expectedSshSource ?? null);
}

export function createStandaloneSubscriptionHost({
  port, stateRoot, workbenchRoot, executable, verifyTarget, spawn = spawnProcess, now = Date.now,
  readRoute = createRouteReader(workbenchRoot), authorize = () => true,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof verifyTarget !== 'function' ||
      ![stateRoot, workbenchRoot, executable].every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new TypeError('Invalid native subscription host options');
  }

  const token = randomBytes(32).toString('base64url');
  const tokenBytes = Buffer.from(token);
  const nonces = new Map();
  const bridgeChildren = new Set();
  const pinsRoot = join(workbenchRoot, 'native-subscription-pins');
  let disposed = false;
  let receiptStore;
  const store = () => receiptStore ??= createNativeReceiptStore(stateRoot);
  const native = createNativeTerminal({
    executable,
    storeFactory: store,
    now,
    spawn(file, args, options) {
      const child = spawn(file, args, options);
      if (args[0] === '--native-status') {
        bridgeChildren.add(child);
        child.once('close', () => bridgeChildren.delete(child));
      }
      return child;
    },
  });

  function readCommittedPins(path) {
    const directory = lstatSync(pinsRoot);
    if (!directory.isDirectory() || directory.isSymbolicLink() || path !== join(pinsRoot, basename(path))) {
      throw fault('unavailable');
    }
    const pins = readCheckedFile(path, lstatSync(path), maxPins);
    if (basename(path) !== digest(pins)) throw fault('unavailable');
    return pins;
  }

  async function plan(body) {
    if (!exact(body, ['op', 'settings', 'targetId', 'requireRelay', 'mode']) ||
        typeof body.targetId !== 'string' || !targetIdPattern.test(body.targetId) ||
        typeof body.requireRelay !== 'boolean' || !['new', 'picker'].includes(body.mode)) throw fault('invalid_request');

    try {
      const settings = body.settings;
      if (settings?.hostKeyConfirmed !== true || !['codex', 'claude', 'claude-sdk'].includes(settings.provider) ||
          typeof settings.knownHostsPath !== 'string' || !isAbsolute(settings.knownHostsPath)) throw fault('unavailable');
      const route = readRoute();
      if (body.requireRelay && route.kind !== 'relay') throw fault('unavailable');

      const pins = readCheckedFile(settings.knownHostsPath, lstatSync(settings.knownHostsPath), maxPins);
      try { mkdirSync(pinsRoot, { mode: 0o700 }); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
      const info = lstatSync(pinsRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fault('unavailable');
      const knownHostsPath = join(pinsRoot, digest(pins));
      try { writeFileSync(knownHostsPath, pins, { flag: 'wx', mode: 0o400 }); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
      readCommittedPins(knownHostsPath);
      if (await verifyTarget(workbenchRoot, { ...settings, knownHostsPath }) !== body.targetId) throw fault('unavailable');

      return {
        connection: {
          Host: settings.host, Port: settings.port, User: settings.user, Authentication: 'Key',
          IdentityPath: settings.identityPath, KnownHostsPath: knownHostsPath,
        },
        options: {
          provider: 'claude', mode: body.mode, sessionId: null, workspace: settings.workspace,
          expectedIpv4: settings.expectedIpv4, expectedIpv6: settings.expectedIpv6 || null,
          socksPort: route.socksPort ?? null, expectedSshSource: route.expectedSshSource ?? null,
          legacy: false, legacyConfirmed: false, outerOnly: false,
        },
      };
    } catch {
      throw fault('subscription_preflight_rejected');
    }
  }

  async function dispatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault('invalid_request');
    const { op } = body;

    if (op === 'native-subscription-route' && exact(body, ['op'])) return readRoute();
    if (op === 'native-subscription-start' || op === 'native-subscription-current') {
      const { connection, options } = await plan(body);
      if (disposed) throw fault('unavailable');
      try {
        readCommittedPins(connection.KnownHostsPath);
        if (!usesRoute(options, readRoute())) throw fault('unavailable');
      } catch {
        throw fault('subscription_preflight_rejected');
      }
      if (!authorize(op)) throw fault('workbench_browse_only');
      if (op === 'native-subscription-start') {
        return native.request('native-start', { op: 'native-start', hostKeyConfirmed: true, connection, options });
      }
      const current = await native.request('native-current', { op: 'native-current' });
      if (!current.sessionId) return current;
      const record = store().read(current.sessionId);
      if (!Object.entries(connection).every(([key, value]) => record.connection[key] === value) ||
          !Object.entries(options).every(([key, value]) => key === 'mode' || record.options[key] === value)) {
        return { ...current, sessionId: null, otherTerminal: true };
      }
      return current;
    }

    if (op === 'native-list' && exact(body, ['op'])) {
      const result = store().list();
      return { ...result, records: result.records.filter(record => record.options.provider === 'claude') };
    }
    if (op === 'native-status' && exact(body, ['op', 'operationId'])) {
      const record = store().read(body.operationId);
      if (record.options.provider !== 'claude' || !usesRoute(record.options, readRoute())) {
        throw fault('unavailable');
      }
      readCommittedPins(record.connection.KnownHostsPath);
      return native.request(op, body);
    }
    if (terminalOperations.has(op)) return native.request(op, body);
    throw fault('invalid_request');
  }

  return {
    token(req, res) {
      const bootstrap = headers(req, 'x-rtw-bootstrap');
      if (disposed || req.method !== 'GET' || req.url !== `${SUBSCRIPTION_PREFIX}bootstrap` ||
          !allowed(req, port) || bootstrap.length !== 1 || bootstrap[0] !== '1') {
        return send(res, 403, { ok: false, error: '请求被拒绝' });
      }
      return send(res, 200, { token });
    },
    async rpc(req, res) {
      if (disposed || req.method !== 'POST' || req.url !== `${SUBSCRIPTION_PREFIX}rpc` || !allowed(req, port)) {
        return send(res, 403, { ok: false, error: '请求被拒绝' });
      }
      const tokens = headers(req, 'x-rtw-token');
      const supplied = Buffer.from(tokens[0] ?? '');
      const nonce = headers(req, 'x-rtw-nonce');
      const content = headers(req, 'content-type');
      if (tokens.length !== 1 || supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes) ||
          nonce.length !== 1 || !/^[a-f0-9-]{36}$/i.test(nonce[0]) ||
          content.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(content[0])) {
        return send(res, 403, { ok: false, error: '请求被拒绝' });
      }
      const current = now();
      for (const [key, expiry] of nonces) if (expiry <= current) nonces.delete(key);
      if (nonces.has(nonce[0]) || nonces.size >= 10000) return send(res, 409, { ok: false, error: '重复请求已拒绝' });
      nonces.set(nonce[0], current + 600000);

      let body;
      try { body = await readBody(req); }
      catch { return send(res, 400, { ok: false, error: '请求格式无效或过大' }); }
      try {
        if (disposed) throw fault('unavailable');
        if (!authorize(body?.op)) throw fault('workbench_browse_only');
        return send(res, 200, { ok: true, result: await dispatch(body) });
      } catch (failure) {
        const code = errorCodes.has(failure?.code) ? failure.code : 'unavailable';
        if (code === 'workbench_browse_only') return send(res, 403, { ok: false, code, error: '工作台处于仅浏览模式。' });
        return send(res, code === 'invalid_request' ? 400 : 409, { ok: false, error: '终端不可用或结果待确认', code });
      }
    },
    dispose() {
      disposed = true;
      nonces.clear();
      native.dispose();
      for (const child of bridgeChildren) {
        try { child.kill(); } catch {}
      }
    },
  };
}
