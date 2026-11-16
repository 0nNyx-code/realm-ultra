// BUILD: src/{index.html,style.css,main.js} + debug-bridge.js -> dist/realm-ultra.html
// Deps (three/esbuild) di /tmp karena /mnt/sdcard noexec + tanpa symlink.
// PENTING: bridge disuntik DI DALAM IIFE game (sebelum penutup "})();" terakhir)
// supaya bisa akses state/camera/renderer/th yang scope-nya lokal.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, load, NODE_MODULES } from './deps.mjs';

const esbuild = load('esbuild');

const sha = (s) => createHash('sha256').update(s).digest('hex');

const [tpl, css, fontsCss, main, beauty, perf, bridge] = await Promise.all([
  readFile(join(ROOT, 'src', 'index.html'), 'utf8'),
  readFile(join(ROOT, 'src', 'style.css'), 'utf8'),
  readFile(join(ROOT, 'src', 'fonts.css'), 'utf8').catch(() => ''),
  readFile(join(ROOT, 'src', 'main.js'), 'utf8'),
  readFile(join(ROOT, 'src', 'beauty-layer.js'), 'utf8'),
  readFile(join(ROOT, 'src', 'perf-layer.js'), 'utf8'),
  readFile(join(ROOT, 'src', 'debug-bridge.js'), 'utf8')
]);
const cssAll = fontsCss + '\n' + css;

// --- suntik bridge ke dalam IIFE ---
const CLOSER = '\n})();';
const cut = main.lastIndexOf(CLOSER);
if (cut < 0) throw new Error('penutup IIFE "})();" tidak ditemukan');
const entry = main.slice(0, cut)
  + '\n\n/* === BEAUTY LAYER === */\n' + beauty
  + '\n\n/* === PERF LAYER === */\n' + perf
  + '\n\n/* === DEBUG BRIDGE === */\n' + bridge
  + '\n' + main.slice(cut);

const threeDir = join(NODE_MODULES, 'three');
const threeAlias = {
  name: 'three-alias',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: join(threeDir, 'build', 'three.module.js') }));
    build.onResolve({ filter: /^three\/addons\// }, (a) => ({
      path: join(threeDir, 'examples', 'jsm', a.path.slice('three/addons/'.length))
    }));
  }
};

const result = await esbuild.build({
  stdin: { contents: entry, sourcefile: 'main.js', resolveDir: join(ROOT, 'src'), loader: 'js' },
  bundle: true,
  format: 'iife',
  target: ['chrome89'],
  platform: 'browser',
  write: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  nodePaths: [NODE_MODULES],
  plugins: [threeAlias]
});

let js = result.outputFiles[0].text;
const warnings = result.warnings || [];

js = js.replaceAll('</script', '<\\/script');
const safeCss = cssAll.replaceAll('</style', '<\\/style');

if (/from\s*["']three["']/.test(js) || /require\(["']three["']\)/.test(js)) {
  throw new Error('BUNDLE MASIH MENGIMPOR three — resolusi gagal');
}

const html = tpl
  .replace('<!--CSS-->', `<style>\n${safeCss}\n</style>`)
  .replace('<!--JS-->', `<script type="module">\n${js}\n</script>`);

if (html.includes('<!--CSS-->') || html.includes('<!--JS-->')) throw new Error('placeholder tidak ter-replace');
if (/<script type="importmap">/.test(html)) throw new Error('importmap masih ada di output');
if (!js.includes('window.__realm')) throw new Error('bridge tidak masuk bundle');

await mkdir(join(ROOT, 'dist'), { recursive: true });
const outFile = join(ROOT, 'dist', 'realm-ultra.html');
await writeFile(outFile, html);

const report = {
  file: 'dist/realm-ultra.html',
  bytes: Buffer.byteLength(html),
  kb: +(Buffer.byteLength(html) / 1024).toFixed(1),
  jsBytes: Buffer.byteLength(js),
  cssBytes: Buffer.byteLength(safeCss),
  sha256: sha(html),
  warnings: warnings.map((w) => w.text)
};
await writeFile(join(ROOT, 'dist', 'build-report.json'), JSON.stringify(report, null, 2));

console.log(`OK ${report.file} — ${report.kb} KB (js ${(js.length / 1024) | 0} KB, css ${(safeCss.length / 1024) | 0} KB)`);
console.log('sha256:', report.sha256);
if (warnings.length) console.log('warning:', warnings.map((w) => w.text).join(' | '));
