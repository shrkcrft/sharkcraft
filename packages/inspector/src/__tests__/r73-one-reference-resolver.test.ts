import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import {
  ALL_ID_REFERENCE_KINDS,
  referenceIdExists,
  referenceIdExistsInAnyKind,
  referenceIdsFor,
  warmReferenceRegistries,
  type ReferenceKind,
} from '../reference-registry.ts';

/**
 * ONE definition of "does this id exist".
 *
 * That sentence was in the docs long before it was true of the code. Three
 * modules resolved ids — the prose linter's registry, and the v1 and v2
 * self-config doctors — each from its own sources, agreeing only by
 * coincidence. They did not always agree: the v2 doctor reported SEVENTEEN of
 * shrk's own correctly-registered ids as unknown, because its hand-written
 * "known ids" union omitted policies, decisions, scaffold patterns and paths.
 *
 * The property below is the deliverable. A `list`/`resolve` divergence on any
 * kind now fails the day it is introduced.
 */

const REPO = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');

let inspection: ISharkcraftInspection;

beforeAll(async () => {
  inspection = await inspectSharkcraft({ cwd: REPO });
  await warmReferenceRegistries(inspection);
});

describe('list ≡ resolve, for every kind', () => {
  test.each(ALL_ID_REFERENCE_KINDS.map((k) => [k] as const))(
    'every id listed for %s resolves, and a phantom does not',
    (kind: ReferenceKind) => {
      const ids = referenceIdsFor(inspection, kind);
      for (const id of ids) {
        expect(referenceIdExists(inspection, kind, id)).toBe(true);
        expect(referenceIdExistsInAnyKind(inspection, id)).toBe(true);
      }
      // The other half. A resolver that says yes to everything passes the loop
      // above and is worth nothing.
      const phantom = `zz.phantom-${kind}-that-is-not-registered`;
      expect(referenceIdExists(inspection, kind, phantom)).toBe(false);
      expect(referenceIdExistsInAnyKind(inspection, phantom)).toBe(false);
    },
  );

  test('the kinds this repo populates are NOT empty — an empty kind makes the test blind', () => {
    // A kind listing nothing cannot fail the loop above, so the property would
    // silently stop testing anything. shrk itself registers these, so if one
    // goes empty the source moved and this test says so.
    const mustBePopulated: ReferenceKind[] = [
      'template',
      'pipeline',
      'rule',
      'path-convention',
      'knowledge',
      'policy',
      'decision',
      'scaffold-pattern',
    ];
    const empty = mustBePopulated.filter((k) => referenceIdsFor(inspection, k).length === 0);
    expect(empty).toEqual([]);
  });

  test('the kind set is complete — a kind may not silently leave it', () => {
    // Deliberately hardcoded. `ALL_ID_REFERENCE_KINDS` drives the unnamed-
    // reference union, so a kind dropped from it stops being resolvable
    // everywhere at once — which is exactly how correctly-registered scaffold
    // patterns and policies came to be reported as unknown. Any edit to this
    // list must be a conscious one, visible in the diff.
    expect([...ALL_ID_REFERENCE_KINDS].sort()).toEqual([
      'boundary-rule',
      'construct',
      'contract-template',
      'convention',
      'decision',
      'helper',
      'knowledge',
      'migration-profile',
      'path-convention',
      'pipeline',
      'playbook',
      'policy',
      'registration-hint',
      'routing-hint',
      'rule',
      'scaffold-pattern',
      'template',
    ]);
  });
});

describe('one resolver, not three', () => {
  test('the self-config doctors read the shared registry, not their own sources', () => {
    // The lock. Both doctors used to build their own lookup sets; a renamed or
    // newly-added registry could reach one and not the other, with nothing to
    // notice. `buildLookups*` must be a projection of `referenceIdsFor`.
    for (const file of ['self-config-doctor.ts', 'self-config-doctor-v2.ts']) {
      const src = readFileSync(join(import.meta.dir, '..', file), 'utf8');
      const body = src.slice(src.indexOf('async function buildLookups'));
      const decl = body.slice(0, body.indexOf('\n}\n'));
      expect(decl).toContain('referenceIdsFor');
      // Building a set from anything but the registry is the regression.
      expect(decl).not.toMatch(/new Set<string>\((?!\)|referenceIdsFor)/);
    }
  });

  test('there is exactly ONE list of reference kinds', () => {
    // A second kind list is the same trap one level up: it drifts from the
    // first, and whichever surface reads the stale one starts rejecting valid
    // ids. `ID_REFERENCE_KINDS` was such a duplicate and is gone.
    const src = readFileSync(join(import.meta.dir, '..', 'reference-registry.ts'), 'utf8');
    const lists = src.match(/^export const [A-Z_]*KINDS\b/gm) ?? [];
    expect(lists).toHaveLength(1);
  });

  test('no module builds a policy/playbook/construct id set of its own', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(join(import.meta.dir, '..'))) {
      if (!file.endsWith('.ts') || file === 'reference-registry.ts') continue;
      if (file === 'policy-registry.ts' || file === 'playbook-registry.ts') continue;
      if (file === 'construct-registry.ts') continue;
      const text = readFileSync(join(import.meta.dir, '..', file), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        // The v2 doctor sourced policies from the pack inventory alone, so
        // every LOCALLY declared policy read as unknown.
        if (/entriesByKind\[['"]policy['"]\]/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('shrk resolves its own cross-references', () => {
  test('the self-config doctor reports no unknown id against this repo', async () => {
    // The end-to-end proof. Before the unification this reported 17 findings,
    // every one of them a correctly-registered id: 7 scaffold patterns and a
    // policy from a union that omitted their kinds, and 9 more once the ids
    // were namespaced. A gate that flags correct usage gets switched off.
    const report = await buildSelfConfigDoctorReportV2(inspection);
    const unknown = report.findings.filter((f) => f.code.endsWith('-missing'));
    expect(unknown.map((f) => `${f.code}:${f.targetId}`)).toEqual([]);
  });
});
