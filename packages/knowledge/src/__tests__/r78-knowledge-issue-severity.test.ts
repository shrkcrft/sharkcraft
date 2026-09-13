/**
 * r78 — ONE severity enum for a knowledge validation issue and a reference
 * `root` problem (round 15 follow-up, lane B — B3).
 *
 * `IKnowledgeValidationIssue.severity` and `IReferenceRootProblem.severity`
 * were two separate `'error' | 'warning'` unions. The `root` predicate's
 * severity is copied onto the validator's issue, so they agreed only by
 * coincidence, and a bare string could stand in for either. Both are now
 * `KnowledgeIssueSeverity`.
 *
 * The type-level locks below are compiled by the base tsc gate (it includes
 * every `packages/<pkg>/src/**` file). A union that returns fails `Equals`,
 * and an unused `@ts-expect-error` fails the build.
 */
import { describe, expect, test } from 'bun:test';
import {
  KnowledgeIssueSeverity,
  referenceRootProblem,
  validateKnowledgeEntries,
  type IKnowledgeEntry,
  type IKnowledgeValidationIssue,
  type IReferenceRootProblem,
} from '../index.ts';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const ISSUE_SEVERITY_IS_THE_ENUM: Equals<IKnowledgeValidationIssue['severity'], KnowledgeIssueSeverity> = true;
const ROOT_SEVERITY_IS_THE_ENUM: Equals<IReferenceRootProblem['severity'], KnowledgeIssueSeverity> = true;
const SAME_SEVERITY: Equals<IKnowledgeValidationIssue['severity'], IReferenceRootProblem['severity']> = true;
// @ts-expect-error — a bare string literal is not a KnowledgeIssueSeverity (the old union accepted one).
const LITERAL_REFUSED: IKnowledgeValidationIssue['severity'] = 'error';

function entry(over: Partial<IKnowledgeEntry> & { readonly id: string }): IKnowledgeEntry {
  return { title: over.id, type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', ...over };
}

const SEVERITIES: readonly string[] = Object.values(KnowledgeIssueSeverity);

describe('r78 B3 — KnowledgeIssueSeverity is the one severity of both shapes', () => {
  test('the type-level locks hold (compiled by the base tsc gate)', () => {
    expect(ISSUE_SEVERITY_IS_THE_ENUM).toBe(true);
    expect(ROOT_SEVERITY_IS_THE_ENUM).toBe(true);
    expect(SAME_SEVERITY).toBe(true);
    expect(LITERAL_REFUSED).toBe(KnowledgeIssueSeverity.Error);
    expect([...SEVERITIES].sort()).toEqual(['error', 'warning']);
  });

  test('every validator issue carries an enum member, errors and warnings alike', () => {
    const r = validateKnowledgeEntries([
      // An error (a `supersededBy` naming itself) and a warning (a `seeAlso` naming itself).
      entry({ id: 'k.self', supersededBy: ['k.self'], seeAlso: ['k.self'] }),
      // A warning: an unknown type.
      entry({ id: 'k.typed', type: 'nonsense' as IKnowledgeEntry['type'] }),
      // An error from THE root predicate: `root: pack` on an entry no pack contributes.
      entry({ id: 'k.root', references: [{ kind: 'file', path: 'docs/a.md', root: 'pack' } as never] }),
    ]);
    expect(r.issues.length).toBeGreaterThanOrEqual(4);
    for (const i of r.issues) expect(SEVERITIES).toContain(i.severity);
    const seen = new Set(r.issues.map((i) => i.severity));
    expect(seen.has(KnowledgeIssueSeverity.Error)).toBe(true);
    expect(seen.has(KnowledgeIssueSeverity.Warning)).toBe(true);
    expect(r.valid).toBe(false);
  });

  test("the root predicate's severity reaches the validator issue unchanged (one value, not two that agree)", () => {
    const ref = { kind: 'template', id: 'x.y', root: 'pack' };
    const problem = referenceRootProblem(ref, true);
    expect(problem?.severity).toBe(KnowledgeIssueSeverity.Warning);
    const r = validateKnowledgeEntries([entry({ id: 'k.pack', references: [ref as never] })], { isPackContributed: () => true });
    const issue = r.issues.find((i) => i.entryId === 'k.pack' && i.message.includes('root: pack'));
    expect(issue?.severity).toBe(problem!.severity);
  });
});
