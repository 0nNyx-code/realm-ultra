// Ambil font Google (Orbitron + JetBrains Mono) -> src/fonts.css (base64 embedded).
// Jalankan sekali; hasilnya di-commit. Build berikutnya tidak butuh internet.
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const URL_CSS = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=JetBrains+Mono:wght@400;700;800&display=swap';

const res = await fetch(URL_CSS, { headers: { 'User-Agent': UA } });
if (!res.ok) throw new Error('gagal ambil css font: ' + res.status);
const cssText = await res.text();

// ambil hanya subset LATIN (unicode-range U+0000-00FF). Bahasa Indonesia tidak butuh latin-ext/cyrillic.
const blocks = [...cssText.matchAll(/@font-face\s*{([^}]+)}/g)].map(m => m[1]);
const needed = [];
for (const body of blocks) {
  if (!/unicode-range:[^;]*U\+0000-00FF/i.test(body)) continue;
  const fam = /font-family:\s*'([^']+)'/.exec(body);
  const wght = /font-weight:\s*(\d+)/.exec(body);
  const src = /url\((https:\/\/[^)]+\.woff2)\)/.exec(body);
  if (!fam || !src || !wght) continue;
  const key = fam[1] + '|' + wght[1];
  if (needed.some(n => n.key === key)) continue;
  needed.push({ key, family: fam[1], weight: wght[1], url: src[1] });
}
if (!needed.length) throw new Error('tidak ada @font-face latin yang ketemu');

let out = '/* Font di-embed base64 — 100% offline, tanpa request jaringan */\n';
let bytes = 0;
for (const f of needed) {
  const r = await fetch(f.url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('gagal unduh ' + f.url);
  const buf = Buffer.from(await r.arrayBuffer());
  bytes += buf.length;
  const b64 = buf.toString('base64');
  out += `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}\n`;
  console.log('embed', f.family, f.weight, (buf.length / 1024).toFixed(1) + ' KB');
}

await writeFile(join(ROOT, 'src', 'fonts.css'), out);
console.log('OK src/fonts.css —', (out.length / 1024).toFixed(1), 'KB (font mentah', (bytes / 1024).toFixed(1), 'KB,', needed.length, 'file)');
