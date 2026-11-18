// Fallback smoke test kalau Firefox tidak tersedia: Chromium + SwiftShader.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire('/tmp/opencode/realm-build/package.json')('playwright-core');
const FILE = pathToFileURL(join(ROOT, 'dist', 'realm-ultra.html')).href + '?debug=1';
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium-browser', headless: true, timeout: 90000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--ignore-gpu-blocklist',
         '--disable-dev-shm-usage']
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => { if (['error','warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0,180)}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + String(e.message).slice(0,220)));
const t0 = Date.now();
await page.goto(FILE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__realm && window.__realm.ready, null, { timeout: 180000, polling: 250 });
try { if (await page.locator('#startBtn').isVisible({ timeout: 3000 })) await page.locator('#startBtn').click({ timeout: 10000 }); } catch {}
try { if (await page.locator('#storySkip').isVisible({ timeout: 1500 })) await page.locator('#storySkip').click({ timeout: 8000 }); } catch {}
await page.waitForTimeout(2500);
const r = await page.evaluate(() => ({
  waterY: window.__realm.get('water ? +water.position.y.toFixed(3) : null'),
  pondY: window.__realm.get('+pondWaterY().toFixed(3)'),
  terrainAtPond: window.__realm.get('+th(POND_X, POND_Z).toFixed(3)'),
  terrainRim: window.__realm.get('+th(POND_X+POND_R-1, POND_Z).toFixed(3)'),
  sun: window.__realm.get('+sun.intensity.toFixed(2)'),
  dim: window.__realm.get('state.world.dimension'),
  calls: window.__realm.info().calls,
  fpsFrames: window.__realm.frames
}));
console.log(JSON.stringify({ bootMs: Date.now()-t0, ...r, errors: logs.slice(0,15) }, null, 2));
await browser.close();
