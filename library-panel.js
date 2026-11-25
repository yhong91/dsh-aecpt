import React from 'react';

const h = React.createElement;
const { useCallback, useEffect, useRef, useState } = React;

const STATUS = {
  pending: ['待审核', 'warn'],
  approved: ['已入库', 'done'],
  rejected: ['未通过', 'danger'],
};
const MAX_PDF = 50 * 1024 * 1024;
const VIEWS = [['browse', '公用库'], ['mine', '我的投稿'], ['submit', '提交论文']];

const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('zh-CN') : '';
const personName = p => (p && (p.name || p.username)) || '';
const parseTags = text => [...new Set(String(text || '').split(/[,，、;；]/).map(item => item.trim()).filter(Boolean))];
const fmtSize = bytes => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round((bytes || 0) / 1024)) + ' KB';

function authorsText(list) {
  if (!list?.length) return '';
  return list.length > 4 ? list.slice(0, 3).join(', ') + ' 等' : list.join(', ');
}
const metaLine = paper => [authorsText(paper.authors), paper.year, paper.venue].filter(Boolean).join(' · ');

function statusChip(status) {
  const [label, tone] = STATUS[status] || [status, ''];
  return h('span', { className: 'aecpt-wb-chip', 'data-tone': tone }, label);
}

function dispositionName(header) {
  const text = String(header || '');
  const star = text.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  return text.match(/filename\s*=\s*"([^"]+)"/)?.[1] || '';
}

/** Hand a Blob to the browser's download flow via a detached link. */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** PDF bytes are not JSON, so this bypasses the JSON helper but sends the
 * same panel marker and binding headers. */
async function fetchPdf(bindingId, id) {
  const headers = { 'X-Aecpt-Client': '1' };
  if (bindingId) headers['X-Aecpt-Binding'] = bindingId;
  const res = await fetch(`/aecpt-api/library/papers/${id}/pdf`, { cache: 'no-store', headers });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.detail || '下载失败：HTTP ' + res.status);
  }
  return { blob: await res.blob(), filename: dispositionName(res.headers.get('content-disposition')) || `paper-${id}.pdf` };
}

async function copyText(text) {
  if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板');
  await navigator.clipboard.writeText(text);
}

function Facts({ rows }) {
  const visible = rows.filter(([, value]) => value);
  if (!visible.length) return null;
  return h('dl', { className: 'aecpt-wb-facts' }, visible.map(([label, value]) => h(React.Fragment, { key: label },
    h('dt', null, label), h('dd', null, value))));
}

const extLink = (href, text) => h('a', { className: 'aecpt-wb-link', href, target: '_blank', rel: 'noreferrer' }, text);

function PaperRow({ paper, selected, onSelect, busy, onDownload, onCopy }) {
  const [open, setOpen] = useState(false);
  const detailId = `aecpt-paper-${paper.id}`;
  const meta = metaLine(paper);
  return h('li', { className: 'aecpt-wb-paper' },
    h('div', { className: 'aecpt-wb-paper-head' },
      h('input', {
        type: 'checkbox', checked: selected, onChange: e => onSelect(paper.id, e.target.checked),
        'aria-label': `选择《${paper.title}》`,
      }),
      h('div', { className: 'aecpt-wb-paper-main' },
        h('button', {
          type: 'button', className: 'aecpt-wb-paper-title', 'aria-expanded': open, 'aria-controls': detailId,
          onClick: () => setOpen(!open),
        }, paper.title),
        meta && h('p', { className: 'aecpt-wb-paper-meta' }, meta),
        paper.tags?.length > 0 && h('div', { className: 'aecpt-wb-paper-tags' },
          paper.tags.map(tag => h('span', { key: tag, className: 'aecpt-wb-chip' }, tag))))),
    open && h('div', { id: detailId, className: 'aecpt-wb-paper-detail' },
      paper.abstract
        ? h('p', { className: 'aecpt-wb-paper-abstract' }, paper.abstract)
        : h('p', { className: 'aecpt-wb-muted' }, '没有摘要。'),
      h(Facts, {
        rows: [
          ['DOI', paper.doi && extLink('https://doi.org/' + paper.doi, paper.doi)],
          ['arXiv', paper.arxiv_id && extLink('https://arxiv.org/abs/' + paper.arxiv_id, paper.arxiv_id)],
          ['链接', paper.url && !paper.doi && !paper.arxiv_id && extLink(paper.url, paper.url)],
          ['推荐人', personName(paper.submitted_by)],
          ['推荐理由', paper.note],
          ['PDF', paper.pdf?.name && `${paper.pdf.name}（${fmtSize(paper.pdf.size)}）`],
        ],
      }),
      h('div', { className: 'aecpt-wb-entry-actions aecpt-wb-paper-actions' },
        h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => onDownload(paper) }, '下载 PDF'),
        h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => onCopy(paper) }, '复制 BibTeX'))));
}

function BibtexFallback({ text, onClose }) {
  if (!text) return null;
  return h('div', { className: 'aecpt-wb-card aecpt-wb-stack' },
    h('div', { className: 'aecpt-wb-section-head' },
      h('h2', null, '无法写入剪贴板，请手动复制'),
      h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: onClose }, '关闭')),
    h('textarea', {
      className: 'aecpt-wb-input aecpt-wb-bibtex', readOnly: true, value: text, rows: 8, 'aria-label': 'BibTeX 文本',
      onFocus: e => e.target.select(),
    }));
}

function LibraryBrowser({ api, bindingId, active }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tag, setTag] = useState('');
  const [papers, setPapers] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [fallback, setFallback] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const current = ++seq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debounced) params.set('q', debounced);
      if (tag) params.set('tag', tag);
      const qs = params.toString();
      const rows = await api('/library/papers/' + (qs ? '?' + qs : ''));
      if (current !== seq.current) return;
      setPapers(rows || []);
      setError('');
    } catch (e) {
      if (current !== seq.current) return;
      setError(String(e.message || e));
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [api, debounced, tag]);

  useEffect(() => { if (active) load(); }, [active, load]);

  async function run(action) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(String(e.message || e)); } finally { setBusy(false); }
  }

  const exportBibtex = async ids => {
    const result = await api('/library/export/?ids=' + ids.join(','));
    if (!result?.count) throw new Error('没有可导出的论文');
    return result;
  };
  const copyBibtex = async (text, done) => {
    try {
      await copyText(text);
      setFallback('');
      setNotice(done);
    } catch {
      setFallback(text);
    }
  };
  const download = paper => run(async () => {
    const { blob, filename } = await fetchPdf(bindingId, paper.id);
    saveBlob(blob, filename);
    setNotice(`已开始下载：${filename}`);
  });
  const copyOne = paper => run(async () => {
    const result = await exportBibtex([paper.id]);
    await copyBibtex(result.bibtex, '已复制 BibTeX');
  });
  const exportSelected = () => run(async () => {
    const result = await exportBibtex([...selected]);
    saveBlob(new Blob([result.bibtex], { type: 'application/x-bibtex;charset=utf-8' }), 'aecpt-library.bib');
    await copyBibtex(result.bibtex, `已导出 ${result.count} 条 BibTeX：已复制到剪贴板并下载 aecpt-library.bib`);
  });
  const toggle = (id, on) => setSelected(prev => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const tagCounts = new Map();
  for (const paper of papers || []) for (const item of paper.tags || []) tagCounts.set(item, (tagCounts.get(item) || 0) + 1);
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).slice(0, 24).map(([name]) => name);
  if (tag && !tags.includes(tag)) tags.unshift(tag);
  const visibleIds = (papers || []).map(paper => paper.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));

  return h('div', { className: 'aecpt-wb-stack' },
    h('div', { className: 'aecpt-wb-toolbar', role: 'search' },
      h('input', {
        type: 'search', className: 'aecpt-wb-input aecpt-wb-search', value: query,
        placeholder: '搜索标题、作者、期刊、DOI、摘要或标签', 'aria-label': '搜索公用库',
        onChange: e => setQuery(e.target.value),
      }),
      loading && h('span', { className: 'aecpt-wb-muted', role: 'status' }, '搜索中…')),
    tags.length > 0 && h('div', { className: 'aecpt-wb-tagbar', role: 'group', 'aria-label': '按标签筛选' },
      tags.map(name => h('button', {
        key: name, type: 'button', className: 'aecpt-wb-chip aecpt-wb-chip-btn', 'aria-pressed': tag === name,
        onClick: () => setTag(tag === name ? '' : name),
      }, name))),
    notice && h('div', { className: 'aecpt-wb-notice', role: 'status' }, h('span', null, notice)),
    error && h('div', { className: 'aecpt-wb-stack' },
      h('p', { className: 'aecpt-wb-error', role: 'alert' }, error),
      !papers && h('div', null, h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: load }, '重试'))),
    h(BibtexFallback, { text: fallback, onClose: () => setFallback('') }),
    papers && papers.length > 0 && h('div', { className: 'aecpt-wb-toolbar' },
      h('label', null,
        h('input', {
          type: 'checkbox', checked: allVisibleSelected,
          onChange: e => setSelected(prev => {
            const next = new Set(prev);
            for (const id of visibleIds) { if (e.target.checked) next.add(id); else next.delete(id); }
            return next;
          }),
        }),
        '全选当前结果'),
      h('span', { className: 'aecpt-wb-muted' }, `共 ${papers.length} 篇 · 已选 ${selected.size} 篇`),
      h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy || !selected.size, onClick: exportSelected }, '导出所选 BibTeX'),
      selected.size > 0 && h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => setSelected(new Set()) }, '清除选择')),
    h('div', { className: 'aecpt-wb-card' },
      !papers
        ? (!error && h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…'))
        : papers.length
          ? h('ol', { className: 'aecpt-wb-rows', 'aria-label': '公用库论文' }, papers.map(paper => h(PaperRow, {
            key: paper.id, paper, busy, selected: selected.has(paper.id), onSelect: toggle, onDownload: download, onCopy: copyOne,
          })))
          : h('div', { className: 'aecpt-wb-empty' },
            debounced || tag
              ? h('p', null, '没有找到匹配的论文。')
              : h(React.Fragment, null,
                h('p', null, '公用库还没有论文。'),
                h('p', null, '在「提交论文」中推荐论文，导师审核通过后对课题组所有成员可见。')))));
}

function SubmissionRow({ paper, api, onChanged, setNotice }) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState((paper.tags || []).join(', '));
  const [note, setNote] = useState(paper.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canWithdraw = paper.can_delete && (paper.status === 'pending' || paper.status === 'rejected');
  const canEdit = paper.can_edit && paper.status === 'pending';

  async function run(action, message) {
    setBusy(true); setError('');
    try {
      await action();
      setNotice(message);
      await onChanged();
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }
  const withdraw = () => run(() => api(`/library/papers/${paper.id}/`, { method: 'DELETE' }), `已撤回：${paper.title}`);
  const save = event => {
    event.preventDefault();
    run(async () => {
      await api(`/library/papers/${paper.id}/`, { method: 'PATCH', body: JSON.stringify({ tags: parseTags(tags), note: note.trim() }) });
      setEditing(false);
    }, '已保存修改');
  };

  return h('li', { className: 'aecpt-wb-paper' },
    h('div', { className: 'aecpt-wb-submission-head' },
      statusChip(paper.status),
      h('div', { className: 'aecpt-wb-paper-main' },
        h('p', { className: 'aecpt-wb-submission-title' }, paper.title),
        h('p', { className: 'aecpt-wb-paper-meta' }, [metaLine(paper), '提交于 ' + fmtDate(paper.submitted_at)].filter(Boolean).join(' · '))),
      (canEdit || canWithdraw) && h('div', { className: 'aecpt-wb-entry-actions' },
        canEdit && !editing && h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => setEditing(true) }, '编辑'),
        canWithdraw && (confirming
          ? h(React.Fragment, null,
            h('button', { type: 'button', className: 'aecpt-wb-btn', disabled: busy, onClick: withdraw }, '确认撤回'),
            h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => setConfirming(false) }, '取消'))
          : h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: () => setConfirming(true) }, '撤回')))),
    paper.status === 'rejected' && h('div', { className: 'aecpt-wb-review-note' },
      h('strong', null, '导师意见'), personName(paper.reviewed_by) ? `（${personName(paper.reviewed_by)}）` : '', '：',
      paper.review_note || '未填写'),
    paper.status === 'approved' && h('p', { className: 'aecpt-wb-muted aecpt-wb-submission-sub' },
      '已入库，课题组成员可在公用库中查看' + (paper.reviewed_at ? ' · 审核于 ' + fmtDate(paper.reviewed_at) : '')),
    !editing && paper.tags?.length > 0 && h('div', { className: 'aecpt-wb-paper-tags aecpt-wb-submission-sub' },
      paper.tags.map(tag => h('span', { key: tag, className: 'aecpt-wb-chip' }, tag))),
    editing && h('form', { className: 'aecpt-wb-lib-form aecpt-wb-submission-sub', onSubmit: save },
      h('label', { className: 'aecpt-wb-field-wide' }, '标签（逗号分隔）',
        h('input', { className: 'aecpt-wb-input', value: tags, disabled: busy, onChange: e => setTags(e.target.value) })),
      h('label', { className: 'aecpt-wb-field-wide' }, '推荐理由',
        h('textarea', { className: 'aecpt-wb-input aecpt-wb-textarea', rows: 3, value: note, disabled: busy, onChange: e => setNote(e.target.value) })),
      h('div', { className: 'aecpt-wb-entry-actions aecpt-wb-field-wide aecpt-wb-form-actions' },
        h('button', { type: 'submit', className: 'aecpt-wb-btn', disabled: busy }, busy ? '保存中…' : '保存'),
        h('button', {
          type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy,
          onClick: () => { setEditing(false); setTags((paper.tags || []).join(', ')); setNote(paper.note || ''); },
        }, '取消'))),
    error && h('p', { className: 'aecpt-wb-error aecpt-wb-submission-sub', role: 'alert' }, error));
}

function MySubmissions({ api, active, reloadKey }) {
  const [papers, setPapers] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const current = ++seq.current;
    try {
      const rows = await api('/library/submissions/');
      if (current !== seq.current) return;
      setPapers(rows || []);
      setError('');
    } catch (e) {
      if (current === seq.current) setError(String(e.message || e));
    }
  }, [api]);

  useEffect(() => { if (active) load(); }, [active, load, reloadKey]);

  if (!papers) {
    return error
      ? h('div', { className: 'aecpt-wb-stack' },
        h('p', { className: 'aecpt-wb-error', role: 'alert' }, error),
        h('div', null, h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', onClick: load }, '重试')))
      : h('p', { className: 'aecpt-wb-muted', role: 'status' }, '加载中…');
  }
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const paper of papers) if (counts[paper.status] !== undefined) counts[paper.status] += 1;
  const rows = filter ? papers.filter(paper => paper.status === filter) : papers;
  const filters = [['', `全部 ${papers.length}`], ...Object.keys(STATUS).map(key => [key, `${STATUS[key][0]} ${counts[key]}`])];

  return h('div', { className: 'aecpt-wb-stack' },
    papers.length > 0 && h('div', { className: 'aecpt-wb-tagbar', role: 'group', 'aria-label': '按状态筛选' },
      filters.map(([key, label]) => h('button', {
        key: key || 'all', type: 'button', className: 'aecpt-wb-chip aecpt-wb-chip-btn', 'aria-pressed': filter === key,
        onClick: () => setFilter(key),
      }, label))),
    notice && h('div', { className: 'aecpt-wb-notice', role: 'status' }, h('span', null, notice)),
    error && h('p', { className: 'aecpt-wb-error', role: 'alert' }, error),
    h('div', { className: 'aecpt-wb-card' },
      rows.length
        ? h('ol', { className: 'aecpt-wb-rows', 'aria-label': '我的投稿' }, rows.map(paper => h(SubmissionRow, {
          key: paper.id + ':' + paper.status + ':' + (paper.tags || []).join('|') + ':' + (paper.note || ''),
          paper, api, onChanged: load, setNotice,
        })))
        : h('p', { className: 'aecpt-wb-empty' }, papers.length ? '这个状态下没有投稿。' : '你还没有提交过论文。')));
}

const EMPTY_FORM = { title: '', authors: '', year: '', venue: '', doi: '', arxiv_id: '', url: '', abstract: '', tags: '', note: '' };

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function Field({ label, wide, children }) {
  return h('label', { className: wide ? 'aecpt-wb-field-wide' : undefined }, label, children);
}

function SubmitForm({ api, onSubmitted }) {
  const [identifier, setIdentifier] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveNote, setResolveNote] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [autoArxiv, setAutoArxiv] = useState(true);
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef(null);
  const set = key => event => setForm(prev => ({ ...prev, [key]: event.target.value }));
  const hasArxiv = Boolean(form.arxiv_id.trim());
  const useArxivPdf = hasArxiv && autoArxiv;

  async function resolve(event) {
    event.preventDefault();
    setResolving(true); setError(''); setResolveNote('');
    try {
      const { metadata, pdfUrl } = await api('/library/resolve', { method: 'POST', body: JSON.stringify({ identifier: identifier.trim() }) });
      setForm(prev => ({
        ...prev,
        title: metadata.title || '',
        authors: (metadata.authors || []).join('\n'),
        year: metadata.year ? String(metadata.year) : '',
        venue: metadata.venue || '',
        doi: metadata.doi || '',
        arxiv_id: metadata.arxiv_id || '',
        url: metadata.url || '',
        abstract: metadata.abstract || '',
      }));
      setAutoArxiv(Boolean(pdfUrl));
      setResolveNote(`已从 ${metadata.arxiv_id ? 'arXiv' : 'Crossref'} 读取论文信息，请核对后提交。${pdfUrl ? '' : '出版社 PDF 不会自动下载，请选择本地 PDF。'}`);
    } catch (e) { setError(String(e.message || e)); }
    finally { setResolving(false); }
  }

  async function chooseFile(event) {
    const chosen = event.target.files?.[0];
    setError('');
    if (!chosen) { setFile(null); return; }
    if (chosen.type !== 'application/pdf' && !/\.pdf$/i.test(chosen.name)) {
      setError('请选择 PDF 文件'); event.target.value = ''; setFile(null); return;
    }
    if (chosen.size > MAX_PDF) {
      setError('PDF 超过 50 MB 上限'); event.target.value = ''; setFile(null); return;
    }
    setFile({ name: chosen.name, size: chosen.size, raw: chosen });
  }

  function reset() {
    setIdentifier(''); setForm(EMPTY_FORM); setFile(null); setAutoArxiv(true); setResolveNote(''); setError('');
    if (fileInput.current) fileInput.current.value = '';
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    const title = form.title.trim();
    if (!title) { setError('请填写论文标题'); return; }
    const yearText = form.year.trim();
    if (yearText && !(/^\d{4}$/.test(yearText) && Number(yearText) >= 1800 && Number(yearText) <= 2100)) {
      setError('年份应为 1800–2100 之间的四位数字'); return;
    }
    if (!useArxivPdf && !file) { setError(hasArxiv ? '请选择 PDF 文件，或勾选自动下载 arXiv PDF' : '请选择 PDF 文件'); return; }
    setSubmitting(true);
    try {
      const metadata = {
        title,
        authors: form.authors.split('\n').map(item => item.trim()).filter(Boolean),
        year: yearText ? Number(yearText) : undefined,
        venue: form.venue, doi: form.doi, arxiv_id: form.arxiv_id, url: form.url, abstract: form.abstract,
        tags: parseTags(form.tags), note: form.note,
      };
      const body = useArxivPdf
        ? { metadata, fetchArxivPdf: true }
        : { metadata, pdf: { name: file.name, base64: await readFileBase64(file.raw) } };
      const paper = await api('/library/papers/', { method: 'POST', body: JSON.stringify(body) });
      reset();
      onSubmitted(paper);
    } catch (e) {
      const existing = e.data?.error?.existing;
      setError(e.code === 'paper_duplicate' && existing
        ? `库中已有：${existing.title}（${STATUS[existing.status]?.[0] || existing.status}）`
        : String(e.message || e));
    } finally { setSubmitting(false); }
  }

  const busy = resolving || submitting;
  return h('div', { className: 'aecpt-wb-stack' },
    h('form', { className: 'aecpt-wb-card aecpt-wb-stack', onSubmit: resolve },
      h('div', { className: 'aecpt-wb-resolve' },
        h('label', null, 'DOI 或 arXiv',
          h('input', {
            className: 'aecpt-wb-input', value: identifier, disabled: busy, inputMode: 'url',
            placeholder: '10.1145/… 、https://doi.org/… 、2611.01234 或 arxiv.org 链接',
            onChange: e => setIdentifier(e.target.value),
          })),
        h('button', { type: 'submit', className: 'aecpt-wb-btn', disabled: busy || !identifier.trim() }, resolving ? '解析中…' : '解析')),
      h('p', { className: 'aecpt-wb-muted' }, resolveNote || '解析后自动填写下方信息；没有 DOI 或 arXiv 编号时可直接手动填写。')),
    h('form', { className: 'aecpt-wb-card aecpt-wb-stack', onSubmit: submit, 'aria-label': '论文信息' },
      h('div', { className: 'aecpt-wb-lib-form' },
        h(Field, { label: '标题 *', wide: true },
          h('input', { className: 'aecpt-wb-input', value: form.title, disabled: busy, required: true, onChange: set('title') })),
        h(Field, { label: '作者（每行一位）', wide: true },
          h('textarea', { className: 'aecpt-wb-input aecpt-wb-textarea', rows: 3, value: form.authors, disabled: busy, onChange: set('authors') })),
        h(Field, { label: '年份' },
          h('input', { className: 'aecpt-wb-input', value: form.year, disabled: busy, inputMode: 'numeric', maxLength: 4, onChange: set('year') })),
        h(Field, { label: '期刊 / 会议' },
          h('input', { className: 'aecpt-wb-input', value: form.venue, disabled: busy, onChange: set('venue') })),
        h(Field, { label: 'DOI' },
          h('input', { className: 'aecpt-wb-input', value: form.doi, disabled: busy, placeholder: '可选', onChange: set('doi') })),
        h(Field, { label: 'arXiv 编号' },
          h('input', { className: 'aecpt-wb-input', value: form.arxiv_id, disabled: busy, placeholder: '可选', onChange: set('arxiv_id') })),
        h(Field, { label: '链接', wide: true },
          h('input', { className: 'aecpt-wb-input', value: form.url, disabled: busy, inputMode: 'url', placeholder: '可选，http(s)://…', onChange: set('url') })),
        h(Field, { label: '摘要', wide: true },
          h('textarea', { className: 'aecpt-wb-input aecpt-wb-textarea', rows: 5, value: form.abstract, disabled: busy, onChange: set('abstract') })),
        h(Field, { label: '标签（逗号分隔）', wide: true },
          h('input', { className: 'aecpt-wb-input', value: form.tags, disabled: busy, placeholder: '如：计算美学, 用户研究', onChange: set('tags') })),
        h(Field, { label: '推荐理由', wide: true },
          h('textarea', { className: 'aecpt-wb-input aecpt-wb-textarea', rows: 3, value: form.note, disabled: busy, placeholder: '导师审核和组内成员都能看到', onChange: set('note') }))),
      h('fieldset', { className: 'aecpt-wb-pdf' },
        h('legend', null, 'PDF 全文 *'),
        hasArxiv && h('label', { className: 'aecpt-wb-check' },
          h('input', { type: 'checkbox', checked: autoArxiv, disabled: busy, onChange: e => setAutoArxiv(e.target.checked) }),
          '自动下载 arXiv PDF'),
        !useArxivPdf && h('label', { className: 'aecpt-wb-file' }, '选择本地 PDF（不超过 50 MB）',
          h('input', { ref: fileInput, type: 'file', accept: 'application/pdf,.pdf', disabled: busy, onChange: chooseFile })),
        !useArxivPdf && file && h('p', { className: 'aecpt-wb-muted' }, `已选择：${file.name}（${fmtSize(file.size)}）`)),
      error && h('p', { className: 'aecpt-wb-error', role: 'alert' }, error),
      h('div', { className: 'aecpt-wb-toolbar' },
        h('button', { type: 'submit', className: 'aecpt-wb-btn', disabled: busy }, submitting ? (useArxivPdf ? '正在下载并提交…' : '正在提交…') : '提交审核'),
        h('button', { type: 'button', className: 'aecpt-wb-btn-ghost', disabled: busy, onClick: reset }, '清空'),
        h('span', { className: 'aecpt-wb-muted' }, '提交后需导师审核，通过后对课题组可见。'))));
}

/** Shared paper library: browse approved papers, track own submissions,
 * and submit new papers for supervisor review. */
export function LibraryPanel({ api, active, bindingId }) {
  const [view, setView] = useState('browse');
  const [notice, setNotice] = useState('');
  const [mineKey, setMineKey] = useState(0);
  const onViewKey = (event, index) => {
    const target = { ArrowLeft: (index + VIEWS.length - 1) % VIEWS.length, ArrowRight: (index + 1) % VIEWS.length }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    setView(VIEWS[target][0]);
    setNotice('');
    event.currentTarget.parentElement?.children[target]?.focus();
  };
  return h('div', { className: 'aecpt-wb-library' },
    h('div', { className: 'aecpt-wb-segmented', role: 'group', 'aria-label': '论文库视图' },
      VIEWS.map(([key, label], index) => h('button', {
        key, type: 'button', className: 'aecpt-wb-seg-btn', 'aria-pressed': view === key,
        onClick: () => { setView(key); setNotice(''); }, onKeyDown: event => onViewKey(event, index),
      }, label))),
    notice && h('div', { className: 'aecpt-wb-notice', role: 'status' }, h('span', null, notice)),
    h('div', { hidden: view !== 'browse' }, h(LibraryBrowser, { api, bindingId, active: active && view === 'browse' })),
    h('div', { hidden: view !== 'mine' }, h(MySubmissions, { api, active: active && view === 'mine', reloadKey: mineKey })),
    h('div', { hidden: view !== 'submit' }, h(SubmitForm, {
      api,
      onSubmitted: paper => {
        setNotice(paper?.status === 'approved' ? `已入库：${paper.title}` : '已提交，等待导师审核');
        setMineKey(key => key + 1);
        setView('mine');
      },
    })));
}
