/**
 * Shared source-mtime freshness helper (`../status/freshness.ts`).
 *
 * Drives `computeMtimeFreshness` directly against a throwaway tree:
 *   - a build newer than every source  → state 'fresh', behindMs 0;
 *   - a source touched after the build  → state 'stale', behindMs > 0,
 *     lastChangedAt set;
 *   - an unparseable build timestamp    → state 'unknown';
 *   - files under skip dirs / non-source extensions are ignored when
 *     computing the newest source mtime.
 *
 * This is the single home for the walk that `framework status` and
 * `context status` used to inline byte-for-byte.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { computeMtimeFreshness } from '../status/freshness.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-freshness-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write `rel` under `root` and stamp its mtime to `when`. */
function writeWithMtime(root: string, rel: string, contents: string, when: Date): void {
  const abs = nodePath.join(root, rel);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
  utimesSync(abs, when, when);
}

const OLD = new Date('2020-01-01T00:00:00.000Z');
const MID = new Date('2021-01-01T00:00:00.000Z');
const NEW = new Date('2022-01-01T00:00:00.000Z');
const FUTURE = new Date('2099-01-01T00:00:00.000Z');

describe('computeMtimeFreshness', () => {
  test('build newer than newest source → fresh, behindMs 0', () => {
    withTmp((dir) => {
      writeWithMtime(dir, 'src/a.ts', 'export const a = 1;', OLD);
      const fresh = computeMtimeFreshness(dir, MID.toISOString());
      expect(fresh.state).toBe('fresh');
      expect(fresh.behindMs).toBe(0);
      expect(fresh.lastBuiltAt).toBe(MID.toISOString());
      // newest source mtime is reported even when fresh.
      expect(fresh.lastChangedAt).not.toBeNull();
      expect(fresh.lastChangedAt!.startsWith('2020')).toBe(true);
    });
  });

  test('source touched after the build → stale, behindMs > 0, lastChangedAt set', () => {
    withTmp((dir) => {
      writeWithMtime(dir, 'src/a.ts', 'export const a = 2;', NEW);
      const fresh = computeMtimeFreshness(dir, MID.toISOString());
      expect(fresh.state).toBe('stale');
      expect(fresh.behindMs).toBeGreaterThan(0);
      expect(fresh.lastChangedAt).not.toBeNull();
      expect(fresh.lastChangedAt!.startsWith('2022')).toBe(true);
    });
  });

  test('unparseable build timestamp → unknown', () => {
    withTmp((dir) => {
      writeWithMtime(dir, 'src/a.ts', 'export const a = 3;', OLD);
      const fresh = computeMtimeFreshness(dir, 'not-a-real-date');
      expect(fresh.state).toBe('unknown');
      expect(fresh.behindMs).toBe(0);
      expect(fresh.lastBuiltAt).toBe('not-a-real-date');
    });
  });

  test('null / undefined build timestamp → unknown', () => {
    withTmp((dir) => {
      writeWithMtime(dir, 'src/a.ts', 'export const a = 4;', OLD);
      expect(computeMtimeFreshness(dir, null).state).toBe('unknown');
      expect(computeMtimeFreshness(dir, undefined).state).toBe('unknown');
    });
  });

  test('files under skip dirs / non-source extensions are ignored', () => {
    withTmp((dir) => {
      // Only real source: an old .ts file.
      writeWithMtime(dir, 'src/a.ts', 'export const a = 5;', OLD);
      // Decoys with a far-future mtime that must NOT count.
      writeWithMtime(dir, 'node_modules/dep/index.ts', 'x', FUTURE);
      writeWithMtime(dir, 'dist/built.ts', 'x', FUTURE);
      writeWithMtime(dir, 'src/notes.txt', 'x', FUTURE);
      writeWithMtime(dir, '.cache/blob.ts', 'x', FUTURE);
      const fresh = computeMtimeFreshness(dir, MID.toISOString());
      // Newest source is the 2020 .ts, so a 2021 build is fresh.
      expect(fresh.state).toBe('fresh');
      expect(fresh.behindMs).toBe(0);
      expect(fresh.lastChangedAt!.startsWith('2020')).toBe(true);
    });
  });

  test('no source files at all → lastChangedAt null', () => {
    withTmp((dir) => {
      writeWithMtime(dir, 'README.txt', 'docs', FUTURE);
      const fresh = computeMtimeFreshness(dir, MID.toISOString());
      expect(fresh.lastChangedAt).toBeNull();
      // newestMs is 0, build is finite → not behind.
      expect(fresh.state).toBe('fresh');
    });
  });
});
