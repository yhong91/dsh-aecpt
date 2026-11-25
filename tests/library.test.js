import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const tmp = join(import.meta.dirname, '..', '.tmp');
mkdirSync(tmp, { recursive: true });
const testHome = mkdtempSync(join(tmp, 'library-'));
const mockHome = mock.method(os, 'homedir', () => testHome);
syncBuiltinESMExports();
const library = await import('../library.js');
const store = await import('../store.js');
const { apply } = await import('../index.js');
mockHome.mock.restore();
syncBuiltinESMExports();
test.after(() => rmSync(testHome, { recursive: true, force: true }));

// External metadata/PDF fetches never leave the process in tests.
const external = new Map();
const externalCalls = [];
library.network.lookup = async () => [{ address: '93.184.216.34' }];
library.network.fetch = async (url, init) => {
  externalCalls.push({ url, init });
  const handler = external.get(url);
  if (!handler) return new Response('not found', { status: 404 });
  return handler(url, init);
};

const CROSSREF = {
  status: 'ok',
  message: {
    DOI: '10.1145/3544548.3581000',
    title: ['Computational <i>Aesthetics</i> &amp; Interfaces'],
    author: [{ given: 'Hua', family: 'Li' }, { given: 'Fang', family: 'Wang' }, { name: 'AeCpt Lab' }],
    published: { 'date-parts': [[2026, 4]] },
    issued: { 'date-parts': [[2025]] },
    'container-title': ['Proceedings of the Fictional Conference on Aesthetics'],
    abstract: '<jats:title>Abstract</jats:title><jats:p>We study beauty &amp; usability.</jats:p>',
    URL: 'https://doi.org/10.1145/3544548.3581000',
  },
};

const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
<title>arXiv Query</title>
<entry><id>http://arxiv.org/abs/2611.01234v2</id>
<published>2026-11-02T10:00:00Z</published>
<title>Interfaces that
  feel right</title>
<summary>  We present a fictional study of aesthetic interfaces.  </summary>
<author><name>Ada Zhang</name></author><author><name>Bo Chen</name></author>
<arxiv:doi>10.1000/fictional.2026.1</arxiv:doi>
<link href="http://arxiv.org/abs/2611.01234v2" rel="alternate" type="text/html"/>
</entry></feed>`;

const ARXIV_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_9999.99999</id>
<title>Error</title><summary>incorrect id format</summary></entry></feed>`;

const PDF_BYTES = Buffer.from('%PDF-1.4\n% fictional test pdf\n1 0 obj << >> endobj\n%%EOF\n');

external.set('https://api.crossref.org/works/10.1145/3544548.3581000', () => Response.json(CROSSREF));
external.set('https://api.crossref.org/works/10.1000/dup', () => Response.json({ message: { title: ['Dup'], DOI: '10.1000/dup' } }));
external.set('https://export.arxiv.org/api/query?id_list=2611.01234&max_results=1',
  () => new Response(ARXIV_ATOM, { headers: { 'content-type': 'application/atom+xml' } }));
external.set('https://export.arxiv.org/api/query?id_list=9999.99999&max_results=1',
  () => new Response(ARXIV_ERROR, { headers: { 'content-type': 'application/atom+xml' } }));
external.set('https://arxiv.org/pdf/2611.01234', () => new Response(null, { status: 301, headers: { location: 'https://arxiv.org/pdf/2611.01234v2' } }));
external.set('https://arxiv.org/pdf/2611.01234v2', () => new Response(PDF_BYTES, { headers: { 'content-type': 'application/pdf' } }));
external.set('https://arxiv.org/pdf/2611.05555', () => new Response('<html>busy</html>', { headers: { 'content-type': 'text/html' } }));

const PAPER = {
  id: 3, title: 'Computational Aesthetics & Interfaces', authors: ['Hua Li', 'Fang Wang'], year: 2026,
  venue: 'Fictional Conference', doi: '10.1145/3544548.3581000', arxiv_id: '', url: '', abstract: 'We study beauty.',
  tags: ['美学'], note: '入门必读', status: 'approved', status_display: '已入库',
  pdf: { name: '论文.pdf', size: PDF_BYTES.length, sha256: 'x' },
  submitted_by: { id: 5, username: 'demo_library', name: '示例学生' },
};

test('identifiers: DOI, doi.org URL, arXiv id and URLs', () => {
  assert.deepEqual(library.parseIdentifier(' https://doi.org/10.1145/3544548.3581000 '), { kind: 'doi', doi: '10.1145/3544548.3581000' });
  assert.deepEqual(library.parseIdentifier('doi:10.1016/J.CAG.2026.000011'), { kind: 'doi', doi: '10.1016/j.cag.2026.000011' });
  assert.deepEqual(library.parseIdentifier('arXiv:2611.01234v3'), { kind: 'arxiv', id: '2611.01234', version: 'v3' });
  assert.deepEqual(library.parseIdentifier('https://arxiv.org/pdf/2611.01234v2.pdf'), { kind: 'arxiv', id: '2611.01234', version: 'v2' });
  assert.deepEqual(library.parseIdentifier('https://arxiv.org/abs/cs/0112017'), { kind: 'arxiv', id: 'cs/0112017', version: '' });
  assert.deepEqual(library.parseIdentifier('10.48550/arXiv.2611.01234'), { kind: 'arxiv', id: '2611.01234', version: '' });
  for (const bad of ['', 'hello world', 'https://example.org/paper', '11.1/x']) {
    assert.throws(() => library.parseIdentifier(bad), error => error.status === 400, bad);
  }
});

test('library proxy routes, submission relay and agent tool', async t => {
  const received = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://upstream');
    received.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization });
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname === '/api/v1/library/papers/') {
      const form = await new Request('http://upstream/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData();
      const metadata = JSON.parse(form.get('metadata'));
      const pdf = form.get('pdf');
      const pdfBytes = Buffer.from(await pdf.arrayBuffer());
      received.at(-1).form = { metadata, pdfName: pdf.name, pdfType: pdf.type, pdfBytes };
      if (metadata.doi === '10.1000/dup') {
        return json(409, { error: { code: 'paper_duplicate', detail: '库中已有这篇论文', correlation_id: 'c1', existing: { id: 3, title: PAPER.title, status: 'approved' } } });
      }
      return json(201, { ...PAPER, id: 7, title: metadata.title, status: 'pending', status_display: '待审核' });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/library/papers/') return json(200, [PAPER]);
    if (url.pathname === '/api/v1/library/papers/3/') {
      if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      return json(200, PAPER);
    }
    if (url.pathname === '/api/v1/library/papers/3/pdf/') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=utf-8''${encodeURIComponent('论文.pdf')}`,
        'Content-Length': String(PDF_BYTES.length),
      });
      return res.end(PDF_BYTES);
    }
    if (url.pathname === '/api/v1/library/papers/99/pdf/') return json(404, { error: { code: 'not_found', detail: '没有这篇论文' } });
    if (url.pathname === '/api/v1/library/submissions/') return json(200, [{ ...PAPER, id: 8, status: 'rejected', status_display: '未通过', review_note: '请补充 PDF 全文' }]);
    if (url.pathname === '/api/v1/library/export/') {
      return json(200, { count: 1, bibtex: '@inproceedings{li2026computational,\n  title = {Computational Aesthetics},\n}\n' });
    }
    json(404, { error: { code: 'not_found', detail: 'missing' } });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const binding = { token: 'library-token', username: 'demo_library', userId: 5, serverInstance: 'library-db',
    serverUrl: `http://127.0.0.1:${upstream.address().port}`, bindingId: 'library-binding' };

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
  const base = `http://127.0.0.1:${proxy.address().port}/aecpt-api`;
  const headers = { 'X-Aecpt-Client': '1', 'X-Aecpt-Binding': 'library-binding', 'Content-Type': 'application/json' };
  const call = (path, { method = 'GET', body } = {}) => fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Resolve: DOI through Crossref.
  let res = await call('/library/resolve', { method: 'POST', body: { identifier: 'https://doi.org/10.1145/3544548.3581000' } });
  assert.equal(res.status, 200);
  let resolved = await res.json();
  assert.equal(resolved.pdfUrl, null);
  assert.deepEqual(resolved.metadata, {
    title: 'Computational Aesthetics & Interfaces',
    authors: ['Hua Li', 'Fang Wang', 'AeCpt Lab'],
    year: 2026,
    venue: 'Proceedings of the Fictional Conference on Aesthetics',
    doi: '10.1145/3544548.3581000',
    arxiv_id: '',
    url: 'https://doi.org/10.1145/3544548.3581000',
    abstract: 'We study beauty & usability.',
  });
  assert.match(externalCalls.at(-1).init.headers['User-Agent'], /AeCpt/);

  // Resolve: arXiv abs URL through the arXiv API.
  res = await call('/library/resolve', { method: 'POST', body: { identifier: 'https://arxiv.org/abs/2611.01234' } });
  resolved = await res.json();
  assert.equal(res.status, 200);
  assert.equal(resolved.pdfUrl, 'https://arxiv.org/pdf/2611.01234');
  assert.equal(resolved.metadata.title, 'Interfaces that feel right');
  assert.deepEqual(resolved.metadata.authors, ['Ada Zhang', 'Bo Chen']);
  assert.equal(resolved.metadata.year, 2026);
  assert.equal(resolved.metadata.arxiv_id, '2611.01234');
  assert.equal(resolved.metadata.doi, '10.1000/fictional.2026.1');
  assert.equal(resolved.metadata.url, 'https://arxiv.org/abs/2611.01234');
  assert.equal(resolved.metadata.abstract, 'We present a fictional study of aesthetic interfaces.');

  // Not found and network failures answer in Chinese.
  res = await call('/library/resolve', { method: 'POST', body: { identifier: '9999.99999' } });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error.detail, /arXiv 没有找到/);
  res = await call('/library/resolve', { method: 'POST', body: { identifier: '10.9999/missing' } });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error.detail, /Crossref 没有找到/);
  const savedFetch = library.network.fetch;
  library.network.fetch = async () => { throw new TypeError('fetch failed'); };
  res = await call('/library/resolve', { method: 'POST', body: { identifier: '10.1145/3544548.3581000' } });
  library.network.fetch = savedFetch;
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.detail, /无法连接 api\.crossref\.org/);
  res = await call('/library/resolve', { method: 'POST', body: { identifier: 'not an id' } });
  assert.equal(res.status, 400);

  // Submission with an uploaded PDF reaches the server as multipart.
  res = await call('/library/papers/', {
    method: 'POST',
    body: {
      metadata: { title: '  示例论文  ', authors: ['Hua Li', ''], year: '2026', venue: '', doi: '', tags: ['美学', '美学'], note: '推荐' },
      pdf: { name: '../示例.pdf', base64: PDF_BYTES.toString('base64') },
    },
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).status, 'pending');
  let sent = received.at(-1);
  assert.equal(sent.auth, 'Bearer library-token');
  assert.deepEqual(sent.form.metadata, { title: '示例论文', authors: ['Hua Li'], year: 2026, tags: ['美学'], note: '推荐' });
  assert.equal(sent.form.pdfName, '示例.pdf');
  assert.equal(sent.form.pdfType, 'application/pdf');
  assert.deepEqual(sent.form.pdfBytes, PDF_BYTES);

  // arXiv auto-download follows the redirect and uploads the PDF bytes.
  res = await call('/library/papers/', { method: 'POST', body: { metadata: { title: 'Interfaces that feel right', arxiv_id: '2611.01234' }, fetchArxivPdf: true } });
  assert.equal(res.status, 201);
  sent = received.at(-1);
  assert.equal(sent.form.pdfName, 'arXiv-2611.01234.pdf');
  assert.deepEqual(sent.form.pdfBytes, PDF_BYTES);
  res = await call('/library/papers/', { method: 'POST', body: { metadata: { title: 'Busy', arxiv_id: '2611.05555' }, fetchArxivPdf: true } });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.detail, /不是 PDF/);

  // Duplicates relay 409 with the existing paper; bad inputs stop at the Host.
  res = await call('/library/papers/', { method: 'POST', body: { metadata: { title: 'Dup', doi: '10.1000/dup' }, pdf: { name: 'd.pdf', base64: PDF_BYTES.toString('base64') } } });
  assert.equal(res.status, 409);
  const duplicate = await res.json();
  assert.equal(duplicate.error.code, 'paper_duplicate');
  assert.deepEqual(duplicate.error.existing, { id: 3, title: PAPER.title, status: 'approved' });
  const before = received.length;
  res = await call('/library/papers/', { method: 'POST', body: { metadata: { title: 'No PDF' } } });
  assert.equal(res.status, 400);
  res = await call('/library/papers/', { method: 'POST', body: { metadata: { title: 'Fake' }, pdf: { name: 'x.pdf', base64: Buffer.from('hello').toString('base64') } } });
  assert.equal((await res.json()).error.code, 'invalid_pdf');
  res = await call('/library/papers/', { method: 'POST', body: { metadata: { title: '' }, pdf: { name: 'x.pdf', base64: PDF_BYTES.toString('base64') } } });
  assert.equal((await res.json()).error.code, 'invalid_title');
  assert.equal(received.length, before);

  // PDF streaming keeps the upstream disposition; errors stay JSON.
  res = await fetch(base + '/library/papers/3/pdf', { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /filename\*=utf-8''/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF_BYTES);
  res = await fetch(base + '/library/papers/99/pdf', { headers });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.detail, '没有这篇论文');
  res = await fetch(base + '/library/papers/3/pdf', { headers: { 'X-Aecpt-Client': '1' } });
  assert.equal(res.status, 409);

  // JSON pass-through follows the allowlist; review endpoints stay closed.
  res = await call('/library/papers/?q=aesthetic&tag=%E7%BE%8E%E5%AD%A6');
  assert.equal(res.status, 200);
  assert.equal(received.at(-1).search, '?q=aesthetic&tag=%E7%BE%8E%E5%AD%A6');
  assert.equal((await call('/library/papers/3/', { method: 'DELETE' })).status, 204);
  assert.equal((await call('/library/submissions/')).status, 200);
  assert.equal((await call('/library/export/?ids=3')).status, 200);
  for (const [path, method] of [['/library/reviews/', 'GET'], ['/library/papers/3/review/', 'POST'], ['/library/papers/3/', 'PUT'],
    ['/library/export/', 'POST'], ['/library/papers/abc/', 'GET'], ['/library/other', 'GET']]) {
    const blocked = await call(path, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(blocked.status, 404, `${method} ${path}`);
  }

  // Agent tool: search, mine, download, export and DOI-without-PDF guidance.
  const tool = tools.get('aecpt_library');
  assert.ok(tool);
  assert.match(tool.description, /supervisor approves/);
  assert.ok(!tool.parameters.action.enum.includes('review'));
  let out = await tool.execute({ action: 'search', q: 'aesthetic' }, {});
  assert.match(out.text, /#3 Computational Aesthetics/);
  out = await tool.execute({ action: 'mine' }, {});
  assert.match(out.text, /未通过[\s\S]*请补充 PDF 全文/);
  out = await tool.execute({ action: 'download', id: 3 }, {});
  assert.equal(out.path, join(testHome, '.aecpt', 'library', store.storeKey(binding), '3-论文.pdf'));
  assert.deepEqual(readFileSync(out.path), PDF_BYTES);
  out = await tool.execute({ action: 'export', ids: '3', path: '~/refs/group' }, {});
  assert.ok(out.path.endsWith(join('refs', 'group.bib')));
  assert.match(readFileSync(out.path, 'utf8'), /@inproceedings/);
  await assert.rejects(tool.execute({ action: 'export', ids: '3', path: '/etc/aecpt.bib' }, {}), /主目录/);
  await assert.rejects(tool.execute({ action: 'export', ids: '3', path: '../outside.bib' }, {}), /主目录/);
  await assert.rejects(tool.execute({ action: 'submit', identifier: '10.1145/3544548.3581000' }, {}), /pdfPath/);
  const localPdf = join(testHome, 'paper.pdf');
  writeFileSync(localPdf, PDF_BYTES);
  out = await tool.execute({ action: 'submit', identifier: '10.1145/3544548.3581000', pdfPath: '~/paper.pdf', tags: '美学，界面', note: '推荐' }, {});
  assert.match(out.text, /等待导师审核/);
  assert.deepEqual(received.at(-1).form.metadata.tags, ['美学', '界面']);
  assert.equal(received.at(-1).form.metadata.doi, '10.1145/3544548.3581000');
  await assert.rejects(tool.execute({ action: 'submit', identifier: '10.1000/dup', pdfPath: localPdf }, {}), /库中已有：Computational/);

  // Shared-device cache wipe removes downloaded PDFs as well.
  store.forgetAccountCache(binding);
  assert.equal(existsSync(join(testHome, '.aecpt', 'library', store.storeKey(binding))), false);
});
