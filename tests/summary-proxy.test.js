import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const tmp = join(import.meta.dirname, '..', '.tmp');
mkdirSync(tmp, { recursive: true });
const testHome = mkdtempSync(join(tmp, 'summary-proxy-'));
const mockHome = mock.method(os, 'homedir', () => testHome);
syncBuiltinESMExports();
const { apply } = await import('../index.js');
const { loadStore } = await import('../store.js');
mockHome.mock.restore();
syncBuiltinESMExports();

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('weekly fragments collect without cluttering content, sync on draft, compile/fuse/undo, and survive offline & legacy servers', async t => {
  t.after(() => rmSync(testHome, { recursive: true, force: true }));
  let current;
  let online = false;
  let supportsRecords = false;
  let loseSubmitResponse = false;
  const submitted = [];
  const upstream = await listen((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!online) return req.socket.destroy();
      const data = JSON.parse(body || '{}');
      const send = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/api/v1/academic-periods/') {
        return send({ current: { period: '26FA13W', label: '26FA13W' }, weeks: [{ period: '26FA13W', label: '26FA13W' }] });
      }
      if (req.url === '/api/v1/reports/sync/') return send({ tasks: [] });
      if (req.url === '/api/v1/reports/' && req.method === 'POST') {
        if (current) return send({ error: { code: 'period_exists', snapshot: current } }, 409);
        current = {
          id: 501, author: { id: 9, username: 'demo_summary', full_name: '总结测试' },
          period: '26FA13W', period_label: '26FA13W', project: null, status: 'draft',
          status_display: '草稿', revision: 1, submitted_at: null,
          created_at: '2026-11-24T00:00:00Z', updated_at: '2026-11-24T00:00:00Z',
          feedback_count: 0, content: data.content, feedback: [],
          ...(supportsRecords ? { summary_records: data.summary_records ?? [], summary_count: (data.summary_records ?? []).length } : {}),
        };
        // First create simulates lost response so recovery path is verified.
        online = false;
        return req.socket.destroy();
      }
      if (req.url === '/api/v1/reports/501/' && req.method === 'PATCH') {
        assert.equal(data.revision, current.revision);
        current = {
          ...current,
          revision: current.revision + 1,
          content: data.content,
          ...(supportsRecords && data.summary_records !== undefined
            ? { summary_records: data.summary_records, summary_count: data.summary_records.length }
            : {}),
        };
        return send(current);
      }
      if (req.url === '/api/v1/reports/501/' && req.method === 'GET') {
        return send(supportsRecords ? { summary_records: [], ...current } : current);
      }
      if (req.url === '/api/v1/reports/501/submit/' && req.method === 'POST') {
        submitted.push(data);
        assert.equal(supportsRecords, true);
        if (current.status === 'draft') {
          assert.equal(data.revision, current.revision);
          current = {
            ...current,
            status: 'submitted',
            submitted_at: '2026-11-24T12:00:00Z',
            revision: current.revision + 1,
            summary_records: data.summary_records ?? current.summary_records ?? [],
          };
        }
        if (loseSubmitResponse) return req.socket.destroy();
        return send(current);
      }
      return send({}, 404);
    });
  });
  t.after(() => upstream.close());

  const sessionId = `session-summary-${process.pid}`;
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '完成了实验设计' }] } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '下一步整理数据' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1 } },
  ];
  const session = {
    id: sessionId,
    header: { cwd: '/tmp/project-alpha' },
    seq: 4,
    requestContext: () => ({ provider: 'test-provider', model: 'test-model' }),
    snapshotEvents: (from, to) => events.filter(event => event.seq >= from && event.seq < to),
  };
  let lastPrompt = '';
  let lastPurpose = '';
  let lastModel = '';
  let compileCount = 0;
  const llm = {
    listProviders: () => [{ id: 'test-provider', name: 'Test Provider' }],
    listModels: async () => [{ id: 'test-model', name: 'Test Model' }, { id: 'fixed-model', name: 'Fixed Model' }],
    resolveModelInfo: async (_provider, model) => ({ provider: 'test-provider', id: model, name: model }),
    async *stream(options) {
      assert.equal(options.provider, 'test-provider');
      lastModel = options.model;
      lastPurpose = options.purpose;
      lastPrompt = options.messages[0].content[0].text;
      if (options.purpose === 'aecpt-weekly-report-compile') {
        compileCount += 1;
        const text = compileCount === 1
          ? '# 26FA13W 科研进展\n\n## 本周核心进展\n\n- 完成实验设计与新增实验分析'
          : '# 26FA13W 科研进展\n\n## 本周核心进展\n\n- 完成实验设计与新增实验分析\n- 融合线下消融结果';
        yield { type: 'text-delta', text };
      } else {
        yield { type: 'text-delta', text: '### 实验设计进展\n- 完成实验设计\n- 下一步整理数据' };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const binding = { token: 'summary-token', username: 'demo_summary', serverUrl: `http://127.0.0.1:${upstream.address().port}` };
  const records = new Map([['dsh-aecpt/default', { payload: binding }]]);
  let route;
  let reportTool;
  const disposers = [];
  await apply({
    credentials: {
      async readRecord(key) { return records.get(key); },
      async deleteRecord(key) { records.delete(key); },
    },
    get(name) {
      if (name === 'webServer') return { register(r) { route = r; } };
      if (name === 'sessions') return { get: id => id === sessionId ? session : undefined };
      if (name === 'sessionController') return {
        modelCatalog: async () => ({ groups: [{ id: 'test-provider', name: 'Test Provider', models: [{ id: 'test-model', name: 'Test Model' }, { id: 'fixed-model', name: 'Fixed Model' }] }] }),
      };
      if (name === 'llm') return llm;
      return undefined;
    },
    effect(fn) { disposers.push(fn()); },
    tools: { register(tool) { if (tool.name === 'aecpt_report') reportTool = tool; } },
  }, {});
  t.after(() => { for (const dispose of disposers) dispose?.(); });
  const proxy = await listen(route.handler);
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.address().port}/aecpt-api`;
  const { bindingId } = await (await fetch(base + '/status', { headers: { 'X-Aecpt-Client': '1' } })).json();
  const call = (url, init = {}) => fetch(url, {
    ...init, headers: { 'X-Aecpt-Client': '1', 'X-Aecpt-Binding': bindingId, ...init.headers },
  });

  await call(base + '/summary-model', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'session' }),
  });

  // 1. Offline conversation summarize -> creates draft with empty content and 1 fragment
  const response = await call(base + '/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, period: '26FA13W' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.report.id, /^local-/);
  assert.equal(result.report.content, '');
  const firstRecord = result.report.summary_records[0];
  assert.equal(firstRecord.session_id, sessionId);
  assert.equal(firstRecord.summary, result.summary);
  assert.equal(firstRecord.model, 'test-model');
  assert.deepEqual([firstRecord.from_seq, firstRecord.to_seq], [0, 4]);
  assert.match(lastPrompt, /完成了实验设计/);

  // Duplicate summarize with no new turns returns 409
  const again = await call(base + '/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, period: '26FA13W' }),
  });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'no_new_messages');

  // 2. Reconnect to legacy server (supportsRecords=false), recover lost create response
  const localDetailUrl = base + '/reports/' + result.report.id + '/';
  online = true;
  const lostCreate = await (await call(localDetailUrl)).json();
  assert.equal(lostCreate.id, result.report.id);
  assert.equal(current.id, 501);
  online = true;
  const remapped = await (await call(localDetailUrl)).json();
  assert.equal(remapped.id, 501);
  assert.deepEqual(remapped.summary_records, [firstRecord]);
  assert.equal(remapped.content, '');
  assert.equal(loadStore(binding).reports[result.report.id], undefined);

  // 3. Second summarize with fixed model -> appends to summary_records, content stays clean (empty)
  events.push(
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'user/message', data: { content: [{ type: 'text', text: '新增实验结果' }] } },
    { seq: 7, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '补充分析' }] } } },
    { seq: 8, type: 'turn/end', data: { turn: 2 } },
  );
  session.seq = 8;
  await call(base + '/summary-model', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'fixed', provider: 'test-provider', model: 'fixed-model' }),
  });
  const third = await call(base + '/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, period: '26FA13W' }),
  });
  assert.equal(third.status, 200);
  const thirdResult = await third.json();
  assert.equal(thirdResult.report.content, '');
  assert.equal(thirdResult.report.summary_records.length, 2);
  assert.equal(lastModel, 'fixed-model');

  // 4. Legacy server refuses submit when summary_records not supported
  const submitUrl = base + '/reports/501/submit/';
  const legacy = await call(submitUrl, { method: 'POST' });
  assert.equal(legacy.status, 409);
  assert.equal((await legacy.json()).error.code, 'summary_records_unsupported');

  // 5. Upgrade server (supportsRecords=true): add manual fragment, delete one, compile, fuse, undo
  supportsRecords = true;
  const manualRes = await call(base + '/reports/summaries/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: '26FA13W', summary: '### 线下消融\n- FID 下降至 15.2' }),
  });
  assert.equal(manualRes.status, 200);
  const manualData = await manualRes.json();
  assert.equal(manualData.report.summary_records.length, 3);
  assert.equal(current.summary_records.length, 3); // Draft summary_records synced to server!

  // Remove the manual fragment, verify synced
  const removedRes = await call(base + `/reports/501/summaries/${manualData.record.id}/`, { method: 'DELETE' });
  assert.equal(removedRes.status, 200);
  const afterRemove = await removedRes.json();
  assert.equal(afterRemove.summary_records.length, 2);
  assert.equal(current.summary_records.length, 2);

  // Fresh one-click compile (without active sessionId, simulating sidebar main panel)
  const compiledRes = await call(base + '/reports/501/compile/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(compiledRes.status, 200);
  const compiled = await compiledRes.json();
  assert.equal(compiled.fused, false);
  assert.equal(lastPurpose, 'aecpt-weekly-report-compile');
  assert.match(compiled.report.content, /本周核心进展/);
  assert.equal(compiled.report.can_undo_compile, true);
  assert.equal(compiled.report.uncompiled_count, 0);

  // Add a new manual fragment -> uncompiled_count becomes 1
  const manual2 = await (await call(base + '/reports/summaries/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: '26FA13W', summary: '### 新增消融\n- 补充推理耗时测试' }),
  })).json();
  assert.equal(manual2.report.uncompiled_count, 1);

  // Second compile -> fusion mode (includes existing content + new fragment)
  const fusedRes = await call(base + '/reports/501/compile/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(fusedRes.status, 200);
  const fused = await fusedRes.json();
  assert.equal(fused.fused, true);
  assert.match(lastPrompt, /当前已有周报正文/);
  assert.match(lastPrompt, /尚未融入的新增片段/);
  assert.match(lastPrompt, /补充推理耗时测试/);
  assert.match(fused.report.content, /融合线下消融结果/);
  assert.equal(fused.report.uncompiled_count, 0);
  assert.equal(fused.report.can_undo_compile, true);

  // Undo compile -> restores exact pre-fusion body and uncompiled_count=1
  const undoneRes = await call(base + '/reports/501/undo-compile/', { method: 'POST', body: '{}' });
  assert.equal(undoneRes.status, 200);
  const undone = await undoneRes.json();
  assert.equal(undone.content, compiled.report.content);
  assert.equal(undone.can_undo_compile, false);
  assert.equal(undone.uncompiled_count, 1);

  // Manual edit succeeds and preserves all 3 fragments
  const edited = await call(base + '/reports/501/', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '学生审阅后的最终完整周报' }),
  });
  assert.equal(edited.status, 200);
  const editedData = await edited.json();
  assert.equal(editedData.summary_records.length, 3);
  assert.equal(editedData.can_undo_compile, false);

  // 6. Submit survives lost response and keeps all 3 fragments
  loseSubmitResponse = true;
  const disconnected = await call(submitUrl, { method: 'POST' });
  assert.equal(disconnected.status, 503);
  assert.equal(current.summary_records.length, 3);

  loseSubmitResponse = false;
  const retry = await reportTool.execute({ action: 'submit', id: 501 }, {});
  assert.equal(retry.report.status, 'submitted');
  assert.equal(retry.report.content, '学生审阅后的最终完整周报');
  const detail = await (await call(base + '/reports/501/')).json();
  assert.equal(detail.summary_records.length, 3);
  assert.equal(detail.summary_records_pending, 0);
});

test('session summary handles multi-week spans, incremental previous context, overlong transcripts and checkpoint rollback on delete', async t => {
  const home2 = mkdtempSync(join(tmp, 'summary-session-prompt-'));
  t.after(() => rmSync(home2, { recursive: true, force: true }));

  let report = null;
  const upstream = await listen((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      const send = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/api/v1/academic-periods/') {
        return send({ current: { period: '26FA13W', label: '26FA13W' }, weeks: [{ period: '26FA13W', label: '26FA13W' }] });
      }
      if (req.url === '/api/v1/reports/sync/') return send({ tasks: [] });
      if (req.url === '/api/v1/reports/' && req.method === 'POST') {
        report = {
          id: 601, author: { id: 10, username: 'demo_span', full_name: '跨周测试' },
          period: data.period, period_label: data.period, project: null, status: 'draft',
          status_display: '草稿', revision: 1, submitted_at: null,
          created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:00:00Z',
          feedback_count: 0, content: data.content,
          summary_records: data.summary_records ?? [], summary_count: (data.summary_records ?? []).length,
          feedback: [],
        };
        return send(report, 201);
      }
      if (req.url === '/api/v1/reports/601/' && req.method === 'PATCH') {
        report = {
          ...report,
          revision: report.revision + 1,
          content: data.content,
          summary_records: data.summary_records ?? report.summary_records,
          summary_count: (data.summary_records ?? report.summary_records).length,
        };
        return send(report);
      }
      if (req.url === '/api/v1/reports/601/' && req.method === 'GET') return send(report);
      return send({}, 404);
    });
  });
  t.after(() => upstream.close());

  const sessionId = `session-multiweek-${process.pid}`;
  const t1 = Date.parse('2026-11-10T02:00:00Z'); // 2026-11-10 10:00 +08
  const t2 = Date.parse('2026-11-22T06:30:00Z'); // 2026-11-22 14:30 +08 (13-day span!)
  const events = [
    { seq: 1, type: 'turn/start', time: t1, data: { turn: 1 } },
    { seq: 2, type: 'user/message', time: t1, data: { content: [{ type: 'text', text: '11月10日启动基线实验，SRCC 只有 0.65' }] } },
    { seq: 3, type: 'assistant/message', time: t2, data: { message: { content: [{ type: 'text', text: '11月22日完成改版，SRCC 升至 0.72' }] } } },
    { seq: 4, type: 'turn/end', time: t2, data: { turn: 1 } },
  ];
  const session = {
    id: sessionId,
    header: { cwd: '/tmp/project-alpha' },
    seq: 4,
    requestContext: () => ({ provider: 'test-provider', model: 'test-model' }),
    snapshotEvents: (from, to) => events.filter(event => event.seq >= from && event.seq < to),
  };

  const prompts = [];
  const systems = [];
  let replyText = '### 跨周基线迭代至 SRCC 0.72\n- [11-10] 初始基线 SRCC 0.65\n- [11-22] 改版后提升至 0.72';
  const llm = {
    async *stream(options) {
      prompts.push(options.messages[0].content[0].text);
      systems.push(options.system);
      yield { type: 'text-delta', text: replyText };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const binding = { token: 'span-token', username: 'demo_span', serverUrl: `http://127.0.0.1:${upstream.address().port}` };
  const records = new Map([['dsh-aecpt/default', { payload: binding }]]);
  let route;
  const disposers = [];
  await apply({
    credentials: {
      async readRecord(key) { return records.get(key); },
      async deleteRecord(key) { records.delete(key); },
    },
    get(name) {
      if (name === 'webServer') return { register(r) { route = r; } };
      if (name === 'sessions') return { get: id => id === sessionId ? session : undefined };
      if (name === 'llm') return llm;
      return undefined;
    },
    effect(fn) { disposers.push(fn()); },
    tools: { register() {} },
  }, {});
  t.after(() => { for (const dispose of disposers) dispose?.(); });
  const proxy = await listen(route.handler);
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.address().port}/aecpt-api`;
  const { bindingId } = await (await fetch(base + '/status', { headers: { 'X-Aecpt-Client': '1' } })).json();
  const call = (url, init = {}) => fetch(url, {
    ...init, headers: { 'X-Aecpt-Client': '1', 'X-Aecpt-Binding': bindingId, ...init.headers },
  });

  // 1. Multi-week (>7 days) session summary auto-resolves current teaching week when period is omitted
  const first = await (await call(base + '/summarize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })).json();
  assert.equal(first.report.period, '26FA13W');
  assert.equal(first.report.summary_records.length, 1);
  assert.match(prompts[0], /对话时间跨度：2026-11-10 至 2026-11-22（共 13 天，跨越多周/);
  assert.match(prompts[0], /用户 \[2026-11-10 10:00\]/);
  assert.match(prompts[0], /助手 \[2026-11-22 14:30\]/);
  assert.match(systems[0], /已修正/);

  // 2. Follow-up turns in the same session: default (omitting referenceIds) includes previous session fragments + 承接前序
  const t3 = Date.parse('2026-11-25T01:00:00Z');
  events.push(
    { seq: 5, type: 'turn/start', time: t3, data: { turn: 2 } },
    { seq: 6, type: 'user/message', time: t3, data: { content: [{ type: 'text', text: '发现数据泄漏，修正后 SRCC 为 0.705' }] } },
    { seq: 7, type: 'turn/end', time: t3, data: { turn: 2 } },
  );
  session.seq = 7;
  // Check /summarize/context reports newMessageCount and sessionFragments
  const ctxInfo = await (await call(base + `/summarize/context?sessionId=${encodeURIComponent(sessionId)}`)).json();
  assert.equal(ctxInfo.sessionFound, true);
  assert.equal(ctxInfo.newMessageCount, 1);
  assert.equal(ctxInfo.targetPeriod, '26FA13W');
  assert.equal(ctxInfo.workspaceName, 'project-alpha');
  assert.equal(ctxInfo.fragments.length, 1);
  assert.equal(ctxInfo.fragments[0].relation, 'session');
  assert.equal(ctxInfo.sessionFragments.length, 1);
  assert.equal(ctxInfo.workspaceFragments.length, 0);

  replyText = '### 修正数据泄漏后的真实指标\n> 承接前序：此前基线改版至 SRCC 0.72。\n- 已修正：去除验证集重复样本后 SRCC 为 0.705';
  const second = await (await call(base + '/summarize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, period: '26FA13W' }),
  })).json();
  assert.equal(second.report.summary_records.length, 2);
  assert.equal(second.reference_count, 1);
  assert.match(prompts[1], /【参考的过往进展与问题（共 1 条；请结合它们用 1 句「> 承接前序：…」铺垫前期进展与遗留问题/);
  assert.match(prompts[1], /本会话前序 · 归属 26FA13W/);
  assert.match(prompts[1], /跨周基线迭代至 SRCC 0\.72/);
  assert.match(prompts[1], /【本次新增对话（第 2–2 轮）】/);

  // 3. Deleting the latest fragment rolls back the checkpoint; re-summarize with referenceIds: [] skips prior context!
  const secondId = second.report.summary_records[1].id;
  const delRes = await call(base + `/reports/601/summaries/${secondId}/`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  const standalone = await (await call(base + '/summarize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, period: '26FA13W', referenceIds: [] }),
  })).json();
  assert.equal(standalone.reference_count, 0);
  assert.match(prompts[2], /发现数据泄漏/);
  assert.doesNotMatch(prompts[2], /参考的过往进展与问题/);

  // 4. Add a workspace manual fragment and explicitly pick BOTH a session fragment and the workspace fragment via referenceIds
  const manual = await (await call(base + '/reports/summaries/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: '26FA13W', summary: '### 线下讨论待办\n- 需补充 Q-Align 同口径对比' }),
  })).json();
  const ctxWithWorkspace = await (await call(base + `/summarize/context?sessionId=${encodeURIComponent(sessionId)}`)).json();
  assert.equal(ctxWithWorkspace.sessionFragments.length, 2);
  assert.equal(ctxWithWorkspace.workspaceFragments.length, 1);

  // Overlong incremental conversation (>60,000 chars) + explicit mixed referenceIds
  let seq = 8;
  events.push({ seq: seq++, type: 'turn/start', time: t3 + 60_000, data: { turn: 3 } });
  events.push({ seq: seq++, type: 'user/message', time: t3 + 60_000, data: { content: [{ type: 'text', text: 'OPENING_GOAL_MARKER: 对比三组超参' }] } });
  for (let i = 0; i < 15; i += 1) {
    events.push({ seq: seq++, type: 'assistant/message', time: t3 + 60_000, data: { message: { content: [{ type: 'text', text: `MIDDLE_CHUNK_${i}_` + 'X'.repeat(5000) }] } } });
  }
  events.push({ seq: seq++, type: 'assistant/message', time: t3 + 120_000, data: { message: { content: [{ type: 'text', text: 'FINAL_RESULT_MARKER: 选定 lr=3e-5' }] } } });
  events.push({ seq: seq++, type: 'turn/end', time: t3 + 120_000, data: { turn: 3 } });
  session.seq = seq - 1;
  const overlong = await (await call(base + '/summarize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      period: '26FA13W',
      referenceIds: [first.report.summary_records[0].id, manual.record.id],
    }),
  })).json();
  assert.equal(overlong.reference_count, 2);
  assert.match(prompts[3], /【参考的过往进展与问题（共 2 条/);
  assert.match(prompts[3], /本会话前序/);
  assert.match(prompts[3], /工作区手动补记/);
  assert.match(prompts[3], /篇幅提示：本段对话较长/);
  assert.match(prompts[3], /OPENING_GOAL_MARKER/);
  assert.match(prompts[3], /中间省略 \d+ 条较早消息/);
  assert.match(prompts[3], /FINAL_RESULT_MARKER/);
});
