import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { apply } from '../index.js';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function origin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

test('a stale plan form cannot write to the newly connected account', async t => {
  const upstreamCalls = [];
  const upstream = await listen((req, res) => {
    upstreamCalls.push({ method: req.method, path: req.url });
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  t.after(() => upstream.close());

  const binding = { serverUrl: origin(upstream), username: 'demo_plan_proxy', token: 'fictional-old-token' };
  let route;
  const disposers = [];
  await apply({
    credentials: { readRecord: async () => ({ payload: binding }) },
    get: name => name === 'webServer' ? { register: r => { route = r; } } : undefined,
    effect: fn => disposers.push(fn()),
    tools: { register() {} },
  }, {});
  t.after(() => { for (const dispose of disposers) dispose?.(); });
  const proxy = await listen(route.handler);
  t.after(() => proxy.close());

  const base = origin(proxy) + '/aecpt-api';
  const status = await (await fetch(base + '/status', { headers: { 'X-Aecpt-Client': '1' } })).json();
  assert.equal(status.connected, true);
  assert.equal(typeof status.bindingId, 'string');
  const headers = { 'X-Aecpt-Client': '1', 'X-Aecpt-Binding': status.bindingId };
  const list = await fetch(base + '/plan-items/', { headers });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
  await list.json();
  // The plan form loads the project list through the same forwarder.
  const projects = await fetch(base + '/projects/', { headers });
  assert.equal(projects.status, 200);
  await projects.json();

  binding.token = 'fictional-replacement-token';
  const create = await fetch(base + '/plan-items/', {
    method: 'POST', headers, body: JSON.stringify({ title: 'Unsent draft' }),
  });
  assert.equal(create.status, 409);
  assert.equal((await create.json()).error.code, 'binding_changed');
  assert.deepEqual(upstreamCalls, [
    { method: 'GET', path: '/api/v1/plan-items/' },
    { method: 'GET', path: '/api/v1/projects/' },
  ]);
});
