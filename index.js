/**
 * dsh-aecpt Host half: binds this DSH to the aecpt workbench server
 * and exposes the learning/research progress loop as agent tools. The bearer token lives
 * in the DSH credential store (record dsh-aecpt/default), never in
 * configuration, tool output, or chat text. Staging: fictional data only.
 *
 * Local-directory bundle: no bare package imports (they would not resolve
 * from the linked checkout); tool definitions are plain objects and the
 * credential record key is the plain `<owner>/<id>` string.
 * @module dsh-aecpt
 */

export const name = 'dsh-aecpt'
export const inject = ['tools', 'credentials']

import { randomBytes, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  syncNow, loadStore, listPayloads, createDraft, editDraft, reportDetail,
  resolveConflict, exportMarkdown, exportToFile, serverFetch, submitReport,
  loadSummaryCheckpoint, listAccountSummaryFragments, findSummaryRecordsByIds,
  sessionSummaries, rememberCurrentPeriod, fallbackCurrentPeriod,
  saveReportSummary, addManualSummary, removeReportSummary,
  saveCompiledReport, undoCompiledReport, loadSummaryModelSetting, saveSummaryModelSetting,
  lastAccount, localWorkSummary, forgetAccountCache,
} from './store.js'
import {
  FeedError, listFeeds, addSource, removeSource, refreshFeeds, markRead,
} from './feeds.js'
import {
  PAPER_STATUS, SUBMIT_BODY_LIMIT, resolveIdentifier, prepareSubmission, submitPaper, streamPaperPdf,
  submissionMetadata, downloadArxivPdf, readLocalPdf, downloadPaperPdf, writeBibFile, paperLine, paperDetail,
} from './library.js'
import {
  DEFAULT_SERVER_URL, ProxyError, normalizeBase, parseServerInput, resolveServerBase,
  parseBody, apiError,
  pkcePair, authorizeUrl, buildEntryAuthUrl, createAuthSession, pollAuthSession,
  exchangeAndMint, fetchProfile, revokeToken,
  bindingFromPayload, sameAccount, describeAccount, readBinding,
  deleteBindingRecords, changeBinding, previousAccount, commitBinding, commitFromTool,
  upgradeLegacyBinding,
} from './binding.js'
import {
  fmtUtc8Date, fmtUtc8Time, loadCustomPrompts, buildFragmentPrompt, buildCompilePrompt,
} from './prompts.js'

const BODY_LIMIT = 256 * 1024
const AUTH_TTL = 10 * 60 * 1000
const MAX_PENDING_AUTH = 16

/** Pending browser authorizations: state -> { verifier, base, createdAt, inFlight, staged }. */
const pendingAuth = new Map()

function prunePending() {
  const cutoff = Date.now() - AUTH_TTL
  for (const [key, value] of pendingAuth) {
    if (value.createdAt < cutoff) {
      if (value.staged) void revokeToken(value.base, value.staged.minted.token)
      pendingAuth.delete(key)
    }
  }
}

async function startPending(base, { invitationUrl = '' } = {}) {
  prunePending()
  if (pendingAuth.size >= MAX_PENDING_AUTH) {
    throw new ProxyError(429, 'too_many_auth_attempts', '待完成的授权过多，请稍后再试')
  }
  const state = randomBytes(24).toString('base64url')
  const { verifier, challenge } = pkcePair()
  const session = await createAuthSession(base, state)
  const pollSecret = session?.pollSecret || ''
  const pollIntervalMs = session?.pollIntervalMs || 2000
  pendingAuth.set(state, {
    verifier,
    base,
    pollSecret,
    pollIntervalMs,
    createdAt: Date.now(),
    inFlight: false,
    staged: null,
  })
  return {
    authorize_url: buildEntryAuthUrl(base, state, challenge, invitationUrl),
    state,
    auto_poll: Boolean(pollSecret),
    poll_interval_ms: pollIntervalMs,
  }
}

async function finalizePendingAuthorization(ctx, config, stateKey, entry, code) {
  const minted = await exchangeAndMint(entry.base, code, entry.verifier)
  const incoming = { ...(await fetchProfile(entry.base, minted.token)), serverUrl: entry.base }
  const previous = await previousAccount(ctx, config)
  if (previous && !sameAccount(previous, incoming)) {
    // Hold the new token until the user explicitly keeps or discards it.
    entry.staged = { minted, profile: incoming, previous }
    throw new ProxyError(409, 'account_mismatch', '授权的账号与本机缓存的账号不同', {
      previous: describeAccount(previous),
      incoming: describeAccount(incoming),
    })
  }
  const result = await commitBinding(ctx, entry.base, minted, incoming)
  pendingAuth.delete(stateKey)
  clearPending()
  return result
}

function clearPending() {
  for (const value of pendingAuth.values()) {
    if (value.staged) void revokeToken(value.base, value.staged.minted.token)
  }
  pendingAuth.clear()
}

async function readRequestBody(req, limit = BODY_LIMIT, tooLarge = '请求内容过大') {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > limit) throw new ProxyError(413, 'body_too_large', tooLarge)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonBody(req, limit = BODY_LIMIT, tooLarge = undefined) {
  const text = await readRequestBody(req, limit, tooLarge)
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    // Report malformed input without echoing it.
  }
  throw new ProxyError(400, 'invalid_body', '请求内容格式不正确')
}

function textOfBlocks(content) {
  return (content || [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function eventEpochMs(event) {
  const raw = event?.time ?? event?.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function transcriptEvents(events) {
  const rows = []
  let firstTime = null
  let lastTime = null
  let lastDate = ''
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const message = event.type === 'user/message' ? event.data : event.data?.message
    const text = textOfBlocks(message?.content)
    if (!text) continue
    const role = event.type === 'user/message' ? '用户' : '助手'
    const ms = eventEpochMs(event)
    let stamp = ''
    if (ms !== null) {
      if (firstTime === null || ms < firstTime) firstTime = ms
      if (lastTime === null || ms > lastTime) lastTime = ms
      const dateStr = fmtUtc8Date(ms)
      const timeStr = fmtUtc8Time(ms)
      stamp = dateStr !== lastDate ? ` [${dateStr} ${timeStr}]` : ` [${timeStr}]`
      lastDate = dateStr
    }
    rows.push(`${role}${stamp}：\n${text}`)
  }
  return { rows, firstTime, lastTime }
}

/** Bound long transcripts on whole-message boundaries, preserving opening goal
 * context plus as much of the latest discussion as fits within `maxChars`. */
function formatBoundedTranscript(rows, maxChars = 60000) {
  const joined = rows.join('\n\n')
  if (joined.length <= maxChars) {
    return { text: joined, truncated: false, omittedCount: 0 }
  }
  const headBudget = Math.min(8000, Math.floor(maxChars * 0.15))
  const head = []
  let headLen = 0
  let headIdx = 0
  while (headIdx < rows.length && headLen + rows[headIdx].length + 2 <= headBudget) {
    head.push(rows[headIdx])
    headLen += rows[headIdx].length + 2
    headIdx += 1
  }
  const tailBudget = maxChars - headLen - 120
  const tail = []
  let tailLen = 0
  let tailIdx = rows.length - 1
  while (tailIdx >= headIdx && tailLen + rows[tailIdx].length + 2 <= tailBudget) {
    tail.unshift(rows[tailIdx])
    tailLen += rows[tailIdx].length + 2
    tailIdx -= 1
  }
  // If even the single last message exceeds budget, keep its tail cleanly.
  if (!tail.length && rows.length) {
    tail.push(rows[rows.length - 1].slice(-Math.max(1000, tailBudget)))
    tailIdx = rows.length - 2
  }
  const omittedCount = Math.max(0, tailIdx - headIdx + 1)
  const parts = []
  if (head.length) parts.push(head.join('\n\n'))
  if (omittedCount > 0) parts.push(`……（中间省略 ${omittedCount} 条较早消息，以保留开题背景与最新进展结论）……`)
  parts.push(tail.join('\n\n'))
  return { text: parts.join('\n\n'), truncated: true, omittedCount }
}

function latestTurn(events) {
  let turn = 0
  for (const event of events) {
    if (event.type === 'turn/start') turn = Math.max(turn, Number(event.data?.turn) || 0)
  }
  return turn
}

async function listSummaryModels(ctx) {
  const controller = ctx.get('sessionController')
  if (controller?.modelCatalog) {
    const catalog = await controller.modelCatalog()
    return (catalog?.groups || []).map(group => ({
      provider: group.id,
      name: group.name || group.id,
      models: (group.models || []).map(model => ({ id: model.id, name: model.name || model.id })),
    }))
  }
  const llm = ctx.get('llm')
  if (!llm?.listProviders || !llm?.listModels) return []
  const providers = await llm.listProviders()
  const options = []
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id)
      if (models?.length) {
        options.push({
          provider: provider.id,
          name: provider.name || provider.id,
          models: models.map(model => ({ id: model.id, name: model.name || model.id })),
        })
      }
    } catch {
      // Isolate one provider's catalog failure.
    }
  }
  return options
}

async function callSelectedModel(ctx, session, prompt, signal, setting, {
  system = loadCustomPrompts().fragmentSystem,
  maxTokens = 1800,
  purpose = 'aecpt-progress-summary',
} = {}) {
  const llm = ctx.get('llm')
  if (!llm?.stream) throw new Error('当前 DSH 没有可用的模型服务')
  let selection = setting?.mode === 'fixed' && setting.provider && setting.model
    ? { provider: setting.provider, model: setting.model }
    : undefined
  if (!selection && session) {
    const requestContext = typeof session.requestContext === 'function' ? session.requestContext() : undefined
    selection = requestContext?.provider && requestContext?.model ? requestContext : undefined
  }
  if (!selection) selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (!selection) {
    const catalog = await listSummaryModels(ctx).catch(() => [])
    const firstGroup = catalog.find(group => group.models?.length)
    if (firstGroup) selection = { provider: firstGroup.provider, model: firstGroup.models[0].id }
  }
  if (!selection?.provider || !selection?.model) {
    throw new Error('当前没有选定模型，请在工作台「设置 → AI 总结模型」中选择模型')
  }
  let text = ''
  let failure = null
  const request = {
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    system,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    }],
    maxTokens,
    temperature: 0.2,
    purpose,
    signal,
  }
  if (session?.id) request.sessionId = session.id
  for await (const chunk of llm.stream(request)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop') {
      failure = chunk.reason?.kind === 'error'
        ? chunk.reason.failure?.message || '模型调用失败'
        : chunk.reason?.kind || '模型调用未正常结束'
    }
  }
  if (failure) throw new Error(failure)
  const trimmed = text.trim()
  if (!trimmed) throw new Error('模型没有返回可用的进展内容')
  return { text: trimmed, provider: selection.provider, model: selection.model }
}

async function resolveAutoPeriod(binding) {
  try {
    const res = await serverFetch(binding, '/academic-periods/', { signal: AbortSignal.timeout(5000) })
    if (res.ok && res.data) {
      const current = res.data.current || res.data.weeks?.[0]
      if (current?.period) {
        const info = { period: current.period, label: current.label || current.period }
        rememberCurrentPeriod(binding, info)
        return info
      }
    }
  } catch {
    // Offline or older server: fall back to cached period.
  }
  return fallbackCurrentPeriod(binding)
}

function sessionCwd(session) {
  return String(session?.header?.cwd || session?.cwd || '').trim()
}

/** API paths the panel may reach through the generic forwarder. */
function forwardAllowed(method, sub) {
  if (method === 'GET' && (sub === '/me/' || sub === '/meta/' || sub === '/academic-periods/' || sub === '/projects/')) return true
  if (sub === '/plan-items/') return method === 'GET' || method === 'POST'
  if (/^\/plan-items\/\d+\/$/.test(sub)) return method === 'PATCH'
  if (sub === '/plan-sharing/supervisors/') return method === 'GET'
  if (/^\/plan-items\/\d+\/shares\/$/.test(sub)) return method === 'GET' || method === 'POST'
  if (/^\/plan-items\/\d+\/shares\/\d+\/$/.test(sub)) return method === 'DELETE'
  // Shared paper library (JSON): search, own submissions, BibTeX export,
  // detail/edit/withdraw. Review stays in the supervisor workbench.
  if (sub === '/library/papers/' || sub === '/library/submissions/' || sub === '/library/export/') return method === 'GET'
  if (/^\/library\/papers\/\d+\/$/.test(sub)) return method === 'GET' || method === 'PATCH' || method === 'DELETE'
  return false
}

async function statusPayload(ctx, config) {
  await upgradeLegacyBinding(ctx, config)
  const binding = await readBinding(ctx, config)
  if (!binding) {
    const cached = lastAccount()
    const knownServer = normalizeBase(config?.serverUrl || cached?.serverUrl || DEFAULT_SERVER_URL)
    return {
      connected: false, username: '', serverUrl: knownServer,
      online: false, lastSync: null, pendingCount: 0, conflictCount: 0,
      cachedAccount: cached ? describeAccount(cached) : null,
    }
  }
  const store = loadStore(binding)
  return {
    connected: true,
    username: binding.username,
    fullName: binding.fullName,
    studentNumber: binding.studentNumber,
    serverUrl: binding.serverUrl,
    bindingId: binding.bindingId,
    online: store.online,
    lastSync: store.lastSync,
    lastError: store.lastError,
    authExpired: Boolean(store.authExpired),
    pendingCount: store.pending.length,
    conflictCount: Object.values(store.reports).filter(r => r.conflict).length,
    unsubmittedSummaries: localWorkSummary(binding).unsubmittedSummaries,
  }
}

/** Same-origin proxy for the Client panel: the browser talks to the Host
 * webServer; the Host attaches the stored bearer token. The token never
 * reaches the browser, and no CORS is needed. Every request carries the
 * client marker header (a plain cross-site form cannot set it); requests
 * past authorization also echo the current binding id. */
function makeProxy(ctx, config) {
  return async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(JSON.stringify(obj))
    }
    try {
      if (req.headers['x-aecpt-client'] !== '1') {
        throw new ProxyError(403, 'forbidden', '请求缺少 AeCpt 面板标识')
      }
      const url = new URL(req.url, 'http://localhost')
      const sub = url.pathname.replace(/^\/aecpt-api/, '') || '/'
      const method = req.method

      if (sub === '/status' && method === 'GET') return send(200, await statusPayload(ctx, config))

      // Browser authorization driven from the panel (no chat involved).
      if (sub === '/authorize/start' && method === 'POST') {
        const body = await readJsonBody(req)
        const binding = await readBinding(ctx, config)
        const cached = lastAccount()
        const rawInput = body.serverUrl ?? body.inviteUrl ?? body.input ?? ''
        const parsed = String(rawInput || '').trim() ? parseServerInput(rawInput) : { serverUrl: '', invitationUrl: '' }
        const base = parsed.serverUrl || resolveServerBase('', binding?.serverUrl, cached?.serverUrl, config?.serverUrl)
        const started = await startPending(base, { invitationUrl: parsed.invitationUrl })
        return send(200, { ...started, server_url: base, has_invitation: Boolean(parsed.invitationUrl) })
      }
      if (sub === '/authorize/poll' && method === 'POST') {
        const body = await readJsonBody(req)
        prunePending()
        const stateKey = String(body.state || '').trim()
        const entry = stateKey ? pendingAuth.get(stateKey) : undefined
        if (!entry) return send(200, { status: 'expired' })
        if (entry.staged) {
          return send(200, {
            status: 'account_mismatch',
            previous: describeAccount(entry.staged.previous),
            incoming: describeAccount(entry.staged.profile),
          })
        }
        if (entry.inFlight) return send(200, { status: 'pending', poll_interval_ms: entry.pollIntervalMs })
        if (!entry.pollSecret) return send(200, { status: 'manual_only' })
        let polled
        try {
          polled = await pollAuthSession(entry.base, stateKey, entry.pollSecret)
        } catch {
          return send(200, { status: 'pending', poll_interval_ms: entry.pollIntervalMs })
        }
        if (polled.status === 'pending') {
          return send(200, { status: 'pending', poll_interval_ms: polled.poll_interval_ms || entry.pollIntervalMs })
        }
        if (polled.status === 'expired') {
          pendingAuth.delete(stateKey)
          return send(200, { status: 'expired' })
        }
        if (polled.status === 'denied') {
          pendingAuth.delete(stateKey)
          return send(200, { status: 'denied', error: polled.error || 'access_denied' })
        }
        if (polled.status === 'authorized' && typeof polled.code === 'string' && polled.code.trim()) {
          entry.inFlight = true
          try {
            const result = await finalizePendingAuthorization(ctx, config, stateKey, entry, polled.code.trim())
            return send(200, { status: 'connected', ...result })
          } catch (err) {
            if (err instanceof ProxyError && err.code === 'account_mismatch') {
              return send(200, { status: 'account_mismatch', ...err.extra })
            }
            throw err
          } finally {
            entry.inFlight = false
          }
        }
        return send(200, { status: 'expired' })
      }
      if (sub === '/authorize/complete' && method === 'POST') {
        const body = await readJsonBody(req)
        prunePending()
        const entry = pendingAuth.get(body.state)
        if (!entry) throw new ProxyError(400, 'no_pending', '没有待完成的授权，请重新发起')
        if (entry.inFlight || entry.staged) throw new ProxyError(409, 'auth_in_flight', '这次授权正在处理')
        const code = String(body.code || '').trim()
        if (!code || code.length > 512) throw new ProxyError(400, 'invalid_auth_code', '请粘贴授权页面显示的一次性代码')
        entry.inFlight = true
        try {
          const result = await finalizePendingAuthorization(ctx, config, body.state, entry, code)
          return send(200, result)
        } finally {
          entry.inFlight = false
        }
      }
      if (sub === '/authorize/confirm' && method === 'POST') {
        const body = await readJsonBody(req)
        const entry = pendingAuth.get(body.state)
        if (!entry?.staged) throw new ProxyError(400, 'no_pending', '这次授权已失效，请重新发起')
        if (body.choice === 'switch') {
          const result = await commitBinding(ctx, entry.base, entry.staged.minted, entry.staged.profile)
          pendingAuth.delete(body.state)
          clearPending()
          return send(200, result)
        }
        if (body.choice === 'cancel') {
          void revokeToken(entry.base, entry.staged.minted.token)
          pendingAuth.delete(body.state)
          return send(200, { connected: Boolean(await readBinding(ctx, config)) })
        }
        throw new ProxyError(400, 'invalid_choice', 'choice 应为 switch 或 cancel')
      }

      const binding = await readBinding(ctx, config)
      if (!binding) throw new ProxyError(401, 'not_connected', '尚未连接工作台')
      if (req.headers['x-aecpt-binding'] !== binding.bindingId) {
        throw new ProxyError(409, 'binding_changed', '工作台连接已变更，请刷新后重试')
      }

      if (sub === '/disconnect' && method === 'POST') {
        const body = await readJsonBody(req)
        const work = localWorkSummary(binding)
        const unsynced = work.pendingCount + work.conflictCount + work.unsubmittedSummaries
        if (body.clearCache === true && unsynced > 0 && body.discardLocal !== true) {
          throw new ProxyError(409, 'unsynced_local_work', '本机还有未同步的内容', { work })
        }
        await changeBinding(async () => {
          const current = await readBinding(ctx, config)
          if (current?.bindingId !== binding.bindingId) {
            throw new ProxyError(409, 'binding_changed', '工作台连接已变更，请刷新后重试')
          }
          await deleteBindingRecords(ctx)
          if (body.clearCache === true) forgetAccountCache(binding)
        })
        clearPending()
        void revokeToken(binding.serverUrl, binding.token)
        return send(200, { connected: false, cacheKept: body.clearCache !== true })
      }

      if (sub === '/connection/' && method === 'GET') {
        const upstream = await serverFetch(binding, '/me/', { signal: AbortSignal.timeout(15_000) })
        return send(200, {
          connected: true,
          online: upstream.ok,
          status: upstream.status,
          code: upstream.ok ? undefined : upstream.data?.error?.code,
          checked_at: new Date().toISOString(),
        })
      }

      if (sub === '/summary-models' && method === 'GET') {
        const setting = loadSummaryModelSetting()
        let options = []
        try {
          options = await listSummaryModels(ctx)
        } catch (error) {
          return send(502, { error: { code: 'summary_models_failed', detail: String(error?.message || error) } })
        }
        return send(200, {
          mode: setting.mode || 'session',
          selection: setting.mode === 'fixed' ? { provider: setting.provider, model: setting.model } : null,
          options,
        })
      }
      if (sub === '/summary-model' && method === 'POST') {
        const body = await readJsonBody(req)
        if (body.mode === 'session') {
          saveSummaryModelSetting({ mode: 'session' })
          return send(200, { mode: 'session' })
        }
        if (body.mode !== 'fixed') {
          return send(400, { error: { code: 'invalid_summary_model', detail: 'mode 应为 session 或 fixed' } })
        }
        const provider = String(body.provider || '').trim()
        const model = String(body.model || '').trim()
        if (!provider || !model) {
          return send(400, { error: { code: 'invalid_summary_model', detail: '固定模型需要 provider 和 model' } })
        }
        const llm = ctx.get('llm')
        try {
          if (!llm?.resolveModelInfo) throw new Error('当前 DSH 没有可用的模型服务')
          await llm.resolveModelInfo(provider, model)
        } catch (error) {
          return send(400, { error: { code: 'invalid_summary_model', detail: String(error?.message || error) } })
        }
        saveSummaryModelSetting({ mode: 'fixed', provider, model })
        return send(200, { mode: 'fixed', selection: { provider, model } })
      }

      if (sub === '/summarize/context' && method === 'GET') {
        const sessionId = String(url.searchParams.get('sessionId') || '').trim()
        if (!sessionId) {
          return send(400, { error: { code: 'invalid_summary_request', detail: '缺少 sessionId' } })
        }
        const [, autoPeriod] = await Promise.all([syncNow(binding), resolveAutoPeriod(binding)])
        const session = ctx.get('sessions')?.get?.(sessionId)
        const cwd = sessionCwd(session)
        const checkpoint = loadSummaryCheckpoint(binding, sessionId)
        let newMessageCount = 0
        let fromTurn = Number(checkpoint?.turn || 0)
        let toTurn = fromTurn
        let firstTime = null
        let lastTime = null
        let spanDays = 0
        if (session) {
          const toSeq = Number(session.seq) || 0
          const fromSeq = checkpoint ? Number(checkpoint.seq || 0) + 1 : 0
          const events = session.snapshotEvents(fromSeq, toSeq + 1)
          const extracted = transcriptEvents(events)
          newMessageCount = extracted.rows.length
          firstTime = extracted.firstTime
          lastTime = extracted.lastTime
          if (firstTime !== null && lastTime !== null) {
            spanDays = Math.max(1, Math.round((lastTime - firstTime) / 86_400_000) + 1)
          }
          const allEvents = session.snapshotEvents(0, toSeq + 1)
          toTurn = latestTurn(allEvents) || fromTurn
        }
        const { fragments, sessionFragments, workspaceFragments } = listAccountSummaryFragments(binding, sessionId, { cwd })
        return send(200, {
          sessionFound: Boolean(session),
          checkpoint,
          newMessageCount,
          fromTurn,
          toTurn,
          firstTime,
          lastTime,
          spanDays,
          targetPeriod: autoPeriod?.period || '',
          targetPeriodLabel: autoPeriod?.label || autoPeriod?.period || '',
          workspaceName: cwd ? basename(cwd) : '',
          fragments,
          sessionFragments,
          workspaceFragments,
        })
      }

      if (sub === '/summarize' && method === 'POST') {
        const body = await readJsonBody(req)
        const sessionId = String(body.sessionId || '').trim()
        let period = String(body.period || '').trim()
        if (!sessionId) {
          return send(400, { error: { code: 'invalid_summary_request', detail: 'sessionId 不能为空' } })
        }
        if (!period) {
          const auto = await resolveAutoPeriod(binding)
          period = auto?.period || ''
        }
        if (!period) {
          return send(400, { error: { code: 'invalid_summary_request', detail: '无法自动确定当前教学周，请联网刷新后重试' } })
        }
        const sessions = ctx.get('sessions')
        const session = sessions?.get?.(sessionId)
        if (!session) {
          return send(404, { error: { code: 'session_not_found', detail: '找不到当前 DSH 会话' } })
        }
        const cwd = sessionCwd(session)
        const checkpoint = loadSummaryCheckpoint(binding, sessionId)
        const toSeq = Number(session.seq) || 0
        const fromSeq = checkpoint ? Number(checkpoint.seq || 0) + 1 : 0
        const events = session.snapshotEvents(fromSeq, toSeq + 1)
        const { rows: transcript, firstTime, lastTime } = transcriptEvents(events)
        if (!transcript.length) {
          return send(409, {
            error: {
              code: 'no_new_messages',
              detail: checkpoint ? '上次总结后没有新的对话内容' : '当前会话还没有可总结的对话',
            },
            checkpoint,
          })
        }
        const allEvents = session.snapshotEvents(0, toSeq + 1)
        const toTurn = latestTurn(allEvents) || Number(checkpoint?.turn || 0)
        const fromTurn = Number(checkpoint?.turn || 0)
        const range = fromTurn ? `第 ${fromTurn + 1}–${toTurn} 轮` : '本次会话'
        const references = Array.isArray(body.referenceIds)
          ? findSummaryRecordsByIds(binding, body.referenceIds)
          : (checkpoint ? sessionSummaries(binding, sessionId, 5) : [])
        const bounded = formatBoundedTranscript(transcript, 60000)
        const prompt = buildFragmentPrompt({
          period,
          range,
          sessionId,
          firstTime,
          lastTime,
          references,
          bounded,
        })
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 120000)
        let generated
        try {
          generated = await callSelectedModel(ctx, session, prompt, controller.signal, loadSummaryModelSetting())
        } catch (error) {
          return send(502, {
            error: {
              code: 'summary_model_failed',
              detail: error?.name === 'AbortError' ? '总结超时，请重试' : String(error?.message || error),
            },
          })
        } finally {
          clearTimeout(timer)
        }
        // The model call can take a while; never write into another binding.
        if ((await readBinding(ctx, config))?.bindingId !== binding.bindingId) {
          throw new ProxyError(409, 'binding_changed', '总结期间工作台连接已变更，本次结果未写入')
        }
        const summary = generated.text.slice(0, 12000).replaceAll('\0', '').toWellFormed().trim()
        if (!summary) {
          return send(502, { error: { code: 'summary_model_failed', detail: '模型没有返回可用的进展内容' } })
        }
        const record = {
          id: randomUUID(),
          session_id: sessionId,
          from_seq: fromSeq,
          to_seq: toSeq,
          created_at: new Date().toISOString(),
          provider: generated.provider,
          model: generated.model,
          summary,
        }
        const result = await saveReportSummary(binding, { period, record, checkpoint, toTurn, cwd })
        if (result.status >= 400) return send(result.status, result.payload)
        return send(200, {
          ...result.payload,
          record,
          summary,
          provider: record.provider,
          model: record.model,
          from_turn: fromTurn,
          to_turn: toTurn,
          reference_count: references.length,
        })
      }

      if (sub === '/reports/summaries/' && method === 'POST') {
        const body = await readJsonBody(req)
        const period = String(body.period || '').trim()
        if (!period) return send(400, { error: { code: 'invalid_period', detail: '请选择教学周' } })
        const result = await addManualSummary(binding, { period, summary: body.summary })
        return send(result.status, result.payload)
      }

      const summaryDel = sub.match(/^\/reports\/([^/]+)\/summaries\/([^/]+)\/$/)
      if (summaryDel && method === 'DELETE') {
        const result = await removeReportSummary(binding, summaryDel[1], summaryDel[2])
        return send(result.status, result.payload)
      }

      const compileMatch = sub.match(/^\/reports\/([^/]+)\/compile\/$/)
      if (compileMatch && method === 'POST') {
        const id = compileMatch[1]
        const body = await readJsonBody(req)
        const store = await syncNow(binding)
        const entry = store.reports[id] ?? Object.values(store.reports).find(report => report.localId === id)
        if (!entry || entry.payload.author?.username !== binding.username) {
          return send(404, { error: { code: 'report_not_found', detail: '无此个人进展' } })
        }
        const currentDetail = reportDetail(entry)
        if (currentDetail.status !== 'draft') {
          return send(409, { error: { code: 'report_submitted', detail: '已提交的进展不能重新提炼' } })
        }
        if (currentDetail.has_conflict) {
          return send(409, { error: { code: 'report_conflict', detail: '该草稿有待解决冲突，请先处理' } })
        }
        const records = currentDetail.summary_records ?? []
        if (!records.length) {
          return send(400, { error: { code: 'no_summary_records', detail: '本周还没有可提炼的过程记录' } })
        }
        const existingContent = (currentDetail.content || '').trim()
        const session = body.sessionId ? ctx.get('sessions')?.get?.(String(body.sessionId).trim()) : null
        const prompt = buildCompilePrompt({
          period: currentDetail.period,
          existingContent,
          records,
          compiledIds: currentDetail.compiled_record_ids,
        })
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 180000)
        let generated
        try {
          generated = await callSelectedModel(ctx, session, prompt, controller.signal, loadSummaryModelSetting(), {
            system: loadCustomPrompts().compileSystem,
            maxTokens: 3200,
            purpose: 'aecpt-weekly-report-compile',
          })
        } catch (error) {
          return send(502, {
            error: {
              code: 'compile_model_failed',
              detail: error?.name === 'AbortError' ? '提炼周报超时，请重试' : String(error?.message || error),
            },
          })
        } finally {
          clearTimeout(timer)
        }
        if ((await readBinding(ctx, config))?.bindingId !== binding.bindingId) {
          throw new ProxyError(409, 'binding_changed', '提炼期间工作台连接已变更，本次结果未写入')
        }
        const compiled = generated.text.slice(0, 180000).replaceAll('\0', '').toWellFormed().trim()
        if (!compiled) {
          return send(502, { error: { code: 'compile_model_failed', detail: '模型没有返回可用的周报正文' } })
        }
        const saved = await saveCompiledReport(binding, String(entry.payload.id), {
          content: compiled,
          recordIds: records.map(rec => rec.id),
          provider: generated.provider,
          model: generated.model,
        })
        if (saved.status >= 400) return send(saved.status, saved.payload)
        return send(200, {
          report: saved.payload,
          provider: generated.provider,
          model: generated.model,
          fused: Boolean(existingContent),
        })
      }

      const undoMatch = sub.match(/^\/reports\/([^/]+)\/undo-compile\/$/)
      if (undoMatch && method === 'POST') {
        const result = await undoCompiledReport(binding, undoMatch[1])
        return send(result.status, result.payload)
      }

      // Local-first report routes (offline-capable reads, queued draft writes).
      if (sub === '/reports/' && method === 'GET') {
        const store = await syncNow(binding)
        return send(200, listPayloads(store).filter(report => report.author?.username === binding.username))
      }
      if (sub === '/reports/' && method === 'POST') {
        const result = await createDraft(binding, await readJsonBody(req))
        return send(result.status, result.payload)
      }
      if (sub === '/reports/sync/' && method === 'POST') {
        const store = await syncNow(binding)
        return send(200, {
          online: store.online, lastSync: store.lastSync,
          pendingCount: store.pending.length, lastError: store.lastError,
        })
      }
      if (sub === '/export' && method === 'GET') {
        const store = await syncNow(binding)
        const ownReports = { ...store, reports: Object.fromEntries(
          Object.entries(store.reports).filter(([, entry]) => entry.payload.author?.username === binding.username),
        ) }
        const path = exportToFile(ownReports)
        return send(200, { path, bytes: Buffer.byteLength(exportMarkdown(ownReports)) })
      }
      const detail = sub.match(/^\/reports\/([^/]+)\/$/)
      if (detail && method === 'GET') {
        const store = await syncNow(binding)
        const id = detail[1]
        const entry = store.reports[id] ?? Object.values(store.reports).find(report => report.localId === id)
        if (!entry || entry.payload.author?.username !== binding.username) {
          return send(404, { error: { code: 'report_not_found', detail: '无此个人进展' } })
        }
        return send(200, reportDetail(entry))
      }
      if (detail && method === 'PATCH') {
        const entry = loadStore(binding).reports[detail[1]]
        if (entry?.payload.author?.username !== binding.username) {
          return send(404, { error: { code: 'report_not_found', detail: '无此个人进展' } })
        }
        const body = await readJsonBody(req)
        const result = await editDraft(binding, detail[1], body.content ?? '')
        return send(result.status, result.payload)
      }
      const action = sub.match(/^\/reports\/([^/]+)\/(submit|resolve)\/$/)
      if (action && method === 'POST') {
        const [, id, kind] = action
        const entry = loadStore(binding).reports[id]
        if (entry?.payload.author?.username !== binding.username) {
          return send(404, { error: { code: 'report_not_found', detail: '无此个人进展' } })
        }
        const result = kind === 'resolve'
          ? await resolveConflict(binding, id, await readJsonBody(req))
          : await submitReport(binding, id)
        return send(result.status, result.payload)
      }

      if (sub.startsWith('/feeds/')) {
        const [status, payload] = await feedRoute(binding, method, sub, url, req)
        return send(status, payload)
      }

      if (sub.startsWith('/library/')) {
        const handled = await libraryRoute(binding, method, sub, req, res)
        if (handled === 'streamed') return
        if (handled) return send(handled[0], handled[1])
      }

      if (!forwardAllowed(method, sub)) throw new ProxyError(404, 'not_found', '无此工作台接口')
      const headers = { Authorization: `Bearer ${binding.token}`, Accept: 'application/json' }
      let body
      if (method === 'POST' || method === 'PATCH') {
        headers['Content-Type'] = 'application/json'
        body = await readRequestBody(req)
      }
      const upstream = await fetch(`${binding.serverUrl}/api/v1${sub}${url.search || ''}`, {
        method, headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000),
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(text)
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof ProxyError) {
        return send(error.status, { error: { code: error.code, detail: error.detail }, ...error.extra })
      }
      if (error instanceof FeedError) {
        return send(error.status, { error: { code: error.code, detail: error.detail } })
      }
      send(502, { error: { code: 'proxy_error', detail: String(error?.message || error) } })
    }
  }
}

/** Literature subscription routes; entries stay on this device. */
async function feedRoute(binding, method, sub, url, req) {
  if (sub === '/feeds/' && method === 'GET') {
    return [200, listFeeds(binding, {
      sourceId: url.searchParams.get('source') || undefined,
      unread: url.searchParams.get('unread') === '1',
      limit: url.searchParams.get('limit') || undefined,
    })]
  }
  if (sub === '/feeds/sources/' && method === 'POST') {
    const body = await readJsonBody(req)
    return [201, await addSource(binding, { name: body.name, url: body.url, kind: body.kind })]
  }
  const source = sub.match(/^\/feeds\/sources\/([^/]+)\/$/)
  if (source && method === 'DELETE') {
    let sourceId
    try { sourceId = decodeURIComponent(source[1]) } catch {
      throw new ProxyError(400, 'invalid_source_id', '订阅标识格式不正确')
    }
    return [200, await removeSource(binding, sourceId)]
  }
  if (sub === '/feeds/refresh' && method === 'POST') {
    const body = await readJsonBody(req)
    return [200, await refreshFeeds(binding, { sourceId: body.sourceId || undefined })]
  }
  if (sub === '/feeds/read' && method === 'POST') {
    const body = await readJsonBody(req)
    return [200, await markRead(binding, { sourceId: body.sourceId, key: body.key, read: body.read !== false })]
  }
  throw new ProxyError(404, 'not_found', '无此订阅接口')
}

/** Shared-library routes the Host handles itself: metadata resolution,
 * submission (JSON from the panel -> multipart upstream) and PDF streaming.
 * Returns null for paths left to the JSON forwarder. */
async function libraryRoute(binding, method, sub, req, res) {
  if (sub === '/library/resolve' && method === 'POST') {
    const body = await readJsonBody(req)
    return [200, await resolveIdentifier(body.identifier)]
  }
  if (sub === '/library/papers/' && method === 'POST') {
    const body = await readJsonBody(req, SUBMIT_BODY_LIMIT, 'PDF 过大（上限 50 MiB）')
    const result = await submitPaper(binding, await prepareSubmission(body))
    return [result.status, result.data]
  }
  const pdf = sub.match(/^\/library\/papers\/(\d+)\/pdf\/?$/)
  if (pdf && method === 'GET') {
    await streamPaperPdf(binding, pdf[1], res)
    return 'streamed'
  }
  return null
}

/** Authenticated JSON call to the library API for agent tools. */
async function libraryCall(binding, path, options = {}) {
  let result
  try {
    result = await serverFetch(binding, path, { ...options, signal: options.signal ?? AbortSignal.timeout(30_000) })
  } catch {
    throw new Error('无法连接 AeCpt 服务器')
  }
  if (!result.ok) {
    if (result.data?.error?.code === 'authentication_failed') throw new Error('令牌无效或已撤销：请调用 aecpt_authorize 重新授权')
    throw new Error(result.data?.error?.detail || `服务器返回 HTTP ${result.status}`)
  }
  return result.data
}

function libraryQuery(args) {
  const params = new URLSearchParams()
  if (args.q) params.set('q', String(args.q))
  if (args.tag) params.set('tag', String(args.tag))
  const text = params.toString()
  return text ? `?${text}` : ''
}

const splitList = text => [...new Set(String(text ?? '').split(/[,，、;；]/).map(item => item.trim()).filter(Boolean))]

/** Authenticated JSON call against the bound server. */
async function api(ctx, config, { method, path, body, signal }) {
  const binding = await readBinding(ctx, config)
  if (!binding) throw new Error('尚未连接 aecpt 服务器：先调用 aecpt_authorize')
  const headers = { Accept: 'application/json', Authorization: `Bearer ${binding.token}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(binding.serverUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  const { data, text } = await parseBody(res)
  if (!res.ok) throw apiError(res, data, text)
  return data
}

const REPORT_SUMMARY_FIELDS = {
  id: { type: 'integer' },
  period: { type: 'string' },
  period_label: { type: 'string' },
  status: { type: 'string' },
  status_display: { type: 'string' },
  author: { type: 'string' },
  project: { type: 'string' },
  revision: { type: 'integer' },
  feedback_count: { type: 'integer' },
}

function summarize(report) {
  return {
    id: report.id,
    period: report.period,
    period_label: report.period_label || report.period,
    status: report.status,
    status_display: report.status_display,
    author: report.author?.full_name || report.author?.username || '',
    project: report.project?.name || '',
    revision: report.revision,
    feedback_count: report.feedback_count ?? 0,
  }
}

function detailOf(report) {
  return {
    ...summarize(report),
    content: report.content || '',
    submitted_at: report.submitted_at || '',
    feedback: (report.feedback || []).map(f => ({
      id: f.id,
      author: f.author?.full_name || f.author?.username || '',
      content: f.content,
      created_at: f.created_at,
    })),
  }
}

function renderReportValue(value) {
  const lines = []
  if (value.periods) {
    const cur = value.periods.current
    lines.push(`当前教学周：${cur ? `${cur.period}（${cur.label || cur.period}）` : '未知'}`)
    for (const w of value.periods.weeks || []) {
      lines.push(`- ${w.period}${w.label && w.label !== w.period ? ` · ${w.label}` : ''}`)
    }
  }
  if (value.reports) {
    lines.push(`${value.reports.length} 份学习/研究进展：`)
    for (const r of value.reports) {
      lines.push(`- #${r.id} ${r.period_label || r.period} ${r.author} [${r.status_display}]${r.project ? ` @${r.project}` : ''} 反馈${r.feedback_count}条`)
    }
  }
  if (value.report) {
    const r = value.report
    lines.push(`进展 #${r.id} ${r.period_label || r.period} ${r.author} [${r.status_display}] rev${r.revision}`)
    if (r.content !== undefined) lines.push(r.content || '（正文为空）')
    for (const f of r.feedback || []) lines.push(`反馈（${f.author}）：${f.content}`)
  }
  if (value.summaries) {
    lines.push(`共 ${value.summaries.length} 条进展碎片：`)
    for (const s of value.summaries) {
      lines.push(`- [${s.id}] ${s.created_at || ''} (${s.model || 'manual'})\n${s.summary}`)
    }
  }
  if (value.record) {
    lines.push(`已记入进展碎片 [${value.record.id}]：\n${value.record.summary}`)
  }
  return [{ type: 'text', text: lines.join('\n') || '完成' }]
}

export async function apply(ctx, config) {
  // Same-origin API proxy for the Client panel (token stays in the Host).
  const webServer = ctx.get('webServer')
  if (webServer) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/aecpt-api',
      handler: makeProxy(ctx, config),
    }))
  }

  // Periodic background sync keeps the local store fresh for offline reads.
  ctx.effect(() => {
    const timer = setInterval(async () => {
      try {
        const binding = await readBinding(ctx, config)
        if (binding) await syncNow(binding)
      } catch { /* best effort */ }
    }, 60000)
    return () => clearInterval(timer)
  })

  // Browser authorization flow via the DSH authorization seam (settings UI).
  // Optional: profiles without the service keep the chat-tool path below.
  const authorization = ctx.get('authorization')
  if (authorization) {
    ctx.effect(() => authorization.registerFlow({
      key: 'dsh-aecpt/default',
      label: 'AeCpt 工作台',
      methods: [{ id: 'oauth', label: '浏览器授权登录' }],
      async run(session) {
        const binding = await readBinding(ctx, config)
        const cached = lastAccount()
        let base = ''
        try {
          base = resolveServerBase('', binding?.serverUrl, cached?.serverUrl, config?.serverUrl)
        } catch {
          const inputAnswer = await session.prompt({
            kind: 'text',
            message: '粘贴导师发来的邀请链接（或 AeCpt 服务器地址）',
          })
          base = parseServerInput(inputAnswer?.value ?? inputAnswer ?? '').serverUrl
          if (!base) throw new Error('未提供有效的邀请链接或服务器地址')
        }
        const state = randomBytes(16).toString('hex')
        const { verifier, challenge } = pkcePair()
        session.notify({
          message: `在浏览器中登录工作台（${base}）并授权，然后复制页面显示的一次性代码`,
          url: authorizeUrl(base, state, challenge),
        })
        const answer = await session.prompt({
          kind: 'text',
          message: '粘贴浏览器页面显示的一次性代码',
        })
        const code = String(answer?.value ?? answer ?? '').trim()
        if (!code) throw new Error('未提供授权码')
        const minted = await exchangeAndMint(base, code, verifier, session.signal)
        await commitFromTool(ctx, config, base, minted, session.signal)
      },
    }))
  }

  ctx.tools.register({
    name: 'aecpt_authorize',
    description:
      'Start the browser OAuth PKCE authorization flow for the AeCpt workbench '
      + '(passwords never pass through DSH). Pass the supervisor invitation link '
      + '(e.g. https://.../invitations/...) or the server base URL; the server origin '
      + 'is extracted automatically. Returns a URL; the user opens it, signs in with '
      + 'a username or student number, approves access, and copies the one-time code '
      + 'shown there. Then call aecpt_authorize_complete with that code.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serverUrl: {
          type: 'string',
          description: 'Supervisor invitation link (e.g. https://.../invitations/...) or server base URL. Optional if previously connected or configured.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['authorize_url', 'state', 'server_url'],
        properties: {
          authorize_url: { type: 'string' },
          state: { type: 'string' },
          server_url: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已识别服务器：${value.server_url}\n请在浏览器中打开并登录授权：\n${value.authorize_url}\n完成后把页面显示的一次性代码交给 aecpt_authorize_complete。`,
      }],
    },
    async execute(args, _exec) {
      const binding = await readBinding(ctx, config)
      const cached = lastAccount()
      const parsed = String(args?.serverUrl || '').trim() ? parseServerInput(args.serverUrl) : { serverUrl: '', invitationUrl: '' }
      const base = parsed.serverUrl || resolveServerBase('', binding?.serverUrl, cached?.serverUrl, config?.serverUrl)
      const { authorize_url, state } = await startPending(base, { invitationUrl: parsed.invitationUrl })
      return { authorize_url, state, server_url: base }
    },
  })

  ctx.tools.register({
    name: 'aecpt_authorize_complete',
    description:
      'Finish the browser authorization flow: exchange the one-time code from the workbench '
      + 'page for an API token stored in the DSH credential store. The code is single-use. '
      + 'Switching to a different account than the one cached on this device is only possible from the AeCpt panel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'The one-time code displayed on the workbench authorization page.' },
        state: { type: 'string', description: 'The state returned by aecpt_authorize; omit to use the most recent pending authorization.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['connected', 'username', 'serverUrl', 'tokenId'],
        properties: {
          connected: { type: 'boolean' },
          username: { type: 'string' },
          serverUrl: { type: 'string' },
          tokenId: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `浏览器授权完成：${value.username} @ ${value.serverUrl}（令牌 #${value.tokenId} 已存入凭据库）`,
      }],
    },
    async execute(args, exec) {
      prunePending()
      let key = args.state
      if (!key) {
        key = Array.from(pendingAuth.entries())
          .filter(([, value]) => !value.staged)
          .sort((a, b) => b[1].createdAt - a[1].createdAt)[0]?.[0]
      }
      const entry = key ? pendingAuth.get(key) : undefined
      if (!entry || entry.staged) throw new Error('没有待完成的授权：请先调用 aecpt_authorize')
      if (entry.inFlight) throw new Error('这次授权正在处理')
      const code = String(args.code || '').trim()
      if (!code) throw new Error('code 不能为空')
      entry.inFlight = true
      try {
        const minted = await exchangeAndMint(entry.base, code, entry.verifier, exec.signal)
        const result = await commitFromTool(ctx, config, entry.base, minted, exec.signal)
        pendingAuth.delete(key)
        return result
      } finally {
        entry.inFlight = false
      }
    },
  })

  ctx.tools.register({
    name: 'aecpt_logout',
    description: 'Remove the stored aecpt binding from this DSH installation and revoke its token. Local cached drafts stay on this device.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['connected'],
        properties: { connected: { type: 'boolean' } },
      },
      render: () => [{ type: 'text', text: '已断开 aecpt 连接（本机凭据已删除，本机缓存保留）' }],
    },
    async execute(_args, _exec) {
      const binding = await readBinding(ctx, config)
      await changeBinding(() => deleteBindingRecords(ctx))
      clearPending()
      if (binding) void revokeToken(binding.serverUrl, binding.token)
      return { connected: false }
    },
  })

  ctx.tools.register({
    name: 'aecpt_feeds',
    description:
      'Personal literature subscriptions kept on this device (journal RSS/Atom, arXiv categories, research blogs). '
      + 'Actions: list (latest entries; unread filter), add (subscribe a feed URL; kind journal|arxiv|blog), '
      + 'remove (sourceId), refresh (all or one sourceId). Subscriptions are for browsing only and never '
      + 'modify progress drafts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'refresh'], description: 'Which operation to run.' },
        url: { type: 'string', description: 'Feed URL for add.' },
        name: { type: 'string', description: 'Optional display name for add.' },
        kind: { type: 'string', enum: ['journal', 'arxiv', 'blog'], description: 'Feed kind for add; defaults to journal.' },
        sourceId: { type: 'string', description: 'Subscription id for remove/refresh and list filtering.' },
        unread: { type: 'boolean', description: 'list only unread entries.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'text'],
        properties: { action: { type: 'string' }, text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, _exec) {
      const binding = await readBinding(ctx, config)
      if (!binding) throw new Error('尚未连接 aecpt 服务器：先调用 aecpt_authorize')
      const { action } = args
      try {
        if (action === 'list') {
          const result = listFeeds(binding, { sourceId: args.sourceId, unread: args.unread === true, limit: 30 })
          const sourceLines = result.sources.map(source =>
            `- ${source.name}（${source.id}，${source.kindLabel}，未读 ${source.unreadCount}/${source.itemCount}）`)
          const lines = result.items.map(item =>
            `- [${item.sourceId} ${item.key}] ${item.title}（${item.sourceName}${item.publishedAt ? `，${item.publishedAt}` : ''}）${item.read ? '' : ' · 未读'}\n  ${item.url}`)
          const parts = [`${result.sources.length} 个订阅，${result.unreadCount} 条未读。`]
          if (sourceLines.length) parts.push(`订阅源：\n${sourceLines.join('\n')}`)
          parts.push(lines.length ? `条目：\n${lines.join('\n')}` : '暂无条目')
          return { action, text: parts.join('\n\n') }
        }
        if (action === 'add') {
          const source = await addSource(binding, { name: args.name, url: args.url, kind: args.kind || 'journal' })
          return { action, text: `已订阅 ${source.name}（${source.id}），读到 ${source.itemCount} 条` }
        }
        if (action === 'remove') {
          await removeSource(binding, args.sourceId)
          return { action, text: `已删除订阅 ${args.sourceId}` }
        }
        if (action === 'refresh') {
          const result = await refreshFeeds(binding, { sourceId: args.sourceId })
          return { action, text: `已刷新 ${result.refreshed} 个订阅，新增 ${result.added} 条，失败 ${result.failed} 个` }
        }
      } catch (error) {
        if (error instanceof FeedError || error instanceof ProxyError) throw new Error(error.detail)
        throw error
      }
      throw new Error(`未知 action：${action}`)
    },
  })
  ctx.tools.register({
    name: 'aecpt_library',
    description:
      'The research group\'s shared paper library on the AeCpt server (metadata + PDF). Actions: '
      + 'search (approved papers; q = space-separated words, tag = exact tag; returns ids), get (id), '
      + 'mine (your own submissions with status and review notes), resolve (DOI / doi.org URL / arXiv id or URL -> '
      + 'metadata preview via Crossref or arXiv), submit (identifier or title, optional pdfPath to a local PDF; '
      + 'arXiv papers auto-download their PDF when pdfPath is omitted, DOI papers require pdfPath; optional tags, note), '
      + 'download (id -> saves the PDF under ~/.aecpt/library/ and returns the absolute path so you can read it), '
      + 'export (BibTeX for ids or a q/tag search; optional path writes a .bib file inside the home directory). '
      + 'Student submissions only enter the shared library after a supervisor approves them; '
      + 'review and deletion are not available through this tool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'get', 'mine', 'resolve', 'submit', 'download', 'export'],
          description: 'Which operation to run.',
        },
        q: { type: 'string', description: 'Search words for search/export (all must match title, authors, venue, DOI, arXiv id, abstract or tags).' },
        tag: { type: 'string', description: 'Exact tag filter for search/export.' },
        id: { type: 'integer', description: 'Paper id for get/download.' },
        ids: { type: 'string', description: 'Comma-separated paper ids for export.' },
        identifier: { type: 'string', description: 'DOI, doi.org URL, arXiv id or arxiv.org abs/pdf URL for resolve/submit.' },
        title: { type: 'string', description: 'Title for a manual submit without identifier.' },
        pdfPath: { type: 'string', description: 'Local PDF path for submit (~ allowed); required for DOI papers.' },
        tags: { type: 'string', description: 'Comma-separated tags for submit.' },
        note: { type: 'string', description: 'Recommendation reason shown to the supervisor and the group (submit).' },
        path: { type: 'string', description: 'export: .bib file path inside the home directory (~ allowed).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'text'],
        properties: { action: { type: 'string' }, text: { type: 'string' }, path: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const binding = await readBinding(ctx, config)
      if (!binding) throw new Error('尚未连接 aecpt 服务器：先调用 aecpt_authorize')
      const { action } = args
      const signal = exec?.signal
      const needId = () => {
        if (!Number.isInteger(args.id)) throw new Error('该操作需要整数 id')
        return args.id
      }
      try {
        if (action === 'search') {
          const papers = await libraryCall(binding, `/library/papers/${libraryQuery(args)}`, { signal })
          const shown = papers.slice(0, 30)
          const head = papers.length
            ? `公用库中找到 ${papers.length} 篇${papers.length > shown.length ? `（显示前 ${shown.length} 篇）` : ''}：`
            : '公用库中没有匹配的论文。'
          return { action, text: [head, ...shown.map(paperLine)].join('\n') }
        }
        if (action === 'get') {
          return { action, text: paperDetail(await libraryCall(binding, `/library/papers/${needId()}/`, { signal })) }
        }
        if (action === 'mine') {
          const papers = await libraryCall(binding, '/library/submissions/', { signal })
          if (!papers.length) return { action, text: '你还没有提交过论文。' }
          const lines = papers.map(paper => {
            const status = paper.status_display || PAPER_STATUS[paper.status] || paper.status
            const note = paper.status === 'rejected' && paper.review_note ? `\n  导师意见：${paper.review_note}` : ''
            return `- #${paper.id} [${status}] ${paper.title}${note}`
          })
          return { action, text: [`你的投稿 ${papers.length} 篇：`, ...lines].join('\n') }
        }
        if (action === 'resolve') {
          const { metadata, pdfUrl } = await resolveIdentifier(args.identifier)
          const pdfHint = pdfUrl
            ? `PDF：可从 arXiv 自动下载（${pdfUrl}）`
            : 'PDF：出版社 PDF 不会自动下载，提交时需要用 pdfPath 指定本地 PDF'
          return { action, text: `${paperDetail({ ...metadata, id: '—', status_display: '预览' })}\n${pdfHint}` }
        }
        if (action === 'submit') {
          let metadata
          if (args.identifier) {
            metadata = (await resolveIdentifier(args.identifier)).metadata
          } else if (String(args.title ?? '').trim()) {
            metadata = { title: String(args.title).trim() }
          } else {
            throw new Error('submit 需要 identifier（DOI 或 arXiv）或 title')
          }
          if (args.tags) metadata.tags = splitList(args.tags)
          if (args.note) metadata.note = String(args.note)
          let file
          if (args.pdfPath) file = readLocalPdf(args.pdfPath)
          else if (metadata.arxiv_id) file = await downloadArxivPdf(metadata.arxiv_id)
          else throw new Error('这篇论文没有可自动下载的 arXiv PDF：请用 pdfPath 指定本地 PDF 文件后再提交')
          const result = await submitPaper(binding, { metadata: submissionMetadata(metadata), ...file })
          if (result.status === 409 && result.data?.error?.existing) {
            const existing = result.data.error.existing
            throw new Error(`库中已有：${existing.title}（${PAPER_STATUS[existing.status] || existing.status}，#${existing.id}），无需重复提交`)
          }
          if (result.status >= 400) throw new Error(result.data?.error?.detail || `提交失败：HTTP ${result.status}`)
          const paper = result.data
          return {
            action,
            text: paper.status === 'approved'
              ? `已入库 #${paper.id}：${paper.title}`
              : `已提交 #${paper.id}：${paper.title}，等待导师审核后对课题组可见`,
          }
        }
        if (action === 'download') {
          const paper = await libraryCall(binding, `/library/papers/${needId()}/`, { signal })
          const saved = await downloadPaperPdf(binding, paper)
          return { action, path: saved.path, text: `已下载《${paper.title}》PDF（${Math.max(1, Math.round(saved.bytes / 1024))} KiB）：${saved.path}` }
        }
        if (action === 'export') {
          let query = libraryQuery(args)
          if (args.ids) {
            const ids = splitList(args.ids)
            if (!ids.every(id => /^\d+$/.test(id))) throw new Error('ids 应为逗号分隔的整数')
            query = `?ids=${ids.join(',')}`
          }
          const result = await libraryCall(binding, `/library/export/${query}`, { signal })
          if (!result.count) return { action, text: '没有可导出的论文（只导出已入库的论文）。' }
          if (args.path) {
            const path = writeBibFile(args.path, result.bibtex)
            return { action, path, text: `已导出 ${result.count} 条 BibTeX 到 ${path}` }
          }
          return { action, text: `${result.count} 条 BibTeX：\n\n${String(result.bibtex).slice(0, 60000)}` }
        }
      } catch (error) {
        if (error instanceof ProxyError || error instanceof FeedError) throw new Error(error.detail)
        throw error
      }
      throw new Error(`未知 action：${action}`)
    },
  })
  ctx.tools.register({
    name: 'aecpt_me',
    description: 'Return the bound AeCpt identity, current FNU teaching week, and visible projects.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'username', 'full_name', 'student_number', 'is_student', 'is_supervisor', 'current_period', 'projects'],
        properties: {
          id: { type: 'integer' },
          username: { type: 'string' },
          full_name: { type: 'string' },
          student_number: { type: 'string' },
          is_student: { type: 'boolean' },
          is_supervisor: { type: 'boolean' },
          current_period: { type: 'string' },
          projects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                kind: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const lines = [
          `${v.full_name}${v.student_number ? `（${v.student_number}）` : `（${v.username}）`}：${v.is_supervisor ? '导师' : ''}${v.is_student ? '学生' : ''}`,
        ]
        if (v.current_period) lines.push(`当前教学周：${v.current_period}`)
        if (v.projects?.length) {
          lines.push(`参与项目（${v.projects.length}）：` + v.projects.map(p => `#${p.id} ${p.name}`).join('；'))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const [me, periods, projects] = await Promise.all([
        api(ctx, config, { method: 'GET', path: '/api/v1/me/', signal: exec.signal }),
        api(ctx, config, { method: 'GET', path: '/api/v1/academic-periods/', signal: exec.signal }).catch(() => null),
        api(ctx, config, { method: 'GET', path: '/api/v1/projects/', signal: exec.signal }).catch(() => []),
      ])
      return {
        id: me.id,
        username: me.username,
        full_name: me.full_name,
        student_number: me.student_number || '',
        is_student: me.is_student,
        is_supervisor: me.is_supervisor,
        current_period: periods?.current?.period || '',
        projects: Array.isArray(projects)
          ? projects.map(p => ({ id: p.id, name: p.name, kind: p.kind || '', status: p.status || '' }))
          : [],
      }
    },
  })
  ctx.tools.register({
    name: 'aecpt_plan',
    description:
      'Manage personal study/research plans and list visible projects on the AeCpt server. '
      + 'Actions: list (personal plan items; optional done filter open|done|all), create (add a new task), '
      + 'update (edit title, notes, due_date, done, or project of a task by id), projects (list visible '
      + 'research/thesis projects with ids). Sharing a plan with a supervisor stays a manual action in the '
      + '计划 tab so private notes are never shared accidentally.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'projects'],
          description: 'Which plan operation to run.',
        },
        id: { type: 'integer', description: 'Plan item id; required for update.' },
        done: { type: 'string', description: 'For list: open, done, or all (default all). For update/create: "true" or "false".' },
        title: { type: 'string', description: 'Task title (required for create, optional for update).' },
        notes: { type: 'string', description: 'Optional private notes for the task.' },
        due_date: { type: 'string', description: 'Optional due date in YYYY-MM-DD format; empty string clears due_date on update.' },
        project: { type: 'integer', description: 'Optional project id to link; pass 0 on update to unlink.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'text'],
        properties: {
          action: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const { action } = args ?? {}
      const signal = exec?.signal
      if (action === 'projects') {
        const rows = await api(ctx, config, { method: 'GET', path: '/api/v1/projects/', signal })
        const list = Array.isArray(rows) ? rows : []
        if (!list.length) return { action, text: '当前没有可见的科研或毕业论文项目。' }
        const lines = list.map(p => `- #${p.id} ${p.name} [${p.kind || ''}${p.status ? ` · ${p.status}` : ''}]`)
        return { action, text: `共 ${list.length} 个可见项目：\n${lines.join('\n')}` }
      }
      if (action === 'list') {
        const filter = String(args.done || 'all').trim().toLowerCase()
        if (!['all', 'open', 'done'].includes(filter)) throw new Error('done 筛选应为 all、open 或 done')
        const rows = await api(ctx, config, { method: 'GET', path: '/api/v1/plan-items/', signal })
        const all = Array.isArray(rows) ? rows : []
        const items = filter === 'all' ? all : all.filter(item => Boolean(item.done) === (filter === 'done'))
        if (!items.length) return { action, text: '没有符合条件的个人计划条目。' }
        const lines = items.map(item => {
          const mark = item.done ? '[x]' : '[ ]'
          const due = item.due_date ? ` 截止 ${item.due_date}` : ''
          const proj = item.project?.name ? ` @${item.project.name}` : ''
          const notes = item.notes ? `\n  备注：${String(item.notes).slice(0, 200)}` : ''
          return `- ${mark} #${item.id} ${item.title}${due}${proj}${notes}`
        })
        return { action, text: `共 ${items.length} 条个人计划：\n${lines.join('\n')}` }
      }
      if (action === 'create') {
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        if (!title) throw new Error('create 需要非空 title')
        const body = { title }
        if (args.notes !== undefined) body.notes = String(args.notes)
        if (args.due_date !== undefined && String(args.due_date).trim()) {
          const due = String(args.due_date).trim()
          if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('due_date 应为 YYYY-MM-DD 格式')
          body.due_date = due
        }
        if (args.done !== undefined) {
          const v = String(args.done).trim().toLowerCase()
          if (v === 'true' || v === 'false') body.done = v === 'true'
          else throw new Error('done 应为 "true" 或 "false"')
        }
        if (args.project !== undefined) {
          if (!Number.isInteger(args.project) || args.project <= 0) throw new Error('project 应为正整数项目编号')
          body.project = args.project
        }
        const created = await api(ctx, config, { method: 'POST', path: '/api/v1/plan-items/', body, signal })
        return {
          action,
          text: `已创建个人计划 #${created.id}：${created.title}${created.due_date ? `（截止 ${created.due_date}）` : ''}`,
        }
      }
      if (action === 'update') {
        if (!Number.isInteger(args.id) || args.id <= 0) throw new Error('update 需要正整数 id')
        const body = {}
        if (args.title !== undefined) {
          const title = String(args.title).trim()
          if (!title) throw new Error('title 不能为空')
          body.title = title
        }
        if (args.notes !== undefined) body.notes = String(args.notes)
        if (args.due_date !== undefined) {
          const due = String(args.due_date).trim()
          if (!due) body.due_date = null
          else if (/^\d{4}-\d{2}-\d{2}$/.test(due)) body.due_date = due
          else throw new Error('due_date 应为 YYYY-MM-DD 或空字符串')
        }
        if (args.done !== undefined) {
          const v = String(args.done).trim().toLowerCase()
          if (v === 'true' || v === 'false') body.done = v === 'true'
          else throw new Error('done 应为 "true" 或 "false"')
        }
        if (args.project !== undefined) {
          if (!Number.isInteger(args.project) || args.project < 0) throw new Error('project 应为项目编号或 0（取消关联）')
          body.project = args.project === 0 ? null : args.project
        }
        if (!Object.keys(body).length) throw new Error('update 至少需要提供一个待修改字段')
        const updated = await api(ctx, config, { method: 'PATCH', path: `/api/v1/plan-items/${args.id}/`, body, signal })
        return {
          action,
          text: `已更新计划 #${updated.id}：${updated.title} [${updated.done ? '已完成' : '未完成'}]${updated.due_date ? ` 截止 ${updated.due_date}` : ''}`,
        }
      }
      throw new Error(`未知 action：${action}`)
    },
  })
  ctx.tools.register({
    name: 'aecpt_report',
    description:
      'Student learning/research progress loop on the AeCpt server. Actions: '
      + 'periods (current FNU teaching week and term list), '
      + 'list (your progress entries; optional project id filter), '
      + 'detail (content, revision and supervisor feedback), '
      + 'summaries (progress fragments collected in a week\'s report by id), '
      + 'add_summary (append a concise progress fragment to a teaching week; period defaults to current week), '
      + 'create (draft for an FNU teaching week code like 26FA13W), '
      + 'edit (draft only; must pass current integer revision), '
      + 'submit (locks the report and uploads collected fragments; repeat calls are safe).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'detail', 'create', 'edit', 'submit', 'summaries', 'add_summary', 'periods'],
          description: 'Which operation to run.',
        },
        id: { type: 'integer', description: 'Report id; required for detail/edit/submit/summaries.' },
        period: { type: 'string', description: 'FNU teaching week code like 26FA13W; required for create, optional for add_summary (defaults to current week).' },
        project: { type: 'integer', description: 'Project id: optional on create, filter on list.' },
        content: { type: 'string', description: 'Report body for create/edit, or fragment Markdown for add_summary.' },
        revision: { type: 'integer', description: 'Expected current revision for edit; a mismatch answers 409 with the latest snapshot.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string' },
          periods: {
            type: 'object',
            properties: {
              current: { type: 'object', properties: { period: { type: 'string' }, label: { type: 'string' } } },
              weeks: { type: 'array', items: { type: 'object', properties: { period: { type: 'string' }, label: { type: 'string' } } } },
            },
          },
          reports: { type: 'array', items: { type: 'object', properties: REPORT_SUMMARY_FIELDS } },
          report: {
            type: 'object',
            properties: {
              ...REPORT_SUMMARY_FIELDS,
              content: { type: 'string' },
              submitted_at: { type: 'string' },
              feedback: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    author: { type: 'string' },
                    content: { type: 'string' },
                    created_at: { type: 'string' },
                  },
                },
              },
            },
          },
          summaries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                session_id: { type: 'string' },
                created_at: { type: 'string' },
                model: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
          record: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              created_at: { type: 'string' },
              summary: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => renderReportValue(value),
    },
    async execute(args, exec) {
      const { action, id, period, project, content, revision } = args
      const need = (cond, msg) => { if (!cond) throw new Error(msg) }
      const signal = exec.signal
      if (action === 'periods') {
        const data = await api(ctx, config, { method: 'GET', path: '/api/v1/academic-periods/', signal })
        return {
          action,
          periods: {
            current: data?.current ? { period: data.current.period, label: data.current.label || data.current.period } : null,
            weeks: Array.isArray(data?.weeks)
              ? data.weeks.map(w => ({ period: w.period, label: w.label || w.period }))
              : [],
          },
        }
      }
      if (action === 'list') {
        const params = new URLSearchParams()
        if (project !== undefined) params.set('project', String(project))
        const qs = params.toString()
        const rows = await api(ctx, config, { method: 'GET', path: `/api/v1/reports/${qs ? `?${qs}` : ''}`, signal })
        return { action, reports: rows.map(summarize) }
      }
      if (action === 'add_summary') {
        need(typeof content === 'string' && content.trim().length > 0, 'add_summary 需要非空 content')
        const binding = await readBinding(ctx, config)
        need(binding, '尚未连接 aecpt 服务器：先调用 aecpt_authorize')
        let targetPeriod = typeof period === 'string' ? period.trim() : ''
        if (!targetPeriod) {
          const auto = await resolveAutoPeriod(binding)
          targetPeriod = auto?.period || ''
        }
        need(targetPeriod, '无法自动确定当前教学周，请显式传入 period（如 26FA13W）')
        const result = await addManualSummary(binding, { period: targetPeriod, summary: content })
        if (result.status >= 400) throw apiError(result, result.payload, '')
        return {
          action,
          record: {
            id: result.payload.record.id,
            created_at: result.payload.record.created_at || '',
            summary: result.payload.record.summary,
          },
          report: detailOf(result.payload.report),
        }
      }
      if (action === 'create') {
        need(typeof period === 'string' && period.length > 0, 'create 需要 period（如 26FA13W）')
        const body = { period }
        if (project !== undefined) body.project = project
        if (content !== undefined) body.content = content
        const report = await api(ctx, config, { method: 'POST', path: '/api/v1/reports/', body, signal })
        return { action, report: detailOf(report) }
      }
      need(Number.isInteger(id), '该操作需要整数 id')
      if (action === 'detail') {
        const report = await api(ctx, config, { method: 'GET', path: `/api/v1/reports/${id}/`, signal })
        return { action, report: detailOf(report) }
      }
      if (action === 'summaries') {
        const binding = await readBinding(ctx, config)
        need(binding, '尚未连接 aecpt 服务器：先调用 aecpt_authorize')
        const store = await syncNow(binding)
        const local = store.reports[String(id)]
        const report = local
          ? reportDetail(local)
          : await api(ctx, config, { method: 'GET', path: `/api/v1/reports/${id}/`, signal })
        const records = Array.isArray(report.summary_records) ? report.summary_records : []
        return {
          action,
          summaries: records.map(rec => ({
            id: String(rec.id || ''),
            session_id: String(rec.session_id || ''),
            created_at: String(rec.created_at || ''),
            model: String(rec.model || ''),
            summary: String(rec.summary || ''),
          })),
        }
      }
      if (action === 'edit') {
        need(Number.isInteger(revision), 'edit 需要整数 revision（先用 detail 读取当前修订号）')
        const body = { revision }
        if (content !== undefined) body.content = content
        const report = await api(ctx, config, { method: 'PATCH', path: `/api/v1/reports/${id}/`, body, signal })
        return { action, report: detailOf(report) }
      }
      if (action === 'submit') {
        const binding = await readBinding(ctx, config)
        need(binding, '尚未连接 aecpt 服务器：先调用 aecpt_authorize')
        const result = await submitReport(binding, id, { signal })
        if (result.status >= 400) throw apiError(result, result.payload, result.text || '')
        return { action, report: detailOf(result.payload) }
      }
      throw new Error(`未知 action：${action}`)
    },
  })
}
