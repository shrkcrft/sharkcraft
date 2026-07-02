import { createHash } from 'node:crypto';
import { globToRegex } from '@shrkcrft/boundaries';
import {
  EdgeKind,
  GraphStore,
  NodeKind,
  type IEdge,
  type INode,
} from '@shrkcrft/graph';
import {
  inspectSharkcraft,
  listConventions,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import { BridgeStore } from '../store/bridge-store.ts';
import type { IBridgeManifest } from '../schema/bridge-schema.ts';
import { deriveApplicability } from './knowledge-rule-matching.ts';

const BRIDGE_SOURCE = 'rule-graph-bridge@v1';

export interface IBridgeBuildOptions {
  projectRoot: string;
  /** Optional pre-loaded inspection; built on the fly when absent. */
  inspection?: ISharkcraftInspection;
}

export interface IBridgeBuildResult {
  manifest: IBridgeManifest;
  durationMs: number;
}

/**
 * Build bridge edges from the code graph (file nodes) to asset
 * registries (boundary rules, path conventions, templates).
 *
 * Inputs:
 *   - graph store (must already exist; run `shrk graph index` first)
 *   - inspection (defaults to `inspectSharkcraft({ cwd: projectRoot })`)
 *
 * Output: writes to `.sharkcraft/bridge/` with schema
 * `sharkcraft.rule-graph/v1`.
 */
export async function buildBridge(
  options: IBridgeBuildOptions,
): Promise<IBridgeBuildResult> {
  const start = Date.now();
  const { projectRoot } = options;
  const graphStore = new GraphStore(projectRoot);
  if (!graphStore.exists()) {
    throw new Error(
      "code-graph store missing. Run 'shrk graph index' before 'shrk rule-graph index'.",
    );
  }
  const graph = graphStore.loadSnapshot();
  const inspection = options.inspection ?? (await inspectSharkcraft({ cwd: projectRoot }));

  const files: INode[] = [];
  for (const n of graph.nodes.values()) {
    if (n.kind === NodeKind.File && n.path) files.push(n);
  }

  const nodes: INode[] = [];
  const edges: IEdge[] = [];
  const sourceCounts: Record<string, number> = { rule: 0, path: 0, template: 0 };
  /**
   * Track which file ids have at least one `applies-rule` edge — this
   * is the set that backs the §3.2 "bridge coverage" doctor check. We
   * deliberately exclude `matches-path` and `covered-by-template` here
   * (those signal location / generation, not policy).
   */
  const filesWithRule = new Set<string>();

  // ── Boundary rules ─────────────────────────────────────────────────
  const boundaries = inspection.boundaryRegistry.list();
  for (const b of boundaries) {
    nodes.push({
      id: `boundary:${b.id}`,
      kind: NodeKind.Boundary,
      label: b.title ?? b.id,
      data: {
        severity: b.severity ?? 'error',
        ...(b.tags ? { tags: [...b.tags] } : {}),
      },
    });
    const regexes = b.from.map((p) => globToRegex(p));
    for (const f of files) {
      if (!regexes.some((re) => re.test(f.path!))) continue;
      edges.push(
        edge(f.id, `boundary:${b.id}`, EdgeKind.AppliesRule, {
          source: 'boundary',
          severity: b.severity ?? 'error',
        }),
      );
      sourceCounts['rule']! += 1;
      filesWithRule.add(f.id);
    }
  }

  // ── Knowledge rules (IKnowledgeEntry type=rule) ────────────────────
  // Heuristic bridge via metadata.appliesTo or tag-based fallback. See
  // `deriveApplicability` for the rationale.
  const knowledgeRules = inspection.ruleService.list();
  for (const r of knowledgeRules) {
    const applicability = deriveApplicability(r);
    if (applicability.source === 'none') continue;
    nodes.push({
      id: `rule:${r.id}`,
      kind: NodeKind.Rule,
      label: r.title ?? r.id,
      data: {
        applicabilitySource: applicability.source,
        ...(r.tags ? { tags: [...r.tags] } : {}),
        ...(r.priority ? { priority: r.priority } : {}),
      },
    });
    const regexes = applicability.patterns.map((p) => globToRegex(p));
    const tagSet = new Set(applicability.fileTags);
    const severity = (r.priority === 'critical' || r.priority === 'high') ? 'error' : 'warning';
    for (const f of files) {
      const pathMatch = regexes.some((re) => re.test(f.path!));
      const tagMatch = tagSet.size > 0 && (f.tags ?? []).some((t) => tagSet.has(t));
      if (!pathMatch && !tagMatch) continue;
      edges.push(
        edge(f.id, `rule:${r.id}`, EdgeKind.AppliesRule, {
          source: 'knowledge',
          severity,
          via: pathMatch ? 'path' : 'tag',
        }),
      );
      sourceCounts['rule']! += 1;
      filesWithRule.add(f.id);
    }
  }

  // ── Conventions (IConvention.appliesTo.fileGlobs) ──────────────────
  // Conventions are the richest file-anchored policy a pack ships (the
  // knowledge rules are task-intent / file-agnostic, so they almost never
  // anchor files). Count their fileGlobs toward `filesWithRule` so the
  // "files covered by rules" metric reflects the real file-anchored policy
  // surface (boundaries + conventions), not a misleading 0.
  const conventions = await listConventions(inspection);
  for (const entry of conventions) {
    const c = entry.convention;
    const globs = c.appliesTo?.fileGlobs ?? [];
    if (globs.length === 0) continue;
    nodes.push({
      id: `convention:${c.id}`,
      kind: NodeKind.Rule,
      label: c.title ?? c.id,
      data: {
        applicabilitySource: 'convention',
        conventionKind: c.kind,
        ...(c.tags ? { tags: [...c.tags] } : {}),
      },
    });
    const regexes = globs.map((g) => globToRegex(g));
    const severity = c.severity === 'error' ? 'error' : 'warning';
    for (const f of files) {
      if (!regexes.some((re) => re.test(f.path!))) continue;
      edges.push(
        edge(f.id, `convention:${c.id}`, EdgeKind.AppliesRule, {
          source: 'convention',
          severity,
        }),
      );
      sourceCounts['rule']! += 1;
      filesWithRule.add(f.id);
    }
  }

  // ── Path conventions ───────────────────────────────────────────────
  const paths = inspection.pathService.list();
  for (const p of paths) {
    const target = (p.metadata?.path as string | undefined) ?? '';
    if (!target) continue;
    nodes.push({
      id: `path:${p.id}`,
      kind: NodeKind.Path,
      label: p.title ?? p.id,
      data: { target },
    });
    const prefix = target.replace(/\/+$/, '');
    for (const f of files) {
      if (!isUnderPrefix(f.path!, prefix)) continue;
      edges.push(
        edge(f.id, `path:${p.id}`, EdgeKind.MatchesPath, { prefix }),
      );
      sourceCounts['path']! += 1;
    }
  }

  // ── Templates (string + invertible-function targetPath) ────────────
  const templates = inspection.templateRegistry.list();
  for (const t of templates) {
    nodes.push({
      id: `template:${t.id}`,
      kind: NodeKind.Template,
      label: t.name ?? t.id,
    });
    // Only attribute coverage on a REAL emit-path match: a file must match one
    // of the template's actual output paths whose basename is a concrete
    // emitted filename. A wildcarded/loose pattern (bare `*`, a `**` segment, or
    // a wildcard basename) is NOT an emit-path claim — dropping it prevents the
    // "covered by an unrelated template" false provenance.
    const patterns = precisePatterns(resolveTemplatePatterns(t as unknown as ITemplateLike));
    if (patterns.length === 0) continue;
    const matchers = patterns.map((p) => ({ pattern: p, re: globToRegex(p) }));
    for (const f of files) {
      const hit = matchers.find((m) => m.re.test(f.path!));
      if (!hit) continue;
      edges.push(
        edge(f.id, `template:${t.id}`, EdgeKind.CoveredByTemplate, { pattern: hit.pattern }),
      );
      sourceCounts['template']! += 1;
    }
  }

  const store = new BridgeStore(projectRoot);
  const filesTotal = files.length;
  const filesCoveredByRules = filesWithRule.size;
  const manifest = store.writeSnapshot(nodes, edges, {
    projectRoot,
    lastBuiltAt: new Date().toISOString(),
    lastBuildDurationMs: Date.now() - start,
    nodesByKind: {},
    edgesByKind: {},
    sourceCounts,
    filesTotal,
    filesCoveredByRules,
    filesUncoveredByRules: filesTotal - filesCoveredByRules,
  });
  return { manifest, durationMs: Date.now() - start };
}

function edge(
  from: string,
  to: string,
  kind: EdgeKind,
  data?: Readonly<Record<string, unknown>>,
): IEdge {
  return {
    id: createHash('sha1').update(`${from}|${to}|${kind}`).digest('hex'),
    from,
    to,
    kind,
    source: BRIDGE_SOURCE,
    ...(data ? { data } : {}),
  };
}

function isUnderPrefix(filePath: string, prefix: string): boolean {
  if (!prefix) return false;
  if (prefix === '.' || prefix === '/') return true;
  return filePath === prefix || filePath.startsWith(prefix + '/');
}

interface ITemplateLike {
  id: string;
  name?: string;
  targetPath?: string | ((values: Record<string, unknown>) => string);
  files?: (values: Record<string, unknown>) => { targetPath: string }[];
  changes?: (values: Record<string, unknown>) => { targetPath: string }[];
  variables?: readonly { name: string }[];
}

/**
 * Invert a template's path resolvers to the FULL set of emit-path globs by
 * substituting `*` for every declared variable. Unlike the previous
 * single-pattern version, this collects every output path (string targetPath,
 * function targetPath, and every entry of files()/changes()), so a multi-file
 * template is modeled by its real emit set rather than a collapsed first path.
 *
 * Returns an empty list when a resolver throws.
 */
function resolveTemplatePatterns(t: ITemplateLike): string[] {
  const dummy: Record<string, unknown> = {};
  for (const v of t.variables ?? []) dummy[v.name] = '*';
  const out: string[] = [];
  try {
    if (typeof t.targetPath === 'string') out.push(t.targetPath);
    else if (typeof t.targetPath === 'function') {
      const p = t.targetPath(dummy);
      if (p) out.push(p);
    }
    if (t.files) for (const f of t.files(dummy)) if (f?.targetPath) out.push(f.targetPath);
    if (t.changes) for (const c of t.changes(dummy)) if (c?.targetPath) out.push(c.targetPath);
  } catch {
    return [];
  }
  return out;
}

/**
 * Keep only patterns precise enough to be a real emit-path claim, and dedupe.
 * A pattern is precise when its basename (the emitted filename) is concrete —
 * a template scaffolds a named file, not "everything under a dir". This drops
 * bare `*`, `.`/`/`, any `**` segment, and wildcard basenames (`src/*`,
 * `packages/*`), which are path-prefix overlaps, not emit-path matches.
 */
function precisePatterns(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p || p === '*' || p === '**' || p === '.' || p === '/') continue;
    const segments = p.split('/');
    if (segments.some((seg) => seg === '**')) continue;
    const base = segments[segments.length - 1] ?? '';
    if (base === '' || base.includes('*') || base.includes('?')) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
