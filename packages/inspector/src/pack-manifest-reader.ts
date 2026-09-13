/**
 * Find and load a pack's manifest from its root — the one reader the
 * pack-author surfaces (`packs dev-status`, `packs test --typecheck`) share.
 *
 *   - `manifestPath`: what `package.json` `sharkcraft.manifest` (or a string
 *     `sharkcraft` field) points at;
 *   - `signedManifestPath`: the `<dir>/<base>.signed.json` `packs sign` writes
 *     next to it (or a root-level `sharkcraft.plugin.signed.json`, for older
 *     packs) — preferred when present, since it carries the signature;
 *   - `manifest`: the loaded object (JSON parsed; TS/JS imported through the
 *     engine loader, so a module that failed once rejects deterministically).
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { importModuleViaLoader } from '@shrkcrft/core';
import type { ISharkCraftPackManifest } from '@shrkcrft/plugin-api';

function readJsonSafe(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export async function readPackManifest(packRoot: string): Promise<{
  readonly manifestPath: string | null;
  readonly signedManifestPath: string | null;
  readonly manifest: ISharkCraftPackManifest | null;
  readonly error?: string;
}> {
  const pkg = readJsonSafe(join(packRoot, 'package.json')) as { sharkcraft?: unknown } | null;
  const field = pkg?.sharkcraft;
  const rel =
    typeof field === 'string'
      ? field
      : field && typeof field === 'object' && typeof (field as { manifest?: unknown }).manifest === 'string'
        ? (field as { manifest: string }).manifest
        : undefined;
  let manifestPath: string | null = rel ? resolve(packRoot, rel) : null;
  if (manifestPath && !existsSync(manifestPath)) manifestPath = null;
  let signedManifestPath: string | null = null;
  if (manifestPath?.endsWith('.json')) {
    signedManifestPath = manifestPath;
  } else if (manifestPath) {
    const sibling = join(dirname(manifestPath), basename(manifestPath).replace(/\.(ts|js|mjs|cjs)$/i, '') + '.signed.json');
    if (existsSync(sibling)) signedManifestPath = sibling;
  }
  if (!signedManifestPath) {
    const legacy = join(packRoot, 'sharkcraft.plugin.signed.json');
    if (existsSync(legacy)) signedManifestPath = legacy;
  }
  const file = signedManifestPath ?? manifestPath;
  if (!file) {
    return {
      manifestPath,
      signedManifestPath,
      manifest: null,
      error: rel
        ? `sharkcraft.manifest points at a missing file (${rel})`
        : 'package.json declares no sharkcraft.manifest',
    };
  }
  try {
    if (file.endsWith('.json')) {
      return { manifestPath, signedManifestPath, manifest: JSON.parse(readFileSync(file, 'utf8')) as ISharkCraftPackManifest };
    }
    const mod = (await importModuleViaLoader(file)) as { default?: ISharkCraftPackManifest };
    return {
      manifestPath,
      signedManifestPath,
      manifest: mod.default ?? (mod as unknown as ISharkCraftPackManifest),
    };
  } catch (e) {
    return {
      manifestPath,
      signedManifestPath,
      manifest: null,
      error: `manifest failed to load (${((e as Error).message.split('\n')[0] ?? '').trim()})`,
    };
  }
}
