import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const tmp = join(import.meta.dirname, '..', '.tmp');
mkdirSync(tmp, { recursive: true });
const testHome = mkdtempSync(join(tmp, 'feeds-'));
const mockHome = mock.method(os, 'homedir', () => testHome);
syncBuiltinESMExports();
const feeds = await import('../feeds.js');
const store = await import('../store.js');
const { apply } = await import('../index.js');
mockHome.mock.restore();
syncBuiltinESMExports();
test.after(() => rmSync(testHome, { recursive: true, force: true }));

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Computers &amp; Graphics</title>
<item><title><![CDATA[Aesthetic <i>evaluation</i> of generated art]]></title>
<link>https://www.sciencedirect.com/science/article/pii/S0097849326000011</link>
<pubDate>Mon, 23 Nov 2026 18:30:00 GMT</pubDate>
<dc:creator>Li Hua</dc:creator><dc:creator>Wang Fang</dc:creator>
<description><![CDATA[<p>Publication date: Dec 2026</p><p>We study &lt;style&gt; transfer &amp; beauty.</p>]]></description></item>
<item><title>Duplicate link</title><link>https://www.sciencedirect.com/science/article/pii/S0097849326000011</link></item>
<item><title>No link at all</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title type="html">ArXiv Query: cat:cs.HC</title>
<entry><id>http://arxiv.org/abs/2611.01234v1</id>
<published>2026-11-23T17:59:59Z</published>
<title>Interfaces that
  feel right</title>
<summary>  We present a study of aesthetic interfaces.  </summary>
<author><name>Ada Zhang</name></author><author><name>Bo Chen</name></author>
<link href="http://arxiv.org/abs/2611.01234v1" rel="alternate" type="text/html"/>
<link title="pdf" href="http://arxiv.org/pdf/2611.01234v1" rel="related" type="application/pdf"/>
</entry></feed>`;

test('RSS 2.0 entries are deduped, tag-free and dated in UTC+8', () => {
  const items = feeds.parseFeed(RSS, 'https://rss.sciencedirect.com/publication/science/00978493');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Aesthetic evaluation of generated art');
  assert.equal(items[0].publishedAt, '2026-11-24');
  assert.equal(items[0].authors, 'Li Hua, Wang Fang');
  assert.match(items[0].summary, /We study <style> transfer & beauty\./);
  assert.equal(feeds.feedTitle(RSS), 'Computers & Graphics');
});

test('arXiv Atom entries use the alternate link and author names', () => {
  const [item] = feeds.parseFeed(ATOM, 'https://export.arxiv.org/api/query');
  assert.equal(item.title, 'Interfaces that feel right');
  assert.equal(item.url, 'http://arxiv.org/abs/2611.01234v1');
  assert.equal(item.authors, 'Ada Zhang, Bo Chen');
  assert.equal(item.publishedAt, '2026-11-24');
  assert.equal(item.summary, 'We present a study of aesthetic interfaces.');
});

test('subscriptions only reach public http(s) hosts', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  for (const url of ['http://localhost:8000/feed', 'http://127.0.0.1/feed', 'http://[::1]/feed', 'http://10.1.2.3/rss',
    'http://192.168.1.5/rss', 'file:///etc/passwd', 'https://user:pw@example.org/rss', 'not a url']) {
    await assert.rejects(feeds.assertPublicUrl(url, { lookup: publicLookup }), error => error.status === 400, url);
  }
  await assert.rejects(feeds.assertPublicUrl('https://intranet.example/rss', { lookup: async () => [{ address: '172.16.0.9' }] }),
    error => error.code === 'private_feed_host');
  assert.equal((await feeds.assertPublicUrl('https://example.org/rss#x', { lookup: publicLookup })).href, 'https://example.org/rss');
  // A redirect into a private address is refused as well.
  const redirecting = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  await assert.rejects(feeds.fetchFeed('https://example.org/rss', { fetchImpl: redirecting, lookup: publicLookup }),
    error => error.code === 'private_feed_host');
});

test('subscribe, refresh, read and manage feeds through the proxy', async t => {
  const responses = new Map([['https://journal.example/rss', RSS], ['https://export.arxiv.org/api/query?search_query=cat:cs.HC', ATOM]]);
  const options = {
    lookup: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async url => responses.has(url)
      ? new Response(responses.get(url), { status: 200, headers: { 'content-type': 'application/xml' } })
      : new Response('<html>not a feed</html>', { status: 200 }),
  };
  // Subscriptions never touch the AeCpt server; the upstream only answers report sync.
  const upstream = createServer((req, res) => {
    res.writeHead(req.url === '/api/v1/reports/sync/' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/v1/reports/sync/' ? { tasks: [] } : {}));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const binding = { token: 'feeds-token', username: 'demo_feeds', userId: 5, serverInstance: 'feeds-db',
    serverUrl: `http://127.0.0.1:${upstream.address().port}`, bindingId: 'feeds-binding' };

  await assert.rejects(feeds.addSource(binding, { url: 'https://journal.example/not-a-feed' }, options),
    error => error.code === 'not_a_feed');
  const journal = await feeds.addSource(binding, { url: 'https://journal.example/rss', kind: 'journal' }, options);
  assert.equal(journal.name, 'Computers & Graphics');
  await assert.rejects(feeds.addSource(binding, { url: 'https://journal.example/rss' }, options), error => error.code === 'feed_exists');
  const arxiv = await feeds.addSource(binding, { url: 'https://export.arxiv.org/api/query?search_query=cat:cs.HC', kind: 'arxiv', name: 'arXiv HC' }, options);
  assert.equal(arxiv.name, 'arXiv HC');

  let listed = feeds.listFeeds(binding);
  assert.equal(listed.sources.length, 2);
  assert.equal(listed.unreadCount, 2);
  const refreshed = await feeds.refreshFeeds(binding, {}, options);
  assert.deepEqual(refreshed, { refreshed: 2, failed: 0, added: 0 });

  // Route level: list, mark read and confirm the removed cite route is gone.
  const records = new Map([['dsh-aecpt/default', { kind: 'grant', payload: binding }]]);
  let route;
  const tools = new Map();
  const disposers = [];
  await apply({
    credentials: { async readRecord(key) { return records.get(key); }, async deleteRecord(key) { records.delete(key); } },
    get: name => name === 'webServer' ? { register(r) { route = r; } } : undefined,
    effect(fn) { disposers.push(fn()); },
    tools: { register(tool) { tools.set(tool.name, tool); } },
  }, {});
  t.after(() => { for (const dispose of disposers) dispose?.(); });
  const proxy = createServer(route.handler);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const call = (path, body) => fetch(`http://127.0.0.1:${proxy.address().port}/aecpt-api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Aecpt-Client': '1', 'X-Aecpt-Binding': 'feeds-binding', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const viaProxy = await (await call('/feeds/?unread=1')).json();
  assert.equal(viaProxy.items.length, 2);
  const other = viaProxy.items.find(item => item.sourceId === arxiv.id);
  assert.equal((await call('/feeds/read', { sourceId: other.sourceId, key: other.key, read: true })).status, 200);
  assert.equal(feeds.listFeeds(binding).unreadCount, 1);
  assert.equal((await call('/feeds/read', { sourceId: other.sourceId, key: other.key, read: false })).status, 200);
  assert.equal(feeds.listFeeds(binding).unreadCount, 2);
  assert.equal((await call('/feeds/read', { sourceId: other.sourceId, key: 'missing', read: true })).status, 404);
  assert.equal((await call('/feeds/cite', { sourceId: other.sourceId, key: other.key, period: '26FA13W' })).status, 404);

  // Agent tool lists both source ids and entries.
  const feedsTool = tools.get('aecpt_feeds');
  assert.ok(feedsTool);
  assert.ok(!feedsTool.parameters.action.enum.includes('cite'));
  const toolList = await feedsTool.execute({ action: 'list', unread: true }, {});
  assert.match(toolList.text, new RegExp(arxiv.id));
  assert.match(toolList.text, /Interfaces that feel right/);

  const removed = await fetch(`http://127.0.0.1:${proxy.address().port}/aecpt-api/feeds/sources/${encodeURIComponent(arxiv.id)}/`, {
    method: 'DELETE', headers: { 'X-Aecpt-Client': '1', 'X-Aecpt-Binding': 'feeds-binding' },
  });
  assert.equal(removed.status, 200);
  assert.equal(feeds.listFeeds(binding).sources.length, 1);

  // Clearing local cache removes the account's feed store as well.
  store.forgetAccountCache(binding);
  assert.equal(feeds.listFeeds(binding).sources.length, 0);
});
