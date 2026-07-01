import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { runGitLines } from '@shrkcrft/shared';
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

    reExtractFile({
      newFp,
      abs,
      nodes,
      edges,
      files,
      resolverCtx,
      packageDirIndex,
      reExtracted,
    });
    updated.push(newFp.path);
  }

  // Re-stitch referrer files. `removeFileFromGraph` is outbound-only, so every
  // inbound caller/reference/heritage edge that targets a symbol in a file we
  // just re-extracted or deleted still sits in `edges`, owned by — and pointing
  // out of — an unchanged referrer file. Those edges now reference a symbol
  // table that may have changed (a renamed/removed symbol). Force-re-extract
  // each distinct referrer so its reference edges are rebuilt against the new
  // table: the edge is recreated when the symbol still exists and dropped when
  // it was renamed/removed (symbol ids are stable: `symbol:<path>#<name>`).
  // Without this, `graph callers X` is silently wrong after editing X.
  const actuallyChanged = new Set<string>([...updated, ...deleted]);
  if (actuallyChanged.size > 0) {
    for (const rel of collectReferrerFiles(edges, actuallyChanged)) {
      if (actuallyChanged.has(rel) || reExtracted.has(rel)) continue;
      const abs = nodePath.resolve(projectRoot, rel);
      if (!existsSync(abs) || !isFile(abs)) continue;
      if (!SOURCE_EXTS.has(nodePath.extname(rel).toLowerCase())) continue;
      const newFp = fingerprintFile(abs, projectRoot);
      // Intentionally NOT pushed to `updated`: a referrer is an internal
      // re-stitch, not one of the caller's reported `changedFiles`.
      reExtractFile({
        newFp,
        abs,
        nodes,
        edges,
        files,
        resolverCtx,
        packageDirIndex,
        reExtracted,
      });
    }
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
  // Shell-free + high-maxBuffer: a large changeset no longer ENOBUFS-crashes
  // the incremental graph update. Failure → [] (caller falls back to a full scan).
  return runGitLines(projectRoot, ['diff', '--name-only', ref]).lines;
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
  // Drop only the edges this file OWNS — its OUTBOUND contribution, i.e. edges
  // whose `from` is the file node or one of its symbols (imports-file,
  // declares-symbol, belongs-to-package, and the file's own
  // calls/references/extends/implements edges).
  //
  // INBOUND edges (`e.to` is this file or one of its symbols — another file
  // calling/referencing/extending a symbol declared here, or importing this
  // file) are owned by those OTHER files and must NOT be dropped here. Deleting
  // them was the GR1 bug: re-indexing a declaring file silently removed every
  // inbound caller/reference/heritage edge from unchanged referrer files, so
  // `graph callers X` returned nothing right after editing X. Those inbound
  // edges are instead refreshed by re-extracting the referrer files (see
  // collectReferrerFiles in updateChanged), which rebuilds them against the new
  // symbol table — recreating an edge when the symbol still exists and dropping
  // it when the symbol was renamed/removed.
  for (const id of [...edges.keys()]) {
    const e = edges.get(id)!;
    if (e.from === fileId || e.from.startsWith(symbolPrefix)) {
      edges.delete(id);
    }
  }
}

/**
 * Re-extract a single file into the in-memory graph: drop its previous
 * (outbound) contribution, then re-add its file node, symbol nodes,
 * declares/re-export edges, belongs-to-package edge, and imports-file edges,
 * and record the extracted result + resolved import map so the post-pass can
 * stitch its reference / call / heritage edges. Shared by the changed-file
 * loop and the referrer re-stitch loop.
 */
function reExtractFile(args: {
  newFp: IFileFingerprint;
  abs: string;
  nodes: Map<string, INode>;
  edges: Map<string, IEdge>;
  files: Map<string, IFileFingerprint>;
  resolverCtx: ReturnType<typeof createImportResolverContext>;
  packageDirIndex: IPackageDirIndex;
  reExtracted: Map<
    string,
    { extracted: IExtractedFile; resolvedSpec: Map<string, string | undefined> }
  >;
}): void {
  const { newFp, abs, nodes, edges, files, resolverCtx, packageDirIndex, reExtracted } = args;

  // Remove the file's previous (outbound) contribution before re-adding.
  if (files.has(newFp.path)) removeFileFromGraph(newFp.path, nodes, edges, files);

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
}

/**
 * The set of "referrer files": every distinct file that owns an outbound
 * calls / references / extends / implements edge whose target is a symbol
 * declared in one of `changedOrDeleted`. For caller/reference edges the owner
 * is `e.from = file:<path>`; for heritage edges it is `e.from = symbol:<path>#<sub>`.
 * Sorted for deterministic processing.
 */
function collectReferrerFiles(
  edges: ReadonlyMap<string, IEdge>,
  changedOrDeleted: ReadonlySet<string>,
): readonly string[] {
  const referrers = new Set<string>();
  for (const e of edges.values()) {
    if (
      e.kind !== EdgeKind.CallsSymbol &&
      e.kind !== EdgeKind.ReferencesSymbol &&
      e.kind !== EdgeKind.ExtendsSymbol &&
      e.kind !== EdgeKind.ImplementsSymbol
    ) {
      continue;
    }
    const targetPath = symbolOwnerPath(e.to);
    if (!targetPath || !changedOrDeleted.has(targetPath)) continue;
    const fromPath = e.from.startsWith('file:')
      ? e.from.slice('file:'.length)
      : symbolOwnerPath(e.from);
    if (fromPath) referrers.add(fromPath);
  }
  return [...referrers].sort((a, b) => a.localeCompare(b));
}

/** Declaring file path of a `symbol:<path>#<name>` id (undefined otherwise). */
function symbolOwnerPath(id: string): string | undefined {
  if (!id.startsWith('symbol:')) return undefined;
  const rest = id.slice('symbol:'.length);
  const hash = rest.indexOf('#');
  return hash === -1 ? undefined : rest.slice(0, hash);
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
