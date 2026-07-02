import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { IFileFingerprint } from '../schema/file-fingerprint.ts';
import type { IGraphManifest } from '../schema/manifest.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';
import { fingerprintFile } from '../store/file-fingerprint.ts';
import { GraphStore } from '../store/graph-store.ts';
import { summarizeCycles } from '../query/cycle-detection.ts';
import { summarizeUnresolvedImports } from './unresolved-imports.ts';
import {
  detectWorkspacePackages,
  type IWorkspacePackage,
} from './detect-workspace.ts';
import {
  EXTRACT_TS_FILE_SOURCE,
  extractTsFile,
  stitchPerFileReferences,
  type IExtractedFile,
} from './extract-ts-file.ts';
import { extractPythonFile } from './extract-python-file.ts';
import { extractGoFile } from './extract-go-file.ts';
import { extractJavaFile } from './extract-java-file.ts';
import { extractRustFile } from './extract-rust-file.ts';
import { extractKotlinFile } from './extract-kotlin-file.ts';
import { extractRubyFile } from './extract-ruby-file.ts';
import { extractCsharpFile } from './extract-csharp-file.ts';
import { extractElixirFile } from './extract-elixir-file.ts';
import { extractPhpFile } from './extract-php-file.ts';
import { extractDartFile } from './extract-dart-file.ts';
import { extractSwiftFile } from './extract-swift-file.ts';
import {
  createImportResolverContext,
  ImportResolution,
  resolveImport,
  type IImportResolverContext,
} from './resolve-imports.ts';
import { resolveReExportedReferenceEdges } from './resolve-reexports.ts';

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  // Web component formats — parsed by framework-scanners; the TS-AST
  // extractor short-circuits on these.
  '.vue', '.svelte', '.astro',
  // Non-TS languages — handled by the per-language dispatcher.
  '.py', '.go', '.java', '.rs', '.kt', '.kts', '.rb', '.cs', '.csx', '.ex', '.exs', '.php',
  '.dart', '.swift',
  // Schema-definition formats — File nodes only; framework-scanners
  // does the SDL parsing.
  '.graphql', '.gql',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.sharkcraft',
  '.next',
  '.cache',
  '.tmp-pack',
  'out',
  'target',
]);

export interface IIndexBuilderOptions {
  projectRoot: string;
  /** Override the ignore set. Adds to defaults; does not replace them. */
  extraIgnore?: readonly string[];
  /** Cap the number of files indexed. Useful for tests; 0 = unlimited. */
  maxFiles?: number;
}

export interface IFullIndexResult {
  manifest: IGraphManifest;
  durationMs: number;
}

/**
 * Build a full graph index and write it to disk. Overwrites any
 * pre-existing store under `<root>/.sharkcraft/graph/`.
 *
 * Single-process, no worker pool yet. The compiler-API per-file extractor
 * is fast enough at SharkCraft's size; worker-pool parallelism is a
 * later optimisation tied to measured budgets (see code-intelligence.md
 * §7).
 */
export function buildFullIndex(options: IIndexBuilderOptions): IFullIndexResult {
  const start = Date.now();
  const { projectRoot } = options;
  const ignore = new Set([...SKIP_DIRS, ...(options.extraIgnore ?? [])]);

  const sourceFiles = walkSources(projectRoot, ignore, options.maxFiles ?? 0);

  const workspaces = detectWorkspacePackages(projectRoot);
  const resolverCtx = createImportResolverContext(projectRoot, workspaces);

  const nodes: INode[] = [];
  const edges: IEdge[] = [];
  const fingerprints: IFileFingerprint[] = [];
  const packageNodes = buildPackageNodes(workspaces);
  for (const n of packageNodes) nodes.push(n);

  const fileIdByPath = new Map<string, string>();
  const packageDirIndex = buildPackageDirIndex(workspaces);

  // Track per-file extracted + resolved imports so the stitcher pass
  // can emit references-symbol / calls-symbol edges with cross-file
  // targets resolved.
  const extractedByPath = new Map<string, IExtractedFile>();
  const resolvedSpecByPath = new Map<string, Map<string, string | undefined>>();
  const defaultExportNameByPath = new Map<string, string | undefined>();

  for (const abs of sourceFiles) {
    const fp = fingerprintFile(abs, projectRoot);
    fingerprints.push(fp);
    fileIdByPath.set(fp.path, fp.nodeId);

    const extracted =
      fp.language === 'python' ? extractPythonFile(fp, abs)
      : fp.language === 'go' ? extractGoFile(fp, abs)
      : fp.language === 'java' ? extractJavaFile(fp, abs)
      : fp.language === 'rust' ? extractRustFile(fp, abs)
      : fp.language === 'kotlin' ? extractKotlinFile(fp, abs)
      : fp.language === 'ruby' ? extractRubyFile(fp, abs)
      : fp.language === 'csharp' ? extractCsharpFile(fp, abs)
      : fp.language === 'elixir' ? extractElixirFile(fp, abs)
      : fp.language === 'php' ? extractPhpFile(fp, abs)
      : fp.language === 'dart' ? extractDartFile(fp, abs)
      : fp.language === 'swift' ? extractSwiftFile(fp, abs)
      : extractTsFile(fp, abs);
    nodes.push(extracted.fileNode);
    for (const sym of extracted.symbolNodes) nodes.push(sym);
    for (const e of extracted.edges) edges.push(e);

    extractedByPath.set(fp.path, extracted);
    defaultExportNameByPath.set(
      fp.path,
      (extracted.fileNode.data?.['defaultExportName'] as string | undefined) ?? undefined,
    );

    // BelongsToPackage edge for files inside a known package dir.
    const pkg = findOwningPackage(fp.path, packageDirIndex);
    if (pkg) {
      edges.push(
        buildEdge(fp.nodeId, `package:${pkg.name}`, EdgeKind.BelongsToPackage, EXTRACT_TS_FILE_SOURCE),
      );
    }

    // ImportsFile edges (resolved where possible).
    const resolvedSpec = new Map<string, string | undefined>();
    for (const raw of extracted.rawImportSpecifiers) {
      const r = resolveImport(raw.specifier, abs, resolverCtx);
      resolvedSpec.set(raw.specifier, r.targetPath);
      const data = {
        specifier: r.specifier,
        line: raw.line,
        importKind: raw.kind,
        resolutionKind: r.kind,
        // Tag type-only imports so the default cycle detector can exclude edges
        // that are erased at emit time (see extract-ts-file `isTypeOnly`).
        typeOnly: raw.isTypeOnly === true,
      } as Record<string, unknown>;
      if (r.targetPath) {
        const targetId = `file:${r.targetPath}`;
        edges.push(buildEdge(fp.nodeId, targetId, EdgeKind.ImportsFile, EXTRACT_TS_FILE_SOURCE, data));
      } else {
        const externalId =
          r.kind === ImportResolution.External
            ? `external:${r.specifier}`
            : r.kind === ImportResolution.Asset
              ? `asset:${r.specifier}`
              : `unresolved:${r.specifier}`;
        edges.push(buildEdge(fp.nodeId, externalId, EdgeKind.ImportsFile, EXTRACT_TS_FILE_SOURCE, data));
      }
    }
    resolvedSpecByPath.set(fp.path, resolvedSpec);
  }

  // Stitch references / calls edges now that bindings + targets are all
  // collected. Loops over the same files; cheap.
  for (const [path, extracted] of extractedByPath) {
    const localNames = new Map<string, string>();
    for (const sym of extracted.symbolNodes) localNames.set(sym.label, sym.id);
    const refEdges = stitchPerFileReferences({
      fileNodeId: extracted.fileNode.id,
      extracted,
      resolvedSpec: resolvedSpecByPath.get(path) ?? new Map(),
      defaultExportNameByPath,
      localSymbolNamesInThisFile: localNames,
    });
    for (const e of refEdges) edges.push(e);
  }

  // Resolve barrel re-export chains so reference/call edges that point at a
  // phantom `symbol:<barrel>#name` are rewritten to the real declaring
  // symbol — otherwise cross-package consumers (which import from a package
  // barrel) never show up in `graph callers` / impact.
  const resolvedEdges = resolveReExportedReferenceEdges(nodes, edges);

  // PackageDependsOn aggregates: collapse internal ImportsFile edges to
  // their owning package on both sides.
  collectPackageDependsOn(resolvedEdges, packageDirIndex);

  // Drop duplicate edges (extractor may emit identical edges for `export
  // { foo } from './foo'` and an `import` re-using the same line — same
  // hashed id; a re-export rewrite can also collide ids). For ImportsFile
  // edges, a VALUE import between the same two files wins over a type-only one:
  // if any occurrence of A→B is a value import, the merged edge is a real
  // runtime dependency (not type-only), so it counts toward cycles.
  const valueImportEdgeIds = new Set<string>();
  for (const e of resolvedEdges) {
    if (e.kind === EdgeKind.ImportsFile && e.data?.['typeOnly'] !== true) {
      valueImportEdgeIds.add(e.id);
    }
  }
  const seen = new Set<string>();
  const dedupedEdges: IEdge[] = [];
  for (const e of resolvedEdges) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.kind === EdgeKind.ImportsFile) {
      const typeOnly = !valueImportEdgeIds.has(e.id);
      dedupedEdges.push({ ...e, data: { ...(e.data ?? {}), typeOnly } });
    } else {
      dedupedEdges.push(e);
    }
  }

  const store = new GraphStore(projectRoot);
  const cycles = summarizeCycles(nodes, dedupedEdges);
  const unresolved = summarizeUnresolvedImports(dedupedEdges);
  const manifest = store.writeSnapshot(nodes, dedupedEdges, fingerprints, {
    projectRoot,
    lastIndexedAt: new Date().toISOString(),
    lastIndexDurationMs: Date.now() - start,
    filesIndexed: fingerprints.length,
    workspacePackages: workspaces.map((w) => w.name),
    // nodesByKind / edgesByKind are filled in by the store.
    nodesByKind: {},
    edgesByKind: {},
    cycleCount: cycles.cycleCount,
    largestCycleSize: cycles.largestCycleSize,
    filesInCycles: cycles.filesInCycles,
    typeOnlyLoopCount: cycles.typeOnlyLoopCount,
    unresolvedImportCount: unresolved.unresolvedImportCount,
    filesWithUnresolvedImports: unresolved.filesWithUnresolvedImports,
    unresolvedImportSamples: unresolved.unresolvedImportSamples,
  });

  return { manifest, durationMs: Date.now() - start };
}

function walkSources(
  projectRoot: string,
  ignore: ReadonlySet<string>,
  maxFiles: number,
): readonly string[] {
  const out: string[] = [];
  const stack: string[] = [projectRoot];
  while (stack.length > 0) {
    if (maxFiles > 0 && out.length >= maxFiles) break;
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (ignore.has(name)) continue;
      if (name.startsWith('.') && name !== '.') continue;
      const full = nodePath.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!SOURCE_EXTS.has(nodePath.extname(full).toLowerCase())) continue;
      out.push(full);
      if (maxFiles > 0 && out.length >= maxFiles) break;
    }
  }
  return out.sort();
}

function buildPackageNodes(packages: readonly IWorkspacePackage[]): readonly INode[] {
  return packages.map((p) => ({
    id: `package:${p.name}`,
    kind: NodeKind.Package,
    label: p.name,
    path: p.dir,
    data: {
      ...(p.entry ? { entry: p.entry } : {}),
    },
  }));
}

interface IPackageDirIndex {
  readonly entries: ReadonlyArray<{ dir: string; name: string }>;
}

function buildPackageDirIndex(packages: readonly IWorkspacePackage[]): IPackageDirIndex {
  // Sorted by length desc so the most-specific match wins (e.g.
  // `packages/foo/sub` resolves before `packages/foo`).
  const entries = [...packages]
    .map((p) => ({ dir: p.dir.replace(/\/+$/, ''), name: p.name }))
    .sort((a, b) => b.dir.length - a.dir.length);
  return { entries };
}

function findOwningPackage(
  filePath: string,
  index: IPackageDirIndex,
): { name: string; dir: string } | undefined {
  for (const e of index.entries) {
    if (filePath === e.dir || filePath.startsWith(e.dir + '/')) {
      return e;
    }
  }
  return undefined;
}

function collectPackageDependsOn(
  edges: IEdge[],
  index: IPackageDirIndex,
): void {
  const pairs = new Map<string, { from: string; to: string; count: number }>();
  for (const e of edges) {
    if (e.kind !== EdgeKind.ImportsFile) continue;
    const fromFile = stripPrefix(e.from, 'file:');
    const toFile = stripPrefix(e.to, 'file:');
    if (!fromFile || !toFile) continue; // skip external / unresolved targets
    const fromPkg = findOwningPackage(fromFile, index);
    const toPkg = findOwningPackage(toFile, index);
    if (!fromPkg || !toPkg) continue;
    if (fromPkg.name === toPkg.name) continue;
    const k = `${fromPkg.name}|${toPkg.name}`;
    const cur = pairs.get(k);
    if (cur) cur.count += 1;
    else pairs.set(k, { from: fromPkg.name, to: toPkg.name, count: 1 });
  }
  for (const { from, to, count } of pairs.values()) {
    edges.push(
      buildEdge(
        `package:${from}`,
        `package:${to}`,
        EdgeKind.PackageDependsOn,
        'index-builder@v1',
        { count },
      ),
    );
  }
}

function buildEdge(
  from: string,
  to: string,
  kind: EdgeKind,
  source: string,
  data?: Readonly<Record<string, unknown>>,
): IEdge {
  return {
    id: createHash('sha1').update(`${from}|${to}|${kind}`).digest('hex'),
    from,
    to,
    kind,
    source,
    ...(data ? { data } : {}),
  };
}

function stripPrefix(id: string, prefix: string): string | undefined {
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}
