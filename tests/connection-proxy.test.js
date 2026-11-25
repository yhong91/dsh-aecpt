import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { apply } from '../index.js';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('student connection probe and disconnect stay on the Host', async t => {
  const upstream = await listen((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ username: 'demo_student_probe', is_student: true }));
  });
  t.after(() => upstream.close());
  const records = new Map([
    ['dsh-aecpt/default', { payload: { token: '{{SECRET_probe_token}}', username: 'demo_student_probe', serverUrl: `http://127.0.0.1:${upstream.address().port}` } }],
  ]);
  let route;
  const disposers = [];
  await apply({
    get(name) { return name === 'webServer' ? { register(r) { route = r; } } : undefined; },
    credentials: {
      async readRecord(key) { return records.get(key); },
      async deleteRecord(key) { records.delete(key); },
    },
    effect(fn) { disposers.push(fn()); },
    tools: { register() {} },
  }, {});
  t.after(() => { for (const dispose of disposers) dispose?.(); });
  const host = await listen(route.handler);
  t.after(() => host.close());
  const base = `http://127.0.0.1:${host.address().port}/aecpt-api`;

  const { bindingId } = await (await fetch(base + '/status', { headers: { 'X-Aecpt-Client': '1' } })).json();
  const headers = { 'X-Aecpt-Client': '1', 'X-Aecpt-Binding': bindingId };
  assert.equal((await fetch(base + '/connection/', { headers: { 'X-Aecpt-Client': '1' } })).status, 409);
  const connection = await fetch(base + '/connection/', { headers });
  assert.equal(connection.status, 200);
  const connectionBody = await connection.json();
  assert.equal(connectionBody.online, true);
  assert.equal(connectionBody.connected, true);

  const disconnected = await fetch(base + '/disconnect', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(disconnected.status, 200);
  assert.equal(records.has('dsh-aecpt/default'), false);
});

test('legacy credential migrates to the aecpt key', async t => {
  const upstream = await listen((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ username: 'demo_legacy_probe', is_student: true }));
  });
  t.after(() => upstream.close());
  const records = new Map([
    ['dsh-aecompute/default', { payload: { token: '{{SECRET_legacy_token}}', username: 'demo_legacy_probe', serverUrl: `http://127.0.0.1:${upstream.address().port}` } }],
  ]);
  let route;
  const disposers = [];
  await apply({
    get(name) { return name === 'webServer' ? { register(r) { route = r; } } : undefined; },
    credentials: {
      async readRecord(key) { return records.get(key); },
      async modifyRecord(key, update) { const next = await update(records.get(key)); records.set(key, next); return next; },
      async deleteRecord(key) { records.delete(key); },
    },
    effect(fn) { disposers.push(fn()); },
    tools: { register() {} },
  }, {});
  t.after(() => { for (const dispose of disposers) dispose?.(); });
  const host = await listen(route.handler);
  t.after(() => host.close());
  const status = await (await fetch(`http://127.0.0.1:${host.address().port}/aecpt-api/status`, { headers: { 'X-Aecpt-Client': '1' } })).json();
  assert.equal(status.connected, true);
  assert.equal(records.has('dsh-aecompute/default'), false);
  assert.equal(records.has('dsh-aecpt/default'), true);
});
