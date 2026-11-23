import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validLocalMcpEndpoint } from '../extensions/state.mjs';

const protocolVersions = ['2025-03-26', '2025-06-18', '2025-11-25'];
const deadline = 15000;
const maxBody = 128 * 1024;
const maxUpstream = 2 * 1024 * 1024;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (id) => (typeof id === 'string' && id.length <= 128) || Number.isSafeInteger(id);
const identify = { name: 'vps-workbench-stage-mcp', version: '1.0.0' };

async function readRequest(request) {
  const pieces = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBody) throw new Error('request too large');
    pieces.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces)));
}

function response(res, status, packet) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...(packet && { 'Content-Type': 'application/json' }) });
  res.end(packet ? JSON.stringify(packet) : undefined);
}

function upstreamFor(url, isAllowed, abort) {
  let connection;
  const client = new Client(identify);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1, maxReconnectionDelay: 0 },
    async fetch(input, options) {
      if (String(input) !== url || !isAllowed()) throw new Error('MCP target changed');
      const result = await fetch(input, { ...options, redirect: 'error',
        signal: AbortSignal.any([abort, AbortSignal.timeout(deadline), ...(options?.signal ? [options.signal] : [])]) });
      if (!result.body) return result;
      let size = 0;
      const body = result.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxUpstream) controller.error(new Error('MCP response too large'));
        else controller.enqueue(chunk);
      } }));
      return new Response(body, { status: result.status, headers: result.headers });
    },
  });
  return {
    async get() {
      connection ??= client.connect(transport, { timeout: deadline, signal: abort });
      await connection;
      if (!isAllowed()) throw new Error('MCP authorization changed');
      return client;
    },
    close: () => client.close(),
  };
}

export async function openStageMcp(servers, permitted, signal) {
  const lifetime = new AbortController();
  const isAllowed = () => !lifetime.signal.aborted && !signal.aborted && permitted();
  const paths = new Map();
  for (const { id, local } of servers) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || !validLocalMcpEndpoint(local?.url, local?.tools)) {
      throw new Error('invalid MCP stage configuration');
    }
    const path = '/' + randomBytes(24).toString('hex') + '/mcp';
    const upstream = upstreamFor(local.url, isAllowed, lifetime.signal);
    paths.set(path, { id, tools: new Set(local.tools), upstream, calls: new Map() });
  }

  async function handle(req, res) {
    const scope = paths.get(req.url);
    if (!scope || req.headers.host !== '127.0.0.1:' + server.address()?.port || req.headers.origin !== undefined ||
        req.headers['sec-fetch-site'] !== undefined) return response(res, 404);
    if (req.method !== 'POST') return response(res, 405);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return response(res, 415);
    if (!isAllowed()) return response(res, 403);
    let packet;
    try { packet = await readRequest(req); }
    catch { return response(res, 400); }
    if (!isRecord(packet) || packet.jsonrpc !== '2.0' || typeof packet.method !== 'string' ||
        (Object.hasOwn(packet, 'params') && !isRecord(packet.params))) return response(res, 400);
    const { method, id, params = {} } = packet;
    if (id === undefined && ['notifications/initialized', 'notifications/cancelled'].includes(method)) return response(res, 202);
    if (!validId(id)) return response(res, 400);
    const send = (result) => response(res, 200, { jsonrpc: '2.0', id, result });
    const error = (code, message) => response(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
    if (!isAllowed()) return error(-32000, 'Stage MCP authorization changed');
    if (method === 'initialize') return send({
      protocolVersion: protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0],
      capabilities: { tools: {} }, serverInfo: identify,
    });
    if (method === 'ping') return send({});
    if (method !== 'tools/list' && method !== 'tools/call') return error(-32601, 'Only stage tools are available');
    if (method === 'tools/call' && (!scope.tools.has(params.name) ||
        ('arguments' in params && !isRecord(params.arguments)))) return error(-32602, 'Tool is not authorized for this stage');
    try {
      const client = await scope.upstream.get();
      const options = { signal: lifetime.signal, timeout: deadline };
      if (method === 'tools/list') {
        // Expose at most the names the user chose. Upstream pagination cannot add grants.
        const tools = [];
        const seen = new Set();
        let cursor;
        for (let page = 0; page < 8; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, options);
          for (const tool of result.tools) {
            if (!scope.tools.has(tool.name) || seen.has(tool.name)) continue;
            seen.add(tool.name);
            tools.push(tool);
          }
          cursor = result.nextCursor;
          if (!cursor || seen.size === scope.tools.size) break;
        }
        return isAllowed() ? send({ tools }) : error(-32000, 'Stage MCP authorization changed');
      }
      if (!isAllowed()) return error(-32000, 'Stage MCP authorization changed');
      const args = { name: params.name, arguments: params.arguments };
      const signature = JSON.stringify(args);
      let call = scope.calls.get(id);
      if (call && call.signature !== signature) return error(-32602, 'Tool request ID conflicts with an earlier call');
      if (!call) {
        if (scope.calls.size >= 256) return error(-32000, 'Stage tool request limit reached');
        call = { signature, result: client.callTool(args, undefined, options) };
        scope.calls.set(id, call);
      }
      const result = await call.result;
      return isAllowed() ? send(result) : error(-32000, 'Stage MCP authorization changed');
    } catch {
      return error(-32000, 'Stage MCP server unavailable');
    }
  }

  const server = createServer({ requestTimeout: deadline, headersTimeout: deadline }, (req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) response(res, 500); else res.destroy(); });
  });
  let closing;
  const close = () => closing ??= (async () => {
    lifetime.abort();
    signal.removeEventListener('abort', stop);
    server.closeAllConnections();
    await Promise.allSettled([...paths.values()].map(({ upstream }) => upstream.close()));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  })();
  const stop = () => { void close(); };
  try {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    signal.addEventListener('abort', stop, { once: true });
    signal.throwIfAborted();
    return { close, servers: [...paths].map(([path, { id, tools }]) =>
      ({ name: id, url: 'http://127.0.0.1:' + server.address().port + path, tools: [...tools] })) };
  } catch (error) {
    await close();
    throw error;
  }
}

export function withStageMcp(servers, permitted, createThread) {
  if (!servers.length) return createThread([]);
  return { async runStreamed(input, options) {
    const gate = await openStageMcp(servers, permitted, options.signal);
    try {
      const stream = await createThread(gate.servers).runStreamed(input, options);
      return { events: (async function* () {
        try { yield* stream.events; }
        finally { await gate.close(); }
      })() };
    } catch (error) {
      await gate.close();
      throw error;
    }
  } };
}
