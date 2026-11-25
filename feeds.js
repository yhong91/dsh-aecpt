/**
 * Personal literature subscriptions for the student workbench.
 *
 * Sources and fetched entries stay on this device, one file per AeCpt
 * account under ~/.aecpt/dsh. Supported feeds: journal RSS 2.0 / RDF / Atom
 * (CNKI, Elsevier, IEEE, Springer…), arXiv API category queries (Atom) and
 * research blog RSS. Parsing follows dsh-conflux's `parseFeed` semantics
 * (dedupe by link, bounded entries, UTC+8 dates, tag-free summaries) with a
 * dependency-free reader, because this linked bundle ships no runtime
 * packages. Fetching only reaches public http(s) hosts.
 */

import { createHash, randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { DATA_DIR, storeKey } from './store.js'

export const FEED_KINDS = Object.freeze({
  journal: '期刊',
  arxiv: 'arXiv',
  blog: '博客资讯',
})

export const ARXIV_PRESETS = Object.freeze([
  ['cs.AI', '人工智能'],
  ['cs.HC', '人机交互'],
  ['cs.CL', '计算语言学'],
  ['cs.CV', '计算机视觉'],
  ['cs.GR', '计算机图形学'],
  ['cs.MM', '多媒体'],
  ['cs.CY', '计算机与社会'],
].map(([category, label]) => Object.freeze({
  category,
  name: `arXiv · ${category} ${label}`,
  url: `https://export.arxiv.org/api/query?search_query=cat:${category}&sortBy=submittedDate&sortOrder=descending&max_results=30`,
})))

const MAX_SOURCES = 30
const MAX_ITEMS_PER_SOURCE = 50
const MAX_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT = 15_000
const MAX_REDIRECTS = 3
const REFRESH_CONCURRENCY = 3

export class FeedError extends Error {
  constructor(status, code, detail) {
    super(detail)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------- parsing

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

/** Inner XML text of an element with CDATA unwrapped (still escaped). */
function unwrapCdata(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) =>
    inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
}

/** Plain text: decode one XML layer, then drop any embedded HTML. */
export function plainText(raw) {
  const xmlText = decodeEntities(unwrapCdata(String(raw ?? '')))
  const withoutTags = xmlText.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim()
}

function tagPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<${escaped}(\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i')
}

export function firstText(block, names) {
  for (const name of names) {
    const match = block.match(tagPattern(name))
    if (match) return match[2]
  }
  return ''
}

export function allTexts(block, name) {
  const pattern = new RegExp(tagPattern(name).source, 'gi')
  return [...block.matchAll(pattern)].map(match => match[2])
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  return match ? decodeEntities(match[2] ?? match[3] ?? '') : ''
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map(match => match[0])
  const alternate = links.find(tag => /\srel\s*=\s*["']alternate["']/i.test(tag))
    ?? links.find(tag => !/\srel\s*=/i.test(tag))
    ?? links[0]
  return alternate ? attribute(alternate, 'href') : ''
}

/** Feed dates (RFC 822 / ISO 8601) as a UTC+8 calendar date. */
function feedDate(raw) {
  const text = plainText(raw)
  if (!text) return null
  const time = new Date(text).getTime()
  if (Number.isNaN(time)) return null
  return new Date(time + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function itemKey(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 16)
}

/** Parse RSS 2.0 / RDF and Atom feeds into bounded, deduped entries. */
export function parseFeed(xml, baseUrl) {
  const text = String(xml ?? '')
  const items = []
  const seen = new Set()
  const push = ({ title, link, date, summary, authors }) => {
    const label = plainText(title)
    const linkText = plainText(link)
    if (!label || !linkText) return
    let url = ''
    try { url = new URL(linkText, baseUrl).href } catch { return }
    if (!/^https?:/i.test(url) || seen.has(url)) return
    seen.add(url)
    items.push({
      key: itemKey(url),
      title: label.slice(0, 300),
      url,
      publishedAt: feedDate(date),
      summary: plainText(summary).slice(0, 600),
      authors: authors.map(plainText).filter(Boolean).slice(0, 8).join(', ').slice(0, 200),
    })
  }
  for (const match of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]
    push({
      title: firstText(block, ['title']),
      link: firstText(block, ['link']) || firstText(block, ['guid']),
      date: firstText(block, ['pubDate', 'dc:date', 'prism:publicationDate', 'prism:coverDate']),
      summary: firstText(block, ['description', 'content:encoded', 'dc:description']),
      authors: [...allTexts(block, 'dc:creator'), ...allTexts(block, 'author')],
    })
  }
  for (const match of text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const block = match[1]
    push({
      title: firstText(block, ['title']),
      link: atomLink(block),
      date: firstText(block, ['published', 'updated']),
      summary: firstText(block, ['summary', 'content']),
      authors: allTexts(block, 'author').map(author => firstText(author, ['name']) || author),
    })
  }
  return items.slice(0, MAX_ITEMS_PER_SOURCE)
}

export function feedTitle(xml) {
  const text = String(xml ?? '')
  const channel = text.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i)?.[1]
  const head = channel ?? text.replace(/<entry\b[\s\S]*$/i, '')
  return plainText(firstText(head, ['title'])).slice(0, 80)
}

// --------------------------------------------------------------- fetching

function privateAddress(address) {
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (version === 6) {
    const value = address.toLowerCase()
    if (value.startsWith('::ffff:')) return privateAddress(value.slice(7))
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
      || value.startsWith('ff')
  }
  return true
}

/** Subscriptions only reach public hosts; this Host runs on the student's machine. */
export async function assertPublicUrl(raw, { lookup = dnsLookup } = {}) {
  let url
  try { url = new URL(String(raw ?? '').trim()) } catch {
    throw new FeedError(400, 'invalid_feed_url', '请输入完整的订阅链接（以 http:// 或 https:// 开头）')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new FeedError(400, 'invalid_feed_url', '订阅链接只支持 http/https，且不能包含账号密码')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new FeedError(400, 'private_feed_host', '订阅链接必须是公网地址')
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
    throw new FeedError(502, 'feed_unreachable', `无法解析域名：${host}`)
  })
  if (!addresses.length || addresses.some(entry => privateAddress(entry.address))) {
    throw new FeedError(400, 'private_feed_host', '订阅链接必须是公网地址')
  }
  url.hash = ''
  return url
}

async function readLimited(response) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new FeedError(502, 'feed_too_large', '订阅内容超过 2 MiB')
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

export async function fetchFeed(raw, { fetchImpl = fetch, lookup = dnsLookup } = {}) {
  let url = await assertPublicUrl(raw, { lookup })
  const signal = AbortSignal.timeout(FETCH_TIMEOUT)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response
    try {
      response = await fetchImpl(url.href, {
        redirect: 'manual',
        signal,
        headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', 'User-Agent': 'AeCpt-DSH-Feeds/1.0' },
      })
    } catch (error) {
      throw new FeedError(502, 'feed_unreachable', error?.name === 'TimeoutError' ? '抓取超时' : '无法连接订阅源')
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = await assertPublicUrl(new URL(response.headers.get('location'), url).href, { lookup })
      continue
    }
    if (!response.ok) throw new FeedError(502, 'feed_http_error', `订阅源返回 HTTP ${response.status}`)
    return { text: await readLimited(response), url: url.href }
  }
  throw new FeedError(502, 'feed_redirect_loop', '订阅源重定向次数过多')
}

// ---------------------------------------------------------------- storage

function feedsPath(binding) {
  return join(DATA_DIR, `feeds-${storeKey(binding)}.json`)
}

export function loadFeeds(binding) {
  const path = feedsPath(binding)
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      return { sources: value.sources ?? [], items: value.items ?? {}, reads: value.reads ?? {} }
    } catch {
      // A corrupt file starts over instead of blocking the panel.
    }
  }
  return { sources: [], items: {}, reads: {} }
}

function saveFeeds(binding, data) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const path = feedsPath(binding)
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 1), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

const locks = new Map()
function withFeedLock(binding, operation) {
  const path = feedsPath(binding)
  const current = (locks.get(path) ?? Promise.resolve()).catch(() => {}).then(operation)
  locks.set(path, current)
  return current.finally(() => { if (locks.get(path) === current) locks.delete(path) })
}

// ------------------------------------------------------------- operations

function sourceView(source, data) {
  const items = data.items[source.id] ?? []
  return {
    ...source,
    kindLabel: FEED_KINDS[source.kind] ?? source.kind,
    itemCount: items.length,
    unreadCount: items.filter(item => !data.reads[`${source.id}:${item.key}`]).length,
  }
}

export function listFeeds(binding, { sourceId, unread = false, limit = 200 } = {}) {
  const data = loadFeeds(binding)
  const names = new Map(data.sources.map(source => [source.id, source.name]))
  const rows = []
  for (const source of data.sources) {
    if (sourceId && source.id !== sourceId) continue
    for (const item of data.items[source.id] ?? []) {
      const read = Boolean(data.reads[`${source.id}:${item.key}`])
      if (unread && read) continue
      rows.push({ ...item, sourceId: source.id, sourceName: names.get(source.id), kind: source.kind, read })
    }
  }
  rows.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
  const sources = data.sources.map(source => sourceView(source, data))
  return {
    sources,
    items: rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 200))),
    unreadCount: sources.reduce((total, source) => total + source.unreadCount, 0),
    presets: ARXIV_PRESETS,
  }
}

export async function addSource(binding, { name = '', url, kind = 'journal' }, options = {}) {
  if (!FEED_KINDS[kind]) throw new FeedError(400, 'invalid_feed_kind', '订阅类型应为期刊、arXiv 或博客资讯')
  const label = String(name ?? '').trim()
  if (label.length > 80) throw new FeedError(400, 'invalid_feed_name', '名称最多 80 个字符')
  const normalized = (await assertPublicUrl(url, options)).href
  // Validate by fetching once so a wrong link fails here, not silently later.
  const fetched = await fetchFeed(normalized, options)
  const items = parseFeed(fetched.text, fetched.url)
  if (!items.length) throw new FeedError(400, 'not_a_feed', '没有从这个链接读到 RSS 或 Atom 条目，请确认是订阅链接')
  return withFeedLock(binding, async () => {
    const data = loadFeeds(binding)
    if (data.sources.some(source => source.url === normalized)) {
      throw new FeedError(409, 'feed_exists', '这个订阅已经添加过')
    }
    if (data.sources.length >= MAX_SOURCES) throw new FeedError(400, 'too_many_feeds', `最多添加 ${MAX_SOURCES} 个订阅`)
    const source = {
      id: `feed:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`,
      name: label || feedTitle(fetched.text) || new URL(normalized).hostname,
      url: normalized,
      kind,
      addedAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
      lastError: '',
    }
    data.sources.push(source)
    data.items[source.id] = items
    saveFeeds(binding, data)
    return sourceView(source, data)
  })
}

export function removeSource(binding, sourceId) {
  return withFeedLock(binding, async () => {
    const data = loadFeeds(binding)
    if (!data.sources.some(source => source.id === sourceId)) throw new FeedError(404, 'feed_not_found', '没有这个订阅')
    data.sources = data.sources.filter(source => source.id !== sourceId)
    delete data.items[sourceId]
    for (const key of Object.keys(data.reads)) if (key.startsWith(`${sourceId}:`)) delete data.reads[key]
    saveFeeds(binding, data)
    return { removed: sourceId }
  })
}

export async function refreshFeeds(binding, { sourceId } = {}, options = {}) {
  const sources = loadFeeds(binding).sources.filter(source => !sourceId || source.id === sourceId)
  if (sourceId && !sources.length) throw new FeedError(404, 'feed_not_found', '没有这个订阅')
  const results = new Map()
  let next = 0
  async function worker() {
    while (next < sources.length) {
      const source = sources[next++]
      try {
        const fetched = await fetchFeed(source.url, options)
        results.set(source.id, { items: parseFeed(fetched.text, fetched.url), error: '' })
      } catch (error) {
        results.set(source.id, { error: String(error?.detail || error?.message || error) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, sources.length) }, worker))
  return withFeedLock(binding, async () => {
    const data = loadFeeds(binding)
    const now = new Date().toISOString()
    let added = 0
    for (const source of data.sources) {
      const result = results.get(source.id)
      if (!result) continue
      source.lastFetchedAt = now
      source.lastError = result.error
      if (result.error) continue
      const known = new Set((data.items[source.id] ?? []).map(item => item.key))
      added += result.items.filter(item => !known.has(item.key)).length
      // Keep entries that dropped out of the feed until the cap is reached.
      const merged = [...result.items, ...(data.items[source.id] ?? []).filter(item =>
        !result.items.some(fresh => fresh.key === item.key))]
      data.items[source.id] = merged.slice(0, MAX_ITEMS_PER_SOURCE)
      const keep = new Set(data.items[source.id].map(item => `${source.id}:${item.key}`))
      for (const key of Object.keys(data.reads)) {
        if (key.startsWith(`${source.id}:`) && !keep.has(key)) delete data.reads[key]
      }
    }
    saveFeeds(binding, data)
    return {
      refreshed: results.size,
      failed: [...results.values()].filter(result => result.error).length,
      added,
    }
  })
}

export function findFeedItem(binding, sourceId, key) {
  const data = loadFeeds(binding)
  const source = data.sources.find(entry => entry.id === sourceId)
  const item = (data.items[sourceId] ?? []).find(entry => entry.key === key)
  if (!source || !item) throw new FeedError(404, 'feed_item_not_found', '这条订阅已不在本机缓存中，请刷新后重试')
  return { source, item }
}

export function markRead(binding, { sourceId, key, read = true }) {
  return withFeedLock(binding, async () => {
    findFeedItem(binding, sourceId, key)
    const data = loadFeeds(binding)
    const mark = `${sourceId}:${key}`
    if (read) data.reads[mark] = new Date().toISOString()
    else delete data.reads[mark]
    saveFeeds(binding, data)
    return { sourceId, key, read: Boolean(read) }
  })
}
