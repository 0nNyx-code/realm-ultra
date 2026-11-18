// ============================================================================
//  ANIME LAYER — "Genshin-lite" retrofit
//  Disuntik di dalam IIFE game (lihat tools/build.mjs).
//  - rim light lewat onBeforeCompile (gratis, tanpa draw call tambahan)
//  - outline inverted-hull HANYA untuk hero & boss (draw call terbatas)
//  Tidak mengubah gameplay. Aman di LOW: outline bisa dimatikan lewat Q.lowOutline.
// ============================================================================
const AL = (() => {
  const patched = new WeakSet();
  const outlined = new WeakSet();
  const _olMat = new THREE.MeshBasicMaterial({
    color: 0x273457, side: THREE.BackSide, fog: true, toneMapped: false
  });

  // Rimlight: rim = pow(1 - dot(N,V), 3), hanya di sisi menghadap kamera.
  function rim(mat, hex, power){
    if (!mat || !mat.isMeshToonMaterial || patched.has(mat)) return;
    patched.add(mat);
    const rimCol = mat.color.clone().setHex(hex);
    const old = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, renderer) => {
      if (old) old(sh, renderer);
      sh.uniforms.uRimCol = { value: rimCol };
      sh.uniforms.uRimPow = { value: power };
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uRimCol;\nuniform float uRimPow;')
        .replace('#include <dithering_fragment>', `
          float _rimD = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
          gl_FragColor.rgb += uRimCol * pow(_rimD, 3.0) * uRimPow;
          #include <dithering_fragment>
        `);
    };
    mat.needsUpdate = true;
  }

  // Outline inverted-hull. Dipakai hemat: hero + boss saja.
  function outline(mesh, width){
    if (!mesh || !mesh.isMesh || !mesh.geometry || outlined.has(mesh)) return;
    if (!mesh.geometry.attributes || !mesh.geometry.attributes.normal) return;
    outlined.add(mesh);
    const o = new THREE.Mesh(mesh.geometry, _olMat);
    o.scale.setScalar(width || 1.035);
    o.renderOrder = -2;
    o.frustumCulled = false;
    o.name = 'AL_outline';
    mesh.add(o);
  }

  function paint(root, hex, power, withOutline){
    if (!root) return;
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.isMeshToonMaterial) rim(m, hex, power);
      }
      if (withOutline && o.name !== 'AL_outline') outline(o, 1.038);
    });
  }

  // Hero selalu dapat rim + outline tipis.
  function init(){
    try { paint(characterAnim.root, 0xbfe4ff, 0.22, true); } catch (e) {}
    try { paint(petGroup, 0xbfffe8, 0.16, false); } catch (e) {}
  }

  // Mob baru muncul belakangan → scan berkala, murah (cuma array MOBS).
  let acc = 0;
  function update(dt){
    acc += dt;
    if (acc < 1.2) return;
    acc = 0;
    try {
      for (let i = 0; i < MOBS.length; i++){
        const m = MOBS[i];
        if (!m || !m.alive || !m.mesh) continue;
        paint(m.mesh, m.isBoss ? 0xffd9a8 : 0xcfe8ff, m.isBoss ? 0.28 : 0.14,
              !!m.isBoss && !LOW);
      }
    } catch (e) {}
  }

  return { init, update, rim, outline, paint };
})();
try { AL.init(); } catch (e) { console.warn('AnimeLayer:', e && e.message); }
const _alOrigUpdateEnvironment = updateEnvironment;
updateEnvironment = function (dt) {
  _alOrigUpdateEnvironment(dt);
  try { AL.update(dt); } catch (e) {}
};
