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
  EdgeKind,
  GraphQueryApi,
  GraphStore,
  NodeKind,
  updateChanged,
} from '@shrkcrft/graph';
import type { INode } from '@shrkcrft/graph';
import { analyzeGraphImpact } from '@shrkcrft/impact-engine';
import { BridgeStore, RuleGraphQueryApi } from '@shrkcrft/rule-graph';
import { FrameworkQueryApi, FrameworkStore } from '@shrkcrft/framework-scanners';
import { flagBool, flagString, resolveCwd, type ParsedArgs } from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';

const STALE_HINT = `Index is missing or stale. Run 'shrk graph index' to build it.`;

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
  const payload = {
    ok: verify.ok,
    state: verify.ok ? 'fresh' : ('corrupt' as const),
    schema: snap.manifest.schema,
    fileCount: snap.manifest.filesIndexed,
    nodeCount: snap.nodes.size,
    edgeCount: snap.edges.size,
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
  return verify.ok ? 0 : 1;
}

// ─── shrk graph search ────────────────────────────────────────────────

export async function runGraphSearch(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const query = args.positional[1];
  if (!query) {
    process.stderr.write('Usage: shrk graph search <query> [--kind file|symbol|package] [--limit N]\n');
    return 2;
  }
  const kindFlag = flagString(args, 'kind') as 'file' | 'symbol' | 'package' | undefined;
  const limit = Number(flagString(args, 'limit') ?? '20');
  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;

  const matches: INode[] = collectSearchMatches(api, query, kindFlag, limit);

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
  if (matches.length === 0) {
    process.stdout.write(`No matches for "${query}".\n`);
    return 0;
  }
  process.stdout.write(header(`Graph search: ${query}`));
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
  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;
  const anchor = resolveAnchor(api, target);
  if (!anchor) {
    const payload = { ok: false, error: 'not-found', target };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(`No graph node matched "${target}".\n`);
    return 1;
  }
  const neighbours = api.neighbours(anchor.id)!;
  const symbols = anchor.kind === NodeKind.File ? api.symbolsIn(anchor.id) : [];

  // Optional bridge enrichment: rules / paths / templates applying to
  // the anchor file (only meaningful when anchor.kind === File).
  const bridgeStore = new BridgeStore(cwd);
  const bridgeFor = (includeBridge && bridgeStore.exists() && anchor.kind === NodeKind.File && anchor.path)
    ? RuleGraphQueryApi.fromStores(cwd).forFile(anchor.path)
    : undefined;

  // Optional framework enrichment.
  const frameworkStore = new FrameworkStore(cwd);
  const frameworkEntities = (includeFramework && frameworkStore.exists() && anchor.kind === NodeKind.File && anchor.path)
    ? FrameworkQueryApi.fromStore(cwd).forFile(anchor.path)
    : [];

  const payload = {
    schema: 'sharkcraft.graph-context/v1',
    anchor: nodeSummary(anchor),
    depth,
    importsFrom: neighbours.out
      .filter((o) => o.edge.kind === 'imports-file')
      .slice(0, 50)
      .map((o) => 'target' in o ? targetSummary(o.target) : { id: 'unknown', resolved: false }),
    importedBy: neighbours.in
      .filter((i) => i.edge.kind === 'imports-file')
      .slice(0, 50)
      .map((i) => 'source' in i ? sourceSummary(i.source) : { id: 'unknown', resolved: false }),
    symbols: symbols.slice(0, 50).map(nodeSummary),
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
    process.stdout.write(asJson(payload) + '\n');
    return 0;
  }
  process.stdout.write(header(`Graph context: ${anchor.kind}:${anchor.label}`));
  process.stdout.write(kv('path', anchor.path ?? '(none)') + '\n');
  if (payload.symbols.length > 0) {
    process.stdout.write(`\nDeclares ${payload.symbols.length} symbols:\n`);
    for (const s of payload.symbols.slice(0, 20)) {
      process.stdout.write(`  ${s.label}${s.line ? ':' + s.line : ''}\n`);
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

  // --full → delegate to the impact-engine for a richer v3 payload.
  if (wantFull) {
    const isSymbol = target.startsWith('symbol:') || /^[A-Za-z_][\w$]*$/.test(target);
    const input = isSymbol && !target.includes('/')
      ? { kind: 'symbol' as const, symbolId: target }
      : { kind: 'files' as const, files: [target] };
    const analysis = analyzeGraphImpact(input, { projectRoot: cwd, limit, maxDepth });
    if (wantJson) {
      process.stdout.write(asJson(analysis) + '\n');
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
    return 0;
  }

  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;
  const anchor = resolveAnchor(api, target);
  if (!anchor) {
    const payload = { ok: false, error: 'not-found', target };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(`No graph node matched "${target}".\n`);
    return 1;
  }
  const closure = reverseClosure(api, anchor.id, maxDepth, limit);
  const direct = closure.layer[1] ?? [];
  const transitive = closure.all.filter((id) => id !== anchor.id && !direct.includes(id));
  const payload = {
    schema: 'sharkcraft.graph-impact/v1',
    anchor: nodeSummary(anchor),
    maxDepth,
    limit,
    truncated: closure.truncated,
    directDependents: direct.map((id) => nodeSummary(api.neighbours(id)!.node)),
    transitiveDependents: transitive
      .slice(0, limit)
      .map((id) => nodeSummary(api.neighbours(id)!.node)),
    totalReached: closure.all.length - 1,
  };
  if (wantJson) {
    process.stdout.write(asJson(payload) + '\n');
    return 0;
  }
  process.stdout.write(header(`Graph impact: ${anchor.label}`));
  process.stdout.write(kv('direct', String(direct.length)) + '\n');
  process.stdout.write(kv('transitive', String(transitive.length)) + '\n');
  process.stdout.write(kv('max-depth', String(maxDepth)) + '\n');
  if (closure.truncated) process.stdout.write(kv('truncated', 'yes') + '\n');
  for (const d of payload.directDependents.slice(0, 30)) {
    process.stdout.write(`  ${d.path ?? d.id}\n`);
  }
  return 0;
}

// ─── shrk graph callers ───────────────────────────────────────────────

export async function runGraphCallers(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const target = args.positional[1];
  if (!target) {
    process.stderr.write('Usage: shrk graph callers <symbol> [--mode call|reference]\n');
    return 2;
  }
  const mode = (flagString(args, 'mode') ?? 'call') as 'call' | 'reference';
  const api = loadOrFail(cwd, wantJson);
  if (!api) return 1;
  const sym = resolveSymbolTarget(api, target);
  if (!sym) {
    const payload = { ok: false, error: 'not-found', target };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(`No symbol matched "${target}".\n`);
    return 1;
  }
  const hits = mode === 'reference' ? api.referencesOf(sym.id) : api.callersOf(sym.id);
  const payload = {
    schema: 'sharkcraft.graph-callers/v1',
    symbol: nodeSummary(sym),
    mode,
    total: hits.length,
    callers: hits.slice(0, 200).map(nodeSummary),
  };
  if (wantJson) {
    process.stdout.write(asJson(payload) + '\n');
    return 0;
  }
  process.stdout.write(header(`Graph callers: ${sym.label} (${mode})`));
  process.stdout.write(kv('total', String(hits.length)) + '\n');
  for (const c of payload.callers.slice(0, 50)) {
    process.stdout.write(`  ${c.path ?? c.id}\n`);
  }
  return 0;
}

function resolveSymbolTarget(api: GraphQueryApi, target: string): INode | undefined {
  if (target.startsWith('symbol:')) {
    return api.neighbours(target)?.node;
  }
  const syms = api.findSymbol(target, { exact: true, limit: 5 });
  if (syms.length === 0) return undefined;
  if (syms.length === 1) return syms[0];
  // Multiple symbols with the same name. Prefer an exported one if any.
  const exported = syms.find((s) => (s.data?.['isExported'] ?? false) === true);
  return exported ?? syms[0];
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
  startId: string,
  maxDepth: number,
  limit: number,
): { all: string[]; layer: Record<number, string[]>; truncated: boolean } {
  const seen = new Set<string>([startId]);
  const layer: Record<number, string[]> = {};
  let frontier: string[] = [startId];
  let depth = 1;
  let truncated = false;
  while (depth <= maxDepth && frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const importers = api.importersOf(id);
      for (const imp of importers) {
        if (seen.has(imp.id)) continue;
        seen.add(imp.id);
        next.push(imp.id);
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
    if (truncated) break;
  }
  return { all: [...seen], layer, truncated };
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
