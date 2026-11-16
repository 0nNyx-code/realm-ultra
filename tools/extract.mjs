// Ekstraksi mekanis: game open world.html -> src/{index.html,style.css,main.js}
// TIDAK mengubah satu karakter pun. Verifikasi dengan rekonstruksi + sha256.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'baseline', 'game-v4.0.html');
const OUT = join(ROOT, 'src');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const raw = await readFile(SRC, 'utf8');
const lines = raw.split('\n');

const find = (re) => {
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error('penanda tidak ditemukan: ' + re);
  return i;
};

const styleOpen = find(/^<style>$/);
const styleClose = find(/^<\/style>$/);
const mapOpen = find(/^<script type="importmap">$/);
const mapClose = lines.findIndex((l, i) => i > mapOpen && /^<\/script>$/.test(l));
const modOpen = lines.findIndex((l, i) => i > mapClose && /^<script type="module">$/.test(l));
const modClose = lines.findIndex((l, i) => i > modOpen && /^<\/script>$/.test(l));

if (styleOpen !== 41 || styleClose !== 396) throw new Error('baris CSS bergeser: ' + styleOpen + '/' + styleClose);
if (mapOpen !== 672 || modOpen !== 678 || modClose !== 8011) throw new Error('baris script bergeser: ' + mapOpen + '/' + modOpen + '/' + modClose);

const head = lines.slice(0, styleOpen).join('\n');            // 1..41
const css = lines.slice(styleOpen + 1, styleClose).join('\n'); // 43..396
const body = lines.slice(styleClose + 1, mapOpen).join('\n');  // 398..672
const js = lines.slice(modOpen + 1, modClose).join('\n');      // 680..8011
const tail = lines.slice(modClose + 1).join('\n');             // 8013..8014

const template =
  head + '\n' +
  '<!--CSS-->' + '\n' +
  body + '\n' +
  '<!--JS-->' + '\n' +
  tail;

// Rekonstruksi: harus byte-identik dengan file asli
const rebuilt =
  head + '\n' +
  '<style>' + '\n' + css + '\n' + '</style>' + '\n' +
  body + '\n' +
  '<script type="importmap">' + '\n' +
  lines.slice(mapOpen + 1, mapClose).join('\n') + '\n' + '</script>' + '\n' +
  '<script type="module">' + '\n' + js + '\n' + '</script>' + '\n' +
  tail;

if (sha(rebuilt) !== sha(raw)) {
  let i = 0;
  while (i < rebuilt.length && rebuilt[i] === raw[i]) i++;
  throw new Error(`REKONSTRUKSI GAGAL di offset ${i}\nasli : ${JSON.stringify(raw.slice(i - 40, i + 40))}\nhasil: ${JSON.stringify(rebuilt.slice(i - 40, i + 40))}`);
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'index.html'), template);
await writeFile(join(OUT, 'style.css'), css);
await writeFile(join(OUT, 'main.js'), js);

console.log('OK rekonstruksi byte-identik');
console.log('  index.html :', template.length, 'byte');
console.log('  style.css  :', css.length, 'byte,', css.split('\n').length, 'baris');
console.log('  main.js    :', js.length, 'byte,', js.split('\n').length, 'baris');
console.log('  sha256 asli:', sha(raw));
console.log('  sha256 js  :', sha(js));
