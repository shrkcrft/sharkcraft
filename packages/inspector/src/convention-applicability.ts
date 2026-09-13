/**
 * THE convention applicability authority (round 15, 15.1).
 *
 * `IConventionAppliesTo` declares five filters; before this only `fileGlobs`
 * was read — by two different matchers that disagreed (`conventions check`
 * compiled `src/**\/*.ts` so it missed `src/a.ts` and ignored `!`; the
 * rule-graph bridge dropped a convention with no `fileGlobs` that check
 * enforced on every file). `profileIds`, `frameworks` and `languages` were
 * validated, resolved by the doctor, and inert.
 *
 * Every surface now asks THIS module: `conventions check`, the rule-graph
 * bridge, MCP `prepare_agent_task`, and the `conventions list / get / explain`
 * display (which shows the answer and never hides an entry).
 *
 * Semantics — the pack-compatibility precedent (`pack-compatibility.ts`):
 *   - within a filter, ANY listed value matches;
 *   - EVERY declared filter must match;
 *   - an absent or empty filter imposes no constraint.
 *
 *   | filter           | level     | matches when                                              |
 *   |------------------|-----------|-----------------------------------------------------------|
 *   | `profileIds`     | workspace | a listed id is in `inspection.workspace.profiles`         |
 *   | `frameworks`     | workspace | a listed id is in `inspection.workspace.frameworks[].id`  |
 *   | `languages`      | file      | the file's language (`fileLanguageOf`) is listed          |
 *   | `fileGlobs`      | file      | `globListSelects(file, globs)` — `**` spans zero+ segments, `!` subtracts |
 *   | `constructKinds` | reserved  | always (not evaluated; the loader warns)                  |
 */
import { realpathSync } from 'node:fs';
import * as nodePath from 'node:path';
import { globListSelects } from '@shrkcrft/boundaries';
import { ConventionAppliesToFilter, type IConvention } from '@shrkcrft/plugin-api';
import { ConventionFilterLevel } from './convention-filter-level.ts';
import { fileLanguageOf } from './file-languages.ts';
import type { IConventionApplicability } from './i-convention-applicability.ts';
import type { IConventionApplicabilityReason } from './i-convention-applicability-reason.ts';
import type { IConventionScope } from './i-convention-scope.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/** Where each filter is decided — keyed by the enum, so a new filter without a level is a compile error. */
export const CONVENTION_FILTER_LEVELS: Readonly<Record<ConventionAppliesToFilter, ConventionFilterLevel>> = Object.freeze({
  [ConventionAppliesToFilter.ProfileIds]: ConventionFilterLevel.Workspace,
  [ConventionAppliesToFilter.Frameworks]: ConventionFilterLevel.Workspace,
  [ConventionAppliesToFilter.Languages]: ConventionFilterLevel.File,
  [ConventionAppliesToFilter.FileGlobs]: ConventionFilterLevel.File,
  [ConventionAppliesToFilter.ConstructKinds]: ConventionFilterLevel.Reserved,
});

/** Reasons are listed workspace filters first, then per-file, then reserved. */
const FILTER_ORDER: readonly ConventionAppliesToFilter[] = [
  ConventionAppliesToFilter.ProfileIds,
  ConventionAppliesToFilter.Frameworks,
  ConventionAppliesToFilter.Languages,
  ConventionAppliesToFilter.FileGlobs,
  ConventionAppliesToFilter.ConstructKinds,
];

/** The convention's declared values for `filter` — `[]` for an absent filter (or a non-list, which the loader refuses). */
export function declaredAppliesTo(convention: IConvention, filter: ConventionAppliesToFilter): readonly string[] {
  const value = (convention.appliesTo as Readonly<Record<string, unknown>> | undefined)?.[filter];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Per inspection: the project root with every symlink resolved, and each spelling a caller passed → its canonical one. */
interface ISpellingCache {
  readonly realRoot: string;
  readonly files: Map<string, string>;
}

/** One realpath per distinct file per inspection — `conventionScope` judges every file once per per-file filter. */
const SPELLINGS = new WeakMap<ISharkcraftInspection, ISpellingCache>();

/**
 * `abs` with every symlink resolved. A path that does not exist (a file a diff
 * deleted, a path a test names) resolves through its nearest existing ancestor,
 * so `/var/…/gone.ts` and `/private/var/…/gone.ts` still agree.
 */
function canonicalPath(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length > 0 ? nodePath.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = nodePath.dirname(head);
      if (parent === head) return abs;
      tail.push(nodePath.basename(head));
      head = parent;
    }
  }
}

/** The lexical spelling: project-relative for an absolute path, `/`-separated, no leading `./`. */
function lexicalFilePath(projectRoot: string, file: string): string {
  let f = nodePath.isAbsolute(file) ? nodePath.relative(projectRoot, file) : file;
  f = f.replace(/\\/g, '/');
  while (f.startsWith('./')) f = f.slice(2);
  return f;
}

/**
 * A file path as the per-file filters AND a rule's patterns read it:
 * project-relative, `/`-separated, no leading `./`. `checkConventionsAgainstFiles`
 * normalizes its file list through this once, so the scope test and every
 * `filePattern` / `expectMatch` / `forbidMatch` regex see ONE spelling of a file
 * (round 15 review: `--files ./src/a.ts` was covered by `fileGlobs: ['src/**']`
 * here and then failed `filePattern: '^src/'` on the raw `./src/a.ts` — a false hit).
 *
 * The spelling is REALPATH-canonical (round 15 follow-up, F9): the file and the
 * project root are both resolved through their symlinks before one is made
 * relative to the other, so a symlinked absolute path (`/link/src/a.ts` with
 * `/link → the project`, or macOS `/var/…` for a root at `/private/var/…`)
 * behaves exactly like its target — it read `../link/src/a.ts`, which no
 * `fileGlobs` selected, so the convention was silently not applicable. A path
 * whose target lies OUTSIDE the project (an in-project symlink to a sibling
 * checkout) keeps its lexical in-project spelling: that is where it is in scope.
 */
export function conventionFilePath(inspection: ISharkcraftInspection, file: string): string {
  let cache = SPELLINGS.get(inspection);
  if (!cache) {
    cache = { realRoot: canonicalPath(nodePath.resolve(inspection.projectRoot)), files: new Map() };
    SPELLINGS.set(inspection, cache);
  }
  const known = cache.files.get(file);
  if (known !== undefined) return known;
  const real = canonicalPath(nodePath.resolve(inspection.projectRoot, file));
  const rel = nodePath.relative(cache.realRoot, real);
  const inside = rel.length > 0 && rel !== '..' && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel);
  const spelled = inside ? rel.split(nodePath.sep).join('/') : lexicalFilePath(inspection.projectRoot, file);
  cache.files.set(file, spelled);
  return spelled;
}

function list(values: readonly string[]): string {
  return `[${values.join(', ')}]`;
}

function reason(
  filter: ConventionAppliesToFilter,
  declared: readonly string[],
  observed: readonly string[],
  matched: boolean,
  detail: string,
): IConventionApplicabilityReason {
  return {
    filter,
    level: CONVENTION_FILTER_LEVELS[filter],
    declared,
    observed,
    matched,
    message: `appliesTo.${filter} ${list(declared)}: ${detail}`,
  };
}

/** A workspace filter: any declared id among the detected ones. */
function judgeWorkspace(
  filter: ConventionAppliesToFilter,
  declared: readonly string[],
  detected: readonly string[],
  noun: string,
): IConventionApplicabilityReason {
  const hit = declared.filter((d) => detected.includes(d));
  if (hit.length > 0) return reason(filter, declared, detected, true, `detected ${hit.join(', ')}`);
  const seen = detected.length > 0 ? `detected: ${detected.join(', ')}` : `no ${noun} detected`;
  return reason(filter, declared, detected, false, `none detected (${seen})`);
}

function judge(
  filter: ConventionAppliesToFilter,
  declared: readonly string[],
  inspection: ISharkcraftInspection,
  file: string | undefined,
): IConventionApplicabilityReason {
  switch (filter) {
    case ConventionAppliesToFilter.ProfileIds:
      return judgeWorkspace(filter, declared, [...(inspection.workspace?.profiles ?? [])], 'profile');
    case ConventionAppliesToFilter.Frameworks:
      return judgeWorkspace(filter, declared, (inspection.workspace?.frameworks ?? []).map((f) => f.id), 'framework');
    case ConventionAppliesToFilter.ConstructKinds:
      return reason(filter, declared, [], true, 'reserved — not evaluated (the convention applies regardless)');
    case ConventionAppliesToFilter.Languages: {
      if (file === undefined) return reason(filter, declared, [], true, 'decided per file');
      const path = conventionFilePath(inspection, file);
      const language = fileLanguageOf(path)?.id;
      if (language === undefined) return reason(filter, declared, [], false, `${path} has no known language`);
      return reason(filter, declared, [language], declared.includes(language), `${path} is ${language}`);
    }
    case ConventionAppliesToFilter.FileGlobs: {
      if (file === undefined) return reason(filter, declared, [], true, 'decided per file');
      const path = conventionFilePath(inspection, file);
      const selected = globListSelects(path, declared);
      return reason(filter, declared, [path], selected, `${selected ? 'selects' : 'does not select'} ${path}`);
    }
  }
}

/**
 * Does `convention` apply here — to the workspace, and (given `file`) to that
 * file? Without `file` only the workspace filters decide; the per-file ones
 * are listed as `decided per file`. See the module doc for the table.
 */
export function conventionApplicability(
  convention: IConvention,
  inspection: ISharkcraftInspection,
  file?: string,
): IConventionApplicability {
  const reasons: IConventionApplicabilityReason[] = [];
  for (const filter of FILTER_ORDER) {
    const declared = declaredAppliesTo(convention, filter);
    if (declared.length === 0) continue;
    reasons.push(judge(filter, declared, inspection, file));
  }
  return { applicable: reasons.every((r) => r.matched), reasons };
}

/**
 * Which of `files` `convention` covers — per file through
 * {@link conventionApplicability}, so `conventions check` and the rule-graph
 * bridge (which both call this) cannot disagree.
 *
 * Not applicable when a workspace filter excludes it, or when `files` is
 * non-empty and no file passes the per-file filters (the per-file reasons
 * then count what each filter selected across the list). An EMPTY list keeps
 * a workspace-applicable convention applicable over nothing — the caller's own
 * empty-scope verdict decides that case.
 */
export function conventionScope(
  convention: IConvention,
  inspection: ISharkcraftInspection,
  files: readonly string[],
): IConventionScope {
  const conventionId = convention.id;
  const workspace = conventionApplicability(convention, inspection);
  if (!workspace.applicable) return { conventionId, applicable: false, files: [], reasons: workspace.reasons };
  const perFile = FILTER_ORDER.filter(
    (f) => CONVENTION_FILTER_LEVELS[f] === ConventionFilterLevel.File && declaredAppliesTo(convention, f).length > 0,
  );
  if (perFile.length === 0 || files.length === 0) {
    return { conventionId, applicable: true, files: [...files], reasons: workspace.reasons };
  }
  const covered: string[] = [];
  const admitted = new Map<ConventionAppliesToFilter, number>();
  const seen = new Map<ConventionAppliesToFilter, Set<string>>();
  for (const file of files) {
    const verdict = conventionApplicability(convention, inspection, file);
    if (verdict.applicable) covered.push(file);
    for (const r of verdict.reasons) {
      if (r.level !== ConventionFilterLevel.File) continue;
      if (r.matched) admitted.set(r.filter, (admitted.get(r.filter) ?? 0) + 1);
      if (r.filter === ConventionAppliesToFilter.Languages) {
        const s = seen.get(r.filter) ?? new Set<string>();
        for (const o of r.observed) s.add(o);
        seen.set(r.filter, s);
      }
    }
  }
  if (covered.length > 0) return { conventionId, applicable: true, files: covered, reasons: workspace.reasons };
  // No file passed: say, per declared per-file filter, what it selected across
  // the list. A filter that admitted NO file excluded the convention (matched:
  // false); one that admitted some did not (matched: true) — unless EVERY
  // per-file filter admitted some file and none passed them all: then the
  // intersection excluded it, and each filter says so. So the excluding reasons
  // are never empty and never name a filter that excluded nothing (round 15
  // review: `fileGlobs` read "selects 1 of 1 file(s)" as an excluding reason).
  const n = files.length;
  const intersectionOnly = perFile.every((filter) => (admitted.get(filter) ?? 0) > 0);
  const together = intersectionOnly ? ' — but no file in scope passes every per-file filter together' : '';
  const aggregated = perFile.map((filter) => {
    const declared = declaredAppliesTo(convention, filter);
    const count = admitted.get(filter) ?? 0;
    const matched = count > 0 && !intersectionOnly;
    if (filter === ConventionAppliesToFilter.Languages) {
      const langs = [...(seen.get(filter) ?? new Set<string>())].sort();
      const detail = `${count} of ${n} file(s) in scope ${count === 1 ? 'is' : 'are'} a listed language (seen: ${langs.length > 0 ? langs.join(', ') : 'none known'})${together}`;
      return reason(filter, declared, langs, matched, detail);
    }
    return reason(filter, declared, [], matched, `selects ${count} of ${n} file(s) in scope${together}`);
  });
  const workspaceReasons = workspace.reasons.filter((r) => r.level !== ConventionFilterLevel.File);
  return { conventionId, applicable: false, files: [], reasons: [...workspaceReasons, ...aggregated] };
}
