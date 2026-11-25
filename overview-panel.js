import React from 'react';
import { localDateKey, planWeekDays } from './plan-panel.js';

const h = React.createElement;
const { useEffect, useState } = React;

const STATUS = {
  draft: ['草稿', 'warn'],
  submitted: ['已提交', ''],
  reviewed: ['已反馈', 'done'],
};

function Panel({ title, meta, action, wide, children }) {
  return h('section', { className: wide ? 'aecpt-wb-panel aecpt-wb-panel-wide' : 'aecpt-wb-panel', 'aria-label': title },
    h('header', { className: 'aecpt-wb-panel-head' },
      h('h2', null, title, meta ? h('span', { className: 'aecpt-wb-badge' }, meta) : null),
      action),
    h('div', { className: 'aecpt-wb-panel-body' }, children));
}

function useLoad(load, active, bindingId, deps) {
  const [state, setState] = useState({ loading: true, bindingId });
  useEffect(() => {
    if (!active) return;
    let live = true;
    setState(previous => (previous.bindingId === bindingId
      ? { ...previous, loading: true, error: '' }
      : { loading: true, bindingId }));
    load().then(data => { if (live) setState({ data, bindingId }); })
      .catch(error => { if (live) setState({ error: String(error?.message || error), bindingId }); });
    return () => { live = false; };
  }, [active, bindingId, ...deps]);
  return state;
}

function reportSnippet(markdown) {
  if (!markdown) return '';
  const lines = String(markdown)
    .split(/\r?\n/)
    .map(line => line.replace(/^#{1,6}\s+/, '').replace(/^[-*>\s]+/, '').trim())
    .filter(line => line && line !== '---');
  return lines.slice(0, 2).join(' · ').slice(0, 140);
}

function WeekSection({ reports, academicPeriods, status, onOpenReport, onStartWeek }) {
  const current = academicPeriods?.current;
  const week = current?.period;
  const report = week ? reports.find(item => item.period === week) : null;
  const [label, tone] = report ? (STATUS[report.status] || [report.status_display, '']) : ['未开始', 'danger'];
  const extras = [];
  if (!status.online) extras.push('离线模式');
  if (report?.has_conflict) extras.push('有冲突待处理');
  if (report?.summary_count > 0) {
    extras.push(`已汇总 ${report.summary_count} 条过程片段` + (report.status === 'draft' && report.has_content === false ? ' · 待提炼周报' : ''));
  }
  if (status.pendingCount) extras.push(`${status.pendingCount} 条修改待同步`);
  else if (report?.dirty) extras.push('有未同步修改');
  const snippet = reportSnippet(report?.content)
    || (report?.summary_count > 0 ? `本周已汇集 ${report.summary_count} 条过程记录，打开即可一键 AI 提炼为完整周报。` : '');

  if (!week) {
    return h('div', { className: 'aecpt-wb-progress-section' },
      h('h3', null, '本周'),
      h('p', { className: 'aecpt-wb-muted' }, academicPeriods
        ? '当前不在教学周内，可以在「科研进展」中按周期查看或新建。'
        : '暂未读取到教学周历，可以在「科研进展」中查看或新建。'));
  }
  return h('div', { className: 'aecpt-wb-progress-section' },
    h('h3', null, '本周'),
    h('div', { className: 'aecpt-wb-week' },
      h('strong', null, week),
      h('span', { className: 'aecpt-wb-chip', 'data-tone': tone }, label)),
    current.start_date && h('p', { className: 'aecpt-wb-muted' }, `${current.start_date} 至 ${current.end_date}`),
    extras.length > 0 && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 4 } }, extras.join(' · ')),
    snippet
      ? h('p', { className: 'aecpt-wb-snippet' }, snippet)
      : !report && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6 } }, '可在会话右上角点「进展总结」自动收集过程片段，最后一键提炼成完整周报。'),
    h('div', { style: { marginTop: 12 } },
      report
        ? h('button', { type: 'button', className: report.status === 'draft' ? 'aecpt-wb-btn' : 'aecpt-wb-btn-ghost', onClick: () => onOpenReport(report.id) },
          report.status === 'draft'
            ? (report.has_content === false && report.summary_count > 0 ? '去提炼本周周报' : '查看本周草稿')
            : '查看本周进展')
        : h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: onStartWeek }, '手动新建草稿')));
}

function FeedbackSection({ reports, currentWeek, onOpenReport }) {
  const withFeedback = reports.filter(report => report.feedback_count > 0);
  const rows = withFeedback
    .slice()
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, 4);
  return h('div', { className: 'aecpt-wb-progress-section' },
    h('h3', null, '最近导师反馈', withFeedback.length ? h('span', { className: 'aecpt-wb-badge' }, withFeedback.length) : null),
    rows.length
      ? h('ol', { className: 'aecpt-wb-rows' }, rows.map(report => h('li', { key: report.id, className: 'aecpt-wb-row aecpt-wb-row-2col' },
        h('button', { type: 'button', className: 'aecpt-wb-row-title', onClick: () => onOpenReport(report.id) },
          `${report.period_label || report.period}${report.period === currentWeek ? '（本周）' : ''}`),
        h('span', { className: 'aecpt-wb-row-meta' }, `${report.feedback_count} 条反馈`))))
      : h('p', { className: 'aecpt-wb-muted' }, '还没有收到导师反馈。提交进展后，导师的意见会附在对应周的进展下。'));
}

/** Research progress: this week's entry and recent supervisor feedback, which belongs to those entries. */
function ProgressPanel({ reports, loading, academicPeriods, status, onOpenReport, onStartWeek, onShowReports }) {
  return h(Panel, {
    title: '科研进展', wide: true,
    action: h('button', { type: 'button', className: 'aecpt-wb-link', onClick: onShowReports }, '全部进展'),
  }, loading ? h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…')
    : h('div', { className: 'aecpt-wb-progress' },
      h(WeekSection, { reports, academicPeriods, status, onOpenReport, onStartWeek }),
      h(FeedbackSection, { reports, currentWeek: academicPeriods?.current?.period, onOpenReport })));
}

function PlanSummaryPanel({ api, active, bindingId, online, onShowAll }) {
  const today = localDateKey();
  const state = useLoad(() => api('/plan-items/'), active, bindingId, [api]);
  const [selected, setSelected] = useState(today);
  const days = planWeekDays(today);
  const items = Array.isArray(state.data) ? state.data : state.data?.results;
  const open = (items || []).filter(item => !item.done);
  const counts = new Map();
  for (const item of open) if (item.due_date) counts.set(item.due_date, (counts.get(item.due_date) || 0) + 1);
  const overdue = open.filter(item => item.due_date && item.due_date < days[0].date)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const weekCount = days.reduce((sum, day) => sum + (counts.get(day.date) || 0), 0);
  const undated = open.filter(item => !item.due_date).length;
  const selectedItems = selected === 'overdue' ? overdue : open.filter(item => item.due_date === selected);
  const shown = selectedItems.slice(0, 5);
  const selectedLabel = selected === 'overdue' ? '本周之前逾期'
    : selected === today ? '今天' : `周${days.find(day => day.date === selected)?.weekday || ''}`;

  let body;
  if (state.loading && !items) body = h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…');
  else if (state.error) {
    body = h('div', { className: 'aecpt-wb-empty' },
      h('p', { className: 'aecpt-wb-error', role: 'alert' }, online ? '计划加载失败：' + state.error : '当前离线，计划需要在线连接。'),
      h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: onShowAll }, '前往计划'));
  } else if (!items) body = h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…');
  else {
    body = h(React.Fragment, null,
      h('div', { className: 'aecpt-wb-weekstrip', role: 'group', 'aria-label': '本周日历' },
        days.map(day => {
          const count = counts.get(day.date) || 0;
          const late = count > 0 && day.date < today;
          return h('button', {
            key: day.date, type: 'button', className: 'aecpt-wb-weekday',
            'aria-pressed': selected === day.date, 'aria-current': day.date === today ? 'date' : undefined,
            'aria-label': `周${day.weekday} ${day.date.slice(5)}，${count} 项待办${late ? '，已逾期' : ''}`,
            onClick: () => setSelected(day.date),
          },
            h('span', { className: 'aecpt-wb-weekday-name' }, day.weekday),
            h('span', { className: 'aecpt-wb-weekday-num' }, day.day),
            h('span', { className: 'aecpt-wb-weekday-count', 'data-late': late ? 'true' : undefined, 'aria-hidden': true },
              count > 0 ? count : '·'));
        })),
      overdue.length > 0 && h('button', {
        type: 'button', className: 'aecpt-wb-chip aecpt-wb-overdue', 'data-tone': 'danger',
        'aria-pressed': selected === 'overdue', onClick: () => setSelected(selected === 'overdue' ? today : 'overdue'),
      }, `本周之前逾期 ${overdue.length} 项`),
      h('div', { className: 'aecpt-wb-dayplan' },
        h('h3', null, selectedLabel),
        shown.length
          ? h('ul', { className: 'aecpt-wb-rows' }, shown.map(item => h('li', { key: item.id, className: 'aecpt-wb-row aecpt-wb-row-2col' },
            h('button', { type: 'button', className: 'aecpt-wb-row-title', title: item.title, onClick: onShowAll }, item.title),
            h('span', { className: 'aecpt-wb-row-meta' },
              selected === 'overdue' ? item.due_date.slice(5) : (item.project?.name || '')))))
          : h('p', { className: 'aecpt-wb-muted' }, selected === today ? '今天没有安排。' : '这天没有安排。'),
        selectedItems.length > shown.length && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 4 } }, `另有 ${selectedItems.length - shown.length} 项，打开计划查看`),
        undated > 0 && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6 } }, `另有 ${undated} 项未设日期`)));
  }

  return h(Panel, {
    title: '近期计划', meta: weekCount || null,
    action: h('button', { type: 'button', className: 'aecpt-wb-link', onClick: onShowAll }, '打开计划'),
  }, body);
}

function FeedPanel({ api, active, bindingId, onShowAll }) {
  const [readKeys, setReadKeys] = useState(() => new Set());
  const state = useLoad(() => api('/feeds/?unread=1&limit=6'), active, bindingId, [api]);
  useEffect(() => { setReadKeys(new Set()); }, [bindingId, state.data]);
  const data = state.data;
  const visibleItems = (data?.items || []).filter(item => !readKeys.has(`${item.sourceId}:${item.key}`));
  const unreadCount = Math.max(0, (data?.unreadCount || 0) - readKeys.size);

  function openItem(item) {
    const token = `${item.sourceId}:${item.key}`;
    setReadKeys(previous => new Set(previous).add(token));
    void api('/feeds/read', {
      method: 'POST',
      body: JSON.stringify({ sourceId: item.sourceId, key: item.key, read: true }),
    }).catch(() => {});
  }

  return h(Panel, {
    title: '文献订阅', meta: unreadCount || null,
    action: h('button', { type: 'button', className: 'aecpt-wb-link', onClick: onShowAll }, '全部订阅'),
  },
    state.loading && !data ? h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…')
      : state.error ? h('p', { className: 'aecpt-wb-error', role: 'alert' }, '订阅加载失败：' + state.error)
        : !data ? h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…')
          : !data.sources.length ? h('div', { className: 'aecpt-wb-empty' },
            h('p', null, '订阅期刊、arXiv 分类或研究博客，新文章会汇总到这里。'),
            h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: onShowAll }, '添加订阅'))
            : visibleItems.length ? h('ol', { className: 'aecpt-wb-rows' }, visibleItems.map((item, index) => h('li', { key: `${item.sourceId}:${item.key}`, className: 'aecpt-wb-row' },
              h('span', { className: 'aecpt-wb-rownum' }, String(index + 1).padStart(2, '0')),
              h('a', {
                className: 'aecpt-wb-row-title', href: item.url, target: '_blank', rel: 'noreferrer',
                title: item.title, onClick: () => openItem(item),
              }, item.title),
              h('span', { className: 'aecpt-wb-row-meta' }, item.publishedAt ? item.publishedAt.slice(5) : item.sourceName))))
              : h('div', { className: 'aecpt-wb-empty' },
                h('p', null, unreadCount > 0 ? `还有 ${unreadCount} 篇未读文章。` : '订阅的文章都已读完。'),
                h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: onShowAll }, unreadCount > 0 ? '查看全部未读' : '去刷新或浏览')));
}

/** Overview: research progress (this week + feedback), upcoming plans and unread literature. */
export function OverviewPanel({ api, active, loading, status, reports, academicPeriods, onOpenReport, onStartWeek, onSection }) {
  return h('div', { className: 'aecpt-wb-grid' },
    h(ProgressPanel, { reports, loading, academicPeriods, status, onOpenReport, onStartWeek, onShowReports: () => onSection('reports') }),
    h(PlanSummaryPanel, { api, active, bindingId: status.bindingId, online: status.online, onShowAll: () => onSection('plan') }),
    h(FeedPanel, { api, active, bindingId: status.bindingId, onShowAll: () => onSection('feeds') }));
}
