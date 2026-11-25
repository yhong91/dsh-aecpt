import React from 'react';

const h = React.createElement;
const { useCallback, useEffect, useId, useRef, useState } = React;
const planPath = '/plan-items/';
const supervisorPath = '/plan-sharing/supervisors/';
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

export function localDateKey(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calendarDate(year, monthIndex, day) {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, monthIndex, day);
  return date;
}

function dateFromKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return calendarDate(year, month - 1, day);
}

function plusDays(date, days) {
  return calendarDate(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function weekdayIndex(date) {
  return (date.getDay() + 6) % 7;
}

export function shiftPlanMonth(key, months) {
  const date = dateFromKey(key);
  const month = calendarDate(date.getFullYear(), date.getMonth() + months, 1);
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const lastDay = calendarDate(year, monthIndex + 1, 0).getDate();
  return localDateKey(calendarDate(year, monthIndex, Math.min(date.getDate(), lastDay)));
}

export function planMonthWeeks(key) {
  const date = dateFromKey(key);
  const year = date.getFullYear();
  const month = date.getMonth();
  const first = calendarDate(year, month, 1);
  const last = calendarDate(year, month + 1, 0);
  const weeks = [];
  for (let monday = plusDays(first, -weekdayIndex(first)); monday <= last; monday = plusDays(monday, 7)) {
    weeks.push(weekdays.map((_, index) => {
      const day = plusDays(monday, index);
      return { date: localDateKey(day), day: day.getDate(), inMonth: day.getMonth() === month };
    }));
  }
  return weeks;
}

/** Monday..Sunday of the week containing `key`, for the overview week strip. */
export function planWeekDays(key) {
  const date = dateFromKey(key);
  const monday = plusDays(date, -weekdayIndex(date));
  return weekdays.map((weekday, index) => {
    const day = plusDays(monday, index);
    return { date: localDateKey(day), day: day.getDate(), weekday };
  });
}

export function groupPlanItems(items, today = localDateKey()) {
  const date = dateFromKey(today);
  const sunday = localDateKey(plusDays(date, 6 - weekdayIndex(date)));
  const groups = { overdue: [], today: [], thisWeek: [], undated: [], future: [], completed: [] };
  for (const item of items) {
    if (item.done) groups.completed.push(item);
    else if (!item.due_date) groups.undated.push(item);
    else if (item.due_date < today) groups.overdue.push(item);
    else if (item.due_date === today) groups.today.push(item);
    else if (item.due_date <= sunday) groups.thisWeek.push(item);
    else groups.future.push(item);
  }
  const byDate = (a, b) => a.due_date.localeCompare(b.due_date);
  groups.overdue.sort(byDate);
  groups.thisWeek.sort(byDate);
  groups.future.sort(byDate);
  return groups;
}

function useToday() {
  const [today, setToday] = useState(localDateKey);
  useEffect(() => {
    let timer;
    const update = () => {
      clearTimeout(timer);
      const now = new Date();
      setToday(localDateKey(now));
      const midnight = plusDays(now, 1);
      midnight.setHours(0, 0, 0, 0);
      timer = setTimeout(update, midnight - now);
    };
    update();
    window.addEventListener('focus', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', update);
    };
  }, []);
  return today;
}

function usePlanList(api, path) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function load() {
      try {
        const response = await api(path, { signal });
        const items = Array.isArray(response) ? response : response?.results;
        if (!Array.isArray(items)) throw new Error('服务器返回了无法读取的数据。');
        if (!signal.aborted) setData(items);
      } catch (error) {
        if (!signal.aborted) setError(error);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [api, path, revision]);

  const reload = useCallback(() => {
    setError(null);
    setLoading(true);
    setRevision(value => value + 1);
  }, []);
  return { data, setData, loading, error, reload };
}

function monthLabel(key) {
  const date = dateFromKey(key);
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function dateLabel(key) {
  const date = dateFromKey(key);
  return `${monthLabel(key)}${date.getDate()}日 星期${weekdays[weekdayIndex(date)]}`;
}

function keyNavigationDate(key, selected) {
  const date = dateFromKey(selected);
  switch (key) {
    case 'ArrowLeft': return localDateKey(plusDays(date, -1));
    case 'ArrowRight': return localDateKey(plusDays(date, 1));
    case 'ArrowUp': return localDateKey(plusDays(date, -7));
    case 'ArrowDown': return localDateKey(plusDays(date, 7));
    case 'Home': return localDateKey(plusDays(date, -weekdayIndex(date)));
    case 'End': return localDateKey(plusDays(date, 6 - weekdayIndex(date)));
    case 'PageUp': return shiftPlanMonth(selected, -1);
    case 'PageDown': return shiftPlanMonth(selected, 1);
    default: return null;
  }
}

function MonthCalendar({ selected, today, items, onSelect }) {
  const selectedButton = useRef(null);
  const focusSelection = useRef(false);
  useEffect(() => {
    if (!focusSelection.current) return;
    focusSelection.current = false;
    selectedButton.current?.focus();
  }, [selected]);

  const selectFromCalendar = date => {
    if (date === selected) return;
    focusSelection.current = true;
    onSelect(date);
  };
  const counts = new Map();
  for (const item of items) {
    if (!item.done && item.due_date) counts.set(item.due_date, (counts.get(item.due_date) || 0) + 1);
  }
  const month = monthLabel(selected);
  return h('div', { className: 'aecpt-plan-calendar' },
    h('div', { className: 'aecpt-plan-calendar-bar' },
      h('h2', null, month),
      h('div', { className: 'aecpt-plan-actions', role: 'group', 'aria-label': '切换月份' },
        h('button', { type: 'button', onClick: () => onSelect(shiftPlanMonth(selected, -1)), 'aria-label': '上个月' }, '‹'),
        h('button', { type: 'button', onClick: () => onSelect(today) }, '回到今天'),
        h('button', { type: 'button', onClick: () => onSelect(shiftPlanMonth(selected, 1)), 'aria-label': '下个月' }, '›'))),
    h('table', { className: 'aecpt-plan-month', 'aria-label': month + '日历' },
      h('thead', null, h('tr', null, weekdays.map(day =>
        h('th', { key: day, scope: 'col', 'aria-label': '星期' + day }, day)))),
      h('tbody', null, planMonthWeeks(selected).map(week => h('tr', { key: week[0].date }, week.map(day => {
        const count = counts.get(day.date) || 0;
        const isSelected = selected === day.date;
        return h('td', { key: day.date }, h('button', {
          type: 'button', className: day.inMonth ? '' : 'aecpt-plan-other-month',
          tabIndex: isSelected ? 0 : -1, ref: isSelected ? selectedButton : null,
          'aria-pressed': isSelected, 'aria-current': today === day.date ? 'date' : undefined,
          'aria-label': `${dateLabel(day.date)}，${count} 项待办`,
          onClick: () => selectFromCalendar(day.date),
          onKeyDown: event => {
            const next = keyNavigationDate(event.key, day.date);
            if (!next) return;
            event.preventDefault();
            selectFromCalendar(next);
          },
        }, h('span', null, day.day), count > 0 && h('span', { className: 'aecpt-plan-day-count', 'aria-hidden': true }, count)));
      }))))));
}

function newDraft(item) {
  return {
    title: item?.title ?? '', notes: item?.notes ?? '',
    due_date: item ? (item.due_date ?? '') : null,
    project: item?.project ? String(item.project.id) : '',
  };
}

function PlanForm({ item, defaultDate, projects, pending, disabled, error, onSave, onCancel }) {
  const [draft, setDraft] = useState(() => newDraft(item));
  const [showDetails, setShowDetails] = useState(false);
  const titleInput = useRef(null);
  useEffect(() => {
    if (item) titleInput.current?.focus();
  }, [item]);

  const date = draft.due_date ?? defaultDate;
  const set = (name, event) => {
    const value = event.target.value;
    setDraft(current => ({ ...current, [name]: value }));
  };
  const options = projects || [];
  const missingProject = draft.project && !options.some(project => String(project.id) === draft.project);
  async function submit(event) {
    event.preventDefault();
    if (!draft.title.trim() || disabled) return;
    const fields = {
      title: draft.title.trim(), notes: draft.notes, due_date: date || null,
      project: draft.project ? Number(draft.project) : null,
    };
    // Keep the submitted date in the draft if a request fails and the calendar selection changes.
    if (!item && draft.due_date === null) setDraft(current => ({ ...current, due_date: date }));
    if (await onSave(fields) && !item) {
      setDraft(newDraft());
      setShowDetails(false);
    }
  }

  return h('form', { className: 'aecpt-plan-form', onSubmit: submit, 'aria-label': item ? '编辑计划' : '快速新增计划' },
    item && h('h2', null, '编辑计划'),
    h('div', { className: 'aecpt-plan-form-head' },
      h('label', { className: 'aecpt-plan-title-field' },
        h('span', { className: 'aecpt-plan-sr-only' }, '计划标题'),
        h('input', {
          ref: titleInput, type: 'text', placeholder: '计划标题', required: true,
          value: draft.title, disabled, onChange: event => set('title', event),
        })),
      !item && h('button', { className: 'aecpt-plan-primary', type: 'submit', disabled: disabled || !draft.title.trim() }, pending ? '新增中…' : '新增')),
    !item && h('div', { className: 'aecpt-plan-form-options' },
      h('button', { className: 'aecpt-plan-text-button', type: 'button', 'aria-expanded': showDetails, onClick: () => setShowDetails(value => !value) }, showDetails ? '收起选项' : '日期、项目与备注'),
      date && h('time', { dateTime: date }, date)),
    (item || showDetails) && h('div', { className: 'aecpt-plan-fields' },
      h('label', null, '截止日期', h('input', { type: 'date', min: '0001-01-01', max: '9999-12-31', value: date, disabled, onChange: event => set('due_date', event) })),
      h('label', null, '关联项目', h('select', { value: draft.project, disabled: disabled || !projects, onChange: event => set('project', event) },
        h('option', { value: '' }, '无关联项目'),
        missingProject && h('option', { value: draft.project, disabled: true }, projects ? '所选项目已不可用' : '正在等待项目列表'),
        options.map(project => h('option', { key: project.id, value: String(project.id) }, project.name)))),
      h('label', { className: 'aecpt-plan-notes-field' }, '备注', h('textarea', { rows: 2, value: draft.notes, disabled, onChange: event => set('notes', event) }))),
    error && h('p', { className: 'aecpt-plan-error', role: 'alert' }, error),
    item && h('div', { className: 'aecpt-plan-actions aecpt-plan-form-footer' },
      h('button', { type: 'button', onClick: onCancel, disabled: pending }, '取消'),
      h('button', { className: 'aecpt-plan-primary', type: 'submit', disabled: disabled || !draft.title.trim() }, pending ? '保存中…' : '保存')));
}

function supervisorLabel({ name, username }) {
  return name && name !== username ? `${name}（${username}）` : username;
}

function unavailableSharing(error) {
  return error?.status === 404 && (!error.code || error.code === 'not_found');
}

function ShareSnapshot({ item }) {
  return h('dl', { className: 'aecpt-plan-snapshot' },
    h('dt', null, '标题'), h('dd', null, item.title),
    h('dt', null, '截止日期'), h('dd', null, item.due_date ? h('time', { dateTime: item.due_date }, item.due_date) : '无日期'),
    h('dt', null, '完成状态'), h('dd', null, item.done ? '已完成' : '待完成'),
    h('dt', null, '备注'), h('dd', null, item.notes || '无'));
}

function PlanSharing({ id, item, api, disabled, pending, runWrite, reloadPlan, refreshVersion, onClose }) {
  const heading = useRef(null);
  const path = `${planPath}${item.id}/shares/`;
  const supervisors = usePlanList(api, supervisorPath);
  const shares = usePlanList(api, path);
  const [recipient, setRecipient] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [stalePreview, setStalePreview] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => { heading.current?.focus(); }, []);
  const seenRefresh = useRef(refreshVersion);
  const reloadSupervisors = supervisors.reload;
  const reloadShares = shares.reload;
  useEffect(() => {
    if (seenRefresh.current === refreshVersion) return;
    seenRefresh.current = refreshVersion;
    reloadSupervisors();
    reloadShares();
  }, [refreshVersion, reloadSupervisors, reloadShares]);

  const { title, notes, due_date, done } = item;
  const preview = { title, notes, due_date, done };
  const available = supervisors.data || [];
  const snapshots = shares.data || [];
  const selected = available.find(supervisor => String(supervisor.id) === recipient);
  const sharedRecipients = new Set(snapshots.map(share => share.supervisor.id));
  const updating = selected && sharedRecipients.has(selected.id);
  const saving = pending === 'share';
  const shareDisabled = Boolean(disabled || supervisors.loading || supervisors.error || shares.loading || shares.error || stalePreview);
  const unsupported = unavailableSharing(supervisors.error) || unavailableSharing(shares.error);
  const unsupportedMessage = '工作台服务器尚未启用计划分享。请在更新服务器后重试。';

  function saveShare() {
    if (!selected || shareDisabled) return;
    const message = updating ? '更新分享' : '分享计划';
    runWrite('share', async () => {
      setError('');
      setAnnouncement('');
      setConfirmRevoke(null);
      try {
        const saved = await api(path, {
          method: 'POST', body: JSON.stringify({ supervisor_id: selected.id, snapshot: preview }),
        });
        shares.setData(current => [saved, ...current.filter(share => share.supervisor.id !== saved.supervisor.id)]);
        const name = supervisorLabel(saved.supervisor);
        setAnnouncement(updating ? `已更新给 ${name} 的快照。` : `已分享给 ${name}。`);
      } catch (error) {
        if (error.code === 'plan_snapshot_changed') setStalePreview(true);
        else if (error.code === 'supervisor_not_found') {
          supervisors.reload();
          setRecipient('');
          setError('所选导师已不可用，请重新选择。');
        } else setError(unavailableSharing(error) ? unsupportedMessage : `${message}失败。${error.message}`);
      }
    });
  }

  function revokeShare(share, button) {
    if (disabled || shares.loading || shares.error) return;
    if (confirmRevoke !== share.id) {
      setConfirmRevoke(share.id);
      return;
    }
    runWrite(`revoke-${share.id}`, async () => {
      setError('');
      setAnnouncement('');
      try {
        await api(`${path}${share.id}/`, { method: 'DELETE' });
        shares.setData(current => current.filter(entry => entry.id !== share.id));
        setConfirmRevoke(null);
        setAnnouncement(`已撤回给 ${supervisorLabel(share.supervisor)} 的分享。`);
        if (document.activeElement === button || document.activeElement === document.body) heading.current?.focus();
      } catch (error) {
        if (error.code === 'plan_share_not_found') {
          shares.reload();
          setConfirmRevoke(null);
          setError('这份分享已不可用。');
        } else setError(unavailableSharing(error) ? unsupportedMessage : `撤回分享失败。${error.message}`);
      }
    });
  }

  return h('section', { id, className: 'aecpt-plan-sharing', 'aria-labelledby': `${id}-heading` },
    h('div', { className: 'aecpt-plan-share-bar' },
      h('h2', { id: `${id}-heading`, ref: heading, tabIndex: -1 }, '分享计划'),
      h('button', { type: 'button', onClick: onClose, disabled: Boolean(pending) }, '收起分享')),
    h('p', { className: 'aecpt-plan-muted' }, '分享会发布当前已保存的计划快照。修改计划后可手动更新。'),
    (supervisors.loading || shares.loading) && h('p', { className: 'aecpt-plan-muted', role: 'status' }, '正在加载分享信息…'),
    (supervisors.error || shares.error) && h('div', { className: 'aecpt-plan-share-errors' },
      unsupported && h('p', { className: 'aecpt-plan-error', role: 'alert' }, unsupportedMessage),
      supervisors.error && !unavailableSharing(supervisors.error) && h('p', { className: 'aecpt-plan-error', role: 'alert' }, `加载导师失败。${supervisors.error.message}`),
      shares.error && !unavailableSharing(shares.error) && h('p', { className: 'aecpt-plan-error', role: 'alert' }, `加载已分享的快照失败。${shares.error.message}`),
      h('div', { className: 'aecpt-plan-actions' },
        h('button', { type: 'button', disabled: supervisors.loading || shares.loading || Boolean(pending), onClick: () => {
          if (supervisors.error) supervisors.reload();
          if (shares.error) shares.reload();
        } }, '重试加载分享信息'))),
    !supervisors.loading && !supervisors.error && (available.length ? h('label', { className: 'aecpt-plan-share-recipient' }, '选择导师',
      h('select', { value: recipient, disabled: shareDisabled, onChange: event => setRecipient(event.target.value) },
        h('option', { value: '' }, '请选择导师'),
        available.map(supervisor => h('option', { key: supervisor.id, value: String(supervisor.id) },
          supervisorLabel(supervisor) + (sharedRecipients.has(supervisor.id) ? ' · 已分享' : '')))))
      : h('div', null, h('p', { className: 'aecpt-plan-muted' }, '暂无可分享的导师。'),
        h('button', { type: 'button', disabled: supervisors.loading || Boolean(pending), onClick: supervisors.reload }, '重新加载导师'))),
    h('div', { className: 'aecpt-plan-share-preview' },
      h('h3', null, updating ? '更新后的快照预览' : '分享快照预览'),
      h(ShareSnapshot, { item: preview }),
      stalePreview && h('div', { className: 'aecpt-plan-share-errors' },
        h('p', { className: 'aecpt-plan-error', role: 'alert' }, '这条计划已有新修改。请刷新预览并重新确认分享内容。'),
        h('div', { className: 'aecpt-plan-actions' },
          h('button', { type: 'button', disabled, onClick: () => {
            setStalePreview(false);
            reloadPlan();
          } }, '刷新快照预览'))),
      selected && h('div', { className: 'aecpt-plan-actions' },
        h('button', { type: 'button', className: 'aecpt-plan-primary', disabled: shareDisabled, onClick: saveShare },
          saving ? '处理中…' : `${updating ? '更新快照给' : '分享给'} ${supervisorLabel(selected)}`))),
    error && h('p', { className: 'aecpt-plan-error', role: 'alert' }, error),
    h('p', { className: announcement ? 'aecpt-plan-muted' : 'aecpt-plan-sr-only', role: 'status' }, announcement),
    !shares.loading && !shares.error && h('div', null,
      h('h3', null, '已分享的快照'),
      snapshots.length ? h('ul', { className: 'aecpt-plan-shares' }, snapshots.map(share => {
        const name = supervisorLabel(share.supervisor);
        const confirming = confirmRevoke === share.id;
        const revoking = pending === `revoke-${share.id}`;
        return h('li', { key: share.id },
          h('details', null,
            h('summary', null, name, h('span', { className: 'aecpt-plan-muted' }, ' · 查看快照')),
            h('p', { className: 'aecpt-plan-muted' }, '分享时间 ', h('time', { dateTime: share.shared_at }, new Date(share.shared_at).toLocaleString('zh-CN'))),
            h(ShareSnapshot, { item: share })),
          confirming && h('p', { className: 'aecpt-plan-muted' }, `撤回后，${name} 将无法查看此快照。`),
          h('div', { className: 'aecpt-plan-actions' },
            h('button', { type: 'button', disabled, 'aria-label': `${confirming ? '确认撤回' : '撤回分享给'} ${name}`,
              onClick: event => revokeShare(share, event.currentTarget) }, revoking ? '撤回中…' : confirming ? '确认撤回' : '撤回分享'),
            confirming && h('button', { type: 'button', disabled, onClick: () => setConfirmRevoke(null) }, '取消')));
      })) : h('p', { className: 'aecpt-plan-muted' }, '这条计划尚未分享。')));
}

function PlanRows({ items, disabled, pending, toggleError, onToggle, onEdit, onShare, sharingId, sharePanelId }) {
  return h('ul', { className: 'aecpt-plan-rows' }, items.map(item => {
    const toggling = pending === `toggle-${item.id}`;
    const action = item.done ? '恢复' : '完成';
    return h('li', { key: item.id, className: 'aecpt-plan-row' },
      h('div', { className: 'aecpt-plan-row-text' },
        h('p', { className: 'aecpt-plan-row-title' }, item.title),
        (item.due_date || item.project) && h('p', { className: 'aecpt-plan-row-meta' },
          item.due_date && h('time', { dateTime: item.due_date }, item.due_date),
          item.project && h('span', null, item.project.name)),
        item.notes && h('p', { className: 'aecpt-plan-row-notes' }, item.notes),
        toggleError?.action === `toggle-${item.id}` && h('p', { className: 'aecpt-plan-error', role: 'alert' }, toggleError.message)),
      h('div', { className: 'aecpt-plan-actions' },
        h('button', { type: 'button', disabled, 'aria-label': '编辑 ' + item.title, onClick: event => onEdit(item, event.currentTarget) }, '编辑'),
        h('button', { type: 'button', disabled, 'aria-label': action + ' ' + item.title, onClick: event => onToggle(item, event.currentTarget) }, toggling ? '更新中…' : action),
        h('button', {
          type: 'button', disabled, 'aria-label': '分享 ' + item.title, 'aria-expanded': sharingId === item.id,
          'aria-controls': sharingId === item.id ? sharePanelId : undefined,
          onClick: event => onShare(item.id, event.currentTarget),
        }, '分享')));
  }));
}

function PlanGroup({ label, items, compact, rowProps }) {
  const heading = h('span', { className: 'aecpt-plan-group-label' }, label, h('span', { className: 'aecpt-plan-count' }, items.length));
  const rows = items.length ? h(PlanRows, { items, ...rowProps }) : null;
  return compact ? h('details', { className: 'aecpt-plan-group' }, h('summary', null, heading), rows)
    : h('section', { className: 'aecpt-plan-group' }, h('h2', null, heading), rows);
}

const listGroups = [
  ['overdue', '逾期'], ['today', '今天'], ['thisWeek', '本周其余日期'],
  ['undated', '无日期'], ['future', '未来', true], ['completed', '已完成', true],
];

export function PlanPanel({ api, active = true }) {
  const today = useToday();
  const [selection, setSelection] = useState(null);
  const [mode, setMode] = useState('list');
  const [editing, setEditing] = useState(null);
  const [sharingId, setSharingId] = useState(null);
  const sharePanelId = useId();
  const [pending, setPending] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const writing = useRef(false);
  const editButton = useRef(null);
  const shareButton = useRef(null);
  const toggleButton = useRef(null);
  const modeButton = useRef(null);
  const editorWasOpen = useRef(false);
  const refreshOnReturn = useRef(false);
  const plans = usePlanList(api, planPath);
  const projects = usePlanList(api, '/projects/');
  const reloadPlans = plans.reload;
  const reloadProjects = projects.reload;
  const selected = selection || today;
  const disabled = Boolean(plans.loading || plans.error || pending);
  const visibleProjects = projects.loading || projects.error ? null : projects.data;
  const reload = useCallback(() => {
    reloadPlans();
    reloadProjects();
    setRefreshVersion(value => value + 1);
  }, [reloadPlans, reloadProjects]);

  useEffect(() => {
    if (!active) refreshOnReturn.current = true;
    else if (refreshOnReturn.current && !pending && !plans.loading) {
      refreshOnReturn.current = false;
      reload();
    }
  }, [active, pending, plans.loading, reload]);

  useEffect(() => {
    if (editing) editorWasOpen.current = true;
    else if (editorWasOpen.current) {
      editorWasOpen.current = false;
      const target = editButton.current?.isConnected ? editButton.current : modeButton.current;
      if (active) target?.focus();
    }
  }, [active, editing]);

  useEffect(() => {
    if (pending || !toggleButton.current) return;
    const button = toggleButton.current;
    toggleButton.current = null;
    if (!active || (document.activeElement !== document.body && document.activeElement !== button)) return;
    const target = button.isConnected ? button : modeButton.current;
    target?.focus();
  }, [active, actionError, pending, plans.data]);

  async function runWrite(action, write) {
    if (writing.current) return false;
    writing.current = true;
    setPending(action);
    try {
      return await write();
    } finally {
      writing.current = false;
      setPending(null);
    }
  }

  function persist(action, id, fields, successMessage) {
    return runWrite(action, async () => {
      setActionError(null);
      setAnnouncement('');
      try {
        const creating = id === null;
        const updated = await api(creating ? planPath : `${planPath}${id}/`, {
          method: creating ? 'POST' : 'PATCH', body: JSON.stringify(fields),
        });
        plans.setData(items => creating ? [updated, ...items] : items.map(item => item.id === updated.id ? updated : item));
        setAnnouncement(successMessage);
        return true;
      } catch (error) {
        setActionError({ action, message: `更新计划失败。${error.message}` });
        return false;
      }
    });
  }

  const closeEditor = () => {
    setEditing(null);
    setActionError(current => current?.action === 'edit' ? null : current);
  };
  const saveEdit = async fields => {
    const before = { ...editing, project: editing.project?.id ?? null };
    const changes = Object.fromEntries(Object.entries(fields).filter(([name, value]) => value !== before[name]));
    if (!Object.keys(changes).length || await persist('edit', editing.id, changes, '计划已保存。')) closeEditor();
  };
  const closeSharing = () => {
    setSharingId(null);
    const button = shareButton.current;
    const target = button?.isConnected && !button.disabled && button.getClientRects().length ? button : modeButton.current;
    target?.focus();
  };
  const rowProps = {
    disabled: disabled || Boolean(editing), pending,
    toggleError: actionError, sharingId, sharePanelId,
    onShare: (id, button) => {
      if (sharingId === id) closeSharing();
      else {
        shareButton.current = button;
        setSharingId(id);
      }
    },
    onEdit: (item, button) => { editButton.current = button; setEditing(item); },
    onToggle: (item, button) => {
      if (writing.current) return;
      toggleButton.current = button;
      persist(`toggle-${item.id}`, item.id, { done: !item.done }, item.done ? '计划已恢复。' : '计划已完成。');
    },
  };
  const saveError = action => actionError?.action === action ? actionError.message : undefined;
  const items = plans.data || [];
  const sharing = items.find(item => item.id === sharingId);
  const calendar = mode === 'calendar';
  const dayItems = calendar ? items.filter(item => item.due_date === selected) : [];
  const groups = calendar ? null : groupPlanItems(items, today);

  return h('section', { className: 'aecpt-plan', 'aria-label': '个人计划' },
    h('div', { className: 'aecpt-plan-toolbar' },
      h('div', { className: 'aecpt-plan-actions', role: 'group', 'aria-label': '计划视图' },
        h('button', { ref: calendar ? null : modeButton, type: 'button', 'aria-pressed': !calendar, onClick: () => setMode('list') }, '清单'),
        h('button', { ref: calendar ? modeButton : null, type: 'button', 'aria-pressed': calendar, onClick: () => setMode('calendar') }, '月历')),
      plans.data !== null && !plans.error && h('button', { type: 'button', disabled, onClick: reload }, '刷新')),
    h('p', { className: 'aecpt-plan-sr-only', role: 'status' }, announcement),
    plans.loading && h('p', { className: 'aecpt-plan-muted', role: 'status' }, '正在加载计划…'),
    plans.error && h('div', { className: 'aecpt-plan-notice' },
      h('p', { className: 'aecpt-plan-error', role: 'alert' }, plans.error.status === 404 && plans.data === null
        ? '工作台服务器尚未启用计划功能。请在更新服务器后重试。' : `加载计划失败。${plans.error.message}`),
      h('button', { type: 'button', onClick: reload }, '重试')),
    plans.data !== null && h(React.Fragment, null,
      projects.error && h('div', { className: 'aecpt-plan-notice' },
        h('p', { className: 'aecpt-plan-error', role: 'alert' }, `加载项目失败。${projects.error.message}`),
        h('button', { type: 'button', onClick: reloadProjects }, '重试加载项目')),
      calendar && h(MonthCalendar, { selected, today, items, onSelect: setSelection }),
      h(PlanForm, { defaultDate: calendar ? selected : '', projects: visibleProjects,
        disabled: disabled || Boolean(editing), pending: pending === 'create', error: saveError('create'),
        onSave: fields => persist('create', null, { ...fields, done: false }, '计划已新增。') }),
      editing && h(PlanForm, { key: editing.id, item: editing, projects: visibleProjects, disabled,
        pending: pending === 'edit', error: saveError('edit'), onSave: saveEdit, onCancel: closeEditor }),
      sharing && h(PlanSharing, { key: `share-${sharing.id}`, id: sharePanelId, item: sharing, api,
        disabled: rowProps.disabled, pending, runWrite, reloadPlan: reloadPlans, refreshVersion, onClose: closeSharing }),
      calendar ? h('section', { className: 'aecpt-plan-day' },
        h('h2', null, dateLabel(selected)),
        !dayItems.some(item => !item.done) && h('p', { className: 'aecpt-plan-muted' }, '当天没有待办。'),
        h(PlanRows, { items: dayItems.filter(item => !item.done), ...rowProps }),
        dayItems.some(item => item.done) && h(PlanGroup, { label: '当天已完成', items: dayItems.filter(item => item.done), compact: true, rowProps }))
        : listGroups.map(([key, label, compact]) => h(PlanGroup, { key, label, items: groups[key], compact, rowProps }))));
}
