import type { IRuleSelfTest } from '@shrkcrft/core';
import type { ISelfTestCheck } from './self-test-check.ts';
import type { ISelfTestSubject } from './self-test-subject.ts';

/**
 * THE gate-plane `selfTest` evaluator: every declared expectation, checked
 * against what the rule's primary selector extracted.
 *
 * `gates coverage` (a rule in config), `gates try` (a candidate that is not in
 * config yet) and `shrk quality` all call this one function with the subject
 * the plane's coverage adapter built. A second evaluator — even a faithful
 * copy — is how a dry-run ends up passing a rule the gate then fails.
 *
 * Every check says what it counted and, when it fails, which selector it
 * consulted, so a failure names the set it looked in instead of a bare
 * "expected N match(es)". A field the plane shape cannot evaluate is reported
 * `not-evaluable` with the reason — an unmeasured assertion is never a pass,
 * and never a fabricated "got 0".
 */
export function evaluateSelfTest(
  selfTest: IRuleSelfTest | undefined,
  subject: ISelfTestSubject,
): readonly ISelfTestCheck[] {
  if (!selfTest) return [];
  const where = `consulted: ${subject.consulted}`;
  const out: ISelfTestCheck[] = [];

  if (subject.notEvaluable !== undefined) {
    const unmeasurable = (
      field: ISelfTestCheck['field'],
      expected: number | string,
    ): ISelfTestCheck => ({
      field,
      assertion: 'extracted-set',
      expected,
      status: 'not-evaluable',
      message: `selfTest.${field} cannot be evaluated: ${subject.notEvaluable} — ${where}`,
    });
    if (selfTest.expectMatchesAtLeast !== undefined) {
      out.push(unmeasurable('expectMatchesAtLeast', selfTest.expectMatchesAtLeast));
    }
    if ((selfTest.expectIds ?? []).length > 0) {
      out.push(unmeasurable('expectIds', (selfTest.expectIds ?? []).join(', ')));
    }
    if ((selfTest.expectNotIds ?? []).length > 0) {
      out.push(unmeasurable('expectNotIds', (selfTest.expectNotIds ?? []).join(', ')));
    }
    return out;
  }

  if (selfTest.expectMatchesAtLeast !== undefined) {
    const floor = selfTest.expectMatchesAtLeast;
    const got = subject.unitsMatched;
    const held = got >= floor;
    out.push({
      field: 'expectMatchesAtLeast',
      assertion: 'extracted-set',
      expected: floor,
      actual: got,
      status: held ? 'held' : 'failed',
      message: held
        ? `${got} ${subject.unitLabel} (at least ${floor} expected)`
        : `expected at least ${floor} ${subject.unitLabel}, got ${got} — ${where}`,
    });
  }
  const present = new Set(subject.ids);
  for (const id of selfTest.expectIds ?? []) {
    const held = present.has(id);
    out.push({
      field: 'expectIds',
      assertion: 'extracted-set',
      expected: id,
      status: held ? 'held' : 'failed',
      message: held
        ? `"${id}" is in the extracted set`
        : `expected id "${id}" was NOT extracted — not among the ${subject.ids.length} ` +
          `${subject.idLabel}; ${where}`,
    });
  }
  for (const id of selfTest.expectNotIds ?? []) {
    const held = !present.has(id);
    out.push({
      field: 'expectNotIds',
      assertion: 'extracted-set',
      expected: id,
      status: held ? 'held' : 'failed',
      message: held
        ? `"${id}" is not in the extracted set`
        : `id "${id}" was extracted but is listed in expectNotIds — ${where}`,
    });
  }
  return out;
}
