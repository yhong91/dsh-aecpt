import React from 'react';
import { ReportMarkdown } from './report-markdown.js';
import { fragmentHeadline } from './report-fragments.js';

const h = React.createElement;
const { useCallback, useEffect, useRef, useState } = React;

function fmtShortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return '';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function fmtSpanDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (!Number.isFinite(d.valueOf())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function relationMeta(item, workspaceName) {
  if (item.relation === 'session') return { label: '本会话', tone: 'done' };
  if (item.relation === 'workspace') return { label: workspaceName ? `同目录 · ${workspaceName}` : '同目录', tone: '' };
  if (item.session_id === 'manual') return { label: '手动补记', tone: '' };
  return { label: item.periodLabel || '近期记录', tone: '' };
}

function FragmentPickRow({ item, workspaceName, checked, expanded, onToggleCheck, onToggleExpand, disabled }) {
  const title = fragmentHeadline(item.summary);
  const tag = relationMeta(item, workspaceName);
  const subParts = [
    item.relation !== 'other' && item.periodLabel ? item.periodLabel : '',
    fmtShortDate(item.created_at),
  ].filter(Boolean).join(' · ');

  return h('li', { className: 'aecpt-sp-item', 'data-checked': checked ? 'true' : 'false' },
    h('div', { className: 'aecpt-sp-item-head' },
      h('input', {
        type: 'checkbox',
        className: 'aecpt-sp-checkbox',
        checked,
        disabled,
        'aria-label': `勾选一起参考：${title}`,
        onChange: onToggleCheck,
      }),
      h('div', { className: 'aecpt-sp-item-main', onClick: () => { if (!disabled) onToggleCheck(); } },
        h('span', { className: 'aecpt-sp-item-title' }, title),
        h('span', { className: 'aecpt-sp-item-meta' },
          h('span', { className: 'aecpt-sp-tag', 'data-tone': tag.tone }, tag.label),
          subParts && h('span', { className: 'aecpt-wb-muted' }, subParts))),
      h('button', {
        type: 'button',
        className: 'aecpt-sp-peek',
        'aria-expanded': expanded,
        onClick: onToggleExpand,
      }, expanded ? '收起' : '预览')),
    expanded && h('div', { className: 'aecpt-sp-item-body' },
      h(ReportMarkdown, { value: item.summary })));
}

/** Focused session-header popover: summarizes the current conversation and
 * automatically files it under the current teaching week. Prior fragments
 * from this session or workspace appear in one unified checklist so the user
 * can optionally tick which ones to bridge together. */
export function SessionPopover({ sessionId, active, api, GuideModal }) {
  const [status, setStatus] = useState(null);
  const [context, setContext] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [showOther, setShowOther] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastResult, setLastResult] = useState(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const bindingRef = useRef(null);
  const initializedSessionRef = useRef('');

  const papi = useCallback(async (path, options) => {
    return api(path, options, bindingRef.current);
  }, [api]);

  const load = useCallback(async ({ resetSelection = false } = {}) => {
    if (!active) return;
    setLoading(true);
    setError('');
    try {
      const st = await api('/status');
      bindingRef.current = st.connected ? st.bindingId : null;
      setStatus(st);
      if (!st.connected) {
        setContext(null);
        return;
      }
      const ctxData = await api(`/summarize/context?sessionId=${encodeURIComponent(sessionId)}`, {}, st.bindingId);
      setContext(ctxData);
      const list = ctxData.fragments || [];
      const key = `${st.bindingId}:${sessionId}`;
      if (resetSelection || initializedSessionRef.current !== key) {
        initializedSessionRef.current = key;
        // Pre-select up to 5 most recent fragments from THIS session only.
        const defaults = list.filter(i => i.relation === 'session').slice(0, 5).map(i => i.id);
        setSelectedIds(new Set(defaults));
        // If this session & workspace have no fragments yet, show recent items right away.
        const hasDirect = list.some(i => i.relation === 'session' || i.relation === 'workspace');
        setShowOther(!hasDirect);
      } else {
        const valid = new Set(list.map(i => i.id));
        setSelectedIds(prev => {
          const next = new Set();
          for (const id of prev) if (valid.has(id)) next.add(id);
          return next;
        });
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [active, api, sessionId]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const toggleCheck = id => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 10) next.add(id);
      return next;
    });
  };

  const toggleExpand = id => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runSummarize = async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError('');
    setLastResult(null);
    try {
      const res = await papi('/summarize', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          ...(context?.targetPeriod ? { period: context.targetPeriod } : {}),
          referenceIds: [...selectedIds],
        }),
      });
      setLastResult({
        reportId: res.report?.id,
        recordId: res.record?.id,
        periodLabel: res.report?.period_label || context?.targetPeriodLabel || '',
        totalCount: res.report?.summary_records?.length ?? 1,
        summary: res.summary,
        model: `${res.provider}/${res.model}`,
        referenceCount: res.reference_count ?? selectedIds.size,
      });
      await load({ resetSelection: true });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const discardLast = async () => {
    if (!lastResult?.reportId || !lastResult?.recordId || undoBusy) return;
    setUndoBusy(true);
    setError('');
    try {
      await papi(`/reports/${encodeURIComponent(lastResult.reportId)}/summaries/${encodeURIComponent(lastResult.recordId)}/`, {
        method: 'DELETE',
      });
      setLastResult(null);
      await load({ resetSelection: true });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setUndoBusy(false);
    }
  };

  if (!status) {
    return h('div', { className: 'aecpt-sp' },
      error
        ? h('div', { className: 'aecpt-sp-body' },
          h('p', { className: 'aecpt-wb-error', role: 'alert' }, error),
          h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', style: { marginTop: 8 }, onClick: () => load() }, '重试'))
        : h('div', { className: 'aecpt-sp-body' },
          h('p', { className: 'aecpt-wb-muted', role: 'status' }, '正在读取当前会话…')));
  }

  if (!status.connected) {
    return h(React.Fragment, null,
      h('div', { className: 'aecpt-sp' },
        h('header', { className: 'aecpt-sp-head' },
          h('h2', null, '总结本次会话')),
        h('div', { className: 'aecpt-sp-body' },
          h('p', { className: 'aecpt-wb-muted' }, '尚未连接 AeCpt 工作台。连接后即可自动将本次对话进展归入本周汇总。'),
          h('button', { type: 'button', className: 'aecpt-wb-btn', style: { marginTop: 10 }, onClick: () => setGuideOpen(true) }, '连接工作台'),
          error && h('p', { className: 'aecpt-wb-error', role: 'alert', style: { marginTop: 8 } }, error))),
      guideOpen && h(GuideModal, {
        account: status.cachedAccount,
        defaultServerUrl: status.serverUrl,
        onClose: () => setGuideOpen(false),
        onDone: () => { setGuideOpen(false); void load({ resetSelection: true }); },
      }));
  }

  const allFrags = context?.fragments || [];
  const directFrags = allFrags.filter(i => i.relation === 'session' || i.relation === 'workspace');
  const otherFrags = allFrags.filter(i => i.relation === 'other');
  const visibleFrags = showOther ? allFrags : directFrags;

  const newCount = context?.newMessageCount ?? 0;
  const fromTurn = context?.fromTurn ?? 0;
  const toTurn = context?.toTurn ?? 0;
  const statusParts = [];
  if (context && !context.sessionFound) {
    statusParts.push('未读取到当前会话');
  } else if (context) {
    if (newCount > 0) {
      statusParts.push(fromTurn > 0 ? `新增第 ${fromTurn + 1}–${toTurn || fromTurn + 1} 轮（${newCount} 条消息）` : `共 ${newCount} 条消息`);
      if (context.spanDays > 1) {
        statusParts.push(`${fmtSpanDate(context.firstTime)}–${fmtSpanDate(context.lastTime)}${context.spanDays > 7 ? `（跨 ${context.spanDays} 天）` : ''}`);
      }
    } else {
      statusParts.push(context.checkpoint ? '上次总结后暂无新对话' : '暂无可总结的对话');
    }
    if (context.targetPeriodLabel) statusParts.push(`自动归入 ${context.targetPeriodLabel}`);
  }

  return h(React.Fragment, null,
    h('div', { className: 'aecpt-sp' },
      h('header', { className: 'aecpt-sp-head' },
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '总结本次会话'),
          statusParts.length > 0 && h('p', { className: 'aecpt-wb-muted', role: 'status' }, statusParts.join(' · '))),
        h('button', {
          type: 'button',
          className: 'aecpt-sp-peek',
          disabled: loading || busy,
          onClick: () => load(),
        }, loading ? '刷新中…' : '刷新')),

      status.authExpired && h('div', { className: 'aecpt-sp-section' },
        h('div', { className: 'aecpt-wb-banner', role: 'alert' },
          '登录已失效。',
          h('button', { type: 'button', className: 'aecpt-wb-link', style: { marginLeft: 8 }, onClick: () => setGuideOpen(true) }, '重新授权'))),

      allFrags.length > 0 && h('section', { className: 'aecpt-sp-section', 'aria-label': '勾选过往片段一起总结' },
        h('div', { className: 'aecpt-sp-sec-head' },
          h('span', { className: 'aecpt-sp-sec-title' }, '结合过往片段一起总结（可选）'),
          selectedIds.size > 0 && h('button', {
            type: 'button', className: 'aecpt-wb-link', disabled: busy,
            onClick: () => setSelectedIds(new Set()),
          }, `清空已选 (${selectedIds.size})`)),
        h('ul', { className: 'aecpt-sp-list' },
          visibleFrags.map(item => h(FragmentPickRow, {
            key: item.id,
            item,
            workspaceName: context?.workspaceName || '',
            checked: selectedIds.has(item.id),
            expanded: expandedIds.has(item.id),
            disabled: busy,
            onToggleCheck: () => toggleCheck(item.id),
            onToggleExpand: () => toggleExpand(item.id),
          }))),
        otherFrags.length > 0 && directFrags.length > 0 && h('button', {
          type: 'button',
          className: 'aecpt-wb-link aecpt-sp-more',
          onClick: () => setShowOther(v => !v),
        }, showOther ? '收起其他近期记录' : `展开其他近期记录 (${otherFrags.length})`)),

      error && h('div', { className: 'aecpt-sp-section' },
        h('p', { className: 'aecpt-wb-error', role: 'alert' }, error)),

      lastResult && h('section', { className: 'aecpt-sp-section aecpt-sp-result', role: 'status' },
        h('div', { className: 'aecpt-sp-sec-head' },
          h('span', { className: 'aecpt-sp-sec-title' },
            `已自动归入 ${lastResult.periodLabel}（本周第 ${lastResult.totalCount} 条）`),
          h('button', {
            type: 'button', className: 'aecpt-sp-peek', disabled: undoBusy || busy,
            onClick: discardLast,
          }, undoBusy ? '删除中…' : '删除重来')),
        h('div', { className: 'aecpt-sp-result-body' },
          h(ReportMarkdown, { value: lastResult.summary })),
        h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6 } },
          `稍后可在左侧「AeCpt 科研工作台」一键提炼为完整周报。`)),

      h('footer', { className: 'aecpt-sp-foot' },
        h('button', {
          type: 'button',
          className: 'aecpt-wb-btn',
          style: { width: '100%' },
          disabled: busy || loading || !context?.sessionFound || newCount === 0,
          onClick: runSummarize,
        }, busy
          ? '正在总结当前会话…'
          : (newCount === 0
            ? '暂无新增对话'
            : (selectedIds.size > 0
              ? `总结并记入本周（结合 ${selectedIds.size} 条过往）`
              : '总结并记入本周'))))),

    guideOpen && h(GuideModal, {
      account: { ...status, authExpired: Boolean(status.authExpired) },
      onClose: () => setGuideOpen(false),
      onDone: () => { setGuideOpen(false); void load({ resetSelection: true }); },
    }));
}
