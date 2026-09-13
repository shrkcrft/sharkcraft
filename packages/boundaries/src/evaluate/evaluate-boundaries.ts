import {
  UnitDeadCause,
  UnitDeadWeight,
  unitProblemsOf,
  type IUnitLiveness,
  type IUnitObservation,
  type IUnitStateLists,
  type IVerdictCoverage,
  type UnitLivenessState,
} from '@shrkcrft/core';
import type {
  BoundaryMatchKind,
  BoundarySeverity,
  ForbiddenMatchMode,
  IBoundaryRule,
  IBoundaryRuleException,
  IBoundaryScopeExemption,
} from '../model/boundary-rule.ts';
import { BoundaryMarkableList } from '../model/boundary-markable-list.ts';
import {
  boundaryForbiddenMatch,
  boundaryPatternOverlaps,
  boundaryRuleScope,
  boundaryRuleSeverity,
  boundaryScopeDecision,
} from '../model/boundary-rule-scope.ts';
import { normalizeBoundaryRule } from '../model/normalize-boundary-rule.ts';
import { globToRegex, matchesAny } from '../scan/glob.ts';
import {
  couldMatchPackageName,
  importPatternDefect,
  LEADING_WILDCARD_NEVER_DEAD,
  matchImportPattern,
  RELATIVE_PATTERN_NEVER_DEAD,
} from '../scan/import-pattern.ts';
import type { IImportEdge, IImportScanResult } from '../scan/scan-imports.ts';
import {
  resolveAliasCandidates,
  type ITsconfigPathsMap,
} from '../scan/tsconfig-aliases.ts';
import { settleBoundaryRule } from './settle-boundary-rule.ts';
import { withBoundaryRuleSettlement } from './with-boundary-rule-settlement.ts';

export interface IBoundaryViolation {
  ruleId: string;
  ruleTitle: string;
  severity: BoundarySeverity;
  file: string;
  importSpecifier: string;
  line: number;
  /** Pattern from `from` that matched the file. */
  matchedFrom: string;
  /** Pattern from `forbiddenImports` that matched the specifier, if any. */
  matchedForbidden?: string;
  /**
   * `subpath` when only the package semantics reached the specifier (a deeper
   * import of a package the pattern names — round 11, 1.5), `exact` otherwise.
   */
  matchKind?: BoundaryMatchKind;
  /** When triggered by allowedImports = [..] (none matched). */
  notAllowed?: boolean;
  /** When the match came from an alias-resolved candidate path. */
  resolvedVia?: string;
  message: string;
  suggestedFix?: string;
}

export interface IEvaluateOptions {
  /** Optional filter: only evaluate rules with this id. */
  onlyRuleId?: string;
  /**
   * Optional tsconfig paths map. When supplied, every edge specifier is also
   * resolved against the alias map and the resulting candidate paths are
   * matched against rule patterns alongside the original specifier.
   */
  tsconfigPaths?: ITsconfigPathsMap;
  /**
   * Package names the workspace knows (dependencies, workspace package names,
   * node builtins). A forbidden pattern naming one is RESOLVABLE even when
   * nothing imports it today — a deliberate "never adopt X" guard is not a
   * dead unit. The orchestrator supplies this; the evaluator stays pure.
   */
  knownPackages?: readonly string[];
}

/** A rule's outcome: `skipped` = its scope matched no governed file (it enforced nothing). */
export type BoundaryRuleStatus = 'passed' | 'failed' | 'skipped';

/**
 * One selector unit that matches nothing (round 11, 1.3) — a scope glob gone
 * dead after a rename, a forbidden pattern that can never match (a typo, a
 * retired package, or a target that does not exist yet), an exemption that
 * exempts nothing. The rule around it can keep reporting "evaluated" while the
 * unit silently stopped enforcing; this is the per-unit signal. The same shape
 * as the other planes' dead units.
 *
 * Round 13: an UNMARKED unit only — the settled `.dead` of `settleBoundaryRule`.
 * A unit marked `{ pattern, expectEmpty: true }` whose target does not exist is
 * intended-empty (accepted and printed), one whose target exists went live; it
 * is never here.
 */
export interface IBoundaryDeadUnit {
  readonly ruleId: string;
  readonly unit: 'from' | 'forbidden' | 'allowed' | 'exemptFiles';
  readonly selector: string;
  /**
   * THE per-unit sentence (`formatUnitLiveness`, `@shrkcrft/core`) without the
   * selector: what was observed, then — for a unit that simply matches nothing —
   * `DEAD_SELECTOR_CAUSES` (typo, retired target, or a target that does not
   * exist yet).
   */
  readonly reason: string;
  /**
   * Set when the unit is dead by its SHAPE alone (round 12): `defect` — an
   * `importPatternDefect` (a `!`, an empty pattern, a trailing `/` under
   * package semantics); `shadowed` — an `allowedImports` entry a forbidden
   * sibling covers, so it can never admit an import. Proved without reading a
   * file, so no unread file can refute it, and never markable. Unset for
   * "matches nothing".
   */
  readonly cause?: UnitDeadCause;
}

/**
 * A violation the rule MARKED rather than reported — an exempt file, or an
 * adjudicated exception. Counted and listed, never silently dropped: a
 * silently-dropped exemption is indistinguishable from a stale glob.
 */
export interface IBoundarySuppressedViolation {
  readonly violation: IBoundaryViolation;
  readonly reason: 'exempt-file' | 'exception';
  /** The exemption glob, for `exempt-file`. */
  readonly glob?: string;
  /** The exception that allowed the edge, for `exception`. */
  readonly exception?: IBoundaryRuleException;
}

/**
 * An exception that suppressed NO real edge in this run. It fails the run: an
 * exception list that cannot rot loudly rots into permanent silent width.
 */
export interface IBoundaryStaleException {
  readonly ruleId: string;
  /** Position in the rule's `exceptions[]`. */
  readonly index: number;
  readonly exception: IBoundaryRuleException;
  readonly severity: 'error';
  readonly message: string;
}

/** Files one glob matched. */
export interface IBoundaryGlobCount {
  readonly glob: string;
  /** Governed (non-exempt) files the glob matched. */
  readonly files: number;
  /** The settled state of the glob as a selector unit (round 13): live, dead, intended-empty, went-live, unproven. */
  readonly state?: UnitLivenessState;
}

/** What one forbidden pattern hit, in scope and anywhere. */
export interface IBoundaryPatternCount {
  readonly pattern: string;
  /** Violations it produced in this rule's governed files. */
  readonly hitsInScope: number;
  /** Distinct specifiers (literal or alias-resolved) it matches anywhere in the scan. */
  readonly hitsAnywhere: number;
  /** Can it ever match? (a hit anywhere, a known package, an alias, a file) */
  readonly resolvable: boolean;
  /** For `forbiddenMatch: 'exact'`: specifiers only the package semantics would have reached. */
  readonly subpathHitsAnywhere?: number;
  /**
   * A sibling forbidden pattern of the same rule that already covers every
   * import this one matches (`@scope/pkg/**` next to `@scope/pkg` under package
   * semantics) — redundant, safe to delete. INFO: never a dead unit, never a
   * verdict change (round 12, R12-5.6; from `boundaryPatternOverlaps`).
   */
  readonly subsumedBy?: string;
  /** The settled state of the pattern as a selector unit (round 13). */
  readonly state?: UnitLivenessState;
}

/** Per-rule coverage: what each unit of the rule actually matched. */
export interface IBoundaryRuleCoverage {
  readonly ruleId: string;
  readonly severity: BoundarySeverity;
  readonly status: BoundaryRuleStatus;
  /** Why the rule checked nothing, when `skipped`. */
  readonly skipReason?: string;
  /** A skip that FAILS the run (`failOnEmpty`, on by default for `error` rules). */
  readonly failedOnEmpty?: boolean;
  /**
   * The rule settled IntendedEmpty (round 13, core `settleRuleEmptiness`):
   * every `from` inclusion is marked `expectEmpty` and it matched no file — it
   * examined 0 files, so it is ACCEPTED (its coverage is the acceptance), never
   * counted as evaluated (`rulesEvaluated`, `boundaryRulesEvaluated`).
   */
  readonly acceptedAsIntendedEmpty?: true;
  /** Governed files: inside `from`, not exempt. */
  readonly filesInScope: number;
  /** Inside `from` but exempt — scanned, violations suppressed. */
  readonly exemptFilesInScope: number;
  /** Import edges read from governed files. */
  readonly edgesInScope: number;
  /** Unsuppressed violations. */
  readonly violations: number;
  readonly suppressed: number;
  readonly fromGlobs: readonly IBoundaryGlobCount[];
  readonly forbidden: readonly IBoundaryPatternCount[];
  /**
   * `shadowedBy`: a forbidden pattern of the same rule covering every import
   * this allowance matches — forbidden is checked first, so it can never admit
   * one (its dead unit carries `cause: 'shadowed'`; round 12, R12-5.3).
   */
  readonly allowed: readonly {
    readonly pattern: string;
    readonly hitsAnywhere: number;
    readonly shadowedBy?: string;
    readonly state?: UnitLivenessState;
  }[];
  readonly exemptions: readonly (IBoundaryScopeExemption & {
    readonly files: number;
    readonly state?: UnitLivenessState;
  })[];
  readonly exceptions: readonly (IBoundaryRuleException & { readonly matched: number })[];
  readonly deadUnits: readonly IBoundaryDeadUnit[];
  /**
   * Every judged selector unit, settled (round 13): the observation, its state
   * and its one sentence. The orchestrator's unread re-settle reads it, and
   * `--fail-on-dead-units` judges each unit through core's `selectorUnitFails`.
   */
  readonly unitLiveness?: readonly IUnitLiveness[];
  /**
   * The verdict coverage the gate envelope settles on: scope globs that reached
   * a governed file, of the scope globs the rule JUDGES (a marked intended-empty
   * glob is accepted by {@link unitAcceptance}, not judged) — for a rule whose
   * every `from` inclusion is intended-empty and that matched no file, the
   * acceptance itself. Engine-owned, like the wiring and policy planes' — a
   * surface reads it, never recomputes it.
   */
  readonly coverage: IVerdictCoverage;
  /**
   * Settle record B (round 13): the rule's intended-empty units,
   * `acceptedBy: 'expectEmpty'`. Folded beside {@link coverage} into the ONE
   * verdict settle (`ruleVerdictRecords`), so it prints `accepted by
   * expectEmpty: …` at exit 0 and can never cover a dead unit.
   */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live unit lines (`unitStateLists`), when it has any. */
  readonly units?: IUnitStateLists;
}

export interface IEvaluateResult {
  /** Rules selected for evaluation (after `onlyRuleId`). */
  rulesConfigured: number;
  /**
   * Rules that examined at least one governed file — never a skipped rule, and
   * never one accepted as intended-empty (it examined 0 files; round 13 —
   * counted in {@link rulesAcceptedEmpty} instead).
   */
  rulesEvaluated: number;
  /**
   * Rules accepted as intended-empty (round 13): every `from` inclusion marked
   * `expectEmpty`, no file matched — `acceptedAsIntendedEmpty` on its coverage.
   * Printed apart from the evaluated count (`N evaluated, M accepted as
   * intended-empty`).
   */
  rulesAcceptedEmpty: number;
  edgesEvaluated: number;
  /** Source files the scopes were counted against. */
  filesScanned: number;
  /**
   * Where that file list came from: the scan's own `files` (every scanned
   * file), or — for a hand-built scan without one — the files that appear in
   * `edges`, which cannot see import-free files.
   */
  fileUniverse: 'scan' | 'edges';
  violations: IBoundaryViolation[];
  /** Quick counts grouped by severity (unsuppressed violations only). */
  counts: { error: number; warning: number; info: number };
  suppressed: IBoundarySuppressedViolation[];
  suppressedCounts: { exemptFile: number; exception: number };
  staleExceptions: IBoundaryStaleException[];
  coverage: IBoundaryRuleCoverage[];
  skipped: { ruleId: string; reason: string; severity: BoundarySeverity; failed: boolean }[];
  deadUnits: IBoundaryDeadUnit[];
  /**
   * Rules the engine entry could not normalise (round 13) — a hand-built rule
   * with a malformed `expectEmpty` marker, which every loader refuses first.
   * Never evaluated and never a crash: each is a skipped rule that fails the run.
   */
  invalidRules?: { ruleId: string; problems: readonly string[] }[];
}

/** The skip reason an unnormalisable rule carries — the loaders' errored-rule words. */
const NOT_EVALUATED = 'failed validation — NOT evaluated';

/**
 * Evaluate every rule against every scanned edge. Returns the list of
 * violations + counts, and — round 11 — what every rule and every selector
 * unit actually matched, so a rule that enforced nothing can never read as
 * evaluated. Pure function — no I/O.
 *
 * Round 13: each rule is normalised IDEMPOTENTLY at entry
 * (`normalizeBoundaryRule` — a loaded rule comes back unchanged), so a
 * hand-built rule with a `{ pattern, expectEmpty: true }` entry is honoured,
 * never a `pattern.includes is not a function` crash; and every rule's units
 * and emptiness settle through the ONE boundary settle (`settleBoundaryRule`).
 */
export function evaluateBoundaries(
  scan: IImportScanResult,
  rules: readonly IBoundaryRule[],
  options: IEvaluateOptions = {},
): IEvaluateResult {
  const selected = options.onlyRuleId
    ? rules.filter((r) => r.id === options.onlyRuleId)
    : rules;

  const fileUniverse: 'scan' | 'edges' = scan.files ? 'scan' : 'edges';
  const files: readonly string[] = scan.files ?? [...new Set(scan.edges.map((e) => e.from))];
  const edgesByFile = new Map<string, IImportEdge[]>();
  for (const e of scan.edges) {
    const list = edgesByFile.get(e.from);
    if (list) list.push(e);
    else edgesByFile.set(e.from, [e]);
  }

  // Literal specifier + tsconfig alias resolutions, computed once per specifier.
  const candidateCache = new Map<string, readonly string[]>();
  const candidatesOf = (specifier: string): readonly string[] => {
    const hit = candidateCache.get(specifier);
    if (hit) return hit;
    const out: string[] = [specifier];
    if (options.tsconfigPaths) {
      for (const resolved of resolveAliasCandidates(specifier, options.tsconfigPaths)) out.push(resolved);
    }
    candidateCache.set(specifier, out);
    return out;
  };
  const distinctSpecifiers = [...new Set(scan.edges.map((e) => e.importSpecifier))];
  const anywhere = new PatternReach(distinctSpecifiers, candidatesOf, files, options);

  const violations: IBoundaryViolation[] = [];
  const suppressed: IBoundarySuppressedViolation[] = [];
  const staleExceptions: IBoundaryStaleException[] = [];
  const coverage: IBoundaryRuleCoverage[] = [];
  const invalidRules: { ruleId: string; problems: readonly string[] }[] = [];

  for (const input of selected) {
    const normalized = normalizeBoundaryRule(input);
    if (!normalized.ok) {
      const problems = unitProblemsOf(normalized.error);
      const ruleId = typeof input.id === 'string' ? input.id : '(no id)';
      invalidRules.push({ ruleId, problems });
      coverage.push({
        ruleId,
        severity: boundaryRuleSeverity(input),
        status: 'skipped',
        skipReason: `${NOT_EVALUATED}: ${problems.join('; ')}`,
        failedOnEmpty: true,
        filesInScope: 0,
        exemptFilesInScope: 0,
        edgesInScope: 0,
        violations: 0,
        suppressed: 0,
        fromGlobs: [],
        forbidden: [],
        allowed: [],
        exemptions: [],
        exceptions: [],
        deadUnits: [],
        coverage: { unit: 'rules', expected: 1, examined: 0, reason: NOT_EVALUATED },
      });
      continue;
    }
    const rule = normalized.value;
    const scope = boundaryRuleScope(rule);
    const mode = boundaryForbiddenMatch(rule);
    const severity = boundaryRuleSeverity(rule);
    const forbiddenPatterns = rule.forbiddenImports ?? [];
    const allowedPatterns = rule.allowedImports ?? [];
    const exceptions = rule.exceptions ?? [];

    const governedPerGlob = new Map<string, number>(scope.include.map((g) => [g, 0]));
    const anyPerGlob = new Map<string, number>(scope.include.map((g) => [g, 0]));
    const exemptPerIndex = scope.exemptions.map(() => 0);
    const hitsInScope = new Map<string, number>(forbiddenPatterns.map((p) => [p, 0]));
    const exceptionMatched = exceptions.map(() => 0);
    let filesInScope = 0;
    let exemptFilesInScope = 0;
    let edgesInScope = 0;
    let ruleViolations = 0;
    let ruleSuppressed = 0;

    for (const file of files) {
      // THE scope decision — the same function why-file, the rule-graph bridge
      // and every other reader call, so none of them can disagree with this.
      const decision = boundaryScopeDecision(scope, file);
      if (decision === 'out') continue;
      const matchedInclude = scope.include.filter((g) => globToRegex(g).test(file));
      for (const g of matchedInclude) anyPerGlob.set(g, (anyPerGlob.get(g) ?? 0) + 1);
      let exemptGlob: string | undefined;
      if (decision === 'exempt') {
        exemptFilesInScope += 1;
        scope.exemptions.forEach((e, i) => {
          if (globToRegex(e.glob).test(file)) {
            exemptPerIndex[i] = (exemptPerIndex[i] ?? 0) + 1;
            exemptGlob ??= e.glob;
          }
        });
      } else {
        filesInScope += 1;
        for (const g of matchedInclude) governedPerGlob.set(g, (governedPerGlob.get(g) ?? 0) + 1);
      }
      const matchedFrom = matchedInclude[0] ?? scope.include[0] ?? '';

      for (const edge of edgesByFile.get(file) ?? []) {
        if (decision === 'in') edgesInScope += 1;
        const specifiers = candidatesOf(edge.importSpecifier);
        let violation: IBoundaryViolation | undefined;

        // Forbidden imports — the first candidate any pattern reaches wins.
        for (const spec of specifiers) {
          let hit: { pattern: string; kind: BoundaryMatchKind } | undefined;
          for (const p of forbiddenPatterns) {
            const kind = matchImportPattern(spec, p, mode);
            if (kind) {
              hit = { pattern: p, kind };
              break;
            }
          }
          if (hit) {
            violation = violationFor(rule, severity, edge, matchedFrom, hit.pattern, hit.kind);
            if (spec !== edge.importSpecifier) violation.resolvedVia = spec;
            if (decision === 'in') hitsInScope.set(hit.pattern, (hitsInScope.get(hit.pattern) ?? 0) + 1);
            break;
          }
        }

        // Allowed imports — when set, anything NOT matching (any candidate) is
        // a violation. Exact glob semantics: an allow-list is never widened.
        if (!violation && allowedPatterns.length > 0) {
          const matchedAllowed = specifiers.some((s) => matchesAny(s, allowedPatterns));
          if (!matchedAllowed && !edge.importSpecifier.startsWith('.')) {
            violation = { ...violationFor(rule, severity, edge, matchedFrom, undefined, undefined), notAllowed: true };
          }
        }
        if (!violation) continue;

        if (decision === 'exempt') {
          suppressed.push({ violation, reason: 'exempt-file', ...(exemptGlob ? { glob: exemptGlob } : {}) });
          ruleSuppressed += 1;
          continue;
        }
        // Credit EVERY exception whose (path, target) matches this edge, and
        // suppress the violation once (attributed to the first). Crediting
        // only the first made an overlapping exception — an area-wide one next
        // to a file-level one for the same edge — read as STALE (exit 1) while
        // it matched a real edge. Only an exception matching no violating edge
        // at all is stale.
        let exceptionIndex = -1;
        exceptions.forEach((ex, idx) => {
          if (!matchesAny(edge.from, [ex.path])) return;
          if (!specifiers.some((s) => matchImportPattern(s, ex.target, mode) !== null)) return;
          exceptionMatched[idx] = (exceptionMatched[idx] ?? 0) + 1;
          if (exceptionIndex < 0) exceptionIndex = idx;
        });
        if (exceptionIndex >= 0) {
          suppressed.push({ violation, reason: 'exception', exception: exceptions[exceptionIndex]! });
          ruleSuppressed += 1;
          continue;
        }
        violations.push(violation);
        ruleViolations += 1;
      }
    }

    // ── selector units: OBSERVE, then settle through the one boundary settle ──
    // Each unit reports two facts (round 13): whether its target EXISTS at all
    // (raw — before exemptions and effectiveness), which decides a MARKED unit
    // (intended-empty or went-live); and whether it is LIVE (the dead predicate
    // this plane has always used, negated), which decides an unmarked one.
    const includedAny = filesInScope + exemptFilesInScope;
    const marked = new Set((rule.expectEmptyUnits ?? []).map((m) => `${m.list} ${m.unit}`));
    const observations: IUnitObservation[] = [];
    for (const g of scope.include) {
      const any = anyPerGlob.get(g) ?? 0;
      const governed = governedPerGlob.get(g) ?? 0;
      observations.push({
        list: BoundaryMarkableList.From,
        unit: g,
        label: g,
        weight: UnitDeadWeight.Coverage,
        exists: any > 0,
        live: governed > 0,
        matched: any,
        liveBecause: governed > 0 ? `it governs ${governed} scanned file(s)` : `it matches ${any} scanned file(s)`,
        deadReason: any > 0 ? `matches only exempt files (${any})` : `matched 0 of ${files.length} scanned files`,
      });
    }
    scope.exemptions.forEach((e, i) => {
      // The `excludeTests` shorthand is allowed to be vacuous (a repo with no
      // tests yet). An exemption of a rule whose from globs match nothing
      // exempts nothing by construction, so it is judged only when marked —
      // a marker is never left unobserved.
      if (e.origin === 'excludeTests') return;
      const list = e.origin === 'from-negation' ? BoundaryMarkableList.From : BoundaryMarkableList.ExemptFiles;
      const unit = e.origin === 'from-negation' ? `!${e.glob}` : e.glob;
      if (includedAny === 0 && !marked.has(`${list} ${unit}`)) return;
      const n = exemptPerIndex[i] ?? 0;
      observations.push({
        list,
        unit,
        label: unit,
        exists: n > 0,
        live: n > 0,
        matched: n,
        liveBecause: `it exempts ${n} file(s)`,
        deadReason:
          includedAny > 0
            ? `exempts none of the ${includedAny} file(s) the rule's from globs match`
            : "exempts nothing — the rule's from globs match no file",
      });
    });
    // Patterns that can never change the verdict — the one static answer
    // `boundaries explain` and MCP `get_boundary_rule` print too.
    const overlaps = boundaryPatternOverlaps(rule);
    const subsumedBy = new Map(overlaps.redundantForbidden.map((o) => [o.index, o.by]));
    const shadowedBy = new Map(overlaps.shadowedAllowed.map((o) => [o.index, o.by]));
    const forbiddenCounts: IBoundaryPatternCount[] = forbiddenPatterns.map((p, i) => {
      const reach = anywhere.forbidden(p, mode);
      const resolvedBy = reach.hits > 0 ? undefined : anywhere.resolvedBy(p, mode);
      const resolvable = reach.hits > 0 || resolvedBy !== undefined;
      // A malformed pattern says WHY (the validator rejects it at load; a
      // hand-built rule reaches here) — never the "typo, retired target" causes.
      const defect = resolvable ? undefined : importPatternDefect(p, mode);
      const subpathNote =
        mode === 'exact' && reach.subpathHits > 0
          ? ` — ${reach.subpathHits} subpath import(s) of it exist; forbiddenMatch: 'exact' excludes them`
          : '';
      observations.push({
        list: BoundaryMarkableList.ForbiddenImports,
        unit: p,
        label: p,
        exists: resolvable,
        live: resolvable,
        matched: reach.hits,
        liveBecause: reach.hits > 0 ? `${reach.hits} import(s) match it` : `no import yet, but ${resolvedBy ?? 'it resolves'}`,
        deadReason:
          defect ??
          `matches no import anywhere in the repo, no workspace/dependency package name, no tsconfig alias and no file${subpathNote}`,
        ...(defect !== undefined ? { cause: UnitDeadCause.Defect } : {}),
      });
      const coveredBy = subsumedBy.get(i);
      return {
        pattern: p,
        hitsInScope: hitsInScope.get(p) ?? 0,
        hitsAnywhere: reach.hits,
        resolvable,
        ...(mode === 'exact' ? { subpathHitsAnywhere: reach.subpathHits } : {}),
        ...(coveredBy !== undefined ? { subsumedBy: coveredBy } : {}),
      };
    });
    const allowedCounts = allowedPatterns.map((p, i) => {
      const hits = anywhere.allowed(p);
      const shadow = shadowedBy.get(i);
      if (shadow !== undefined) {
        // Forbidden is checked first and allowed never re-admits: an allowance
        // a forbidden pattern covers can never admit anything — the carve-out
        // under a bare forbidden package that package semantics made inert.
        observations.push({
          list: BoundaryMarkableList.AllowedImports,
          unit: p,
          label: p,
          exists: hits > 0,
          live: false,
          matched: hits,
          deadReason:
            `shadowed by forbidden '${shadow}' — forbiddenImports is checked first` +
            (mode === 'package' ? ` and '${shadow}' covers every subpath (package semantics)` : '') +
            `, so this allowance can never admit an import; carve the subpath out with exceptions[{ path, target: '${p}', reason }]` +
            (mode === 'package' ? " or set forbiddenMatch: 'exact'" : ''),
          cause: UnitDeadCause.Shadowed,
        });
      } else {
        const resolvedBy = hits > 0 ? undefined : anywhere.resolvedBy(p, 'exact');
        const resolvable = hits > 0 || resolvedBy !== undefined;
        const defect = resolvable ? undefined : importPatternDefect(p, 'exact');
        observations.push({
          list: BoundaryMarkableList.AllowedImports,
          unit: p,
          label: p,
          exists: resolvable,
          live: resolvable,
          matched: hits,
          liveBecause: hits > 0 ? `${hits} import(s) match it` : `no import yet, but ${resolvedBy ?? 'it resolves'}`,
          deadReason:
            defect ??
            'matches no import anywhere in the repo, no workspace/dependency package name, no tsconfig alias and no file',
          ...(defect !== undefined ? { cause: UnitDeadCause.Defect } : {}),
        });
      }
      return { pattern: p, hitsAnywhere: hits, ...(shadow !== undefined ? { shadowedBy: shadow } : {}) };
    });

    // ── stale exceptions ──────────────────────────────────────────────────
    exceptions.forEach((ex, index) => {
      if ((exceptionMatched[index] ?? 0) > 0) return;
      staleExceptions.push({
        ruleId: rule.id,
        index,
        exception: ex,
        severity: 'error',
        message: `exception ${index} of ${rule.id} (path ${ex.path} → target ${ex.target}; reason: ${ex.reason}) no longer matches any violating edge — delete it, or the rule it narrows is not what you think`,
      });
    });

    // ── status + coverage: THE boundary settle ────────────────────────────
    const settlement = settleBoundaryRule({
      rule,
      observations,
      includeGlobs: scope.include,
      filesScanned: files.length,
      fileUniverse,
      filesInScope,
      exemptFilesInScope,
      violations: ruleViolations,
      unread: false,
    });
    coverage.push(
      withBoundaryRuleSettlement(
        {
          ruleId: rule.id,
          severity,
          filesInScope,
          exemptFilesInScope,
          edgesInScope,
          violations: ruleViolations,
          suppressed: ruleSuppressed,
          fromGlobs: scope.include.map((g) => ({ glob: g, files: governedPerGlob.get(g) ?? 0 })),
          forbidden: forbiddenCounts,
          allowed: allowedCounts,
          exemptions: scope.exemptions.map((e, i) => ({ ...e, files: exemptPerIndex[i] ?? 0 })),
          exceptions: exceptions.map((ex, i) => ({ ...ex, matched: exceptionMatched[i] ?? 0 })),
        },
        settlement,
      ),
    );
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const v of violations) counts[v.severity] += 1;
  // Every rule's settled dead list, in rule order — read, never re-derived.
  const deadUnits = coverage.flatMap((c) => c.deadUnits);
  return {
    rulesConfigured: selected.length,
    rulesEvaluated: coverage.filter((c) => c.status !== 'skipped' && c.acceptedAsIntendedEmpty !== true).length,
    rulesAcceptedEmpty: coverage.filter((c) => c.acceptedAsIntendedEmpty === true).length,
    edgesEvaluated: scan.edges.length,
    filesScanned: files.length,
    fileUniverse,
    violations,
    counts,
    suppressed,
    suppressedCounts: {
      exemptFile: suppressed.filter((s) => s.reason === 'exempt-file').length,
      exception: suppressed.filter((s) => s.reason === 'exception').length,
    },
    staleExceptions,
    coverage,
    skipped: coverage
      .filter((c) => c.status === 'skipped')
      .map((c) => ({
        ruleId: c.ruleId,
        reason: c.skipReason ?? 'checked nothing',
        severity: c.severity,
        failed: c.failedOnEmpty === true,
      })),
    deadUnits,
    ...(invalidRules.length > 0 ? { invalidRules } : {}),
  };
}

/**
 * "Could this pattern ever match?" — the whole-scan reach of a pattern,
 * memoised per (pattern, mode) because rule sets share patterns.
 *
 * 0 violations in scope is the NORMAL state of a healthy fence, so a pattern is
 * dead only when it resolves to nothing ANYWHERE: no import in the repo, no
 * workspace / dependency / builtin package name, no tsconfig alias, no file.
 */
class PatternReach {
  private readonly forbiddenCache = new Map<string, { hits: number; subpathHits: number }>();
  private readonly allowedCache = new Map<string, number>();
  private readonly resolveCache = new Map<string, string | undefined>();

  constructor(
    private readonly specifiers: readonly string[],
    private readonly candidatesOf: (specifier: string) => readonly string[],
    private readonly files: readonly string[],
    private readonly options: IEvaluateOptions,
  ) {}

  forbidden(pattern: string, mode: ForbiddenMatchMode): { hits: number; subpathHits: number } {
    const key = [mode, pattern].join(String.fromCharCode(0));
    const cached = this.forbiddenCache.get(key);
    if (cached) return cached;
    let hits = 0;
    let subpathHits = 0;
    for (const s of this.specifiers) {
      const candidates = this.candidatesOf(s);
      if (candidates.some((c) => matchImportPattern(c, pattern, mode) !== null)) {
        hits += 1;
      } else if (
        mode === 'exact' &&
        candidates.some((c) => matchImportPattern(c, pattern, 'package') === 'subpath')
      ) {
        subpathHits += 1;
      }
    }
    const out = { hits, subpathHits };
    this.forbiddenCache.set(key, out);
    return out;
  }

  allowed(pattern: string): number {
    const cached = this.allowedCache.get(pattern);
    if (cached !== undefined) return cached;
    let hits = 0;
    for (const s of this.specifiers) {
      if (this.candidatesOf(s).some((c) => matchesAny(c, [pattern]))) hits += 1;
    }
    this.allowedCache.set(pattern, hits);
    return hits;
  }

  /**
   * WHY the pattern is resolvable with no import of it today — a relative
   * target, a known package, an alias, a file — or `undefined` when nothing
   * names it. The went-live line quotes it (round 13), so a stale marker says
   * what made its target real.
   */
  resolvedBy(pattern: string, mode: ForbiddenMatchMode): string | undefined {
    const key = [mode, pattern].join(String.fromCharCode(0));
    if (this.resolveCache.has(key)) return this.resolveCache.get(key);
    let out: string | undefined;
    // A malformed pattern (`importPatternDefect`) cannot mean what it says —
    // never "resolvable" through a package name it merely spells
    // (`'@scope/pkg/'` used to read resolvable via the known `@scope/pkg`).
    if (importPatternDefect(pattern, mode) === undefined) {
      if (pattern.startsWith('.')) {
        // A relative pattern cannot be judged without an importing file — so
        // it is never reported dead, and a marker on it has nothing to wait for
        // (the rule validator refuses one: `importPatternNeverJudgedDead`).
        out = RELATIVE_PATTERN_NEVER_DEAD;
      } else {
        // Name a piece of EVIDENCE only when it is one: a known package the
        // pattern actually matches (or names a subpath / prefix of), an alias,
        // a file. A LEADING `*` "could match" every package name — the
        // permissive half of the dead predicate, never proof that the target
        // exists — so it is said as what it is, never as "'<builtin>' is a
        // known package" (round 13 review: `*-legacy` read "'_http_agent' is a
        // known package"). The resolvable/not answer is unchanged.
        const known = this.options.knownPackages ?? [];
        const leadingWildcard = pattern.startsWith('*');
        const pkg =
          known.find((k) => matchImportPattern(k, pattern, mode) !== null) ??
          (leadingWildcard ? undefined : known.find((k) => couldMatchPackageName(pattern, k, mode)));
        const alias =
          pkg === undefined
            ? [...(this.options.tsconfigPaths?.aliases.keys() ?? [])].find((aliasKey) =>
                aliasKey.endsWith('*')
                  ? pattern.startsWith(aliasKey.slice(0, -1)) ||
                    couldMatchPackageName(pattern, aliasKey.slice(0, -1) + 'x', mode)
                  : couldMatchPackageName(pattern, aliasKey, mode),
              )
            : undefined;
        const file =
          pkg === undefined && alias === undefined
            ? this.files.find((f) => matchImportPattern(f, pattern, 'package') !== null)
            : undefined;
        const wildcardOnly =
          pkg === undefined &&
          alias === undefined &&
          file === undefined &&
          leadingWildcard &&
          known.some((k) => couldMatchPackageName(pattern, k, mode));
        out =
          pkg !== undefined
            ? `'${pkg}' is a known package (a node builtin, a workspace package or a declared dependency)`
            : alias !== undefined
              ? `the tsconfig alias '${alias}' names it`
              : file !== undefined
                ? `the file '${file}' matches it`
                : wildcardOnly
                  ? LEADING_WILDCARD_NEVER_DEAD
                  : undefined;
      }
    }
    this.resolveCache.set(key, out);
    return out;
  }
}

function violationFor(
  rule: IBoundaryRule,
  severity: BoundarySeverity,
  edge: IImportEdge,
  matchedFrom: string,
  matchedForbidden: string | undefined,
  matchKind: BoundaryMatchKind | undefined,
): IBoundaryViolation {
  return {
    ruleId: rule.id,
    ruleTitle: rule.title,
    severity,
    file: edge.from,
    importSpecifier: edge.importSpecifier,
    line: edge.line,
    matchedFrom,
    ...(matchedForbidden ? { matchedForbidden } : {}),
    ...(matchKind ? { matchKind } : {}),
    message:
      rule.message ??
      (matchedForbidden
        ? `Forbidden import in ${edge.from}: "${edge.importSpecifier}" matched "${matchedForbidden}"${matchKind === 'subpath' ? ' (a subpath of the forbidden package)' : ''}`
        : `Import "${edge.importSpecifier}" not in allowed list for ${rule.id}`),
    ...(rule.suggestedFix ? { suggestedFix: rule.suggestedFix } : {}),
  };
}
