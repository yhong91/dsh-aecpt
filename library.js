/**
 * Shared paper library: Host-side helpers for the AeCpt server library API.
 *
 * Metadata resolution (Crossref for DOIs, the arXiv API for arXiv ids) and
 * arXiv PDF downloads run here, on the student's machine, through the same
 * public-host guard as literature subscriptions; the server never fetches
 * external URLs. Submissions are rebuilt as multipart/form-data for the
 * server with the bound token. PDFs downloaded for the agent land under
 * ~/.aecpt/library/<account key>/. No runtime dependencies.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ProxyError } from './binding.js'
import { FeedError, allTexts, assertPublicUrl, firstText, plainText } from './feeds.js'
import { LIBRARY_DIR, storeKey } from './store.js'

export const MAX_PDF_BYTES = 50 * 1024 * 1024
/** Host-side JSON body cap for submissions: base64 of a 50 MiB PDF plus metadata. */
export const SUBMIT_BODY_LIMIT = 75 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
const META_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT = 15_000
const PDF_TIMEOUT = 120_000
const UPLOAD_TIMEOUT = 180_000
const MAX_REDIRECTS = 3
const USER_AGENT = 'AeCpt-DSH-Library/1.0'
const HOME = homedir()

export const PAPER_STATUS = Object.freeze({ pending: '待审核', approved: '已入库', rejected: '未通过' })

/** Network seam for external metadata/PDF fetches (tests replace it). Calls
 * to the bound AeCpt server use the global fetch directly. */
export const network = {
  fetch: (...args) => globalThis.fetch(...args),
  lookup: dnsLookup,
}

// ------------------------------------------------------------ identifiers

const ARXIV_NEW = /^(\d{4}\.\d{4,5})(v\d+)?$/i
const ARXIV_OLD = /^([a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i
const DOI_RE = /^10\.\d{4,9}\/\S+$/i

const invalidIdentifier = () => new ProxyError(400, 'invalid_identifier',
  '无法识别：请输入 DOI（10.xxxx/…）、doi.org 链接、arXiv 编号（如 2611.01234）或 arxiv.org 链接')

function safeDecode(text) {
  try { return decodeURIComponent(text) } catch { throw invalidIdentifier() }
}

/** DOI / doi.org URL / arXiv id / arxiv.org abs|pdf URL -> {kind, …}. */
export function parseIdentifier(raw) {
  let text = String(raw ?? '').trim()
  if (!text) throw new ProxyError(400, 'identifier_required', '请输入 DOI 或 arXiv 编号/链接')
  if (text.length > 500) throw invalidIdentifier()
  if (/^https?:\/\//i.test(text)) {
    let url
    try { url = new URL(text) } catch { throw invalidIdentifier() }
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'doi.org' || host === 'dx.doi.org') {
      text = safeDecode(url.pathname.slice(1))
    } else if (host === 'arxiv.org' || host === 'export.arxiv.org') {
      const match = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i)
      if (!match) throw invalidIdentifier()
      text = `arXiv:${safeDecode(match[1])}`
    } else {
      throw invalidIdentifier()
    }
  }
  text = text.replace(/^doi:\s*/i, '').trim()
  const arxivDoi = text.match(/^10\.48550\/arxiv\.(.+)$/i)
  const candidate = arxivDoi ? arxivDoi[1] : text.replace(/^arxiv:\s*/i, '')
  const match = candidate.match(ARXIV_NEW) || candidate.match(ARXIV_OLD)
  if (match) return { kind: 'arxiv', id: match[1], version: (match[2] || '').toLowerCase() }
  if (DOI_RE.test(text)) return { kind: 'doi', doi: text.toLowerCase() }
  throw invalidIdentifier()
}

// --------------------------------------------------------------- fetching

async function guardUrl(raw) {
  try {
    return await assertPublicUrl(raw, { lookup: network.lookup })
  } catch (error) {
    if (error instanceof FeedError) {
      if (error.code === 'feed_unreachable') {
        throw new ProxyError(502, 'library_network', `${error.detail}：网络可能不可用或被阻断`)
      }
      throw new ProxyError(400, 'library_private_host', '只允许访问公网地址')
    }
    throw error
  }
}

function networkError(error, label, host) {
  if (error instanceof ProxyError) return error
  return new ProxyError(502, 'library_network', error?.name === 'TimeoutError'
    ? `${label}超时，请稍后重试`
    : `无法连接 ${host}：网络可能不可用或被阻断`)
}

async function readCapped(response, maxBytes, tooLarge) {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ProxyError(502, 'library_too_large', tooLarge)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Fetch a public URL with redirect re-checks, a timeout and a size cap.
 * Returns {status: 404} for missing resources. */
async function publicFetch(raw, { accept, maxBytes, timeout = FETCH_TIMEOUT, label, tooLarge }) {
  let url = await guardUrl(raw)
  const signal = AbortSignal.timeout(timeout)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response
    try {
      response = await network.fetch(url.href, {
        redirect: 'manual', signal, headers: { Accept: accept, 'User-Agent': USER_AGENT },
      })
    } catch (error) {
      throw networkError(error, label, url.hostname)
    }
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      url = await guardUrl(new URL(location, url).href)
      continue
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {})
      return { status: 404 }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new ProxyError(502, 'library_upstream_http', `${label}返回 HTTP ${response.status}，请稍后重试`)
    }
    try {
      return { status: 200, body: await readCapped(response, maxBytes, tooLarge), url: url.href }
    } catch (error) {
      throw networkError(error, label, url.hostname)
    }
  }
  throw new ProxyError(502, 'library_redirect_loop', `${label}重定向次数过多`)
}

// --------------------------------------------------------------- metadata

const clip = (text, limit) => String(text ?? '').slice(0, limit).trim()

function emptyMetadata() {
  return { title: '', authors: [], year: null, venue: '', doi: '', arxiv_id: '', url: '', abstract: '' }
}

function validYear(value) {
  const year = Number(value)
  return Number.isInteger(year) && year >= 1800 && year <= 2100 ? year : null
}

async function resolveDoi(doi) {
  const path = doi.split('/').map(encodeURIComponent).join('/')
  const result = await publicFetch(`https://api.crossref.org/works/${path}`, {
    accept: 'application/json', maxBytes: META_BYTES, label: 'Crossref 查询', tooLarge: 'Crossref 响应过大',
  })
  if (result.status === 404) {
    throw new ProxyError(404, 'identifier_not_found', `Crossref 没有找到 DOI ${doi}，请检查是否输入正确`)
  }
  let message
  try { message = JSON.parse(result.body.toString('utf8'))?.message } catch { /* handled below */ }
  if (!message || typeof message !== 'object') {
    throw new ProxyError(502, 'library_bad_metadata', 'Crossref 返回的内容无法解析')
  }
  const first = value => (Array.isArray(value) ? value[0] : value) || ''
  let year = null
  for (const key of ['published', 'issued', 'published-print', 'published-online', 'created']) {
    year = validYear(message[key]?.['date-parts']?.[0]?.[0])
    if (year) break
  }
  const abstract = String(message.abstract || '').replace(/<jats:title\b[^>]*>[\s\S]*?<\/jats:title>/gi, ' ')
  return {
    metadata: {
      ...emptyMetadata(),
      title: clip(plainText(first(message.title)), 1000),
      authors: (Array.isArray(message.author) ? message.author : [])
        .map(author => plainText([author?.given, author?.family].filter(Boolean).join(' ') || author?.name || ''))
        .filter(Boolean).slice(0, 200).map(name => clip(name, 200)),
      year,
      venue: clip(plainText(first(message['container-title']) || message.event?.name || ''), 300),
      doi,
      url: clip(/^https?:\/\//i.test(String(message.URL || '')) ? message.URL : `https://doi.org/${doi}`, 1000),
      abstract: clip(plainText(abstract), 20000),
    },
    pdfUrl: null,
  }
}

async function resolveArxiv(id, version = '') {
  const queryId = id + version
  const result = await publicFetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(queryId)}&max_results=1`, {
    accept: 'application/atom+xml', maxBytes: META_BYTES, label: 'arXiv 查询', tooLarge: 'arXiv 响应过大',
  })
  const notFound = () => new ProxyError(404, 'identifier_not_found', `arXiv 没有找到编号 ${queryId}，请检查是否输入正确`)
  if (result.status === 404) throw notFound()
  const entry = result.body.toString('utf8').match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/i)?.[1]
  if (!entry || /\/api\/errors/i.test(firstText(entry, ['id']))) throw notFound()
  const title = plainText(firstText(entry, ['title']))
  if (!title || /^error$/i.test(title)) throw notFound()
  const published = new Date(plainText(firstText(entry, ['published'])))
  const doi = plainText(firstText(entry, ['arxiv:doi'])).toLowerCase()
  return {
    metadata: {
      ...emptyMetadata(),
      title: clip(title, 1000),
      authors: allTexts(entry, 'author').map(author => plainText(firstText(author, ['name']) || author))
        .filter(Boolean).slice(0, 200).map(name => clip(name, 200)),
      year: Number.isNaN(published.getTime()) ? null : validYear(published.getUTCFullYear()),
      venue: clip(plainText(firstText(entry, ['arxiv:journal_ref'])) || 'arXiv', 300),
      doi: DOI_RE.test(doi) && doi.length <= 255 ? doi : '',
      arxiv_id: id,
      url: `https://arxiv.org/abs/${queryId}`,
      abstract: clip(plainText(firstText(entry, ['summary'])), 20000),
    },
    pdfUrl: `https://arxiv.org/pdf/${queryId}`,
  }
}

/** Resolve a DOI or arXiv identifier into submission metadata. */
export async function resolveIdentifier(raw) {
  const parsed = parseIdentifier(raw)
  return parsed.kind === 'arxiv' ? resolveArxiv(parsed.id, parsed.version) : resolveDoi(parsed.doi)
}

// ------------------------------------------------------------- submission

const META_KEYS = ['title', 'authors', 'year', 'venue', 'doi', 'arxiv_id', 'url', 'abstract', 'tags', 'note']

/** Keep known metadata keys, drop empty values; the server validates the rest. */
export function submissionMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProxyError(400, 'invalid_metadata', '缺少论文信息')
  }
  const out = {}
  for (const key of META_KEYS) {
    let value = input[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      value = value.trim()
      if (!value) continue
      if (key === 'year') {
        if (!/^\d{4}$/.test(value)) throw new ProxyError(400, 'invalid_year', '年份应为 1800–2100 之间的整数')
        value = Number(value)
      }
    } else if (Array.isArray(value)) {
      value = [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))]
      if (!value.length) continue
    }
    out[key] = value
  }
  if (typeof out.title !== 'string' || !out.title) throw new ProxyError(400, 'invalid_title', '请填写论文标题')
  return out
}

function assertPdf(buffer, source = '文件') {
  if (!buffer?.length) throw new ProxyError(400, 'pdf_required', '请选择 PDF 文件')
  if (buffer.length > MAX_PDF_BYTES) throw new ProxyError(413, 'pdf_too_large', `${source}超过 50 MiB 上限`)
  if (!buffer.subarray(0, 1024).includes('%PDF-')) throw new ProxyError(400, 'invalid_pdf', `${source}不是有效的 PDF`)
  return buffer
}

export function decodePdfBase64(raw) {
  const text = String(raw ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  if (!text) throw new ProxyError(400, 'pdf_required', '请选择 PDF 文件，或对 arXiv 论文勾选自动下载')
  if (text.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4) throw new ProxyError(413, 'pdf_too_large', 'PDF 超过 50 MiB 上限')
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) throw new ProxyError(400, 'invalid_pdf', 'PDF 内容编码不正确')
  return assertPdf(Buffer.from(text, 'base64'), 'PDF ')
}

/** Download an arXiv PDF (latest version unless the id carries one). */
export async function downloadArxivPdf(arxivId) {
  const parsed = parseIdentifier(`arXiv:${String(arxivId ?? '').trim()}`)
  if (parsed.kind !== 'arxiv') throw new ProxyError(400, 'invalid_arxiv_id', 'arXiv 编号格式不正确')
  const id = parsed.id + parsed.version
  const result = await publicFetch(`https://arxiv.org/pdf/${id}`, {
    accept: 'application/pdf', maxBytes: MAX_PDF_BYTES, timeout: PDF_TIMEOUT,
    label: 'arXiv PDF 下载', tooLarge: 'arXiv PDF 超过 50 MiB 上限',
  })
  if (result.status === 404) throw new ProxyError(404, 'identifier_not_found', `arXiv 上没有编号 ${id} 的 PDF`)
  if (result.body.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new ProxyError(502, 'invalid_pdf', '从 arXiv 下载到的不是 PDF（arXiv 可能暂时不可用），请稍后重试或改为上传本地 PDF')
  }
  return { pdf: result.body, pdfName: `arXiv-${id.replace('/', '_')}.pdf` }
}

function pdfFileName(name, metadata) {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop().trim()
  return `${safeName(base || metadata?.arxiv_id || metadata?.title || 'paper')}.pdf`
}

/** Route body {metadata, pdf: {name, base64}} | {metadata, fetchArxivPdf: true}. */
export async function prepareSubmission(body) {
  const metadata = submissionMetadata(body?.metadata)
  if (body?.fetchArxivPdf === true) {
    if (!metadata.arxiv_id) throw new ProxyError(400, 'arxiv_required', '自动下载 PDF 需要 arXiv 编号')
    return { metadata, ...(await downloadArxivPdf(metadata.arxiv_id)) }
  }
  return { metadata, pdf: decodePdfBase64(body?.pdf?.base64), pdfName: body?.pdf?.name }
}

function serverError(status, text) {
  return {
    error: {
      code: `http_${status}`,
      detail: status === 413 ? '文件超过服务器允许的上传大小' : `服务器返回 HTTP ${status}${text ? '' : '（无内容）'}`,
    },
  }
}

/** POST the paper to the server as multipart; relays {status, data}. */
export async function submitPaper(binding, { metadata, pdf, pdfName }) {
  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), pdfFileName(pdfName, metadata))
  let response
  try {
    response = await fetch(`${binding.serverUrl}/api/v1/library/papers/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${binding.token}`, Accept: 'application/json' },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    })
  } catch (error) {
    throw new ProxyError(502, 'server_unreachable', error?.name === 'TimeoutError' ? '上传超时，请稍后重试' : '无法连接 AeCpt 服务器')
  }
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* non-JSON */ }
  if (!data || typeof data !== 'object') data = response.ok ? {} : serverError(response.status, text)
  return { status: response.status, data }
}

// ----------------------------------------------------------------- PDFs

/** Stream an approved/visible paper PDF from the server to the panel. */
export async function streamPaperPdf(binding, id, res) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 300_000)
  res.on('close', () => controller.abort())
  try {
    let upstream
    try {
      upstream = await fetch(`${binding.serverUrl}/api/v1/library/papers/${id}/pdf/`, {
        headers: { Authorization: `Bearer ${binding.token}` }, redirect: 'error', signal: controller.signal,
      })
    } catch {
      throw new ProxyError(502, 'server_unreachable', '无法连接 AeCpt 服务器')
    }
    const type = upstream.headers.get('content-type') || ''
    if (!upstream.ok || !type.includes('application/pdf')) {
      const text = await upstream.text()
      let data = null
      try { data = JSON.parse(text) } catch { /* non-JSON */ }
      const status = upstream.ok ? 502 : upstream.status
      throw new ProxyError(status, data?.error?.code || `http_${status}`, data?.error?.detail || '下载 PDF 失败')
    }
    const headers = {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    const disposition = upstream.headers.get('content-disposition')
    if (disposition) headers['Content-Disposition'] = disposition
    const length = upstream.headers.get('content-length')
    if (length) headers['Content-Length'] = length
    res.writeHead(200, headers)
    try {
      await pipeline(Readable.fromWeb(upstream.body), res)
    } catch {
      res.destroy()
    }
  } finally {
    clearTimeout(timer)
  }
}

export function safeName(text, fallback = 'paper') {
  const cleaned = String(text ?? '')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s_]+|[.\s_]+$/g, '')
    .slice(0, 80)
    .trim()
  return cleaned || fallback
}

export function dispositionName(header) {
  const text = String(header ?? '')
  const star = text.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/)
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) } catch { /* fall through */ }
  }
  return text.match(/filename\s*=\s*"([^"]+)"/)?.[1] || text.match(/filename\s*=\s*([^;]+)/)?.[1]?.trim() || ''
}

export function libraryDir(binding) {
  return join(LIBRARY_DIR, storeKey(binding))
}

function writeAtomic(path, data) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Save a paper PDF under ~/.aecpt/library/<account>/ for the agent. */
export async function downloadPaperPdf(binding, paper) {
  let response
  try {
    response = await fetch(`${binding.serverUrl}/api/v1/library/papers/${paper.id}/pdf/`, {
      headers: { Authorization: `Bearer ${binding.token}` }, redirect: 'error', signal: AbortSignal.timeout(300_000),
    })
  } catch {
    throw new Error('无法连接 AeCpt 服务器')
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error?.detail || `下载 PDF 失败：HTTP ${response.status}`)
  }
  const buffer = await readCapped(response, MAX_DOWNLOAD_BYTES, 'PDF 过大')
  const name = safeName(dispositionName(response.headers.get('content-disposition')) || paper.pdf?.name || paper.title)
  const dir = libraryDir(binding)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${paper.id}-${name}.pdf`)
  writeAtomic(path, buffer)
  return { path, bytes: buffer.length }
}

// ------------------------------------------------------------ local files

function expandHome(raw) {
  const text = String(raw ?? '').trim()
  if (text === '~') return HOME
  if (text.startsWith('~/')) return join(HOME, text.slice(2))
  return resolve(HOME, text)
}

function insideHome(path) {
  const rel = relative(HOME, path)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Read a local PDF chosen by the agent for submission. */
export function readLocalPdf(raw) {
  if (!String(raw ?? '').trim()) throw new Error('pdfPath 为空')
  const path = expandHome(raw)
  let stat
  try { stat = statSync(path) } catch { throw new Error(`找不到 PDF 文件：${path}`) }
  if (!stat.isFile()) throw new Error(`不是文件：${path}`)
  if (stat.size > MAX_PDF_BYTES) throw new Error('PDF 超过 50 MiB 上限')
  try {
    return { pdf: assertPdf(readFileSync(path), '文件'), pdfName: basename(path) }
  } catch (error) {
    throw new Error(error?.detail || String(error?.message || error))
  }
}

/** Write BibTeX to a .bib path that must stay inside the user's home directory. */
export function writeBibFile(raw, bibtex) {
  let path = expandHome(raw)
  if (!/\.bib$/i.test(path)) path += '.bib'
  if (!insideHome(path)) throw new Error('BibTeX 只能写入用户主目录下的 .bib 文件')
  mkdirSync(dirname(path), { recursive: true })
  const realHome = realpathSync(HOME)
  const realDir = realpathSync(dirname(path))
  const rel = relative(realHome, realDir)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('BibTeX 只能写入用户主目录下的 .bib 文件')
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('目标是符号链接，已拒绝写入')
  const target = join(realDir, basename(path))
  writeAtomic(target, bibtex)
  return target
}

// ------------------------------------------------------------- rendering

export function authorsText(authors, max = 4) {
  const list = Array.isArray(authors) ? authors : []
  if (!list.length) return ''
  return list.length > max ? `${list.slice(0, max - 1).join(', ')} 等` : list.join(', ')
}

export function paperLine(paper) {
  const meta = [authorsText(paper.authors), paper.year, paper.venue].filter(Boolean).join(' · ')
  const ids = [paper.doi && `DOI ${paper.doi}`, paper.arxiv_id && `arXiv ${paper.arxiv_id}`].filter(Boolean).join('，')
  const tags = paper.tags?.length ? ` [${paper.tags.join('、')}]` : ''
  return `- #${paper.id} ${paper.title}${meta ? `（${meta}）` : ''}${tags}${ids ? `\n  ${ids}` : ''}`
}

export function paperDetail(paper) {
  const lines = [`#${paper.id} ${paper.title} [${paper.status_display || PAPER_STATUS[paper.status] || paper.status}]`]
  if (paper.authors?.length) lines.push(`作者：${paper.authors.join(', ')}`)
  const where = [paper.year, paper.venue].filter(Boolean).join(' · ')
  if (where) lines.push(`发表：${where}`)
  if (paper.doi) lines.push(`DOI：${paper.doi}（https://doi.org/${paper.doi}）`)
  if (paper.arxiv_id) lines.push(`arXiv：${paper.arxiv_id}（https://arxiv.org/abs/${paper.arxiv_id}）`)
  if (paper.url) lines.push(`链接：${paper.url}`)
  if (paper.tags?.length) lines.push(`标签：${paper.tags.join('、')}`)
  if (paper.pdf?.name) lines.push(`PDF：${paper.pdf.name}（${Math.max(1, Math.round((paper.pdf.size || 0) / 1024))} KiB）`)
  if (paper.submitted_by) lines.push(`推荐人：${paper.submitted_by.name || paper.submitted_by.username}`)
  if (paper.note) lines.push(`推荐理由：${paper.note}`)
  if (paper.review_note) lines.push(`审核意见：${paper.review_note}`)
  if (paper.abstract) lines.push(`摘要：${paper.abstract}`)
  return lines.join('\n')
}
