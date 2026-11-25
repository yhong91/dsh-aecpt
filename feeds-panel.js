import React from 'react';

const h = React.createElement;
const { useCallback, useEffect, useRef, useState } = React;

const KINDS = [
  ['journal', '期刊 RSS / Atom'],
  ['arxiv', 'arXiv 分类'],
  ['blog', '博客 / 资讯'],
];

const CUSTOM_ARXIV = '__custom__';
const fmtTime = iso => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '从未';

function AddSourceForm({ api, presets, existing, onAdded }) {
  const [kind, setKind] = useState('journal');
  const [customArxiv, setCustomArxiv] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const available = presets.filter(preset => !existing.has(preset.url));
  const usePresetSelect = kind === 'arxiv' && available.length > 0 && !customArxiv;

  function changeKind(nextKind) {
    setKind(nextKind);
    setCustomArxiv(false);
    setUrl('');
    setName('');
    setError('');
  }

  function changePreset(value) {
    setError('');
    if (value === CUSTOM_ARXIV) {
      setCustomArxiv(true);
      setUrl('');
      setName('');
      return;
    }
    setUrl(value);
    setName(presets.find(p => p.url === value)?.name || '');
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const source = await api('/feeds/sources/', { method: 'POST', body: JSON.stringify({ kind, url: url.trim(), name: name.trim() }) });
      setUrl(''); setName(''); setCustomArxiv(false);
      onAdded(source);
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  return h('form', { className: 'aecpt-wb-card', onSubmit: submit },
    h('div', { className: 'aecpt-wb-form' },
      h('label', null, '类型',
        h('select', { className: 'aecpt-wb-input', value: kind, disabled: busy, onChange: e => changeKind(e.target.value) },
          KINDS.map(([value, label]) => h('option', { key: value, value }, label)))),
      usePresetSelect
        ? h('label', null, '分类',
          h('select', {
            className: 'aecpt-wb-input', value: url, disabled: busy,
            onChange: e => changePreset(e.target.value),
          },
            h('option', { value: '' }, '选择预设分类…'),
            available.map(preset => h('option', { key: preset.url, value: preset.url }, preset.name)),
            h('option', { value: CUSTOM_ARXIV }, '自定义 arXiv 查询链接…')))
        : h('label', null, '订阅链接',
          h('input', {
            className: 'aecpt-wb-input', value: url, disabled: busy, inputMode: 'url',
            placeholder: kind === 'journal'
              ? '期刊主页 RSS 图标里的链接'
              : kind === 'arxiv'
                ? 'https://export.arxiv.org/api/query?search_query=cat:cs.SE'
                : 'https://…/feed',
            onChange: e => setUrl(e.target.value),
          })),
      h('label', null, '名称（可选）',
        h('input', { className: 'aecpt-wb-input', value: name, disabled: busy, placeholder: '默认读取订阅标题', onChange: e => setName(e.target.value) })),
      h('button', { type: 'submit', className: 'aecpt-wb-btn', disabled: busy || !url.trim() }, busy ? '正在验证…' : '添加订阅')),
    kind === 'arxiv' && h('p', { className: 'aecpt-wb-muted', style: { marginTop: 8 } },
      customArxiv && available.length
        ? h(React.Fragment, null, '粘贴任意 arXiv API 查询链接，或 ',
          h('button', { type: 'button', className: 'aecpt-wb-link', onClick: () => { setCustomArxiv(false); setUrl(''); setName(''); } }, '返回预设分类'))
        : available.length
          ? '选择预设分类，或在下拉框中选择「自定义 arXiv 查询链接」添加其他学科分类。'
          : '预设分类都已添加，可直接粘贴其他 arXiv API 查询链接。'),
    error && h('p', { className: 'aecpt-wb-error', role: 'alert', style: { marginTop: 8 } }, error));
}

function SourceList({ api, sources, onChanged, onRemoved, busy, setBusy }) {
  const [confirming, setConfirming] = useState('');
  const [error, setError] = useState('');
  async function run(action, removedId) {
    setBusy(true); setError('');
    try {
      await action();
      if (removedId) {
        setConfirming('');
        onRemoved?.(removedId);
      } else {
        await onChanged();
      }
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }
  return h('div', { className: 'aecpt-wb-card' },
    h('h3', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, `已订阅 ${sources.length} 个`),
    sources.map(source => h('div', { key: source.id, className: 'aecpt-wb-source' },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { overflowWrap: 'anywhere' } }, source.name, ' ',
          h('span', { className: 'aecpt-wb-chip' }, source.kindLabel)),
        h('p', { className: 'aecpt-wb-muted' }, `${source.itemCount} 篇 · 未读 ${source.unreadCount} · 更新于 ${fmtTime(source.lastFetchedAt)}`),
        source.lastError && h('p', { className: 'aecpt-wb-error' }, '上次刷新失败：' + source.lastError)),
      h('div', { className: 'aecpt-wb-entry-actions' },
        h('button', {
          type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy,
          onClick: () => run(() => api('/feeds/refresh', { method: 'POST', body: JSON.stringify({ sourceId: source.id }) })),
        }, '刷新'),
        confirming === source.id
          ? h(React.Fragment, null,
            h('button', {
              type: 'button', className: 'aecpt-wb-btn', disabled: busy,
              onClick: () => run(
                () => api(`/feeds/sources/${encodeURIComponent(source.id)}/`, { method: 'DELETE' }),
                source.id,
              ),
            }, '确认删除'),
            h('button', {
              type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy,
              onClick: () => setConfirming(''),
            }, '取消'))
          : h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => setConfirming(source.id) }, '删除')))),
    error && h('p', { className: 'aecpt-wb-error', role: 'alert', style: { marginTop: 8 } }, error));
}

function Entry({ item, busy, onRead }) {
  const [open, setOpen] = useState(false);
  const summaryId = `aecpt-feed-${item.sourceId}-${item.key}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const meta = [item.sourceName, item.publishedAt, item.authors].filter(Boolean).join(' · ');
  return h('li', { className: 'aecpt-wb-entry', 'data-read': item.read ? 'true' : 'false' },
    h('div', { className: 'aecpt-wb-entry-head' },
      h('button', {
        type: 'button', className: 'aecpt-wb-toggle', 'aria-expanded': open, 'aria-controls': summaryId,
        'aria-label': open ? '收起摘要' : '展开摘要', disabled: !item.summary, onClick: () => setOpen(!open),
      }, '▸'),
      h('a', {
        className: 'aecpt-wb-entry-title', href: item.url, target: '_blank', rel: 'noreferrer',
        onClick: () => { if (!item.read) onRead(item, true); },
      }, !item.read && h('span', { className: 'aecpt-wb-unread-dot', 'aria-label': '未读' }), item.title),
      h('div', { className: 'aecpt-wb-entry-actions' },
        h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => onRead(item, !item.read) },
          item.read ? '标为未读' : '标为已读'))),
    meta && h('p', { className: 'aecpt-wb-entry-meta' }, meta),
    open && item.summary && h('p', { id: summaryId, className: 'aecpt-wb-entry-summary' }, item.summary));
}

/** Personal literature subscriptions (stored on this device). */
export function FeedsPanel({ api, active }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('');
  const [unread, setUnread] = useState(false);
  const [managing, setManaging] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async (overrideSource) => {
    const seq = ++loadSeq.current;
    const activeSource = overrideSource !== undefined ? overrideSource : source;
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (activeSource) params.set('source', activeSource);
      if (unread) params.set('unread', '1');
      const next = await api('/feeds/?' + params);
      if (seq !== loadSeq.current) return;
      setData(next);
      setError('');
      if (!next.sources.length) setManaging(true);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(String(e.message || e));
    }
  }, [api, source, unread]);

  useEffect(() => { if (active) load(); }, [active, load]);

  async function run(action, makeNotice) {
    setBusy(true); setError(''); setNotice(null);
    try {
      const result = await action();
      if (makeNotice) {
        const value = typeof makeNotice === 'function' ? makeNotice(result) : makeNotice;
        setNotice(typeof value === 'string' ? { text: value } : value);
      }
      await load();
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }

  const refreshAll = () => run(
    () => api('/feeds/refresh', { method: 'POST', body: '{}' }),
    result => `已刷新 ${result.refreshed} 个订阅，新增 ${result.added} 篇${result.failed ? `，${result.failed} 个失败` : ''}`);
  const markRead = (item, read) => run(() => api('/feeds/read', {
    method: 'POST', body: JSON.stringify({ sourceId: item.sourceId, key: item.key, read }),
  }));
  if (!data) {
    return h('div', { className: 'aecpt-wb-feeds' },
      error ? h('div', { className: 'aecpt-wb-stack' },
        h('p', { className: 'aecpt-wb-error', role: 'alert' }, error),
        h('div', null, h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: () => load() }, '重试')))
        : h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…'));
  }

  const existing = new Set(data.sources.map(item => item.url));
  return h('div', { className: 'aecpt-wb-feeds' },
    h('div', { className: 'aecpt-wb-toolbar' },
      h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy || !data.sources.length, onClick: refreshAll },
        busy ? '处理中…' : '刷新全部'),
      h('label', null, '来源',
        h('select', { className: 'aecpt-wb-input', value: source, onChange: e => setSource(e.target.value) },
          h('option', { value: '' }, '全部订阅'),
          data.sources.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
      h('label', null,
        h('input', { type: 'checkbox', checked: unread, onChange: e => setUnread(e.target.checked) }),
        `只看未读（${data.unreadCount}）`),
      h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', 'aria-expanded': managing, onClick: () => setManaging(!managing) },
        managing ? '收起订阅管理' : '管理订阅')),
    notice && h('div', { className: 'aecpt-wb-notice', role: 'status' },
      h('span', null, notice.text)),
    error && h('p', { className: 'aecpt-wb-error', role: 'alert' }, error),
    managing && h(AddSourceForm, {
      api, presets: data.presets || [], existing,
      onAdded: added => { setNotice({ text: `已订阅 ${added.name}，读到 ${added.itemCount} 篇` }); load(); },
    }),
    managing && data.sources.length > 0 && h(SourceList, {
      api, sources: data.sources, busy, setBusy,
      onRemoved: removedId => {
        setNotice({ text: '已删除订阅' });
        if (source === removedId) {
          setSource('');
          void load('');
        } else {
          void load();
        }
      },
      onChanged: () => load(),
    }),
    h('div', { className: 'aecpt-wb-card' },
      !data.sources.length
        ? h('div', { className: 'aecpt-wb-empty' },
          h('p', null, '还没有订阅。期刊 RSS 一般在期刊主页的 RSS 图标里；arXiv 可以直接选预设分类。'),
          h('p', null, '订阅内容只保存在这台电脑上，不会上传到 AeCpt 服务器。'))
        : data.items.length
          ? h('ol', { className: 'aecpt-wb-rows', 'aria-label': '订阅文章' }, data.items.map(item => h(Entry, {
            key: `${item.sourceId}:${item.key}`, item, busy, onRead: markRead,
          })))
          : h('p', { className: 'aecpt-wb-empty' }, unread ? '没有未读文章。' : '暂无文章，点「刷新全部」获取最新内容。')));
}
