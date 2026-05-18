import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { scanImports, type IImportScanResult } from '@shrkcrft/boundaries';

export const IMPORT_GRAPH_ANALYSIS_SCHEMA = 'sharkcraft.import-graph-analysis/v1';

export interface IImportGraphCycle {
  nodes: readonly string[];
}

export interface IImportGraphAnalysis {
  schema: typeof IMPORT_GRAPH_ANALYSIS_SCHEMA;
  projectRoot: string;
  filesScanned: number;
  packageCount: number;
  workspacePackages: readonly string[];
  topFanIn: readonly { file: string; in: number }[];
  topFanOut: readonly { file: string; out: number }[];
  orphans: readonly string[];
  cycles: readonly IImportGraphCycle[];
  internalAliasGroups: readonly { alias: string; count: number }[];
  unusedPublicEntrypoints: readonly string[];
}

function detectWorkspacePackages(projectRoot: string): string[] {
  const pkgPath = nodePath.join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      workspaces?: readonly string[] | { packages?: readonly string[] };
    };
    const ws = json.workspaces;
    const raw: readonly string[] = Array.isArray(ws)
      ? ws
      : (ws as { packages?: readonly string[] } | undefined)?.packages ?? [];
    const names: string[] = [];
    for (const pattern of raw) {
      const dir = pattern.replace(/\/\*?$/, '');
      const full = nodePath.join(projectRoot, dir);
      if (!existsSync(full)) continue;
      try {
        for (const child of readdirSync(full)) {
          const inner = nodePath.join(full, child);
          try {
            if (!statSync(inner).isDirectory()) continue;
          } catch {
            continue;
          }
          const childPkg = nodePath.join(inner, 'package.json');
          if (!existsSync(childPkg)) continue;
          try {
            const pj = JSON.parse(readFileSync(childPkg, 'utf8')) as { name?: string };
            if (pj.name) names.push(pj.name);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
    return names.sort();
  } catch {
    return [];
  }
}

export function analyzeImportGraph(projectRoot: string): IImportGraphAnalysis {
  let scan: IImportScanResult;
  try {
    scan = scanImports({ projectRoot });
  } catch {
    scan = { filesScanned: 0, edges: [], warnings: [] };
  }
  const workspacePackages = detectWorkspacePackages(projectRoot);

  // Fan-in / fan-out by file.
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const adj = new Map<string, Set<string>>();
  for (const e of scan.edges) {
    if (e.kind !== 'internal') continue;
    const target = resolveRelative(e.from, e.importSpecifier);
    if (!target) continue;
    fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
    fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
    const set = adj.get(e.from) ?? new Set<string>();
    set.add(target);
    adj.set(e.from, set);
  }

  const topFanIn = [...fanIn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, n]) => ({ file, in: n }));
  const topFanOut = [...fanOut.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, n]) => ({ file, out: n }));

  // Orphans: files we know about that have no incoming edges and are not entry-shaped.
  const knownFiles = new Set<string>();
  for (const e of scan.edges) knownFiles.add(e.from);
  for (const t of fanIn.keys()) knownFiles.add(t);
  const orphans: string[] = [];
  for (const f of knownFiles) {
    if ((fanIn.get(f) ?? 0) > 0) continue;
    if (isPublicEntry(f)) continue;
    orphans.push(f);
  }
  orphans.sort();

  // Cycles via Tarjan's SCC.
  const cycles = stronglyConnectedComponents(adj).filter((c) => c.length > 1).map((nodes) => ({
    nodes,
  }));

  // Internal alias groups: count occurrences of @org/* style specifiers.
  const aliasCounts = new Map<string, number>();
  for (const e of scan.edges) {
    if (e.kind === 'external' && e.importSpecifier.startsWith('@')) {
      const top = e.importSpecifier.split('/').slice(0, 2).join('/');
      aliasCounts.set(top, (aliasCounts.get(top) ?? 0) + 1);
    }
  }
  const internalAliasGroups = [...aliasCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([alias, count]) => ({ alias, count }))
    .slice(0, 10);

  // Unused public entrypoints: index.ts files that no other internal file imports.
  const unusedPublicEntrypoints: string[] = [];
  for (const f of knownFiles) {
    if (!/\/index\.ts$/.test(f) && !/^index\.ts$/.test(f)) continue;
    if ((fanIn.get(f) ?? 0) === 0) unusedPublicEntrypoints.push(f);
  }

  return {
    schema: IMPORT_GRAPH_ANALYSIS_SCHEMA,
    projectRoot,
    filesScanned: scan.filesScanned,
    packageCount: workspacePackages.length,
    workspacePackages,
    topFanIn,
    topFanOut,
    orphans: orphans.slice(0, 50),
    cycles,
    internalAliasGroups,
    unusedPublicEntrypoints: unusedPublicEntrypoints.slice(0, 30),
  };
}

function resolveRelative(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const dir = nodePath.posix.dirname(from);
  const joined = nodePath.posix.normalize(nodePath.posix.join(dir, spec));
  return joined;
}

function isPublicEntry(file: string): boolean {
  return (
    file.endsWith('/index.ts') ||
    file === 'index.ts' ||
    file.endsWith('/main.ts') ||
    file === 'main.ts' ||
    file.endsWith('.d.ts')
  );
}

function stronglyConnectedComponents(adj: Map<string, Set<string>>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const result: string[][] = [];

  const strongconnect = (v: string): void => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      result.push(scc);
    }
  };

  for (const v of adj.keys()) {
    if (!indices.has(v)) strongconnect(v);
  }
  return result;
}
