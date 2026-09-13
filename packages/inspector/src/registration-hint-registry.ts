/**
 * Registration hint registry. Pack- and local-contributed hints
 * surface downstream registration steps that constructs typically need
 * (composer wiring, route table entries, capability registration, etc.).
 *
 * The engine ships zero hints; every entry comes from a contribution.
 *
 * Read-only: hints can be listed, fetched by id, validated, and previewed
 * against the live file system, but the engine never auto-applies them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  normalizeRegistrationHint,
  validateRegistrationHint,
  type IRegistrationHint,
  type IRegistrationHintInput,
  type IRegistrationHintOperation,
} from '@shrkcrft/plugin-api';
import { SKIP_DIRS } from '@shrkcrft/boundaries';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  DEAD_SELECTOR_CAUSES,
  importModuleViaLoader,
  MARKABLE_UNIT_LISTS,
  MarkableUnitList,
  normalizeUnitList,
  normalizeUnitScalar,
  qualifyListPath,
  qualifyUnitMarks,
  readContributionExport,
  RejectionCause,
  settleUnitLiveness,
  UnitDeadCause,
  UnitDeadWeight,
  UnitLivenessState,
  unitProblemsOf,
  type IContributionExport,
  type IRejectedEntry,
  type ISettledUnitLiveness,
  type IUnitLiveness,
  type IUnitMark,
  type IUnitObservation,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import { substitutePlaceholders } from './substitute-placeholders.ts';
import { RegistrationHintDiscoveryStatus } from './registration-hint-discovery-status.ts';

export const REGISTRATION_HINT_REGISTRY_SCHEMA = 'sharkcraft.registration-hint-registry/v1';

export enum RegistrationHintSource {
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

export interface IRegistrationHintEntry {
  readonly hint: IRegistrationHint;
  readonly source: RegistrationHintSource;
  readonly packageName?: string;
  readonly sourceFile: string;
}

export interface IRegistrationHintDoctorIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly hintId?: string;
  readonly source?: string;
  /** What the finding is about: the dead selector, the missing anchor, `(discovery)`. */
  readonly target?: string;
}

async function importHints(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['registrationHints'] });
}

/**
 * THE registration-hint acceptance predicate (round 12, 12.1): every issue of
 * `validateRegistrationHint`, `<field>: <message>` — `[]` means accepted.
 */
export function registrationHintRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const v = validateRegistrationHint(raw as IRegistrationHint);
  if (v.valid) return [];
  return v.issues.length > 0 ? v.issues.map((i) => `${i.field}: ${i.message}`) : ['(entry): failed validation'];
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['registration-hints.ts', 'registration-hints/index.ts']) {
    const abs = nodePath.join(dir, name);
    if (existsSync(abs)) out.push(abs);
  }
  // More hint files come from pack manifests (`registrationHintFiles`, loaded
  // below) — there is no local-config key for them; the strict config schema
  // rejects one, so a local read here could never be reached.
  return out;
}

export async function loadRegistrationHints(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IRegistrationHintEntry[];
  issues: readonly IRegistrationHintDoctorIssue[];
  /** Every declared hint the loader refused — invalid or a duplicate id (round 12, 12.1). */
  rejected: readonly IRejectedEntry[];
}> {
  const entries: IRegistrationHintEntry[] = [];
  const issues: IRegistrationHintDoctorIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const seen = new Map<string, string>();

  const ingest = (
    raw: unknown,
    source: RegistrationHintSource,
    packageName: string | undefined,
    sourceFile: string,
    at: Pick<IRejectedEntry, 'file' | 'index' | 'exportName'>,
  ): void => {
    const rawId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    const hintId = typeof rawId === 'string' ? rawId : undefined;
    // THE acceptance predicate, then THE normaliser (round 13): markers in
    // `discovery` become plain strings + the `expectEmptyUnits` ledger, stamped
    // with the contributing pack. A normaliser refusal is a rejection too —
    // never a crash further down (`glob.includes is not a function`).
    const invalid = registrationHintRejectionReasons(raw);
    const normalized =
      invalid.length === 0 ? normalizeRegistrationHint(raw as IRegistrationHintInput, packageName) : undefined;
    const reasons =
      invalid.length > 0 ? invalid : normalized !== undefined && !normalized.ok ? unitProblemsOf(normalized.error) : [];
    if (normalized === undefined || !normalized.ok) {
      for (const r of reasons) {
        issues.push({ severity: 'error', code: 'invalid-hint', message: r, hintId, source: sourceFile });
      }
      rejected.push({ ...at, ...(hintId !== undefined ? { entryId: hintId } : {}), reasons, cause: RejectionCause.Invalid });
      return;
    }
    const hint = normalized.value;
    const prev = seen.get(hint.id);
    if (prev !== undefined) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Registration hint "${hint.id}" already loaded; skipping ${sourceFile}.`,
        hintId: hint.id,
        source: sourceFile,
      });
      rejected.push({
        ...at,
        entryId: hint.id,
        reasons: [`id: "${hint.id}" is already declared in ${prev}`],
        cause: RejectionCause.DuplicateId,
      });
      return;
    }
    seen.set(hint.id, sourceFile);
    entries.push({
      hint,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };
  const ingestAll = (
    exp: IContributionExport,
    file: string,
    source: RegistrationHintSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    exp.items.forEach((h, i) =>
      ingest(h, source, packageName, sourceFile, {
        file,
        index: exp.single ? -1 : i,
        ...(exp.exportName ? { exportName: exp.exportName } : {}),
      }),
    );
  };

  for (const file of localFiles(inspection)) {
    try {
      const exp = await importHints(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      ingestAll(exp, file, RegistrationHintSource.Local, undefined, rel);
    } catch (e) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `Failed to load ${file}: ${(e as Error).message}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as { registrationHintFiles?: readonly string[] };
    for (const rel of contributions.registrationHintFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${rel} but file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        ingestAll(await importHints(file), file, RegistrationHintSource.Pack, pack.packageName, rel);
      } catch (e) {
        issues.push({
          severity: 'warning',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  return { entries, issues, rejected };
}

export async function listRegistrationHints(
  inspection: ISharkcraftInspection,
): Promise<readonly IRegistrationHintEntry[]> {
  const { entries } = await loadRegistrationHints(inspection);
  return entries;
}

export async function getRegistrationHint(
  inspection: ISharkcraftInspection,
  hintId: string,
): Promise<IRegistrationHintEntry | null> {
  const entries = await listRegistrationHints(inspection);
  return entries.find((e) => e.hint.id === hintId) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

export interface IRegistrationHintPreviewOperation {
  readonly kind: IRegistrationHintOperation['kind'];
  readonly anchor?: string;
  readonly snippet?: string;
  /** Pretty-printed description for human review. */
  readonly description: string;
}

export interface IRegistrationHintPreview {
  readonly schema: 'sharkcraft.registration-hint-preview/v1';
  readonly hintId: string;
  readonly title: string;
  readonly targetFile: string | null;
  readonly candidates: readonly string[];
  /** True when discovery is ambiguous (multiple candidates) or no file matches. */
  readonly ambiguous: boolean;
  readonly requiresHumanReview: boolean;
  readonly operations: readonly IRegistrationHintPreviewOperation[];
  readonly missingVariables: readonly string[];
  readonly safetyNotes: readonly string[];
  readonly validationCommands: readonly string[];
  readonly nextCommand: string;
  /** Set when the discovery walk hit its directory cap: `candidates` is incomplete. */
  readonly discoveryCapped?: true;
}

export interface IRegistrationHintPreviewOptions {
  readonly variables?: Readonly<Record<string, string>>;
}

export async function previewRegistrationHint(
  inspection: ISharkcraftInspection,
  hintId: string,
  options: IRegistrationHintPreviewOptions = {},
): Promise<IRegistrationHintPreview | null> {
  const entry = await getRegistrationHint(inspection, hintId);
  if (!entry) return null;
  const { hint } = entry;
  const variables = options.variables ?? {};
  const missingVariables = (hint.variables ?? [])
    .filter((v) => v.required && variables[v.name] === undefined && v.defaultValue === undefined)
    .map((v) => v.name);

  // Discovery: prefer fixed targetFile when present, otherwise enumerate
  // candidates from globs on the live file system.
  let targetFile: string | null = null;
  let candidates: string[] = [];
  let discoveryCapped = false;
  if (hint.discovery.targetFile) {
    targetFile = hint.discovery.targetFile;
    candidates = [hint.discovery.targetFile];
  } else if (hint.discovery.targetGlobs && hint.discovery.targetGlobs.length > 0) {
    // THE discovery authority — the doctor classifies the same candidate set.
    const found = resolveRegistrationHintCandidates(inspection, hint);
    candidates = [...found.candidates];
    discoveryCapped = found.capped;
    if (candidates.length === 1 && !discoveryCapped) targetFile = candidates[0]!;
  }
  const ambiguous = candidates.length !== 1 || discoveryCapped;
  const requiresHumanReview = hint.requiresHumanReview === true || ambiguous;
  const renderedOps: IRegistrationHintPreviewOperation[] = hint.operations.map((op) => {
    const description = describeOp(op);
    const out: IRegistrationHintPreviewOperation = { kind: op.kind, description };
    if (op.anchor) (out as { anchor?: string }).anchor = op.anchor;
    if (op.snippet) (out as { snippet?: string }).snippet = substituteVars(op.snippet, variables);
    return out;
  });
  return {
    schema: 'sharkcraft.registration-hint-preview/v1',
    hintId,
    title: hint.title,
    targetFile,
    candidates,
    ambiguous,
    requiresHumanReview,
    operations: renderedOps,
    missingVariables,
    safetyNotes: hint.safetyNotes ?? [],
    validationCommands: hint.validationCommands ?? [],
    nextCommand: ambiguous
      ? `# Multiple candidates — pick one and apply manually.`
      : `# Preview only. Apply manually after human review.`,
    ...(discoveryCapped ? { discoveryCapped: true as const } : {}),
  };
}

/** Directories one glob's discovery walk visits before it reports `capped`. */
const DISCOVERY_DIR_CAP = 5000;

/** What THE discovery authority found for one hint. */
export interface IRegistrationHintCandidates {
  /** `fixed` = `discovery.targetFile`; `glob` = `discovery.targetGlobs`; `none` = neither. */
  readonly mode: 'fixed' | 'glob' | 'none';
  /** Distinct project-relative candidate files, in discovery order (a fixed target only when it exists). */
  readonly candidates: readonly string[];
  /** Per selector — the fixed `targetFile`, or each glob — how many files it matched. */
  readonly perGlob: readonly { readonly glob: string; readonly matched: number }[];
  /** True when a walk hit its directory cap: the candidate set is incomplete. */
  readonly capped: boolean;
}

/** One glob against the live tree: the preview's own dialect (`*`, `**`, else literal). */
function walkDiscoveryGlob(projectRoot: string, glob: string): { files: string[]; capped: boolean } {
  if (!glob.includes('*')) {
    return { files: existsSync(nodePath.join(projectRoot, glob)) ? [glob] : [], capped: false };
  }
  const baseSegments: string[] = [];
  for (const seg of glob.split('/')) {
    if (seg.includes('*')) break;
    baseSegments.push(seg);
  }
  const base = baseSegments.length > 0 ? nodePath.join(projectRoot, ...baseSegments) : projectRoot;
  // Replace `**` with a placeholder BEFORE escaping; then escape special chars;
  // then convert single `*` and the placeholder.
  const escaped = glob
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*');
  let re: RegExp;
  try {
    re = new RegExp('^' + escaped + '$');
  } catch {
    return { files: [], capped: false };
  }
  if (!existsSync(base)) return { files: [], capped: false };
  const files: string[] = [];
  const stack: string[] = [base];
  let visited = 0;
  while (stack.length > 0) {
    // A truncated walk is REPORTED — a zero from a capped walk is not a dead glob.
    if (visited >= DISCOVERY_DIR_CAP) return { files, capped: true };
    const dir = stack.pop()!;
    visited += 1;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const name = String(e.name);
        const next = nodePath.join(dir, name);
        // The shared vendor/build/VCS skip list: node_modules is never walked.
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(name)) stack.push(next);
        } else if (e.isFile()) {
          const rel = nodePath.relative(projectRoot, next).split(nodePath.sep).join('/');
          if (re.test(rel)) files.push(rel);
        }
      }
    } catch {
      // an unreadable directory contributes nothing
    }
  }
  return { files, capped: false };
}

/**
 * THE discovery authority for a registration hint: `registrations preview`
 * acts on it and the doctor classifies it, so "what would this hint target?"
 * has one answer. A fixed `targetFile` counts as a candidate only when it
 * exists (preview still names it either way).
 */
export function resolveRegistrationHintCandidates(
  inspection: ISharkcraftInspection,
  hint: IRegistrationHint,
): IRegistrationHintCandidates {
  // Idempotent defensive normalisation (round 13): a loaded hint is plain
  // already; a hand-built one carrying `{ pattern, expectEmpty }` markers is
  // read by its unit instead of crashing the walk (`glob.includes`).
  const discovery = hint.discovery ?? {};
  const fileUnit =
    discovery.targetFile !== undefined ? normalizeUnitScalar(discovery.targetFile, TARGET_FILE) : undefined;
  const targetFile = fileUnit?.ok ? fileUnit.value.unit : undefined;
  const globUnits = discovery.targetGlobs !== undefined ? normalizeUnitList(discovery.targetGlobs, TARGET_GLOBS) : undefined;
  const targetGlobs = globUnits?.ok
    ? globUnits.value.units
    : (discovery.targetGlobs ?? []).filter((g): g is string => typeof g === 'string');
  if (targetFile) {
    const exists = existsSync(nodePath.join(inspection.projectRoot, targetFile));
    return {
      mode: 'fixed',
      candidates: exists ? [targetFile] : [],
      perGlob: [{ glob: targetFile, matched: exists ? 1 : 0 }],
      capped: false,
    };
  }
  if (!targetGlobs || targetGlobs.length === 0) {
    return { mode: 'none', candidates: [], perGlob: [], capped: false };
  }
  const all: string[] = [];
  const perGlob: { glob: string; matched: number }[] = [];
  let capped = false;
  for (const glob of targetGlobs) {
    const r = walkDiscoveryGlob(inspection.projectRoot, glob);
    perGlob.push({ glob, matched: r.files.length });
    all.push(...r.files);
    capped = capped || r.capped;
  }
  return { mode: 'glob', candidates: [...new Set(all)], perGlob, capped };
}

function describeOp(op: IRegistrationHintOperation): string {
  switch (op.kind) {
    case 'ensure-import':
      return `ensure-import from "${op.from ?? '?'}"${op.symbols ? ` { ${op.symbols.join(', ')} }` : ''}`;
    case 'insert-enum-entry':
      return `insert-enum-entry ${op.enumName ?? '?'}`;
    case 'insert-object-entry':
      return `insert-object-entry ${op.objectName ?? '?'}`;
    case 'insert-before-closing-brace':
      return `insert-before-closing-brace of "${op.containerName ?? '?'}"`;
    case 'insert-between-anchors':
      return `insert-between-anchors "${op.beginAnchor ?? '?'}" .. "${op.endAnchor ?? '?'}"`;
    case 'insert-after':
      return `insert-after anchor "${op.anchor ?? '?'}"`;
    case 'insert-before':
      return `insert-before anchor "${op.anchor ?? '?'}"`;
    case 'append':
      return `append snippet`;
    case 'export':
      return `export${op.symbols ? ` { ${op.symbols.join(', ')} }` : ''} from "${op.from ?? '?'}"`;
  }
}

/** THE placeholder substitution, shared with pack-helper plans. */
function substituteVars(snippet: string, vars: Readonly<Record<string, string>>): string {
  return substitutePlaceholders(snippet, vars);
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor
// ─────────────────────────────────────────────────────────────────────────────

/** One hint's discovery, classified — what `registrations doctor --json` lists per hint. */
export interface IRegistrationHintStatus {
  readonly id: string;
  readonly discovery: IRegistrationHintCandidates['mode'];
  readonly candidates: number;
  readonly status: RegistrationHintDiscoveryStatus;
  readonly source: string;
}

/** The registration-hint doctor: load issues + per-hint discovery + coverage. */
export interface IRegistrationHintDoctorReport {
  readonly issues: readonly IRegistrationHintDoctorIssue[];
  readonly hints: readonly IRegistrationHintStatus[];
  readonly totals: Readonly<{
    hints: number;
    verified: number;
    ambiguous: number;
    dead: number;
    unverified: number;
    intendedEmpty: number;
  }>;
  /**
   * `discovery selectors` — THE settle's records (round 13): record A over every
   * fixed `targetFile` and every glob not marked intended-empty (examined =
   * those matching at least one file; a dead selector is a shortfall, so "0
   * issues" can never be read as "every hint verified"), and — when a marked
   * selector matches nothing — record B, its printed `acceptedBy: expectEmpty`
   * acceptance.
   */
  readonly coverage: readonly IVerdictCoverage[];
  /** Every UNMARKED dead selector, labelled `registration hint <hint>: <selector>` — THE settle's `dead`. */
  readonly deadUnits: readonly string[];
  /**
   * THE settle over every hint's discovery selectors (round 13): each unit's
   * state (live / dead / intended-empty / went-live / unproven) and mark —
   * what `--fail-on-dead-units` decides on (`selectorUnitFails`).
   */
  readonly liveness: ISettledUnitLiveness;
}

const TARGET_GLOBS = MARKABLE_UNIT_LISTS[MarkableUnitList.RegistrationHintTargetGlobs].listPath;
const TARGET_FILE = MARKABLE_UNIT_LISTS[MarkableUnitList.RegistrationHintTargetFile].listPath;

/** The list a discovery mode judges — a marker on the other list (a glob beside a fixed target) is never read. */
function judgedList(mode: IRegistrationHintCandidates['mode']): string | undefined {
  return mode === 'fixed' ? TARGET_FILE : mode === 'glob' ? TARGET_GLOBS : undefined;
}

/**
 * One observation per selector THE discovery authority judged: the fixed
 * target, or each glob. Existence and liveness are one predicate here (a file
 * matches, or none does); a zero from a capped walk is unproven, never dead.
 */
function discoveryObservations(hint: IRegistrationHint, found: IRegistrationHintCandidates): IUnitObservation[] {
  if (found.mode === 'none') {
    return [
      {
        list: qualifyListPath(hint.id, 'discovery'),
        unit: 'no discovery',
        label: `${hint.id}: no discovery`,
        exists: false,
        live: false,
        cause: UnitDeadCause.Defect,
        deadReason: 'declares neither discovery.targetFile nor discovery.targetGlobs, so it can never target a file',
      },
    ];
  }
  const fixed = found.mode === 'fixed';
  const list = qualifyListPath(hint.id, fixed ? TARGET_FILE : TARGET_GLOBS);
  return found.perGlob.map((g) => {
    const seen = g.matched > 0 ? true : found.capped ? undefined : false;
    return {
      list,
      unit: g.glob,
      label: `${hint.id}: ${g.glob}`,
      exists: seen,
      live: seen,
      matched: g.matched,
      liveBecause: fixed ? 'the target file exists' : `matches ${g.matched} file(s)`,
      deadReason: fixed ? 'the file is missing' : 'matched no file',
    };
  });
}

const STATUS_TOTAL: Readonly<
  Record<RegistrationHintDiscoveryStatus, 'verified' | 'ambiguous' | 'dead' | 'unverified' | 'intendedEmpty'>
> = {
  [RegistrationHintDiscoveryStatus.Verified]: 'verified',
  [RegistrationHintDiscoveryStatus.Ambiguous]: 'ambiguous',
  [RegistrationHintDiscoveryStatus.Dead]: 'dead',
  [RegistrationHintDiscoveryStatus.Unverified]: 'unverified',
  [RegistrationHintDiscoveryStatus.IntendedEmpty]: 'intendedEmpty',
};

/** The anchor check, the same for a fixed target and a single glob candidate. */
function checkAnchors(
  inspection: ISharkcraftInspection,
  entry: IRegistrationHintEntry,
  relPath: string,
  out: IRegistrationHintDoctorIssue[],
): void {
  let content: string;
  try {
    content = readFileSync(nodePath.join(inspection.projectRoot, relPath), 'utf8');
  } catch {
    return;
  }
  for (const op of entry.hint.operations) {
    if (!op.anchor || content.includes(op.anchor)) continue;
    out.push({
      severity: 'info',
      code: 'anchor-not-present',
      message: `Hint "${entry.hint.id}" expects anchor "${op.anchor}" in ${relPath} but it is missing today.`,
      hintId: entry.hint.id,
      source: entry.sourceFile,
      target: op.anchor,
    });
  }
}

/**
 * Verify every hint's discovery against the live tree through THE discovery
 * authority. Fixed targets used to be the only ones checked; glob discovery —
 * used precisely when the author was unsure of the target — got none, so a
 * dead, an ambiguous and an anchor-less glob hint all read "OK".
 */
export async function buildRegistrationHintDoctorReport(
  inspection: ISharkcraftInspection,
): Promise<IRegistrationHintDoctorReport> {
  const { issues: loadIssues, entries } = await loadRegistrationHints(inspection);
  const issues: IRegistrationHintDoctorIssue[] = [...loadIssues];
  const hints: IRegistrationHintStatus[] = [];
  const totals = { hints: entries.length, verified: 0, ambiguous: 0, dead: 0, unverified: 0, intendedEmpty: 0 };
  // Observe every selector of every hint, then settle them ONCE through THE
  // liveness authority (round 13): the state, the dead list and both coverage
  // records (the shortfall and the expectEmpty acceptance) come from it.
  const found = entries.map((e) => resolveRegistrationHintCandidates(inspection, e.hint));
  const observations: IUnitObservation[] = [];
  const marks: IUnitMark[] = [];
  const spans: { readonly start: number; readonly end: number }[] = [];
  entries.forEach((e, i) => {
    const f = found[i]!;
    const own = discoveryObservations(e.hint, f);
    spans.push({ start: observations.length, end: observations.length + own.length });
    observations.push(...own);
    const list = judgedList(f.mode);
    marks.push(...qualifyUnitMarks((e.hint.expectEmptyUnits ?? []).filter((m) => m.list === list), e.hint.id));
  });
  const capped = found.some((f) => f.capped);
  const liveness = settleUnitLiveness({
    subject: 'registration hints',
    unitLabel: MARKABLE_UNIT_LISTS[MarkableUnitList.RegistrationHintTargetGlobs].unitLabel,
    weight: UnitDeadWeight.Coverage,
    observations,
    marks,
    deadSummary: 'matched no file',
    ...(capped ? { capped: true, cappedReason: `a discovery walk hit its ${DISCOVERY_DIR_CAP}-directory cap` } : {}),
  });
  entries.forEach((e, i) => {
    const f = found[i]!;
    const span = spans[i]!;
    const units = liveness.units.slice(span.start, span.end);
    const push = (
      severity: IRegistrationHintDoctorIssue['severity'],
      code: string,
      message: string,
      target = '(discovery)',
    ): void => {
      issues.push({ severity, code, message, hintId: e.hint.id, source: e.sourceFile, target });
    };
    for (const u of units) reportDiscoveryUnit(e.hint.id, f.mode, u, push);
    let status: RegistrationHintDiscoveryStatus;
    if (f.mode === 'none') {
      status = RegistrationHintDiscoveryStatus.Dead;
    } else if (f.mode === 'fixed') {
      const u = units[0];
      if (u?.state === UnitLivenessState.IntendedEmpty) {
        status = RegistrationHintDiscoveryStatus.IntendedEmpty;
      } else if (f.candidates.length === 0) {
        status = RegistrationHintDiscoveryStatus.Dead;
      } else {
        checkAnchors(inspection, e, f.candidates[0]!, issues);
        status = RegistrationHintDiscoveryStatus.Verified;
      }
    } else if (f.capped) {
      push('info', 'discovery-unverified', `Registration hint "${e.hint.id}" discovery walk hit its ${DISCOVERY_DIR_CAP}-directory cap, so its candidate set is incomplete — NOT verified.`);
      status = RegistrationHintDiscoveryStatus.Unverified;
    } else if (f.candidates.length === 0) {
      // A hint whose every empty selector is intended-empty is not dead: it
      // targets what the adopting app does not have yet (accepted, printed).
      if (units.some((u) => u.state === UnitLivenessState.Dead)) {
        push('warning', 'discovery-dead', `Registration hint "${e.hint.id}" discovery (${f.perGlob.map((g) => g.glob).join(', ')}) matches no file, so it can never target one — ${DEAD_SELECTOR_CAUSES}.`);
        status = RegistrationHintDiscoveryStatus.Dead;
      } else {
        status = RegistrationHintDiscoveryStatus.IntendedEmpty;
      }
    } else if (f.candidates.length > 1) {
      push('info', 'discovery-ambiguous', `Registration hint "${e.hint.id}" discovery matches ${f.candidates.length} files (${f.candidates.slice(0, 5).join(', ')}${f.candidates.length > 5 ? ', …' : ''}); preview will not guess.`);
      status = RegistrationHintDiscoveryStatus.Ambiguous;
    } else {
      checkAnchors(inspection, e, f.candidates[0]!, issues);
      status = RegistrationHintDiscoveryStatus.Verified;
    }
    totals[STATUS_TOTAL[status]] += 1;
    hints.push({ id: e.hint.id, discovery: f.mode, candidates: f.candidates.length, status, source: e.sourceFile });
  });
  return {
    issues,
    hints,
    totals,
    coverage: liveness.coverage,
    deadUnits: liveness.dead.map((u) => `registration hint ${u.label}`),
    liveness,
  };
}

/**
 * The per-selector issue for one SETTLED unit: a dead selector is a warning
 * (the unmarked dead list), an intended-empty one and a stale marker are info
 * (the acceptance rides in coverage; a went-live marker fails only through
 * `selectorUnitFails` under `--fail-on-dead-units`, never through `--strict`).
 */
function reportDiscoveryUnit(
  hintId: string,
  mode: IRegistrationHintCandidates['mode'],
  u: IUnitLiveness,
  push: (severity: IRegistrationHintDoctorIssue['severity'], code: string, message: string, target?: string) => void,
): void {
  if (u.state === UnitLivenessState.Dead) {
    if (mode === 'none') {
      push('warning', 'discovery-missing', `Registration hint "${hintId}" ${u.deadReason ?? 'has no discovery'}.`);
    } else if (mode === 'fixed') {
      push('warning', 'target-file-missing', `Registration hint "${hintId}" targets ${u.unit} but the file is missing — ${DEAD_SELECTOR_CAUSES}.`, u.unit);
    } else {
      push('warning', 'discovery-glob-matched-nothing', `Registration hint "${hintId}" discovery glob "${u.unit}" matches no file — ${DEAD_SELECTOR_CAUSES}.`, u.unit);
    }
  } else if (u.state === UnitLivenessState.IntendedEmpty || u.state === UnitLivenessState.WentLive) {
    // THE settle's sentence, after the selector it is about.
    const selector = mode === 'fixed' ? `target file ${u.unit}` : `discovery glob "${u.unit}"`;
    push(
      'info',
      u.state === UnitLivenessState.IntendedEmpty ? 'discovery-intended-empty' : 'discovery-went-live',
      `Registration hint "${hintId}" ${selector} — ${u.message}`,
      u.unit,
    );
  }
}

/** Load issues + discovery findings — {@link buildRegistrationHintDoctorReport}'s issue list. */
export async function listRegistrationHintIssues(
  inspection: ISharkcraftInspection,
): Promise<readonly IRegistrationHintDoctorIssue[]> {
  return (await buildRegistrationHintDoctorReport(inspection)).issues;
}
