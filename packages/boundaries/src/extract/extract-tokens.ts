import {
  resolveExtractorAnchor,
  resolveExtractorKind,
  validateWiringSource,
  type ExtractorKind,
  type IWiringSource,
} from '@shrkcrft/core';
import { safeCompile } from '../util/safe-regex.ts';
import { findBlankRunHazards } from '../util/blank-run-hazard.ts';
import type { IBlankRunHazard } from '../util/blank-run-hazard-finding.ts';
import { blankOutsideZone } from './code-zones.ts';
import { extractImportEdges } from './import-edges.ts';
import type { ITsconfigPathsMap } from '../scan/tsconfig-aliases.ts';
import {
  elementToken,
  elementValue,
  escapeRegex,
  lineOf,
  scanBalanced,
} from './scan-literals.ts';

/** A file made available to an extractor. */
export interface IExtractFileEntry {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

/** A captured id + where it was captured. */
export interface IExtractedSite {
  readonly token: string;
  readonly file: string;
  readonly line: number;
}

/**
 * Optional project context an extractor may need.
 *
 * Kept OUT of the source spec because it is not part of the rule — it is what
 * the caller knows about the workspace. Only `import-edges` reads it today, and
 * every other kind stays a pure function of (source, file contents).
 */
export interface IExtractContext {
  /** tsconfig `paths` map, so alias specifiers resolve as the compiler would. */
  readonly tsconfigPaths?: ITsconfigPathsMap;
}

/** Outcome of running one source: the sites, or a configuration error. */
export interface IExtractResult {
  readonly sites: readonly IExtractedSite[];
  /**
   * How many characters a non-`all` `scan` zone blanked before extraction.
   *
   * Surfaced (not merely applied) because a zone is the one setting that can
   * make a rule match LESS while still reading green: an author who sees the
   * number drop can tell "my pattern was matching prose" from "my glob went
   * stale". `explain` prints it.
   */
  readonly blankedChars?: number;
  /** Set when the SOURCE is misconfigured (never thrown — rules degrade). */
  readonly error?: string;
  /**
   * A diagnosis for a zero-match that is CORRECT but almost certainly not what
   * the author meant. Distinct from `error`: nothing is wrong with the source,
   * it just cannot mean what it looks like it means.
   */
  readonly hint?: string;
}

/**
 * Run one source's extractor over the given files.
 *
 * This is the reusable core of the completeness plane: wiring rules, registry
 * inventories, and extractor-backed baselines all harvest their ids through
 * here, so every one of them honours the exact same semantics (and gains every
 * new extractor kind for free). Never throws — a misconfigured source returns
 * an `error` and no sites.
 */
export function extractTokens(
  source: IWiringSource,
  files: readonly IExtractFileEntry[],
  context: IExtractContext = {},
): IExtractResult {
  const error = validateWiringSource(source);
  if (error) return { sites: [], error };

  const kind = resolveExtractorKind(source)!;
  const anchor = resolveExtractorAnchor(source);

  // Zone the CONTENT once, up front, instead of teaching every extractor about
  // comments. Blanking preserves length and newlines, so each extractor still
  // reports the true `file:line` and none of them needs zone logic of its own.
  const zone = source.scan ?? 'all';
  let blankedChars = 0;
  // `import-edges` zones itself (round 11, 6.1a#import-edges-scan): it judges a
  // statement by where its KEYWORD starts, through the one import parser.
  // Pre-blanking here erased every specifier (a string) under `scan: 'code'`,
  // and the rule silently extracted nothing.
  const scanned: readonly IExtractFileEntry[] =
    zone === 'all' || kind === 'import-edges'
      ? files
      : files.map((f) => {
          const blanked = blankOutsideZone(f.content, zone);
          blankedChars += blanked.blankedChars;
          return { path: f.path, content: blanked.content };
        });

  let sites: IExtractedSite[];
  // A user pattern run on a BLANKED buffer can backtrack O(run²) on the
  // whitespace runs the zone manufactures. Lint it (the hint reaches `gates
  // coverage` / `explain`), and bound each file: a file over budget is a
  // named, loud skip — the rule errors, never a silent partial.
  let regexHint: string | undefined;
  switch (kind) {
    case 'regex-capture': {
      const zoned = zone !== 'all';
      const hazards = zoned ? findBlankRunHazards(source.pattern!) : [];
      if (hazards.length > 0) regexHint = blankRunHazardHint(zone, hazards);
      const run = byRegex(source, scanned, zoned, hazards);
      if (run.predicted.length + run.ran.length > 0) {
        return {
          sites: [],
          error: zonedOverBudgetError(zone, run, hazards),
          ...(regexHint ? { hint: regexHint } : {}),
          ...zoneMeta(zone, blankedChars),
        };
      }
      sites = run.sites;
      break;
    }
    case 'array-members':
      sites = byBracketLiteral(anchor!, '[', scanned, (el) => elementToken(el));
      break;
    case 'object-keys':
      sites = byBracketLiteral(anchor!, '{', scanned, (el) =>
        source.capture === 'value' ? elementValue(el) : elementToken(el),
      );
      break;
    case 'enum-members':
      sites = byEnumMembers(anchor!, source.capture === 'value', scanned);
      break;
    case 'export-names':
      sites = byExportNames(scanned);
      break;
    case 'call-args':
      sites = byCallArgs(anchor!, source.argIndex ?? 0, false, scanned);
      break;
    case 'decorator-args':
      sites = byCallArgs(anchor!, source.argIndex ?? 0, true, scanned);
      break;
    case 'string-union-members':
      sites = byStringUnion(anchor!, scanned);
      break;
    case 'json-path':
      sites = byJsonPath(source.jsonPath!, scanned);
      break;
    case 'filenames':
      sites = byFilenames(source, scanned);
      break;
    case 'import-edges': {
      const edges = extractImportEdges(source, scanned, {
        ...(context.tsconfigPaths ? { tsconfigPaths: context.tsconfigPaths } : {}),
      });
      if (edges.error) return { sites: [], error: edges.error };
      // It zones itself, so what its zone blanked is its own figure — the
      // `scan: code (N chars blanked)` note must not read 0 over a zone that
      // dropped a commented-out edge.
      blankedChars += edges.blankedChars ?? 0;
      if (edges.hint) return { sites: edges.sites, hint: edges.hint, ...zoneMeta(zone, blankedChars) };
      sites = edges.sites;
      break;
    }
    default:
      return { sites: [], error: `unknown extract kind "${String(kind)}"` };
  }

  if (source.match !== undefined) {
    const { re } = safeCompile(source.match, source.matchFlags);
    if (re) {
      sites = sites.filter((s) => {
        re.lastIndex = 0;
        return re.test(s.token);
      });
    }
  }
  if (source.exclude !== undefined) {
    const { re } = safeCompile(source.exclude, source.excludeFlags);
    if (re) {
      sites = sites.filter((s) => {
        re.lastIndex = 0;
        return !re.test(s.token);
      });
    }
  }
  return { sites, ...zoneMeta(zone, blankedChars), ...(regexHint ? { hint: regexHint } : {}) };
}

/** The zone provenance to attach to a result — omitted entirely when unzoned. */
function zoneMeta(zone: string, blankedChars: number): { blankedChars?: number } {
  return zone === 'all' ? {} : { blankedChars };
}


/**
 * One id per FILE, derived from its path.
 *
 * Every other extractor reads a file's CONTENTS, so "a declared thing must have
 * its sibling FILE" — a `FOO_DESCRIPTOR` const paired with `FOO_DESCRIPTOR.ts` —
 * had no expression at all. Paired with a `parity` wiring rule this asserts the
 * correspondence in BOTH directions: a const with no file, and a file with no
 * const.
 *
 * The site line is 1: the id comes from the path, not from any line in it, and
 * claiming a more specific location would be inventing one.
 */
function byFilenames(
  source: IWiringSource,
  files: readonly IExtractFileEntry[],
): IExtractedSite[] {
  const capture = source.capturePath ?? 'stem';
  let re: RegExp | undefined;
  if (capture === 'regex') {
    const compiled = safeCompile(source.pathPattern!, source.pathPatternFlags);
    if (!compiled.re) return [];
    re = compiled.re;
  }
  const sites: IExtractedSite[] = [];
  for (const file of files) {
    if (capture === 'regex') {
      re!.lastIndex = 0;
      const m = re!.exec(file.path);
      if (m?.[1]) sites.push({ token: m[1], file: file.path, line: 1 });
      continue;
    }
    const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
    const dot = basename.indexOf('.');
    const token = capture === 'basename' || dot <= 0 ? basename : basename.slice(0, dot);
    sites.push({ token, file: file.path, line: 1 });
  }
  return sites;
}

/**
 * Wall-clock cap for ONE file's `regex-capture` pass under a non-`all` scan
 * zone. Checked between matches; a file that trips it contributes nothing and
 * is NAMED (the source errors), so a partial token set can never read green.
 */
export const ZONED_REGEX_FILE_BUDGET_MS = 1000;

/**
 * For a pattern the blank-run lint flags: a file whose PREDICTED backtracking
 * work (priced by each hazard's reach, below) exceeds this is skipped BEFORE
 * the regex runs. One `exec` over such a buffer cannot be interrupted (a
 * 16 KB newline-crossing run already costs ~300–470 ms), so the prediction is
 * what makes the cap a real bound.
 */
const ZONED_HAZARD_COST_LIMIT = 2e8;

/** Blank stretches shorter than this are ordinary indentation — not worth pricing. */
const MIN_PRICED_RUN = 64;

/**
 * The three shapes of quadratic work a flagged pattern can do on a blanked
 * buffer, measured in one pass. Blanking writes spaces and keeps newlines, so
 * a RUN is a maximal stretch of spaces/newlines and a LINE SEGMENT a maximal
 * stretch of spaces alone.
 */
interface IBlankRunCosts {
  /** Σ run² — a newline-crossing quantifier (`\s*`) that can start at any offset. */
  readonly run: number;
  /** Σ segment² — a line-bounded one (`[ \t]*`, `.*?`, `[ ]*`): it stops at every `\n`. */
  readonly line: number;
  /** Σ (lines × run) — a newline-crossing one that can only start at a line start (`(?:^|\n)\s*`). */
  readonly linesTimesRun: number;
}

function blankRunCosts(content: string): IBlankRunCosts {
  let run = 0;
  let segment = 0;
  let newlines = 0;
  let runCost = 0;
  let lineCost = 0;
  let linesTimesRun = 0;
  for (let i = 0; i <= content.length; i += 1) {
    const c = i < content.length ? content.charCodeAt(i) : 0;
    if (c === 0x20) {
      run += 1;
      segment += 1;
      continue;
    }
    if (segment >= MIN_PRICED_RUN) lineCost += segment * segment;
    segment = 0;
    if (c === 0x0a) {
      run += 1;
      newlines += 1;
      continue;
    }
    if (run >= MIN_PRICED_RUN) {
      runCost += run * run;
      linesTimesRun += (newlines + 1) * run;
    }
    run = 0;
    newlines = 0;
  }
  return { run: runCost, line: lineCost, linesTimesRun };
}

/** One file's predicted work under the costliest flagged hazard, and the measure it was priced by. */
interface IPredictedCost {
  readonly cost: number;
  readonly measure: string;
}

/** Price every flagged hazard by its OWN reach; the file costs what its worst hazard costs. */
function predictedHazardCost(hazards: readonly IBlankRunHazard[], costs: IBlankRunCosts): IPredictedCost {
  let worst: IPredictedCost = { cost: 0, measure: 'Σ run²' };
  for (const h of hazards) {
    const priced: IPredictedCost = !h.crossesNewline
      ? { cost: costs.line, measure: 'Σ line-run²' }
      : h.shape === 'leading' && h.fromLineStart
        ? { cost: costs.linesTimesRun, measure: 'Σ lines×run' }
        : { cost: costs.run, measure: 'Σ run²' };
    if (priced.cost > worst.cost) worst = priced;
  }
  return worst;
}

/**
 * The remedy for each hazard shape present. A LEADING quantifier is fixed by
 * a literal anchor — never by another quantifier: a leading `[ \t]*` is still
 * tried at every offset of a blanked line.
 */
function hazardRemedy(hazards: readonly IBlankRunHazard[]): string {
  const remedies: string[] = [];
  if (hazards.some((h) => h.shape === 'leading')) {
    remedies.push(
      'anchor the alternative on a literal — begin it with the token the whitespace precedes ' +
        '(`foo[ \\t]*\\(`, not `[ \\t]*foo\\(`), since a leading whitespace quantifier of any class is tried at every offset',
    );
  }
  if (hazards.some((h) => h.shape === 'adjacent')) {
    remedies.push('collapse the touching whitespace quantifiers into one');
  }
  return remedies.join('; ');
}

/** The hint a hazardous user pattern earns under a zone — surfaced through `gates coverage` / `explain`. */
function blankRunHazardHint(zone: string, hazards: readonly IBlankRunHazard[]): string {
  const h = hazards[0]!;
  const reach = hazards.every((x) => !x.crossesNewline)
    ? ' It stops at each newline, so only a very long blanked line is costly.'
    : '';
  return (
    `pattern backtracking hazard under scan: '${zone}': ${h.message}. Blanked comments and strings become ` +
    `long whitespace runs; ${hazardRemedy(hazards)} (or scan: 'all').${reach}`
  );
}

/** A file skipped before its regex ran, because its predicted work was over the limit. */
interface IPredictedSkip extends IPredictedCost {
  readonly path: string;
}

/** One zoned `regex-capture` pass: the sites, and every file it could NOT judge — split by why. */
interface IRegexRun {
  readonly sites: IExtractedSite[];
  /** Skipped BEFORE running: the predicted cost was over {@link ZONED_HAZARD_COST_LIMIT}. */
  readonly predicted: readonly IPredictedSkip[];
  /** Stopped AFTER running past {@link ZONED_REGEX_FILE_BUDGET_MS}. */
  readonly ran: readonly string[];
}

function namedFiles(files: readonly string[]): string {
  return files.slice(0, 5).join(', ') + (files.length > 5 ? `, … (+${files.length - 5} more)` : '');
}

function formatCost(n: number): string {
  return n.toExponential(1).replace('e+', 'e');
}

/**
 * The error for files a zoned `regex-capture` could not judge — loud, named,
 * never a silent partial. The two causes are worded apart: a PREDICTED skip
 * never ran the regex (so it spent nothing), a STOPPED file ran past the cap.
 */
function zonedOverBudgetError(zone: string, run: IRegexRun, hazards: readonly IBlankRunHazard[]): string {
  const parts: string[] = [];
  if (run.predicted.length > 0) {
    const worst = run.predicted.reduce((a, b) => (b.cost > a.cost ? b : a));
    parts.push(
      `predicted over budget, so the regex was never run (${worst.measure} = ${formatCost(worst.cost)} > ` +
        `${formatCost(ZONED_HAZARD_COST_LIMIT)}): ${namedFiles(run.predicted.map((p) => p.path))}`,
    );
  }
  if (run.ran.length > 0) {
    parts.push(`ran past the ${ZONED_REGEX_FILE_BUDGET_MS} ms per-file cap and was stopped: ${namedFiles(run.ran)}`);
  }
  const total = run.predicted.length + run.ran.length;
  const why = hazards.length > 0 ? ` — ${hazards[0]!.message}` : '';
  const fix = hazards.length > 0 ? hazardRemedy(hazards) : 'simplify the pattern';
  return (
    `regex-capture under scan: '${zone}' skipped ${total} file(s): over budget — ${parts.join('; ')}${why}. ` +
    `${fix.charAt(0).toUpperCase()}${fix.slice(1)}, or use scan: 'all'.`
  );
}

/**
 * Capture-group-1 of a pattern, per file. Under a zone (`zoned`), each file is
 * bounded: a FLAGGED pattern skips a file whose predicted work — each hazard
 * priced by its own reach, so a line-bounded one pays per line — is over the
 * limit, and any pattern stops a file that runs past the per-file budget.
 * Both are named, never a quietly smaller token set.
 */
function byRegex(
  source: IWiringSource,
  files: readonly IExtractFileEntry[],
  zoned: boolean,
  hazards: readonly IBlankRunHazard[],
): IRegexRun {
  const { re } = safeCompile(source.pattern!, source.flags);
  if (!re) return { sites: [], predicted: [], ran: [] };
  const sites: IExtractedSite[] = [];
  const predicted: IPredictedSkip[] = [];
  const ran: string[] = [];
  for (const f of files) {
    if (zoned && hazards.length > 0) {
      const p = predictedHazardCost(hazards, blankRunCosts(f.content));
      if (p.cost > ZONED_HAZARD_COST_LIMIT) {
        predicted.push({ path: f.path, ...p });
        continue;
      }
    }
    const startedAt = Date.now();
    const fileSites: IExtractedSite[] = [];
    let over = false;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content)) !== null) {
      // Guard against a zero-width match looping forever.
      if (m.index === re.lastIndex) re.lastIndex += 1;
      const token = m[1];
      if (token !== undefined && token !== '') {
        fileSites.push({ token, file: f.path, line: lineOf(f.content, m.index) });
      }
      if (zoned && Date.now() - startedAt > ZONED_REGEX_FILE_BUDGET_MS) {
        over = true;
        break;
      }
    }
    if (over) {
      ran.push(f.path);
      continue;
    }
    sites.push(...fileSites);
  }
  return { sites, predicted, ran };
}

/**
 * The head regexes the anchor-based extractors run — possibly on a blanked
 * buffer. One factory, so the linearity lock (`r75-blank-run-linearity`)
 * times and lints the exact patterns that run, not copies of them.
 */
export function extractorHeadPatterns(anchor: string): {
  readonly arrayLiteral: RegExp;
  readonly objectLiteral: RegExp;
  readonly enumBody: RegExp;
  readonly call: RegExp;
  readonly decorator: RegExp;
  readonly stringUnion: RegExp;
  readonly exportDecl: RegExp;
  readonly exportClause: RegExp;
} {
  const a = escapeRegex(anchor);
  const literalHead = (open: '[' | '{'): RegExp =>
    new RegExp(`(?<![\\w$])${a}\\s*(?::[^=\\n]*)?[:=]\\s*(?:[A-Za-z_$][\\w$.]*\\s*\\(\\s*)?\\${open}`, 'g');
  return {
    arrayLiteral: literalHead('['),
    objectLiteral: literalHead('{'),
    enumBody: new RegExp(`\\benum\\s+${a}\\s*\\{`, 'g'),
    call: new RegExp(`(?<![\\w$.@])${a}\\s*\\(`, 'g'),
    decorator: new RegExp(`@${a}\\s*\\(`, 'g'),
    // Collapsed from `\s*(?:<[^>]*>)?\s*=`: two whitespace quantifiers with
    // only an optional group between them re-partition a blank run.
    stringUnion: new RegExp(`\\btype\\s+${a}\\s*(?:<[^>]*>\\s*)?=`, 'g'),
    exportDecl: EXPORT_DECL,
    exportClause: EXPORT_CLAUSE,
  };
}

/**
 * Elements of every `<anchor> = <open> … ` / `<anchor>: <open> … ` literal.
 *
 * Covers `export const ARR = [ … ]`, an inline `arrayProperty: [ … ]`, a typed
 * `const ARR: readonly T[] = [ … ]`, and the very common freeze/wrapper form
 * `export const ARR = Object.freeze([ … ])` — a registry array is nearly always
 * wrapped, and missing that would silently extract nothing.
 */
function byBracketLiteral(
  anchor: string,
  open: '[' | '{',
  files: readonly IExtractFileEntry[],
  tokenOf: (elementText: string) => string | undefined,
): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  const heads = extractorHeadPatterns(anchor);
  const head = open === '[' ? heads.arrayLiteral : heads.objectLiteral;
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const openIndex = m.index + m[0].length - 1;
      const { elements, end } = scanBalanced(f.content, openIndex);
      for (const el of elements) {
        const token = tokenOf(el.text);
        if (token === undefined || token === '') continue;
        sites.push({ token, file: f.path, line: lineOf(f.content, el.index) });
      }
      head.lastIndex = Math.max(end + 1, head.lastIndex);
    }
  }
  return sites;
}

/** Members of `enum <anchor> { … }` — the member name, or its assigned value. */
function byEnumMembers(
  anchor: string,
  wantValue: boolean,
  files: readonly IExtractFileEntry[],
): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  const head = extractorHeadPatterns(anchor).enumBody;
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const openIndex = m.index + m[0].length - 1;
      const { elements, end } = scanBalanced(f.content, openIndex);
      for (const el of elements) {
        const token = wantValue ? elementValue(el.text) : elementToken(el.text);
        if (token === undefined || token === '') continue;
        sites.push({ token, file: f.path, line: lineOf(f.content, el.index) });
      }
      head.lastIndex = Math.max(end + 1, head.lastIndex);
    }
  }
  return sites;
}

/** Every exported binding name, including re-export aliases (`export { A as B }` → `B`). */
const EXPORT_DECL =
  /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_CLAUSE = /\bexport\s*(?:type\s+)?\{([^}]*)\}/g;

function byExportNames(files: readonly IExtractFileEntry[]): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  for (const f of files) {
    EXPORT_DECL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORT_DECL.exec(f.content)) !== null) {
      sites.push({ token: m[1]!, file: f.path, line: lineOf(f.content, m.index) });
    }
    EXPORT_CLAUSE.lastIndex = 0;
    while ((m = EXPORT_CLAUSE.exec(f.content)) !== null) {
      const line = lineOf(f.content, m.index);
      for (const raw of m[1]!.split(',')) {
        const spec = raw.trim().replace(/^type\s+/, '');
        if (spec === '' || spec === 'default') continue;
        // `A as B` exports B; a bare `A` exports A.
        const parts = spec.split(/\s+as\s+/);
        const name = (parts[parts.length - 1] ?? '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) sites.push({ token: name, file: f.path, line });
      }
    }
  }
  return sites;
}

/** Argument `argIndex` of every `anchor(…)` call — or `@anchor(…)` decorator. */
function byCallArgs(
  anchor: string,
  argIndex: number,
  decorator: boolean,
  files: readonly IExtractFileEntry[],
): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  const heads = extractorHeadPatterns(anchor);
  const head = decorator ? heads.decorator : heads.call;
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const openIndex = m.index + m[0].length - 1;
      const { elements, end } = scanBalanced(f.content, openIndex);
      const el = elements[argIndex];
      if (el) {
        const token = elementToken(el.text);
        if (token !== undefined && token !== '') {
          sites.push({ token, file: f.path, line: lineOf(f.content, el.index) });
        }
      }
      head.lastIndex = Math.max(end + 1, head.lastIndex);
    }
  }
  return sites;
}

/** The string literals of `type <anchor> = 'a' | 'b' | 'c'`. */
function byStringUnion(anchor: string, files: readonly IExtractFileEntry[]): IExtractedSite[] {
  const sites: IExtractedSite[] = [];
  const head = extractorHeadPatterns(anchor).stringUnion;
  const member = /['"`]([^'"`]+)['"`]/g;
  for (const f of files) {
    head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = head.exec(f.content)) !== null) {
      if (m.index === head.lastIndex) head.lastIndex += 1;
      const start = m.index + m[0].length;
      // The alias body runs to the first `;` or blank line at depth 0.
      const semi = f.content.indexOf(';', start);
      const blank = f.content.indexOf('\n\n', start);
      const ends = [semi, blank].filter((i) => i >= 0);
      const end = ends.length > 0 ? Math.min(...ends) : f.content.length;
      const body = f.content.slice(start, end);
      member.lastIndex = 0;
      let mm: RegExpExecArray | null;
      while ((mm = member.exec(body)) !== null) {
        sites.push({
          token: mm[1]!,
          file: f.path,
          line: lineOf(f.content, start + mm.index),
        });
      }
      head.lastIndex = Math.max(end, head.lastIndex);
    }
  }
  return sites;
}

/**
 * Leaves selected by a JSON path. Supports `.key`, `[n]`, `[*]`; a leading `$.`
 * is accepted and ignored. Scalars become ids; a selected object contributes
 * its KEYS (so `compilerOptions.paths` yields the alias names). Line numbers are
 * resolved by locating the token's first quoted occurrence in the raw text —
 * exact when the id is unique, and honestly approximate when it is not.
 */
function byJsonPath(jsonPath: string, files: readonly IExtractFileEntry[]): IExtractedSite[] {
  const segments = parseJsonPath(jsonPath);
  const sites: IExtractedSite[] = [];
  for (const f of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(f.content);
    } catch {
      continue; // not JSON — a `json-path` source over mixed globs skips it
    }
    for (const leaf of selectJsonPath(doc, segments)) {
      const token = String(leaf);
      if (token === '') continue;
      const at = f.content.indexOf(`"${token}"`);
      sites.push({
        token,
        file: f.path,
        line: at >= 0 ? lineOf(f.content, at) : 1,
      });
    }
  }
  return sites;
}

/** One step of a parsed JSON path: a literal key, an index, or the `*` wildcard. */
type JsonPathSegment = { readonly key: string } | { readonly index: number } | { readonly all: true };

function parseJsonPath(path: string): readonly JsonPathSegment[] {
  const out: JsonPathSegment[] = [];
  const cleaned = path.replace(/^\$\.?/, '');
  for (const part of cleaned.split('.')) {
    if (part === '') continue;
    const head = part.replace(/\[.*$/, '');
    if (head !== '') out.push({ key: head });
    for (const b of part.matchAll(/\[([^\]]*)\]/g)) {
      const inner = (b[1] ?? '').trim();
      if (inner === '*') out.push({ all: true });
      else if (/^\d+$/.test(inner)) out.push({ index: Number(inner) });
      else out.push({ key: inner.replace(/^['"]|['"]$/g, '') });
    }
  }
  return out;
}

function selectJsonPath(doc: unknown, segments: readonly JsonPathSegment[]): string[] {
  let current: unknown[] = [doc];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if ('all' in seg) {
        if (Array.isArray(node)) next.push(...node);
        else if (typeof node === 'object') next.push(...Object.values(node as object));
      } else if ('index' in seg) {
        if (Array.isArray(node)) next.push(node[seg.index]);
      } else if (typeof node === 'object' && !Array.isArray(node)) {
        next.push((node as Record<string, unknown>)[seg.key]);
      }
    }
    current = next;
  }
  const out: string[] = [];
  for (const leaf of current) {
    if (leaf === null || leaf === undefined) continue;
    if (typeof leaf === 'object') {
      // A selected object contributes its keys; an array, its scalar elements.
      if (Array.isArray(leaf)) {
        for (const el of leaf) if (typeof el === 'string' || typeof el === 'number') out.push(String(el));
      } else {
        out.push(...Object.keys(leaf as object));
      }
      continue;
    }
    if (typeof leaf === 'boolean') continue;
    out.push(String(leaf));
  }
  return out;
}
