import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IGeneratedArtifactRule } from '@shrkcrft/core';
import { checkProvenanceHeaders } from '../generated/check-provenance.ts';
import { scanGeneratedFiles } from '../generated/scan-generated.ts';
import { clearFileReadCache, withFileReadCache } from '../util/walk-files.ts';

/**
 * A MIXED generated tree — the shape that made the single-writer rule unusable:
 * two generators owning different slices, one legitimately hand-maintained
 * file, and one stray nobody has classified.
 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shrk-mixed-'));
  mkdirSync(join(root, 'src/generated'), { recursive: true });
  writeFileSync(join(root, 'src/generated/AView.ts'), '// GENERATED — do not edit\nexport const a = 1;\n');
  writeFileSync(join(root, 'src/generated/BDto.ts'), '// GENERATED — do not edit\nexport const b = 2;\n');
  writeFileSync(join(root, 'src/generated/LegacyThing.ts'), 'export const legacy = 3;\n');
  writeFileSync(join(root, 'src/generated/Stray.ts'), 'export const stray = 4;\n');
  clearFileReadCache();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const RULE: IGeneratedArtifactRule = {
  id: 'views',
  generatedGlob: ['src/generated/*.ts'],
  sources: [
    { id: 'views', regen: 'gen-views {TMP}', glob: ['src/generated/*View.ts'] },
    { id: 'dtos', regen: 'gen-dtos {TMP}', glob: ['src/generated/*Dto.ts'] },
  ],
  handMaintained: ['src/generated/LegacyThing.ts'],
  provenanceHeader: { mustMatch: 'GENERATED .* do not edit', withinLines: 5 },
};

describe('scanGeneratedFiles — mixed-tree classification', () => {
  test('partitions the tree into per-writer slices', () => {
    const scan = scanGeneratedFiles(root, RULE);
    expect(scan.generated.size).toBe(4);
    expect(scan.slices).toHaveLength(2);
    expect([...scan.slices[0]!.files.keys()]).toEqual(['src/generated/AView.ts']);
    expect([...scan.slices[1]!.files.keys()]).toEqual(['src/generated/BDto.ts']);
  });

  test('excludes hand-maintained files from the checkable set', () => {
    const scan = scanGeneratedFiles(root, RULE);
    expect(scan.handMaintained).toEqual(['src/generated/LegacyThing.ts']);
    expect(scan.checkable.has('src/generated/LegacyThing.ts')).toBe(false);
  });

  test('surfaces a file owned by no writer as unclassified', () => {
    const scan = scanGeneratedFiles(root, RULE);
    expect(scan.unclassified).toEqual(['src/generated/Stray.ts']);
  });

  test('a single-writer rule classifies nothing as unclassified — it owns its glob', () => {
    const single: IGeneratedArtifactRule = {
      id: 'single',
      generatedGlob: ['src/generated/*.ts'],
      regen: 'gen {TMP}',
    };
    expect(scanGeneratedFiles(root, single).unclassified).toEqual([]);
  });

  test('a handMaintained pattern matching nothing is reported as a stale bless', () => {
    const stale = { ...RULE, handMaintained: ['src/generated/Gone.ts'] };
    expect(scanGeneratedFiles(root, stale).staleHandMaintained).toEqual(['src/generated/Gone.ts']);
  });
});

describe('checkProvenanceHeaders — mixed tree', () => {
  test('the hand-maintained file is NOT reported as missing-header', () => {
    const scan = scanGeneratedFiles(root, RULE);
    const { findings } = checkProvenanceHeaders(RULE, scan.checkable, scan.outside, {
      unclassified: scan.unclassified,
      staleHandMaintained: scan.staleHandMaintained,
    });
    const missing = findings.filter((f) => f.kind === 'missing-header').map((f) => f.file);
    expect(missing).not.toContain('src/generated/LegacyThing.ts');
    // The stray IS still reported — an exemption must be declared, not assumed.
    expect(missing).toContain('src/generated/Stray.ts');
  });

  test('an unclassified file is its own loud finding', () => {
    const scan = scanGeneratedFiles(root, RULE);
    const { findings } = checkProvenanceHeaders(RULE, scan.checkable, scan.outside, {
      unclassified: scan.unclassified,
    });
    const unclassified = findings.filter((f) => f.kind === 'unclassified');
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0]!.file).toBe('src/generated/Stray.ts');
    expect(unclassified[0]!.severity).toBe('error');
  });

  test('classification findings survive a rule with NO header contract', () => {
    const headerless: IGeneratedArtifactRule = { ...RULE, provenanceHeader: undefined };
    const scan = scanGeneratedFiles(root, headerless);
    const { findings } = checkProvenanceHeaders(headerless, scan.checkable, scan.outside, {
      unclassified: scan.unclassified,
      staleHandMaintained: ['src/generated/Gone.ts'],
    });
    expect(findings.map((f) => f.kind).sort()).toEqual(['stale-hand-maintained', 'unclassified']);
  });

  test('a stale bless is a WARNING — it widens nothing, it just documents a ghost', () => {
    const scan = scanGeneratedFiles(root, RULE);
    const { findings } = checkProvenanceHeaders(RULE, scan.checkable, scan.outside, {
      staleHandMaintained: ['src/generated/Gone.ts'],
    });
    const stale = findings.find((f) => f.kind === 'stale-hand-maintained');
    expect(stale?.severity).toBe('warning');
  });
});

describe('withFileReadCache — the memo may never outlive a read-only scan', () => {
  test('reuses reads INSIDE the scope', () => {
    withFileReadCache(() => {
      const a = scanGeneratedFiles(root, RULE);
      const b = scanGeneratedFiles(root, RULE);
      expect([...a.generated.keys()].sort()).toEqual([...b.generated.keys()].sort());
    });
  });

  test('a write BETWEEN scopes is seen — the memo never survives its scope', () => {
    const before = withFileReadCache(() => scanGeneratedFiles(root, RULE).generated.get('src/generated/AView.ts'));
    writeFileSync(join(root, 'src/generated/AView.ts'), '// GENERATED — do not edit\nexport const a = 99;\n');
    const after = withFileReadCache(() => scanGeneratedFiles(root, RULE).generated.get('src/generated/AView.ts'));
    // This is the regression that a global, process-wide memo caused: the
    // second read returned the FIRST read's bytes, so a drifted file looked
    // clean. A scan must always see the tree as it is now.
    expect(after).not.toBe(before);
    expect(after).toContain('99');
    // Restore for any later test in this file.
    writeFileSync(join(root, 'src/generated/AView.ts'), '// GENERATED — do not edit\nexport const a = 1;\n');
    clearFileReadCache();
  });

  test('the memo is OFF outside a scope, so an unwrapped scan is always fresh', () => {
    const before = scanGeneratedFiles(root, RULE).generated.get('src/generated/BDto.ts');
    writeFileSync(join(root, 'src/generated/BDto.ts'), '// GENERATED — do not edit\nexport const b = 77;\n');
    const after = scanGeneratedFiles(root, RULE).generated.get('src/generated/BDto.ts');
    expect(after).toContain('77');
    expect(after).not.toBe(before);
    writeFileSync(join(root, 'src/generated/BDto.ts'), '// GENERATED — do not edit\nexport const b = 2;\n');
  });
});

describe('handMaintainedMarker composes with multi-writer sources', () => {
  const MARKED: IGeneratedArtifactRule = {
    ...RULE,
    handMaintained: undefined,
    handMaintainedMarker: 'HAND-AUTHORED, NOT GENERATED',
  };

  test('a marker-blessed file is exempt AND does not become unclassified', () => {
    // Order matters: the marker exclusion runs BEFORE the writers partition the
    // tree. If it ran after, every blessed file would be owned by no writer and
    // land in `unclassified` — trading one false finding for another.
    writeFileSync(
      join(root, 'src/generated/LegacyThing.ts'),
      '// HAND-AUTHORED, NOT GENERATED\nexport const legacy = 3;\n',
    );
    clearFileReadCache();
    const scan = scanGeneratedFiles(root, MARKED);
    expect(scan.handMaintained).toContain('src/generated/LegacyThing.ts');
    expect(scan.markedHandMaintained).toContain('src/generated/LegacyThing.ts');
    expect(scan.unclassified).not.toContain('src/generated/LegacyThing.ts');
    // The genuinely unclassified stray is still reported.
    expect(scan.unclassified).toEqual(['src/generated/Stray.ts']);
    writeFileSync(join(root, 'src/generated/LegacyThing.ts'), 'export const legacy = 3;\n');
    clearFileReadCache();
  });

  test('without the marker that same file IS unclassified', () => {
    const scan = scanGeneratedFiles(root, { ...RULE, handMaintained: undefined });
    expect(scan.unclassified).toContain('src/generated/LegacyThing.ts');
  });
});
