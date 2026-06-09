#!/usr/bin/env bun
/**
 * One-shot: convert dev-mode package.json files to dual-runtime exports so
 * both Bun (`./src/<x>.ts`) and Node (`./dist/<x>.js`) can resolve the
 * package from the same workspace.
 *
 * Rules:
 *   - Skip packages whose `main` is not `./src/<x>.ts` (already converted).
 *   - Skip `@shrkcrft/dashboard` (browser bundle, special shape).
 *   - Convert `main` from `./src/<x>.ts` → `./dist/<x>.js`.
 *   - Convert `types` from `./src/<x>.ts` → `./dist/<x>.d.ts`.
 *   - For every string `exports[key]`, expand to a conditional object:
 *       { types: dist .d.ts, bun: src .ts, import: dist .js, default: dist .js }
 *   - For string `bin` entries, rewrite to dist .js.
 *
 * Idempotent: re-running on a converted package is a no-op.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

function rewriteFile(s: string): string {
  return s.replace(/^\.\/src\//, './dist/').replace(/\.tsx?$/, '.js');
}
function rewriteTypes(s: string): string {
  if (s.endsWith('.d.ts')) return s.replace(/^\.\/src\//, './dist/');
  return s.replace(/^\.\/src\//, './dist/').replace(/\.tsx?$/, '.d.ts');
}

const SKIP = new Set(['dashboard']);

for (const short of readdirSync(PACKAGES_DIR).sort()) {
  if (SKIP.has(short)) continue;
  const pkgPath = join(PACKAGES_DIR, short, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch {
    continue;
  }
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const main = pkg.main;
  if (typeof main !== 'string' || !main.startsWith('./src/') || !main.endsWith('.ts')) {
    console.log(`skip  ${short}  (main=${String(main)})`);
    continue;
  }
  const srcMain = main;
  pkg.main = rewriteFile(srcMain);
  if (typeof pkg.types === 'string') pkg.types = rewriteTypes(pkg.types);

  // Conditional exports.
  if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
    const e = pkg.exports as Record<string, unknown>;
    const fixed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'string' && v.endsWith('.ts')) {
        fixed[k] = {
          types: rewriteTypes(v),
          bun: v,
          import: rewriteFile(v),
          default: rewriteFile(v),
        };
      } else {
        fixed[k] = v;
      }
    }
    pkg.exports = fixed;
  }

  // bin: dev-mode points at src/<x>.ts; rewrite to dist/<x>.js so the
  // dev-mode `node_modules/.bin/<name>` symlink works under Node. Bun
  // consumers running `bun packages/<x>/src/main.ts` are unaffected.
  if (pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)) {
    const b = pkg.bin as Record<string, unknown>;
    const fixed: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === 'string') fixed[k] = rewriteFile(v);
    }
    pkg.bin = fixed;
  } else if (typeof pkg.bin === 'string') {
    pkg.bin = rewriteFile(pkg.bin);
  }

  // Preserve key order roughly by re-stringifying. The downstream
  // publish-mode transform re-runs over this; that's idempotent.
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`ok    ${short}`);
}
