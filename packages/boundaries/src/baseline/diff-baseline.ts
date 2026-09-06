import type { IBaselineRule } from '@shrkcrft/core';
import { extractJsonPath } from './json-path-keys.ts';
import { canonicalizePair, tryParseJson, type CanonicalForm } from './canonicalize.ts';

export const BASELINE_SCHEMA = 'sharkcraft.baseline/v1' as const;

/** How the two sides were compared. */
export type BaselineCompareMode = 'keyed-set' | 'element-set' | 'canonical-text';

/**
 * Per-rule outcome. `skipped` is DISTINCT from `passed`: a recompute that
 * produced nothing compared nothing, and a silently-empty compute would
 * "match" an empty baseline forever.
 */
export type BaselineStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface IBaselineDiff {
  /** Entries present now but not in the committed baseline. */
  readonly added: readonly string[];
  /** Entries in the committed baseline but gone now. */
  readonly removed: readonly string[];
  /** How the comparison was performed. */
  readonly mode: BaselineCompareMode;
  /** The canonical form applied to both sides. */
  readonly canonical: string;
  /** True when the canonical texts are byte-identical. */
  readonly identical: boolean;
}

export interface IBaselineResult {
  readonly ruleId: string;
  readonly description?: string;
  readonly baselinePath: string;
  readonly severity: 'error' | 'warning';
  readonly status: BaselineStatus;
  readonly direction: 'two-way' | 'additions-only' | 'no-shrink';
  readonly diff?: IBaselineDiff;
  /** Entry count on each side (keyed mode) or line count (text mode). */
  readonly baselineCount: number;
  readonly currentCount: number;
  /** Set when the rule could not run (missing baseline file, failed compute, bad config). */
  readonly error?: string;
  /** Why the rule compared nothing. */
  readonly skipReason?: string;
  /** The remediation line for this rule. */
  readonly hint: string;
}

export interface IBaselineReport {
  readonly schema: typeof BASELINE_SCHEMA;
  readonly results: readonly IBaselineResult[];
  readonly evaluated: number;
  readonly verdict: 'pass' | 'errors' | 'warnings';
}

/** Split canonical text into comparable entries (a set of non-empty lines). */
function textEntries(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '');
}

/**
 * The scalar elements of a top-level JSON array, or `undefined` for any other
 * shape.
 *
 * A committed inventory is most often exactly this — a JSON list of ids — and
 * diffing it by LINE reports `  "beta"` with its quote and comma, plus the
 * bracket lines, as changes. Naming the entry is the whole point of a ledger
 * diff, so the array case is compared element-wise.
 */
function jsonArrayEntries(text: string): string[] | undefined {
  const parsed = tryParseJson(text);
  if (!Array.isArray(parsed)) return undefined;
  const out: string[] = [];
  for (const el of parsed) {
    if (el === null || typeof el === 'object') return undefined;
    out.push(String(el));
  }
  return out;
}

/** Set difference preserving the left side's order, de-duplicated. */
function minus(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of left) {
    if (rightSet.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Compare a committed baseline against a freshly computed value.
 *
 * With `keyBy` the two sides are compared as KEYED SETS (per-key added/removed);
 * otherwise both are canonicalized and compared as text, with the line-level set
 * difference reported so the human diff names what actually moved.
 *
 * Pure: the caller supplies both strings, so the same engine serves a
 * shell-computed ledger, an extractor-computed inventory, and a unit test.
 */
export function diffBaseline(
  rule: IBaselineRule,
  committed: string,
  current: string,
): IBaselineDiff {
  const form = (rule.compute.canonical ?? 'auto') as CanonicalForm;
  const pair = canonicalizePair(committed, current, form);

  if (rule.keyBy) {
    const before = extractJsonPath(committed, rule.keyBy);
    const after = extractJsonPath(current, rule.keyBy);
    return {
      added: minus(after, before),
      removed: minus(before, after),
      mode: 'keyed-set',
      canonical: pair.expected.form,
      identical: pair.expected.text === pair.actual.text,
    };
  }

  const beforeArray = jsonArrayEntries(committed);
  const afterArray = jsonArrayEntries(current);
  const elementSet = beforeArray !== undefined && afterArray !== undefined;
  const before = elementSet ? beforeArray! : textEntries(pair.expected.text);
  const after = elementSet ? afterArray! : textEntries(pair.actual.text);
  return {
    added: minus(after, before),
    removed: minus(before, after),
    mode: elementSet ? 'element-set' : 'canonical-text',
    canonical: pair.expected.form,
    identical: pair.expected.text === pair.actual.text,
  };
}

/**
 * Does this diff fail under the rule's direction?
 *
 * `two-way` (the default) is deliberate: the historical failure of hand-rolled
 * ledgers is being one-directional, so a silent DELETION passes. Narrowing to
 * one direction must be an explicit, visible choice.
 */
export function baselineFails(rule: IBaselineRule, diff: IBaselineDiff): boolean {
  const direction = rule.direction ?? 'two-way';
  const gained = diff.added.length > 0;
  const lost = diff.removed.length > 0;
  // A pure-reordering change is not drift under keyed-set semantics, but under
  // canonical-text semantics an identical canonical form means no change at all.
  if (!gained && !lost && diff.identical) return false;
  if (direction === 'additions-only') return gained;
  if (direction === 'no-shrink') return lost;
  return gained || lost || !diff.identical;
}

/** Entry count for a side, matching the comparison mode. */
export function baselineCount(rule: IBaselineRule, text: string): number {
  if (rule.keyBy) return extractJsonPath(text, rule.keyBy).length;
  const asArray = jsonArrayEntries(text);
  if (asArray !== undefined) return asArray.length;
  const form = (rule.compute.canonical ?? 'auto') as CanonicalForm;
  const pair = canonicalizePair(text, text, form);
  return textEntries(pair.expected.text).length;
}

/** The verdict of a `mode: 'ceiling'` baseline: one measured number vs its limit. */
export interface ICeilingVerdict {
  readonly value: number;
  readonly ceiling: number;
  readonly direction: 'at-most' | 'at-least';
  readonly failed: boolean;
  /** Headroom left (`at-most`) or shortfall (`at-least`); negative when failing. */
  readonly slack: number;
}

/**
 * Measured value for a ceiling rule's computed text.
 *
 * A `command` compute whose stdout IS a number (`wc -l`, a bundle size, a
 * warning count) reports that number; anything else is measured by entry count,
 * the same way a ledger counts. Guessing wrong in either direction would make
 * the ratchet silently measure something other than what the author wrote, so
 * the rule is one line and stated here rather than inferred per call site.
 */
export function ceilingValue(rule: IBaselineRule, text: string): number {
  const trimmed = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return baselineCount(rule, text);
}

/**
 * Compare a measured value against the rule's declared ceiling.
 *
 * `at-most` is the default because the shape people hand-roll is almost always
 * a debt ratchet — "no more than N of X, and never more". A floor (`at-least`)
 * is the same engine with the comparison flipped, so a coverage ratchet does
 * not need a second gate.
 */
export function evaluateCeiling(rule: IBaselineRule, value: number): ICeilingVerdict {
  const ceiling = rule.ceiling ?? 0;
  const direction = rule.direction === 'at-least' ? 'at-least' : 'at-most';
  const slack = direction === 'at-most' ? ceiling - value : value - ceiling;
  return { value, ceiling, direction, failed: slack < 0, slack };
}
