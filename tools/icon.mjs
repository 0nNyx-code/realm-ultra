// Generate ikon APK procedural (PNG) dengan pngjs.
// Jalankan: node tools/icon.mjs   -> apk/app/src/main/res/mipmap-*/ic_launcher*.png
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, load } from './deps.mjs';

const { PNG } = load('pngjs');

const SIZES = [
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]
];

// warna
const BG_TOP = [0x0b, 0x1d, 0x2e], BG_BOT = [0x05, 0x0a, 0x14];
const CYAN = [0x7c, 0xe7, 0xff], VIOLET = [0xc7, 0x7d, 0xff];
const WHITE = [0xff, 0xff, 0xff];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// polygon: titik dinormalisasi 0..1
const CRYSTAL = [
  [0.50, 0.13], [0.685, 0.36], [0.685, 0.60],
  [0.50, 0.87], [0.315, 0.60], [0.315, 0.36]
];
// facet dalam (membuat kesan 3D)
const FACET_L = [[0.50, 0.13], [0.50, 0.87], [0.315, 0.60], [0.315, 0.36]];
const FACET_R = [[0.50, 0.13], [0.685, 0.36], [0.685, 0.60], [0.50, 0.87]];

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function distToPoly(px, py, poly) {
  let best = 1e9;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
    const dx = bx - ax, dy = by - ay;
    const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
    const cx = ax + dx * t, cy = ay + dy * t;
    best = Math.min(best, Math.hypot(px - cx, py - cy));
  }
  return best;
}

function render(S) {
  const png = new PNG({ width: S, height: S });
  const cx = 0.5, cy = 0.5;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;

      // --- background: gradien vertikal + glow radial di tengah ---
      let col = mix3(BG_TOP, BG_BOT, clamp01(v * 1.12));
      const r = Math.hypot(u - cx, (v - cy) * 1.06);
      const glow = Math.exp(-r * r * 5.2) * 0.55;
      col = mix3(col, [0x18, 0x4a, 0x66], glow * 0.85);

      // --- cincin orbit miring ---
      const ex = (u - cx), ey = (v - cy);
      const ang = -0.5;
      const rx = ex * Math.cos(ang) - ey * Math.sin(ang);
      const ry = ex * Math.sin(ang) + ey * Math.cos(ang);
      const ring = Math.abs(Math.hypot(rx, ry / 0.36) - 0.33);
      if (ring < 0.012) {
        const a = (1 - ring / 0.012) * 0.65;
        col = mix3(col, CYAN, a);
      }

      // --- kristal ---
      const sdf = inPoly(u, v, CRYSTAL) ? -distToPoly(u, v, CRYSTAL) : distToPoly(u, v, CRYSTAL);
      if (sdf < 0.004) {
        // isi: gradasi cyan (kiri-atas) -> violet (kanan-bawah)
        const t = clamp01((u - 0.3) * 1.4 + (v - 0.15) * 0.55);
        let fill = mix3(CYAN, VIOLET, t);
        // facet kiri lebih terang (specular)
        if (inPoly(u, v, FACET_L)) fill = mix3(fill, WHITE, 0.18);
        if (inPoly(u, v, FACET_R)) fill = mix3(fill, [0x2a, 0x1b, 0x50], 0.22);
        // tepi menyala
        const edge = clamp01(1 - Math.abs(sdf) / 0.02);
        fill = mix3(fill, WHITE, edge * 0.55);
        col = mix3(col, fill, 1);
      } else {
        // halo di luar kristal
        const halo = Math.exp(-sdf * sdf * 1400) * 0.5;
        col = mix3(col, CYAN, halo);
      }

      // --- kilau diagonal tipis (kaca) ---
      const band = Math.abs((u + v) - 0.62);
      if (band < 0.05) col = mix3(col, WHITE, (1 - band / 0.05) * 0.025);

      // --- vignette ---
      const vg = clamp01(1 - Math.hypot(u - cx, v - cy) * 1.25);
      col = col.map(c => c * (0.82 + 0.18 * vg));

      const idx = (y * S + x) << 2;
      png.data[idx] = Math.max(0, Math.min(255, col[0] | 0));
      png.data[idx + 1] = Math.max(0, Math.min(255, col[1] | 0));
      png.data[idx + 2] = Math.max(0, Math.min(255, col[2] | 0));
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

for (const [dpi, size] of SIZES) {
  const dir = join(ROOT, 'apk', 'app', 'src', 'main', 'res', 'mipmap-' + dpi);
  await mkdir(dir, { recursive: true });
  const buf = render(size);
  await writeFile(join(dir, 'ic_launcher.png'), buf);
  await writeFile(join(dir, 'ic_launcher_round.png'), buf);
  console.log('icon', dpi, size + 'px', (buf.length / 1024).toFixed(1) + ' KB');
}
// ikon 512 untuk Play Store / dokumentasi
const big = render(512);
await mkdir(join(ROOT, 'apk'), { recursive: true });
await writeFile(join(ROOT, 'apk', 'icon-512.png'), big);
console.log('icon 512px', (big.length / 1024).toFixed(1), 'KB');
