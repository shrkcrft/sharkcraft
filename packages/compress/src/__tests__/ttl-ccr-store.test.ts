import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TtlFileCcrStore } from '../index.ts';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'shrk-ttl-ccr-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('TtlFileCcrStore (P5.1)', () => {
  test('round-trips content across stores in the same dir (cross-process)', () => {
    const dir = freshDir();
    const a = new TtlFileCcrStore(dir);
    const key = a.put('the original blob');
    // A second store instance over the same dir sees it — i.e. another process.
    const b = new TtlFileCcrStore(dir);
    expect(b.get(key)?.content).toBe('the original blob');
    expect(b.has(key)).toBe(true);
  });

  test('expires entries past the TTL', () => {
    const dir = freshDir();
    let clock = 1_000;
    const store = new TtlFileCcrStore(dir, { ttlMs: 500, now: () => clock });
    const key = store.put('soon to expire');
    expect(store.get(key)?.content).toBe('soon to expire');
    clock = 1_400; // within TTL
    expect(store.has(key)).toBe(true);
    clock = 1_600; // past TTL (600 > 500)
    expect(store.get(key)).toBeUndefined();
    expect(store.has(key)).toBe(false);
    expect(store.size()).toBe(0);
  });

  test('sliding TTL: refreshOnAccess keeps a frequently-read entry alive', () => {
    const dir = freshDir();
    let clock = 1_000;
    const store = new TtlFileCcrStore(dir, { ttlMs: 500, refreshOnAccess: true, now: () => clock });
    const key = store.put('hot');
    clock = 1_400;
    expect(store.get(key)?.content).toBe('hot'); // refreshes timestamp to 1400
    clock = 1_800; // 400 since last access < 500 → still alive
    expect(store.get(key)?.content).toBe('hot');
  });

  test('evicts the oldest entries past maxEntries', () => {
    const dir = freshDir();
    let clock = 1_000;
    const store = new TtlFileCcrStore(dir, { maxEntries: 2, now: () => clock });
    const k1 = store.put('one');
    clock += 10;
    const k2 = store.put('two');
    clock += 10;
    const k3 = store.put('three'); // evicts the oldest (k1)
    expect(store.size()).toBe(2);
    expect(store.has(k1)).toBe(false);
    expect(store.has(k2)).toBe(true);
    expect(store.has(k3)).toBe(true);
  });

  test('rejects path-traversal keys', () => {
    const store = new TtlFileCcrStore(freshDir());
    expect(store.get('../../etc/passwd')).toBeUndefined();
    expect(store.has('../secret')).toBe(false);
  });
});
