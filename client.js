import React from 'react';
import { ReportEditor, ReportMarkdown } from './report-markdown.js';
import { WeeklyFragmentsView } from './report-fragments.js';
import { SessionPopover } from './session-popover.js';
import { PlanPanel } from './plan-panel.js';
import { OverviewPanel } from './overview-panel.js';
import { FeedsPanel } from './feeds-panel.js';
import { LibraryPanel } from './library-panel.js';
import './plan-panel.css';
import './workbench.css';

const h = React.createElement;
const { useEffect, useState, useCallback, useRef } = React;

const REPORT_TONE = {
  draft: 'warn',
  submitted: '',
  reviewed: 'done',
};

/** Host proxy call. Every request carries the panel marker; requests made for
 * a connected account also echo its binding id so a view opened for an
 * earlier connection cannot act on a later one. */
async function api(path, options = {}, bindingId) {
  const headers = { 'X-Aecpt-Client': '1', ...options.headers };
  if (bindingId) headers['X-Aecpt-Binding'] = bindingId;
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch('/aecpt-api' + path, { cache: 'no-store', ...options, headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(data?.error?.detail || ('HTTP ' + res.status));
    error.status = res.status;
    error.code = data?.error?.code;
    error.data = data;
    throw error;
  }
  return data;
}

const authorName = a => (a && (a.full_name || a.username)) || '';
const accountLabel = a => {
  if (!a) return '';
  const name = a.fullName || a.username || '未知账号';
  return a.studentNumber ? `${name}（${a.studentNumber}）` : name;
};
const localWorkText = w => {
  if (!w) return '';
  const parts = [];
  if (w.pendingCount) parts.push(w.pendingCount + ' 条未同步修改');
  if (w.conflictCount) parts.push(w.conflictCount + ' 条待解决冲突');
  if (w.unsubmittedSummaries) parts.push(w.unsubmittedSummaries + ' 条未提交的 AI 总结');
  return parts.join('、');
};
const periodLabel = report => report?.period_label || report?.period || '';
const fmtTime = iso => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '从未';

function refreshedReport(previous, reports) {
  const current = reports.find(report => report.id === previous.id);
  if (current || !String(previous.id).startsWith('local-')) return current;
  return reports.find(report => !report.local_only && report.period === previous.period &&
    report.author?.username === previous.author?.username);
}

/** Capture-phase Escape handling + focus entry, Tab trap, and focus restore for dialogs. */
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
function useDialogAccessibility(dialogRef, { canClose, onClose }) {
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previous && typeof previous.focus === 'function' && previous.isConnected) previous.focus();
    };
  }, [dialogRef]);

  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (canClose) onClose();
        return;
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
        if (!items.length) { event.preventDefault(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [dialogRef, canClose, onClose]);
}

function parseClientServerInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { serverUrl: '', invitationUrl: '', error: '' };
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return { serverUrl: '', invitationUrl: '', error: '需为 http:// 或 https:// 开头的有效地址，且不能包含账号密码' };
    }
    const isInvite = /^\/invitations\/[A-Za-z0-9_-]{20,}(?:\/register)?\/?$/.test(url.pathname);
    return { serverUrl: url.origin, invitationUrl: isInvite ? `${url.origin}${url.pathname}` : '', error: '' };
  } catch {
    return { serverUrl: '', invitationUrl: '', error: '请输入完整的导师邀请链接或服务器地址（如 https://...）' };
  }
}

/** Setup guide modal: maps the server address from a supervisor invitation link
 * (or bare server URL) and runs browser OAuth PKCE without involving chat. When
 * the authorized account differs from the one cached on this device, the user
 * explicitly keeps the new account or cancels. */
function GuideModal({ onClose, onDone, account, defaultServerUrl }) {
  const [serverInput, setServerInput] = useState(account?.serverUrl || defaultServerUrl || '');
  const [authUrl, setAuthUrl] = useState('');
  const [state, setState] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState(null);
  const dialogRef = useRef(null);

  useDialogAccessibility(dialogRef, { canClose: !busy && !mismatch, onClose });
  const parsedServer = parseClientServerInput(serverInput);

  const start = useCallback(async () => {
    setBusy(true); setError(''); setNote('');
    try {
      const r = await api('/authorize/start', {
        method: 'POST',
        body: JSON.stringify({ serverUrl: serverInput }),
      });
      setAuthUrl(r.authorize_url); setState(r.state); setCode('');
      window.open(r.authorize_url, '_blank');
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }, [serverInput]);

  const complete = useCallback(async () => {
    setBusy(true); setError('');
    try {
      await api('/authorize/complete', { method: 'POST', body: JSON.stringify({ code, state }) });
      onDone();
    } catch (e) {
      if (e.code === 'account_mismatch') setMismatch(e.data);
      else setError(String(e.message || e));
    }
    finally { setBusy(false); }
  }, [code, state, onDone]);

  const confirm = useCallback(async choice => {
    setBusy(true); setError('');
    try {
      await api('/authorize/confirm', { method: 'POST', body: JSON.stringify({ state, choice }) });
      if (choice === 'switch') { onDone(); return; }
      setMismatch(null); setAuthUrl(''); setState(''); setCode('');
      setNote('已取消。请在授权页先切换到 ' + accountLabel(mismatch?.previous) + '，再重新授权。');
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }, [state, onDone, mismatch]);

  if (mismatch) {
    const { previous, incoming } = mismatch;
    const work = localWorkText(previous);
    return h('div', { className: 'aecpt-wb-scrim' },
      h('div', { ref: dialogRef, tabIndex: -1, className: 'aecpt-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '确认切换账号' },
        h('h3', { style: { marginBottom: 8, fontSize: 16 } }, '授权的账号与本机缓存不同'),
        h('p', { style: { fontSize: 13, marginBottom: 4 } }, '本次授权：' + accountLabel(incoming)),
        h('p', { style: { fontSize: 13, marginBottom: 8 } }, '本机缓存：' + accountLabel(previous)),
        work && h('p', { className: 'aecpt-wb-banner', style: { marginBottom: 8 } }, accountLabel(previous) + ' 在本机还有 ' + work +
          '。切换后这些内容保留在本机，改回该账号后继续同步。'),
        h('p', { className: 'aecpt-wb-muted' }, '如果浏览器自动登录了别人的账号，请取消后在授权页切换账号。'),
        error && h('p', { className: 'aecpt-wb-error', role: 'alert', style: { marginTop: 8 } }, error),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 } },
          h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy, onClick: () => confirm('switch') },
            '改用 ' + accountLabel(incoming) + '（保留 ' + accountLabel(previous) + ' 的本机缓存）'),
          h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => confirm('cancel') },
            '取消，用 ' + accountLabel(previous) + ' 重新授权'))));
  }

  return h('div', { className: 'aecpt-wb-scrim', onClick: e => { if (e.target === e.currentTarget && !busy) onClose(); } },
    h('div', { ref: dialogRef, tabIndex: -1, className: 'aecpt-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '连接 AeCpt 工作台' },
      h('h3', { style: { marginBottom: 6, fontSize: 16 } }, account?.authExpired ? '重新授权 AeCpt 工作台' : '连接 AeCpt 工作台'),
      h('p', { className: 'aecpt-wb-muted' }, '粘贴导师发来的邀请链接即可自动映射服务器地址。密码只提交给工作台服务器，不经过 DSH。'),
      account && h('p', { className: 'aecpt-wb-banner', style: { marginTop: 10 } }, '本机缓存属于 ' + accountLabel(account) +
        '。如果浏览器自动登录了其他账号，请先在授权页切换账号。'),
      note && h('p', { className: 'aecpt-wb-muted', role: 'status', style: { marginTop: 8 } }, note),
      h('div', { className: 'aecpt-wb-step' },
        h('span', { className: 'aecpt-wb-step-num' }, '1'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('p', { style: { marginBottom: 6, fontSize: 13 } }, '粘贴导师邀请链接（或服务器地址）：'),
          h('input', {
            className: 'aecpt-wb-input',
            placeholder: '如 https://your-server/invitations/...',
            value: serverInput,
            disabled: busy,
            onChange: e => { setServerInput(e.target.value); setAuthUrl(''); setState(''); setError(''); },
          }),
          parsedServer.serverUrl && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6, overflowWrap: 'anywhere' } },
            '已识别服务器：' + parsedServer.serverUrl),
          parsedServer.invitationUrl && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 4 } },
            '首次使用还没注册？',
            h('a', { className: 'aecpt-wb-link', href: parsedServer.invitationUrl, target: '_blank', rel: 'noreferrer' },
              '先打开此邀请链接注册并接受邀请')),
          parsedServer.error && h('p', { className: 'aecpt-wb-error', style: { marginTop: 6 } }, parsedServer.error))),
      h('div', { className: 'aecpt-wb-step' },
        h('span', { className: 'aecpt-wb-step-num' }, '2'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy || !parsedServer.serverUrl, onClick: start },
            authUrl ? '重新打开授权页面' : '打开授权页面'),
          authUrl && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6 } },
            '若浏览器未自动打开，请手动复制：', h('a', { className: 'aecpt-wb-link', href: authUrl, target: '_blank', rel: 'noreferrer' }, authUrl)))),
      h('div', { className: 'aecpt-wb-step' },
        h('span', { className: 'aecpt-wb-step-num' }, '3'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('p', { style: { marginBottom: 6, fontSize: 13 } }, '在页面用学号登录后，复制显示的一次性代码：'),
          h('input', { className: 'aecpt-wb-input', placeholder: '粘贴一次性代码', value: code, onChange: e => setCode(e.target.value) }),
          h('button', { type: 'button', className: 'aecpt-wb-btn', style: { marginTop: 8 }, disabled: busy || !code.trim() || !state, onClick: complete }, '完成连接'))),
      error && h('p', { className: 'aecpt-wb-error', role: 'alert', style: { marginTop: 8 } }, error),
      h('div', { style: { textAlign: 'right', marginTop: 12 } },
        h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: onClose }, '取消'))));
}

function SettingsIcon({ size = 16 }) {
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
  },
    h('path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }),
    h('circle', { cx: 12, cy: 12, r: 3 }))
}

function ConnectionBadge({ api }) {
  const [state, setState] = useState('checking');
  const [checkedAt, setCheckedAt] = useState(null);
  const check = useCallback(async () => {
    try {
      const result = await api('/connection/', { cache: 'no-store' });
      setState(result.online ? 'online' : 'offline');
      setCheckedAt(result.checked_at || new Date().toISOString());
    } catch {
      setState('offline');
      setCheckedAt(new Date().toISOString());
    }
  }, [api]);
  useEffect(() => {
    check();
    const timer = setInterval(check, 30000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [check]);
  const online = state === 'online';
  const color = online ? 'var(--dsw-alias-state-success-primary)'
    : state === 'checking' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)';
  return h('span', {
    role: 'status', 'aria-live': 'polite', title: checkedAt ? '检查于 ' + fmtTime(checkedAt) : '',
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  },
    h('span', { 'aria-hidden': true, style: { width: 8, height: 8, borderRadius: '50%', background: color } }),
    online ? '服务器正常' : state === 'checking' ? '正在检查连接' : '无法连接服务器');
}

function SettingsModal({ status, api, onClose, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [clearCache, setClearCache] = useState(false);
  const [unsynced, setUnsynced] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summaryModels, setSummaryModels] = useState(null);
  const [summaryChoice, setSummaryChoice] = useState('session');
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState('');
  const dialogRef = useRef(null);

  useDialogAccessibility(dialogRef, { canClose: !busy, onClose });

  useEffect(() => {
    let live = true;
    api('/summary-models', { cache: 'no-store' }).then(data => {
      if (!live) return;
      setSummaryModels(data);
      setSummaryChoice(data.mode === 'fixed' && data.selection
        ? JSON.stringify({ provider: data.selection.provider, model: data.selection.model })
        : 'session');
    }).catch(e => { if (live) setModelError(String(e.message || e)); });
    return () => { live = false; };
  }, [api]);

  async function chooseSummaryModel(event) {
    const next = event.target.value;
    const previous = summaryChoice;
    setSummaryChoice(next);
    setModelError('');
    setModelBusy(true);
    try {
      let body;
      if (next === 'session') {
        body = { mode: 'session' };
      } else {
        const selected = JSON.parse(next);
        body = { mode: 'fixed', provider: selected.provider, model: selected.model };
      }
      await api('/summary-model', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      setSummaryChoice(previous);
      setModelError(String(e.message || e));
    } finally {
      setModelBusy(false);
    }
  }

  const fixedUnavailable = summaryModels?.mode === 'fixed' && summaryModels.selection &&
    summaryChoice !== 'session' &&
    !summaryModels.options.some(group => group.models.some(model =>
      group.provider === summaryModels.selection.provider && model.id === summaryModels.selection.model));

  async function disconnect(discardLocal = false) {
    setBusy(true); setError('');
    try {
      await api('/disconnect', { method: 'POST', body: JSON.stringify({ clearCache, discardLocal }) });
      onDone();
    } catch (e) {
      if (e.code === 'unsynced_local_work') setUnsynced(e.data?.work || {});
      else setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }
  const localWork = localWorkText({
    pendingCount: status.pendingCount, conflictCount: status.conflictCount,
    unsubmittedSummaries: status.unsubmittedSummaries,
  });
  return h('div', { className: 'aecpt-wb-scrim', onClick: e => { if (e.target === e.currentTarget && !busy) onClose(); } },
    h('div', { ref: dialogRef, tabIndex: -1, className: 'aecpt-wb-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置' },
      h('h2', { style: { fontSize: 18, fontWeight: 600, marginBottom: 12 } }, '设置'),
      h('div', { className: 'aecpt-wb-stack' },
        h('div', { className: 'aecpt-wb-card' },
          h('p', { style: { fontWeight: 600, marginBottom: 6 } }, '工作台连接'),
          h('p', { className: 'aecpt-wb-muted' }, '账号：' + (accountLabel(status) || '未连接') + (status.username ? ' · ' + status.username : '')),
          h('p', { className: 'aecpt-wb-muted', style: { overflowWrap: 'anywhere' } }, '服务器：' + status.serverUrl),
          h('div', { style: { marginTop: 10 } }, h(ConnectionBadge, { api }))),
        h('div', { className: 'aecpt-wb-card' },
          h('p', { style: { fontWeight: 600, marginBottom: 6 } }, 'AI 总结模型'),
          h('p', { className: 'aecpt-wb-muted' }, '默认跟随当前对话 Session 的模型；也可以指定固定模型。'),
          h('select', {
            className: 'aecpt-wb-input', style: { marginTop: 8 }, value: summaryChoice,
            onChange: chooseSummaryModel, disabled: modelBusy,
            'aria-label': 'AI 总结模型',
          },
            h('option', { value: 'session' }, '跟随当前对话 Session'),
            (summaryModels?.options || []).map(group => h('optgroup', { key: group.provider, label: group.name },
              group.models.map(model => h('option', {
                key: group.provider + '\u0000' + model.id,
                value: JSON.stringify({ provider: group.provider, model: model.id }),
              }, model.name + ' · ' + group.name)))),
            fixedUnavailable && h('option', { value: summaryChoice }, summaryModels.selection.provider + '/' + summaryModels.selection.model + '（当前不可用）')),
          !summaryModels && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6 } }, '正在读取模型列表…'),
          summaryModels && !(summaryModels.options || []).some(group => group.models.length)
            && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6 } }, '当前没有读取到可指定的模型，可继续使用跟随当前对话 Session。'),
          modelBusy && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6 } }, '正在保存模型设置…'),
          modelError && h('p', { className: 'aecpt-wb-error', role: 'alert', style: { marginTop: 6 } }, modelError)),
        h('p', { className: 'aecpt-wb-muted' }, '断开只移除本机保存的工作台连接，不会删除服务器上的账号或数据。本机缓存与文献订阅默认保留，重新连接同一账号后继续使用。'),
        localWork && h('p', { className: 'aecpt-wb-muted' }, '本机还有 ' + localWork + '。'),
        confirming && h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
          h('input', { type: 'checkbox', checked: clearCache, disabled: busy, onChange: e => { setClearCache(e.target.checked); setUnsynced(null); } }),
          '同时清除本机缓存与文献订阅（公用电脑使用）'),
        unsynced && h('p', { className: 'aecpt-wb-banner', role: 'alert' }, '本机还有 ' + (localWorkText(unsynced) || '未同步内容') +
          '，清除后无法恢复。建议先联网同步，或取消勾选只断开连接。'),
        error && h('p', { className: 'aecpt-wb-error', role: 'alert' }, error)),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, flexWrap: 'wrap' } },
        confirming ? h(React.Fragment, null,
          h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => { setConfirming(false); setClearCache(false); setUnsynced(null); } }, '取消'),
          unsynced
            ? h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy, onClick: () => disconnect(true) }, busy ? '断开中…' : '仍然清除并断开')
            : h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy, onClick: () => disconnect(false) }, busy ? '断开中…' : '确认断开'))
          : h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy, onClick: () => setConfirming(true) }, '断开连接'),
        h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: onClose }, '关闭'))));
}

function Panel(props) {
  const view = props?.view || 'page';
  const surface = props?.surface || 'embedded';
  const sessionId = props?.sessionId || '';
  const panelActive = props?.active !== false;
  const [status, setStatus] = useState(null);
  const [section, setSection] = useState('overview');
  const [planOpened, setPlanOpened] = useState(false);
  const [checkingPlan, setCheckingPlan] = useState(false);
  const [planConnectionError, setPlanConnectionError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reports, setReports] = useState([]);
  const [reportsLoaded, setReportsLoaded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editGuardNote, setEditGuardNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState('');
  const [academicPeriods, setAcademicPeriods] = useState(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [compileBusy, setCompileBusy] = useState(false);
  const [summaryNote, setSummaryNote] = useState('');
  const [reportTab, setReportTab] = useState('report');
  const [content, setContent] = useState('');
  const [guide, setGuide] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [conflictText, setConflictText] = useState('');
  const [exportPath, setExportPath] = useState('');
  const reportView = useRef(null);
  const detailSeq = useRef(0);
  const account = useRef(null);
  const bindingRef = useRef(null);
  const refreshRef = useRef(null);
  const wasActive = useRef(panelActive);
  // Every call made for the connected account echoes the binding this view
  // loaded; after a switch the Host refuses it and the view reloads.
  const papi = useCallback(async (path, options) => {
    try {
      return await api(path, options, bindingRef.current);
    } catch (error) {
      if (error.code === 'binding_changed') void refreshRef.current?.();
      throw error;
    }
  }, []);
  reportView.current = {
    id: detail?.id,
    editing,
    changedBody: Boolean(editing && detail && editContent !== (detail.content || '')),
    changedConflict: Boolean(detail?.conflict && conflictText !== detail.conflict.merged),
  };
  useEffect(() => () => { reportView.current = null; }, []);

  const acceptStatus = useCallback(current => {
    const nextAccount = current.connected ? JSON.stringify([current.serverUrl, current.username]) : null;
    const changed = account.current !== nextAccount;
    if (changed && account.current !== null) {
      setReports([]);
      setReportsLoaded(false);
      setAcademicPeriods(null);
      setDetail(null);
      setEditing(false);
      setCreating(false);
      setEditGuardNote('');
      setPeriod('');
      setContent('');
      setEditContent('');
      setConflictText('');
      setExportPath('');
      setSummaryNote('');
    }
    account.current = nextAccount;
    bindingRef.current = current.connected ? current.bindingId : null;
    setStatus(current);
    return changed;
  }, []);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const st = await api('/status');
      acceptStatus(st);
      if (st.connected) {
        setGuide(false);
        const visibleReports = await papi('/reports/');
        let calendar = null;
        try {
          calendar = await papi('/academic-periods/');
        } catch { /* older server: keep free-text fallback */ }
        const syncedStatus = await api('/status');
        acceptStatus(syncedStatus);
        if (st.bindingId !== syncedStatus.bindingId) return;
        if (calendar) {
          setAcademicPeriods(calendar);
          setPeriod(current => current || calendar?.current?.period || calendar?.weeks?.[0]?.period || '');
        }
        setReports(visibleReports);
        setReportsLoaded(true);
        return visibleReports;
      }
      if (view === 'page') setGuide(true);
    } catch (e) { setError(String(e.message || e)); }
  }, [view, acceptStatus, papi]);
  refreshRef.current = refresh;

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (panelActive && !wasActive.current) void refresh();
    wasActive.current = panelActive;
  }, [panelActive, refresh]);

  const checkPlanBinding = useCallback(async () => {
    setCheckingPlan(true);
    setPlanConnectionError('');
    try {
      const current = await api('/status', { cache: 'no-store' });
      const changed = acceptStatus(current);
      if (changed && current.connected) void refresh();
      setPlanOpened(Boolean(current.connected && current.bindingId));
      if (!current.connected) setSection('overview');
      if (current.connected && !current.bindingId) setPlanConnectionError('请重新加载工作台插件。');
    } catch (error) {
      setPlanConnectionError(error.message);
    } finally {
      setCheckingPlan(false);
    }
  }, [acceptStatus, refresh]);

  useEffect(() => {
    if (section !== 'plan' || !panelActive) return;
    checkPlanBinding();
    window.addEventListener('focus', checkPlanBinding);
    return () => window.removeEventListener('focus', checkPlanBinding);
  }, [section, panelActive, checkPlanBinding]);

  const planBinding = status?.bindingId;
  const planApi = useCallback(async (path, options) => {
    try {
      return await papi(path, options);
    } catch (error) {
      if (error.code === 'binding_changed') void checkPlanBinding();
      else if (error.status === 401 || error.code === 'authentication_failed') {
        setPlanConnectionError('工作台登录已失效，请重新授权登录。');
        setStatus(current => current ? { ...current, connected: false, bindingId: null } : current);
      }
      throw error;
    }
  }, [papi, checkPlanBinding]);

  const run = useCallback(async (fn, afterRefresh) => {
    setBusy(true); setError('');
    try {
      const result = await fn();
      const visibleReports = await refresh();
      await afterRefresh?.(result, visibleReports);
    }
    catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }, [refresh]);

  const openDetail = useCallback(async (id, preserveFromId, { skipChanged = false, keepEditing = false, tab } = {}) => {
    const seq = ++detailSeq.current;
    setError('');
    setEditGuardNote('');
    try {
      const d = await papi('/reports/' + id + '/');
      if (seq !== detailSeq.current) return;
      const current = reportView.current;
      if (preserveFromId !== undefined && current?.id !== preserveFromId) return;
      if (skipChanged && (current?.changedBody || current?.changedConflict)) return;
      setDetail(d);
      if (tab) {
        setReportTab(tab);
      } else if (preserveFromId === undefined) {
        const hasBody = Boolean((d.content || '').trim());
        const hasFrags = (d.summary_records?.length || 0) > 0;
        setReportTab(d.status === 'draft' && !hasBody && hasFrags ? 'fragments' : 'report');
      }
      if (!keepEditing && preserveFromId === undefined) setEditing(false);
      if (preserveFromId === undefined || !current.changedBody) setEditContent(d.content || '');
      if (preserveFromId === undefined || !current.changedConflict) setConflictText(d.conflict?.merged || '');
    } catch (e) {
      if (seq === detailSeq.current) setError(String(e.message || e));
    }
  }, [papi]);

  // Reading-first: automatically show the current week's (or latest) progress entry.
  useEffect(() => {
    if (section !== 'reports' || !reportsLoaded || creating || !reports.length) return;
    if (detail) {
      const current = refreshedReport(detail, reports);
      if (!current) {
        setDetail(null);
        setEditing(false);
      }
      return;
    }
    const preferred = reports.find(r => r.period === academicPeriods?.current?.period) || reports[0];
    if (preferred) void openDetail(preferred.id);
  }, [section, reportsLoaded, creating, reports, detail, academicPeriods, openDetail]);

  const summarize = useCallback(async () => {
    if (!sessionId || !period || summaryBusy || compileBusy || reportView.current?.changedBody || reportView.current?.changedConflict) return;
    setSummaryBusy(true); setError(''); setSummaryNote('');
    try {
      const result = await papi('/summarize', {
        method: 'POST',
        body: JSON.stringify({ sessionId, period }),
      });
      const count = result.report?.summary_records?.length ?? 1;
      setSummaryNote(`已将本次对话片段记入 ${result.report?.period_label || period} 本周汇总（共 ${count} 条），可随时一键提炼为完整周报`);
      setCreating(false);
      setEditing(false);
      setSection('reports');
      const visibleReports = await refresh();
      if (result.report?.id !== undefined) {
        await openDetail(
          refreshedReport(result.report, visibleReports || [])?.id ?? result.report.id,
          undefined,
          { skipChanged: true, tab: 'fragments' },
        );
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSummaryBusy(false);
    }
  }, [sessionId, period, summaryBusy, compileBusy, papi, refresh, openDetail]);

  const compileReport = useCallback(async (id) => {
    if (!id || compileBusy || summaryBusy || reportView.current?.changedBody || reportView.current?.changedConflict) return;
    setCompileBusy(true); setError(''); setSummaryNote('');
    try {
      const result = await papi(`/reports/${id}/compile/`, {
        method: 'POST',
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      });
      setEditing(false);
      setReportTab('report');
      setSummaryNote(result.fused
        ? `已由 ${result.provider}/${result.model} 融合更新完整周报，可继续微调或一键撤销`
        : `已由 ${result.provider}/${result.model} 提炼生成完整周报，可继续微调或一键撤销`);
      const visibleReports = await refresh();
      const targetId = refreshedReport(result.report, visibleReports || [])?.id ?? result.report?.id ?? id;
      await openDetail(targetId, undefined, { tab: 'report' });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setCompileBusy(false);
    }
  }, [sessionId, compileBusy, summaryBusy, papi, refresh, openDetail]);

  const undoCompile = useCallback(async (id) => {
    if (!id || compileBusy || summaryBusy) return;
    await run(async () => {
      const restored = await papi(`/reports/${id}/undo-compile/`, { method: 'POST', body: '{}' });
      setDetail(restored);
      setEditContent(restored.content || '');
      setSummaryNote('已撤销上一次 AI 提炼，恢复到之前的周报内容');
    });
  }, [compileBusy, summaryBusy, papi, run]);

  const addManualFragment = useCallback(async (targetPeriod, summary) => {
    setBusy(true); setError(''); setSummaryNote('');
    try {
      const result = await papi('/reports/summaries/', {
        method: 'POST',
        body: JSON.stringify({ period: targetPeriod, summary }),
      });
      const count = result.report?.summary_records?.length ?? 1;
      setSummaryNote(`已补记到 ${result.report?.period_label || targetPeriod} 本周汇总（共 ${count} 条）`);
      const visibleReports = await refresh();
      const targetId = refreshedReport(result.report, visibleReports || [])?.id ?? result.report?.id;
      if (targetId) await openDetail(targetId, undefined, { tab: 'fragments' });
      return true;
    } catch (e) {
      setError(String(e.message || e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [papi, refresh, openDetail]);

  const removeFragment = useCallback(async (reportId, recordId) => {
    await run(async () => {
      const updated = await papi(`/reports/${reportId}/summaries/${encodeURIComponent(recordId)}/`, { method: 'DELETE' });
      setDetail(updated);
      setSummaryNote('已从本周汇总中删除该条片段');
    });
  }, [papi, run]);

  const forceSync = useCallback(async () => {
    setBusy(true); setError('');
    try {
      await papi('/reports/sync/', { method: 'POST', body: '{}' });
      const visibleReports = await refresh();
      if (detail && visibleReports) {
        const current = refreshedReport(detail, visibleReports);
        if (current) await openDetail(current.id, detail.id);
      }
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }, [papi, refresh, detail, openDetail]);

  const doExport = useCallback(async () => {
    setError(''); setExportPath('');
    try {
      const r = await papi('/export');
      setExportPath(r.path);
    } catch (e) { setError(String(e.message || e)); }
  }, [papi]);

  const wrapPage = inner => surface === 'main'
    ? h('div', { className: 'aecpt-wb-page' }, h('div', { className: 'aecpt-workbench aecpt-wb' }, inner))
    : h('div', { className: 'aecpt-workbench aecpt-wb' }, inner);

  if (!status) {
    return wrapPage(error
      ? h('div', { className: 'aecpt-wb-stack' },
        h('p', { className: 'aecpt-wb-error', role: 'alert' }, error),
        h('div', null, h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: refresh }, '重试')))
      : h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…'));
  }

  if (view === 'summary') {
    return h('span', { className: 'aecpt-wb-muted' },
      status.connected ? '已连接：' + accountLabel(status) + ' · ' + status.serverUrl : '尚未连接工作台服务器');
  }

  if (!status.connected) {
    const cached = status.cachedAccount;
    const cachedWork = localWorkText(cached);
    return h(React.Fragment, null,
      wrapPage(h(React.Fragment, null,
        h('header', { className: 'aecpt-wb-header' },
          h('div', null,
            h('h1', { className: 'aecpt-wb-title' }, h(AeCptIcon, { size: 19 }), h('span', null, 'AeCpt 科研工作台')),
            h('p', { className: 'aecpt-wb-sub' }, '尚未连接工作台服务器'))),
        h('div', { className: 'aecpt-wb-card aecpt-wb-stack' },
          h('div', null,
            h('button', { type: 'button', className: 'aecpt-wb-btn', onClick: () => setGuide(true) }, cached ? '重新连接' : '连接工作台')),
          status.serverUrl
            ? h('p', { className: 'aecpt-wb-muted', style: { overflowWrap: 'anywhere' } }, '服务器：' + status.serverUrl)
            : h('p', { className: 'aecpt-wb-muted' }, '点击「连接工作台」并粘贴导师发来的邀请链接，系统将自动识别课题组服务器地址。'),
          cached && h('p', { className: 'aecpt-wb-muted' }, '本机缓存：' + accountLabel(cached) +
            ' · 最后同步：' + fmtTime(cached.lastSync) + (cachedWork ? ' · 本机还有 ' + cachedWork : ''))),
        error && h('p', { className: 'aecpt-wb-error', role: 'alert', style: { marginTop: 10 } }, error))),
      guide && h(GuideModal, { account: cached, defaultServerUrl: status.serverUrl, onClose: () => setGuide(false), onDone: () => { setGuide(false); refresh(); } }));
  }

  const createReport = () => run(async () => {
    const created = await papi('/reports/', { method: 'POST', body: JSON.stringify({ period, content }) });
    setContent('');
    setCreating(false);
    setEditing(false);
    return created;
  }, async (created, visibleReports) => {
    if (!created?.id) return;
    const targetId = refreshedReport(created, visibleReports || [])?.id ?? created.id;
    await openDetail(targetId);
  });
  const saveDraft = (id) => run(async () => {
    const updated = await papi('/reports/' + id + '/', { method: 'PATCH', body: JSON.stringify({ content: editContent }) });
    if (reportView.current?.id !== id) return;
    setDetail(updated);
    setEditContent(updated.content || '');
    setConflictText(updated.conflict?.merged || '');
    setEditing(false);
    setEditGuardNote('');
    return updated;
  }, async (updated, visibleReports) => {
    if (!updated?.dirty || !visibleReports) return;
    const current = refreshedReport(updated, visibleReports);
    if (current && (current.id !== updated.id || !current.dirty || current.has_conflict)) {
      await openDetail(current.id, updated.id);
    }
  });
  const submitReport = (id) => run(async () => {
    const updated = await papi('/reports/' + id + '/submit/', { method: 'POST', body: '{}' });
    setDetail(updated);
    setEditContent(updated.content || '');
    setEditing(false);
    setEditGuardNote('');
  });
  const resolve = (id, choice) => run(async () => {
    await papi('/reports/' + id + '/resolve/', { method: 'POST', body: JSON.stringify({ choice, content: conflictText }) });
    await openDetail(id);
  });

  const offline = !status.online;
  const ownDraft = Boolean(status.username && detail?.status === 'draft' && detail.author?.username === status.username);
  const changedBody = reportView.current.changedBody;
  const hasReportBody = Boolean((detail?.content || '').trim());
  const fragmentCount = detail?.summary_records?.length ?? 0;
  const submitHint = changedBody ? '请先保存草稿' : !hasReportBody ? '请先提炼或编写完整周报正文'
    : offline ? '提交需要在线连接'
      : detail?.dirty || detail?.local_only ? '请先同步草稿' : '';

  const goSection = next => {
    if (next === 'plan' && section !== 'plan') setCheckingPlan(true);
    setSection(next);
  };
  const selectReport = id => {
    if (detail?.id === id) { setCreating(false); return; }
    if (reportView.current?.changedBody || reportView.current?.changedConflict) {
      setEditGuardNote('当前草稿有未保存修改，请先保存或取消编辑后再切换。');
      return;
    }
    setCreating(false);
    setEditing(false);
    setEditGuardNote('');
    void openDetail(id);
  };
  const openReport = id => {
    setSection('reports');
    if (detail?.id === id && (reportView.current?.changedBody || reportView.current?.changedConflict)) return;
    setCreating(false);
    setEditing(false);
    setEditGuardNote('');
    void openDetail(id);
  };
  const openCreateForm = targetPeriod => {
    if (reportView.current?.changedBody || reportView.current?.changedConflict) {
      setEditGuardNote('当前草稿有未保存修改，请先保存或取消编辑后再新建。');
      return;
    }
    if (targetPeriod) setPeriod(targetPeriod);
    setEditing(false);
    setEditGuardNote('');
    setCreating(true);
    setSection('reports');
  };
  const tabs = [['overview', '概览'], ['reports', '科研进展'], ['plan', '计划'], ['feeds', '文献订阅'], ['library', '论文库']];
  const onTabKey = (event, index) => {
    const target = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    goSection(tabs[target][0]);
    event.currentTarget.parentElement?.children[target]?.focus();
  };

  return h(React.Fragment, null,
    wrapPage(h(React.Fragment, null,
      h('header', { className: 'aecpt-wb-header' },
        h('div', { style: { minWidth: 0 } },
          h('h1', { className: 'aecpt-wb-title' }, h(AeCptIcon, { size: 19 }), h('span', null, 'AeCpt 科研工作台')),
          h('p', { className: 'aecpt-wb-sub' }, accountLabel(status) + ' · ' + status.serverUrl)),
        h('div', { className: 'aecpt-wb-actions' },
          h(ConnectionBadge, { api: papi }),
          sessionId && h('button', {
            type: 'button', className: 'aecpt-wb-btn', disabled: summaryBusy || compileBusy || busy || !period || changedBody || reportView.current?.changedConflict,
            onClick: summarize, title: changedBody || reportView.current?.changedConflict
              ? '请先保存当前草稿修改' : `从当前对话提取进展片段并归入 ${period} 本周汇总`,
          }, summaryBusy ? '正在提取…' : '记入本周汇总'),
          h('button', { type: 'button', className: 'aecpt-wb-icon-btn', 'aria-label': '设置', title: '设置', onClick: () => setSettingsOpen(true) }, h(SettingsIcon)))),
      summaryNote && h('div', { className: 'aecpt-wb-notice', role: 'status', style: { marginBottom: 12 } },
        h('span', null, summaryNote)),
      status.authExpired && h('div', { className: 'aecpt-wb-banner', role: 'alert', style: { marginBottom: 12 } },
        '工作台登录已失效，本机缓存已保留。',
        h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', style: { marginLeft: 8 }, onClick: () => setGuide(true) }, '重新授权')),
      error && h('p', { className: 'aecpt-wb-error', role: 'alert', style: { marginBottom: 10 } }, error),
      h('div', { className: 'aecpt-wb-tabs', role: 'tablist', 'aria-label': '工作台页面' },
        tabs.map(([key, label], index) => h('button', {
          key, id: `aecpt-tab-${key}`, type: 'button', role: 'tab', className: 'aecpt-wb-tab',
          'aria-selected': section === key, 'aria-controls': `aecpt-panel-${key}`,
          tabIndex: section === key ? 0 : -1, onClick: () => goSection(key), onKeyDown: event => onTabKey(event, index),
        }, label,
        key === 'reports' && (status.pendingCount + status.conflictCount) > 0
          ? h('span', { className: 'aecpt-wb-badge', title: '待处理修改或冲突' }, status.pendingCount + status.conflictCount) : null))),
      section === 'overview' && h('div', { id: 'aecpt-panel-overview', role: 'tabpanel', 'aria-labelledby': 'aecpt-tab-overview' },
        h(OverviewPanel, {
          key: status.bindingId || 'overview',
          api: papi, active: panelActive, loading: !reportsLoaded, status, reports, academicPeriods,
          onOpenReport: openReport,
          onStartWeek: () => openCreateForm(academicPeriods?.current?.period || academicPeriods?.weeks?.[0]?.period || period),
          onSection: goSection,
        })),
      h('div', { id: 'aecpt-panel-feeds', role: 'tabpanel', 'aria-labelledby': 'aecpt-tab-feeds', hidden: section !== 'feeds' },
        h(FeedsPanel, {
          key: status.bindingId || 'feeds',
          api: papi, active: section === 'feeds' && panelActive,
        })),
      h('div', { id: 'aecpt-panel-library', role: 'tabpanel', 'aria-labelledby': 'aecpt-tab-library', hidden: section !== 'library' },
        h(LibraryPanel, {
          key: status.bindingId || 'library',
          api: papi, bindingId: status.bindingId, active: section === 'library' && panelActive,
        })),
      h('div', { id: 'aecpt-panel-plan', role: 'tabpanel', 'aria-labelledby': 'aecpt-tab-plan', hidden: section !== 'plan' },
        checkingPlan && h('p', { className: 'aecpt-wb-muted', role: 'status' }, '正在检查工作台连接…'),
        !checkingPlan && planConnectionError && h('div', { className: 'aecpt-wb-stack' },
          h('p', { className: 'aecpt-wb-error', role: 'alert' }, '无法检查工作台连接。' + planConnectionError),
          h('div', null, h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: checkPlanBinding }, '重试'))),
        planOpened && planBinding && h('div', { hidden: checkingPlan || Boolean(planConnectionError) },
          h(PlanPanel, { api: planApi, active: section === 'plan' && panelActive, key: planBinding }))),
      h('div', { id: 'aecpt-panel-reports', role: 'tabpanel', 'aria-labelledby': 'aecpt-tab-reports', hidden: section !== 'reports' },
        h('div', { className: 'aecpt-wb-stack' },
          h('div', { className: 'aecpt-wb-toolbar' },
            h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: forceSync }, busy ? '同步中…' : '刷新同步'),
            h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: doExport }, '导出 Markdown'),
            h('button', {
              type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || summaryBusy,
              'aria-expanded': creating,
              onClick: () => (creating ? setCreating(false) : openCreateForm()),
            }, creating ? '取消新建' : '手动新建草稿'),
            h('span', { className: 'aecpt-wb-muted aecpt-wb-toolbar-end' }, '最后同步：' + fmtTime(status.lastSync))),
          offline && h('div', { className: 'aecpt-wb-banner' },
            '离线模式 · 显示本地副本（最后同步：' + fmtTime(status.lastSync) + '）' +
            (status.pendingCount ? ' · ' + status.pendingCount + ' 条修改待同步' : '') +
            ' · 草稿可继续编辑，提交需在线'),
          !offline && status.pendingCount > 0 && h('div', { className: 'aecpt-wb-banner' }, status.pendingCount + ' 条修改待同步'),
          status.conflictCount > 0 && h('div', { className: 'aecpt-wb-banner' }, status.conflictCount + ' 条进展存在待解决冲突（选中对应周期处理）'),
          editGuardNote && h('div', { className: 'aecpt-wb-banner', role: 'status' }, editGuardNote),
          exportPath && h('div', { className: 'aecpt-wb-notice', role: 'status' }, h('span', null, '已导出：' + exportPath)),

          creating && h('section', { className: 'aecpt-wb-card', 'aria-label': '手动新建草稿' },
            h('div', { className: 'aecpt-wb-section-head' },
              h('h2', null, '手动新建进展草稿'),
              h('div', { className: 'aecpt-wb-toolbar' },
                academicPeriods?.weeks?.length
                  ? h('select', {
                    className: 'aecpt-wb-input', style: { width: 190 }, 'aria-label': '选择教学周',
                    value: period, onChange: e => setPeriod(e.target.value),
                  },
                    !period && h('option', { value: '', disabled: true }, '选择教学周…'),
                    academicPeriods.weeks.map(week => h('option', { key: week.period, value: week.period }, week.label)))
                  : h('input', {
                    className: 'aecpt-wb-input', style: { width: 160 }, 'aria-label': '教学周',
                    placeholder: '教学周，如 26FA13W', value: period, onChange: e => setPeriod(e.target.value),
                  }),
                h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy || summaryBusy || !period, onClick: createReport },
                  '保存草稿' + (offline ? '（离线）' : '')),
                h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => setCreating(false) }, '取消'))),
            h(ReportEditor, {
              label: '新建进展正文', placeholder: '本周学习/研究进展、困难与下一步…',
              value: content, onChange: setContent, disabled: busy,
            })),

          !creating && !reportsLoaded && h('p', { className: 'aecpt-wb-muted', role: 'status' }, '正在加载进展…'),

          !creating && reportsLoaded && reports.length === 0 && h('section', { className: 'aecpt-wb-card aecpt-wb-empty' },
            h('p', null, '暂无科研进展。'),
            h('p', null, '可在对话窗口右上角点「进展总结」自动收集每次对话的进展片段，最后一键提炼成完整周报，也可以手动新建草稿。'),
            h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: () => openCreateForm() }, '手动新建草稿')),

          !creating && reports.length > 0 && h('div', { className: 'aecpt-wb-reports-layout' },
            h('aside', { className: 'aecpt-wb-report-nav', 'aria-label': '进展列表' },
              h('div', { className: 'aecpt-wb-report-nav-head' },
                h('h2', null, '我的进展'),
                h('span', { className: 'aecpt-wb-badge' }, reports.length)),
              h('ol', { className: 'aecpt-wb-report-list' }, reports.map(r => h('li', { key: String(r.id) },
                h('button', {
                  type: 'button', className: 'aecpt-wb-report-row',
                  'aria-current': detail?.id === r.id ? 'true' : undefined,
                  onClick: () => selectReport(r.id),
                },
                  h('span', { className: 'aecpt-wb-report-main' },
                    h('strong', null, periodLabel(r)),
                    r.feedback_count > 0 && h('span', { className: 'aecpt-wb-muted' }, `反馈 ${r.feedback_count}`)),
                  h('span', { className: 'aecpt-wb-report-meta' },
                    h('span', { className: 'aecpt-wb-chip', 'data-tone': r.has_conflict ? 'danger' : (REPORT_TONE[r.status] || '') },
                      r.status_display + (r.dirty ? ' · 未同步' : '') + (r.has_conflict ? ' · 冲突' : '')),
                    r.summary_count > 0 && h('span', { className: 'aecpt-wb-muted' },
                      `汇总 ${r.summary_count} 条` + (r.status === 'draft' && r.has_content === false ? ' · 待提炼' : '')),
                    r.project && h('span', { className: 'aecpt-wb-muted' }, r.project.name || r.project))))))),

            h('article', { className: 'aecpt-wb-card aecpt-wb-report-reader', 'aria-label': '进展正文' },
              !detail
                ? h('p', { className: 'aecpt-wb-muted', role: 'status' }, '正在加载进展正文…')
                : h(React.Fragment, null,
                  h('div', { className: 'aecpt-wb-section-head' },
                    h('div', { style: { minWidth: 0 } },
                      h('strong', { style: { fontSize: 16 } }, periodLabel(detail)),
                      h('span', { className: 'aecpt-wb-muted', style: { marginLeft: 8 } },
                        authorName(detail.author) + ' · #' + detail.id + ' · rev' + detail.revision),
                      detail.project && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 2 } }, '项目：' + (detail.project.name || detail.project))),
                    h('div', { className: 'aecpt-wb-toolbar' },
                      h('span', { className: 'aecpt-wb-chip', 'data-tone': detail.has_conflict ? 'danger' : (REPORT_TONE[detail.status] || '') },
                        detail.status_display + (detail.dirty ? ' · 未同步' : '')),
                      ownDraft && !detail.has_conflict && !editing && fragmentCount > 0 && h('button', {
                        type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || summaryBusy || compileBusy,
                        title: hasReportBody ? '将已有周报正文与本周所有碎片融合更新' : '一键调用模型将本周所有碎片提炼为完整周报',
                        onClick: () => compileReport(detail.id),
                      }, compileBusy ? '正在提炼…' : (hasReportBody ? 'AI 融合更新' : 'AI 提炼周报')),
                      ownDraft && !detail.has_conflict && !editing && h('button', {
                        type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || summaryBusy || compileBusy,
                        onClick: () => { setReportTab('report'); setEditContent(detail.content || ''); setEditing(true); setEditGuardNote(''); },
                      }, '编辑'),
                      ownDraft && !detail.has_conflict && !editing && h('button', {
                        type: 'button', className: 'aecpt-wb-btn', disabled: busy || summaryBusy || compileBusy || Boolean(submitHint),
                        title: submitHint || '提交给导师审阅（提交后锁定）',
                        onClick: () => submitReport(detail.id),
                      }, '提交进展'))),

                  h('div', { className: 'aecpt-wb-segmented', role: 'group', 'aria-label': '进展视图切换', style: { marginBottom: 10 } },
                    h('button', {
                      type: 'button',
                      'aria-pressed': reportTab === 'report',
                      disabled: editing,
                      onClick: () => setReportTab('report'),
                    }, '完整周报', ownDraft && detail.uncompiled_count > 0 && h('span', { className: 'aecpt-wb-badge', title: '有新片段尚未融入周报' }, `+${detail.uncompiled_count}`)),
                    h('button', {
                      type: 'button',
                      'aria-pressed': reportTab === 'fragments',
                      disabled: editing,
                      onClick: () => setReportTab('fragments'),
                    }, `本周汇总 (${fragmentCount})`)),

                  ownDraft && !detail.has_conflict && !editing && submitHint && reportTab === 'report'
                    && h('p', { className: 'aecpt-wb-muted', role: 'status', style: { marginBottom: 8 } }, submitHint),

                  ownDraft && detail.has_conflict && detail.conflict && h('div', { className: 'aecpt-wb-banner', style: { marginBottom: 12 } },
                    h('strong', null, '同步冲突：本地修改与服务器更新重叠'),
                    h('div', { className: 'aecpt-wb-conflict-cols' },
                      h('div', null, h('p', { className: 'aecpt-wb-muted' }, '服务器版本'), h('div', { className: 'aecpt-wb-pre' }, detail.conflict.server)),
                      h('div', null, h('p', { className: 'aecpt-wb-muted' }, '本地版本'), h('div', { className: 'aecpt-wb-pre' }, detail.conflict.local))),
                    h('p', { className: 'aecpt-wb-muted', style: { marginTop: 6 } }, '合并结果（含冲突标记，可手工编辑后保存）：'),
                    h('textarea', {
                      className: 'aecpt-wb-input', style: { minHeight: 100, marginTop: 4 },
                      value: conflictText, onChange: e => setConflictText(e.target.value), disabled: summaryBusy || compileBusy,
                    }),
                    h('div', { className: 'aecpt-wb-toolbar', style: { marginTop: 8 } },
                      h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || summaryBusy || compileBusy, onClick: () => resolve(detail.id, 'local') }, '保留本地'),
                      h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || summaryBusy || compileBusy, onClick: () => resolve(detail.id, 'server') }, '保留服务器'),
                      h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy || summaryBusy || compileBusy, onClick: () => resolve(detail.id, 'custom') }, '保存编辑后的合并结果'))),

                  reportTab === 'fragments' && !editing
                    ? h(WeeklyFragmentsView, {
                      detail,
                      ownDraft,
                      busy: busy || summaryBusy,
                      compileBusy,
                      onCompile: () => compileReport(detail.id),
                      onAddManual: text => addManualFragment(detail.period, text),
                      onRemove: recordId => removeFragment(detail.id, recordId),
                    })
                    : ownDraft && !detail.has_conflict && editing
                      ? h('div', { className: 'aecpt-wb-report-body' },
                        h(ReportEditor, { key: detail.id, label: '进展正文', value: editContent, onChange: setEditContent, disabled: busy || summaryBusy || compileBusy }),
                        h('div', { className: 'aecpt-wb-toolbar', style: { marginTop: 10 } },
                          h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy || summaryBusy || compileBusy, onClick: () => saveDraft(detail.id) }, '保存草稿' + (offline ? '（本地）' : '')),
                          h('button', {
                            type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || summaryBusy || compileBusy,
                            onClick: () => { setEditContent(detail.content || ''); setEditing(false); setEditGuardNote(''); },
                          }, '取消编辑')))
                      : !detail.has_conflict && h('div', { className: 'aecpt-wb-report-body' },
                        ownDraft && detail.can_undo_compile && h('div', { className: 'aecpt-wb-notice', style: { marginBottom: 10 } },
                          h('span', null, `已由 AI 提炼生成完整周报${detail.last_compiled_model ? `（${detail.last_compiled_model}）` : ''}`),
                          h('button', {
                            type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || compileBusy,
                            onClick: () => undoCompile(detail.id),
                          }, '撤销本次提炼')),
                        ownDraft && hasReportBody && detail.uncompiled_count > 0 && h('div', { className: 'aecpt-wb-notice', style: { marginBottom: 10 } },
                          h('span', null, `「本周汇总」新增了 ${detail.uncompiled_count} 条过程片段，尚未融入当前周报`),
                          h('button', {
                            type: 'button', className: 'aecpt-wb-btn', disabled: busy || summaryBusy || compileBusy,
                            onClick: () => compileReport(detail.id),
                          }, compileBusy ? '正在提炼…' : '一键融合更新')),
                        !hasReportBody && ownDraft
                          ? h('div', { className: 'aecpt-wb-empty' },
                            h('p', null, fragmentCount > 0
                              ? `本周已汇总 ${fragmentCount} 条零碎过程记录，尚未提炼为完整周报。`
                              : '本周完整周报尚为空白。'),
                            h('div', { className: 'aecpt-wb-toolbar' },
                              fragmentCount > 0 && h('button', {
                                type: 'button', className: 'aecpt-wb-btn', disabled: busy || summaryBusy || compileBusy,
                                onClick: () => compileReport(detail.id),
                              }, compileBusy ? '正在提炼…' : '一键 AI 提炼完整周报'),
                              fragmentCount > 0 && h('button', {
                                type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || compileBusy,
                                onClick: () => setReportTab('fragments'),
                              }, `查看本周汇总 (${fragmentCount})`),
                              h('button', {
                                type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy || compileBusy,
                                onClick: () => { setEditContent(''); setEditing(true); },
                              }, '手动编写')))
                          : h(ReportMarkdown, { value: detail.content })),

                  (detail.feedback || []).map(f => h('div', { key: f.id, className: 'aecpt-wb-feedback' },
                    h('p', { className: 'aecpt-wb-muted', style: { marginBottom: 4 } }, '导师反馈 · ' + authorName(f.author) + ' · ' + fmtTime(f.created_at)),
                    h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, f.content)))))))))),
    settingsOpen && h(SettingsModal, { status, api: papi, onClose: () => setSettingsOpen(false), onDone: () => { setSettingsOpen(false); refresh(); } }),
    guide && h(GuideModal, {
      account: { ...status, authExpired: Boolean(status.authExpired) },
      onClose: () => setGuide(false), onDone: () => { setGuide(false); refresh(); },
    }));
}

/** Top-right session utility: opens the workbench in a popover. */
function WorkbenchUtility({ sessionId }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setOpen(false);
      btnRef.current?.focus();
    };
    const onResize = () => setRect(btnRef.current?.getBoundingClientRect() || null);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen(!open);
  };

  return h('div', { style: { position: 'relative' } },
    h('button', {
      type: 'button', ref: btnRef, onClick: toggle, title: 'AeCpt 会话进展总结', 'aria-expanded': open,
      className: 'aecpt-wb-utility-btn',
    }, h(AeCptIcon, { size: 15 }), '进展总结'),
    rect && h('div', {
      ref: popRef, hidden: !open,
      className: 'aecpt-wb-popover',
      style: {
        top: rect.bottom + 8,
        right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 468)),
      },
    }, h(SessionPopover, { sessionId, active: open, api, GuideModal, accountLabel })));
}

/** Pure geometric AeCpt student mark (Aesthetic ∩ Computing dual-ring + spark). */
function AeCptIcon({ size = 18 }) {
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
    fill: 'none', stroke: 'currentColor', strokeWidth: '1.6',
    strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { flexShrink: 0, display: 'block' },
  },
    h('circle', { cx: '9.2', cy: '12', r: '5.6' }),
    h('circle', { cx: '14.8', cy: '12', r: '5.6' }),
    h('path', {
      d: 'M12 9.8l.5 1.7 1.7.5-1.7.5-.5 1.7-.5-1.7-1.7-.5 1.7-.5.5-1.7Z',
      fill: 'currentColor', stroke: 'none',
    }),
  );
}

/** Global panel icon for the sidebar panel list (the plugin bar). */
function PanelIcon({ size = 18 } = {}) {
  return h(AeCptIcon, { size });
}

function MainPanelEntry(props) {
  return h(Panel, { ...props, surface: 'main' });
}

function ConfigPanelEntry(props) {
  return h(Panel, { ...props, surface: 'embedded' });
}

export const inject = ['slots'];

export function apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'aecpt',
    order: 46,
    label: 'AeCpt 科研工作台',
  }, PanelIcon));
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'aecpt',
  }, MainPanelEntry));
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: 'dsh-aecpt#dsh-aecpt',
  }, ConfigPanelEntry));
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'aecpt-workbench',
    order: -5,
  }, WorkbenchUtility));
}
