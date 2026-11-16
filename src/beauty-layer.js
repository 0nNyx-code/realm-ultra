// ============================================================================
//  BEAUTY LAYER v1 — "Shadered Voxel"
//  Modul aditif: TIDAK mengubah logika gameplay. Disuntik di dalam IIFE game
//  (lihat tools/build.mjs) supaya bisa akses scene/camera/state/th/rnd.
//
//  Isi: sky dome shader, awan berlapis, fireflies, kelopak jatuh, burung,
//       pulau terapung, kristal raksasa, air stylized (ganti Water addon).
//  Semua procedural (BufferGeometry + canvas texture), tanpa aset eksternal.
// ============================================================================
const BL = (() => {
  const D = {
    sky: null, clouds: [], fireflies: null, petals: null,
    birds: null, islands: [], crystals: [], waterMesh: null, enabled: true
  };
  const LOWQ = LOW;
  const TAU = Math.PI * 2;

  // ---------- util ----------
  const canvasTex = (w, h, draw) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 1;
    return t;
  };
  const softDotTex = () => canvasTex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(w/2, h/2, 0, w/2, h/2, w/2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });

  // ==========================================================================
  //  1. SKY DOME — gradien zenith/horizon + glow matahari + dither anti-band
  // ==========================================================================
  const skyUniforms = {
    uZenith:  { value: new THREE.Color(0x2f6fb5) },
    uHorizon: { value: new THREE.Color(0xbfe0ff) },
    uGround:  { value: new THREE.Color(0x9fb6c8) },
    uSunDir:  { value: new THREE.Vector3(0.55, 0.72, 0.35).normalize() },
    uSunCol:  { value: new THREE.Color(0xfff1d6) },
    uDayness: { value: 1 },
    uStorm:   { value: 0 }
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main(){
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uZenith, uHorizon, uGround, uSunCol, uSunDir;
      uniform float uDayness, uStorm;
      varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -1.0, 1.0);
        // gradien langit: horizon -> zenith (kurva pow supaya horizon lebih tebal)
        float t = pow(clamp(h, 0.0, 1.0), 0.52);
        vec3 col = mix(uHorizon, uZenith, t);
        // di bawah horizon: kabut tanah
        col = mix(uGround, col, smoothstep(-0.16, 0.015, h));
        // glow matahari 3 lapis (lebar, sedang, inti)
        float sd = max(dot(d, normalize(uSunDir)), 0.0);
        float glow = pow(sd, 6.0) * 0.30 + pow(sd, 48.0) * 0.85 + pow(sd, 900.0) * 2.4;
        col += uSunCol * glow * uDayness;
        // pita hangat di horizon (sunset feel)
        float band = exp(-abs(h) * 6.5);
        col += uSunCol * band * 0.18 * uDayness;
        // badai: desaturasi + gelap
        col = mix(col, mix(vec3(dot(col, vec3(0.299,0.587,0.114))), vec3(0.18,0.20,0.23), 0.45), uStorm * 0.7);
        // dither -> hilangkan banding 8-bit
        float dth = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        col += (dth - 0.5) * 0.010;
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  D.sky = new THREE.Mesh(new THREE.IcosahedronGeometry(430, 2), skyMat);
  D.sky.frustumCulled = false;
  D.sky.renderOrder = -1000;
  D.sky.name = 'BL_sky';
  scene.add(D.sky);

  // ==========================================================================
  //  1b. PIPELINE WARNA — tone mapping dipindah ke SATU pass terakhir
  //      (material tidak tone-map sendiri; bloom jadi lihat nilai HDR asli)
  // ==========================================================================
  renderer.toneMapping = THREE.NoToneMapping;   // ACES dipasang di gradePass
  try { if (scene.environment) { scene.environment.dispose && scene.environment.dispose(); scene.environment = null; } } catch (e) {}
  // SSAO = render scene KEDUA penuh + 3 RT full-res. Dibuang total.
  try { if (typeof _ssao !== 'undefined') { _ssao.enabled = false; } } catch (e) {}
  // bloom hanya untuk nilai > 1 (matahari, kristal, api) -> langit tidak ikut bloom
  try { bloom.threshold = 1.0; bloom.radius = 0.62; bloom.strength = LOW ? 0.55 : 0.85; } catch (e) {}

  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uExposure: { value: 1.06 },
      uContrast: { value: 1.06 },
      uSat: { value: 1.12 },
      uVignette: { value: 0.30 },
      uTime: { value: 0 }
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse;
      uniform float uExposure, uContrast, uSat, uVignette, uTime;
      varying vec2 vUv;
      vec3 aces(vec3 x){
        const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }
      vec3 toSRGB(vec3 c){
        return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c));
      }
      void main(){
        vec3 col = texture2D(tDiffuse, vUv).rgb * uExposure;
        col = aces(col);
        col = (col - 0.5) * uContrast + 0.5;
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, uSat);
        // split toning: shadow dingin, highlight hangat
        col = mix(col * vec3(0.965, 1.0, 1.055), col * vec3(1.045, 1.005, 0.965), smoothstep(0.30, 0.88, l));
        col = clamp(col, 0.0, 1.0);
        // vignette
        vec2 d = vUv - 0.5;
        col *= clamp(1.0 - uVignette * dot(d, d) * 1.7, 0.0, 1.0);
        col = toSRGB(col);
        // dither 8-bit
        float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
        col += (n - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }`
  };
  const gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);          // WAJIB paling akhir: tonemap + sRGB
  D.gradePass = gradePass;

  // ==========================================================================
  //  2. AWAN — 2 lapis plane dengan tekstur noise lembut, scroll berbeda
  // ==========================================================================
  {
    const cloudTex = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = 'rgba(0,0,0,0)'; g.fillRect(0, 0, w, h);
      // gumpalan awan: banyak blob radial dengan alpha rendah (tileable kasar)
      for (let i = 0; i < 90; i++) {
        const x = Math.random() * w, y = Math.random() * h;
        const r = 14 + Math.random() * 46;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(255,255,255,0.30)');
        gr.addColorStop(0.6, 'rgba(255,255,255,0.10)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    });
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    cloudTex.repeat.set(2.2, 2.2);
    for (let i = 0; i < 2; i++) {
      const m = new THREE.MeshBasicMaterial({
        map: cloudTex.clone(), transparent: true, opacity: i === 0 ? 0.85 : 0.55,
        depthWrite: false, fog: false, side: THREE.DoubleSide,
        blending: THREE.NormalBlending, color: 0xffffff
      });
      m.map.needsUpdate = true;
      m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
      m.map.repeat.set(2.2 + i * 1.3, 2.2 + i * 1.3);
      const p = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), m);
      p.rotation.x = -Math.PI / 2;
      p.position.y = 150 + i * 34;
      p.renderOrder = -900;
      p.frustumCulled = false;
      p.name = 'BL_cloud' + i;
      scene.add(p);
      D.clouds.push(p);
    }
  }

  // ==========================================================================
  //  3. FIREFLIES — titik bercahaya yang berkedip, hanya malam
  // ==========================================================================
  {
    const N = LOWQ ? 90 : 170;
    const R = 34;
    const pos = new Float32Array(N * 3), ph = new Float32Array(N), sz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i*3]   = (rnd() * 2 - 1) * R;
      pos[i*3+1] = 0.4 + rnd() * 5.5;
      pos[i*3+2] = (rnd() * 2 - 1) * R;
      ph[i] = rnd() * TAU;
      sz[i] = 0.34 + rnd() * 0.36;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 }, uNight: { value: 0 }, uPR: { value: 1 }, uColor: { value: new THREE.Color(0xbdf7c9) } },
      vertexShader: /* glsl */`
        attribute float aPhase, aSize;
        uniform float uTime, uPR;
        varying float vBlink;
        void main(){
          vec3 p = position;
          float ph = aPhase;
          p.x += sin(uTime * 0.55 + ph) * 1.7;
          p.y += sin(uTime * 0.80 + ph * 1.7) * 0.75;
          p.z += cos(uTime * 0.47 + ph * 0.8) * 1.7;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uPR * (520.0 / max(1.0, -mv.z)), 54.0 * uPR);
          vBlink = pow(max(0.0, sin(uTime * 1.35 + ph * 2.7)), 5.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uNight; uniform vec3 uColor;
        varying float vBlink;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c));
          gl_FragColor = vec4(uColor, a * vBlink * uNight * 0.95);
        }`
    });
    D.fireflies = new THREE.Points(g, mat);
    D.fireflies.frustumCulled = false;
    D.fireflies.name = 'BL_fireflies';
    scene.add(D.fireflies);
  }

  // ==========================================================================
  //  4. KELOPAK JATUH — partikel pink/putih melayang, hanya siang
  // ==========================================================================
  {
    const N = LOWQ ? 34 : 70, R = 26;
    const pos = new Float32Array(N * 3), ph = new Float32Array(N), sz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i*3]   = (rnd() * 2 - 1) * R;
      pos[i*3+1] = 1 + rnd() * 12;
      pos[i*3+2] = (rnd() * 2 - 1) * R;
      ph[i] = rnd() * TAU;
      sz[i] = 0.26 + rnd() * 0.3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, fog: false,
      uniforms: { uTime: { value: 0 }, uDay: { value: 1 }, uPR: { value: 1 }, uColor: { value: new THREE.Color(0xffd6e8) } },
      vertexShader: /* glsl */`
        attribute float aPhase, aSize;
        uniform float uTime, uPR;
        varying float vA;
        void main(){
          vec3 p = position;
          float ph = aPhase;
          p.x += sin(uTime * 0.42 + ph) * 2.4;
          p.z += cos(uTime * 0.36 + ph * 1.3) * 2.4;
          p.y = mod(p.y - uTime * 0.55, 13.0) + 0.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uPR * (480.0 / max(1.0, -mv.z)), 44.0 * uPR);
          vA = 0.35 + 0.35 * sin(uTime * 1.1 + ph * 2.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uDay; uniform vec3 uColor;
        varying float vA;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.05, length(c));
          gl_FragColor = vec4(uColor, a * vA * uDay * 0.75);
        }`
    });
    D.petals = new THREE.Points(g, mat);
    D.petals.frustumCulled = false;
    D.petals.name = 'BL_petals';
    scene.add(D.petals);
  }

  // ==========================================================================
  //  5. BURUNG — InstancedMesh V-shape, terbang melingkar, sayap mengepak
  // ==========================================================================
  {
    const wing = new THREE.BufferGeometry();
    // dua segitiga membentuk "V"
    wing.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,   1.0, 0.10, -0.35,   1.0, 0.10, 0.35,
      0, 0, 0,  -1.0, 0.10,  0.35,  -1.0, 0.10, -0.35
    ], 3));
    wing.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0x2b3446, side: THREE.DoubleSide, fog: true });
    const N = LOWQ ? 6 : 12;
    D.birds = new THREE.InstancedMesh(wing, mat, N);
    D.birds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    D.birds.frustumCulled = false;
    D.birds.name = 'BL_birds';
    D.birds.userData.flock = [];
    for (let i = 0; i < N; i++) {
      D.birds.userData.flock.push({
        a: rnd() * TAU, r: 22 + rnd() * 30, h: 16 + rnd() * 16,
        spd: 0.10 + rnd() * 0.10, phase: rnd() * TAU, tilt: (rnd() - 0.5) * 0.5
      });
    }
    scene.add(D.birds);
  }

  // ==========================================================================
  //  6. PULAU TERAPUNG — 3 pulau kecil melayang (wonder / landmark langit)
  // ==========================================================================
  {
    const rockMatBL = new THREE.MeshStandardMaterial({ color: 0x7d7f8f, roughness: 0.95, flatShading: true });
    const grassMatBL = new THREE.MeshStandardMaterial({ color: 0x6fa84a, roughness: 0.88, flatShading: true });
    const spots = [[-38, 26, -30], [44, 34, -48], [10, 42, 58]];
    for (let i = 0; i < spots.length; i++) {
      const [x, y, z] = spots[i];
      const base = new THREE.DodecahedronGeometry(6.5, 0);
      base.scale(1.0, 0.55, 1.0);
      const cap = new THREE.CylinderGeometry(5.4, 6.2, 1.1, 7);
      cap.translate(0, 2.8, 0);
      const g = new THREE.Group();
      const m1 = new THREE.Mesh(base, rockMatBL); m1.position.y = 0;
      const m2 = new THREE.Mesh(cap, grassMatBL); m2.position.y = 0.2;
      g.add(m1, m2);
      // kristal kecil di atas pulau
      const shard = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.6, 5),
        new THREE.MeshStandardMaterial({ color: 0xc77dff, emissive: 0xc77dff, emissiveIntensity: 1.4, roughness: 0.3, flatShading: true }));
      shard.position.set(1.4, 3.4, -0.8); shard.rotation.z = 0.22;
      g.add(shard);
      g.position.set(x, y, z);
      g.name = 'BL_island' + i;
      g.userData = { baseY: y, phase: i * 2.1, spin: 0.02 + i * 0.01 };
      scene.add(g);
      D.islands.push(g);
    }
  }

  // ==========================================================================
  //  7. KRISTAL RAKSASA — landmark di darat, emissive (memanfaatkan bloom)
  // ==========================================================================
  {
    const spots = [[26, -14], [-30, 22], [52, 12], [-18, -46], [8, 40], [-52, -8]];
    const colA = 0x7ce7ff, colB = 0xc77dff;
    for (let i = 0; i < spots.length; i++) {
      const [x, z] = spots[i];
      const y = th(x, z);
      if (y < -0.5) continue;                       // jangan di dalam air
      const col = i % 2 ? colB : colA;
      const mat = new THREE.MeshStandardMaterial({
        color: col, emissive: col, emissiveIntensity: 1.1,
        roughness: 0.18, metalness: 0.15, flatShading: true,
        transparent: true, opacity: 0.92
      });
      const grp = new THREE.Group();
      const h = 4 + (i % 3) * 1.6;
      const main = new THREE.Mesh(new THREE.ConeGeometry(1.15, h, 6), mat);
      main.position.y = h / 2;
      main.rotation.z = (i % 2 ? 1 : -1) * 0.16;
      grp.add(main);
      // 2 pecahan kecil
      for (let k = 0; k < 2; k++) {
        const hh = h * (0.35 + k * 0.15);
        const s = new THREE.Mesh(new THREE.ConeGeometry(0.42, hh, 5), mat);
        s.position.set(Math.cos(i + k * 2.1) * 1.5, hh / 2, Math.sin(i + k * 2.1) * 1.5);
        s.rotation.z = Math.cos(i + k) * 0.35;
        grp.add(s);
      }
      // halo additive
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softDotTex(), color: col, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false
      }));
      halo.scale.setScalar(h * 2.4);
      halo.position.y = h * 0.55;
      grp.add(halo);
      grp.position.set(x, y, z);
      grp.name = 'BL_crystal' + i;
      grp.userData = { phase: i * 1.7, halo, mat };
      scene.add(grp);
      D.crystals.push(grp);
    }
  }

  // ==========================================================================
  //  8. AIR STYLIZED — ganti Water addon (hemat 1 render pass refleksi)
  // ==========================================================================
  {
    const waterU = {
      time: { value: 0 },
      uShallow: { value: new THREE.Color(0x59c7d6) },
      uDeep:    { value: new THREE.Color(0x1b5f8a) },
      uSunDir:  { value: new THREE.Vector3(0.55, 0.72, 0.35).normalize() },
      uSunCol:  { value: new THREE.Color(0xfff1d6) },
      uFogCol:  { value: new THREE.Color(0xbfe0ff) },
      uFogDen:  { value: 0.011 },
      uCamPos:  { value: new THREE.Vector3() },
      uDay:     { value: 1 }
    };
    const wMat = new THREE.ShaderMaterial({
      uniforms: waterU, transparent: true, side: THREE.DoubleSide, fog: false,
      vertexShader: /* glsl */`
        uniform float time;
        varying vec3 vWorld; varying vec2 vUv; varying float vWave;
        void main(){
          vUv = uv;
          vec3 p = position;
          // gerstner ringan 3 arah
          float w1 = sin(p.x * 0.55 + time * 1.1) * 0.055;
          float w2 = sin(p.y * 0.72 - time * 0.85) * 0.045;
          float w3 = sin((p.x + p.y) * 0.31 + time * 0.6) * 0.06;
          p.z += w1 + w2 + w3;
          vWave = w1 + w2 + w3;
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uShallow, uDeep, uSunDir, uSunCol, uFogCol, uCamPos;
        uniform float uFogDen, uDay, time;
        varying vec3 vWorld; varying vec2 vUv; varying float vWave;
        // hash noise 2D
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                     mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
        }
        void main(){
          // normal dari 2 lapis noise bergerak + gelombang vertex
          vec2 uv1 = vWorld.xz * 0.22 + vec2(time * 0.035, time * 0.021);
          vec2 uv2 = vWorld.xz * 0.55 - vec2(time * 0.052, time * 0.030);
          float n1 = noise(uv1), n2 = noise(uv2);
          vec3 N = normalize(vec3((n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.5,
                                 1.0,
                                 (n2 - 0.5) * 0.9 + (n1 - 0.5) * 0.5 + vWave * 2.0));
          vec3 V = normalize(uCamPos - vWorld);
          float fres = pow(1.0 - clamp(dot(V, N), 0.0, 1.0), 3.2);
          vec3 base = mix(uDeep, uShallow, clamp(fres * 1.15 + 0.12, 0.0, 1.0));
          // specular matahari
          vec3 H = normalize(V + normalize(uSunDir));
          float spec = pow(max(dot(N, H), 0.0), 180.0) * 2.2 * uDay;
          // sparkle
          float sp = pow(noise(vWorld.xz * 6.0 + time * 0.25), 18.0) * 1.6 * uDay;
          // busa tepi kolam
          float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
          float foam = smoothstep(0.055, 0.0, edge) * (0.55 + 0.45 * sin(vWorld.x * 3.0 + time * 1.5));
          base = mix(base, vec3(0.94, 0.98, 1.0), clamp(foam, 0.0, 1.0) * 0.8);
          base += uSunCol * (spec + sp);
          // fog manual
          float d = length(uCamPos - vWorld);
          float fd = 1.0 - exp(-uFogDen * uFogDen * d * d);
          base = mix(base, uFogCol, clamp(fd, 0.0, 1.0));
          gl_FragColor = vec4(base, 0.90);
        }`
    });

    // hitung tinggi permukaan pond seperti kode asli
    let minH = Infinity;
    for (let i = -POND_R; i <= POND_R; i += 2)
      for (let j = -POND_R; j <= POND_R; j += 2)
        minH = Math.min(minH, th(POND_X + i, POND_Z + j));

    if (water) {
      // ganti material Water addon -> hilangkan render target refleksi
      try {
        if (water.material && water.material.dispose) water.material.dispose();
      } catch (e) {}
      water.material = wMat;
    } else {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(POND_R * 2, POND_R * 2, 24, 24), wMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(POND_X, minH + 0.6, POND_Z);
      m.name = 'BL_water';
      scene.add(m);
      water = m;                       // updateEnvironment() akan menaikkan uniforms.time
    }
    D.waterMesh = water;
  }

  // ==========================================================================
  //  9. UPDATE — dipanggil tiap frame dari updateEnvironment (di-wrap)
  // ==========================================================================
  const _cTmp = new THREE.Color();
  const _cTmp2 = new THREE.Color();
  const _cDay = new THREE.Color(), _cDusk = new THREE.Color(), _cNight = new THREE.Color();
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _v3 = new THREE.Vector3();
  const _s3 = new THREE.Vector3(1, 1, 1);
  const _e = new THREE.Euler();
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  function update(dt) {
    if (!D.enabled) return;
    const t = performance.now() * 0.001;
    const dayness = (Math.sin(state.day * Math.PI * 2) + 1) / 2;
    const elev = Math.sin(state.day * Math.PI * 2);          // -1..1 ketinggian matahari
    const dayW = sstep(-0.06, 0.32, elev);
    const nightW = 1 - sstep(-0.32, 0.02, elev);
    const duskW = clamp(1 - dayW - nightW, 0, 1);
    const stormy = (state.weather === 'storm' || state.weather === 'overcast');
    const night = state.weather === 'bloodmoon';
    const isVoxel = state.world.dimension === 'voxel';
    const px = playerGroup.position.x, pz = playerGroup.position.z;

    // --- sky dome ---
    D.sky.position.set(camera.position.x, camera.position.y, camera.position.z);
    skyUniforms.uDayness.value = dayW + duskW * 0.55;
    skyUniforms.uStorm.value = stormy ? 1 : 0;

    // zenith
    _cNight.setHex(0x050a1c); _cDusk.setHex(0x40457e); _cDay.setHex(0x3a7ec4);
    _cTmp.copy(_cNight).lerp(_cDusk, clamp(duskW + dayW, 0, 1)).lerp(_cDay, dayW);
    skyUniforms.uZenith.value.copy(_cTmp);
    // horizon
    _cNight.setHex(0x0e1a2e); _cDusk.setHex(0xffa869); _cDay.setHex(0xcfe9ff);
    _cTmp2.copy(_cNight).lerp(_cDusk, clamp(duskW + dayW, 0, 1)).lerp(_cDay, dayW);
    skyUniforms.uHorizon.value.copy(_cTmp2);
    // kabut tanah di bawah horizon
    _cTmp.copy(_cTmp2).multiplyScalar(0.66);
    skyUniforms.uGround.value.copy(_cTmp);
    // warna matahari
    _cNight.setHex(0x8fa6ff); _cDusk.setHex(0xffb27a); _cDay.setHex(0xfff4de);
    skyUniforms.uSunCol.value.copy(_cNight).lerp(_cDusk, clamp(duskW + dayW, 0, 1)).lerp(_cDay, dayW);
    skyUniforms.uSunDir.value.set(0.55, 0.35 + dayW * 0.55, 0.35).normalize();
    scene.background = null;

    // --- LIGHTING (diambil alih dari updateEnvironment) ---
    sun.intensity = 0.08 + dayW * 2.35 + duskW * 1.15 + (stormy ? -0.6 : 0);
    sun.color.copy(skyUniforms.uSunCol.value);
    ambient.intensity = 0.16 + dayW * 0.40 + duskW * 0.24;
    ambient.color.setHex(stormy ? 0x9fb2c8 : 0x9cc4f0);
    ambient.groundColor.setHex(stormy ? 0x3a4038 : 0x4a5a3a);
    moon.intensity = (1 - dayW) * 0.22;
    if (night) sun.color.setHex(0xff7a7a);
    // kabut mengikuti warna horizon supaya menyatu
    scene.fog.color.copy(_cTmp2);
    scene.fog.density = (LOW ? 0.0060 : 0.0052) + (1 - dayW) * 0.0042 + (stormy ? 0.010 : 0) + (state.weather === 'fog' ? 0.012 : 0);
    if (D.gradePass) {
      D.gradePass.uniforms.uExposure.value = 1.02 + dayW * 0.06;
      D.gradePass.uniforms.uTime.value = t * 60;
    }
    // --- awan ---
    for (let i = 0; i < D.clouds.length; i++) {
      const c = D.clouds[i];
      c.position.x = px; c.position.z = pz;
      c.rotation.z += dt * (i === 0 ? 0.004 : -0.006);
      c.material.map.offset.x += dt * (i === 0 ? 0.0035 : 0.0060);
      c.material.map.offset.y += dt * 0.0008;
      const w = 0.55 + dayness * 0.45;
      c.material.color.setRGB(w * (duskW > 0.2 ? 1.0 : 0.98), w * (duskW > 0.2 ? 0.86 : 0.97), w * (duskW > 0.2 ? 0.78 : 0.99));
      c.material.opacity = (i === 0 ? 0.80 : 0.50) * (0.35 + dayness * 0.65) * (stormy ? 1.25 : 1);
      c.visible = !isVoxel;
    }

    // --- fireflies (malam) ---
    const ff = D.fireflies;
    const _pr = renderer.getPixelRatio();
    ff.material.uniforms.uPR.value = _pr;
    D.petals.material.uniforms.uPR.value = _pr;
    ff.material.uniforms.uTime.value = t;
    ff.material.uniforms.uNight.value = clamp((0.45 - dayness) * 2.6, 0, 1);
    ff.visible = !isVoxel;
    if (ff.visible) {
      const arr = ff.geometry.attributes.position.array;
      const R = 34;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i]   += Math.sin(t * 0.6 + i) * dt * 0.35;
        arr[i+2] += Math.cos(t * 0.5 + i) * dt * 0.35;
        if (arr[i] - px > R) arr[i] -= 2 * R; else if (arr[i] - px < -R) arr[i] += 2 * R;
        if (arr[i+2] - pz > R) arr[i+2] -= 2 * R; else if (arr[i+2] - pz < -R) arr[i+2] += 2 * R;
      }
      ff.geometry.attributes.position.needsUpdate = true;
      ff.position.y = th(px, pz);          // ikut kontur tanah
    }

    // --- kelopak ---
    D.petals.material.uniforms.uTime.value = t;
    D.petals.material.uniforms.uDay.value = clamp(dayness * 1.6 - 0.25, 0, 1);
    D.petals.position.set(px, th(px, pz), pz);
    D.petals.visible = !isVoxel;

    // --- burung ---
    const flock = D.birds.userData.flock;
    for (let i = 0; i < flock.length; i++) {
      const b = flock[i];
      b.a += dt * b.spd;
      const x = px + Math.cos(b.a) * b.r;
      const z = pz + Math.sin(b.a) * b.r;
      const y = th(x, z) + b.h + Math.sin(t * 1.2 + b.phase) * 1.6;
      const flap = Math.sin(t * 7.5 + b.phase) * 0.45;
      _e.set(0, -b.a + Math.PI / 2, flap + b.tilt);
      _q.setFromEuler(_e);
      _v3.set(x, y, z);
      _s3.set(1.15, 1.15, 1.15);
      _m4.compose(_v3, _q, _s3);
      D.birds.setMatrixAt(i, _m4);
    }
    D.birds.instanceMatrix.needsUpdate = true;
    D.birds.visible = dayness > 0.25 && !isVoxel;

    // --- pulau terapung ---
    for (let i = 0; i < D.islands.length; i++) {
      const g = D.islands[i], u = g.userData;
      g.position.y = u.baseY + Math.sin(t * 0.35 + u.phase) * 1.4;
      g.rotation.y += dt * u.spin;
      g.visible = !isVoxel;
    }

    // --- kristal ---
    for (let i = 0; i < D.crystals.length; i++) {
      const g = D.crystals[i], u = g.userData;
      const pulse = 0.85 + Math.sin(t * 1.5 + u.phase) * 0.35;
      u.mat.emissiveIntensity = pulse * (night || state.weather === 'aurora' ? 2.2 : 1.2);
      u.halo.material.opacity = 0.28 + pulse * 0.22;
      u.halo.scale.setScalar(14 + pulse * 5);
      g.visible = !isVoxel;
    }

    // --- air ---
    const wm = D.waterMesh;
    if (wm && wm.material && wm.material.uniforms) {
      const u = wm.material.uniforms;
      if (u.uCamPos) u.uCamPos.value.copy(camera.position);
      if (u.uFogCol) u.uFogCol.value.copy(scene.fog.color);
      if (u.uFogDen) u.uFogDen.value = scene.fog.density;
      if (u.uDay) u.uDay.value = 0.25 + dayness * 0.95;
      if (u.uSunDir) u.uSunDir.value.copy(sunOffset).normalize();
    }
  }

  return { D, update, skyUniforms };
})();

// hubungkan ke loop utama tanpa menyentuh animate(): bungkus updateEnvironment
const _blOrigUpdateEnvironment = updateEnvironment;
updateEnvironment = function (dt) {
  _blOrigUpdateEnvironment(dt);
  try { BL.update(dt); } catch (e) { console.warn('BeautyLayer:', e && e.message); }
};
