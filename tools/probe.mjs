// PROBE NUMERIK — tanpa screenshot. Baca angka lighting + luminansi framebuffer.
// Jalankan: xvfb-run -a node tools/probe.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { firefox } = createRequire('/tmp/opencode/realm-build/package.json')('playwright-core');
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
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 160)}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + String(e.message).slice(0, 200)));

await page.goto(FILE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__realm && window.__realm.ready, null, { timeout: 180000, polling: 250 });
try { if (await page.locator('#startBtn').isVisible({ timeout: 3000 })) await page.locator('#startBtn').click({ timeout: 10000 }); } catch {}
try { if (await page.locator('#storySkip').isVisible({ timeout: 1500 })) await page.locator('#storySkip').click({ timeout: 8000 }); } catch {}
await page.waitForTimeout(1200);

const SAMPLE = `
(() => {
  const gl = renderer.getContext();
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  const buf = new Uint8Array(64 * 36 * 4);
  gl.readPixels(0, 0, 64, 36, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let sum = 0, dark = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const l = 0.2126 * buf[i] + 0.7152 * buf[i+1] + 0.0722 * buf[i+2];
    sum += l; if (l < 24) dark++;
  }
  return { lum: +(sum / (64*36)).toFixed(1), darkPct: +(100*dark/(64*36)).toFixed(1) };
})()
`;

const LIGHTS = `
({
  day: +state.day.toFixed(4),
  clock: document.getElementById('clock') ? document.getElementById('clock').textContent : null,
  dim: state.world.dimension,
  sun: +sun.intensity.toFixed(3),
  ambient: +ambient.intensity.toFixed(3),
  ambientHex: ambient.color.getHexString(),
  moon: +moon.intensity.toFixed(3),
  fog: +scene.fog.density.toFixed(4),
  fogHex: scene.fog.color.getHexString(),
  waterY: water ? +water.position.y.toFixed(2) : null,
  pondBed: +th(POND_X, POND_Z).toFixed(2),
  pondRim: +th(POND_X + POND_R - 1, POND_Z).toFixed(2),
  zenith: BL.skyUniforms.uZenith.value.getHexString(),
  horizon: BL.skyUniforms.uHorizon.value.getHexString(),
  mobs: MOBS.filter(m => m.alive && m.dimension === state.world.dimension).map(m => ({
    kind: m.kind, dist: +Math.hypot(m.mesh.position.x - playerGroup.position.x, m.mesh.position.z - playerGroup.position.z).toFixed(1),
    visible: m.mesh.visible, y: +m.mesh.position.y.toFixed(1)
  })).slice(0, 6)
})
`;

const take = async (label, inject = '') => {
  if (inject) await page.evaluate(inject);
  await page.waitForTimeout(450);
  const r = await page.evaluate(
    ([l, s]) => ({ light: window.__realm.get(l), frame: window.__realm.get(s) }),
    [LIGHTS, SAMPLE]
  );
  console.log(label.padEnd(22), JSON.stringify(r));
};

console.log('--- probe ---');
await take('genesis default');
await take('genesis 12:00', `window.__realm.freeze({ day: 0.5 });`);
await take('genesis 15:29', `window.__realm.freeze({ day: 15.483/24 });`);
await take('genesis 00:00', `window.__realm.freeze({ day: 0 });`);
await take('genesis 06:00', `window.__realm.freeze({ day: 0.25 });`);

// Objek hitam di sekitar player
const blacks = await page.evaluate((expr) => window.__realm.get(expr), `(() => {
  const out = [];
  const p = playerGroup.position;
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const c = m.color;
    if (!c) return;
    const lum = 0.2126*c.r + 0.7152*c.g + 0.0722*c.b;
    if (lum > 0.06) return;
    const wp = p.clone(); o.getWorldPosition(wp);
    const d = wp.distanceTo(p);
    if (d > 6) return;
    o.geometry.computeBoundingBox && o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    out.push({ name: o.name || o.parent?.name || '-', d: +d.toFixed(2),
      type: m.type, hex: c.getHexString(), vis: o.visible,
      size: bb ? bb.getSize(p.clone()).toArray().map(v => +v.toFixed(2)) : null });
  });
  return out.slice(0, 25);
})()`);
console.log('black meshes near player (count ' + blacks.length + '):', JSON.stringify(blacks.slice(0, 6), null, 1));

const heroDump = await page.evaluate((expr) => window.__realm.get(expr), `(() => {
  const out = [];
  playerGroup.updateMatrixWorld(true);
  playerGroup.traverse(o => {
    if (!o.isMesh && !o.isSprite) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const c = m && m.color;
    const bb = o.geometry && o.geometry.boundingBox;
    out.push({ name: o.name || '-', type: m && m.type, hex: c ? c.getHexString() : null,
      vis: o.visible, parent: o.parent && o.parent.name,
      scale: o.scale.toArray().map(v => +v.toFixed(2)),
      size: bb ? bb.getSize(p0.clone()).toArray().map(v => +v.toFixed(2)) : null });
  });
  return out.filter(o => o.hex === '000000' || (o.size && Math.max.apply(null, o.size) > 0.35) || (o.hex && parseInt(o.hex.slice(0,2),16) < 40)).slice(0, 60);
})()`.replace('p0.clone()', 'playerGroup.position.clone()'));
console.log('player meshes:', JSON.stringify(heroDump, null, 1));

// Masuk voxel
await page.evaluate(`window.__realm.freeze({ day: 0.68 }); window.__realm.get('enterVoxelDimension()')`);
await page.waitForTimeout(3200);
await take('voxel jam 16:19');
await take('voxel paksa siang', `window.__realm.freeze({ day: 0.5 });`);

console.log('errors:', JSON.stringify(logs.slice(0, 12)));
await browser.close();
