import type { IGateCoverage } from './rule-coverage.ts';

/**
 * A scaffolded `selfTest`, ready to paste (or to insert with `--write`).
 *
 * The trust layer asks every rule to carry `failOnEmpty` + a `selfTest`, so a
 * stale glob after a directory move fails LOUD instead of passing over an empty
 * set. In practice the selfTest is the step that gets skipped — not from
 * disagreement, but because authoring the fixture inline (which ids to pin,
 * what floor to set) is a blank page at the exact moment the author just wants
 * the rule to work. A rule with no selfTest is invisible to the stale-glob
 * detector, so the friction converts directly into missing coverage.
 */
export interface IScaffoldedSelfTest {
  readonly ruleId: string;
  readonly plane: string;
  /** What the rule matches right now — the number the floor is derived from. */
  readonly currentCount: number;
  readonly expectMatchesAtLeast: number;
  readonly expectIds: readonly string[];
  /** The percentage of headroom left below the current count. */
  readonly marginPercent: number;
  /** The literal block to paste into the rule. */
  readonly snippet: string;
}

/** Markers that make an id a poor anchor: it is likely to be renamed or removed. */
const UNSTABLE = /(^|[^a-z])(tmp|temp|draft|wip|scratch|legacy|deprecated|old|new|test|fixture|sample|example|foo|bar|baz)([^a-z]|$)/i;

/**
 * How good an anchor an id is, higher is better.
 *
 * A selfTest is only as useful as the ids it pins: anchoring on a name that was
 * always going to be deleted produces a rule that fails for a reason unrelated
 * to the selector, which trains people to delete the selfTest. So the obviously
 * temporary and the obviously generated are ranked last, and everything else is
 * ordered deterministically by name so the same tree always scaffolds the same
 * fixture.
 */
function stability(id: string): number {
  let score = 100;
  if (UNSTABLE.test(id)) score -= 60;
  // A long digit or hex run reads as generated (a hash, a timestamp, an index).
  if (/\d{4,}/.test(id)) score -= 40;
  if (/[0-9a-f]{8,}/i.test(id)) score -= 40;
  // Trailing counters (`handlerV2`, `route3`) churn as versions advance.
  if (/\d$/.test(id)) score -= 15;
  return score;
}

/**
 * Build a ready-to-commit `selfTest` from what the rule matches TODAY.
 *
 * The floor is deliberately BELOW the current count: pinning the exact number
 * would turn every legitimate addition into a failure, and a rule that cries
 * wolf on normal work gets its expectations deleted rather than fixed. The
 * margin is what keeps the assertion about "the selector still bites" rather
 * than about "the set never changes".
 */
export function scaffoldSelfTest(
  coverage: IGateCoverage,
  marginPercent: number,
  sampleSize = 3,
): IScaffoldedSelfTest {
  const ids = coverage.allIds ?? coverage.sampleIds;
  const count = coverage.unitsMatched;
  const floor = Math.max(1, Math.floor(count * (1 - marginPercent / 100)));
  const expectIds = [...ids]
    .sort((a, b) => stability(b) - stability(a) || a.localeCompare(b))
    .slice(0, Math.min(sampleSize, ids.length));
  const snippet = [
    'selfTest: {',
    `  expectMatchesAtLeast: ${floor},`,
    ...(expectIds.length > 0
      ? [`  expectIds: [${expectIds.map((i) => `'${i}'`).join(', ')}],`]
      : []),
    '  expectNotIds: [],',
    '},',
  ].join('\n');
  return {
    ruleId: coverage.id,
    plane: coverage.plane,
    currentCount: count,
    expectMatchesAtLeast: floor,
    expectIds,
    marginPercent,
    snippet,
  };
}

/** Outcome of inserting a scaffolded selfTest into the config text. */
export interface IInsertResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
}

/**
 * Insert the block into the rule whose `id` matches, in place.
 *
 * Refuses rather than guesses. A config is the file every gate reads, so a
 * write that lands in the wrong rule — or in one of two rules sharing an id —
 * would silently re-point an assertion at a different set, which is worse than
 * making the author paste three lines by hand.
 */
export function insertSelfTest(
  configText: string,
  ruleId: string,
  snippet: string,
): IInsertResult {
  // A registry declaration is keyed by `name`, every other plane by `id`. Both
  // are the rule's identity as `gates list` prints it, so both are accepted —
  // an author should not have to know which plane spells it which way.
  const idPattern = new RegExp(
    `^([ \\t]*)(?:id|name):\\s*['"\`]${escapeRegex(ruleId)}['"\`]\\s*,?\\s*$`,
    'gm',
  );
  const matches = [...configText.matchAll(idPattern)];
  if (matches.length === 0) {
    return {
      ok: false,
      error: `no \`id: '${ruleId}'\` (or \`name:\`) line found in the config — is the rule contributed by a pack?`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `"${ruleId}" appears ${matches.length} times — refusing to guess which rule to edit`,
    };
  }
  const m = matches[0]!;
  const indent = m[1] ?? '  ';
  const lineEnd = configText.indexOf('\n', m.index!);
  const at = lineEnd === -1 ? configText.length : lineEnd + 1;
  const block = snippet
    .split('\n')
    .map((l) => (l === '' ? l : indent + l))
    .join('\n');
  return { ok: true, text: configText.slice(0, at) + block + '\n' + configText.slice(at) };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
