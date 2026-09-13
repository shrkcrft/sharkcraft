/**
 * Deterministic feature-checklist → changeset-evidence mapper.
 *
 * For each acceptance criterion of a spec, scan the changeset (the set of
 * tracked + untracked changed files plus their current contents) for
 * backing evidence:
 *
 *   - a new exported symbol whose name relates to the criterion,
 *   - a new registration / array membership,
 *   - a new route / command registration,
 *   - a touched companion file whose path relates to the criterion,
 *   - a new test file.
 *
 * A criterion with zero footprint across the whole changeset is `UNMET`
 * (claimed-but-unimplemented). There is NO model in the loop: matching is a
 * pure keyword/identifier intersection between the criterion text and the
 * identifiers/paths added in the changeset.
 *
 * This module is read-only and side-effect free; the caller is responsible
 * for collecting `changedFiles` + `fileContents` (see the CLI
 * `collectChangedPaths` helper and `spec verify --coverage`).
 */

// THE identifier tokenizer — shared with reuse and the recommender.
import { matchesAny, TEST_FILE_GLOBS } from '@shrkcrft/boundaries';
import { splitIdentifierTokens } from '../split-identifier.ts';

/** The shape of evidence backing (or claiming to back) a criterion. */
export type SpecEvidenceKind = 'symbol' | 'registration' | 'route' | 'companion' | 'test';

export interface ISpecEvidenceItem {
  readonly kind: SpecEvidenceKind;
  /** Changeset-relative path the evidence was found in. */
  readonly file: string;
  /** The matched identifier / path token / line fragment. */
  readonly detail: string;
  /** The criterion keyword that produced the match. */
  readonly matched: string;
}

export interface ICriterionCoverage {
  readonly id: string;
  readonly text: string;
  /** True iff at least one piece of evidence was found in the changeset. */
  readonly covered: boolean;
  readonly evidence: readonly ISpecEvidenceItem[];
}

export interface IChecklistCriterionInput {
  readonly id: string;
  readonly text: string;
}

export interface IMapChecklistToEvidenceInput {
  readonly criteria: readonly IChecklistCriterionInput[];
  readonly changedFiles: readonly string[];
  /** Map of changed-file path → current file contents. Missing = treated as empty. */
  readonly fileContents: Readonly<Record<string, string>>;
}

export interface IChecklistEvidenceReport {
  readonly criteria: readonly ICriterionCoverage[];
  readonly coveredCount: number;
  /** Criteria with zero footprint in the changeset (claimed-but-unimplemented). */
  readonly unmetCount: number;
}

/** Cap on evidence items retained per criterion (deterministic, insertion-ordered). */
const MAX_EVIDENCE_PER_CRITERION = 12;

/**
 * Words too generic to be a useful match signal. English filler plus
 * code-structure nouns that appear in nearly every changed file.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // english filler
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'its', 'from', 'when',
  'then', 'must', 'should', 'shall', 'will', 'can', 'via', 'into', 'onto',
  'per', 'not', 'new', 'add', 'added', 'adds', 'adding', 'also', 'only',
  'both', 'same', 'each', 'all', 'any', 'one', 'two', 'every', 'ensure',
  'ensures', 'return', 'returns', 'returned', 'use', 'uses', 'using', 'used',
  'support', 'supports', 'make', 'makes', 'get', 'gets', 'set', 'sets', 'run',
  'runs', 'call', 'calls', 'allow', 'allows', 'emit', 'emits', 'show', 'shows',
  'print', 'prints', 'such', 'over', 'under', 'where', 'which', 'while',
  // code-structure nouns
  'flag', 'flags', 'file', 'files', 'function', 'functions', 'const', 'class',
  'interface', 'type', 'types', 'enum', 'test', 'tests', 'value', 'values',
  'field', 'fields', 'array', 'arrays', 'list', 'lists', 'table', 'output',
  'input', 'json', 'human', 'count', 'counts', 'result', 'results', 'report',
  'reports', 'command', 'commands', 'option', 'options', 'arg', 'args', 'case',
  'cases', 'line', 'lines', 'code', 'name', 'names', 'data', 'item', 'items',
  'entry', 'entries', 'key', 'keys', 'string', 'number', 'boolean', 'object',
]);

/** Markers that, when present on a line, treat a keyword match as a route. */
const ROUTE_MARKER = /\b(route|router|endpoint|register[a-z]*|addcommand|handlermap|usage)\b/i;

/**
 * Map a spec checklist to changeset evidence. Pure; deterministic for a
 * given input (stable iteration over `changedFiles` and sorted keywords).
 */
export function mapChecklistToEvidence(
  input: IMapChecklistToEvidenceInput,
): IChecklistEvidenceReport {
  const criteria = input.criteria.map((c) => analyzeCriterion(c, input));
  const coveredCount = criteria.filter((c) => c.covered).length;
  return {
    criteria,
    coveredCount,
    unmetCount: criteria.length - coveredCount,
  };
}

function analyzeCriterion(
  criterion: IChecklistCriterionInput,
  input: IMapChecklistToEvidenceInput,
): ICriterionCoverage {
  const keywords = extractKeywords(criterion.text);
  const evidence = new Map<string, ISpecEvidenceItem>();
  const push = (item: ISpecEvidenceItem): void => {
    if (evidence.size >= MAX_EVIDENCE_PER_CRITERION) return;
    evidence.set(`${item.kind}|${item.file}|${item.detail}`, item);
  };

  if (keywords.size > 0) {
    for (const file of input.changedFiles) {
      const content = input.fileContents[file] ?? '';
      collectFileEvidence(file, content, keywords, push);
    }
  }

  const items = [...evidence.values()];
  return {
    id: criterion.id,
    text: criterion.text,
    covered: items.length > 0,
    evidence: items,
  };
}

function collectFileEvidence(
  file: string,
  content: string,
  keywords: ReadonlySet<string>,
  push: (item: ISpecEvidenceItem) => void,
): void {
  const pathTokens = splitIdentifierTokens(stripExtension(baseName(file)));

  if (isTestFile(file)) {
    // A new test backs a criterion when its path (or an exported helper)
    // names the feature. Test files are reported ONLY as `test` evidence.
    const onPath = firstMatch(pathTokens, keywords);
    if (onPath) {
      push({ kind: 'test', file, detail: baseName(file), matched: onPath });
      return;
    }
    for (const symbol of extractExportedSymbols(content)) {
      const hit = firstMatch(splitIdentifierTokens(symbol), keywords);
      if (hit) {
        push({ kind: 'test', file, detail: symbol, matched: hit });
        return;
      }
    }
    return;
  }

  // companion: the touched file's own path names the feature.
  const onPath = firstMatch(pathTokens, keywords);
  if (onPath) {
    push({ kind: 'companion', file, detail: baseName(file), matched: onPath });
  }

  // symbol: a newly exported declaration names the feature.
  for (const symbol of extractExportedSymbols(content)) {
    const hit = firstMatch(splitIdentifierTokens(symbol), keywords);
    if (hit) push({ kind: 'symbol', file, detail: symbol, matched: hit });
  }

  // route / registration: line-level membership.
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const member = registrationMember(line);
    if (member) {
      const hit = firstMatch(splitIdentifierTokens(member), keywords);
      if (hit) {
        const kind: SpecEvidenceKind = ROUTE_MARKER.test(line) ? 'route' : 'registration';
        push({ kind, file, detail: member, matched: hit });
      }
    }
  }
}

/**
 * The "registration token" of a line: an object-property key
 * (`coverage: ...`), a quoted map/array string entry (`'coverage'`), or the
 * identifier following a route/registration marker.
 */
function registrationMember(line: string): string | null {
  const prop = line.match(/^['"]?([A-Za-z_$][\w-]*)['"]?\s*:/);
  if (prop) return prop[1]!;
  const quoted = line.match(/^['"]([\w./-]+)['"]\s*,?$/);
  if (quoted) return quoted[1]!;
  if (ROUTE_MARKER.test(line)) {
    const ident = line.match(/['"]([\w./-]+)['"]/);
    if (ident) return ident[1]!;
  }
  return null;
}

function extractExportedSymbols(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const decl = line.match(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (decl && !seen.has(decl[1]!)) {
      seen.add(decl[1]!);
      out.push(decl[1]!);
      continue;
    }
    const named = line.match(/^export\s*\{([^}]*)\}/);
    if (named) {
      for (const part of named[1]!.split(',')) {
        const id = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(id) && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
  }
  return out;
}

/** Distinctive lowercase keyword tokens of a criterion (stopwords removed). */
function extractKeywords(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    for (const tok of splitIdentifierTokens(raw)) {
      if (tok.length >= 3 && !STOPWORDS.has(tok)) out.add(tok);
    }
  }
  return out;
}

function firstMatch(tokens: readonly string[], keywords: ReadonlySet<string>): string | null {
  for (const t of tokens) {
    if (keywords.has(t)) return t;
  }
  return null;
}

/**
 * "Is this a test file?" through THE test-file layout list, `TEST_FILE_GLOBS`
 * (the one a boundary rule's `excludeTests: true` expands to), so spec
 * evidence and the boundary gate agree on which files are tests.
 */
function isTestFile(file: string): boolean {
  return matchesAny(file.split('\\').join('/'), TEST_FILE_GLOBS);
}

function baseName(file: string): string {
  const norm = file.split('\\').join('/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
