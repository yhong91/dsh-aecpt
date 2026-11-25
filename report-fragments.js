import React from 'react';
import { ReportMarkdown } from './report-markdown.js';

const h = React.createElement;
const { useEffect, useRef, useState } = React;

function fmtShortTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return String(value);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function fragmentHeadline(markdown) {
  if (!markdown) return '（空记录）';
  const lines = String(markdown)
    .split(/\r?\n/)
    .map(line => line.replace(/^#{1,6}\s+/, '').replace(/^[-*>\d.)\s]+/, '').trim())
    .filter(line => line && line !== '---');
  const first = lines[0] || '未命名片段';
  return first.length > 72 ? `${first.slice(0, 72)}…` : first;
}

export function fragmentPreview(markdown) {
  if (!markdown) return '';
  const lines = String(markdown)
    .split(/\r?\n/)
    .map(line => line.replace(/^#{1,6}\s+/, '').replace(/^[-*>\s]+/, '').trim())
    .filter(line => line && line !== '---');
  const rest = lines.slice(1).join(' · ');
  return rest.length > 120 ? `${rest.slice(0, 120)}…` : rest;
}

function FragmentItem({ record, ownDraft, disabled, isNew, onRemove }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef(null);
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);

  const manual = record.session_id === 'manual' || record.provider === 'manual';
  const headline = fragmentHeadline(record.summary);
  const preview = !expanded ? fragmentPreview(record.summary) : '';

  return h('li', { className: 'aecpt-wb-frag', 'data-expanded': expanded ? 'true' : 'false' },
    h('div', { className: 'aecpt-wb-frag-head' },
      h('button', {
        type: 'button',
        className: 'aecpt-wb-frag-toggle',
        'aria-expanded': expanded,
        onClick: () => setExpanded(v => !v),
      },
        h('span', { className: 'aecpt-wb-frag-arrow', 'aria-hidden': true }, '▸'),
        h('span', { className: 'aecpt-wb-frag-main' },
          h('strong', { className: 'aecpt-wb-frag-title' }, headline),
          preview && h('span', { className: 'aecpt-wb-frag-preview' }, preview)),
        h('span', { className: 'aecpt-wb-frag-meta' },
          isNew && h('span', { className: 'aecpt-wb-chip', 'data-tone': 'warn' }, '未融入'),
          h('span', { className: 'aecpt-wb-chip' }, manual ? '手动补记' : '对话片段'),
          h('span', { className: 'aecpt-wb-muted' }, fmtShortTime(record.created_at)))),
      ownDraft && !confirming && h('button', {
        type: 'button',
        className: 'aecpt-wb-btn-ghost aecpt-wb-frag-del',
        disabled,
        'aria-label': `删除片段：${headline}`,
        onClick: () => setConfirming(true),
      }, '删除'),
      ownDraft && confirming && h('span', {
        className: 'aecpt-wb-toolbar',
        onKeyDown: e => { if (e.key === 'Escape' && !disabled) { e.preventDefault(); setConfirming(false); } },
      },
        h('button', {
          type: 'button', className: 'aecpt-wb-btn-danger', disabled,
          onClick: () => { setConfirming(false); onRemove(record.id); },
        }, '确认删除'),
        h('button', {
          ref: cancelRef, type: 'button', className: 'aecpt-wb-btn-ghost', disabled,
          onClick: () => setConfirming(false),
        }, '取消'))),
    expanded && h('div', { className: 'aecpt-wb-frag-body' },
      h(ReportMarkdown, { value: record.summary }),
      h('p', { className: 'aecpt-wb-muted', style: { marginTop: 8 } }, manual
        ? `手动补记 · ${fmtShortTime(record.created_at)}`
        : `模型：${record.provider}/${record.model} · 消息范围 ${record.from_seq}–${record.to_seq} · 会话 ${record.session_id}`)));
}

export function WeeklyFragmentsView({
  detail, ownDraft, busy, compileBusy, onCompile, onAddManual, onRemove,
}) {
  const [adding, setAdding] = useState(false);
  const [noteText, setNoteText] = useState('');
  const noteRef = useRef(null);
  useEffect(() => { if (adding) noteRef.current?.focus(); }, [adding]);

  const records = Array.isArray(detail.summary_records) ? detail.summary_records : [];
  const hasContent = Boolean((detail.content || '').trim());
  const compiledSet = new Set(Array.isArray(detail.compiled_record_ids) ? detail.compiled_record_ids : []);
  const showNewMarks = ownDraft && hasContent && compiledSet.size > 0;
  const disabled = busy || compileBusy;

  async function submitNote(event) {
    event.preventDefault();
    const trimmed = noteText.trim();
    if (!trimmed || disabled) return;
    const ok = await onAddManual(trimmed);
    if (ok) {
      setNoteText('');
      setAdding(false);
    }
  }

  return h('div', { className: 'aecpt-wb-report-body aecpt-wb-stack' },
    h('div', { className: 'aecpt-wb-frag-bar' },
      h('div', { style: { minWidth: 0 } },
        h('p', { className: 'aecpt-wb-muted' }, ownDraft
          ? '本教学周内从各次对话提取的进展片段会自动汇总于此，点击「AI 提炼完整周报」即可一键去重整合。'
          : '以下为本教学周提交时留档的过程记录，供追溯参考。')),
      ownDraft && !detail.has_conflict && h('div', { className: 'aecpt-wb-toolbar' },
        h('button', {
          type: 'button', className: 'aecpt-wb-btn-ghost', disabled,
          'aria-expanded': adding,
          onClick: () => setAdding(v => !v),
        }, adding ? '取消补记' : '+ 手动补记'),
        records.length > 0 && h('button', {
          type: 'button', className: 'aecpt-wb-btn', disabled,
          onClick: onCompile,
        }, compileBusy ? '正在提炼…' : (hasContent ? 'AI 融合更新周报' : 'AI 提炼完整周报')))),

    adding && ownDraft && !detail.has_conflict && h('form', {
      className: 'aecpt-wb-frag-add',
      onSubmit: submitNote,
      onKeyDown: e => { if (e.key === 'Escape' && !disabled) { e.preventDefault(); setAdding(false); } },
    },
      h('label', { className: 'aecpt-wb-muted', htmlFor: 'aecpt-manual-frag' }, '手动补记一条本周进展片段（支持 Markdown，如线下实验或文献笔记）'),
      h('textarea', {
        id: 'aecpt-manual-frag',
        ref: noteRef,
        className: 'aecpt-wb-input',
        rows: 4,
        maxLength: 12000,
        placeholder: '例如：\n### 消融实验结果\n- 完成 3 组基线对比，FID 从 18.4 降到 15.2\n- 待确认采样步数对推理耗时的影响',
        value: noteText,
        onChange: e => setNoteText(e.target.value),
        disabled,
      }),
      h('div', { className: 'aecpt-wb-toolbar' },
        h('button', { type: 'submit', className: 'aecpt-wb-btn', disabled: disabled || !noteText.trim() }, '记入本周汇总'),
        h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled, onClick: () => setAdding(false) }, '取消'))),

    detail.summary_records_pending > 0 && h('p', { className: 'aecpt-wb-muted' },
      ownDraft ? `有 ${detail.summary_records_pending} 条片段待同步到服务器。` : `${detail.summary_records_pending} 条片段仅保存在本机。`),

    records.length === 0
      ? h('div', { className: 'aecpt-wb-empty' },
        h('p', null, '本周还没有汇总的过程片段。'),
        h('p', null, '在任意 DSH 对话窗口右上角点「进展总结」，即可把该对话的有效进展自动归集到这里，或点击「+ 手动补记」。'))
      : h('ol', { className: 'aecpt-wb-frag-list', 'aria-label': '本周汇总片段' },
        records.map(record => h(FragmentItem, {
          key: record.id,
          record,
          ownDraft: ownDraft && !detail.has_conflict,
          disabled,
          isNew: showNewMarks && !compiledSet.has(record.id),
          onRemove,
        }))));
}
