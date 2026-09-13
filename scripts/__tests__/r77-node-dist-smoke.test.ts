/**
 * Round 13 (13.2) — the node-facing release gate, wired where DECISIONS §7
 * requires it and able to fail.
 *
 * Every Bun-run step resolves @shrkcrft/* through tsconfig paths, so the only
 * step that sees a missing workspace link is one that runs the EMITTED dist
 * under node. The review found release:preflight without that step while the
 * docs and changelog said it was there: these tests read the real step lists
 * (a TypeScript parse of the scripts, and ci.yml) so a dropped or reordered
 * step fails here, and run the REAL scripts/node-dist-smoke.ts over a
 * synthetic tree — the real bin bootstraps transpiled as build-dist emits them
 * — so a smoke that cannot fail fails here too.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const TIMEOUT_MS = 60_000;
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

interface IStepLiteral {
  readonly name?: string;
  readonly required?: boolean;
  readonly args?: readonly string[];
  /** An in-process `run: () => …` step. */
  readonly inProcess: boolean;
}

/** The object-literal elements of `const STEPS = [...]` in `rel` (spread, opt-in steps are skipped). */
function stepsOf(rel: string): IStepLiteral[] {
  const source = ts.createSourceFile(rel, readFileSync(join(REPO_ROOT, rel), 'utf8'), ts.ScriptTarget.Latest, true);
  const steps: IStepLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'STEPS' &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        let name: string | undefined;
        let required: boolean | undefined;
        let args: string[] | undefined;
        let inProcess = false;
        for (const property of element.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          const value = property.initializer;
          if (property.name.text === 'name' && ts.isStringLiteral(value)) name = value.text;
          if (property.name.text === 'required') required = value.kind === ts.SyntaxKind.TrueKeyword;
          if (property.name.text === 'args' && ts.isArrayLiteralExpression(value)) {
            args = value.elements.filter(ts.isStringLiteral).map((e) => e.text);
          }
          if (property.name.text === 'run') inProcess = true;
        }
        steps.push({ ...(name !== undefined ? { name } : {}), ...(required !== undefined ? { required } : {}), ...(args ? { args } : {}), inProcess });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return steps;
}

describe('the node-facing gates are wired where DECISIONS §7 puts them', () => {
  test('release:preflight: REQUIRED workspace-links before tests, REQUIRED node-dist-smoke right after build-dist', () => {
    const steps = stepsOf('scripts/release-preflight.ts');
    const names = steps.map((s) => s.name);
    const links = steps.find((s) => s.name === 'workspace-links');
    expect(links).toMatchObject({ required: true, inProcess: true });
    expect(names.indexOf('workspace-links')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('workspace-links')).toBeLessThan(names.indexOf('tests'));
    const smoke = steps.find((s) => s.name === 'node-dist-smoke');
    expect(smoke).toMatchObject({ required: true, args: ['run', 'scripts/node-dist-smoke.ts'] });
    expect(names.indexOf('build-dist')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('node-dist-smoke')).toBe(names.indexOf('build-dist') + 1);
  });

  test('release:dry-run runs node-dist-smoke right after build-dist', () => {
    const names = stepsOf('scripts/release-dry-run.ts').map((s) => s.name);
    expect(names.indexOf('build-dist')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('node-dist-smoke')).toBe(names.indexOf('build-dist') + 1);
  });

  test('release:preflight typechecks scripts/** (K12): a REQUIRED typecheck-scripts step right after typecheck, over tsconfig.scripts.json', () => {
    const steps = stepsOf('scripts/release-preflight.ts');
    const names = steps.map((s) => s.name);
    expect(steps.find((s) => s.name === 'typecheck-scripts')).toMatchObject({
      required: true,
      args: ['x', 'tsc', '-p', 'tsconfig.scripts.json', '--noEmit'],
    });
    expect(names.indexOf('typecheck')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('typecheck-scripts')).toBe(names.indexOf('typecheck') + 1);
    // The base config excludes scripts/** (its include is packages/*/src, examples, tools) — the
    // scripts config is what covers them, and CI runs it too.
    const base = JSON.parse(readFileSync(join(REPO_ROOT, 'tsconfig.base.json'), 'utf8')) as { include: string[] };
    expect(base.include.some((g) => g.startsWith('scripts'))).toBe(false);
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'tsconfig.scripts.json'), 'utf8')) as {
      extends: string;
      include: string[];
    };
    expect(scripts).toMatchObject({ extends: './tsconfig.base.json', include: ['scripts/**/*.ts'] });
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('run: bun x tsc -p tsconfig.scripts.json --noEmit');
  });

  test('CI runs the smoke after its build:dist step', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const build = ci.indexOf('run: bun run build:dist');
    const smoke = ci.indexOf('run: bun run scripts/node-dist-smoke.ts');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(smoke).toBeGreaterThan(build);
  });
});

function transpile(from: string, to: string): void {
  const out = ts.transpileModule(readFileSync(join(REPO_ROOT, from), 'utf8'), {
    fileName: from,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true },
  });
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, out.outputText);
}

const HEALTHY_CLI_MAIN = "process.stdout.write('SharkCraft v1.2.3\\n');\n";
const HEALTHY_MCP_MAIN = "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n";
const UNLINKED_MAIN = "import '@shrkcrft/zzz';\n";

/**
 * A tool tree with the four entries the smoke probes: fake `dist/main.js`
 * files and the REAL bin bootstraps, plus a copy of the REAL smoke script at
 * scripts/node-dist-smoke.ts (it probes the tree its own `..` names).
 */
function toolTree(cliMain: string, mcpMain: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r77-smoke-')));
  created.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tool-root', private: true, workspaces: ['packages/*'] }));
  for (const [dir, name, bin, main] of [
    ['cli', '@shrkcrft/cli', 'shrk', cliMain],
    ['mcp-server', '@shrkcrft/mcp-server', 'shrk-mcp', mcpMain],
  ] as const) {
    const pkg = join(root, 'packages', dir);
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.2.3', type: 'module' }));
    writeFileSync(join(pkg, 'dist', 'main.js'), main);
    transpile(`packages/${dir}/src/${bin}.ts`, join(pkg, 'dist', `${bin}.js`));
    transpile(
      `packages/${dir}/src/bootstrap/unlinked-workspace-dependency.ts`,
      join(pkg, 'dist', 'bootstrap', 'unlinked-workspace-dependency.js'),
    );
  }
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'scripts/node-dist-smoke.ts'), join(root, 'scripts/node-dist-smoke.ts'));
  return root;
}

function smoke(root: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bun', [join(root, 'scripts/node-dist-smoke.ts')], { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('scripts/node-dist-smoke.ts can fail (the real script over a synthetic tool tree)', () => {
  test(
    'a loadable dist: exit 0, every probe ok — the version printed, each server exiting 0 on stdin EOF',
    () => {
      const res = smoke(toolTree(HEALTHY_CLI_MAIN, HEALTHY_MCP_MAIN));
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('[node-dist-smoke] ok node packages/cli/dist/main.js --version → SharkCraft v1.2.3');
      expect(res.stdout).toContain('[node-dist-smoke] ok node packages/cli/dist/shrk.js --version → SharkCraft v1.2.3');
      expect(res.stdout).toContain('[node-dist-smoke] ok node packages/mcp-server/dist/main.js (stdin closed) → exit 0 on stdin EOF');
      expect(res.stdout).toContain('[node-dist-smoke] ok node packages/mcp-server/dist/shrk-mcp.js (stdin closed) → exit 0 on stdin EOF');
    },
    TIMEOUT_MS,
  );

  test(
    'an unlinked workspace dependency under the CLI: exit 1 — main.js dies at load, the bin bootstrap exits 70 with its one line',
    () => {
      const res = smoke(toolTree(UNLINKED_MAIN, HEALTHY_MCP_MAIN));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('[node-dist-smoke] FAILED node packages/cli/dist/main.js --version: died at load (exit 1)');
      expect(res.stderr).toContain('[node-dist-smoke] FAILED node packages/cli/dist/shrk.js --version: died at load (exit 70)');
      expect(res.stderr).toContain('shrk: workspace dependency @shrkcrft/zzz (needed by @shrkcrft/cli) is not linked');
      expect(res.stderr).toContain('2 probe(s) failed');
      expect(res.stdout).toContain('ok node packages/mcp-server/dist/main.js (stdin closed)');
    },
    TIMEOUT_MS,
  );

  test(
    'an unlinked workspace dependency under the MCP server (stdin closed): exit 1 for both of its entries',
    () => {
      const res = smoke(toolTree(HEALTHY_CLI_MAIN, UNLINKED_MAIN));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('[node-dist-smoke] FAILED node packages/mcp-server/dist/main.js (stdin closed): died at load (exit 1)');
      expect(res.stderr).toContain('[node-dist-smoke] FAILED node packages/mcp-server/dist/shrk-mcp.js (stdin closed): died at load (exit 70)');
      expect(res.stderr).toContain('(needed by @shrkcrft/mcp-server) is not linked');
    },
    TIMEOUT_MS,
  );

  test(
    'a CLI that loads but prints another version, and a missing entry, fail too',
    () => {
      const root = toolTree("process.stdout.write('SharkCraft v0.0.0\\n');\n", HEALTHY_MCP_MAIN);
      rmSync(join(root, 'packages/mcp-server/dist/shrk-mcp.js'));
      const res = smoke(root);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('FAILED node packages/cli/dist/main.js --version: did not print the version 1.2.3');
      expect(res.stderr).toContain(
        'FAILED node packages/mcp-server/dist/shrk-mcp.js (stdin closed): packages/mcp-server/dist/shrk-mcp.js is missing',
      );
    },
    TIMEOUT_MS,
  );
});
