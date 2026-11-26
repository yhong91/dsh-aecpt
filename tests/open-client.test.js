import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'

const tmp = join(import.meta.dirname, '..', '.tmp')
mkdirSync(tmp, { recursive: true })
const testHome = mkdtempSync(join(tmp, 'open-client-'))
const mockHome = mock.method(os, 'homedir', () => testHome)
syncBuiltinESMExports()
const { apply } = await import('../index.js')
const { DEFAULT_SERVER_URL, parseServerInput, resolveServerBase } = await import('../binding.js')
const {
  FRAGMENT_SYSTEM_PROMPT,
  COMPILE_SYSTEM_PROMPT,
  loadCustomPrompts,
  buildCompilePrompt,
} = await import('../prompts.js')
mockHome.mock.restore()
syncBuiltinESMExports()

async function listen(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

test('server URL is never hardcoded and maps cleanly from supervisor invitation links', async t => {
  assert.equal(DEFAULT_SERVER_URL, '')

  const fromInvite = parseServerInput('https://aecpt.example.edu:8443/invitations/AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456/')
  assert.equal(fromInvite.serverUrl, 'https://aecpt.example.edu:8443')
  assert.equal(fromInvite.invitationUrl, 'https://aecpt.example.edu:8443/invitations/AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456/')

  const fromRegisterInvite = parseServerInput('http://10.0.0.5:8767/invitations/AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456/register/')
  assert.equal(fromRegisterInvite.serverUrl, 'http://10.0.0.5:8767')
  assert.equal(fromRegisterInvite.invitationUrl, 'http://10.0.0.5:8767/invitations/AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456/register/')

  const fromBareOrigin = parseServerInput('https://aecpt.example.edu/')
  assert.equal(fromBareOrigin.serverUrl, 'https://aecpt.example.edu')
  assert.equal(fromBareOrigin.invitationUrl, '')

  assert.throws(() => parseServerInput('ftp://aecpt.example.edu'), /HTTP\(S\)/)
  assert.throws(() => parseServerInput('https://user:pass@aecpt.example.edu'), /账号密码/)
  assert.throws(() => parseServerInput('not-a-url'), /邀请链接或服务器地址/)
  assert.throws(() => resolveServerBase('', '', undefined), /邀请链接或服务器地址/)

  // Fresh unbound Host without config.serverUrl requires an invitation link or server URL
  let route
  const tools = new Map()
  const disposers = []
  await apply({
    get(k) { return k === 'webServer' ? { register(r) { route = r; return () => {} } } : undefined },
    credentials: {
      async readRecord() { return null },
      async modifyRecord() {},
      async deleteRecord() {},
    },
    effect(fn) { disposers.push(fn()) },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }, {})
  t.after(() => { for (const d of disposers) d?.() })

  const proxy = await listen(route.handler)
  t.after(() => proxy.close())
  const base = `http://127.0.0.1:${proxy.address().port}/aecpt-api`
  const headers = { 'X-AeCpt-Client': '1', 'Content-Type': 'application/json' }

  // Empty start -> 400 server_url_required
  const missing = await fetch(`${base}/authorize/start`, { method: 'POST', headers, body: '{}' })
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error.code, 'server_url_required')

  // Start with supervisor invitation link -> extracts server origin and builds one-hop invitation URL
  const inviteLink = 'http://127.0.0.1:1/invitations/AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456/'
  const started = await fetch(`${base}/authorize/start`, {
    method: 'POST', headers, body: JSON.stringify({ serverUrl: inviteLink }),
  })
  assert.equal(started.status, 200)
  const startedBody = await started.json()
  assert.equal(startedBody.server_url, 'http://127.0.0.1:1')
  assert.equal(startedBody.has_invitation, true)
  const parsedAuth = new URL(startedBody.authorize_url)
  assert.equal(parsedAuth.pathname, '/invitations/AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456/')
  assert.ok((parsedAuth.searchParams.get('oauth_next') || '').startsWith('/oauth/authorize/?'))

  // Bare server URL goes straight to /oauth/authorize/
  const bareStarted = await fetch(`${base}/authorize/start`, {
    method: 'POST', headers, body: JSON.stringify({ serverUrl: 'http://127.0.0.1:1' }),
  })
  const bareBody = await bareStarted.json()
  assert.ok(bareBody.authorize_url.startsWith('http://127.0.0.1:1/oauth/authorize/?'))

  // Agent tool aecpt_authorize also accepts a supervisor invitation link directly
  const toolRes = await tools.get('aecpt_authorize').execute({ serverUrl: inviteLink }, {})
  assert.equal(toolRes.server_url, 'http://127.0.0.1:1')
  assert.ok(toolRes.authorize_url.includes('/invitations/AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456/?oauth_next='))
})

test('Scheme B PKCE polling auto-connects without manual code copy/paste', async t => {
  const sessions = new Map()
  let readyCode = ''
  const upstream = await listen(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/v1/auth/plugin-sessions/' && req.method === 'POST') {
      const { state } = JSON.parse(raw)
      const pollSecret = 'poll_secret_0123456789abcdef0123456789ab'
      sessions.set(state, { pollSecret })
      return json(201, { poll_secret: pollSecret, poll_interval_ms: 1500 })
    }
    if (url.pathname === '/api/v1/auth/plugin-sessions/poll/' && req.method === 'POST') {
      const { state, poll_secret } = JSON.parse(raw)
      const s = sessions.get(state)
      if (!s || s.pollSecret !== poll_secret) return json(200, { status: 'expired' })
      if (!readyCode) return json(200, { status: 'pending', poll_interval_ms: 1500 })
      const delivered = readyCode
      readyCode = ''
      sessions.delete(state)
      return json(200, { status: 'authorized', code: delivered })
    }
    if (url.pathname === '/oauth/token/' && req.method === 'POST') {
      assert.ok(raw.includes('code=auto_code_777'))
      return json(200, { access_token: 'oauth_tok_auto' })
    }
    if (url.pathname === '/api/v1/auth/tokens/exchange/' && req.method === 'POST') {
      return json(201, { id: 42, token: 'aec_auto_minted_token' })
    }
    if (url.pathname === '/api/v1/me/' && req.method === 'GET') {
      return json(200, {
        id: 101, username: 's_auto01', full_name: '自动授权学生',
        student_number: '2026888', is_student: true, server_instance: 'inst-auto-1',
      })
    }
    return json(404, { error: { code: 'not_found' } })
  })
  t.after(() => upstream.close())
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`

  const records = new Map()
  let route
  const disposers = []
  await apply({
    get(k) { return k === 'webServer' ? { register(r) { route = r; return () => {} } } : undefined },
    credentials: {
      async readRecord(k) { return records.get(k) ?? null },
      async modifyRecord(k, fn) { records.set(k, await fn(records.get(k))) },
      async deleteRecord(k) { records.delete(k) },
    },
    effect(fn) { disposers.push(fn()) },
    tools: { register() {} },
  }, {})
  t.after(() => { for (const d of disposers) d?.() })

  const proxy = await listen(route.handler)
  t.after(() => proxy.close())
  const base = `http://127.0.0.1:${proxy.address().port}/aecpt-api`
  const headers = { 'X-AeCpt-Client': '1', 'Content-Type': 'application/json' }

  const invite = `${upstreamOrigin}/invitations/AbCdEfGhIjKlMnOpQrStUvWxYz01234567890123456/`
  const startRes = await (await fetch(`${base}/authorize/start`, {
    method: 'POST', headers, body: JSON.stringify({ serverUrl: invite }),
  })).json()
  assert.equal(startRes.auto_poll, true)
  assert.equal(startRes.poll_interval_ms, 1500)

  // Before browser consent -> pending
  const p1 = await (await fetch(`${base}/authorize/poll`, {
    method: 'POST', headers, body: JSON.stringify({ state: startRes.state }),
  })).json()
  assert.equal(p1.status, 'pending')

  // Browser completes consent -> poll auto-exchanges and stores binding!
  readyCode = 'auto_code_777'
  const p2 = await (await fetch(`${base}/authorize/poll`, {
    method: 'POST', headers, body: JSON.stringify({ state: startRes.state }),
  })).json()
  assert.equal(p2.status, 'connected')
  assert.equal(p2.username, 's_auto01')
  assert.equal(records.get('dsh-aecpt/default')?.payload?.token, 'aec_auto_minted_token')
})

test('prompts.js handles custom overrides, multi-week compile span, and incremental fusion without reviving deleted text', () => {
  const overrideDir = join(testHome, '.aecpt', 'dsh')
  mkdirSync(overrideDir, { recursive: true })
  const overrideFile = join(overrideDir, 'prompts.json')

  // Default fallback when file does not exist
  const defaults = loadCustomPrompts(overrideFile)
  assert.equal(defaults.fragmentSystem, FRAGMENT_SYSTEM_PROMPT)
  assert.equal(defaults.compileSystem, COMPILE_SYSTEM_PROMPT)
  assert.equal(defaults.customized.fragment, false)

  // Valid override applies only non-empty keys
  writeFileSync(overrideFile, JSON.stringify({
    fragment_system: '自定义片段提示词',
    compile_system: '   ',
  }))
  const overridden = loadCustomPrompts(overrideFile)
  assert.equal(overridden.fragmentSystem, '自定义片段提示词')
  assert.equal(overridden.compileSystem, COMPILE_SYSTEM_PROMPT)
  assert.deepEqual(overridden.customized, { fragment: true, compile: false })

  // Malformed JSON safely falls back
  writeFileSync(overrideFile, '{invalid json')
  const fallback = loadCustomPrompts(overrideFile)
  assert.equal(fallback.fragmentSystem, FRAGMENT_SYSTEM_PROMPT)

  // Incremental fusion: ONLY passes existing body + uncompiled new fragments (never old compiled fragments)
  const records = [
    { id: 'old-1', session_id: 's1', created_at: '2026-11-01T08:00:00Z', summary: 'OLD_DELETED_TRIAL_NOISE' },
    { id: 'new-2', session_id: 'manual', created_at: '2026-11-15T09:00:00Z', summary: 'NEW_FINAL_METRIC_95' },
  ]
  const fusedPrompt = buildCompilePrompt({
    period: '26FA13W',
    existingContent: '# 26FA13W 科研进展\n- 保留手改内容',
    records,
    compiledIds: ['old-1'],
  })
  assert.match(fusedPrompt, /增量融合更新/)
  assert.match(fusedPrompt, /超过一周/)
  assert.match(fusedPrompt, /NEW_FINAL_METRIC_95/)
  assert.doesNotMatch(fusedPrompt, /OLD_DELETED_TRIAL_NOISE/)

  // Re-compile polish with no new fragments includes reference records
  const polishPrompt = buildCompilePrompt({
    period: '26FA13W',
    existingContent: '# 26FA13W 科研进展\n- 保留手改内容',
    records,
    compiledIds: ['old-1', 'new-2'],
  })
  assert.match(polishPrompt, /全量整理与润色/)
  assert.match(polishPrompt, /本周全部过程记录参考/)
})

test('Host proxy forwards /meta/ and new/upgraded student tools (aecpt_me, aecpt_plan, aecpt_report) work end-to-end', async t => {
  t.after(() => rmSync(testHome, { recursive: true, force: true }))

  let plans = [
    { id: 1, title: '完成基线复现', notes: '先跑 3 个 seed', due_date: '2026-11-28', done: false, project: { id: 10, name: '美学评分' } },
    { id: 2, title: '整理开题文献', notes: '', due_date: '2026-11-20', done: true, project: null },
  ]
  let report = {
    id: 88,
    author: { id: 9, username: 'demo_open_stu', full_name: '林同学' },
    period: '26FA13W',
    period_label: '26FA13W',
    project: null,
    status: 'draft',
    status_display: '草稿',
    revision: 1,
    submitted_at: null,
    created_at: '2026-11-25T00:00:00Z',
    updated_at: '2026-11-25T00:00:00Z',
    feedback_count: 0,
    content: '',
    feedback: [],
    summary_records: [],
    summary_count: 0,
  }

  const upstream = await listen((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      const send = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.url === '/api/v1/meta/' && req.method === 'GET') {
        return send({ api_version: '1', server_instance: 'inst-open', limits: { report_content_chars: 200000 } })
      }
      if (req.url === '/api/v1/me/' && req.method === 'GET') {
        return send({ id: 9, username: 'demo_open_stu', full_name: '林同学', student_number: 'U2026001', is_student: true, is_supervisor: false, server_instance: 'inst-open' })
      }
      if (req.url === '/api/v1/academic-periods/' && req.method === 'GET') {
        return send({ current: { period: '26FA13W', label: '26FA13W' }, weeks: [{ period: '26FA13W', label: '26FA13W' }] })
      }
      if (req.url === '/api/v1/projects/' && req.method === 'GET') {
        return send([{ id: 10, name: '美学评分', kind: '毕业论文', status: '进行中' }])
      }
      if (req.url === '/api/v1/plan-items/' && req.method === 'GET') {
        return send(plans)
      }
      if (req.url === '/api/v1/plan-items/' && req.method === 'POST') {
        const next = { id: 3, title: body.title, notes: body.notes || '', due_date: body.due_date ?? null, done: Boolean(body.done), project: body.project ? { id: body.project, name: '美学评分' } : null }
        plans.unshift(next)
        return send(next, 201)
      }
      if (req.url === '/api/v1/plan-items/3/' && req.method === 'PATCH') {
        const target = plans.find(p => p.id === 3)
        Object.assign(target, body)
        return send(target)
      }
      if (req.url === '/api/v1/reports/sync/' && req.method === 'POST') {
        return send({ tasks: [] })
      }
      if (req.url === '/api/v1/reports/' && req.method === 'POST') {
        report = { ...report, content: body.content || '', summary_records: body.summary_records || [], summary_count: (body.summary_records || []).length }
        return send(report, 201)
      }
      if (req.url === '/api/v1/reports/88/' && req.method === 'PATCH') {
        report = { ...report, revision: report.revision + 1, content: body.content ?? report.content, summary_records: body.summary_records ?? report.summary_records }
        return send(report)
      }
      if (req.url === '/api/v1/reports/88/' && req.method === 'GET') {
        return send(report)
      }
      return send({ error: { code: 'not_found' } }, 404)
    })
  })
  t.after(() => upstream.close())

  const serverUrl = `http://127.0.0.1:${upstream.address().port}`
  const records = new Map([
    ['dsh-aecpt/default', {
      kind: 'grant',
      payload: {
        token: '{{SECRET_open_client_token}}',
        serverUrl,
        username: 'demo_open_stu',
        userId: 9,
        fullName: '林同学',
        studentNumber: 'U2026001',
        serverInstance: 'inst-open',
        bindingId: 'open-b1',
      },
    }],
  ])

  let route
  const tools = new Map()
  const disposers = []
  await apply({
    get(k) { return k === 'webServer' ? { register(r) { route = r; return () => {} } } : undefined },
    credentials: {
      async readRecord(k) { return records.get(k) },
      async modifyRecord(k, fn) { records.set(k, await fn(records.get(k))) },
      async deleteRecord(k) { records.delete(k) },
    },
    effect(fn) { disposers.push(fn()) },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }, { serverUrl })
  t.after(() => { for (const d of disposers) d?.() })

  const proxy = await listen(route.handler)
  t.after(() => proxy.close())
  const base = `http://127.0.0.1:${proxy.address().port}/aecpt-api`
  const headers = { 'X-AeCpt-Client': '1', 'X-AeCpt-Binding': 'open-b1' }

  // 1. Host proxy forwards GET /meta/
  const metaRes = await fetch(`${base}/meta/`, { headers })
  assert.equal(metaRes.status, 200)
  const meta = await metaRes.json()
  assert.equal(meta.api_version, '1')
  assert.equal(meta.limits.report_content_chars, 200000)

  // 2. Enriched aecpt_me returns student_number, current_period, and projects
  const me = await tools.get('aecpt_me').execute({}, {})
  assert.equal(me.student_number, 'U2026001')
  assert.equal(me.current_period, '26FA13W')
  assert.equal(me.projects.length, 1)
  assert.equal(me.projects[0].name, '美学评分')

  // 3. New aecpt_plan tool: list, create, update, projects
  const planTool = tools.get('aecpt_plan')
  assert.ok(planTool)
  const openPlans = await planTool.execute({ action: 'list', done: 'open' }, {})
  assert.match(openPlans.text, /完成基线复现/)
  assert.doesNotMatch(openPlans.text, /整理开题文献/)

  const createdPlan = await planTool.execute({ action: 'create', title: '跑消融实验', due_date: '2026-11-30', project: 10 }, {})
  assert.match(createdPlan.text, /#3/)

  const updatedPlan = await planTool.execute({ action: 'update', id: 3, done: 'true', due_date: '' }, {})
  assert.match(updatedPlan.text, /已完成/)

  const projList = await planTool.execute({ action: 'projects' }, {})
  assert.match(projList.text, /美学评分/)

  // 4. Upgraded aecpt_report tool: periods, add_summary (auto period), summaries, and feedback removed
  const reportTool = tools.get('aecpt_report')
  assert.equal(reportTool.parameters.properties.action.enum.includes('feedback'), false)
  await assert.rejects(reportTool.execute({ action: 'feedback', id: 88, content: 'x' }, {}), /未知 action/)

  // 5. All registered tools must emit standard JSON Schema Draft 2020-12 object parameters
  assert.equal(tools.size, 8)
  const validTypes = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object', 'null'])
  const checkSchema = (schema, path) => {
    assert.equal(typeof schema, 'object', `${path}: schema must be an object`)
    assert.ok(schema && !Array.isArray(schema), `${path}: schema must be a plain object`)
    assert.ok(validTypes.has(schema.type), `${path}: invalid type ${JSON.stringify(schema.type)}`)
    assert.notEqual(typeof schema.required, 'boolean', `${path}: boolean required is shorthand, not JSON Schema`)
    if (schema.type === 'object') {
      assert.equal(typeof schema.properties, 'object', `${path}: object schema missing properties`)
      assert.ok(schema.properties && !Array.isArray(schema.properties), `${path}: properties must be a plain object`)
      if (schema.required !== undefined) {
        assert.ok(Array.isArray(schema.required), `${path}: required must be an array`)
        for (const req of schema.required) {
          assert.ok(Object.hasOwn(schema.properties, req), `${path}: required "${req}" missing from properties`)
        }
      }
      for (const [key, prop] of Object.entries(schema.properties)) checkSchema(prop, `${path}.properties.${key}`)
    }
    if (schema.type === 'array') {
      assert.ok(schema.items && typeof schema.items === 'object', `${path}: array schema missing items`)
      checkSchema(schema.items, `${path}.items`)
    }
  }
  const allowedRootKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'description'])
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.type, 'object', `${name}: root parameters.type must be "object"`)
    assert.equal(tool.parameters.additionalProperties, false, `${name}: root additionalProperties must be false`)
    for (const key of Object.keys(tool.parameters)) {
      assert.ok(allowedRootKeys.has(key), `${name}: unexpected root schema keyword "${key}"`)
    }
    checkSchema(tool.parameters, `${name}.parameters`)
  }
  assert.equal('title' in tools.get('aecpt_library').parameters, false)
  assert.equal(tools.get('aecpt_library').parameters.properties.title.type, 'string')
  assert.equal('title' in tools.get('aecpt_plan').parameters, false)
  assert.equal(tools.get('aecpt_plan').parameters.properties.title.type, 'string')

  const periods = await reportTool.execute({ action: 'periods' }, {})
  assert.equal(periods.periods.current.period, '26FA13W')

  const added = await reportTool.execute({ action: 'add_summary', content: '### 消融实验完成\n- PSNR 提升 1.2 dB' }, {})
  assert.match(added.record.summary, /PSNR 提升 1.2 dB/)

  const summaries = await reportTool.execute({ action: 'summaries', id: 88 }, {})
  assert.equal(summaries.summaries.length, 1)
  assert.match(summaries.summaries[0].summary, /消融实验完成/)
})
