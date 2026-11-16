// ============================================================================
//  PERF LAYER — auto quality + telemetry (mobile first)
//  Disuntik di dalam IIFE game, SETELAH beauty layer.
//  Tujuan: di HP kelas Galaxy A05 (Mali-G52 MC2) tetap 30+ FPS tanpa
//  menghilangkan look "shadered voxel".
// ============================================================================
const PERF = (() => {
  const D = {
    gpu: 'unknown', vendor: '', tier: 'mid',
    fps: 60, avg: 60, scale: 1, minScale: DYN_RES_MIN,
    degraded: false, auto: true, warm: 3.0, lowTime: 0, highTime: 0,
    spikes: 0, frames: 0
  };

  // ---- 1. deteksi GPU ----
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      D.gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
      D.vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '');
    } else {
      D.gpu = String(gl.getParameter(gl.RENDERER) || '');
      D.vendor = String(gl.getParameter(gl.VENDOR) || '');
    }
  } catch (e) {}

  const gname = (D.gpu + ' ' + D.vendor).toLowerCase();
  // GPU kelas bawah / software renderer
  const WEAK = /mali-4|mali-t[0-9]|mali-g3|mali-g5[0-2]|mali-g7[0-1]|adreno.*(\(tm\) )?[3-5][0-9][0-9]|powervr ge|videocore|llvmpipe|swiftshader|software|mesa offscreen/.test(gname);
  D.tier = WEAK ? 'low' : (LOW ? 'mid' : 'high');

  // ---- 2. set skala resolusi (dipakai juga oleh dynamic resolution) ----
  function setScale(s) {
    const clamped = Math.max(D.minScale, Math.min(1, s));
    dynResLevel = clamped;
    currentPixelRatio = Q.pixelRatio * clamped;
    D.scale = clamped;
    try { syncRenderTargets(); } catch (e) {}
  }

  // ---- 3. preset kualitas statis ----
  function applyPreset(name) {
    if (name === 'potato') {
      D.minScale = 0.42;
      try { fxaaPass.enabled = false; } catch (e) {}
      try { bloom.enabled = false; } catch (e) {}
      try { if (typeof _ssao !== 'undefined') _ssao.enabled = false; } catch (e) {}
      try { if (renderer.shadowMap) renderer.shadowMap.enabled = false; } catch (e) {}
      setScale(0.55);
      D.degraded = true;
    } else if (name === 'low') {
      D.minScale = 0.5;
      try { fxaaPass.enabled = true; } catch (e) {}
      try { bloom.enabled = false; } catch (e) {}
      try { if (typeof _ssao !== 'undefined') _ssao.enabled = false; } catch (e) {}
      setScale(0.72);
    } else if (name === 'mid') {
      D.minScale = 0.6;
      try { fxaaPass.enabled = true; } catch (e) {}
      try { bloom.enabled = !!Q.bloom; } catch (e) {}
      setScale(0.9);
    } else {
      D.minScale = DYN_RES_MIN;
      try { fxaaPass.enabled = true; } catch (e) {}
      try { bloom.enabled = !!Q.bloom && v4.bloomOn; } catch (e) {}
      setScale(1);
    }
    D.preset = name;
  }

  // ---- 4. auto: sekali di awal sesuai GPU, lalu reaktif kalau FPS jelek ----
  applyPreset(D.tier === 'low' ? 'low' : (D.tier === 'mid' ? 'mid' : 'high'));

  function tick(rawDt, fps) {
    if (!D.auto) return;
    D.fps = fps;
    if (rawDt > 0.25) { D.spikes++; return; }   // abaikan frame spike (GC / tab switch)
    if (D.warm > 0) { D.warm -= 0.6; return; }
    D.avg = D.avg * 0.82 + fps * 0.18;

    if (D.avg < 26) {
      D.lowTime += 0.6; D.highTime = 0;
      if (D.lowTime >= 2.4) {
        D.lowTime = 0;
        if (!D.degraded) {
          // langkah 1: matikan FXAA (satu full-screen pass hilang)
          D.degraded = true;
          try { fxaaPass.enabled = false; } catch (e) {}
          setScale(Math.max(D.minScale, D.scale * 0.82));
        } else if (D.scale > D.minScale + 0.02) {
          // langkah 2: turunkan resolusi lebih agresif
          setScale(D.scale * 0.85);
        } else {
          // langkah 3 (terakhir): matikan efek dekoratif berat
          try { if (typeof _ssao !== 'undefined') _ssao.enabled = false; } catch (e) {}
          try { if (renderer.shadowMap) renderer.shadowMap.enabled = false; } catch (e) {}
        }
      }
    } else if (D.avg > 52) {
      D.highTime += 0.6; D.lowTime = 0;
      if (D.highTime >= 12 && D.scale < 1) {
        D.highTime = 0;
        setScale(Math.min(1, D.scale + 0.08));
        if (D.degraded && D.scale > 0.85) {
          D.degraded = false;
          try { fxaaPass.enabled = true; } catch (e) {}
        }
      }
    } else {
      D.lowTime = 0; D.highTime = 0;
    }
  }

  // ---- 5. mode performa manual (tombol di Settings) ----
  D.manual = (on) => {
    if (on) { D.auto = false; applyPreset('potato'); }
    else { D.auto = true; applyPreset(D.tier === 'low' ? 'low' : (D.tier === 'mid' ? 'mid' : 'high')); }
  };

  return D;
})();

// sambungkan ke pengukur FPS yang sudah ada, tanpa mengubah animate()
const _perfOrigDynRes = updateDynamicResolution;
updateDynamicResolution = function (rawDt, fps) {
  try { PERF.tick(rawDt, fps); } catch (e) {}
  _perfOrigDynRes(rawDt, fps);
};

// API publik kecil (dipakai Settings + debug bridge)
function applyPerfMode(on) {
  try { PERF.manual(!!on); } catch (e) {}
}
try { window.__perf = PERF; } catch (e) {}
