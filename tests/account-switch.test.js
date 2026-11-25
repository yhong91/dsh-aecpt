import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const tmp = join(import.meta.dirname, '..', '.tmp');
mkdirSync(tmp, { recursive: true });
const testHome = mkdtempSync(join(tmp, 'account-switch-'));
const mockHome = mock.method(os, 'homedir', () => testHome);
syncBuiltinESMExports();
const { apply } = await import('../index.js');
mockHome.mock.restore();
syncBuiltinESMExports();

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const USERS = {
  a: { id: 11, username: 'demo_switch_a', full_name: '张三', student_number: 'S2026011', server_instance: 'fictional-db' },
  b: { id: 12, username: 'demo_switch_b', full_name: '李四', student_number: 'S2026012', server_instance: 'fictional-db' },
};

test('reconnects resume the same account cache and require an explicit switch', async t => {
  t.after(() => rmSync(testHome, { recursive: true, force: true }));
  let reportsOnline = true;
  let minted = 0;
  const tokens = new Map(); // api token -> user key
  const revoked = [];
  const upstream = await listen((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const send = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (req.url === '/oauth/token/') {
        const code = new URLSearchParams(body).get('code');
        return send({ access_token: `oauth-${code}` });
      }
      if (req.url === '/api/v1/auth/tokens/exchange/') {
        const user = bearer.replace(/^oauth-code-/, '').slice(0, 1);
        const token = `aec_${user}_${++minted}`;
        tokens.set(token, user);
        return send({ token, id: minted });
      }
      if (req.url === '/api/v1/auth/tokens/current/revoke/') {
        revoked.push(bearer);
        return send({}, 204);
      }
      const user = tokens.get(bearer);
      if (!user || revoked.includes(bearer)) return send({ error: { code: 'authentication_failed' } }, 403);
      if (req.url === '/api/v1/me/') return send(USERS[user]);
      if (req.url === '/api/v1/reports/sync/') return send({ tasks: [] });
      if (req.url === '/api/v1/reports/' && req.method === 'POST') {
        if (!reportsOnline) return req.socket.destroy();
      }
      return send({}, 404);
    });
  });
  t.after(() => upstream.close());

  const records = new Map();
  let route;
  const disposers = [];
  await apply({
    credentials: {
      async readRecord(key) { return records.get(key); },
      async modifyRecord(key, update) { const next = await update(records.get(key)); records.set(key, next); return next; },
      async deleteRecord(key) { records.delete(key); },
    },
    get: name => name === 'webServer' ? { register(r) { route = r; } } : undefined,
    effect(fn) { disposers.push(fn()); },
    tools: { register() {} },
  }, { serverUrl: `http://127.0.0.1:${upstream.address().port}` });
  t.after(() => { for (const dispose of disposers) dispose?.(); });
  const proxy = await listen(route.handler);
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.address().port}/aecpt-api`;

  const call = (path, { bindingId, body, method = body ? 'POST' : 'GET', client = true } = {}) => fetch(base + path, {
    method,
    headers: {
      ...(client ? { 'X-Aecpt-Client': '1' } : {}),
      ...(bindingId ? { 'X-Aecpt-Binding': bindingId } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const status = async () => (await call('/status')).json();
  const authorize = async code => {
    const { state } = await (await call('/authorize/start', { body: {} })).json();
    const response = await call('/authorize/complete', { body: { state, code } });
    return { state, response, data: await response.json() };
  };

  assert.equal((await call('/status', { client: false })).status, 403);

  // First connection on a fresh device commits directly.
  const first = await authorize('code-a1');
  assert.equal(first.response.status, 200);
  const connected = await status();
  assert.equal(connected.fullName, '张三');
  assert.equal(connected.studentNumber, 'S2026011');
  const firstBinding = connected.bindingId;

  // Leave one draft only on this device.
  reportsOnline = false;
  const draft = await call('/reports/', { bindingId: firstBinding, body: { period: '26FA13W', content: '离线草稿' } });
  assert.equal(draft.status, 201);
  assert.equal((await status()).pendingCount, 1);

  // Disconnect keeps the cache and revokes the token.
  const disconnected = await call('/disconnect', { bindingId: firstBinding, body: {} });
  assert.deepEqual(await disconnected.json(), { connected: false, cacheKept: true });
  const offline = await status();
  assert.equal(offline.connected, false);
  assert.equal(offline.cachedAccount.fullName, '张三');
  assert.equal(offline.cachedAccount.pendingCount, 1);

  // A different account needs explicit confirmation; cancel discards its token.
  const other = await authorize('code-b1');
  assert.equal(other.response.status, 409);
  assert.equal(other.data.error.code, 'account_mismatch');
  assert.equal(other.data.previous.fullName, '张三');
  assert.equal(other.data.previous.pendingCount, 1);
  assert.equal(other.data.incoming.fullName, '李四');
  assert.equal(records.size, 0);
  const cancelled = await call('/authorize/confirm', { body: { state: other.state, choice: 'cancel' } });
  assert.equal(cancelled.status, 200);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(revoked.some(token => token.startsWith('aec_b_')));
  assert.equal((await status()).connected, false);

  // The same account resumes its cache without a prompt.
  const again = await authorize('code-a2');
  assert.equal(again.response.status, 200);
  const resumed = await status();
  assert.equal(resumed.fullName, '张三');
  assert.equal(resumed.pendingCount, 1);
  assert.notEqual(resumed.bindingId, firstBinding);

  // A view still holding the old binding cannot act on the new one.
  const stale = await call('/reports/', { bindingId: firstBinding, body: { period: '26FA14W', content: 'x' } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'binding_changed');

  // Clearing the cache with unsynced work needs an explicit discard.
  const guarded = await call('/disconnect', { bindingId: resumed.bindingId, body: { clearCache: true } });
  assert.equal(guarded.status, 409);
  assert.equal((await guarded.json()).work.pendingCount, 1);
  const discarded = await call('/disconnect', { bindingId: resumed.bindingId, body: { clearCache: true, discardLocal: true } });
  assert.deepEqual(await discarded.json(), { connected: false, cacheKept: false });
  assert.equal((await status()).cachedAccount, null);

  // With no cached account the next connection commits; switching then needs consent.
  assert.equal((await authorize('code-b2')).response.status, 200);
  assert.equal((await status()).fullName, '李四');
  const back = await authorize('code-a3');
  assert.equal(back.data.error.code, 'account_mismatch');
  const switched = await call('/authorize/confirm', { body: { state: back.state, choice: 'switch' } });
  assert.equal(switched.status, 200);
  const final = await status();
  assert.equal(final.fullName, '张三');
  assert.equal(final.pendingCount, 0);
});
