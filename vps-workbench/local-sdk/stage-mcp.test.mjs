import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { openStageMcp } from './stage-mcp.mjs';

test('stage MCP gateway scopes discovery and calls, blocks other protocol routes, and revokes live access', { timeout: 10000 }, async (t) => {
  const received = [];
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks = [];
    for await (const bytes of req) chunks.push(bytes);
    const packet = JSON.parse(Buffer.concat(chunks).toString());
    received.push(packet);
    if (packet.id === undefined) { res.writeHead(202).end(); return; }
    if (req.url === '/redirect') { res.writeHead(307, { Location: '/mcp' }).end(); return; }
    const tool = (name) => ({ name, inputSchema: { type: 'object' } });
    const result = packet.method === 'initialize' ? {
      protocolVersion: packet.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
    } : packet.method === 'tools/list' ? { tools: [tool('allowed'), tool('blocked')] } :
      { content: [{ type: 'text', text: 'fixture accepted ' + packet.params.name }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise((resolve) => upstream.close(resolve)); });
  const abort = new AbortController();
  let permitted = true;
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const stage = await openStageMcp([
    { id: 'docs', local: { url: baseUrl + '/mcp', tools: ['allowed'] } },
    { id: 'redirect', local: { url: baseUrl + '/redirect', tools: ['allowed'] } },
  ], () => permitted, abort.signal);
  t.after(stage.close);
  const [{ url }, { url: redirect }] = stage.servers;
  const request = (method, params, { endpoint = url, headers = {} } = {}) => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const rpc = async (...args) => (await request(...args)).json();
  assert.equal((await request('initialize', {}, { headers: { Origin: 'http://localhost' } })).status, 404);
  assert.equal((await request('initialize', {}, { endpoint: new URL('/mcp', url) })).status, 404);
  assert.deepEqual((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.capabilities, { tools: {} });
  assert.equal((await rpc('resources/list', {})).error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'blocked', arguments: {} })).error.code, -32602);
  assert.deepEqual(received, []);
  assert.deepEqual((await rpc('tools/list', {})).result.tools.map(({ name }) => name), ['allowed']);
  assert.match((await rpc('tools/call', { name: 'allowed', arguments: { query: 'fixture' }, _meta: { untrusted: true } }))
    .result.content[0].text, /fixture accepted allowed/u);
  const call = received.find(({ method }) => method === 'tools/call');
  assert.deepEqual(call.params, { name: 'allowed', arguments: { query: 'fixture' } });
  assert.ok((await rpc('tools/call', { name: 'allowed', arguments: { query: 'fixture' } })).result);
  assert.equal((await rpc('tools/call', { name: 'allowed', arguments: { query: 'different' } })).error.code, -32602);
  assert.equal(received.filter(({ method }) => method === 'tools/call').length, 1);
  const count = received.length;
  assert.equal((await rpc('tools/list', {}, { endpoint: redirect })).error.code, -32000);
  assert.equal(received.length, count + 1);
  permitted = false;
  assert.equal((await request('tools/call', { name: 'allowed' })).status, 403);
  assert.equal(received.filter(({ method }) => method === 'tools/call').length, 1);
  await stage.close();
  await assert.rejects(request('tools/list', {}));
});
