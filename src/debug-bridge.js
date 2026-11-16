/* DEBUG BRIDGE — aktif hanya dengan ?debug=1
   Disuntik DI DALAM IIFE game (lihat tools/build.mjs), jadi bisa akses
   state / camera / renderer / playerGroup / th yang scope-nya lokal. */
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('debug')) {
  const R = { ready: false, frames: 0, errors: [] };
  try { renderer.info.autoReset = false; } catch (e) { R.errors.push('autoReset'); }

  // Hitung frame nyata (untuk bench FPS) + penanda sudah render.
  (function tick() {
    R.frames++;
    if (R.frames === 2) R.ready = true;
    requestAnimationFrame(tick);
  })();

  R.info = () => {
    try {
      const i = renderer.info;
      const snap = {
        frames: R.frames,
        calls: i.render.calls,
        triangles: i.render.triangles,
        lines: i.render.lines,
        points: i.render.points,
        geometries: i.memory.geometries,
        textures: i.memory.textures,
        programs: i.programs ? i.programs.length : -1,
        pixelRatio: +renderer.getPixelRatio().toFixed(3),
        size: renderer.getSize(new THREE.Vector2()).toArray()
      };
      i.reset();
      return snap;
    } catch (e) { return { error: String(e && e.message) }; }
  };

  R.groundAt = (x, z) => { try { return th(x, z); } catch { return 0; } };

  // Kunci pose pemain + arah kamera. Kamera menyusul (lerp) dalam beberapa frame.
  R.pose = (x, z, yawV = 0, pitchV = -0.22) => {
    const y = R.groundAt(x, z);
    playerGroup.position.set(x, y + 0.05, z);
    yaw = yawV;
    pitch = pitchV;
    return { x, y, z, yaw: yawV, pitch: pitchV };
  };

  // Bekukan variabel dunia yang membuat dua screenshot berbeda.
  R.freeze = (o = {}) => {
    const done = {};
    try { state.paused = false; state.slowmo = 0; state.killCam = 0; state.trauma = 0; } catch {}
    for (const k of ['corruption', 'overload', 'swing', 'mining', 'charging', 'parryActive', 'blink']) {
      if (k in state) { state[k] = 0; done[k] = 0; }
    }
    try { if (o.day !== undefined) { state.day = o.day; done.day = state.day; } } catch {}
    try { if (o.weather) { state.weather = o.weather; done.weather = state.weather; } } catch {}
    try { weatherTimer = 0; lightningTimer = 0; meteorTimer = 0; } catch {}
    try { if ('dynResOn' in state) { state.dynResOn = !!o.dynRes; done.dynResOn = state.dynResOn; } } catch {}
    return done;
  };

  // Akses bebas ke scope game untuk inspeksi/eksperimen.
  // eval LANGSUNG (bukan indirect) supaya bisa lihat closure IIFE game.
  R.get = (expr) => { try { return eval(expr); } catch (e) { return 'ERR: ' + (e && e.message); } };

  R.state = () => state;

  // Sembunyikan semua overlay UI supaya screenshot murni render 3D.
  R.clean = (on = true) => {
    const cv = renderer.domElement;
    const changed = [];
    for (const el of document.body.children) {
      if (el.contains(cv)) continue;
      if (el.dataset.blWas === undefined) el.dataset.blWas = el.style.display || '';
      el.style.display = on ? 'none' : el.dataset.blWas;
      changed.push(el.id || el.tagName);
    }
    return changed;
  };

  window.__realm = R;
}
