/**
 * Type-check a pack's own TypeScript assets — the manifest file plus every
 * `.ts`/`.tsx` contribution the manifest declares — with the ONE in-process
 * check (`typecheckFiles`). Pack loading is transpile-only, so this is the
 * only place an implicit-any parameter or a misspelled field in an asset is
 * caught before it ships.
 *
 * Opt-in (`--typecheck` on `packs test | doctor | release-check`): it is
 * costly, and default loading must not change behaviour. The pack's own
 * `tsconfig.json` applies when present; otherwise strict defaults with `.ts`
 * import specifiers allowed (Bun loads them). Every diagnostic in a file under
 * the pack root is reported (so a group module an asset imports is checked
 * too). `ran: false` — no TS files, or TypeScript could not run — is a
 * not-verified outcome for callers, never a pass.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONTRIBUTION_FILE_KEYS,
  FUTURE_CONTRIBUTION_FILE_KEYS,
  type ISharkCraftPackManifest,
} from '@shrkcrft/plugin-api';
import { typecheckFiles, type ITypecheckFilesResult } from './typecheck-files.ts';

const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/;

export function typecheckPackAssets(pack: {
  readonly packageRoot: string;
  readonly manifestPath?: string | null;
  readonly manifest?: ISharkCraftPackManifest | null;
}): ITypecheckFilesResult {
  const roots = new Set<string>();
  if (pack.manifestPath && TS_SOURCE.test(pack.manifestPath) && existsSync(pack.manifestPath)) {
    roots.add(resolve(pack.manifestPath));
  }
  const contributions = (pack.manifest?.contributions ?? {}) as Record<string, readonly string[] | undefined>;
  for (const key of [...CONTRIBUTION_FILE_KEYS, ...FUTURE_CONTRIBUTION_FILE_KEYS]) {
    for (const rel of contributions[key] ?? []) {
      if (typeof rel !== 'string' || !TS_SOURCE.test(rel)) continue;
      const abs = resolve(pack.packageRoot, rel);
      if (existsSync(abs)) roots.add(abs);
    }
  }
  const result = typecheckFiles(pack.packageRoot, {
    rootNames: [...roots].sort(),
    reportOnlyUnder: pack.packageRoot,
    allowTsExtensionsByDefault: true,
    includeGlobalDiagnostics: true,
  });
  return sdkUnresolved(result, pack.packageRoot) ?? result;
}

/** "Cannot find module" — 2307, and 2792 (its moduleResolution-hint variant). */
const MODULE_NOT_FOUND: ReadonlySet<number> = new Set([2307, 2792]);
const SDK_SPECIFIER = /['"](@shrkcrft\/[^'"]+)['"]/;

/**
 * A pack that imports the SharkCraft SDK (`@shrkcrft/*`) from a tree where it
 * is not installed (a fresh `packs new` scaffold before `npm install`) cannot
 * be type-checked: every SDK type is unresolved, so the diagnostics are the
 * missing devDependency — cascading into implicit-any errors — not defects in
 * the pack. That run examined nothing trustworthy: report it as NOT run (a
 * not-verified outcome for every caller), never as pack errors.
 */
function sdkUnresolved(result: ITypecheckFilesResult, packageRoot: string): ITypecheckFilesResult | undefined {
  if (!result.ran) return undefined;
  const missing = new Set<string>();
  for (const e of result.errors) {
    if (!MODULE_NOT_FOUND.has(e.code)) continue;
    const m = SDK_SPECIFIER.exec(e.message);
    if (m) missing.add(m[1]!);
  }
  if (missing.size === 0) return undefined;
  return {
    ran: false,
    errors: [],
    checkedFiles: result.checkedFiles,
    tsconfigPath: result.tsconfigPath,
    note:
      `SDK not installed — ${[...missing].sort().join(', ')} cannot be resolved from ${packageRoot}, so the ` +
      `${result.errors.length} diagnostic(s) it produced are withheld; run \`npm install\` in the pack and re-run — typecheck NOT verified`,
  };
}
