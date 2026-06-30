import {
  buildRegistryWithPacks,
  defaultRegistry,
  FrameworkQueryApi,
  runExtractors,
} from '@shrkcrft/framework-scanners';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import {
  flagBool,
  flagPositiveInt,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { computeMtimeFreshness } from '../status/freshness.ts';

/**
 * `shrk framework` — run / inspect the framework-aware extractors.
 *
 * Sub-verbs:
 *   - shrk framework index           run extractors over the project
 *   - shrk framework status          report store health
 *   - shrk framework list [filters]  list entities (--framework, --subtype, --file)
 *   - shrk framework routes          NestJS route table (method, path, handler, file)
 */
export const frameworkCommand: ICommandHandler = {
  name: 'framework',
  description:
    'Framework-aware extractors: NestJS (controllers/modules/providers/routes), React (components/hook usages). Output: shrk framework list / routes / status / index.',
  usage:
    'shrk framework index [--only nestjs,react] [--json] | shrk framework status [--json] | shrk framework list [--framework <name>] [--subtype <s>] [--file <path>] [--limit N] [--json] | shrk framework routes [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'index') return runIndex(args);
    if (sub === 'status') return runStatus(args);
    if (sub === 'list') return runList(args);
    if (sub === 'routes') return runRoutes(args);
    process.stderr.write(this.usage + '\n');
    return 2;
  },
};

async function runIndex(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const only = flagString(args, 'only');
  const noPacks = flagBool(args, 'no-packs');
  try {
    // Build the registry: built-ins + optional pack-contributed extractors.
    const registry = defaultRegistry();
    let packPackages: readonly string[] = [];
    let packDiagnostics: readonly string[] = [];
    if (!noPacks) {
      try {
        const inspection = await inspectSharkcraft({ cwd });
        const merged = await buildRegistryWithPacks(registry, inspection.packs);
        packPackages = merged.packs;
        packDiagnostics = merged.diagnostics;
      } catch (e) {
        // Pack loading is best-effort. Surface the error as a diagnostic
        // but don't block the index — built-in extractors still run.
        packDiagnostics = [`pack discovery failed: ${(e as Error).message}`];
      }
    }
    const r = runExtractors({
      projectRoot: cwd,
      registry,
      ...(only ? { only: only.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    });
    const diagnostics = [...packDiagnostics, ...r.diagnostics];
    if (wantJson) {
      process.stdout.write(
        asJson({
          ok: true,
          manifest: r.manifest,
          filesScanned: r.filesScanned,
          durationMs: r.durationMs,
          diagnostics,
          packExtractors: packPackages,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Framework index'));
    process.stdout.write(kv('schema', r.manifest.schema) + '\n');
    process.stdout.write(kv('frameworks', r.manifest.frameworks.join(', ')) + '\n');
    process.stdout.write(kv('files scanned', String(r.filesScanned)) + '\n');
    for (const [framework, count] of Object.entries(r.manifest.countsByFramework)) {
      process.stdout.write(kv(`entities (${framework})`, String(count)) + '\n');
    }
    if (packPackages.length > 0) {
      process.stdout.write(kv('pack extractors', packPackages.join(', ')) + '\n');
    }
    process.stdout.write(kv('duration', `${r.durationMs}ms`) + '\n');
    for (const d of diagnostics.slice(0, 5)) process.stdout.write(`! ${d}\n`);
    return 0;
  } catch (e) {
    const msg = (e as Error).message;
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: msg, nextCommand: 'shrk graph index' }) + '\n');
    } else {
      process.stderr.write(msg + '\n');
    }
    return 1;
  }
}

async function runStatus(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const missing = FrameworkQueryApi.missingDescription(cwd);
  if (missing) {
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, state: 'missing', message: missing, nextCommand: 'shrk framework index' }) + '\n');
      return 1;
    }
    process.stderr.write(missing + '\n');
    return 1;
  }
  const api = FrameworkQueryApi.fromStore(cwd);
  const m = api.manifest();
  // Honest freshness: the framework store is stale once a source file changed
  // after it was built. Mirror the `state + lastBuiltAt + drift` shape that
  // `graph status` exposes.
  const fresh = computeMtimeFreshness(cwd, m.lastBuiltAt);
  if (wantJson) {
    process.stdout.write(
      asJson({
        ok: true,
        state: fresh.state,
        lastBuiltAt: m.lastBuiltAt,
        lastChangedAt: fresh.lastChangedAt,
        behindMs: fresh.behindMs,
        ...(fresh.state === 'stale' ? { nextCommand: 'shrk framework index' } : {}),
        manifest: m,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header('Framework status'));
  process.stdout.write(kv('schema', m.schema) + '\n');
  process.stdout.write(kv('frameworks', m.frameworks.join(', ')) + '\n');
  for (const [k, v] of Object.entries(m.countsBySubtype)) {
    process.stdout.write(kv(`  ${k}`, String(v)) + '\n');
  }
  process.stdout.write(kv('last built', m.lastBuiltAt) + '\n');
  process.stdout.write(kv('state', fresh.state) + '\n');
  if (fresh.state === 'stale') {
    process.stdout.write(
      `! stale — source changed since last build${fresh.lastChangedAt ? ` (last change ${fresh.lastChangedAt})` : ''}; re-run \`shrk framework index\`\n`,
    );
  }
  return 0;
}

async function runList(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const missing = FrameworkQueryApi.missingDescription(cwd);
  if (missing) {
    process.stderr.write(missing + '\n');
    return 1;
  }
  const api = FrameworkQueryApi.fromStore(cwd);
  const framework = flagString(args, 'framework');
  const subtype = flagString(args, 'subtype');
  const file = flagString(args, 'file');
  const limit = flagPositiveInt(args, 'limit', 50);
  const entities = api.list({
    ...(framework ? { framework } : {}),
    ...(subtype ? { subtype } : {}),
    ...(file ? { file } : {}),
    limit,
  });
  if (wantJson) {
    process.stdout.write(
      asJson({
        schema: 'sharkcraft.framework-list/v1',
        filters: { framework, subtype, file },
        total: entities.length,
        entities: entities.map((n) => ({ id: n.id, label: n.label, path: n.path, data: n.data })),
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header('Framework entities'));
  process.stdout.write(kv('total', String(entities.length)) + '\n');
  for (const n of entities) {
    process.stdout.write(`  ${(n.data?.['framework'] as string | undefined) ?? '?'}:${(n.data?.['subtype'] as string | undefined) ?? '?'}  ${n.label}  ${n.path ?? ''}\n`);
  }
  return 0;
}

async function runRoutes(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const missing = FrameworkQueryApi.missingDescription(cwd);
  if (missing) {
    process.stderr.write(missing + '\n');
    return 1;
  }
  const api = FrameworkQueryApi.fromStore(cwd);
  const routes = api.routes();
  if (wantJson) {
    process.stdout.write(asJson({ schema: 'sharkcraft.framework-routes/v1', total: routes.length, routes }) + '\n');
    return 0;
  }
  process.stdout.write(header('NestJS routes'));
  process.stdout.write(kv('total', String(routes.length)) + '\n');
  for (const r of routes.slice(0, 100)) {
    process.stdout.write(`  ${r.method.padEnd(6)} ${r.path.padEnd(36)} → ${r.handler}  (${r.file})\n`);
  }
  return 0;
}
