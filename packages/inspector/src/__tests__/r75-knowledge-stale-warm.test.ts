/**
 * Round 11, 1.1#warm — the staleness engine never reports a correct id STALE
 * because a registry was not loaded.
 *
 * The playbook / policy / construct / helper registries are async-filled; the
 * engine is synchronous. Unwarmed, every id checked against them used to read
 * `stale` (`playbook not found: pb.real`) — the fastest way to get a check
 * switched off. Now: a cold registry is `unknown` with the warm hint, and after
 * `warmReferenceRegistries` every id each registry LISTS resolves `ok`.
 *
 * Separate real projects: one is never warmed (the caches are keyed by project
 * root), the others are.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildKnowledgeStaleReport, ReferenceCheckOutcome } from '../knowledge-stale.ts';
import { ReferenceFailure } from '../reference-failure.ts';
import { referenceIdsFor, warmReferenceRegistries } from '../reference-registry.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

type Ref = readonly [kind: string, id: string];

/** Ids each registry lists in the fixture — every one gets a reference. */
const LISTED: readonly Ref[] = [
  ['playbook', 'pb.real'],
  ['playbook', 'pb.other'],
  ['policy', 'pol.real'],
  ['policy', 'local:pol.real'],
  ['construct', 'c.real'],
];

function fixture(refs: readonly Ref[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-warm-'));
  roots.push(root);
  const entries = refs.map(
    ([kind, id], i) =>
      `{ id: 'w.e${i}', title: 'E${i}', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], ` +
      `content: 'x', references: [{ kind: '${kind}', id: '${id}' }] }`,
  );
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'wfx', version: '0.0.0' }),
    'sharkcraft/playbooks.ts':
      "export default [{ id: 'pb.real', title: 'Real', steps: [] }, { id: 'pb.other', title: 'Other', steps: [] }];\n",
    'sharkcraft/policies.ts': "export default [{ id: 'pol.real', title: 'Real policy', evaluate: () => true }];\n",
    'sharkcraft/constructs.ts': "export default [{ id: 'c.real', type: 'feature', title: 'Real construct' }];\n",
    'sharkcraft/knowledge.ts': `export default [\n  ${entries.join(',\n  ')}\n];\n`,
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'wfx', knowledgeFiles: ['knowledge.ts'] };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function checksById(insp: ISharkcraftInspection): Map<string, { outcome: string; message: string; failure?: string }> {
  const r = buildKnowledgeStaleReport(insp);
  return new Map(r.referenceChecks.map((c) => [String(c.reference.id), c]));
}

describe('a COLD registry is not verified — never stale', () => {
  test('correct ids read unknown with the warm hint, and their entries are unverifiable', async () => {
    const cold = await inspectSharkcraft({ cwd: fixture([...LISTED, ['playbook', 'pb.missing']]) });
    const report = buildKnowledgeStaleReport(cold);
    const pb = report.referenceChecks.find((c) => c.reference.id === 'pb.real')!;
    expect(pb.outcome).toBe(ReferenceCheckOutcome.Unknown);
    expect(pb.failure).toBe(ReferenceFailure.Unverifiable);
    expect(pb.message).toContain('warmReferenceRegistries');
    for (const c of report.referenceChecks) {
      expect({ id: c.reference.id, outcome: c.outcome }).toEqual({
        id: c.reference.id,
        outcome: ReferenceCheckOutcome.Unknown,
      });
    }
    expect(report.coverage).toMatchObject({ verified: 0, stale: 0, unverifiable: report.entriesInScope });
  });
});

describe('after warming, list ≡ resolve', () => {
  let warm: ISharkcraftInspection;
  beforeAll(async () => {
    warm = await inspectSharkcraft({ cwd: fixture([...LISTED, ['playbook', 'pb.missing']]) });
    await warmReferenceRegistries(warm);
  });

  test('every id the registries LIST resolves ok through the staleness engine', () => {
    const byId = checksById(warm);
    for (const kind of ['playbook', 'policy', 'construct'] as const) {
      const listed = referenceIdsFor(warm, kind);
      expect(listed.length).toBeGreaterThan(0);
      for (const id of listed) {
        expect({ kind, id, outcome: byId.get(id)?.outcome }).toEqual({
          kind,
          id,
          outcome: ReferenceCheckOutcome.Ok,
        });
      }
    }
  });

  test('a genuinely missing id against a LOADED registry is stale, as an unregistered id', () => {
    const miss = checksById(warm).get('pb.missing');
    expect(miss?.outcome).toBe(ReferenceCheckOutcome.Stale);
    expect(miss?.failure).toBe(ReferenceFailure.IdUnregistered);
  });

  test('a helper reference goes through the SHARED resolver — never a private built-in list', async () => {
    // Whatever the helper catalog lists is what resolves; an EMPTY catalog is
    // "could not verify", never "your helper id is wrong".
    const listed = referenceIdsFor(warm, 'helper');
    const probe = listed[0] ?? 'no.such.helper';
    const insp = await inspectSharkcraft({ cwd: fixture([['helper', probe]]) });
    await warmReferenceRegistries(insp);
    const check = checksById(insp).get(probe);
    expect(check?.outcome).toBe(listed.length > 0 ? ReferenceCheckOutcome.Ok : ReferenceCheckOutcome.Unknown);
  });
});
