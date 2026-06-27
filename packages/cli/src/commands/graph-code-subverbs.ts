/**
 * CLI subverbs for the `@shrkcrft/graph` code-intelligence layer.
 *
 * Lives separately from `graph.command.ts` to keep the dispatch file
 * focused. The entry command imports each `run*` and routes when the
 * first positional matches the subverb name.
 */
import {
  buildFullIndex,
  changedFilesSince,
  detectChangedAndDeleted,
  detectGraphFreshness,
  EdgeKind,
  GraphQueryApi,
  GraphStore,
  hasCallGraphReferences,
  NodeKind,
  updateChanged,
} from '@shrkcrft/graph';
import type { INode } from '@shrkcrft/graph';
import { analyzeGraphImpact } from '@shrkcrft/impact-engine';
import { BridgeStore, RuleGraphQueryApi } from '@shrkcrft/rule-graph';
import { FrameworkQueryApi, FrameworkStore } from '@shrkcrft/framework-scanners';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { compactArrayToColumnar } from '@shrkcrft/compress';
import { flagBool, flagString, resolveCwd, type ParsedArgs } from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';

/**
 * Opt-in `--table`/`--compact`: columnarise each homogeneous object-array field
 * of a graph `--json` payload (compact, still valid JSON, reversible via
 * `expandColumnar` — and stacks with the round-8 derived-column pass to drop
 * id/kind/label). Off by default so the bare-array wire shape is unchanged.
 * Ships the columnar form only when it is actually smaller (net-loss guard).
 */
/** Drop refs whose file no longer exists on disk (a deleted dependent can't be
 *  affected by an edit and a deleted test shouldn't be run). */
function pruneDeletedRefs<T extends { path?: string }>(refs: readonly T[], cwd: string): T[] {
  return refs.filter(
    (r) => !r.path || existsSync(nodePath.isAbsolute(r.path) ? r.path : nodePath.join(cwd, r.path)),
  );
}

/**
 * A note when a symbol's file language has no call-graph extraction (Go,
 * Python, Java, …) — only TS/JS build the call graph — so an EMPTY caller list
 * isn't read by the agent as "nothing calls it".
 */
function callGraphLanguageNote(api: GraphQueryApi, sym: INode): string | null {
  const file = sym.path ? api.findFile(sym.path) : undefined;
  const lang = file?.data?.['language'] as string | undefined;
  if (hasCallGraphReferences(lang)) return null;
  return `Call/reference edges are extracted for TS/JS only — \`${sym.label}\` is in a ${lang} file, so its callers are not tracked here (an empty result does NOT mean nothing calls it).`;
}

function maybeColumnarize(payload: Record<string, unknown>, args: ParsedArgs): unknown {
  if (!flagBool(args, 'table') && !flagBool(args, 'compact')) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))
    ) {
      const col = compactArrayToColumnar(v);
      if (col && JSON.stringify(col).length < JSON.stringify(v).length) {
        out[k] = col;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

const STALE_HINT = `Index is missing or stale. Run 'shrk graph index' to build it.`;
const STALE_RESULT_HINT =
  'Some result files changed since the index was built — auto-refresh is on by default (you passed --no-refresh / SHRK_GRAPH_NO_REFRESH). Drop the opt-out, or run `shrk graph index --changed`, for fresh results.';

/**
 * Refresh-by-default: incrementally reindex changed/deleted files BEFORE
 * querying so an agent's just-saved edits are reflected, then print a one-line
 * `(refreshed, N files)` notice to stderr. The incremental updater is
 * sub-second on SharkCraft-sized indexes, so this removes the manual `shrk
 * graph index --changed` step that otherwise leaves every read command
 * answering from a silently-stale index — the #1 daily-friction tax.
 *
 * Opt out with `--no-refresh` or `SHRK_GRAPH_NO_REFRESH=1` (e.g. to keep a read
 * perfectly side-effect-free, or on a huge repo where the rewrite is felt).
 * `--refresh` is still accepted as a harmless explicit-on alias.
 *
 * CLI-only — it writes the gitignored `.sharkcraft` cache; MCP never calls this
 * (the read-only contract). When there is no index yet, `detectChangedAndDeleted`
 * returns nothing, so `updateChanged` (which requires an existing store) is
 * never reached. The notice goes to stderr so it never corrupts a `--json`
 * payload on stdout.
 */
function maybeRefresh(args: ParsedArgs, cwd: string): void {
  if (flagBool(args, 'no-refresh')) return;
  if ((process.env.SHRK_GRAPH_NO_REFRESH ?? '').trim().length > 0) return;
  const d = detectChangedAndDeleted(cwd);
  if (d.changed.length === 0 && d.deleted.length === 0) return;
  const result = updateChanged({ projectRoot: cwd, changedFiles: d.changed, deletedFiles: d.deleted });
  const n = result.updated.length + result.deleted.length;
  if (n > 0) process.stderr.write(`(refreshed, ${n} file${n === 1 ? '' : 's'})\n`);
}

interface IResultStaleness {
  deletedSet: ReadonlySet<string>;
  modified: readonly string[];
  deleted: readonly string[];
  /** A `{ stale, staleHint }` object to spread into a JSON payload, or null when fresh. */
  field: { stale: { modified: readonly string[]; deleted: readonly string[] }; staleHint: string } | null;
}

/**
 * Targeted staleness over a query's result file paths: which changed (flag)
 * and which were deleted (drop). Cheap — stats only the result files.
 */
function resultStaleness(
  api: GraphQueryApi,
  cwd: string,
  paths: ReadonlyArray<string | undefined>,
): IResultStaleness {
  const rel = paths.filter((p): p is string => !!p);
  const stale = api.staleFilesAmong(cwd, rel);
  const has = stale.modified.length > 0 || stale.deleted.length > 0;
  return {
    deletedSet: new Set(stale.deleted),
    modified: stale.modified,
    deleted: stale.deleted,
    field: has
      ? { stale: { modified: stale.modified, deleted: stale.deleted }, staleHint: STALE_RESULT_HINT }
      : null,
  };
}

/**
 * A "the index is N files behind" qualifier for a not-found / empty result, so
 * an agent doesn't read a bare "not-found" as "this symbol doesn't exist / is
 * safe to create" when the truth is "it's in a file the index hasn't seen yet."
 * Runs the full freshness walk — only call it on the rare miss path.
 */
function indexBehindHint(cwd: string): string | null {
  const f = detectGraphFreshness(cwd);
  if (!f.hasIndex) return null;
  const behind = f.modified.length + f.added.length + f.deleted.length;
  if (behind === 0) return null;
  return `Index is ${behind} file(s) behind (${f.modified.length} modified, ${f.added.length} new, ${f.deleted.length} deleted) — run \`shrk graph index --changed\` and retry.`;
}

// ─── shrk graph index ─────────────────────────────────────────────────

export async function runGraphIndex(args: ParsedArgs): Promise<number> {
  // --watch: run the index once, then re-run on file changes. Every
  // tick after the first uses the incremental updater so a 5-file edit
  // takes < 100ms. Default watch path is the project root; pass
  // `--paths a,b,c` to narrow.
  const watchExit = await maybeRunInWatchMode(
    args,
    async (inner) => {
      const innerFlags = new Map(inner.flags);
      innerFlags.set('changed', true);
      return runGraphIndexOnce({ ...inner, flags: innerFlags });
    },
    { defaultPaths: ['.'] },
  );
  if (watchExit !== null) return watchExit;
  return runGraphIndexOnce(args);
}

async function runGraphIndexOnce(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const wantChanged = flagBool(args, 'changed');
  const since = flagString(args, 'since');
  const wantFull = flagBool(args, 'full');

  // Incremental path: --changed OR --since OR no store yet but the user
  // asked for incremental — fall through to a full build in that case.
  const store = new GraphStore(cwd);
  const isIncremental = (wantChanged || since) && !wantFull;

  if (isIncremental && store.exists()) {
    let changed: readonly string[] = [];
    let deleted: readonly string[] = [];
    if (since) {
      changed = changedFilesSince(cwd, since);
    } else {
      const detected = detectChangedAndDeleted(cwd);
      changed = detected.changed;
      deleted = detected.deleted;
    }
    const result = updateChanged({ projectRoot: cwd, changedFiles: changed, deletedFiles: deleted });
    if (wantJson) {
      process.stdout.write(
        asJson({
          ok: true,
          mode: 'incremental',
          manifest: result.manifest,
          durationMs: result.durationMs,
          updated: result.updated,
          deleted: result.deleted,
          skipped: result.skipped,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Graph index (incremental)'));
    process.stdout.write(kv('updated', String(result.updated.length)) + '\n');
    process.stdout.write(kv('deleted', String(result.deleted.length)) + '\n');
    process.stdout.write(kv('skipped', String(result.skipped.length)) + '\n');
    process.stdout.write(kv('files total', String(result.manifest.filesIndexed)) + '\n');
    process.stdout.write(kv('duration', `${result.durationMs}ms`) + '\n');
    process.stdout.write(kv('digest', result.manifest.digest.slice(0, 12) + '…') + '\n');
    return 0;
  }

  // Full path.
  const result = buildFullIndex({ projectRoot: cwd });
  if (wantJson) {
    process.stdout.write(asJson({
      ok: true,
      mode: 'full',
      manifest: result.manifest,
      durationMs: result.durationMs,
    }) + '\n');
    return 0;
  }
  process.stdout.write(header('Graph index'));
  process.stdout.write(kv('files', String(result.manifest.filesIndexed)) + '\n');
  process.stdout.write(kv('nodes', String(sumValues(result.manifest.nodesByKind))) + '\n');
  process.stdout.write(kv('edges', String(sumValues(result.manifest.edgesByKind))) + '\n');
  process.stdout.write(kv('packages', String(result.manifest.workspacePackages.length)) + '\n');
  if (typeof result.manifest.cycleCount === 'number') {
    const largest =
      typeof result.manifest.largestCycleSize === 'number' && result.manifest.largestCycleSize > 0
        ? ` (largest ${result.manifest.largestCycleSize})`
        : '';
    process.stdout.write(kv('cycles', `${result.manifest.cycleCount}${largest}`) + '\n');
  }
  if (
    typeof result.manifest.unresolvedImportCount === 'number' &&
    result.manifest.unresolvedImportCount > 0
  ) {
    process.stdout.write(
      kv(
        'unresolved imports',
        `${result.manifest.unresolvedImportCount} across ${
          result.manifest.filesWithUnresolvedImports ?? 0
        } file(s)`,
      ) + '\n',
    );
  }
  process.stdout.write(kv('duration', `${result.durationMs}ms`) + '\n');
  process.stdout.write(kv('digest', result.manifest.digest.slice(0, 12) + '…') + '\n');
  return 0;
}

// ─── shrk graph cycles ────────────────────────────────────────────────

export async function runGraphCycles(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const limit = parseLimit(args);
  const minSize = parseMinSize(args);

  const store = new GraphStore(cwd);
  if (!store.exists()) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          ok: false,
          state: 'missing',
          nextCommand: 'shrk graph index',
          message: STALE_HINT,
        }) + '\n',
      );
      return 1;
    }
    process.stderr.write(STALE_HINT + '\n');
    return 1;
  }
  const api = GraphQueryApi.fromStore(cwd);
  const allCycles = api.cycles();
  const filtered = allCycles.filter((c) => c.size >= minSize);
  const limited = filtered.slice(0, limit);
  if (wantJson) {
    process.stdout.write(
      asJson({
        ok: true,
        total: filtered.length,
        truncated: filtered.length > limit,
        cycles: limited.map((c) => ({
          size: c.size,
          paths: c.paths ?? c.nodeIds.map((id) => id.replace(/^file:/, '')),
        })),
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header('Graph cycles'));
  process.stdout.write(kv('total', String(filtered.length)) + '\n');
  if (filtered.length === 0) {
    process.stdout.write('\nNo cycles in the file-import graph. ✓\n');
    return 0;
  }
  process.stdout.write(kv('shown', `${limited.length}/${filtered.length}`) + '\n');
  process.stdout.write('\n');
  for (let i = 0; i < limited.length; i += 1) {
    const c = limited[i]!;
    const paths = c.paths ?? c.nodeIds.map((id) => id.replace(/^file:/, ''));
    process.stdout.write(`#${i + 1} (size ${c.size}):\n`);
    for (const p of paths) process.stdout.write(`  ${p}\n`);
    // Closing arrow indicates the cycle wraps back to the first node.
    if (paths[0]) process.stdout.write(`  → ${paths[0]}\n`);
    if (i + 1 < limited.length) process.stdout.write('\n');
  }
  if (filtered.length > limit) {
    process.stdout.write(
      `\n(${filtered.length - limit} more — pass --limit ${filtered.length} to see all)\n`,
    );
  }
  return 0;
}

function parseLimit(args: ParsedArgs): number {
  const raw = flagString(args, 'limit');
  if (!raw) return 20;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}
function parseMinSize(args: ParsedArgs): number {
  const raw = flagString(args, 'min-size');
  if (!raw) return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 2 ? n : 2;
}

// ─── shrk graph unresolved ────────────────────────────────────────────

export async function runGraphUnresolved(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const limit = parseLimit(args);

  const store = new GraphStore(cwd);
  if (!store.exists()) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          ok: false,
          state: 'missing',
          nextCommand: 'shrk graph index',
          message: STALE_HINT,
        }) + '\n',
      );
      return 1;
    }
    process.stderr.write(STALE_HINT + '\n');
    return 1;
  }
  const snap = store.loadSnapshot();
  // Group unresolved edges by source file.
  type Group = { from: string; path?: string; specifiers: string[] };
  const groups = new Map<string, Group>();
  for (const e of snap.edges.values()) {
    if (e.kind !== EdgeKind.ImportsFile) continue;
    if (!e.to.startsWith('unresolved:')) continue;
    const fromNode = snap.nodes.get(e.from);
    const g = groups.get(e.from);
    const spec = e.to.slice('unresolved:'.length);
    if (g) {
      g.specifiers.push(spec);
    } else {
      groups.set(e.from, {
        from: e.from,
        ...(fromNode?.path ? { path: fromNode.path } : {}),
        specifiers: [spec],
      });
    }
  }
  const list = [...groups.values()].sort((a, b) => {
    if (b.specifiers.length !== a.specifiers.length) {
      return b.specifiers.length - a.specifiers.length;
    }
    return (a.path ?? a.from).localeCompare(b.path ?? b.from);
  });
  // De-dupe specifiers per file + sort, so the output is stable.
  for (const g of list) g.specifiers = [...new Set(g.specifiers)].sort();
  const total = list.reduce((n, g) => n + g.specifiers.length, 0);
  const limited = list.slice(0, limit);

  if (wantJson) {
    process.stdout.write(
      asJson({
        ok: true,
        totalEdges: total,
        totalFiles: list.length,
        truncated: list.length > limit,
        files: limited.map((g) => ({
          path: g.path ?? g.from.replace(/^file:/, ''),
          unresolved: g.specifiers,
        })),
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header('Unresolved imports'));
  process.stdout.write(kv('total edges', String(total)) + '\n');
  process.stdout.write(kv('files', String(list.length)) + '\n');
  if (list.length === 0) {
    process.stdout.write('\nNo unresolved imports. ✓\n');
    return 0;
  }
  process.stdout.write(kv('shown', `${limited.length}/${list.length}`) + '\n');
  process.stdout.write('\n');
  for (const g of limited) {
    process.stdout.write(`${g.path ?? g.from.replace(/^file:/, '')}\n`);
    for (const s of g.specifiers) {
      process.stdout.write(`  • ${s}\n`);
    }
  }
  if (list.length > limit) {
    process.stdout.write(
      `\n(${list.length - limit} more — pass --limit ${list.length} to see all)\n`,
    );
  }
  return 0;
}

// ─── shrk graph deps ──────────────────────────────────────────────────

export async function runGraphDeps(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const pkg = args.positional[0];
  if (!pkg) {
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: 'missing-package' }) + '\n');
      return 2;
    }
    process.stderr.write('Usage: shrk graph deps <package-name> [--json]\n');
    return 2;
  }
  const store = new GraphStore(cwd);
  if (!store.exists()) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          ok: false,
          state: 'missing',
          nextCommand: 'shrk graph index',
          message: STALE_HINT,
        }) + '\n',
      );
      return 1;
    }
    process.stderr.write(STALE_HINT + '\n');
    return 1;
  }
  const api = GraphQueryApi.fromStore(cwd);
  const pkgId = `package:${pkg}`;
  // Existence guard (mirrors the MCP tool): without it, an unknown package
  // name returns a confidently-wrong empty `dependsOn/dependedOnBy` that reads
  // as "this package has no edges" rather than "this package isn't here".
  if (!api.neighbours(pkgId)?.node) {
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: 'not-found', package: pkg }) + '\n');
      return 1;
    }
    process.stderr.write(`No workspace package "${pkg}" in the graph.\n`);
    return 1;
  }
  // outbound: packages this one depends on
  const outbound = api.packageDeps(pkg).map((n) => n.id.replace(/^package:/, ''));
  // inbound: packages that depend on this one
  const inbound: string[] = [];
  for (const p of api.allPackages()) {
    const name = p.id.replace(/^package:/, '');
    if (name === pkg) continue;
    if (api.packageDeps(name).some((n) => n.id === pkgId)) inbound.push(name);
  }
  outbound.sort();
  inbound.sort();
  if (wantJson) {
    process.stdout.write(
      asJson({
        ok: true,
        package: pkg,
        dependsOn: outbound,
        dependedOnBy: inbound,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header(`Package deps: ${pkg}`));
  process.stdout.write(kv('depends on', String(outbound.length)) + '\n');
  process.stdout.write(kv('depended on by', String(inbound.length)) + '\n');
  if (outbound.length > 0) {
    process.stdout.write('\nDepends on:\n');
    for (const n of outbound) process.stdout.write(`  → ${n}\n`);
  }
  if (inbound.length > 0) {
    process.stdout.write('\nDepended on by:\n');
    for (const n of inbound) process.stdout.write(`  ← ${n}\n`);
  }
  if (outbound.length === 0 && inbound.length === 0) {
    process.stdout.write('\n(no workspace-internal edges)\n');
  }
  return 0;
}

// ─── shrk graph status ────────────────────────────────────────────────

export async function runGraphStatus(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const store = new GraphStore(cwd);
  if (!store.exists()) {
    const payload = {
      ok: false,
      state: 'missing' as const,
      nextCommand: 'shrk graph index',
      message: STALE_HINT,
    };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(STALE_HINT + '\n');
    return 1;
  }
  const verify = store.verifyDigest();
  const snap = store.loadSnapshot();
  const manifestNodeCount = sumValues(snap.manifest.nodesByKind);
  const manifestEdgeCount = sumValues(snap.manifest.edgesByKind);
  // Honest freshness vs the working tree. `corrupt` (store self-integrity) and
  // `stale` (disk drift) are orthogonal — a store can be digest-valid yet
  // stale — so precedence is corrupt > stale > fresh.
  const fresh = detectGraphFreshness(cwd);
  const behind = fresh.modified.length + fresh.added.length + fresh.deleted.length;
  const state = !verify.ok ? ('corrupt' as const) : behind > 0 ? ('stale' as const) : ('fresh' as const);
  const payload = {
    ok: verify.ok,
    state,
    schema: snap.manifest.schema,
    fileCount: snap.manifest.filesIndexed,
    nodeCount: manifestNodeCount,
    edgeCount: manifestEdgeCount,
    lastIndexedAt: snap.manifest.lastIndexedAt,
    lastIndexDurationMs: snap.manifest.lastIndexDurationMs,
    workspacePackages: snap.manifest.workspacePackages,
    cycleCount: snap.manifest.cycleCount ?? null,
    largestCycleSize: snap.manifest.largestCycleSize ?? null,
    filesInCycles: snap.manifest.filesInCycles ?? null,
    unresolvedImportCount: snap.manifest.unresolvedImportCount ?? null,
    filesWithUnresolvedImports: snap.manifest.filesWithUnresolvedImports ?? null,
    unresolvedImportSamples: snap.manifest.unresolvedImportSamples ?? null,
    digest: verify.ok ? snap.manifest.digest : { expected: verify.expected, actual: verify.actual },
    modifiedSinceIndex: fresh.modified.length,
    newSinceIndex: fresh.added.length,
    deletedSinceIndex: fresh.deleted.length,
    ...(behind > 0 ? { nextCommand: 'shrk graph index --changed' } : {}),
  };
  if (wantJson) {
    process.stdout.write(asJson(payload) + '\n');
    return verify.ok ? 0 : 1;
  }
  process.stdout.write(header('Graph status'));
  process.stdout.write(kv('schema', payload.schema) + '\n');
  process.stdout.write(kv('files', String(payload.fileCount)) + '\n');
  process.stdout.write(kv('nodes', String(payload.nodeCount)) + '\n');
  process.stdout.write(kv('edges', String(payload.edgeCount)) + '\n');
  process.stdout.write(kv('packages', String(payload.workspacePackages.length)) + '\n');
  if (typeof payload.cycleCount === 'number') {
    const largest = payload.largestCycleSize ? ` (largest ${payload.largestCycleSize})` : '';
    process.stdout.write(kv('cycles', `${payload.cycleCount}${largest}`) + '\n');
  }
  if (typeof payload.unresolvedImportCount === 'number' && payload.unresolvedImportCount > 0) {
    process.stdout.write(
      kv(
        'unresolved imports',
        `${payload.unresolvedImportCount} across ${payload.filesWithUnresolvedImports ?? 0} file(s)`,
      ) + '\n',
    );
  }
  process.stdout.write(kv('last indexed', payload.lastIndexedAt) + '\n');
  process.stdout.write(kv('state', payload.state) + '\n');
  if (behind > 0) {
    process.stdout.write(
      kv(
        'drift',
        `${fresh.modified.length} modified, ${fresh.added.length} new, ${fresh.deleted.length} deleted since index — run \`shrk graph index --changed\``,
      ) + '\n',
    );
  }
  return verify.ok ? 0 : 1;
}

// ─── shrk graph search ────────────────────────────────────────────────

export async function runGraphSearch(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const query = args.positional[1];
  const hasUnresolved = flagBool(args, 'has-unresolved-imports');
  if (!query && !hasUnresolved) {
    process.stderr.write(
      'Usage: shrk graph search <query> [--kind file|symbol|package] [--limit N]\n' +
        '       shrk graph search --kind file --has-unresolved-imports [--limit N]\n',
    );
    return 2;
  }
  const kindFlag = flagString(args, 'kind') as 'file' | 'symbol' | 'package' | undefined;
  const limit = Number(flagString(args, 'limit') ?? '20');
  maybeRefresh(args, cwd);
  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;

  let matches: INode[];
  if (hasUnresolved) {
    const all = api.filesWithUnresolvedImports();
    matches = (query
      ? all.filter((n) => (n.path ?? '').toLowerCase().includes(query.toLowerCase()))
      : [...all]
    ).slice(0, limit);
  } else {
    matches = collectSearchMatches(api, query!, kindFlag, limit);
  }

  if (wantJson) {
    process.stdout.write(asJson({
      schema: 'sharkcraft.graph-search/v1',
      query,
      kind: kindFlag ?? 'any',
      total: matches.length,
      matches: matches.map(toSearchHit),
    }) + '\n');
    return 0;
  }
  const headerLabel = query ?? (hasUnresolved ? 'files with unresolved imports' : '');
  if (matches.length === 0) {
    process.stdout.write(`No matches for "${headerLabel}".\n`);
    return 0;
  }
  process.stdout.write(header(`Graph search: ${headerLabel}`));
  for (const m of matches) {
    process.stdout.write(`  ${m.kind.padEnd(8)} ${m.label}${m.path ? '  ' + m.path : ''}${m.line ? ':' + m.line : ''}\n`);
  }
  return 0;
}

// ─── shrk graph context ───────────────────────────────────────────────

export async function runGraphContext(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const target = args.positional[1];
  if (!target) {
    process.stderr.write('Usage: shrk graph context <fileOrSymbol> [--depth N] [--no-bridge] [--no-framework]\n');
    return 2;
  }
  const depth = Math.max(1, Math.min(3, Number(flagString(args, 'depth') ?? '1')));
  const includeBridge = !flagBool(args, 'no-bridge');
  const includeFramework = !flagBool(args, 'no-framework');
  maybeRefresh(args, cwd);
  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;
  const anchor = resolveAnchor(api, target);
  if (!anchor) {
    const hint = indexBehindHint(cwd);
    const payload = { ok: false, error: 'not-found', target, ...(hint ? { hint } : {}) };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(`No graph node matched "${target}".${hint ? ' ' + hint : ''}\n`);
    return 1;
  }
  const anchorFile = anchor.kind === NodeKind.File
    ? anchor
    : declaringFileOf(api, anchor.id) ?? (anchor.path ? api.findFile(anchor.path) : undefined);
  const subjectNodeId = anchorFile?.id ?? anchor.id;
  const neighbours = api.neighbours(subjectNodeId)!;
  const symbols = anchor.kind === NodeKind.File ? api.symbolsIn(anchor.id) : [];
  const references = anchor.kind === NodeKind.Symbol ? dedupeNodes(api.referencesOf(anchor.id)) : [];
  const callers = anchor.kind === NodeKind.Symbol ? dedupeNodes(api.callersOf(anchor.id)) : [];
  // Typed subtype/supertype relationships (extends / implements) — the precise
  // "who implements this interface" answer, distinct from a generic reference.
  const subtypes = anchor.kind === NodeKind.Symbol ? dedupeNodes(api.subtypesOf(anchor.id)) : [];
  const supertypes = anchor.kind === NodeKind.Symbol ? dedupeNodes(api.supertypesOf(anchor.id)) : [];

  // Optional bridge enrichment: rules / paths / templates applying to
  // the anchor file (or a symbol's containing file).
  const bridgeStore = new BridgeStore(cwd);
  const bridgeFor = (includeBridge && bridgeStore.exists() && anchorFile?.path)
    ? RuleGraphQueryApi.fromStores(cwd).forFile(anchorFile.path)
    : undefined;

  // Optional framework enrichment.
  const frameworkStore = new FrameworkStore(cwd);
  const frameworkEntities = (includeFramework && frameworkStore.exists() && anchorFile?.path)
    ? FrameworkQueryApi.fromStore(cwd).forFile(anchorFile.path)
    : [];

  const importsFromList = neighbours.out
    .filter((o) => o.edge.kind === 'imports-file')
    .slice(0, 50)
    .map((o) => ('target' in o ? targetSummary(o.target) : { id: 'unknown', resolved: false }));
  const importedByList = neighbours.in
    .filter((i) => i.edge.kind === 'imports-file')
    .slice(0, 50)
    .map((i) => ('source' in i ? sourceSummary(i.source) : { id: 'unknown', resolved: false }));
  const referencedByList = references.slice(0, 50).map(nodeSummary);
  const calledByList = callers.slice(0, 50).map(nodeSummary);
  // Staleness over the anchor + every referenced file: drop dead paths from the
  // usage lists, flag changed ones.
  const ctxPathOf = (x: { path?: string }): string | undefined => x.path;
  const fresh = resultStaleness(api, cwd, [
    anchor.path,
    ...importsFromList.map(ctxPathOf),
    ...importedByList.map(ctxPathOf),
    ...referencedByList.map(ctxPathOf),
    ...calledByList.map(ctxPathOf),
  ]);
  const ctxDropDel = <T extends { path?: string }>(rows: readonly T[]): T[] =>
    rows.filter((r) => !r.path || !fresh.deletedSet.has(r.path));
  const payload = {
    schema: 'sharkcraft.graph-context/v1',
    anchor: nodeSummary(anchor),
    declaredIn: anchor.kind === NodeKind.Symbol && anchorFile ? nodeSummary(anchorFile) : null,
    depth,
    importsFrom: ctxDropDel(importsFromList),
    importedBy: ctxDropDel(importedByList),
    symbols: symbols.slice(0, 50).map(nodeSummary),
    referencedBy: ctxDropDel(referencedByList),
    calledBy: ctxDropDel(calledByList),
    ...(subtypes.length > 0 ? { subtypes: subtypes.slice(0, 50).map(nodeSummary) } : {}),
    ...(supertypes.length > 0 ? { supertypes: supertypes.slice(0, 50).map(nodeSummary) } : {}),
    ...(fresh.field ?? {}),
    bridge: bridgeFor
      ? {
          rules: bridgeFor.rules.map((h) => ({
            id: h.target.id,
            label: h.target.label,
            severity: (h.edge.data?.['severity'] as string | undefined) ?? undefined,
          })),
          paths: bridgeFor.paths.map((h) => ({ id: h.target.id, label: h.target.label })),
          templates: bridgeFor.templates.map((h) => ({ id: h.target.id, label: h.target.label })),
        }
      : null,
    framework: frameworkEntities.length > 0
      ? {
          entities: frameworkEntities.map((n) => ({
            id: n.id,
            label: n.label,
            framework: (n.data?.['framework'] as string | undefined) ?? null,
            subtype: (n.data?.['subtype'] as string | undefined) ?? null,
          })),
        }
      : null,
  };
  if (wantJson) {
    process.stdout.write(asJson(maybeColumnarize(payload, args)) + '\n');
    return 0;
  }
  process.stdout.write(header(`Graph context: ${anchor.kind}:${anchor.label}`));
  process.stdout.write(kv('path', anchor.path ?? '(none)') + '\n');
  if (anchor.line) process.stdout.write(kv('line', String(anchor.line)) + '\n');
  if (payload.declaredIn) {
    process.stdout.write(kv('declared in', payload.declaredIn.path ?? payload.declaredIn.id) + '\n');
  }
  if (payload.symbols.length > 0) {
    process.stdout.write(`\nDeclares ${payload.symbols.length} symbols:\n`);
    for (const s of payload.symbols.slice(0, 20)) {
      process.stdout.write(`  ${s.label}${s.line ? ':' + s.line : ''}\n`);
    }
  }
  if (payload.referencedBy.length > 0) {
    process.stdout.write(`\nReferenced by (${payload.referencedBy.length}):\n`);
    for (const r of payload.referencedBy.slice(0, 20)) {
      process.stdout.write(`  ← ${r.path ?? r.id}\n`);
    }
  }
  if (payload.calledBy.length > 0) {
    process.stdout.write(`\nCalled by (${payload.calledBy.length}):\n`);
    for (const c of payload.calledBy.slice(0, 20)) {
      process.stdout.write(`  ← ${c.path ?? c.id}\n`);
    }
  }
  if (supertypes.length > 0) {
    process.stdout.write(`\nExtends / implements (${supertypes.length}):\n`);
    for (const s of supertypes.slice(0, 20)) {
      process.stdout.write(`  ▲ ${s.label}${s.path ? '  ' + s.path : ''}${s.line ? ':' + s.line : ''}\n`);
    }
  }
  if (subtypes.length > 0) {
    process.stdout.write(`\nExtended / implemented by (${subtypes.length}):\n`);
    for (const s of subtypes.slice(0, 20)) {
      process.stdout.write(`  ▼ ${s.label}${s.path ? '  ' + s.path : ''}${s.line ? ':' + s.line : ''}\n`);
    }
  }
  if (payload.importsFrom.length > 0) {
    process.stdout.write(`\nImports from (${payload.importsFrom.length}):\n`);
    for (const o of payload.importsFrom.slice(0, 20)) {
      process.stdout.write(`  → ${describeTarget(o)}\n`);
    }
  }
  if (payload.importedBy.length > 0) {
    process.stdout.write(`\nImported by (${payload.importedBy.length}):\n`);
    for (const i of payload.importedBy.slice(0, 20)) {
      process.stdout.write(`  ← ${describeTarget(i)}\n`);
    }
  }
  if (payload.bridge) {
    if (payload.bridge.rules.length > 0) {
      process.stdout.write(`\nApplies rules (${payload.bridge.rules.length}):\n`);
      for (const r of payload.bridge.rules.slice(0, 10)) {
        process.stdout.write(`  • ${r.id}${r.severity ? ` [${r.severity}]` : ''} — ${r.label}\n`);
      }
    }
    if (payload.bridge.paths.length > 0) {
      process.stdout.write(`\nPath conventions (${payload.bridge.paths.length}):\n`);
      for (const p of payload.bridge.paths.slice(0, 10)) {
        process.stdout.write(`  • ${p.id} — ${p.label}\n`);
      }
    }
    if (payload.bridge.templates.length > 0) {
      process.stdout.write(`\nCovered by templates (${payload.bridge.templates.length}):\n`);
      for (const t of payload.bridge.templates.slice(0, 10)) {
        process.stdout.write(`  • ${t.id} — ${t.label}\n`);
      }
    }
  }
  if (payload.framework && payload.framework.entities.length > 0) {
    process.stdout.write(`\nFramework entities (${payload.framework.entities.length}):\n`);
    for (const e of payload.framework.entities.slice(0, 10)) {
      process.stdout.write(`  • ${e.framework}:${e.subtype} ${e.label}\n`);
    }
  }
  if (fresh.field) {
    process.stdout.write(
      `\n  ⚠ ${fresh.modified.length} referenced file(s) changed, ${fresh.deleted.length} deleted since indexing — run \`shrk graph index --changed\`.\n`,
    );
  }
  return 0;
}

// ─── shrk graph impact ────────────────────────────────────────────────

export async function runGraphImpact(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const wantFull = flagBool(args, 'full');
  const target = args.positional[1];
  if (!target) {
    process.stderr.write(
      'Usage: shrk graph impact <fileOrSymbol> [--max-depth N] [--limit N] [--full]\n',
    );
    return 2;
  }
  const maxDepth = Math.max(1, Math.min(10, Number(flagString(args, 'max-depth') ?? '5')));
  const limit = Math.max(1, Number(flagString(args, 'limit') ?? '200'));
  maybeRefresh(args, cwd);

  // --full → delegate to the impact-engine for a richer v3 payload.
  if (wantFull) {
    const isSymbol = target.startsWith('symbol:') || /^[A-Za-z_][\w$]*$/.test(target);
    const input = isSymbol && !target.includes('/')
      ? { kind: 'symbol' as const, symbolId: target }
      : { kind: 'files' as const, files: [target] };
    const raw = analyzeGraphImpact(input, { projectRoot: cwd, limit, maxDepth });
    // Drop dependents/tests whose file was deleted on disk so a stale index
    // never tells the agent a dead file is in the blast radius or routes it to
    // run a test that no longer exists.
    const analysis = {
      ...raw,
      directDependents: pruneDeletedRefs(raw.directDependents, cwd),
      transitiveDependents: pruneDeletedRefs(raw.transitiveDependents, cwd),
      affectedCallerFiles: pruneDeletedRefs(raw.affectedCallerFiles, cwd),
      likelyTests: pruneDeletedRefs(raw.likelyTests, cwd),
    };
    // Pre-merge blast radius drives which tests an agent runs — so it must also
    // say when the index is behind the working tree (repo-level: a stale --full
    // analysis can still MISS new dependents the prune can't see).
    const behind = indexBehindHint(cwd);
    if (wantJson) {
      process.stdout.write(asJson(behind ? { ...analysis, staleHint: behind } : analysis) + '\n');
      return 0;
    }
    process.stdout.write(header(`Graph impact (full): ${target}`));
    process.stdout.write(kv('risk', analysis.risk) + '\n');
    process.stdout.write(kv('direct', String(analysis.directDependents.length)) + '\n');
    process.stdout.write(kv('transitive', String(analysis.transitiveDependents.length)) + '\n');
    process.stdout.write(kv('symbols', String(analysis.affectedSymbols.length)) + '\n');
    process.stdout.write(kv('caller files', String(analysis.affectedCallerFiles.length)) + '\n');
    process.stdout.write(kv('packages', String(analysis.affectedPackages.length)) + '\n');
    process.stdout.write(kv('rules', String(analysis.affectedRules.length)) + '\n');
    process.stdout.write(kv('templates', String(analysis.affectedTemplates.length)) + '\n');
    process.stdout.write(kv('likely tests', String(analysis.likelyTests.length)) + '\n');
    process.stdout.write(kv('public API touched', analysis.publicApiTouched ? 'yes' : 'no') + '\n');
    if (analysis.riskReasons.length > 0) {
      process.stdout.write('\nRisk reasons:\n');
      for (const r of analysis.riskReasons) process.stdout.write(`  • ${r}\n`);
    }
    if (analysis.validationScope.length > 0) {
      process.stdout.write('\nRun before merging:\n');
      for (const c of analysis.validationScope) process.stdout.write(`  $ ${c}\n`);
    }
    for (const d of analysis.diagnostics.slice(0, 5)) process.stdout.write(`! ${d}\n`);
    if (behind) process.stdout.write(`\n  ⚠ ${behind}\n`);
    return 0;
  }

  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;
  const anchor = resolveAnchor(api, target);
  if (!anchor) {
    const hint = indexBehindHint(cwd);
    const payload = { ok: false, error: 'not-found', target, ...(hint ? { hint } : {}) };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(`No graph node matched "${target}".${hint ? ' ' + hint : ''}\n`);
    return 1;
  }
  const closure = reverseClosure(api, anchor, maxDepth, limit);
  const direct = closure.layer[1] ?? [];
  const transitive = closure.all.filter((id) => id !== anchor.id && !direct.includes(id));
  const directNodes = direct.map((id) => nodeSummary(api.neighbours(id)!.node));
  const transitiveNodes = transitive.slice(0, limit).map((id) => nodeSummary(api.neighbours(id)!.node));
  // Drop dependents whose file was deleted (they can't break); flag modified.
  const fresh = resultStaleness(api, cwd, [
    anchor.path,
    ...directNodes.map((n) => n.path),
    ...transitiveNodes.map((n) => n.path),
  ]);
  const liveDirect = directNodes.filter((n) => !n.path || !fresh.deletedSet.has(n.path));
  const liveTransitive = transitiveNodes.filter((n) => !n.path || !fresh.deletedSet.has(n.path));
  const payload = {
    schema: 'sharkcraft.graph-impact/v1',
    anchor: nodeSummary(anchor),
    maxDepth,
    limit,
    truncated: closure.truncated,
    directDependents: liveDirect,
    transitiveDependents: liveTransitive,
    totalReached: closure.all.length - 1,
    ...(fresh.field ?? {}),
  };
  if (wantJson) {
    process.stdout.write(asJson(maybeColumnarize(payload, args)) + '\n');
    return 0;
  }
  process.stdout.write(header(`Graph impact: ${anchor.label}`));
  process.stdout.write(kv('direct', String(liveDirect.length)) + '\n');
  process.stdout.write(kv('transitive', String(liveTransitive.length)) + '\n');
  process.stdout.write(kv('max-depth', String(maxDepth)) + '\n');
  if (closure.truncated) process.stdout.write(kv('truncated', 'yes') + '\n');
  for (const d of liveDirect.slice(0, 30)) {
    process.stdout.write(`  ${d.path ?? d.id}\n`);
  }
  // No silent caps: when the reverse closure hit the limit, say so explicitly so
  // the reader knows the blast radius is larger than what's shown.
  if (closure.truncated) {
    process.stdout.write(
      `\n  ⓘ Showing ${liveDirect.length + liveTransitive.length} of ${payload.totalReached} dependents (capped at --limit ${limit}); raise --limit to see the full blast radius.\n`,
    );
  }
  if (fresh.field) {
    process.stdout.write(
      `\n  ⚠ ${fresh.modified.length} dependent file(s) changed, ${fresh.deleted.length} deleted since indexing — run \`shrk graph index --changed\`.\n`,
    );
  }
  return 0;
}

// ─── shrk graph hubs ──────────────────────────────────────────────────

/**
 * `shrk graph hubs` — the most-depended-on code: symbols ranked by how many
 * DISTINCT files reference them, files by how many import them. The
 * "load-bearing code" an agent should change most carefully and a human should
 * understand first — the natural companion to `graph impact` (impact = blast
 * radius of ONE node; hubs = the nodes with the biggest blast radius).
 */
export async function runGraphHubs(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const limit = Math.max(1, Math.min(100, Number(flagString(args, 'limit') ?? '15')));
  const pathScope = flagString(args, 'path');
  maybeRefresh(args, cwd);
  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;
  const hubs = api.topHubs(limit, pathScope);
  const toRow = (h: { node: INode; inDegree: number }): Record<string, unknown> => ({
    ...nodeSummary(h.node),
    inDegree: h.inDegree,
  });
  const payload = {
    schema: 'sharkcraft.graph-hubs/v1',
    ...(pathScope ? { path: pathScope } : {}),
    symbols: hubs.symbols.map(toRow),
    files: hubs.files.map(toRow),
  };
  if (wantJson) {
    process.stdout.write(asJson(maybeColumnarize(payload, args)) + '\n');
    return 0;
  }
  process.stdout.write(header(`Graph hubs (most-depended-on)${pathScope ? ` under ${pathScope}` : ''}`));
  if (hubs.symbols.length === 0 && hubs.files.length === 0) {
    process.stdout.write(
      pathScope
        ? `  No referenced/imported code under "${pathScope}" (check the path, or the call/reference graph is TS/JS-only).\n`
        : '  No reference/import edges yet (call/reference graph is TS/JS-only — run `shrk graph index`).\n',
    );
    return 0;
  }
  if (hubs.symbols.length > 0) {
    process.stdout.write('\nMost-referenced symbols (distinct dependent files):\n');
    for (const h of hubs.symbols) {
      process.stdout.write(
        `  ${String(h.inDegree).padStart(4)}  ${h.node.label}${h.node.path ? '  ' + h.node.path : ''}${h.node.line ? ':' + h.node.line : ''}\n`,
      );
    }
  }
  if (hubs.files.length > 0) {
    process.stdout.write('\nMost-imported files (distinct importers):\n');
    for (const h of hubs.files) {
      process.stdout.write(`  ${String(h.inDegree).padStart(4)}  ${h.node.path ?? h.node.id}\n`);
    }
  }
  return 0;
}

// ─── shrk graph callers ───────────────────────────────────────────────

export async function runGraphCallers(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const target = args.positional[1];
  if (!target) {
    process.stderr.write('Usage: shrk graph callers <symbol> [--mode call|reference] [--limit N] [--no-refresh]\n');
    return 2;
  }
  const mode = (flagString(args, 'mode') ?? 'call') as 'call' | 'reference';
  // --limit N: cap the returned call sites (default 200). `total` still reports
  // the true uncapped count, so a truncated result stays honest. Guard against
  // non-numeric input — `Number('foo')` is NaN and `slice(0, NaN)` would zero
  // the callers list while `total` kept showing the real count.
  const parsedLimit = Number.parseInt(flagString(args, 'limit') ?? '200', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 200;
  maybeRefresh(args, cwd);
  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;
  const resolved = resolveSymbolTarget(api, target);
  if (!resolved) {
    const behind = indexBehindHint(cwd);
    const payload = { ok: false, error: 'not-found', target, ...(behind ? { hint: behind } : {}) };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(`No symbol matched "${target}".${behind ? ' ' + behind : ''}\n`);
    return 1;
  }
  const { sym, alsoNamed } = resolved;
  const sites = mode === 'reference' ? api.referenceSitesOf(sym.id) : api.callerSitesOf(sym.id);
  // Targeted staleness over the result files (declaring file + caller files):
  // drop callers whose file was deleted, flag those whose content changed.
  const fresh = resultStaleness(api, cwd, [sym.path, ...sites.map((s) => s.node.path)]);
  const liveSites = sites.filter((s) => !s.node.path || !fresh.deletedSet.has(s.node.path));
  const langNote = callGraphLanguageNote(api, sym);
  // When several symbols share the name, callers are reported for ONE of them
  // (the chosen — exported-preferred — declaration). Say so, otherwise the
  // agent reads a narrow result as the whole picture for that name.
  const ambiguityNote =
    alsoNamed > 0
      ? `${alsoNamed + 1} symbols named "${sym.label}"; showing callers of the one at ${sym.path ?? sym.id}${sym.line ? ':' + sym.line : ''}. Pass a symbol: id to disambiguate.`
      : undefined;
  // `total` is distinct caller FILES: at index time the graph collapses many
  // call/reference sites in one file to a single edge. Say so, otherwise `total`
  // reads as a raw invocation count and under-reports.
  const dedupNote =
    'total counts distinct caller files — multiple sites within one file collapse to a single entry.';
  const note = [ambiguityNote, langNote, dedupNote].filter(Boolean).join(' ');
  const payload = {
    schema: 'sharkcraft.graph-callers/v1',
    symbol: nodeSummary(sym),
    mode,
    total: liveSites.length,
    callers: liveSites.slice(0, limit).map((s) => ({
      ...nodeSummary(s.node),
      ...(s.line ? { line: s.line } : {}),
    })),
    ...(note ? { note } : {}),
    ...(fresh.field ?? {}),
  };
  if (wantJson) {
    process.stdout.write(asJson(maybeColumnarize(payload, args)) + '\n');
    return 0;
  }
  process.stdout.write(header(`Graph callers: ${sym.label} (${mode})`));
  process.stdout.write(kv('total', String(liveSites.length)) + '\n');
  if (note) process.stdout.write(`  ⓘ ${note}\n`);
  // Render `path:line` so the agent jumps straight to the call site instead
  // of having to grep inside each returned file.
  for (const c of payload.callers.slice(0, Math.min(50, limit))) {
    process.stdout.write(`  ${c.path ?? c.id}${c.line ? ':' + c.line : ''}\n`);
  }
  if (fresh.field) {
    process.stdout.write(
      `\n  ⚠ ${fresh.modified.length} result file(s) changed, ${fresh.deleted.length} deleted since indexing — run \`shrk graph index --changed\`.\n`,
    );
  }
  return 0;
}

/**
 * Resolve a callers target to a single symbol, reporting how many OTHER symbols
 * share the name (`alsoNamed`) so the caller can disclose the ambiguity instead
 * of silently picking one.
 */
function resolveSymbolTarget(
  api: GraphQueryApi,
  target: string,
): { sym: INode; alsoNamed: number } | undefined {
  if (target.startsWith('symbol:')) {
    const node = api.neighbours(target)?.node;
    return node ? { sym: node, alsoNamed: 0 } : undefined;
  }
  const syms = api.findSymbol(target, { exact: true, limit: 5 });
  if (syms.length === 0) return undefined;
  if (syms.length === 1) return { sym: syms[0]!, alsoNamed: 0 };
  // Multiple symbols with the same name. Prefer an exported one if any.
  const exported = syms.find((s) => (s.data?.['isExported'] ?? false) === true);
  return { sym: exported ?? syms[0]!, alsoNamed: syms.length - 1 };
}

// ─── shrk graph path ──────────────────────────────────────────────────

/**
 * `shrk graph path <from> <to>` — does code A actually reach code B?
 *
 * The question the original feedback fell back to grep for ("is billing
 * actually WIRED to checkout?"). `callers` = direct callers, `impact` =
 * reverse closure, `graph why` = the KNOWLEDGE graph — none answers the
 * forward CODE path between two symbols/files. This BFS does, over the
 * import/call/reference/declare/re-export/extends/implements edges, and
 * prints each hop with its edge kind (and call-site line) so the answer
 * shows HOW they are wired, not just that they are. When A→B has no path it
 * also checks B→A so "the dependency runs the other way" is reported instead
 * of a bare "no".
 */
export async function runGraphPath(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const fromArg = args.positional[1];
  const toArg = args.positional[2];
  if (!fromArg || !toArg) {
    process.stderr.write('Usage: shrk graph path <from> <to> [--max-depth N] [--no-refresh] [--json]\n');
    return 2;
  }
  const maxDepth = Math.max(1, Math.min(32, Number(flagString(args, 'max-depth') ?? '16')));
  maybeRefresh(args, cwd);
  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;
  const from = resolveAnchor(api, fromArg);
  const to = resolveAnchor(api, toArg);
  if (!from || !to) {
    const missing = !from ? fromArg : toArg;
    const behind = indexBehindHint(cwd);
    const payload = { ok: false, error: 'not-found', target: missing, ...(behind ? { hint: behind } : {}) };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(`No graph node matched "${missing}".${behind ? ' ' + behind : ''}\n`);
    return 1;
  }
  // A symbol node has no OUTGOING code edges — references/calls are recorded
  // file→symbol, so the out-edges live on the symbol's DECLARING FILE. To trace
  // "does A reach B" when A is a symbol, start the BFS from that file (and note
  // it), since per-symbol out-edges aren't tracked. The target may stay a symbol
  // (file→symbol edges land on it).
  const fromStart = bfsStartNode(api, from);
  const toStart = bfsStartNode(api, to);
  const forward = api.pathBetween(fromStart.id, to.id, { maxDepth });
  // If A doesn't reach B, the agent usually still wants to know whether B
  // reaches A (the dependency runs the other way) — so check the reverse and
  // report direction rather than a bare "no".
  const reverse = forward.found ? null : api.pathBetween(toStart.id, from.id, { maxDepth });
  const direction: 'forward' | 'reverse' | 'none' = forward.found
    ? 'forward'
    : reverse?.found
      ? 'reverse'
      : 'none';
  const chosen = forward.found ? forward : reverse?.found ? reverse : forward;
  // The endpoint the user asked for at the start of the chosen direction, plus
  // the file the BFS actually started from (differs only for a symbol endpoint).
  const startEndpoint = direction === 'reverse' ? to : from;
  const startFile = direction === 'reverse' ? toStart : fromStart;
  const startNote =
    direction !== 'none' && startFile.id !== startEndpoint.id && startEndpoint.kind === NodeKind.Symbol
      ? `\`${startEndpoint.label}\` is declared in ${startFile.path ?? startFile.id}; path traced from that file (per-symbol out-edges are not tracked).`
      : null;
  const hopRows = chosen.hops.map((h) => ({
    from: h.from.path ?? h.from.id,
    to: h.to.path ?? h.to.id,
    kind: h.kind,
    label: h.to.label,
    ...(h.line ? { line: h.line } : {}),
  }));
  const fresh = resultStaleness(api, cwd, [
    from.path,
    to.path,
    ...chosen.hops.map((h) => h.from.path),
    ...chosen.hops.map((h) => h.to.path),
  ]);
  // A no-path answer between non-TS endpoints may just be missing call edges
  // (call/reference graph is TS/JS-only), NOT proof they are unwired.
  const langNote =
    direction === 'none' ? callGraphLanguageNote(api, from) ?? callGraphLanguageNote(api, to) : null;
  const note = startNote ?? langNote;
  const payload = {
    schema: 'sharkcraft.graph-path/v1',
    from: nodeSummary(from),
    to: nodeSummary(to),
    found: direction !== 'none',
    direction,
    ...(direction !== 'none' && startFile.id !== startEndpoint.id ? { tracedFrom: nodeSummary(startFile) } : {}),
    hops: hopRows,
    hopCount: hopRows.length,
    explored: forward.found ? forward.explored : reverse?.explored ?? forward.explored,
    ...(direction === 'none' && chosen.reason ? { reason: chosen.reason } : {}),
    ...(note ? { note } : {}),
    ...(fresh.field ?? {}),
  };
  if (wantJson) {
    process.stdout.write(asJson(maybeColumnarize(payload, args)) + '\n');
    return 0;
  }
  process.stdout.write(header(`Graph path: ${from.label} → ${to.label}`));
  if (direction === 'none') {
    process.stdout.write(`  No code path ${from.label} → ${to.label} (or back) within ${maxDepth} hops.\n`);
    process.stdout.write(`  explored ${payload.explored} node(s).\n`);
    if (langNote) process.stdout.write(`  ⓘ ${langNote}\n`);
    return 0;
  }
  if (direction === 'reverse') {
    process.stdout.write(
      `  No ${from.label} → ${to.label} path, but ${to.label} reaches ${from.label} (dependency runs the other way):\n\n`,
    );
  }
  if (startNote) process.stdout.write(`  ⓘ ${startNote}\n`);
  process.stdout.write(`  ${startFile.path ?? startFile.label}\n`);
  for (const h of hopRows) {
    process.stdout.write(`    ──${h.kind}──▶ ${h.to}${h.line ? ':' + h.line : ''}\n`);
  }
  process.stdout.write(`\n  ${hopRows.length} hop(s).\n`);
  if (fresh.field) {
    process.stdout.write(
      `\n  ⚠ ${fresh.modified.length} file(s) on the path changed, ${fresh.deleted.length} deleted since indexing — run \`shrk graph index --changed\`.\n`,
    );
  }
  return 0;
}

// ─── helpers ──────────────────────────────────────────────────────────

function loadOrFail(cwd: string, wantJson: boolean): GraphQueryApi | undefined {
  const store = new GraphStore(cwd);
  if (!store.exists()) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          ok: false,
          state: 'missing',
          nextCommand: 'shrk graph index',
          message: STALE_HINT,
        }) + '\n',
      );
    } else {
      process.stderr.write(STALE_HINT + '\n');
    }
    return undefined;
  }
  return GraphQueryApi.fromStore(cwd);
}

function resolveAnchor(api: GraphQueryApi, target: string): INode | undefined {
  // Exact node id wins.
  const direct = api.neighbours(target);
  if (direct) return direct.node;
  // Prefixed id forms.
  for (const prefix of ['file:', 'symbol:', 'package:']) {
    if (target.startsWith(prefix)) return undefined;
  }
  // File path?
  const f = api.findFile(target);
  if (f) return f;
  // Symbol by name (exact).
  const syms = api.findSymbol(target, { exact: true, limit: 1 });
  if (syms.length > 0) return syms[0];
  return undefined;
}

function collectSearchMatches(
  api: GraphQueryApi,
  query: string,
  kind: 'file' | 'symbol' | 'package' | undefined,
  limit: number,
): INode[] {
  const out: INode[] = [];
  if (!kind || kind === 'file') {
    const f = api.findFile(query);
    if (f) out.push(f);
    // Fuzzy fallback: substring match on path/basename so `shrk graph
    // search Foo --kind file` finds `libs/x/y/Foo.ts` without forcing the
    // caller to type the full path. Skips the node if exact match already
    // included it.
    if (out.length < limit) {
      const q = query.toLowerCase();
      const seen = new Set(out.map((n) => n.id));
      for (const node of api.allFiles()) {
        if (seen.has(node.id)) continue;
        const p = node.path?.toLowerCase() ?? '';
        const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
        if (base.includes(q) || p.includes(q)) {
          out.push(node);
          seen.add(node.id);
          if (out.length >= limit) break;
        }
      }
    }
  }
  if (!kind || kind === 'symbol') {
    for (const s of api.findSymbol(query, { exact: false, limit })) out.push(s);
  }
  if (!kind || kind === 'package') {
    const p = api.neighbours(`package:${query}`);
    if (p) out.push(p.node);
  }
  return out.slice(0, limit);
}

function reverseClosure(
  api: GraphQueryApi,
  anchor: INode,
  maxDepth: number,
  limit: number,
): { all: string[]; layer: Record<number, string[]>; truncated: boolean } {
  const seen = new Set<string>([anchor.id]);
  const layer: Record<number, string[]> = {};
  let frontier = directDependentsForAnchor(api, anchor);
  let truncated = false;
  frontier = frontier.filter((id) => !seen.has(id));
  if (frontier.length > limit) {
    frontier = frontier.slice(0, limit);
    truncated = true;
  }
  for (const id of frontier) seen.add(id);
  if (frontier.length > 0) layer[1] = frontier;
  let depth = 2;
  while (depth <= maxDepth && frontier.length > 0 && !truncated) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of nextDependents(api, anchor.kind, id)) {
        if (seen.has(dep.id)) continue;
        seen.add(dep.id);
        next.push(dep.id);
        if (seen.size - 1 >= limit) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (next.length > 0) layer[depth] = next;
    frontier = next;
    depth += 1;
  }
  return { all: [...seen], layer, truncated };
}

function directDependentsForAnchor(api: GraphQueryApi, anchor: INode): string[] {
  // Kind-aware direct dependents (symbol → refs/calls + subtype files, file →
  // importers, package → dependents) — the ONE shared implementation in the
  // graph query API, so the CLI + MCP impact closures never disagree.
  return api.directDependentsOf(anchor).map((n) => n.id);
}

function nextDependents(api: GraphQueryApi, anchorKind: NodeKind, nodeId: string): readonly INode[] {
  if (anchorKind === NodeKind.Package) {
    const node = api.neighbours(nodeId)?.node;
    if (!node) return [];
    return api.packageDependents(packageNameFor(node));
  }
  return api.importersOf(nodeId);
}

/**
 * The node a code-path BFS should START from. Files carry their own outgoing
 * import/call/reference edges, so a file is its own start. A symbol does NOT —
 * those edges are recorded on its declaring file — so a symbol resolves to that
 * file (falling back to the symbol itself if the declaring file is unknown).
 */
function bfsStartNode(api: GraphQueryApi, node: INode): INode {
  if (node.kind !== NodeKind.Symbol) return node;
  return declaringFileOf(api, node.id) ?? (node.path ? api.findFile(node.path) : undefined) ?? node;
}

function declaringFileOf(api: GraphQueryApi, symbolId: string): INode | undefined {
  const neighbours = api.neighbours(symbolId);
  if (!neighbours) return undefined;
  for (const incoming of neighbours.in) {
    if (incoming.edge.kind !== EdgeKind.DeclaresSymbol) continue;
    if ('resolved' in incoming.source) continue;
    if (incoming.source.kind === NodeKind.File) return incoming.source;
  }
  return undefined;
}

function packageNameFor(node: INode): string {
  return node.id.startsWith('package:') ? node.id.slice('package:'.length) : node.label;
}

function nodeSummary(n: INode): {
  id: string;
  kind: string;
  label: string;
  path?: string;
  line?: number;
} {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    ...(n.path ? { path: n.path } : {}),
    ...(n.line ? { line: n.line } : {}),
  };
}

function targetSummary(
  target: INode | { id: string; resolved: false },
): { id: string; resolved: boolean; kind?: string; label?: string; path?: string } {
  if ('resolved' in target) {
    return { id: target.id, resolved: false };
  }
  return { id: target.id, resolved: true, kind: target.kind, label: target.label, ...(target.path ? { path: target.path } : {}) };
}

function sourceSummary(
  source: INode | { id: string; resolved: false },
): { id: string; resolved: boolean; kind?: string; label?: string; path?: string } {
  return targetSummary(source);
}

function toSearchHit(n: INode): {
  id: string;
  kind: string;
  label: string;
  path?: string;
  line?: number;
} {
  return nodeSummary(n);
}

function describeTarget(t: {
  id: string;
  resolved: boolean;
  kind?: string;
  label?: string;
  path?: string;
}): string {
  if (!t.resolved) return t.id;
  return `${t.path ?? t.label ?? t.id}`;
}

function sumValues(record: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const v of Object.values(record)) n += v;
  return n;
}

function dedupeNodes(nodes: readonly INode[]): readonly INode[] {
  const seen = new Set<string>();
  const out: INode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}
