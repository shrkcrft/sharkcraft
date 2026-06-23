/**
 * Knowledge propose.
 *
 * AST-driven inference of stub knowledge entries for exported top-level
 * constructs that do not yet have a knowledge entry covering them.
 *
 * Schema: `sharkcraft.knowledge-propose/v1`
 *
 * Read-only and deterministic. Callers decide what to do with the
 * proposals (preview, write to drafts, render JSON). Nothing in this
 * module mutates source.
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import * as nodePath from 'node:path';
import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { getChangedFiles, getCommitSubjects, isGitRepo } from './git-helpers.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  buildSymbolIndex,
  SymbolDeclarationKind,
  SymbolVisibility,
  type ISymbolEntry,
} from './symbol-index.ts';

export const KNOWLEDGE_PROPOSE_SCHEMA = 'sharkcraft.knowledge-propose/v1';

export enum KnowledgeProposeSkipReason {
  AlreadyCovered = 'already-covered',
  Excluded = 'excluded',
  UnsupportedKind = 'unsupported-kind',
  Default = 'default-export-skipped',
  NotSelected = 'not-selected',
}

export interface IProposedReference {
  kind: 'file' | 'symbol';
  path?: string;
  symbol?: string;
  required?: boolean;
}

export interface IProposedKnowledgeEntry {
  id: string;
  title: string;
  type: string;
  priority: string;
  scope: readonly string[];
  tags: readonly string[];
  appliesWhen: readonly string[];
  summary: string;
  content: string;
  references: readonly IProposedReference[];
  source: { file: string; line: number; kind: string };
  /**
   * Recent commits (in the `--since` range) that touched this symbol's file —
   * the "why this entry now". Present only when proposing over a git range.
   */
  commits?: readonly { hash: string; subject: string }[];
}

export interface IKnowledgeProposeSkip {
  file: string;
  symbol?: string;
  reason: KnowledgeProposeSkipReason;
  coveredByEntryId?: string;
}

export interface IKnowledgeProposeReport {
  schema: typeof KNOWLEDGE_PROPOSE_SCHEMA;
  proposals: readonly IProposedKnowledgeEntry[];
  skipped: readonly IKnowledgeProposeSkip[];
  scannedFiles: number;
  totalExports: number;
  /** When true, the scan was restricted to git-changed files. */
  gitChangedOnly: boolean;
  /** Ref used for git-changed scan, when applicable. */
  since?: string;
  /** Number of proposals dropped by `--max` (0/absent when no cap hit). */
  truncated?: number;
}

export interface IKnowledgeProposeInput {
  cwd: string;
  /** Restrict scan to a single file (relative or absolute). */
  path?: string;
  /** Propose only for a single named symbol. */
  symbol?: string;
  /**
   * When set, scan files changed relative to this ref.
   * Ignored when `path` or `symbol` is set.
   * Pass `null` to scan the whole workspace.
   */
  since?: string | null;
  /**
   * Cap the number of proposals returned (commit-annotated ones first). Guards
   * against a far-back `--since` flooding hundreds of unreviewable stubs.
   */
  max?: number;
}

const INCLUDED_KINDS = new Set<SymbolDeclarationKind>([
  SymbolDeclarationKind.Class,
  SymbolDeclarationKind.Function,
  SymbolDeclarationKind.Interface,
  SymbolDeclarationKind.TypeAlias,
  SymbolDeclarationKind.Enum,
  SymbolDeclarationKind.Const,
]);

const SCANNABLE_EXTS = new Set<string>(['.ts', '.tsx', '.mts', '.cts']);

const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  'node_modules',
  '/dist/',
  '/__tests__/',
  '.test.',
  '.spec.',
  '.d.ts',
  '/coverage/',
  '/.sharkcraft/',
];

interface ICoverageIndex {
  symbols: Map<string, string>;
  files: Map<string, string>;
  symbolByFile: Map<string, Set<string>>;
}

function isScannableFile(path: string): boolean {
  const ext = nodePath.extname(path).toLowerCase();
  if (!SCANNABLE_EXTS.has(ext)) return false;
  return !DEFAULT_EXCLUDE_PATTERNS.some((p) => path.includes(p));
}

function relativeFromRoot(root: string, abs: string): string {
  const rel = nodePath.relative(root, abs);
  return rel.split(nodePath.sep).join('/');
}

function absoluteUnderRoot(root: string, input: string): string {
  if (nodePath.isAbsolute(input)) return nodePath.resolve(input);
  return nodePath.resolve(root, input);
}

function packageOfPath(relPath: string): string {
  const segments = relPath.split('/');
  if (segments[0] === 'packages' && segments.length > 1) {
    return segments[1] ?? 'workspace';
  }
  if (segments[0] === 'examples' && segments.length > 1) {
    return `example.${segments[1]}`;
  }
  return segments[0] ?? 'workspace';
}

function nearestFeatureScope(relPath: string): string | undefined {
  const segments = relPath.split('/');
  if (segments.length < 4) return undefined;
  if (segments[0] !== 'packages' && segments[0] !== 'examples') return undefined;
  const tail = segments[segments.length - 1] ?? '';
  const dot = tail.indexOf('.');
  const stem = dot >= 0 ? tail.slice(0, dot) : tail;
  return stem === 'index' ? undefined : stem;
}

function camelToKebab(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function deriveEntryId(scope: string, symbol: string): string {
  return `${scope}.${camelToKebab(symbol)}`;
}

function kindLabel(kind: SymbolDeclarationKind): string {
  switch (kind) {
    case SymbolDeclarationKind.Class:
      return 'class';
    case SymbolDeclarationKind.Interface:
      return 'interface';
    case SymbolDeclarationKind.TypeAlias:
      return 'type alias';
    case SymbolDeclarationKind.Enum:
      return 'enum';
    case SymbolDeclarationKind.Function:
      return 'function';
    case SymbolDeclarationKind.Const:
      return 'const';
    default:
      return 'binding';
  }
}

function buildCoverageIndex(entries: readonly IKnowledgeEntry[]): ICoverageIndex {
  const symbols = new Map<string, string>();
  const files = new Map<string, string>();
  const symbolByFile = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const ref of entry.references ?? []) {
      if (ref.kind === 'symbol' && ref.symbol) {
        const symbolKey = ref.path
          ? `${ref.path}::${ref.symbol}`
          : `::${ref.symbol}`;
        symbols.set(symbolKey, entry.id);
        if (ref.path) {
          let set = symbolByFile.get(ref.path);
          if (!set) {
            set = new Set<string>();
            symbolByFile.set(ref.path, set);
          }
          set.add(ref.symbol);
        }
      } else if (ref.kind === 'file' && ref.path) {
        files.set(ref.path, entry.id);
      }
    }
    for (const anchor of entry.anchors ?? []) {
      if (anchor.kind === 'symbol' && anchor.symbol) {
        const symbolKey = anchor.path
          ? `${anchor.path}::${anchor.symbol}`
          : `::${anchor.symbol}`;
        symbols.set(symbolKey, entry.id);
      } else if (anchor.kind === 'file' && anchor.path) {
        files.set(anchor.path, entry.id);
      }
    }
  }
  return { symbols, files, symbolByFile };
}

function findCoverage(
  index: ICoverageIndex,
  relPath: string,
  symbol: string,
): string | undefined {
  const symKey = `${relPath}::${symbol}`;
  if (index.symbols.has(symKey)) return index.symbols.get(symKey);
  const orphan = `::${symbol}`;
  if (index.symbols.has(orphan)) return index.symbols.get(orphan);
  if (index.files.has(relPath)) return index.files.get(relPath);
  return undefined;
}

function buildProposalForExport(
  relPath: string,
  entry: ISymbolEntry,
  commits: readonly { hash: string; subject: string }[] = [],
): IProposedKnowledgeEntry {
  const scopeName = packageOfPath(relPath);
  const feature = nearestFeatureScope(relPath);
  const scope = feature ? [scopeName, feature] : [scopeName];
  const id = deriveEntryId(scopeName, entry.name);
  const klabel = kindLabel(entry.kind);
  const title = `${entry.name} (${klabel}, proposed)`;
  const summary = `Stub knowledge for the exported ${klabel} \`${entry.name}\`.`;
  const content = [
    `Auto-proposed by \`shrk knowledge propose\` for the exported ${klabel}`,
    `\`${entry.name}\` declared at \`${relPath}:${entry.line}\`.`,
    ...(commits.length > 0
      ? ['', `Surfaced by recent commit(s): ${commits.map((c) => `${c.subject} (${c.hash})`).join('; ')}.`]
      : []),
    '',
    'Replace this body with the *why*: the contract this symbol provides, the',
    'invariants it preserves, and how callers should reach for it.',
  ].join('\n');
  return {
    id,
    title,
    type: 'technical',
    priority: 'medium',
    scope,
    tags: ['proposed', klabel.replace(/\s+/g, '-')],
    appliesWhen: [],
    summary,
    content,
    references: [
      { kind: 'file', path: relPath, required: true },
      { kind: 'symbol', symbol: entry.name, path: relPath },
    ],
    source: { file: relPath, line: entry.line, kind: entry.kind },
    ...(commits.length > 0 ? { commits } : {}),
  };
}

function gatherWorkspaceFiles(
  root: string,
  inspection: ISharkcraftInspection,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (dir: string): void => {
    let kids: Dirent[];
    try {
      kids = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const kid of kids) {
      if (kid.name.startsWith('.')) continue;
      if (kid.name === 'node_modules' || kid.name === 'dist') continue;
      const full = nodePath.join(dir, kid.name);
      if (kid.isDirectory()) {
        walk(full);
        continue;
      }
      if (!kid.isFile()) continue;
      const rel = relativeFromRoot(root, full);
      if (!isScannableFile(rel)) continue;
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
    }
  };
  for (const candidate of ['packages', 'examples', 'sharkcraft']) {
    const abs = nodePath.join(root, candidate);
    if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs);
  }
  // Best-effort: include known files the inspector already loaded.
  for (const source of inspection.sourceFiles) {
    const rel = relativeFromRoot(root, source);
    if (!seen.has(rel) && isScannableFile(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out.sort();
}

function resolveFileSet(
  input: IKnowledgeProposeInput,
  root: string,
  inspection: ISharkcraftInspection,
): { files: string[]; gitChangedOnly: boolean; since?: string } {
  if (input.path) {
    const abs = absoluteUnderRoot(root, input.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { files: [], gitChangedOnly: false };
    }
    return { files: [relativeFromRoot(root, abs)], gitChangedOnly: false };
  }
  const since = input.since === undefined ? 'HEAD' : input.since;
  if (since !== null && isGitRepo(root)) {
    const changed = getChangedFiles(root, { since, includeWorktree: true })
      .filter(isScannableFile);
    if (changed.length > 0) {
      return { files: changed, gitChangedOnly: true, since };
    }
  }
  return { files: gatherWorkspaceFiles(root, inspection), gitChangedOnly: false };
}

export async function proposeKnowledge(
  input: IKnowledgeProposeInput,
): Promise<IKnowledgeProposeReport> {
  const inspection = await inspectSharkcraft({ cwd: input.cwd });
  const root = inspection.projectRoot;
  const coverage = buildCoverageIndex(inspection.knowledgeEntries);
  const { files, gitChangedOnly, since } = resolveFileSet(input, root, inspection);

  // When proposing over a real git range, map each file to the commit
  // subjects that touched it so each draft says WHY it surfaced (instead of
  // pure boilerplate). `HEAD..HEAD` (the default working-tree compare) yields
  // nothing, so this only annotates `--since <ref>` runs. Deterministic.
  const commitsByFile = new Map<string, { hash: string; subject: string }[]>();
  if (typeof since === 'string' && since !== 'HEAD' && isGitRepo(root)) {
    for (const c of getCommitSubjects(root, { since })) {
      for (const f of c.files) {
        const arr = commitsByFile.get(f) ?? [];
        if (arr.length < 3) arr.push({ hash: c.shortHash, subject: c.subject });
        commitsByFile.set(f, arr);
      }
    }
  }

  const proposals: IProposedKnowledgeEntry[] = [];
  const skipped: IKnowledgeProposeSkip[] = [];
  let totalExports = 0;

  for (const relPath of files) {
    if (!isScannableFile(relPath)) {
      skipped.push({ file: relPath, reason: KnowledgeProposeSkipReason.Excluded });
      continue;
    }
    const abs = nodePath.join(root, relPath);
    const index = buildSymbolIndex(abs);
    if (!index.parsed) continue;
    if (index.exports.length === 0) continue;

    for (const exp of index.exports) {
      totalExports += 1;
      if (exp.visibility === SymbolVisibility.Default) {
        skipped.push({
          file: relPath,
          symbol: exp.name,
          reason: KnowledgeProposeSkipReason.Default,
        });
        continue;
      }
      if (input.symbol && exp.name !== input.symbol) {
        skipped.push({
          file: relPath,
          symbol: exp.name,
          reason: KnowledgeProposeSkipReason.NotSelected,
        });
        continue;
      }
      if (!INCLUDED_KINDS.has(exp.kind)) {
        skipped.push({
          file: relPath,
          symbol: exp.name,
          reason: KnowledgeProposeSkipReason.UnsupportedKind,
        });
        continue;
      }
      const coveredBy = findCoverage(coverage, relPath, exp.name);
      if (coveredBy) {
        skipped.push({
          file: relPath,
          symbol: exp.name,
          reason: KnowledgeProposeSkipReason.AlreadyCovered,
          coveredByEntryId: coveredBy,
        });
        continue;
      }
      proposals.push(buildProposalForExport(relPath, exp, commitsByFile.get(relPath)));
    }
  }

  // --max: cap the flood. Commit-annotated proposals (genuinely touched in the
  // range) lead, so truncation keeps the most relevant drafts.
  let finalProposals: readonly IProposedKnowledgeEntry[] = proposals;
  let truncated = 0;
  if (typeof input.max === 'number' && input.max >= 0 && proposals.length > input.max) {
    const annotated = proposals.filter((p) => p.commits && p.commits.length > 0);
    const rest = proposals.filter((p) => !p.commits || p.commits.length === 0);
    truncated = proposals.length - input.max;
    finalProposals = [...annotated, ...rest].slice(0, input.max);
  }

  return {
    schema: KNOWLEDGE_PROPOSE_SCHEMA,
    proposals: finalProposals,
    skipped,
    scannedFiles: files.length,
    totalExports,
    gitChangedOnly,
    ...(since !== undefined ? { since } : {}),
    ...(truncated > 0 ? { truncated } : {}),
  };
}

export function renderKnowledgeProposeMarkdown(
  report: IKnowledgeProposeReport,
): string {
  const lines: string[] = [];
  lines.push('# Knowledge propose');
  lines.push('');
  lines.push(`schema: ${report.schema}`);
  lines.push(`scanned files: ${report.scannedFiles}`);
  lines.push(`exports inspected: ${report.totalExports}`);
  lines.push(`proposals: ${report.proposals.length}`);
  lines.push(
    `skipped: ${report.skipped.length}` +
      (report.gitChangedOnly && report.since
        ? ` (git-changed only since ${report.since})`
        : ''),
  );
  if (report.truncated && report.truncated > 0) {
    lines.push(
      `truncated: ${report.truncated} more proposal(s) dropped by --max (commit-annotated ones kept first)`,
    );
  }
  lines.push('');
  if (report.proposals.length === 0) {
    lines.push('No new entries proposed. Every exported binding is either');
    lines.push('already covered, excluded, or of an unsupported kind.');
    return lines.join('\n');
  }
  for (const p of report.proposals) {
    lines.push(`## ${p.id}`);
    lines.push('');
    lines.push(`- title: ${p.title}`);
    lines.push(`- type: ${p.type}`);
    lines.push(`- priority: ${p.priority}`);
    lines.push(`- scope: ${p.scope.join(', ')}`);
    lines.push(`- source: ${p.source.file}:${p.source.line} (${p.source.kind})`);
    lines.push('');
    lines.push('References:');
    for (const ref of p.references) {
      const path = ref.path ? ` path=${ref.path}` : '';
      const symbol = ref.symbol ? ` symbol=${ref.symbol}` : '';
      const required = ref.required ? ' required' : '';
      lines.push(`  - ${ref.kind}${path}${symbol}${required}`);
    }
    lines.push('');
    lines.push('Summary:');
    lines.push(`  ${p.summary}`);
    lines.push('');
    lines.push('Content (stub):');
    for (const line of p.content.split('\n')) lines.push(`  ${line}`);
    lines.push('');
  }
  return lines.join('\n');
}
