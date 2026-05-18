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
  const rules = matchRules(input.inspection, target, limit);
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

function matchPathConventions(
  inspection: ISharkcraftInspection,
  target: IWhyTarget,
): readonly IWhyPathConvention[] {
  const out: IWhyPathConvention[] = [];
  for (const p of inspection.pathService.list()) {
    const canonical = (p.metadata?.path as string | undefined) ?? '';
    if (!canonical) continue;
    const normalized = canonical.replace(/^\.\//, '');
    if (target.relativePath === normalized || target.relativePath.startsWith(normalized.endsWith('/') ? normalized : `${normalized}/`)) {
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

function matchRules(
  inspection: ISharkcraftInspection,
  target: IWhyTarget,
  limit: number,
): readonly IWhyRule[] {
  const tokens = pathTokens(target.relativePath);
  const out: IWhyRule[] = [];
  for (const rule of inspection.ruleService.list()) {
    const r = rule as unknown as {
      id: string;
      title: string;
      priority?: string;
      scope?: readonly string[];
      tags?: readonly string[];
      appliesWhen?: readonly string[];
    };
    const scope = r.scope ?? [];
    const tags = r.tags ?? [];
    const appliesWhen = r.appliesWhen ?? [];
    const allTokens = new Set([...scope, ...tags, ...appliesWhen].map((t) => t.toLowerCase()));
    const hits = tokens.filter((t) => allTokens.has(t.toLowerCase()));
    if (hits.length === 0) continue;
    out.push({
      id: r.id,
      title: r.title,
      priority: r.priority ?? 'medium',
      scope,
      tags,
      appliesWhen,
      reason: `Matches on: ${hits.join(', ')}`,
      ...sourceField(inspection, r.id),
    });
  }
  // Sort by priority weight desc, then by hit count desc.
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

function pathTokens(relPath: string): string[] {
  return relPath
    .replace(/\.[^./]+$/, '') // drop extension
    .split(/[/\\.\-_]/)
    .filter((t) => t.length > 0);
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
