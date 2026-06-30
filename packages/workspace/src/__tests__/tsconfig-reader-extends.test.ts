/**
 * `readTsConfig` strict resolution through a relative `extends` chain.
 *
 * Locks O3-1: a tsconfig that does not set `strict` directly but extends a
 * base that DOES must report the inherited value (and a `strictResolvable`
 * tri-state so callers can tell confirmed-off from unknown).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTsConfig } from '../tsconfig-reader.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-tscfg-ext-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readTsConfig — extends strict resolution', () => {
  test('inherits strict:true from a relative base (extends without .json)', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 'tsconfig.base.json'),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: './tsconfig.base',
          compilerOptions: { target: 'ES2022' },
        }),
      );
      const r = readTsConfig(dir);
      expect(r.ok).toBe(true);
      const cfg = r.ok ? r.value : null;
      expect(cfg).not.toBeNull();
      expect(cfg?.strict).toBe(true);
      expect(cfg?.strictResolvable).toBe(true);
    });
  });

  test('inherits strict:true through a two-level relative chain (.json explicit)', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 'tsconfig.root.json'),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      writeFileSync(
        join(dir, 'tsconfig.mid.json'),
        JSON.stringify({ extends: './tsconfig.root.json' }),
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ extends: './tsconfig.mid.json', compilerOptions: {} }),
      );
      const r = readTsConfig(dir);
      const cfg = r.ok ? r.value : null;
      expect(cfg?.strict).toBe(true);
      expect(cfg?.strictResolvable).toBe(true);
    });
  });

  test('a local strict:false wins over a strict:true base', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 'tsconfig.base.json'),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: './tsconfig.base',
          compilerOptions: { strict: false },
        }),
      );
      const r = readTsConfig(dir);
      const cfg = r.ok ? r.value : null;
      expect(cfg?.strict).toBe(false);
      expect(cfg?.strictResolvable).toBe(true);
    });
  });

  test('no strict + no extends → confirmed off (TS default)', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
      );
      const r = readTsConfig(dir);
      const cfg = r.ok ? r.value : null;
      expect(cfg?.strict).toBe(false);
      expect(cfg?.strictResolvable).toBe(true);
    });
  });

  test('extends a non-relative package → strict unknown (strictResolvable false)', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ extends: '@tsconfig/strictest', compilerOptions: {} }),
      );
      const r = readTsConfig(dir);
      const cfg = r.ok ? r.value : null;
      expect(cfg).not.toBeNull();
      expect(cfg?.strictResolvable).toBe(false);
      expect(cfg?.strict).toBeUndefined();
    });
  });

  test('extends a missing relative base → strict unknown', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ extends: './does-not-exist', compilerOptions: {} }),
      );
      const r = readTsConfig(dir);
      const cfg = r.ok ? r.value : null;
      expect(cfg?.strictResolvable).toBe(false);
      expect(cfg?.strict).toBeUndefined();
    });
  });

  test('cyclic extends is guarded (no hang) and resolves to unknown', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 'tsconfig.a.json'),
        JSON.stringify({ extends: './tsconfig.b.json', compilerOptions: {} }),
      );
      writeFileSync(
        join(dir, 'tsconfig.b.json'),
        JSON.stringify({ extends: './tsconfig.a.json', compilerOptions: {} }),
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ extends: './tsconfig.a.json', compilerOptions: {} }),
      );
      const r = readTsConfig(dir);
      const cfg = r.ok ? r.value : null;
      expect(cfg?.strictResolvable).toBe(false);
      expect(cfg?.strict).toBeUndefined();
    });
  });
});
