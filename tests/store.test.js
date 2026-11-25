import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  syncNow, loadStore, saveStore, createDraft, editDraft,
  resolveConflict, exportMarkdown, listPayloads,
} from '../store.js';

let server;
let base;
let routes;
const binding = () => ({ token: 'test-token', serverUrl: base, username: `store-test-${process.pid}` });

function payload(overrides = {}) {
  return {
    id: 1, author: { id: 9, username: 'demo_student_a', full_name: '李本科' },
    period: '26FA12W', project: null, status: 'draft', status_display: '草稿',
    revision: 1, submitted_at: null, created_at: '2026-11-20T00:00:00Z',
    updated_at: '2026-11-20T00:00:00Z', feedback_count: 0,
    content: 'base content', feedback: [], ...overrides,
  };
}

before(async () => {
  routes = {};
  server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    const handler = routes[key];
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'no_route', detail: key } }));
        return;
      }
      const out = handler(JSON.parse(body || '{}'));
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  const dir = join(homedir(), '.aecpt', 'dsh');
  try {
    for (const f of readdirSync(dir)) {
      try {
        const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (String(data.username || '').startsWith('store-test')) rmSync(join(dir, f));
      } catch { /* skip non-store files */ }
    }
  } catch { /* dir may not exist */ }
});

function resetStore() {
  const store = loadStore(binding());
  store.reports = {};
  store.pending = [];
  store.lastSync = null;
  store.online = false;
  saveStore(store);
  return store;
}

test('pull task stores entry and sets watermark', async () => {
  resetStore();
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'pull', report: payload() }] },
  });
  const store = await syncNow(binding());
  assert.equal(store.online, true);
  assert.ok(store.lastSync);
  assert.equal(store.reports['1'].payload.content, 'base content');
  assert.equal(store.reports['1'].dirty, false);
});

test('offline create queues, reconnect flushes and remaps id', async () => {
  resetStore();
  server.close();
  await new Promise(r => setTimeout(r, 50));
  // Re-create a closed-port binding by pointing at a dead port.
  const dead = { ...binding(), serverUrl: 'http://127.0.0.1:1' };
  const created = await createDraft(dead, { period: '26FA15W', content: 'offline draft' });
  assert.equal(created.status, 201);
  assert.ok(created.payload.local_only);
  let store = loadStore(dead);
  assert.equal(store.pending.length, 1);
  assert.equal(store.online, false);

  // Bring the mock back on the same port is not possible; use a live binding
  // sharing the same store by fixing serverUrl in the store file.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  routes['POST /api/v1/reports/'] = () => ({ status: 201, body: payload({ id: 77, period: '26FA15W', content: 'offline draft' }) });
  routes['POST /api/v1/reports/sync/'] = () => ({ body: { tasks: [] } });
  store = loadStore(dead);
  store.serverUrl = base;
  saveStore(store);
  const live = { ...dead, serverUrl: base };
  const synced = await syncNow(live);
  assert.equal(synced.pending.length, 0);
  assert.ok(synced.reports['77']);
  assert.equal(synced.reports['77'].payload.period, '26FA15W');
  const localKeys = Object.keys(synced.reports).filter(k => k.startsWith('local-'));
  assert.equal(localKeys.length, 0);
});

test('editing an offline draft on reconnect sends the latest Markdown and returns its server id', async () => {
  resetStore();
  const dead = { ...binding(), serverUrl: 'http://127.0.0.1:1' };
  const created = await createDraft(dead, { period: '26FA17W', content: '## 初稿' });
  assert.equal(created.status, 201);
  const queued = loadStore(dead);
  queued.serverUrl = base;
  saveStore(queued);
  routes['POST /api/v1/reports/'] = body => ({
    status: 201, body: payload({ id: 78, period: body.period, content: body.content }),
  });
  const markdown = '## 本周进展\n\n- [x] 核对实验结果\n';
  const edited = await editDraft(binding(), created.payload.id, markdown);
  assert.equal(edited.status, 200);
  assert.equal(edited.payload.id, 78);
  assert.equal(edited.payload.content, markdown);
  assert.equal(edited.payload.dirty, false);
  assert.equal(loadStore(binding()).pending.length, 0);
});

test('dirty edit with push task flushes clean', async () => {
  resetStore();
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'pull', report: payload() }] },
  });
  await syncNow(binding());
  routes['PATCH /api/v1/reports/1/'] = body => ({
    body: payload({ revision: 2, content: body.content }),
  });
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'push', id: 1, revision: 1 }] },
  });
  const edited = await editDraft(binding(), 1, 'local edit');
  assert.equal(edited.status, 200);
  const store = loadStore(binding());
  assert.equal(store.reports['1'].dirty, false);
  assert.equal(store.reports['1'].payload.content, 'local edit');
  assert.equal(store.pending.length, 0);
});

test('overlapping server update creates conflict; resolve local pushes', async () => {
  resetStore();
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'pull', report: payload() }] },
  });
  await syncNow(binding());
  // Local dirty edit without flushing (simulate offline edit).
  let store = loadStore(binding());
  store.reports['1'].dirty = true;
  store.reports['1'].localContent = 'LOCAL change';
  store.pending = [];
  saveStore(store);
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'pull', report: payload({ revision: 3, content: 'SERVER change' }) }] },
  });
  store = await syncNow(binding());
  assert.ok(store.reports['1'].conflict, 'conflict recorded');
  assert.equal(store.reports['1'].conflict.local, 'LOCAL change');
  assert.equal(store.reports['1'].conflict.server, 'SERVER change');

  routes['PATCH /api/v1/reports/1/'] = body => ({
    body: payload({ revision: 4, content: body.content }),
  });
  routes['POST /api/v1/reports/sync/'] = () => ({ body: { tasks: [] } });
  const resolved = await resolveConflict(binding(), 1, { choice: 'local' });
  assert.equal(resolved.status, 200);
  store = loadStore(binding());
  assert.equal(store.reports['1'].conflict, null);
  assert.equal(store.reports['1'].dirty, false);
  assert.equal(store.reports['1'].payload.content, 'LOCAL change');
});

test('disjoint server update auto-merges via diff3', async () => {
  resetStore();
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'pull', report: payload({ content: 'line1\nline2' }) }] },
  });
  await syncNow(binding());
  let store = loadStore(binding());
  store.reports['1'].dirty = true;
  store.reports['1'].localContent = 'LOCAL\nline2';
  store.pending = [];
  saveStore(store);
  routes['PATCH /api/v1/reports/1/'] = body => ({
    body: payload({ revision: 3, content: body.content }),
  });
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'pull', report: payload({ revision: 2, content: 'line1\nSERVER' }) }] },
  });
  store = await syncNow(binding());
  assert.equal(store.reports['1'].conflict, null);
  assert.equal(store.reports['1'].payload.content, 'LOCAL\nSERVER');
  assert.equal(store.reports['1'].dirty, false);
});

test('delete task purges local copy', async () => {
  resetStore();
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'pull', report: payload() }] },
  });
  await syncNow(binding());
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'delete', id: 1 }] },
  });
  const store = await syncNow(binding());
  assert.equal(store.reports['1'], undefined);
});

test('export markdown contains content and feedback', async () => {
  resetStore();
  routes['POST /api/v1/reports/sync/'] = () => ({
    body: { tasks: [{ action: 'pull', report: payload({ feedback: [{ id: 1, author: { full_name: '王导师' }, content: '很好', created_at: '2026-11-21T00:00:00Z' }] }) }] },
  });
  const store = await syncNow(binding());
  const md = exportMarkdown(store);
  assert.ok(md.includes('base content'));
  assert.ok(md.includes('王导师'));
  assert.ok(md.includes('26FA12W'));
  assert.ok(listPayloads(store).length === 1);
});