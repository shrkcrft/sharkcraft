/**
 * Registry lifecycle symmetry rule.
 *
 * Scans the workspace for `register*` APIs (functions or methods) and checks
 * that a matching `remove*` / `unregister*` / `clear*` exists in the same file,
 * with optional scope-aware naming (e.g. `registerXByScope` ↔ `removeXByScope`).
 *
 * Ignored: generated files (.generated.*, .d.ts), files containing
 * `@shrkcrft lifecycle-ignore <reason>`. Sites with `@shrkcrft lifecycle-managed-by <name>`
 * are reported under `ignored` with the managed-by reference.
 *
 * Bounded, and honest about the bound (round 11):
 *   - candidates are SORTED by project-relative path, so `offset` / `limit`
 *     page through them deterministically and `nextOffset` always reaches the
 *     remainder a cap, the budget or a signal left unexamined;
 *   - the wall-clock budget is checked between files AND inside each file
 *     (after the strip, after the declaration scan, before every register), so
 *     one pathological file cannot run past it unbounded. A file over its own
 *     sub-budget is abandoned whole and NAMED in `overBudgetFiles`;
 *   - every per-file step is linear — no two newline-spanning quantifiers
 *     touch in any pattern that runs on the blanked buffer, and the remover
 *     lookup is one pass per file instead of one regex per candidate name;
 *   - the report carries engine-owned coverage (`files`, `registrations`), and
 *     {@link registryLifecycleVerdict} reads nothing else.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { coverageShortfall, type IVerdictCoverage } from '@shrkcrft/core';

export interface IRegistryPair {
  registerName: string;
  removerName: string;
  file: string;
  registerLine: number;
  removerLine: number;
}

export interface IRegistryMissingRemover {
  registerName: string;
  expectedRemoverNames: ReadonlyArray<string>;
  file: string;
  line: number;
  suggestion: string;
}

export interface IRegistryIgnored {
  registerName: string;
  file: string;
  line: number;
  reason: string;
  managedBy?: string;
}

/**
 * A file the scan started and abandoned because a deadline expired inside it.
 * Its partial findings are DISCARDED — a file is either fully judged or listed
 * here — so a half-classified file can never read as clean.
 */
export interface IRegistryLifecycleOverBudgetFile {
  readonly file: string;
  /** The phase the clock ran out in. */
  readonly phase: 'strip' | 'registers' | 'removers';
  /** Which deadline expired: this file's own sub-budget, or the whole run's. */
  readonly deadline: 'file' | 'run';
  readonly elapsedMs: number;
  /** `register*` declarations seen before the file was abandoned (none judged). */
  readonly registersSeen: number;
}

/** The engine's verdict, in the settled-verdict vocabulary (`pass` / `fail` / `not-verified`). */
export type RegistryLifecycleVerdict = 'pass' | 'fail' | 'not-verified';

/**
 * Where the scan reads its clock. The default clock ignores it; a test clock
 * uses it to advance time in ONE phase only, so budget behaviour is asserted
 * deterministically instead of by racing the wall clock.
 */
export type RegistryLifecycleCheckpoint =
  | 'start'
  | 'walk'
  | 'file'
  | 'strip'
  | 'registers'
  | 'register';

export interface IRegistryLifecycleReport {
  schema: 'sharkcraft.registry-lifecycle/v1';
  /** Files fully judged (excluded, unreadable and over-budget files are not). */
  filesScanned: number;
  /** Candidate files found (the whole sorted list, before `offset`). */
  totalFiles: number;
  /** True when the scan did NOT consume every candidate (cap, budget, signal, or an unfinished walk). */
  truncated: boolean;
  /** True when the run's wall-clock budget expired before the work was done. */
  timedOut: boolean;
  /** True when a signal (SIGTERM / SIGINT / an AbortSignal) stopped the scan early. */
  interrupted: boolean;
  /** False when the budget expired during candidate DISCOVERY, so `totalFiles` is itself partial. */
  walkComplete: boolean;
  /** True when the scan was scoped to the changed file set (`--changed-only`). */
  changedOnly: boolean;
  /** Project-relative subtree the scan was scoped to, when `--scope` was used. */
  scope?: string;
  /** Index of the first candidate this run judged (sorted order). */
  offset: number;
  /** The file cap for this run; `0` = uncapped. */
  limit: number;
  budgetMs: number;
  perFileBudgetMs: number;
  /** Candidates consumed from `offset` — judged, excluded, unreadable or over budget. */
  candidatesExamined: number;
  /**
   * Where a continuation starts: present iff candidates remain. The ONE
   * continuation for a cap, an expired budget and an interrupted run alike —
   * `--offset <nextOffset>` reaches exactly the remainder.
   */
  nextOffset?: number;
  /** Deliberately excluded candidates (generated, deleted, over the size cap) — narrowing, named. */
  excludedFiles: {
    readonly generated: number;
    readonly missing: number;
    readonly oversized: readonly string[];
  };
  unreadableFiles: readonly string[];
  overBudgetFiles: readonly IRegistryLifecycleOverBudgetFile[];
  /** The skip-dir set the walk applied (defaults, a replacement, plus `skipDirsAdd`). */
  skipDirs: readonly string[];
  /** Dependency / VCS / build defaults a replacing `skipDirs` list dropped. */
  droppedDefaultSkipDirs: readonly string[];
  warnings: readonly string[];
  registersFound: number;
  matchedPairs: ReadonlyArray<IRegistryPair>;
  missingRemovers: ReadonlyArray<IRegistryMissingRemover>;
  /**
   * `register*` declarations in a file with NO teardown-shaped API — treated as
   * one-shot / bootstrap registrations that legitimately need no remover. Kept
   * out of `missingRemovers` so the check isn't a wall of false positives.
   */
  oneShotBootstrap: ReadonlyArray<IRegistryIgnored>;
  ignored: ReadonlyArray<IRegistryIgnored>;
  recommendations: ReadonlyArray<string>;
  /** Files examined of files in scope — engine-owned; the verdict reads it. */
  coverage: IVerdictCoverage;
  /** Registrations judged — `expected: 0` when the examined files declare none. */
  registrationCoverage: IVerdictCoverage;
  /**
   * Set only when the project config EXISTS but failed to load: 1 config file
   * expected, 0 examined. The scan ran with the default skip set, not the
   * configured one, so the verdict can never be a pass.
   */
  configCoverage?: IVerdictCoverage;
  verdict: RegistryLifecycleVerdict;
  verdictReason?: string;
}

/** Inputs to one lifecycle scan. */
export interface IRegistryLifecycleInput {
  projectRoot: string;
  /** File cap (default 2000). `<= 0` = uncapped. */
  limit?: number;
  /** First candidate to judge, in sorted order (default 0). */
  offset?: number;
  /** Project-relative subtree to scope the scan to (sub-second on a subtree). */
  scope?: string;
  /**
   * Changed-only scope: scan JUST these files (project-relative or absolute)
   * instead of walking the tree. Non-`.ts/.tsx` entries are ignored. When set,
   * an empty relevant set is reported as an expected-0 coverage, never a pass.
   */
  files?: readonly string[];
  /** Wall-clock budget for the whole run (ms). */
  budgetMs?: number;
  /** One file's sub-budget (ms). Default `max(1000, budgetMs / 4)`. */
  perFileBudgetMs?: number;
  /**
   * Directory names the walk skips INSTEAD OF {@link DEFAULT_REGISTRY_LIFECYCLE_SKIP_DIRS}.
   * An advanced escape hatch; prefer {@link skipDirsAdd}. Ignored on the changed-only path.
   */
  skipDirs?: readonly string[];
  /** Directory names ADDED to the skip set (defaults or `skipDirs`). */
  skipDirsAdd?: readonly string[];
  /**
   * The project config EXISTS but failed to load (the caller's
   * `resolveProjectConfig` error, or `inspection.configLoadError`). The walk
   * then runs with the default skip set — not the scope the config asked for
   * — so the report carries a `configCoverage` shortfall and can never be a
   * pass. Absent when there is no config, or it loaded.
   */
  configLoadError?: { readonly file?: string | null; readonly message: string };
  /** Test seam: the clock (default `Date.now`). */
  now?: (checkpoint: RegistryLifecycleCheckpoint) => number;
}

/** A lifecycle scan, advanced one candidate at a time. Both wrappers drive the same {@link step}. */
export interface IRegistryLifecycleScan {
  /** Judge the next candidate. `false` when nothing is left or the run's budget expired. */
  step(): boolean;
  /** The report for what has been judged so far. */
  snapshot(options?: { readonly interrupted?: boolean }): IRegistryLifecycleReport;
}

/** Options for {@link renderRegistryLifecycleReportText}. */
export interface IRegistryLifecycleRenderOptions {
  /** The command a continuation re-runs, flags included (default `shrk check registry-lifecycle`). */
  readonly command?: string;
}

/**
 * Default directories the walk skips — build artefacts + non-source trees that
 * inflate the scan without owning runtime lifecycle. Extend it with
 * `registryLifecycle.skipDirsAdd`; replace it with `registryLifecycle.skipDirs`.
 */
export const DEFAULT_REGISTRY_LIFECYCLE_SKIP_DIRS: readonly string[] = Object.freeze([
  'node_modules',
  'dist',
  '.git',
  '.sharkcraft',
  'coverage',
  '.nx',
  'build',
  'out',
  'examples',
  'e2e',
  'fixtures',
  '__fixtures__',
  'scripts',
  'tools',
  '.agents',
  '.github',
]);

/**
 * The dependency / VCS-adjacent / build-output defaults. A replacing
 * `skipDirs` list that omits one of these makes the scan read vendored or
 * generated code — four false positives from one added exclusion, measured —
 * so dropping one is always reported. (`.git` & co. stay skipped by the
 * dot-entry rule regardless.)
 */
export const CORE_REGISTRY_LIFECYCLE_SKIP_DIRS: readonly string[] = Object.freeze([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.sharkcraft',
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);
/**
 * Skip pathological single files — named in `excludedFiles.oversized` AND
 * counted UNEXAMINED in the files coverage: a cap is never a deliberate
 * narrowing (round 11 review: subtracting them from `expected` let a missing
 * remover inside a 361 KB file settle to a clean ✓). The boundaries reader's
 * rule (`readScopeCoverage`: over-cap = unread = a shortfall) — one rule.
 */
const MAX_SCAN_FILE_BYTES = 256 * 1024;
/** How the files coverage names the size cap. */
const LIFECYCLE_READ_CAP = `${MAX_SCAN_FILE_BYTES / 1024} KB`;
/** Wall-clock budget for a whole run. */
const DEFAULT_BUDGET_MS = 15_000;
/** Default file cap. */
const DEFAULT_LIMIT = 2000;
/** Labels named in a coverage record's `unexamined`. */
const UNEXAMINED_SHOWN = 20;

/**
 * THE skip-dir authority: the engine, the CLI and `shrk doctor` all call this.
 * `skipDirsAdd` extends; `skipDirs` replaces; a replacement that drops a core
 * default is reported in `droppedDefaults`.
 */
export function resolveRegistryLifecycleSkipDirs(input: {
  readonly skipDirs?: readonly string[];
  readonly skipDirsAdd?: readonly string[];
}): { readonly effective: readonly string[]; readonly droppedDefaults: readonly string[] } {
  const base = input.skipDirs ?? DEFAULT_REGISTRY_LIFECYCLE_SKIP_DIRS;
  const effective = [...new Set([...base, ...(input.skipDirsAdd ?? [])])].sort();
  const kept = new Set(effective);
  const droppedDefaults = CORE_REGISTRY_LIFECYCLE_SKIP_DIRS.filter((d) => !kept.has(d));
  return { effective, droppedDefaults };
}

/** The warning a replacing skip list that drops core defaults earns. One wording, scan and doctor. */
export function registryLifecycleSkipDirsWarning(droppedDefaults: readonly string[]): string {
  return (
    `registryLifecycle.skipDirs replaces the defaults and drops: ${droppedDefaults.join(', ')} — ` +
    'use skipDirsAdd to extend the default skip set instead'
  );
}

function isGeneratedPath(file: string): boolean {
  return file.endsWith('.d.ts') || /\.generated\.(ts|tsx)$/.test(file);
}

function isGeneratedContent(content: string): boolean {
  return /^\/\/ @generated\b/m.test(content);
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isMissing(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'ENOENT';
}

/** Walk for candidates. Returns `false` when the budget expired before the walk finished. */
function walkCandidates(
  dir: string,
  out: string[],
  skipDirs: ReadonlySet<string>,
  expired: () => boolean,
): boolean {
  // The budget bounds DISCOVERY too, not only the per-file loop — a
  // pathological tree could otherwise eat the whole budget first (a25 §2.5).
  if (expired()) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of entries) {
    if (expired()) return false;
    if (skipDirs.has(e.name)) continue;
    // Hidden entries stay out, except `.sharkcraft` (skipped by default, but a
    // replacing skip list makes it scannable — and is warned about).
    if (e.name.startsWith('.') && e.name !== '.sharkcraft') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (!walkCandidates(abs, out, skipDirs, expired)) return false;
    } else if (e.isFile() && SCAN_EXTENSIONS.has(extname(e.name))) {
      out.push(abs);
    }
  }
  return true;
}

interface IRegisterMatch {
  name: string;
  line: number;
}

const REGISTER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // export function registerX(
  /(?:export\s+)?(?:async\s+)?function\s+(register[A-Z]\w*)\s*\(/g,
  // class method DECLARATION: requires a body `{` or return-type `:` after the
  // params, which a bare call site (`registry.registerX(...)`) never has.
  // NOTE: every modifier carries its OWN single-line (`[ \t]`) trailing space
  // and the leading whitespace class is single-line too — no two newline-
  // spanning (`\s`) quantifiers sit adjacent. The old form had `[\t ]*` then
  // `\s*` then `(?:static\s+)?` then `(?:async\s+)?` all touching, so from each
  // `\n` anchor the engine re-partitioned the whole whitespace block looking for
  // `register`: O(block^2) catastrophic backtracking that dominated the scan
  // (~90% of runtime on a stripped source full of blanked comment/string runs).
  // The only newline-spanning class is the final one, after the required `)`,
  // where it cannot backtrack against a neighbour. Match-equivalent to the old
  // pattern on real TS (modifiers always sit on the same line as `registerX(`).
  /(?:^|\n)[ \t]*(?:(?:public|private|protected)[ \t]+)?(?:static[ \t]+)?(?:async[ \t]+)?(register[A-Z]\w*)[ \t]*\([^;]*?\)[ \t\r\n]*[:{]/g,
  // assigned arrow / function expression: `registerX = (…) =>` / `registerX = function`
  /\b(register[A-Z]\w*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>)/g,
]);

// Accumulation of removable per-entry state — a registry that ADDS entries one
// at a time plausibly needs a way to remove them.
const ACCUMULATION_RE = /\.(?:set|add|push)\s*\(|\[[^\]]+\]\s*=[^=]/;
// A teardown-shaped API somewhere in the file — evidence the file is in the
// business of removing things, so a missing per-register remover is suspicious.
const TEARDOWN_RE = /\b(?:remove|unregister|clear|dispose|unsubscribe)\w*\s*\(|\boff\s*\(/i;
/**
 * Every callable site `name(` / `name = (` in the blanked code, in ONE pass.
 *
 * Replaces a whole-file regex compiled once PER CANDIDATE NAME whose third
 * alternative, `(?:public|private|protected)?\s*(?:async\s+)?NAME\s*\(`, could
 * start at every offset of a blank run and cost O(run) there: O(run²) per
 * blanked comment, times six candidate names, times every register — 16 s for
 * one 51 KB file. Anchored on `\b` + an identifier, no whitespace quantifier
 * can start a match, so this is linear. It also reports the NAME's offset, so
 * `removerLine` is the method's own line (the old match began at the blank run).
 */
const CALLABLE_SITE_RE = /\b([A-Za-z_$][\w$]*)\s*(?:=\s*)?\(/g;

/**
 * Every pattern this module runs on a blanked buffer, for the linearity lock
 * (`r75-registry-lifecycle-scan.test.ts`): each must stay fast on a 64 KiB
 * blank run and clean under `findBlankRunHazards`.
 */
export const REGISTRY_LIFECYCLE_PATTERNS: {
  readonly register: ReadonlyArray<RegExp>;
  readonly accumulation: RegExp;
  readonly teardown: RegExp;
  readonly callableSite: RegExp;
} = Object.freeze({
  register: REGISTER_PATTERNS,
  accumulation: ACCUMULATION_RE,
  teardown: TEARDOWN_RE,
  callableSite: CALLABLE_SITE_RE,
});

/**
 * Blank out comments and string / template-literal bodies (preserving newlines
 * so line numbers stay accurate) before scanning for `register*` declarations.
 * Deterministic char-scan — no TS parser, consistent with this module's no-AST
 * posture. Stops `register*` mentions inside comments / strings / docs from
 * being counted as code.
 */
function stripCommentsAndLiterals(content: string): string {
  const out: string[] = [];
  const n = content.length;
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let state: State = 'code';
  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');
  let i = 0;
  while (i < n) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out.push('  '); i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out.push('  '); i += 2; continue; }
      if (ch === "'") { state = 'sq'; out.push(' '); i += 1; continue; }
      if (ch === '"') { state = 'dq'; out.push(' '); i += 1; continue; }
      if (ch === '`') { state = 'tpl'; out.push(' '); i += 1; continue; }
      out.push(ch); i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out.push('\n'); i += 1; continue; }
      out.push(blank(ch)); i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out.push('  '); i += 2; continue; }
      out.push(blank(ch)); i += 1; continue;
    }
    // string / template literal body
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (ch === '\\') {
      out.push(' ');
      out.push(next === undefined ? '' : blank(next));
      i += 2;
      continue;
    }
    if (ch === quote) { state = 'code'; out.push(' '); i += 1; continue; }
    out.push(blank(ch)); i += 1; continue;
  }
  return out.join('');
}

/**
 * Precompute the byte offset of each line start, so an offset → line lookup is
 * O(log n) instead of the O(fileLen) `content.slice(0, i).split('\n')` done PER
 * MATCH (the original quadratic hotspot — a 57 KB file with 200 `register*`
 * tokens paid ~200 × 57 KB of slicing). Built once per file.
 */
function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number for a byte offset, via binary search over line starts. */
function lineAtOffset(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

function findRegistersInFile(content: string, lineStarts: readonly number[]): IRegisterMatch[] {
  const out: IRegisterMatch[] = [];
  const seen = new Set<string>();
  for (const re of REGISTER_PATTERNS) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const name = m[1]!;
      // The NAME's offset, not the match start: the method pattern begins at
      // the preceding `\n`, which used to report the line ABOVE the declaration.
      const at = m.index + m[0].indexOf(name);
      if (seen.has(`${name}@${at}`)) continue;
      seen.add(`${name}@${at}`);
      out.push({ name, line: lineAtOffset(lineStarts, at) });
    }
  }
  return out;
}

/** First offset of every callable name in the file — built once, looked up per register. */
function indexCallableSites(code: string): Map<string, number> {
  const first = new Map<string, number>();
  CALLABLE_SITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALLABLE_SITE_RE.exec(code)) !== null) {
    const name = m[1]!;
    if (!first.has(name)) first.set(name, m.index);
  }
  return first;
}

function findIgnoreAnnotations(
  content: string,
  registerName: string,
): { ignore: boolean; managedBy?: string; reason?: string } {
  const ignoreRe = new RegExp(
    `@shrkcrft\\s+lifecycle-ignore(?:\\s+([^\\n]+))?[\\s\\S]{0,200}?\\b${registerName}\\b`,
    'm',
  );
  const managedRe = new RegExp(
    `@shrkcrft\\s+lifecycle-managed-by\\s+([\\w.-]+)[\\s\\S]{0,200}?\\b${registerName}\\b`,
    'm',
  );
  const ignoreMatch = content.match(ignoreRe);
  if (ignoreMatch) {
    return { ignore: true, reason: ignoreMatch[1]?.trim() ?? 'no reason given' };
  }
  const managedMatch = content.match(managedRe);
  if (managedMatch) {
    return { ignore: true, managedBy: managedMatch[1], reason: 'managed-by directive' };
  }
  return { ignore: false };
}

function expectedRemoverNames(registerName: string): string[] {
  // registerX → removeX / unregisterX / clearX / disposeX / unsubscribeX / Xoff
  // registerXByScope → removeXByScope / … (stem carries the scope suffix)
  const stem = registerName.slice('register'.length);
  return [
    `remove${stem}`,
    `unregister${stem}`,
    `clear${stem}`,
    `dispose${stem}`,
    `unsubscribe${stem}`,
    `${stem}Off`,
  ];
}

/** What judging one candidate produced. */
type FileOutcome =
  | { readonly kind: 'generated' | 'missing' | 'oversized' | 'unreadable' }
  | { readonly kind: 'over-budget'; readonly entry: IRegistryLifecycleOverBudgetFile }
  | {
      readonly kind: 'judged';
      readonly registers: number;
      readonly pairs: readonly IRegistryPair[];
      readonly missing: readonly IRegistryMissingRemover[];
      readonly oneShot: readonly IRegistryIgnored[];
      readonly ignored: readonly IRegistryIgnored[];
    };

/**
 * Create a scan: discover and sort the candidates, then judge them one
 * {@link IRegistryLifecycleScan.step} at a time. The sync report builder and
 * the signal-aware async runner both drive this — one loop, not two.
 */
export function createRegistryLifecycleScan(input: IRegistryLifecycleInput): IRegistryLifecycleScan {
  const { projectRoot } = input;
  const clock = input.now ?? ((): number => Date.now());
  const scope = input.scope && input.scope.length > 0 ? input.scope : undefined;
  const changedOnly = input.files !== undefined;
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const perFileBudgetMs = input.perFileBudgetMs ?? Math.max(1000, Math.floor(budgetMs / 4));
  const rawLimit = input.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
  const requestedOffset = Math.max(0, Math.floor(input.offset ?? 0));
  const skip = resolveRegistryLifecycleSkipDirs({
    ...(input.skipDirs ? { skipDirs: input.skipDirs } : {}),
    ...(input.skipDirsAdd ? { skipDirsAdd: input.skipDirsAdd } : {}),
  });
  const warnings: string[] = [];
  if (input.skipDirs !== undefined && skip.droppedDefaults.length > 0) {
    warnings.push(registryLifecycleSkipDirsWarning(skip.droppedDefaults));
  }
  // An existing config that failed to load: the configured skip set was never
  // applied, so this walk is NOT the scope the project asked for. Loud (a
  // warning line) AND settled (a coverage record the verdict reads).
  const loadError = input.configLoadError;
  const configCoverage: IVerdictCoverage | undefined = loadError
    ? {
        unit: 'config files',
        expected: 1,
        examined: 0,
        ...(loadError.file ? { unexamined: [loadError.file], unexaminedTotal: 1 } : {}),
        reason: 'failed to load, so registryLifecycle.skipDirs / skipDirsAdd were not applied (the scan used the default skip set)',
      }
    : undefined;
  if (loadError) {
    warnings.push(
      'sharkcraft.config.ts failed to load — registryLifecycle.skipDirs / skipDirsAdd not applied, so this scan ' +
        `used the default skip set (${loadError.message}). Run \`shrk doctor\`.`,
    );
  }
  const deadline = clock('start') + budgetMs;
  const walkRoot = changedOnly ? projectRoot : scope ? join(projectRoot, scope) : projectRoot;
  const rel = (abs: string): string => toPosix(relative(projectRoot, abs));

  // Candidates, SORTED by project-relative path: without a stable order a
  // continuation cannot be derived (readdir order is not one).
  let files: string[];
  let walkComplete = true;
  if (input.files !== undefined) {
    const abs = input.files
      .map((f) => (f.startsWith('/') ? f : join(projectRoot, f)))
      .filter((f) => SCAN_EXTENSIONS.has(extname(f)));
    files = [...new Set(abs)];
  } else {
    files = [];
    walkComplete = walkCandidates(walkRoot, files, new Set(skip.effective), () => clock('walk') >= deadline);
  }
  const relOf = new Map(files.map((f) => [f, rel(f)] as const));
  files.sort((a, b) => comparePaths(relOf.get(a)!, relOf.get(b)!));

  const start = Math.min(requestedOffset, files.length);
  const end = limit > 0 ? Math.min(files.length, start + limit) : files.length;
  let cursor = start;
  let finished = false;
  let timedOut = !walkComplete;
  let filesScanned = 0;
  let registersFound = 0;
  let generated = 0;
  let missingCount = 0;
  const oversized: string[] = [];
  const unreadable: string[] = [];
  const overBudget: IRegistryLifecycleOverBudgetFile[] = [];
  const matchedPairs: IRegistryPair[] = [];
  const missingRemovers: IRegistryMissingRemover[] = [];
  const oneShotBootstrap: IRegistryIgnored[] = [];
  const ignored: IRegistryIgnored[] = [];

  function judgeFile(abs: string, file: string, fileStart: number): FileOutcome {
    if (isGeneratedPath(abs)) return { kind: 'generated' };
    let size: number;
    try {
      size = statSync(abs).size;
    } catch (e) {
      return { kind: isMissing(e) ? 'missing' : 'unreadable' };
    }
    if (size > MAX_SCAN_FILE_BYTES) return { kind: 'oversized' };
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (e) {
      return { kind: isMissing(e) ? 'missing' : 'unreadable' };
    }
    if (isGeneratedContent(content)) return { kind: 'generated' };

    const fileDeadline = Math.min(deadline, fileStart + perFileBudgetMs);
    const abandon = (
      phase: IRegistryLifecycleOverBudgetFile['phase'],
      t: number,
      registersSeen: number,
    ): FileOutcome => ({
      kind: 'over-budget',
      entry: {
        file,
        phase,
        deadline: t >= deadline ? 'run' : 'file',
        elapsedMs: Math.max(0, t - fileStart),
        registersSeen,
      },
    });

    // Scan declarations on code with comments/strings blanked out; keep the raw
    // content only for the comment-based @shrkcrft annotations.
    const code = stripCommentsAndLiterals(content);
    let t = clock('strip');
    if (t >= fileDeadline) return abandon('strip', t, 0);
    const lineStarts = buildLineStarts(code);
    const registers = findRegistersInFile(code, lineStarts);
    t = clock('registers');
    if (t >= fileDeadline) return abandon('registers', t, registers.length);

    // Per-file lifecycle evidence: only a file that BOTH accumulates removable
    // state AND has a teardown-shaped API plausibly owes a per-register remover.
    const ownsLifecycle = ACCUMULATION_RE.test(code) && TEARDOWN_RE.test(code);
    const sites = registers.length > 0 ? indexCallableSites(code) : new Map<string, number>();
    const annotated = content.includes('@shrkcrft');
    const pairs: IRegistryPair[] = [];
    const missing: IRegistryMissingRemover[] = [];
    const oneShot: IRegistryIgnored[] = [];
    const ign: IRegistryIgnored[] = [];
    for (const reg of registers) {
      t = clock('register');
      if (t >= fileDeadline) return abandon('removers', t, registers.length);
      const ann = annotated ? findIgnoreAnnotations(content, reg.name) : { ignore: false };
      if (ann.ignore) {
        ign.push({
          registerName: reg.name,
          file,
          line: reg.line,
          reason: ann.reason ?? 'ignored',
          ...(ann.managedBy ? { managedBy: ann.managedBy } : {}),
        });
        continue;
      }
      const candidates = expectedRemoverNames(reg.name);
      // Candidate PRIORITY order is preserved: the first expected name with a
      // callable site wins, exactly as the per-name loop it replaces.
      const removerName = candidates.find((n) => sites.has(n));
      if (removerName !== undefined) {
        pairs.push({
          registerName: reg.name,
          removerName,
          file,
          registerLine: reg.line,
          removerLine: lineAtOffset(lineStarts, sites.get(removerName)!),
        });
      } else if (ownsLifecycle) {
        missing.push({
          registerName: reg.name,
          expectedRemoverNames: candidates,
          file,
          line: reg.line,
          suggestion: `Add ${candidates[0]}() / ${candidates[1]}() / ${candidates[2]}() — or annotate with \`@shrkcrft lifecycle-ignore <reason>\` / \`@shrkcrft lifecycle-managed-by <name>\` if cleanup is owned elsewhere.`,
        });
      } else {
        // No teardown-shaped API in the file → one-shot / bootstrap registration.
        oneShot.push({
          registerName: reg.name,
          file,
          line: reg.line,
          reason: 'no teardown-shaped API in file — treated as one-shot bootstrap',
        });
      }
    }
    return { kind: 'judged', registers: registers.length, pairs, missing, oneShot, ignored: ign };
  }

  function step(): boolean {
    if (finished) return false;
    if (cursor >= end) {
      finished = true;
      return false;
    }
    const fileStart = clock('file');
    if (fileStart >= deadline) {
      timedOut = true;
      finished = true;
      return false;
    }
    const abs = files[cursor]!;
    const outcome = judgeFile(abs, relOf.get(abs)!, fileStart);
    switch (outcome.kind) {
      case 'generated':
        generated += 1;
        break;
      case 'missing':
        missingCount += 1;
        break;
      case 'oversized':
        oversized.push(relOf.get(abs)!);
        break;
      case 'unreadable':
        unreadable.push(relOf.get(abs)!);
        break;
      case 'over-budget':
        overBudget.push(outcome.entry);
        if (outcome.entry.deadline === 'run') {
          // The RUN's deadline expired inside this file: stop, and leave the
          // cursor ON it so `--offset <nextOffset>` re-scans it.
          timedOut = true;
          finished = true;
          return false;
        }
        break;
      case 'judged':
        filesScanned += 1;
        registersFound += outcome.registers;
        matchedPairs.push(...outcome.pairs);
        missingRemovers.push(...outcome.missing);
        oneShotBootstrap.push(...outcome.oneShot);
        ignored.push(...outcome.ignored);
        break;
    }
    cursor += 1;
    return true;
  }

  function snapshot(options: { readonly interrupted?: boolean } = {}): IRegistryLifecycleReport {
    const interrupted = options.interrupted === true && cursor < end;
    const nextOffset = walkComplete && cursor < files.length ? cursor : undefined;
    const truncated = !walkComplete || cursor < files.length;
    // Deliberate narrowing only: a generated file, and one deleted mid-walk.
    // An over-cap file stays EXPECTED and is named unexamined below.
    const excludedCount = generated + missingCount;
    const expected = Math.max(0, files.length - start - excludedCount);
    const fileOverBudget = overBudget.filter((o) => o.deadline === 'file').map((o) => o.file);
    const remaining = files.slice(cursor).map((f) => relOf.get(f)!);
    const unexaminedAll = [...new Set([...fileOverBudget, ...unreadable, ...oversized, ...remaining])];
    const reason = coverageReason({
      walkComplete,
      interrupted,
      timedOut,
      capped: truncated,
      budgetMs,
      limit,
      perFileBudgetMs,
      cursor,
      processed: cursor - start,
      overBudgetCount: fileOverBudget.length,
      unreadableCount: unreadable.length,
      oversizedCount: oversized.length,
    });
    const coverage: IVerdictCoverage = {
      unit: 'files',
      expected,
      examined: filesScanned,
      root: walkRoot,
      ...(truncated ? { capped: true } : {}),
      ...(unexaminedAll.length > 0
        ? { unexamined: unexaminedAll.slice(0, UNEXAMINED_SHOWN), unexaminedTotal: unexaminedAll.length }
        : {}),
      ...(reason ? { reason } : {}),
    };
    const registrationCoverage: IVerdictCoverage = {
      unit: 'registrations',
      expected: registersFound,
      examined: registersFound,
      root: walkRoot,
      ...(registersFound === 0 ? { reason: 'no register* declaration in the examined files' } : {}),
    };
    const recommendations: string[] = [];
    if (missingRemovers.length > 0) {
      recommendations.push(
        `Run \`shrk check registry-lifecycle --json\` and add the matching remover(s), or document why not via a \`@shrkcrft lifecycle-ignore\` / \`@shrkcrft lifecycle-managed-by\` annotation.`,
      );
    }
    const settled = registryLifecycleVerdict({
      missingRemovers,
      coverage,
      registrationCoverage,
      ...(configCoverage ? { configCoverage } : {}),
    });
    return {
      schema: 'sharkcraft.registry-lifecycle/v1',
      filesScanned,
      totalFiles: files.length,
      truncated,
      timedOut,
      interrupted,
      walkComplete,
      changedOnly,
      ...(scope ? { scope } : {}),
      offset: start,
      limit,
      budgetMs,
      perFileBudgetMs,
      candidatesExamined: cursor - start,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      excludedFiles: { generated, missing: missingCount, oversized: [...oversized] },
      unreadableFiles: [...unreadable],
      overBudgetFiles: [...overBudget],
      skipDirs: skip.effective,
      droppedDefaultSkipDirs: skip.droppedDefaults,
      warnings: [...warnings],
      registersFound,
      matchedPairs: [...matchedPairs],
      missingRemovers: [...missingRemovers],
      oneShotBootstrap: [...oneShotBootstrap],
      ignored: [...ignored],
      recommendations,
      coverage,
      registrationCoverage,
      ...(configCoverage ? { configCoverage } : {}),
      verdict: settled.verdict,
      ...(settled.reason !== undefined ? { verdictReason: settled.reason } : {}),
    };
  }

  return { step, snapshot };
}

/** Why the files coverage fell short — the continuation lives here, so the verdict line carries it. */
function coverageReason(s: {
  walkComplete: boolean;
  interrupted: boolean;
  timedOut: boolean;
  capped: boolean;
  budgetMs: number;
  limit: number;
  perFileBudgetMs: number;
  cursor: number;
  processed: number;
  overBudgetCount: number;
  unreadableCount: number;
  oversizedCount: number;
}): string | undefined {
  if (!s.walkComplete) {
    return `the ${s.budgetMs} ms wall-clock budget expired during the tree walk, before every candidate was found; narrow with --scope <dir> or raise --budget-ms`;
  }
  if (s.interrupted) return `interrupted by a signal after ${s.processed} candidate(s); continue with --offset ${s.cursor}`;
  if (s.timedOut) {
    return `the ${s.budgetMs} ms wall-clock budget expired after ${s.processed} candidate(s); continue with --offset ${s.cursor}, or raise --budget-ms`;
  }
  if (s.capped) return `--limit ${s.limit} reached; continue with --offset ${s.cursor} (or --limit 0 for an uncapped run)`;
  const parts: string[] = [];
  if (s.overBudgetCount > 0) parts.push(`over the per-file budget (${s.perFileBudgetMs} ms) and never judged`);
  if (s.unreadableCount > 0) parts.push('unreadable');
  if (s.oversizedCount > 0) parts.push(`over the ${LIFECYCLE_READ_CAP} lifecycle read cap, so never judged`);
  if (parts.length === 0) return undefined;
  // The budget remedy only reaches what a budget stopped; an over-cap file is
  // never judged whatever the budget.
  const remedy = s.overBudgetCount > 0 || s.unreadableCount > 0 ? ' — raise --budget-ms or narrow with --scope <dir>' : '';
  return `${parts.join(' or ')}${remedy}`;
}

/**
 * THE lifecycle verdict. Both CLI verbs settle the same coverage records
 * through `buildGateEnvelope`, and the MCP tool reads this — every surface
 * answers from `coverageShortfall`, never a re-derived ternary.
 *
 *   - a missing remover in the examined scope → `fail` (a real violation is
 *     real however much of the tree was examined);
 *   - otherwise any coverage shortfall (a config that failed to load, a cap,
 *     an expired budget, a signal, an over-budget or unreadable file, nothing
 *     in scope, no registrations) → `not-verified`, with the shortfall as the
 *     reason;
 *   - otherwise `pass`.
 */
export function registryLifecycleVerdict(
  report: Pick<IRegistryLifecycleReport, 'missingRemovers' | 'coverage' | 'registrationCoverage' | 'configCoverage'>,
): { readonly verdict: RegistryLifecycleVerdict; readonly reason?: string } {
  if (report.missingRemovers.length > 0) {
    return {
      verdict: 'fail',
      reason: `${report.missingRemovers.length} register* declaration(s) with no matching remover`,
    };
  }
  // The config shortfall FIRST: when the configured scope was never applied,
  // every other count describes the wrong scope.
  const gap =
    (report.configCoverage ? coverageShortfall(report.configCoverage) : undefined) ??
    coverageShortfall(report.coverage) ??
    coverageShortfall(report.registrationCoverage);
  if (gap !== undefined) return { verdict: 'not-verified', reason: gap };
  return { verdict: 'pass' };
}

/** Synchronous scan: drives {@link createRegistryLifecycleScan} to the end. */
export function buildRegistryLifecycleReport(input: IRegistryLifecycleInput): IRegistryLifecycleReport {
  const scan = createRegistryLifecycleScan(input);
  while (scan.step()) {
    // one candidate per step — the budget is checked inside each
  }
  return scan.snapshot();
}

/**
 * Signal-aware scan: the same {@link IRegistryLifecycleScan.step}, yielding to
 * the event loop between files so a SIGTERM / SIGINT handler can run. An
 * aborted run returns the partial report with `interrupted: true` and a
 * `nextOffset` that continues it. Latency is bounded by one (linear) file.
 */
export async function runRegistryLifecycleScan(
  input: IRegistryLifecycleInput,
  options: { readonly signal?: AbortSignal } = {},
): Promise<IRegistryLifecycleReport> {
  const scan = createRegistryLifecycleScan(input);
  for (;;) {
    if (options.signal?.aborted) return scan.snapshot({ interrupted: true });
    if (!scan.step()) return scan.snapshot();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function renderRegistryLifecycleReportText(
  report: IRegistryLifecycleReport,
  options: IRegistryLifecycleRenderOptions = {},
): string {
  const command = options.command ?? 'shrk check registry-lifecycle';
  const lines: string[] = [];
  lines.push('=== Registry lifecycle ===');
  if (report.scope) lines.push(`  scope             ${report.scope}`);
  if (report.changedOnly) lines.push('  scope             changed-only');
  lines.push(
    `  candidates        ${report.totalFiles}` + (report.offset > 0 ? ` (this run starts at offset ${report.offset})` : ''),
  );
  lines.push(`  files scanned     ${report.filesScanned} of ${report.coverage.expected}`);
  lines.push(`  registers found   ${report.registersFound}`);
  lines.push(`  matched pairs     ${report.matchedPairs.length}`);
  lines.push(`  missing removers  ${report.missingRemovers.length}`);
  lines.push(`  one-shot bootstrap ${report.oneShotBootstrap.length}`);
  lines.push(`  ignored           ${report.ignored.length}`);
  const ex = report.excludedFiles;
  if (ex.generated + ex.missing > 0) {
    const parts: string[] = [];
    if (ex.generated > 0) parts.push(`${ex.generated} generated`);
    if (ex.missing > 0) parts.push(`${ex.missing} deleted`);
    lines.push(`  excluded          ${parts.join(', ')}`);
  }
  // An over-cap file is UNEXAMINED (it is in the coverage's expected scope),
  // never "excluded": listed with the other files that were never judged.
  for (const o of ex.oversized.slice(0, 20)) {
    lines.push(`  ! over read cap   ${o} — over the ${LIFECYCLE_READ_CAP} lifecycle read cap, never judged`);
  }
  for (const o of report.overBudgetFiles) {
    lines.push(
      `  ! over budget     ${o.file} — ${o.phase} phase, ${o.elapsedMs} ms (${o.deadline === 'run' ? "the run's budget" : `the ${report.perFileBudgetMs} ms per-file budget`}); ${o.registersSeen} register(s) seen, none judged`,
    );
  }
  for (const u of report.unreadableFiles.slice(0, 20)) lines.push(`  ! unreadable      ${u}`);
  for (const w of report.warnings) lines.push(`  ! ${w}`);

  // Scope facts — what was NOT examined and how to reach it. The verdict line
  // itself is the caller's (the CLI settles it through the gate envelope).
  const remainingCount = report.totalFiles - (report.offset + report.candidatesExamined);
  const resume = report.nextOffset !== undefined ? `${command} --offset ${report.nextOffset}` : undefined;
  if (report.coverage.expected === 0 && report.walkComplete) {
    lines.push('');
    lines.push(
      report.changedOnly
        ? '  ! 0 files in the changed scope — nothing to judge.'
        : '  ! 0 candidate files in scope — nothing to judge.',
    );
  } else if (report.registersFound === 0 && report.filesScanned > 0 && !report.truncated) {
    lines.push('');
    lines.push('  ! 0 register* declarations in the examined files — nothing to judge.');
  }
  if (!report.walkComplete) {
    lines.push('');
    lines.push(
      `  ! wall-clock budget (${report.budgetMs} ms) expired during the tree walk — ${report.totalFiles} candidate(s) found so far; narrow with --scope <dir> or raise --budget-ms.`,
    );
  } else if (report.interrupted && resume) {
    lines.push('');
    lines.push(
      `  ! INTERRUPTED — partial results (scanned ${report.filesScanned}/${report.coverage.expected}); continue with ${resume}`,
    );
  } else if (report.timedOut && resume) {
    lines.push('');
    lines.push(
      `  ! wall-clock budget (${report.budgetMs} ms) hit — scanned ${report.filesScanned}/${report.coverage.expected}; continue with ${resume} (or raise --budget-ms)`,
    );
  } else if (resume) {
    lines.push('');
    lines.push(
      `  ! capped — scanned ${report.candidatesExamined} of ${report.totalFiles - report.offset} candidate files (cap --limit ${report.limit}); ${remainingCount} unexamined. Continue: ${resume}   (or --limit 0 for an uncapped run)`,
    );
  }
  lines.push('');
  if (report.missingRemovers.length > 0) {
    lines.push('Missing removers:');
    for (const m of report.missingRemovers.slice(0, 50)) {
      lines.push(`  ${m.file}:${m.line}  ${m.registerName}`);
      lines.push(`      ↳ ${m.suggestion}`);
    }
  }
  if (report.ignored.length > 0) {
    lines.push('');
    lines.push('Ignored:');
    for (const i of report.ignored.slice(0, 20)) {
      lines.push(`  ${i.file}:${i.line}  ${i.registerName}  (${i.reason}${i.managedBy ? `; managed-by ${i.managedBy}` : ''})`);
    }
  }
  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push('Recommendations:');
    for (const r of report.recommendations) lines.push(`  • ${r}`);
  }
  return lines.join('\n') + '\n';
}
