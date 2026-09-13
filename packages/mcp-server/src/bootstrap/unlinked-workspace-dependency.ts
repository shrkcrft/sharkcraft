/**
 * The bin bootstrap's one diagnosis (round 13, 13.2): is this load failure a
 * workspace dependency of the installed tool that is not linked?
 *
 * A missing `@shrkcrft/*` link kills the emitted CLI (and the MCP server) at
 * ESM LINK time — before `main.js` evaluates a line, so its `Fatal:` handler
 * never runs and Node prints a raw resolver stack naming a `dist/` file. The
 * bootstrap dynamic-imports the entry, and this function turns that one error
 * into the sentence the build's link check prints (scripts/lib/workspace-links.ts):
 *
 *   shrk: workspace dependency @shrkcrft/x (needed by @shrkcrft/y) is not linked — run `bun install` in <root>
 *
 * Two real shapes are recognised: Node's `Cannot find package '@shrkcrft/x'
 * imported from <file>`, and Bun's `Cannot find module '@shrkcrft/x' from
 * '<file>'` — a bare package name only, because Bun reports a missing SUBPATH
 * of a linked package the same way. Anything else returns `undefined`, and the
 * bootstrap rethrows it untouched.
 *
 * node: builtins ONLY — never an `@shrkcrft` import, not even core: the package
 * it would import could be the one whose link is missing. That is also why the
 * MCP server carries a byte-identical copy of this file instead of importing
 * it; r77-bootstrap-rewrite.test.ts locks the two copies together.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Node: the package directory itself was not found from the importing file. */
const NODE_UNLINKED = /^Cannot find package '(@shrkcrft\/[^'/]+)' imported from (.+)$/;
/** Bun: honoured for a bare package name only (see the module comment). */
const BUN_UNLINKED = /^Cannot find module '(@shrkcrft\/[^'/]+)' from '(.+)'$/;

/**
 * The one-line message for an unlinked workspace dependency, or `undefined`
 * for any other error. Pure over its inputs: `locate` maps the importing file
 * to the package that needs the dependency and the directory the install runs
 * in; the default reads the nearest package.json files on disk.
 */
export function unlinkedWorkspaceDependencyMessage(
  error: unknown,
  locate: (importerFile: string) => { readonly packageName?: string; readonly toolRoot: string } = locateInstall,
): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { readonly code?: unknown; readonly message?: unknown };
  if (code !== 'ERR_MODULE_NOT_FOUND' || typeof message !== 'string') return undefined;
  const firstLine = message.split('\n', 1)[0] ?? '';
  const match = NODE_UNLINKED.exec(firstLine) ?? BUN_UNLINKED.exec(firstLine);
  const dependency = match?.[1];
  const importer = match?.[2];
  if (dependency === undefined || importer === undefined) return undefined;
  const importerFile = importer.startsWith('file:') ? fileURLToPath(importer) : importer;
  const { packageName, toolRoot } = locate(importerFile);
  return (
    `shrk: workspace dependency ${dependency} (needed by ${packageName ?? importerFile}) ` +
    `is not linked — run \`bun install\` in ${toolRoot}`
  );
}

/** The package owning `importerFile` (its nearest package.json) and where its install runs. */
function locateInstall(importerFile: string): { readonly packageName?: string; readonly toolRoot: string } {
  for (let dir = dirname(importerFile); ; ) {
    const manifest = readManifest(join(dir, 'package.json'));
    if (manifest !== undefined) {
      const toolRoot = installRootOf(dir);
      return typeof manifest.name === 'string' ? { packageName: manifest.name, toolRoot } : { toolRoot };
    }
    const parent = dirname(dir);
    if (parent === dir) return { toolRoot: dirname(importerFile) };
    dir = parent;
  }
}

/**
 * Where the install that links `packageDir`'s dependencies runs: the directory
 * holding the OUTERMOST `node_modules` when the package is installed (a
 * consumer repo, a global prefix), else the nearest workspace root — a
 * package.json declaring `workspaces`, i.e. the tool's own checkout.
 */
function installRootOf(packageDir: string): string {
  const at = packageDir.indexOf(`${sep}node_modules${sep}`);
  if (at >= 0) return at === 0 ? sep : packageDir.slice(0, at);
  for (let dir = packageDir; ; ) {
    const manifest = readManifest(join(dir, 'package.json'));
    if (manifest?.workspaces !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) return packageDir;
    dir = parent;
  }
}

/** A package.json's fields, `{}` when it exists but does not parse, `undefined` when absent. */
function readManifest(path: string): { readonly name?: unknown; readonly workspaces?: unknown } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
