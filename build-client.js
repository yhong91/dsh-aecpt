import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['client.js'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  external: ['react', 'react-dom'],
  loader: { '.woff2': 'dataurl' },
  plugins: [{
    name: 'katex-woff2',
    setup(build) {
      build.onLoad({ filter: /[\\/]katex[\\/]dist[\\/]katex\.css$/ }, async ({ path }) => {
        const css = await readFile(path, 'utf8');
        // The DSH browser supports WOFF2. Embed it in the module stylesheet.
        const contents = css.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '');
        return { contents, loader: 'css', resolveDir: dirname(path) };
      });
    },
  }],
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'inline',
  write: false,
  metafile: true,
});
const js = result.outputFiles.find(file => extname(file.path) === '.js').text;
const css = result.outputFiles.find(file => extname(file.path) === '.css').text;
const usedInputs = new Set(Object.values(result.metafile.outputs).flatMap(output => Object.keys(output.inputs)));
const packages = new Set();
for (const input of usedInputs) {
  const dependency = input.match(/^(.*\bnode_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (dependency) packages.add(dependency[1]);
}
const notices = [];
for (const packageDir of [...packages].sort()) {
  const files = await readdir(resolve(root, packageDir));
  const texts = files.filter(name => /^(?:license|licence|copying|notice)(?:$|[.-])/i.test(name)).sort();
  const name = packageDir.replace(/^node_modules\//, '');
  if (texts.length === 0) {
    // A published package can omit the license file that is present upstream.
    const manifest = JSON.parse(await readFile(resolve(root, packageDir, 'package.json'), 'utf8'));
    const upstream = resolve(root, 'licenses', `${name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.txt`);
    const text = await readFile(upstream, 'utf8');
    notices.push(`${name} (upstream ${manifest.version})\n\n${text.trim()}`);
    continue;
  }
  for (const filename of texts) {
    const text = await readFile(resolve(root, packageDir, filename), 'utf8');
    notices.push(`${name} (${filename})\n\n${text.trim()}`);
  }
}
const artifact = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  meta: () => ({ stylesheets: { 'report-markdown.css': { text: () => ${JSON.stringify(css)} } } }),
  factory(require) {
    const module = { exports: {} };
${js}
    return module.exports;
  },
});\n`;
const output = resolve(root, 'dist/client.js');
await mkdir(dirname(output), { recursive: true });
await writeFile(resolve(root, 'dist/THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n') + '\n');
await writeFile(output, artifact);
console.log(`Built DSH client (${Buffer.byteLength(artifact)} bytes, ${packages.size} bundled dependency notices).`);
