import React from 'react';
import MDEditor, { bold, heading2, unorderedListCommand, link } from '@uiw/react-md-editor/nohighlight';
import { reportMath } from './report-math.js';
import 'katex/dist/katex.css';
import './report-markdown.css';

const h = React.createElement;
const reportTemplate = '## 本周进展\n\n- \n\n## 遇到的问题\n\n- \n\n## 下一步\n\n- \n';
const editorCommands = [
  [{ ...heading2, icon: h('span', null, 'H2') }, '二级标题'],
  [bold, '粗体'], [unorderedListCommand, '项目列表'], [link, '插入链接'],
].map(([command, label]) => ({
  ...command, buttonProps: { ...command.buttonProps, title: label, 'aria-label': label },
}));
const modes = [ ['edit', '编辑'], ['preview', '预览'], ['live', '分栏'] ];

function previewUrl(value, key) {
  if (key === 'href' && value.startsWith('#')) return value;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        url.origin !== window.location.origin) return url.href;
  } catch {
    // Unsafe and unresolved links are rendered as plain text.
  }
  return undefined;
}

const previewOptions = {
  skipHtml: true,
  disableCopy: true,
  ...reportMath,
  urlTransform: previewUrl,
  components: {
    a: ({ children, href }) => href
      ? h('a', { href, ...(href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' }) }, children)
      : h('span', null, children),
    img: ({ alt, src }) => src
      ? h('a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, alt || '查看图片')
      : h('span', null, alt),
  },
};

export function ReportEditor({ value, onChange, label, placeholder, disabled }) {
  const [mode, setMode] = React.useState('edit');
  return h('div', { className: 'aecpt-markdown' },
    h('div', { className: 'aecpt-markdown-modes' },
      h('div', { className: 'aecpt-markdown-mode-group', role: 'group', 'aria-label': 'Markdown 显示方式' },
        modes.map(([id, title]) => h('button', {
          key: id, type: 'button',
          'aria-pressed': mode === id, onClick: () => setMode(id),
        }, title))),
      !value && h('button', {
        type: 'button', disabled, onClick: () => { onChange(reportTemplate); setMode('edit'); },
      }, '插入进展模板')),
    mode !== 'preview' && h('p', { className: 'aecpt-markdown-math-hint' },
      '行内公式用 ', h('code', null, '$x^2$'), '，独立公式前后各用一行 ', h('code', null, '$$'), '。'),
    h(MDEditor, {
      value, onChange: text => onChange(text ?? ''), disabled, preview: mode,
      height: 208, visibleDragbar: false, highlightEnable: false, defaultTabEnable: true,
      commands: editorCommands, extraCommands: [], hideToolbar: mode === 'preview', previewOptions,
      textareaProps: { 'aria-label': label, placeholder },
    }));
}

export function ReportMarkdown({ value }) {
  return value ? h('div', { className: 'aecpt-markdown aecpt-markdown-reading' },
    h(MDEditor.Markdown, { ...previewOptions, source: value })) : h('p', null, '（正文为空）');
}
