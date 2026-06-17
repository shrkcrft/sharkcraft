import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFiles } from '../folder-scanner.ts';

describe('findFiles determinism', () => {
  test('returns a stable, lexicographically-sorted list regardless of creation order', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-findfiles-'));
    mkdirSync(join(root, 'services'), { recursive: true });
    // Create in deliberately non-alphabetical order so a raw readdir order
    // would differ from the sorted order.
    const names = ['zeta.service.ts', 'alpha.service.ts', 'mid.service.ts', 'beta.service.ts'];
    for (const n of names) writeFileSync(join(root, 'services', n), '');

    const re = /\.service\.ts$/;
    const a = findFiles(root, re, { maxDepth: 5 });
    const b = findFiles(root, re, { maxDepth: 5 });

    expect(a.length).toBe(4);
    // Deterministic across repeated calls.
    expect(a).toEqual(b);
    // Lexicographically sorted, so a caller taking `matches[0]` (e.g. the
    // onboarding inference's "sample" file) gets a stable result rather than a
    // filesystem-order-dependent one.
    expect(a).toEqual([...a].sort());
    expect(a[0]!.endsWith('alpha.service.ts')).toBe(true);
  });
});
