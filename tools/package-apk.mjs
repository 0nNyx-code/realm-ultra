// Salin hasil build single-file ke assets Android.
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './deps.mjs';

const src = join(ROOT, 'dist', 'realm-ultra.html');
const dir = join(ROOT, 'apk', 'app', 'src', 'main', 'assets');
await mkdir(dir, { recursive: true });
const dest = join(dir, 'index.html');
await copyFile(src, dest);
const st = await stat(dest);
console.log('OK apk/app/src/main/assets/index.html —', (st.size / 1024).toFixed(1), 'KB');
