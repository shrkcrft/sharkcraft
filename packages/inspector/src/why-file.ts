/**
 * DX/feedback3 — `shrk why <file>`.
 *
 * Closes a dangling promise: `ide.command.ts:112` already suggests
 * `shrk why "<path>"` to the user, but the verb didn't exist until
 * now. This helper answers: "for THIS file, which registries apply
 * and why?" Pure composition over the existing inspection — no new
 * asset kinds, no LLM, no shell.
 *
 * Symbol queries (`shrk why <symbol>`) are intentionally out of scope
 * for the first cut. They require AST analysis that this verb
 * shouldn't grow on its own. The verb gracefully accepts a non-path
 * argument and routes to `shrk knowledge search` via the suggestion
 * block.
 */

import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { matchesAny } from '@shrkcrft/boundaries';
import { deriveApplicability } from '@shrkcrft/rules';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const WHY_FILE_SCHEMA = 'sharkcraft.why/v1';

export type WhyTargetKind = 'file' | 'directory' | 'missing';

export interface IWhyTarget {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly relativePath: string;
  readonly kind: WhyTargetKind;
}

export interface IWhyPathConvention {
  readonly id: string;
  readonly title: string;
  readonly canonicalPath: string;
  readonly source?: string;
}

export interface IWhyRule {
  readonly id: string;
  readonly title: string;
  readonly priority: string;
  readonly scope: readonly string[];
  readonly tags: readonly string[];
  readonly appliesWhen: readonly string[];
  readonly source?: string;
  readonly reason: string;
}

export interface IWhyBoundaryRule {
  readonly id: string;
  readonly title: string;
  readonly severity?: string;
  readonly from: readonly string[];
  readonly forbiddenImports?: readonly string[];
  readonly allowedImports?: readonly string[];
  readonly source?: string;
}

export interface IWhyKnowledge {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly source?: string;
  readonly reason: string;
}

export interface IWhyReport {
  readonly schema: typeof WHY_FILE_SCHEMA;
  readonly target: IWhyTarget;
  readonly inferredPackage?: string;
  readonly inferredLayer?: string;
  readonly pathConventions: readonly IWhyPathConvention[];
  readonly rules: readonly IWhyRule[];
  readonly boundaries: readonly IWhyBoundaryRule[];
  readonly knowledge: readonly IWhyKnowledge[];
  readonly suggestedNext: readonly string[];
}

export interface IBuildWhyReportInput {
  readonly inspection: ISharkcraftInspection;
  readonly projectRoot: string;
  readonly target: string;
  readonly limit?: number;
}

export function buildWhyReport(input: IBuildWhyReportInput): IWhyReport {
  const limit = input.limit ?? 10;
  const target = resolveTarget(input.projectRoot, input.target);
  const inferredPackage = inferPackage(target.relativePath);
  const inferredLayer = inferLayer(target.relativePath);

  const pathConventions = matchPathConventions(input.inspection, target);
  const rules = matchRules(input.inspection, target, limit, inferredPackage, inferredLayer);
  const boundaries = matchBoundaries(input.inspection, target);
  const knowledge = matchKnowledge(input.inspection, target, limit);
  const suggestedNext = buildSuggestions(target, rules, knowledge);

  return {
    schema: WHY_FILE_SCHEMA,
    target,
    ...(inferredPackage !== undefined ? { inferredPackage } : {}),
    ...(inferredLayer !== undefined ? { inferredLayer } : {}),
    pathConventions,
    rules,
    boundaries,
    knowledge,
    suggestedNext,
  };
}

function resolveTarget(projectRoot: string, raw: string): IWhyTarget {
  const resolved = nodePath.isAbsolute(raw) ? raw : nodePath.resolve(projectRoot, raw);
  const relativePath = nodePath.relative(projectRoot, resolved) || '.';
  let kind: WhyTargetKind = 'missing';
  if (existsSync(resolved)) {
    try {
      kind = statSync(resolved).isDirectory() ? 'directory' : 'file';
    } catch {
      kind = 'missing';
    }
  }
  return { inputPath: raw, resolvedPath: resolved, relativePath, kind };
}

function inferPackage(relPath: string): string | undefined {
  if (!relPath || relPath === '.') return undefined;
  const segments = relPath.split(/[/\\]/).filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  if (segments[0] === 'packages' && segments.length >= 2) return `packages/${segments[1]}`;
  if (segments[0] === 'apps' && segments.length >= 2) return `apps/${segments[1]}`;
  if (segments[0] === 'libs' && segments.length >= 2) return `libs/${segments[1]}`;
  if (segments[0] === 'tools' && segments.length >= 2) return `tools/${segments[1]}`;
  return segments[0];
}

function inferLayer(relPath: string): string | undefined {
  // Engine-specific heuristic: under `packages/<layer>/...` the layer is
  // the package name (cli, inspector, generator, …). Empty otherwise so
  // the field is omitted rather than guessed.
  const segments = relPath.split(/[/\\]/).filter((s) => s.length > 0);
  if (segments[0] === 'packages' && segments.length >= 2) return segments[1];
  return undefined;
}

/** Does `targetRel` equal, or live under, the canonical directory/file path? */
function pathCovers(targetRel: string, canonical: string): boolean {
  const normalized = canonical.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized) return false;
  return targetRel === normalized || targetRel.startsWith(`${normalized}/`);
}

function matchPathConventions(
  inspection: ISharkcraftInspection,
  target: IWhyTarget,
): readonly IWhyPathConvention[] {
  const out: IWhyPathConvention[] = [];
  for (const p of inspection.pathService.list()) {
    const canonical = (p.metadata?.path as string | undefined) ?? '';
    if (!canonical) continue;
    if (pathCovers(target.relativePath, canonical)) {
      out.push({
        id: p.id,
        title: p.title,
        canonicalPath: canonical,
        ...sourceField(inspection, p.id),
      });
    }
  }
  return out;
}

interface IRuleLike {
  readonly id: string;
  readonly title: string;
  readonly priority?: string;
  readonly scope?: readonly string[];
  readonly tags?: readonly string[];
  readonly appliesWhen?: readonly string[];
  readonly references?: readonly { kind?: string; path?: string; id?: string }[];
  readonly anchors?: readonly { kind?: string; path?: string }[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Precise PATH evidence that a rule applies to a file — not topical token
 * overlap (scope/tags/appliesWhen are free-form labels, so the old
 * intersection attached nearly every rule to every file). Priority order:
 * explicit file/dir references → path-glob scope/tag → package reference →
 * scope/tag equal to the inferred package or layer.
 */
function ruleReasonForFile(
  r: IRuleLike,
  target: IWhyTarget,
  inferredPackage: string | undefined,
  inferredLayer: string | undefined,
): string | undefined {
  const rel = target.relativePath;
  // 1. Explicit file/directory references that cover the target.
  for (const ref of r.references ?? []) {
    const p = (ref.path ?? '').replace(/^\.\//, '');
    if ((ref.kind === 'file' || ref.kind === 'directory') && p && pathCovers(rel, p)) {
      return ref.kind === 'directory' ? `directory reference ${p}` : `file reference ${p}`;
    }
  }
  // 1b. Anchors that point at a covering path.
  for (const a of r.anchors ?? []) {
    const p = (a.path ?? '').replace(/^\.\//, '');
    if (p && pathCovers(rel, p)) return `anchor path ${p}`;
  }
  // 2. Scope/tag values that are themselves path globs matching the target.
  const pathish = [...(r.scope ?? []), ...(r.tags ?? [])].filter((s) => /[/*?[]/.test(s));
  if (pathish.length > 0) {
    const hit = pathish.find((g) => matchesAny(rel, [g]));
    if (hit) return `path pattern ${hit}`;
  }
  // 2b. Tag / metadata applicability — the SAME mapping `shrk rule-graph for
  // <file>` uses (deriveApplicability): `metadata.appliesTo` globs
  // (authoritative) or a conservative tag→path table (e.g. an `imports`-tagged
  // rule → packages/**/*.ts). This is what makes `why` surface topical-but-real
  // per-file rules that carry no explicit path reference, instead of an empty
  // rules section. Kept consistent with the bridge so the two never diverge.
  const appl = deriveApplicability({ tags: r.tags, metadata: r.metadata });
  if (appl.source !== 'none') {
    const hit = appl.patterns.find((g) => matchesAny(rel, [g]));
    if (hit) return appl.source === 'metadata' ? `appliesTo glob ${hit}` : `tag-mapped path ${hit}`;
  }
  // 3. Package reference / scope-or-tag equal to the inferred package or layer.
  const labels = [...(r.scope ?? []), ...(r.tags ?? [])];
  if (inferredPackage) {
    for (const ref of r.references ?? []) {
      if (ref.kind === 'package' && ref.id && samePath(ref.id, inferredPackage)) {
        return `package reference ${ref.id}`;
      }
    }
    if (labels.some((l) => samePath(l, inferredPackage))) return `scoped to package ${inferredPackage}`;
  }
  if (inferredLayer && labels.some((l) => l.toLowerCase() === inferredLayer.toLowerCase())) {
    return `scoped to layer ${inferredLayer}`;
  }
  return undefined;
}

function samePath(a: string, b: string): boolean {
  const n = (s: string): string => s.replace(/^\.?\/+/, '').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

function matchRules(
  inspection: ISharkcraftInspection,
  target: IWhyTarget,
  limit: number,
  inferredPackage: string | undefined,
  inferredLayer: string | undefined,
): readonly IWhyRule[] {
  const out: IWhyRule[] = [];
  for (const rule of inspection.ruleService.list()) {
    const r = rule as unknown as IRuleLike;
    const reason = ruleReasonForFile(r, target, inferredPackage, inferredLayer);
    if (!reason) continue;
    out.push({
      id: r.id,
      title: r.title,
      priority: r.priority ?? 'medium',
      scope: r.scope ?? [],
      tags: r.tags ?? [],
      appliesWhen: r.appliesWhen ?? [],
      reason,
      ...sourceField(inspection, r.id),
    });
  }
  // Sort by priority weight desc (stable for equal weights).
  const weight: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  out.sort((a, b) => (weight[b.priority] ?? 2) - (weight[a.priority] ?? 2));
  return out.slice(0, limit);
}

function matchBoundaries(
  inspection: ISharkcraftInspection,
  target: IWhyTarget,
): readonly IWhyBoundaryRule[] {
  const out: IWhyBoundaryRule[] = [];
  for (const rule of inspection.boundaryRegistry.list()) {
    if (rule.from.length === 0) continue;
    if (!matchesAny(target.relativePath, rule.from)) continue;
    const entry: IWhyBoundaryRule = {
      id: rule.id,
      title: rule.title,
      ...(rule.severity !== undefined ? { severity: rule.severity } : {}),
      from: rule.from,
      ...(rule.forbiddenImports !== undefined ? { forbiddenImports: rule.forbiddenImports } : {}),
      ...(rule.allowedImports !== undefined ? { allowedImports: rule.allowedImports } : {}),
      ...sourceField(inspection.boundarySources, rule.id),
    };
    out.push(entry);
  }
  return out;
}

function matchKnowledge(
  inspection: ISharkcraftInspection,
  target: IWhyTarget,
  limit: number,
): readonly IWhyKnowledge[] {
  const basename = nodePath.basename(target.relativePath).toLowerCase();
  const rel = target.relativePath.toLowerCase();
  const out: IWhyKnowledge[] = [];
  for (const k of inspection.knowledgeEntries) {
    const refs = ((k as { references?: readonly { path?: string }[] }).references ?? []).map((r) => r.path ?? '');
    const refMatch = refs.some(
      (p) => p.toLowerCase() === rel || p.toLowerCase().endsWith(`/${basename}`),
    );
    const contentMatch = ((k.content ?? '') + ' ' + (k.title ?? '')).toLowerCase().includes(basename);
    if (!refMatch && !contentMatch) continue;
    out.push({
      id: k.id,
      title: k.title,
      type: String(k.type),
      reason: refMatch ? `references the file` : `mentions ${basename}`,
      ...sourceField(inspection, k.id),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function buildSuggestions(
  target: IWhyTarget,
  rules: readonly IWhyRule[],
  knowledge: readonly IWhyKnowledge[],
): readonly string[] {
  const out: string[] = [];
  if (target.kind === 'missing') {
    out.push(`shrk knowledge search "${target.inputPath}"`);
    out.push(`shrk search "${target.inputPath}"`);
    return out;
  }
  if (rules.length > 0) {
    out.push(`shrk rules get ${rules[0]!.id}`);
  }
  if (knowledge.length > 0) {
    out.push(`shrk knowledge get ${knowledge[0]!.id}`);
  }
  out.push(`shrk check boundaries --since origin/main`);
  out.push(`shrk impact "${target.relativePath}"`);
  return out;
}

function sourceField(
  inspection: ISharkcraftInspection | ReadonlyMap<string, { file?: string }>,
  id: string,
): { source?: string } {
  let map: ReadonlyMap<string, { file?: string }> | undefined;
  if (inspection && 'entrySources' in inspection) {
    map = inspection.entrySources;
  } else if (inspection instanceof Map) {
    map = inspection;
  }
  const source = map?.get(id)?.file;
  return source !== undefined ? { source } : {};
}
