import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneMigrations } from '../runner/prune-migrations.ts';

function setup(): string {
  return mkdtempSync(join(tmpdir(), 'shrk-prune-'));
}

function writeState(root: string, id: string, overall: 'pass' | 'fail' | 'skipped', startedAt: string): void {
  mkdirSync(join(root, '.sharkcraft', 'migrations'), { recursive: true });
  const path = join(root, '.sharkcraft', 'migrations', `${id}.state.json`);
  writeFileSync(
    path,
    JSON.stringify({
      schema: 'sharkcraft.migration-run/v1',
      migration: { id, title: id },
      dryRun: false,
      startedAt,
      totalDurationMs: 1,
      overall,
      steps: [],
    }),
  );
  // Also align the file mtime to startedAt, since the prune fallback
  // uses mtime when the JSON is corrupted.
  const ms = Date.parse(startedAt);
  if (Number.isFinite(ms)) {
    utimesSync(path, new Date(ms), new Date(ms));
  }
}

describe('pruneMigrations', () => {
  test('returns no-op when the migrations dir does not exist', () => {
    const root = setup();
    try {
      const r = pruneMigrations({ projectRoot: root });
      expect(r.scanned).toBe(0);
      expect(r.eligible).toBe(0);
      expect(r.removed).toBe(0);
      expect(r.diagnostics[0]).toContain('no .sharkcraft/migrations');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('prunes pass entries older than threshold; skips recent ones', () => {
    const root = setup();
    try {
      const today = new Date().toISOString();
      const fortyDaysAgo = new Date(Date.now() - 40 * 86400_000).toISOString();
      writeState(root, 'recent', 'pass', today);
      writeState(root, 'old', 'pass', fortyDaysAgo);
      const r = pruneMigrations({ projectRoot: root, olderThanDays: 30 });
      expect(r.scanned).toBe(2);
      expect(r.eligible).toBe(1);
      expect(r.removed).toBe(1);
      expect(r.entries[0]!.id).toBe('old');
      expect(existsSync(join(root, '.sharkcraft', 'migrations', 'recent.state.json'))).toBe(true);
      expect(existsSync(join(root, '.sharkcraft', 'migrations', 'old.state.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps failed entries unless --include-failed', () => {
    const root = setup();
    try {
      const fortyDaysAgo = new Date(Date.now() - 40 * 86400_000).toISOString();
      writeState(root, 'failed-old', 'fail', fortyDaysAgo);
      const r1 = pruneMigrations({ projectRoot: root, olderThanDays: 30 });
      expect(r1.eligible).toBe(0);
      const r2 = pruneMigrations({ projectRoot: root, olderThanDays: 30, includeFailed: true });
      expect(r2.eligible).toBe(1);
      expect(r2.entries[0]!.reason).toBe('failed-included');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--dry-run reports without deleting', () => {
    const root = setup();
    try {
      const fortyDaysAgo = new Date(Date.now() - 40 * 86400_000).toISOString();
      writeState(root, 'old', 'pass', fortyDaysAgo);
      const r = pruneMigrations({ projectRoot: root, olderThanDays: 30, dryRun: true });
      expect(r.eligible).toBe(1);
      expect(r.removed).toBe(0);
      expect(existsSync(join(root, '.sharkcraft', 'migrations', 'old.state.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to mtime when JSON is corrupted', () => {
    const root = setup();
    try {
      mkdirSync(join(root, '.sharkcraft', 'migrations'), { recursive: true });
      const file = join(root, '.sharkcraft', 'migrations', 'corrupt.state.json');
      writeFileSync(file, 'not json');
      const old = new Date(Date.now() - 40 * 86400_000);
      utimesSync(file, old, old);
      const r = pruneMigrations({ projectRoot: root, olderThanDays: 30 });
      expect(r.eligible).toBe(1);
      expect(r.removed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
