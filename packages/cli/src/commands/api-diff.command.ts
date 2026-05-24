import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  diffApiSurfaces,
  extractApiSurface,
  extractApiSurfaceWithProgram,
  type IApiSurface,
} from '@shrkcrft/api-surface-diff';
import { GraphStore } from '@shrkcrft/graph';
import {
  flagBool,
  flagList,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * `shrk api-diff` — compare the current code-graph's public-API
 * surface to a saved baseline (or another snapshot file).
 *
 * Sub-verbs:
 *   - shrk api-diff capture --output <path>     write the current surface to disk
 *   - shrk api-diff <baseline.json>             diff current vs baseline
 */
export const apiDiffCommand: ICommandHandler = {
  name: 'api-diff',
  description:
    'Compare the current public API surface to a saved baseline. Reports added / removed / kind-changed / moved symbols, with breaking-change severity.',
  usage:
    'shrk api-diff capture --output <path> [--packages a,b] [--with-signatures] | shrk api-diff <baseline.json> [--packages a,b] [--with-signatures] [--json] [--fail-on-breaking]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const sub = args.positional[0];
    if (!sub) {
      process.stderr.write(this.usage + '\n');
      return 2;
    }

    if (sub === 'capture') {
      return runCapture(args, cwd, wantJson);
    }
    return runDiff(args, cwd, wantJson, sub);
  },
};

async function runCapture(args: ParsedArgs, cwd: string, wantJson: boolean): Promise<number> {
  const outputFlag = flagString(args, 'output');
  if (!outputFlag) {
    process.stderr.write('shrk api-diff capture requires --output <path>\n');
    return 2;
  }
  const surface = readSurfaceFromCwd(cwd, args);
  if (!surface) return 1;
  const abs = nodePath.isAbsolute(outputFlag) ? outputFlag : nodePath.resolve(cwd, outputFlag);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(surface, null, 2), 'utf8');
  if (wantJson) {
    process.stdout.write(asJson({ ok: true, wrote: abs, total: surface.total }) + '\n');
    return 0;
  }
  process.stdout.write(header('API surface capture'));
  process.stdout.write(kv('wrote', abs) + '\n');
  process.stdout.write(kv('symbols', String(surface.total)) + '\n');
  return 0;
}

async function runDiff(
  args: ParsedArgs,
  cwd: string,
  wantJson: boolean,
  baselinePath: string,
): Promise<number> {
  const baselineAbs = nodePath.isAbsolute(baselinePath)
    ? baselinePath
    : nodePath.resolve(cwd, baselinePath);
  let baseline: IApiSurface;
  try {
    baseline = JSON.parse(readFileSync(baselineAbs, 'utf8'));
  } catch (e) {
    process.stderr.write(`Baseline read error: ${(e as Error).message}\n`);
    return 2;
  }
  const current = readSurfaceFromCwd(cwd, args);
  if (!current) return 1;
  const diff = diffApiSurfaces(baseline, current);
  const failOnBreaking = flagBool(args, 'fail-on-breaking');
  if (wantJson) {
    process.stdout.write(asJson(diff) + '\n');
    return failOnBreaking && diff.breakingCount > 0 ? 1 : 0;
  }
  process.stdout.write(header('API surface diff'));
  process.stdout.write(kv('schema', diff.schema) + '\n');
  process.stdout.write(kv('baseline symbols', String(diff.baselineTotal)) + '\n');
  process.stdout.write(kv('current symbols', String(diff.currentTotal)) + '\n');
  process.stdout.write(kv('added', String(diff.added)) + '\n');
  process.stdout.write(kv('removed', String(diff.removed)) + '\n');
  process.stdout.write(kv('changed', String(diff.changed)) + '\n');
  process.stdout.write(kv('breaking', String(diff.breakingCount)) + '\n');
  if (diff.entries.length === 0) {
    process.stdout.write('\nNo changes.\n');
    return 0;
  }
  process.stdout.write('\nEntries:\n');
  for (const e of diff.entries.slice(0, 80)) {
    process.stdout.write(`  [${e.severity}] [${e.kind}] ${e.message}\n`);
  }
  if (diff.entries.length > 80) {
    process.stdout.write(`  … (${diff.entries.length - 80} more)\n`);
  }
  return failOnBreaking && diff.breakingCount > 0 ? 1 : 0;
}

function readSurfaceFromCwd(cwd: string, args: ParsedArgs): IApiSurface | undefined {
  const packages = flagList(args, 'packages');
  const withSignatures = flagBool(args, 'with-signatures');
  if (withSignatures) {
    const result = extractApiSurfaceWithProgram({
      projectRoot: cwd,
      ...(packages.length > 0 ? { packageFilter: packages } : {}),
    });
    for (const d of result.diagnostics.slice(0, 5)) {
      process.stderr.write(`! ${d}\n`);
    }
    return result.surface;
  }
  const store = new GraphStore(cwd);
  if (!store.exists()) {
    process.stderr.write("Code-graph store missing. Run 'shrk graph index' first.\n");
    return undefined;
  }
  const snap = store.loadSnapshot();
  return extractApiSurface(snap, { ...(packages.length > 0 ? { packageFilter: packages } : {}) });
}
