/**
 * Declared cross-references — the ids assets name in `related`-style fields.
 *
 * Assets point at each other by id across every namespace: a knowledge entry's
 * `related` / `seeAlso` / `supersededBy` and its action hints, a construct's
 * `related*` fields and its facets, a boundary rule's `related*`, a template's
 * `related`. None of it used to be resolved by anything: a renamed or deleted
 * asset left dangling ids behind, and every doctor still printed ✓ while the
 * dead link produced a silently smaller result for whoever followed it.
 *
 * This module is the ONE answer to "which declared asset fields carry ids"
 * ({@link DECLARED_XREF_FIELDS}); every id is resolved through the ONE resolver
 * (`reference-registry.ts`). The self-config doctor, `self-config
 * broken-links|resolve|xrefs`, `packs doctor`, `templates drift`, `knowledge
 * remove` and `shrk quality` all read this collector rather than walking the
 * fields themselves — a second walker would drift from this one, and the one
 * nobody runs would be the wrong one.
 *
 * The prose twin is `doc-references.ts` (ids cited in free text).
 */
import * as nodePath from 'node:path';
import type { IVerdictCoverage } from '@shrkcrft/core';
import type { IKnowledgeRefResolution } from '@shrkcrft/knowledge';
import { listConstructs } from './construct-registry.ts';
import { DeclaredXrefStatus } from './declared-xref-status.ts';
import type { IDeclaredXrefField } from './i-declared-xref-field.ts';
import type { IDeclaredXrefIssue } from './i-declared-xref-issue.ts';
import type { IDeclaredXrefReport } from './i-declared-xref-report.ts';
import type { IDeclaredXrefRow } from './i-declared-xref-row.ts';
import { nearestIds } from './nearest-id.ts';
import {
  ALL_ID_REFERENCE_KINDS,
  isCacheBackedKind,
  isReferenceCacheWarm,
  referenceIdPool,
  referenceIdSets,
  warmReferenceRegistries,
  type ReferenceKind,
} from './reference-registry.ts';
import type { ISelfConfigGraph, ISelfConfigGraphEdge } from './self-config-doctor.ts';
import type { ISharkcraftInspection, ISourceInfo } from './sharkcraft-inspector.ts';

export const DECLARED_XREF_SCHEMA = 'sharkcraft.declared-xrefs/v1' as const;

/**
 * THE table of declared fields that carry cross-reference ids.
 *
 * Severity: a dangling `related`-style id shrinks a result silently but does
 * not misroute anyone, so it is a warning (`--strict` makes it fail);
 * `supersededBy` ROUTES a reader to the current entry, so a dangling one is an
 * error. Another cluster that validates ids inside an asset field adds a row
 * here — it never writes its own loop.
 */
export const DECLARED_XREF_FIELDS: readonly IDeclaredXrefField[] = Object.freeze([
  { sourceKind: 'knowledge', field: 'related', accepts: 'any', severity: 'warning', relation: 'related' },
  { sourceKind: 'knowledge', field: 'seeAlso', accepts: 'any', severity: 'warning', relation: 'related' },
  { sourceKind: 'knowledge', field: 'supersededBy', accepts: ['knowledge'], severity: 'error', relation: 'supersedes' },
  { sourceKind: 'knowledge', field: 'actionHints.relatedKnowledge', accepts: ['knowledge'], severity: 'warning', relation: 'related' },
  { sourceKind: 'knowledge', field: 'actionHints.relatedTemplates', accepts: ['template'], severity: 'warning', relation: 'related' },
  { sourceKind: 'knowledge', field: 'actionHints.relatedPathConventions', accepts: ['path-convention'], severity: 'warning', relation: 'related' },
  { sourceKind: 'construct', field: 'relatedKnowledge', accepts: ['knowledge'], severity: 'warning', relation: 'related' },
  { sourceKind: 'construct', field: 'relatedRules', accepts: ['rule', 'boundary-rule'], severity: 'warning', relation: 'related' },
  { sourceKind: 'construct', field: 'relatedTemplates', accepts: ['template'], severity: 'warning', relation: 'related' },
  { sourceKind: 'construct', field: 'relatedPipelines', accepts: ['pipeline'], severity: 'warning', relation: 'related' },
  { sourceKind: 'construct', field: 'relatedPathConventions', accepts: ['path-convention'], severity: 'warning', relation: 'related' },
  // Facet values are free-form (an event topic, a token name) unless the value
  // DECLARES what it names via `resolvesAs` — only those are resolved.
  { sourceKind: 'construct', field: 'facets', accepts: 'declared', severity: 'warning', relation: 'related' },
  { sourceKind: 'boundary-rule', field: 'relatedRules', accepts: ['rule', 'boundary-rule'], severity: 'warning', relation: 'related' },
  { sourceKind: 'boundary-rule', field: 'relatedPathConventions', accepts: ['path-convention'], severity: 'warning', relation: 'related' },
  { sourceKind: 'template', field: 'related', accepts: 'any', severity: 'warning', relation: 'related' },
] satisfies readonly IDeclaredXrefField[]);

/**
 * Knowledge fields whose SHAPE is validated at load (`validateKnowledgeEntries`,
 * code `invalid-cross-reference`). The collector does not re-report a malformed
 * member there — one code path per question.
 */
const LOAD_VALIDATED_KNOWLEDGE_FIELDS: ReadonlySet<string> = new Set(['related', 'seeAlso', 'supersededBy']);

/** Knowledge-backed kinds: removing a knowledge entry removes the rule / path it also is. */
export const KNOWLEDGE_BACKED_KINDS: readonly ReferenceKind[] = Object.freeze([
  'knowledge',
  'rule',
  'path-convention',
] satisfies readonly ReferenceKind[]);

interface IXrefSource {
  readonly kind: ReferenceKind;
  readonly id: string;
  readonly asset: unknown;
  readonly file?: string;
  readonly packageName?: string;
}

function relativeFile(projectRoot: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  if (!nodePath.isAbsolute(file)) return file;
  const rel = nodePath.relative(projectRoot, file);
  return rel.startsWith('..') ? file : rel;
}

function packOf(info: ISourceInfo | undefined): { packageName?: string } {
  return info?.type === 'pack' && info.packageName ? { packageName: info.packageName } : {};
}

function listOf<T>(reg: unknown): readonly T[] {
  const list = (reg as { list?: () => readonly T[] } | undefined)?.list;
  return typeof list === 'function' ? (list.call(reg) ?? []) : [];
}

/** Every asset that can declare a cross-reference, with where it lives. */
function collectSources(
  inspection: ISharkcraftInspection,
  warm: boolean,
): { sources: IXrefSource[]; unread: ReferenceKind[] } {
  const root = inspection.projectRoot;
  const sources: IXrefSource[] = [];
  const unread: ReferenceKind[] = [];
  for (const e of inspection.knowledgeEntries) {
    const info = inspection.entrySources.get(e.id);
    const file = relativeFile(root, info?.file ?? e.source?.origin);
    sources.push({ kind: 'knowledge', id: e.id, asset: e, ...(file ? { file } : {}), ...packOf(info) });
  }
  const constructs = listConstructs(inspection);
  // Constructs load asynchronously; on a cold cache there is nothing to walk,
  // which must read as "could not look", never as "no constructs declare ids".
  if (!warm && constructs.length === 0) unread.push('construct');
  for (const c of constructs) {
    sources.push({
      kind: 'construct',
      id: c.id,
      asset: c,
      ...(c.sourceFile ? { file: c.sourceFile } : {}),
      ...(c.source === 'pack' && c.packageName ? { packageName: c.packageName } : {}),
    });
  }
  for (const r of listOf<{ id: string }>(inspection.boundaryRegistry)) {
    const info = inspection.boundarySources.get(r.id);
    const file = relativeFile(root, info?.file);
    sources.push({ kind: 'boundary-rule', id: r.id, asset: r, ...(file ? { file } : {}), ...packOf(info) });
  }
  // `templateRegistry`, not `inspection.templates`: the same source `shrk
  // templates list` (and the reference registry) reads.
  for (const t of listOf<{ id: string }>(inspection.templateRegistry)) {
    const info = inspection.templateSources.get(t.id);
    const file = relativeFile(root, info?.file);
    sources.push({ kind: 'template', id: t.id, asset: t, ...(file ? { file } : {}), ...packOf(info) });
  }
  return { sources, unread };
}

function readPath(asset: unknown, path: string): unknown {
  let cur: unknown = asset;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The string ids a field value holds, deduped, plus why it is malformed (if it is). */
function idsOf(value: unknown): { ids: string[]; malformed?: string } {
  if (value === undefined || value === null) return { ids: [] };
  // A scalar where a list belongs is the common authoring typo — honoured, as
  // the action-hint formatter honours it, rather than walked as characters.
  if (typeof value === 'string') {
    return value.trim().length > 0 ? { ids: [value] } : { ids: [], malformed: 'is an empty string' };
  }
  if (!Array.isArray(value)) return { ids: [], malformed: `is a ${typeof value}, not a list of ids` };
  const ids: string[] = [];
  let bad = 0;
  for (const m of value) {
    if (typeof m === 'string' && m.trim().length > 0) {
      if (!ids.includes(m)) ids.push(m);
    } else {
      bad += 1;
    }
  }
  return bad > 0 ? { ids, malformed: `has ${bad} member(s) that are not non-empty string ids` } : { ids };
}

interface IResolveContext {
  readonly inspection: ISharkcraftInspection;
  readonly sets: ReadonlyMap<ReferenceKind, ReadonlySet<string>>;
  readonly warm: boolean;
  readonly pools: Map<string, readonly string[]>;
}

function acceptsLabel(accepts: readonly ReferenceKind[] | 'any'): string {
  return accepts === 'any' ? 'any kind' : accepts.join(' | ');
}

function resolveId(
  ctx: IResolveContext,
  source: IXrefSource,
  field: string,
  accepts: readonly ReferenceKind[] | 'any',
  severity: 'error' | 'warning',
  relation: 'related' | 'supersedes',
  targetId: string,
  facetId?: string,
): IDeclaredXrefRow {
  const resolvedAs = ALL_ID_REFERENCE_KINDS.filter((k) => ctx.sets.get(k)?.has(targetId) === true);
  const acceptedKinds = accepts === 'any' ? ALL_ID_REFERENCE_KINDS : accepts;
  const where = `${source.kind} "${source.id}" ${field}${facetId ? ` [${facetId}]` : ''}`;
  let status: DeclaredXrefStatus;
  let reason = '';
  if (resolvedAs.some((k) => acceptedKinds.includes(k))) {
    status = DeclaredXrefStatus.Ok;
  } else {
    // A negative answer is only trustworthy when every registry the id could
    // live in was actually looked at.
    const cold = ctx.warm ? [] : acceptedKinds.filter(isCacheBackedKind);
    const emptyTyped =
      ctx.warm &&
      accepts !== 'any' &&
      acceptedKinds.every((k) => isCacheBackedKind(k) && (ctx.sets.get(k)?.size ?? 0) === 0);
    if (cold.length > 0) {
      status = DeclaredXrefStatus.Unverified;
      reason = `the ${cold.join(' / ')} registr${cold.length === 1 ? 'y was' : 'ies were'} not warmed (warmReferenceRegistries), so it could not be looked up`;
    } else if (emptyTyped) {
      status = DeclaredXrefStatus.Unverified;
      reason = `the ${acceptedKinds.join(' / ')} registry is empty — it may have failed to load, so the id could not be looked up`;
    } else {
      status = resolvedAs.length === 0 ? DeclaredXrefStatus.Dangling : DeclaredXrefStatus.WrongKind;
    }
  }
  let didYouMean: readonly string[] = [];
  if (status === DeclaredXrefStatus.Dangling || status === DeclaredXrefStatus.WrongKind) {
    const key = acceptedKinds.join(',');
    let pool = ctx.pools.get(key);
    if (!pool) {
      pool = referenceIdPool(ctx.inspection, acceptedKinds);
      ctx.pools.set(key, pool);
    }
    // Never suggest the source's own id: following that advice writes a
    // self-reference (a self-supersession the validator rejects as an error).
    didYouMean = nearestIds(targetId, pool)
      .map((n) => n.id)
      .filter((id) => id !== source.id);
  }
  const hint = didYouMean.length > 0 ? ` — did you mean "${didYouMean[0]}"?` : '';
  const message =
    status === DeclaredXrefStatus.Ok
      ? `${where} → "${targetId}" resolves as ${resolvedAs.join(' | ')}`
      : status === DeclaredXrefStatus.Dangling
        ? `${where} names "${targetId}", which no registry has (the field accepts ${acceptsLabel(accepts)})${hint}`
        : status === DeclaredXrefStatus.WrongKind
          ? `${where} names "${targetId}", which is a ${resolvedAs.join(' | ')} — the field accepts ${acceptsLabel(accepts)}${hint}`
          : `${where} names "${targetId}" — NOT VERIFIED: ${reason}`;
  return {
    sourceKind: source.kind,
    sourceId: source.id,
    field,
    ...(facetId !== undefined ? { facetId } : {}),
    targetId,
    ...(source.file ? { file: source.file } : {}),
    ...(source.packageName ? { packageName: source.packageName } : {}),
    accepts,
    resolvedAs,
    status,
    severity:
      status === DeclaredXrefStatus.Dangling || status === DeclaredXrefStatus.WrongKind ? severity : 'info',
    relation,
    message,
    didYouMean,
  };
}

function issueAt(
  source: IXrefSource,
  field: string,
  code: IDeclaredXrefIssue['code'],
  severity: 'error' | 'warning',
  message: string,
  targetId?: string,
  facetId?: string,
): IDeclaredXrefIssue {
  return {
    code,
    severity,
    sourceKind: source.kind,
    sourceId: source.id,
    field,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(facetId !== undefined ? { facetId } : {}),
    ...(source.file ? { file: source.file } : {}),
    ...(source.packageName ? { packageName: source.packageName } : {}),
    message,
  };
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(ALL_ID_REFERENCE_KINDS);

/** Resolve every facet value that declares what it names; count the rest. */
function collectFacetRows(
  ctx: IResolveContext,
  source: IXrefSource,
  spec: IDeclaredXrefField,
  rows: IDeclaredXrefRow[],
  issues: IDeclaredXrefIssue[],
): number {
  let undeclared = 0;
  const facets = readPath(source.asset, 'facets');
  if (!facets || typeof facets !== 'object') return 0;
  for (const [name, values] of Object.entries(facets as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue;
    const field = `facets.${name}`;
    for (const v of values as readonly unknown[]) {
      if (!v || typeof v !== 'object') continue;
      const fv = v as { id?: unknown; value?: unknown; resolvesAs?: unknown };
      const facetId = typeof fv.id === 'string' ? fv.id : undefined;
      if (fv.resolvesAs === undefined) {
        undeclared += 1;
        continue;
      }
      const declared = Array.isArray(fv.resolvesAs)
        ? (fv.resolvesAs as readonly unknown[])
        : [fv.resolvesAs];
      const unknown = declared.filter((k) => typeof k !== 'string' || !KNOWN_KINDS.has(k));
      for (const k of unknown) {
        // A typo'd kind is the `$use` failure shape: the value would otherwise
        // resolve against nothing and read as "not an id".
        issues.push(
          issueAt(
            source,
            field,
            'xref-unknown-kind',
            'error',
            `${source.kind} "${source.id}" ${field}${facetId ? ` [${facetId}]` : ''} declares resolvesAs "${String(k)}", which is not a reference kind (expected one of: ${ALL_ID_REFERENCE_KINDS.join(', ')}).`,
            typeof fv.value === 'string' ? fv.value : undefined,
            facetId,
          ),
        );
      }
      const accepts = declared.filter(
        (k): k is ReferenceKind => typeof k === 'string' && KNOWN_KINDS.has(k),
      );
      if (accepts.length === 0) continue;
      if (typeof fv.value !== 'string' || fv.value.trim().length === 0) {
        issues.push(
          issueAt(
            source,
            field,
            'xref-malformed',
            'warning',
            `${source.kind} "${source.id}" ${field}${facetId ? ` [${facetId}]` : ''} declares resolvesAs but its value is not a non-empty string id.`,
            undefined,
            facetId,
          ),
        );
        continue;
      }
      rows.push(resolveId(ctx, source, field, accepts, spec.severity, spec.relation, fv.value, facetId));
    }
  }
  return undeclared;
}

/** Strongly-connected components of size > 1 — each one a supersession cycle. */
function supersessionCycles(succ: ReadonlyMap<string, readonly string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of succ.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of [...succ.keys()].sort()) if (!index.has(v)) visit(v);
  return out;
}

/** The current (non-superseded) entries reachable from `start`, cycle-safe. */
function terminalSuccessors(
  start: string,
  succ: ReadonlyMap<string, readonly string[]>,
  inCycle: ReadonlySet<string>,
): string[] {
  const terminals = new Set<string>();
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined || seen.has(cur) || inCycle.has(cur)) continue;
    seen.add(cur);
    const next = succ.get(cur);
    if (!next || next.length === 0) terminals.add(cur);
    else queue.push(...next);
  }
  return [...terminals].sort();
}

/**
 * `supersededBy` graph checks: a cycle has no current entry (error); a target
 * that is itself superseded makes a reader hop twice (warning, naming the
 * terminal successor). Existence of each target is the row check's job.
 */
function checkSupersession(
  ctx: IResolveContext,
  sources: readonly IXrefSource[],
  issues: IDeclaredXrefIssue[],
): void {
  const knowledge = ctx.sets.get('knowledge') ?? new Set<string>();
  const byId = new Map<string, IXrefSource>();
  const succ = new Map<string, readonly string[]>();
  for (const s of sources) {
    if (s.kind !== 'knowledge') continue;
    byId.set(s.id, s);
    // Self-supersession is a load-time error (`invalid-cross-reference`).
    const next = idsOf(readPath(s.asset, 'supersededBy')).ids.filter((t) => t !== s.id && knowledge.has(t));
    if (next.length > 0) succ.set(s.id, next);
  }
  if (succ.size === 0) return;
  const inCycle = new Set<string>();
  for (const cycle of supersessionCycles(succ)) {
    for (const m of cycle) inCycle.add(m);
    const first = byId.get(cycle[0] ?? '');
    if (!first) continue;
    issues.push(
      issueAt(
        first,
        'supersededBy',
        'xref-superseded-cycle',
        'error',
        `supersededBy forms a cycle among ${cycle.map((c) => `"${c}"`).join(', ')} — none of them is current, so a reader following the chain never arrives.`,
        (succ.get(first.id) ?? []).find((t) => cycle.includes(t)),
      ),
    );
  }
  for (const [from, next] of succ) {
    if (inCycle.has(from)) continue;
    const source = byId.get(from);
    if (!source) continue;
    for (const target of next) {
      if (!succ.has(target) || inCycle.has(target)) continue;
      const terminals = terminalSuccessors(target, succ, inCycle);
      issues.push(
        issueAt(
          source,
          'supersededBy',
          'xref-superseded-chain',
          'warning',
          `knowledge "${from}" is superseded by "${target}", which is itself superseded — point it at the current entr${terminals.length === 1 ? 'y' : 'ies'}: ${terminals.map((t) => `"${t}"`).join(', ') || '(none — the chain ends in a cycle)'}.`,
          target,
        ),
      );
    }
  }
}

/**
 * Resolve every declared cross-reference id. Synchronous: call it AFTER
 * `warmReferenceRegistries` (or use {@link buildDeclaredXrefReport}). On a cold
 * cache the cache-backed kinds cannot be looked up, so an id that might live
 * in one is `unverified` — never `dangling` — and constructs are reported in
 * `examined.unreadSources`. Never throws: a registry that will not load is its
 * own surface's problem.
 */
export function collectDeclaredXrefs(inspection: ISharkcraftInspection): IDeclaredXrefReport {
  const warm = isReferenceCacheWarm(inspection);
  const ctx: IResolveContext = { inspection, sets: referenceIdSets(inspection), warm, pools: new Map() };
  const { sources, unread } = collectSources(inspection, warm);
  const rows: IDeclaredXrefRow[] = [];
  const issues: IDeclaredXrefIssue[] = [];
  let facetValuesUndeclared = 0;
  const sourcesByKind: Record<string, number> = {};
  for (const source of sources) {
    sourcesByKind[source.kind] = (sourcesByKind[source.kind] ?? 0) + 1;
    for (const spec of DECLARED_XREF_FIELDS) {
      if (spec.sourceKind !== source.kind) continue;
      if (spec.accepts === 'declared') {
        facetValuesUndeclared += collectFacetRows(ctx, source, spec, rows, issues);
        continue;
      }
      const { ids, malformed } = idsOf(readPath(source.asset, spec.field));
      if (malformed && !(source.kind === 'knowledge' && LOAD_VALIDATED_KNOWLEDGE_FIELDS.has(spec.field))) {
        issues.push(
          issueAt(source, spec.field, 'xref-malformed', 'warning', `${source.kind} "${source.id}" ${spec.field} ${malformed}.`),
        );
      }
      for (const id of ids) {
        rows.push(resolveId(ctx, source, spec.field, spec.accepts, spec.severity, spec.relation, id));
      }
    }
  }
  checkSupersession(ctx, sources, issues);

  const byField: Record<string, { ids: number; dangling: number; wrongKind: number; unverified: number }> = {};
  const counts = { ids: rows.length, ok: 0, dangling: 0, wrongKind: 0, unverified: 0, errors: 0, warnings: 0 };
  for (const r of rows) {
    const key = `${r.sourceKind}.${r.field.startsWith('facets.') ? 'facets' : r.field}`;
    const f = (byField[key] ??= { ids: 0, dangling: 0, wrongKind: 0, unverified: 0 });
    f.ids += 1;
    if (r.status === DeclaredXrefStatus.Ok) counts.ok += 1;
    else if (r.status === DeclaredXrefStatus.Dangling) {
      counts.dangling += 1;
      f.dangling += 1;
    } else if (r.status === DeclaredXrefStatus.WrongKind) {
      counts.wrongKind += 1;
      f.wrongKind += 1;
    } else {
      counts.unverified += 1;
      f.unverified += 1;
    }
    if (r.severity === 'error') counts.errors += 1;
    else if (r.severity === 'warning') counts.warnings += 1;
  }
  for (const i of issues) {
    if (i.severity === 'error') counts.errors += 1;
    else counts.warnings += 1;
  }
  return {
    schema: DECLARED_XREF_SCHEMA,
    rows,
    issues,
    counts,
    examined: {
      sources: sources.length,
      sourcesByKind,
      ids: rows.length,
      fields: Object.keys(byField).length,
      byField,
      facetValuesUndeclared,
      cacheWarm: warm,
      unreadSources: unread,
    },
  };
}

/** Warm the async registries, then {@link collectDeclaredXrefs}. */
export async function buildDeclaredXrefReport(
  inspection: ISharkcraftInspection,
): Promise<IDeclaredXrefReport> {
  await warmReferenceRegistries(inspection);
  return collectDeclaredXrefs(inspection);
}

/** True for a row a reader following it would find broken: dangling or wrong-kind. */
export function isBrokenXref(row: IDeclaredXrefRow): boolean {
  return row.status === DeclaredXrefStatus.Dangling || row.status === DeclaredXrefStatus.WrongKind;
}

/**
 * Who points at `targetId` — the reverse direction. With `asKinds`, only rows
 * whose field could mean an id of one of those kinds (a construct's
 * `relatedTemplates: ['x']` is not a reference to a knowledge entry `x`).
 */
export function reverseXrefs(
  report: IDeclaredXrefReport,
  targetId: string,
  asKinds?: readonly ReferenceKind[],
): readonly IDeclaredXrefRow[] {
  return report.rows.filter(
    (r) =>
      r.targetId === targetId &&
      (!asKinds || r.accepts === 'any' || r.accepts.some((k) => asKinds.includes(k))),
  );
}

/**
 * The collector's coverage: every declared id must have been LOOKED UP. An
 * unverified id (or a source that could not be enumerated) is an unexamined
 * unit, so a verdict over it can never settle to a pass.
 */
export function declaredXrefCoverage(report: IDeclaredXrefReport): IVerdictCoverage {
  const unread = report.examined.unreadSources.map((k) => `${k} assets (registry not warmed)`);
  const unverified = report.rows
    .filter((r) => r.status === DeclaredXrefStatus.Unverified)
    .map((r) => `${r.sourceKind}:${r.sourceId} ${r.field} → ${r.targetId}`);
  const labels = [...unread, ...unverified];
  return {
    unit: 'declared cross-reference ids',
    expected: report.counts.ids + unread.length,
    examined: report.counts.ids - report.counts.unverified,
    ...(labels.length > 0
      ? {
          unexamined: labels.slice(0, 20),
          unexaminedTotal: labels.length,
          reason: 'could not be looked up (registry not warmed, or empty)',
        }
      : {}),
  };
}

/** The one-line summary every renderer prints (`N ids across M fields · …`). */
export function declaredXrefSummaryLine(report: IDeclaredXrefReport): string {
  const c = report.counts;
  if (c.ids === 0 && report.issues.length === 0) {
    return `none declared — nothing examined (${report.examined.sources} asset(s) walked)`;
  }
  const issues = report.issues.length > 0 ? ` · ${report.issues.length} declaration issue(s)` : '';
  return `${c.ids} id(s) across ${report.examined.fields} field(s) · ${c.dangling} dangling · ${c.wrongKind} wrong-kind · ${c.unverified} unverified${issues}`;
}

/**
 * The self-config graph plus one edge per declared cross-reference; dangling
 * and wrong-kind ones are also `brokenEdges`, so `self-config broken-links`
 * agrees with the doctor instead of printing ✓ over dead ids.
 */
export function withDeclaredXrefEdges(
  graph: ISelfConfigGraph,
  report: IDeclaredXrefReport,
): ISelfConfigGraph {
  const edges: ISelfConfigGraphEdge[] = [...graph.edges];
  const brokenEdges: ISelfConfigGraphEdge[] = [...graph.brokenEdges];
  for (const r of report.rows) {
    const edge: ISelfConfigGraphEdge = {
      from: { id: r.sourceId, kind: r.sourceKind, ...(r.file ? { source: r.file } : {}) },
      to: { id: r.targetId, kind: r.resolvedAs[0] ?? (r.accepts === 'any' ? 'unknown' : (r.accepts[0] ?? 'unknown')) },
      relation: r.field,
    };
    edges.push(edge);
    if (isBrokenXref(r)) brokenEdges.push(edge);
  }
  return { ...graph, edges, brokenEdges };
}

/**
 * The resolver `formatEntryFull` renders cross-references with (the knowledge
 * package sits below this layer and cannot resolve ids itself). Warm first: on
 * a cold cache an unresolvable id is `unverified`, never "unresolved".
 */
export function buildKnowledgeRefResolver(
  inspection: ISharkcraftInspection,
): (id: string) => IKnowledgeRefResolution {
  const sets = referenceIdSets(inspection);
  const warm = isReferenceCacheWarm(inspection);
  return (id: string): IKnowledgeRefResolution => {
    const kinds = ALL_ID_REFERENCE_KINDS.filter((k) => sets.get(k)?.has(id) === true);
    if (kinds.length === 0) return warm ? { kinds } : { kinds, unverified: true };
    const title = inspection.index.get(id)?.title ?? inspection.templateRegistry.get(id)?.name;
    return { kinds, ...(title ? { title } : {}) };
  };
}
