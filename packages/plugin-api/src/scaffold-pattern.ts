/**
 * Scaffold patterns let a pack express "if you see a file matching these
 * paths, suggest this template id with these variables." Inference uses them
 * to seed `infer templates` / `onboard --scaffold-templates` with high-
 * confidence candidates without re-implementing pattern matching locally.
 *
 * Scaffold patterns are read-only data — they cannot execute code, shell
 * commands, or run any pack-provided functions. The match step happens in
 * the inspector layer.
 *
 * Intended-empty `matchPaths` (round 13, docs/intended-empty.md): an entry may
 * be `{ pattern, expectEmpty: true, reason? }` — a path the pattern names
 * before any file lives there. The loader normalises it
 * ({@link normalizeScaffoldPattern}) into the plain glob plus an
 * `expectEmptyUnits` ledger; `scaffolds doctor` accepts it (printed) while
 * nothing matches and reports it as went-live once a file does. Needs engine
 * 0.1.0-alpha.31 or later.
 */

import {
  err,
  mergeUnitMarks,
  normalizeUnitList,
  ok,
  stampUnitMarks,
  type AppErrorImpl,
  type IUnitMark,
  type Result,
  type SelectorListEntry,
} from '@shrkcrft/core';
import {
  EXACT_SCAFFOLD_STRATEGY_NAMES,
  resolveScaffoldStrategy,
  SCAFFOLD_STRATEGY_SAMPLE,
} from './scaffold-strategy.ts';

/**
 * A single variable extraction strategy. Values are recognized strings — the
 * one table of what each yields lives in `scaffold-strategy.ts`.
 */
export type ScaffoldExtractionStrategy =
  | 'filename.kebab'
  | 'filename.pascal'
  | `filename.stripSuffix:${string}`
  | 'className'
  | `className.stripPrefix:${string}`
  | `className.stripSuffix:${string}`
  | 'functionName'
  | 'directoryName'
  | 'directoryName.kebab'
  | 'directoryName.pascal'
  | 'nearestPackageName';

export interface IScaffoldPatternVariable {
  /** Variable name as exposed to the template renderer (e.g. "name"). */
  name: string;
  /** Where the value should come from. */
  from: ScaffoldExtractionStrategy;
  /** Optional human description of what this variable represents. */
  description?: string;
}

export interface IScaffoldPattern {
  /** Stable id, e.g. "myproj.service-pattern". */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** What this pattern detects and where it points. */
  description: string;
  /** Glob-like include patterns relative to the project root. */
  matchPaths: readonly string[];
  /** Optional exclude patterns. */
  excludePaths?: readonly string[];
  /** Template id this pattern suggests when matched. */
  templateId: string;
  /** Variable extraction strategies. */
  variables: readonly IScaffoldPatternVariable[];
  /** Lifecycle hooks where this pattern is consulted. */
  appliesWhen: readonly ('onboard' | 'infer-template' | string)[];
  /** Confidence floor when matched. */
  confidence: 'high' | 'medium' | 'low';
  /** Free-form tags for grouping. */
  tags?: readonly string[];
  /** Optional notes shown in pack doctor / scaffolds list. */
  notes?: readonly string[];
  /**
   * Optional evidence the inspector should check before accepting the match
   * (e.g. "the file exports an interface starting with I"). Strings only —
   * the actual checks are inspector-side.
   */
  requiredEvidence?: readonly string[];
  /**
   * LOADED patterns only (round 13): the `matchPaths` entries marked
   * `expectEmpty` (`list` = `matchPaths`), stamped with the contributing pack by
   * the loader. Derived — an author never writes it (the loader refuses the
   * key); write a `{ pattern, expectEmpty: true }` entry instead.
   */
  expectEmptyUnits?: readonly IUnitMark[];
}

/**
 * An AUTHORED scaffold pattern: {@link IScaffoldPattern} with markable
 * `matchPaths` (round 13).
 */
export interface IScaffoldPatternInput extends Omit<IScaffoldPattern, 'matchPaths' | 'expectEmptyUnits'> {
  /** Glob-like include patterns — any entry may be a `{ pattern, expectEmpty: true, reason? }` marker. */
  matchPaths: readonly SelectorListEntry[];
}

/** Author one scaffold pattern (markers allowed in `matchPaths`); returns it unchanged. */
export function defineScaffoldPattern<T extends IScaffoldPatternInput>(pattern: T): T {
  return pattern;
}

/** Helper used by pack authors to ship an array of scaffold patterns. */
export function defineScaffoldPatterns<T extends IScaffoldPatternInput>(patterns: readonly T[]): readonly T[] {
  return patterns;
}

/**
 * THE loaded shape of an accepted pattern (round 13): `matchPaths` as plain
 * globs — what every matcher consumes — plus the `expectEmptyUnits` ledger of
 * the marked entries, stamped with `packageName` (the contributing pack;
 * `undefined` for a local pattern). Idempotent: a loaded pattern keeps its
 * ledger. Refused (`CONFIG_INVALID`, problems in `details.problems`) only for
 * a `matchPaths` the core parser refuses — the loader's acceptance predicate
 * refuses that pattern first.
 */
export function normalizeScaffoldPattern(
  input: IScaffoldPatternInput | IScaffoldPattern,
  packageName?: string,
): Result<IScaffoldPattern, AppErrorImpl> {
  const n = normalizeUnitList(Array.isArray(input.matchPaths) ? input.matchPaths : [], 'matchPaths');
  if (!n.ok) return err(n.error);
  const marks = stampUnitMarks(mergeUnitMarks((input as IScaffoldPattern).expectEmptyUnits, n.value.marks), packageName);
  const { expectEmptyUnits: _previous, ...rest } = input as IScaffoldPattern;
  return ok({ ...rest, matchPaths: n.value.units, ...(marks.length > 0 ? { expectEmptyUnits: marks } : {}) });
}

/**
 * The exactly-named strategies (kept for back-compat). Derived from the one
 * strategy table, so it can never disagree with what the extractor implements;
 * the parameterised forms (`className.stripPrefix:<P>`, `…stripSuffix:<S>`)
 * are recognised by {@link isRecognizedScaffoldStrategy}.
 */
export const RECOGNIZED_SCAFFOLD_STRATEGIES: ReadonlySet<string> = new Set(EXACT_SCAFFOLD_STRATEGY_NAMES);

/** True iff the strategy table implements `s` — the same answer the extractor gives. */
export function isRecognizedScaffoldStrategy(s: string): boolean {
  return resolveScaffoldStrategy(s, SCAFFOLD_STRATEGY_SAMPLE).recognized;
}
