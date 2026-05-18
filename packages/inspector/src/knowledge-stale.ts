/**
 * Knowledge stale-check.
 *
 * Walks every knowledge entry's `references[]` + `anchors[]` and checks
 * whether each target still resolves against the current workspace.
 *
 * Pure file-system + registry lookups — no network, no AST compilation.
 * Symbol checks are deterministic best-effort text scans so the doctor
 * stays cheap.
 *
 * Schema: sharkcraft.knowledge-stale/v1
 */

import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  IKnowledgeAnchor,
  IKnowledgeEntry,
  IKnowledgeReference,
  KnowledgeReferenceKind,
} from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { HELPERS } from './helper-registry.ts';
import { resolveSymbolInFile, SymbolResolution } from './symbol-index.ts';

export const KNOWLEDGE_STALE_SCHEMA = 'sharkcraft.knowledge-stale/v1';

export enum ReferenceCheckOutcome {
  Ok = 'ok',
  Stale = 'stale',
  Missing = 'missing',
  Unknown = 'unknown',
}

export enum SymbolConfidence {
  Exact = 'exact',
  Probable = 'probable',
  Missing = 'missing',
  Unknown = 'unknown',
}

/**
 * Rename detection strategy.
 *
 * - `strict` (default): emit `replaceWith.path` only when there is
 *   exactly one unambiguous candidate.
 * - `wide`: also surface multiple candidates above a confidence
 *   threshold. When one candidate is meaningfully ahead of the second,
 *   it still auto-applies; otherwise the candidate list is returned
 *   without `path` so the user can disambiguate manually.
 */
export enum RenameStrategy {
  Strict = 'strict',
  Wide = 'wide',
}

/**
 * One scored candidate in a wide-strategy replacement.
 *
 * `score` is 0..1; higher is better. `rationale` is a one-line
 * human-readable explanation suitable for the preview output.
 */
export interface IReplacementCandidate {
  path?: string;
  symbol?: string;
  id?: string;
  score: number;
  rationale: string;
}

/**
 * Structured replacement signal.
 *
 * When the engine can identify the new location of a moved symbol /
 * renamed file with high confidence, it emits a structured payload the
 * apply path can act on without parsing the free-form `suggestion`
 * text. Strict mode emits `path` (or `id` / `symbol`) only when the
 * resolution is unambiguous (exactly one candidate match across the
 * source tree). Wide mode additionally surfaces `candidates[]` for the
 * ambiguous cases the user previously got nothing for.
 */
export interface IReferenceReplacement {
  /** New path for symbol or file/directory references that moved. */
  path?: string;
  /** New id for id-keyed references. */
  id?: string;
  /** New symbol for renamed symbols. */
  symbol?: string;
  /** One-line "why this is the right replacement" for human review. */
  rationale: string;
  /** Under wide strategy, full ranked candidate list. */
  candidates?: readonly IReplacementCandidate[];
  /** Strategy that produced this replacement. */
  strategy?: RenameStrategy;
}

export interface IKnowledgeReferenceCheck {
  entryId: string;
  reference: IKnowledgeReference;
  outcome: ReferenceCheckOutcome;
  /** Confidence for symbol references; undefined for other kinds. */
  symbolConfidence?: SymbolConfidence;
  message: string;
  suggestion?: string;
  /** Structured replacement when the engine can identify the new location. */
  replaceWith?: IReferenceReplacement;
}

export interface IKnowledgeAnchorCheck {
  entryId: string;
  anchor: IKnowledgeAnchor;
  outcome: ReferenceCheckOutcome;
  message: string;
}

export interface IKnowledgeStaleReport {
  schema: typeof KNOWLEDGE_STALE_SCHEMA;
  entries: number;
  totalReferences: number;
  totalAnchors: number;
  counts: { ok: number; stale: number; missing: number; unknown: number };
  referenceChecks: ReadonlyArray<IKnowledgeReferenceCheck>;
  anchorChecks: ReadonlyArray<IKnowledgeAnchorCheck>;
}

export interface IKnowledgeStaleCheckOptions {
  /** When provided, only entries referencing one of these files are checked. */
  changedFiles?: ReadonlyArray<string>;
  /**
   * Rename detection strategy. Default `strict`: only emit a candidate
   * when one is unambiguous. `wide` surfaces multi-candidate matches
   * that strict silently drops, and applies a path-overlap score so
   * the apply path can still auto-select when one candidate clearly
   * leads.
   */
  renameStrategy?: RenameStrategy;
}

/**
 * Wide-mode score thresholds. Tuned so a single-segment overlap
 * (e.g. `packages/foo/<basename>`) registers as plausible, but two
 * shared segments are required for confident auto-apply.
 */
const WIDE_MIN_SCORE = 0.34;
const WIDE_STRONG_SCORE = 0.66;
const WIDE_LEAD_GAP = 0.2;

function fileExists(projectRoot: string, rel: string): boolean {
  return existsSync(nodePath.join(projectRoot, rel));
}

function dirExists(projectRoot: string, rel: string): boolean {
  const full = nodePath.join(projectRoot, rel);
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function commandExistsInInspection(
  inspection: ISharkcraftInspection,
  id: string,
): boolean {
  // Both `shrk` commands and pack-contributed commands live on the
  // inspection. We do a permissive lookup against the recommendation
  // catalog if available.
  const commands = (inspection as { commandCatalog?: { id: string }[] }).commandCatalog;
  if (Array.isArray(commands)) {
    if (commands.some((c) => c.id === id)) return true;
  }
  // Fallback — accept anything that looks like a valid `shrk` command.
  return id.startsWith('shrk ') || id.startsWith('bun ');
}

function templateExists(inspection: ISharkcraftInspection, id: string): boolean {
  return inspection.templates.some((t) => t.id === id);
}

function playbookExists(inspection: ISharkcraftInspection, id: string): boolean {
  const inspectionAny = inspection as ISharkcraftInspection & {
    playbookRegistry?: { list?: () => readonly { id: string }[] };
  };
  const reg = inspectionAny.playbookRegistry;
  if (reg && typeof reg.list === 'function') {
    return (reg.list() ?? []).some((p) => p.id === id);
  }
  return false;
}

function constructExists(inspection: ISharkcraftInspection, id: string): boolean {
  const inspectionAny = inspection as ISharkcraftInspection & {
    constructRegistry?: { list?: () => readonly { id: string }[] };
  };
  const reg = inspectionAny.constructRegistry;
  if (reg && typeof reg.list === 'function') {
    return (reg.list() ?? []).some((c) => c.id === id);
  }
  return false;
}

function helperExists(id: string): boolean {
  return HELPERS.some((h) => h.id === id);
}

function policyExists(inspection: ISharkcraftInspection, id: string): boolean {
  const inspectionAny = inspection as ISharkcraftInspection & {
    policyChecks?: readonly { id: string }[];
  };
  const checks = inspectionAny.policyChecks;
  if (Array.isArray(checks)) return checks.some((c) => c.id === id);
  return false;
}

function boundaryRuleExists(inspection: ISharkcraftInspection, id: string): boolean {
  const reg = (inspection as { boundaryRegistry?: { list?: () => readonly { id: string }[] } }).boundaryRegistry;
  if (reg && typeof reg.list === 'function') return reg.list().some((b) => b.id === id);
  return false;
}

function pathConventionExists(inspection: ISharkcraftInspection, id: string): boolean {
  const svc = (inspection as { pathService?: { list?: () => readonly { id: string }[] } }).pathService;
  if (svc && typeof svc.list === 'function') {
    return svc.list().some((p) => p.id === id);
  }
  return false;
}

function packageExists(inspection: ISharkcraftInspection, id: string): boolean {
  // Project packages live under `packages/<name>` for SharkCraft + many
  // monorepos. Trust the inspection's package map if available, else
  // fall back to a filesystem check.
  const pkgs = (inspection as { packages?: { name: string }[] }).packages;
  if (Array.isArray(pkgs)) {
    if (pkgs.some((p) => p.name === id)) return true;
  }
  // file lookup as a backstop
  const rel = id.startsWith('@') ? id.split('/')[1] ?? '' : id;
  return dirExists(inspection.projectRoot, `packages/${rel}`);
}

function checkSymbolReference(
  projectRoot: string,
  ref: IKnowledgeReference,
): { outcome: ReferenceCheckOutcome; confidence: SymbolConfidence; message: string } {
  const sym = ref.symbol ?? '';
  if (!sym) {
    return {
      outcome: ReferenceCheckOutcome.Unknown,
      confidence: SymbolConfidence.Unknown,
      message: 'Symbol reference has no `symbol` field.',
    };
  }
  const file = ref.path ? nodePath.join(projectRoot, ref.path) : null;
  if (file) {
    if (!existsSync(file)) {
      return {
        outcome: ReferenceCheckOutcome.Missing,
        confidence: SymbolConfidence.Missing,
        message: `Referenced file does not exist: ${ref.path}`,
      };
    }
    // AST-backed resolution (falls back to text-scan if parse fails).
    try {
      const res = resolveSymbolInFile(file, sym);
      switch (res.resolution) {
        case SymbolResolution.ExactExport:
          return {
            outcome: ReferenceCheckOutcome.Ok,
            confidence: SymbolConfidence.Exact,
            message: res.message,
          };
        case SymbolResolution.ExactLocal:
        case SymbolResolution.ExactReExport:
          return {
            outcome: ReferenceCheckOutcome.Ok,
            confidence: SymbolConfidence.Exact,
            message: res.message,
          };
        case SymbolResolution.ProbableText:
          return {
            outcome: ReferenceCheckOutcome.Ok,
            confidence: SymbolConfidence.Probable,
            message: res.message,
          };
        case SymbolResolution.Missing:
          return {
            outcome: ReferenceCheckOutcome.Stale,
            confidence: SymbolConfidence.Missing,
            message: res.message,
          };
        default:
          return {
            outcome: ReferenceCheckOutcome.Unknown,
            confidence: SymbolConfidence.Unknown,
            message: res.message,
          };
      }
    } catch {
      // Fallback to text scan.
      try {
        const text = readFileSync(file, 'utf8');
        const declRe = new RegExp(
          `(export\\s+(?:async\\s+)?(?:function|class|interface|enum|type|const|let|var)\\s+|class\\s+|function\\s+)${escapeRe(sym)}\\b`,
        );
        if (declRe.test(text)) {
          return {
            outcome: ReferenceCheckOutcome.Ok,
            confidence: SymbolConfidence.Exact,
            message: `Found declaration of \`${sym}\` in ${ref.path}.`,
          };
        }
        if (text.includes(sym)) {
          return {
            outcome: ReferenceCheckOutcome.Ok,
            confidence: SymbolConfidence.Probable,
            message: `\`${sym}\` appears in ${ref.path}, but not as an exported declaration.`,
          };
        }
        return {
          outcome: ReferenceCheckOutcome.Stale,
          confidence: SymbolConfidence.Missing,
          message: `Symbol \`${sym}\` not found in ${ref.path}.`,
        };
      } catch {
        return {
          outcome: ReferenceCheckOutcome.Unknown,
          confidence: SymbolConfidence.Unknown,
          message: `Failed to read ${ref.path}.`,
        };
      }
    }
  }
  // No file pinned — best-effort confidence is `unknown`.
  return {
    outcome: ReferenceCheckOutcome.Unknown,
    confidence: SymbolConfidence.Unknown,
    message: `Symbol reference \`${sym}\` has no file pin; stale-check cannot verify.`,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkReference(
  inspection: ISharkcraftInspection,
  ref: IKnowledgeReference,
): { outcome: ReferenceCheckOutcome; confidence?: SymbolConfidence; message: string; suggestion?: string } {
  const projectRoot = inspection.projectRoot;
  switch (ref.kind) {
    case 'file': {
      if (!ref.path) return missingField('file', 'path');
      if (fileExists(projectRoot, ref.path)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `File exists: ${ref.path}` };
      }
      return staleFile(ref.path);
    }
    case 'directory': {
      if (!ref.path) return missingField('directory', 'path');
      if (dirExists(projectRoot, ref.path)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Directory exists: ${ref.path}` };
      }
      return {
        outcome: ReferenceCheckOutcome.Stale,
        message: `Directory missing: ${ref.path}`,
        suggestion: 'Move the directory or update the knowledge reference.',
      };
    }
    case 'symbol': {
      const r = checkSymbolReference(projectRoot, ref);
      return r;
    }
    case 'command': {
      const id = ref.id ?? ref.command ?? '';
      if (!id) return missingField('command', 'id or command');
      if (commandExistsInInspection(inspection, id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Command available: ${id}` };
      }
      return {
        outcome: ReferenceCheckOutcome.Stale,
        message: `Command not registered: ${id}`,
        suggestion: 'Register the command in the command catalog or update the reference.',
      };
    }
    case 'template': {
      if (!ref.id) return missingField('template', 'id');
      if (templateExists(inspection, ref.id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Template exists: ${ref.id}` };
      }
      return staleId('template', ref.id);
    }
    case 'playbook': {
      if (!ref.id) return missingField('playbook', 'id');
      if (playbookExists(inspection, ref.id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Playbook exists: ${ref.id}` };
      }
      return staleId('playbook', ref.id);
    }
    case 'construct': {
      if (!ref.id) return missingField('construct', 'id');
      if (constructExists(inspection, ref.id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Construct exists: ${ref.id}` };
      }
      return staleId('construct', ref.id);
    }
    case 'helper': {
      if (!ref.id) return missingField('helper', 'id');
      if (helperExists(ref.id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Helper exists: ${ref.id}` };
      }
      return staleId('helper', ref.id);
    }
    case 'policy': {
      if (!ref.id) return missingField('policy', 'id');
      if (policyExists(inspection, ref.id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Policy exists: ${ref.id}` };
      }
      return staleId('policy', ref.id);
    }
    case 'boundary-rule': {
      if (!ref.id) return missingField('boundary-rule', 'id');
      if (boundaryRuleExists(inspection, ref.id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Boundary rule exists: ${ref.id}` };
      }
      return staleId('boundary-rule', ref.id);
    }
    case 'path-convention': {
      if (!ref.id) return missingField('path-convention', 'id');
      if (pathConventionExists(inspection, ref.id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Path convention exists: ${ref.id}` };
      }
      return staleId('path-convention', ref.id);
    }
    case 'package': {
      if (!ref.id) return missingField('package', 'id');
      if (packageExists(inspection, ref.id)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `Package exists: ${ref.id}` };
      }
      return staleId('package', ref.id);
    }
    case 'url': {
      // We never fetch URLs. Mark them unknown unless we can resolve to a
      // local docs file.
      return {
        outcome: ReferenceCheckOutcome.Unknown,
        message: 'URL references are not verified (no network).',
      };
    }
  }
}

function missingField(
  kind: KnowledgeReferenceKind,
  field: string,
): { outcome: ReferenceCheckOutcome; message: string } {
  return {
    outcome: ReferenceCheckOutcome.Unknown,
    message: `${kind} reference missing required field: ${field}`,
  };
}

function staleFile(rel: string): { outcome: ReferenceCheckOutcome; message: string; suggestion?: string } {
  return {
    outcome: ReferenceCheckOutcome.Stale,
    message: `File missing: ${rel}`,
    suggestion: 'Restore the file or run `shrk knowledge rename-file <old> <new> --dry-run`.',
  };
}

function staleId(
  kind: string,
  id: string,
): { outcome: ReferenceCheckOutcome; message: string; suggestion?: string } {
  return {
    outcome: ReferenceCheckOutcome.Stale,
    message: `${kind} not found: ${id}`,
    suggestion: 'Register the target or remove the reference.',
  };
}

function entryTouchesChangedFiles(
  entry: IKnowledgeEntry,
  changed: ReadonlyArray<string>,
): boolean {
  if (changed.length === 0) return true;
  const changedSet = new Set(changed.map((c) => c.split(/[\\/]/).join('/')));
  for (const ref of entry.references ?? []) {
    if (ref.path && changedSet.has(ref.path.split(/[\\/]/).join('/'))) return true;
  }
  for (const anchor of entry.anchors ?? []) {
    if (anchor.path && changedSet.has(anchor.path.split(/[\\/]/).join('/'))) return true;
  }
  return false;
}

export function buildKnowledgeStaleReport(
  inspection: ISharkcraftInspection,
  options: IKnowledgeStaleCheckOptions = {},
): IKnowledgeStaleReport {
  const strategy = options.renameStrategy ?? RenameStrategy.Strict;
  const referenceChecks: IKnowledgeReferenceCheck[] = [];
  const anchorChecks: IKnowledgeAnchorCheck[] = [];
  const counts = { ok: 0, stale: 0, missing: 0, unknown: 0 };
  let totalReferences = 0;
  let totalAnchors = 0;
  // Lazy symbol → file index, built on first stale-symbol need.
  let symbolIndex: ReadonlyMap<string, readonly string[]> | null = null;
  const getSymbolIndex = (): ReadonlyMap<string, readonly string[]> => {
    if (symbolIndex) return symbolIndex;
    symbolIndex = buildSymbolFileIndex(inspection.projectRoot);
    return symbolIndex;
  };
  // Lazy basename → file path index, used for file-rename detection.
  let fileBasenameIndex: ReadonlyMap<string, readonly string[]> | null = null;
  const getFileBasenameIndex = (): ReadonlyMap<string, readonly string[]> => {
    if (fileBasenameIndex) return fileBasenameIndex;
    fileBasenameIndex = buildBasenameFileIndex(inspection.projectRoot);
    return fileBasenameIndex;
  };
  // Lazy basename → directory path index, used for dir-rename detection.
  let dirBasenameIndex: ReadonlyMap<string, readonly string[]> | null = null;
  const getDirBasenameIndex = (): ReadonlyMap<string, readonly string[]> => {
    if (dirBasenameIndex) return dirBasenameIndex;
    dirBasenameIndex = buildBasenameDirIndex(inspection.projectRoot);
    return dirBasenameIndex;
  };
  for (const entry of inspection.knowledgeEntries as IKnowledgeEntry[]) {
    if (options.changedFiles && !entryTouchesChangedFiles(entry, options.changedFiles)) {
      continue;
    }
    for (const ref of entry.references ?? []) {
      totalReferences += 1;
      const result = checkReference(inspection, ref);
      const outcome = result.outcome;
      if (outcome === ReferenceCheckOutcome.Ok) counts.ok += 1;
      else if (outcome === ReferenceCheckOutcome.Stale) counts.stale += 1;
      else if (outcome === ReferenceCheckOutcome.Missing) counts.missing += 1;
      else counts.unknown += 1;
      const check: IKnowledgeReferenceCheck = {
        entryId: entry.id,
        reference: ref,
        outcome,
        message: result.message,
        ...(result.confidence ? { symbolConfidence: result.confidence } : {}),
        ...(result.suggestion ? { suggestion: result.suggestion } : {}),
      };
      const isStaleOrMissing =
        outcome === ReferenceCheckOutcome.Stale || outcome === ReferenceCheckOutcome.Missing;
      // Symbol rename detection. Strict mode: emit `replaceWith.path`
      // only for the single unambiguous candidate. Wide mode also
      // emits scored candidate lists for the multi-candidate cases that
      // strict silently drops.
      if (isStaleOrMissing && ref.kind === 'symbol' && ref.symbol) {
        const all = (getSymbolIndex().get(ref.symbol) ?? []).filter((p) => p !== ref.path);
        if (all.length === 1) {
          check.replaceWith = {
            path: all[0]!,
            rationale: `\`${ref.symbol}\` is exported from \`${all[0]!}\` — sole candidate.`,
            strategy: RenameStrategy.Strict,
          };
        } else if (strategy === RenameStrategy.Wide && all.length > 1) {
          check.replaceWith = buildWideReplacement({
            stalePath: ref.path ?? '',
            paths: all,
            kindLabel: `symbol \`${ref.symbol}\``,
          });
        }
      }
      // File rename detection (directory move, basename match).
      if (isStaleOrMissing && ref.kind === 'file' && ref.path && !check.replaceWith) {
        const indexed = getFileBasenameIndex();
        const uniq = pickUniqueRenameCandidate(ref.path, indexed);
        if (uniq) {
          check.replaceWith = {
            path: uniq,
            rationale: `File basename \`${nodePath.basename(ref.path)}\` resolves uniquely to \`${uniq}\` (likely directory rename).`,
            strategy: RenameStrategy.Strict,
          };
        } else if (strategy === RenameStrategy.Wide) {
          const all = (indexed.get(nodePath.basename(ref.path)) ?? []).filter(
            (p) => p !== ref.path,
          );
          if (all.length > 0) {
            check.replaceWith = buildWideReplacement({
              stalePath: ref.path,
              paths: all,
              kindLabel: `file \`${nodePath.basename(ref.path)}\``,
            });
          }
        }
      }
      // Directory rename detection.
      if (isStaleOrMissing && ref.kind === 'directory' && ref.path && !check.replaceWith) {
        const indexed = getDirBasenameIndex();
        const uniq = pickUniqueRenameCandidate(ref.path, indexed);
        if (uniq) {
          check.replaceWith = {
            path: uniq,
            rationale: `Directory basename \`${nodePath.basename(ref.path)}\` resolves uniquely to \`${uniq}\`.`,
            strategy: RenameStrategy.Strict,
          };
        } else if (strategy === RenameStrategy.Wide) {
          const all = (indexed.get(nodePath.basename(ref.path)) ?? []).filter(
            (p) => p !== ref.path,
          );
          if (all.length > 0) {
            check.replaceWith = buildWideReplacement({
              stalePath: ref.path,
              paths: all,
              kindLabel: `directory \`${nodePath.basename(ref.path)}\``,
            });
          }
        }
      }
      referenceChecks.push(check);
    }
    for (const anchor of entry.anchors ?? []) {
      totalAnchors += 1;
      const inspected = checkAnchor(inspection, anchor);
      anchorChecks.push({
        entryId: entry.id,
        anchor,
        outcome: inspected.outcome,
        message: inspected.message,
      });
    }
  }
  // Content-similarity boost: when multiple wide replacements in the
  // SAME entry name the same candidate path, raise that candidate's score
  // for each occurrence. Captures the "directory was moved, all files
  // followed" case where a single per-reference signal is weak but the
  // aggregate is strong.
  applyEntryCorroborationBoost(referenceChecks);
  return {
    schema: KNOWLEDGE_STALE_SCHEMA,
    entries: inspection.knowledgeEntries.length,
    totalReferences,
    totalAnchors,
    counts,
    referenceChecks,
    anchorChecks,
  };
}

/**
 * Score a list of candidate paths against the stale path by shared
 * parent-directory segments. Normalises score into [0, 1] by the number
 * of non-trivial segments in the stale path.
 */
function scoreByPathOverlap(stalePath: string, candidate: string): number {
  const normalise = (s: string): string[] =>
    s
      .split(/[\\/]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p !== '.');
  const staleSegs = normalise(stalePath);
  const staleBasename = staleSegs.length > 0 ? staleSegs[staleSegs.length - 1]! : '';
  const candSegs = normalise(candidate);
  const staleDirs = new Set(staleSegs.filter((s) => s !== staleBasename));
  let overlap = 0;
  for (const s of candSegs) {
    if (s === staleBasename) continue;
    if (staleDirs.has(s)) overlap += 1;
  }
  const denom = Math.max(staleDirs.size, 1);
  return Math.min(1, overlap / denom);
}

interface IWideBuildArgs {
  stalePath: string;
  paths: readonly string[];
  kindLabel: string;
}

function buildWideReplacement(args: IWideBuildArgs): IReferenceReplacement {
  const scored: IReplacementCandidate[] = args.paths
    .map((p) => ({
      path: p,
      score: scoreByPathOverlap(args.stalePath, p),
      rationale: `Path-overlap score ${scoreByPathOverlap(args.stalePath, p).toFixed(2)} vs stale \`${args.stalePath}\`.`,
    }))
    .filter((c) => c.score >= WIDE_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    return {
      rationale: `Wide search for ${args.kindLabel} found ${args.paths.length} candidates, none above score threshold ${WIDE_MIN_SCORE}.`,
      candidates: [],
      strategy: RenameStrategy.Wide,
    };
  }
  const top = scored[0]!;
  const second = scored[1];
  const clearWinner =
    top.score >= WIDE_STRONG_SCORE && (!second || top.score - second.score >= WIDE_LEAD_GAP);
  if (clearWinner) {
    return {
      path: top.path,
      rationale: `Wide auto-select: ${args.kindLabel} → ${top.path} (score ${top.score.toFixed(2)}, lead ${second ? (top.score - second.score).toFixed(2) : '∞'}).`,
      candidates: scored,
      strategy: RenameStrategy.Wide,
    };
  }
  return {
    rationale: `Wide search for ${args.kindLabel} surfaced ${scored.length} candidates; none clearly leads. Disambiguate manually.`,
    candidates: scored,
    strategy: RenameStrategy.Wide,
  };
}

function applyEntryCorroborationBoost(checks: IKnowledgeReferenceCheck[]): void {
  const byEntry = new Map<string, IKnowledgeReferenceCheck[]>();
  for (const c of checks) {
    if (!c.replaceWith?.candidates || c.replaceWith.candidates.length === 0) continue;
    let bucket = byEntry.get(c.entryId);
    if (!bucket) {
      bucket = [];
      byEntry.set(c.entryId, bucket);
    }
    bucket.push(c);
  }
  for (const bucket of byEntry.values()) {
    if (bucket.length < 2) continue;
    const pathCounts = new Map<string, number>();
    for (const c of bucket) {
      for (const cand of c.replaceWith!.candidates!) {
        if (!cand.path) continue;
        pathCounts.set(cand.path, (pathCounts.get(cand.path) ?? 0) + 1);
      }
    }
    for (const c of bucket) {
      const candidates = c.replaceWith!.candidates ?? [];
      const boosted: IReplacementCandidate[] = candidates
        .map((cand) => {
          if (!cand.path) return cand;
          const count = pathCounts.get(cand.path) ?? 0;
          if (count < 2) return cand;
          const bumped = Math.min(1, cand.score + 0.15 * (count - 1));
          return {
            ...cand,
            score: bumped,
            rationale: `${cand.rationale} (+entry-corroboration ×${count - 1})`,
          };
        })
        .sort((a, b) => b.score - a.score);
      const top = boosted[0];
      const second = boosted[1];
      const promote =
        top &&
        top.path &&
        top.score >= WIDE_STRONG_SCORE &&
        (!second || top.score - second.score >= WIDE_LEAD_GAP);
      c.replaceWith = {
        ...c.replaceWith!,
        candidates: boosted,
        ...(promote
          ? {
              path: top!.path,
              rationale: `Wide + corroboration auto-select: ${top!.path} (score ${top!.score.toFixed(2)}).`,
            }
          : {}),
      };
    }
  }
}

/**
 * Build a `symbol-name → [files...]` index by scanning TS
 * sources for top-level `export ... <symbol>` declarations.
 *
 * Pure regex scan (no AST). Designed to be cheap enough to run once
 * per inspection — bounded by the number of TS files under
 * `packages/` (the only reliable source roots in SharkCraft
 * today). Skips `node_modules`, `dist`, `.sharkcraft`, and `*.d.ts`.
 *
 * Returns paths relative to `projectRoot` so they're directly
 * pasteable into a `references[]` entry.
 */
function buildSymbolFileIndex(projectRoot: string): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  // Bounded BFS over known source roots. We explicitly stay out of
  // node_modules / dist / .sharkcraft / examples / tools to avoid
  // exploding the scan over the workspace.
  const roots = ['packages'];
  for (const root of roots) {
    const abs = nodePath.join(projectRoot, root);
    if (!existsSync(abs)) continue;
    walkForSymbols(abs, projectRoot, index);
  }
  const out = new Map<string, readonly string[]>();
  for (const [k, v] of index) out.set(k, [...v]);
  return out;
}

/**
 * Build a `basename → [relative file paths...]` index over the same
 * source roots `buildSymbolFileIndex` covers. Used to detect file
 * renames (the common case when a directory is moved).
 */
function buildBasenameFileIndex(
  projectRoot: string,
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const root of ['packages', 'sharkcraft', 'docs', 'examples']) {
    const abs = nodePath.join(projectRoot, root);
    if (!existsSync(abs)) continue;
    walkForBasenames(abs, projectRoot, index, /* dirs */ false);
  }
  const out = new Map<string, readonly string[]>();
  for (const [k, v] of index) out.set(k, [...v]);
  return out;
}

/**
 * Build a `basename → [relative directory paths...]` index over
 * the same source roots. Used to detect directory renames.
 */
function buildBasenameDirIndex(
  projectRoot: string,
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const root of ['packages', 'sharkcraft', 'docs', 'examples']) {
    const abs = nodePath.join(projectRoot, root);
    if (!existsSync(abs)) continue;
    walkForBasenames(abs, projectRoot, index, /* dirs */ true);
  }
  const out = new Map<string, readonly string[]>();
  for (const [k, v] of index) out.set(k, [...v]);
  return out;
}

function walkForBasenames(
  dir: string,
  projectRoot: string,
  out: Map<string, string[]>,
  collectDirs: boolean,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === '.sharkcraft' || e.startsWith('.')) continue;
    const full = nodePath.join(dir, e);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const rel = nodePath.relative(projectRoot, full);
    if (st.isDirectory()) {
      if (collectDirs) {
        const key = e;
        let list = out.get(key);
        if (!list) {
          list = [];
          out.set(key, list);
        }
        if (!list.includes(rel)) list.push(rel);
      }
      if (e === '__tests__' || e === 'fixtures') continue;
      walkForBasenames(full, projectRoot, out, collectDirs);
    } else if (st.isFile() && !collectDirs) {
      // Skip auto-generated noise.
      if (e.endsWith('.d.ts')) continue;
      const key = e;
      let list = out.get(key);
      if (!list) {
        list = [];
        out.set(key, list);
      }
      if (!list.includes(rel)) list.push(rel);
    }
  }
}

/**
 * Given a stale reference path and a basename → candidates index,
 * return a unique candidate iff:
 *   1. The basename exists in the index.
 *   2. Exactly one candidate matches.
 *   3. That candidate is not the same path as the stale one.
 *   4. The candidate shares ≥1 non-trivial parent-directory segment with
 *      the stale path (so we don't propose unrelated namesakes).
 */
function pickUniqueRenameCandidate(
  stalePath: string,
  index: ReadonlyMap<string, readonly string[]>,
): string | null {
  const norm = stalePath.split(/[\\/]/).join('/').replace(/^\.\//, '');
  const basename = nodePath.basename(norm);
  if (!basename) return null;
  const candidates = (index.get(basename) ?? []).filter((c) => c !== norm);
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  const staleSegments = new Set(norm.split('/').filter((s) => s.length > 0 && s !== basename));
  const candidateSegments = candidate.split('/').filter((s) => s.length > 0 && s !== basename);
  let overlap = 0;
  for (const seg of candidateSegments) {
    if (staleSegments.has(seg)) overlap++;
  }
  if (overlap < 1) return null;
  return candidate;
}

function walkForSymbols(
  dir: string,
  projectRoot: string,
  out: Map<string, string[]>,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === '.sharkcraft' || e.startsWith('.')) continue;
    const full = nodePath.join(dir, e);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (e === '__tests__' || e === 'fixtures') continue;
      walkForSymbols(full, projectRoot, out);
      continue;
    }
    if (!st.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(e) || e.endsWith('.d.ts') || e.endsWith('.test.ts')) continue;
    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const re = /^export\s+(?:async\s+)?(?:function|class|interface|enum|type|const|let|var)\s+([A-Z_a-z][A-Z_a-z0-9]*)\b/gm;
    let m: RegExpExecArray | null;
    const rel = nodePath.relative(projectRoot, full);
    while ((m = re.exec(text)) !== null) {
      const name = m[1]!;
      let list = out.get(name);
      if (!list) {
        list = [];
        out.set(name, list);
      }
      if (!list.includes(rel)) list.push(rel);
    }
  }
}

function checkAnchor(
  inspection: ISharkcraftInspection,
  anchor: IKnowledgeAnchor,
): { outcome: ReferenceCheckOutcome; message: string } {
  switch (anchor.kind) {
    case 'file':
      if (!anchor.path) {
        return { outcome: ReferenceCheckOutcome.Unknown, message: 'anchor has no path' };
      }
      if (fileExists(inspection.projectRoot, anchor.path)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `anchor file exists: ${anchor.path}` };
      }
      return { outcome: ReferenceCheckOutcome.Stale, message: `anchor file missing: ${anchor.path}` };
    case 'symbol':
      return checkSymbolAnchor(inspection, anchor);
    case 'command':
      if (anchor.targetId && commandExistsInInspection(inspection, anchor.targetId)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `command exists: ${anchor.targetId}` };
      }
      return { outcome: ReferenceCheckOutcome.Stale, message: `command anchor unresolved: ${anchor.targetId ?? '?'}` };
    case 'construct':
      if (anchor.targetId && constructExists(inspection, anchor.targetId)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `construct exists: ${anchor.targetId}` };
      }
      return { outcome: ReferenceCheckOutcome.Stale, message: `construct anchor unresolved: ${anchor.targetId ?? '?'}` };
    case 'template':
      if (anchor.targetId && templateExists(inspection, anchor.targetId)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `template exists: ${anchor.targetId}` };
      }
      return { outcome: ReferenceCheckOutcome.Stale, message: `template anchor unresolved: ${anchor.targetId ?? '?'}` };
    case 'helper':
      if (anchor.targetId && helperExists(anchor.targetId)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `helper exists: ${anchor.targetId}` };
      }
      return { outcome: ReferenceCheckOutcome.Stale, message: `helper anchor unresolved: ${anchor.targetId ?? '?'}` };
    case 'playbook':
      if (anchor.targetId && playbookExists(inspection, anchor.targetId)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `playbook exists: ${anchor.targetId}` };
      }
      return { outcome: ReferenceCheckOutcome.Stale, message: `playbook anchor unresolved: ${anchor.targetId ?? '?'}` };
    case 'policy':
      if (anchor.targetId && policyExists(inspection, anchor.targetId)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `policy exists: ${anchor.targetId}` };
      }
      return { outcome: ReferenceCheckOutcome.Stale, message: `policy anchor unresolved: ${anchor.targetId ?? '?'}` };
  }
}

function checkSymbolAnchor(
  inspection: ISharkcraftInspection,
  anchor: IKnowledgeAnchor,
): { outcome: ReferenceCheckOutcome; message: string } {
  const r = checkSymbolReference(inspection.projectRoot, {
    kind: 'symbol',
    symbol: anchor.symbol,
    ...(anchor.path ? { path: anchor.path } : {}),
  });
  return { outcome: r.outcome, message: r.message };
}
