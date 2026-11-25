import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { visit } from 'unist-util-visit';

const maxFormulaLength = 2048;
const maxFormulas = 64;
const mathClasses = new Set(['language-math', 'math-inline', 'math-display']);
const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};

/** Leave large or excess formulas as readable source in the preview. */
function limitMath() {
  return tree => {
    let count = 0;
    visit(tree, { type: 'element', tagName: 'code' }, node => {
      const classes = node.properties.className;
      if (!Array.isArray(classes) || !classes.some(name => mathClasses.has(name))) return;
      const length = node.children.reduce((total, child) => total + (child.value?.length ?? 0), 0);
      if (length <= maxFormulaLength && count < maxFormulas) {
        count += 1;
        return;
      }
      const otherClasses = classes.filter(name => !mathClasses.has(name));
      if (otherClasses.length) node.properties.className = otherClasses;
      else delete node.properties.className;
    });
  };
}

/** Preserve common currency ranges such as “$10 to $20”. */
function keepCurrencyText() {
  return (tree, file) => {
    const source = String(file);
    visit(tree, 'inlineMath', (node, index, parent) => {
      const { start, end } = node.position ?? {};
      if (!parent || start?.offset === undefined || end?.offset === undefined) return;
      const original = source.slice(start.offset, end.offset);
      if (/^\$\d+(?:[.,]\d+)*(?:\s|\p{Script=Han})/u.test(original) && /\d/.test(source.charAt(end.offset))) {
        parent.children[index] = { type: 'text', value: original };
      }
    });
  };
}

export const reportMath = {
  remarkPlugins: [remarkMath, keepCurrencyText],
  rehypePlugins: [
    [rehypeSanitize, markdownSchema],
    limitMath,
    [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 300, maxSize: 20 }],
  ],
};
