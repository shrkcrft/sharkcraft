import { execSync } from 'node:child_process';
import {
  EdgeKind,
  GraphQueryApi,
  GraphStore,
  NodeKind,
  type INode,
} from '@shrkcrft/graph';
import {
  BridgeStore,
  RuleGraphQueryApi,
} from '@shrkcrft/rule-graph';
import {
  GRAPH_IMPACT_SCHEMA,
  type IAffectedAssetRef,
  type IAffectedNodeRef,
  type IGraphImpactAnalysis,
} from '../schema/impact-analysis.ts';
import { classifyRisk } from './risk-score.ts';

export type IGraphImpactInput =
  | { kind: 'files'; files: readonly string[] }
  | { kind: 'symbol'; symbolId: string }
  | { kind: 'gitref'; ref: string };

export interface IAnalyzeOptions {
  projectRoot: string;
  /** Cap on each list. Default 200. */
  limit?: number;
  /** Cap on reverse-closure depth. Default 5. */
  maxDepth?: number;
}

/**
 * Compute a v3 graph-backed impact analysis.
 *
 * Failure modes are non-fatal:
 *   - missing code graph → diagnostic + minimal payload
 *   - missing bridge → no affectedRules/Paths/Templates; not an error
 *   - input file unknown to the graph → kept in `normalizedTargets`
 *     with a diagnostic, treated as zero-dependent
 */
export function analyzeGraphImpact(
  input: IGraphImpactInput,
  options: IAnalyzeOptions,
): IGraphImpactAnalysis {
  const limit = options.limit ?? 200;
  const maxDepth = Math.max(1, Math.min(10, options.maxDepth ?? 5));
  const graphStore = new GraphStore(options.projectRoot);
  const diagnostics: string[] = [];
  if (!graphStore.exists()) {
    return missingGraphPayload(input, ['code-graph store missing — run `shrk graph index`']);
  }
  const api = GraphQueryApi.fromStore(options.projectRoot);

  let bridgeApi: RuleGraphQueryApi | undefined;
  const bridgeStore = new BridgeStore(options.projectRoot);
  if (bridgeStore.exists()) {
    bridgeApi = RuleGraphQueryApi.fromStores(options.projectRoot);
  } else {
    diagnostics.push("bridge store missing — `shrk rule-graph index` for affectedRules/Templates");
  }

  // Resolve input → target node ids.
  const targets: { nodeId: string; path?: string; isSymbol: boolean }[] = [];
  const normalizedTargets: string[] = [];

  const addFileTarget = (relPath: string): void => {
    const file = api.findFile(relPath);
    if (file) {
      targets.push({ nodeId: file.id, path: file.path, isSymbol: false });
      normalizedTargets.push(file.id);
    } else {
      diagnostics.push(`file not in graph: ${relPath}`);
      normalizedTargets.push(`file:${relPath}`);
    }
  };
  if (input.kind === 'files') {
    for (const f of input.files) addFileTarget(f);
  } else if (input.kind === 'symbol') {
    let symNode: INode | undefined;
    if (input.symbolId.startsWith('symbol:')) {
      symNode = api.neighbours(input.symbolId)?.node;
    } else {
      const matches = api.findSymbol(input.symbolId, { exact: true, limit: 5 });
      symNode = matches.find((s) => (s.data?.['isExported'] ?? false) === true) ?? matches[0];
    }
    if (symNode) {
      targets.push({ nodeId: symNode.id, path: symNode.path, isSymbol: true });
      normalizedTargets.push(symNode.id);
    } else {
      diagnostics.push(`symbol not in graph: ${input.symbolId}`);
      normalizedTargets.push(`symbol:${input.symbolId}`);
    }
  } else {
    const files = changedFilesSince(options.projectRoot, input.ref);
    if (files.length === 0) diagnostics.push(`no files changed since ${input.ref}`);
    for (const f of files) addFileTarget(f);
  }

  // Reverse closure over imports-file edges.
  const truncations: Record<string, number> = {};
  const reachable = new Set<string>();
  for (const t of targets) reachable.add(t.nodeId);
  const directIds = new Set<string>();
  {
    let frontier: string[] = [...reachable];
    let depth = 1;
    while (depth <= maxDepth && frontier.length > 0) {
      const next: string[] = [];
      let truncated = false;
      for (const id of frontier) {
        for (const imp of api.importersOf(id)) {
          if (reachable.has(imp.id)) continue;
          reachable.add(imp.id);
          next.push(imp.id);
          if (depth === 1) directIds.add(imp.id);
          if (reachable.size - targets.length >= limit) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      if (truncated) {
        truncations['dependents'] = (truncations['dependents'] ?? 0) + 1;
        break;
      }
      frontier = next;
      depth += 1;
    }
  }
  const direct = [...directIds]
    .map((id) => toRef(api, id))
    .filter((r): r is IAffectedNodeRef => r !== undefined);
  const transitive: IAffectedNodeRef[] = [];
  for (const id of reachable) {
    if (id === targets.find((t) => t.nodeId === id)?.nodeId) continue;
    if (directIds.has(id)) continue;
    if (targets.some((t) => t.nodeId === id)) continue;
    const ref = toRef(api, id);
    if (ref) transitive.push(ref);
    if (transitive.length >= limit) {
      truncations['transitive'] = (truncations['transitive'] ?? 0) + 1;
      break;
    }
  }

  // Symbols declared by target files.
  const affectedSymbols: IAffectedNodeRef[] = [];
  const callerSet = new Set<string>();
  for (const t of targets) {
    if (t.isSymbol) {
      affectedSymbols.push(toRefForce(api, t.nodeId));
      for (const c of api.referencesOf(t.nodeId)) callerSet.add(c.id);
    } else {
      for (const sym of api.symbolsIn(t.nodeId)) {
        affectedSymbols.push(toRefForce(api, sym.id));
        for (const c of api.referencesOf(sym.id)) callerSet.add(c.id);
      }
    }
  }
  const affectedCallerFiles = [...callerSet]
    .map((id) => toRef(api, id))
    .filter((r): r is IAffectedNodeRef => r !== undefined)
    .slice(0, limit);

  // Affected packages.
  const packagesSet = new Set<string>();
  for (const id of reachable) {
    const pkg = packageOf(api, id);
    if (pkg) packagesSet.add(pkg);
  }
  const affectedPackages = [...packagesSet].sort();

  // Rule-graph bridge: rules / paths / templates touching any affected file.
  const affectedRules: IAffectedAssetRef[] = [];
  const affectedPaths: IAffectedAssetRef[] = [];
  const affectedTemplates: IAffectedAssetRef[] = [];
  if (bridgeApi) {
    const seenRule = new Set<string>();
    const seenPath = new Set<string>();
    const seenTpl = new Set<string>();
    for (const id of reachable) {
      const node = api.neighbours(id)?.node;
      if (!node?.path) continue;
      const f = bridgeApi.forFile(node.path);
      if (!f) continue;
      for (const h of f.rules) {
        if (seenRule.has(h.target.id)) continue;
        seenRule.add(h.target.id);
        affectedRules.push({
          id: h.target.id,
          label: h.target.label,
          severity: (h.edge.data?.['severity'] as string | undefined) ?? undefined,
        });
      }
      for (const h of f.paths) {
        if (seenPath.has(h.target.id)) continue;
        seenPath.add(h.target.id);
        affectedPaths.push({ id: h.target.id, label: h.target.label });
      }
      for (const h of f.templates) {
        if (seenTpl.has(h.target.id)) continue;
        seenTpl.add(h.target.id);
        affectedTemplates.push({ id: h.target.id, label: h.target.label });
      }
    }
  }

  // Likely tests: reachable files tagged `test`.
  const likelyTests: IAffectedNodeRef[] = [];
  for (const id of reachable) {
    const node = api.neighbours(id)?.node;
    if (!node) continue;
    if (!(node.tags ?? []).includes('test')) continue;
    const ref = toRef(api, id);
    if (ref) likelyTests.push(ref);
    if (likelyTests.length >= limit) {
      truncations['likelyTests'] = (truncations['likelyTests'] ?? 0) + 1;
      break;
    }
  }

  // publicApiTouched: any target is an index file or declares an exported symbol.
  let publicApiTouched = false;
  for (const t of targets) {
    if (t.path && (/\/index\.ts$/.test(t.path) || /^index\.ts$/.test(t.path) || t.path.endsWith('.d.ts'))) {
      publicApiTouched = true;
      break;
    }
    if (t.isSymbol) {
      const node = api.neighbours(t.nodeId)?.node;
      if (node && (node.data?.['isExported'] ?? false) === true) {
        publicApiTouched = true;
        break;
      }
    } else {
      const syms = api.symbolsIn(t.nodeId);
      if (syms.some((s) => (s.data?.['isExported'] ?? false) === true)) {
        publicApiTouched = true;
        break;
      }
    }
  }

  // Risk + validation scope.
  const { risk, reasons } = classifyRisk({
    directCount: direct.length,
    transitiveCount: transitive.length,
    packagesTouched: affectedPackages.length,
    rulesTouched: affectedRules.length,
    templatesTouched: affectedTemplates.length,
    publicApiTouched,
    callerFilesCount: affectedCallerFiles.length,
  });
  const validationScope = deriveValidationScope({
    risk,
    affectedRules: affectedRules.length,
    affectedTemplates: affectedTemplates.length,
    likelyTests: likelyTests.length,
    affectedPackages,
  });

  return {
    schema: GRAPH_IMPACT_SCHEMA,
    inputKind: input.kind,
    normalizedTargets,
    directDependents: direct,
    transitiveDependents: transitive,
    affectedSymbols,
    affectedCallerFiles,
    affectedPackages,
    affectedRules,
    affectedPaths,
    affectedTemplates,
    likelyTests,
    publicApiTouched,
    risk,
    riskReasons: reasons,
    validationScope,
    truncations,
    diagnostics,
  };
}

function toRef(api: GraphQueryApi, id: string): IAffectedNodeRef | undefined {
  const node = api.neighbours(id)?.node;
  if (!node) return undefined;
  return toRefFromNode(node);
}

function toRefForce(api: GraphQueryApi, id: string): IAffectedNodeRef {
  const ref = toRef(api, id);
  return ref ?? { id, kind: 'unknown', label: id };
}

function toRefFromNode(node: INode): IAffectedNodeRef {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.path ? { path: node.path } : {}),
    ...(node.line ? { line: node.line } : {}),
  };
}

function packageOf(api: GraphQueryApi, id: string): string | undefined {
  // A file → package via BelongsToPackage edge.
  const neighbours = api.neighbours(id);
  if (!neighbours) return undefined;
  for (const edge of neighbours.out) {
    if (edge.edge.kind === EdgeKind.BelongsToPackage) {
      const target = edge.target as INode | { id: string; resolved: false };
      if ('kind' in target && target.kind === NodeKind.Package) return target.label;
    }
  }
  // Symbol → owning file → package.
  if (id.startsWith('symbol:')) {
    const filePath = id.slice('symbol:'.length).split('#')[0];
    if (filePath) {
      const fileId = `file:${filePath}`;
      return packageOf(api, fileId);
    }
  }
  return undefined;
}

function deriveValidationScope(input: {
  risk: 'low' | 'medium' | 'high' | 'critical';
  affectedRules: number;
  affectedTemplates: number;
  likelyTests: number;
  affectedPackages: readonly string[];
}): readonly string[] {
  const out: string[] = [];
  if (input.affectedRules > 0) out.push('shrk check boundaries');
  if (input.affectedTemplates > 0) out.push('shrk drift --json');
  if (input.likelyTests > 0) out.push('bun test');
  if (input.risk === 'high' || input.risk === 'critical') {
    out.push('shrk doctor');
    out.push('bun x tsc -p tsconfig.base.json --noEmit');
  }
  return out;
}

function missingGraphPayload(
  input: IGraphImpactInput,
  diagnostics: readonly string[],
): IGraphImpactAnalysis {
  return {
    schema: GRAPH_IMPACT_SCHEMA,
    inputKind: input.kind,
    normalizedTargets: [],
    directDependents: [],
    transitiveDependents: [],
    affectedSymbols: [],
    affectedCallerFiles: [],
    affectedPackages: [],
    affectedRules: [],
    affectedPaths: [],
    affectedTemplates: [],
    likelyTests: [],
    publicApiTouched: false,
    risk: 'low',
    riskReasons: [],
    validationScope: [],
    truncations: {},
    diagnostics,
  };
}

function changedFilesSince(projectRoot: string, ref: string): readonly string[] {
  try {
    const raw = execSync(`git diff --name-only ${ref}`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

