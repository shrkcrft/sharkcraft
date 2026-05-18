/**
 * Repository intelligence graph v2.
 *
 * Unifies existing SharkCraft data sources (packages, files, constructs,
 * rules, paths, templates, pipelines, presets, boundaries, packs,
 * ownership, sessions, bundles) into a single deterministic graph the
 * agent can navigate.
 *
 * Read-only. Sources data from the already-loaded inspection — never
 * re-walks the filesystem unless absolutely necessary. Truncates large
 * collections with explicit metadata so the graph stays bounded on
 * large repos.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { loadTsconfigPaths, scanImports } from '@shrkcrft/boundaries';
import { listConstructs, loadConstructs } from './construct-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const REPOSITORY_INTELLIGENCE_SCHEMA = 'sharkcraft.repository-intelligence/v1';

export enum RepoNodeKind {
  File = 'file',
  Directory = 'directory',
  Package = 'package',
  App = 'app',
  Library = 'library',
  Construct = 'construct',
  PublicApi = 'public-api',
  Template = 'template',
  Pipeline = 'pipeline',
  Playbook = 'playbook',
  Preset = 'preset',
  Policy = 'policy',
  BoundaryRule = 'boundary-rule',
  OwnershipRule = 'ownership-rule',
  Test = 'test',
  Doc = 'doc',
  Script = 'script',
  Pack = 'pack',
  Session = 'session',
  Bundle = 'bundle',
  Decision = 'decision',
}

export enum RepoEdgeKind {
  Imports = 'imports',
  Exports = 'exports',
  Owns = 'owns',
  BelongsTo = 'belongs-to',
  Tests = 'tests',
  Violates = 'violates',
  GovernedBy = 'governed-by',
  GeneratedBy = 'generated-by',
  ReferencedBy = 'referenced-by',
  DependsOn = 'depends-on',
  Impacts = 'impacts',
  UsesTemplate = 'uses-template',
  UsesPipeline = 'uses-pipeline',
  UsesPlaybook = 'uses-playbook',
  RelatedRule = 'related-rule',
  RelatedPath = 'related-path',
  PublicApiOf = 'public-api-of',
}

export interface IRepositoryNode {
  id: string;
  kind: RepoNodeKind;
  label: string;
  meta?: Record<string, unknown>;
}

export interface IRepositoryEdge {
  from: string;
  to: string;
  kind: RepoEdgeKind;
  /** How the imports edge was resolved. Only present on import edges. */
  resolvedVia?: 'literal' | 'tsconfig-path';
}

export interface IRepositoryGraphSummaries {
  packages: number;
  apps: number;
  libraries: number;
  constructs: number;
  policies: number;
  boundaries: number;
  ownership: number;
  tests: number;
  docs: number;
  scripts: number;
  packs: number;
  decisions: number;
}

export interface IRepositoryGraphTruncation {
  files: number;
  filesCap: number;
  filesCapped: boolean;
  importEdges: number;
  importEdgeCap: number;
  importEdgesCapped: boolean;
  /** Number of import edges resolved through a tsconfig path alias. */
  aliasResolvedEdges: number;
}

export interface IBuildRepositoryIntelligenceGraphOptions {
  /** When true, fold in import / depends-on / tests edges. Default false (graph stays compact). */
  includeImports?: boolean;
  /** Cap on the number of import-derived edges. Default 4000. */
  importEdgeCap?: number;
  /** When true, attempt to resolve `@scope/name` imports via tsconfig.base.json paths to file edges. */
  resolveAliases?: boolean;
}

export interface IRepositoryIntelligenceGraph {
  schema: typeof REPOSITORY_INTELLIGENCE_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  nodes: readonly IRepositoryNode[];
  edges: readonly IRepositoryEdge[];
  summaries: IRepositoryGraphSummaries;
  truncation: IRepositoryGraphTruncation;
}

const FILES_CAP = 800;
const IMPORT_EDGE_CAP = 4000;
const TEST_PATTERN = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e)(?:\/|\.)|\.(?:test|spec|e2e)\.[tj]sx?$/i;
const DOC_PATTERN = /(?:^|\/)(?:README|CHANGELOG|LICENSE|CONTRIBUTING|SECURITY)(?:\.md)?$|\.md$/i;
const SCRIPT_PATTERN = /(?:^|\/)(?:scripts?|tools)\//i;

function listPackages(projectRoot: string): { name: string; kind: 'package' | 'app' | 'example'; dir: string }[] {
  const out: { name: string; kind: 'package' | 'app' | 'example'; dir: string }[] = [];
  for (const top of ['packages', 'apps', 'examples'] as const) {
    const root = nodePath.join(projectRoot, top);
    if (!existsSync(root)) continue;
    for (const short of readdirSync(root)) {
      const dir = nodePath.join(root, short);
      const pkgJson = nodePath.join(dir, 'package.json');
      if (!existsSync(pkgJson)) continue;
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      let name = short;
      try {
        const meta = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string };
        if (typeof meta.name === 'string') name = meta.name;
      } catch {
        /* keep short */
      }
      const kind = top === 'packages' ? 'package' : top === 'apps' ? 'app' : 'example';
      out.push({ name, kind, dir });
    }
  }
  return out;
}

function walkSourceFiles(packageDir: string, cap: number): string[] {
  const out: string[] = [];
  const stack: string[] = [packageDir];
  while (stack.length > 0 && out.length < cap) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.sharkcraft' || name.startsWith('.')) {
        continue;
      }
      const full = nodePath.join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (/\.(?:ts|tsx|js|jsx|mts|cts|md)$/.test(name)) out.push(full);
      if (out.length >= cap) break;
    }
  }
  return out;
}

export async function buildRepositoryIntelligenceGraph(
  inspection: ISharkcraftInspection,
  options: IBuildRepositoryIntelligenceGraphOptions = {},
): Promise<IRepositoryIntelligenceGraph> {
  await loadConstructs(inspection);
  const includeImports = options.includeImports === true;
  const importEdgeCap = options.importEdgeCap ?? IMPORT_EDGE_CAP;
  const nodes: IRepositoryNode[] = [];
  const edges: IRepositoryEdge[] = [];
  const seen = new Set<string>();

  const addNode = (n: IRepositoryNode): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };
  const addEdge = (e: IRepositoryEdge): void => {
    edges.push(e);
  };

  // Packages / apps / libraries.
  const packages = listPackages(inspection.projectRoot);
  for (const p of packages) {
    const id = `pkg:${p.name}`;
    const kind =
      p.kind === 'app'
        ? RepoNodeKind.App
        : p.kind === 'example'
          ? RepoNodeKind.Library
          : RepoNodeKind.Package;
    addNode({ id, kind, label: p.name, meta: { dir: p.dir } });
  }

  // Files (capped). Walk each package once.
  let totalFiles = 0;
  let filesCapped = false;
  for (const p of packages) {
    const files = walkSourceFiles(p.dir, FILES_CAP - totalFiles);
    for (const f of files) {
      totalFiles += 1;
      if (totalFiles > FILES_CAP) {
        filesCapped = true;
        break;
      }
      const rel = nodePath.relative(inspection.projectRoot, f);
      const fileId = `file:${rel}`;
      const fileKind = TEST_PATTERN.test(rel)
        ? RepoNodeKind.Test
        : DOC_PATTERN.test(rel)
          ? RepoNodeKind.Doc
          : SCRIPT_PATTERN.test(rel)
            ? RepoNodeKind.Script
            : RepoNodeKind.File;
      addNode({ id: fileId, kind: fileKind, label: rel });
      addEdge({ from: fileId, to: `pkg:${p.name}`, kind: RepoEdgeKind.BelongsTo });
    }
    if (filesCapped) break;
  }
  // Add scripts/* and docs/* at repo root too.
  for (const top of ['scripts', 'docs'] as const) {
    const root = nodePath.join(inspection.projectRoot, top);
    if (!existsSync(root)) continue;
    const files = walkSourceFiles(root, Math.max(0, FILES_CAP - totalFiles));
    for (const f of files) {
      totalFiles += 1;
      if (totalFiles > FILES_CAP) {
        filesCapped = true;
        break;
      }
      const rel = nodePath.relative(inspection.projectRoot, f);
      const id = `file:${rel}`;
      addNode({
        id,
        kind: top === 'docs' ? RepoNodeKind.Doc : RepoNodeKind.Script,
        label: rel,
      });
    }
    if (filesCapped) break;
  }

  // Constructs.
  for (const c of listConstructs(inspection)) {
    const id = `construct:${c.id}`;
    addNode({ id, kind: RepoNodeKind.Construct, label: c.id, meta: { constructType: c.type } });
    if (/api|public/i.test(c.type)) {
      addNode({ id: `public-api:${c.id}`, kind: RepoNodeKind.PublicApi, label: c.id });
      addEdge({ from: `public-api:${c.id}`, to: id, kind: RepoEdgeKind.PublicApiOf });
    }
  }

  // Templates.
  for (const t of inspection.templates) {
    addNode({ id: `template:${t.id}`, kind: RepoNodeKind.Template, label: t.id });
  }

  // Pipelines.
  for (const p of inspection.pipelines) {
    addNode({ id: `pipeline:${p.id}`, kind: RepoNodeKind.Pipeline, label: p.id });
  }

  // Presets.
  for (const pr of inspection.presetRegistry.list()) {
    addNode({ id: `preset:${pr.id}`, kind: RepoNodeKind.Preset, label: pr.id });
  }

  // Boundary rules.
  for (const b of inspection.boundaryRegistry.list()) {
    addNode({
      id: `boundary:${b.id}`,
      kind: RepoNodeKind.BoundaryRule,
      label: b.id,
      meta: { severity: (b as { severity?: string }).severity ?? 'warning' },
    });
  }

  // Packs.
  for (const p of inspection.packs.validPacks ?? []) {
    addNode({
      id: `pack:${p.packageName}`,
      kind: RepoNodeKind.Pack,
      label: p.packageName,
      meta: { version: p.packageVersion ?? '' },
    });
  }

  // Summaries.
  let pkgN = 0,
    appN = 0,
    libN = 0,
    constructN = 0,
    policyN = 0,
    boundaryN = 0,
    ownN = 0,
    testN = 0,
    docN = 0,
    scriptN = 0,
    packN = 0,
    decisionN = 0;
  for (const n of nodes) {
    switch (n.kind) {
      case RepoNodeKind.Package:
        pkgN++;
        break;
      case RepoNodeKind.App:
        appN++;
        break;
      case RepoNodeKind.Library:
        libN++;
        break;
      case RepoNodeKind.Construct:
        constructN++;
        break;
      case RepoNodeKind.Policy:
        policyN++;
        break;
      case RepoNodeKind.BoundaryRule:
        boundaryN++;
        break;
      case RepoNodeKind.OwnershipRule:
        ownN++;
        break;
      case RepoNodeKind.Test:
        testN++;
        break;
      case RepoNodeKind.Doc:
        docN++;
        break;
      case RepoNodeKind.Script:
        scriptN++;
        break;
      case RepoNodeKind.Pack:
        packN++;
        break;
      case RepoNodeKind.Decision:
        decisionN++;
        break;
      default:
        break;
    }
  }

  // Import / depends-on / tests edges (opt-in).
  let importEdgeCount = 0;
  let importEdgesCapped = false;
  let aliasResolvedEdges = 0;
  if (includeImports) {
    let scan: ReturnType<typeof scanImports> | null = null;
    try {
      scan = scanImports({ projectRoot: inspection.projectRoot });
    } catch {
      scan = null;
    }
    let aliasMap: ReadonlyMap<string, readonly string[]> = new Map();
    if (options.resolveAliases === true) {
      try {
        aliasMap = loadTsconfigPaths(inspection.projectRoot).aliases;
      } catch {
        aliasMap = new Map();
      }
    }
    // Build a map of package short name (last segment after /) → package name + dir.
    const packageByDir = new Map<string, string>();
    for (const p of packages) packageByDir.set(p.dir, p.name);
    const packageByPath = (rel: string): string | undefined => {
      for (const [dir, name] of packageByDir) {
        const relDir = nodePath.relative(inspection.projectRoot, dir);
        if (rel === relDir || rel.startsWith(relDir + nodePath.sep) || rel.startsWith(relDir + '/')) return name;
      }
      return undefined;
    };
    const internalPackageNames = new Set(packages.map((p) => p.name));

    const tryResolveCandidates = (target: string): string | undefined => {
      const candidates = /\.[a-z]+$/i.test(target)
        ? [target]
        : [target + '.ts', target + '.tsx', target + '.js', target + '.jsx', target + '/index.ts'];
      for (const c of candidates) {
        const abs = nodePath.join(inspection.projectRoot, c);
        if (existsSync(abs)) return c;
      }
      return undefined;
    };
    const resolveAliasSpecifier = (spec: string): string | undefined => {
      for (const [pattern, paths] of aliasMap.entries()) {
        if (pattern.endsWith('*')) {
          const prefix = pattern.slice(0, -1);
          if (!spec.startsWith(prefix)) continue;
          const rest = spec.slice(prefix.length);
          for (const targetPattern of paths) {
            const resolved = targetPattern.replace(/\*/g, rest);
            const r = tryResolveCandidates(resolved);
            if (r) return r;
          }
        } else if (pattern === spec) {
          for (const t of paths) {
            const r = tryResolveCandidates(t);
            if (r) return r;
          }
        }
      }
      return undefined;
    };

    if (scan) {
      for (const e of scan.edges) {
        if (importEdgeCount >= importEdgeCap) {
          importEdgesCapped = true;
          break;
        }
        const fromFileId = `file:${e.from}`;
        if (e.kind === 'internal') {
          // Relative path → resolve.
          const target = nodePath.normalize(nodePath.join(nodePath.dirname(e.from), e.importSpecifier));
          const resolved = tryResolveCandidates(target);
          if (!resolved) continue;
          const toFileId = `file:${resolved}`;
          if (!seen.has(toFileId)) continue;
          addEdge({ from: fromFileId, to: toFileId, kind: RepoEdgeKind.Imports, resolvedVia: 'literal' });
          importEdgeCount++;
          if (TEST_PATTERN.test(e.from) && !TEST_PATTERN.test(resolved)) {
            addEdge({ from: fromFileId, to: toFileId, kind: RepoEdgeKind.Tests, resolvedVia: 'literal' });
            importEdgeCount++;
          }
        } else if (e.kind === 'external' && e.importSpecifier.startsWith('@')) {
          // Try tsconfig alias resolution first.
          if (options.resolveAliases === true && aliasMap.size > 0) {
            const resolved = resolveAliasSpecifier(e.importSpecifier);
            if (resolved) {
              const toFileId = `file:${resolved}`;
              if (seen.has(toFileId)) {
                addEdge({ from: fromFileId, to: toFileId, kind: RepoEdgeKind.Imports, resolvedVia: 'tsconfig-path' });
                importEdgeCount++;
                aliasResolvedEdges++;
                if (TEST_PATTERN.test(e.from) && !TEST_PATTERN.test(resolved)) {
                  addEdge({ from: fromFileId, to: toFileId, kind: RepoEdgeKind.Tests, resolvedVia: 'tsconfig-path' });
                  importEdgeCount++;
                }
                continue;
              }
            }
          }
          // @scope/package → depends-on between packages.
          const targetPkg = e.importSpecifier.split('/').slice(0, 2).join('/');
          if (!internalPackageNames.has(targetPkg)) continue;
          const fromPkgName = packageByPath(e.from);
          if (!fromPkgName || fromPkgName === targetPkg) continue;
          addEdge({ from: `pkg:${fromPkgName}`, to: `pkg:${targetPkg}`, kind: RepoEdgeKind.DependsOn });
          importEdgeCount++;
        }
      }
    }
  }

  return {
    schema: REPOSITORY_INTELLIGENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    nodes,
    edges,
    summaries: {
      packages: pkgN,
      apps: appN,
      libraries: libN,
      constructs: constructN,
      policies: policyN,
      boundaries: boundaryN,
      ownership: ownN,
      tests: testN,
      docs: docN,
      scripts: scriptN,
      packs: packN,
      decisions: decisionN,
    },
    truncation: {
      files: totalFiles,
      filesCap: FILES_CAP,
      filesCapped,
      importEdges: importEdgeCount,
      importEdgeCap,
      importEdgesCapped,
      aliasResolvedEdges,
    },
  };
}

export function getRepositoryNode(
  graph: IRepositoryIntelligenceGraph,
  id: string,
): IRepositoryNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export interface IRepositoryNodeExplanation {
  node: IRepositoryNode;
  incoming: readonly IRepositoryEdge[];
  outgoing: readonly IRepositoryEdge[];
  neighborCount: number;
}

export function explainRepositoryNode(
  graph: IRepositoryIntelligenceGraph,
  id: string,
): IRepositoryNodeExplanation | undefined {
  const node = getRepositoryNode(graph, id);
  if (!node) return undefined;
  const incoming = graph.edges.filter((e) => e.to === id);
  const outgoing = graph.edges.filter((e) => e.from === id);
  const neighbors = new Set<string>();
  for (const e of incoming) neighbors.add(e.from);
  for (const e of outgoing) neighbors.add(e.to);
  return { node, incoming, outgoing, neighborCount: neighbors.size };
}

export function findRepositoryPath(
  graph: IRepositoryIntelligenceGraph,
  from: string,
  to: string,
  maxDepth = 6,
): readonly string[] | undefined {
  if (!getRepositoryNode(graph, from) || !getRepositoryNode(graph, to)) return undefined;
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  const visited = new Map<string, string | null>();
  visited.set(from, null);
  const queue: string[] = [from];
  let depth = 0;
  while (queue.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const cur of queue) {
      if (cur === to) {
        // Reconstruct.
        const path: string[] = [];
        let p: string | null = cur;
        while (p) {
          path.unshift(p);
          p = visited.get(p) ?? null;
        }
        return path;
      }
      for (const n of adj.get(cur) ?? []) {
        if (visited.has(n)) continue;
        visited.set(n, cur);
        next.push(n);
      }
    }
    if (next.length === 0) break;
    queue.length = 0;
    queue.push(...next);
    depth++;
  }
  return undefined;
}

export interface IRepositoryGraphQuery {
  kinds?: readonly string[];
  edgeKinds?: readonly string[];
  imports?: string;
  dependsOn?: string;
  text?: string;
  tag?: string;
  packageName?: string;
  constructId?: string;
  risk?: 'low' | 'medium' | 'high';
  /** DSL v2: negated filters of the form not:<filter> applied AFTER positive filters. */
  notKinds?: readonly string[];
  notEdgeKinds?: readonly string[];
  notText?: readonly string[];
  notTag?: readonly string[];
  notPackage?: readonly string[];
}

/** Top-level expression is a disjunction (OR) of groups; each group is a conjunction (AND) of filters. */
export interface IRepositoryGraphExpression {
  groups: readonly IRepositoryGraphQuery[];
}

export interface IRepositoryGraphQueryResult {
  nodes: readonly IRepositoryNode[];
  edges: readonly IRepositoryEdge[];
  reasons: readonly string[];
  errors?: readonly string[];
}

function applyTokenToGroup(group: IRepositoryGraphQuery, token: string, errors: string[]): void {
  const negated = token.startsWith('not:');
  const body = negated ? token.slice(4) : token;
  const i = body.indexOf(':');
  if (i < 0) {
    if (negated) {
      (group.notText as string[] | undefined)?.push(body) ?? ((group as { notText?: string[] }).notText = [body]);
    } else {
      group.text = (group.text ? group.text + ' ' : '') + body;
    }
    return;
  }
  const key = body.slice(0, i).toLowerCase();
  const value = body.slice(i + 1);
  if (negated) {
    if (key === 'kind') ((group as { notKinds?: string[] }).notKinds ??= []).push(value);
    else if (key === 'edge') ((group as { notEdgeKinds?: string[] }).notEdgeKinds ??= []).push(value);
    else if (key === 'text') ((group as { notText?: string[] }).notText ??= []).push(value);
    else if (key === 'tag') ((group as { notTag?: string[] }).notTag ??= []).push(value);
    else if (key === 'package' || key === 'pkg') ((group as { notPackage?: string[] }).notPackage ??= []).push(value);
    else errors.push(`Unsupported negated filter: not:${key}:<…>`);
    return;
  }
  if (key === 'kind') ((group as { kinds?: string[] }).kinds ??= []).push(value);
  else if (key === 'edge') ((group as { edgeKinds?: string[] }).edgeKinds ??= []).push(value);
  else if (key === 'imports') group.imports = value;
  else if (key === 'depends-on' || key === 'dependson' || key === 'depends') group.dependsOn = value;
  else if (key === 'text') group.text = (group.text ? group.text + ' ' : '') + value;
  else if (key === 'tag') group.tag = value;
  else if (key === 'package' || key === 'pkg') group.packageName = value;
  else if (key === 'construct') group.constructId = value;
  else if (key === 'risk' && (value === 'low' || value === 'medium' || value === 'high')) group.risk = value;
  else errors.push(`Unknown filter key: ${key}`);
}

export function parseRepositoryGraphExpression(raw: string): {
  expression: IRepositoryGraphExpression;
  errors: string[];
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const errors: string[] = [];
  const groups: IRepositoryGraphQuery[] = [{}];
  for (const token of tokens) {
    if (/^OR$/i.test(token)) {
      groups.push({});
      continue;
    }
    if (/^AND$/i.test(token)) continue;
    const current = groups[groups.length - 1];
    if (current) applyTokenToGroup(current, token, errors);
  }
  return { expression: { groups }, errors };
}

/** Back-compat: single-group AND parse. */
export function parseRepositoryGraphQuery(raw: string): IRepositoryGraphQuery {
  const { expression } = parseRepositoryGraphExpression(raw);
  // When the user didn't use OR, return the single group so callers that
  // expect the legacy IRepositoryGraphQuery shape still work.
  return expression.groups[0] ?? {};
}

function applyGroupFilters(
  graph: IRepositoryIntelligenceGraph,
  query: IRepositoryGraphQuery,
  reasons: string[],
): { nodes: IRepositoryNode[]; edges: IRepositoryEdge[] } {
  let nodes: IRepositoryNode[] = [...graph.nodes];
  let edges: IRepositoryEdge[] = [...graph.edges];
  if (query.kinds && query.kinds.length > 0) {
    nodes = nodes.filter((n) => query.kinds!.includes(n.kind));
    reasons.push(`kind ∈ {${query.kinds.join(', ')}}`);
  }
  if (query.edgeKinds && query.edgeKinds.length > 0) {
    edges = edges.filter((e) => query.edgeKinds!.includes(e.kind));
    reasons.push(`edge ∈ {${query.edgeKinds.join(', ')}}`);
  }
  if (query.text) {
    const t = query.text.toLowerCase();
    nodes = nodes.filter((n) => n.id.toLowerCase().includes(t) || n.label.toLowerCase().includes(t));
    reasons.push(`text contains "${query.text}"`);
  }
  if (query.tag) {
    const t = query.tag.toLowerCase();
    nodes = nodes.filter((n) => n.kind === t || n.label.toLowerCase().includes(t));
    reasons.push(`tag "${query.tag}"`);
  }
  if (query.packageName) {
    nodes = nodes.filter((n) => n.label === query.packageName || n.id === `pkg:${query.packageName}`);
    reasons.push(`package "${query.packageName}"`);
  }
  if (query.constructId) {
    nodes = nodes.filter((n) => n.id === `construct:${query.constructId}` || n.label === query.constructId);
    reasons.push(`construct "${query.constructId}"`);
  }
  if (query.imports) {
    const fragment = query.imports;
    const matchedFromIds = new Set<string>();
    for (const e of graph.edges) {
      if (e.kind !== RepoEdgeKind.Imports) continue;
      if (e.to.includes(fragment) || e.to === `pkg:${fragment}`) matchedFromIds.add(e.from);
    }
    nodes = nodes.filter((n) => matchedFromIds.has(n.id));
    reasons.push(`imports contains "${fragment}"`);
  }
  if (query.dependsOn) {
    const fragment = query.dependsOn;
    const matchedFromIds = new Set<string>();
    for (const e of graph.edges) {
      if (e.kind !== RepoEdgeKind.DependsOn) continue;
      if (e.to.includes(fragment)) matchedFromIds.add(e.from);
    }
    nodes = nodes.filter((n) => matchedFromIds.has(n.id));
    reasons.push(`depends-on "${fragment}"`);
  }
  // Negated filters
  if (query.notKinds && query.notKinds.length > 0) {
    nodes = nodes.filter((n) => !query.notKinds!.includes(n.kind));
    reasons.push(`not:kind ∈ {${query.notKinds.join(', ')}}`);
  }
  if (query.notEdgeKinds && query.notEdgeKinds.length > 0) {
    edges = edges.filter((e) => !query.notEdgeKinds!.includes(e.kind));
    reasons.push(`not:edge ∈ {${query.notEdgeKinds.join(', ')}}`);
  }
  if (query.notText && query.notText.length > 0) {
    const lows = query.notText.map((t) => t.toLowerCase());
    nodes = nodes.filter((n) => !lows.some((t) => n.id.toLowerCase().includes(t) || n.label.toLowerCase().includes(t)));
    reasons.push(`not:text ∈ {${query.notText.join(', ')}}`);
  }
  if (query.notTag && query.notTag.length > 0) {
    const lows = query.notTag.map((t) => t.toLowerCase());
    nodes = nodes.filter((n) => !lows.some((t) => n.kind === t || n.label.toLowerCase().includes(t)));
    reasons.push(`not:tag ∈ {${query.notTag.join(', ')}}`);
  }
  if (query.notPackage && query.notPackage.length > 0) {
    nodes = nodes.filter((n) => !query.notPackage!.includes(n.label));
    reasons.push(`not:package ∈ {${query.notPackage.join(', ')}}`);
  }
  return { nodes, edges };
}

export function queryRepositoryIntelligence(
  graph: IRepositoryIntelligenceGraph,
  query: IRepositoryGraphQuery | IRepositoryGraphExpression,
): IRepositoryGraphQueryResult {
  const reasons: string[] = [];
  // Backwards-compatible: a plain query object is treated as a single AND group.
  const groups: readonly IRepositoryGraphQuery[] =
    (query as IRepositoryGraphExpression).groups ?? [query as IRepositoryGraphQuery];
  if (groups.length === 1) {
    const { nodes, edges } = applyGroupFilters(graph, groups[0]!, reasons);
    return { nodes, edges, reasons };
  }
  // Multiple groups: OR together. Compute each group and union the nodes by id.
  const unionNodes = new Map<string, IRepositoryNode>();
  const unionEdgesKey = new Set<string>();
  const unionEdges: IRepositoryEdge[] = [];
  for (let i = 0; i < groups.length; i++) {
    const groupReasons: string[] = [];
    const { nodes, edges } = applyGroupFilters(graph, groups[i]!, groupReasons);
    reasons.push(`group ${i + 1}: ${groupReasons.join(' ∧ ') || '(no filters)'}`);
    for (const n of nodes) unionNodes.set(n.id, n);
    for (const e of edges) {
      const k = `${e.from}|${e.kind}|${e.to}`;
      if (unionEdgesKey.has(k)) continue;
      unionEdgesKey.add(k);
      unionEdges.push(e);
    }
  }
  return { nodes: [...unionNodes.values()], edges: unionEdges, reasons };
}

export function summarizeEdgeKinds(graph: IRepositoryIntelligenceGraph): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of graph.edges) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

export function renderRepositoryIntelligenceText(graph: IRepositoryIntelligenceGraph): string {
  const lines: string[] = [];
  lines.push('=== Repository intelligence ===');
  lines.push(`  nodes        ${graph.nodes.length}`);
  lines.push(`  edges        ${graph.edges.length}`);
  lines.push(`  packages     ${graph.summaries.packages}`);
  lines.push(`  apps         ${graph.summaries.apps}`);
  lines.push(`  libraries    ${graph.summaries.libraries}`);
  lines.push(`  constructs   ${graph.summaries.constructs}`);
  lines.push(`  policies     ${graph.summaries.policies}`);
  lines.push(`  boundaries   ${graph.summaries.boundaries}`);
  lines.push(`  ownership    ${graph.summaries.ownership}`);
  lines.push(`  tests        ${graph.summaries.tests}`);
  lines.push(`  docs         ${graph.summaries.docs}`);
  lines.push(`  scripts      ${graph.summaries.scripts}`);
  lines.push(`  packs        ${graph.summaries.packs}`);
  lines.push(`  decisions    ${graph.summaries.decisions}`);
  if (graph.truncation.filesCapped) {
    lines.push(`  truncated    files capped at ${graph.truncation.filesCap}`);
  }
  if (graph.truncation.importEdges > 0 || graph.truncation.importEdgesCapped) {
    lines.push(`  import edges ${graph.truncation.importEdges}${graph.truncation.importEdgesCapped ? ` (capped at ${graph.truncation.importEdgeCap})` : ''}`);
  }
  if (graph.truncation.aliasResolvedEdges > 0) {
    lines.push(`  alias-resolved edges ${graph.truncation.aliasResolvedEdges}`);
  }
  const ek = summarizeEdgeKinds(graph);
  if (Object.keys(ek).length > 0) {
    lines.push('Edges by kind:');
    for (const [k, v] of Object.entries(ek).sort((a, b) => b[1] - a[1])) lines.push(`  ${k.padEnd(16)} ${v}`);
  }
  return lines.join('\n') + '\n';
}
