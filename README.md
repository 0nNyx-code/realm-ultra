# Realm Ultra

Game open-world voxel single-file (Three.js) + pembungkus Android **WebView** tanpa
dependensi runtime. Tampilan **"Shadered Voxel"** — cerah, magis, ala Minecraft pakai shaderpack.

| Item | Nilai |
|---|---|
| Package id | `dev.realmultra.mobile` |
| Label | Realm Ultra |
| minSdk / targetSdk / compileSdk | 24 / 34 / 34 |
| Orientasi | `sensorLandscape` |
| Permission | **tidak ada** (game 100% offline) |
| Ukuran APK | ±3 MB |
| Gate performa | ≥30 FPS di Galaxy A05 (Helio G85 / Mali-G52 MC2) |

## Unduh APK

Build terakhir (GitHub Actions, ditandatangani debug key — bisa langsung di-install):

```
https://github.com/0nNyx-code/realm-ultra/releases/latest/download/realm-ultra.apk
```

Versi HTML single-file (bisa dibuka di browser apa pun, offline):

```
https://github.com/0nNyx-code/realm-ultra/releases/latest/download/realm-ultra.html.gz
```

> Aktifkan dulu **"Install dari sumber tidak dikenal"** untuk aplikasi file manager / browser.

## Struktur

```
src/
  index.html        template HTML (slot <!--CSS--> dan <!--JS-->)
  style.css         seluruh CSS game
  main.js           game (three.js, ~7.3k baris) — di-bundle esbuild
  beauty-layer.js   sky dome + cloud + fireflies + petals + birds + floating islands
                    + crystals + water shader + GradeShader (ACES, split-tone, vignette)
  perf-layer.js     deteksi GPU, preset kualitas, degradasi reaktif, modul __perf
  debug-bridge.js   window.__realm (?debug=1) — frames / info / pose / freeze / get
  fonts.css         Orbitron + JetBrains Mono (base64, 5 woff2) — digenerate tools/fonts.mjs
tools/
  build.mjs         src/* -> dist/realm-ultra.html (single file, 0 request jaringan)
  fonts.mjs         unduh subset latin Google Fonts -> src/fonts.css (base64)
  icon.mjs          ikon launcher PNG procedural (mdpi..xxxhdpi + 512)
  package-apk.mjs   dist/realm-ultra.html -> apk/app/src/main/assets/index.html
  smoke.mjs         smoke test headless: error runtime, FPS, draw call (tanpa screenshot)
  extract.mjs       pecah game asli jadi src/{index.html,style.css,main.js}
apk/                proyek Gradle (AGP 8.5.2, Gradle 8.9, JDK 17)
.github/workflows/android.yml   CI: build game -> APK -> GitHub Release
```

## Alur build

Lokal (butuh Node 22; tiga/esbuild di `node_modules`):

```bash
npm install
node tools/fonts.mjs      # sekali saja, butuh internet
node tools/icon.mjs
node tools/build.mjs      # -> dist/realm-ultra.html  ±2.0 MB
node tools/package-apk.mjs
cd apk && gradle assembleRelease
```

Otomatis: setiap push ke `main` menjalankan `.github/workflows/android.yml`
(ubuntu-latest → Node 22 → SDK 34 → Gradle 8.9) dan menerbitkan
`realm-ultra.apk` + `realm-ultra.html.gz` sebagai release `build-<run_number>`.

Catatan CI: kalau `src/main.js` belum ada di repo, workflow melakukan **bootstrap** —
mengunduh tarball `GAME_SRC_URL`, mengekstrak ke `src/`, lalu meng-commit balik.
Setelah itu semua build murni dari git.

## Performa (fokus HP kelas bawah)

- **Dynamic resolution nyala dari awal.** Mulai `pixelRatio 1.0`, turun sampai `0.55`
  kalau FPS < 45, naik lagi pelan kalau > 57. Warmup 2 detik (shader compile) supaya
  tidak langsung menurunkan resolusi saat frame pertama.
- `perf-layer.js` mendeteksi GPU lewat `WEBGL_debug_renderer_info`:
  - **low** (Mali-G3x/G5x/G7x, Adreno 3xx–5xx, PowerVR GE, software) → pixelRatio 0.72,
    FXAA nyala, bloom/SSAO/shadow mati, `minScale 0.5`
  - **mid** → 0.9 · **high** → 1.0
- Degradasi reaktif: FPS rata-rata < 26 selama 2.4 s → matikan FXAA → turunkan resolusi →
  matikan shadow. Naik lagi kalau FPS > 52 stabil 12 s.
- Toggle **"Mode Performa (HP kentang)"** di Settings memaksa preset `potato`
  (`minScale 0.42`, semua pass berat mati).
- Pass `corruptionPass` di-`enabled=false` saat tidak ada efek (hemat 1 full-screen pass).
- `LOW` juga menurunkan: render distance 48, grass 56/chunk, 120 pohon, 48 batu, 80 bunga,
  8 mob, `voxelRenderDist 2`, `particleScale 0.4`.

Debug cepat di browser: buka dengan `?debug=1`, lalu di console:

```js
__realm.ready            // true kalau boot selesai
__realm.info()           // fps, calls, triangles, pixelRatio
__perf                   // gpu, tier, preset, scale, degraded
__realm.pose(10, 0.5, -20, 0.6)   // taruh kamera (x, y, z, yaw)
```

## Update versi / tanda tangan

`apk/app/build.gradle` menandatangani release dengan **debug key** supaya APK langsung
bisa di-install. Untuk Play Store, ganti dengan keystore sendiri:

```gradle
signingConfigs {
    release {
        storeFile file('realm-ultra.jks')
        storePassword System.getenv('KEYSTORE_PASS')
        keyAlias 'realm-ultra'
        keyPassword System.getenv('KEY_PASS')
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
    }
}
```

Naikkan `versionCode` / `versionName` tiap rilis.

## Lisensi / aset

- Three.js r169 — MIT.
- Font Orbitron & JetBrains Mono — SIL Open Font License 1.1 (di-embed base64).
- Kode game, layer visual, dan ikon: dibuat untuk proyek ini.
