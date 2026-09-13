/**
 * Round 11 §1.4#a — a contribution file the module loader cannot import is a
 * LOAD FAILURE, never a regex scrape reported `validation: 'ok'`. And the
 * inventory's `sourceFile` values are a pure function of the repo, not of
 * `process.cwd()` (a pack-relative path used to be resolved against the cwd,
 * which also let a convention's nested `rules[].id` leak in as a contribution).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ConventionKind, ConventionSeverity } from '@shrkcrft/plugin-api';
import {
  buildPackContributionsInventory,
  buildPackContributionsInventoryAsync,
  ConflictKind,
  inspectSharkcraft,
  renderInventoryMarkdown,
  renderInventoryText,
} from '../index.ts';

const REPO = resolve(import.meta.dir, '../../../..');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const GOOD_KNOWLEDGE = `export default [{ id: 'pack.good.one', title: 'Good', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'ok' }];\n`;
// Two adjacent string literals, no operator — a hard syntax error.
const BROKEN_KNOWLEDGE = `export default [{ id: 'pack.broken.one', title: 'Broken', content: 'x', tags: ['a' 'b'] }];\n`;
const BROKEN_HELPERS = `export default [{ id: 'r75.broken-helper', title: 'B', description: 'b', variables: [], tags: ['a' 'b'], safety: { outputKind: 'plan' } }];\n`;
const GOOD_HELPERS = `export default [{ id: 'r75.add-route', title: 'Add route', description: 'Add a route', variables: [], safety: { outputKind: 'plan' } }];\n`;
const CONVENTIONS = `export default [{ id: 'r75.convention', title: 'Conv', kind: '${Object.values(ConventionKind)[0]}', severity: '${Object.values(ConventionSeverity)[0]}', rules: [{ id: 'r1', description: 'nested rule id' }] }];\n`;

function consumer(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-inv-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
  const pack = join(root, 'node_modules', '@r75', 'broken');
  write(pack, 'package.json', JSON.stringify({ name: '@r75/broken', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    pack,
    'manifest.json',
    JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@r75/broken', version: '0.0.1' },
      contributions: {
        knowledgeFiles: ['./k-good.ts', './k-broken.ts'],
        helperFiles: ['./helpers-good.ts', './helpers-broken.ts'],
        conventionFiles: ['./conventions.ts'],
      },
    }),
  );
  write(pack, 'k-good.ts', GOOD_KNOWLEDGE);
  write(pack, 'k-broken.ts', BROKEN_KNOWLEDGE);
  write(pack, 'helpers-good.ts', GOOD_HELPERS);
  write(pack, 'helpers-broken.ts', BROKEN_HELPERS);
  write(pack, 'conventions.ts', CONVENTIONS);
  return root;
}

describe('the async inventory reports load failures, never a scraped "ok"', () => {
  test('ids scraped from a file that failed to load are validation "error", one InvalidContribution per file', async () => {
    const root = consumer();
    const inspection = await inspectSharkcraft({ cwd: root });
    const inv = await buildPackContributionsInventoryAsync(inspection);

    for (const id of ['pack.broken.one', 'r75.broken-helper']) {
      const e = inv.entries.find((x) => x.id === id);
      expect({ id, validation: e?.validation, mode: e?.extractionMode }).toEqual({
        id,
        validation: 'error',
        mode: 'regex-fallback',
      });
      expect(e?.validationMessage).toContain('does NOT take effect');
    }
    const invalid = inv.conflicts.filter((c) => c.kind === ConflictKind.InvalidContribution);
    expect(invalid.map((c) => c.id).sort()).toEqual([
      'node_modules/@r75/broken/helpers-broken.ts',
      'node_modules/@r75/broken/k-broken.ts',
    ]);
    expect(invalid.every((c) => c.severity === 'error')).toBe(true);
    expect(inv.loadFailures.map((f) => f.file).sort()).toEqual(invalid.map((c) => c.id).sort());
    expect(inv.loadFailures.find((f) => f.file.endsWith('k-broken.ts'))?.scrapedIds).toEqual(['pack.broken.one']);

    // The healthy siblings stay structural and ok.
    expect(inv.entries.find((x) => x.id === 'pack.good.one')?.extractionMode).toBe('structural');
    expect(inv.entries.find((x) => x.id === 'r75.add-route')?.validation).toBe('ok');
    expect(inv.extractionTotals.regexFallback).toBeGreaterThanOrEqual(2);

    const text = renderInventoryText(inv);
    expect(text).toContain('regex-fallback');
    expect(text).toContain('Load failures (2)');
    expect(text).toContain('regex-scraped ids NOT loaded: pack.broken.one');
    expect(renderInventoryMarkdown(inv)).toContain('## Load failures');
  });

  test('the sync wrapper still reports the load failure, and marks its regex ids unverified', async () => {
    const root = consumer();
    const inspection = await inspectSharkcraft({ cwd: root });
    const inv = buildPackContributionsInventory(inspection);
    expect(inv.mode).toBe('sync');
    expect(inv.entries.find((x) => x.id === 'pack.broken.one')?.validation).toBe('error');
    const helper = inv.entries.find((x) => x.id === 'r75.add-route');
    expect(helper?.validation).toBe('warning');
    expect(helper?.validationMessage).toContain('unverified');
  });
});

describe('sourceFile is cwd-independent', () => {
  test('built from the repo cwd and from the consumer cwd, the inventory is identical; no nested rules[].id leaks', async () => {
    const root = consumer();
    const inspection = await inspectSharkcraft({ cwd: root });
    const original = process.cwd();
    const snapshot = async (): Promise<string[]> =>
      (await buildPackContributionsInventoryAsync(inspection)).entries
        .map((e) => `${e.kind}|${e.id}|${e.sourceFile}|${e.extractionMode}|${e.validation}`)
        .sort();
    let fromRepo: string[];
    let fromConsumer: string[];
    try {
      process.chdir(REPO);
      fromRepo = await snapshot();
      process.chdir(root);
      fromConsumer = await snapshot();
    } finally {
      process.chdir(original);
    }
    expect(fromRepo).toEqual(fromConsumer);
    expect(fromRepo.some((l) => l.startsWith('convention|r1|'))).toBe(false);
    expect(fromRepo).toContain(
      'convention|r75.convention|node_modules/@r75/broken/conventions.ts|structural|ok',
    );
  });
});
