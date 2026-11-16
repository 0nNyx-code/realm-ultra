// ============================================================================
//  REALM ULTRA v4.0 — VOXEL ASCENSION
//  ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Water } from 'three/addons/objects/Water.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

/* ============================================================================
   REALM ULTRA — ULTRA CHARACTER  v1.0  "VOXEL KNIGHT"
   ----------------------------------------------------------------------------
   Drop-in module. Tanpa dependency selain THREE (r150+).
   Cukup paste blok ini SEBELUM `(() => { 'use strict';` di file utama,
   lalu panggil di dalam game loop.

   CONTOH PAKAI:
     const hero = UltraCharacter.create(THREE, {
       tint: 0x5f7dfa, accent: 0x5eead4, quality: LOW ? 'low' : 'high',
       shadows: Q.shadows, armorTier: 3, cape: true
     });
     scene.add(hero.root);
     hero.setPosition(0, 0, 0);
     hero.setFacing(0);
     hero.attachWeapon('sword');

     // tiap frame:
     hero.update(dt, {
       speed: 6.2,          // unit/detik (0 = idle)
       airborne: !state.grounded,
       vy: state.velY,
       sprint: state.sprinting
     });

     // event:
     hero.playAttack('slashR');      // slashR | slashL | overhead | thrust | spin
     hero.play('parry');             // parry | dash | hurt | land | cast | ult | mine | victory | dead
     hero.setState('idle');          // paksa state
     hero.setArmorTier(2);           // 0..3
     hero.setCape(false);
     hero.attachWeapon('axe');       // sword | axe | spear | greatsword | dagger | staff
     hero.getSocket('bladeTip');     // Object3D untuk FX
     hero.getSocket('handR');        // dst: handL head chest back footL footR
     hero.setTint(0xa78bfa);
     hero.dispose();
   ========================================================================== */

const UltraCharacter = (function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  POSE KEY LIST (flat, zero-alloc blending)                          */
  /* ------------------------------------------------------------------ */
  const K = [
    'rootPY', 'rootPZ', 'rootRX', 'rootRY', 'rootRZ',
    'pelPY', 'pelRX', 'pelRY', 'pelRZ',
    'spRX', 'spRY', 'spRZ',
    'chRX', 'chRY', 'chRZ',
    'nkRX', 'nkRY', 'nkRZ',
    'hdRX', 'hdRY', 'hdRZ',
    'shLx', 'shLy', 'shLz', 'elLx', 'elLz', 'wrLx',
    'shRx', 'shRy', 'shRz', 'elRx', 'elRz', 'wrRx',
    'hipLx', 'hipLz', 'knLx', 'anLx',
    'hipRx', 'hipRz', 'knRx', 'anRx',
    'cp0', 'cp1', 'cp2', 'cp3', 'cpY',
    'wpx', 'wpz'
  ];

  function makePose() {
    const o = {};
    for (let i = 0; i < K.length; i++) o[K[i]] = 0;
    return o;
  }
  function clearPose(o) {
    for (let i = 0; i < K.length; i++) o[K[i]] = 0;
  }
  function lerpPose(cur, tgt, a) {
    for (let i = 0; i < K.length; i++) {
      const k = K[i];
      cur[k] += (tgt[k] - cur[k]) * a;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  MATH HELPERS (no allocation)                                       */
  /* ------------------------------------------------------------------ */
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const lerp  = (a, b, t) => a + (b - a) * t;
  const seg   = (u, a, b) => u <= a ? 0 : (u >= b ? 1 : (u - a) / (b - a));
  const ease  = (u) => u * u * (3 - 2 * u);
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);
  const easeIn  = (u) => u * u * u;

  /*  keyframe combine: 0 -> vA @ w -> vB @ s -> 0 @ r  */
  function kf(w, vA, s, vB, r) {
    let v = vA * w;
    v += (vB - vA) * s;
    v -= vB * r;
    return v;
  }

  /* ------------------------------------------------------------------ */
  /*  FACTORY                                                            */
  /* ------------------------------------------------------------------ */
  function create(THREE, opt) {
    opt = opt || {};
    const QUALITY   = opt.quality || 'high';
    const LOW       = QUALITY === 'low';
    const TINT      = opt.tint   !== undefined ? opt.tint   : 0x5f7dfa;
    const ACCENT    = opt.accent !== undefined ? opt.accent : 0x5eead4;
    const SHADOW    = opt.shadows !== false;
    const WANT_CAPE = opt.cape !== false;
    let   ARMOR     = opt.armorTier === undefined ? 3 : opt.armorTier;

    const tintCol   = new THREE.Color(TINT);
    const accentCol = new THREE.Color(ACCENT);

    /* ---------------- MATERIALS (shared, ~10 total) ---------------- */
    const M = {
      skin:    new THREE.MeshStandardMaterial({ color: 0xffd2ab, roughness: 0.78, metalness: 0.02 }),
      cloth:   new THREE.MeshStandardMaterial({ color: TINT, roughness: 0.84, metalness: 0.05 }),
      clothD:  new THREE.MeshStandardMaterial({ color: tintCol.clone().multiplyScalar(0.45), roughness: 0.9 }),
      armor:   new THREE.MeshPhysicalMaterial({ color: 0x2b3050, roughness: 0.38, metalness: 0.78, flatShading: true, clearcoat: 0.6, clearcoatRoughness: 0.22, reflectivity: 0.45 }),
      armorD:  new THREE.MeshPhysicalMaterial({ color: 0x171b30, roughness: 0.45, metalness: 0.7, flatShading: true, clearcoat: 0.45, clearcoatRoughness: 0.28, reflectivity: 0.4 }),
      trim:    new THREE.MeshPhysicalMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.55, roughness: 0.28, metalness: 0.82, clearcoat: 0.78, clearcoatRoughness: 0.12 }),
      leather: new THREE.MeshStandardMaterial({ color: 0x3a2a24, roughness: 0.92, metalness: 0.04 }),
      steel:   new THREE.MeshPhysicalMaterial({ color: 0xdfe6ff, emissive: 0x24407a, emissiveIntensity: 0.32, roughness: 0.24, metalness: 0.92, clearcoat: 0.85, clearcoatRoughness: 0.08 }),
      hair:    new THREE.MeshStandardMaterial({ color: 0x1b2038, roughness: 0.86, flatShading: true }),
      dark:    new THREE.MeshStandardMaterial({ color: 0x0d1020, roughness: 0.9 }),
      cape:    new THREE.MeshStandardMaterial({ color: tintCol.clone().multiplyScalar(0.5), roughness: 0.93, side: THREE.DoubleSide, metalness: 0.03 }),
      glow:    new THREE.MeshBasicMaterial({ color: ACCENT }),
      eye:     new THREE.MeshBasicMaterial({ color: 0x0a0c1c })
    };

    /* ---------------- GEOMETRIES (low poly, shared) ---------------- */
    const G = {
      box:      new THREE.BoxGeometry(1, 1, 1),
      sphere:   new THREE.SphereGeometry(1, LOW ? 8 : 12, LOW ? 6 : 9),
      sphereLo: new THREE.SphereGeometry(1, 6, 4),
      cyl:      new THREE.CylinderGeometry(1, 1, 1, LOW ? 6 : 9),
      cone:     new THREE.ConeGeometry(1, 1, LOW ? 5 : 7),
      torus:    new THREE.TorusGeometry(1, 0.14, 6, 14),
      plane:    new THREE.PlaneGeometry(1, 1),
      capArm:   new THREE.CapsuleGeometry(0.085, 0.24, 3, LOW ? 5 : 7),
      capFore:  new THREE.CapsuleGeometry(0.072, 0.22, 3, LOW ? 5 : 7),
      capThigh: new THREE.CapsuleGeometry(0.11, 0.30, 3, LOW ? 5 : 7),
      capShin:  new THREE.CapsuleGeometry(0.095, 0.30, 3, LOW ? 5 : 7),
      capNeck:  new THREE.CapsuleGeometry(0.075, 0.09, 2, 6),
      finger:   new THREE.BoxGeometry(0.026, 0.055, 0.026),
      voxel:    new THREE.BoxGeometry(0.055, 0.055, 0.055)
    };

    /* ---------------- BUILD HELPERS ---------------- */
    function mk(geo, mat, parent, x, y, z, sx, sy, sz, shadow) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x || 0, y || 0, z || 0);
      if (sx !== undefined) m.scale.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
      m.castShadow = SHADOW && shadow !== false;
      m.receiveShadow = false;
      if (parent) parent.add(m);
      return m;
    }
    function grp(parent, x, y, z) {
      const g = new THREE.Group();
      g.position.set(x || 0, y || 0, z || 0);
      if (parent) parent.add(g);
      return g;
    }
    function sock(parent, x, y, z) {
      const o = new THREE.Object3D();
      o.position.set(x || 0, y || 0, z || 0);
      parent.add(o);
      return o;
    }

    /* ================================================================ */
    /*  ROOT / HIERARCHY                                                */
    /* ================================================================ */
    const root = new THREE.Group();
    root.name = 'UltraCharacter';

    const body = grp(root);                       // squash/stretch holder
    const pelvis = grp(body, 0, 0.94, 0);         // BASE_PELVIS_Y
    const PELVIS_Y = 0.94;

    /* --- pelvis mesh + belt ---------------------------------------- */
    mk(G.box, M.cloth, pelvis, 0, 0, 0, 0.40, 0.22, 0.26);
    const belt = mk(G.box, M.leather, pelvis, 0, 0.10, 0, 0.44, 0.09, 0.29);
    mk(G.box, M.trim, pelvis, 0, 0.10, 0.15, 0.11, 0.11, 0.045);
    const tassetL = mk(G.box, M.armorD, pelvis, 0.17, -0.11, 0.02, 0.16, 0.20, 0.22);
    const tassetR = mk(G.box, M.armorD, pelvis, -0.17, -0.11, 0.02, 0.16, 0.20, 0.22);

    /* ================================================================ */
    /*  LEGS                                                            */
    /* ================================================================ */
    function buildLeg(side) {           // side: +1 = kiri (+X), -1 = kanan (-X)
      const hip = grp(pelvis, side * 0.135, -0.055, 0);
      mk(G.capThigh, M.cloth, hip, 0, -0.24, 0, 1, 1, 1);
      const thighPlate = mk(G.box, M.armor, hip, side * 0.075, -0.20, 0.01, 0.10, 0.30, 0.19, false);

      const knee = grp(hip, 0, -0.48, 0);
      mk(G.sphereLo, M.armor, knee, 0, 0, 0, 0.105, 0.09, 0.105);
      mk(G.capShin, M.armorD, knee, 0, -0.25, 0, 1, 1, 1);

      const foot = grp(knee, 0, -0.49, 0);
      mk(G.box, M.armorD, foot, 0, -0.045, 0.06, 0.155, 0.10, 0.30);
      mk(G.box, M.trim, foot, 0, -0.03, 0.20, 0.13, 0.055, 0.05, false);
      mk(G.box, M.dark, foot, 0, -0.085, 0.06, 0.16, 0.03, 0.31, false);

      return { hip, knee, foot, thighPlate };
    }
    const legL = buildLeg(1);
    const legR = buildLeg(-1);

    /* ================================================================ */
    /*  SPINE / CHEST                                                   */
    /* ================================================================ */
    const spine = grp(pelvis, 0, 0.13, 0);
    mk(G.box, M.cloth, spine, 0, 0.10, 0, 0.34, 0.22, 0.23);

    const chest = grp(spine, 0, 0.24, 0);
    mk(G.box, M.cloth, chest, 0, 0.10, 0, 0.42, 0.34, 0.27);

    /* cuirass (armor plate) — toggled by armor tier */
    const cuirass = grp(chest, 0, 0.10, 0);
    mk(G.box, M.armor, cuirass, 0, 0, 0.015, 0.47, 0.36, 0.30);
    mk(G.box, M.armorD, cuirass, 0, -0.16, 0.02, 0.44, 0.10, 0.29, false);
    mk(G.box, M.trim, cuirass, 0, 0.06, 0.17, 0.10, 0.16, 0.035, false);
    mk(G.box, M.trim, cuirass, 0.20, 0.10, 0.03, 0.04, 0.30, 0.28, false);
    mk(G.box, M.trim, cuirass, -0.20, 0.10, 0.03, 0.04, 0.30, 0.28, false);
    const backPlate = mk(G.box, M.armorD, cuirass, 0, 0.02, -0.16, 0.44, 0.32, 0.06);

    /* ================================================================ */
    /*  ARMS                                                            */
    /* ================================================================ */
    function buildArm(side) {           // +1 = kiri (+X), -1 = kanan (-X)
      const shoulder = grp(chest, side * 0.265, 0.145, 0);

      const upper = mk(G.capArm, M.cloth, shoulder, 0, -0.17, 0, 1, 1, 1);

      /* pauldron */
      const pauldron = grp(shoulder, side * 0.045, 0.06, 0);
      mk(G.sphere, M.armor, pauldron, 0, 0, 0, 0.155, 0.13, 0.155);
      mk(G.box, M.trim, pauldron, side * 0.02, -0.07, 0, 0.06, 0.14, 0.20, false);
      const spike = mk(G.cone, M.trim, pauldron, side * 0.075, 0.06, 0, 0.045, 0.14, 0.045, false);
      spike.rotation.z = side * -0.6;

      const elbow = grp(shoulder, 0, -0.355, 0);
      mk(G.capFore, M.clothD, elbow, 0, -0.155, 0, 1, 1, 1);
      /* gauntlet */
      const gauntlet = mk(G.box, M.armor, elbow, 0, -0.24, 0, 0.115, 0.13, 0.115, false);

      const hand = grp(elbow, 0, -0.35, 0);
      mk(G.box, M.skin, hand, 0, -0.02, 0, 0.095, 0.11, 0.075, false);
      if (!LOW) {
        for (let i = 0; i < 3; i++) {
          mk(G.finger, M.skin, hand, side * 0.022, -0.085, -0.045 + i * 0.045, 1, 1, 1, false);
        }
        mk(G.finger, M.skin, hand, side * -0.02, -0.06, 0.03, 1, 0.9, 1, false);
      }

      return { shoulder, elbow, hand, pauldron, gauntlet, upper };
    }
    const armL = buildArm(1);
    const armR = buildArm(-1);

    /* ================================================================ */
    /*  NECK / HEAD                                                     */
    /* ================================================================ */
    const neck = grp(chest, 0, 0.30, 0);
    mk(G.capNeck, M.skin, neck, 0, 0.02, 0, 1, 1, 1, false);

    const head = grp(neck, 0, 0.16, 0);
    const skull = mk(G.sphere, M.skin, head, 0, 0.02, 0, 0.225, 0.245, 0.225);
    mk(G.box, M.skin, head, 0, -0.06, 0.02, 0.20, 0.12, 0.20, false);   // jaw

    /* eyes (blink via scale.y) */
    const eyeL = mk(G.box, M.eye, head, 0.078, 0.045, 0.205, 0.042, 0.055, 0.02, false);
    const eyeR = mk(G.box, M.eye, head, -0.078, 0.045, 0.205, 0.042, 0.055, 0.02, false);
    /* iris glow */
    const irisL = mk(G.box, M.glow, head, 0.078, 0.045, 0.216, 0.024, 0.032, 0.008, false);
    const irisR = mk(G.box, M.glow, head, -0.078, 0.045, 0.216, 0.024, 0.032, 0.008, false);

    /* hair — voxel cluster */
    const hairGroup = grp(head, 0, 0, 0);
    if (!LOW) {
      const HC = 11;
      for (let i = 0; i < HC; i++) {
        const a = (i / HC) * Math.PI * 2;
        const r = 0.16 + Math.random() * 0.06;
        const h = mk(G.voxel, M.hair, hairGroup,
          Math.cos(a) * r * 0.9,
          0.16 + Math.random() * 0.10,
          Math.sin(a) * r * 0.75 - 0.03,
          1 + Math.random() * 0.6, 1 + Math.random() * 0.8, 1 + Math.random() * 0.6, false);
        h.rotation.set(Math.random(), Math.random(), Math.random());
      }
    } else {
      mk(G.sphereLo, M.hair, hairGroup, 0, 0.09, -0.02, 0.24, 0.20, 0.245, false);
    }

    /* helmet (armor tier >= 1) */
    const helmet = grp(head, 0, 0, 0);
    mk(G.sphere, M.armor, helmet, 0, 0.075, -0.01, 0.252, 0.225, 0.252);
    mk(G.box, M.armorD, helmet, 0, -0.03, 0.145, 0.42, 0.11, 0.14, false);   // visor brim
    mk(G.box, M.dark, helmet, 0, 0.015, 0.16, 0.34, 0.075, 0.13, false);     // visor slit
    const helmCrest = mk(G.box, M.trim, helmet, 0, 0.20, -0.02, 0.045, 0.10, 0.34, false);
    mk(G.cone, M.trim, helmet, 0, 0.30, -0.20, 0.05, 0.14, 0.05, false);
    const hornL = mk(G.cone, M.armorD, helmet, 0.19, 0.10, -0.02, 0.05, 0.24, 0.05, false);
    hornL.rotation.z = -0.75;
    const hornR = mk(G.cone, M.armorD, helmet, -0.19, 0.10, -0.02, 0.05, 0.24, 0.05, false);
    hornR.rotation.z = 0.75;

    /* ================================================================ */
    /*  CAPE (4 segments, cheap swing)                                  */
    /* ================================================================ */
    let capeSegs = [];
    const capeRoot = grp(chest, 0, 0.16, -0.17);
    if (WANT_CAPE) {
      const N = LOW ? 2 : 4;
      let parent = capeRoot;
      for (let i = 0; i < N; i++) {
        const s = grp(parent, 0, i === 0 ? 0 : -0.26, 0);
        const w = 0.52 - i * 0.05;
        const m = mk(G.box, M.cape, s, 0, -0.13, 0, w, 0.27, 0.035, false);
        m.castShadow = false;
        capeSegs.push(s);
        parent = s;
      }
      /* shoulder mantle */
      const mantle = mk(G.box, M.cape, chest, 0, 0.24, -0.02, 0.52, 0.14, 0.36, false);
      mantle.rotation.x = -0.16;
      capeRoot.userData.mantle = mantle;
    }

    /* ================================================================ */
    /*  SOCKETS                                                         */
    /* ================================================================ */
    const sockets = {
      handR: armR.hand,
      handL: armL.hand,
      head: head,
      chest: chest,
      pelvis: pelvis,
      back: backPlate,
      footL: legL.foot,
      footR: legR.foot,
      shoulderR: armR.shoulder,
      shoulderL: armL.shoulder
    };

    /* ================================================================ */
    /*  WEAPONS                                                         */
    /* ================================================================ */
    const weaponMount = grp(armR.hand, 0, -0.06, 0.03);
    weaponMount.rotation.x = -Math.PI / 2;   // blade mengarah ke depan (+Z)

    const weapons = {};
    function buildWeapon(type) {
      const g = new THREE.Group();
      g.visible = false;
      let tip = null, base = null;

      const handleMat = M.leather;
      const bladeMat = M.steel;

      if (type === 'sword' || type === 'greatsword') {
        const long = type === 'greatsword';
        const bladeLen = long ? 1.55 : 1.15;
        const bladeW = long ? 0.115 : 0.075;
        mk(G.cyl, handleMat, g, 0, -0.16, 0, 0.032, 0.28, 0.032, false);
        mk(G.box, M.trim, g, 0, -0.30, 0, 0.075, 0.06, 0.075, false);          // pommel
        mk(G.box, M.trim, g, 0, 0.015, 0, long ? 0.42 : 0.32, 0.055, 0.075, false); // guard
        const blade = mk(G.box, bladeMat, g, 0, 0.02 + bladeLen / 2, 0, bladeW, bladeLen, 0.032, true);
        mk(G.box, M.trim, g, 0, 0.05, 0.024, 0.022, bladeLen * 0.75, 0.012, false); // fuller glow
        mk(G.cone, bladeMat, g, 0, 0.02 + bladeLen + 0.09, 0, bladeW * 0.62, 0.20, 0.032, false);
        tip = sock(g, 0, 0.02 + bladeLen + 0.20, 0);
        base = sock(g, 0, 0.02, 0);
        if (long) mk(G.box, M.trim, g, 0, 0.05, -0.03, 0.05, 0.5, 0.02, false);
      }
      else if (type === 'axe') {
        mk(G.cyl, handleMat, g, 0, -0.05, 0, 0.036, 0.95, 0.036, false);
        mk(G.box, M.armorD, g, 0, 0.44, 0, 0.09, 0.24, 0.09, false);
        const headA = mk(G.box, M.steel, g, 0.14, 0.44, 0, 0.26, 0.24, 0.06, false);
        headA.rotation.z = -0.12;
        const headB = mk(G.box, M.steel, g, -0.11, 0.44, 0, 0.18, 0.20, 0.055, false);
        headB.rotation.z = 0.12;
        mk(G.cone, M.trim, g, 0.28, 0.44, 0, 0.05, 0.16, 0.05, false).rotation.z = -Math.PI / 2;
        tip = sock(g, 0.30, 0.44, 0);
        base = sock(g, 0, -0.5, 0);
      }
      else if (type === 'spear') {
        mk(G.cyl, handleMat, g, 0, -0.10, 0, 0.032, 2.05, 0.032, false);
        mk(G.box, M.trim, g, 0, 0.80, 0, 0.07, 0.12, 0.07, false);
        mk(G.cone, M.steel, g, 0, 1.06, 0, 0.075, 0.42, 0.075, false);
        mk(G.box, M.armorD, g, 0.06, 0.98, 0, 0.10, 0.10, 0.03, false).rotation.z = -0.7;
        mk(G.box, M.armorD, g, -0.06, 0.98, 0, 0.10, 0.10, 0.03, false).rotation.z = 0.7;
        tip = sock(g, 0, 1.28, 0);
        base = sock(g, 0, -1.1, 0);
      }
      else if (type === 'dagger') {
        mk(G.cyl, handleMat, g, 0, -0.10, 0, 0.028, 0.16, 0.028, false);
        mk(G.box, M.trim, g, 0, 0.0, 0, 0.20, 0.04, 0.06, false);
        mk(G.box, bladeMat, g, 0, 0.30, 0, 0.055, 0.55, 0.026, true);
        mk(G.cone, bladeMat, g, 0, 0.66, 0, 0.035, 0.14, 0.026, false);
        tip = sock(g, 0, 0.75, 0);
        base = sock(g, 0, 0.02, 0);
      }
      else { // staff
        mk(G.cyl, M.leather, g, 0, -0.10, 0, 0.038, 1.85, 0.038, false);
        mk(G.torus, M.trim, g, 0, 0.95, 0, 0.14, 0.14, 0.14, false);
        mk(G.sphere, M.glow, g, 0, 0.95, 0, 0.075, 0.075, 0.075, false);
        mk(G.box, M.armorD, g, 0, 0.80, 0, 0.10, 0.09, 0.10, false);
        tip = sock(g, 0, 0.95, 0);
        base = sock(g, 0, -1.0, 0);
      }

      g.userData.tip = tip;
      g.userData.base = base;
      weaponMount.add(g);
      weapons[type] = g;
      return g;
    }
    ['sword', 'axe', 'spear', 'greatsword', 'dagger', 'staff'].forEach(buildWeapon);

    let activeWeapon = 'sword';
    weapons.sword.visible = true;
    sockets.bladeTip = weapons.sword.userData.tip;
    sockets.bladeBase = weapons.sword.userData.base;

    /* ================================================================ */
    /*  ARMOR TIER VISIBILITY                                           */
    /* ================================================================ */
    function setArmorTier(t) {
      ARMOR = t;
      const on = (m, v) => { if (m) m.visible = v; };
      const t1 = ARMOR >= 1, t2 = ARMOR >= 2, t3 = ARMOR >= 3;
      on(cuirass, t1);
      on(helmet, t1);
      on(armL.pauldron, t1); on(armR.pauldron, t1);
      on(armL.gauntlet, t2); on(armR.gauntlet, t2);
      on(legL.thighPlate, t2); on(legR.thighPlate, t2);
      on(tassetL, t2); on(tassetR, t2);
      on(belt, true);
      if (helmCrest) helmCrest.visible = t3;
      if (capeRoot.userData.mantle) capeRoot.userData.mantle.visible = t3;
      hornL.visible = t3; hornR.visible = t3;
      if (backPlate) backPlate.visible = t2;
    }
    setArmorTier(ARMOR);

    function setCape(v) {
      capeRoot.visible = !!v;
    }
    setCape(WANT_CAPE);

    /* ================================================================ */
    /*  ANIMATION STATE                                                 */
    /* ================================================================ */
    const cur = makePose();
    const tgt = makePose();

    let _state    = 'idle';
    let _stateT   = 0;
    let _phase    = 0;
    let _blink    = 1.4 + Math.random() * 2.4;
    let _blinkT   = 0;
    let _breath   = 0;

    const _p = { speed: 0, airborne: false, vy: 0, sprint: false };
    const _hold = { name: null, t: 0, dur: 0, variant: null };

    /* ---------------- ACTION (one-shot states) ---------------- */
    const ACTION_DUR = {
      parry: 0.42, dash: 0.34, hurt: 0.42, land: 0.34,
      cast: 0.75, ult: 1.65, mine: 0.55, victory: 1.6, dead: 1.0
    };

    function play(name, dur) {
      _hold.name = name;
      _hold.t = 0;
      _hold.dur = dur !== undefined ? dur : (ACTION_DUR[name] || 0.5);
      _hold.variant = null;
    }
    function playAttack(variant) {
      const DUR = { slashR: 0.40, slashL: 0.40, overhead: 0.52, thrust: 0.38, spin: 0.62 };
      _hold.name = 'attack';
      _hold.variant = variant || 'slashR';
      _hold.t = 0;
      _hold.dur = DUR[_hold.variant] || 0.4;
    }

    /* ---------------- POSE GENERATOR ---------------- */
    function setPose(o, st, t, p, u, variant) {
      clearPose(o);

      const S = Math.sin, C = Math.cos;
      const spd = p.speed;
      const sprinting = p.sprint && spd > 0.2;
      const amp = sprinting ? 1.35 : 1.0;

      /* cape helper: base flow + oscillation */
      const cape = (base, wave) => {
        o.cp0 = base;
        o.cp1 = base * 1.15 + S(t * 1.6 + wave) * 0.06;
        o.cp2 = base * 1.30 + S(t * 1.6 + wave + 0.7) * 0.09;
        o.cp3 = base * 1.45 + S(t * 1.6 + wave + 1.4) * 0.12;
      };

      switch (st) {

        /* ---------------- IDLE ---------------- */
        case 'idle': {
          _breath = t * 1.5;
          const br = S(_breath);
          o.pelPY = br * 0.010;
          o.spRX  = 0.020 + br * 0.014;
          o.chRX  = 0.022 + br * 0.024;
          o.nkRX  = -0.030 - br * 0.012;
          o.hdRY  = S(t * 0.42) * 0.11;
          o.hdRX  = -0.020 + S(t * 0.71) * 0.022;
          o.shLx  = 0.045 + br * 0.018;  o.shLz =  0.105;
          o.shRx  = 0.045 + br * 0.018;  o.shRz = -0.105;
          o.elLx  = -0.20;  o.elRx = -0.20;
          o.hipLx = 0.020;  o.hipRx = 0.020;
          o.knLx  = 0.030;  o.knRx  = 0.030;
          o.anLx  = -0.020; o.anRx  = -0.020;
          o.pelRY = S(t * 0.31) * 0.035;
          cape(0.06, 0);
          break;
        }

        /* ---------------- WALK ---------------- */
        case 'walk': {
          const s = S(_phase), c = C(_phase);
          o.pelPY = Math.abs(s) * 0.030 - 0.018;
          o.pelRY = s * 0.055;
          o.pelRZ = c * 0.028;
          o.spRX  = 0.055;
          o.chRX  = 0.035;
          o.chRY  = -s * 0.14;
          o.hdRY  = s * 0.06;
          o.hdRX  = -0.03;
          o.hipLx = -s * 0.52 * amp;  o.knLx = Math.max(0, s) * 0.62 + 0.08;  o.anLx = 0.14 + s * 0.18;
          o.hipRx =  s * 0.52 * amp;  o.knRx = Math.max(0, -s) * 0.62 + 0.08; o.anRx = 0.14 - s * 0.18;
          o.shLx  =  s * 0.40 * amp;  o.elLx = -0.28 - Math.max(0, -s) * 0.30;
          o.shRx  = -s * 0.40 * amp;  o.elRx = -0.28 - Math.max(0, s) * 0.30;
          o.shLz  =  0.10;  o.shRz = -0.10;
          cape(0.14 + spd * 0.010, 0);
          o.cpY = s * 0.06;
          break;
        }

        /* ---------------- RUN ---------------- */
        case 'run': {
          const s = S(_phase), c = C(_phase);
          o.pelPY = Math.abs(s) * 0.052 - 0.030;
          o.pelRY = s * 0.09;
          o.pelRZ = c * 0.05;
          o.spRX  = 0.16;
          o.chRX  = 0.10;
          o.chRY  = -s * 0.26;
          o.hdRX  = -0.10;
          o.hdRY  = s * 0.07;
          o.hipLx = -s * 0.85 * amp;  o.knLx = Math.max(0, s) * 1.10 + 0.20;  o.anLx = 0.20 + s * 0.26;
          o.hipRx =  s * 0.85 * amp;  o.knRx = Math.max(0, -s) * 1.10 + 0.20; o.anRx = 0.20 - s * 0.26;
          o.shLx  =  s * 0.78 * amp;  o.elLx = -1.05;
          o.shRx  = -s * 0.78 * amp;  o.elRx = -1.05;
          o.shLz  =  0.16;  o.shRz = -0.16;
          cape(0.34 + spd * 0.020, 0);
          o.cpY = s * 0.10;
          break;
        }

        /* ---------------- SPRINT ---------------- */
        case 'sprint': {
          const s = S(_phase);
          o.pelPY = Math.abs(s) * 0.060 - 0.042;
          o.pelRY = s * 0.12;
          o.spRX  = 0.30;
          o.chRX  = 0.16;
          o.chRY  = -s * 0.34;
          o.nkRX  = -0.22;
          o.hdRX  = -0.20;
          o.hipLx = -s * 1.05;  o.knLx = Math.max(0, s) * 1.35 + 0.30;  o.anLx = 0.26 + s * 0.30;
          o.hipRx =  s * 1.05;  o.knRx = Math.max(0, -s) * 1.35 + 0.30; o.anRx = 0.26 - s * 0.30;
          o.shLx  =  s * 0.98;  o.elLx = -1.35;
          o.shRx  = -s * 0.98;  o.elRx = -1.35;
          o.shLz  =  0.20;  o.shRz = -0.20;
          o.wpz   = -0.15;
          cape(0.62 + spd * 0.030, 0);
          o.cpY = s * 0.14;
          break;
        }

        /* ---------------- JUMP ---------------- */
        case 'jump': {
          o.pelPY = 0.04;
          o.spRX  = -0.10;
          o.chRX  = -0.06;
          o.hdRX  = -0.16;
          o.hipLx = -0.55;  o.knLx = 0.95;  o.anLx = 0.36;
          o.hipRx = -0.30;  o.knRx = 0.60;  o.anRx = 0.30;
          o.shLx  = -0.85;  o.elLx = -0.55; o.shLz = 0.35;
          o.shRx  = -1.05;  o.elRx = -0.70; o.shRz = -0.45;
          cape(0.55, 0);
          break;
        }

        /* ---------------- FALL ---------------- */
        case 'fall': {
          o.pelPY = -0.01;
          o.spRX  = 0.05;
          o.chRX  = 0.10;
          o.hdRX  = 0.06;
          o.hipLx = -0.34;  o.knLx = 0.50;
          o.hipRx = 0.18;   o.knRx = 0.28;
          o.shLx  = -0.20;  o.elLx = -0.85; o.shLz = 0.55;
          o.shRx  = -0.30;  o.elRx = -0.95; o.shRz = -0.55;
          cape(0.85, 0);
          o.cpY = S(t * 3) * 0.08;
          break;
        }

        /* ---------------- ATTACK ---------------- */
        case 'attack': {
          const w = seg(u, 0.00, 0.26);
          const s = seg(u, 0.26, 0.52);
          const r = seg(u, 0.52, 1.00);
          const we = ease(w), se = easeOut(s), re = ease(r);

          if (variant === 'slashR') {
            o.spRY = kf(we, -0.52, se,  0.62, re);
            o.chRY = kf(we, -0.30, se,  0.36, re);
            o.chRX = kf(we, -0.10, se,  0.18, re);
            o.shRx = kf(we, -0.65, se, -0.15, re);
            o.shRz = kf(we, -1.35, se,  0.62, re);
            o.elRx = kf(we, -1.25, se, -0.18, re);
            o.shLx = kf(we,  0.30, se, -0.45, re);
            o.shLz = 0.28;
            o.elLx = -0.55;
            o.hipRx = kf(we, 0.10, se, -0.28, re);
            o.hipLx = kf(we, -0.10, se, 0.22, re);
            o.pelRY = kf(we, -0.20, se, 0.26, re);
            o.wpz = kf(we, 0.25, se, -0.45, re);
          }
          else if (variant === 'slashL') {
            o.spRY = kf(we,  0.55, se, -0.65, re);
            o.chRY = kf(we,  0.34, se, -0.40, re);
            o.chRX = kf(we, -0.08, se,  0.20, re);
            o.shRx = kf(we, -0.85, se, -0.30, re);
            o.shRz = kf(we,  0.95, se, -0.85, re);
            o.elRx = kf(we, -1.45, se, -0.25, re);
            o.shLx = kf(we,  0.10, se, -0.30, re);
            o.shLz = 0.22;
            o.pelRY = kf(we, 0.22, se, -0.28, re);
            o.hipLx = kf(we, 0.12, se, -0.30, re);
            o.wpz = kf(we, 0.35, se, -0.60, re);
          }
          else if (variant === 'overhead') {
            o.shRx = kf(we, -2.10, se, -0.10, re);
            o.shRz = kf(we, -0.35, se,  0.05, re);
            o.elRx = kf(we, -1.55, se, -0.10, re);
            o.shLx = kf(we, -1.45, se, -0.20, re);
            o.elLx = -0.80;
            o.spRX = kf(we, -0.24, se,  0.42, re);
            o.chRX = kf(we, -0.18, se,  0.30, re);
            o.hdRX = kf(we, -0.28, se,  0.24, re);
            o.hipLx = kf(we, 0.05, se, -0.42, re);
            o.hipRx = kf(we, 0.05, se, -0.30, re);
            o.knLx = kf(we, 0.10, se,  0.55, re);
            o.knRx = kf(we, 0.10, se,  0.45, re);
            o.pelPY = kf(we, 0.02, se, -0.12, re);
            o.wpx = kf(we, 0.30, se, -0.55, re);
          }
          else if (variant === 'thrust') {
            o.spRY = kf(we,  0.42, se, -0.44, re);
            o.chRY = kf(we,  0.30, se, -0.32, re);
            o.shRx = kf(we, -0.55, se, -1.55, re);
            o.shRz = kf(we,  0.25, se, -0.05, re);
            o.elRx = kf(we, -1.65, se, -0.02, re);
            o.shLx = 0.30; o.shLz = 0.25; o.elLx = -0.90;
            o.spRX = kf(we, 0.05, se, 0.30, re);
            o.hipRx = kf(we, 0.20, se, -0.45, re);
            o.hipLx = kf(we, -0.18, se, 0.30, re);
            o.knRx = 0.35; o.knLx = 0.50;
            o.pelPZ = 0;
            o.rootPZ = kf(we, -0.06, se, 0.22, re);
          }
          else { // spin
            o.rootRY = kf(we, -0.5, se, Math.PI * 2.0, re);
            o.shRx = -1.45; o.shRz = -0.55; o.elRx = -0.35;
            o.shLx = -1.45; o.shLz =  0.55; o.elLx = -0.35;
            o.spRX = kf(we, -0.10, se, 0.18, re);
            o.hipLx = kf(we, -0.10, se, 0.42, re);
            o.hipRx = kf(we,  0.10, se, -0.42, re);
            o.knLx = 0.35; o.knRx = 0.35;
            o.pelRY = kf(we, -0.25, se, 0.30, re);
          }
          cape(0.45 + s * 0.35, 0);
          break;
        }

        /* ---------------- PARRY ---------------- */
        case 'parry': {
          const w = seg(u, 0.0, 0.18);
          const s = seg(u, 0.18, 0.42);
          const r = seg(u, 0.42, 1.0);
          o.shRx = kf(ease(w), -1.75, ease(s), -1.05, ease(r));
          o.shRz = kf(ease(w),  0.55, ease(s),  0.85, ease(r));
          o.elRx = kf(ease(w), -1.95, ease(s), -2.30, ease(r));
          o.shLx = kf(ease(w), -0.35, ease(s), -1.15, ease(r));
          o.shLz = 0.45; o.elLx = -1.75;
          o.spRY = kf(ease(w), 0.35, ease(s), 0.55, ease(r));
          o.chRY = kf(ease(w), 0.22, ease(s), 0.34, ease(r));
          o.hdRY = 0.16;
          o.pelRY = kf(ease(w), 0.18, ease(s), 0.26, ease(r));
          o.knLx = 0.40; o.knRx = 0.28;
          o.hipLx = 0.20; o.hipRx = -0.15;
          o.pelPY = kf(ease(w), -0.03, ease(s), -0.06, ease(r));
          o.wpx = -0.30;
          cape(0.30, 0);
          break;
        }

        /* ---------------- DASH ---------------- */
        case 'dash': {
          const w = seg(u, 0, 0.22), r = seg(u, 0.5, 1);
          o.spRX = kf(ease(w), 0.55, 0, 0, ease(r));
          o.chRX = 0.30;
          o.nkRX = -0.40;
          o.hdRX = -0.30;
          o.shLx = -1.55; o.shLz = 0.30; o.elLx = -1.20;
          o.shRx =  1.05; o.shRz = -0.25; o.elRx = -1.60;
          o.hipLx = kf(ease(w), 0.75, 0, 0, ease(r));
          o.hipRx = kf(ease(w), -0.85, 0, 0, ease(r));
          o.knLx = 1.30; o.knRx = 0.55;
          o.anLx = 0.35; o.anRx = 0.45;
          o.pelPY = -0.10;
          cape(1.05, 0);
          break;
        }

        /* ---------------- HURT ---------------- */
        case 'hurt': {
          const w = seg(u, 0, 0.18), r = seg(u, 0.35, 1);
          o.spRX = kf(ease(w), -0.55, 0, 0, ease(r));
          o.chRX = kf(ease(w), -0.32, 0, 0, ease(r));
          o.nkRX = kf(ease(w), -0.35, 0, 0, ease(r));
          o.hdRX = kf(ease(w), -0.45, 0, 0, ease(r));
          o.shLx = kf(ease(w), -0.95, 0, 0, ease(r));  o.shLz = 0.55;
          o.shRx = kf(ease(w), -0.85, 0, 0, ease(r));  o.shRz = -0.55;
          o.elLx = -1.15; o.elRx = -1.05;
          o.hipLx = kf(ease(w), -0.35, 0, 0, ease(r));
          o.hipRx = kf(ease(w), -0.20, 0, 0, ease(r));
          o.knLx = 0.55; o.knRx = 0.42;
          o.rootPZ = kf(ease(w), -0.10, 0, 0, ease(r));
          o.pelPY = kf(ease(w), -0.05, 0, 0, ease(r));
          break;
        }

        /* ---------------- LAND ---------------- */
        case 'land': {
          const w = seg(u, 0, 0.22), r = seg(u, 0.35, 1);
          o.pelPY = kf(ease(w), -0.26, 0, 0, ease(r));
          o.spRX = kf(ease(w), 0.34, 0, 0, ease(r));
          o.chRX = kf(ease(w), 0.22, 0, 0, ease(r));
          o.hdRX = kf(ease(w), -0.12, 0, 0, ease(r));
          o.hipLx = kf(ease(w), -0.70, 0, 0, ease(r));
          o.hipRx = kf(ease(w), -0.70, 0, 0, ease(r));
          o.knLx = kf(ease(w), 1.35, 0, 0, ease(r));
          o.knRx = kf(ease(w), 1.35, 0, 0, ease(r));
          o.anLx = 0.45; o.anRx = 0.45;
          o.shLx = kf(ease(w), 0.65, 0, 0, ease(r));  o.shLz = 0.40;
          o.shRx = kf(ease(w), 0.65, 0, 0, ease(r));  o.shRz = -0.40;
          o.elLx = -0.70; o.elRx = -0.70;
          cape(0.45, 0);
          break;
        }

        /* ---------------- CAST ---------------- */
        case 'cast': {
          const w = seg(u, 0, 0.30), r = seg(u, 0.55, 1);
          o.shLx = kf(ease(w), -2.05, 0, 0, ease(r));
          o.shLz = kf(ease(w), 0.45, 0, 0, ease(r));
          o.elLx = kf(ease(w), -0.45, 0, 0, ease(r));
          o.shRx = kf(ease(w), -0.75, 0, 0, ease(r));
          o.shRz = -0.70;
          o.elRx = -1.35;
          o.spRX = kf(ease(w), -0.12, 0, 0, ease(r));
          o.chRX = kf(ease(w), -0.06, 0, 0, ease(r));
          o.hdRX = kf(ease(w), -0.25, 0, 0, ease(r));
          o.hipLx = 0.15; o.hipRx = -0.15;
          cape(0.42, 0);
          break;
        }

        /* ---------------- ULTIMATE ---------------- */
        case 'ult': {
          const w = seg(u, 0, 0.28);
          const s = seg(u, 0.28, 0.70);
          const r = seg(u, 0.82, 1.0);
          o.rootRY = kf(ease(w), -0.35, ease(s), Math.PI * 2.4, ease(r));
          o.shRx = kf(ease(w), -2.35, ease(s), -1.15, ease(r));
          o.shRz = kf(ease(w), -0.55, ease(s),  0.15, ease(r));
          o.elRx = kf(ease(w), -1.35, ease(s), -0.25, ease(r));
          o.shLx = kf(ease(w), -1.95, ease(s), -0.95, ease(r));
          o.shLz = kf(ease(w),  0.55, ease(s),  0.25, ease(r));
          o.elLx = -0.85;
          o.spRX = kf(ease(w), -0.30, ease(s), 0.10, ease(r));
          o.chRX = kf(ease(w), -0.22, ease(s), 0.06, ease(r));
          o.hdRX = kf(ease(w), -0.40, ease(s), 0.10, ease(r));
          o.hipLx = kf(ease(w), -0.20, ease(s), 0.45, ease(r));
          o.hipRx = kf(ease(w),  0.20, ease(s), -0.45, ease(r));
          o.knLx = kf(ease(w), 0.35, ease(s), 0.15, ease(r));
          o.knRx = kf(ease(w), 0.35, ease(s), 0.15, ease(r));
          o.pelPY = kf(ease(w), -0.14, ease(s), 0.08, ease(r));
          cape(1.10 + s * 0.35, 0);
          o.cpY = S(t * 6) * 0.16 * s;
          break;
        }

        /* ---------------- MINE ---------------- */
        case 'mine': {
          const w = seg(u, 0, 0.30), s = seg(u, 0.30, 0.55), r = seg(u, 0.62, 1);
          o.shRx = kf(ease(w), -1.90, easeOut(s), -0.15, ease(r));
          o.elRx = kf(ease(w), -0.95, easeOut(s), -0.30, ease(r));
          o.shRz = -0.18;
          o.shLx = -0.35; o.shLz = 0.32; o.elLx = -0.95;
          o.spRX = kf(ease(w), -0.12, easeOut(s), 0.40, ease(r));
          o.chRX = kf(ease(w), -0.06, easeOut(s), 0.26, ease(r));
          o.hipLx = 0.10; o.hipRx = 0.10;
          o.knLx = 0.30; o.knRx = 0.30;
          o.pelPY = kf(ease(w), 0.02, easeOut(s), -0.10, ease(r));
          break;
        }

        /* ---------------- VICTORY ---------------- */
        case 'victory': {
          const w = seg(u, 0, 0.30), s = seg(u, 0.30, 1.0);
          o.shRx = kf(ease(w), -2.60, 0, 0, 0);
          o.shRz = kf(ease(w), -0.15, 0, 0, 0);
          o.elRx = -0.15;
          o.shLx = kf(ease(w), -0.55, 0, 0, 0);
          o.shLz = 0.65; o.elLx = -1.25;
          o.spRX = -0.16;
          o.chRX = -0.10;
          o.hdRX = -0.32;
          o.pelPY = S(t * 3.2) * 0.030;
          o.rootRY = S(t * 0.9) * 0.18;
          cape(0.55 + S(t * 2.2) * 0.10, 0);
          break;
        }

        /* ---------------- DEAD ---------------- */
        case 'dead': {
          const w = ease(seg(u, 0, 0.75));
          o.rootRX = w * 1.40;
          o.rootPY = w * -0.62;
          o.spRX = w * -0.25;
          o.chRX = w * -0.15;
          o.hdRX = w * 0.35;
          o.hipLx = w * 0.55; o.hipRx = w * 0.45;
          o.knLx = w * 1.25;  o.knRx = w * 1.05;
          o.shLx = w * -1.35; o.shLz = 0.70;
          o.shRx = w * -1.15; o.shRz = -0.70;
          o.elLx = w * -0.75; o.elRx = w * -0.55;
          cape(0.9 * w, 0);
          break;
        }

        default:
          break;
      }
    }

    /* ================================================================ */
    /*  APPLY POSE -> BONES                                              */
    /* ================================================================ */
    function applyPose(o) {
      body.position.y = o.rootPY;
      body.position.z = o.rootPZ;
      body.rotation.set(o.rootRX, o.rootRY, o.rootRZ);

      pelvis.position.y = PELVIS_Y + o.pelPY;
      pelvis.rotation.set(o.pelRX, o.pelRY, o.pelRZ);

      spine.rotation.set(o.spRX, o.spRY, o.spRZ);
      chest.rotation.set(o.chRX, o.chRY, o.chRZ);
      neck.rotation.set(o.nkRX, o.nkRY, o.nkRZ);
      head.rotation.set(o.hdRX, o.hdRY, o.hdRZ);

      armL.shoulder.rotation.set(o.shLx, o.shLy, o.shLz);
      armL.elbow.rotation.set(o.elLx, 0, o.elLz);
      armL.hand.rotation.x = o.wrLx;

      armR.shoulder.rotation.set(o.shRx, o.shRy, o.shRz);
      armR.elbow.rotation.set(o.elRx, 0, o.elRz);
      armR.hand.rotation.x = o.wrRx;

      legL.hip.rotation.set(o.hipLx, 0, o.hipLz);
      legL.knee.rotation.x = o.knLx;
      legL.foot.rotation.x = o.anLx;

      legR.hip.rotation.set(o.hipRx, 0, o.hipRz);
      legR.knee.rotation.x = o.knRx;
      legR.foot.rotation.x = o.anRx;

      if (capeSegs.length) {
        capeSegs[0].rotation.x = o.cp0;
        capeSegs[0].rotation.y = o.cpY;
        if (capeSegs[1]) capeSegs[1].rotation.x = o.cp1;
        if (capeSegs[2]) capeSegs[2].rotation.x = o.cp2;
        if (capeSegs[3]) capeSegs[3].rotation.x = o.cp3;
      }

      weaponMount.rotation.x = -Math.PI / 2 + o.wpx;
      weaponMount.rotation.z = o.wpz;
    }

    /* ================================================================ */
    /*  LOCOMOTION PICKER                                                */
    /* ================================================================ */
    function pickLocomotion() {
      if (_p.airborne) return _p.vy > 0.4 ? 'jump' : 'fall';
      const sp = _p.speed;
      if (sp > 5.6) return 'sprint';
      if (sp > 2.6) return 'run';
      if (sp > 0.20) return 'walk';
      return 'idle';
    }

    /* ================================================================ */
    /*  UPDATE                                                          */
    /* ================================================================ */
    function update(dt, params) {
      if (dt > 0.06) dt = 0.06;
      if (params) {
        if (params.speed    !== undefined) _p.speed    = params.speed;
        if (params.airborne !== undefined) _p.airborne = params.airborne;
        if (params.vy       !== undefined) _p.vy       = params.vy;
        if (params.sprint   !== undefined) _p.sprint   = params.sprint;
      }

      /* phase advance */
      const strideRate = _p.speed > 5.6 ? 2.55 : (_p.speed > 2.6 ? 2.05 : 1.55);
      _phase += _p.speed * dt * strideRate;

      /* hold / action timer */
      if (_hold.name) {
        _hold.t += dt;
        if (_hold.t >= _hold.dur) {
          _hold.name = null;
          _hold.t = 0;
        }
      }

      /* state resolve */
      const next = _hold.name || pickLocomotion();
      if (next !== _state) {
        _state = next;
        _stateT = 0;
      } else {
        _stateT += dt;
      }

      const u = _hold.name ? clamp(_hold.t / _hold.dur, 0, 1) : 0;

      /* generate target pose */
      setPose(tgt, _state, _stateT, _p, u, _hold.variant);

      /* blend */
      const rate = _hold.name ? 30 : (_state === 'idle' ? 9 : 14);
      const a = 1 - Math.exp(-rate * dt);
      lerpPose(cur, tgt, a);

      applyPose(cur);

      /* ---- blink ---- */
      _blink -= dt;
      if (_blink <= 0) {
        _blinkT = 0.11;
        _blink = 2.2 + Math.random() * 4.2;
      }
      let eyeScale = 1;
      if (_blinkT > 0) {
        _blinkT -= dt;
        eyeScale = 0.10;
      }
      eyeL.scale.y = 0.055 * eyeScale;
      eyeR.scale.y = 0.055 * eyeScale;
      irisL.visible = eyeScale > 0.5;
      irisR.visible = eyeScale > 0.5;

      /* ---- idle micro head drift ---- */
      if (_state === 'idle') {
        head.rotation.y += Math.sin(_stateT * 0.6) * 0.02;
      }
    }

    /* ================================================================ */
    /*  PUBLIC API                                                      */
    /* ================================================================ */
    const api = {
      root,
      VERSION: '1.0',

      /* transform */
      setPosition(x, y, z) { root.position.set(x, y, z); return api; },
      getPosition(out) { return out ? out.copy(root.position) : root.position.clone(); },
      setFacing(yaw) { root.rotation.y = yaw; return api; },
      setScale(s) { root.scale.setScalar(s); return api; },
      setVisible(v) { root.visible = !!v; return api; },

      /* animation */
      update,
      play,
      playAttack,
      setState(name, dur) {
        _hold.name = name || null;
        _hold.t = 0;
        _hold.dur = dur !== undefined ? dur : (ACTION_DUR[name] || 0.5);
        _hold.variant = null;
      },
      isBusy() { return !!_hold.name; },
      getState() { return _state; },
      setParams(speed, airborne, vy, sprint) {
        if (speed    !== undefined) _p.speed = speed;
        if (airborne !== undefined) _p.airborne = airborne;
        if (vy       !== undefined) _p.vy = vy;
        if (sprint   !== undefined) _p.sprint = sprint;
      },

      /* equipment */
      attachWeapon(type) {
        if (!weapons[type]) return api;
        weapons[activeWeapon].visible = false;
        activeWeapon = type;
        weapons[type].visible = true;
        sockets.bladeTip = weapons[type].userData.tip;
        sockets.bladeBase = weapons[type].userData.base;
        return api;
      },
      getWeapon() { return activeWeapon; },
      setArmorTier,
      setCape,
      setTint(hex) {
        tintCol.setHex(hex);
        M.cloth.color.copy(tintCol);
        M.clothD.color.copy(tintCol).multiplyScalar(0.45);
        M.cape.color.copy(tintCol).multiplyScalar(0.5);
        return api;
      },
      setAccent(hex) {
        accentCol.setHex(hex);
        M.trim.color.copy(accentCol);
        M.trim.emissive.copy(accentCol);
        M.glow.color.copy(accentCol);
        return api;
      },

      /* fx sockets */
      getSocket(name) {
        if (name === 'bladeTip')  return sockets.bladeTip;
        if (name === 'bladeBase') return sockets.bladeBase;
        return sockets[name] || null;
      },
      getBone(name) {
        switch (name) {
          case 'pelvis': return pelvis;
          case 'spine':  return spine;
          case 'chest':  return chest;
          case 'neck':   return neck;
          case 'head':   return head;
          case 'armL':   return armL.shoulder;
          case 'armR':   return armR.shoulder;
          case 'handL':  return armL.hand;
          case 'handR':  return armR.hand;
          case 'legL':   return legL.hip;
          case 'legR':   return legR.hip;
          case 'footL':  return legL.foot;
          case 'footR':  return legR.foot;
          default: return null;
        }
      },

      /* shadow toggling for perf */
      setShadows(on) {
        root.traverse((o) => {
          if (o.isMesh && o !== eyeL && o !== eyeR && o !== irisL && o !== irisR) {
            o.castShadow = !!on;
          }
        });
      },

      /* cleanup */
      dispose() {
        root.traverse((o) => {
          if (o.isMesh) {
            if (o.geometry && !o.geometry.userData.__shared) o.geometry.dispose();
          }
        });
        Object.values(M).forEach((m) => m.dispose());
        Object.values(G).forEach((g) => g.dispose());
        if (root.parent) root.parent.remove(root);
      },

      /* internal debug */
      _pose: cur,
      _target: tgt
    };

    /* mark shared geometries as non-disposable individually */
    Object.values(G).forEach((g) => { g.userData.__shared = true; });

    /* initial pose resolve so the character isn't in T-pose */
    setPose(cur, 'idle', 0, _p, 0, null);
    applyPose(cur);

    return api;
  }

  return { create, VERSION: '1.0' };
})();

(() => {
'use strict';

// ============================================================================
//  SECTION: TUNING
// ============================================================================
const TUNING = {
  worldR: 112, chunkSize: 28,
  playerBaseSpeed: 6.2, sprintMult: 1.5, gravity: 17, jumpVel: 7.2,
  dashCost: 0.2, dashCd: 0.95,
  atkCdLight: 0.36, atkCdHeavy: 0.62, chargeTime: 0.8,
  parryWindow: 0.25, parryCd: 1.4,
  ultMax: 100, ultPerHit: 8,
  xpBase: 100, xpCurve: 1.35,
  crystalCount: 8, biomeCount: 5,
  corruptPerKill: 4, corruptPerDash: 2.5, corruptPerUlt: 20, corruptDecay: 0.6,
  overloadTime: 5, echoInterval: 30, echoRecord: 3,
  fractureRewind: 2, fractureCd: 20,
  // v4.0 voxel
  voxelDimW: 128, voxelDimH: 32, voxelChunk: 16,
  voxelGravityMult: 1.4, voxelJumpMult: 0.82,
  mineBaseTime: 0.55,
  portalCinematic: 2.4
};

// ============================================================================
//  SECTION: RNG
// ============================================================================
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const dailySeed = (() => {
  const d = new Date();
  return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
})();
const rnd = mulberry32(dailySeed);
const vrnd = mulberry32(dailySeed ^ 0x5eed);

// ============================================================================
//  SECTION: DEVICE TIER
// ============================================================================
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const IS_MOBILE = IS_TOUCH && Math.min(screen.width, screen.height) < 900;
const LOW = IS_MOBILE || window.innerWidth < 760;

const Q = LOW ? {
  // PERF: HP kelas Galaxy A05 render ~720x1600. pixelRatio 1.0 saja = 1.15M px.
  // Dynamic resolution akan menurunkan ini otomatis kalau FPS jatuh.
  pixelRatio: Math.min(window.devicePixelRatio || 1, 1.0), shadows: false, bloom: false, bloomStrength: 0.28,
  renderDist: 48, grassPerChunk: 56, treeCount: 120, rockCount: 48,
  flowerCount: 80, water: false, groundSeg: 96, particleScale: 0.4,
  mobSmall: 4, mobBrute: 1, maxMobs: 8, decals: 14,
  voxelRenderDist: 2, // chunks
  grassMax: 160, rain: 120
} : {
  pixelRatio: Math.min(devicePixelRatio, 1.5), shadows: true, bloom: true,
  bloomStrength: 0.6, renderDist: 78, grassPerChunk: 170, treeCount: 252,
  rockCount: 102, flowerCount: 290, water: true, groundSeg: 170,
  particleScale: 1, mobSmall: 6, mobBrute: 2, maxMobs: 18, decals: 40,
  voxelRenderDist: 5,
  grassMax: 500, rain: 500
};

// ============================================================================
//  SECTION: SETTINGS v4
// ============================================================================
const v4 = {
  sensitivity: 1.0,
  echoOn: true, corruptOn: true, fractureOn: true, killCamOn: true, trailsOn: true,
  bloomOn: true, shadowOn: true, dynResOn: true, occOn: true, grainOn: false,
  perfMode: false,
  renderDist: Q.renderDist,
  voxelAuto: true,
  preset: 'high'
};
try {
  const s = JSON.parse(localStorage.getItem('realm_ultra_v4_settings') || '{}');
  Object.assign(v4, s);
} catch(e){}
function saveSettings(){
  try { localStorage.setItem('realm_ultra_v4_settings', JSON.stringify(v4)); } catch(e){}
}

// ============================================================================
//  SECTION: PALETTE
// ============================================================================
const C = {
  void:0x0f1024, night:0x101128,
  teal:0x5eead4, violet:0xa78bfa, sky:0x7dd3fc,
  amber:0xfcd34d, magenta:0xe879f9, ember:0xfb923c,
  ice:0x93c5fd, water:0x123a5c, corrupt:0xc026d3,
  voxel:0x7ee787, voxelSoil:0x5d8a4a, voxelStone:0x7a7d84,
  voxelSand:0xe8d8a0, voxelNether:0x8a2a2a
};
const CSS = {
  teal:'#5eead4', violet:'#a78bfa', sky:'#7dd3fc', amber:'#fcd34d',
  magenta:'#e879f9', ember:'#fb923c', ice:'#93c5fd', ink:'#eef1ff',
  corrupt:'#c026d3', voxel:'#7ee787', mut:'rgba(214,222,255,.56)'
};

// ============================================================================
//  SECTION: KAOMOJI (no emoji!)
// ============================================================================
const KAO = {
  happy:   '( ￣▽￣)',
  surprise:'(* >ω<)',
  cry:     '(*T^T)',
  shy:     '(*/∀＼*)',
  sleep:   '(-.-)Zzz・・・・',
  cool:    '(￣▽￣)ゞ',
  determined:'(๑•̀ㅂ•́)و',
  shrug:   '¯\\_(ツ)_/¯',
  sparkle: '(* >ω<)',
  roar:    '(╯°□°）╯',
  cheeky:  '(￣ω￣)',
  hmm:     '(￣～￣)',
  dead:    '(x_x)'
};

const $ = (id) => document.getElementById(id);
function showBootNotice(message){
  let box = $('bootNotice');
  if (!box){
    box = document.createElement('div'); box.id = 'bootNotice';
    box.style.cssText = 'position:fixed;z-index:99999;left:12px;right:12px;bottom:12px;padding:12px 14px;border:1px solid #fb923c;border-radius:12px;background:#1b1015;color:#ffe8d2;font:12px/1.5 system-ui;white-space:pre-wrap';
    document.body.appendChild(box);
  }
  box.textContent = 'Sebagian fitur gagal dimuat. Game mencoba tetap berjalan.\n' + String(message).slice(0,500);
}
addEventListener('error', e => { if ($('fade')?.style.opacity === '1') showBootNotice(e.message || 'Kesalahan JavaScript saat boot'); });
addEventListener('unhandledrejection', e => { if ($('fade')?.style.opacity === '1') showBootNotice(e.reason?.message || e.reason || 'Kesalahan pemuatan'); });
const clamp = (v,lo,hi) => v<lo?lo:(v>hi?hi:v);
const lerp = (a,b,t) => a + (b-a)*t;

// ============================================================================
//  SECTION: NOISE
// ============================================================================
const noise = new ImprovedNoise();
function fbm(x, z, oct=5, lac=2.0, gain=0.5){
  let amp=1, freq=1, sum=0, norm=0;
  for (let i=0;i<oct;i++){
    sum += noise.noise(x*freq, z*freq, i*31.7) * amp;
    norm += amp; amp *= gain; freq *= lac;
  }
  return sum / norm;
}
function fbm3(x, y, z, oct=3){
  let amp=1, freq=1, sum=0, norm=0;
  for (let i=0;i<oct;i++){
    sum += noise.noise(x*freq, y*freq, z*freq + i*17.3) * amp;
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

// ============================================================================
//  SECTION: BIOMES + TERRAIN
// ============================================================================
const BIOMES = {
  verdant: { name:'Verdant Valley', soil:[0.10,0.28,0.22], sky:0x5c7fc2, grass:0x3f9c78, treeCol:0x1f6b5c, amb:0x9ccf8f },
  ashen:   { name:'Ashen Ridge',    soil:[0.20,0.16,0.14], sky:0x6a4a3a, grass:0x6b5340, treeCol:0x3c2a24, amb:0xcfa070 },
  frozen:  { name:'Frozen Hollow',  soil:[0.70,0.78,0.88], sky:0x8fb8e6, grass:0x9dc4d8, treeCol:0x6a92b0, amb:0xc0e0ff },
  ember:   { name:'Ember Marsh',    soil:[0.30,0.14,0.08], sky:0xaa4a2a, grass:0x8a3a22, treeCol:0x4a1e18, amb:0xff9a66 },
  crystal: { name:'Crystal Steppe', soil:[0.24,0.20,0.36], sky:0x6a5fae, grass:0x6d5fb0, treeCol:0x4a3a80, amb:0xb0a0ff }
};
const BIOME_KEYS = Object.keys(BIOMES);
function biomeAt(x, z){
  const n = fbm(x*0.006, z*0.006, 3);
  const idx = clamp(Math.floor((n + 1) * 0.5 * BIOME_KEYS.length), 0, BIOME_KEYS.length - 1);
  return BIOME_KEYS[idx];
}
const WORLD_R = TUNING.worldR;
const POND_X = 14, POND_Z = -2, POND_R = 12;
const inPond = (x,z,pad=0) => Math.abs(x-POND_X)<POND_R+pad && Math.abs(z-POND_Z)<POND_R+pad;
function th(x, z){
  let y = fbm(x*0.03, z*0.03, 5) * 4.2;
  y += fbm(x*0.09, z*0.09, 3) * 1.0;
  y += Math.sin(x*0.05)*Math.cos(z*0.05)*0.6;
  const d0 = Math.hypot(x,z);
  y *= clamp(d0/9, 0, 1);
  return y;
}

// ============================================================================
//  SECTION: RENDERER / SCENE / CAMERA
// ============================================================================
const canvas = $('game');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW, powerPreference:'high-performance', stencil:false, preserveDrawingBuffer:false });
} catch (e) {
  const notice = document.createElement('div');
  notice.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-content:center;padding:24px;background:#080914;color:#eef1ff;font:16px/1.6 system-ui;text-align:center';
  notice.innerHTML = '<h1>Game 3D tidak dapat dimulai</h1><p>Browser atau perangkat ini belum menyediakan WebGL. Coba buka dengan Chrome/Firefox terbaru dan aktifkan akselerasi hardware.</p>';
  document.body.appendChild(notice);
  return;
}
let currentPixelRatio = Q.pixelRatio;
renderer.setPixelRatio(currentPixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = Q.shadows && v4.shadowOn;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, innerWidth/innerHeight, 0.1, 500);
camera.position.set(0, 3, 7);

// ============================================================================
//  SECTION: GROUND (Genesis)
// ============================================================================
const SEG = Q.groundSeg;
const groundGeo = new THREE.PlaneGeometry(WORLD_R*2, WORLD_R*2, SEG, SEG);
groundGeo.rotateX(-Math.PI/2);
{
  const gpos = groundGeo.attributes.position;
  const gcol = new Float32Array(gpos.count*3);
  for (let i = 0; i < gpos.count; i++){
    const x = gpos.getX(i), z = gpos.getZ(i);
    const y = th(x, z);
    gpos.setY(i, y);
    const biome = BIOMES[biomeAt(x, z)];
    const t = clamp((y + 2)/4, 0, 1);
    let [r, g, b] = biome.soil;
    if (inPond(x,z)) { r = 0.06; g = 0.19; b = 0.34; }
    else { r += t*0.1; g += t*0.05; b += t*0.1; }
    gcol[i*3] = r; gcol[i*3+1] = g; gcol[i*3+2] = b;
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(gcol, 3));
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.95, side: THREE.FrontSide
}));
ground.receiveShadow = Q.shadows;
ground.name = 'groundGenesis';
scene.add(ground);

// ============================================================================
//  SECTION: WATER (Genesis)
// ============================================================================
let water = null;
if (Q.water){
  try {
    let minH = Infinity;
    for (let i = -POND_R; i <= POND_R; i += 2)
      for (let j = -POND_R; j <= POND_R; j += 2)
        minH = Math.min(minH, th(POND_X+i, POND_Z+j));
    const low = 32, hi = 128;
    const lc = document.createElement('canvas'); lc.width = lc.height = low;
    const lx = lc.getContext('2d');
    const img = lx.createImageData(low, low);
    for (let i = 0; i < low*low; i++){
      img.data[i*4] = 128 + (Math.random()-0.5)*78;
      img.data[i*4+1] = 128 + (Math.random()-0.5)*78;
      img.data[i*4+2] = 255; img.data[i*4+3] = 255;
    }
    lx.putImageData(img, 0, 0);
    const cc = document.createElement('canvas'); cc.width = cc.height = hi;
    const ctx = cc.getContext('2d'); ctx.drawImage(lc, 0, 0, hi, hi);
    const normTex = new THREE.CanvasTexture(cc);
    normTex.wrapS = normTex.wrapT = THREE.RepeatWrapping;
    water = new Water(new THREE.PlaneGeometry(POND_R*2, POND_R*2), {
      textureWidth: 256, textureHeight: 256, waterNormals: normTex,
      sunDirection: new THREE.Vector3(0.5, 1, 0.3).normalize(),
      sunColor: 0xd8dfff, waterColor: C.water, distortionScale: 2.4, alpha: 0.9, fog: true
    });
    water.rotation.x = -Math.PI/2;
    water.position.set(POND_X, minH+0.6, POND_Z);
    scene.add(water);
  } catch(e){ water = null; }
}

// ============================================================================
//  SECTION: SKY / LIGHTS
// ============================================================================
const skyColor = new THREE.Color(C.night);
scene.background = skyColor;
scene.fog = new THREE.FogExp2(C.night, LOW ? 0.009 : 0.012);
const ambient = new THREE.HemisphereLight(0x8fb4ff, 0x1e332c, 1.15);
scene.add(ambient);
const sunOffset = new THREE.Vector3(55, 75, 35);
const sun = new THREE.DirectionalLight(0xffeccd, 2.0);
sun.position.copy(sunOffset);
if (Q.shadows){
  sun.castShadow = true;
  sun.shadow.mapSize.set(LOW?1024:1536, LOW?1024:1536);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 180;
  sun.shadow.camera.left = -46; sun.shadow.camera.right = 46;
  sun.shadow.camera.top = 46; sun.shadow.camera.bottom = -46;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
}
scene.add(sun);
if (!LOW){
  const _pmrem = new THREE.PMREMGenerator(renderer);
  _pmrem.compileEquirectangularShader();
  try { scene.environment = _pmrem.fromScene(new RoomEnvironment()).texture; } catch(e){}
  try { scene.environmentIntensity = 0.65; } catch(e){}
  _pmrem.dispose();
} scene.add(sun.target);
const moon = new THREE.DirectionalLight(0x9db8ff, 0.3);
scene.add(moon);
const moonOffset = new THREE.Vector3(-50, 60, -40);
moon.position.copy(moonOffset);

const starGeo = new THREE.BufferGeometry();
const starPos = new Float32Array(700*3);
for (let i = 0; i < starPos.length; i++) starPos[i] = (Math.random()-0.5)*380;
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const starMat = new THREE.PointsMaterial({ color: 0xcfd9ff, size: 0.7, transparent: true, opacity: 0, depthWrite: false });
const stars = new THREE.Points(starGeo, starMat);
scene.add(stars);

// ============================================================================
//  SECTION: SHARED GEOMETRY (Genesis)
// ============================================================================
const trunkGeo = new THREE.CylinderGeometry(0.18, 0.34, 2.1, 9); trunkGeo.translate(0, 1.05, 0);
const crownA = new THREE.DodecahedronGeometry(1.35, 1); crownA.scale(1.1, 0.9, 1.1); crownA.translate(0, 2.45, 0);
const crownB = new THREE.DodecahedronGeometry(0.95, 1); crownB.translate(0.35, 2.95, -0.25);
const crownC = new THREE.DodecahedronGeometry(0.78, 1); crownC.scale(1.0, 0.9, 1.0); crownC.translate(-0.48, 2.58, 0.22);
const crownGeo = BufferGeometryUtils.mergeGeometries([crownA, crownB, crownC], false);
crownA.dispose(); crownB.dispose(); crownC.dispose();
const rockGeo = new THREE.DodecahedronGeometry(1, 1);
const flowerGeo = new THREE.ConeGeometry(0.07, 0.2, 5); flowerGeo.translate(0, 0.1, 0);
const bladeGeo = new THREE.PlaneGeometry(0.16, 0.65); bladeGeo.translate(0, 0.325, 0);
const pillarGeo = new THREE.CylinderGeometry(0.9, 1.1, 8, 10); pillarGeo.translate(0, 4, 0);

const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2a44, roughness: 0.95, side: THREE.FrontSide });
const leafMat  = new THREE.MeshStandardMaterial({ color: 0x1f6b5c, roughness: 0.85, side: THREE.FrontSide });
const rockMat  = new THREE.MeshStandardMaterial({ color: 0x6f7290, roughness: 0.97, flatShading: true, side: THREE.FrontSide });
const flowerMat= new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, side: THREE.FrontSide });
const pillarMat= new THREE.MeshStandardMaterial({ color: 0x6a6f8a, roughness: 0.9, flatShading: true, side: THREE.FrontSide });

const windUniform = { value: 0 };
const playerPosU = { value: new THREE.Vector3() };
const grassMat = new THREE.MeshStandardMaterial({ color: 0x3f9c78, roughness: 0.9, side: THREE.DoubleSide, emissive: 0x143f2e, emissiveIntensity: 0.45 });
grassMat.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = windUniform;
  shader.uniforms.uPlayerPos = playerPosU;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uPlayerPos;')
    .replace('#include <begin_vertex>', `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        float ix = instanceMatrix[3][0];
        float iz = instanceMatrix[3][2];
      #else
        float ix = 0.0; float iz = 0.0;
      #endif
      float sway = sin(uTime * 1.6 + ix * 0.45 + iz * 0.35) * 0.14;
      float h = max(0.0, position.y);
      transformed.x += sway * h;
      transformed.z += sway * 0.55 * h;
      float pd = distance(vec2(ix,iz), uPlayerPos.xz);
      float push = smoothstep(1.5, 0.3, pd);
      transformed.y -= push * h * 0.6;
    `);
};

// ============================================================================
//  SECTION: CHUNKS (Genesis) + LOD
// ============================================================================
const CHUNK_SIZE = TUNING.chunkSize;
const CHUNKS_PER_SIDE = Math.ceil((WORLD_R*2)/CHUNK_SIZE);
const chunkStore = new Map();
const chunkIdx = (v) => clamp(Math.floor((v + WORLD_R)/CHUNK_SIZE), 0, CHUNKS_PER_SIDE-1);
function getChunk(cx, cz){
  const k = cx + ':' + cz;
  let c = chunkStore.get(k);
  if (!c){
    c = {
      cx, cz, trunks:[], crowns:[], rocks:[], flowers:[], grass:[], pillars:[],
      group: new THREE.Group(),
      lodGroup: new THREE.Group(),  // LOD1 mesh (simplified)
      farGroup: new THREE.Group(),  // LOD2 (impostor)
      center: new THREE.Vector3(-WORLD_R + (cx+0.5)*CHUNK_SIZE, 2.5, -WORLD_R + (cz+0.5)*CHUNK_SIZE),
      radius: Math.hypot(CHUNK_SIZE*0.5, CHUNK_SIZE*0.5) + 7,
      visible: true, lod: 0, occludedUntil: 0
    };
    chunkStore.set(k, c);
  }
  return c;
}
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _s = new THREE.Vector3();

// Trees
for (let i = 0; i < Q.treeCount; i++){
  const x = (rnd()*2-1)*(WORLD_R-14);
  const z = (rnd()*2-1)*(WORLD_R-14);
  if (Math.hypot(x,z) < 6) continue;
  if (inPond(x,z,1.5)) continue;
  const sc = 0.85 + rnd()*0.5;
  _e.set(0, rnd()*Math.PI*2, 0); _q.setFromEuler(_e);
  _v.set(x, th(x,z), z); _s.set(sc, sc, sc);
  _m4.compose(_v, _q, _s);
  const ch = getChunk(chunkIdx(x), chunkIdx(z));
  ch.trunks.push(_m4.clone()); ch.crowns.push(_m4.clone());
}
// Rocks
const tmpColor = new THREE.Color();
for (let i = 0; i < Q.rockCount; i++){
  const x = (rnd()*2-1)*(WORLD_R-8), z = (rnd()*2-1)*(WORLD_R-8);
  if (Math.hypot(x,z) < 7 || inPond(x,z,0.5)) continue;
  const sc = 0.5 + rnd()*1.5;
  _e.set(rnd()*Math.PI, rnd()*Math.PI, rnd()*Math.PI); _q.setFromEuler(_e);
  _v.set(x, th(x,z) + sc*0.3, z); _s.set(sc, sc*0.8, sc);
  _m4.compose(_v, _q, _s);
  const ch = getChunk(chunkIdx(x), chunkIdx(z));
  ch.rocks.push({ m: _m4.clone(), c: 0.55 + rnd()*0.45 });
}
// Pillars
for (let i = 0; i < 14; i++){
  const x = (rnd()*2-1)*(WORLD_R-20), z = (rnd()*2-1)*(WORLD_R-20);
  if (Math.hypot(x,z) < 16 || inPond(x,z,2)) continue;
  const sc = 1 + rnd()*0.7;
  _e.set(0, rnd()*Math.PI*2, 0); _q.setFromEuler(_e);
  _v.set(x, th(x,z), z); _s.set(sc, sc, sc);
  _m4.compose(_v, _q, _s);
  const ch = getChunk(chunkIdx(x), chunkIdx(z));
  ch.pillars.push(_m4.clone());
}
// Flowers
for (let i = 0; i < Q.flowerCount; i++){
  const x = (rnd()*2-1)*(WORLD_R-18), z = (rnd()*2-1)*(WORLD_R-18);
  if (inPond(x,z,0.5)) continue;
  const sc = 0.7 + rnd()*0.8;
  _e.set(0, rnd()*Math.PI*2, 0); _q.setFromEuler(_e);
  _v.set(x, th(x,z), z); _s.set(sc, sc, sc);
  _m4.compose(_v, _q, _s);
  const ch = getChunk(chunkIdx(x), chunkIdx(z));
  ch.flowers.push({ m: _m4.clone(), t: rnd() < 0.5 ? 0 : 1 });
}
// Grass
const totalGrass = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE * Q.grassPerChunk;
for (let i = 0; i < totalGrass; i++){
  const x = (rnd()*2-1)*(WORLD_R-4), z = (rnd()*2-1)*(WORLD_R-4);
  if (Math.hypot(x,z) < 2.5 || inPond(x,z,1)) continue;
  const sc = 0.7 + rnd()*0.7;
  _e.set(0, rnd()*Math.PI*2, 0); _q.setFromEuler(_e);
  _v.set(x, th(x,z), z); _s.set(sc, 0.6 + rnd()*0.9, 1);
  _m4.compose(_v, _q, _s);
  const ch = getChunk(chunkIdx(x), chunkIdx(z));
  ch.grass.push(_m4.clone());
}
// Build meshes per chunk
chunkStore.forEach((c) => {
  if (c.trunks.length){
    const im = new THREE.InstancedMesh(trunkGeo, trunkMat, c.trunks.length);
    c.trunks.forEach((m,i) => im.setMatrixAt(i,m));
    im.instanceMatrix.needsUpdate = true; im.castShadow = Q.shadows;
    im.computeBoundingSphere(); c.group.add(im);
  }
  if (c.crowns.length){
    const im = new THREE.InstancedMesh(crownGeo, leafMat, c.crowns.length);
    c.crowns.forEach((m,i) => im.setMatrixAt(i,m));
    im.instanceMatrix.needsUpdate = true; im.castShadow = Q.shadows;
    im.computeBoundingSphere(); c.group.add(im);
  }
  if (c.rocks.length){
    const im = new THREE.InstancedMesh(rockGeo, rockMat, c.rocks.length);
    c.rocks.forEach((r,i) => { im.setMatrixAt(i,r.m); tmpColor.setHSL(0.62, 0.08, 0.30 + r.c*0.28); im.setColorAt(i, tmpColor); });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = Q.shadows; im.receiveShadow = Q.shadows;
    im.computeBoundingSphere(); c.group.add(im);
  }
  if (c.pillars.length){
    const im = new THREE.InstancedMesh(pillarGeo, pillarMat, c.pillars.length);
    c.pillars.forEach((m,i) => im.setMatrixAt(i,m));
    im.instanceMatrix.needsUpdate = true; im.castShadow = Q.shadows;
    im.computeBoundingSphere(); c.group.add(im);
  }
  if (c.flowers.length){
    const im = new THREE.InstancedMesh(flowerGeo, flowerMat, c.flowers.length);
    c.flowers.forEach((f,i) => {
      im.setMatrixAt(i,f.m);
      if (f.t === 0) tmpColor.setHex(0xc9a6ff); else tmpColor.setHex(0x9fe8d8);
      im.setColorAt(i, tmpColor);
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere(); c.group.add(im);
  }
  if (c.grass.length){
    const im = new THREE.InstancedMesh(bladeGeo, grassMat, c.grass.length);
    c.grass.forEach((m,i) => im.setMatrixAt(i,m));
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
    c.group.add(im);
  }
  c.group.matrixAutoUpdate = false; c.group.updateMatrix();
  c.group.name = 'chunk_' + c.cx + '_' + c.cz;
  scene.add(c.group);
});

// ============================================================================
//  SECTION: PORTAL (Genesis → Voxel)
// ============================================================================
const PX = -9, PZ = -12;
const PORTAL_NEED = 3;
const portal = new THREE.Group();
const portalRing = new THREE.Mesh(
  new THREE.TorusGeometry(1.9, 0.25, 12, 48),
  new THREE.MeshStandardMaterial({ color: C.violet, emissive: C.violet, emissiveIntensity: 0.5, metalness: 0.55, roughness: 0.25 })
);
portalRing.position.y = 1.6; portalRing.castShadow = Q.shadows; portal.add(portalRing);
const portalFill = new THREE.Mesh(
  new THREE.CircleGeometry(1.6, 40),
  new THREE.MeshStandardMaterial({ color: 0x1c2240, emissive: C.teal, emissiveIntensity: 0.9, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
);
portalFill.position.y = 1.6; portalFill.rotation.y = Math.PI/2; portal.add(portalFill);
// Desktop-only local light adds a real-time emissive glow; mobile keeps emissive materials only.
if (!LOW){ const portalLight = new THREE.PointLight(C.teal, 2.2, 18, 2); portalLight.position.set(0, 1.6, 0.6); portal.add(portalLight); }
const portalRayMat = new THREE.MeshBasicMaterial({ color: C.violet, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
const portalRay = new THREE.Mesh(new THREE.ConeGeometry(2.6, 26, 12, 1, true), portalRayMat);
portalRay.position.y = 13; portal.add(portalRay);
portal.position.set(PX, th(PX,PZ)+0.1, PZ);
scene.add(portal);

// Exit portal (in voxel)
const voxelPortal = new THREE.Group();
{
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.9, 0.25, 12, 48),
    new THREE.MeshStandardMaterial({ color: C.voxel, emissive: C.voxel, emissiveIntensity: 0.7, metalness: 0.55, roughness: 0.25 })
  );
  ring.position.y = 1.6; voxelPortal.add(ring);
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(1.6, 40),
    new THREE.MeshStandardMaterial({ color: 0x062018, emissive: C.voxel, emissiveIntensity: 1.0, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  );
  fill.position.y = 1.6; fill.rotation.y = Math.PI/2; voxelPortal.add(fill);
  if (!LOW){ const voxelLight = new THREE.PointLight(C.voxel, 2.4, 18, 2); voxelLight.position.set(0, 1.6, 0.6); voxelPortal.add(voxelLight); }
  voxelPortal.visible = false;
}
const voxelRayMat = new THREE.MeshBasicMaterial({ color: C.voxel, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
const voxelRay = new THREE.Mesh(new THREE.ConeGeometry(2.6, 26, 12, 1, true), voxelRayMat);
voxelRay.position.y = 13; voxelPortal.add(voxelRay);
scene.add(voxelPortal);

// ============================================================================
//  SECTION: WOW FX (sun disc, dust motes, beam pulses)
// ============================================================================
const _sunDir = new THREE.Vector3();
const DUST_N = LOW ? 70 : 140;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_N * 3);
const dustSeed = new Float32Array(DUST_N * 2);
for (let i = 0; i < DUST_N; i++){
  dustPos[i*3] = (rnd()*2-1)*35; dustPos[i*3+1] = rnd()*10+0.5; dustPos[i*3+2] = (rnd()*2-1)*35;
  dustSeed[i*2] = rnd()*Math.PI*2; dustSeed[i*2+1] = 0.3+rnd()*0.7;
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dustMat = new THREE.PointsMaterial({ color: 0x9fe8d8, size: 0.28, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
const dust = new THREE.Points(dustGeo, dustMat); dust.frustumCulled = false; scene.add(dust);
function makeGlowTexture(inner, outer){
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g2 = cv.getContext('2d');
  const grd = g2.createRadialGradient(64,64,4,64,64,64);
  grd.addColorStop(0, inner); grd.addColorStop(0.35, outer); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g2.fillStyle = grd; g2.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(cv);
}
const sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture('rgba(255,244,214,1)','rgba(255,180,90,0.55)'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
sunSpr.scale.setScalar(46); scene.add(sunSpr);
function updateWowFX(nowMs, dt){
  const px = playerGroup.position.x, pz = playerGroup.position.z;
  const arr = dustGeo.attributes.position.array;
  for (let i = 0; i < DUST_N; i++){
    const s1 = dustSeed[i*2];
    arr[i*3] += Math.sin(nowMs*0.0004 + s1) * dt * 0.6;
    arr[i*3+1] += Math.cos(nowMs*0.0005 + s1*1.7) * dt * 0.35;
    if (arr[i*3] - px > 35) arr[i*3] -= 70; else if (arr[i*3] - px < -35) arr[i*3] += 70;
    if (arr[i*3+2] - pz > 35) arr[i*3+2] -= 70; else if (arr[i*3+2] - pz < -35) arr[i*3+2] += 70;
    if (arr[i*3+1] < 0.2) arr[i*3+1] = 10; else if (arr[i*3+1] > 12) arr[i*3+1] = 0.5;
  }
  dustGeo.attributes.position.needsUpdate = true;
  dustMat.color.setHex(state.world.dimension === 'voxel' ? 0x8fff9e : 0x9fe8d8);
  const dayness = (Math.sin(state.day * Math.PI * 2) + 1) / 2;
  _sunDir.copy(sunOffset).normalize();
  sunSpr.position.set(px + _sunDir.x*220, _sunDir.y*220, pz + _sunDir.z*220);
  sunSpr.material.opacity = clamp(dayness*1.4-0.15, 0, 1);
  beamMat.opacity = 0.12 + Math.sin(nowMs*0.0022)*0.05;
  portalRayMat.opacity = (portalActive ? 0.16 : 0.08) + Math.sin(nowMs*0.003)*0.03;
  portalRay.rotation.y += dt * 0.5;
}

// ============================================================================
//  SECTION: PICKUPS (Genesis)
// ============================================================================
const HEALS = [];
const healGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
const healMat = new THREE.MeshStandardMaterial({ color: C.violet, emissive: C.violet, emissiveIntensity: 0.7, metalness: 0.3, roughness: 0.45 });
for (let i = 0; i < 8; i++){
  const x = (rnd()*2-1)*50, z = (rnd()*2-1)*50;
  if (Math.hypot(x-PX, z-PZ) < 8) continue;
  const cube = new THREE.Mesh(healGeo, healMat);
  cube.position.set(x, th(x,z)+0.75, z); cube.castShadow = Q.shadows;
  scene.add(cube);
  HEALS.push({ x, z, mesh: cube, got: false });
}
const TOTAL_C = TUNING.crystalCount;
const CRYSTALS = [];
const coreGeo = new THREE.OctahedronGeometry(0.48, 0);
const coreMat = new THREE.MeshStandardMaterial({ color: C.teal, emissive: C.teal, emissiveIntensity: 1.4, metalness: 0.5, roughness: 0.2 });
const auraGeo = new THREE.SphereGeometry(0.85, 12, 12);
const auraMat = new THREE.MeshStandardMaterial({ color: C.teal, transparent: true, opacity: 0.12, emissive: C.teal, emissiveIntensity: 0.7, depthWrite: false });
const rimGeo = new THREE.RingGeometry(0.75, 0.9, 24);
const rimMat = new THREE.MeshStandardMaterial({ color: C.sky, emissive: C.sky, emissiveIntensity: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false });
const beamGeo = new THREE.CylinderGeometry(0.32, 0.85, 30, 8, 1, true);
const beamMat = new THREE.MeshBasicMaterial({ color: C.teal, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
function makeCrystal(x, z){
  const g = new THREE.Group();
  g.add(new THREE.Mesh(coreGeo, coreMat));
  g.add(new THREE.Mesh(auraGeo, auraMat));
  const rim = new THREE.Mesh(rimGeo, rimMat); rim.rotation.x = Math.PI/2; g.add(rim);
  const beam = new THREE.Mesh(beamGeo, beamMat); beam.position.y = 14; g.add(beam);
  g.position.set(x, th(x,z)+1.2, z);
  scene.add(g);
  return { x, z, mesh: g, got: false };
}
let attempts = 0;
while (CRYSTALS.length < TOTAL_C && attempts < 200){
  attempts++;
  const x = (rnd()*2-1)*62, z = (rnd()*2-1)*62;
  if (Math.hypot(x,z) < 7 || Math.hypot(x-PX, z-PZ) < 8) continue;
  CRYSTALS.push(makeCrystal(x, z));
}

// ============================================================================
//  SECTION: BENCHES / NPC
// ============================================================================
const BENCHES = [
  { x: 8, z: 8 }, { x: -20, z: 12 }, { x: 4, z: -22 }
].map(b => {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.15, 1.0),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 }));
  top.position.y = 0.9; g.add(top);
  for (const [sx, sz] of [[-0.7,-0.4],[0.7,-0.4],[-0.7,0.4],[0.7,0.4]]){
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.9 }));
    leg.position.set(sx, 0.45, sz); g.add(leg);
  }
  g.position.set(b.x, th(b.x,b.z), b.z);
  scene.add(g);
  return { x: b.x, z: b.z, mesh: g };
});
const NPCS = [];
const npcColors = {
  trader:  { body: 0xfcd34d, head: 0xffd6b0, name: 'Pedagang' },
  elder:   { body: 0xa78bfa, head: 0xffd6b0, name: 'Kepala Desa' },
  mage:    { body: 0x5eead4, head: 0xffd6b0, name: 'Penyihir Tua' }
};
function makeNPC(kind, x, z){
  const cfg = npcColors[kind];
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 4, 8),
    new THREE.MeshStandardMaterial({ color: cfg.body, roughness: 0.7 }));
  body.position.y = 0.85; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 12),
    new THREE.MeshStandardMaterial({ color: cfg.head, roughness: 0.75 }));
  head.position.y = 1.72; g.add(head);
  g.position.set(x, th(x,z), z);
  scene.add(g);
  return { kind, x, z, mesh: g, name: cfg.name, talked: false };
}
NPCS.push(makeNPC('trader', 12, 4));
NPCS.push(makeNPC('elder', -14, 8));
NPCS.push(makeNPC('mage', -6, -18));

// ============================================================================
//  SECTION: ENEMY SPECS (Genesis)
// ============================================================================
const MOBS = [];
// Shared low-poly building blocks; baked archetypes keep each creature to a small number of draw calls.
const mobBodyGeo = new THREE.CapsuleGeometry(0.38, 0.82, 4, LOW ? 8 : 14);
const mobLegGeo = new THREE.CapsuleGeometry(0.13, 0.48, 3, LOW ? 6 : 10);
const mobArmGeo = new THREE.CapsuleGeometry(0.11, 0.42, 3, LOW ? 6 : 10);
const mobSkullGeo = new THREE.DodecahedronGeometry(0.31, 0);
const mobArmorGeo = new THREE.DodecahedronGeometry(0.23, 0);
const mobEyeGeo = new THREE.SphereGeometry(1, LOW ? 8 : 12, LOW ? 6 : 8);
const mobHornGeo = new THREE.ConeGeometry(0.11, 0.48, LOW ? 5 : 8);
const mobFangGeo = new THREE.ConeGeometry(0.055, 0.19, 5);
const mobRibGeo = new THREE.BoxGeometry(1, 1, 1);
const mobVeilGeo = new THREE.ConeGeometry(0.58, 1.55, LOW ? 7 : 11, 1, true);
const projGeo = new THREE.SphereGeometry(0.16, 8, 6);
const mobModelCache = new Map();
function bakeMobGeometry(parts){
  const baked = [];
  for (const part of parts){
    let geo = part.geo.clone();
    // Polyhedron and box primitives can differ in indexed state; normalize before merging.
    if (geo.index){
      const nonIndexed = geo.toNonIndexed();
      geo.dispose();
      geo = nonIndexed;
    }
    const pos = new THREE.Vector3(...(part.pos || [0,0,0]));
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(part.rot || [0,0,0])));
    const scale = new THREE.Vector3(...(part.scale || [1,1,1]));
    geo.applyMatrix4(new THREE.Matrix4().compose(pos, rot, scale));
    baked.push(geo);
  }
  const merged = BufferGeometryUtils.mergeGeometries(baked, false);
  baked.forEach(geo => geo.dispose());
  if (!merged) throw new Error('Monster geometry merge failed');
  merged.computeVertexNormals();
  return merged;
}
function getMobArchetype(kind){
  if (mobModelCache.has(kind)) return mobModelCache.get(kind);
  const profiles = {
    somber:   { torso:[0.82,1.00,0.76], head:0.92, shoulder:0.9, horns:0.8, eyes:2, legs:true, veil:false, ribs:1.0 },
    brute:    { torso:[1.28,1.12,1.02], head:1.12, shoulder:1.3, horns:1.4, eyes:2, legs:true, veil:false, ribs:1.2 },
    wisp:     { torso:[0.72,1.08,0.70], head:0.92, shoulder:0.8, horns:0.35, eyes:3, legs:false, veil:true, ribs:0.7 },
    golem:    { torso:[1.42,1.26,1.22], head:1.12, shoulder:1.45, horns:1.25, eyes:3, legs:true, veil:false, ribs:1.35 },
    ranger:   { torso:[0.86,1.04,0.78], head:0.92, shoulder:0.92, horns:0.65, eyes:2, legs:true, veil:true, ribs:0.9 },
    shaman:   { torso:[0.90,1.05,0.82], head:1.00, shoulder:1.05, horns:1.15, eyes:3, legs:true, veil:true, ribs:1.0 },
    assassin: { torso:[0.78,1.12,0.72], head:0.86, shoulder:0.78, horns:0.55, eyes:2, legs:true, veil:true, ribs:0.85 },
    echo:     { torso:[0.84,1.14,0.78], head:0.94, shoulder:0.9, horns:0.9, eyes:3, legs:false, veil:true, ribs:0.8 }
  };
  const profile = profiles[kind] || profiles.somber;
  const bodyParts = [
    { geo:mobBodyGeo, pos:[0,1.12,0], scale:profile.torso }
  ];
  if (profile.legs){
    bodyParts.push(
      { geo:mobLegGeo, pos:[-0.18,0.39,0], rot:[0.04,0,0.04], scale:[1,1,1] },
      { geo:mobLegGeo, pos:[ 0.18,0.39,0], rot:[-0.04,0,-0.04], scale:[1,1,1] }
    );
  } else {
    bodyParts.push({ geo:mobVeilGeo, pos:[0,0.73,-0.02], scale:[1.0,0.88,0.85] });
  }
  const body = bakeMobGeometry(bodyParts);
  const faceParts = [
    { geo:mobSkullGeo, pos:[0,0,0], scale:[profile.head*0.95,profile.head*1.14,profile.head*0.88] },
    { geo:mobRibGeo, pos:[0,-0.24,0.16], scale:[0.34*profile.head,0.15*profile.head,0.23*profile.head] },
    { geo:mobRibGeo, pos:[0,-0.30,0.205], scale:[0.25*profile.head,0.035*profile.head,0.035*profile.head] }
  ];
  for (let side of [-1,1]){
    faceParts.push({ geo:mobHornGeo, pos:[side*0.20*profile.head,0.22*profile.head,-0.015], rot:[0,0,side*-0.34], scale:[profile.horns,profile.horns,profile.horns] });
  }
  const face = bakeMobGeometry(faceParts);
  const armorParts = [];
  for (const y of [1.34,1.15,0.96]){
    const width = (0.46 - (1.34-y)*0.28) * profile.ribs;
    armorParts.push({ geo:mobRibGeo, pos:[0,y,0.44*profile.torso[2]], rot:[0,0,0], scale:[width,0.064,0.06] });
  }
  armorParts.push({ geo:mobRibGeo, pos:[0,1.14,0.47*profile.torso[2]], scale:[0.075,0.34,0.06] });
  for (const side of [-1,0,1]){
    armorParts.push({ geo:mobFangGeo, pos:[side*0.075,1.80,0.29], rot:[0,0,Math.PI], scale:[0.8,1.15,0.8] });
  }
  for (const side of [-1,1]){
    armorParts.push({ geo:mobArmorGeo, pos:[side*0.46*profile.shoulder,1.48,0.02], scale:[0.31*profile.shoulder,0.25*profile.shoulder,0.27*profile.shoulder] });
    armorParts.push({ geo:mobHornGeo, pos:[side*0.50*profile.shoulder,1.56,-0.22], rot:[-Math.PI/2,0,side*0.22], scale:[0.72,0.76,0.72] });
  }
  for (let i=0;i<3;i++){
    armorParts.push({ geo:mobHornGeo, pos:[(i-1)*0.18,1.35,-0.30], rot:[-Math.PI/2,0,(i-1)*0.12], scale:[0.72-i*0.08,0.9,0.72-i*0.08] });
  }
  const armor = bakeMobGeometry(armorParts);
  const armParts = [
    { geo:mobArmGeo, pos:[0,-0.25,0], scale:[1,1.05,1] },
    { geo:mobArmGeo, pos:[0,-0.72,0.035], rot:[-0.08,0,0], scale:[0.92,0.88,0.92] },
    { geo:mobFangGeo, pos:[-0.09,-1.04,0.09], rot:[0,0,Math.PI], scale:[1.0,1.3,1.0] },
    { geo:mobFangGeo, pos:[0,-1.06,0.12], rot:[0,0,Math.PI], scale:[1.0,1.5,1.0] },
    { geo:mobFangGeo, pos:[0.09,-1.04,0.09], rot:[0,0,Math.PI], scale:[1.0,1.3,1.0] }
  ];
  const arm = bakeMobGeometry(armParts);
  const eyes = [];
  const eyePositions = profile.eyes === 3 ? [[-0.12,0.03,0.265],[0.12,0.03,0.265],[0,0.17,0.255]] : [[-0.12,0.03,0.265],[0.12,0.03,0.265]];
  for (const [x,y,z] of eyePositions){
    eyes.push({ geo:mobEyeGeo, pos:[x*profile.head,y*profile.head,z*profile.head], scale:[0.082*profile.head,0.044*profile.head,0.035*profile.head] });
  }
  const glow = bakeMobGeometry(eyes);
  const model = { profile, body, face, armor, arm, glow, veil: profile.veil ? bakeMobGeometry([{ geo:mobVeilGeo, pos:[0,0.86,-0.13], rot:[0,0,0], scale:[1.1,1.0,0.9] }]) : null };
  mobModelCache.set(kind, model);
  return model;
}
const ENEMY_SPECS = {
  somber:  { hp:3,  speed:1.6, chase:3.4, dmg:1, range:1.4, sense:12, color:0x2a1a4e, emissive:0xe879f9, scale:1,    xp:12, mass:1 },
  brute:   { hp:6,  speed:1.2, chase:2.8, dmg:2, range:1.7, sense:14, color:0x1e1440, emissive:0xa78bfa, scale:1.45, xp:25, mass:2 },
  wisp:    { hp:2,  speed:2.8, chase:5.0, dmg:1, range:1.2, sense:16, color:0x0c1a30, emissive:0x5eead4, scale:0.7,  xp:15, mass:0.5, flying:true },
  golem:   { hp:12, speed:0.8, chase:2.0, dmg:3, range:2.2, sense:13, color:0x353a4e, emissive:0x93c5fd, scale:2.0,  xp:45, mass:4, aoe:true },
  ranger:  { hp:4,  speed:2.0, chase:3.6, dmg:2, range:11,  sense:18, color:0x2a1e10, emissive:0xfcd34d, scale:1.1,  xp:22, mass:1, ranged:true },
  shaman:  { hp:5,  speed:1.4, chase:3.0, dmg:1, range:2.0, sense:14, color:0x1a3020, emissive:0x5eead4, scale:1.2,  xp:35, mass:1, healer:true },
  assassin:{ hp:4,  speed:2.4, chase:5.5, dmg:3, range:1.5, sense:16, color:0x100a1e, emissive:0xfb923c, scale:1.15, xp:40, mass:1, teleport:true },
  echo:    { hp:5,  speed:3.0, chase:6.0, dmg:2, range:1.6, sense:99, color:0x2a0a3e, emissive:0xc026d3, scale:1.05, xp:50, mass:1, echo:true }
};

// ============================================================================
//  SECTION: VOXEL SPECS (v4.0)
// ============================================================================
const VOXEL_SPECS = {
  vcreeper:  { hp:4,  speed:1.4, chase:3.0, dmg:4, range:2.8, sense:14, color:0x40c97a, emissive:0x1a4a2a, scale:1.0, xp:30, creeper:true },
  vzombie:   { hp:4,  speed:1.0, chase:2.4, dmg:1, range:1.4, sense:12, color:0x4a6a8a, emissive:0x1a2a3a, scale:1.05, xp:15 },
  vskeleton: { hp:3,  speed:1.4, chase:2.6, dmg:2, range:12, sense:20, color:0xdedede, emissive:0x222222, scale:1.0, xp:25, ranged:true },
  venderman: { hp:6,  speed:2.2, chase:5.0, dmg:3, range:1.6, sense:24, color:0x2a1a3a, emissive:0xa060d0, scale:1.15, xp:45, teleport:true, enderman:true },
  vgolem:    { hp:40, speed:0.9, chase:2.2, dmg:5, range:2.8, sense:20, color:0x8a8a7a, emissive:0x5a5a3a, scale:2.2, xp:120, miniBoss:true, aoe:true }
};

// ============================================================================
//  SECTION: MOB FACTORY (Genesis)
// ============================================================================
// ============================================================
//  SECTION: ANIME MONSTER MODULE (MonsterFactory v1.0)
// ============================================================
/* ============================================================
   MONSTER FACTORY v1.0 — Anime Toon Monsters
   ------------------------------------------------------------
   12 monster siap pakai. Toon-shaded, multi-bone rig, animasi
   unik per spesies, glow eyes anime, flash hit, windup attack.

   PAKAI:
     const mon = MonsterFactory.create(THREE, 'somber', {
       quality: LOW ? 'low' : 'high',
       bodyColor: 0x2a1a4e,
       eyeColor:  0xff3cf0
     });
     scene.add(mon.root);
     mon.root.position.set(x, y, z);

     // Tiap frame:
     mon.update(dt, {
       mode: 'patrol'|'chase'|'attack'|'hurt'|'dead',
       speed: 3.2, dP: 5.0, t: performance.now()
     });

     mon.setFlash(0.5);     // hit-flash putih
     mon.play('windup');    // trigger attack windup
     mon.play('attack');    // strike
     mon.dispose();
   ============================================================ */
const MonsterFactory = (function () {
  'use strict';

  const clamp = (v,a,b) => v<a?a:(v>b?b:v);
  const lerp  = (a,b,t) => a+(b-a)*t;
  const ease  = u => u*u*(3-2*u);

  // ---------- Toon gradient (shared) ----------
  let _grad = null;
  function gradient(THREE){
    if (_grad) return _grad;
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 1;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgb(48,48,58)';   g.fillRect(0,0,1,1);
    g.fillStyle = 'rgb(112,112,128)';g.fillRect(1,0,1,1);
    g.fillStyle = 'rgb(186,186,200)';g.fillRect(2,0,1,1);
    g.fillStyle = 'rgb(255,255,255)';g.fillRect(3,0,1,1);
    const t = new THREE.CanvasTexture(cv);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    _grad = t;
    return t;
  }

  // ---------- Scene helpers ----------
  function grp(THREE, parent, x, y, z){
    const g = new THREE.Group();
    g.position.set(x||0, y||0, z||0);
    if (parent) parent.add(g);
    return g;
  }
  function mk(THREE, geo, mat, parent, x, y, z, sx, sy, sz){
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x||0, y||0, z||0);
    if (sx !== undefined) m.scale.set(sx, sy===undefined?sx:sy, sz===undefined?sx:sz);
    m.castShadow = true;
    m.receiveShadow = false;
    if (parent) parent.add(m);
    return m;
  }
  function sock(parent, x, y, z){
    const o = new THREE.Object3D();
    o.position.set(x||0, y||0, z||0);
    parent.add(o);
    return o;
  }

  // ---------- Geo cache (per instance, so disposal is clean) ----------
  function makeGeoCache(THREE, LOW){
    const D = LOW ? 1 : 2;
    return {
      box:      new THREE.BoxGeometry(1,1,1),
      sphere:   new THREE.SphereGeometry(1, 8*D, 6*D),
      sphereLo: new THREE.SphereGeometry(1, 6, 4),
      cyl:      new THREE.CylinderGeometry(1,1,1, 6*D),
      cone:     new THREE.ConeGeometry(1,1, 5*D),
      capsule:  new THREE.CapsuleGeometry(1, 1, 4, 5*D),
      torus:    new THREE.TorusGeometry(1, 0.15, 6, 14),
      torusT:   new THREE.TorusGeometry(1, 0.07, 5, 12),
      plane:    new THREE.PlaneGeometry(1,1),
      octa:     new THREE.OctahedronGeometry(1, 0),
      dodec:    new THREE.DodecahedronGeometry(1, 0),
      dodecHi:  new THREE.DodecahedronGeometry(1, 1)
    };
  }

  // ---------- Materials ----------
  function buildMats(THREE, cfg){
    const grad = gradient(THREE);
    const toon = (col, em, emI, opts) => {
      opts = opts || {};
      const m = new THREE.MeshToonMaterial({
        color: col, gradientMap: grad,
        emissive: em || 0x000000,
        emissiveIntensity: emI || 0,
        side: opts.side || THREE.FrontSide,
        transparent: !!opts.transparent,
        opacity: opts.opacity !== undefined ? opts.opacity : 1
      });
      return m;
    };
    const basic = (col, opts) => {
      opts = opts || {};
      return new THREE.MeshBasicMaterial({
        color: col, toneMapped: false,
        transparent: !!opts.transparent,
        opacity: opts.opacity !== undefined ? opts.opacity : 1
      });
    };
    return {
      body:    toon(cfg.body   || 0x2a1a4e, cfg.emissive || 0x000000, 0.10),
      accent:  toon(cfg.accent || 0x8b4bc7, cfg.accent, 0.18),
      dark:    toon(cfg.dark   || 0x0a0618),
      bone:    toon(cfg.bone   || 0xd8d0c4),
      cloth:   toon(cfg.cloth  || 0x1a0a30, 0x000000, 0, { side: THREE.DoubleSide }),
      eyeW:    basic(0xfbfbff),
      iris:    basic(cfg.eye    || 0xff3cf0),
      pupil:   basic(0x0a0a14),
      hl:      basic(0xffffff),
      glow:    basic(cfg.glow   || cfg.eye || 0xffffff),
      glowToon:toon(cfg.glow || cfg.eye || 0xffffff, cfg.glow || cfg.eye, 1.2),
      // weapons
      blade:   toon(0xe6f2ff, 0x3a80ff, 0.35),
      metal:   toon(0x808898, 0x222a40, 0.15),
      toon, basic
    };
  }

  // ---------- Reusable sub-parts ----------
  function buildEye(THREE, G, M, size){
    const e = new THREE.Group();
    mk(THREE, G.sphere, M.eyeW,  e, 0, 0, 0,            size*0.90, size*1.15, size*0.35);
    mk(THREE, G.sphere, M.iris,  e, 0, -0.02*size, size*0.28, size*0.62, size*0.80, size*0.25);
    mk(THREE, G.sphere, M.pupil, e, 0, -0.02*size, size*0.38, size*0.30, size*0.45, size*0.15);
    mk(THREE, G.sphere, M.hl,    e, -0.18*size,  0.25*size, size*0.44, size*0.22, size*0.26, size*0.12);
    mk(THREE, G.sphere, M.hl,    e,  0.22*size, -0.30*size, size*0.44, size*0.12, size*0.14, size*0.10);
    return e;
  }

  function buildClaw(THREE, G, mat, side){
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++){
      const c = mk(THREE, G.cone, mat, g,
        side*(i-1)*0.045, -0.10, 0.02,
        0.026, 0.09 - i*0.008, 0.026);
      c.rotation.x = -0.35;
      c.rotation.z = side*(i-1)*0.20;
    }
    return g;
  }

  function buildHorn(THREE, G, mat, side, style){
    const g = new THREE.Group();
    if (style === 'curved'){
      const s1 = mk(THREE, G.cone, mat, g, 0, 0.06, 0, 0.038, 0.14, 0.038);
      s1.rotation.z = side * -0.35;
      const s2 = mk(THREE, G.cone, mat, g, side*0.06, 0.20, -0.02, 0.028, 0.16, 0.028);
      s2.rotation.z = side * -0.78;
      s2.rotation.x = -0.2;
      const s3 = mk(THREE, G.cone, mat, g, side*0.12, 0.34, -0.05, 0.018, 0.14, 0.018);
      s3.rotation.z = side * -1.15;
      s3.rotation.x = -0.4;
    } else if (style === 'straight'){
      mk(THREE, G.cone, mat, g, 0, 0.10, 0, 0.032, 0.22, 0.032);
    } else if (style === 'crown'){
      for (let i = 0; i < 5; i++){
        const h = mk(THREE, G.cone, mat, g, (i-2)*0.09, 0.10 + (i===0||i===4?0:0.04), 0, 0.022, 0.10, 0.022);
      }
    }
    return g;
  }

  function buildLeg(THREE, G, M, parent, side, cfg){
    const hip = grp(THREE, parent, side*cfg.spread, cfg.y||0, 0);
    mk(THREE, G.capsule, M.body, hip, 0, -cfg.thigh/2, 0, cfg.w, cfg.thigh/2, cfg.w);
    const knee = grp(THREE, hip, 0, -cfg.thigh, 0);
    mk(THREE, G.capsule, M.body, knee, 0, -cfg.shin/2, 0, cfg.w*0.85, cfg.shin/2, cfg.w*0.85);
    const foot = grp(THREE, knee, 0, -cfg.shin, 0);
    mk(THREE, G.box, M.dark, foot, 0, -0.04, 0.06, cfg.w*2, 0.10, cfg.footLen || 0.24);
    return { hip, knee, foot };
  }

  function buildArm(THREE, G, M, parent, side, cfg){
    const sh = grp(THREE, parent, side*cfg.spread, cfg.y||0, 0);
    mk(THREE, G.capsule, M.body, sh, 0, -cfg.upper/2, 0, cfg.w, cfg.upper/2, cfg.w);
    const el = grp(THREE, sh, 0, -cfg.upper, 0);
    mk(THREE, G.capsule, M.body, el, 0, -cfg.lower/2, 0, cfg.w*0.9, cfg.lower/2, cfg.w*0.9);
    const hand = grp(THREE, el, 0, -cfg.lower, 0);
    mk(THREE, G.box, M.body, hand, 0, -0.02, 0, cfg.w*2, 0.09, 0.06);
    let claw = null;
    if (cfg.claws){
      claw = buildClaw(THREE, G, M.bone, side);
      claw.position.set(0, -0.06, 0.02);
      hand.add(claw);
    }
    return { shoulder: sh, elbow: el, hand, claw };
  }

  function buildVeil(THREE, G, M, parent, len, w){
    const root = grp(THREE, parent);
    const segs = [];
    let p = root;
    for (let i = 0; i < len; i++){
      const s = grp(THREE, p, 0, i===0?0:-0.20, 0);
      mk(THREE, G.plane, M.cloth, s, 0, -0.10, 0, w - i*0.04, 0.22, 1);
      segs.push(s);
      p = s;
    }
    return { root, segs };
  }

  // ============================================================
  //  MONSTER CONFIGS
  // ============================================================
  const CONFIGS = {
    // ---- SOMBER: shadowy hunter, 3 eyes, curved horns, veil
    somber: {
      colors: { body:0x2a1a4e, accent:0x6a2a9e, emissive:0x5a2a9e, eye:0xff3cf0, glow:0xff6cf0, cloth:0x1a0a30, dark:0x0a0518 },
      rig:    { pelvisY:0.95, torsoW:0.32, torsoH:0.22, chestW:0.38, chestH:0.32, headSize:0.22, headH:0.26 },
      legs:   { y:-0.05, spread:0.11, thigh:0.48, shin:0.52, w:0.075, footLen:0.24 },
      arms:   { y:0.16, spread:0.24, upper:0.34, lower:0.32, w:0.07, claws:true },
      head:   'skull',
      horns:  'curved',
      eyes:   3,
      eyeSize:0.075,
      veil:   { len:4, w:0.50 },
      floating: false,
      attackKind: 'melee'
    },

    // ---- BRUTE: 4-armed armored titan
    brute: {
      colors: { body:0x1e1440, accent:0x4a2a8e, emissive:0x3a1a6e, eye:0xa78bfa, glow:0xb8a0ff, bone:0xb09a8c, dark:0x0a0518 },
      rig:    { pelvisY:1.05, torsoW:0.46, torsoH:0.32, chestW:0.60, chestH:0.48, headSize:0.26, headH:0.30 },
      legs:   { y:-0.08, spread:0.16, thigh:0.52, shin:0.55, w:0.13, footLen:0.32 },
      arms:   { y:0.20, spread:0.34, upper:0.40, lower:0.36, w:0.11, claws:true },
      arms2:  { y:0.02, spread:0.28, upper:0.32, lower:0.28, w:0.09, claws:true, tucked:true },
      head:   'dodec',
      horns:  'straight',
      eyes:   2,
      eyeSize:0.065,
      spikes: true,
      floating: false,
      attackKind: 'melee'
    },

    // ---- WISP: floating wraith, no legs, tendrils
    wisp: {
      colors: { body:0x0c1a30, accent:0x1a3050, emissive:0x0a2a4a, eye:0x5eead4, glow:0x9ffff0, cloth:0x061828, dark:0x020810 },
      rig:    { pelvisY:1.05, torsoW:0.22, torsoH:0.20, chestW:0.28, chestH:0.26, headSize:0.20, headH:0.24 },
      legs:   null,
      arms:   { y:0.16, spread:0.20, upper:0.28, lower:0.24, w:0.055, claws:false },
      head:   'skull',
      horns:  'none',
      eyes:   3,
      eyeSize:0.065,
      tendrils: 6,
      veil:   { len:5, w:0.46 },
      floating: true,
      floatAmp: 0.32,
      attackKind: 'melee'
    },

    // ---- GOLEM: massive stone titan
    golem: {
      colors: { body:0x353a4e, accent:0x6a7088, emissive:0x1a1e2e, eye:0x93c5fd, glow:0xd0e6ff, bone:0x9aa0b0, dark:0x181c28 },
      rig:    { pelvisY:1.20, torsoW:0.60, torsoH:0.40, chestW:0.88, chestH:0.62, headSize:0.28, headH:0.32 },
      legs:   { y:-0.12, spread:0.24, thigh:0.60, shin:0.62, w:0.18, footLen:0.40 },
      arms:   { y:0.28, spread:0.48, upper:0.50, lower:0.46, w:0.17, claws:false },
      head:   'dodec',
      horns:  'none',
      eyes:   2,
      eyeSize:0.055,
      cracks: true,
      rockChunks: true,
      floating: false,
      attackKind: 'melee'
    },

    // ---- ASSASSIN: lean dual-blade
    assassin: {
      colors: { body:0x100a1e, accent:0x2a1a3a, emissive:0x1a0a2a, eye:0xfb923c, glow:0xffb86c, cloth:0x0a0518, dark:0x030208 },
      rig:    { pelvisY:0.98, torsoW:0.28, torsoH:0.20, chestW:0.34, chestH:0.30, headSize:0.20, headH:0.26 },
      legs:   { y:-0.05, spread:0.10, thigh:0.50, shin:0.52, w:0.07, footLen:0.22 },
      arms:   { y:0.16, spread:0.22, upper:0.34, lower:0.32, w:0.06, claws:false },
      head:   'skull',
      horns:  'none',
      eyes:   2,
      eyeSize:0.070,
      hood: true,
      dualBlades: true,
      scarf: true,
      floating: false,
      attackKind: 'melee'
    },

    // ---- ECHO: glitch mirror, semi-transparent
    echo: {
      colors: { body:0x2a0a3e, accent:0x6a1a7e, emissive:0x4a0a5e, eye:0xff6cff, glow:0xff9cff, cloth:0x1a0224, dark:0x0a0018 },
      rig:    { pelvisY:0.95, torsoW:0.34, torsoH:0.22, chestW:0.40, chestH:0.32, headSize:0.22, headH:0.26 },
      legs:   null,
      arms:   { y:0.16, spread:0.24, upper:0.34, lower:0.32, w:0.07, claws:true },
      head:   'skull',
      horns:  'curved',
      eyes:   3,
      eyeSize:0.075,
      veil:   { len:4, w:0.50 },
      glitch: true,
      floating: true,
      floatAmp: 0.22,
      attackKind: 'melee'
    },

    // ---- RANGER: hooded archer
    ranger: {
      colors: { body:0x2a1e10, accent:0x5a3a1a, emissive:0x3a2a10, eye:0xfcd34d, glow:0xffe28c, bone:0xd0c0a0, cloth:0x1a1208, dark:0x0a0804 },
      rig:    { pelvisY:0.98, torsoW:0.30, torsoH:0.22, chestW:0.36, chestH:0.32, headSize:0.22, headH:0.26 },
      legs:   { y:-0.05, spread:0.11, thigh:0.48, shin:0.50, w:0.08, footLen:0.24 },
      arms:   { y:0.16, spread:0.24, upper:0.34, lower:0.32, w:0.07, claws:false },
      head:   'skull',
      horns:  'none',
      eyes:   2,
      eyeSize:0.065,
      hood: true,
      bow: true,
      floating: false,
      attackKind: 'ranged'
    },

    // ---- SHAMAN: horned mask, staff
    shaman: {
      colors: { body:0x1a3020, accent:0x2a5038, emissive:0x1a4a2a, eye:0x5eead4, glow:0x9ffff0, cloth:0x0e1e14, dark:0x040a06 },
      rig:    { pelvisY:1.00, torsoW:0.34, torsoH:0.24, chestW:0.42, chestH:0.34, headSize:0.22, headH:0.28 },
      legs:   { y:-0.05, spread:0.12, thigh:0.50, shin:0.52, w:0.08, footLen:0.24 },
      arms:   { y:0.16, spread:0.26, upper:0.34, lower:0.32, w:0.075, claws:false },
      head:   'skull',
      horns:  'crown',
      eyes:   3,
      eyeSize:0.060,
      staff: true,
      robe: true,
      floating: false,
      attackKind: 'melee'
    },

    // ---- Voxel Creeper
    vcreeper: {
      colors: { body:0x40c97a, accent:0x1a6a3a, emissive:0x1a4a2a, eye:0xff4444, glow:0xff8888, dark:0x0a2010 },
      rig:    { pelvisY:0.8, torsoW:1.0, torsoH:1.6, chestW:1.0, chestH:0.3, headSize:0.38, headH:0.38 },
      legs:   { y:-0.6, spread:0.32, thigh:0.35, shin:0.35, w:0.22, footLen:0.28 },
      arms:   { y:0.30, spread:0.42, upper:0.30, lower:0.28, w:0.20, claws:false },
      head:   'box',
      horns:  'none',
      eyes:   2,
      eyeSize:0.10,
      voxel:  true,
      floating: false,
      attackKind: 'explode'
    },

    // ---- Voxel Skeleton
    vskeleton: {
      colors: { body:0xdedede, accent:0xa0a0a0, emissive:0x222222, eye:0xff3333, glow:0xff6666, dark:0x181818 },
      rig:    { pelvisY:0.98, torsoW:0.24, torsoH:0.18, chestW:0.30, chestH:0.30, headSize:0.20, headH:0.24 },
      legs:   { y:-0.05, spread:0.10, thigh:0.46, shin:0.48, w:0.06, footLen:0.22 },
      arms:   { y:0.16, spread:0.22, upper:0.34, lower:0.32, w:0.055, claws:false },
      head:   'box',
      horns:  'none',
      eyes:   2,
      eyeSize:0.070,
      voxel:  true,
      bow: true,
      floating: false,
      attackKind: 'ranged'
    },

    // ---- Voxel Enderman
    venderman: {
      colors: { body:0x2a1a3a, accent:0x4a2a5a, emissive:0x3a1a4a, eye:0xa060d0, glow:0xd08cff, dark:0x0a0518 },
      rig:    { pelvisY:1.25, torsoW:0.28, torsoH:0.22, chestW:0.34, chestH:0.42, headSize:0.22, headH:0.26 },
      legs:   { y:-0.05, spread:0.11, thigh:0.58, shin:0.60, w:0.07, footLen:0.24 },
      arms:   { y:0.20, spread:0.24, upper:0.44, lower:0.42, w:0.065, claws:false },
      head:   'box',
      horns:  'none',
      eyes:   2,
      eyeSize:0.075,
      voxel:  true,
      longArms: true,
      floating: false,
      attackKind: 'melee'
    },

    // ---- Voxel Golem mini-boss
    vgolem: {
      colors: { body:0x8a8a7a, accent:0xb0b0a0, emissive:0x3a3a2a, eye:0xffaa44, glow:0xffd080, dark:0x181810 },
      rig:    { pelvisY:1.30, torsoW:0.72, torsoH:0.50, chestW:0.94, chestH:0.72, headSize:0.32, headH:0.34 },
      legs:   { y:-0.14, spread:0.30, thigh:0.62, shin:0.64, w:0.22, footLen:0.44 },
      arms:   { y:0.30, spread:0.54, upper:0.54, lower:0.50, w:0.20, claws:false },
      head:   'box',
      horns:  'none',
      eyes:   2,
      eyeSize:0.10,
      voxel:  true,
      rockChunks: true,
      floating: false,
      attackKind: 'melee'
    }
  };

  // ============================================================
  //  ASSEMBLE
  // ============================================================
  function assemble(THREE, kind, opt, LOW){
    const cfg = CONFIGS[kind];
    if (!cfg) throw new Error('Unknown monster kind: ' + kind);

    const G = makeGeoCache(THREE, LOW);
    const M = buildMats(THREE, Object.assign({}, cfg.colors, opt.mats || {}));
    const F = Object.assign({}, cfg, opt.overrides || {});

    const root = new THREE.Group();
    root.name = 'Monster_' + kind;

    // ---- Pelvis ----
    const pelvis = grp(THREE, root, 0, F.rig.pelvisY, 0);
    mk(THREE, G.box, M.body, pelvis, 0, 0, 0, F.rig.torsoW, F.rig.torsoH, F.rig.torsoW*0.75);

    // ---- Legs ----
    let legL = null, legR = null;
    if (F.legs){
      legL = buildLeg(THREE, G, M, pelvis,  1, F.legs);
      legR = buildLeg(THREE, G, M, pelvis, -1, F.legs);
    } else {
      // Floating: soft bottom taper
      mk(THREE, G.cone, M.body, pelvis, 0, -0.30, 0, F.rig.torsoW*0.9, 0.60, F.rig.torsoW*0.9).rotation.x = Math.PI;
      mk(THREE, G.cone, M.accent, pelvis, 0, -0.65, 0, F.rig.torsoW*0.7, 0.40, F.rig.torsoW*0.7).rotation.x = Math.PI;
    }

    // ---- Spine / chest ----
    const spine = grp(THREE, pelvis, 0, F.rig.torsoH*0.6, 0);
    mk(THREE, G.box, M.body, spine, 0, 0.06, 0, F.rig.torsoW*0.9, 0.16, F.rig.torsoW*0.75);
    const chest = grp(THREE, spine, 0, 0.22, 0);
    mk(THREE, G.box, M.body, chest, 0, 0.10, 0, F.rig.chestW, F.rig.chestH, F.rig.chestW*0.68);
    // chest accent
    mk(THREE, G.box, M.accent, chest, 0, 0.16, F.rig.chestW*0.34, F.rig.chestW*0.9, 0.07, 0.03);

    // ---- Arms ----
    const armL = buildArm(THREE, G, M, chest,  1, F.arms);
    const armR = buildArm(THREE, G, M, chest, -1, F.arms);
    let armL2 = null, armR2 = null;
    if (F.arms2){
      armL2 = buildArm(THREE, G, M, chest,  1, F.arms2);
      armR2 = buildArm(THREE, G, M, chest, -1, F.arms2);
      armL2.shoulder.rotation.z = 0.35;
      armR2.shoulder.rotation.z = -0.35;
    }

    // ---- Neck / head ----
    const neck = grp(THREE, chest, 0, F.rig.chestH*0.55, 0);
    mk(THREE, G.capsule, M.body, neck, 0, 0.04, 0, F.rig.chestW*0.20, 0.05, F.rig.chestW*0.20);
    const head = grp(THREE, neck, 0, 0.17, 0);

    const HS = F.rig.headSize;
    if (F.head === 'box'){
      mk(THREE, G.box, M.body, head, 0, 0.02, 0, HS*1.9, HS*2.1, HS*1.9);
    } else if (F.head === 'dodec'){
      mk(THREE, G.dodec, M.body, head, 0, 0.02, 0, HS*1.05, HS*1.25, HS*1.05);
    } else {
      mk(THREE, G.sphere, M.body, head, 0, 0.02, 0, HS, HS*1.15, HS);
      mk(THREE, G.box, M.body, head, 0, -0.10, 0.04, HS*1.5, HS*0.55, HS*1.5);
    }
    // jaw
    mk(THREE, G.box, M.dark, head, 0, -0.14, 0.02, HS*1.3, 0.04, HS*1.2);

    // ---- Eyes ----
    const eyes = [];
    const ES = F.eyeSize;
    if (F.eyes === 2){
      const eL = buildEye(THREE, G, M, ES); eL.position.set( HS*0.42, 0.04,  HS*0.86); head.add(eL); eyes.push(eL);
      const eR = buildEye(THREE, G, M, ES); eR.position.set(-HS*0.42, 0.04,  HS*0.86); head.add(eR); eyes.push(eR);
    } else if (F.eyes === 3){
      const eL = buildEye(THREE, G, M, ES); eL.position.set( HS*0.44, 0.02,  HS*0.86); head.add(eL); eyes.push(eL);
      const eR = buildEye(THREE, G, M, ES); eR.position.set(-HS*0.44, 0.02,  HS*0.86); head.add(eR); eyes.push(eR);
      const eC = buildEye(THREE, G, M, ES*0.7); eC.position.set(0, HS*0.65, HS*0.78); head.add(eC); eyes.push(eC);
    } else if (F.eyes === 4){
      for (const [dx, dy] of [[0.42, 0.10], [-0.42, 0.10], [0.30, -0.10], [-0.30, -0.10]]){
        const e = buildEye(THREE, G, M, ES*0.75);
        e.position.set(dx*HS, dy, HS*0.86);
        head.add(e); eyes.push(e);
      }
    }

    // ---- Horns ----
    const horns = [];
    if (F.horns && F.horns !== 'none'){
      for (const side of [1, -1]){
        const h = buildHorn(THREE, G, M.bone, side, F.horns);
        h.position.set(side*HS*0.75, HS*0.75, -0.02);
        head.add(h);
        horns.push(h);
      }
    }

    // ---- Hood ----
    if (F.hood){
      const hood = grp(THREE, head, 0, 0.05, -0.02);
      mk(THREE, G.sphere, M.cloth, hood, 0, 0, 0, HS*1.55, HS*1.65, HS*1.55);
      // visor cut (dark plane in front)
      mk(THREE, G.plane, M.dark, hood, 0, -0.02, HS*1.10, HS*1.4, HS*0.7, 1);
    }

    // ---- Veil (tattered cape) ----
    let veil = null;
    if (F.veil){
      const v = buildVeil(THREE, G, M, chest, F.veil.len, F.veil.w);
      v.root.position.set(0, F.rig.chestH*0.5, -F.rig.chestW*0.35);
      veil = v;
    }

    // ---- Tendrils (wisp) ----
    const tendrils = [];
    if (F.tendrils){
      for (let i = 0; i < F.tendrils; i++){
        const a = (i/F.tendrils) * Math.PI * 2;
        const t = grp(THREE, pelvis, Math.sin(a)*F.rig.torsoW*0.5, -F.rig.torsoH*0.4, Math.cos(a)*F.rig.torsoW*0.5);
        const segs = [];
        let p = t;
        for (let j = 0; j < 4; j++){
          const s = grp(THREE, p, 0, j===0?0:-0.18, 0);
          mk(THREE, G.capsule, M.body, s, 0, -0.09, 0, 0.045 - j*0.008, 0.09, 0.045 - j*0.008);
          segs.push(s);
          p = s;
        }
        tendrils.push({ root:t, segs, phase: a });
      }
    }

    // ---- Rock chunks (golem) ----
    if (F.rockChunks){
      for (let i = 0; i < 8; i++){
        const a = rndFloat(i*1.7) * Math.PI * 2;
        const c = mk(THREE, G.dodec, M.accent, chest,
          Math.sin(a)*F.rig.chestW*0.55,
          (rndFloat(i*3.1) - 0.5)*F.rig.chestH*0.9,
          Math.cos(a)*F.rig.chestW*0.4,
          0.08 + rndFloat(i*2.3)*0.10,
          0.08 + rndFloat(i*5.7)*0.10,
          0.08 + rndFloat(i*7.1)*0.10);
        c.rotation.set(rndFloat(i)*3, rndFloat(i*2)*3, rndFloat(i*3)*3);
      }
    }

    // ---- Spikes (brute) ----
    if (F.spikes){
      for (let i = 0; i < 5; i++){
        const dx = (i-2)*0.14;
        const dy = 0.14 - Math.abs(i-2)*0.03;
        const s = mk(THREE, G.cone, M.accent, chest, dx, F.rig.chestH*0.4 + dy, -F.rig.chestW*0.32, 0.04, 0.14, 0.04);
        s.rotation.x = -0.3;
      }
    }

    // ---- Dual blades (assassin) ----
    let bladeL = null, bladeR = null;
    if (F.dualBlades){
      const mkBlade = () => {
        const b = new THREE.Group();
        mk(THREE, G.box, M.dark, b, 0, -0.04, 0, 0.03, 0.08, 0.03);
        mk(THREE, G.box, M.blade, b, 0, 0.24, 0, 0.045, 0.55, 0.02);
        mk(THREE, G.cone, M.blade, b, 0, 0.56, 0, 0.035, 0.12, 0.018);
        return b;
      };
      bladeL = mkBlade(); bladeL.rotation.x = -Math.PI/2; bladeL.position.set(0, -0.08, 0.02);
      bladeR = mkBlade(); bladeR.rotation.x = -Math.PI/2; bladeR.position.set(0, -0.08, 0.02);
      armL.hand.add(bladeL);
      armR.hand.add(bladeR);
    }

    // ---- Scarf (assassin) ----
    let scarf = null;
    if (F.scarf){
      scarf = buildVeil(THREE, G, M, neck, 3, 0.30);
      scarf.root.position.set(0, 0, -0.08);
    }

    // ---- Bow (ranger/skeleton) ----
    let bow = null;
    if (F.bow){
      bow = new THREE.Group();
      mk(THREE, G.torus, M.bone, bow, 0, 0, 0, 0.14, 0.32, 0.14);
      mk(THREE, G.box, M.dark, bow, 0, 0, 0, 0.02, 0.55, 0.02);
      armL.hand.add(bow);
      bow.rotation.set(0, 0, Math.PI/2);
      bow.position.set(0, -0.06, 0.02);
    }

    // ---- Staff (shaman) ----
    let staff = null;
    if (F.staff){
      staff = new THREE.Group();
      mk(THREE, G.cyl, M.dark, staff, 0, -0.35, 0, 0.03, 1.10, 0.03);
      mk(THREE, G.torus, M.glowToon, staff, 0, 0.35, 0, 0.10, 0.10, 0.10);
      mk(THREE, G.sphere, M.glow, staff, 0, 0.35, 0, 0.06, 0.06, 0.06);
      armR.hand.add(staff);
    }

    // ---- Robe (shaman) ----
    if (F.robe){
      for (let i = 0; i < 8; i++){
        const a = (i/8)*Math.PI*2;
        const c = mk(THREE, G.plane, M.cloth, pelvis,
          Math.sin(a)*F.rig.torsoW*0.5, -F.rig.torsoH*0.5, Math.cos(a)*F.rig.torsoW*0.5,
          0.30, 0.55, 1);
        c.rotation.y = a;
      }
    }

    // ---- Voxel override ----
    if (F.voxel){
      root.traverse(o => {
        if (o.isMesh && o.material === M.body){
          o.geometry.dispose?.();
          // approximate box proportions
          const s = o.scale;
          const box = new THREE.BoxGeometry(1,1,1);
          o.geometry = box;
          o.scale.set(Math.ceil(s.x*4)/4, Math.ceil(s.y*4)/4, Math.ceil(s.z*4)/4);
        }
      });
    }

    // ---- Glitch (echo) ----
    if (F.glitch){
      M.body.transparent = true; M.body.opacity = 0.78;
      M.accent.transparent = true; M.accent.opacity = 0.65;
      M.cloth.transparent = true; M.cloth.opacity = 0.55;
    }

    // ============================================================
    //  ANIMATION STATE MACHINE
    // ============================================================
    const st = {
      t: 0, anim: 0,
      mode: 'patrol',
      flash: 0, windup: 0,
      baseEmissive: 0.10,
      attackPhase: 0,
      floatPhase: Math.random()*Math.PI*2,
      glitch: 0
    };

    const baseY = F.rig.pelvisY;

    function update(dt, ctx){
      ctx = ctx || {};
      st.t += dt;
      const mode = ctx.mode || st.mode;
      st.mode = mode;
      const spd = ctx.speed || (mode === 'chase' ? 5 : 2);
      st.anim += dt * (mode === 'chase' ? spd * 1.6 : spd * 1.0);
      const g = mode === 'chase' ? 1.0 : 0.5;
      const sw = Math.sin(st.anim * 1.1);

      // ------- Breathing / body bob -------
      const br = Math.sin(st.t * 1.7 + st.floatPhase);
      const bobY = br * 0.010;
      pelvis.position.y = baseY + bobY + (F.floating ? Math.sin(st.t*1.3 + st.floatPhase) * (F.floatAmp||0.15) : 0);

      // ------- Torso -------
      chest.rotation.x = br * 0.018 + (mode === 'chase' ? 0.06 : 0);
      chest.rotation.y = sw * 0.05 * g;

      // ------- Head -------
      head.rotation.y = Math.sin(st.t * 0.7) * 0.12 + (mode === 'chase' ? 0 : 0);
      head.rotation.x = Math.sin(st.t * 0.9) * 0.04 + (mode === 'chase' ? -0.08 : 0);

      // ------- Arms -------
      const baseSwing = mode === 'chase' ? 0.7 : 0.32;
      armL.shoulder.rotation.x = sw * baseSwing;
      armR.shoulder.rotation.x = -sw * baseSwing;
      armL.shoulder.rotation.z = -0.12 - Math.abs(sw) * 0.05;
      armR.shoulder.rotation.z =  0.12 + Math.abs(sw) * 0.05;
      armL.elbow.rotation.x = -0.30 - Math.abs(sw) * 0.25;
      armR.elbow.rotation.x = -0.30 - Math.abs(sw) * 0.25;

      // Second arms (brute) — opposite phase, lower
      if (armL2 && armR2){
        armL2.shoulder.rotation.x = -sw * baseSwing * 0.6;
        armR2.shoulder.rotation.x =  sw * baseSwing * 0.6;
        armL2.shoulder.rotation.z = -0.35;
        armR2.shoulder.rotation.z =  0.35;
        armL2.elbow.rotation.x = -0.55;
        armR2.elbow.rotation.x = -0.55;
      }

      // ------- Legs -------
      if (legL && legR){
        const legSwing = (F.floating ? 0 : baseSwing * 1.1);
        legL.hip.rotation.x = -sw * legSwing;
        legR.hip.rotation.x =  sw * legSwing;
        legL.knee.rotation.x = Math.max(0,  sw) * (mode === 'chase' ? 0.8 : 0.5);
        legR.knee.rotation.x = Math.max(0, -sw) * (mode === 'chase' ? 0.8 : 0.5);
      }

      // ------- Veil / scarf / tendrils flow -------
      if (veil){
        const flow = mode === 'chase' ? 0.65 : 0.22;
        for (let i = 0; i < veil.segs.length; i++){
          veil.segs[i].rotation.x = flow * (0.5 + i*0.28) + Math.sin(st.t*2 + i*0.5) * 0.06;
        }
      }
      if (scarf){
        for (let i = 0; i < scarf.segs.length; i++){
          scarf.segs[i].rotation.x = 0.4 * (0.6 + i*0.4) + Math.sin(st.t*3 + i*0.7) * 0.10;
        }
      }
      if (tendrils.length){
        for (const td of tendrils){
          const s = Math.sin(st.t*2.2 + td.phase);
          for (let i = 0; i < td.segs.length; i++){
            td.segs[i].rotation.x = (0.20 + i*0.10) + s * (0.08 + i*0.03);
            td.segs[i].rotation.z = Math.cos(st.t*1.8 + td.phase + i*0.3) * 0.06;
          }
        }
      }

      // ------- Floating idle -------
      if (F.floating && mode !== 'chase'){
        armL.shoulder.rotation.z = -0.35 + Math.sin(st.t*1.5)*0.06;
        armR.shoulder.rotation.z =  0.35 - Math.sin(st.t*1.5)*0.06;
      }

      // ------- Windup / attack -------
      if (st.windup > 0){
        st.windup -= dt;
        const w = clamp(1 - st.windup / 0.45, 0, 1);
        const raise = ease(w);
        armL.shoulder.rotation.x = lerp(armL.shoulder.rotation.x, -1.6, 0.35);
        armR.shoulder.rotation.x = lerp(armR.shoulder.rotation.x, -2.0, 0.35);
        armL.elbow.rotation.x = lerp(armL.elbow.rotation.x, -1.5, 0.30);
        armR.elbow.rotation.x = lerp(armR.elbow.rotation.x, -1.8, 0.30);
        chest.rotation.x = lerp(chest.rotation.x, -0.22, 0.25);
        head.rotation.x = lerp(head.rotation.x, -0.25, 0.25);
        // glow pulse
        M.glowToon.emissiveIntensity = 1.2 + raise * 2.4;
        M.iris.opacity = 1;
      } else if (st.attackPhase > 0){
        st.attackPhase -= dt;
        armL.shoulder.rotation.x = lerp(armL.shoulder.rotation.x, 0.8, 0.4);
        armR.shoulder.rotation.x = lerp(armR.shoulder.rotation.x, 1.2, 0.4);
        chest.rotation.x = lerp(chest.rotation.x, 0.35, 0.4);
        M.glowToon.emissiveIntensity = lerp(M.glowToon.emissiveIntensity, 1.2, 0.25);
      }

      // ------- Hit flash -------
      if (st.flash > 0){
        st.flash -= dt;
        const f = Math.max(0, st.flash) * 4;
        M.body.emissive.setRGB(1, 1, 1);
        M.body.emissiveIntensity = st.baseEmissive + f * 2.5;
        M.accent.emissive.setRGB(1, 1, 1);
        M.accent.emissiveIntensity = 0.15 + f * 2.5;
        M.iris.opacity = 1;
        if (st.flash <= 0){
          M.body.emissive.setRGB(cfg.colors.emissive>>16&255 / 255, 0, 0); // restore
          M.body.emissive.copy(new THREE.Color(cfg.colors.emissive || 0x000000));
          M.accent.emissive.copy(new THREE.Color(cfg.colors.accent || cfg.colors.emissive || 0x000000));
          M.body.emissiveIntensity = st.baseEmissive;
          M.accent.emissiveIntensity = 0.15;
        }
      }

      // ------- Glitch (echo) -------
      if (F.glitch){
        st.glitch += dt;
        if (st.glitch > 0.12){
          st.glitch = 0;
          const jitter = (Math.random() - 0.5) * 0.06;
          pelvis.position.x = jitter;   // local only - never fights world position
          M.body.opacity = 0.65 + Math.random() * 0.25;
        }
      }

      // ------- Rock chunk jitter (golem) -------
      if (F.rockChunks && mode === 'chase'){
        // subtle — chunks jitter via material flash already
      }
    }

    function play(name){
      if (name === 'windup'){
        st.windup = 0.45;
      } else if (name === 'attack'){
        st.attackPhase = 0.20;
        st.windup = 0;
      } else if (name === 'hurt'){
        st.flash = 0.35;
      } else if (name === 'die'){
        st.mode = 'dead';
      }
    }

    function setFlash(f){ st.flash = Math.max(st.flash, f); }

    function dispose(){
      root.traverse(o => {
        if (o.isMesh){
          if (o.geometry && !o.geometry.userData.__shared) o.geometry.dispose();
        }
      });
      Object.values(M).forEach(m => { if (m.dispose) m.dispose(); });
      Object.values(G).forEach(g => { if (g.dispose) g.dispose(); });
    }

    // rndFloat helper
    function rndFloat(s){
      const x = Math.sin(s*12.9898) * 43758.5453;
      return x - Math.floor(x);
    }

    return {
      kind, root,
      // legacy-compatible hooks
      body: chest.children[0] || chest,
      pelvis, spine, chest, head, neck,
      armL, armR, armL2, armR2,
      legL, legR,
      veil: veil ? veil.root : null,
      tendrils,
      mat: M.body, matAccent: M.accent, eyeMat: M.iris, glowMat: M.glow,
      parts: { eyes, horns, veilSegs: veil?veil.segs:null, scarf, bow, staff, bladeL, bladeR },
      state: st,
      baseEmissive: st.baseEmissive,
      update, play, setFlash, dispose,
      height: F.rig.pelvisY * 2.2,
      cfg: F
    };
  }

  // ---------------- PUBLIC ----------------
  function create(THREE, kind, opt){
    opt = opt || {};
    const LOW = opt.quality === 'low';
    return assemble(THREE, kind, opt, LOW);
  }

  return {
    create,
    KINDS: Object.keys(CONFIGS),
    VERSION: '1.0'
  };
})();

// ---- v4.5 ANIME MONSTER MODELS (MonsterFactory) ----
const MOB_MODEL_SCALE = { somber:1.0, brute:1.35, wisp:1.0, golem:1.6, ranger:1.05, shaman:1.10, assassin:1.0, echo:1.05 };

// big parts only -> shadows stay cheap even with 50-mesh monsters
function applyMobShadow(mon){
  if (!Q.shadows) return;
  const picks = [mon.body, mon.head && mon.head.children[0], mon.chest && mon.chest.children[0]];
  if (mon.legL && mon.legL.hip) picks.push(mon.legL.hip.children[0]);
  if (mon.legR && mon.legR.hip) picks.push(mon.legR.hip.children[0]);
  for (const p of picks) if (p && p.isMesh) p.castShadow = true;
}
function disposeMobVisual(m){
  try { if (m && m._mon && m._mon.dispose) m._mon.dispose(); } catch(e){}
  try { if (m && m.mesh && m.mesh.parent) m.mesh.parent.remove(m.mesh); } catch(e){}
}
function makeMob(kind, x, z, levelBonus = 0){
  const sp = ENEMY_SPECS[kind];
  if (!sp) return null;
  const mon = MonsterFactory.create(THREE, kind, {
    quality: LOW ? 'low' : 'high',
    mats: { eye: sp.emissive, glow: sp.emissive }
  });
  const g = mon.root;
  const s = MOB_MODEL_SCALE[kind] || 1;
  g.scale.setScalar(s);
  g.position.set(x, th(x, z), z);
  scene.add(g);
  applyMobShadow(mon);
  const hp = sp.hp + Math.round(levelBonus * 0.5);
  return {
    kind, mesh:g, body: mon.body, mat: mon.mat, eyeMat: mon.eyeMat, spec:sp,
    head: mon.head, armL: mon.armL, armR: mon.armR, veil: mon.veil,
    _mon: mon,
    mode:'patrol', target:{ x:x+3, z:z-3 }, nextRetarget:0,
    health:hp, maxHp:hp, alive:true,
    cooldown:0, windup:0, stun:0, anim:0, flash:0,
    attackDmg:sp.dmg, attackRange:sp.range, sense:sp.sense,
    baseEmissive:0.10, eyeBaseEmissive:1.5, scaleBase:s, isBoss:false, phase:1,
    flying:!!sp.flying, ranged:!!sp.ranged, healer:!!sp.healer,
    teleport:!!sp.teleport, aoe:!!sp.aoe, isEcho:!!sp.echo,
    dimension:'genesis',
    replay:null, replayStart:0
  };
}

// ============================================================================
//  SECTION: VOXEL MOB FACTORY (v4.0)
// ============================================================================
const voxelBlockGeo = new THREE.BoxGeometry(0.95, 0.95, 0.95);
// ---- v4.5 ANIME VOXEL MONSTERS (MonsterFactory) ----
const VOXEL_MON_MAP = { vcreeper:'vcreeper', vzombie:'somber', vskeleton:'vskeleton', venderman:'venderman', vgolem:'vgolem' };
const VOXEL_MON_TWEAK = {
  // zombie = shambling husk: no horns, no veil, box head, sickly glow
  vzombie: {
    mats: { body:0x4a6a8a, accent:0x2f5566, emissive:0x1a2a3a, eye:0x9dff7a, glow:0xcfff9d, dark:0x16242e },
    overrides: { horns:'none', veil:null, eyes:2, head:'box' }
  }
};
function makeVoxelMob(kind, x, y, z, levelBonus = 0){
  const sp = VOXEL_SPECS[kind];
  if (!sp) return null;
  const cfgKind = VOXEL_MON_MAP[kind] || 'vcreeper';
  const tweak = VOXEL_MON_TWEAK[kind] || {};
  const mon = MonsterFactory.create(THREE, cfgKind, {
    quality: LOW ? 'low' : 'high',
    mats: Object.assign({ eye: sp.emissive, glow: sp.emissive }, tweak.mats || {}),
    overrides: tweak.overrides || undefined
  });
  const g = mon.root;
  g.position.set(x, y, z);
  scene.add(g);
  applyMobShadow(mon);
  const hp = sp.hp + Math.round(levelBonus * 0.6);
  return {
    kind, mesh: g, mat: mon.mat, eyeMat: mon.eyeMat, spec: sp,
    body: mon.body, head: mon.head, armL: mon.armL, armR: mon.armR,
    _mon: mon,
    mode:'patrol', target:{ x: x+3, z: z-3 }, nextRetarget: 0,
    health: hp, maxHp: hp, alive: true,
    cooldown: 0, windup: 0, stun: 0, anim: 0, flash: 0,
    attackDmg: sp.dmg, attackRange: sp.range, sense: sp.sense,
    baseEmissive: 0.10, scaleBase: 1, isBoss: false, phase: 1,
    ranged: !!sp.ranged, teleport: !!sp.teleport, aoe: !!sp.aoe,
    creeper: !!sp.creeper, enderman: !!sp.enderman, miniBoss: !!sp.miniBoss,
    fuse: 0, dimension: 'voxel',
    homeY: y, levelBonus
  };
}

// ============================================================================
//  SECTION: VOXEL WORLD (v4.0)
// ============================================================================
const voxelState = {
  active: false,
  world: null,           // 3D Uint8Array [x][y][z] flattened
  worldW: TUNING.voxelDimW, worldH: TUNING.voxelDimH,
  voxChunk: TUNING.voxelChunk,
  chunks: new Map(),      // key -> { mesh group }
  modifiedBlocks: new Map(), // key "x,y,z" -> blockId (persist to IDB)
  minedCount: 0,
  biomeVoxel: 'plain',
  spawnedAt: { x: TUNING.voxelDimW/2, y: 0, z: TUNING.voxelDimW/2 },
  exits: [],
  creeperBlasts: 0,
  enterCount: 0
};
const VOXEL_BIOMES = ['plain', 'desert', 'nether'];
const VOXEL_BLOCK_TYPES = {
  0: { name:'air',   color:0x000000, transparent: true,  mine: 0    },
  1: { name:'grass', color:0x6bbf4a, mine: 0.6, solid: true },
  2: { name:'dirt',  color:0x8a5a3a, mine: 0.5, solid: true },
  3: { name:'stone', color:0x8a8a92, mine: 0.9, solid: true },
  4: { name:'sand',  color:0xe8d8a0, mine: 0.5, solid: true },
  5: { name:'water', color:0x3a8ad4, transparent: true, mine: 99, solid: false, liquid: true },
  6: { name:'lava',  color:0xff6a1a, emissive: true, mine: 99, solid: false, liquid: true },
  7: { name:'netherrack', color:0x8a2a2a, mine: 0.7, solid: true },
  8: { name:'obsidian', color:0x2a1a3a, emissive: true, mine: 2.5, solid: true },
  9: { name:'glowstone', color:0xffd966, emissive: true, mine: 0.6, solid: true }
};

function voxIdx(x, y, z){
  const W = voxelState.worldW, H = voxelState.worldH;
  return (y * W + z) * W + x;
}
function voxGet(x, y, z){
  if (x < 0 || x >= voxelState.worldW) return 0;
  if (y < 0 || y >= voxelState.worldH) return 0;
  if (z < 0 || z >= voxelState.worldW) return 0;
  return voxelState.world[voxIdx(x, y, z)];
}
function voxSet(x, y, z, v){
  if (x < 0 || x >= voxelState.worldW) return;
  if (y < 0 || y >= voxelState.worldH) return;
  if (z < 0 || z >= voxelState.worldW) return;
  voxelState.world[voxIdx(x, y, z)] = v;
  // rebuild affected chunk
  const cx = Math.floor(x / voxelState.voxChunk);
  const cz = Math.floor(z / voxelState.voxChunk);
  rebuildVoxelChunk(cx, cz);
  // persist modified
  voxelState.modifiedBlocks.set(x+','+y+','+z, v);
  voxelState.minedCount++;
  saveVoxelMods();
}

function generateVoxelWorld(){
  const W = voxelState.worldW, H = voxelState.worldH;
  voxelState.world = new Uint8Array(W * H * W);
  // biome by 2D noise
  for (let x = 0; x < W; x++){
    for (let z = 0; z < W; z++){
      const bn = fbm(x*0.04 + 1000, z*0.04 + 1000, 3);
      let biome;
      if (bn < -0.15) biome = 'nether';
      else if (bn > 0.2) biome = 'desert';
      else biome = 'plain';
      // heightmap
      let h = Math.floor(fbm(x*0.06, z*0.06, 4) * 4 + 6);
      h = clamp(h, 3, H - 6);
      // fill column
      for (let y = 0; y <= h; y++){
        let block = 0;
        if (y === h){
          block = biome === 'desert' ? 4 : (biome === 'nether' ? 7 : 1);
        } else if (y > h - 3){
          block = biome === 'desert' ? 4 : 2;
        } else {
          block = biome === 'nether' ? 7 : 3;
        }
        voxelState.world[voxIdx(x, y, z)] = block;
      }
      // cave carving
      if (x > 4 && x < W-4 && z > 4 && z < W-4 && h > 5){
        for (let y = 2; y < h - 2; y++){
          const c = fbm3(x*0.15, y*0.15, z*0.15, 3);
          if (c > 0.28){
            voxelState.world[voxIdx(x, y, z)] = 0;
          }
        }
      }
      // water ponds (plain only)
      if (biome === 'plain' && h <= 4){
        for (let y = h+1; y <= 5; y++) voxelState.world[voxIdx(x, y, z)] = 5;
      }
      // lava (nether)
      if (biome === 'nether' && h <= 4){
        for (let y = h+1; y <= 5; y++) voxelState.world[voxIdx(x, y, z)] = 6;
      }
      // glowstone near lava
      if (biome === 'nether' && Math.random() < 0.008 && h > 3){
        voxelState.world[voxIdx(x, h+1, z)] = 9;
      }
    }
  }
  // Clear spawn area (portal site)
  const sx = voxelState.spawnedAt.x, sz = voxelState.spawnedAt.z;
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++)
      for (let y = 0; y < H; y++)
        voxelState.world[voxIdx(sx+dx, y, sz+dz)] = 0;
  // Portal platform
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++)
      voxelState.world[voxIdx(sx+dx, 0, sz+dz)] = 8;
  // Reapply modifications
  voxelState.modifiedBlocks.forEach((v, k) => {
    const [x, y, z] = k.split(',').map(Number);
    if (x >= 0 && x < W && y >= 0 && y < H && z >= 0 && z < W){
      voxelState.world[voxIdx(x, y, z)] = v;
    }
  });
}

// Greedy-ish meshing per chunk (simplified: build instanced cubes per block type)
const voxelMatCache = {};
function getVoxelMat(blockId){
  if (voxelMatCache[blockId]) return voxelMatCache[blockId];
  const b = VOXEL_BLOCK_TYPES[blockId];
  const mat = new THREE.MeshStandardMaterial({
    color: b.color,
    emissive: b.emissive ? b.color : 0x000000,
    emissiveIntensity: b.emissive ? 1.1 : 0,
    roughness: 0.92, flatShading: true,
    side: THREE.FrontSide,
    transparent: !!b.transparent,
    opacity: b.transparent ? 0.75 : 1,
    depthWrite: !b.transparent
  });
  voxelMatCache[blockId] = mat;
  return mat;
}
function rebuildVoxelChunk(cx, cz){
  const key = cx + '_' + cz;
  let ch = voxelState.chunks.get(key);
  if (ch){
    scene.remove(ch.group);
    ch.group.traverse(o => { if (o.isInstancedMesh) o.geometry.dispose?.(); });
    voxelState.chunks.delete(key);
  }
  const CS = voxelState.voxChunk;
  const x0 = cx * CS, z0 = cz * CS;
  const x1 = Math.min(x0 + CS, voxelState.worldW);
  const z1 = Math.min(z0 + CS, voxelState.worldW);
  // bucket blocks by type
  const byType = new Map();
  for (let x = x0; x < x1; x++){
    for (let z = z0; z < z1; z++){
      for (let y = 0; y < voxelState.worldH; y++){
        const b = voxelState.world[voxIdx(x, y, z)];
        if (b === 0) continue;
        // occluded block culling: skip if all 6 neighbors solid
        if (isBlockFullySurrounded(x, y, z)) continue;
        if (!byType.has(b)) byType.set(b, []);
        byType.get(b).push({ x, y, z });
      }
    }
  }
  if (byType.size === 0) return;
  const group = new THREE.Group();
  byType.forEach((list, blockId) => {
    const mat = getVoxelMat(blockId);
    const im = new THREE.InstancedMesh(voxelBlockGeo, mat, list.length);
    for (let i = 0; i < list.length; i++){
      const b = list[i];
      _v.set(b.x + 0.5, b.y + 0.5, b.z + 0.5);
      _q.identity();
      _s.set(1, 1, 1);
      _m4.compose(_v, _q, _s);
      im.setMatrixAt(i, _m4);
    }
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = Q.shadows && blockId !== 5;
    im.receiveShadow = Q.shadows;
    im.computeBoundingSphere();
    group.add(im);
  });
  group.matrixAutoUpdate = false; group.updateMatrix();
  group.userData.cx = cx; group.userData.cz = cz;
  scene.add(group);
  voxelState.chunks.set(key, { group, cx, cz });
}
function isBlockFullySurrounded(x, y, z){
  return voxGet(x+1,y,z) !== 0 && voxGet(x-1,y,z) !== 0 &&
         voxGet(x,y+1,z) !== 0 && voxGet(x,y-1,z) !== 0 &&
         voxGet(x,y,z+1) !== 0 && voxGet(x,y,z-1) !== 0;
}
function buildAllVoxelChunks(){
  // Clear old
  voxelState.chunks.forEach(ch => scene.remove(ch.group));
  voxelState.chunks.clear();
  const CS = voxelState.voxChunk;
  const n = Math.ceil(voxelState.worldW / CS);
  for (let cx = 0; cx < n; cx++)
    for (let cz = 0; cz < n; cz++)
      rebuildVoxelChunk(cx, cz);
}

// Voxel ground collider — raycast downward from player
function voxSolidAt(x, y, z){
  const b = voxGet(Math.floor(x), Math.floor(y), Math.floor(z));
  if (b === 0) return false;
  return VOXEL_BLOCK_TYPES[b]?.solid;
}
function voxGroundHeight(x, z){
  for (let y = voxelState.worldH - 1; y >= 0; y--){
    if (voxSolidAt(x, y, z)) return y + 1;
  }
  return 0;
}

// IndexedDB persistence for modified blocks
let idb = null;
function openIDB(){
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('realm_ultra_v4', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('voxelMods');
      };
      req.onsuccess = () => { idb = req.result; resolve(idb); };
      req.onerror = () => resolve(null);
    } catch(e){ resolve(null); }
  });
}
function saveVoxelMods(){
  if (!idb) return;
  try {
    const tx = idb.transaction('voxelMods', 'readwrite');
    const store = tx.objectStore('voxelMods');
    const arr = [];
    voxelState.modifiedBlocks.forEach((v, k) => arr.push({ k, v }));
    store.put(arr, 'data');
  } catch(e){}
}
async function loadVoxelMods(){
  if (!idb) return;
  try {
    const tx = idb.transaction('voxelMods', 'readonly');
    const store = tx.objectStore('voxelMods');
    const req = store.get('data');
    req.onsuccess = () => {
      if (req.result){
        req.result.forEach(({k, v}) => voxelState.modifiedBlocks.set(k, v));
      }
    };
  } catch(e){}
}

// ============================================================================
//  SECTION: BOSS (Genesis)
// ============================================================================
let activeBoss = null;
function spawnBoss(biome){
  if (activeBoss) return;
  const x = playerGroup.position.x + Math.cos(rnd()*Math.PI*2) * 24;
  const z = playerGroup.position.z + Math.sin(rnd()*Math.PI*2) * 24;
  const boss = makeMob('golem', x, z, 5);
  if (!boss) return;
  boss.isBoss = true;
  boss.health = 60; boss.maxHp = 60;
  boss.attackDmg = 4; boss.attackRange = 3.2; boss.sense = 30;
  boss.mesh.scale.setScalar(2.6); boss.scaleBase = 2.6;
  boss.bossName = 'TITAN of ' + (BIOMES[biome]?.name?.split(' ')[0] || 'Realm');
  activeBoss = boss;
  MOBS.push(boss);
  $('bossbar').classList.add('on');
  $('bossName').textContent = boss.bossName;
  $('bossPhase').textContent = 'PHASE I / III';
  $('bossHp').style.width = '100%';
  updateBossPips(3, 1);
  $('bosswarn').classList.add('on');
  setTimeout(() => $('bosswarn').classList.remove('on'), 1400);
  showToast('BOSS — ' + boss.bossName + '  ' + KAO.determined, 'magenta');
  [220, 277, 330, 415].forEach((f,i) => tone(f, 0.4, 'sawtooth', 0.09, i*0.14));
}
function despawnBoss(){
  if (!activeBoss) return;
  $('bossbar').classList.remove('on');
  activeBoss = null;
}
function updateBossPips(total, current){
  const el = $('bossPips');
  el.innerHTML = '';
  for (let i = 0; i < total; i++){
    const p = document.createElement('div');
    p.className = 'pip' + (i < current ? ' on' : '');
    el.appendChild(p);
  }
}

// ============================================================================
//  SECTION: PLAYER RIG (upgraded 20 bone - simplified)
// ============================================================================
function buildHumanoid(tint){
  const rig = {};
  const col = tint || 0x5f7dfa;
  const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.15, emissive: 0x101a4a, emissiveIntensity: 0.15 });
  const limbMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x232b52, roughness: 0.75 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xffd6b0, roughness: 0.75 });
  rig.mat = mat; rig.limbMat = limbMat; rig.bootMat = bootMat; rig.skinMat = skinMat;

  const root = new THREE.Group();
  const pelvis = new THREE.Group(); pelvis.position.y = 0.92; root.add(pelvis);
  const pelvisMesh = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.24, 0.28), mat); pelvis.add(pelvisMesh);
  rig.pelvis = pelvis;

  const spine = new THREE.Group(); spine.position.y = 0.18; pelvis.add(spine); rig.spine = spine;
  const chest = new THREE.Group(); chest.position.y = 0.30; spine.add(chest); rig.chest = chest;
  const chestMesh = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.48, 0.32), mat); chest.add(chestMesh);

  const neck = new THREE.Group(); neck.position.y = 0.34; chest.add(neck); rig.neck = neck;
  const head = new THREE.Group(); head.position.y = 0.20; neck.add(head); rig.head = head;
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), skinMat); head.add(headMesh);

  // eyes (blink)
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0a0a1e });
  const eye1 = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), eyeMat);
  eye1.position.set(-0.08, 0.02, 0.22); head.add(eye1);
  const eye2 = eye1.clone(); eye2.position.set(0.08, 0.02, 0.22); head.add(eye2);
  rig.eyes = [eye1, eye2];

  // hair voxel points
  const hairGeo = new THREE.BoxGeometry(0.06, 0.06, 0.06);
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x1a2038, roughness: 0.8 });
  const hair = new THREE.Group();
  for (let i = 0; i < 14; i++){
    const h = new THREE.Mesh(hairGeo, hairMat);
    h.position.set(
      (Math.random()-0.5) * 0.28,
      Math.random() * 0.12 + 0.12,
      (Math.random()-0.5) * 0.22
    );
    hair.add(h);
  }
  head.add(hair); rig.hair = hair;

  function makeArm(side){
    const shoulder = new THREE.Group(); shoulder.position.set(side * 0.34, 0.16, 0); chest.add(shoulder);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.32, 3, 6), limbMat);
    upper.position.y = -0.20; shoulder.add(upper);
    const lowerGrp = new THREE.Group(); lowerGrp.position.y = -0.40; shoulder.add(lowerGrp);
    const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.30, 3, 6), limbMat);
    lower.position.y = -0.20; lowerGrp.add(lower);
    const hand = new THREE.Group(); hand.position.y = -0.38; lowerGrp.add(hand);
    const handMesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), skinMat); hand.add(handMesh);
    // finger stubs
    for (let i = 0; i < 3; i++){
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.03), skinMat);
      f.position.set(side * 0.04, -0.02, -0.06 + i*0.06); hand.add(f);
    }
    return { shoulder, lowerGrp, hand };
  }
  rig.armL = makeArm(-1); rig.armR = makeArm(1);

  function makeLeg(side){
    const hip = new THREE.Group(); hip.position.set(side * 0.14, -0.06, 0); pelvis.add(hip);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.42, 3, 6), limbMat);
    thigh.position.y = -0.28; hip.add(thigh);
    const knee = new THREE.Group(); knee.position.y = -0.52; hip.add(knee);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.10, 0.42, 3, 6), limbMat);
    shin.position.y = -0.28; knee.add(shin);
    const foot = new THREE.Group(); foot.position.y = -0.52; knee.add(foot);
    const footMesh = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.10, 0.26), bootMat);
    footMesh.position.z = 0.06; foot.add(footMesh);
    return { hip, knee, foot };
  }
  rig.legL = makeLeg(-1); rig.legR = makeLeg(1);
  return { root, rig };
}
// ============================================================
//  SECTION: ANIME CHARACTER MODULE (SAKURA BLADE v1.0)
// ============================================================
/* ============================================================
   ANIME CHARACTER — "SAKURA BLADE" v1.0
   Toon-shaded anime hero + 20 animasi + expression system.
   Drop-in module. Hanya butuh THREE.js (r150+).

   PAKAI:
     const hero = AnimeCharacter.create(THREE, {
       hairColor: 0x2a4d8f, outfitColor: 0x1a2540,
       accentColor: 0xff6b8a, skinTone: 0xffd6bb,
       quality: 'high' // atau 'low'
     });
     scene.add(hero.root);
     hero.setPosition(0, 0, 0);
     hero.setFacing(0);

     // Loop tiap frame:
     hero.update(dt, { speed, airborne, vy, sprint });

     // Aksi (one-shot):
     hero.playAttack('iai');   // slash1 | slash2 | slash3 | iai | spin | aerial
     hero.play('dodge');       // dodge | parry | draw | sheathe | ult | victory | hurt | land | cast | dead
     hero.playExpression('smile'); // normal | smile | angry | surprise | blush | sad

     // Socket buat FX:
     hero.getSocket('bladeTip'); // handR | handL | head | chest | bladeTip | bladeBase
   ============================================================ */
const AnimeCharacter = (function () {
  'use strict';

  const clamp = (v,a,b) => v<a?a:(v>b?b:v);
  const lerp  = (a,b,t) => a+(b-a)*t;
  const seg   = (u,a,b) => u<=a?0:(u>=b?1:(u-a)/(b-a));
  const ease  = u => u*u*(3-2*u);
  const easeOut = u => 1-Math.pow(1-u,3);
  const kf = (w,vA,s,vB,r) => vA*w + (vB-vA)*s - vB*r;

  const KEYS = [
    'rootPY','rootPZ','rootRX','rootRY','rootRZ',
    'pelPY','pelRX','pelRY','pelRZ',
    'spRX','spRY','spRZ','chRX','chRY','chRZ',
    'nkRX','nkRY','nkRZ','hdRX','hdRY','hdRZ',
    'shLx','shLy','shLz','elLx','elLz','wrLx',
    'shRx','shRy','shRz','elRx','elRz','wrRx',
    'hipLx','hipLz','knLx','anLx',
    'hipRx','hipRz','knRx','anRx',
    'hair0','hair1','hair2','hair3','hair4','hairY',
    'skirt0','skirt1','skirt2','skirt3',
    'ribbon0','ribbon1',
    'wpx','wpz'
  ];

  function makePose(){ const o={}; for(let i=0;i<KEYS.length;i++) o[KEYS[i]]=0; return o; }
  function clearPose(o){ for(let i=0;i<KEYS.length;i++) o[KEYS[i]]=0; }
  function lerpPose(cur, tgt, a){ for(let i=0;i<KEYS.length;i++){ const k=KEYS[i]; cur[k]+=(tgt[k]-cur[k])*a; } }

  function create(THREE, opt){
    opt = opt || {};
    const LOW    = opt.quality === 'low';
    const HAIR   = opt.hairColor  !== undefined ? opt.hairColor  : 0x2a4d8f;
    const OUTFIT = opt.outfitColor!== undefined ? opt.outfitColor: 0x1a2540;
    const ACCENT = opt.accentColor!== undefined ? opt.accentColor: 0xff6b8a;
    const SKIN   = opt.skinTone   !== undefined ? opt.skinTone   : 0xffd6bb;
    const SHADOW = opt.shadows !== false;

    // ---- Toon gradient map (canvas-based, lebih aman dari DataTexture)
    function makeGradient(){
      const cv = document.createElement('canvas');
      cv.width = 4; cv.height = 1;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = 'rgb(70,70,70)';   ctx.fillRect(0,0,1,1);
      ctx.fillStyle = 'rgb(140,140,140)';ctx.fillRect(1,0,1,1);
      ctx.fillStyle = 'rgb(210,210,210)';ctx.fillRect(2,0,1,1);
      ctx.fillStyle = 'rgb(255,255,255)';ctx.fillRect(3,0,1,1);
      const tex = new THREE.CanvasTexture(cv);
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      return tex;
    }
    const gradientMap = makeGradient();

    function toon(color, o){
      o = o || {};
      return new THREE.MeshToonMaterial({
        color, gradientMap,
        emissive: o.emissive || 0x000000,
        emissiveIntensity: o.emissiveIntensity || 0,
        transparent: !!o.transparent,
        opacity: o.opacity !== undefined ? o.opacity : 1,
        side: o.side || THREE.FrontSide
      });
    }
    function flat(color, o){
      o = o || {};
      return new THREE.MeshBasicMaterial({
        color,
        transparent: !!o.transparent,
        opacity: o.opacity !== undefined ? o.opacity : 1,
        side: o.side || THREE.FrontSide,
        depthWrite: o.depthWrite !== false
      });
    }

    const M = {
      skin:     toon(SKIN),
      hair:     toon(HAIR),
      hairHi:   toon(new THREE.Color(HAIR).lerp(new THREE.Color(0xffffff),0.35).getHex()),
      outfit:   toon(OUTFIT),
      outfitDk: toon(new THREE.Color(OUTFIT).multiplyScalar(0.6).getHex()),
      accent:   toon(ACCENT, { emissive: ACCENT, emissiveIntensity: 0.12 }),
      accentLt: toon(new THREE.Color(ACCENT).lerp(new THREE.Color(0xffffff),0.4).getHex()),
      trim:     toon(0xf5c542, { emissive: 0xf5c542, emissiveIntensity: 0.2 }),
      eyeWhite: flat(0xfbfbff),
      iris:     flat(0x3ec9ff),
      pupil:    flat(0x0a0a20),
      hl:       flat(0xffffff),
      lash:     toon(0x0d1020),
      brow:     toon(0x1a2035),
      blade:    new THREE.MeshPhysicalMaterial({
        color: 0xe6f2ff, emissive: 0x3a80ff, emissiveIntensity: 0.35,
        metalness: 0.95, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05
      }),
      bladeEdge:flat(0xa8e6ff),
      handle:   toon(0x1a1a2a),
      guard:    toon(0xf5c542, { emissive: 0xf5c542, emissiveIntensity: 0.3 }),
      sheath:   toon(0x101520),
      boot:     toon(0x2a2030),
      sock:     toon(0xf0f4ff)
    };

    const G = {
      sphere:  new THREE.SphereGeometry(1, LOW?10:16, LOW?8:12),
      box:     new THREE.BoxGeometry(1,1,1),
      cyl:     new THREE.CylinderGeometry(1,1,1, LOW?6:10),
      cone:    new THREE.ConeGeometry(1,1, LOW?5:8),
      capsule: new THREE.CapsuleGeometry(1, 1, 4, LOW?6:10),
      plane:   new THREE.PlaneGeometry(1,1),
      torus:   new THREE.TorusGeometry(1, 0.15, 6, 16)
    };
    Object.values(G).forEach(g => { g.userData.__shared = true; });

    function mk(geo, mat, parent, x,y,z, sx,sy,sz){
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x||0, y||0, z||0);
      if (sx !== undefined) m.scale.set(sx, sy===undefined?sx:sy, sz===undefined?sx:sz);
      m.castShadow = SHADOW;
      m.receiveShadow = false;
      if (parent) parent.add(m);
      return m;
    }
    function grp(parent, x,y,z){
      const g = new THREE.Group();
      g.position.set(x||0, y||0, z||0);
      if (parent) parent.add(g);
      return g;
    }
    function sock(parent, x,y,z){
      const o = new THREE.Object3D();
      o.position.set(x||0, y||0, z||0);
      parent.add(o);
      return o;
    }

    // ============================================================
    //  HIERARCHY
    // ============================================================
    const root = new THREE.Group();
    root.name = 'AnimeCharacter';
    const body = grp(root);
    const PELVIS_Y = 0.92;
    const pelvis = grp(body, 0, PELVIS_Y, 0);

    mk(G.box, M.outfit, pelvis, 0, 0, 0, 0.34, 0.20, 0.22);
    mk(G.box, M.accent, pelvis, 0, 0.09, 0, 0.36, 0.05, 0.23);

    // Skirt (4 flaps)
    const skirtRoot = grp(pelvis, 0, -0.06, 0);
    const skirtSegs = [];
    for (let i = 0; i < 4; i++){
      const a = (i/4) * Math.PI * 2 + Math.PI/4;
      const s = grp(skirtRoot, Math.sin(a)*0.06, 0, Math.cos(a)*0.06);
      s.rotation.y = a;
      mk(G.box, M.outfit, s, 0, -0.14, 0.14, 0.30, 0.28, 0.04).rotation.x = -0.15;
      mk(G.box, M.accent, s, 0, -0.26, 0.14, 0.30, 0.04, 0.045);
      skirtSegs.push(s);
    }

    // ============================================================
    //  LEGS
    // ============================================================
    function buildLeg(side){
      const hip = grp(pelvis, side*0.115, -0.04, 0);
      mk(G.capsule, M.skin, hip, 0, -0.24, 0, 0.10, 0.22, 0.10);
      const knee = grp(hip, 0, -0.48, 0);
      mk(G.sphere, M.skin, knee, 0, 0, 0, 0.095, 0.09, 0.095);
      mk(G.capsule, M.skin, knee, 0, -0.14, 0, 0.085, 0.14, 0.085);
      mk(G.capsule, M.sock, knee, 0, -0.36, 0, 0.10, 0.12, 0.10);
      const foot = grp(knee, 0, -0.52, 0);
      mk(G.box, M.boot, foot, 0, -0.05, 0.06, 0.15, 0.11, 0.28);
      mk(G.box, M.accent, foot, 0, 0.0, 0.20, 0.13, 0.06, 0.05);
      return { hip, knee, foot };
    }
    const legL = buildLeg(1);
    const legR = buildLeg(-1);

    // ============================================================
    //  SPINE / CHEST
    // ============================================================
    const spine = grp(pelvis, 0, 0.12, 0);
    mk(G.box, M.outfit, spine, 0, 0.10, 0, 0.32, 0.22, 0.22);

    const chest = grp(spine, 0, 0.24, 0);
    mk(G.box, M.outfit, chest, 0, 0.10, 0, 0.40, 0.34, 0.24);
    mk(G.box, M.accent, chest, 0, 0.22, -0.06, 0.42, 0.10, 0.16);
    mk(G.box, M.trim,   chest, 0, 0.15,  0.13, 0.05, 0.14, 0.02);
    mk(G.box, M.accent, chest, 0, 0.26,  0.14, 0.24, 0.05, 0.02);

    // Ribbon back
    const ribbonRoot = grp(chest, 0, 0.20, -0.14);
    const ribbonSegs = [];
    {
      const s1 = grp(ribbonRoot, 0, 0, 0);
      mk(G.box, M.accent, s1, 0, -0.10, 0, 0.22, 0.20, 0.02);
      const s2 = grp(s1, 0, -0.20, 0);
      mk(G.box, M.accentLt, s2, 0, -0.10, 0, 0.18, 0.20, 0.02);
      ribbonSegs.push(s1, s2);
    }

    // ============================================================
    //  ARMS
    // ============================================================
    function buildArm(side){
      const shoulder = grp(chest, side*0.24, 0.14, 0);
      mk(G.capsule, M.outfit, shoulder, 0, -0.16, 0, 0.085, 0.14, 0.085);
      const elbow = grp(shoulder, 0, -0.34, 0);
      mk(G.capsule, M.skin, elbow, 0, -0.14, 0, 0.07, 0.12, 0.07);
      mk(G.box, M.accent, elbow, 0, -0.02, 0, 0.10, 0.05, 0.10);
      const hand = grp(elbow, 0, -0.32, 0);
      mk(G.box, M.skin, hand, 0, -0.03, 0, 0.08, 0.09, 0.05);
      if (!LOW){
        for (let i = 0; i < 4; i++){
          mk(G.box, M.skin, hand, side*0.025, -0.11, -0.03 + i*0.02, 0.018, 0.055, 0.018);
        }
        mk(G.box, M.skin, hand, side*-0.045, -0.02, 0.02, 0.02, 0.05, 0.022);
      }
      return { shoulder, elbow, hand };
    }
    const armL = buildArm(1);
    const armR = buildArm(-1);

    // ============================================================
    //  HEAD
    // ============================================================
    const neck = grp(chest, 0, 0.30, 0);
    mk(G.capsule, M.skin, neck, 0, 0.02, 0, 0.065, 0.05, 0.065);

    const head = grp(neck, 0, 0.17, 0);
    mk(G.sphere, M.skin, head, 0, 0.02, 0, 0.24, 0.27, 0.24);
    mk(G.sphere, M.skin, head, 0, -0.09, 0.06, 0.14, 0.11, 0.15);

    // ============================================================
    //  FACE (anime-style)
    // ============================================================
    const eyeL = new THREE.Group(); eyeL.position.set(0.085, 0.04, 0.215); head.add(eyeL);
    const eyeR = new THREE.Group(); eyeR.position.set(-0.085, 0.04, 0.215); head.add(eyeR);

    mk(G.sphere, M.eyeWhite, eyeL, 0, 0, 0, 0.055, 0.075, 0.02);
    mk(G.sphere, M.eyeWhite, eyeR, 0, 0, 0, 0.055, 0.075, 0.02);
    mk(G.sphere, M.iris,     eyeL, 0, -0.005, 0.015, 0.038, 0.050, 0.015);
    mk(G.sphere, M.iris,     eyeR, 0, -0.005, 0.015, 0.038, 0.050, 0.015);
    mk(G.sphere, M.pupil,    eyeL, 0, -0.005, 0.022, 0.018, 0.028, 0.01);
    mk(G.sphere, M.pupil,    eyeR, 0, -0.005, 0.022, 0.018, 0.028, 0.01);
    mk(G.sphere, M.hl,       eyeL, -0.012, 0.018, 0.026, 0.014, 0.016, 0.008);
    mk(G.sphere, M.hl,       eyeR,  0.012, 0.018, 0.026, 0.014, 0.016, 0.008);
    mk(G.sphere, M.hl,       eyeL, 0.014, -0.022, 0.026, 0.007, 0.008, 0.005);
    mk(G.sphere, M.hl,       eyeR, -0.014, -0.022, 0.026, 0.007, 0.008, 0.005);
    mk(G.box, M.lash, eyeL, 0, 0.036, 0.022, 0.06, 0.008, 0.01);
    mk(G.box, M.lash, eyeR, 0, 0.036, 0.022, 0.06, 0.008, 0.01);

    const browL = mk(G.box, M.brow, head, 0.085, 0.135, 0.205, 0.07, 0.012, 0.012);
    const browR = mk(G.box, M.brow, head, -0.085, 0.135, 0.205, 0.07, 0.012, 0.012);
    browL.rotation.z = -0.15; browR.rotation.z = 0.15;

    mk(G.cone, M.skin, head, 0, -0.02, 0.235, 0.015, 0.02, 0.02).rotation.x = Math.PI/2;
    const mouth = mk(G.box, M.lash, head, 0, -0.10, 0.215, 0.045, 0.008, 0.008);

    const blushL = mk(G.plane, flat(0xff8899, { transparent: true, opacity: 0 }), head, 0.14, -0.03, 0.20, 0.07, 0.05, 1);
    const blushR = mk(G.plane, flat(0xff8899, { transparent: true, opacity: 0 }), head, -0.14, -0.03, 0.20, 0.07, 0.05, 1);

    for (const side of [1, -1]){
      const ear = mk(G.cone, M.skin, head, side*0.235, 0.03, -0.02, 0.04, 0.12, 0.05);
      ear.rotation.z = side * -0.25;
      ear.rotation.x = -0.15;
    }

    // ============================================================
    //  HAIR
    // ============================================================
    mk(G.sphere, M.hair, head, 0, 0.10, -0.02, 0.25, 0.24, 0.26);
    mk(G.sphere, M.hair, head, 0, 0.05, -0.14, 0.22, 0.22, 0.14);

    // Bangs
    for (let i = 0; i < 5; i++){
      const a = (i - 2) * 0.35;
      const b = mk(G.cone, M.hair, head, Math.sin(a)*0.18, 0.10, 0.20 + Math.cos(a)*0.02, 0.05, 0.16, 0.03);
      b.rotation.x = -0.3 + Math.random()*0.15;
      b.rotation.z = -a * 0.5;
    }

    mk(G.capsule, M.hair, head, 0.20, -0.05, 0.02, 0.045, 0.20, 0.045);
    mk(G.capsule, M.hair, head, -0.20, -0.05, 0.02, 0.045, 0.20, 0.045);

    // Long hair chain (5 segmen berayun)
    const hairRoot = grp(head, 0, 0.08, -0.20);
    const hairSegs = [];
    {
      let p = hairRoot;
      for (let i = 0; i < 5; i++){
        const s = grp(p, 0, i === 0 ? -0.10 : -0.20, 0);
        mk(G.capsule, M.hair, s, 0, -0.11, 0, 0.13 - i*0.012, 0.13, 0.11);
        hairSegs.push(s);
        p = s;
      }
      const tuft = mk(G.cone, M.hair, p, 0, -0.20, 0, 0.10, 0.18, 0.10);
      tuft.rotation.x = Math.PI;
    }

    // Hair bow
    {
      const bow = grp(head, 0.20, 0.15, -0.08);
      bow.rotation.z = -0.4;
      mk(G.box, M.accent, bow, 0.08, 0, 0, 0.14, 0.10, 0.02).rotation.z = 0.4;
      mk(G.box, M.accentLt, bow, -0.08, 0, 0, 0.14, 0.10, 0.02).rotation.z = -0.4;
      mk(G.sphere, M.trim, bow, 0, 0, 0, 0.035, 0.035, 0.025);
    }

    // ============================================================
    //  KATANA + SHEATH
    // ============================================================
    const weaponMount = grp(armR.hand, 0, -0.06, 0.03);

    const sheath = grp(pelvis, -0.12, -0.04, -0.14);
    sheath.rotation.x = -0.3;
    sheath.rotation.z = 0.5;
    mk(G.cyl, M.sheath, sheath, 0, -0.30, 0, 0.035, 0.55, 0.035);
    mk(G.box, M.guard, sheath, 0, 0.02, 0, 0.06, 0.05, 0.06);

    const katana = new THREE.Group();
    mk(G.cyl, M.handle, katana, 0, -0.14, 0, 0.026, 0.26, 0.026);
    for (let i = 0; i < 5; i++){
      const wrap = mk(G.torus, M.accent, katana, 0, -0.24 + i*0.05, 0, 0.032, 0.032, 0.01);
      wrap.rotation.x = Math.PI/2;
      wrap.rotation.z = i * 0.6;
    }
    mk(G.sphere, M.trim, katana, 0, -0.28, 0, 0.035, 0.035, 0.035);
    mk(G.cyl, M.guard, katana, 0, -0.01, 0, 0.10, 0.015, 0.10);
    mk(G.box, M.blade, katana, 0, 0.55, 0, 0.045, 1.10, 0.020);
    mk(G.box, M.bladeEdge, katana, 0.022, 0.55, 0.006, 0.008, 1.10, 0.016);
    mk(G.cone, M.blade, katana, 0, 1.16, 0, 0.040, 0.14, 0.018);

    const bladeTip  = sock(katana, 0.022, 1.22, 0.008);
    const bladeBase = sock(katana, 0, 0.02, 0);
    weaponMount.add(katana);
    weaponMount.rotation.x = -Math.PI/2;

    const sockets = {
      handR: armR.hand, handL: armL.hand,
      head, chest, pelvis,
      footL: legL.foot, footR: legR.foot,
      bladeTip, bladeBase
    };

    // ============================================================
    //  ANIMATION STATE
    // ============================================================
    const cur = makePose();
    const tgt = makePose();

    let _state = 'idle', _stateT = 0, _phase = 0;
    let _blink = 1.4 + Math.random()*2.5, _blinkT = 0, _breath = 0;
    let _expression = 'normal', _exprT = 0;

    const _p = { speed: 0, airborne: false, vy: 0, sprint: false };
    const _hold = { name: null, t: 0, dur: 0, variant: null };

    const ACTION_DUR = {
      dodge: 0.44, parry: 0.38, hurt: 0.40, land: 0.30,
      draw: 0.55, sheathe: 0.60, ult: 2.0, victory: 1.8,
      dead: 1.2, cast: 0.7
    };
    const ATTACK_DUR = { slash1: 0.34, slash2: 0.34, slash3: 0.42, iai: 0.55, spin: 0.66, aerial: 0.50 };

    function play(name, dur){
      _hold.name = name;
      _hold.t = 0;
      _hold.dur = dur !== undefined ? dur : (ACTION_DUR[name] || 0.5);
      _hold.variant = null;
    }
    function playAttack(v){
      _hold.name = 'attack';
      _hold.variant = v || 'slash1';
      _hold.t = 0;
      _hold.dur = ATTACK_DUR[_hold.variant] || 0.4;
    }
    function playExpression(name, dur){
      _expression = name;
      _exprT = dur !== undefined ? dur : 2.0;
    }

    // ============================================================
    //  POSE GENERATOR
    // ============================================================
    function setPose(o, st, t, p, u, variant){
      clearPose(o);
      const S = Math.sin, C = Math.cos;
      const spd = p.speed;
      const sprinting = p.sprint && spd > 0.2;
      const amp = sprinting ? 1.3 : 1.0;

      const hairFlow = (base, sf) => {
        const w = t * (1.5 + sf * 2);
        o.hair0 = base*0.55 + S(w)*0.04;
        o.hair1 = base*0.85 + S(w+0.4)*0.06;
        o.hair2 = base*1.10 + S(w+0.8)*0.08;
        o.hair3 = base*1.30 + S(w+1.2)*0.10;
        o.hair4 = base*1.45 + S(w+1.6)*0.12;
        o.hairY = S(t*1.3)*0.06;
      };
      const skirtFlow = (base) => {
        o.skirt0 = base + S(t*2.0)*0.03;
        o.skirt1 = base + S(t*2.0+1.5)*0.03;
        o.skirt2 = base + S(t*2.0+3.0)*0.03;
        o.skirt3 = base + S(t*2.0+4.5)*0.03;
      };
      const ribbonFlow = (base) => {
        o.ribbon0 = base + S(t*2.2)*0.06;
        o.ribbon1 = base*1.3 + S(t*2.2+0.8)*0.09;
      };

      switch (st){
        case 'idle': {
          _breath = t * 1.4;
          const br = S(_breath);
          o.pelPY = br * 0.008;
          o.spRX = 0.02 + br*0.012;
          o.chRX = 0.025 + br*0.02;
          o.nkRX = -0.03 - br*0.01;
          o.hdRY = S(t*0.4)*0.12;
          o.shLx = 0.05 + br*0.015; o.shLz = 0.10;
          o.shRx = 0.05 + br*0.015; o.shRz = -0.10;
          o.elLx = -0.22; o.elRx = -0.22;
          o.hipLx = 0.02; o.hipRx = 0.02;
          o.knLx = 0.03; o.knRx = 0.03;
          o.pelRY = S(t*0.3)*0.03;
          hairFlow(0.10, 0); skirtFlow(0.05); ribbonFlow(0.08);
          break;
        }
        case 'walk': {
          const s = S(_phase), c = C(_phase);
          o.pelPY = Math.abs(s)*0.026 - 0.014;
          o.pelRY = s*0.055; o.pelRZ = c*0.025;
          o.spRX = 0.05; o.chRY = -s*0.13;
          o.hipLx = -s*0.48*amp; o.knLx = Math.max(0,s)*0.55+0.06; o.anLx = 0.13 + s*0.16;
          o.hipRx =  s*0.48*amp; o.knRx = Math.max(0,-s)*0.55+0.06; o.anRx = 0.13 - s*0.16;
          o.shLx = s*0.38*amp; o.elLx = -0.30;
          o.shRx = -s*0.38*amp; o.elRx = -0.30;
          o.shLz = 0.10; o.shRz = -0.10;
          hairFlow(0.20 + spd*0.01, 0.5); skirtFlow(0.08); ribbonFlow(0.15);
          break;
        }
        case 'run': {
          const s = S(_phase);
          o.pelPY = Math.abs(s)*0.05 - 0.026;
          o.pelRY = s*0.09;
          o.spRX = 0.15; o.chRX = 0.09; o.chRY = -s*0.24;
          o.hdRX = -0.10;
          o.hipLx = -s*0.82*amp; o.knLx = Math.max(0,s)*1.05+0.18; o.anLx = 0.20 + s*0.24;
          o.hipRx =  s*0.82*amp; o.knRx = Math.max(0,-s)*1.05+0.18; o.anRx = 0.20 - s*0.24;
          o.shLx = s*0.75*amp; o.elLx = -1.0;
          o.shRx = -s*0.75*amp; o.elRx = -1.0;
          o.shLz = 0.15; o.shRz = -0.15;
          hairFlow(0.55 + spd*0.02, 1.0); skirtFlow(0.18); ribbonFlow(0.40);
          break;
        }
        case 'sprint': {
          const s = S(_phase);
          o.pelPY = Math.abs(s)*0.058 - 0.036;
          o.pelRY = s*0.11;
          o.spRX = 0.28; o.chRX = 0.15; o.chRY = -s*0.32;
          o.nkRX = -0.20; o.hdRX = -0.18;
          o.hipLx = -s*1.0; o.knLx = Math.max(0,s)*1.30+0.26;
          o.hipRx =  s*1.0; o.knRx = Math.max(0,-s)*1.30+0.26;
          o.shLx = s*0.95; o.elLx = -1.30;
          o.shRx = -s*0.95; o.elRx = -1.30;
          o.shLz = 0.20; o.shRz = -0.20;
          hairFlow(0.90 + spd*0.03, 1.5); skirtFlow(0.28); ribbonFlow(0.70);
          break;
        }
        case 'jump': {
          o.pelPY = 0.04; o.spRX = -0.10; o.hdRX = -0.15;
          o.hipLx = -0.55; o.knLx = 0.90;
          o.hipRx = -0.30; o.knRx = 0.60;
          o.shLx = -0.80; o.elLx = -0.55;
          o.shRx = -1.0;  o.elRx = -0.70;
          o.shLz = 0.32; o.shRz = -0.42;
          hairFlow(1.10, 2.0); skirtFlow(0.35); ribbonFlow(0.80);
          break;
        }
        case 'fall': {
          o.spRX = 0.05; o.chRX = 0.10;
          o.hipLx = -0.32; o.knLx = 0.45;
          o.hipRx =  0.16; o.knRx = 0.26;
          o.shLx = -0.20; o.elLx = -0.85;
          o.shRx = -0.28; o.elRx = -0.95;
          o.shLz = 0.50; o.shRz = -0.50;
          hairFlow(1.30, 2.5); skirtFlow(0.42); ribbonFlow(0.95);
          break;
        }
        case 'attack': {
          const w = seg(u, 0, 0.28);
          const s = seg(u, 0.28, 0.55);
          const r = seg(u, 0.55, 1);
          const we = ease(w), se = easeOut(s), re = ease(r);

          if (variant === 'slash1'){
            o.spRY = kf(we,-0.55, se, 0.65, re);
            o.chRY = kf(we,-0.32, se, 0.38, re);
            o.shRx = kf(we,-0.70, se,-0.15, re);
            o.shRz = kf(we,-1.40, se, 0.65, re);
            o.elRx = kf(we,-1.30, se,-0.15, re);
            o.shLx = kf(we, 0.30, se,-0.45, re); o.shLz = 0.28;
            o.hipRx = kf(we, 0.10, se,-0.28, re);
            o.pelRY = kf(we,-0.22, se, 0.28, re);
            o.wpz   = kf(we, 0.25, se,-0.50, re);
          } else if (variant === 'slash2'){
            o.spRY = kf(we, 0.55, se,-0.65, re);
            o.chRY = kf(we, 0.34, se,-0.40, re);
            o.shRx = kf(we,-0.90, se,-0.30, re);
            o.shRz = kf(we, 0.95, se,-0.85, re);
            o.elRx = kf(we,-1.50, se,-0.25, re);
            o.shLx = kf(we, 0.10, se,-0.30, re);
            o.hipLx = kf(we, 0.12, se,-0.30, re);
            o.wpz   = kf(we, 0.35, se,-0.60, re);
          } else if (variant === 'slash3'){
            o.shRx = kf(we,-2.20, se,-0.10, re);
            o.shRz = kf(we,-0.35, se, 0.05, re);
            o.elRx = kf(we,-1.60, se,-0.08, re);
            o.shLx = kf(we,-1.50, se,-0.20, re);
            o.spRX = kf(we,-0.26, se, 0.45, re);
            o.chRX = kf(we,-0.20, se, 0.32, re);
            o.hdRX = kf(we,-0.30, se, 0.26, re);
            o.hipLx = kf(we, 0.05, se,-0.45, re);
            o.knLx  = kf(we, 0.10, se, 0.55, re);
            o.pelPY = kf(we, 0.02, se,-0.12, re);
            o.wpx   = kf(we, 0.30, se,-0.55, re);
          } else if (variant === 'iai'){
            const w2 = seg(u, 0, 0.35);
            const s2 = seg(u, 0.35, 0.55);
            const r2 = seg(u, 0.55, 1);
            o.pelPY = kf(ease(w2), -0.15, easeOut(s2), 0.05, ease(r2));
            o.knLx  = kf(ease(w2),  0.55, 0, 0.15, ease(r2));
            o.knRx  = kf(ease(w2),  0.55, 0, 0.15, ease(r2));
            o.hipLx = kf(ease(w2),  0.30, 0,-0.20, ease(r2));
            o.hipRx = kf(ease(w2), -0.15, 0, 0.10, ease(r2));
            o.spRY  = kf(ease(w2),  0.60, easeOut(s2),-0.80, ease(r2));
            o.chRY  = kf(ease(w2),  0.42, easeOut(s2),-0.55, ease(r2));
            o.shRx  = kf(ease(w2),  0.10, easeOut(s2),-1.90, ease(r2));
            o.shRz  = kf(ease(w2),  0.45, easeOut(s2),-0.55, ease(r2));
            o.elRx  = kf(ease(w2), -0.55, easeOut(s2),-0.05, ease(r2));
            o.shLx  = kf(ease(w2), -0.30, easeOut(s2),-0.80, ease(r2));
            o.shLz = 0.35; o.elLx = -0.85;
            o.hdRY = kf(ease(w2), 0.30, easeOut(s2),-0.35, ease(r2));
            o.wpz  = kf(ease(w2), 0.50, easeOut(s2),-0.60, ease(r2));
          } else if (variant === 'spin'){
            o.rootRY = kf(we,-0.6, se, Math.PI*2.2, re);
            o.shRx = -1.50; o.shRz = -0.55; o.elRx = -0.35;
            o.shLx = -1.50; o.shLz =  0.55; o.elLx = -0.35;
            o.spRX = kf(we,-0.12, se, 0.20, re);
            o.hipLx = kf(we,-0.12, se, 0.45, re);
            o.hipRx = kf(we, 0.12, se,-0.45, re);
            o.pelRY = kf(we,-0.28, se, 0.32, re);
          } else if (variant === 'aerial'){
            o.shRx = kf(we,-2.5, se,-1.4, re);
            o.shRz = -0.30;
            o.elRx = kf(we,-1.55, se,-0.15, re);
            o.shLx = kf(we,-0.90, se,-1.30, re); o.shLz = 0.55;
            o.spRX = kf(we,-0.25, se, 0.55, re);
            o.chRX = kf(we,-0.20, se, 0.40, re);
            o.hipLx = kf(we,-0.85, se,-0.65, re);
            o.knLx  = kf(we, 1.20, se, 0.90, re);
            o.hipRx = kf(we,-0.45, se,-0.35, re);
            o.knRx  = kf(we, 0.90, se, 0.75, re);
            o.pelPY = kf(we,-0.05, se, 0.10, re);
            o.wpz   = kf(we, 0.40, se,-0.75, re);
          }
          hairFlow(0.55 + s*0.35, 1.2); skirtFlow(0.22 + s*0.15); ribbonFlow(0.55 + s*0.25);
          break;
        }
        case 'dodge': {
          const w = seg(u, 0, 0.22), r = seg(u, 0.5, 1);
          o.spRX = kf(ease(w), 0.55, 0, 0, ease(r));
          o.chRX = 0.30; o.nkRX = -0.40; o.hdRX = -0.28;
          o.shLx = -1.5; o.shLz = 0.30; o.elLx = -1.15;
          o.shRx =  1.0; o.shRz = -0.25; o.elRx = -1.55;
          o.hipLx = kf(ease(w), 0.75, 0, 0, ease(r));
          o.hipRx = kf(ease(w),-0.85, 0, 0, ease(r));
          o.knLx = 1.25; o.knRx = 0.55;
          o.pelPY = -0.10;
          hairFlow(1.20, 2.0); skirtFlow(0.35); ribbonFlow(0.85);
          break;
        }
        case 'parry': {
          const w = seg(u, 0, 0.20), s = seg(u, 0.20, 0.45), r = seg(u, 0.45, 1);
          o.shRx = kf(ease(w),-1.80, ease(s),-1.10, ease(r));
          o.shRz = kf(ease(w), 0.55, ease(s), 0.85, ease(r));
          o.elRx = kf(ease(w),-2.0, ease(s),-2.35, ease(r));
          o.shLx = kf(ease(w),-0.35, ease(s),-1.15, ease(r));
          o.shLz = 0.45; o.elLx = -1.75;
          o.spRY = kf(ease(w), 0.35, ease(s), 0.55, ease(r));
          o.chRY = kf(ease(w), 0.22, ease(s), 0.34, ease(r));
          o.pelRY = kf(ease(w), 0.18, ease(s), 0.26, ease(r));
          o.knLx = 0.40; o.knRx = 0.28;
          o.pelPY = kf(ease(w),-0.03, ease(s),-0.06, ease(r));
          o.wpx = -0.30;
          hairFlow(0.35, 0); skirtFlow(0.10); ribbonFlow(0.20);
          break;
        }
        case 'draw': {
          const w = seg(u, 0, 0.5), s = seg(u, 0.5, 0.75), r = seg(u, 0.75, 1);
          o.shRx = kf(ease(w), 0.55, easeOut(s),-1.80, ease(r));
          o.shRz = kf(ease(w), 0.85, easeOut(s), 0.15, ease(r));
          o.elRx = kf(ease(w),-0.55, easeOut(s),-0.25, ease(r));
          o.shLx = kf(ease(w),-0.15, easeOut(s),-0.55, ease(r));
          o.shLz = 0.30; o.elLx = -0.65;
          o.spRY = kf(ease(w), 0.55, easeOut(s),-0.20, ease(r));
          o.chRY = kf(ease(w), 0.35, easeOut(s),-0.15, ease(r));
          o.wpz  = kf(ease(w), 0.55, easeOut(s),-0.35, ease(r));
          hairFlow(0.25, 0); skirtFlow(0.08); ribbonFlow(0.15);
          break;
        }
        case 'sheathe': {
          const w = seg(u, 0, 0.5), r = seg(u, 0.5, 1);
          o.shRx = kf(ease(w),-1.60, 0, 0.55, ease(r));
          o.shRz = kf(ease(w), 0.15, 0, 0.85, ease(r));
          o.elRx = kf(ease(w),-0.35, 0,-0.55, ease(r));
          o.shLx = 0.05; o.shLz = 0.10; o.elLx = -0.35;
          o.wpz = kf(ease(w),-0.35, 0, 0.55, ease(r));
          break;
        }
        case 'ult': {
          const w = seg(u, 0, 0.30), s = seg(u, 0.30, 0.70), r = seg(u, 0.82, 1);
          o.rootRY = kf(ease(w),-0.35, ease(s), Math.PI*2.6, ease(r));
          o.shRx = kf(ease(w),-2.40, ease(s),-1.15, ease(r));
          o.shRz = kf(ease(w),-0.55, ease(s), 0.15, ease(r));
          o.elRx = kf(ease(w),-1.35, ease(s),-0.20, ease(r));
          o.shLx = kf(ease(w),-2.0,  ease(s),-0.95, ease(r));
          o.shLz = kf(ease(w), 0.55, ease(s), 0.25, ease(r));
          o.elLx = -0.85;
          o.spRX = kf(ease(w),-0.32, ease(s), 0.12, ease(r));
          o.chRX = kf(ease(w),-0.24, ease(s), 0.08, ease(r));
          o.hdRX = kf(ease(w),-0.42, ease(s), 0.12, ease(r));
          o.hipLx = kf(ease(w),-0.20, ease(s), 0.45, ease(r));
          o.hipRx = kf(ease(w), 0.20, ease(s),-0.45, ease(r));
          o.knLx  = kf(ease(w), 0.35, ease(s), 0.15, ease(r));
          o.knRx  = kf(ease(w), 0.35, ease(s), 0.15, ease(r));
          o.pelPY = kf(ease(w),-0.14, ease(s), 0.10, ease(r));
          hairFlow(1.5 + s*0.5, 3.0); skirtFlow(0.45); ribbonFlow(1.15);
          break;
        }
        case 'hurt': {
          const w = seg(u, 0, 0.18), r = seg(u, 0.35, 1);
          o.spRX = kf(ease(w),-0.55, 0, 0, ease(r));
          o.chRX = kf(ease(w),-0.32, 0, 0, ease(r));
          o.nkRX = kf(ease(w),-0.35, 0, 0, ease(r));
          o.hdRX = kf(ease(w),-0.45, 0, 0, ease(r));
          o.shLx = kf(ease(w),-0.95, 0, 0, ease(r)); o.shLz = 0.55;
          o.shRx = kf(ease(w),-0.85, 0, 0, ease(r)); o.shRz = -0.55;
          o.elLx = -1.15; o.elRx = -1.05;
          o.hipLx = kf(ease(w),-0.35, 0, 0, ease(r));
          o.hipRx = kf(ease(w),-0.20, 0, 0, ease(r));
          o.knLx = 0.55; o.knRx = 0.42;
          o.rootPZ = kf(ease(w),-0.10, 0, 0, ease(r));
          hairFlow(0.40, 0); skirtFlow(0.15); ribbonFlow(0.30);
          break;
        }
        case 'land': {
          const w = seg(u, 0, 0.22), r = seg(u, 0.35, 1);
          o.pelPY = kf(ease(w),-0.26, 0, 0, ease(r));
          o.spRX = kf(ease(w), 0.34, 0, 0, ease(r));
          o.chRX = kf(ease(w), 0.22, 0, 0, ease(r));
          o.hipLx = kf(ease(w),-0.70, 0, 0, ease(r));
          o.hipRx = kf(ease(w),-0.70, 0, 0, ease(r));
          o.knLx  = kf(ease(w), 1.35, 0, 0, ease(r));
          o.knRx  = kf(ease(w), 1.35, 0, 0, ease(r));
          o.anLx = 0.45; o.anRx = 0.45;
          o.shLx = kf(ease(w), 0.65, 0, 0, ease(r)); o.shLz = 0.40;
          o.shRx = kf(ease(w), 0.65, 0, 0, ease(r)); o.shRz = -0.40;
          o.elLx = -0.70; o.elRx = -0.70;
          hairFlow(0.75, 1.5); skirtFlow(0.28); ribbonFlow(0.55);
          break;
        }
        case 'victory': {
          const w = seg(u, 0, 0.30);
          o.shRx = kf(ease(w),-2.60, 0, 0, 0);
          o.shRz = kf(ease(w),-0.15, 0, 0, 0);
          o.elRx = -0.15;
          o.shLx = kf(ease(w),-0.55, 0, 0, 0);
          o.shLz = 0.65; o.elLx = -1.25;
          o.spRX = -0.16; o.chRX = -0.10; o.hdRX = -0.32;
          o.pelPY = S(t*3.0)*0.028;
          o.rootRY = S(t*0.9)*0.18;
          hairFlow(0.60 + S(t*2.0)*0.10, 0.5); skirtFlow(0.12); ribbonFlow(0.35);
          break;
        }
        case 'dead': {
          const w = ease(seg(u, 0, 0.8));
          o.rootRX = w*1.40; o.rootPY = w*-0.62;
          o.spRX = w*-0.25; o.chRX = w*-0.15; o.hdRX = w*0.35;
          o.hipLx = w*0.55; o.hipRx = w*0.45;
          o.knLx  = w*1.25; o.knRx  = w*1.05;
          o.shLx = w*-1.35; o.shLz = 0.70;
          o.shRx = w*-1.15; o.shRz = -0.70;
          hairFlow(0.9*w, 0); skirtFlow(0.30*w); ribbonFlow(0.50*w);
          break;
        }
        case 'cast': {
          const w = seg(u, 0, 0.35), r = seg(u, 0.55, 1);
          o.shLx = kf(ease(w),-2.10, 0, 0, ease(r));
          o.shLz = kf(ease(w), 0.45, 0, 0, ease(r));
          o.elLx = kf(ease(w),-0.45, 0, 0, ease(r));
          o.shRx = kf(ease(w),-0.75, 0, 0, ease(r));
          o.shRz = -0.70; o.elRx = -1.35;
          o.spRX = kf(ease(w),-0.12, 0, 0, ease(r));
          o.hdRX = kf(ease(w),-0.25, 0, 0, ease(r));
          hairFlow(0.45, 0); skirtFlow(0.12); ribbonFlow(0.25);
          break;
        }
        default: break;
      }
    }

    // ============================================================
    //  APPLY POSE → BONES
    // ============================================================
    function applyPose(o){
      body.position.y = o.rootPY;
      body.position.z = o.rootPZ;
      body.rotation.set(o.rootRX, o.rootRY, o.rootRZ);
      pelvis.position.y = PELVIS_Y + o.pelPY;
      pelvis.rotation.set(o.pelRX, o.pelRY, o.pelRZ);
      spine.rotation.set(o.spRX, o.spRY, o.spRZ);
      chest.rotation.set(o.chRX, o.chRY, o.chRZ);
      neck.rotation.set(o.nkRX, o.nkRY, o.nkRZ);
      head.rotation.set(o.hdRX, o.hdRY, o.hdRZ);

      armL.shoulder.rotation.set(o.shLx, o.shLy, o.shLz);
      armL.elbow.rotation.set(o.elLx, 0, o.elLz);
      armL.hand.rotation.x = o.wrLx;
      armR.shoulder.rotation.set(o.shRx, o.shRy, o.shRz);
      armR.elbow.rotation.set(o.elRx, 0, o.elRz);
      armR.hand.rotation.x = o.wrRx;

      legL.hip.rotation.set(o.hipLx, 0, o.hipLz);
      legL.knee.rotation.x = o.knLx;
      legL.foot.rotation.x = o.anLx;
      legR.hip.rotation.set(o.hipRx, 0, o.hipRz);
      legR.knee.rotation.x = o.knRx;
      legR.foot.rotation.x = o.anRx;

      if (hairSegs[0]) hairSegs[0].rotation.x = o.hair0;
      if (hairSegs[1]) hairSegs[1].rotation.x = o.hair1;
      if (hairSegs[2]) hairSegs[2].rotation.x = o.hair2;
      if (hairSegs[3]) hairSegs[3].rotation.x = o.hair3;
      if (hairSegs[4]) hairSegs[4].rotation.x = o.hair4;
      if (hairSegs[0]) hairSegs[0].rotation.y = o.hairY;

      if (skirtSegs[0]) skirtSegs[0].rotation.x = o.skirt0;
      if (skirtSegs[1]) skirtSegs[1].rotation.x = o.skirt1;
      if (skirtSegs[2]) skirtSegs[2].rotation.x = o.skirt2;
      if (skirtSegs[3]) skirtSegs[3].rotation.x = o.skirt3;

      if (ribbonSegs[0]) ribbonSegs[0].rotation.x = o.ribbon0;
      if (ribbonSegs[1]) ribbonSegs[1].rotation.x = o.ribbon1;

      weaponMount.rotation.x = -Math.PI/2 + o.wpx;
      weaponMount.rotation.z = o.wpz;
    }

    // ============================================================
    //  EXPRESSION
    // ============================================================
    function updateExpression(dt){
      if (_exprT > 0){
        _exprT -= dt;
        if (_exprT <= 0) _expression = 'normal';
      }
      let browY = 0, browTilt = 0, eyeY = 1, mouthScale = 1, blushOp = 0;
      switch (_expression){
        case 'smile':    browY = 0.005; mouthScale = 1.8; blushOp = 0.5; break;
        case 'angry':    browTilt = 0.35; browY = -0.008; mouthScale = 0.7; break;
        case 'surprise': browY = 0.015; eyeY = 1.2; mouthScale = 1.6; break;
        case 'blush':    blushOp = 0.8; mouthScale = 0.8; break;
        case 'sad':      browY = -0.008; browTilt = -0.3; mouthScale = 0.6; break;
      }
      browL.position.y = 0.135 + browY;
      browR.position.y = 0.135 + browY;
      browL.rotation.z = -0.15 + browTilt;
      browR.rotation.z =  0.15 - browTilt;
      eyeL.scale.y = eyeY; eyeR.scale.y = eyeY;
      mouth.scale.set(mouthScale, 1, 1);
      blushL.material.opacity += (blushOp - blushL.material.opacity) * Math.min(1, dt*6);
      blushR.material.opacity = blushL.material.opacity;
    }

    // ============================================================
    //  UPDATE
    // ============================================================
    function pickLocomotion(){
      if (_p.airborne) return _p.vy > 0.4 ? 'jump' : 'fall';
      const sp = _p.speed;
      if (sp > 5.6) return 'sprint';
      if (sp > 2.6) return 'run';
      if (sp > 0.20) return 'walk';
      return 'idle';
    }

    function update(dt, params){
      if (dt > 0.06) dt = 0.06;
      if (params){
        if (params.speed !== undefined) _p.speed = params.speed;
        if (params.airborne !== undefined) _p.airborne = params.airborne;
        if (params.vy !== undefined) _p.vy = params.vy;
        if (params.sprint !== undefined) _p.sprint = params.sprint;
      }
      const strideRate = _p.speed > 5.6 ? 2.5 : (_p.speed > 2.6 ? 2.0 : 1.5);
      _phase += _p.speed * dt * strideRate;

      if (_hold.name){
        _hold.t += dt;
        if (_hold.t >= _hold.dur){ _hold.name = null; _hold.t = 0; }
      }

      const next = _hold.name || pickLocomotion();
      if (next !== _state){ _state = next; _stateT = 0; } else _stateT += dt;

      const u = _hold.name ? clamp(_hold.t / _hold.dur, 0, 1) : 0;
      setPose(tgt, _state, _stateT, _p, u, _hold.variant);
      const rate = _hold.name ? 30 : (_state === 'idle' ? 8 : 14);
      const a = 1 - Math.exp(-rate * dt);
      lerpPose(cur, tgt, a);
      applyPose(cur);

      _blink -= dt;
      if (_blink <= 0){ _blinkT = 0.11; _blink = 2.2 + Math.random()*4.0; }
      let eyeScale = 1;
      if (_blinkT > 0){ _blinkT -= dt; eyeScale = 0.10; }
      eyeL.scale.y = eyeScale;
      eyeR.scale.y = eyeScale;

      updateExpression(dt);
      if (_state === 'idle') head.rotation.y += Math.sin(_stateT * 0.6) * 0.02;
    }

    // ============================================================
    //  PUBLIC API
    // ============================================================
    const api = {
      root,
      VERSION: '1.0',

      setPosition(x,y,z){ root.position.set(x,y,z); return api; },
      getPosition(out){ return out ? out.copy(root.position) : root.position.clone(); },
      setFacing(yaw){ root.rotation.y = yaw; return api; },
      setScale(s){ root.scale.setScalar(s); return api; },
      setVisible(v){ root.visible = !!v; return api; },

      update, play, playAttack, playExpression,
      setState(name, dur){
        _hold.name = name || null;
        _hold.t = 0;
        _hold.dur = dur !== undefined ? dur : (ACTION_DUR[name] || 0.5);
        _hold.variant = null;
      },
      isBusy(){ return !!_hold.name; },
      getState(){ return _state; },
      getExpression(){ return _expression; },

      setTint(hex){ M.outfit.color.setHex(hex); return api; },
      setAccent(hex){
        M.accent.color.setHex(hex);
        M.accent.emissive.setHex(hex);
        return api;
      },
      setHair(hex){
        M.hair.color.setHex(hex);
        M.hairHi.color.setHex(new THREE.Color(hex).lerp(new THREE.Color(0xffffff),0.35).getHex());
        return api;
      },

      getSocket(name){ return sockets[name] || null; },
      getBone(name){
        const map = {
          pelvis, spine, chest, neck, head,
          armL: armL.shoulder, armR: armR.shoulder,
          handL: armL.hand, handR: armR.hand,
          legL: legL.hip, legR: legR.hip,
          footL: legL.foot, footR: legR.foot
        };
        return map[name] || null;
      },
      setShadows(on){
        root.traverse(o => { if (o.isMesh) o.castShadow = !!on; });
      },
      dispose(){
        root.traverse(o => {
          if (o.isMesh && o.geometry && !o.geometry.userData.__shared) o.geometry.dispose();
        });
        if (root.parent) root.parent.remove(root);
      },
      _pose: cur,
      _target: tgt
    };

    setPose(cur, 'idle', 0, _p, 0, null);
    applyPose(cur);
    return api;
  }

  return { create, VERSION: '1.0' };
})();

const playerGroup = new THREE.Group();
const playerBuild = buildHumanoid();
playerBuild.root.visible = false; // legacy pose proxy retained for existing gameplay hooks
playerGroup.add(playerBuild.root);
// v4.5 - ANIME HERO (SAKURA BLADE)
const ANIME_ALIAS = { dash:'dodge', overhead:'slash3', mine:'slash3', slashR:'slash1', slashL:'slash2', thrust:'iai' };
function wrapAnimeHero(hero){
  const _play = hero.play.bind(hero), _atk = hero.playAttack.bind(hero);
  hero.play = (n, d) => { _play(ANIME_ALIAS[n] || n, d); return hero; };
  hero.playAttack = (n, d) => { _atk(ANIME_ALIAS[n] || n, d); return hero; };
  hero.attachWeapon = () => hero;   // katana + sheath are built in
  hero.setArmorTier = () => hero;
  return hero;
}
const characterAnim = wrapAnimeHero(AnimeCharacter.create(THREE, {
  hairColor: 0x3f6cd8, outfitColor: 0x1a2540, accentColor: C.teal, skinTone: 0xffd9c0,
  quality: LOW ? 'low' : 'high', shadows: Q.shadows && v4.shadowOn
}));
playerGroup.add(characterAnim.root);
scene.add(playerGroup);

// ============================================================================
//  COMPANION (auto pet that fights for you)
// ============================================================================
const PET = { cd: 0, dirX: 1, dirZ: 0, leap: 0, phase: 0 };
const petGroup = new THREE.Group();
scene.add(petGroup);
const petFur = new THREE.MeshStandardMaterial({ color: 0xffe7cf, roughness: 0.72, metalness: 0.06, emissive: 0x5a4b3a, emissiveIntensity: 0.12 });
const petTrim = new THREE.MeshStandardMaterial({ color: C.teal, emissive: C.teal, emissiveIntensity: 0.95, roughness: 0.28, metalness: 0.82 });
const petBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.48, 5, LOW ? 8 : 12), petFur);
petBody.position.y = 0.68; petGroup.add(petBody);
const petHead = new THREE.Mesh(new THREE.SphereGeometry(0.24, LOW ? 8 : 12, 8), petFur);
petHead.position.set(0, 1.05, 0.18); petGroup.add(petHead);
const petSnout = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 8), petFur);
petSnout.rotation.x = -Math.PI/2; petSnout.position.set(0, 1.00, 0.38); petGroup.add(petSnout);
for (const side of [-1, 1]){
  const ear = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.18, 5), petFur);
  ear.position.set(side * 0.13, 1.27, 0.12);
  ear.rotation.z = side < 0 ? -0.7 : 0.7; petGroup.add(ear);
}
const petTail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.05, 0.38, 5), petFur);
petTail.position.set(0, 0.84, -0.42); petTail.rotation.x = 0.85; petGroup.add(petTail);
for (const side of [-1, 1]){
  const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.26, 3, LOW ? 6 : 8), petFur);
  leg.position.set(side * 0.12, 0.26, side < 0 ? 0.06 : -0.06); petGroup.add(leg);
}
for (const side of [-1, 1]){
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), petTrim);
  eye.position.set(side * 0.09, 1.09, 0.40); petGroup.add(eye);
}
if (!LOW){
  const petLight = new THREE.PointLight(C.teal, 0.6, 6, 2);
  petLight.position.y = 1.0; petGroup.add(petLight);
}
petGroup.scale.setScalar(1.24);
petGroup.position.set(0, 1, 0);

const petEyeGeo = new THREE.SphereGeometry(0.035, 6, 5);
scene.add(playerGroup);
const rig = playerBuild.rig;
let characterMoveSpeed = 0;

// Sword
const sword = new THREE.Group();
const sHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.35, 6),
  new THREE.MeshStandardMaterial({ color: 0x2a2340, roughness: 0.75 }));
sHandle.position.y = -0.10; sword.add(sHandle);
const sGuard = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.1),
  new THREE.MeshStandardMaterial({ color: 0xfcd34d, emissive: 0xfcd34d, emissiveIntensity: 0.3, metalness: 0.7, roughness: 0.35 }));
sGuard.position.y = 0.08; sword.add(sGuard);
const sBlade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, 0.09),
  new THREE.MeshStandardMaterial({ color: 0xdfe6ff, emissive: 0x3550a0, emissiveIntensity: 0.45, metalness: 0.9, roughness: 0.22 }));
sBlade.position.y = 0.82; sword.add(sBlade);
sword.rotation.x = Math.PI/2;
rig.armR.hand.add(sword);
const weaponShapes = {
  sword: { geo: new THREE.BoxGeometry(0.06, 1.4, 0.09), dmg: 1.0, reach: 3.2, name: 'Sword' },
  axe:   { geo: new THREE.BoxGeometry(0.08, 1.1, 0.32), dmg: 1.35, reach: 3.0, name: 'Axe' },
  spear: { geo: new THREE.BoxGeometry(0.05, 2.0, 0.05), dmg: 0.85, reach: 4.2, name: 'Spear' },
  voxel: { geo: new THREE.BoxGeometry(0.12, 1.2, 0.12), dmg: 0.95, reach: 3.0, name: 'Voxel Blade' }
};

// ============================================================================
//  SECTION: STATE
// ============================================================================
const state = {
  running: false, won: false, dead: false, paused: false,
  hp: 5, maxHp: 9,
  level: 1, xp: 0, xpNeeded: TUNING.xpBase,
  stamina: 1, ult: 0,
  corruption: 0, overload: 0,
  gems: 0, attacks: 0, crits: 0, enemiesKilled: 0, bossKills: 0, parries: 0,
  score: 0, combo: 1, comboTimer: 0, comboStep: 0,
  startT: 0, trauma: 0, velY: 0, grounded: true,
  atkCoeff: 1, weapon: 'sword',
  dashCd: 0, atkCd: 0, sprinting: false, dashing: false,
  invuln: 0, swing: 0, hurtPulse: 0,
  charging: false, chargeT: 0,
  parryActive: 0, parryCd: 0,
  hitstop: 0, slowmo: 0, killCam: 0,
  playerClass: 'blade',
  weather: 'clear', day: 0.35,
  killCount: 0,
  world: { biome: 'verdant', dimension: 'genesis' },
  achievements: {},
  distance: 0, totalTime: 0,
  fractureCd: 0, fractureCharges: 1,
  echoTimer: TUNING.echoInterval,
  echoRecorder: [], recordTimer: 0,
  rewindBuf: [], rewindTick: 0,
  threat: 0,
  // v4.0
  voxelUnlocked: false,
  voxelEnterCount: 0,
  hpGhost: 0,
  lockOn: null,
  hotbar: ['sword', null, null, null, null, null, null, null, null],
  hotbarIdx: 0,
  mining: null,
  mineProgress: 0,
  cinematic: 0,
  blink: 0,
  staminaArcVisible: false
};
const CLASSES = {
  blade: { hp:5, dmgMul:1.15, spdMul:1.0,  dashDist:5.0, name:'Bladeborn', color:0xfcd34d, comboMax: 4, parryBonus: 0.1 },
  void:  { hp:3, dmgMul:1.50, spdMul:1.15, dashDist:8.5, name:'Voidwalker', color:0xa78bfa, comboMax: 3, blink: true },
  ward:  { hp:10, dmgMul:0.90, spdMul:0.88, dashDist:3.6, name:'Warden', color:0x5eead4, comboMax: 3, shield: true },
  voxeleng: { hp:6, dmgMul:0.85, spdMul:1.0, dashDist:5.0, name:'Voxel Engineer', color:0x7ee787, comboMax: 3, fastMine: 2 }
};

// ============================================================================
//  SECTION: SAVE / LOAD v4 (migrasi)
// ============================================================================
const SAVE_KEY_V2 = 'realm_ultra_v2_save';
const SAVE_KEY_V3 = 'realm_ultra_v3_save';
const SAVE_KEY_V4 = 'realm_ultra_v4_save';
function encodeSave(obj){
  try {
    const json = JSON.stringify(obj);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64;
  } catch(e){ return JSON.stringify(obj); }
}
function decodeSave(str){
  try {
    const json = decodeURIComponent(escape(atob(str)));
    return JSON.parse(json);
  } catch(e){
    try { return JSON.parse(str); } catch(e2){ return null; }
  }
}
function saveGame(){
  const data = {
    v: 4,
    level: state.level, xp: state.xp,
    achievements: state.achievements,
    enemiesKilled: state.enemiesKilled, bossKills: state.bossKills,
    parries: state.parries, playerClass: state.playerClass,
    totalTime: state.totalTime, distance: state.distance,
    voxelUnlocked: state.voxelUnlocked,
    voxelEnterCount: state.voxelEnterCount,
    hotbar: state.hotbar,
    seed: dailySeed, ts: Date.now()
  };
  try { localStorage.setItem(SAVE_KEY_V4, encodeSave(data)); } catch(e){}
}
function loadSave(){
  try {
    let raw = localStorage.getItem(SAVE_KEY_V4);
    let data = raw ? decodeSave(raw) : null;
    if (data && data.v === 4) return data;
    // migrate v3
    raw = localStorage.getItem(SAVE_KEY_V3);
    if (raw){
      const v3Data = JSON.parse(raw);
      v3Data.v = 4;
      v3Data.voxelUnlocked = false;
      v3Data.voxelEnterCount = 0;
      v3Data.hotbar = ['sword', null, null, null, null, null, null, null, null];
      try { localStorage.setItem(SAVE_KEY_V4, encodeSave(v3Data)); } catch(e){}
      return v3Data;
    }
    // migrate v2
    raw = localStorage.getItem(SAVE_KEY_V2);
    if (raw){
      const v2Data = JSON.parse(raw);
      v2Data.v = 4;
      v2Data.voxelUnlocked = false;
      v2Data.voxelEnterCount = 0;
      v2Data.hotbar = ['sword', null, null, null, null, null, null, null, null];
      try { localStorage.setItem(SAVE_KEY_V4, encodeSave(v2Data)); } catch(e){}
      return v2Data;
    }
    return null;
  } catch(e){ return null; }
}
function refreshStatsUI(){
  const s = loadSave() || {};
  $('stTime').textContent = Math.round((s.totalTime || 0) / 60) + 'm';
  $('stKill').textContent = s.enemiesKilled || 0;
  $('stBest').textContent = localStorage.getItem('realm_max_best') ?
    parseFloat(localStorage.getItem('realm_max_best')).toFixed(1) + 's' : '-';
  $('stBoss').textContent = s.bossKills || 0;
  $('stParry').textContent = s.parries || 0;
  $('stMined').textContent = s.minedCount || 0;
  const ach = s.achievements || {};
  $('stAch').textContent = Object.values(ach).filter(Boolean).length + '/18';
  $('voxelUnlockStatus').textContent = s.voxelUnlocked ? 'Ya' : 'Belum';
  $('voxelModCount').textContent = voxelState.modifiedBlocks.size;
  if (s.voxelUnlocked) $('cardVoxel').classList.remove('locked');
}

// ============================================================================
//  SECTION: ACHIEVEMENTS (18)
// ============================================================================
const ACHIEVEMENTS = [
  { id:'first_blood', name:'First Blood', desc:'Bunuh musuh pertama' },
  { id:'combo5',      name:'Rampage', desc:'Capai combo x5' },
  { id:'bosskiller',  name:'Titan Slayer', desc:'Kalahkan satu boss' },
  { id:'parry10',     name:'Mirror', desc:'10 parry sukses' },
  { id:'crystals8',   name:'Crystal Hoarder', desc:'Kumpulkan 8 kristal' },
  { id:'speedrun60',  name:'Speed Demon', desc:'Selesai dalam <60 detik' },
  { id:'lvl5',        name:'Ascendant', desc:'Capai Level 5' },
  { id:'biome5',      name:'Wanderer', desc:'Kunjungi 5 biome Genesis' },
  { id:'stormchaser', name:'Storm Chaser', desc:'Selamat dari badai' },
  { id:'voidmaster',  name:'Void Master', desc:'Pakai ultimate 3x' },
  { id:'echo_slayer', name:'Echo Slayer', desc:'Kalahkan 3 Echo' },
  { id:'overload',    name:'Corrupted', desc:'Capai Overload Mode' },
  // v4.0 voxel
  { id:'voxel_first', name:'Voxel Pioneer', desc:'Place blok voxel pertama' },
  { id:'voxel_mine10', name:'Miner', desc:'Mine 10 blok voxel' },
  { id:'creeper_survivor', name:'Boomer', desc:'Selamat dari ledakan creeper' },
  { id:'enderman_slayer', name:'Void Watcher', desc:'Bunuh 5 Enderman' },
  { id:'dragon_slayer', name:'Dragonbane', desc:'Kalahkan Voxel Golem' },
  { id:'dimension_master', name:'Dimension Master', desc:'Masuk-keluar dimensi 3x' }
];
function unlockAch(id){
  if (state.achievements[id]) return;
  state.achievements[id] = true;
  const a = ACHIEVEMENTS.find(x => x.id === id);
  if (a) showToast('ACH ' + a.name + '  ' + KAO.happy, 'amber');
  const s = loadSave() || {};
  s.achievements = state.achievements;
  try { localStorage.setItem(SAVE_KEY_V4, encodeSave(s)); } catch(e){}
}
const biomesVisited = new Set();

// ============================================================================
//  SECTION: INPUT
// ============================================================================
const keys = {};
let yaw = 0, pitch = -0.22;
const yawUpdate = (dx) => { yaw -= dx * 0.0026 * v4.sensitivity; };
const pitchUpdate = (dy) => { pitch = clamp(pitch - dy * 0.0026 * v4.sensitivity, -0.6, 0.4); };

let lookTouchId = null, moveTouchId = null;
let lookLastX = 0, lookLastY = 0;
let stickOriginX = 0, stickOriginY = 0, stickX = 0, stickY = 0;
const STICK_DEADZONE = 12;

canvas.addEventListener('touchstart', (e) => {
  if (!state.running || state.paused) return;
  for (const t of e.changedTouches){
    if (t.clientX > innerWidth * 0.4){
      if (lookTouchId === null){
        lookTouchId = t.identifier;
        lookLastX = t.clientX; lookLastY = t.clientY;
      }
    } else {
      if (moveTouchId === null){
        moveTouchId = t.identifier;
        stickOriginX = t.clientX; stickOriginY = t.clientY;
        stickX = 0; stickY = 0;
      }
    }
  }
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
  if (!state.running || state.paused) return;
  e.preventDefault();
  for (const t of e.changedTouches){
    if (t.identifier === lookTouchId){
      yaw -= (t.clientX - lookLastX) * 0.0055 * v4.sensitivity;
      pitch = clamp(pitch - (t.clientY - lookLastY) * 0.0055 * v4.sensitivity, -0.6, 0.4);
      lookLastX = t.clientX; lookLastY = t.clientY;
    } else if (t.identifier === moveTouchId){
      stickX = t.clientX - stickOriginX;
      stickY = t.clientY - stickOriginY;
    }
  }
}, { passive: false });

function resetTouch(e){
  for (const t of e.changedTouches){
    if (t.identifier === lookTouchId) lookTouchId = null;
    else if (t.identifier === moveTouchId){ moveTouchId = null; stickX = stickY = 0; }
  }
}
canvas.addEventListener('touchend', resetTouch, { passive: true });
canvas.addEventListener('touchcancel', resetTouch, { passive: true });

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (!state.running || state.paused) return;
  if (e.code === 'Space' && state.grounded) {
    state.velY = TUNING.jumpVel * (state.world.dimension === 'voxel' ? TUNING.voxelJumpMult : 1);
    state.grounded = false; jumpBeep();
  }
  if (e.code === 'KeyE') tryDashOrInteract();
  if (e.code === 'KeyF') { if (!state.charging) { state.charging = true; state.chargeT = 0; } }
  if (e.code === 'KeyQ') tryParry();
  if (e.code === 'KeyR') tryUltimate();
  if (e.code === 'KeyZ') tryFracture();
  if (e.code === 'Tab') { e.preventDefault(); swapWeapon(); }
  if (e.code === 'KeyT') cycleWeather();
  if (e.code === 'KeyM') toggleMap();
  if (e.code === 'Escape') togglePause();
  if (e.code === 'Backquote') { $('dbg').classList.toggle('on'); }
  // hotbar keys
  if (e.code.startsWith('Digit')){
    const n = parseInt(e.code.slice(5)) - 1;
    if (n >= 0 && n < 9) selectHotbar(n);
  }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Tab'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyF') releaseAttack();
});
let dragging = false, lastMX = 0, lastMY = 0, plLocked = false;
canvas.addEventListener('mousedown', (e) => {
  lastMX = e.clientX; lastMY = e.clientY; dragging = true;
  canvas.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  plLocked = document.pointerLockElement === canvas;
  if (plLocked) dragging = false;
});
document.addEventListener('pointerlockerror', () => { dragging = true; plLocked = false; });
addEventListener('mousemove', (e) => {
  if (!state.running || state.paused) return;
  if (plLocked) { yawUpdate(-e.movementX); pitchUpdate(-e.movementY); }
  else if (dragging) {
    yawUpdate(-(e.clientX - lastMX)); pitchUpdate(-(e.clientY - lastMY));
    lastMX = e.clientX; lastMY = e.clientY;
  }
});
addEventListener('mouseup', () => { dragging = false; });

const padDown = {};
document.querySelectorAll('.pad').forEach((p) => {
  const k = p.dataset.k;
  if (!k) return;
  const start = (e) => {
    e.preventDefault();
    padDown[k] = true; p.classList.add('on');
    if (k === 'jump' && state.running && state.grounded) {
      state.velY = TUNING.jumpVel * (state.world.dimension === 'voxel' ? TUNING.voxelJumpMult : 1);
      state.grounded = false; jumpBeep();
    }
    if (k === 'dash') tryDashOrInteract();
    if (k === 'atk') { state.charging = true; state.chargeT = 0; }
    if (k === 'q') tryParry();
    if (k === 'r') tryUltimate();
    if (k === 'z') tryFracture();
    if (k === 'tab') swapWeapon();
    if (k === 'interact') tryInteract();
  };
  const stop = (e) => {
    e.preventDefault();
    padDown[k] = false; p.classList.remove('on');
    if (k === 'atk') releaseAttack();
  };
  p.addEventListener('pointerdown', start, { passive: false });
  ['pointerup','pointercancel','pointerleave','lostpointercapture'].forEach(ev => p.addEventListener(ev, stop, { passive: false }));
});

// ============================================================================
//  SECTION: AUDIO
// ============================================================================
let actx = null;
let musicLayers = null;
function ac(){
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch(e){}
  return actx;
}
function spatialTone(x, y, z, f, dur, type, vol, slide){
  if (!ac()) return;
  try {
    const panner = actx.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
    panner.refDistance = 2; panner.maxDistance = 55; panner.rolloffFactor = 1.4;
    if (panner.positionX){ panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z; }
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, actx.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, actx.currentTime + dur);
    g.gain.setValueAtTime(vol || 0.07, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g).connect(panner).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur + 0.02);
  } catch(e){}
}
function tone(f, dur, type, vol, delay, slide){
  if (!ac()) return;
  try {
    const t0 = actx.currentTime + (delay || 0);
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(vol || 0.07, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  } catch(e){}
}
function noiseBurst(dur, vol, freq){
  if (!ac()) return;
  try {
    const n = (actx.sampleRate * dur) | 0;
    const buf = actx.createBuffer(1, n, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random()*2-1) * (1 - i/n);
    const src = actx.createBufferSource(); src.buffer = buf;
    const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = actx.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(actx.destination); src.start();
  } catch(e){}
}
function startDrone(){
  if (!ac() || musicLayers) return;
  try {
    musicLayers = {
      calm: { o: actx.createOscillator(), g: actx.createGain(), freq: 46 },
      combat: { o: actx.createOscillator(), g: actx.createGain(), freq: 69 },
      boss: { o: actx.createOscillator(), g: actx.createGain(), freq: 92 },
      voxel: { o: actx.createOscillator(), g: actx.createGain(), freq: 220 } // chiptune-ish
    };
    Object.values(musicLayers).forEach(L => {
      L.o.type = 'triangle'; L.o.frequency.value = L.freq;
      L.g.gain.value = 0.0;
      L.o.connect(L.g).connect(actx.destination);
      L.o.start();
    });
    musicLayers.calm.g.gain.value = 0.012;
  } catch(e){}
}
function updateMusic(){
  if (!musicLayers) return;
  let target;
  if (state.world.dimension === 'voxel'){
    target = { calm: 0.002, combat: 0.004, boss: 0, voxel: 0.018 };
  } else if (activeBoss && activeBoss.alive){
    target = { calm: 0, combat: 0.004, boss: 0.022, voxel: 0 };
  } else if (state.threat > 0.4){
    target = { calm: 0.002, combat: 0.018, boss: 0, voxel: 0 };
  } else {
    target = { calm: 0.012, combat: 0, boss: 0, voxel: 0 };
  }
  const t = actx ? actx.currentTime : 0;
  Object.keys(musicLayers).forEach(k => {
    const L = musicLayers[k];
    L.g.gain.cancelScheduledValues(t);
    L.g.gain.linearRampToValueAtTime(target[k] || 0, t + 0.5);
  });
}
const jumpBeep = () => tone(520, 0.06, 'triangle', 0.05, 0, 1000);
const pickupSfx = (b) => { tone(b || 660, 0.09, 'triangle', 0.07); tone((b || 660) * 1.5, 0.16, 'sine', 0.045, 0.06); };
const winSfx = () => [523, 659, 784, 1046, 1318, 1568].forEach((f,i) => tone(f, 0.18, 'triangle', 0.07, i*0.09));
const loseSfx = () => [330, 277, 196, 165, 110].forEach((f,i) => tone(f, 0.25, 'sawtooth', 0.075, i*0.16, f*0.7));
const levelSfx = () => [392, 523, 659, 784].forEach((f,i) => tone(f, 0.22, 'triangle', 0.09, i*0.07));
const voxelEnterSfx = () => [440, 554, 659, 880].forEach((f,i) => tone(f, 0.18, 'square', 0.06, i*0.08));
const explodeSfx = () => { noiseBurst(0.5, 0.15, 500); tone(60, 0.4, 'sawtooth', 0.1, 0, 30); };

// ============================================================================
//  SECTION: POST-PROCESSING
// ============================================================================
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const _ssao = new SSAOPass(scene, camera, innerWidth, innerHeight);
_ssao.kernelRadius = 10; _ssao.minDistance = 0.005; _ssao.maxDistance = 0.12; _ssao.output = SSAOPass.OUTPUT_DEFAULT;
_ssao.enabled = (!LOW) && v4.shadowOn;
composer.addPass(_ssao);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), Q.bloomStrength, 0.5, 0.62);
composer.addPass(bloom);
bloom.enabled = Q.bloom && v4.bloomOn;

const CorruptionShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uTime: { value: 0 },
    uPixelate: { value: 0 }
  },
  vertexShader: `varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uTime;
    uniform float uPixelate;
    varying vec2 vUv;
    void main(){
      vec2 uv = vUv;
      if (uPixelate > 0.001){
        float px = mix(1.0, 0.02, uPixelate);
        uv = floor(uv / px) * px;
      }
      float c = clamp(uAmount, 0.0, 1.0);
      vec2 dir = uv - 0.5;
      float d = length(dir);
      float ab = c * 0.012 + uPixelate * 0.02;
      vec2 off = normalize(dir + 0.0001) * ab;
      float r = texture2D(tDiffuse, uv - off).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv + off).b;
      vec3 col = vec3(r, g, b);
      float vig = smoothstep(0.95, 0.25, d + (1.0 - c) * 0.35);
      col *= mix(1.0, vig, c * 0.85);
      col = mix(col, col * vec3(1.15, 0.82, 1.3), c * 0.7);
      float scan = sin(uv.y * 900.0 + uTime * 24.0) * 0.022 * c;
      col += scan;
      gl_FragColor = vec4(col, 1.0);
    }
  `
};
const corruptionPass = new ShaderPass(CorruptionShader);
composer.addPass(corruptionPass);
const fxaaPass = new ShaderPass(FXAAShader);
composer.addPass(fxaaPass);
function syncRenderTargets(w=innerWidth, h=innerHeight){
  renderer.setPixelRatio(currentPixelRatio);
  renderer.setSize(w, h, true);   // v4.6 fix: canvas CSS box ikut viewport (fix hitam separuh/persegi panjang)
  composer.setPixelRatio(currentPixelRatio);
  composer.setSize(w, h);
  if (typeof _ssao !== 'undefined' && _ssao.setSize) _ssao.setSize(w, h);
  const res = fxaaPass.material.uniforms.resolution.value;
  res.set(1 / Math.max(1, w * currentPixelRatio), 1 / Math.max(1, h * currentPixelRatio));
}

// ============================================================================
//  SECTION: FX POOLS
// ============================================================================
const PARTICLE_GEO = new THREE.SphereGeometry(0.07, 5, 5);
const particlePool = [], particles = [];
const dmgPool = [], dmgNumbers = [];
const RAIN_GEO = new THREE.CylinderGeometry(0.005, 0.005, 0.3, 4);
const rainPool = [], rainParticles = [];
const projPool = [], projectiles = [];
const trailPool = [], trails = [];
const decalPool = [], decals = [];

function getParticle(){
  let p = particlePool.pop();
  if (!p){
    const mesh = new THREE.Mesh(PARTICLE_GEO, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 }));
    p = { mesh, vel: new THREE.Vector3(), life: 0, max: 1 };
  }
  return p;
}
function spawnBurst(x, y, z, color, n, up){
  n = Math.round(n * Q.particleScale);
  for (let i = 0; i < n; i++){
    const a = rnd() * Math.PI * 2;
    const sp = 0.9 + rnd() * 2.2;
    const p = getParticle();
    p.mesh.material.color.setHex(color);
    p.mesh.material.opacity = 1;
    p.mesh.position.set(x, y, z);
    p.mesh.scale.setScalar(1);
    p.vel.set(Math.cos(a)*sp, (up?1.5:0.4) + rnd()*1.7, Math.sin(a)*sp);
    p.life = 0.6 + rnd()*0.5; p.max = 1.1;
    if (!p.mesh.parent) scene.add(p.mesh);
    particles.push(p);
  }
}
function spawnDmg(pos, text, color){
  let d = dmgPool.pop();
  if (!d){
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false }));
    d = { spr, cv, vel: new THREE.Vector3(), life: 0, max: 1 };
  }
  const c = d.cv.getContext('2d');
  c.clearRect(0, 0, 128, 64);
  c.font = 'bold 42px "JetBrains Mono", monospace';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.shadowColor = color; c.shadowBlur = 14;
  c.lineWidth = 6; c.strokeStyle = '#0b0c1c';
  c.strokeText(text, 64, 32);
  c.fillStyle = color;
  c.fillText(text, 64, 32);
  d.spr.material.map.needsUpdate = true;
  d.spr.position.copy(pos).add(new THREE.Vector3(0, 1.15, 0));
  d.spr.scale.set(1.6, 0.8, 1);
  d.spr.material.opacity = 1;
  if (!d.spr.parent) scene.add(d.spr);
  d.vel.set((Math.random()*2-1)*0.6, 2.4, (Math.random()*2-1)*0.6);
  d.life = 0.95; d.max = 0.95;
  dmgNumbers.push(d);
}
function spawnRainParticle(){
  let r = rainPool.pop();
  if (!r){
    const mesh = new THREE.Mesh(RAIN_GEO, new THREE.MeshBasicMaterial({ color: 0xaac8ff, transparent: true, opacity: 0.45 }));
    r = { mesh, life: 0.5 };
  }
  const x = (Math.random()*2-1)*26, z = (Math.random()*2-1)*26;
  r.mesh.position.set(playerGroup.position.x + x, 15, playerGroup.position.z + z);
  r.mesh.material.opacity = 0.45;
  if (!r.mesh.parent) scene.add(r.mesh);
  rainParticles.push(r);
}
function spawnProjectile(x, y, z, tx, ty, tz, color, dmg){
  let p = projPool.pop();
  if (!p){
    const mesh = new THREE.Mesh(projGeo, new THREE.MeshStandardMaterial({ color: 0xfcd34d, emissive: 0xfcd34d, emissiveIntensity: 1.5 }));
    p = { mesh, vel: new THREE.Vector3(), life: 0 };
  }
  p.mesh.material.color.setHex(color);
  p.mesh.material.emissive.setHex(color);
  p.mesh.position.set(x, y, z);
  const dir = new THREE.Vector3(tx - x, ty - y, tz - z).normalize();
  p.vel.copy(dir).multiplyScalar(10);
  p.life = 3.0; p.dmg = dmg;
  if (!p.mesh.parent) scene.add(p.mesh);
  projectiles.push(p);
}

const TRAIL_GEO = new THREE.SphereGeometry(0.14, 5, 5);
function spawnTrail(x, y, z){
  if (!v4.trailsOn) return;
  let t = trailPool.pop();
  if (!t){
    const mesh = new THREE.Mesh(TRAIL_GEO, new THREE.MeshBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.9 }));
    t = { mesh, life: 0, max: 0.55 };
  }
  const c = new THREE.Color().setHSL(0.5 - Math.random()*0.3, 0.9, 0.6);
  t.mesh.material.color.copy(c);
  t.mesh.material.opacity = 0.9;
  t.mesh.position.set(x, y, z);
  t.mesh.scale.setScalar(1);
  t.life = 0.55; t.max = 0.55;
  if (!t.mesh.parent) scene.add(t.mesh);
  trails.push(t);
}

const DECAL_GEO = new THREE.PlaneGeometry(1, 1);
function spawnDecal(x, y, z, color){
  let d = decalPool.pop();
  if (!d){
    const mesh = new THREE.Mesh(DECAL_GEO, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }));
    d = { mesh, life: 0, max: 6 };
  }
  d.mesh.material.color.setHex(color);
  d.mesh.material.opacity = 0.65;
  d.mesh.position.set(x, y + 0.03, z);
  d.mesh.rotation.x = -Math.PI/2;
  d.mesh.rotation.z = rnd() * Math.PI * 2;
  const sc = 0.7 + rnd() * 0.7;
  d.mesh.scale.set(sc, sc, sc);
  d.life = 6; d.max = 6;
  if (!d.mesh.parent) scene.add(d.mesh);
  decals.push(d);
  while (decals.length > Q.decals){
    const old = decals.shift();
    scene.remove(old.mesh);
    decalPool.push(old);
  }
}

// ============================================================================
//  SECTION: TOASTS / FEEDBACK
// ============================================================================
function showToast(msg, cls){
  const el = document.createElement('div');
  el.className = 'toast' + (cls ? ' ' + cls : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  const all = $('toasts').children;
  while (all.length > 4) all[0].remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2300);
}
function hurtFlash(){
  const d = $('dmg');
  d.animate([{ opacity: 0.7 }, { opacity: 0 }], { duration: 420, easing: 'ease-out' });
  state.trauma = Math.min(1, state.trauma + 0.4);
  if (navigator.vibrate) navigator.vibrate(30);
}
function screenFlash(color){
  const f = $('flash');
  f.style.background = color;
  f.animate([{ opacity: 0.5 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' });
}
function hitstop(t){ state.hitstop = Math.max(state.hitstop, t); }
function killCamOn(){
  if (!v4.killCamOn) return;
  state.slowmo = 0.8;
  state.killCam = 0.8;
  $('killcam').classList.add('on');
}
function syncVitals(){
  $('hp').textContent = state.hp;
  $('hpBar').style.width = clamp(state.hp / state.maxHp, 0, 1) * 100 + '%';
  if (state.hpGhost > state.hp){
    $('hpGhost').style.width = clamp(state.hpGhost / state.maxHp, 0, 1) * 100 + '%';
  } else {
    state.hpGhost = state.hp;
    $('hpGhost').style.width = clamp(state.hp / state.maxHp, 0, 1) * 100 + '%';
  }
  $('lvl').textContent = state.level;
  $('xpBar').style.width = (state.xp / state.xpNeeded) * 100 + '%';
  $('ult').textContent = Math.round(state.ult) + '%';
  $('ultBar').style.width = state.ult + '%';
  $('corrupt').textContent = Math.round(state.corruption) + '%';
  $('corruptBar').style.width = state.corruption + '%';
  const fracReady = state.fractureCharges > 0 && state.fractureCd <= 0;
  $('frac').textContent = fracReady ? 'READY' : (state.fractureCd > 0 ? state.fractureCd.toFixed(1) + 's' : '-');
  $('frac').style.color = fracReady ? CSS.teal : CSS.mut;
  // stamina arc
  const circle = $('stamCircle');
  const dashLen = 2 * Math.PI * 22;
  if (circle){
    circle.setAttribute('stroke-dashoffset', String(dashLen * (1 - state.stamina)));
    circle.setAttribute('stroke', state.stamina > 0.5 ? '#5eead4' : state.stamina > 0.2 ? '#fcd34d' : '#e879f9');
  }
  // Combo HUD is optional in older/custom markup: never let it stop game startup.
  const comboEl = $('comboBig');
  if (comboEl){
    if (state.combo >= 3){
      comboEl.classList.add('on');
      comboEl.innerHTML = 'x' + state.combo + '<small>COMBO</small>';
      comboEl.style.transform = 'translate(-50%,-50%) scale(' + (1 + Math.min(0.3, state.combo * 0.03)) + ')';
    } else comboEl.classList.remove('on');
  }
}

// ============================================================================
//  SECTION: ACTIONS
// ============================================================================
function tryDashOrInteract(){
  // If in voxel and near a solid block ahead → mine
  if (state.world.dimension === 'voxel' && state.grounded){
    startMining();
    return;
  }
  tryDash();
}
function tryDash(){
  if (!state.running || state.paused || state.dashCd > 0 || state.stamina < TUNING.dashCost) return;
  const cls = CLASSES[state.playerClass];
  state.dashing = true;
  characterAnim.play('dash');
  state.dashCd = TUNING.dashCd;
  state.invuln = Math.max(state.invuln, 0.4);
  state.stamina = Math.max(0, state.stamina - TUNING.dashCost);
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  for (let i = 0; i < 5; i++){
    const t = i/5;
    spawnTrail(
      playerGroup.position.x + dx * cls.dashDist * t,
      playerGroup.position.y + 0.9,
      playerGroup.position.z + dz * cls.dashDist * t
    );
  }
  if (cls.blink && state.world.dimension === 'genesis'){
    playerGroup.position.x += dx * cls.dashDist;
    playerGroup.position.z += dz * cls.dashDist;
    screenFlash('rgba(167,139,250,0.4)');
  } else {
    playerGroup.position.x += dx * cls.dashDist;
    playerGroup.position.z += dz * cls.dashDist;
  }
  spawnBurst(playerGroup.position.x, playerGroup.position.y + 0.8, playerGroup.position.z, C.sky, 12, true);
  tone(880, 0.12, 'sawtooth', 0.09, 0, 1300);
  state.trauma = Math.min(1, state.trauma + 0.2);
  addCorruption(TUNING.corruptPerDash);
  setTimeout(() => { state.dashing = false; }, 220);
}
function releaseAttack(){
  if (!state.charging) return;
  const charged = state.chargeT >= TUNING.chargeTime;
  state.charging = false;
  state.chargeT = 0;
  tryAttack(charged);
}
function tryAttack(heavy){
  if (!state.running || state.paused || state.atkCd > 0) return;
  const cls = CLASSES[state.playerClass];
  const ws = weaponShapes[state.weapon] || weaponShapes.sword;
  state.atkCd = heavy ? TUNING.atkCdHeavy : TUNING.atkCdLight;
  state.attacks++;
  state.swing = 1;
  const comboMax = cls.comboMax || 3;
  state.comboStep = (state.comboStep + 1) % comboMax;
  const attackVariants = ['slashR', 'slashL', 'thrust', 'spin'];
  characterAnim.playAttack(heavy ? 'overhead' : attackVariants[state.comboStep % attackVariants.length]);
  const px = playerGroup.position.x, pz = playerGroup.position.z;
  const reach = ws.reach * (heavy ? 1.35 : 1);
  const overMul = state.overload > 0 ? 3 : 1;
  const baseDmg = (2.0 + (state.atkCoeff - 1) * 0.8) * cls.dmgMul * ws.dmg * (heavy ? 1.9 : 1) * overMul;
  let hitCount = 0, crits = 0;
  MOBS.forEach((m) => {
    if (!m.alive) return;
    const dx = m.mesh.position.x - px, dz = m.mesh.position.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > reach) return;
    const ang = Math.atan2(dx, dz);
    let diff = Math.abs(ang - (yaw + Math.PI));
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const tolerance = IS_TOUCH ? 1.5 : 1.15;
    if (diff > tolerance) return;
    const crit = Math.random() < (heavy ? 0.5 : 0.22);
    const dmgFinal = Math.max(1, Math.round(crit ? baseDmg * 1.9 : baseDmg));
    if (crit) crits++;
    hitCount++;
    state.score += 10 * dmgFinal;
    state.ult = Math.min(TUNING.ultMax, state.ult + TUNING.ultPerHit);
    addXp(2);
    const mp = m.mesh.position;
    spawnDmg(new THREE.Vector3(mp.x, mp.y + 1.2, mp.z),
      (crit ? 'CRIT ' : '') + dmgFinal, crit ? CSS.amber : CSS.ink);
    m.health -= dmgFinal;
    m.flash = 0.5;
    m.stun = 0.4;
    m.mode = 'chase';
    m.target = { x: px, z: pz };
    const al = d || 1;
    mp.x += (dx/al) * (heavy ? 1.6 : 1.0);
    mp.z += (dz/al) * (heavy ? 1.6 : 1.0);
    spatialTone(mp.x, mp.y, mp.z, 300, 0.06, 'square', 0.05);
    if (m.health <= 0) killMob(m, true);
  });
  state.crits += crits;
  if (hitCount > 0){
    state.comboTimer = 2.6;
    if (heavy) state.combo = Math.min(9, state.combo + 1);
    state.stamina = Math.min(1, state.stamina + hitCount * 0.05);
    state.trauma = Math.min(1, state.trauma + (heavy ? 0.35 : 0.1));
    if (crits > 0) hitstop(0.06);
    if (state.combo >= 5) unlockAch('combo5');
    if (navigator.vibrate) navigator.vibrate(15);
  } else state.combo = 1;
  tone(heavy ? 330 : 500, 0.08, 'square', 0.045, 0, heavy ? 165 : 980);
  if (heavy){
    spawnBurst(px, playerGroup.position.y + 0.5, pz, C.ember, 24, false);
    screenFlash('rgba(251,146,60,0.35)');
  }
}
function killMob(m, fromPlayer){
  m.alive = false;
  state.enemiesKilled++;
  state.killCount++;
  state.score += 50;
  state.combo = Math.min(9, state.combo + 1);
  state.comboTimer = 2.6;
  state.ult = Math.min(TUNING.ultMax, state.ult + 10);
  addXp(m.isBoss ? 200 : (m.spec?.xp || 20) * (1 + (m.levelBonus||0) * 0.2));
  const mp = m.mesh.position;
  const killColor = m.dimension === 'voxel' ? C.voxel : (m.isEcho ? C.corrupt : C.violet);
  spawnBurst(mp.x, mp.y + 0.5, mp.z, killColor, 16, true);
  spatialTone(mp.x, mp.y, mp.z, 200, 0.2, 'sawtooth', 0.07, 70);
  if (fromPlayer) spawnDecal(mp.x, mp.dimension === 'voxel' ? mp.y - 0.5 : th(mp.x, mp.z), mp.z, killColor);
  const nameMap = {
    somber: 'The Hollow', brute: 'Bone Gnasher', wisp: 'Lantern Wraith', golem: 'Grave Golem',
    ranger: 'Marrow Stalker', shaman: 'Rot Oracle', assassin: 'Night Reaver', echo: 'Echo Husk',
    vcreeper: 'Creeper', vzombie: 'Zombie', vskeleton: 'Skeleton',
    venderman: 'Enderman', vgolem: 'Voxel Golem'
  };
  showToast((nameMap[m.kind] || m.kind) + ' tumbang  ' + (m.dimension === 'voxel' ? KAO.cool : KAO.happy), m.dimension === 'voxel' ? 'voxel' : 'magenta');
  if (state.enemiesKilled === 1) unlockAch('first_blood');
  if (m.isEcho){
    state.echoKills = (state.echoKills || 0) + 1;
    if (state.echoKills >= 3) unlockAch('echo_slayer');
  }
  if (m.kind === 'venderman'){
    state.endermanKills = (state.endermanKills || 0) + 1;
    if (state.endermanKills >= 5) unlockAch('enderman_slayer');
  }
  if (m.miniBoss) unlockAch('dragon_slayer');
  if (m.isBoss){
    state.bossKills++;
    despawnBoss();
    state.hp = Math.min(state.maxHp, state.hp + 3);
    showToast('BOSS slain - +3 HP  ' + KAO.roar, 'amber');
    unlockAch('bosskiller');
  }
  // Creeper explode on death near player
  if (m.creeper && fromPlayer){
    creeperExplode(mp.x, mp.y, mp.z);
  }
  setTimeout(() => { m.mesh.visible = false; }, 400);
  addCorruption(TUNING.corruptPerKill);
  if (fromPlayer && state.combo >= 5) killCamOn();
  if (state.killCount > 0 && state.killCount % 20 === 0 && !activeBoss && state.world.dimension === 'genesis') spawnBoss(state.world.biome);
}

// Creeper explosion
function creeperExplode(x, y, z){
  explodeSfx();
  screenFlash('rgba(126,231,135,0.5)');
  state.trauma = Math.min(1, state.trauma + 0.6);
  // destroy nearby voxel blocks
  if (state.world.dimension === 'voxel'){
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    let destroyed = 0;
    for (let dx = -2; dx <= 2; dx++){
      for (let dy = -1; dy <= 2; dy++){
        for (let dz = -2; dz <= 2; dz++){
          if (destroyed >= 6) break;
          if (Math.hypot(dx, dy, dz) <= 2 && Math.random() < 0.4){
            const b = voxGet(cx+dx, cy+dy, cz+dz);
            if (b !== 0 && b !== 8){
              voxSet(cx+dx, cy+dy, cz+dz, 0);
              destroyed++;
            }
          }
        }
      }
    }
    voxelState.creeperBlasts++;
  }
  // damage player
  const pd = Math.hypot(playerGroup.position.x - x, playerGroup.position.z - z);
  if (pd < 3.5 && state.invuln <= 0){
    hitFlashAndDmg(4, new THREE.Vector3(x, y, z));
    unlockAch('creeper_survivor');
  }
  spawnBurst(x, y + 0.5, z, C.voxel, 40, true);
}

function tryParry(){
  if (!state.running || state.paused || state.parryCd > 0) return;
  const cls = CLASSES[state.playerClass];
  const window = TUNING.parryWindow + (cls.parryBonus || 0);
  state.parryActive = window;
  characterAnim.play('parry');
  state.parryCd = TUNING.parryCd;
  tone(1200, 0.08, 'triangle', 0.06);
}
function tryUltimate(){
  if (!state.running || state.paused) return;
  if (state.ult < TUNING.ultMax){ showToast('Ultimate belum siap  ' + KAO.hmm, 'sky'); return; }
  state.ult = 0;
  characterAnim.play('ult');
  const cls = CLASSES[state.playerClass];
  const px = playerGroup.position.x, pz = playerGroup.position.z;
  showToast('ULTIMATE!  ' + KAO.determined, 'amber');
  screenFlash('rgba(252,211,77,0.5)');
  state.trauma = Math.min(1, state.trauma + 0.5);
  hitstop(0.1);
  spawnBurst(px, playerGroup.position.y + 1, pz, C.amber, 60, true);
  for (let i = 0; i < 12; i++){
    const a = (i/12) * Math.PI * 2;
    spawnTrail(px + Math.cos(a)*2, playerGroup.position.y + 1, pz + Math.sin(a)*2);
  }
  const radius = state.playerClass === 'ward' ? 8 : (state.playerClass === 'void' ? 6 : 5);
  MOBS.forEach(m => {
    if (!m.alive) return;
    const d = Math.hypot(m.mesh.position.x - px, m.mesh.position.z - pz);
    if (d < radius){
      const dmg = Math.round(15 * cls.dmgMul * (state.playerClass === 'void' ? 1.5 : 1));
      m.health -= dmg;
      m.flash = 0.6; m.stun = 1.0;
      spawnDmg(new THREE.Vector3(m.mesh.position.x, m.mesh.position.y + 1.2, m.mesh.position.z), 'ULT ' + dmg, CSS.ember);
      if (m.health <= 0) killMob(m, true);
    }
  });
  state.ultCount = (state.ultCount || 0) + 1;
  if (state.ultCount >= 3) unlockAch('voidmaster');
  addCorruption(TUNING.corruptPerUlt);
  [523, 659, 784, 1046].forEach((f,i) => tone(f, 0.24, 'sawtooth', 0.1, i*0.06));
}
function swapWeapon(){
  const order = ['sword', 'axe', 'spear'];
  const i = order.indexOf(state.weapon);
  state.weapon = order[(i + 1) % order.length];
  characterAnim.attachWeapon(state.weapon);
  const shape = weaponShapes[state.weapon];
  sBlade.geometry.dispose();
  sBlade.geometry = shape.geo;
  $('wLabel').textContent = state.weapon[0].toUpperCase();
  showToast('Senjata - ' + shape.name, 'sky');
  tone(600, 0.1, 'triangle', 0.06, 0, 900);
}
function tryInteract(){
  let nearest = null, nd = 3.5;
  BENCHES.forEach(b => {
    const d = Math.hypot(b.x - playerGroup.position.x, b.z - playerGroup.position.z);
    if (d < nd){ nd = d; nearest = { type:'bench', obj: b }; }
  });
  NPCS.forEach(n => {
    const d = Math.hypot(n.x - playerGroup.position.x, n.z - playerGroup.position.z);
    if (d < nd){ nd = d; nearest = { type:'npc', obj: n }; }
  });
  if (!nearest) return;
  if (nearest.type === 'bench') openCrafting();
  else showToast('[' + nearest.obj.name + ']: "Selamat datang, pengembara."', 'violet');
}
function openCrafting(){
  state.paused = true;
  state.running = false;
  $('ovPause').classList.remove('hidden');
  const panel = $('pausePanel');
  panel.style.display = 'block';
  panel.innerHTML = `
    <h4>Crafting Bench  ${KAO.cheeky}</h4>
    <p>Bahan: <b>${state.enemiesKilled}</b> kill - Ult ${Math.round(state.ult)}%</p>
    <div class="kv" style="margin-top:8px"><span>3 Kill -> Sword Rare (+20% dmg)</span><button class="btn btn-ghost" data-craft="sword" style="padding:.3rem .7rem;font-size:.5rem">CRAFT</button></div>
    <div class="kv"><span>10 Kill -> Amulet Epic (+1 HP)</span><button class="btn btn-ghost" data-craft="amulet" style="padding:.3rem .7rem;font-size:.5rem">CRAFT</button></div>
    <div class="kv"><span>20 Kill + 1 Boss -> Legendary Blade (+50% dmg)</span><button class="btn btn-ghost" data-craft="legendary" style="padding:.3rem .7rem;font-size:.5rem">CRAFT</button></div>
  `;
  panel.querySelectorAll('[data-craft]').forEach(btn => {
    btn.onclick = () => {
      const k = btn.dataset.craft;
      if (k === 'sword' && state.enemiesKilled >= 3) { state.atkCoeff += 0.2; showToast('Sword Rare crafted!  ' + KAO.sparkle, 'amber'); }
      else if (k === 'amulet' && state.enemiesKilled >= 10) { state.maxHp += 1; state.hp = state.maxHp; showToast('Amulet Epic crafted!  ' + KAO.sparkle, 'amber'); }
      else if (k === 'legendary' && state.enemiesKilled >= 20 && state.bossKills >= 1) { state.atkCoeff += 0.5; showToast('Legendary Blade crafted!  ' + KAO.determined, 'amber'); }
      else { showToast('Bahan tidak cukup  ' + KAO.shrug, 'magenta'); return; }
      syncVitals();
    };
  });
}

// ============================================================================
//  SECTION: VOXEL MINING / PLACING
// ============================================================================
function startMining(){
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  const tx = playerGroup.position.x + dx * 2;
  const tz = playerGroup.position.z + dz * 2;
  const bx = Math.floor(tx), bz = Math.floor(tz);
  // find first solid block below eye level
  let by = -1;
  for (let y = voxelState.worldH - 1; y >= 0; y--){
    if (voxSolidAt(bx, y, bz)){ by = y; break; }
  }
  if (by < 0) return;
  const blockId = voxGet(bx, by, bz);
  const block = VOXEL_BLOCK_TYPES[blockId];
  if (!block || !block.solid) return;
  state.mining = { x: bx, y: by, z: bz, blockId, time: block.mine, elapsed: 0 };
  characterAnim.play('mine');
  $('mineProg').classList.add('on');
}
function updateMining(dt){
  if (!state.mining){
    $('mineProg').classList.remove('on');
    return;
  }
  const cls = CLASSES[state.playerClass];
  const speed = cls.fastMine || 1;
  state.mining.elapsed += dt * speed;
  const pct = state.mining.elapsed / state.mining.time;
  $('mineBar').style.width = Math.min(100, pct * 100) + '%';
  if (pct >= 1){
    const b = state.mining;
    voxSet(b.x, b.y, b.z, 0);
    spawnBurst(b.x + 0.5, b.y + 0.5, b.z + 0.5, blockColor(b.blockId), 10, true);
    spawnDmg(new THREE.Vector3(b.x + 0.5, b.y + 1, b.z + 0.5), VOXEL_BLOCK_TYPES[b.blockId].name, CSS.voxel);
    state.score += 5;
    // add to hotbar
    const itemName = VOXEL_BLOCK_TYPES[b.blockId].name;
    addToHotbar(itemName);
    state.minedCount = (state.minedCount || 0) + 1;
    if (state.minedCount >= 10) unlockAch('voxel_mine10');
    tone(400 + Math.random() * 200, 0.1, 'square', 0.06);
    if (navigator.vibrate) navigator.vibrate(20);
    state.mining = null;
    $('mineProg').classList.remove('on');
  }
}
function blockColor(id){
  const b = VOXEL_BLOCK_TYPES[id];
  return b ? b.color : 0x888888;
}
function placeBlock(){
  if (state.world.dimension !== 'voxel') return;
  const item = state.hotbar[state.hotbarIdx];
  if (!item || item === 'sword' || item === 'axe' || item === 'spear' || item === 'voxel') return;
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  const tx = playerGroup.position.x + dx * 2.5;
  const tz = playerGroup.position.z + dz * 2.5;
  const bx = Math.floor(tx), bz = Math.floor(tz);
  // find surface
  let by = 0;
  for (let y = voxelState.worldH - 2; y >= 0; y--){
    if (voxSolidAt(bx, y, bz)){ by = y + 1; break; }
  }
  // find matching block id
  let blockId = 1;
  for (const [id, b] of Object.entries(VOXEL_BLOCK_TYPES)){
    if (b.name === item){ blockId = parseInt(id); break; }
  }
  if (by < voxelState.worldH && !voxSolidAt(bx, by, bz)){
    voxSet(bx, by, bz, blockId);
    spawnBurst(bx + 0.5, by + 0.5, bz + 0.5, blockColor(blockId), 6, true);
    tone(600, 0.08, 'triangle', 0.05);
    unlockAch('voxel_first');
  }
}
function addToHotbar(item){
  // find first empty slot after 0 (0 = weapon)
  for (let i = 1; i < state.hotbar.length; i++){
    if (!state.hotbar[i]){
      state.hotbar[i] = item;
      updateHotbarUI();
      return;
    }
  }
  // replace slot 1
  state.hotbar[1] = item;
  updateHotbarUI();
}
function updateHotbarUI(){
  const slots = document.querySelectorAll('#hotbar .hb-slot');
  slots.forEach((el, i) => {
    const item = state.hotbar[i];
    const ico = el.querySelector('.hb-ico');
    const ct = el.querySelector('.hb-ct');
    if (!item){ ico.textContent = '-'; ct.textContent = ''; }
    else {
      // short name
      const map = {
        sword:'SW', axe:'AX', spear:'SP', voxel:'VX',
        grass:'GR', dirt:'DR', stone:'ST', sand:'SD',
        water:'WA', lava:'LV', netherrack:'NR', obsidian:'OB', glowstone:'GS'
      };
      ico.textContent = map[item] || item.slice(0,2).toUpperCase();
      ct.textContent = '';
    }
    el.classList.toggle('active', i === state.hotbarIdx);
  });
}
function selectHotbar(i){
  if (i < 0 || i >= state.hotbar.length) return;
  state.hotbarIdx = i;
  const item = state.hotbar[i];
  if (item === 'sword' || item === 'axe' || item === 'spear' || item === 'voxel'){
    state.weapon = item;
    characterAnim.attachWeapon(item === 'voxel' ? 'sword' : item);
    const shape = weaponShapes[item];
    if (shape){
      sBlade.geometry.dispose();
      sBlade.geometry = shape.geo;
    }
  }
  updateHotbarUI();
  tone(500, 0.06, 'triangle', 0.05);
}

// ============================================================================
//  SECTION: CORRUPTION
// ============================================================================
function addCorruption(amount){
  if (!v4.corruptOn) return;
  state.corruption = clamp(state.corruption + amount, 0, 100);
  if (state.corruption >= 100 && state.overload <= 0) enterOverload();
}
function reduceCorruption(amount){
  state.corruption = clamp(state.corruption - amount, 0, 100);
}
function enterOverload(){
  state.overload = TUNING.overloadTime;
  unlockAch('overload');
  showToast('OVERLOAD MODE  ' + KAO.roar, 'corrupt');
  screenFlash('rgba(192,38,211,0.6)');
  state.trauma = Math.min(1, state.trauma + 0.6);
  for (let i = 0; i < 40; i++){
    const a = rnd() * Math.PI * 2;
    spawnBurst(
      playerGroup.position.x + Math.cos(a)*1.5,
      playerGroup.position.y + 1,
      playerGroup.position.z + Math.sin(a)*1.5,
      C.corrupt, 3, true
    );
  }
  [196, 233, 277, 349].forEach((f,i) => tone(f, 0.35, 'sawtooth', 0.12, i*0.09, f*0.5));
}

// ============================================================================
//  SECTION: ECHO SYSTEM
// ============================================================================
function recordEcho(dt){
  if (!v4.echoOn) return;
  state.recordTimer += dt;
  if (state.recordTimer < 1/20) return;
  state.recordTimer = 0;
  const now = performance.now() * 0.001;
  state.echoRecorder.push({
    t: now,
    x: playerGroup.position.x,
    z: playerGroup.position.z,
    y: playerGroup.position.y,
    yaw
  });
  const cutoff = now - TUNING.echoRecord;
  while (state.echoRecorder.length && state.echoRecorder[0].t < cutoff) state.echoRecorder.shift();
}
function spawnEcho(){
  if (!v4.echoOn || state.echoRecorder.length < 4) return;
  const start = performance.now() * 0.001;
  const px = state.echoRecorder[0].x + (rnd()-0.5) * 4;
  const pz = state.echoRecorder[0].z + (rnd()-0.5) * 4;
  const echo = makeMob('echo', px, pz, state.level - 1);
  if (!echo) return;
  echo.replay = state.echoRecorder.map(s => ({...s, t: s.t - state.echoRecorder[0].t}));
  echo.replayStart = start;
  echo.replayIdx = 0;
  echo.sense = 999;
  echo.mode = 'chase';
  MOBS.push(echo);
  showToast('ECHO muncul - lawan masa lalumu  ' + KAO.surprise, 'corrupt');
  spawnBurst(px, th(px, pz) + 1, pz, C.corrupt, 30, true);
  tone(220, 0.4, 'sawtooth', 0.1, 0, 110);
}
function updateEcho(m, dt){
  if (m._mon) m._mon.update(dt, { mode:'chase', speed: m.spec.chase, dP: 0, t: performance.now() });
  if (!m.replay || !m.replay.length){
    const dx = playerGroup.position.x - m.mesh.position.x;
    const dz = playerGroup.position.z - m.mesh.position.z;
    const d = Math.hypot(dx, dz) || 1;
    m.mesh.position.x += (dx/d) * 4 * dt;
    m.mesh.position.z += (dz/d) * 4 * dt;
    m.mesh.position.y = th(m.mesh.position.x, m.mesh.position.z);
    return;
  }
  const elapsed = performance.now() * 0.001 - m.replayStart;
  const dur = m.replay[m.replay.length - 1].t || 1;
  const local = elapsed % dur;
  while (m.replayIdx < m.replay.length - 1 && m.replay[m.replayIdx + 1].t < local) m.replayIdx++;
  const a = m.replay[m.replayIdx];
  const b = m.replay[Math.min(m.replayIdx + 1, m.replay.length - 1)];
  const span = Math.max(0.001, b.t - a.t);
  const k = clamp((local - a.t) / span, 0, 1);
  const targetX = lerp(a.x, b.x, k);
  const targetZ = lerp(a.z, b.z, k);
  const dx = targetX - m.mesh.position.x;
  const dz = targetZ - m.mesh.position.z;
  const d = Math.hypot(dx, dz);
  const spd = Math.min(d, 8 * dt);
  if (d > 0.01){
    m.mesh.position.x += (dx/d) * spd;
    m.mesh.position.z += (dz/d) * spd;
  }
  m.mesh.position.y = th(m.mesh.position.x, m.mesh.position.z);
  const pdx = playerGroup.position.x - m.mesh.position.x;
  const pdz = playerGroup.position.z - m.mesh.position.z;
  m.mesh.rotation.y = Math.atan2(pdx, pdz);
  if (local < m.replay[m.replayIdx]?.t || m.replayIdx >= m.replay.length - 1) m.replayIdx = 0;
}

// ============================================================================
//  SECTION: TIME FRACTURE
// ============================================================================
function tryFracture(){
  if (!v4.fractureOn) return;
  if (!state.running || state.paused) return;
  if (state.fractureCd > 0 || state.fractureCharges <= 0){ showToast('Fracture tidak siap  ' + KAO.hmm, 'sky'); return; }
  if (state.rewindBuf.length < 2){ showToast('Fracture buffer kosong', 'sky'); return; }
  const snap = state.rewindBuf[0];
  screenFlash('rgba(192,38,211,0.4)');
  state.trauma = Math.min(1, state.trauma + 0.4);
  hitstop(0.08);
  playerGroup.position.set(snap.px, snap.py, snap.pz);
  yaw = snap.yaw;
  state.hp = snap.hp;
  MOBS.forEach(m => {
    const s = snap.mobs.find(mm => mm.id === m._id);
    if (s && m.alive){
      m.mesh.position.set(s.x, s.y, s.z);
      m.health = s.hp;
    }
  });
  for (let i = 0; i < 30; i++){
    const a = rnd() * Math.PI * 2;
    spawnBurst(
      playerGroup.position.x + Math.cos(a)*1.8,
      playerGroup.position.y + 1,
      playerGroup.position.z + Math.sin(a)*1.8,
      C.corrupt, 2, true
    );
  }
  state.fractureCd = TUNING.fractureCd;
  state.fractureCharges = 0;
  reduceCorruption(20);
  showToast('TIME FRACTURE  ' + KAO.cool, 'corrupt');
  [660, 440, 220].forEach((f,i) => tone(f, 0.3, 'triangle', 0.09, i*0.08, f*0.5));
  state.rewindBuf = [];
}
let mobIdCounter = 1;
function recordRewind(dt){
  if (!v4.fractureOn) return;
  state.rewindTick += dt;
  if (state.rewindTick < 0.1) return;
  state.rewindTick = 0;
  const snap = {
    t: performance.now(),
    px: playerGroup.position.x,
    py: playerGroup.position.y,
    pz: playerGroup.position.z,
    yaw,
    hp: state.hp,
    mobs: MOBS.filter(m => m.alive).map(m => ({
      id: m._id, x: m.mesh.position.x, y: m.mesh.position.y, z: m.mesh.position.z, hp: m.health
    }))
  };
  state.rewindBuf.push(snap);
  const now = performance.now();
  while (state.rewindBuf.length && now - state.rewindBuf[0].t > TUNING.fractureRewind * 1000){
    state.rewindBuf.shift();
  }
}

// ============================================================================
//  SECTION: XP / LEVEL
// ============================================================================
function addXp(n){
  state.xp += n;
  while (state.xp >= state.xpNeeded){
    state.xp -= state.xpNeeded;
    state.level++;
    state.xpNeeded = Math.round(TUNING.xpBase * Math.pow(TUNING.xpCurve, state.level - 1));
    state.maxHp += 1;
    state.hp = state.maxHp;
    state.atkCoeff += 0.05;
    showLevelUp();
    if (state.level >= 5) unlockAch('lvl5');
  }
  syncVitals();
}
function showLevelUp(){
  const el = $('levelup');
  el.classList.add('on');
  levelSfx();
  for (let i = 0; i < 24; i++){
    const a = (i/24) * Math.PI * 2;
    spawnBurst(
      playerGroup.position.x + Math.cos(a)*1.5,
      playerGroup.position.y + 1.0,
      playerGroup.position.z + Math.sin(a)*1.5,
      C.amber, 2, true
    );
  }
  setTimeout(() => el.classList.remove('on'), 1800);
}

// ============================================================================
//  SECTION: WEATHER
// ============================================================================
const WEATHER_TYPES = ['clear','overcast','rain','storm','snow','fog','bloodmoon','aurora','meteor'];
const WEATHER_NAMES = {
  clear:'Cerah', overcast:'Mendung', rain:'Hujan', storm:'Badai', snow:'Salju',
  fog:'Kabut', bloodmoon:'Blood Moon', aurora:'Aurora', meteor:'Meteor Shower'
};
const weatherEl = $('weather');
let weatherTimer = 0, lightningTimer = 0, meteorTimer = 0;
function setWeather(w){
  state.weather = w;
  weatherEl.className = (w === 'clear') ? '' : w;
  showToast('Cuaca - ' + WEATHER_NAMES[w],
    w === 'storm' ? 'magenta' : w === 'snow' ? 'sky' : w === 'meteor' ? 'ember' : w === 'bloodmoon' ? 'magenta' : 'violet');
}
function cycleWeather(){
  const i = WEATHER_TYPES.indexOf(state.weather);
  setWeather(WEATHER_TYPES[(i + 1) % WEATHER_TYPES.length]);
  if (state.weather === 'storm') unlockAch('stormchaser');
}
function lightningStrike(){
  const a = rnd() * Math.PI * 2;
  const d = 8 + rnd() * 14;
  const x = playerGroup.position.x + Math.cos(a) * d;
  const z = playerGroup.position.z + Math.sin(a) * d;
  const points = [];
  let px = x, py = 40, pz = z;
  const y0 = th(x, z);
  while (py > y0){
    points.push(new THREE.Vector3(px, py, pz));
    px += (rnd()-0.5) * 2.5;
    pz += (rnd()-0.5) * 2.5;
    py -= 4 + rnd() * 3;
  }
  points.push(new THREE.Vector3(x, y0, z));
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 }));
  scene.add(line);
  screenFlash('rgba(200,220,255,0.65)');
  setTimeout(() => { scene.remove(line); geo.dispose(); line.material.dispose(); }, 180);
  spawnBurst(x, y0 + 0.5, z, C.sky, 20, true);
  const dToP = Math.hypot(playerGroup.position.x - x, playerGroup.position.z - z);
  if (dToP < 3) hitFlashAndDmg(2, playerGroup.position.clone());
  MOBS.forEach(m => {
    if (!m.alive) return;
    const dm = Math.hypot(m.mesh.position.x - x, m.mesh.position.z - z);
    if (dm < 3){ m.health -= 4; m.flash = 0.6; if (m.health <= 0) killMob(m, true); }
  });
  spatialTone(x, 20, z, 90, 0.5, 'sawtooth', 0.15, 40);
}
function meteorFall(){
  const a = rnd() * Math.PI * 2;
  const d = 10 + rnd() * 16;
  const x = playerGroup.position.x + Math.cos(a) * d;
  const z = playerGroup.position.z + Math.sin(a) * d;
  const y = th(x, z);
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.9, 24),
    new THREE.MeshBasicMaterial({ color: 0xfb923c, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI/2; ring.position.set(x, y + 0.15, z);
  scene.add(ring);
  setTimeout(() => {
    spawnBurst(x, y + 1, z, C.ember, 30, true);
    screenFlash('rgba(251,146,60,0.4)');
    const dp = Math.hypot(playerGroup.position.x - x, playerGroup.position.z - z);
    if (dp < 3) hitFlashAndDmg(3, playerGroup.position.clone());
    MOBS.forEach(m => {
      if (!m.alive) return;
      const dm = Math.hypot(m.mesh.position.x - x, m.mesh.position.z - z);
      if (dm < 3){ m.health -= 6; m.flash = 0.6; if (m.health <= 0) killMob(m, true); }
    });
    scene.remove(ring); ring.geometry.dispose(); ring.material.dispose();
  }, 800);
}

// ============================================================================
//  SECTION: MINIMAP
// ============================================================================
const mmap = $('minimap');
const mctx = mmap.getContext('2d');
let mmTick = 0;
let minimapZoom = 1;
mmap.addEventListener('click', () => {
  minimapZoom = minimapZoom === 1 ? 2 : 1;
  showToast('Minimap ' + minimapZoom + 'x', 'sky');
});
function drawMinimap(px, pz){
  const S = mmap.width, sc = (S / (WORLD_R * 2.35)) * minimapZoom;
  const cx = S/2, cz = S/2;
  mctx.clearRect(0, 0, S, S);
  mctx.fillStyle = '#0a0b1a'; mctx.fillRect(0, 0, S, S);
  if (state.world.dimension === 'voxel'){
    mctx.fillStyle = 'rgba(126,231,135,.15)';
    mctx.fillRect(cx + (-voxelState.worldW/2)*sc, cz + (-voxelState.worldW/2)*sc, voxelState.worldW*sc, voxelState.worldW*sc);
    mctx.fillStyle = CSS.voxel;
    MOBS.forEach(m => {
      if (!m.alive || m.dimension !== 'voxel') return;
      mctx.beginPath();
      mctx.arc(cx + (m.mesh.position.x - voxelState.worldW/2)*sc, cz + (m.mesh.position.z - voxelState.worldW/2)*sc, 2, 0, Math.PI*2);
      mctx.fill();
    });
    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    mctx.arc(cx, cz, 3, 0, Math.PI*2);
    mctx.fill();
  } else {
    mctx.fillStyle = 'rgba(40,95,155,.45)';
    mctx.fillRect(cx + (POND_X - POND_R)*sc, cz + (POND_Z - POND_R)*sc, POND_R*2*sc, POND_R*2*sc);
    mctx.fillStyle = 'rgba(252,211,77,.9)';
    BENCHES.forEach(b => mctx.fillRect(cx + b.x*sc - 2, cz + b.z*sc - 2, 4, 4));
    mctx.fillStyle = 'rgba(167,139,250,.9)';
    NPCS.forEach(n => { mctx.beginPath(); mctx.arc(cx + n.x*sc, cz + n.z*sc, 2, 0, Math.PI*2); mctx.fill(); });
    mctx.fillStyle = CSS.teal;
    CRYSTALS.forEach(c => {
      if (c.got) return;
      mctx.beginPath(); mctx.arc(cx + c.x*sc, cz + c.z*sc, 2.4, 0, Math.PI*2); mctx.fill();
    });
    mctx.fillStyle = state.gems >= PORTAL_NEED ? 'rgba(252,211,77,.95)' : 'rgba(167,139,250,.4)';
    mctx.beginPath(); mctx.arc(cx + portal.position.x*sc, cz + portal.position.z*sc, 3.4, 0, Math.PI*2); mctx.fill();
    mctx.fillStyle = 'rgba(232,121,249,.9)';
    MOBS.forEach(m => {
      if (!m.alive || m.dimension !== 'genesis') return;
      mctx.beginPath(); mctx.arc(cx + m.mesh.position.x*sc, cz + m.mesh.position.z*sc, m.isBoss ? 3.5 : 1.8, 0, Math.PI*2); mctx.fill();
    });
    MOBS.forEach(m => {
      if (!m.alive || !m.isEcho) return;
      mctx.fillStyle = CSS.corrupt;
      mctx.beginPath(); mctx.arc(cx + m.mesh.position.x*sc, cz + m.mesh.position.z*sc, 2.4, 0, Math.PI*2); mctx.fill();
    });
    mctx.save();
    mctx.translate(cx + px*sc, cz + pz*sc);
    mctx.rotate(yaw + Math.PI);
    mctx.fillStyle = '#eef1ff';
    mctx.beginPath();
    mctx.moveTo(0,-6); mctx.lineTo(3.4,3.4); mctx.lineTo(0,1.7); mctx.lineTo(-3.4,3.4);
    mctx.closePath(); mctx.fill();
    mctx.restore();
  }
  mctx.strokeStyle = 'rgba(150,175,255,.12)'; mctx.lineWidth = 1;
  mctx.strokeRect(0.5, 0.5, S-1, S-1);
}
function toggleMap(){ showToast('Minimap zoom: tap peta  ' + KAO.cheeky, 'sky'); }

// ============================================================================
//  SECTION: COMPASS
// ============================================================================
function updateCompass(){
  const px = playerGroup.position.x, pz = playerGroup.position.z;
  if (state.world.dimension === 'voxel'){
    $('cmpQuest').innerHTML = '(o) PORTAL KELUAR';
    $('cmpPortal').innerHTML = '(*) EXIT <b>' + Math.round(Math.hypot(voxelPortal.position.x - px, voxelPortal.position.z - pz)) + 'm</b>';
    $('cmpBiome').innerHTML = '(^) VOXEL ' + voxelState.biomeVoxel.toUpperCase();
    return;
  }
  let target = null, bestD = Infinity;
  if (state.gems < TOTAL_C){
    CRYSTALS.forEach(c => {
      if (c.got) return;
      const d = Math.hypot(c.x - px, c.z - pz);
      if (d < bestD){ bestD = d; target = { x: c.x, z: c.z }; }
    });
  } else target = { x: portal.position.x, z: portal.position.z };
  if (target){
    const dx = target.x - px, dz = target.z - pz;
    const d = Math.hypot(dx, dz);
    $('cmpQuest').innerHTML = '(o) QUEST <b>' + Math.round(d) + 'm</b>';
  } else $('cmpQuest').textContent = '(o) QUEST';
  const pDist = Math.hypot(portal.position.x - px, portal.position.z - pz);
  $('cmpPortal').innerHTML = '(*) PORTAL <b>' + Math.round(pDist) + 'm</b>';
  $('cmpBiome').innerHTML = '(^) ' + (BIOMES[state.world.biome]?.name || 'Realm').split(' ')[0].toUpperCase();
}

// ============================================================================
//  SECTION: MENUS
// ============================================================================
function togglePause(){
  if (!state.running) return;
  state.paused = !state.paused;
  if (state.paused) $('ovPause').classList.remove('hidden');
  else { $('ovPause').classList.add('hidden'); $('pausePanel').style.display = 'none'; }
}
$('resumeBtn').onclick = togglePause;
$('saveBtn').onclick = () => { saveGame(); showToast('Game disimpan  ' + KAO.cool, 'teal'); };
$('settingsBtn').onclick = () => {
  const panel = $('pausePanel');
  panel.style.display = 'block';
  panel.innerHTML = `
    <h4>Settings v4.0</h4>
    <div class="slider-row"><span>Sensitivitas</span><input type="range" id="psSens" min="0.5" max="2" step="0.05" value="${v4.sensitivity}"><b id="psSensV">${v4.sensitivity.toFixed(1)}x</b></div>
    <div class="slider-row"><span>Render Distance</span><input type="range" id="psRd" min="40" max="120" step="4" value="${v4.renderDist}"><b id="psRdV">${v4.renderDist}</b></div>
    <div class="slider-row"><span>Echo</span><div class="toggle ${v4.echoOn?'on':''}" data-tg="echoOn"></div></div>
    <div class="slider-row"><span>Corruption Shader</span><div class="toggle ${v4.corruptOn?'on':''}" data-tg="corruptOn"></div></div>
    <div class="slider-row"><span>Time Fracture</span><div class="toggle ${v4.fractureOn?'on':''}" data-tg="fractureOn"></div></div>
    <div class="slider-row"><span>Kill Cam</span><div class="toggle ${v4.killCamOn?'on':''}" data-tg="killCamOn"></div></div>
    <div class="slider-row"><span>Trails</span><div class="toggle ${v4.trailsOn?'on':''}" data-tg="trailsOn"></div></div>
    <div class="slider-row"><span>Bloom</span><div class="toggle ${v4.bloomOn?'on':''}" data-tg="bloomOn"></div></div>
    <div class="slider-row"><span>Dyn Resolution</span><div class="toggle ${v4.dynResOn?'on':''}" data-tg="dynResOn"></div></div>
    <div class="slider-row"><span>Film Grain</span><div class="toggle ${v4.grainOn?'on':''}" data-tg="grainOn"></div></div>
    <div class="slider-row"><span>Mode Performa (HP kentang)</span><div class="toggle ${v4.perfMode?'on':''}" data-tg="perfMode"></div></div>
  `;
  const sens = panel.querySelector('#psSens');
  sens.oninput = () => { v4.sensitivity = parseFloat(sens.value); panel.querySelector('#psSensV').textContent = v4.sensitivity.toFixed(1)+'x'; saveSettings(); };
  const rd = panel.querySelector('#psRd');
  rd.oninput = () => { v4.renderDist = parseInt(rd.value); panel.querySelector('#psRdV').textContent = v4.renderDist; saveSettings(); };
  panel.querySelectorAll('[data-tg]').forEach(tg => {
    tg.onclick = () => {
      const k = tg.dataset.tg;
      v4[k] = !v4[k];
      tg.classList.toggle('on', v4[k]);
      if (k === 'bloomOn') bloom.enabled = v4.bloomOn && Q.bloom;
      if (k === 'shadowOn') characterAnim.setShadows(Q.shadows && v4.shadowOn);
      if (k === 'grainOn') $('grain').classList.toggle('on', v4.grainOn && state.corruption > 30);
      if (k === 'perfMode') applyPerfMode(v4.perfMode);
      saveSettings();
    };
  });
};
$('achBtn').onclick = () => {
  const panel = $('pausePanel');
  panel.style.display = 'block';
  const ach = state.achievements || {};
  panel.innerHTML = '<h4>Achievements</h4>' + ACHIEVEMENTS.map(a =>
    `<div class="ach ${ach[a.id]?'on':''}"><div class="ic">${ach[a.id]?'*':'-'}</div><div class="nm"><b style="color:var(--ink)">${a.name}</b><br>${a.desc}</div></div>`
  ).join('');
};
$('statsBtn').onclick = () => {
  const panel = $('pausePanel');
  panel.style.display = 'block';
  panel.innerHTML = `
    <h4>Statistics</h4>
    <div class="kv"><span>Level</span><b>${state.level}</b></div>
    <div class="kv"><span>Total Kill</span><b>${state.enemiesKilled}</b></div>
    <div class="kv"><span>Boss Kills</span><b>${state.bossKills}</b></div>
    <div class="kv"><span>Parries</span><b>${state.parries}</b></div>
    <div class="kv"><span>Echoes Slain</span><b>${state.echoKills || 0}</b></div>
    <div class="kv"><span>Distance</span><b>${Math.round(state.distance)}m</b></div>
    <div class="kv"><span>Dimension</span><b>${state.world.dimension}</b></div>
    <div class="kv"><span>Session Time</span><b>${Math.round((performance.now()-state.startT)/1000)}s</b></div>
  `;
};
$('quitBtn').onclick = () => location.reload();

// ============================================================================
//  SECTION: START / RESET
// ============================================================================
let portalWasActiveSent = false;
let portalActive = false;
const OPENING_STORY = [
  { title:'Retakan Pertama', text:'Dulu, waktu menyatukan setiap sudut dunia ini. Seseorang memecahkan inti itu—dan kini lembah mengulang hari yang sama.' },
  { title:'Gema Sang Penjaga', text:'Kristal yang tersebar menyimpan ingatan dunia. Para penjaga bukan sekadar musuh: mereka adalah gema dari siklus yang gagal kau hentikan.' },
  { title:'Jalan Menuju Portal', text:'Temukan delapan kristal, kuatkan dirimu, lalu tembus portal. Di baliknya, realitas voxel menyimpan petunjuk tentang siapa yang memulai kehancuran.' }
];
let openingStoryIndex = 0;
function closeOpeningStory(){
  $('storyIntro').classList.remove('on');
  state.paused = false;
  try { sessionStorage.setItem('realm_ultra_story_seen', '1'); } catch(e){}
}
function beginOpeningStory(){
  let seen = false;
  try { seen = sessionStorage.getItem('realm_ultra_story_seen') === '1'; } catch(e){}
  if (seen) return;
  openingStoryIndex = 0;
  state.paused = true;
  const show = () => {
    const beat = OPENING_STORY[openingStoryIndex];
    $('storyHeading').textContent = beat.title;
    $('storyCopy').textContent = beat.text;
    $('storyCount').textContent = (openingStoryIndex + 1) + ' / ' + OPENING_STORY.length;
    $('storyNext').textContent = openingStoryIndex === OPENING_STORY.length - 1 ? 'Mulai Jelajah' : 'Lanjut';
  };
  show();
  $('storyIntro').classList.add('on');
}
$('storyNext').onclick = () => {
  if (openingStoryIndex < OPENING_STORY.length - 1){ openingStoryIndex++; beginOpeningStoryPage(); }
  else closeOpeningStory();
};
function beginOpeningStoryPage(){
  const beat = OPENING_STORY[openingStoryIndex];
  $('storyHeading').textContent = beat.title;
  $('storyCopy').textContent = beat.text;
  $('storyCount').textContent = (openingStoryIndex + 1) + ' / ' + OPENING_STORY.length;
  $('storyNext').textContent = openingStoryIndex === OPENING_STORY.length - 1 ? 'Mulai Jelajah' : 'Lanjut';
  const card = document.querySelector('.story-card');
  card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
}
$('storySkip').onclick = closeOpeningStory;
addEventListener('keydown', e => { if (e.code === 'Escape' && $('storyIntro').classList.contains('on')) closeOpeningStory(); });

function applyClass(cls){
  state.playerClass = cls;
  const cfg = CLASSES[cls];
  state.maxHp = cfg.hp;
  state.hp = cfg.hp;
  if (characterAnim){
    characterAnim.setTint(cfg.color);
    const accent = cls === 'void' ? C.magenta : (cls === 'ward' ? C.teal : (cls === 'engineer' ? C.voxel : C.amber));
    characterAnim.setAccent(accent);
  }
  syncVitals();
}
function startGame(){
  state.running = true;
  state.paused = false;
  state.won = false; state.dead = false;
  state.gems = 0;
  state.stamina = 1;
  state.ult = 0;
  state.corruption = 0; state.overload = 0;
  state.trauma = 0; state.velY = 0; state.grounded = true;
  state.score = 0; state.combo = 1; state.comboTimer = 0;
  state.invuln = 0; state.swing = 0;
  state.startT = performance.now();
  state.atkCoeff = 1;
  state.enemiesKilled = 0; state.crits = 0; state.attacks = 0;
  state.killCount = 0; state.echoKills = 0; state.ultCount = 0;
  state.bossKills = 0; state.parries = 0;
  state.dashCd = 0; state.atkCd = 0;
  state.parryActive = 0; state.parryCd = 0;
  state.charging = false; state.chargeT = 0;
  state.hitstop = 0; state.slowmo = 0; state.killCam = 0;
  state.day = 0.35;
  state.weapon = 'sword';
  characterAnim.attachWeapon('sword');
  characterAnim.setArmorTier(3);
  characterAnim.setState('idle');
  characterMoveSpeed = 0;
  state.echoTimer = TUNING.echoInterval;
  state.echoRecorder = []; state.recordTimer = 0;
  state.rewindBuf = []; state.rewindTick = 0;
  state.fractureCd = 0; state.fractureCharges = 1;
  state.hotbar = ['sword', null, null, null, null, null, null, null, null];
  state.hotbarIdx = 0;
  state.mining = null;
  state.mineProgress = 0;
  state.hpGhost = state.hp;
  state.cinematic = 0;
  state.endermanKills = 0;
  state.minedCount = 0;
  updateHotbarUI();
  $('stamArc').classList.add('on');
  $('wLabel').textContent = 'S';
  applyClass(state.playerClass);
  syncVitals();
  $('gems').textContent = '0/' + TOTAL_C;
  $('ovStart').classList.add('hidden');
  $('ovOver').classList.add('hidden');
  $('ovDead').classList.add('hidden');
  $('ovPause').classList.add('hidden');
  $('bossbar').classList.remove('on');
  $('killcam').classList.remove('on');
  $('voxelDim').classList.remove('on');
  CRYSTALS.forEach(c => { c.got = false; c.mesh.visible = true; c.mesh.scale.set(1,1,1); c.mesh.position.y = th(c.x,c.z)+1.2; });
  HEALS.forEach(h => { h.got = false; h.mesh.visible = true; h.mesh.position.y = th(h.x,h.z)+0.75; });
  MOBS.forEach(m => disposeMobVisual(m));
  MOBS.length = 0;
  activeBoss = null;
  spawnMobsAround(state.level - 1);
  // clear pools
  particles.forEach(p => { if (p.mesh.parent) scene.remove(p.mesh); particlePool.push(p); });
  particles.length = 0;
  dmgNumbers.forEach(d => { if (d.spr.parent) scene.remove(d.spr); dmgPool.push(d); });
  dmgNumbers.length = 0;
  rainParticles.forEach(r => { if (r.mesh.parent) scene.remove(r.mesh); rainPool.push(r); });
  rainParticles.length = 0;
  projectiles.forEach(p => { if (p.mesh.parent) scene.remove(p.mesh); projPool.push(p); });
  projectiles.length = 0;
  trails.forEach(t => { if (t.mesh.parent) scene.remove(t.mesh); trailPool.push(t); });
  trails.length = 0;
  decals.forEach(d => { if (d.mesh.parent) scene.remove(d.mesh); decalPool.push(d); });
  decals.length = 0;
  // Genesis only
  ground.visible = true;
  if (water) water.visible = true;
  playerGroup.position.set(0, th(0,0), 0);
  yaw = 0; pitch = -0.22;
  state.world.dimension = 'genesis';
  portalWasActiveSent = false;
  portalActive = false;
  startDrone();
  tone(440, 0.1, 'triangle', 0.07, 0, 900);
  const fade = $('fade');
  fade.style.transition = 'none'; fade.style.opacity = '1';
  requestAnimationFrame(() => {
    fade.style.transition = 'opacity 1.1s ease';
    fade.style.opacity = '0';
  });
}
function die(){
  characterAnim.play('dead');
  state.dead = true;
  state.running = false;
  loseSfx();
  state.trauma = Math.min(1, state.trauma + 0.8);
  $('ovDead').classList.remove('hidden');
}
function win(){
  characterAnim.play('victory');
  state.won = true;
  state.running = false;
  winSfx();
  const t = (performance.now() - state.startT) / 1000;
  if (t < 60) unlockAch('speedrun60');
  $('timeOut').textContent = t.toFixed(1) + ' dtk';
  $('dmgStats').textContent = 'KILL - ' + state.enemiesKilled + ' - CRIT - ' + state.crits + ' - SCORE - ' + state.score + ' - LVL - ' + state.level;
  let best = parseFloat(localStorage.getItem('realm_max_best') || '0');
  if (!best || t < best){ best = t; try { localStorage.setItem('realm_max_best', String(t)); } catch(e){} }
  saveGame();
  $('ovOver').classList.remove('hidden');
}
function collectCrystal(c){
  if (!c || c.got) return;
  c.got = true;
  state.gems += 1;
  state.score = (state.score || 0) + 100 * (state.combo || 1);
  state.combo = Math.min(9, (state.combo || 0) + 1);
  state.ult = Math.min(100, state.ult + 12);
  try { if (state.echoCharges < 3 && state.gems % 3 === 0) state.echoCharges += 1; } catch(e){}
  try { c.mesh.visible = false; } catch(e){}
  try { c.mesh.scale.set(0.001, 0.001, 0.001); } catch(e){}
  try { spawnBurst(c.x, c.mesh.position.y, c.z, C.teal, 22, true); } catch(e){}
  try { pickupSfx(660 + state.gems * 30); } catch(e){}
  try { screenFlash(CSS.teal); } catch(e){}
  try { showToast('Kristal ' + state.gems + '/' + TOTAL_C + '  ' + KAO.sparkle, 'teal'); } catch(e){}
  try { syncVitals(); } catch(e){}
  if (state.gems >= TOTAL_C){
    state.comboTimer = 2.8;
    try { showToast('Semua kristal terkumpul! Portal terbuka  ' + KAO.cool, 'amber'); } catch(e){}
  }
  try { saveGame(); } catch(e){}
}

function hitFlashAndDmg(dmg, pos){
  if (state.invuln > 0) return;
  state.invuln = 1.0;
  characterAnim.play('hurt');
  hurtFlash();
  const amt = Math.max(1, Math.round(dmg));
  state.hpGhost = state.hp;
  state.hp = Math.max(0, state.hp - amt);
  syncVitals();
  spawnDmg(pos.clone(), '-' + amt, CSS.magenta);
  spatialTone(pos.x, pos.y, pos.z, 160, 0.2, 'sawtooth', 0.13);
  noiseBurst(0.1, 0.06, 900);
  if (state.hp <= 0) die();
}

// ============================================================================
//  SECTION: MOVEMENT
// ============================================================================
function dir(){
  let fx = 0, fz = 0;
  if (keys['KeyW'] || keys['ArrowUp'] || padDown['fwd'])   { fx -= Math.sin(yaw); fz -= Math.cos(yaw); }
  if (keys['KeyS'] || keys['ArrowDown'] || padDown['back']) { fx += Math.sin(yaw); fz += Math.cos(yaw); }
  if (keys['KeyA'] || keys['ArrowLeft'] || padDown['left']) { fx -= Math.cos(yaw); fz += Math.sin(yaw); }
  if (keys['KeyD'] || keys['ArrowRight'] || padDown['right']){ fx += Math.cos(yaw); fz -= Math.sin(yaw); }
  if (moveTouchId !== null){
    const mag = Math.hypot(stickX, stickY);
    if (mag > STICK_DEADZONE){
      const nx = stickX / mag, ny = stickY / mag;
      const strength = Math.min(1, (mag - STICK_DEADZONE) / 60);
      fx = 0; fz = 0;
      fx += (-Math.sin(yaw)) * (-ny) + (Math.cos(yaw)) * nx;
      fz += (-Math.cos(yaw)) * (-ny) + (-Math.sin(yaw)) * nx;
      fx *= strength; fz *= strength;
      return { x: fx, z: fz, mag: strength };
    }
  }
  const len = Math.hypot(fx, fz);
  const l = len || 1;
  return { x: fx/l, z: fz/l, mag: Math.min(1, len) };
}

// ============================================================================
//  SECTION: COMPANION AI
// ============================================================================
function updateCompanion(dt){
  if (!petGroup || petGroup.userData.dead) return;
  const voxel = (state.world.dimension === 'voxel');
  petGroup.visible = !voxel && state.running && !state.won && !state.dead;
  if (voxel || !state.running || state.won || state.dead) return;
  if (state.paused) return;
  PET.phase += dt * 7;
  // locate nearest live hostile mob
  let tgt = null, tDist = 16;
  for (let i = 0; i < MOBS.length; i++){
    const m = MOBS[i];
    if (!m || !m.alive) continue;
    const d = Math.hypot(m.mesh.position.x - petGroup.position.x, m.mesh.position.z - petGroup.position.z);
    if (d < tDist){ tDist = d; tgt = m; }
  }
  const behindX = playerGroup.position.x - Math.sin(yaw) * 2.6;
  const behindZ = playerGroup.position.z - Math.cos(yaw) * 2.6;
  let goalX = behindX, goalZ = behindZ, goalY = th(behindX, behindZ);
  if (tgt){
    goalX = tgt.mesh.position.x;
    goalZ = tgt.mesh.position.z;
    goalY = tgt.mesh.position.y;
    const dx = tgt.mesh.position.x - petGroup.position.x;
    const dz = tgt.mesh.position.z - petGroup.position.z;
    const dd = Math.hypot(dx, dz) || 1;
    if (dd > 1.8){
      petGroup.position.x += (dx / dd) * Math.min(dd, 6.6 * dt);
      petGroup.position.z += (dz / dd) * Math.min(dd, 6.6 * dt);
    } else {
      PET.cd -= dt;
      if (PET.cd <= 0){
        PET.cd = 2.1;
        const dmg = Math.max(1, Math.round(2 + state.level * 0.45));
        tgt.health -= dmg;
        tgt.flash = 0.6; tgt.stun = 0.35;
        const mp = tgt.mesh.position;
        spawnDmg(new THREE.Vector3(mp.x, mp.y + 1.2, mp.z), (dmg >= 4 ? 'CRIT ' : '') + dmg, dmg >= 4 ? CSS.amber : CSS.teal);
        spawnBurst(mp.x, mp.y + 0.5, mp.z, C.teal, 10, true);
        spatialTone(mp.x, mp.y, mp.z, 360, 0.06, 'triangle', 0.05);
        if (tgt.health <= 0) killMob(tgt, true);
      }
    }
  } else {
    PET.cd -= dt; if (PET.cd < 0) PET.cd = 0;
    const dx = behindX - petGroup.position.x;
    const dz = behindZ - petGroup.position.z;
    const dd = Math.hypot(dx, dz) || 1;
    if (dd > 0.12){
      petGroup.position.x += (dx / dd) * Math.min(dd, 3.2 * dt);
      petGroup.position.z += (dz / dd) * Math.min(dd, 3.2 * dt);
    }
  }
  // Ground lock + bob
  const groundY = th(petGroup.position.x, petGroup.position.z) + 0.05;
  const moveSpeedHint = tgt && tDist < 14 ? 6.6 : 3.2;
  let moving = tgt && tDist > 1.9;
  if (!tgt) moving = Math.hypot(petGroup.position.x - behindX, petGroup.position.z - behindZ) > 0.15;
  petGroup.position.y += (groundY + (moving ? 0.06 * Math.sin(PET.phase) : 0) - petGroup.position.y) * clamp(0.12 + dt * 18, 0, 1);
  // Face motion/target
  const fx = goalX - petGroup.position.x;
  const fz = goalZ - petGroup.position.z;
  if (Math.hypot(fx, fz) > 0.01){
    const lookYaw = Math.atan2(fx, fz);
    let diff = lookYaw - petGroup.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    petGroup.rotation.y += diff * Math.min(1, 8 * dt);
  }
  // tail wiggle
  if (petTail){ petTail.rotation.y = Math.sin(PET.phase * 1.6) * 0.45; }
  petBody.rotation.x = Math.sin(PET.phase * 0.9) * 0.03;
}

// ============================================================================
//  SECTION: ENVIRONMENT UPDATE
// ============================================================================
const _tmpSky = new THREE.Color();
function updateEnvironment(dt){
  state.day = (state.day + dt * 0.003334) % 1;
  const dayness = (Math.sin(state.day * Math.PI * 2) + 1) / 2;
  const stormy = (state.weather === 'storm' || state.weather === 'overcast');
  const foggy  = state.weather === 'fog';
  const night  = state.weather === 'bloodmoon';
  const aurora = state.weather === 'aurora';
  const isVoxel = state.world.dimension === 'voxel';
  const biome = isVoxel ? { sky: 0x87ceeb, grass: 0x6bbf4a, treeCol: 0x4a7a2a } : (BIOMES[state.world.biome] || BIOMES.verdant);
  const nightCol = new THREE.Color(C.night);
  const dayCol = new THREE.Color(biome.sky);
  const mix = clamp(dayness * 0.85 + (stormy ? -0.05 : 0.05), 0, 1);
  _tmpSky.copy(nightCol).lerp(dayCol, mix);
  if (night) _tmpSky.lerp(new THREE.Color(0x6b0a20), 0.5);
  if (aurora) _tmpSky.lerp(new THREE.Color(0x1a3a5a), 0.35);
  skyColor.copy(_tmpSky);
  scene.fog.color.copy(skyColor);
  scene.fog.density = (stormy ? 0.024 : (LOW ? 0.009 : 0.011)) + (1 - dayness) * 0.006 + (foggy ? 0.016 : 0);
  sun.intensity = (stormy ? 0.4 : 0.85) + dayness * 1.45;
  ambient.intensity = 0.65 + dayness * 0.6;
  starMat.opacity = clamp(1 - dayness * 3.2, 0, 1) * 0.85;
  if (bloom.enabled) bloom.strength = Q.bloomStrength * (0.55 + dayness * 0.55);
  sun.position.copy(playerGroup.position).add(sunOffset);
  sun.target.position.copy(playerGroup.position); sun.target.updateMatrixWorld();
  moon.position.copy(playerGroup.position).add(moonOffset);
  moon.intensity = (1 - dayness) * 0.5 + (night ? 0.3 : 0);
  const gHex = stormy ? 0x1e4a3e : biome.grass;
  grassMat.color.setHex(gHex);
  leafMat.color.setHex(biome.treeCol);
  windUniform.value += dt;
  playerPosU.value.copy(playerGroup.position);
  if (water) water.material.uniforms['time'].value += dt * 0.3;
  // biome change (genesis only)
  if (!isVoxel){
    const bx = playerGroup.position.x, bz = playerGroup.position.z;
    const b = biomeAt(bx, bz);
    if (state.world.biome !== b){
      state.world.biome = b;
      showToast('Biome - ' + (BIOMES[b]?.name || b), 'violet');
      biomesVisited.add(b);
      if (biomesVisited.size >= 5) unlockAch('biome5');
    }
  }
  weatherTimer += dt;
  if (weatherTimer > 180 && !isVoxel){ weatherTimer = 0; cycleWeather(); }
  if (state.weather === 'storm' && !isVoxel){
    lightningTimer += dt;
    if (lightningTimer > 3 + rnd() * 3){ lightningTimer = 0; lightningStrike(); }
  }
  if (state.weather === 'meteor' && !isVoxel){
    meteorTimer += dt;
    if (meteorTimer > 1.5 + rnd() * 1.5){ meteorTimer = 0; meteorFall(); }
  }
  const hour = Math.floor(state.day * 24);
  const min = Math.floor((state.day * 24 - hour) * 60);
  $('clock').textContent = String(hour).padStart(2,'0') + ':' + String(min).padStart(2,'0');
  // voxel visibility
  const genVisible = !isVoxel;
  ground.visible = genVisible;
  if (water) water.visible = genVisible;
  chunkStore.forEach(c => {
    c.group.userData.dim = isVoxel ? 'hidden' : 'genesis';
    if (isVoxel) c.group.visible = false;
  });
  if (!isVoxel) voxelState.chunks.forEach(ch => { ch.group.visible = false; });
  portal.visible = !isVoxel;  // show only the portal belonging to the active dimension
  voxelPortal.visible = isVoxel;
}

// ============================================================================
//  SECTION: GAMEPLAY UPDATE
// ============================================================================
const _camTarget = new THREE.Vector3();
const _camPos = new THREE.Vector3();
let traumaTime = 0, bobPhase = 0, bobAmp = 0;
function updateGameplay(dt){
  const wasGrounded = state.grounded;
  const p = playerGroup.position;
  const { x: mx, z: mz, mag } = dir();
  const cls = CLASSES[state.playerClass];
  const isVoxel = state.world.dimension === 'voxel';
  if (state.charging) state.chargeT += dt;
  if (state.parryActive > 0) state.parryActive -= dt;
  state.parryCd = Math.max(0, state.parryCd - dt);
  const sprint = (keys['ShiftLeft'] || keys['ShiftRight']) && mag > 0.1 && state.stamina > 0.02;
  state.sprinting = sprint;
  const speed = TUNING.playerBaseSpeed * cls.spdMul * (sprint ? TUNING.sprintMult : 1) * mag * (state.dashing ? 1.8 : 1);
  const weatherSlow = state.weather === 'snow' ? 0.75 : 1;
  const overMul = state.overload > 0 ? 1.4 : 1;
  const finalSpeed = speed * weatherSlow * overMul;
  characterMoveSpeed = mag > 0.1 ? finalSpeed : 0;
  if (mag > 0.1){
    const nx = p.x + mx * finalSpeed * dt;
    const nz = p.z + mz * finalSpeed * dt;
    if (isVoxel){
      // simple voxel collision: check next cell solid at chest height
      const testX = nx, testZ = nz;
      const chestY = p.y + 0.5;
      if (!voxSolidAt(testX, chestY, p.z)) p.x = nx;
      if (!voxSolidAt(p.x, chestY, testZ)) p.z = nz;
      p.x = clamp(p.x, 1, voxelState.worldW - 1);
      p.z = clamp(p.z, 1, voxelState.worldW - 1);
    } else {
      if (Math.abs(nx) < WORLD_R - 1) p.x = nx;
      if (Math.abs(nz) < WORLD_R - 1) p.z = nz;
    }
    playerGroup.rotation.y = Math.atan2(mx, mz);
    state.distance += Math.hypot(mx, mz) * finalSpeed * dt;
    const walkPhase = performance.now() * 0.012;
    const swingAmp = sprint ? 0.7 : 0.45;
    const sw = Math.sin(walkPhase);
    rig.armL.shoulder.rotation.x = sw * swingAmp;
    rig.armR.shoulder.rotation.x = -sw * swingAmp * 0.6;
    rig.legL.hip.rotation.x = -sw * swingAmp * 1.2;
    rig.legR.hip.rotation.x = sw * swingAmp * 1.2;
    rig.legL.knee.rotation.x = Math.max(0, -sw) * 0.6;
    rig.legR.knee.rotation.x = Math.max(0, sw) * 0.6;
    bobAmp = Math.min(0.05, bobAmp + 0.1*dt);
    bobPhase += dt * (sprint ? 15 : 10.5);
  } else {
    bobAmp = Math.max(0, bobAmp - 0.2*dt);
    const breath = Math.sin(performance.now() * 0.0015);
    rig.chest.rotation.x = breath * 0.03;
    rig.head.rotation.y = Math.sin(performance.now() * 0.0008) * 0.1;
    rig.armL.shoulder.rotation.x *= 0.9;
    rig.armR.shoulder.rotation.x *= 0.9;
    rig.legL.hip.rotation.x *= 0.9;
    rig.legR.hip.rotation.x *= 0.9;
  }
  state.stamina = clamp(state.stamina + (sprint ? -0.10 : 0.10) * dt, 0, 1);
  // Gravity / ground
  const grav = TUNING.gravity * (isVoxel ? TUNING.voxelGravityMult : 1);
  state.velY -= grav * dt;
  p.y += state.velY * dt;
  let gy;
  if (isVoxel){
    gy = voxGroundHeight(p.x, p.z);
  } else {
    gy = th(p.x, p.z);
  }
  if (p.y <= gy){ p.y = gy; state.velY = 0; state.grounded = true; }
  else state.grounded = false;
  if (!wasGrounded && state.grounded) characterAnim.play('land');
  if (state.comboTimer > 0){ state.comboTimer -= dt; if (state.comboTimer <= 0) state.combo = 1; }
  state.trauma = Math.max(0, state.trauma - 1.5*dt);
  state.dashCd = Math.max(0, state.dashCd - dt);
  state.atkCd = Math.max(0, state.atkCd - dt);
  state.invuln = Math.max(0, state.invuln - dt);
  state.hitstop = Math.max(0, state.hitstop - dt);
  state.fractureCd = Math.max(0, state.fractureCd - dt);
  if (state.fractureCd <= 0 && state.fractureCharges < 1) state.fractureCharges = 1;
  if (state.hitstop > 0) return;
  $('dashCold').textContent = state.dashCd > 0 ? state.dashCd.toFixed(1) : '';
  $('qCold').textContent = state.parryCd > 0 ? state.parryCd.toFixed(1) : '';
  // Overload
  if (state.overload > 0){
    state.overload -= dt;
    state.hpDrainAcc = (state.hpDrainAcc || 0) + dt;
    if (state.hpDrainAcc > 1.2){
      state.hpDrainAcc = 0;
      state.hp = Math.max(1, state.hp - 1);
      syncVitals();
      spawnDmg(playerGroup.position.clone(), '-1', CSS.corrupt);
    }
    if (state.overload <= 0){
      state.corruption = 30;
      showToast('Overload berakhir  ' + KAO.hmm, 'sky');
    }
  }
  if (state.overload <= 0 && state.corruption > 0){
    state.corruption = Math.max(0, state.corruption - TUNING.corruptDecay * dt);
  }
  // Sword swing
  if (state.swing > 0){
    state.swing = Math.max(0, state.swing - dt * 4.6);
    const k = 1 - state.swing;
    let arc = Math.sin(k * Math.PI);
    if (state.comboStep === 0) rig.armR.shoulder.rotation.x = -arc * 1.6;
    else if (state.comboStep === 1) rig.armR.shoulder.rotation.z = -arc * 1.4;
    else { rig.chest.rotation.y = arc * 2.0; rig.armR.shoulder.rotation.x = -arc * 1.2; }
    rig.armR.lowerGrp.rotation.x = -arc * 0.8;
  } else {
    rig.armR.shoulder.rotation.x *= 0.92;
    rig.armR.shoulder.rotation.z *= 0.92;
    rig.armR.lowerGrp.rotation.x *= 0.92;
    rig.chest.rotation.y *= 0.92;
  }
  // Blink animation (voidwalker eyes)
  state.blink -= dt;
  if (state.blink <= 0){
    state.blink = 2 + Math.random() * 4;
    rig.eyes.forEach(e => e.visible = false);
    setTimeout(() => rig.eyes.forEach(e => e.visible = true), 120);
  }
  // Mining
  if (state.mining) updateMining(dt);
  // Camera
  const followDist = state.killCam > 0 ? 4.4 : 6.6;
  const cosP = Math.cos(pitch);
  const fovBase = 74;
  const fovTarget = state.charging ? 62 : (state.parryActive > 0 ? 66 : (state.killCam > 0 ? 58 : fovBase));
  camera.fov += (fovTarget - camera.fov) * Math.min(1, dt*6);
  camera.updateProjectionMatrix();
  _camPos.set(
    p.x + Math.sin(yaw) * followDist * cosP,
    p.y + 2.9 + Math.sin(-pitch) * (followDist * 0.5),
    p.z + Math.cos(yaw) * followDist * cosP
  );
  camera.position.lerp(_camPos, 0.16);
  _camTarget.set(p.x, p.y + 1.4, p.z);
  camera.lookAt(_camTarget);
  traumaTime += dt;
  const shake = state.trauma * state.trauma;
  const ns = (t, s) => { const x = Math.sin(t*12.9898 + s*78.233) * 43758.5453; return (x - Math.floor(x))*2 - 1; };
  camera.position.x += 0.55 * shake * ns(traumaTime*34, 1);
  camera.position.y += 0.5 * shake * ns(traumaTime*34, 2);
  p.y += Math.sin(bobPhase) * bobAmp * 0.5;

  // Crystals (Genesis only)
  const nowMs = performance.now();
  if (!isVoxel){
    for (let i = 0; i < CRYSTALS.length; i++){
      const c = CRYSTALS[i];
      if (c.got) continue;
      c.mesh.position.y = th(c.x, c.z) + 1.2 + Math.sin(nowMs*0.003 + c.x) * 0.12;
      c.mesh.rotation.y += dt * 1.6;
      const dx = c.mesh.position.x - p.x, dz = c.mesh.position.z - p.z;
      if (dx*dx + dz*dz < 1.96) collectCrystal(c);
    }
    for (let i = 0; i < HEALS.length; i++){
      const h = HEALS[i];
      if (h.got) continue;
      h.mesh.rotation.x += dt; h.mesh.rotation.y += dt * 0.7;
      const dx = h.mesh.position.x - p.x, dz = h.mesh.position.z - p.z;
      if (dx*dx + dz*dz < 1.82){
        h.got = true;
        state.hp = Math.min(state.maxHp, state.hp + 2);
        syncVitals();
        showToast('Pulih +2  ' + KAO.happy, 'teal');
        tone(780, 0.2, 'triangle', 0.07);
        spawnBurst(h.mesh.position.x, h.mesh.position.y, h.mesh.position.z, C.violet, 10, true);
        h.mesh.visible = false;
      }
    }
  }

  // Mobs
  let nearbyHostile = 0;
  for (let i = 0; i < MOBS.length; i++){
    const m = MOBS[i];
    if (!m.alive) continue;
    if (!m._id) m._id = mobIdCounter++;
    // dimension filter
    if (m.dimension === 'genesis' && isVoxel) { m.mesh.visible = false; continue; }
    if (m.dimension === 'voxel' && !isVoxel) { m.mesh.visible = false; continue; }
    m.mesh.visible = true;
    const sm = m.mesh;
    if (m.isEcho){ updateEcho(m, dt); continue; }
    if (m.dimension === 'voxel') updateVoxelMobAI(m, dt, p, nowMs);
    else updateGenesisMobAI(m, dt, p, nowMs);
    const dx = sm.position.x - p.x, dz = sm.position.z - p.z;
    const dP = Math.hypot(dx, dz) || 0.001;
    if (dP > 58) sm.visible = false;   // v4.5 perf: far monsters stop drawing
    if (dP < m.sense * 1.4) nearbyHostile++;
  }

  // Threat level
  const threatTarget = clamp(nearbyHostile / 6 + (activeBoss ? 1 : 0), 0, 1);
  state.threat += (threatTarget - state.threat) * Math.min(1, dt * 1.5);

  // Projectiles
  for (let i = projectiles.length - 1; i >= 0; i--){
    const pr = projectiles[i];
    pr.mesh.position.x += pr.vel.x * dt;
    pr.mesh.position.y += pr.vel.y * dt;
    pr.mesh.position.z += pr.vel.z * dt;
    pr.life -= dt;
    const dp = Math.hypot(pr.mesh.position.x - p.x, pr.mesh.position.z - p.z);
    if (dp < 0.7 && pr.life > 0){
      hitFlashAndDmg(pr.dmg, pr.mesh.position.clone());
      pr.life = 0;
    }
    if (pr.life <= 0){
      scene.remove(pr.mesh);
      projPool.push(pr);
      projectiles.splice(i, 1);
    }
  }

  // Portal
  if (!isVoxel){
    portalActive = state.gems >= PORTAL_NEED;
    if (!portalWasActiveSent && portalActive){
      portalWasActiveSent = true;
      showToast('Portal aktif - jalan masuk ke Voxel Realm  ' + KAO.sparkle, 'amber');
      tone(880, 0.25, 'triangle', 0.08, 0, 1320);
    }
    if (portalActive){
      const dx = p.x - portal.position.x, dz = p.z - portal.position.z;
      if (dx*dx + dz*dz < 8){
        enterVoxelDimension();
      }
    }
  } else {
    // exit portal
    const dx = p.x - voxelPortal.position.x, dz = p.z - voxelPortal.position.z;
    if (dx*dx + dz*dz < 8){
      exitVoxelDimension();
    }
  }

  // Boss bar
  if (activeBoss && activeBoss.alive){
    const pct = (activeBoss.health / activeBoss.maxHp) * 100;
    $('bossHp').style.width = pct + '%';
    const phase = pct > 66 ? 1 : pct > 33 ? 2 : 3;
    if (phase !== activeBoss.phase){
      activeBoss.phase = phase;
      activeBoss.attackDmg += 1;
      activeBoss.spec.chase += 0.5;
      showToast('BOSS PHASE ' + phase + '  ' + KAO.determined, 'magenta');
      updateBossPips(3, phase);
    }
    $('bossPhase').textContent = 'PHASE ' + ['I','II','III'][phase-1] + ' / III';
  }
  // Interact prompt
  let near = null, nd = 3.5;
  if (!isVoxel){
    const pdp = Math.hypot(portal.position.x - p.x, portal.position.z - p.z);
    if (pdp < 6 && pdp < nd){
      nd = pdp;
      near = portalActive ? 'Masuk PORTAL Voxel Realm' : 'Portal butuh ' + Math.max(0, PORTAL_NEED - state.gems) + ' kristal lagi';
    }
    BENCHES.forEach(b => {
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < nd){ nd = d; near = 'Bench [E] Crafting'; }
    });
    NPCS.forEach(n => {
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < nd){ nd = d; near = '[E] ' + n.name; }
    });
  } else {
    near = '[E] Mine block';
  }
  if (near) $('hint-bar').innerHTML = '<b>' + near + '</b>';
  else $('hint-bar').innerHTML = '<b>WASD</b> move - <b>F</b> attack - <b>Q</b> parry - <b>R</b> ult - <b>Z</b> rewind - <b>1-9</b> hotbar';

  // HUD
  $('gems').textContent = state.gems + '/' + TOTAL_C;
  syncVitals();
  updateCompass();
  // Echo timer (genesis only)
  if (!isVoxel){
    state.echoTimer -= dt;
    if (state.echoTimer <= 0){
      state.echoTimer = TUNING.echoInterval;
      if (v4.echoOn && MOBS.filter(m => m.alive && m.isEcho).length < 2) spawnEcho();
    }
  }
}

// Genesis mob AI
function updateGenesisMobAI(m, dt, p, nowMs){
  const sm = m.mesh;
  const dx = sm.position.x - p.x, dz = sm.position.z - p.z;
  const dP = Math.hypot(dx, dz) || 0.001;
  // --- v4.5 anime animator ---
  if (m._mon){
    m._mon.update(dt, {
      mode: (m.mode === 'chase' || m.mode === 'attack' || m.mode === 'alert') ? 'chase' : 'patrol',
      speed: m.spec.chase, dP: dP, t: nowMs
    });
  }
  if (m.stun > 0) m.stun -= dt;
  if (dP < m.sense && m.mode !== 'attack'){
    if (m.mode === 'patrol') m.mode = 'alert';
    else if (m.mode === 'alert' && dP < m.sense * 0.7) m.mode = 'chase';
  }
  if (m.mode === 'alert' && dP < m.sense * 0.6) m.mode = 'chase';
  if (m.mode === 'chase' || m.mode === 'attack') if (dP > m.sense * 1.5) m.mode = 'retreat';
  if (m.mode === 'retreat' && dP > m.sense * 2.5) m.mode = 'patrol';
  if (m.mode === 'patrol' && m.nextRetarget < nowMs && Math.random() < 0.5){
    m.nextRetarget = nowMs + 2600 + Math.random()*2600;
    m.target = { x: sm.position.x + (Math.random()*2-1)*16, z: sm.position.z + (Math.random()*2-1)*16 };
  }
  if (m.mode === 'chase' || m.mode === 'attack' || m.mode === 'alert') m.target = { x: p.x, z: p.z };
  const tx = m.target.x - sm.position.x;
  const tz = m.target.z - sm.position.z;
  const tl = Math.hypot(tx, tz) || 1;
  let spd;
  if (m.mode === 'chase' || m.mode === 'attack') spd = m.spec.chase;
  else if (m.mode === 'retreat') spd = m.spec.chase * 1.1;
  else spd = m.spec.speed;
  spd *= (m.stun > 0 ? 0.15 : 1) * dt;
  if (state.weather === 'snow') spd *= 0.75;
  const step = Math.min(spd, tl);
  const nx2 = sm.position.x + (tx/tl) * step;
  const nz2 = sm.position.z + (tz/tl) * step;
  if (Math.abs(nx2) < WORLD_R - 1) sm.position.x = nx2;
  if (Math.abs(nz2) < WORLD_R - 1) sm.position.z = nz2;
  sm.rotation.y = Math.atan2(tx, tz);
  m.anim += ((m.mode === 'chase') ? 1.1 : 0.65) * dt * 9;
  const bob = Math.sin(m.anim);
  m.body.scale.y = 1 + bob * 0.025;
  if (!m._mon){
    if (m.armL){
      const gait = m.mode === 'chase' ? 0.42 : 0.20;
      m.armL.rotation.x = Math.sin(m.anim * 0.7) * gait;
      m.armR.rotation.x = -Math.sin(m.anim * 0.7) * gait;
      m.armL.rotation.z = -0.12 - Math.max(0,bob) * 0.10;
      m.armR.rotation.z = 0.12 + Math.max(0,-bob) * 0.10;
    }
    if (m.head) m.head.rotation.x = m.mode === 'chase' ? -0.10 : Math.sin(m.anim * 0.22) * 0.035;
    if (m.veil) m.veil.rotation.z = Math.sin(m.anim * 0.35) * 0.08;
  }
  const baseY = m.flying ? th(sm.position.x, sm.position.z) + 1.25 + Math.sin(nowMs*0.002)*0.34 : th(sm.position.x, sm.position.z);
  sm.position.y = baseY + Math.abs(bob)*0.05;
  if (m.flash > 0){
    m.flash -= dt;
    if (m._mon){
      m._mon.setFlash(Math.max(0, m.flash));
    } else {
      m.mat.emissiveIntensity = m.baseEmissive + m.flash * 1.8;
      m.eyeMat.emissiveIntensity = m.eyeBaseEmissive + m.flash * 1.4;
      if (m.flash <= 0){
        m.mat.emissiveIntensity = m.baseEmissive;
        m.eyeMat.emissiveIntensity = m.eyeBaseEmissive;
      }
    }
  }
  if (m.ranged && m.mode === 'chase' && m.cooldown <= 0 && dP < m.spec.range && m.stun <= 0){
    m.cooldown = 2.2;
    spawnProjectile(sm.position.x, sm.position.y + 1.2, sm.position.z, p.x, p.y + 1.0, p.z, 0xfcd34d, m.attackDmg);
  }
  if (m.teleport && m.mode === 'chase' && m.cooldown <= 0 && dP > 4 && dP < 12 && m.stun <= 0){
    m.cooldown = 3.0;
    const a = rnd() * Math.PI * 2;
    sm.position.x = p.x + Math.cos(a) * 2.5;
    sm.position.z = p.z + Math.sin(a) * 2.5;
    spawnBurst(sm.position.x, sm.position.y + 1, sm.position.z, C.ember, 14, true);
    spatialTone(sm.position.x, sm.position.y, sm.position.z, 700, 0.15, 'sawtooth', 0.06, 200);
  }
  if (m.healer && m.cooldown <= 0 && m.stun <= 0){
    m.cooldown = 4.0;
    MOBS.forEach(other => {
      if (other === m || !other.alive) return;
      const dh = Math.hypot(other.mesh.position.x - sm.position.x, other.mesh.position.z - sm.position.z);
      if (dh < 8 && other.health < other.maxHp){
        other.health = Math.min(other.maxHp, other.health + 2);
        spawnBurst(other.mesh.position.x, other.mesh.position.y + 1, other.mesh.position.z, C.teal, 8, true);
      }
    });
  }
  handleMobAttack(m, dt, dP, dx, dz, p);
  if (m.cooldown > 0) m.cooldown -= dt;
}

// Voxel mob AI (v4.0)
function updateVoxelMobAI(m, dt, p, nowMs){
  const sm = m.mesh;
  const dx = sm.position.x - p.x, dz = sm.position.z - p.z;
  const dP = Math.hypot(dx, dz) || 0.001;
  if (m._mon){
    m._mon.update(dt, {
      mode: (m.mode === 'chase' || m.mode === 'attack') ? 'chase' : 'patrol',
      speed: m.spec.chase, dP: dP, t: nowMs
    });
  }
  if (m.stun > 0) m.stun -= dt;
  if (dP < m.sense) m.mode = 'chase';
  else m.mode = 'patrol';
  if (m.mode === 'patrol' && m.nextRetarget < nowMs && Math.random() < 0.3){
    m.nextRetarget = nowMs + 3000 + Math.random()*3000;
    m.target = { x: sm.position.x + (Math.random()*2-1)*12, z: sm.position.z + (Math.random()*2-1)*12 };
  }
  if (m.mode === 'chase') m.target = { x: p.x, z: p.z };
  const tx = m.target.x - sm.position.x;
  const tz = m.target.z - sm.position.z;
  const tl = Math.hypot(tx, tz) || 1;
  let spd = (m.mode === 'chase' ? m.spec.chase : m.spec.speed) * (m.stun > 0 ? 0.15 : 1) * dt;
  const step = Math.min(spd, tl);
  const nx2 = sm.position.x + (tx/tl) * step;
  const nz2 = sm.position.z + (tz/tl) * step;
  if (nx2 > 1 && nx2 < voxelState.worldW - 1) sm.position.x = nx2;
  if (nz2 > 1 && nz2 < voxelState.worldW - 1) sm.position.z = nz2;
  sm.rotation.y = Math.atan2(tx, tz);
  // voxel ground snap
  const gy = voxGroundHeight(sm.position.x, sm.position.z);
  sm.position.y = lerp(sm.position.y, gy, Math.min(1, dt * 8));
  m.anim += dt * 6;
  if (m.flash > 0){
    m.flash -= dt;
    if (m._mon){
      m._mon.setFlash(Math.max(0, m.flash));
    } else {
      m.mat.emissiveIntensity = m.baseEmissive + m.flash * 3.0;
      if (m.flash <= 0) m.mat.emissiveIntensity = m.baseEmissive;
    }
  }
  // Creeper fuse
  if (m.creeper && dP < 2.5 && m.stun <= 0){
    m.fuse += dt;
    m.mat.emissiveIntensity = 0.4 + Math.sin(m.fuse * 20) * 0.8;
    if (m.fuse > 1.5){
      creeperExplode(sm.position.x, sm.position.y, sm.position.z);
      m.alive = false;
      scene.remove(m.mesh);
      return;
    }
  } else if (m.creeper){
    m.fuse = Math.max(0, m.fuse - dt * 2);
    if (m.fuse <= 0) m.mat.emissiveIntensity = m.baseEmissive;
  }
  // Skeleton ranged
  if (m.ranged && m.mode === 'chase' && m.cooldown <= 0 && dP < m.spec.range && m.stun <= 0 && dP > 4){
    m.cooldown = 2.4;
    spawnProjectile(sm.position.x, sm.position.y + 1.2, sm.position.z, p.x, p.y + 1.0, p.z, 0xffffff, m.attackDmg);
    spatialTone(sm.position.x, sm.position.y, sm.position.z, 500, 0.1, 'triangle', 0.06);
  }
  // Enderman teleport
  if (m.teleport && m.mode === 'chase' && m.cooldown <= 0 && dP > 5 && dP < 14 && m.stun <= 0){
    m.cooldown = 4.0;
    const a = rnd() * Math.PI * 2;
    sm.position.x = clamp(p.x + Math.cos(a) * 5, 2, voxelState.worldW - 2);
    sm.position.z = clamp(p.z + Math.sin(a) * 5, 2, voxelState.worldW - 2);
    spawnBurst(sm.position.x, sm.position.y + 1, sm.position.z, C.violet, 14, true);
    spatialTone(sm.position.x, sm.position.y, sm.position.z, 700, 0.15, 'sawtooth', 0.06, 200);
  }
  if (m.cooldown > 0) m.cooldown -= dt;
  handleMobAttack(m, dt, dP, dx, dz, p);
}

function handleMobAttack(m, dt, dP, dx, dz, p){
  const sm = m.mesh;
  if (m.windup > 0){
    m.windup -= dt;
    const t = 1 - clamp(m.windup / 0.45, 0, 1);
    if (!m._mon){
      sm.scale.setScalar(m.scaleBase * (1 + t*0.18));
      m.mat.emissiveIntensity = m.baseEmissive + t*1.6;
    }
    if (m.windup <= 0){
      if (m._mon) m._mon.play('attack');
      else {
        sm.scale.setScalar(m.scaleBase);
        m.mat.emissiveIntensity = m.baseEmissive;
      }
      if (dP < m.attackRange + 0.55){
        if (state.parryActive > 0){
          state.parries++;
          if (state.parries >= 10) unlockAch('parry10');
          showToast('PARRY!  ' + KAO.cool, 'amber');
          reduceCorruption(8);
          m.stun = 2.0;
          m.health -= m.attackDmg * 2;
          spawnDmg(new THREE.Vector3(sm.position.x, sm.position.y + 1.2, sm.position.z), 'PARRY', CSS.amber);
          hitstop(0.15);
          state.trauma = Math.min(1, state.trauma + 0.5);
          if (navigator.vibrate) navigator.vibrate(50);
          if (m.health <= 0) killMob(m, true);
        } else {
          hitFlashAndDmg(m.attackDmg, sm.position);
          state.velY = -1.5;
          p.x -= (dx/dP) * 0.5;
          p.z -= (dz/dP) * 0.5;
        }
      }
    }
  } else if (dP < m.attackRange && m.cooldown <= 0 && m.stun <= 0 && !m.ranged){
    m.cooldown = 1.9;
    m.windup = 0.45;
    if (m._mon) m._mon.play('windup');
    spatialTone(sm.position.x, sm.position.y, sm.position.z, 220, 0.12, 'square', 0.06);
  }
}

// ============================================================================
//  SECTION: DIMENSION TRANSITION
// ============================================================================
function enterVoxelDimension(){
  if (state.cinematic > 0) return;
  state.cinematic = TUNING.portalCinematic;
  state.running = false;
  // cinematic: pixelate + zoom
  const startT = performance.now();
  const fade = $('fade');
  fade.style.transition = 'opacity 1.4s ease';
  fade.style.opacity = '0.85';
  voxelEnterSfx();
  // Show big toast
  const el = $('voxelEnter');
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 2400);
  // delay world switch to allow pixelate
  setTimeout(() => {
    // switch dimension
    state.world.dimension = 'voxel';
    state.voxelEnterCount++;
    state.voxelUnlocked = true;
    state.vexolEnterCount = (state.voxelEnterCount || 0);
    if (state.voxelEnterCount >= 3) unlockAch('dimension_master');
    // Generate voxel world
    if (!voxelState.world){
      generateVoxelWorld();
      buildAllVoxelChunks();
    }
    // spawn voxel mobs
    spawnVoxelMobs();
    // position player at spawn
    const sx = voxelState.spawnedAt.x, sz = voxelState.spawnedAt.z;
    playerGroup.position.set(sx + 0.5, voxelState.worldH - 5, sz + 0.5);
    // spawn point above ground
    playerGroup.position.y = voxGroundHeight(sx + 0.5, sz + 0.5) + 1.2;
    // exit portal
    voxelPortal.position.set(sx + 4, voxGroundHeight(sx + 4, sz) + 0.1, sz);
    // hide genesis chunks
    chunkStore.forEach(c => { c.group.visible = false; });
    // Set fireflies-like ambient (warm)
    ambient.color.setHex(0xffe0a0);
    ambient.intensity = 1.3;
    // camera reset
    yaw = 0; pitch = -0.22;
    // hud
    $('voxelDim').classList.add('on');
    $('hotbar').classList.add('on');
    showToast('VOXEL REALM  ' + KAO.sparkle, 'voxel');
    screenFlash('rgba(126,231,135,0.6)');
    // signal done
    setTimeout(() => {
      state.running = true;
      state.cinematic = 0;
      fade.style.transition = 'opacity 1.2s ease';
      fade.style.opacity = '0';
    }, 900);
  }, 1600);
}
function exitVoxelDimension(){
  if (state.cinematic > 0) return;
  state.cinematic = TUNING.portalCinematic;
  state.running = false;
  const fade = $('fade');
  fade.style.transition = 'opacity 1.4s ease';
  fade.style.opacity = '0.85';
  screenFlash('rgba(126,231,135,0.4)');
  tone(300, 0.6, 'sawtooth', 0.1, 0, 600);
  setTimeout(() => {
    // return to genesis
    state.world.dimension = 'genesis';
    // position player near portal
    playerGroup.position.set(portal.position.x - 3, th(portal.position.x - 3, portal.position.z) + 1, portal.position.z);
    // show genesis
    chunkStore.forEach(c => { c.group.visible = true; });
    ground.visible = true;
    if (water) water.visible = true;
    // remove voxel mobs
    MOBS.forEach(m => { if (m.dimension === 'voxel') scene.remove(m.mesh); });
    for (let i = MOBS.length - 1; i >= 0; i--){
      if (MOBS[i].dimension === 'voxel') MOBS.splice(i, 1);
    }
    ambient.color.setHex(0x8fb4ff);
    $('voxelDim').classList.remove('on');
    $('hotbar').classList.remove('on');
    showToast('Kembali ke Genesis  ' + KAO.cool, 'violet');
    screenFlash('rgba(167,139,250,0.5)');
    setTimeout(() => {
      state.running = true;
      state.cinematic = 0;
      fade.style.transition = 'opacity 1.2s ease';
      fade.style.opacity = '0';
      // win if enough
      if (state.voxelEnterCount >= 1 && state.gems >= TOTAL_C && state.enemiesKilled > 0){
        // only win after exit
        win();
      }
    }, 900);
  }, 1600);
}

// Spawn voxel mobs
function spawnVoxelMobs(){
  // clear existing voxel mobs
  for (let i = MOBS.length - 1; i >= 0; i--){
    if (MOBS[i].dimension === 'voxel'){
      disposeMobVisual(MOBS[i]);
      MOBS.splice(i, 1);
    }
  }
  const sx = voxelState.spawnedAt.x, sz = voxelState.spawnedAt.z;
  const count = 12;
  for (let i = 0; i < count; i++){
    const a = Math.random() * Math.PI * 2;
    const r = 12 + Math.random() * 20;
    const x = clamp(sx + Math.cos(a) * r, 4, voxelState.worldW - 4);
    const z = clamp(sz + Math.sin(a) * r, 4, voxelState.worldW - 4);
    const y = voxGroundHeight(x, z);
    let kind;
    const roll = Math.random();
    if (roll < 0.3) kind = 'vzombie';
    else if (roll < 0.55) kind = 'vskeleton';
    else if (roll < 0.75) kind = 'vcreeper';
    else if (roll < 0.95) kind = 'venderman';
    else kind = 'vgolem';
    const m = makeVoxelMob(kind, x, y, z, state.level - 1);
    if (m) MOBS.push(m);
  }
}

// Genesis mobs around
function spawnMobsAround(levelBonus = 0){
  MOBS.forEach(m => disposeMobVisual(m));
  MOBS.length = 0;
  const spawned = [];
  let tries = 0;
  // Opening encounter: keep one hunter in view instead of scattering every enemy off-camera.
  const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);
  spawned.push({
    kind:'somber',
    x:playerGroup.position.x + fwdX*11 + rightX*2.5,
    z:playerGroup.position.z + fwdZ*11 + rightZ*2.5
  });
  while (spawned.length < Q.mobSmall && tries < 200){
    tries++;
    const x = (rnd()*2-1)*42, z = (rnd()*2-1)*42;
    if (Math.hypot(x,z) < 14) continue;
    spawned.push({ kind: 'somber', x, z });
  }
  tries = 0;
  while (spawned.length < Q.mobSmall + Q.mobBrute && tries < 200){
    tries++;
    const x = (rnd()*2-1)*48, z = (rnd()*2-1)*48;
    if (Math.hypot(x,z) < 18) continue;
    spawned.push({ kind: 'brute', x, z });
  }
  for (const k of ['wisp','ranger','shaman','assassin']){
    if (rnd() < 0.6){
      const x = (rnd()*2-1)*50, z = (rnd()*2-1)*50;
      if (Math.hypot(x,z) < 20) continue;
      spawned.push({ kind: k, x, z });
    }
  }
  spawned.forEach(s => {
    const m = makeMob(s.kind, s.x, s.z, levelBonus);
    if (m) MOBS.push(m);
  });
}

// ============================================================================
//  SECTION: FX UPDATE
// ============================================================================
function updateFX(dt){
  for (let i = particles.length - 1; i >= 0; i--){
    const pt = particles[i];
    pt.life -= dt;
    pt.vel.y -= 8 * dt;
    pt.mesh.position.x += pt.vel.x * dt;
    pt.mesh.position.y += pt.vel.y * dt;
    pt.mesh.position.z += pt.vel.z * dt;
    pt.mesh.material.opacity = Math.max(0, pt.life / pt.max);
    pt.mesh.scale.setScalar(0.4 + 0.6 * (pt.life / pt.max));
    if (pt.life <= 0){
      scene.remove(pt.mesh);
      particlePool.push(pt);
      particles.splice(i, 1);
    }
  }
  for (let i = dmgNumbers.length - 1; i >= 0; i--){
    const d = dmgNumbers[i];
    d.life -= dt;
    d.vel.y -= 4 * dt;
    d.spr.position.x += d.vel.x * dt;
    d.spr.position.y += d.vel.y * dt;
    d.spr.position.z += d.vel.z * dt;
    d.spr.material.opacity = Math.max(0, d.life);
    const k = d.life / d.max;
    d.spr.scale.set(1.6 - 0.4*(1-k), 0.8 - 0.2*(1-k), 1);
    if (d.life <= 0){
      scene.remove(d.spr);
      dmgPool.push(d);
      dmgNumbers.splice(i, 1);
    }
  }
  for (let i = trails.length - 1; i >= 0; i--){
    const t = trails[i];
    t.life -= dt;
    t.mesh.material.opacity = Math.max(0, t.life / t.max);
    t.mesh.scale.setScalar(1 + (1 - t.life/t.max) * 1.2);
    if (t.life <= 0){
      scene.remove(t.mesh);
      trailPool.push(t);
      trails.splice(i, 1);
    }
  }
  for (let i = decals.length - 1; i >= 0; i--){
    const d = decals[i];
    d.life -= dt;
    d.mesh.material.opacity = Math.max(0, (d.life / d.max) * 0.65);
    if (d.life <= 0){
      scene.remove(d.mesh);
      decalPool.push(d);
      decals.splice(i, 1);
    }
  }
  if (state.running && (state.weather === 'rain' || state.weather === 'storm')){
    if (Math.random() < (state.weather === 'storm' ? 0.8 : 0.5)) spawnRainParticle();
  }
  for (let i = rainParticles.length - 1; i >= 0; i--){
    const r = rainParticles[i];
    r.mesh.position.y -= 30 * dt;
    const groundY = state.world.dimension === 'voxel' ?
      voxGroundHeight(r.mesh.position.x, r.mesh.position.z) :
      th(r.mesh.position.x, r.mesh.position.z);
    if (r.mesh.position.y < groundY){
      scene.remove(r.mesh);
      rainPool.push(r);
      rainParticles.splice(i, 1);
    }
  }
  while (rainParticles.length > Q.rain){
    const r = rainParticles.shift();
    scene.remove(r.mesh); rainPool.push(r);
  }
}

// ============================================================================
//  SECTION: CHUNK CULLING + LOD + OCCLUSION (v4.0)
// ============================================================================
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _chunkSphere = new THREE.Sphere(new THREE.Vector3(), 1);
let chunkTick = 0;
let occlusionGrid = new Map();
function updateChunkVisibility(){
  camera.updateMatrixWorld();
  _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projScreen);
  const px = playerGroup.position.x, pz = playerGroup.position.z;
  if (state.world.dimension === 'voxel'){
    chunkStore.forEach(c => { c.group.visible = false; });
    const cs = voxelState.voxChunk;
    const range = Math.max(cs * 1.5, Math.min(Q.voxelRenderDist * cs, v4.renderDist));
    voxelState.chunks.forEach(ch => {
      const cx = ch.cx * cs + cs * 0.5;
      const cz = ch.cz * cs + cs * 0.5;
      const dx = cx - px, dz = cz - pz;
      if (dx*dx + dz*dz > (range + cs) * (range + cs)){ ch.group.visible = false; return; }
      _chunkSphere.center.set(cx, 7, cz);
      _chunkSphere.radius = Math.hypot(cs * 0.72, 10, cs * 0.72);
      ch.group.visible = !v4.occOn || _frustum.intersectsSphere(_chunkSphere);
    });
    if ($('dbg')?.classList.contains('on')) window._cullStats = { visible: [...voxelState.chunks.values()].filter(ch => ch.group.visible).length, total: voxelState.chunks.size, lod0:0, lod1:0, lod2:0 };
    return;
  }
  const rd = Math.min(v4.renderDist, Q.renderDist);
  const rdSq = (rd + CHUNK_SIZE) * (rd + CHUNK_SIZE);
  const l0Sq = 40 * 40;
  const l1Sq = 90 * 90;
  let visible = 0, total = 0, lod0 = 0, lod1 = 0, lod2 = 0;
  const now = performance.now();
  chunkStore.forEach((c) => {
    total++;
    const dx = c.center.x - px, dz = c.center.z - pz;
    const dSq = dx*dx + dz*dz;
    if (dSq > rdSq){ c.group.visible = false; return; }
    _chunkSphere.center.copy(c.center);
    _chunkSphere.radius = c.radius;
    const inFrustum = _frustum.intersectsSphere(_chunkSphere);
    if (v4.occOn && !inFrustum){ c.group.visible = false; return; }
    // occlusion culling (grid 8x8)
    if (v4.occOn){
      const gx = Math.floor(c.center.x / 24);
      const gz = Math.floor(c.center.z / 24);
      const key = gx + '_' + gz;
      const occ = occlusionGrid.get(key);
      if (occ && occ.until > now){
        c.group.visible = false;
        return;
      }
    }
    // LOD (only if not too close)
    let lod = 0;
    if (dSq > l1Sq) lod = 2;
    else if (dSq > l0Sq) lod = 1;
    c.lod = lod;
    if (lod === 0){ lod0++; }
    else if (lod === 1){ lod1++; }
    else { lod2++; }
    // LOD toggles: hide grass/flowers at LOD1+, hide shadows at LOD1+
    c.group.traverse((o) => {
      if (o.isInstancedMesh){
        // flower/grass identification by material
        const isFoliage = o.material === grassMat || o.material === flowerMat;
        o.visible = lod === 0 || !isFoliage;
        o.castShadow = lod === 0 && Q.shadows;
      }
    });
    c.group.visible = true;
    visible++;
  });
  // update debug counters
  if ($('dbg').classList.contains('on')){
    window._cullStats = { visible, total, lod0, lod1, lod2 };
  }
}

// ============================================================================
//  SECTION: DYNAMIC RESOLUTION SCALING
// ============================================================================
let dynResLowTimer = 0, dynResHighTimer = 0, dynResLevel = 1;
const DYN_RES_MIN = LOW ? 0.55 : 0.75;
let dynResWarmup = 2.0;                 // jangan sentuh apa pun 2 detik pertama (shader compile)
function updateDynamicResolution(rawDt, fps){
  if (!v4.dynResOn) return;
  if (dynResWarmup > 0){ dynResWarmup -= rawDt; return; }
  if (fps < 45 && dynResLevel > DYN_RES_MIN){
    dynResLowTimer += rawDt;
    dynResHighTimer = 0;
    if (dynResLowTimer > 1.1){
      dynResLevel = Math.max(DYN_RES_MIN, dynResLevel - 0.08);
      currentPixelRatio = Q.pixelRatio * dynResLevel;
      syncRenderTargets();
      dynResLowTimer = 0;
    }
  } else if (fps > 57 && dynResLevel < 1){
    dynResHighTimer += rawDt;
    dynResLowTimer = 0;
    if (dynResHighTimer > 5){
      dynResLevel = Math.min(1, dynResLevel + 0.05);
      currentPixelRatio = Q.pixelRatio * dynResLevel;
      syncRenderTargets();
      dynResHighTimer = 0;
    }
  } else {
    dynResLowTimer = 0; dynResHighTimer = 0;
  }
}

// ============================================================================
//  SECTION: RENDER LOOP
// ============================================================================
const clock = new THREE.Clock();
let frameCount = 0, fpsAcc = 0, fpsTimer = 0;
const fpsEl = $('fps');
let showFps = false;
addEventListener('keydown', (e) => {
  if (e.code === 'KeyP'){ showFps = !showFps; fpsEl.classList.toggle('on', showFps); }
});
let debugTick = 0;
let lastFps = 60;
let _vpTick = 0;
function animate(){
  requestAnimationFrame(animate);
  // v4.6 fix: self-heal canvas vs viewport mismatch (rotate HP / URL bar Chrome hide-show / no resize event)
  if ((++_vpTick & 63) === 0){
    const _cv = renderer.domElement;
    if (Math.abs(_cv.clientWidth - innerWidth) > 1 || Math.abs(_cv.clientHeight - innerHeight) > 1) resize();
  }
  let rawDt = Math.min(0.045, clock.getDelta());
  let dt = rawDt;
  if (state.slowmo > 0){
    state.slowmo -= rawDt;
    dt = rawDt * 0.3;
    if (state.slowmo <= 0){
      state.slowmo = 0; state.killCam = 0;
      $('killcam').classList.remove('on');
    }
  }
  if (state.killCam > 0) state.killCam -= rawDt;
  if (state.paused) dt = 0;
  if (state.cinematic > 0){
    state.cinematic -= rawDt;
    dt = rawDt * 0.4;
  }
  if (!state.paused){
    updateEnvironment(dt);
    if (state.running && !state.won && !state.dead){
      recordEcho(dt);
      recordRewind(dt);
      updateGameplay(dt);
      updateCompanion(dt);
      updateMusic();
    }
    updateFX(dt);
    corruptionPass.uniforms.uAmount.value = state.corruption / 100 * (v4.corruptOn ? 1 : 0);
    corruptionPass.uniforms.uTime.value = performance.now() * 0.001;
    const cinematicPix = state.cinematic > 0 ? clamp(1 - state.cinematic / TUNING.portalCinematic, 0, 1) : 0;
    corruptionPass.uniforms.uPixelate.value = cinematicPix * 0.9;
    // PERF: lewati seluruh full-screen pass kalau memang tidak ada efek.
    corruptionPass.enabled = corruptionPass.uniforms.uAmount.value > 0.5 || corruptionPass.uniforms.uPixelate.value > 0.001;
    // grain
    $('grain').classList.toggle('on', v4.grainOn && state.corruption > 30);
  }
  if (!state.paused){
    characterAnim.update(dt, {
      speed: state.running ? characterMoveSpeed : 0,
      airborne: state.running && !state.grounded,
      vy: state.velY,
      sprint: state.running && state.sprinting
    });
  }
  chunkTick++;
  if (chunkTick % 4 === 0) updateChunkVisibility();
  try { updateWowFX(performance.now(), dt); } catch(e){}
  portal.position.y = th(PX, PZ) + 0.1 + Math.sin(performance.now() * 0.0026) * 0.28;
  portalRing.rotation.z += dt * 0.6;
  portalFill.material.opacity = 0.35 + Math.sin(performance.now() * 0.004) * 0.12;
  portal.scale.setScalar(portalActive ? 1 + Math.sin(performance.now() * 0.005) * 0.04 : 1);
  if (voxelPortal.visible){
    voxelPortal.rotation.y += dt * 0.4;
    voxelRayMat.opacity = 0.1 + Math.sin(performance.now()*0.003)*0.04;
  }
  mmTick++;
  if (mmTick % 3 === 0) drawMinimap(playerGroup.position.x, playerGroup.position.z);
  composer.render();
  // FPS
  frameCount++; fpsTimer += rawDt;
  if (fpsTimer >= 0.6){
    lastFps = frameCount / fpsTimer;
    if (showFps) fpsEl.textContent = Math.round(lastFps) + ' FPS';
    updateDynamicResolution(0.6, lastFps);
    frameCount = 0; fpsTimer = 0;
  }
  debugTick++;
  if (debugTick % 30 === 0 && $('dbg').classList.contains('on')){
    const info = renderer.info;
    const cull = window._cullStats || {};
    $('dbg').innerHTML =
      `POS: ${playerGroup.position.x.toFixed(1)}, ${playerGroup.position.z.toFixed(1)}<br>` +
      `DIM: ${state.world.dimension}<br>` +
      `BIOME: ${state.world.biome}<br>` +
      `WEATHER: ${state.weather}<br>` +
      `MOBS: ${MOBS.filter(m => m.alive).length}<br>` +
      `CORRUPT: ${Math.round(state.corruption)}% - OVERLOAD: ${state.overload.toFixed(1)}<br>` +
      `THREAT: ${(state.threat*100).toFixed(0)}%<br>` +
      `CHUNKS: ${cull.visible || 0}/${cull.total || 0} L0:${cull.lod0 || 0} L1:${cull.lod1 || 0} L2:${cull.lod2 || 0}<br>` +
      `VOX CHUNKS: ${voxelState.chunks.size}<br>` +
      `PIXEL RATIO: ${currentPixelRatio.toFixed(2)}<br>` +
      `DRAW: ${info.render.calls} - TRI: ${(info.render.triangles/1000).toFixed(1)}k<br>` +
      `FPS: ${lastFps.toFixed(0)}`;
  }
}

// ============================================================================
//  SECTION: UI WIRING
// ============================================================================
let selectedClass = 'blade';
document.querySelectorAll('.class-card:not(.locked)').forEach(card => {
  card.onclick = () => {
    document.querySelectorAll('.class-card').forEach(c => c.classList.remove('sel'));
    card.classList.add('sel');
    selectedClass = card.dataset.class;
  };
});
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('on'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('on'));
    btn.classList.add('on');
    const id = 'tab' + btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1);
    const panel = $(id);
    if (panel) panel.classList.add('on');
  };
});
// Settings toggles on start menu
function wireStartSettings(){
  const s = $('sensSlider');
  if (s){
    s.value = v4.sensitivity;
    $('sensVal').textContent = v4.sensitivity.toFixed(1)+'x';
    s.oninput = () => { v4.sensitivity = parseFloat(s.value); $('sensVal').textContent = v4.sensitivity.toFixed(1)+'x'; saveSettings(); };
  }
  const rd = $('rdSlider');
  if (rd){
    rd.value = v4.renderDist;
    $('rdVal').textContent = v4.renderDist;
    rd.oninput = () => { v4.renderDist = parseInt(rd.value); $('rdVal').textContent = v4.renderDist; saveSettings(); };
  }
  const map = { tgEcho:'echoOn', tgCorrupt:'corruptOn', tgFracture:'fractureOn', tgKillCam:'killCamOn',
                tgTrails:'trailsOn', tgBloom:'bloomOn', tgShadow:'shadowOn',
                tgDynRes:'dynResOn', tgOcc:'occOn', tgGrain:'grainOn', tgPerf:'perfMode' };
  Object.entries(map).forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('on', !!v4[key]);
    el.onclick = () => {
      v4[key] = !v4[key];
      el.classList.toggle('on', v4[key]);
      if (key === 'bloomOn') bloom.enabled = v4.bloomOn && Q.bloom;
      if (key === 'shadowOn') renderer.shadowMap.enabled = Q.shadows && v4.shadowOn;
      if (key === 'grainOn') $('grain').classList.toggle('on', v4.grainOn && state.corruption > 30);
      if (key === 'perfMode') applyPerfMode(v4.perfMode);
      saveSettings();
    };
  });
}
wireStartSettings();
$('startBtn').onclick = () => {
  state.playerClass = selectedClass;
  $('pads').classList.toggle('show', IS_TOUCH);
  startGame();
  beginOpeningStory();
};
$('loadBtn').onclick = () => {
  const s = loadSave();
  if (s){
    state.level = s.level || 1;
    state.xp = s.xp || 0;
    state.xpNeeded = Math.round(TUNING.xpBase * Math.pow(TUNING.xpCurve, state.level - 1));
    state.achievements = s.achievements || {};
    state.playerClass = s.playerClass || 'blade';
    state.enemiesKilled = s.enemiesKilled || 0;
    state.bossKills = s.bossKills || 0;
    state.parries = s.parries || 0;
    state.voxelUnlocked = s.voxelUnlocked || false;
    state.voxelEnterCount = s.voxelEnterCount || 0;
    if (s.hotbar) state.hotbar = s.hotbar;
    showToast('Save dimuat - Lv ' + state.level + '  ' + KAO.cool, 'teal');
  } else showToast('Tidak ada save  ' + KAO.hmm, 'magenta');
  $('pads').classList.toggle('show', IS_TOUCH);
  startGame();
};
$('againBtn').onclick = () => {
  state.level = Math.max(1, state.level + 1);
  state.maxHp += 2;
  showToast('NG+ dimulai - Lv ' + state.level + '  ' + KAO.determined, 'amber');
  startGame();
};
$('menuBtn').onclick = () => location.reload();
$('retryBtn').onclick = () => location.reload();

// Quest collapse toggle
$('qCard').onclick = () => { $('qCard').classList.toggle('collapsed'); };

// Hotbar clicks
document.querySelectorAll('#hotbar .hb-slot').forEach(el => {
  el.onclick = () => selectHotbar(parseInt(el.dataset.slot));
});

// Bestiary content
function fillBestiary(){
  const gen = [
    { k:'The Hollow', d:'Pemburu kurus bertanduk. Mengintai dari balik kabut lalu menerjang.' },
    { k:'Bone Gnasher', d:'Raksasa berlapis rusuk dan cakar; hantamannya memicu rage saat sekarat.' },
    { k:'Lantern Wraith', d:'Roh melayang bermata tiga. Mendekat cepat untuk mengisap nyawa.' },
    { k:'Grave Golem', d:'Benteng batu bertulang. Slam area membuat tanah bergetar.' },
    { k:'Marrow Stalker', d:'Pemburu berjubah yang menembakkan proyektil dari kejauhan.' },
    { k:'Rot Oracle', d:'Dukun bertanduk tiga yang memulihkan makhluk lain di sekitarnya.' },
    { k:'Night Reaver', d:'Pembunuh ramping yang lenyap sebelum muncul tepat di belakangmu.' },
    { k:'Echo Husk', d:'Sosok ungu yang mengulang gerakmu beberapa detik setelahnya.' }
  ];
  const vox = [
    { k:'Creeper', d:'Fuse 1.5s, ledakan AoE 4, destroy blok.' },
    { k:'Zombie', d:'Horde 4-6, lambat, damage 1.' },
    { k:'Skeleton', d:'Arrow projectile, drop parabola.' },
    { k:'Enderman', d:'Teleport 6-10m, kebal kecuali dipandang.' },
    { k:'Voxel Golem', d:'Mini-boss 3x3x3, HP 40, AoE jump.' }
  ];
  $('bestiaryGenesis').innerHTML = gen.map(g =>
    `<div class="beast genesis"><div class="cube">[G]</div><div class="meta"><b>${g.k}</b>${g.d}</div></div>`
  ).join('');
  $('bestiaryVoxel').innerHTML = vox.map(g =>
    `<div class="beast"><div class="cube">[V]</div><div class="meta"><b>${g.k}</b>${g.d}</div></div>`
  ).join('');
}
fillBestiary();
refreshStatsUI();

// ============================================================================
//  SECTION: RESIZE / PORTRAIT
// ============================================================================
function resize(){
  const w = innerWidth, h = innerHeight;
  // Cap high-DPI mobile pixel work; dynamic resolution can lower it further under load.
  if (LOW){
    const cap = Math.min(Q.pixelRatio, 1.25);
    currentPixelRatio = Math.min(currentPixelRatio, cap);
  }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  syncRenderTargets(w, h);
  updatePortrait();
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 250));
function updatePortrait(){
  const isPortrait = window.innerHeight > window.innerWidth;
  $('portrait').classList.toggle('on', isPortrait && IS_TOUCH);
}
updatePortrait();

// ============================================================================
//  SECTION: BOOT
// ============================================================================
(async () => {
  const bootErrors = [];
  try {
    idb = await Promise.race([openIDB(), new Promise(resolve => setTimeout(() => resolve(null), 1400))]);
    await loadVoxelMods();
    playerGroup.position.set(0, th(0, 0), 0);
  if (typeof petGroup !== "undefined") petGroup.position.set(-1.8, th(0,0) + 0.1, -1.2);
    camera.position.set(0, 3, 7);
    syncVitals();
    updateChunkVisibility();
    updateEnvironment(0.016);
    updateHotbarUI();
  } catch(e) {
    bootErrors.push('Inisialisasi dunia: ' + (e?.message || e));
  }
  // Start rendering even if optional save/UI initialization fails.
  try { animate(); } catch(e) { bootErrors.push('Render: ' + (e?.message || e)); }
  try { if (IS_TOUCH) $('pads')?.classList.add('show'); } catch(e){}
  try { $('grain')?.classList.toggle('on', v4.grainOn); } catch(e){}
  const fade = $('fade');
  if (fade){
    setTimeout(() => {
      fade.style.transition = 'opacity 1.2s ease';
      fade.style.opacity = '0';
    }, 120);
  }
  if (bootErrors.length){
    showBootNotice(bootErrors.join('\n'));
  }
  setTimeout(() => showToast('Selamat datang di Voxel Ascension  ' + KAO.happy, 'voxel'), 800);
})();

})();