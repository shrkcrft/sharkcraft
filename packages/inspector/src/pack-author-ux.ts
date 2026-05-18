/**
 * Pack-author developer UX.
 *
 *  - buildPackDevStatus({ packPath, consumerPath }) — what the consumer sees:
 *    source vs node_modules vs symlink, signed-manifest staleness, contribution
 *    counts.
 *  - planPackWatchCommand({ packPath, command }) — pure helper that returns
 *    the resolved watch command and the file globs to observe (no spawning
 *    happens here — the CLI command spawns the child).
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export interface IPackDevStatus {
  schema: 'sharkcraft.pack-dev-status/v1';
  packPath: string;
  consumerPath?: string | undefined;
  packExists: boolean;
  manifestPath: string | null;
  signedManifestPath: string | null;
  packVersion: string | null;
  consumerSeesPackFrom: 'source' | 'node_modules' | 'symlink' | 'not-installed' | 'self';
  signatureStaleness: 'fresh' | 'stale' | 'missing' | 'unknown';
  staleAssets: ReadonlyArray<string>;
  contributionCounts: Readonly<{
    rules: number;
    paths: number;
    templates: number;
    pipelines: number;
    presets: number;
    boundaries: number;
    knowledge: number;
    playbooks: number;
    constructs: number;
    docsFiles: number;
  }>;
  warnings: ReadonlyArray<string>;
  nextCommandHint: string;
}

const WATCHED_GLOBS = Object.freeze([
  'src/assets/**/*.ts',
  'package.json',
  'manifest.json',
  'sharkcraft.plugin.signed.json',
  'README.md',
  'SECURITY.md',
] as const);

function readJsonSafe(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function countTsExports(absFile: string): number {
  if (!existsSync(absFile)) return 0;
  const txt = readFileSync(absFile, 'utf8');
  // Count default array entries: lines like `  pluginContract,` at brace depth 1.
  const m = txt.match(/^export default \[([\s\S]*?)\];/m);
  if (m && m[1]) {
    return m[1].split(',').filter((s) => s.trim().length > 0).length;
  }
  // Fallback: count named exports.
  const named = txt.match(/^export const /gm);
  return named ? named.length : 0;
}

function walkSourceAssetMtimes(packPath: string): { newestMtimeMs: number; files: string[] } {
  const root = join(packPath, 'src', 'assets');
  let newestMtimeMs = 0;
  const out: string[] = [];
  if (!existsSync(root)) return { newestMtimeMs, files: out };
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.ts')) {
        const st = statSync(p);
        out.push(p);
        if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
      }
    }
  };
  walk(root);
  return { newestMtimeMs, files: out };
}

function detectConsumerSource(
  packPath: string,
  consumerPath: string,
): IPackDevStatus['consumerSeesPackFrom'] {
  // Read consumer package.json to find pack name.
  const pkgPath = join(packPath, 'package.json');
  if (!existsSync(pkgPath)) return 'not-installed';
  const pkg = readJsonSafe(pkgPath) as { name?: string };
  if (!pkg?.name) return 'not-installed';
  const consumerNm = join(consumerPath, 'node_modules', pkg.name);
  if (existsSync(consumerNm)) {
    try {
      const lstat = lstatSync(consumerNm);
      if (lstat.isSymbolicLink()) return 'symlink';
    } catch {
      /* fall through */
    }
    return 'node_modules';
  }
  // Same path → consumer is the pack itself.
  if (resolve(packPath) === resolve(consumerPath)) return 'self';
  return 'source';
}

export function buildPackDevStatus(input: {
  packPath: string;
  consumerPath?: string;
}): IPackDevStatus {
  const { packPath } = input;
  const warnings: string[] = [];
  if (!existsSync(packPath)) {
    return {
      schema: 'sharkcraft.pack-dev-status/v1',
      packPath,
      packExists: false,
      manifestPath: null,
      signedManifestPath: null,
      packVersion: null,
      consumerSeesPackFrom: 'not-installed',
      signatureStaleness: 'unknown',
      staleAssets: [],
      contributionCounts: {
        rules: 0,
        paths: 0,
        templates: 0,
        pipelines: 0,
        presets: 0,
        boundaries: 0,
        knowledge: 0,
        playbooks: 0,
        constructs: 0,
        docsFiles: 0,
      },
      warnings: [`Pack path does not exist: ${packPath}`],
      nextCommandHint: 'shrk packs new <name>',
    };
  }
  const manifestPath = join(packPath, 'manifest.json');
  const signedManifestPath = join(packPath, 'sharkcraft.plugin.signed.json');
  const pkg = readJsonSafe(join(packPath, 'package.json')) as { version?: string; name?: string };
  const contributionCounts = {
    rules: countTsExports(join(packPath, 'src/assets/rules.ts')),
    paths: countTsExports(join(packPath, 'src/assets/paths.ts')),
    templates: countTsExports(join(packPath, 'src/assets/templates.ts')),
    pipelines: countTsExports(join(packPath, 'src/assets/pipelines.ts')),
    presets: countTsExports(join(packPath, 'src/assets/presets.ts')),
    boundaries: countTsExports(join(packPath, 'src/assets/boundaries.ts')),
    knowledge: countTsExports(join(packPath, 'src/assets/knowledge.ts')),
    playbooks: countTsExports(join(packPath, 'src/assets/playbooks.ts')),
    constructs: countTsExports(join(packPath, 'src/assets/constructs.ts')),
    docsFiles: 0,
  };
  let signatureStaleness: IPackDevStatus['signatureStaleness'] = 'unknown';
  const staleAssets: string[] = [];
  if (existsSync(signedManifestPath)) {
    const sigMtime = statSync(signedManifestPath).mtimeMs;
    const { newestMtimeMs, files } = walkSourceAssetMtimes(packPath);
    if (newestMtimeMs > sigMtime + 500) {
      signatureStaleness = 'stale';
      for (const f of files) {
        const st = statSync(f).mtimeMs;
        if (st > sigMtime + 500) staleAssets.push(relative(packPath, f));
      }
      warnings.push(
        `Signed manifest is older than ${staleAssets.length} asset file(s). Re-sign with \`shrk packs sign\`.`,
      );
    } else {
      signatureStaleness = 'fresh';
    }
  } else {
    signatureStaleness = 'missing';
    warnings.push('No signed manifest found. Run `shrk packs sign` before publishing.');
  }
  const consumerPath = input.consumerPath ? resolve(input.consumerPath) : undefined;
  const consumerSeesPackFrom = consumerPath
    ? detectConsumerSource(packPath, consumerPath)
    : 'not-installed';
  return {
    schema: 'sharkcraft.pack-dev-status/v1',
    packPath,
    consumerPath: consumerPath ?? undefined,
    packExists: true,
    manifestPath: existsSync(manifestPath) ? manifestPath : null,
    signedManifestPath: existsSync(signedManifestPath) ? signedManifestPath : null,
    packVersion: pkg?.version ?? null,
    consumerSeesPackFrom,
    signatureStaleness,
    staleAssets,
    contributionCounts,
    warnings,
    nextCommandHint:
      signatureStaleness === 'stale'
        ? `shrk packs sign --pack ${packPath.split(sep).pop()}`
        : `shrk packs doctor --release --cwd ${packPath}`,
  };
}

export interface IPackWatchPlan {
  schema: 'sharkcraft.pack-watch-plan/v1';
  packPath: string;
  consumerPath?: string;
  command: string;
  args: ReadonlyArray<string>;
  globs: ReadonlyArray<string>;
  debounceMs: number;
  willSign: false;
}

export function planPackWatchCommand(input: {
  packPath: string;
  consumerPath?: string;
  command?: string;
  debounceMs?: number;
}): IPackWatchPlan {
  const command = input.command ?? 'shrk packs doctor --release && shrk commands doctor';
  return {
    schema: 'sharkcraft.pack-watch-plan/v1',
    packPath: input.packPath,
    ...(input.consumerPath ? { consumerPath: input.consumerPath } : {}),
    command,
    args: [],
    globs: [...WATCHED_GLOBS],
    debounceMs: input.debounceMs ?? 300,
    willSign: false,
  };
}

export function renderPackDevStatusText(status: IPackDevStatus): string {
  const lines: string[] = [];
  lines.push(`=== Pack dev-status ===`);
  lines.push(`  pack            ${status.packPath}`);
  if (status.consumerPath) lines.push(`  consumer        ${status.consumerPath}`);
  lines.push(`  version         ${status.packVersion ?? '(unknown)'}`);
  lines.push(`  seen as         ${status.consumerSeesPackFrom}`);
  lines.push(`  signature       ${status.signatureStaleness}`);
  if (status.staleAssets.length > 0) {
    lines.push(`  stale assets    ${status.staleAssets.length}`);
    for (const a of status.staleAssets.slice(0, 8)) lines.push(`                  • ${a}`);
  }
  lines.push('');
  lines.push('Contributions:');
  for (const [k, v] of Object.entries(status.contributionCounts)) {
    lines.push(`  ${k.padEnd(12)} ${v}`);
  }
  if (status.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of status.warnings) lines.push(`  ⚠ ${w}`);
  }
  lines.push('');
  lines.push(`Next: ${status.nextCommandHint}`);
  return lines.join('\n') + '\n';
}
