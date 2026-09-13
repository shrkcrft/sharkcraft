/**
 * Round 11, 4.1(5) — `verifiedOn` is a first-class field, and `--stale-after`
 * asks "what has nobody checked in N days" deterministically (`asOf` pinned).
 *
 * Author attestation, not index freshness: it never changes a reference
 * outcome. Real fixture (TS + Markdown knowledge) through the real inspector.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatEntryFull, parseStaleAfterDays, validateKnowledgeEntries } from '@shrkcrft/knowledge';
import { buildKnowledgeStaleReport } from '../knowledge-stale.ts';
import { warmReferenceRegistries } from '../reference-registry.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';

const root = mkdtempSync(join(tmpdir(), 'shrk-r75-verified-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function e(id: string, verifiedOn?: string): string {
  return (
    `{ id: '${id}', title: '${id}', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], ` +
    `content: 'x', references: [{ kind: 'file', path: 'src/a.ts' }]${verifiedOn ? `, verifiedOn: '${verifiedOn}'` : ''} }`
  );
}

let insp: ISharkcraftInspection;
beforeAll(async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'vfx', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/knowledge.ts': `export default [\n  ${[
      e('v.old', '2026-01-01'),
      e('v.recent', '2026-08-01'),
      e('v.never'),
      e('v.bad', '2026-02-30'),
    ].join(',\n  ')}\n];\n`,
    'sharkcraft/notes.md': '---\nid: v.md\nverifiedOn: 2026-05-01\n---\n# Markdown note\n\nBody.\n',
    'sharkcraft/sharkcraft.config.ts':
      "export default { projectName: 'vfx', knowledgeFiles: ['knowledge.ts', 'notes.md'] };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  insp = await inspectSharkcraft({ cwd: root });
  await warmReferenceRegistries(insp);
});

describe('--stale-after with a fixed --as-of', () => {
  test('aged (oldest first) and never-verified lists are deterministic', () => {
    const r = buildKnowledgeStaleReport(insp, { staleAfterDays: 90, asOf: '2026-09-11' });
    expect(r.age?.asOf).toBe('2026-09-11');
    expect(r.age?.aged.map((a) => [a.entryId, a.verifiedOn, a.ageDays])).toEqual([
      ['v.old', '2026-01-01', 253],
      ['v.md', '2026-05-01', 133],
    ]);
    // No date, or a date that is not a real one, is "never verified".
    expect([...(r.age?.neverVerified ?? [])].sort()).toEqual(['v.bad', 'v.never']);
  });

  test('age never changes a reference outcome or a bucket', () => {
    const aged = buildKnowledgeStaleReport(insp, { staleAfterDays: 1, asOf: '2026-09-11' });
    const plain = buildKnowledgeStaleReport(insp);
    expect(aged.coverage).toEqual(plain.coverage);
    expect(plain.age).toBeUndefined();
  });
});

describe('the field itself', () => {
  test('the markdown loader carries frontmatter verifiedOn', () => {
    expect(insp.knowledgeEntries.find((x) => x.id === 'v.md')?.verifiedOn).toBe('2026-05-01');
  });

  test('`knowledge get` (formatEntryFull) prints it with its age', () => {
    const entry = insp.knowledgeEntries.find((x) => x.id === 'v.old')!;
    expect(formatEntryFull(entry, { asOf: '2026-09-11' })).toContain('verifiedOn: 2026-01-01 (253d ago)');
  });

  test('an impossible date is a validation error', () => {
    const issues = validateKnowledgeEntries(insp.knowledgeEntries).issues.filter(
      (i) => i.code === 'invalid-verified-on',
    );
    expect(issues.map((i) => i.entryId)).toEqual(['v.bad']);
  });

  test('--stale-after durations', () => {
    expect(parseStaleAfterDays('90d')).toBe(90);
    expect(parseStaleAfterDays('12w')).toBe(84);
    expect(parseStaleAfterDays('6m')).toBe(180);
    expect(parseStaleAfterDays('1y')).toBe(365);
    for (const bad of ['0d', '3x', '90', 'd', '-1d']) expect(parseStaleAfterDays(bad)).toBeNull();
  });
});
