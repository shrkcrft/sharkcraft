import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { execSync } from 'node:child_process';
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
import { resolveReExportedReferenceEdges } from './resolve-reexports.ts';
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
} from './resolve-imports.ts';

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.vue', '.svelte', '.astro', '.py', '.go', '.java', '.rs', '.kt', '.kts',
  '.rb', '.cs', '.csx', '.ex', '.exs', '.php', '.dart', '.swift',
  '.graphql', '.gql',
]);

export interface IIncrementalUpdateOptions {
  projectRoot: string;
  /** Project-relative file paths (POSIX). */
  changedFiles?: readonly string[];
  /** Project-relative file paths (POSIX). */
  deletedFiles?: readonly string[];
}

export interface IIncrementalUpdateResult {
  manifest: IGraphManifest;
  durationMs: number;
  /** Files actually re-extracted (skipped == fingerprint unchanged). */
  updated: readonly string[];
  /** Files removed from the index. */
  deleted: readonly string[];
  /** Files marked as changed but whose fingerprint matched (no-op). */
  skipped: readonly string[];
}

/**
 * Apply a delta to the on-disk index.
 *
 * Strategy (MVP): load the snapshot, mutate in memory, rewrite the full
 * store. Cheap for SharkCraft-sized indexes (a few MB on disk). Per-kind
 * append/compact is the optimisation when the cold-rewrite cost is felt.
 */
export function updateChanged(
  options: IIncrementalUpdateOptions,
): IIncrementalUpdateResult {
  const start = Date.now();
  const { projectRoot } = options;
  const store = new GraphStore(projectRoot);
  if (!store.exists()) {
    throw new Error(
      `code-graph store missing under ${store.storeDir}. Run 'shrk graph index' first.`,
    );
  }
  const snap = store.loadSnapshot();
  const nodes = new Map(snap.nodes);
  const edges = new Map(snap.edges);
  const files = new Map(snap.files);

  const workspaces = detectWorkspacePackages(projectRoot);
  const resolverCtx = createImportResolverContext(projectRoot, workspaces);
  const packageDirIndex = buildPackageDirIndex(workspaces);

  // Make sure the package nodes match the current workspace state. Adds
  // new packages; doesn't drop existing ones (rare to lose a package
  // mid-session).
  for (const p of workspaces) {
    const id = `package:${p.name}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: NodeKind.Package,
        label: p.name,
        path: p.dir,
        ...(p.entry ? { data: { entry: p.entry } } : {}),
      });
    }
  }

  const deleted: string[] = [];
  for (const rel of options.deletedFiles ?? []) {
    const fileId = `file:${rel}`;
    if (!nodes.has(fileId)) continue;
    removeFileFromGraph(rel, nodes, edges, files);
    deleted.push(rel);
  }

  const updated: string[] = [];
  const skipped: string[] = [];

  // For each file we actually re-extract, retain extracted + resolved
  // spec so the stitcher pass can produce reference / call edges.
  const reExtracted = new Map<
    string,
    { extracted: IExtractedFile; resolvedSpec: Map<string, string | undefined> }
  >();

  for (const rel of options.changedFiles ?? []) {
    const abs = nodePath.resolve(projectRoot, rel);
    if (!existsSync(abs) || !isFile(abs)) {
      // Treat as deletion if the file no longer exists.
      if (nodes.has(`file:${rel}`)) {
        removeFileFromGraph(rel, nodes, edges, files);
        deleted.push(rel);
      }
      continue;
    }
    if (!SOURCE_EXTS.has(nodePath.extname(rel).toLowerCase())) continue;

    const newFp = fingerprintFile(abs, projectRoot);
    const oldFp = files.get(newFp.path);
    if (oldFp && oldFp.sha1 === newFp.sha1 && oldFp.mtime === newFp.mtime) {
      skipped.push(newFp.path);
      continue;
    }

    // Remove the file's previous contribution.
    if (oldFp) removeFileFromGraph(newFp.path, nodes, edges, files);

    // Re-extract.
    files.set(newFp.path, newFp);
    const extracted =
      newFp.language === 'python' ? extractPythonFile(newFp, abs)
      : newFp.language === 'go' ? extractGoFile(newFp, abs)
      : newFp.language === 'java' ? extractJavaFile(newFp, abs)
      : newFp.language === 'rust' ? extractRustFile(newFp, abs)
      : newFp.language === 'kotlin' ? extractKotlinFile(newFp, abs)
      : newFp.language === 'ruby' ? extractRubyFile(newFp, abs)
      : newFp.language === 'csharp' ? extractCsharpFile(newFp, abs)
      : newFp.language === 'elixir' ? extractElixirFile(newFp, abs)
      : newFp.language === 'php' ? extractPhpFile(newFp, abs)
      : newFp.language === 'dart' ? extractDartFile(newFp, abs)
      : newFp.language === 'swift' ? extractSwiftFile(newFp, abs)
      : extractTsFile(newFp, abs);
    nodes.set(extracted.fileNode.id, extracted.fileNode);
    for (const sym of extracted.symbolNodes) nodes.set(sym.id, sym);
    for (const e of extracted.edges) edges.set(e.id, e);

    const pkg = findOwningPackage(newFp.path, packageDirIndex);
    if (pkg) {
      const e = buildEdge(
        newFp.nodeId,
        `package:${pkg.name}`,
        EdgeKind.BelongsToPackage,
        EXTRACT_TS_FILE_SOURCE,
      );
      edges.set(e.id, e);
    }

    const resolvedSpec = new Map<string, string | undefined>();
    for (const raw of extracted.rawImportSpecifiers) {
      const r = resolveImport(raw.specifier, abs, resolverCtx);
      resolvedSpec.set(raw.specifier, r.targetPath);
      const data = {
        specifier: r.specifier,
        line: raw.line,
        importKind: raw.kind,
        resolutionKind: r.kind,
      } as Record<string, unknown>;
      const targetId = r.targetPath
        ? `file:${r.targetPath}`
        : r.kind === ImportResolution.External
          ? `external:${r.specifier}`
          : `unresolved:${r.specifier}`;
      const e = buildEdge(
        newFp.nodeId,
        targetId,
        EdgeKind.ImportsFile,
        EXTRACT_TS_FILE_SOURCE,
        data,
      );
      edges.set(e.id, e);
    }
    reExtracted.set(newFp.path, { extracted, resolvedSpec });
    updated.push(newFp.path);
  }

  // Stitch references / calls for re-extracted files. Build the default
  // export name map from the current node table (covers both
  // re-extracted and untouched files).
  if (reExtracted.size > 0) {
    const defaultExportNameByPath = new Map<string, string | undefined>();
    for (const n of nodes.values()) {
      if (n.kind !== NodeKind.File || !n.path) continue;
      defaultExportNameByPath.set(
        n.path,
        (n.data?.['defaultExportName'] as string | undefined) ?? undefined,
      );
    }
    for (const [path, { extracted, resolvedSpec }] of reExtracted) {
      const localNames = new Map<string, string>();
      for (const sym of extracted.symbolNodes) localNames.set(sym.label, sym.id);
      const refEdges = stitchPerFileReferences({
        fileNodeId: extracted.fileNode.id,
        extracted,
        resolvedSpec,
        defaultExportNameByPath,
        localSymbolNamesInThisFile: localNames,
      });
      for (const e of refEdges) edges.set(e.id, e);
    }
  }

  // Rebuild package-depends-on aggregates from the (now-updated)
  // imports-file edges. Drop the old ones first.
  for (const id of [...edges.keys()]) {
    const e = edges.get(id)!;
    if (e.kind === EdgeKind.PackageDependsOn) edges.delete(id);
  }
  for (const e of collectPackageDependsOn([...edges.values()], packageDirIndex)) {
    edges.set(e.id, e);
  }

  const nodeList = [...nodes.values()];
  // Resolve barrel re-export chains (rewrites phantom cross-package
  // reference/call targets to the real symbol), then de-dupe since a rewrite
  // can collide a rewritten edge id with an existing one.
  const seenEdge = new Set<string>();
  const edgeList: IEdge[] = [];
  for (const e of resolveReExportedReferenceEdges(nodeList, [...edges.values()])) {
    if (seenEdge.has(e.id)) continue;
    seenEdge.add(e.id);
    edgeList.push(e);
  }
  const cycles = summarizeCycles(nodeList, edgeList);
  const unresolved = summarizeUnresolvedImports(edgeList);
  const manifest = store.writeSnapshot(
    nodeList,
    edgeList,
    [...files.values()],
    {
      projectRoot,
      lastIndexedAt: new Date().toISOString(),
      lastIndexDurationMs: Date.now() - start,
      filesIndexed: files.size,
      workspacePackages: workspaces.map((w) => w.name),
      nodesByKind: {},
      edgesByKind: {},
      cycleCount: cycles.cycleCount,
      largestCycleSize: cycles.largestCycleSize,
      filesInCycles: cycles.filesInCycles,
      unresolvedImportCount: unresolved.unresolvedImportCount,
      filesWithUnresolvedImports: unresolved.filesWithUnresolvedImports,
      unresolvedImportSamples: unresolved.unresolvedImportSamples,
    },
  );

  return {
    manifest,
    durationMs: Date.now() - start,
    updated,
    deleted,
    skipped,
  };
}

export interface IGraphFreshness {
  hasIndex: boolean;
  lastIndexedAt?: string;
  /** Indexed files whose on-disk content changed since the index was built. */
  modified: readonly string[];
  /** Source files on disk that are not in the index yet. */
  added: readonly string[];
  /** Indexed files that no longer exist on disk. */
  deleted: readonly string[];
}

/**
 * Walk the project and categorise every source file against the stored
 * snapshot: `modified` (indexed but content changed), `added` (on disk, not
 * indexed), `deleted` (indexed, gone from disk). This is the per-file truth
 * behind honest `graph status` freshness and the targeted per-query staleness
 * check — so an agent never gets a silently-stale answer for a file it just
 * edited. Outputs are sorted for determinism.
 */
export function detectGraphFreshness(projectRoot: string): IGraphFreshness {
  const store = new GraphStore(projectRoot);
  if (!store.exists()) {
    return { hasIndex: false, modified: [], added: [], deleted: [] };
  }
  const snap = store.loadSnapshot();
  const seen = new Set<string>();
  const modified: string[] = [];
  const added: string[] = [];
  const fsStack: string[] = [projectRoot];
  const skip = new Set([
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
  while (fsStack.length > 0) {
    const dir = fsStack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      if (name.startsWith('.') && name !== '.') continue;
      const full = nodePath.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        fsStack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!SOURCE_EXTS.has(nodePath.extname(full).toLowerCase())) continue;
      const rel = nodePath
        .relative(projectRoot, full)
        .split(nodePath.sep)
        .join('/');
      seen.add(rel);
      const oldFp = snap.files.get(rel);
      if (!oldFp) {
        added.push(rel);
        continue;
      }
      // Cheap check: mtime first. If equal, trust it (assumes mtime
      // bumps on writes — true on local FS, sometimes wrong inside
      // bind mounts). Otherwise recompute the sha and compare.
      if (Math.floor(st.mtimeMs) === oldFp.mtime && st.size === oldFp.sizeBytes) continue;
      const newFp = fingerprintFile(full, projectRoot);
      if (newFp.sha1 !== oldFp.sha1) modified.push(rel);
    }
  }
  const deleted: string[] = [];
  for (const path of snap.files.keys()) {
    if (!seen.has(path)) deleted.push(path);
  }
  modified.sort((a, b) => a.localeCompare(b));
  added.sort((a, b) => a.localeCompare(b));
  deleted.sort((a, b) => a.localeCompare(b));
  return {
    hasIndex: true,
    lastIndexedAt: snap.manifest.lastIndexedAt,
    modified,
    added,
    deleted,
  };
}

/**
 * Back-compat adapter for `shrk graph index --changed`: `changed` is the
 * union of modified + added (both need re-extraction); `deleted` unchanged.
 */
export function detectChangedAndDeleted(projectRoot: string): {
  changed: readonly string[];
  deleted: readonly string[];
} {
  const f = detectGraphFreshness(projectRoot);
  return {
    changed: [...f.modified, ...f.added].sort((a, b) => a.localeCompare(b)),
    deleted: f.deleted,
  };
}

/**
 * Get the list of files changed since a git ref (e.g. `main`, `HEAD~5`,
 * a tag). Returns project-relative POSIX paths. Errors → empty list.
 */
export function changedFilesSince(projectRoot: string, ref: string): readonly string[] {
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

// ── helpers ───────────────────────────────────────────────────────────

function removeFileFromGraph(
  rel: string,
  nodes: Map<string, INode>,
  edges: Map<string, IEdge>,
  files: Map<string, IFileFingerprint>,
): void {
  const fileId = `file:${rel}`;
  const symbolPrefix = `symbol:${rel}#`;
  files.delete(rel);
  // Drop the file node + all symbol nodes declared in this file.
  for (const id of [...nodes.keys()]) {
    if (id === fileId || id.startsWith(symbolPrefix)) {
      nodes.delete(id);
    }
  }
  // Drop every edge that touches this file or any of its symbols.
  for (const id of [...edges.keys()]) {
    const e = edges.get(id)!;
    if (
      e.from === fileId ||
      e.to === fileId ||
      e.from.startsWith(symbolPrefix) ||
      e.to.startsWith(symbolPrefix)
    ) {
      edges.delete(id);
    }
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

interface IPackageDirIndex {
  readonly entries: ReadonlyArray<{ dir: string; name: string }>;
}

function buildPackageDirIndex(packages: readonly IWorkspacePackage[]): IPackageDirIndex {
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
    if (filePath === e.dir || filePath.startsWith(e.dir + '/')) return e;
  }
  return undefined;
}

function collectPackageDependsOn(
  allEdges: readonly IEdge[],
  index: IPackageDirIndex,
): readonly IEdge[] {
  const pairs = new Map<string, { from: string; to: string; count: number }>();
  for (const e of allEdges) {
    if (e.kind !== EdgeKind.ImportsFile) continue;
    const fromFile = stripPrefix(e.from, 'file:');
    const toFile = stripPrefix(e.to, 'file:');
    if (!fromFile || !toFile) continue;
    const fromPkg = findOwningPackage(fromFile, index);
    const toPkg = findOwningPackage(toFile, index);
    if (!fromPkg || !toPkg) continue;
    if (fromPkg.name === toPkg.name) continue;
    const k = `${fromPkg.name}|${toPkg.name}`;
    const cur = pairs.get(k);
    if (cur) cur.count += 1;
    else pairs.set(k, { from: fromPkg.name, to: toPkg.name, count: 1 });
  }
  const out: IEdge[] = [];
  for (const { from, to, count } of pairs.values()) {
    out.push(
      buildEdge(
        `package:${from}`,
        `package:${to}`,
        EdgeKind.PackageDependsOn,
        'incremental-updater@v1',
        { count },
      ),
    );
  }
  return out;
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
