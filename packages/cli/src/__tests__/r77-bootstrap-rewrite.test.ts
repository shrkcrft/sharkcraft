/**
 * Round 13 (13.2) — the bin bootstrap's one diagnosis, as a pure function over
 * REAL error shapes: each is captured from node or bun resolving a real missing
 * package on disk, never typed out by hand. Plus the locks that keep the
 * bootstrap honest: the CLI and MCP copies are byte-identical, the bootstrap
 * imports node: builtins only (and its entry), and both bins point at it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { unlinkedWorkspaceDependencyMessage } from '../bootstrap/unlinked-workspace-dependency.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const TIMEOUT_MS = 60_000;
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A real tree on disk; returns its realpath (the path node and bun report). */
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r77-boot-')));
  created.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** What node raises importing `entry`: its real `code` and `message`, on an Error as node throws it. */
function nodeError(entry: string): Error & { code?: string } {
  const res = spawnSync(
    'node',
    [
      '-e',
      "import(require('node:url').pathToFileURL(process.argv[1]).href).then(" +
        "() => process.stdout.write('null'), (e) => process.stdout.write(JSON.stringify({ code: e.code, message: e.message })))",
      entry,
    ],
    { encoding: 'utf8', timeout: TIMEOUT_MS },
  );
  const shape = JSON.parse(res.stdout) as { code: string; message: string } | null;
  if (shape === null) throw new Error(`node imported ${entry} without an error`);
  return Object.assign(new Error(shape.message), { code: shape.code });
}

/** The object bun itself throws importing `entry` — a ResolveMessage, not an Error instance. */
async function bunError(entry: string): Promise<unknown> {
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    return error;
  }
  throw new Error(`bun imported ${entry} without an error`);
}

/** The tool's own checkout: a workspace root whose packages/app/dist/runner/entry.js imports `specifier`. */
function workspaceImporting(specifier: string): { root: string; entry: string } {
  const root = tree({
    'package.json': JSON.stringify({ name: 'tool-root', private: true, workspaces: ['packages/*'] }),
    'packages/app/package.json': JSON.stringify({ name: '@shrkcrft/app', type: 'module' }),
    'packages/app/dist/runner/entry.js': `import '${specifier}';\n`,
  });
  return { root, entry: join(root, 'packages/app/dist/runner/entry.js') };
}

const expected = (dep: string, owner: string, root: string): string =>
  `shrk: workspace dependency ${dep} (needed by ${owner}) is not linked — run \`bun install\` in ${root}`;

describe('rewritten: an unlinked @shrkcrft package, in the shape each runtime really throws', () => {
  test('node: `Cannot find package \'@shrkcrft/x\' imported from <file>`', () => {
    const { root, entry } = workspaceImporting('@shrkcrft/zzz');
    const error = nodeError(entry);
    expect(error.message).toBe(`Cannot find package '@shrkcrft/zzz' imported from ${entry}`);
    expect(unlinkedWorkspaceDependencyMessage(error)).toBe(expected('@shrkcrft/zzz', '@shrkcrft/app', root));
  });

  test('node: a subpath import of a missing package names the package (node reports the package)', () => {
    const { root, entry } = workspaceImporting('@shrkcrft/zzz/deep/x.js');
    expect(unlinkedWorkspaceDependencyMessage(nodeError(entry))).toBe(expected('@shrkcrft/zzz', '@shrkcrft/app', root));
  });

  test('bun: `Cannot find module \'@shrkcrft/x\' from \'<file>\'` (a ResolveMessage)', async () => {
    const { root, entry } = workspaceImporting('@shrkcrft/zzz');
    const error = await bunError(entry);
    expect(error instanceof Error).toBe(false);
    expect((error as { code?: unknown }).code).toBe('ERR_MODULE_NOT_FOUND');
    expect(unlinkedWorkspaceDependencyMessage(error)).toBe(expected('@shrkcrft/zzz', '@shrkcrft/app', root));
  });

  test('an installed tool: the install root is the directory holding the OUTERMOST node_modules', () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'consumer' }),
      'node_modules/@shrkcrft/cli/package.json': JSON.stringify({ name: '@shrkcrft/cli', type: 'module' }),
      'node_modules/@shrkcrft/cli/dist/main.js': "import '@shrkcrft/zzz';\n",
      'node_modules/@shrkcrft/cli/node_modules/@shrkcrft/fs/package.json': JSON.stringify({ name: '@shrkcrft/fs', type: 'module' }),
      'node_modules/@shrkcrft/cli/node_modules/@shrkcrft/fs/dist/x.js': "import '@shrkcrft/zzz';\n",
    });
    expect(unlinkedWorkspaceDependencyMessage(nodeError(join(root, 'node_modules/@shrkcrft/cli/dist/main.js')))).toBe(
      expected('@shrkcrft/zzz', '@shrkcrft/cli', root),
    );
    expect(
      unlinkedWorkspaceDependencyMessage(nodeError(join(root, 'node_modules/@shrkcrft/cli/node_modules/@shrkcrft/fs/dist/x.js'))),
    ).toBe(expected('@shrkcrft/zzz', '@shrkcrft/fs', root));
  });

  test('an owning package.json that does not parse: bun still reports the missing package, and the importer path stands in for the name', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'tool-root', workspaces: ['packages/*'] }),
      'packages/app/package.json': '{ not json',
      'packages/app/dist/entry.mjs': "import '@shrkcrft/zzz';\n",
    });
    const entry = join(root, 'packages/app/dist/entry.mjs');
    expect(unlinkedWorkspaceDependencyMessage(await bunError(entry))).toBe(expected('@shrkcrft/zzz', entry, root));
    // node refuses the malformed manifest itself (ERR_INVALID_PACKAGE_CONFIG) — not a link problem, left alone.
    const nodeShape = nodeError(entry);
    expect(nodeShape.code).toBe('ERR_INVALID_PACKAGE_CONFIG');
    expect(unlinkedWorkspaceDependencyMessage(nodeShape)).toBeUndefined();
  });

  test('pure over `locate`: it receives the importing file exactly, and its answer is used verbatim', () => {
    const { entry } = workspaceImporting('@shrkcrft/zzz');
    const seen: string[] = [];
    const locate = (file: string): { packageName: string; toolRoot: string } => {
      seen.push(file);
      return { packageName: '@shrkcrft/owner', toolRoot: '/the/root' };
    };
    expect(unlinkedWorkspaceDependencyMessage(nodeError(entry), locate)).toBe(expected('@shrkcrft/zzz', '@shrkcrft/owner', '/the/root'));
    expect(seen).toEqual([entry]);
    const nameless = unlinkedWorkspaceDependencyMessage(nodeError(entry), () => ({ toolRoot: '/r' }));
    expect(nameless).toBe(expected('@shrkcrft/zzz', entry, '/r'));
  });
});

describe('everything else is left alone (undefined — the bootstrap rethrows it untouched)', () => {
  test('a missing third-party package, in both runtimes', async () => {
    const { entry } = workspaceImporting('left-pad-zzz');
    expect(unlinkedWorkspaceDependencyMessage(nodeError(entry))).toBeUndefined();
    expect(unlinkedWorkspaceDependencyMessage(await bunError(entry))).toBeUndefined();
  });

  test('a missing relative file, in both runtimes', async () => {
    const { entry } = workspaceImporting('./missing.js');
    const error = nodeError(entry);
    expect(error.code).toBe('ERR_MODULE_NOT_FOUND');
    expect(unlinkedWorkspaceDependencyMessage(error)).toBeUndefined();
    expect(unlinkedWorkspaceDependencyMessage(await bunError(entry))).toBeUndefined();
  });

  test('a linked package that does not export the subpath (node ERR_PACKAGE_PATH_NOT_EXPORTED; bun reports the subpath)', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'tool-root', workspaces: ['packages/*'] }),
      'packages/app/package.json': JSON.stringify({ name: '@shrkcrft/app', type: 'module' }),
      'packages/app/dist/entry.js': "import '@shrkcrft/yyy/deep';\n",
      'packages/app/node_modules/@shrkcrft/yyy/package.json': JSON.stringify({
        name: '@shrkcrft/yyy',
        type: 'module',
        exports: { '.': './index.js' },
      }),
      'packages/app/node_modules/@shrkcrft/yyy/index.js': 'export const y = 1;\n',
    });
    const entry = join(root, 'packages/app/dist/entry.js');
    const error = nodeError(entry);
    expect(error.code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(unlinkedWorkspaceDependencyMessage(error)).toBeUndefined();
    expect(unlinkedWorkspaceDependencyMessage(await bunError(entry))).toBeUndefined();
  });

  test('a bun subpath report is ambiguous (a missing package or a missing subpath) and is not rewritten', async () => {
    const { entry } = workspaceImporting('@shrkcrft/zzz/deep/x.js');
    expect(unlinkedWorkspaceDependencyMessage(await bunError(entry))).toBeUndefined();
  });

  test('values that are not a module-not-found error', () => {
    for (const value of [undefined, null, 'Cannot find package', 42, new Error('boom'), { code: 'ERR_MODULE_NOT_FOUND' }]) {
      expect(unlinkedWorkspaceDependencyMessage(value)).toBeUndefined();
    }
    expect(unlinkedWorkspaceDependencyMessage({ code: 'ERR_MODULE_NOT_FOUND', message: 7 })).toBeUndefined();
  });
});

describe('the bootstrap stays a bootstrap', () => {
  const PAIRS = [
    ['packages/cli/src/bootstrap/unlinked-workspace-dependency.ts', 'packages/mcp-server/src/bootstrap/unlinked-workspace-dependency.ts'],
    ['packages/cli/src/shrk.ts', 'packages/mcp-server/src/shrk-mcp.ts'],
  ] as const;

  test('the CLI and MCP copies are byte-identical (they cannot share one through a package import)', () => {
    for (const [cli, mcp] of PAIRS) {
      expect({ file: mcp, same: readFileSync(join(REPO_ROOT, mcp), 'utf8') === readFileSync(join(REPO_ROOT, cli), 'utf8') }).toEqual({
        file: mcp,
        same: true,
      });
    }
  });

  test('node: builtins only — the entry imports its ./bootstrap module and ./main, the module imports node:* alone', () => {
    const importsOf = (rel: string): string[] =>
      ts.preProcessFile(readFileSync(join(REPO_ROOT, rel), 'utf8'), true, true).importedFiles.map((f) => f.fileName);
    for (const entry of ['packages/cli/src/shrk.ts', 'packages/mcp-server/src/shrk-mcp.ts']) {
      expect(importsOf(entry).sort()).toEqual(['./bootstrap/unlinked-workspace-dependency.ts', './main.ts']);
    }
    for (const [cli, mcp] of PAIRS.slice(0, 1)) {
      for (const rel of [cli, mcp]) {
        const specifiers = importsOf(rel);
        expect(specifiers.length).toBeGreaterThan(0);
        expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
      }
    }
  });

  test('both bins point at the bootstrap build-dist emits from src/<bin>.ts (rootDir src → outDir dist)', () => {
    const bins: Record<string, Record<string, string>> = {
      'packages/cli/package.json': { shrk: './dist/shrk.js' },
      'packages/mcp-server/package.json': { 'shrk-mcp': './dist/shrk-mcp.js' },
    };
    for (const [manifest, bin] of Object.entries(bins)) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8')) as { bin?: unknown; files?: string[] };
      expect(pkg.bin).toEqual(bin);
      expect(pkg.files).toContain('dist');
      for (const target of Object.values(bin)) {
        const source = join(REPO_ROOT, dirname(manifest), target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'));
        expect({ source, exists: existsSync(source) }).toEqual({ source, exists: true });
      }
    }
  });

  test('exit 70 is documented next to 78 in docs/exit-codes.md', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/exit-codes.md'), 'utf8');
    const rows = doc.split('\n').filter((l) => /^\| `(?:70|78)` \|/.test(l));
    expect(rows.map((r) => r.slice(0, 7))).toEqual(['| `78` ', '| `70` ']);
    expect(doc).toContain('## `70` — ');
  });
});
