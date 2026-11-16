// SMOKE TEST — tanpa screenshot. Cuma cek: ada error runtime? FPS? draw call?
// Jalankan: xvfb-run -a node tools/smoke.mjs [--sec=8]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { firefox } = createRequire('/tmp/opencode/realm-build/package.json')('playwright-core');
const arg = (k, d) => { const m = process.argv.find(a => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const SEC = +arg('sec', 8);
const FILE = pathToFileURL(join(ROOT, 'dist', 'realm-ultra.html')).href + '?debug=1';

const browser = await firefox.launch({
  executablePath: '/root/.cache/ms-playwright/firefox-1543/firefox/firefox',
  headless: false, timeout: 90000,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  firefoxUserPrefs: {
    'webgl.force-enabled': true, 'webgl.disabled': false, 'webgl.forbid-software': false,
    'webgl.out-of-process': false, 'webgl.enable-webgl2': true, 'webgl.disable-angle': true,
    'gfx.webrender.software': true, 'layers.acceleration.disabled': true,
    'security.sandbox.content.level': 0, 'security.sandbox.gpu.level': 0, 'dom.max_script_run_time': 0
  }
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 180)}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + String(e.message).slice(0, 220)));

const t0 = Date.now();
await page.goto(FILE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__realm && window.__realm.ready, null, { timeout: 180000, polling: 250 });
const boot = Date.now() - t0;

try { if (await page.locator('#startBtn').isVisible({ timeout: 3000 })) await page.locator('#startBtn').click({ timeout: 10000 }); } catch (e) {}
try { if (await page.locator('#storySkip').isVisible({ timeout: 1500 })) await page.locator('#storySkip').click({ timeout: 8000 }); } catch (e) {}

// ukur FPS nyata selama N detik
const start = await page.evaluate(() => ({ t: performance.now(), f: window.__realm.frames }));
await page.waitForTimeout(SEC * 1000);
const end = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => {
  r({ t: performance.now(), f: window.__realm.frames, info: window.__realm.info(), perf: window.__perf ? { ...window.__perf, gpu: window.__perf.gpu, tier: window.__perf.tier, scale: window.__perf.scale, preset: window.__perf.preset, degraded: window.__perf.degraded } : null });
})));

const fps = (end.f - start.f) / ((end.t - start.t) / 1000);
const out = { bootMs: boot, fps: +fps.toFixed(1), frames: end.f, calls: end.info.calls, tri: end.info.triangles, pixelRatio: end.info.pixelRatio, perf: end.perf, errors: logs.slice(0, 20) };
console.log(JSON.stringify(out, null, 2));
await browser.close();
