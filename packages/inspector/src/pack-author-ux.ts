/**
 * Pack-author developer UX.
 *
 *  - buildPackDevStatus({ packPath, consumerPath }) — what the consumer sees:
 *    source vs node_modules vs symlink, signature + compiled-build freshness
 *    (from THE pack-asset freshness authority — content digests, never mtimes),
 *    and the contribution FILES the manifest declares.
 *  - planPackWatchCommand({ packPath, command }) — pure helper that returns
 *    the resolved watch command and the file globs to observe (no spawning
 *    happens here — the CLI command spawns the child).
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { countContributions } from '@shrkcrft/packs';
import {
  describePackAssetFreshness,
  detectPackAssetFreshness,
  type IPackAssetFreshness,
} from './pack-asset-freshness.ts';
import { readPackManifest } from './pack-manifest-reader.ts';

export interface IPackDevStatus {
  schema: 'sharkcraft.pack-dev-status/v1';
  packPath: string;
  consumerPath?: string | undefined;
  packExists: boolean;
  /** The manifest `package.json` `sharkcraft.manifest` points at. */
  manifestPath: string | null;
  /** The signed manifest (`<manifest>.signed.json`, as `packs sign` writes it), when present. */
  signedManifestPath: string | null;
  packVersion: string | null;
  consumerSeesPackFrom: 'source' | 'node_modules' | 'symlink' | 'not-installed' | 'self';
  /**
   * Signature freshness from the one authority: `stale` = a contribution's
   * content changed since signing; `unknown` = the signature records no
   * content digests (NOT verified) or the manifest could not be read.
   */
  signatureStaleness: 'fresh' | 'stale' | 'missing' | 'unknown';
  /** Pack-relative files whose content changed since signing. */
  staleAssets: ReadonlyArray<string>;
  /** Compiled-artifact freshness (`dist/*.js` vs its source) from the one authority. */
  buildStaleness: IPackAssetFreshness['build']['state'] | 'unknown';
  /** Compiled artifacts built from an older source. */
  staleArtifacts: ReadonlyArray<string>;
  /**
   * Declared contribution FILES per kind, read from the manifest
   * (`countContributions`) — never a regex count of array entries, which used
   * to split the default-export text on commas and report nonsense.
   */
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
  /** The full freshness record (null when the manifest could not be read). */
  freshness: IPackAssetFreshness | null;
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

const ZERO_COUNTS: IPackDevStatus['contributionCounts'] = Object.freeze({
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
});

function readJsonSafe(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
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

export async function buildPackDevStatus(input: {
  packPath: string;
  consumerPath?: string;
}): Promise<IPackDevStatus> {
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
      buildStaleness: 'unknown',
      staleArtifacts: [],
      contributionCounts: ZERO_COUNTS,
      freshness: null,
      warnings: [`Pack path does not exist: ${packPath}`],
      nextCommandHint: 'shrk packs new <name>',
    };
  }
  const pkg = readJsonSafe(join(packPath, 'package.json')) as { version?: string; name?: string };
  const loaded = await readPackManifest(packPath);
  const { manifestPath, signedManifestPath } = loaded;
  if (loaded.error) warnings.push(`Cannot read the pack manifest: ${loaded.error}. Freshness NOT verified.`);
  const manifest = loaded.manifest;
  const c = countContributions(manifest?.contributions) as Record<string, number | undefined>;
  const contributionCounts: IPackDevStatus['contributionCounts'] = {
    rules: c['ruleFiles'] ?? 0,
    paths: (c['pathFiles'] ?? 0) + (c['pathConventionFiles'] ?? 0),
    templates: c['templateFiles'] ?? 0,
    pipelines: c['pipelineFiles'] ?? 0,
    presets: c['presetFiles'] ?? 0,
    boundaries: c['boundaryFiles'] ?? 0,
    knowledge: c['knowledgeFiles'] ?? 0,
    playbooks: c['playbookFiles'] ?? 0,
    constructs: c['constructFiles'] ?? 0,
    docsFiles: c['docsFiles'] ?? 0,
  };

  const freshness = manifest
    ? detectPackAssetFreshness({ packageName: pkg?.name ?? basename(packPath), packageRoot: packPath, manifest })
    : null;
  const signatureStaleness: IPackDevStatus['signatureStaleness'] = !freshness
    ? 'unknown'
    : freshness.signature.state === 'unsigned'
      ? 'missing'
      : freshness.signature.state === 'diverged'
        ? 'stale'
        : freshness.signature.state === 'unrecorded'
          ? 'unknown'
          : 'fresh';
  if (freshness) {
    const said = describePackAssetFreshness(freshness);
    if (said.signature) warnings.push(said.signature);
    if (said.build) warnings.push(said.build);
    if (freshness.signature.state === 'unsigned') {
      warnings.push('No signed manifest found. Run `shrk packs sign` before publishing.');
    }
  }
  const staleArtifacts = freshness
    ? freshness.build.artifacts.filter((a) => a.state === 'stale').map((a) => a.artifact)
    : [];

  const consumerPath = input.consumerPath ? resolve(input.consumerPath) : undefined;
  const consumerSeesPackFrom = consumerPath
    ? detectConsumerSource(packPath, consumerPath)
    : 'not-installed';
  const nextCommandHint =
    freshness?.build.state === 'stale'
      ? freshness.build.rebuildCommand
        ? `(cd ${packPath} && ${freshness.build.rebuildCommand})`
        : `rebuild ${packPath}`
      : signatureStaleness === 'stale' || signatureStaleness === 'unknown'
        ? `shrk packs sign ${packPath}`
        : `shrk packs doctor --release --cwd ${packPath}`;
  return {
    schema: 'sharkcraft.pack-dev-status/v1',
    packPath,
    consumerPath: consumerPath ?? undefined,
    packExists: true,
    manifestPath,
    signedManifestPath,
    packVersion: pkg?.version ?? null,
    consumerSeesPackFrom,
    signatureStaleness,
    staleAssets: freshness?.signature.diverged ?? [],
    buildStaleness: freshness?.build.state ?? 'unknown',
    staleArtifacts,
    contributionCounts,
    freshness,
    warnings,
    nextCommandHint,
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
  lines.push(`  signature       ${status.signatureStaleness}${status.signatureStaleness === 'unknown' ? ' (NOT verified)' : ''}`);
  if (status.staleAssets.length > 0) {
    lines.push(`  changed since signing  ${status.staleAssets.length}`);
    for (const a of status.staleAssets.slice(0, 8)) lines.push(`                  • ${a}`);
  }
  lines.push(`  build           ${status.buildStaleness}${status.buildStaleness === 'unrecorded' ? ' (NOT verified)' : ''}`);
  if (status.staleArtifacts.length > 0) {
    lines.push(`  stale artifacts ${status.staleArtifacts.length}`);
    for (const a of status.staleArtifacts.slice(0, 8)) lines.push(`                  • ${a}`);
  }
  lines.push('');
  lines.push('Contribution files (declared in the manifest):');
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
