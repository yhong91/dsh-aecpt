import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { reportMath } from '../report-math.js';

function render(source) {
  return renderToStaticMarkup(createElement(Markdown, { ...reportMath, skipHtml: true, children: source }));
}

function formulaCount(html) {
  return [...html.matchAll(/class="katex"/g)].length;
}

test('renders inline and display math alongside plain text and code', () => {
  const html = render('能量 $E=mc^2$。\n\n$$\n\\frac{a}{b}=x\n$$\n\n`$code$` 和 \\$20');
  assert.equal(formulaCount(html), 2);
  assert.match(html, /class="katex-display".*<mfrac>/);
  assert.match(html, /<code>\$code\$<\/code> 和 \$20/);
});

test('common currency ranges stay as ordinary text', () => {
  const html = render('预算从 $10 调整到 $20。成本$3到$5，范围 $12.50 to $15.00。公式 $2 x=4$。');
  assert.equal(formulaCount(html), 1);
  assert.match(html, /预算从 \$10 调整到 \$20。成本\$3到\$5，范围 \$12\.50 to \$15\.00。/);
});

test('a malformed formula leaves its source and the remaining Markdown readable', () => {
  const html = render('$\\frac{1}$ **继续阅读**');
  assert.match(html, /class="katex-error".*\\frac\{1\}/);
  assert.match(html, /<strong>继续阅读<\/strong>/);
});

test('large and excess formulas stay as source', () => {
  const html = render(['$' + 'x'.repeat(2049) + '$', ...Array(65).fill('$x$')].join(' '));
  assert.equal(formulaCount(html), 64);
  assert.match(html, /<code>x{2049}<\/code>/);
  assert.match(html, /<code>x<\/code>/);
});

test('formula commands cannot render external images or links', () => {
  const html = render(String.raw`$\includegraphics{https://example.com/img.png}$ $\href{https://example.com}{外链}$`);
  assert.doesNotMatch(html, /<(?:img|a)\b/);
});
