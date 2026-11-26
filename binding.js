/**
 * Binding, identity and browser-authorization helpers for the student Host.
 *
 * A binding is the credential record that connects this DSH to one AeCpt
 * account. Each successful authorization writes a fresh random `bindingId`;
 * the panel echoes it on every request so a view opened for an earlier
 * binding cannot act on a later one. Account identity (server database
 * identity + server user id) decides whether a reconnect resumes the
 * existing local cache or needs the user's explicit confirmation.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lastAccount, localWorkSummary, rememberAccount } from './store.js'

export const DEFAULT_SERVER_URL = ''
export const RECORD_KEY = 'dsh-aecpt/default'
export const LEGACY_RECORD_KEY = 'dsh-aecompute/default'
export const CLIENT_ID = 'aecpt-dsh-plugin'

const INVITATION_PATH_RE = /^\/invitations\/[A-Za-z0-9_-]{20,}(?:\/register)?\/?$/

export class ProxyError extends Error {
  constructor(status, code, detail, extra = {}) {
    super(detail || code)
    this.status = status
    this.code = code
    this.detail = detail
    this.extra = extra
  }
}

export function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

/** Extract a clean HTTP(S) server origin from either a supervisor invitation
 * link (e.g. `https://host/invitations/<token>/`) or a bare server URL. */
export function parseServerInput(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return { serverUrl: '', invitationUrl: '' }
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new ProxyError(400, 'invalid_server_url', '请输入有效的导师邀请链接或服务器地址（需以 http:// 或 https:// 开头）')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new ProxyError(400, 'invalid_server_url', '请输入有效的 HTTP(S) 导师邀请链接或服务器地址，且不能包含账号密码')
  }
  const serverUrl = url.origin
  const invitationUrl = INVITATION_PATH_RE.test(url.pathname) ? `${url.origin}${url.pathname}` : ''
  return { serverUrl, invitationUrl }
}

/** Resolve the target server origin from user input (invitation link or URL)
 * or fallback values; throws 400 `server_url_required` when none is available. */
export function resolveServerBase(rawInput, ...fallbacks) {
  const input = String(rawInput || '').trim()
  if (input) return parseServerInput(input).serverUrl
  for (const candidate of fallbacks) {
    const trimmed = String(candidate || '').trim()
    if (!trimmed) continue
    try {
      const { serverUrl } = parseServerInput(trimmed)
      if (serverUrl) return serverUrl
    } catch {
      // Ignore malformed fallback and keep searching.
    }
  }
  throw new ProxyError(400, 'server_url_required', '请先粘贴导师发来的邀请链接或服务器地址')
}

export async function parseBody(res) {
  const text = await res.text()
  try {
    return { data: JSON.parse(text), text }
  } catch {
    return { data: null, text }
  }
}

export function apiError(res, data, text) {
  const err = data?.error
  const code = err?.code || `http_${res.status}`
  if (code === 'authentication_failed') {
    return new Error('令牌无效或已撤销：请调用 aecpt_authorize 重新授权')
  }
  return new Error(`aecpt ${code}: ${err?.detail || String(text || '').slice(0, 200)}`)
}

export function pkcePair() {
  const verifier = randomBytes(36).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function authorizePath(base, state, challenge) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${base}/oauth/plugin-done/`,
    scope: 'api',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `/oauth/authorize/?${params.toString()}`
}

export function authorizeUrl(base, state, challenge) {
  return `${base}${authorizePath(base, state, challenge)}`
}

/** Build the single browser entry URL: when the user pasted an invitation link
 * on the same server, chain `/invitations/<token>/?oauth_next=/oauth/authorize/...`
 * so registration, invitation acceptance, and OAuth consent happen in one hop. */
export function buildEntryAuthUrl(base, state, challenge, invitationUrl = '') {
  const oauthPath = authorizePath(base, state, challenge)
  const rawInv = String(invitationUrl || '').trim()
  if (rawInv) {
    try {
      const inv = new URL(rawInv)
      if (inv.origin === base) {
        const cleanPath = inv.pathname.replace(/\/register\/?$/, '/').replace(/\/?$/, '/')
        const params = new URLSearchParams({ oauth_next: oauthPath })
        return `${base}${cleanPath}?${params.toString()}`
      }
    } catch {
      // Fall back to direct OAuth authorize URL.
    }
  }
  return `${base}${oauthPath}`
}

/** Register a short-lived server-side PKCE polling session so the plugin can
 * finish connecting without asking the user to copy/paste a code. Returns null
 * when talking to an older server that only supports manual paste. */
export async function createAuthSession(base, state, signal) {
  try {
    const res = await fetch(`${base}/api/v1/auth/plugin-sessions/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ state }),
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const { data } = await parseBody(res)
    if (typeof data?.poll_secret !== 'string' || !data.poll_secret) return null
    const interval = Number(data.poll_interval_ms)
    return {
      pollSecret: data.poll_secret,
      pollIntervalMs: Number.isFinite(interval) && interval >= 1000 ? Math.min(interval, 10_000) : 2000,
    }
  } catch {
    return null
  }
}

export async function pollAuthSession(base, state, pollSecret, signal) {
  const res = await fetch(`${base}/api/v1/auth/plugin-sessions/poll/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ state, poll_secret: pollSecret }),
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  const body = await parseBody(res)
  if (!res.ok) throw apiError(res, body.data, body.text)
  return body.data || { status: 'expired' }
}

/** Exchange the authorization code (PKCE) and swap the OAuth token for an
 * ApiToken, so API calls keep one credential type and one revocation path. */
export async function exchangeAndMint(base, code, verifier, signal) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${base}/oauth/plugin-done/`,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  })
  const tokenRes = await fetch(`${base}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  const tokenBody = await parseBody(tokenRes)
  if (!tokenRes.ok) {
    if (tokenRes.status === 400 || tokenRes.status === 401) {
      throw new ProxyError(400, 'invalid_auth_code', '一次性代码无效或已过期，请重新授权')
    }
    throw new Error(`授权码交换失败：${tokenBody.data?.error || tokenBody.text.slice(0, 160)}`)
  }
  const exchangeRes = await fetch(`${base}/api/v1/auth/tokens/exchange/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenBody.data.access_token}`,
    },
    body: JSON.stringify({ name: 'DSH 插件（浏览器授权）' }),
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  const exchangeBody = await parseBody(exchangeRes)
  if (!exchangeRes.ok) throw apiError(exchangeRes, exchangeBody.data, exchangeBody.text)
  return exchangeBody.data
}

/** Server-confirmed identity behind a token. */
export async function fetchProfile(base, token, signal) {
  const res = await fetch(`${base}/api/v1/me/`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  const body = await parseBody(res)
  if (!res.ok) throw apiError(res, body.data, body.text)
  const me = body.data || {}
  return {
    userId: me.id ?? null,
    username: me.username || '',
    fullName: me.full_name || '',
    studentNumber: me.student_number || '',
    serverInstance: me.server_instance || '',
  }
}

/** Best effort: end a token we no longer keep. Older servers lack the
 * endpoint; failures leave the token to server-side revocation. */
export async function revokeToken(base, token) {
  try {
    await fetch(`${base}/api/v1/auth/tokens/current/revoke/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // Offline or unsupported: nothing more to do locally.
  }
}

function legacyBindingId(serverUrl, token) {
  return createHash('sha256').update(JSON.stringify([serverUrl, token])).digest('base64url')
}

export function bindingFromPayload(payload, config = {}) {
  if (!payload?.token) return null
  const serverUrl = normalizeBase(payload.serverUrl || config.serverUrl || DEFAULT_SERVER_URL)
  return {
    token: payload.token,
    tokenId: payload.tokenId,
    serverUrl,
    username: payload.username || '',
    userId: payload.userId ?? null,
    fullName: payload.fullName || '',
    studentNumber: payload.studentNumber || '',
    serverInstance: payload.serverInstance || '',
    bindingId: payload.bindingId || legacyBindingId(serverUrl, payload.token),
  }
}

function sameServer(a, b) {
  if (a.serverInstance && b.serverInstance) return a.serverInstance === b.serverInstance
  return normalizeBase(a.serverUrl) === normalizeBase(b.serverUrl)
}

/** Same person on the same database. Names, student numbers and usernames
 * may change; the server user id does not. */
export function sameAccount(a, b) {
  if (a.userId !== null && a.userId !== undefined && b.userId !== null && b.userId !== undefined) {
    return sameServer(a, b) && String(a.userId) === String(b.userId)
  }
  return normalizeBase(a.serverUrl) === normalizeBase(b.serverUrl) && a.username === b.username
}

export function accountLabel(account) {
  const name = account.fullName || account.username || '未知账号'
  return account.studentNumber ? `${name}（${account.studentNumber}）` : name
}

export function describeAccount(account) {
  return {
    fullName: account.fullName || '',
    username: account.username || '',
    studentNumber: account.studentNumber || '',
    serverUrl: account.serverUrl || '',
    ...localWorkSummary(account),
  }
}

export async function readBindingRecord(ctx) {
  const current = await ctx.credentials.readRecord(RECORD_KEY)
  if (current?.payload?.token) return current
  const legacy = await ctx.credentials.readRecord(LEGACY_RECORD_KEY)
  if (!legacy?.payload?.token) return current
  await ctx.credentials.modifyRecord(RECORD_KEY, async () => legacy)
  await ctx.credentials.deleteRecord(LEGACY_RECORD_KEY)
  return legacy
}

export async function readBinding(ctx, config) {
  return bindingFromPayload((await readBindingRecord(ctx))?.payload, config)
}

export async function deleteBindingRecords(ctx) {
  await ctx.credentials.deleteRecord(RECORD_KEY)
  await ctx.credentials.deleteRecord(LEGACY_RECORD_KEY)
}

// Order credential changes so a slow authorization cannot overwrite a newer
// binding or race a disconnect.
let bindingChanges = Promise.resolve()
export function changeBinding(action) {
  const next = bindingChanges.then(action)
  bindingChanges = next.catch(() => {})
  return next
}

/** The account a reconnect is compared with: the stored binding (even with
 * an expired token), else the last account this device was bound to. */
export async function previousAccount(ctx, config) {
  return (await readBinding(ctx, config)) ?? lastAccount()
}

export async function commitBinding(ctx, base, minted, profile) {
  return changeBinding(async () => {
    const previous = await readBinding(ctx, {})
    const payload = {
      token: minted.token,
      tokenId: minted.id,
      username: profile.username,
      userId: profile.userId,
      fullName: profile.fullName,
      studentNumber: profile.studentNumber,
      serverUrl: base,
      serverInstance: profile.serverInstance,
      bindingId: randomUUID(),
    }
    await ctx.credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload }))
    await ctx.credentials.deleteRecord(LEGACY_RECORD_KEY)
    rememberAccount(payload)
    if (previous && previous.token !== minted.token) void revokeToken(previous.serverUrl, previous.token)
    return { connected: true, username: payload.username, serverUrl: base, tokenId: minted.id }
  })
}

/** Agent-tool and settings-flow sign-in: these paths never switch accounts
 * silently; switching requires the confirmation dialog in the panel. */
export async function commitFromTool(ctx, config, base, minted, signal) {
  const profile = { ...(await fetchProfile(base, minted.token, signal)), serverUrl: base }
  const previous = await previousAccount(ctx, config)
  if (previous && !sameAccount(previous, profile)) {
    await revokeToken(base, minted.token)
    throw new Error(`本机已绑定或缓存 ${accountLabel(previous)} 的工作台数据；要改用 ${accountLabel(profile)}，请在 AeCpt 面板中重新授权并确认切换`)
  }
  return commitBinding(ctx, base, minted, profile)
}

const upgradeAttempts = new Map()

/** Bindings saved before identity fields existed gain a user id and a
 * random binding id on the next online status check. */
export async function upgradeLegacyBinding(ctx, config) {
  if (typeof ctx.credentials.modifyRecord !== 'function') return
  const payload = (await readBindingRecord(ctx))?.payload
  if (!payload?.token || (payload.userId !== null && payload.userId !== undefined && payload.bindingId)) return
  const last = upgradeAttempts.get(payload.token) ?? 0
  if (Date.now() - last < 60_000) return
  upgradeAttempts.set(payload.token, Date.now())
  const base = normalizeBase(payload.serverUrl || config.serverUrl || DEFAULT_SERVER_URL)
  let profile
  try {
    profile = await fetchProfile(base, payload.token, AbortSignal.timeout(5_000))
  } catch {
    return
  }
  if (profile.userId === null) return
  await changeBinding(async () => {
    let upgraded = null
    await ctx.credentials.modifyRecord(RECORD_KEY, async current => {
      if (current?.payload?.token !== payload.token) return current
      upgraded = {
        ...current.payload,
        userId: profile.userId,
        username: profile.username || current.payload.username,
        fullName: profile.fullName,
        studentNumber: profile.studentNumber,
        serverInstance: profile.serverInstance,
        serverUrl: base,
        bindingId: current.payload.bindingId || randomUUID(),
      }
      return { ...current, payload: upgraded }
    })
    if (upgraded) rememberAccount(upgraded)
  })
}
