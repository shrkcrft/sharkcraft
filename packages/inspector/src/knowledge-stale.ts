/**
 * Knowledge stale-check — THE staleness engine (every consumer reads it).
 *
 * Walks every knowledge entry's `references[]` + `anchors[]` — and the
 * references boundary rules and policy checks declare — and checks whether each
 * target still resolves against the current workspace, and (with `contains` /
 * `matches` / `count`) still says what the asset claims.
 *
 * It classifies every entry in scope into ONE of three buckets: `verified`,
 * `stale`, `unverifiable`. An entry with nothing checkable used to contribute
 * nothing and read as healthy — the less verifiable a corpus, the healthier it
 * looked. The buckets make that shortfall a number the verdict can refuse on.
 *
 * Callers MUST `await warmReferenceRegistries(inspection)` first: the
 * playbook / policy / construct / helper registries are async-filled, and an
 * unwarmed registry is reported `unknown` (NOT VERIFIED) here — never `stale`
 * against a correct id.
 *
 * Pure file-system + registry lookups — no network, no whole-program
 * compilation. Symbol checks use the single-file AST index.
 *
 * Schema: sharkcraft.knowledge-stale/v1 (additive fields since round 11)
 */

import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import * as nodePath from 'node:path';
import { globListSelects, globToRegex } from '@shrkcrft/boundaries';
import { KnowledgeReferenceRoot, type IAssetReference } from '@shrkcrft/core';
import {
  KNOWLEDGE_REFERENCE_KINDS,
  referenceRootProblem,
  anchorShapeProblem,
  anchorsListProblem,
  declaredAnchorItems,
  declaredReferenceItems,
  knowledgeAnchors,
  knowledgeSourceFormat,
  referenceShapeProblem,
  referencesListProblem,
  todayUtcIso,
  verifiedOnAgeDays,
  type IKnowledgeAnchor,
  type IKnowledgeEntry,
  type IKnowledgeReference,
  type KnowledgeReferenceKind,
} from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  isCacheBackedKind,
  isReferenceCacheWarm,
  referenceIdExists,
  referenceIdsFor,
  type ReferenceKind,
} from './reference-registry.ts';
import { listPolicyDeclarations } from './policy-registry.ts';
import {
  checkReferenceContent,
  checkReferenceCount,
  hasContentAssertion,
  type IReferenceAssertionResult,
} from './reference-content-check.ts';
import { ReferenceFailure } from './reference-failure.ts';
import { KnowledgeEntryVerdict } from './knowledge-entry-verdict.ts';
import { KnowledgeUnverifiableReason } from './knowledge-unverifiable-reason.ts';
import type { IKnowledgeEntryVerdictRecord } from './knowledge-entry-verdict-record.ts';
import type { IKnowledgeStaleCoverage } from './knowledge-stale-coverage.ts';
import type { IKnowledgeKindBucket } from './knowledge-kind-bucket.ts';
import type { IKnowledgeReferenceKindBucket } from './knowledge-reference-kind-bucket.ts';
import type { IKnowledgeStaleAdvisory } from './knowledge-stale-advisory.ts';
import type { IKnowledgeAgedEntry } from './knowledge-aged-entry.ts';
import { KnowledgeAdvisoryCode } from './knowledge-advisory-code.ts';
import { knowledgeRejectedEntries } from './knowledge-entry-rejections.ts';
import type { IKnowledgeRejectedEntry } from './knowledge-rejected-entry.ts';
import { ReferenceAssetKind } from './reference-asset-kind.ts';
import type { IReferenceSubject } from './reference-subject.ts';
import { stalePathHint } from './stale-path-hint.ts';
import type { IStalePathHintInput } from './i-stale-path-hint-input.ts';
import { buildSymbolIndex, type ISymbolIndex } from './symbol-index.ts';
// The `command` reference case (and its anchor twin) — one injected resolver.
import { COMMAND_INDEX_NOT_INJECTED, resolveShrkCommandReference } from './reference-registry.ts';
import { CommandResolutionStatus } from './command-resolution-status.ts';
import { resolveSymbolInFile, SymbolResolution } from './symbol-index.ts';
// Round 15 follow-up (F7): a pack's `root: pack` reference resolves against its package directory.
import type { IReferencePackOrigin } from './i-reference-pack-origin.ts';
import { packOriginByName, packOriginOfFile } from './reference-pack-origin.ts';

export const KNOWLEDGE_STALE_SCHEMA = 'sharkcraft.knowledge-stale/v1';

/** The `byReferenceKind` bucket of an item with no kind to bucket under (a string, a non-list value). */
const MALFORMED_KIND_BUCKET = '(malformed)';

/**
 * A declared value as a check row carries it: `null` / `undefined` become their
 * text, so no renderer dereferences them; anything else as declared
 * (`formatKnowledgeReference` renders a non-object as written). The CHECK reads
 * the original, so a `null` item says "is not an object (got null)" — the
 * validator's words — not "is the string \"null\"".
 */
function displayedReference(value: unknown): IKnowledgeReference {
  return (value === null || value === undefined ? String(value) : value) as IKnowledgeReference;
}

export enum ReferenceCheckOutcome {
  Ok = 'ok',
  Stale = 'stale',
  Missing = 'missing',
  /** Well-formed, but the check cannot evaluate it (a `url`, an unwarmed registry). */
  Unknown = 'unknown',
  /**
   * MALFORMED — a kind outside the vocabulary, or the field its kind cannot be
   * checked without is missing (a symbol reference with no `symbol`). It
   * verifies nothing; it used to share `unknown` with an unfetched url and
   * count toward a green run. Now it is a coverage shortfall on the verdict
   * (not verified) and fails under `--fail-on invalid`.
   */
  Invalid = 'invalid',
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
  /**
   * WHY a non-ok check did not pass — additive to {@link outcome}, which keeps
   * its historical values. Lets `--fail-on path-missing|anchor-missing|content|count`
   * gate each failure mode separately.
   */
  failure?: ReferenceFailure;
  /** For a content / count assertion: what the asset claims. */
  expected?: string | number;
  /** For a content / count assertion: what the tree holds now. */
  actual?: string | number;
  /** Which asset kind declared the reference. Absent on knowledge checks (the historical shape). */
  assetKind?: ReferenceAssetKind;
  /** True for an IMPLICIT reference derived from a scope glob — advisory unless `--fail-on implicit`. */
  implicit?: boolean;
}

export interface IKnowledgeAnchorCheck {
  entryId: string;
  anchor: IKnowledgeAnchor;
  outcome: ReferenceCheckOutcome;
  message: string;
  /** WHY a non-ok anchor did not pass. */
  failure?: ReferenceFailure;
}

export interface IKnowledgeStaleReport {
  schema: typeof KNOWLEDGE_STALE_SCHEMA;
  /** Knowledge entries in the CORPUS. A scoped run examines {@link entriesInScope}. */
  entries: number;
  totalReferences: number;
  totalAnchors: number;
  /**
   * Knowledge-reference outcomes (anchors and other assets' references are
   * counted elsewhere). `invalid` = malformed references, never checked.
   */
  counts: { ok: number; stale: number; missing: number; unknown: number; invalid: number };
  referenceChecks: ReadonlyArray<IKnowledgeReferenceCheck>;
  anchorChecks: ReadonlyArray<IKnowledgeAnchorCheck>;
  /** Knowledge entries the sweep examined — `changedFiles` narrows this, never {@link entries}. */
  entriesInScope: number;
  /** The three entry buckets over {@link entriesInScope}. */
  coverage: IKnowledgeStaleCoverage;
  /** One verdict per knowledge entry in scope, in corpus order. */
  entryVerdicts: ReadonlyArray<IKnowledgeEntryVerdictRecord>;
  /** Every unverifiable entry id in scope (renderers cap; this never does). */
  unverifiableIds: ReadonlyArray<string>;
  /**
   * Round 15 follow-up (F3): knowledge-family entries the LOADER REFUSED (THE
   * rejection channel, `knowledgeRejectedEntries`). Never in {@link entries} or
   * {@link entryVerdicts} — nothing they claim was read, let alone checked — so
   * the verdict counts each one UNEXAMINED (an INVALID-class row; `--fail-on
   * invalid` makes it a failure). Never narrowed by `changedFiles`: a refused
   * entry's references were never read, so no changeset can prove it untouched.
   */
  rejectedEntries: ReadonlyArray<IKnowledgeRejectedEntry>;
  /** Non-ok checks per {@link ReferenceFailure} — knowledge references, anchors and other assets. */
  failureCounts: Readonly<Record<ReferenceFailure, number>>;
  /** Per asset kind. `scanned: 0` means NOT IN SWEEP — say so, never render it as clean zeros. */
  byAssetKind: Readonly<Record<ReferenceAssetKind, IKnowledgeKindBucket>>;
  /** Per knowledge entry `type` (rules and paths are where unreferenced entries cluster). */
  byEntryType: Readonly<Record<string, IKnowledgeKindBucket>>;
  /** Per reference kind, knowledge and other assets together. */
  byReferenceKind: Readonly<Record<string, IKnowledgeReferenceKindBucket>>;
  /**
   * References declared by boundary rules and policy checks, plus IMPLICIT
   * boundary references (`implicit: true`). Kept apart from
   * {@link referenceChecks} so the nine consumers that map a check back to a
   * knowledge entry never meet a rule id.
   */
  assetReferenceChecks: ReadonlyArray<IKnowledgeReferenceCheck>;
  /** Reported, never gating on their own. */
  advisories: ReadonlyArray<IKnowledgeStaleAdvisory>;
  /**
   * Policy checks keep their scope inside `evaluate()`; only declared
   * references can verify them. `loaded: false` = the policy cache was not
   * warm, so policies were NOT IN SWEEP.
   */
  policySweep: { readonly loaded: boolean; readonly declared: number; readonly withReferences: number };
  /** Set when `staleAfterDays` was requested. */
  age?: {
    readonly asOf: string;
    readonly staleAfterDays: number;
    /** Oldest first. */
    readonly aged: ReadonlyArray<IKnowledgeAgedEntry>;
    /** In scope with no (valid) `verifiedOn`. */
    readonly neverVerified: ReadonlyArray<string>;
  };
}

/**
 * Minimal structural view of the code graph's symbol index.
 *
 * `GraphQueryApi.findSymbol` satisfies this shape. Inspector sits *below*
 * `@shrkcrft/graph` in the layer order and therefore cannot import it; the
 * gate (which lives above the graph) injects a resolver that conforms to
 * this interface so symbol checks can resolve cross-file without an upward
 * dependency.
 */
export interface ISymbolGraphResolver {
  /** Return the declaration nodes for `name` (project-relative `path`). */
  findSymbol(name: string): ReadonlyArray<{ path?: string; line?: number }>;
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
  /**
   * Optional code-graph resolver. When supplied, symbol references are
   * resolved cross-file via the graph's global symbol index (so a *moved*
   * symbol is distinguished from a deleted one) and only fall back to the
   * single-file AST scan when the graph cannot answer.
   */
  graph?: ISymbolGraphResolver;
  /**
   * `--stale-after`, in days: list entries whose `verifiedOn` is older than
   * this (and those with none). Author attestation — it never changes a
   * reference outcome.
   */
  staleAfterDays?: number;
  /** The date ages are measured to (`YYYY-MM-DD`). Default: today, UTC — echoed in `age.asOf`. */
  asOf?: string;
  /** Sweep boundary-rule and policy references too. Default `true`. */
  includeAssets?: boolean;
  /** Directories a `count` source never walks (e.g. the sharkcraft dir). */
  excludeDirs?: readonly string[];
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

/*
 * Existence checks delegate to the SHARED reference registry.
 *
 * They used to be private copies here, each reading a differently-shaped
 * structural cast off the inspection (`playbookRegistry`, `constructRegistry`,
 * `policyChecks`) — properties nothing ever attached, so those kinds answered
 * "does not exist" for every id including correct ones. An unchecked cast to a
 * hoped-for shape compiles perfectly and fails silently forever; the registry
 * imports the real accessors so the compiler can see a rename.
 */

/**
 * A `command` reference (or anchor) through THE injected command resolver.
 *
 * Without a resolver (outside the CLI) the command was NOT checked: that is
 * `Unknown` with a loud NOT VERIFIED message — never `Ok`. It used to be `Ok`
 * for every `shrk …` string, which certified three dead commands in shrk's own
 * knowledge as "Command available".
 *
 * Read as a command REFERENCE (`resolveShrkCommandReference`): a bare
 * `frobnicate` is `shrk frobnicate` — stale — exactly as the self-config
 * doctor and the agent-test runner read it, never `not-shrk` → `ok`.
 */
function checkCommandString(
  inspection: ISharkcraftInspection,
  id: string,
  label: string,
): { outcome: ReferenceCheckOutcome; message: string; suggestion?: string } {
  const resolution = resolveShrkCommandReference(inspection, id);
  switch (resolution.status) {
    case CommandResolutionStatus.Unverified:
      return {
        outcome: ReferenceCheckOutcome.Unknown,
        message: `${label} ${id}: ${COMMAND_INDEX_NOT_INJECTED}`,
        suggestion: 'Run the check through the CLI (`shrk knowledge stale-check`), which injects the live command index.',
      };
    case CommandResolutionStatus.Ok:
    case CommandResolutionStatus.PrefixOnly:
    case CommandResolutionStatus.NotShrk:
      return {
        outcome: ReferenceCheckOutcome.Ok,
        message:
          resolution.status === CommandResolutionStatus.Ok
            ? `Command available: ${id}`
            : `Command ${id}: ${resolution.status}${resolution.reason ? ` (${resolution.reason})` : ''}`,
      };
    default: {
      const closest = resolution.closest ?? [];
      return {
        outcome: ReferenceCheckOutcome.Stale,
        message: `Command not registered: ${id} (${resolution.status}${resolution.reason ? ` — ${resolution.reason}` : ''})`,
        suggestion:
          closest.length > 0
            ? `Did you mean \`${closest[0]}\`? Update the reference (or run \`shrk surface list\` for every real command).`
            : 'Update the reference — run `shrk surface list` for every real command.',
      };
    }
  }
}

/** One reference / anchor check, before it is attached to its subject. */
interface IRefResult {
  outcome: ReferenceCheckOutcome;
  confidence?: SymbolConfidence;
  message: string;
  suggestion?: string;
  failure?: ReferenceFailure;
  expected?: string | number;
  actual?: string | number;
  /** A pinned symbol's declaration span — what `contains` / `matches` read. */
  span?: { start: number; end: number };
  /** An `Owner.member` spelling that WOULD resolve, for a bare member name. */
  suggestedSymbol?: string;
}

/**
 * Why an id could not be CHECKED against a cache-backed registry, or undefined
 * when the registry is loaded and non-empty.
 *
 * A negative answer from an unloaded (or empty) registry proves nothing: every
 * id checked against it would be reported stale, including correct ones — the
 * fastest way to get a check switched off. So it reads as NOT VERIFIED
 * (`unknown`), the same safety net the doc-reference linter uses. A POSITIVE
 * answer is always trusted.
 */
function unloadedRegistryReason(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
): string | undefined {
  if (!isCacheBackedKind(kind)) return undefined;
  if (!isReferenceCacheWarm(inspection)) {
    return `the ${kind} registry was not loaded — call warmReferenceRegistries() before building the report (NOT VERIFIED)`;
  }
  if (referenceIdsFor(inspection, kind).length === 0) {
    return `the ${kind} registry is empty — it failed to load, or this repo declares no ${kind}s (NOT VERIFIED)`;
  }
  return undefined;
}

/**
 * An id-keyed reference, through THE shared resolver. The helper kind reads
 * built-ins AND pack helpers there; a private built-in-only list used to answer
 * here, calling every pack helper stale.
 */
function checkRegisteredId(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
  id: string,
  label: string,
): IRefResult {
  if (referenceIdExists(inspection, kind, id)) {
    return { outcome: ReferenceCheckOutcome.Ok, message: `${label} exists: ${id}` };
  }
  const unloaded = unloadedRegistryReason(inspection, kind);
  if (unloaded) {
    return {
      outcome: ReferenceCheckOutcome.Unknown,
      failure: ReferenceFailure.Unverifiable,
      message: `${label} ${id}: ${unloaded}`,
      suggestion: 'Run through the CLI (`shrk knowledge stale-check`), which loads every registry first.',
    };
  }
  return staleId(kind, id);
}

/** Workspace package name → its directory (relative), per inspection. */
const WORKSPACE_PACKAGES = new WeakMap<object, ReadonlyMap<string, string>>();

function readPackageJson(abs: string): { name?: unknown; workspaces?: unknown } | null {
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as { name?: unknown; workspaces?: unknown };
  } catch {
    return null;
  }
}

/** Directories (relative) matching one `workspaces` glob. */
function expandWorkspaceGlob(projectRoot: string, pattern: string): string[] {
  const norm = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  const segs = norm.split('/');
  const firstGlob = segs.findIndex((s) => /[*?[{]/.test(s));
  if (firstGlob === -1) return [norm];
  const maxDepth = segs.includes('**') ? 4 : segs.length - firstGlob;
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(nodePath.join(projectRoot, rel));
    } catch {
      return;
    }
    for (const n of names) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const child = rel ? `${rel}/${n}` : n;
      if (!dirExists(projectRoot, child)) continue;
      // One `workspaces` pattern against one directory — not a gate-plane list.
      if (globToRegex(norm).test(child)) out.push(child);
      walk(child, depth + 1);
    }
  };
  walk(segs.slice(0, firstGlob).join('/'), 1);
  return out;
}

/**
 * Every workspace package the root `package.json` declares — the packages its
 * `workspaces` globs reach, by their `name`. This replaces a read of
 * `inspection.packages`, a property the inspection never has (the phantom-cast
 * bug class): it answered "not a package" for every id and fell through to a
 * hard-coded `packages/<name>` layout.
 */
function workspacePackages(inspection: ISharkcraftInspection): ReadonlyMap<string, string> {
  const cached = WORKSPACE_PACKAGES.get(inspection);
  if (cached) return cached;
  const out = new Map<string, string>();
  const root = readPackageJson(nodePath.join(inspection.projectRoot, 'package.json'));
  if (root) {
    if (typeof root.name === 'string') out.set(root.name, '.');
    const ws = root.workspaces as unknown;
    const patterns: unknown[] = Array.isArray(ws)
      ? ws
      : Array.isArray((ws as { packages?: unknown } | null)?.packages)
        ? ((ws as { packages: unknown[] }).packages)
        : [];
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
      for (const dir of expandWorkspaceGlob(inspection.projectRoot, pattern)) {
        const pkg = readPackageJson(nodePath.join(inspection.projectRoot, dir, 'package.json'));
        if (pkg && typeof pkg.name === 'string' && !out.has(pkg.name)) out.set(pkg.name, dir);
      }
    }
  }
  WORKSPACE_PACKAGES.set(inspection, out);
  return out;
}

function checkPackageReference(
  inspection: ISharkcraftInspection,
  id: string,
  origin?: IReferencePackOrigin,
): IRefResult {
  const dir = workspacePackages(inspection).get(id);
  if (dir) {
    return { outcome: ReferenceCheckOutcome.Ok, message: `Package exists: ${id} (${dir})` };
  }
  // A pack's entry naming the pack that ships it (round 15 follow-up): the
  // consumer's root package.json names neither its installed packs nor their
  // names, but the contributing pack is installed by definition.
  if (origin && origin.packageName === id) {
    return {
      outcome: ReferenceCheckOutcome.Ok,
      message: `Package exists: ${id} (the contributing pack, installed at ${origin.displayRoot})`,
    };
  }
  // Last-resort backstop for repos without a `workspaces` field — reported as
  // probable, because a directory name is not a package name.
  const rel = id.startsWith('@') ? (id.split('/')[1] ?? '') : id;
  if (rel && dirExists(inspection.projectRoot, `packages/${rel}`)) {
    return {
      outcome: ReferenceCheckOutcome.Ok,
      message: `Package exists (probable): packages/${rel}/ is present, but no workspace package.json declares the name ${id}.`,
    };
  }
  return staleId('package', id);
}

function normalizeRel(p: string): string {
  return p.split(/[\\/]/).join('/').replace(/^\.\//, '');
}

/** `Foo` for `Foo.bar` / `Foo.prototype.bar`; null for a bare name. */
function qualifiedOwner(sym: string): string | null {
  const cleaned = sym.replace(/\.prototype\./g, '.');
  const dot = cleaned.indexOf('.');
  return dot > 0 && dot < cleaned.length - 1 ? cleaned.slice(0, dot) : null;
}

function checkSymbolReference(
  projectRoot: string,
  ref: IKnowledgeReference,
  graph?: ISymbolGraphResolver,
): IRefResult & { confidence: SymbolConfidence } {
  const sym = ref.symbol ?? '';
  if (!sym) {
    return {
      outcome: ReferenceCheckOutcome.Invalid,
      confidence: SymbolConfidence.Unknown,
      failure: ReferenceFailure.Malformed,
      message: 'malformed reference: symbol reference missing required field `symbol`.',
    };
  }
  // `Owner.member`: the graph indexes top-level symbols only, so it answers for
  // the OWNER (moved-detection); the member itself is verified by the AST on
  // the owner's declaring file.
  const owner = qualifiedOwner(sym);
  const lookup = owner ?? sym;
  // Graph-resolved, cross-file path (preferred when a graph is supplied).
  // A single-file AST scan cannot tell a *moved* symbol from a deleted one;
  // the graph's global symbol index can, so consult it first.
  if (graph) {
    const decl = graph
      .findSymbol(lookup)
      .map((n) => n.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map(normalizeRel);
    if (decl.length > 0) {
      if (ref.path) {
        const target = normalizeRel(ref.path);
        if (!decl.includes(target)) {
          // Symbol exists but no longer at the pinned file — it moved.
          return {
            outcome: ReferenceCheckOutcome.Stale,
            confidence: SymbolConfidence.Missing,
            failure: ReferenceFailure.AnchorMissing,
            message: `Symbol \`${lookup}\` is no longer in ${ref.path}; the graph resolves it to ${decl
              .slice(0, 3)
              .join(', ')}.`,
          };
        }
        if (!owner && !hasContentAssertion(ref)) {
          return {
            outcome: ReferenceCheckOutcome.Ok,
            confidence: SymbolConfidence.Exact,
            message: `\`${sym}\` resolves to ${ref.path} (graph).`,
          };
        }
        // The owner is at the pinned file; the member (and any content span)
        // is verified by the AST below.
      } else if (!owner) {
        // No file pin, but the graph resolved it cross-file.
        return {
          outcome: ReferenceCheckOutcome.Ok,
          confidence: SymbolConfidence.Probable,
          message: `\`${sym}\` resolves via the code graph to ${decl.slice(0, 3).join(', ')}.`,
        };
      } else if (decl.length === 1) {
        return resolveSymbolAtPath(projectRoot, decl[0]!, sym, false);
      } else {
        return {
          outcome: ReferenceCheckOutcome.Unknown,
          confidence: SymbolConfidence.Unknown,
          failure: ReferenceFailure.Unverifiable,
          message: `\`${owner}\` is declared in ${decl.length} files (${decl.slice(0, 3).join(', ')}) — pin the path to check \`${sym}\`.`,
        };
      }
    } else if (!ref.path) {
      // Absent from the graph. The graph may be partial (locals, unindexed
      // languages), so fall through to the AST/text backstop when a file is
      // pinned; otherwise we cannot verify.
      return {
        outcome: ReferenceCheckOutcome.Unknown,
        confidence: SymbolConfidence.Unknown,
        failure: ReferenceFailure.Unverifiable,
        message: `Symbol reference \`${sym}\` has no file pin and is absent from the code graph; stale-check cannot verify.`,
      };
    }
  }
  if (ref.path) return resolveSymbolAtPath(projectRoot, ref.path, sym, true);
  // No file pinned — best-effort confidence is `unknown`.
  return {
    outcome: ReferenceCheckOutcome.Unknown,
    confidence: SymbolConfidence.Unknown,
    failure: ReferenceFailure.Unverifiable,
    message: `Symbol reference \`${sym}\` has no file pin; stale-check cannot verify (pin it as \`symbol:${sym}@<path>\`).`,
  };
}

/** Resolve `sym` in one file through the AST index (text-scan backstop). */
function resolveSymbolAtPath(
  projectRoot: string,
  relPath: string,
  sym: string,
  pinned: boolean,
): IRefResult & { confidence: SymbolConfidence } {
  const file = nodePath.join(projectRoot, relPath);
  if (!existsSync(file)) {
    return {
      outcome: ReferenceCheckOutcome.Missing,
      confidence: SymbolConfidence.Missing,
      failure: ReferenceFailure.PathMissing,
      message: `Referenced file does not exist: ${relPath}`,
    };
  }
  const via = pinned ? '' : ` (declaring file ${relPath}, from the code graph)`;
  // AST-backed resolution (falls back to text-scan if parse fails).
  try {
    const res = resolveSymbolInFile(file, sym);
    switch (res.resolution) {
      case SymbolResolution.ExactExport:
      case SymbolResolution.ExactLocal:
      case SymbolResolution.ExactReExport:
      case SymbolResolution.ExactMember:
      case SymbolResolution.ExactLocalMember:
        return {
          outcome: ReferenceCheckOutcome.Ok,
          confidence: pinned ? SymbolConfidence.Exact : SymbolConfidence.Probable,
          message: res.message + via,
          ...(res.span ? { span: res.span } : {}),
        };
      case SymbolResolution.ProbableText:
        return {
          outcome: ReferenceCheckOutcome.Ok,
          confidence: SymbolConfidence.Probable,
          message: res.message + via,
        };
      case SymbolResolution.Missing:
        return {
          outcome: ReferenceCheckOutcome.Stale,
          confidence: SymbolConfidence.Missing,
          failure: ReferenceFailure.AnchorMissing,
          message: res.message + via,
          ...(res.suggestedSymbol ? { suggestedSymbol: res.suggestedSymbol } : {}),
        };
      default:
        return {
          outcome: ReferenceCheckOutcome.Unknown,
          confidence: SymbolConfidence.Unknown,
          failure: ReferenceFailure.Unverifiable,
          message: res.message + via,
        };
    }
  } catch {
    // Fallback to text scan.
    const token = qualifiedOwner(sym) ? sym.slice(sym.lastIndexOf('.') + 1) : sym;
    try {
      const text = readFileSync(file, 'utf8');
      const declRe = new RegExp(
        `(export\\s+(?:async\\s+)?(?:function|class|interface|enum|type|const|let|var)\\s+|class\\s+|function\\s+)${escapeRe(token)}\\b`,
      );
      if (declRe.test(text)) {
        return {
          outcome: ReferenceCheckOutcome.Ok,
          confidence: SymbolConfidence.Exact,
          message: `Found declaration of \`${sym}\` in ${relPath}.`,
        };
      }
      if (text.includes(token)) {
        return {
          outcome: ReferenceCheckOutcome.Ok,
          confidence: SymbolConfidence.Probable,
          message: `\`${sym}\` appears in ${relPath}, but not as an exported declaration.`,
        };
      }
      return {
        outcome: ReferenceCheckOutcome.Stale,
        confidence: SymbolConfidence.Missing,
        failure: ReferenceFailure.AnchorMissing,
        message: `Symbol \`${sym}\` not found in ${relPath}.`,
      };
    } catch {
      return {
        outcome: ReferenceCheckOutcome.Unknown,
        confidence: SymbolConfidence.Unknown,
        failure: ReferenceFailure.Unverifiable,
        message: `Failed to read ${relPath}.`,
      };
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check one reference: does its target exist — and, when it declares
 * `contains` / `matches` / `count`, does the target still say what the asset
 * claims. Every non-ok result carries a {@link ReferenceFailure}.
 */
function checkReference(
  inspection: ISharkcraftInspection,
  ref: IKnowledgeReference,
  graph?: ISymbolGraphResolver,
  excludeDirs: readonly string[] = [],
  origin?: IReferencePackOrigin,
  subject?: Pick<IStalePathHintInput, 'sourceFormat' | 'source'>,
): IRefResult {
  // THE item-shape predicate the validator applies (a string the grammar
  // refused, a number, a non-string `path`): MALFORMED here — never a crash in a
  // path join, never a silent row.
  const shape = referenceShapeProblem(ref);
  if (shape) {
    return {
      outcome: ReferenceCheckOutcome.Invalid,
      failure: ReferenceFailure.Malformed,
      message: `malformed reference: ${shape}.`,
    };
  }
  // THE `root` predicate the validator applies (round 15 follow-up): `root:
  // pack` on an asset no pack contributes is MALFORMED — never a silent
  // fallback to the project root, which would read a different file.
  const rootProblem = referenceRootProblem(ref, origin !== undefined);
  if (rootProblem?.severity === 'error') {
    return {
      outcome: ReferenceCheckOutcome.Invalid,
      failure: ReferenceFailure.Malformed,
      message: `malformed reference: ${rootProblem.message}.`,
    };
  }
  // A `root: pack` that has an effect (the predicate's warning means none)
  // moves every path read — the target, `contains` / `matches`, a `count`
  // source — into the contributing pack's directory. The consumer's code graph
  // never indexes a pack's files, and its count exclusions are consumer paths.
  const pack = origin !== undefined && rootProblem === undefined && isPackRooted(ref) ? origin : undefined;
  const rootDir = pack ? pack.packageRoot : inspection.projectRoot;
  const base = checkReferenceTarget(inspection, ref, pack ? undefined : graph, rootDir, origin);
  const asserted =
    base.outcome === ReferenceCheckOutcome.Ok ? applyAssertions(rootDir, ref, base, pack ? [] : excludeDirs) : base;
  const result =
    asserted.outcome === ReferenceCheckOutcome.Ok || asserted.failure !== undefined
      ? asserted
      : { ...asserted, failure: defaultFailure(ref.kind, asserted.outcome) };
  const labelled = pack ? packRootedResult(result, pack) : result;
  return withStalePathHint(labelled, ref, origin, pack !== undefined, subject);
}

/** A reference whose path resolves against its contributing pack's directory (`root: pack`). */
function isPackRooted(ref: unknown): boolean {
  return ref !== null && typeof ref === 'object' && (ref as { root?: unknown }).root === KnowledgeReferenceRoot.Pack;
}

/**
 * Every row of a pack-rooted reference names the root it resolved against —
 * the renderers (text, gate violations, markdown, MCP) all print the message.
 * A missing path is fixed in the pack, never by a consumer-side rename (the
 * hint is {@link stalePathHint}'s).
 */
function packRootedResult(result: IRefResult, pack: IReferencePackOrigin): IRefResult {
  return { ...result, message: `${result.message} (root: pack — ${pack.packageName} at ${pack.displayRoot})` };
}

/**
 * A missing path's hint, from THE authority ({@link stalePathHint}, round 15
 * closing A3): who declared the reference decides who fixes it — a pack (the
 * round-15 repro: a pack doc referencing its own file read STALE, with a hint
 * to rename a file the consumer does not own), a Markdown entry's frontmatter,
 * or a rename. No other code path sets a missing path's `suggestion`.
 */
function withStalePathHint(
  result: IRefResult,
  ref: IKnowledgeReference,
  origin: IReferencePackOrigin | undefined,
  packRooted: boolean,
  subject: Pick<IStalePathHintInput, 'sourceFormat' | 'source'> | undefined,
): IRefResult {
  if (result.failure !== ReferenceFailure.PathMissing || typeof ref.path !== 'string' || ref.path === '') return result;
  const suggestion = stalePathHint({
    kind: String(ref.kind),
    path: normalizeRel(ref.path),
    packRooted,
    ...(origin !== undefined ? { pack: origin } : {}),
    ...(subject?.sourceFormat !== undefined ? { sourceFormat: subject.sourceFormat } : {}),
    ...(subject?.source !== undefined ? { source: subject.source } : {}),
  });
  return suggestion === undefined ? result : { ...result, suggestion };
}

/**
 * A reference as the changeset scope sees it: a pack-rooted path — and a
 * pack-rooted `count` source's globs, the tree the count is MEASURED over —
 * made project-relative. Unprefixed, a count over the pack's `src/*.ts` was
 * scoped in by a change to the CONSUMER's `src/` and never by the pack's.
 */
function scopedReference(ref: IAssetReference, origin: IReferencePackOrigin | undefined): IAssetReference {
  if (!origin || !isPackRooted(ref) || origin.displayRoot === '.') return ref;
  const at = (rel: string): string => `${origin.displayRoot}/${normalizeRel(rel)}`;
  const globs = ref.count?.source?.files;
  return {
    ...ref,
    ...(typeof ref.path === 'string' ? { path: at(ref.path) } : {}),
    ...(ref.count && Array.isArray(globs)
      ? {
          count: {
            ...ref.count,
            source: {
              ...ref.count.source,
              files: globs.map((g) => (typeof g === 'string' && g.startsWith('!') ? `!${at(g.slice(1))}` : at(String(g)))),
            },
          },
        }
      : {}),
  };
}

/** The failure mode of a non-ok check that did not name one. */
function defaultFailure(kind: string, outcome: ReferenceCheckOutcome): ReferenceFailure {
  if (outcome === ReferenceCheckOutcome.Unknown) return ReferenceFailure.Unverifiable;
  if (outcome === ReferenceCheckOutcome.Invalid) return ReferenceFailure.Malformed;
  if (kind === 'file' || kind === 'directory') return ReferenceFailure.PathMissing;
  if (kind === 'symbol') return ReferenceFailure.AnchorMissing;
  return ReferenceFailure.IdUnregistered;
}

/**
 * Content and count assertions, over a target that EXISTS — a mismatch on a
 * missing file would report one break twice.
 */
function applyAssertions(
  projectRoot: string,
  ref: IKnowledgeReference,
  base: IRefResult,
  excludeDirs: readonly string[],
): IRefResult {
  const content = checkReferenceContent(projectRoot, ref, ref.kind === 'symbol' ? base.span : undefined);
  if (content && !content.ok) return assertionFailure(base, content, 'content');
  const count = checkReferenceCount(projectRoot, ref, countExcludeDirsFor(ref, excludeDirs));
  if (count && !count.ok) return assertionFailure(base, count, 'count');
  const held = [content?.message, count?.message].filter((m): m is string => m !== undefined);
  if (held.length === 0) return base;
  return {
    ...base,
    message: `${base.message} ${held.join(' ')}`,
    ...(count ? { expected: count.expected, actual: count.actual } : {}),
  };
}

function assertionFailure(
  base: IRefResult,
  a: IReferenceAssertionResult,
  what: 'content' | 'count',
): IRefResult {
  const confidence = base.confidence ? { confidence: base.confidence } : {};
  if (a.unverifiable) {
    return {
      outcome: ReferenceCheckOutcome.Unknown,
      ...confidence,
      failure: ReferenceFailure.Unverifiable,
      message: `${base.message} Its ${what} assertion could not be evaluated: ${a.message}`,
    };
  }
  return {
    outcome: ReferenceCheckOutcome.Stale,
    ...confidence,
    failure: a.failure ?? (what === 'count' ? ReferenceFailure.CountMismatch : ReferenceFailure.ContentMismatch),
    ...(a.expected !== undefined ? { expected: a.expected } : {}),
    ...(a.actual !== undefined ? { actual: a.actual } : {}),
    message: a.message,
    suggestion:
      what === 'count'
        ? `Update the claim in the entry, then set count.expected: ${String(a.actual)}.`
        : 'Update the entry (and the assertion) to what the code says now.',
  };
}

/** Does the reference's TARGET exist? (Assertions are layered on by {@link checkReference}.) */
function checkReferenceTarget(
  inspection: ISharkcraftInspection,
  ref: IKnowledgeReference,
  graph?: ISymbolGraphResolver,
  rootDir: string = inspection.projectRoot,
  origin?: IReferencePackOrigin,
): IRefResult {
  // The directory a path resolves against: the project root, or the
  // contributing pack's directory for a `root: pack` reference.
  const projectRoot = rootDir;
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
        failure: ReferenceFailure.PathMissing,
        message: `Directory missing: ${ref.path}`,
        // The hint is {@link stalePathHint}'s — who declared it decides (A3).
      };
    }
    case 'symbol': {
      const r = checkSymbolReference(projectRoot, ref, graph);
      return r;
    }
    case 'command': {
      const id = ref.id ?? ref.command ?? '';
      if (!id) return missingField('command', 'id or command');
      return checkCommandString(inspection, id, 'Command');
    }
    case 'template': {
      if (!ref.id) return missingField('template', 'id');
      return checkRegisteredId(inspection, 'template', ref.id, 'Template');
    }
    case 'playbook': {
      if (!ref.id) return missingField('playbook', 'id');
      return checkRegisteredId(inspection, 'playbook', ref.id, 'Playbook');
    }
    case 'construct': {
      if (!ref.id) return missingField('construct', 'id');
      return checkRegisteredId(inspection, 'construct', ref.id, 'Construct');
    }
    case 'helper': {
      if (!ref.id) return missingField('helper', 'id');
      return checkRegisteredId(inspection, 'helper', ref.id, 'Helper');
    }
    case 'policy': {
      if (!ref.id) return missingField('policy', 'id');
      return checkRegisteredId(inspection, 'policy', ref.id, 'Policy');
    }
    case 'boundary-rule': {
      if (!ref.id) return missingField('boundary-rule', 'id');
      return checkRegisteredId(inspection, 'boundary-rule', ref.id, 'Boundary rule');
    }
    case 'path-convention': {
      if (!ref.id) return missingField('path-convention', 'id');
      return checkRegisteredId(inspection, 'path-convention', ref.id, 'Path convention');
    }
    case 'package': {
      if (!ref.id) return missingField('package', 'id');
      return checkPackageReference(inspection, ref.id, origin);
    }
    case 'url': {
      // We never fetch URLs. Mark them unknown unless we can resolve to a
      // local docs file.
      return {
        outcome: ReferenceCheckOutcome.Unknown,
        failure: ReferenceFailure.Unverifiable,
        message: 'URL references are not verified (no network).',
      };
    }
    default:
      // A kind outside the vocabulary still loads (the validator reports it as
      // an error); here it is MALFORMED — never a crash, never a silent row.
      return {
        outcome: ReferenceCheckOutcome.Invalid,
        failure: ReferenceFailure.Malformed,
        message: `malformed reference: unsupported kind "${String((ref as { kind?: unknown }).kind)}" — expected one of: ${KNOWLEDGE_REFERENCE_KINDS.join(', ')}.`,
      };
  }
}

function missingField(kind: KnowledgeReferenceKind, field: string): IRefResult {
  return {
    outcome: ReferenceCheckOutcome.Invalid,
    failure: ReferenceFailure.Malformed,
    message: `malformed reference: ${kind} reference missing required field \`${field}\`.`,
  };
}

/** A missing file — its hint is {@link stalePathHint}'s, who declared the reference decides (A3). */
function staleFile(rel: string): IRefResult {
  return {
    outcome: ReferenceCheckOutcome.Stale,
    failure: ReferenceFailure.PathMissing,
    message: `File missing: ${rel}`,
  };
}

function staleId(kind: string, id: string): IRefResult {
  return {
    outcome: ReferenceCheckOutcome.Stale,
    failure: ReferenceFailure.IdUnregistered,
    message: `${kind} not found: ${id}`,
    suggestion: 'Register the target or remove the reference.',
  };
}

function normalizeSlashes(p: string): string {
  return p.split(/[\\/]/).join('/');
}

/** `./src/a.ts` / `src\a.ts` / `src/svc/` → `src/a.ts` / `src/svc`. */
function normalizeScopePath(p: string): string {
  return normalizeSlashes(p).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

/**
 * A changed path IS the target, or lies UNDER it — a `directory` reference
 * whose files changed, or a directory deleted wholesale (git lists its files,
 * never the directory itself).
 */
function pathTouched(target: string | undefined, changed: readonly string[]): boolean {
  if (!target) return false;
  const p = normalizeScopePath(target);
  if (p === '' || p === '.') return false;
  const under = `${p}/`;
  return changed.some((c) => c === p || c.startsWith(under));
}

/**
 * Is a subject — a knowledge entry, a boundary rule, a policy check — in a
 * changeset's scope? THE one scoping rule for `--changed-only` / `--files`:
 *
 *   - the file that DECLARES it changed (its references were added or edited —
 *     a typo in a new reference must be checked by the run that introduced it);
 *   - a changed path equals a reference / anchor path, or lies under one;
 *   - a changed path matches a `count` source glob (the number re-derives from
 *     those globs, so a change there can move it with no pinned path changing).
 *
 * `source` is project-relative (`relativeSource`); `(unknown source)` matches
 * nothing.
 */
function subjectTouchesChangedFiles(
  subject: {
    readonly source: string;
    readonly references?: readonly IAssetReference[];
    readonly anchors?: readonly IKnowledgeAnchor[];
  },
  changed: ReadonlyArray<string>,
): boolean {
  if (changed.length === 0) return true;
  const changedList = changed.map(normalizeScopePath);
  if (changedList.includes(normalizeScopePath(subject.source))) return true;
  for (const ref of subject.references ?? []) {
    // A malformed item (a string, a number) points at no path.
    if (ref === null || typeof ref !== 'object') continue;
    if (pathTouched(typeof ref.path === 'string' ? ref.path : undefined, changedList)) return true;
    // The scope the count is MEASURED over (`inspectSource` selects through
    // `globListSelects`), so a change to a file its `!` excludes is no touch.
    const globs = ref.count?.source?.files;
    if (globs && globs.length > 0 && changedList.some((c) => globListSelects(c, globs))) return true;
  }
  for (const anchor of subject.anchors ?? []) {
    if (pathTouched(anchor.path, changedList)) return true;
  }
  return false;
}

/**
 * The directories a `count` source never walks by default: the sharkcraft dir.
 * Its `.ts` files hold the claims themselves — prose saying `registerService("<name>")`
 * inside a count glob would count itself, and the mismatch hint would tell the
 * author to bake that self-match into `expected` (policy-lint and finish prune
 * the same dir for the same reason).
 */
function defaultCountExcludeDirs(inspection: ISharkcraftInspection): readonly string[] {
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  const rel = normalizeScopePath(nodePath.relative(inspection.projectRoot, dir));
  return rel && rel !== '.' && !rel.startsWith('..') && !nodePath.isAbsolute(rel) ? [rel] : [];
}

/**
 * The exclusions ONE count source walks under: an exclusion is dropped when the
 * source's own globs target inside it (`sharkcraft/**` counts there on purpose).
 */
function countExcludeDirsFor(ref: IAssetReference, excludeDirs: readonly string[]): readonly string[] {
  const globs = ref.count?.source?.files ?? [];
  if (excludeDirs.length === 0 || globs.length === 0) return excludeDirs;
  const prefixes = globs.filter((g) => !g.startsWith('!')).map((g) => staticGlobPrefix(g));
  return excludeDirs.filter((d) => !prefixes.some((p) => p === d || p.startsWith(`${d}/`)));
}

/** Every {@link ReferenceFailure} at 0 — the report always carries the full map. */
function emptyFailureCounts(): Record<ReferenceFailure, number> {
  const out = {} as Record<ReferenceFailure, number>;
  for (const f of Object.values(ReferenceFailure)) out[f] = 0;
  return out;
}

function emptyKindBucket(): IKnowledgeKindBucket {
  return { scanned: 0, zeroReferences: 0, referencesChecked: 0, verified: 0, stale: 0, unverifiable: 0 };
}

/**
 * ok / stale / missing are real checks; unknown and invalid (malformed) proved
 * nothing either way. THE predicate — the stale-check's entry buckets, its
 * verdict fold (`declaredReferenceCoverage`) and the `shrk gate`
 * knowledge-symbol gate all read it.
 */
export function isCheckableOutcome(o: ReferenceCheckOutcome): boolean {
  return o !== ReferenceCheckOutcome.Unknown && o !== ReferenceCheckOutcome.Invalid;
}

function isFailingOutcome(o: ReferenceCheckOutcome): boolean {
  return o === ReferenceCheckOutcome.Stale || o === ReferenceCheckOutcome.Missing;
}

/**
 * One subject's bucket from its checks: any failing check makes it stale; any
 * passing one (and no failing) makes it verified; NOTHING checkable makes it
 * unverifiable — never healthy.
 */
function classifyChecks(checkable: number, failing: number): KnowledgeEntryVerdict {
  if (failing > 0) return KnowledgeEntryVerdict.Stale;
  if (checkable > 0) return KnowledgeEntryVerdict.Verified;
  return KnowledgeEntryVerdict.Unverifiable;
}

function bumpBucket(b: IKnowledgeKindBucket, declared: number, verdict: KnowledgeEntryVerdict): void {
  b.scanned += 1;
  if (declared === 0) b.zeroReferences += 1;
  b.referencesChecked += declared;
  if (verdict === KnowledgeEntryVerdict.Verified) b.verified += 1;
  else if (verdict === KnowledgeEntryVerdict.Stale) b.stale += 1;
  else b.unverifiable += 1;
}

function tallyOutcome(b: IKnowledgeReferenceKindBucket, outcome: ReferenceCheckOutcome): void {
  b.checked += 1;
  if (outcome === ReferenceCheckOutcome.Ok) b.ok += 1;
  else if (outcome === ReferenceCheckOutcome.Stale) b.stale += 1;
  else if (outcome === ReferenceCheckOutcome.Missing) b.missing += 1;
  else if (outcome === ReferenceCheckOutcome.Invalid) b.invalid += 1;
  else b.unknown += 1;
}

function relativeSource(projectRoot: string, origin: string | undefined): string {
  if (!origin) return '(unknown source)';
  return normalizeSlashes(nodePath.isAbsolute(origin) ? nodePath.relative(projectRoot, origin) : origin);
}

function pct1(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** The static directory part of a glob (`apps/legacy/**` → `apps/legacy`); `''` when it starts with a wildcard. */
function staticGlobPrefix(glob: string): string {
  const segs = normalizeSlashes(glob).replace(/^\.\//, '').split('/');
  const firstGlob = segs.findIndex((s) => /[*?[{]/.test(s));
  return (firstGlob === -1 ? segs : segs.slice(0, firstGlob)).join('/');
}

const BACKTICKED_IDENTIFIER = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?:\(\))?`/g;
const TS_SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PATH_ONLY_ADVISORY_CAP = 5;

/**
 * The path-only advisory: an entry whose references are all paths, whose prose
 * names (in backticks) a symbol one of its referenced files DECLARES. Renaming
 * that symbol would leave the entry wrong while every reference still resolves
 * — the strong form (`symbol` pinned to the path) catches it. Never gating.
 */
function pathOnlyAdvisories(
  projectRoot: string,
  entry: IKnowledgeEntry,
  refs: readonly IKnowledgeReference[],
  cache: Map<string, ISymbolIndex | null>,
): IKnowledgeStaleAdvisory[] {
  // A malformed item (a string, a null, a non-string path) earns no advisory — it is an INVALID row.
  if (
    refs.length === 0 ||
    !refs.every((r) => referenceShapeProblem(r) === undefined && (r.kind === 'file' || r.kind === 'directory'))
  ) {
    return [];
  }
  const files = refs
    // A pack-rooted path names a file in the pack, not in this tree (round 15 follow-up).
    .filter((r) => r.kind === 'file' && r.path !== undefined && TS_SOURCE.test(r.path) && !isPackRooted(r))
    .map((r) => r.path!);
  if (files.length === 0) return [];
  const names = new Set<string>();
  for (const text of [entry.summary ?? '', typeof entry.content === 'string' ? entry.content : '']) {
    for (const m of text.matchAll(BACKTICKED_IDENTIFIER)) names.add(m[1]!);
  }
  const out: IKnowledgeStaleAdvisory[] = [];
  for (const name of names) {
    if (out.length >= PATH_ONLY_ADVISORY_CAP) break;
    for (const rel of files) {
      let idx = cache.get(rel);
      if (idx === undefined) {
        const abs = nodePath.join(projectRoot, rel);
        idx = existsSync(abs) ? buildSymbolIndex(abs) : null;
        cache.set(rel, idx);
      }
      if (!idx?.parsed) continue;
      const declared = name.includes('.')
        ? (idx.members ?? []).some((m) => `${m.owner}.${m.name}` === name)
        : idx.exports.some((e) => e.name === name);
      if (!declared) continue;
      out.push({
        code: KnowledgeAdvisoryCode.PathOnlyReference,
        subjectId: entry.id,
        assetKind: ReferenceAssetKind.Knowledge,
        message: `entry names \`${name}\`, which ${rel} declares, but pins only the path — a rename inside the file would pass unnoticed. Add { kind: 'symbol', symbol: '${name}', path: '${rel}' }.`,
        suggestion: { kind: 'symbol', symbol: name, path: rel },
      });
      break;
    }
  }
  return out;
}

export function buildKnowledgeStaleReport(
  inspection: ISharkcraftInspection,
  options: IKnowledgeStaleCheckOptions = {},
): IKnowledgeStaleReport {
  const strategy = options.renameStrategy ?? RenameStrategy.Strict;
  const projectRoot = inspection.projectRoot;
  // Default: never walk the sharkcraft dir — the claims live there and would
  // count themselves (every caller gets this; none has to remember to pass it).
  const excludeDirs = options.excludeDirs ?? defaultCountExcludeDirs(inspection);
  const referenceChecks: IKnowledgeReferenceCheck[] = [];
  const anchorChecks: IKnowledgeAnchorCheck[] = [];
  const assetReferenceChecks: IKnowledgeReferenceCheck[] = [];
  const counts = { ok: 0, stale: 0, missing: 0, unknown: 0, invalid: 0 };
  const failureCounts = emptyFailureCounts();
  const byAssetKind: Record<ReferenceAssetKind, IKnowledgeKindBucket> = {
    [ReferenceAssetKind.Knowledge]: emptyKindBucket(),
    [ReferenceAssetKind.BoundaryRule]: emptyKindBucket(),
    [ReferenceAssetKind.Policy]: emptyKindBucket(),
  };
  const byEntryType: Record<string, IKnowledgeKindBucket> = {};
  const byReferenceKind: Record<string, IKnowledgeReferenceKindBucket> = {};
  const entryVerdicts: IKnowledgeEntryVerdictRecord[] = [];
  const advisories: IKnowledgeStaleAdvisory[] = [];
  const symbolIndexCache = new Map<string, ISymbolIndex | null>();
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
  /**
   * Check ONE declared reference and attach its rename signal — the same path
   * for a knowledge entry, a boundary rule and a policy check, so every asset
   * kind is verified by one checker.
   */
  const checkOne = (
    subjectId: string,
    ref: IAssetReference,
    assetKind?: ReferenceAssetKind,
    origin?: IReferencePackOrigin,
    subject?: Pick<IStalePathHintInput, 'sourceFormat' | 'source'>,
  ): IKnowledgeReferenceCheck => {
    const result = checkReference(inspection, ref, options.graph, excludeDirs, origin, subject);
    const outcome = result.outcome;
    const check: IKnowledgeReferenceCheck = {
      entryId: subjectId,
      reference: displayedReference(ref),
      outcome,
      message: result.message,
      ...(result.confidence ? { symbolConfidence: result.confidence } : {}),
      ...(result.suggestion ? { suggestion: result.suggestion } : {}),
      ...(result.failure ? { failure: result.failure } : {}),
      ...(result.expected !== undefined ? { expected: result.expected } : {}),
      ...(result.actual !== undefined ? { actual: result.actual } : {}),
      ...(assetKind ? { assetKind } : {}),
    };
    // A malformed item (a string, a number) has no kind to bucket under.
    const kindKey =
      ref !== null && typeof ref === 'object' && typeof ref.kind === 'string' ? ref.kind : MALFORMED_KIND_BUCKET;
    tallyOutcome(
      (byReferenceKind[kindKey] ??= { checked: 0, ok: 0, stale: 0, missing: 0, unknown: 0, invalid: 0 }),
      outcome,
    );
    if (result.failure) failureCounts[result.failure] += 1;
    const isStaleOrMissing =
      outcome === ReferenceCheckOutcome.Stale || outcome === ReferenceCheckOutcome.Missing;
    // A pack's reference is fixed in the pack (round 15 follow-up): a candidate
    // from THIS tree is never its rename — `fix --knowledge-stale` would point
    // a pack's entry at a consumer file. Its hint names `root: pack` instead.
    const findRename = isStaleOrMissing && origin === undefined;
    // A bare MEMBER name: the qualified spelling resolves in the same file, so
    // it is the replacement (`shrk fix --knowledge-stale` applies it).
    if (isStaleOrMissing && result.suggestedSymbol) {
      check.replaceWith = {
        symbol: result.suggestedSymbol,
        rationale: `\`${ref.symbol}\` is a member, not a top-level declaration — \`${result.suggestedSymbol}\` resolves in ${ref.path ?? 'the pinned file'}.`,
        strategy: RenameStrategy.Strict,
      };
    }
    // Symbol rename detection. Strict mode: emit `replaceWith.path`
    // only for the single unambiguous candidate. Wide mode also
    // emits scored candidate lists for the multi-candidate cases that
    // strict silently drops.
    if (findRename && ref.kind === 'symbol' && ref.symbol && !check.replaceWith) {
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
    if (findRename && ref.kind === 'file' && ref.path && !check.replaceWith) {
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
    if (findRename && ref.kind === 'directory' && ref.path && !check.replaceWith) {
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
    return check;
  };

  for (const entry of inspection.knowledgeEntries as IKnowledgeEntry[]) {
    // EVERY declared item is judged (`declaredReferenceItems` /
    // `declaredAnchorItems`): a non-list `references` or `anchors` is never
    // iterated (it crashed every inspection-backed verb) — each is reported
    // below as one INVALID row — and a malformed item is checked into an
    // INVALID row carrying the validator's words (`displayedReference`).
    const refs = declaredReferenceItems(entry) as readonly IKnowledgeReference[];
    const anchorItems = declaredAnchorItems(entry);
    // The contributing pack (round 15 follow-up) — what a `root: pack` reference resolves against.
    const entrySource = inspection.entrySources?.get(entry.id);
    const packOrigin =
      entrySource?.type === 'pack' ? packOriginByName(inspection, entrySource.packageName) : undefined;
    if (
      options.changedFiles &&
      !subjectTouchesChangedFiles(
        {
          source: relativeSource(projectRoot, entry.source?.origin),
          references: refs.map((r) => scopedReference(r, packOrigin)),
          anchors: knowledgeAnchors(entry),
        },
        options.changedFiles,
      )
    ) {
      continue;
    }
    const sourceFormat = knowledgeSourceFormat(entry);
    let checkable = 0;
    let failing = 0;
    // A non-list `references` / `anchors` value (TypeScript or Markdown), or a
    // malformed anchor item: declared, never checkable — MALFORMED, the same
    // problem the validator reports. One INVALID row each.
    const malformedRow = (declaredValue: unknown, message: string): void => {
      counts.invalid += 1;
      failureCounts[ReferenceFailure.Malformed] += 1;
      tallyOutcome(
        (byReferenceKind[MALFORMED_KIND_BUCKET] ??= { checked: 0, ok: 0, stale: 0, missing: 0, unknown: 0, invalid: 0 }),
        ReferenceCheckOutcome.Invalid,
      );
      referenceChecks.push({
        entryId: entry.id,
        // As declared: a string renders as written, a map as `kind:value`.
        reference: displayedReference(declaredValue),
        outcome: ReferenceCheckOutcome.Invalid,
        failure: ReferenceFailure.Malformed,
        message,
      });
    };
    const listProblem = referencesListProblem(entry.references, sourceFormat);
    if (listProblem) {
      totalReferences += 1;
      malformedRow(entry.references, `malformed reference: ${listProblem}.`);
    }
    // An anchor row names WHICH anchor (`anchors`, `anchor #N` — the doctor's
    // spelling): rendered through the reference grammar, an anchor object read
    // `undefined:<id>`.
    const anchorsProblem = anchorsListProblem(entry.anchors);
    if (anchorsProblem) {
      totalAnchors += 1;
      malformedRow('anchors', `malformed anchor: ${anchorsProblem}.`);
    }
    // Who fixes a missing path (A3): a Markdown entry names its `references:` frontmatter.
    const hintSubject = { sourceFormat, source: relativeSource(projectRoot, entry.source?.origin) };
    for (const ref of refs) {
      totalReferences += 1;
      const check = checkOne(entry.id, ref, undefined, packOrigin, hintSubject);
      if (check.outcome === ReferenceCheckOutcome.Ok) counts.ok += 1;
      else if (check.outcome === ReferenceCheckOutcome.Stale) counts.stale += 1;
      else if (check.outcome === ReferenceCheckOutcome.Missing) counts.missing += 1;
      else if (check.outcome === ReferenceCheckOutcome.Invalid) counts.invalid += 1;
      else counts.unknown += 1;
      if (isCheckableOutcome(check.outcome)) {
        checkable += 1;
        if (isFailingOutcome(check.outcome)) failing += 1;
      }
      referenceChecks.push(check);
    }
    for (const [i, item] of anchorItems.entries()) {
      totalAnchors += 1;
      // THE anchor item-shape predicate the validator applies: a `null` item
      // crashed `checkAnchor` (`anchor.kind`), a non-string path its path join.
      const shape = anchorShapeProblem(item);
      if (shape) {
        malformedRow(`anchor #${i + 1}`, `malformed anchor: ${shape}.`);
        continue;
      }
      const anchor = item as IKnowledgeAnchor;
      const inspected = checkAnchor(inspection, anchor, options.graph);
      const failure =
        inspected.outcome === ReferenceCheckOutcome.Ok
          ? undefined
          : (inspected.failure ?? defaultFailure(anchor.kind, inspected.outcome));
      if (failure) failureCounts[failure] += 1;
      if (isCheckableOutcome(inspected.outcome)) {
        checkable += 1;
        if (isFailingOutcome(inspected.outcome)) failing += 1;
      }
      anchorChecks.push({
        entryId: entry.id,
        anchor,
        outcome: inspected.outcome,
        message: inspected.message,
        ...(failure ? { failure } : {}),
      });
    }
    const verdict = classifyChecks(checkable, failing);
    const declared = refs.length + anchorItems.length + (listProblem ? 1 : 0) + (anchorsProblem ? 1 : 0);
    const reason =
      verdict !== KnowledgeEntryVerdict.Unverifiable
        ? undefined
        : declared === 0
          ? KnowledgeUnverifiableReason.NoReferences
          : KnowledgeUnverifiableReason.OnlyUnverifiableReferences;
    const type = String(entry.type);
    const origin = inspection.entrySources?.get(entry.id);
    entryVerdicts.push({
      entryId: entry.id,
      verdict,
      ...(reason ? { reason } : {}),
      source: relativeSource(projectRoot, entry.source?.origin),
      sourceFormat,
      ...(origin?.type === 'pack' && origin.packageName ? { pack: origin.packageName } : {}),
      type,
      checkable,
      failing,
    });
    bumpBucket(byAssetKind[ReferenceAssetKind.Knowledge], declared, verdict);
    bumpBucket((byEntryType[type] ??= emptyKindBucket()), declared, verdict);
    advisories.push(...pathOnlyAdvisories(projectRoot, entry, refs, symbolIndexCache));
  }
  // Content-similarity boost: when multiple wide replacements in the
  // SAME entry name the same candidate path, raise that candidate's score
  // for each occurrence. Captures the "directory was moved, all files
  // followed" case where a single per-reference signal is weak but the
  // aggregate is strong.
  applyEntryCorroborationBoost(referenceChecks);

  // Boundary rules and policy checks declare references too — swept by the
  // same checker, counted per kind, and NOT folded into the knowledge buckets
  // (their coverage is reported, not gated by default).
  const includeAssets = options.includeAssets !== false;
  const boundaryRules = includeAssets ? (inspection.boundaryRegistry?.list() ?? []) : [];
  const policyDecls = includeAssets ? listPolicyDeclarations(inspection) : [];
  const subjects: IReferenceSubject[] = [
    ...boundaryRules.map((rule) => ({
      assetKind: ReferenceAssetKind.BoundaryRule,
      id: rule.id,
      source: relativeSource(projectRoot, inspection.boundarySources?.get(rule.id)?.file),
      references: rule.references ?? [],
    })),
    ...policyDecls.map((p) => ({
      assetKind: ReferenceAssetKind.Policy,
      id: p.qualifiedId,
      source: relativeSource(projectRoot, p.sourceFile),
      references: p.references ?? [],
    })),
  ];
  // The contributing pack of a boundary rule / policy check a pack declares
  // (round 15 follow-up) — the same `root: pack` resolution a knowledge entry gets.
  const subjectPackOrigin = (subject: IReferenceSubject): IReferencePackOrigin | undefined => {
    if (subject.assetKind === ReferenceAssetKind.BoundaryRule) {
      const src = inspection.boundarySources?.get(subject.id);
      return src?.type === 'pack' ? packOriginByName(inspection, src.packageName) : undefined;
    }
    const decl = policyDecls.find((p) => p.qualifiedId === subject.id);
    return decl?.source === 'pack' ? packOriginOfFile(inspection, decl.sourceFile) : undefined;
  };
  for (const subject of subjects) {
    const packOrigin = subjectPackOrigin(subject);
    if (
      options.changedFiles &&
      !subjectTouchesChangedFiles(
        {
          source: subject.source ?? '(unknown source)',
          references: subject.references.map((r) => scopedReference(r, packOrigin)),
        },
        options.changedFiles,
      )
    ) {
      continue;
    }
    let checkable = 0;
    let failing = 0;
    for (const ref of subject.references) {
      const check = checkOne(subject.id, ref, subject.assetKind, packOrigin);
      if (isCheckableOutcome(check.outcome)) {
        checkable += 1;
        if (isFailingOutcome(check.outcome)) failing += 1;
      }
      assetReferenceChecks.push(check);
    }
    bumpBucket(byAssetKind[subject.assetKind], subject.references.length, classifyChecks(checkable, failing));
  }
  // IMPLICIT references (boundary rules only — their scope is data): a `from`
  // glob whose static prefix does not exist governs nothing there. Advisory
  // unless `--fail-on implicit`; never counted in `failureCounts`. Policy
  // checks keep their scope inside `evaluate()`, which cannot be read without
  // running it — that gap is reported, not guessed at.
  if (!options.changedFiles) {
    for (const rule of boundaryRules) {
      for (const glob of rule.from ?? []) {
        if (glob.startsWith('!')) continue;
        const prefix = staticGlobPrefix(glob);
        if (!prefix || fileExists(projectRoot, prefix)) continue;
        const message = `boundary rule ${rule.id} scopes '${glob}' but ${prefix} does not exist — the rule governs nothing there.`;
        assetReferenceChecks.push({
          entryId: rule.id,
          reference: { kind: 'directory', path: prefix, note: `implicit: from '${glob}'` },
          outcome: ReferenceCheckOutcome.Stale,
          failure: ReferenceFailure.PathMissing,
          implicit: true,
          assetKind: ReferenceAssetKind.BoundaryRule,
          message,
          suggestion: 'Fix or remove the glob (gate it with --fail-on implicit).',
        });
        advisories.push({
          code: KnowledgeAdvisoryCode.ImplicitPathMissing,
          subjectId: rule.id,
          assetKind: ReferenceAssetKind.BoundaryRule,
          message,
        });
      }
    }
  }
  const policySweep = {
    loaded: isReferenceCacheWarm(inspection),
    declared: policyDecls.length,
    withReferences: policyDecls.filter((p) => (p.references?.length ?? 0) > 0).length,
  };
  if (policySweep.declared > policySweep.withReferences) {
    advisories.push({
      code: KnowledgeAdvisoryCode.PolicyScopeUnverifiable,
      subjectId: 'policy',
      assetKind: ReferenceAssetKind.Policy,
      message: `policy: ${policySweep.declared} declared check(s), ${policySweep.withReferences} with references — the scope of the rest is unverifiable (it lives inside evaluate()).`,
    });
  }

  const verified = entryVerdicts.filter((v) => v.verdict === KnowledgeEntryVerdict.Verified).length;
  const stale = entryVerdicts.filter((v) => v.verdict === KnowledgeEntryVerdict.Stale).length;
  const unverifiableIds = entryVerdicts
    .filter((v) => v.verdict === KnowledgeEntryVerdict.Unverifiable)
    .map((v) => v.entryId);
  const entriesInScope = entryVerdicts.length;
  const coverage: IKnowledgeStaleCoverage = {
    entriesInScope,
    verified,
    stale,
    unverifiable: unverifiableIds.length,
    unverifiablePct: pct1(unverifiableIds.length, entriesInScope),
    referencedRatio: entriesInScope > 0 ? (verified + stale) / entriesInScope : 0,
  };

  let age: IKnowledgeStaleReport['age'];
  if (options.staleAfterDays !== undefined) {
    const asOf = options.asOf ?? todayUtcIso();
    const inScope = new Set(entryVerdicts.map((v) => v.entryId));
    const aged: IKnowledgeAgedEntry[] = [];
    const neverVerified: string[] = [];
    for (const entry of inspection.knowledgeEntries as IKnowledgeEntry[]) {
      if (!inScope.has(entry.id)) continue;
      const days = entry.verifiedOn ? verifiedOnAgeDays(entry.verifiedOn, asOf) : undefined;
      if (days === undefined) {
        neverVerified.push(entry.id);
      } else if (days > options.staleAfterDays) {
        aged.push({
          entryId: entry.id,
          verifiedOn: entry.verifiedOn!,
          ageDays: days,
          source: relativeSource(projectRoot, entry.source?.origin),
        });
      }
    }
    aged.sort((a, b) => b.ageDays - a.ageDays || a.entryId.localeCompare(b.entryId));
    age = { asOf, staleAfterDays: options.staleAfterDays, aged, neverVerified };
  }

  return {
    schema: KNOWLEDGE_STALE_SCHEMA,
    entries: inspection.knowledgeEntries.length,
    totalReferences,
    totalAnchors,
    counts,
    referenceChecks,
    anchorChecks,
    entriesInScope,
    coverage,
    entryVerdicts,
    unverifiableIds,
    rejectedEntries: knowledgeRejectedEntries(inspection),
    failureCounts,
    byAssetKind,
    byEntryType,
    byReferenceKind,
    assetReferenceChecks,
    advisories,
    policySweep,
    ...(age ? { age } : {}),
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
  graph?: ISymbolGraphResolver,
): { outcome: ReferenceCheckOutcome; message: string; failure?: ReferenceFailure } {
  switch (anchor.kind) {
    case 'file':
      if (!anchor.path) {
        return {
          outcome: ReferenceCheckOutcome.Invalid,
          failure: ReferenceFailure.Malformed,
          message: 'malformed anchor: file anchor missing required field `path`.',
        };
      }
      if (fileExists(inspection.projectRoot, anchor.path)) {
        return { outcome: ReferenceCheckOutcome.Ok, message: `anchor file exists: ${anchor.path}` };
      }
      return {
        outcome: ReferenceCheckOutcome.Stale,
        failure: ReferenceFailure.PathMissing,
        message: `anchor file missing: ${anchor.path}`,
      };
    case 'symbol':
      return checkSymbolAnchor(inspection, anchor, graph);
    case 'command': {
      if (!anchor.targetId) {
        return { outcome: ReferenceCheckOutcome.Stale, message: 'command anchor unresolved: ?' };
      }
      const r = checkCommandString(inspection, anchor.targetId, 'command anchor');
      return { outcome: r.outcome, message: r.message };
    }
    case 'construct':
      return checkAnchorId(inspection, 'construct', anchor.targetId);
    case 'template':
      return checkAnchorId(inspection, 'template', anchor.targetId);
    case 'helper':
      return checkAnchorId(inspection, 'helper', anchor.targetId);
    case 'playbook':
      return checkAnchorId(inspection, 'playbook', anchor.targetId);
    case 'policy':
      return checkAnchorId(inspection, 'policy', anchor.targetId);
    default:
      return {
        outcome: ReferenceCheckOutcome.Invalid,
        failure: ReferenceFailure.Malformed,
        message: `malformed anchor: unsupported anchor kind "${String((anchor as { kind?: unknown }).kind)}".`,
      };
  }
}

/**
 * An id-keyed anchor, through the same guarded resolver as a reference — an
 * unloaded registry is NOT VERIFIED, never "unresolved".
 */
function checkAnchorId(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
  targetId: string | undefined,
): { outcome: ReferenceCheckOutcome; message: string; failure?: ReferenceFailure } {
  if (!targetId) {
    return {
      outcome: ReferenceCheckOutcome.Stale,
      failure: ReferenceFailure.IdUnregistered,
      message: `${kind} anchor unresolved: ?`,
    };
  }
  const r = checkRegisteredId(inspection, kind, targetId, kind);
  if (r.outcome === ReferenceCheckOutcome.Ok) {
    return { outcome: ReferenceCheckOutcome.Ok, message: `${kind} exists: ${targetId}` };
  }
  if (r.outcome === ReferenceCheckOutcome.Unknown) {
    return { outcome: r.outcome, message: r.message, failure: ReferenceFailure.Unverifiable };
  }
  return {
    outcome: ReferenceCheckOutcome.Stale,
    failure: ReferenceFailure.IdUnregistered,
    message: `${kind} anchor unresolved: ${targetId}`,
  };
}

function checkSymbolAnchor(
  inspection: ISharkcraftInspection,
  anchor: IKnowledgeAnchor,
  graph?: ISymbolGraphResolver,
): { outcome: ReferenceCheckOutcome; message: string; failure?: ReferenceFailure } {
  const r = checkSymbolReference(
    inspection.projectRoot,
    {
      kind: 'symbol',
      symbol: anchor.symbol,
      ...(anchor.path ? { path: anchor.path } : {}),
    },
    graph,
  );
  return { outcome: r.outcome, message: r.message, ...(r.failure ? { failure: r.failure } : {}) };
}
