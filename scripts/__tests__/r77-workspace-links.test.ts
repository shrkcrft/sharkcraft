/**
 * Round 13 (13.2) — the ONE workspace-link check, scripts/lib/workspace-links.ts.
 *
 * A green build could emit a runtime-broken CLI: tsc and Bun resolve every
 * @shrkcrft/* import through tsconfig paths, so neither `bun run build` nor
 * `bun run build:dist` ever consulted the per-package links Node resolves the
 * emitted dist through. These tests build REAL workspaces on disk — manifests,
 * src files, and relative symlinks laid out exactly as `bun install` lays them
 * out (packages/<p>/node_modules/@shrkcrft/<dep> → ../../../<dep>) — and pin
 * every state: linked, missing link, wrong link, undeclared import,
 * devDependencies-only import, and the warning for a link no manifest declares.
 * The real repository is held to 0 problems and the fast import scanner to a
 * full-AST census of it; the build scripts must refuse before any tsc runs; and
 * the build's sentence must be the one the bin bootstrap prints at runtime.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { checkWorkspaceLinks, runWorkspaceLinkGate, type IWorkspaceLinkGateIo } from '../lib/workspace-links.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SPAWN_TIMEOUT_MS = 60_000;
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

interface IFixturePackage {
  readonly manifest?: Record<string, unknown>;
  readonly files?: Record<string, string>;
}

/** A real workspace: <root>/package.json (workspaces: packages/*), packages/<short> named `@shrkcrft/<short>`. */
function workspace(packages: Record<string, IFixturePackage>): string {
  const root = tempDir('r77-links-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r77-fixture', private: true, workspaces: ['packages/*'] }));
  for (const [short, pkg] of Object.entries(packages)) {
    const dir = join(root, 'packages', short);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `@shrkcrft/${short}`, version: '0.0.0', type: 'module', ...pkg.manifest }),
    );
    for (const [rel, text] of Object.entries(pkg.files ?? { 'src/index.ts': 'export const value = 1;\n' })) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  }
  return root;
}

/** The link `bun install` creates: packages/<from>/node_modules/@shrkcrft/<dep> → ../../../<dep>. */
function link(root: string, from: string, dep: string, target = `../../../${dep}`): void {
  const scope = join(root, 'packages', from, 'node_modules', '@shrkcrft');
  mkdirSync(scope, { recursive: true });
  symlinkSync(target, join(scope, dep));
}

function unlinked(dep: string, neededBy: string, root: string): string {
  return `workspace dependency ${dep} (needed by ${neededBy}) is not linked — run \`bun install\` in ${root}`;
}

const DEPENDS_ON_B = { dependencies: { '@shrkcrft/b': 'workspace:*' } };
const IMPORTS_B = { 'src/index.ts': "import { value } from '@shrkcrft/b';\nexport const a = value;\n" };

function capture(): IWorkspaceLinkGateIo & { readonly out_: string[]; readonly err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return { out: (t) => void out_.push(t), err: (t) => void err_.push(t), out_, err_ };
}

describe('rule 1 — every runtime workspace: pin is linked to the workspace package itself', () => {
  test('linked: a pin whose link resolves to the workspace package is clean', () => {
    const root = workspace({ a: { manifest: DEPENDS_ON_B, files: IMPORTS_B }, b: {} });
    link(root, 'a', 'b');
    const report = checkWorkspaceLinks(root);
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect({ packages: report.packages, pins: report.pins, imports: report.imports }).toEqual({
      packages: 2,
      pins: 1,
      imports: 1,
    });
    expect(report.root).toBe(root);
  });

  test('missing link: named, with the package that needs it and where to run the install', () => {
    const root = workspace({ a: { manifest: DEPENDS_ON_B, files: IMPORTS_B }, b: {} });
    expect(checkWorkspaceLinks(root).problems).toEqual([unlinked('@shrkcrft/b', '@shrkcrft/a', root)]);
  });

  test('a link to the wrong directory is a problem, never a pass', () => {
    const root = workspace({ a: { manifest: DEPENDS_ON_B, files: IMPORTS_B }, b: {} });
    const impostor = join(root, 'elsewhere', 'b');
    mkdirSync(impostor, { recursive: true });
    writeFileSync(join(impostor, 'package.json'), JSON.stringify({ name: '@shrkcrft/b', version: '9.9.9' }));
    link(root, 'a', 'b', impostor);
    expect(checkWorkspaceLinks(root).problems).toEqual([
      `workspace dependency @shrkcrft/b (needed by @shrkcrft/a) resolves to ${impostor}, not the workspace package ` +
        `packages/b — run \`bun install\` in ${root}`,
    ]);
  });

  test('peerDependencies and optionalDependencies pins are link-checked too; devDependencies pins are not', () => {
    for (const section of ['peerDependencies', 'optionalDependencies'] as const) {
      const root = workspace({ a: { manifest: { [section]: { '@shrkcrft/b': 'workspace:^' } } }, b: {} });
      expect(checkWorkspaceLinks(root).problems).toEqual([unlinked('@shrkcrft/b', '@shrkcrft/a', root)]);
    }
    const dev = workspace({ a: { manifest: { devDependencies: { '@shrkcrft/b': 'workspace:*' } } }, b: {} });
    expect(checkWorkspaceLinks(dev).problems).toEqual([]);
  });

  test('a private package is checked like any other (dashboard is private-by-bundle, not exempt)', () => {
    const root = workspace({ dashboard: { manifest: { private: true, ...DEPENDS_ON_B } }, b: {} });
    expect(checkWorkspaceLinks(root).problems).toEqual([unlinked('@shrkcrft/b', '@shrkcrft/dashboard', root)]);
  });

  test('a workspace: pin naming no workspace package is a problem', () => {
    const root = workspace({ a: { manifest: { dependencies: { '@shrkcrft/ghost': 'workspace:*' } } } });
    expect(checkWorkspaceLinks(root).problems).toEqual([
      '@shrkcrft/a pins @shrkcrft/ghost as "workspace:*" in dependencies, but no workspace package has that name — fix packages/a/package.json',
    ]);
  });

  test('a link no manifest declares is a WARNING (a leftover that can mask an undeclared import), never a problem', () => {
    const root = workspace({ a: {}, b: {} });
    link(root, 'b', 'a');
    const report = checkWorkspaceLinks(root);
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([
      '@shrkcrft/a is linked into packages/b/node_modules, but @shrkcrft/b does not declare it — ' +
        'a leftover link can silently satisfy an undeclared import (delete the link, or declare the dependency)',
    ]);
  });
});

describe('rule 2 — every bare workspace-package import in non-test src is declared at runtime', () => {
  test('an undeclared import is named with its file:line and the manifest to fix', () => {
    const root = workspace({
      a: { files: { 'src/x.ts': "export const k = 1;\n\nimport { value } from '@shrkcrft/b';\n" } },
      b: {},
    });
    expect(checkWorkspaceLinks(root).problems).toEqual([
      '@shrkcrft/a imports @shrkcrft/b (packages/a/src/x.ts:3) but does not declare it — ' +
        'add "@shrkcrft/b": "workspace:*" to "dependencies" in packages/a/package.json',
    ]);
  });

  test('declared only in devDependencies fails, even with the link present (it compiles through the link)', () => {
    const root = workspace({ a: { manifest: { devDependencies: { '@shrkcrft/b': 'workspace:*' } }, files: IMPORTS_B }, b: {} });
    link(root, 'a', 'b');
    const report = checkWorkspaceLinks(root);
    expect(report.warnings).toEqual([]);
    expect(report.problems).toEqual([
      '@shrkcrft/a imports @shrkcrft/b (packages/a/src/index.ts:1) but declares it only in devDependencies — ' +
        'a src import ships in dist/, so move it to "dependencies" (or "peerDependencies") in packages/a/package.json',
    ]);
  });

  test('a peerDependencies or optionalDependencies declaration satisfies the rule', () => {
    for (const section of ['peerDependencies', 'optionalDependencies'] as const) {
      const root = workspace({ a: { manifest: { [section]: { '@shrkcrft/b': 'workspace:*' } }, files: IMPORTS_B }, b: {} });
      link(root, 'a', 'b');
      expect(checkWorkspaceLinks(root).problems).toEqual([]);
    }
  });

  test('every import shape counts: static, type-only, re-export, literal dynamic, require, typeof import, subpath', () => {
    const shapes = [
      "import { value } from '@shrkcrft/b';",
      "import type { IValue } from '@shrkcrft/b';",
      "export { value } from '@shrkcrft/b';",
      "export * from '@shrkcrft/b';",
      "export type { IValue } from '@shrkcrft/b';",
      "export const load = async () => await import('@shrkcrft/b');",
      "declare const require: (s: string) => unknown;\nexport const m = require('@shrkcrft/b');",
      "export type T = typeof import('@shrkcrft/b');",
      "import '@shrkcrft/b/deep/path.js';",
      "import b = require('@shrkcrft/b');\nexport { b };",
      // A token scanner (ts.preProcessFile) loses sync on this template literal —
      // a substitution holding a quote-bearing regex — and misses every dynamic
      // import after it (6 in packages/cli/src/commands/bundle.command.ts).
      "export const q = (s: string): string => `'${s.replace(/'/g, `'\\\\''`)}'`;\n" +
        "export const load = async () => await import('@shrkcrft/b');",
    ];
    for (const shape of shapes) {
      const root = workspace({ a: { files: { 'src/index.ts': `${shape}\n` } }, b: {} });
      const problems = checkWorkspaceLinks(root).problems;
      expect({ shape, problems: problems.length }).toEqual({ shape, problems: 1 });
      expect(problems[0]).toContain('@shrkcrft/a imports @shrkcrft/b (packages/a/src/');
    }
  });

  test('repeat imports of one package collapse into one problem that counts the rest', () => {
    const root = workspace({
      a: { files: { 'src/one.ts': "import '@shrkcrft/b';\n", 'src/two.ts': "import '@shrkcrft/b';\nimport '@shrkcrft/b';\n" } },
      b: {},
    });
    expect(checkWorkspaceLinks(root).problems).toEqual([
      '@shrkcrft/a imports @shrkcrft/b (packages/a/src/one.ts:1, and 2 more) but does not declare it — ' +
        'add "@shrkcrft/b": "workspace:*" to "dependencies" in packages/a/package.json',
    ]);
  });

  test('tests, comments, strings, self-references and non-workspace packages are not imports it judges', () => {
    const root = workspace({
      a: {
        files: {
          'src/index.ts': [
            "// import '@shrkcrft/b';",
            "/* export * from '@shrkcrft/b'; */",
            "export const s = \"import '@shrkcrft/b'\";",
            "export { x } from '@shrkcrft/a';",
            "import 'zod';",
            "import { readFileSync } from 'node:fs';",
            "export { readFileSync };",
          ].join('\n'),
          'src/__tests__/a.test.ts': "import '@shrkcrft/b';\n",
          'src/unit.test.ts': "import '@shrkcrft/b';\n",
          'src/unit.spec.ts': "import '@shrkcrft/b';\n",
          'src/dist/stale.js': "import '@shrkcrft/b';\n",
        },
      },
      b: {},
    });
    expect(checkWorkspaceLinks(root).problems).toEqual([]);
  });
});

describe('the gate the build scripts call', () => {
  test('runWorkspaceLinkGate: 1 with every problem on stderr under the tag; 0 with one summary line on stdout', () => {
    const broken = workspace({ a: { manifest: DEPENDS_ON_B, files: IMPORTS_B }, b: {} });
    const bad = capture();
    expect(runWorkspaceLinkGate(broken, '[build]', bad)).toBe(1);
    expect(bad.out_).toEqual([]);
    expect(bad.err_[0]).toBe(`[build] ${unlinked('@shrkcrft/b', '@shrkcrft/a', broken)}\n`);
    expect(bad.err_.at(-1)).toContain('dies under node at load time (ERR_MODULE_NOT_FOUND)');

    link(broken, 'a', 'b');
    const good = capture();
    expect(runWorkspaceLinkGate(broken, '[build]', good)).toBe(0);
    expect(good.err_).toEqual([]);
    expect(good.out_.join('')).toMatch(/^\[build\] workspace links ok — 1 workspace pin\(s\) linked across 2 package\(s\); 1 workspace import\(s\) in 2 src file\(s\) declared \(\d+ms\)\n$/);
  });

  test(
    '`bun run build` (scripts/build.ts) exits 1 with the message before any package is typechecked',
    () => {
      const root = workspace({ a: { manifest: DEPENDS_ON_B, files: IMPORTS_B }, b: {} });
      const res = spawnSync('bun', [join(REPO_ROOT, 'scripts/build.ts')], { cwd: root, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`[build] ${unlinked('@shrkcrft/b', '@shrkcrft/a', root)}`);
      expect(res.stdout).not.toContain('[build] a\n');
      expect(res.stdout).not.toContain('[build] ok');
      link(root, 'a', 'b');
      const ok = spawnSync('bun', [join(REPO_ROOT, 'scripts/build.ts')], { cwd: root, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('[build] workspace links ok');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`bun run build:dist` (scripts/build-dist.ts) exits 1 with the message before anything is emitted or wiped',
    () => {
      const root = workspace({ a: { manifest: DEPENDS_ON_B, files: IMPORTS_B }, b: {} });
      mkdirSync(join(root, 'packages/a/dist'), { recursive: true });
      writeFileSync(join(root, 'packages/a/dist/index.js'), '// a previous build\n');
      const res = spawnSync('bun', [join(REPO_ROOT, 'scripts/build-dist.ts')], { cwd: root, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`[build-dist] ${unlinked('@shrkcrft/b', '@shrkcrft/a', root)}`);
      expect(res.stdout).not.toContain('(deps:');
      expect(existsSync(join(root, 'packages/a/tsconfig.build.json'))).toBe(false);
      expect(readFileSync(join(root, 'packages/a/dist/index.js'), 'utf8')).toBe('// a previous build\n');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`bun scripts/lib/workspace-links.ts` runs the gate on the cwd: 1 broken, 0 linked',
    () => {
      const root = workspace({ a: { manifest: DEPENDS_ON_B, files: IMPORTS_B }, b: {} });
      const run = (): ReturnType<typeof spawnSync> =>
        spawnSync('bun', [join(REPO_ROOT, 'scripts/lib/workspace-links.ts')], { cwd: root, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
      const broken = run();
      expect(broken.status).toBe(1);
      expect(String(broken.stderr)).toContain(`[workspace-links] ${unlinked('@shrkcrft/b', '@shrkcrft/a', root)}`);
      link(root, 'a', 'b');
      expect(run().status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});

/** Transpile the REAL cli bootstrap (entry + its ./bootstrap module) into `outDir`, as build-dist emits it. */
function emitCliBootstrap(outDir: string): void {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['packages/cli/src/shrk.ts', 'shrk.js'],
    ['packages/cli/src/bootstrap/unlinked-workspace-dependency.ts', 'bootstrap/unlinked-workspace-dependency.js'],
  ];
  for (const [from, to] of pairs) {
    const source = readFileSync(join(REPO_ROOT, from), 'utf8');
    const out = ts.transpileModule(source, {
      fileName: from,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true },
    });
    mkdirSync(dirname(join(outDir, to)), { recursive: true });
    writeFileSync(join(outDir, to), out.outputText);
  }
}

describe('one sentence, build time and run time', () => {
  test(
    'the build refuses a missing link with exactly the line the bin bootstrap prints (exit 70) at runtime',
    () => {
      const root = workspace({ a: { manifest: DEPENDS_ON_B, files: IMPORTS_B }, b: {} });
      const [problem] = checkWorkspaceLinks(root).problems;
      expect(problem).toBe(unlinked('@shrkcrft/b', '@shrkcrft/a', root));
      const dist = join(root, 'packages/a/dist');
      emitCliBootstrap(dist);
      writeFileSync(join(dist, 'main.js'), "import '@shrkcrft/b';\n");
      const res = spawnSync('node', [join(dist, 'shrk.js'), '--version'], {
        cwd: tempDir('r77-consumer-'),
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(res.status).toBe(70);
      expect(res.stdout).toBe('');
      expect(res.stderr).toBe(`shrk: ${problem}\n`);
    },
    SPAWN_TIMEOUT_MS,
  );
});

/** A full-AST census of bare workspace-package imports in non-test src — the oracle for the fast scanner. */
function astWorkspaceImportCount(root: string): number {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] };
  const names = new Set<string>();
  const checked: Array<{ dir: string; name: string }> = [];
  for (const glob of manifest.workspaces ?? []) {
    const parent = glob.replace(/\/\*$/, '');
    for (const entry of readdirSync(join(root, parent))) {
      const pkgJson = join(root, parent, entry, 'package.json');
      if (!existsSync(pkgJson)) continue;
      const name = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { name: string }).name;
      names.add(name);
      if (parent === 'packages') checked.push({ dir: join(root, parent, entry), name });
    }
  }
  const packageOf = (spec: string): string | undefined => {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.includes(':')) return undefined;
    const parts = spec.split('/');
    return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  };
  let count = 0;
  for (const pkg of checked) {
    const stack = [join(pkg.dir, 'src')];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['__tests__', 'node_modules', 'dist'].includes(entry.name)) stack.push(full);
          continue;
        }
        if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
        const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, false);
        const visit = (node: ts.Node): void => {
          let spec: ts.Node | undefined;
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) spec = node.moduleSpecifier;
          else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            spec = node.moduleReference.expression;
          } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          ) {
            spec = node.arguments[0];
          } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            spec = node.argument.literal;
          }
          if (spec !== undefined && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
            const name = packageOf(spec.text);
            if (name !== undefined && name !== pkg.name && names.has(name)) count += 1;
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  }
  return count;
}

describe('the repository itself', () => {
  test('0 problems: every runtime workspace pin is linked and every src import of a workspace package is declared', () => {
    const report = checkWorkspaceLinks(REPO_ROOT);
    expect(report.problems).toEqual([]);
    expect(report.packages).toBeGreaterThanOrEqual(30);
    expect(report.pins).toBeGreaterThanOrEqual(100);
    expect(report.imports).toBeGreaterThan(500);
  });

  test('its import census equals an independent full-AST census of the repository (no shape, file or package missed)', () => {
    expect(checkWorkspaceLinks(REPO_ROOT).imports).toBe(astWorkspaceImportCount(REPO_ROOT));
  });
});
