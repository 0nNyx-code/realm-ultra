// Resolusi dependency yang jalan di dua tempat:
//  - lokal (Termux): /mnt/sdcard noexec -> pakai /tmp/opencode/realm-build
//  - CI (GitHub Actions): pakai ./node_modules dari `npm ci`
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [process.env.REALM_DEPS, ROOT, '/tmp/opencode/realm-build'].filter(Boolean);

export function load(name) {
  const errors = [];
  for (const base of CANDIDATES) {
    if (!existsSync(join(base, 'package.json'))) continue;
    try {
      return createRequire(join(base, 'package.json'))(name);
    } catch (e) {
      errors.push(base + ': ' + (e && e.message));
    }
  }
  throw new Error(`dependency "${name}" tidak ketemu di: ${CANDIDATES.join(', ')}\n` + errors.join('\n'));
}

// folder node_modules untuk esbuild nodePaths
export const NODE_MODULES = CANDIDATES.map((b) => join(b, 'node_modules')).find((p) => existsSync(join(p, 'three')))
  || join(ROOT, 'node_modules');
