/**
 * Scaffold pattern registry + loader.
 *
 * Resolves scaffold patterns from packs (and the local config when supplied)
 * into a single in-memory list. Patterns are data; this module never executes
 * shell commands or evaluates pack code beyond a dynamic import.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  DEAD_SELECTOR_CAUSES,
  importModuleViaLoader,
  MARKABLE_UNIT_LISTS,
  MarkableUnitList,
  mergeUnitMarks,
  normalizeUnitList,
  qualifyListPath,
  qualifyUnitMarks,
  RejectionCause,
  settleUnitLiveness,
  stampUnitMarks,
  UnitDeadWeight,
  UnitLivenessState,
  unitListProblems,
  unitProblemsOf,
  type IRejectedEntry,
  type ISettledUnitLiveness,
  type IUnitMark,
  type IUnitObservation,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import {
  isRecognizedScaffoldStrategy,
  normalizeScaffoldPattern,
  resolveScaffoldStrategy,
  type IScaffoldPattern,
  type IScaffoldPatternInput,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection, ISourceInfo } from './sharkcraft-inspector.ts';

export interface IScaffoldPatternWithSource {
  pattern: IScaffoldPattern;
  source: ISourceInfo;
}

export interface IScaffoldPatternsLoadResult {
  patterns: IScaffoldPatternWithSource[];
  /** FILE-level problems (missing, not an array, failed to import). */
  warnings: string[];
  /**
   * Every declared pattern the loader refused — invalid or a duplicate id —
   * with its position and every reason (round 12, 12.1). These used to be
   * unstructured warning strings the self-config doctor discarded.
   */
  rejected: IRejectedEntry[];
}

/** THE closed set of a pattern's `confidence` — the loader and the doctor read one set. */
const SCAFFOLD_CONFIDENCES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

/**
 * THE scaffold-pattern acceptance predicate (round 12, 12.1 / 12.1d): `id`,
 * `templateId`, a non-empty `matchPaths` and a `confidence` from the closed
 * set — `[]` means accepted. `confidence` was checked only by `scaffolds
 * doctor`, so a pattern without one was ACCEPTED and `scaffolds list` crashed
 * on it (`p.pattern.confidence.padEnd`).
 */
export function scaffoldPatternRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const p = raw as Record<string, unknown>;
  const out: string[] = [];
  if (typeof p.id !== 'string' || p.id.length === 0) out.push('id: must be a non-empty string');
  if (typeof p.templateId !== 'string' || p.templateId.length === 0) {
    out.push('templateId: must be a non-empty string');
  }
  if (!Array.isArray(p.matchPaths) || p.matchPaths.length === 0) {
    out.push('matchPaths: must be a non-empty array');
  } else {
    // Round 13: each entry is a glob string or a well-formed
    // `{ pattern, expectEmpty: true, reason? }` marker — THE core parser's
    // problems, one per bad entry. An object used to load as the glob
    // `[object Object]` (matching nothing, silently).
    out.push(...unitListProblems(p.matchPaths, MATCH_PATHS));
  }
  if ('expectEmptyUnits' in p) {
    out.push(`expectEmptyUnits: derived by the loader — mark the entry itself: matchPaths: [{ pattern, expectEmpty: true }]`);
  }
  if (typeof p.confidence !== 'string' || !SCAFFOLD_CONFIDENCES.has(p.confidence)) {
    out.push(`confidence: must be high|medium|low (got "${String(p.confidence)}")`);
  }
  return out;
}

/** THE list path of `matchPaths` — the loader's marks and the doctor's observations share it. */
const MATCH_PATHS = MARKABLE_UNIT_LISTS[MarkableUnitList.ScaffoldPatternMatchPaths].listPath;

/**
 * A pattern's `matchPaths` as plain globs plus its marker ledger — idempotent,
 * so a hand-built pattern that still carries `{ pattern, expectEmpty }` entries
 * is read by its units instead of as the glob `[object Object]`.
 */
function patternUnits(p: IScaffoldPattern): { readonly units: readonly string[]; readonly marks: readonly IUnitMark[] } {
  const list: readonly unknown[] = Array.isArray(p.matchPaths) ? p.matchPaths : [];
  const n = normalizeUnitList(list, MATCH_PATHS);
  return n.ok
    ? { units: n.value.units, marks: mergeUnitMarks(p.expectEmptyUnits, n.value.marks) }
    : { units: list.filter((g): g is string => typeof g === 'string'), marks: p.expectEmptyUnits ?? [] };
}

export async function loadScaffoldPatternsFromFile(
  file: string,
): Promise<{
  patterns: IScaffoldPattern[];
  /** Each accepted pattern's position in the file's array (parallel to `patterns`). */
  indices: number[];
  warnings: string[];
  rejected: IRejectedEntry[];
}> {
  if (!existsSync(file)) {
    return { patterns: [], indices: [], warnings: [`scaffold pattern file missing: ${file}`], rejected: [] };
  }
  try {
    const mod = await importModuleViaLoader<{
      default?: unknown;
    }>(file);
    const raw = mod.default ?? mod;
    if (!Array.isArray(raw)) {
      return {
        patterns: [],
        indices: [],
        warnings: [`scaffold pattern file did not default-export an array: ${file}`],
        rejected: [],
      };
    }
    const out: IScaffoldPattern[] = [];
    const indices: number[] = [];
    const rejected: IRejectedEntry[] = [];
    raw.forEach((candidate: unknown, index: number) => {
      const reasons = scaffoldPatternRejectionReasons(candidate);
      if (reasons.length > 0) {
        const id = candidate && typeof candidate === 'object' ? (candidate as { id?: unknown }).id : undefined;
        rejected.push({
          file,
          index,
          exportName: 'default',
          ...(typeof id === 'string' && id.length > 0 ? { entryId: id } : {}),
          reasons,
          cause: RejectionCause.Invalid,
        });
        return;
      }
      // THE normaliser (round 13): `matchPaths` markers become plain globs + the
      // `expectEmptyUnits` ledger (the pack stamp is added by the inspection
      // loader, which knows the pack). A new object — the module's export is
      // never patched.
      const normalized = normalizeScaffoldPattern(candidate as IScaffoldPatternInput);
      if (!normalized.ok) {
        const id = (candidate as { id?: unknown }).id;
        rejected.push({
          file,
          index,
          exportName: 'default',
          ...(typeof id === 'string' && id.length > 0 ? { entryId: id } : {}),
          reasons: unitProblemsOf(normalized.error),
          cause: RejectionCause.Invalid,
        });
        return;
      }
      const p = normalized.value;
      // The list every consumer iterates (`extractVariablesForFile`): a missing
      // one is normalised to a frozen [] rather than reaching it as undefined.
      out.push(Array.isArray(p.variables) ? p : { ...p, variables: Object.freeze([]) });
      indices.push(index);
    });
    return { patterns: out, indices, warnings: [], rejected };
  } catch (e) {
    return {
      patterns: [],
      indices: [],
      warnings: [`failed to import scaffold pattern file ${file}: ${(e as Error).message}`],
      rejected: [],
    };
  }
}

/**
 * Walk the inspection's discovered packs and load every `scaffoldPatternFiles`
 * entry. Returns the patterns + source map.
 */
export async function loadScaffoldPatternsFromInspection(
  inspection: ISharkcraftInspection,
): Promise<IScaffoldPatternsLoadResult> {
  const seen = new Map<string, IScaffoldPatternWithSource>();
  const warnings: string[] = [];
  const rejected: IRejectedEntry[] = [];
  const duplicate = (p: IScaffoldPattern, file: string, index: number, prev: IScaffoldPatternWithSource): void => {
    rejected.push({
      file,
      index,
      exportName: 'default',
      entryId: p.id,
      reasons: [`id: "${p.id}" is already declared in ${prev.source.file ?? prev.source.type}`],
      cause: RejectionCause.DuplicateId,
    });
  };
  // Also load a local sharkcraft/scaffold-patterns.ts when present.
  if (inspection.sharkcraftDir) {
    const local = nodePath.join(inspection.sharkcraftDir, 'scaffold-patterns.ts');
    if (existsSync(local)) {
      const r = await loadScaffoldPatternsFromFile(local);
      warnings.push(...r.warnings);
      rejected.push(...r.rejected);
      r.patterns.forEach((p, i) => {
        const prev = seen.get(p.id);
        if (prev) {
          duplicate(p, local, r.indices[i] ?? i, prev);
          return;
        }
        seen.set(p.id, {
          pattern: p,
          source: { type: 'local', file: local },
        });
      });
    }
  }
  for (const pack of inspection.packs.validPacks) {
    const c = pack.manifest!.contributions as { scaffoldPatternFiles?: readonly string[] };
    for (const rel of c.scaffoldPatternFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      const r = await loadScaffoldPatternsFromFile(full);
      warnings.push(...r.warnings);
      rejected.push(...r.rejected);
      for (const [i, p] of r.patterns.entries()) {
        const prev = seen.get(p.id);
        if (prev) {
          duplicate(p, full, r.indices[i] ?? i, prev);
          continue;
        }
        seen.set(p.id, {
          // A pack's markers carry the pack (round 13): a pack marker that went
          // live is INFO for the consumer, who cannot edit it.
          pattern: p.expectEmptyUnits
            ? { ...p, expectEmptyUnits: stampUnitMarks(p.expectEmptyUnits, pack.packageName) }
            : p,
          source: {
            type: 'pack',
            packageName: pack.packageName,
            packageVersion: pack.packageVersion,
            file: full,
          },
        });
        if (pack.resolvedCounts) {
          (pack.resolvedCounts as { scaffoldPatterns?: number }).scaffoldPatterns =
            (pack.resolvedCounts.scaffoldPatterns ?? 0) + 1;
        }
      }
    }
  }
  return { patterns: [...seen.values()], warnings, rejected };
}

// ─── Matching + doctor ────────────────────────────────────────────────────────

export interface IScaffoldPatternIssue {
  patternId: string;
  field: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Set on the coverage findings: `matchPaths-matched-nothing` / `pattern-dead`. */
  code?: string;
  /** The selector the finding is about (the dead `matchPaths` glob). */
  target?: string;
}

/**
 * `coverage` (optional, from {@link enumerateScaffoldPatternCandidates}) adds
 * the per-unit dead-selector checks: a `matchPaths` glob matching no file, and
 * a pattern matching no file after `excludePaths`. Without it only the
 * definitions are validated (back-compat).
 */
export function doctorScaffoldPatterns(
  patterns: readonly IScaffoldPatternWithSource[],
  inspection: ISharkcraftInspection,
  coverage?: IScaffoldPatternEnumeration,
): readonly IScaffoldPatternIssue[] {
  const issues: IScaffoldPatternIssue[] = [];
  if (coverage) {
    // Every per-unit finding comes from THE settle (round 13): a dead glob or
    // pattern is a warning; an intended-empty glob and a stale marker are info
    // (the acceptance rides in coverage; went-live fails only through
    // `selectorUnitFails` under `--fail-on-dead-units`).
    const liveness = scaffoldPatternLiveness(patterns, coverage);
    for (const { pattern: p } of patterns) {
      if (!coverage.byPattern.has(p.id)) continue;
      for (const u of liveness.globs.units.filter((x) => x.list === qualifyListPath(p.id, MATCH_PATHS))) {
        if (u.state === UnitLivenessState.Dead) {
          issues.push({
            patternId: p.id,
            field: 'matchPaths',
            severity: 'warning',
            code: 'matchPaths-matched-nothing',
            target: u.unit,
            message: `matchPaths glob "${u.unit}" matches no file, so the pattern never sees files through it — ${DEAD_SELECTOR_CAUSES}`,
          });
        } else if (u.state === UnitLivenessState.IntendedEmpty || u.state === UnitLivenessState.WentLive) {
          issues.push({
            patternId: p.id,
            field: 'matchPaths',
            severity: 'info',
            code: u.state === UnitLivenessState.IntendedEmpty ? 'matchPaths-intended-empty' : 'matchPaths-went-live',
            target: u.unit,
            // THE settle's sentence; the pattern is already the finding's subject.
            message: `matchPaths glob "${u.unit}" — ${u.message}`,
          });
        }
      }
      if (liveness.patterns.dead.some((u) => u.unit === p.id)) {
        issues.push({
          patternId: p.id,
          field: 'matchPaths',
          severity: 'warning',
          code: 'pattern-dead',
          message: 'matches no file (after excludePaths), so inference can never suggest it',
        });
      }
    }
  }
  const knownTemplateIds = new Set(inspection.templateRegistry.list().map((t) => t.id));
  for (const { pattern: p } of patterns) {
    if (!p.title) {
      issues.push({ patternId: p.id, field: 'title', severity: 'warning', message: 'missing title' });
    }
    if (!p.description) {
      issues.push({
        patternId: p.id,
        field: 'description',
        severity: 'warning',
        message: 'missing description',
      });
    }
    if (!Array.isArray(p.appliesWhen) || p.appliesWhen.length === 0) {
      issues.push({
        patternId: p.id,
        field: 'appliesWhen',
        severity: 'warning',
        message: 'appliesWhen is empty — pattern will not be consulted by any lifecycle hook',
      });
    }
    if (!SCAFFOLD_CONFIDENCES.has(String(p.confidence))) {
      issues.push({
        patternId: p.id,
        field: 'confidence',
        severity: 'error',
        message: `confidence must be high|medium|low (got "${String(p.confidence)}")`,
      });
    }
    for (const m of p.matchPaths) {
      if (typeof m !== 'string' || m.length === 0) {
        issues.push({
          patternId: p.id,
          field: 'matchPaths',
          severity: 'error',
          message: `matchPaths entry must be a non-empty string`,
        });
      }
    }
    if (!knownTemplateIds.has(p.templateId)) {
      issues.push({
        patternId: p.id,
        field: 'templateId',
        severity: 'warning',
        message: `template "${p.templateId}" is not registered in this project`,
      });
    }
    for (const v of p.variables ?? []) {
      if (!isRecognizedScaffoldStrategy(String(v.from))) {
        issues.push({
          patternId: p.id,
          field: `variables.${v.name}.from`,
          severity: 'warning',
          message: `unrecognized extraction strategy "${String(v.from)}"`,
        });
      }
    }
  }
  return issues;
}

/**
 * Convert a glob-like pattern (only `*` and `**` are recognized) into a
 * RegExp. Kept tiny — we don't depend on `minimatch`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      // `**/` matches zero or more path segments. We also consume the slash so
      // that the segment-separator isn't required by the rest of the pattern.
      re += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+()[]{}|^$\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function matchScaffoldPattern(
  pattern: IScaffoldPattern,
  relativePath: string,
): boolean {
  const path = relativePath.split(nodePath.sep).join('/');
  for (const x of pattern.excludePaths ?? []) {
    if (globToRegExp(x).test(path)) return false;
  }
  for (const m of patternUnits(pattern).units) {
    if (globToRegExp(m).test(path)) return true;
  }
  return false;
}

// ─── Candidate enumeration (the one walker infer and the doctor share) ────────

/** Directory names the candidate walk never enters. */
const SCAFFOLD_WALK_SKIP: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.sharkcraft',
  '__tests__',
]);

/**
 * THE scaffold candidate walker: every file under `root` once (skipping
 * vendor/build/VCS and test dirs), with its project-relative POSIX path.
 * `infer templates` and the scaffold doctor both read it, so the doctor's
 * per-pattern counts equal infer's candidates by construction. Returns the
 * number of files visited.
 */
export function walkScaffoldCandidateFiles(root: string, onFile: (abs: string, rel: string) => void): number {
  let walked = 0;
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (SCAFFOLD_WALK_SKIP.has(e)) continue;
      const full = nodePath.join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) {
        walked += 1;
        onFile(full, nodePath.relative(root, full).split(nodePath.sep).join('/'));
      }
    }
  };
  if (existsSync(root)) visit(root);
  return walked;
}

/** One pattern's matches: files after `excludePaths`, and raw hits per `matchPaths` glob. */
export interface IScaffoldPatternCoverage {
  readonly patternId: string;
  readonly files: readonly string[];
  readonly perMatchPath: readonly { readonly glob: string; readonly files: number }[];
}

/** What one walk found for every pattern. */
export interface IScaffoldPatternEnumeration {
  readonly byPattern: ReadonlyMap<string, IScaffoldPatternCoverage>;
  /** Walk order, attributed to the FIRST pattern (in input order) that matches — infer's attribution. */
  readonly firstMatch: readonly { readonly file: string; readonly patternId: string }[];
  readonly walked: number;
}

/**
 * Walk once and count, per pattern, the files it matches (the runtime matcher,
 * `excludePaths` honoured) and the files each `matchPaths` glob matches on its
 * own (`globToRegExp` — the pattern's own dialect, not the boundaries one).
 */
export function enumerateScaffoldPatternCandidates(
  projectRoot: string,
  patterns: readonly IScaffoldPatternWithSource[],
): IScaffoldPatternEnumeration {
  // Compiled once per walk. A non-string / empty entry compiles to nothing —
  // exactly what `matchScaffoldPattern` makes of it (`/^$/` or a throw) — and
  // the doctor reports it as a definition error.
  const compile = (list: readonly unknown[] | undefined): (RegExp | null)[] =>
    (list ?? []).map((g) => (typeof g === 'string' && g.length > 0 ? globToRegExp(g) : null));
  const compiled = patterns.map(({ pattern }) => {
    const units = patternUnits(pattern).units;
    return {
      pattern,
      units,
      globs: compile(units),
      excludes: compile(pattern.excludePaths),
      counts: units.map(() => 0),
      files: [] as string[],
    };
  });
  const firstMatch: { file: string; patternId: string }[] = [];
  const walked = walkScaffoldCandidateFiles(projectRoot, (_abs, rel) => {
    let first: string | undefined;
    for (const c of compiled) {
      let anyGlob = false;
      c.globs.forEach((re, i) => {
        if (re && re.test(rel)) {
          c.counts[i] = (c.counts[i] ?? 0) + 1;
          anyGlob = true;
        }
      });
      // `matchScaffoldPattern`'s semantics: excluded first, then any glob.
      if (anyGlob && !c.excludes.some((re) => re !== null && re.test(rel))) {
        c.files.push(rel);
        first ??= c.pattern.id;
      }
    }
    if (first) firstMatch.push({ file: rel, patternId: first });
  });
  const byPattern = new Map<string, IScaffoldPatternCoverage>();
  for (const c of compiled) {
    byPattern.set(c.pattern.id, {
      patternId: c.pattern.id,
      files: c.files,
      perMatchPath: c.units.map((glob, i) => ({ glob, files: c.counts[i] ?? 0 })),
    });
  }
  return { byPattern, firstMatch, walked };
}

/**
 * THE two settles over an enumeration (round 13): every `matchPaths` glob
 * (markable: exists = live = it matches a file), and the DERIVED pattern-level
 * unit (does the pattern match a file after `excludePaths`; not authored, so
 * never marked). A pattern whose every glob is intended-empty is left OUT of
 * the pattern-level settle — its glob-level acceptance speaks for it: ONE
 * planned fact is ONE acceptance, not the dead=2 it used to be.
 */
function scaffoldPatternLiveness(
  patterns: readonly IScaffoldPatternWithSource[],
  enumeration: IScaffoldPatternEnumeration,
): { readonly globs: ISettledUnitLiveness; readonly patterns: ISettledUnitLiveness } {
  const globObservations: IUnitObservation[] = [];
  const marks: IUnitMark[] = [];
  for (const { pattern } of patterns) {
    const list = qualifyListPath(pattern.id, MATCH_PATHS);
    for (const g of enumeration.byPattern.get(pattern.id)?.perMatchPath ?? []) {
      globObservations.push({
        list,
        unit: g.glob,
        label: `${pattern.id}: ${g.glob}`,
        exists: g.files > 0,
        live: g.files > 0,
        matched: g.files,
        liveBecause: `matches ${g.files} file(s)`,
        deadReason: 'matched no file',
      });
    }
    marks.push(...qualifyUnitMarks(patternUnits(pattern).marks, pattern.id));
  }
  const globs = settleUnitLiveness({
    subject: 'scaffold patterns',
    unitLabel: MARKABLE_UNIT_LISTS[MarkableUnitList.ScaffoldPatternMatchPaths].unitLabel,
    weight: UnitDeadWeight.Coverage,
    observations: globObservations,
    marks,
    deadSummary: 'matched no file',
  });
  const patternObservations: IUnitObservation[] = [];
  for (const { pattern } of patterns) {
    const own = globs.units.filter((u) => u.list === qualifyListPath(pattern.id, MATCH_PATHS));
    if (own.length > 0 && own.every((u) => u.state === UnitLivenessState.IntendedEmpty)) continue;
    const files = enumeration.byPattern.get(pattern.id)?.files.length ?? 0;
    patternObservations.push({
      list: 'patterns',
      unit: pattern.id,
      exists: files > 0,
      live: files > 0,
      matched: files,
      liveBecause: `matches ${files} file(s) after excludePaths`,
      deadReason: 'match no file after excludePaths',
    });
  }
  const settledPatterns = settleUnitLiveness({
    subject: 'scaffold patterns',
    unitLabel: 'patterns',
    weight: UnitDeadWeight.Coverage,
    observations: patternObservations,
    marks: [],
    deadSummary: 'match no file after excludePaths',
  });
  return { globs, patterns: settledPatterns };
}

/**
 * Per-unit coverage over an enumeration, from THE settles
 * (`scaffoldPatternLiveness`): `matchPaths globs` (examined = globs matching a
 * file; an intended-empty glob is its own printed acceptance) and `patterns`
 * (examined = patterns matching a file after `excludePaths`). Empty when there
 * are no patterns.
 */
export function scaffoldPatternCoverage(
  patterns: readonly IScaffoldPatternWithSource[],
  enumeration: IScaffoldPatternEnumeration,
): { coverage: IVerdictCoverage[]; deadUnits: string[]; liveness: readonly ISettledUnitLiveness[] } {
  if (patterns.length === 0) return { coverage: [], deadUnits: [], liveness: [] };
  const settled = scaffoldPatternLiveness(patterns, enumeration);
  return {
    coverage: [...settled.globs.coverage, ...settled.patterns.coverage],
    deadUnits: [
      ...settled.globs.dead.map((u) => `scaffold pattern ${u.label}`),
      ...settled.patterns.dead.map((u) => `scaffold pattern ${u.unit} (no file)`),
    ],
    liveness: [settled.globs, settled.patterns],
  };
}

// ─── Variable extraction ──────────────────────────────────────────────────────

export interface IExtractedVariables {
  values: Record<string, string>;
  warnings: string[];
}

export function extractVariablesForFile(
  pattern: IScaffoldPattern,
  filePath: string,
  inspection: ISharkcraftInspection,
): IExtractedVariables {
  const warnings: string[] = [];
  const values: Record<string, string> = {};
  const base = nodePath.basename(filePath).replace(/\.(tsx?|jsx?)$/i, '');
  const dirSegments = filePath.split(/[\\/]/).slice(0, -1);
  const dir = dirSegments[dirSegments.length - 1] ?? '';

  // THE strategy table (plugin-api `resolveScaffoldStrategy`) — the same one
  // `isRecognizedScaffoldStrategy` reads, so "recognised" and "implemented"
  // cannot drift apart.
  const packageName = inspection.workspace.packageName ?? undefined;
  for (const v of pattern.variables ?? []) {
    const strat = String(v.from);
    const r = resolveScaffoldStrategy(strat, {
      basename: base,
      directory: dir,
      ...(packageName ? { packageName } : {}),
    });
    if (!r.recognized) {
      warnings.push(`unrecognized extraction strategy "${strat}" for variable "${v.name}"`);
      continue;
    }
    if (r.value) values[v.name] = r.value;
  }
  return { values, warnings };
}
