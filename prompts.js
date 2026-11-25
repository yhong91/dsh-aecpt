/**
 * AI prompt templates and prompt builders for dsh-aecpt.
 *
 * Extracted into a standalone module so students can inspect, fork, or override
 * both AI summarization workflows without editing the main Host proxy:
 *   1. Session progress fragment extraction (FRAGMENT_SYSTEM_PROMPT / buildFragmentPrompt)
 *   2. Teaching-week report synthesis & incremental fusion (COMPILE_SYSTEM_PROMPT / buildCompilePrompt)
 *
 * No-code override: create `~/.aecpt/dsh/prompts.json` with optional keys:
 *   {
 *     "fragment_system": "你的自定义对话片段提取系统提示词...",
 *     "compile_system": "你的自定义周报提炼系统提示词..."
 *   }
 * Empty/missing fields fall back to the built-in prompts below.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_CUSTOM_PROMPT_CHARS = 16000

export function fmtUtc8Date(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function fmtUtc8Time(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function fmtUtc8DateTime(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs || ''))
  if (!Number.isFinite(ms)) return ''
  return `${fmtUtc8Date(ms)} ${fmtUtc8Time(ms)}`
}

export const FRAGMENT_SYSTEM_PROMPT = [
  '你是科研过程记录助手。只根据给出的 DSH 对话片段提取有实质价值的学习、实验、代码或论文推进进展，严禁编造对话中未出现的数据或结论。',
  '输出要求：',
  '1. 第一行必须为「### <一句话具体主题>」（12–28 字，直接点明核心工作或结论，不要用“科研进展总结”“本次对话”等空泛标题）；',
  '2. 若提示中附带了【参考的过往进展与问题】（来自本会话前序总结或用户勾选的工作区过往片段）：',
  '   - 在标题下方先用 1 句引用块「> 承接前序：…」简要铺垫相关的前期进展与遗留问题，让本条记录独立阅读或跨周归档时来龙去脉清晰；',
  '   - 随后的要点列表仍只写本次新增对话的实质进展，不要大段复述前序细节；若本次修正了前序数据/结论，或解决/完成了前序遗留问题与计划，请用「已修正：…」「已解决：…」「已完成：…」明确呼应；',
  '3. 若未附带过往参考片段，不要写「承接前序」，直接输出要点列表；',
  '4. 要点列表用 2–6 条简洁的 Markdown 列表（若对话跨越多周且实质内容很多，最多 8 条）写出核心产出、关键指标/结论、有价值的排障教训、未解决阻碍或明确下一步；仅写有依据的内容，不要套用固定空小节或写“暂无明确记录”；',
  '5. 若对话横跨多天或多周、或中间经历了多次试错改版，以对话后半段的最终结论和最新数据为准，过滤已作废的早期尝试和无关寒暄；如跨越多天，可在关键条目前用「[MM-DD]」注明日期。',
].join('\n')

export const COMPILE_SYSTEM_PROMPT = [
  '你是高校科研周报撰写助手。请将学生积累的过程记录提炼、去重、整合为一份结构清晰、语言凝练、可直接提交给导师审阅的完整中文科研周报（Markdown 格式）。',
  '输出要求：',
  '1. 严格基于提供的材料，绝不编造未出现的实验数据、指标或结论；',
  '2. 合并同一主题的多次过程记录，按逻辑与重要性组织，消除碎片感与重复小标题；保留关键数值、指标、公式、论文或模块名，去掉对话口水话；',
  '3. 使用清晰的层级结构（如「# <教学周> 科研进展」「## 本周核心进展」「## 遇到的问题与风险」「## 下周计划」，无实质内容的栏目直接省略，不要硬凑空节）；',
  '4. 若处于【增量融合更新】模式（提供了【当前已有周报正文】与【尚未融入的新增片段】）：',
  '   - 以【当前已有周报正文】为基线，尊重并保留学生已在正文中手工润色、调整或删减的取舍；',
  '   - 仅将【尚未融入的新增片段】去重融合到对应章节，不要凭空恢复或重复早已弃用的旧尝试；',
  '   - 若新增片段修正了正文中的旧指标/结论，或解决了正文中的遗留问题，请原地更新对应条目并删除已过时表述，而不是机械追加到末尾；',
  '5. 若所汇总的过程记录实际时间跨度超过一周（多周补记），请在导语或标题下方简明交代起止日期，按阶段/主题归纳，在关键里程碑旁用「[MM-DD]」标注时间，并以最新结论覆盖早期已作废试错。',
].join('\n')

export function defaultCustomPromptPath() {
  return join(homedir(), '.aecpt', 'dsh', 'prompts.json')
}

/** Load optional user prompt overrides from `~/.aecpt/dsh/prompts.json`. */
export function loadCustomPrompts(filePath = defaultCustomPromptPath()) {
  let fragmentSystem = FRAGMENT_SYSTEM_PROMPT
  let compileSystem = COMPILE_SYSTEM_PROMPT
  let customized = { fragment: false, compile: false }
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.fragment_system === 'string' && parsed.fragment_system.trim()) {
        fragmentSystem = parsed.fragment_system.trim().slice(0, MAX_CUSTOM_PROMPT_CHARS)
        customized.fragment = true
      }
      if (typeof parsed.compile_system === 'string' && parsed.compile_system.trim()) {
        compileSystem = parsed.compile_system.trim().slice(0, MAX_CUSTOM_PROMPT_CHARS)
        customized.compile = true
      }
    }
  } catch {
    // Missing or malformed user override file safely falls back to built-in defaults.
  }
  return { fragmentSystem, compileSystem, customized }
}

export function formatReferenceFragments(references, currentSessionId, maxChars = 6000) {
  if (!Array.isArray(references) || !references.length) return ''
  const blocks = []
  let used = 0
  for (let i = 0; i < references.length; i += 1) {
    const { period, record } = references[i]
    const source = record.session_id === currentSessionId
      ? '本会话前序'
      : (record.session_id === 'manual' ? '工作区手动补记' : '工作区过往会话')
    const time = fmtUtc8DateTime(record.created_at) || (record.created_at ? record.created_at.slice(0, 16).replace('T', ' ') : '')
    const head = `[参考 ${i + 1} · ${source}${period ? ` · 归属 ${period}` : ''}${time ? ` · ${time}` : ''}]`
    const budget = maxChars - used - head.length - 8
    if (budget <= 80) break
    const body = String(record.summary || '').trim().slice(0, budget)
    const block = `${head}\n${body}`
    blocks.push(block)
    used += block.length + 6
  }
  return blocks.join('\n\n---\n\n')
}

export function buildFragmentPrompt({ period, range, sessionId, firstTime, lastTime, references, bounded }) {
  const header = [`归属教学周：${period}`, `提取范围：${range}`]
  if (firstTime !== null && lastTime !== null) {
    const startDate = fmtUtc8Date(firstTime)
    const endDate = fmtUtc8Date(lastTime)
    const spanDays = Math.max(1, Math.round((lastTime - firstTime) / 86_400_000) + 1)
    if (startDate === endDate) {
      header.push(`对话日期：${startDate}`)
    } else if (spanDays > 7) {
      header.push(`对话时间跨度：${startDate} 至 ${endDate}（共 ${spanDays} 天，跨越多周：请保留各阶段关键成果，以最新结论覆盖早期作废试错，并在关键条目括注 [MM-DD] 日期）`)
    } else {
      header.push(`对话时间跨度：${startDate} 至 ${endDate}（共 ${spanDays} 天）`)
    }
  }
  if (bounded.truncated) {
    header.push(`篇幅提示：本段对话较长，已保留开头背景与后半段最新消息（中间省略 ${bounded.omittedCount} 条较早消息），请聚焦最终产出与最新进展。`)
  }
  const parts = [...header]
  const refText = formatReferenceFragments(references, sessionId)
  if (refText) {
    parts.push(
      '',
      `【参考的过往进展与问题（共 ${references.length} 条；请结合它们用 1 句「> 承接前序：…」铺垫前期进展与遗留问题，但主体要点不要大段复述）】`,
      refText,
      '',
      '任务：请结合上方参考脉络，仅针对下方【本次新增对话】提炼新增实质进展：先写首行「### 一句话具体主题」，紧跟 1 句「> 承接前序：…」，再用简洁要点列出新增成果，并对修正/解决/完成前序项显式标注「已修正 / 已解决 / 已完成」。',
      '',
      `【本次新增对话（${range}）】`,
      bounded.text,
    )
  } else {
    parts.push(
      '',
      '任务：请从下方 DSH 对话中提取与学习、科研、项目推进有关的实质进展，输出一条紧凑的过程记录（首行「### 一句话具体主题」，下方列简洁要点，不写承接前序）。',
      '',
      '【对话内容】',
      bounded.text,
    )
  }
  return parts.join('\n')
}

function recordTimeSpan(records) {
  let first = null
  let last = null
  for (const rec of records) {
    const ms = Date.parse(String(rec?.created_at || ''))
    if (!Number.isFinite(ms)) continue
    if (first === null || ms < first) first = ms
    if (last === null || ms > last) last = ms
  }
  if (first === null || last === null) return null
  const startDate = fmtUtc8Date(first)
  const endDate = fmtUtc8Date(last)
  const spanDays = Math.max(1, Math.round((last - first) / 86_400_000) + 1)
  return { startDate, endDate, spanDays }
}

export function buildCompilePrompt({ period, existingContent, records, compiledIds }) {
  const ordered = [...records].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  const compiledSet = new Set(Array.isArray(compiledIds) ? compiledIds : [])
  const formatItem = (rec, index) => {
    const time = fmtUtc8DateTime(rec.created_at) || (rec.created_at ? rec.created_at.slice(0, 16).replace('T', ' ') : '')
    const kind = rec.session_id === 'manual' ? '手动补记' : '对话片段'
    return `[片段 ${index + 1} · ${kind}${time ? ` · ${time}` : ''}]\n${rec.summary}`
  }

  const header = [`教学周：${period}`]
  const span = recordTimeSpan(ordered)
  if (span && span.spanDays > 7) {
    header.push(`记录时间跨度：${span.startDate} 至 ${span.endDate}（共 ${span.spanDays} 天，超过一周：请按阶段与主题整合，在关键里程碑括注 [MM-DD]，并以最新结论覆盖早期试错）`)
  } else if (span && span.startDate !== span.endDate) {
    header.push(`记录时间跨度：${span.startDate} 至 ${span.endDate}`)
  }

  const trimmedExisting = String(existingContent || '').trim()
  if (trimmedExisting) {
    const newItems = ordered.filter(rec => !compiledSet.has(rec.id))
    if (newItems.length > 0) {
      // Incremental fusion: pass ONLY existing body + newly added fragments so
      // earlier fragments manually pruned by the student are never resurrected.
      return [
        ...header,
        '模式：增量融合更新（已有周报正文 + 新增未融入片段）',
        '任务：以【当前已有周报正文】为基线，保留其中已有的手动修改、结构与删减取舍，仅将【尚未融入的新增片段】去重融合进对应章节；若新增片段修正了旧数据或解决了旧问题，请原地更新对应条目，输出更新后的完整周报 Markdown。',
        '',
        '【当前已有周报正文】',
        trimmedExisting.slice(0, 30000),
        '',
        `【尚未融入的新增片段（共 ${newItems.length} 条）】`,
        newItems.map(formatItem).join('\n\n---\n\n').slice(-25000),
      ].join('\n')
    }
    // Re-compile / polish with no brand-new fragments.
    return [
      ...header,
      '模式：全量整理与润色（当前无新增片段）',
      '任务：请以【当前已有周报正文】为主，对照【本周全部过程记录参考】检查是否有遗漏的关键指标或可合并的冗余段落，尊重学生已有的删减取舍，输出更清晰凝练的完整周报 Markdown。',
      '',
      '【当前已有周报正文】',
      trimmedExisting.slice(0, 30000),
      '',
      `【本周全部过程记录参考（共 ${ordered.length} 条）】`,
      ordered.map(formatItem).join('\n\n---\n\n').slice(-25000),
    ].join('\n')
  }

  return [
    ...header,
    `模式：首次提炼（共 ${ordered.length} 条过程记录）`,
    `任务：请将下方零碎过程记录提炼、去重、整合为一份完整的「# ${period} 科研进展」周报。`,
    '',
    ordered.map(formatItem).join('\n\n---\n\n').slice(-55000),
  ].join('\n')
}
