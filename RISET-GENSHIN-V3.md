# RISET — Genshin Impact look untuk REALM ULTRA (17 Nov 2026)

Dossier riset internet (web search + scrape) untuk upgrade visual. Fokus: **bisa jalan di WebGL2 / Mali-G52 / 30 FPS**, offline, single-file.

## Sumber
- Adrian Mendez — *Genshin Impact Character Shader Breakdown (Unity URP)* — https://adrianmendez.artstation.com/projects/wJZ4Gg
- Ben Ayers — *Blender NPR: Recreating the Genshin Impact Shader* — https://bjayers.com/blog/9oOD/blender-npr-recreating-the-genshin-impact-shader
- NoiRCCC — *Genshin Face Shader & Real-Time Rendering* — https://noirccc.net/blog/posts/54
- kaze-mio — *UnityGenshinToonShader* (rim light, outline, shadow ramp) — https://github.com/kaze-mio/UnityGenshinToonShader
- roystan — *Toon Shader Tutorial* (rim = `1 - dot(N,V)`, thresholded) — https://roystan.net/articles/toon-shader/
- nugglet — *Genshin Console Graphics Rendering Pipeline* — https://nugglet.github.io/posts/2022/12/console_graphics_rendering_pipeline_genshin_impact
- Zesix — *Stylized PBR environment, Genshin vs BotW* — https://www.zesix.com/2021/11/02/creating-illine-a-stylized-environment-in-unity-urp/
- Partii — *Toon shading / rim / outline on phone* — https://www.partii.games/docs/build/shaders-and-look
- three.js docs — *MeshToonMaterial* — https://threejs.org/docs/pages/MeshToonMaterial.html
- ARM — *Mali tile-based rendering* — https://developer.arm.com/solutions/graphics/developer-guides/tile-based-rendering/single-page
- Gameroom part 2 — *Mali-G52 budget phone measurements* — https://www.jageticbojan.com/post/building-gameroom-part-2

---

## 1. Apa yang sebenarnya bikin Genshin "Genshin"

| Elemen | Temuan riset | Implementasi murah di Three.js |
|---|---|---|
| **Cel ramp** | Transisi light/shadow **tidak ekstrem keras**; ~0.1 soft edge. Shadow di-tint (dingin), bukan hitam. | `MeshToonMaterial` + `gradientMap` 4–5 band, `NearestFilter`, warna bayangan biru/ungu muda. |
| **Hand-painted shadow** | Lipatan baju, bayangan rambut, AO dicat di tekstur — bukan real-time. | Kita tidak punya tekstur; pakai **vertex color gradient** + ramp + rim untuk substitute. |
| **No self-shadowing** | Karakter hampir tidak pernah cast shadow ke dirinya sendiri. | Matikan `castShadow` pada mesh karakter kecil; andalkan ramp + blob shadow. |
| **Rim light** | `rim = pow(1 - dot(N,V), 2..3)`, dikalikan NdotL supaya hanya di sisi terang. Warna putih/keemasan. | `onBeforeCompile` pada `MeshToonMaterial`, tambah ke `gl_FragColor.rgb`. Gratis (beberapa ALU). |
| **Outline** | Genshin memakai **post-process depth+normal Sobel**, bukan inverted-hull, supaya tipis & presisi. | Inverted-hull = 1 draw ekstra per mesh; post = 1 full-screen pass. Di HP → hull hanya untuk hero/boss. |
| **Warna** | "saturated unnatural colors", **fresh, bright, clean**. BotW natural blend; Genshin warna lebih tegas, batu mulus, lumut cuma di atas. | Palet warna dinaikkan saturasi & value; batu/props toon, bukan PBR coklat kusam. |
| **God ray** | Volumetric fog + ray marching terpisah (putaran tambahan) karena fog saja hasilnya keruh. | Skip ray marching. Fake: sprite beam additif + gradasi langit. |
| **AO** | 3 lapis (HBAO + AO volume + capsule AO), setengah resolusi. | Skip di LOW; ramp bayangan + contact shadow statis cukup. |
| **Bloom** | threshold tinggi, menyentuh emisif/matahari saja. | `bloom.threshold = 1.0` sudah benar. LOW tetap mati; ganti glow sprite. |

## 2. Fakta performa yang membatasi desain
- Mali-G52 (Helio G85) = **tile-based, fill-rate bound**. Biaya naik karena *pixel shading* & overdraw, bukan geometri.
- Redmi 12C (Mali-G52): ganti material PBR → Lambert menaikkan 20,7 → 34,5 FPS tanpa mengurangi geometri.
- Budget mobile: ≤100–200 draw call, ≤1 pass post-process, ≤1 shadow map 1024, DPR ≤1.5.
- `MeshToonMaterial` **lebih murah dari `MeshStandardMaterial`** (tanpa BRDF PBR). Jadi toon bukan tambahan biaya — ini *optimasi sekaligus* styling.
- Outline inverted-hull **menggandakan draw call** untuk objek yang di-outline. → hanya hero & boss.
- `gradientMap` wajib `NearestFilter` + `generateMipmaps=false`, kalau tidak bandingannya blur.

## 3. Keputusan implementasi di REALM ULTRA
1. **Toon ramp global 5 band** (shadow `0x707c96` → highlight putih) dipakai ulang untuk ground, pohon, batu, rumput, blok voxel, pet.
2. **Rim light via `onBeforeCompile`** dipasang ke material karakter & mob (murah, tidak nambah draw call).
3. **Outline inverted-hull** hanya untuk hero + boss (mati di LOW kalau draw call mepet).
4. **Grade pass**: saturasi 1.12 → 1.20, vignette 0.30 → 0.22 (high-key), split-tone sudah ada.
5. **Voxel**: palet siang abadi + awan tipis + blok toon warna cerah.
6. **Rumput**: wind sudah ada; tambah gradasi akar→ujung lewat vertex shader.
7. **Tidak boleh**: SSAO, SSR, volumetric ray marching, multi-pass post — semuanya dibuang demi 30 FPS.

## 4. Bug yang ketemu saat riset/audit (sudah diperbaiki sebelum upgrade)
| Bug | Gejala | Akar | Fix |
|---|---|---|---|
| Phase siang/malam | Jam 15:29 gelap, jam 06:00 terang | `sin(day*2π)` puncak jam 06 | `-cos(day*2π)` |
| Voxel hitam legam | `lum 1.8`, 100% gelap | Beauty layer menimpa ambient 1.3 tiap frame | palet voxel khusus di `BL.update()` + `updateEnvironment()` |
| Monster tak terlihat | mati mendadak | ramp toon band paling gelap 48/255 + lighting mati | ramp ≥104/255 + lighting voxel terang |
| Kotak hitam di wajah | rectangle 1×1×1 | `mouth.scale.set(mouthScale,1,1)` menimpa skala asli | `set(0.045*mouthScale, 0.008, 0.008)` |
| Spawn mob mengepung | langsung diserang | radius 12 m + 0 invuln | radius 18 m + 3 s invuln |
| Siang keputihan | lum 179 | sun 2.35 + exposure 1.08 | sun 1.30 + exposure 1.00 |
