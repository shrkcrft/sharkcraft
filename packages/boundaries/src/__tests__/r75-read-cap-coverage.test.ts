/**
 * Round 11 (integration lane, item 1) — the ONE reader reports what it did not
 * read, and every plane's coverage counts it.
 *
 * `readMatchingFiles` used to drop a glob-matched file over the 1MB read cap
 * silently. Every plane counted its expected scope from what was READ, so a
 * forbidden token in a 1.7MB file read "examined 1 of 1 ✓", and a failOnEmpty
 * rule whose only file was over the cap FAILED as "matched nothing". Now the
 * reader returns the unread files, and one rule (`readScopeCoverage`) folds
 * them into every engine's coverage as `examined N of M files, K over the 1MB
 * read cap: <path>`.
 *
 * Every fixture is a real file over the real cap on disk, next to a clean one,
 * through the real engines. Nothing is hand-built.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  coverageShortfall,
  type IGeneratedArtifactRule,
  type IPolicyRule,
  type IRegistrationIdiom,
  type IRegistryDeclaration,
  type IWiringRule,
} from '@shrkcrft/core';
import { computeBaselineFromExtractor } from '../baseline/compute-baseline.ts';
import { inspectSource, sourceDeadGlobs } from '../extract/inspect-source.ts';
import { scanGeneratedFiles } from '../generated/scan-generated.ts';
import { runPolicyLint } from '../policy/run-policy.ts';
import { planeScanExcludeDirs } from '../util/plane-scan-exclude-dirs.ts';
import { READ_CAP_REASON, readScopeCoverage } from '../util/read-scope-coverage.ts';
import { UnreadFileReason } from '../util/unread-file-reason.ts';
import {
  MAX_SCAN_FILE_BYTES,
  readMatchingFiles,
  walkSkipsDirectory,
  withFileReadCache,
} from '../util/walk-files.ts';
import { explainWiring } from '../wiring/explain-wiring.ts';
import { buildRegistrationGraph } from '../wiring/registration-graph.ts';
import { scanRegistry } from '../wiring/registry-query.ts';
import { runWiring } from '../wiring/scan-wiring-files.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-readcap-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** A real file just over the one reader's cap: `body`, then padding. */
function overCap(body: string): string {
  return `${body}\n// ${'x'.repeat(MAX_SCAN_FILE_BYTES + 16)}\n`;
}

/** The gap sentence every plane now prints for one unread file. */
const GAP = `examined 1 of 2 files, 1 ${READ_CAP_REASON}: src/big.ts`;

const TREE = {
  'src/clean.ts': 'export const CLEAN = 1;\n',
  'src/big.ts': overCap('export const BIG = "FORBIDDEN_TOKEN";'),
};

describe('the one reader returns the matched files it did not read', () => {
  test('an over-cap file is reported unread (with its size), never silently dropped', () => {
    const root = tree(TREE);
    const matched = readMatchingFiles(root, ['src/**/*.ts']);
    expect([...matched.files.keys()]).toEqual(['src/clean.ts']);
    expect(matched.unread.map((u) => [u.path, u.reason])).toEqual([['src/big.ts', UnreadFileReason.OverReadCap]]);
    expect(matched.unread[0]!.bytes).toBeGreaterThan(MAX_SCAN_FILE_BYTES);
  });

  test('a memoized read hands back the same unread list with a fresh map', () => {
    const root = tree(TREE);
    withFileReadCache(() => {
      const a = readMatchingFiles(root, ['src/**/*.ts']);
      a.files.delete('src/clean.ts');
      const b = readMatchingFiles(root, ['src/**/*.ts']);
      expect([...b.files.keys()]).toEqual(['src/clean.ts']);
      expect(b.unread.map((u) => u.path)).toEqual(['src/big.ts']);
    });
  });

  test('a file the process cannot read is reported unreadable', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // root reads anything
    const root = tree({ 'src/clean.ts': 'export const A = 1;\n', 'src/locked.ts': 'export const L = 1;\n' });
    chmodSync(join(root, 'src/locked.ts'), 0o000);
    try {
      const matched = readMatchingFiles(root, ['src/**/*.ts']);
      expect(matched.unread.map((u) => [u.path, u.reason])).toEqual([['src/locked.ts', UnreadFileReason.Unreadable]]);
    } finally {
      chmodSync(join(root, 'src/locked.ts'), 0o644);
    }
  });

  test('the walker skips directories through ONE exported predicate', () => {
    expect(walkSkipsDirectory('node_modules', 'node_modules', new Set())).toBe(true);
    expect(walkSkipsDirectory('sharkcraft', 'sharkcraft', new Set(['sharkcraft']))).toBe(true);
    expect(walkSkipsDirectory('.claude', '.claude', new Set())).toBe(true);
    expect(walkSkipsDirectory('.claude', '.claude', new Set(), new Set(['.claude']))).toBe(false);
    expect(walkSkipsDirectory('src', 'src', new Set())).toBe(false);
  });
});

describe('policy: the file record replaces "examined 1 of 1 ✓"', () => {
  const RULE: IPolicyRule = {
    id: 'no-forbidden',
    surface: 'ts',
    files: ['src/**/*.ts'],
    pattern: 'FORBIDDEN_TOKEN',
    message: 'm',
    severity: 'warning',
  };

  test('a forbidden token inside an over-cap file: the rule is NOT a pass, and the gap names the file', () => {
    const root = tree(TREE);
    const report = runPolicyLint(root, [RULE]);
    const r = report.rules[0]!;
    // It found nothing among what it read ...
    expect(r.status).toBe('passed');
    expect(report.findings).toEqual([]);
    // ... and the coverage says it read 1 of the 2 files its glob matched.
    expect(r.coverage).toEqual({
      unit: 'files',
      expected: 2,
      examined: 1,
      unexamined: ['src/big.ts'],
      unexaminedTotal: 1,
      reason: READ_CAP_REASON,
    });
    expect(coverageShortfall(r.coverage)).toBe(GAP);
    expect(r.unread?.map((u) => u.path)).toEqual(['src/big.ts']);
  });

  test('a failOnEmpty rule whose only file is over the cap is PARTIAL — never the failOnEmpty failure', () => {
    const errRule: IPolicyRule = { ...RULE, severity: 'error', files: ['src/big.ts'] }; // failOnEmpty on by default
    const root = tree(TREE);
    const report = runPolicyLint(root, [errRule]);
    const r = report.rules[0]!;
    expect({ status: r.status, verdict: report.verdict, skipped: report.skipped }).toEqual({
      status: 'passed',
      verdict: 'pass',
      skipped: [],
    });
    expect(coverageShortfall(r.coverage)).toBe(`examined 0 of 1 files, 1 ${READ_CAP_REASON}: src/big.ts`);
    // Control: the same rule over a glob that matches NOTHING still fails on empty.
    const dead = runPolicyLint(root, [{ ...errRule, files: ['nowhere/*.ts'] }]);
    expect(dead.skipped.map((s) => s.failed)).toEqual([true]);
    expect(dead.verdict).toBe('errors');
  });

  test('--changed-only: a changed over-cap file keeps the rule in scope, PARTIAL naming it (not failOnEmpty 1)', () => {
    const root = tree(TREE);
    const report = runPolicyLint(root, [{ ...RULE, severity: 'error' }], {
      changedOnly: true,
      changedFiles: ['src/big.ts'],
    });
    expect(report.rules.map((r) => r.status)).toEqual(['passed']);
    expect(report.verdict).toBe('pass');
    expect(coverageShortfall(report.rules[0]!.coverage)).toBe(`examined 0 of 1 files, 1 ${READ_CAP_REASON}: src/big.ts`);
  });

  test('a glob that matched only an over-cap file is not a dead glob', () => {
    const root = tree(TREE);
    const r = runPolicyLint(root, [{ ...RULE, files: ['src/big.ts', 'src/clean.ts'] }]).rules[0]!;
    expect(r.deadGlobs).toBeUndefined();
  });
});

describe('wiring: an unread file on either side is in the rule coverage', () => {
  const TOKENS_TREE = {
    'src/tokens/big.ts': overCap('export const A_T = 1;'),
    'src/reg.ts': 'export const T = [A_T];\n',
  };
  const RULE: IWiringRule = {
    id: 'tokens-wired',
    declared: { files: ['src/tokens/*.ts'], extract: 'export-names', match: '_T$' },
    registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'T' },
  }; // error severity → failOnEmpty on

  test('the source side over the cap: PARTIAL naming the file, never a failOnEmpty failure', () => {
    const root = tree(TOKENS_TREE);
    const report = runWiring(root, [RULE]);
    const r = report.rules[0]!;
    expect({ status: r.status, verdict: report.verdict, skipped: report.skipped.length, evaluated: report.evaluated }).toEqual({
      status: 'passed',
      verdict: 'pass',
      skipped: 0,
      evaluated: 1,
    });
    expect(coverageShortfall(r.coverage)).toBe(`examined 1 of 2 files, 1 ${READ_CAP_REASON}: src/tokens/big.ts`);
    // The explain reads the SAME engine record (it hands the engine the same unread list).
    expect(explainWiring(root, RULE).coverage).toEqual(r.coverage);
  });

  test('the sink over the cap: the coverage names it, and the empty-sink hint says it was never read', () => {
    const root = tree({
      'src/tokens/a.ts': 'export const A_T = 1;\n',
      'src/reg.ts': overCap('export const T = [A_T];'),
    });
    const r = runWiring(root, [RULE]).rules[0]!;
    expect(r.emptySink).toBe(true);
    expect(r.sinkHint).toContain('was never read');
    expect(r.sinkHint).toContain('src/reg.ts');
    expect(coverageShortfall(r.coverage)).toBe(`examined 1 of 2 files, 1 ${READ_CAP_REASON}: src/reg.ts`);
  });
});

describe('the extraction planes carry the unread files to their coverage', () => {
  const SOURCE = { files: ['src/**/*.ts'], extract: 'export-names' as const };

  test('inspectSource reports them, and a glob matching only one is not dead', () => {
    const root = tree(TREE);
    const insp = inspectSource(root, SOURCE);
    expect({ read: insp.filesScanned, unread: insp.unread.map((u) => u.path), ids: insp.ids }).toEqual({
      read: 1,
      unread: ['src/big.ts'],
      ids: ['CLEAN'],
    });
    expect(sourceDeadGlobs(root, { files: ['src/big.ts', 'src/clean.ts'], extract: 'export-names' })).toEqual([]);
  });

  test('registry: an inventory over an unread source file is incomplete, and says so', () => {
    const root = tree(TREE);
    const decl: IRegistryDeclaration = { name: 'exports', source: SOURCE };
    const inv = scanRegistry(root, decl);
    expect(inv.entries.map((e) => e.id)).toEqual(['CLEAN']);
    expect(inv.readScope).toEqual({ read: 1, unread: [expect.objectContaining({ path: 'src/big.ts' })] });
    const cov = readScopeCoverage({ unit: 'ids', expected: 1, examined: 1 }, inv.readScope);
    expect(coverageShortfall(cov)).toBe(GAP);
  });

  test('baseline: the extractor compute reports its unread files', () => {
    const root = tree(TREE);
    const res = computeBaselineFromExtractor(root, SOURCE);
    expect({ ids: res.ids, read: res.filesScanned, unread: res.unread.map((u) => u.path) }).toEqual({
      ids: ['CLEAN'],
      read: 1,
      unread: ['src/big.ts'],
    });
  });

  test('registration: the graph carries its read scope', () => {
    const root = tree(TREE);
    const idiom: IRegistrationIdiom = { name: 'i', declared: SOURCE, provided: SOURCE, consumed: SOURCE };
    const graph = buildRegistrationGraph(root, [idiom]);
    expect(graph.readScope).toEqual({ read: 1, unread: [expect.objectContaining({ path: 'src/big.ts' })] });
  });

  test('generated: an over-cap committed file is in the read scope, and a bless naming it is not stale', () => {
    const root = tree({
      'gen/a.json': '{}\n',
      'gen/big.json': overCap('{}'),
    });
    const rule: IGeneratedArtifactRule = { id: 'gen', generatedGlob: ['gen/**'], handMaintained: ['gen/big.json'] };
    const scan = scanGeneratedFiles(root, rule);
    expect([...scan.generated.keys()]).toEqual(['gen/a.json']);
    expect(scan.readScope).toEqual({ read: 1, unread: [expect.objectContaining({ path: 'gen/big.json' })] });
    expect(scan.staleHandMaintained).toEqual([]);
  });
});

describe('one scan-scope authority', () => {
  test('the SharkCraft dir inside the project is pruned; one outside it prunes nothing', () => {
    expect(planeScanExcludeDirs('/repo', '/repo/sharkcraft')).toEqual(['sharkcraft']);
    expect(planeScanExcludeDirs('/repo/sub', '/repo/sharkcraft')).toEqual([]);
    expect(planeScanExcludeDirs('/repo', null)).toEqual([]);
  });
});
