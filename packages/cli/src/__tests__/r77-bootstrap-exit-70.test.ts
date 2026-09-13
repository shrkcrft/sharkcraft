/**
 * Round 13 (13.2) — the bin bootstraps, spawned under the runtime that matters.
 *
 * The REAL bootstrap sources (packages/cli/src/shrk.ts, packages/mcp-server/src/
 * shrk-mcp.ts and their ./bootstrap module) are transpiled into a synthetic
 * workspace package, exactly as build-dist emits them, next to a fake main.js.
 * When main.js imports a missing @shrkcrft/zzz, running main.js directly dies
 * with Node's raw resolver stack at exit 1 — the bootstrap prints one line and
 * exits 70. Every other failure behaves as it does without the bootstrap, and a
 * healthy entry passes straight through. The real CLI and MCP server run
 * through their bootstraps from source, too.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const TIMEOUT_MS = 60_000;
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

const ENTRIES = [
  { bin: 'shrk', entry: 'packages/cli/src/shrk.ts', module: 'packages/cli/src/bootstrap/unlinked-workspace-dependency.ts' },
  {
    bin: 'shrk-mcp',
    entry: 'packages/mcp-server/src/shrk-mcp.ts',
    module: 'packages/mcp-server/src/bootstrap/unlinked-workspace-dependency.ts',
  },
] as const;

function transpile(from: string, to: string): void {
  const out = ts.transpileModule(readFileSync(join(REPO_ROOT, from), 'utf8'), {
    fileName: from,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true },
  });
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, out.outputText);
}

/** A workspace whose packages/fake/dist holds the real bootstrap as `<bin>.js` and `main` as main.js. */
function fakeInstall(which: (typeof ENTRIES)[number], main: string): { root: string; bootstrap: string; main: string } {
  const root = tempDir('r77-exit70-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tool-root', private: true, workspaces: ['packages/*'] }));
  const pkg = join(root, 'packages', 'fake');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@shrkcrft/fake', type: 'module' }));
  transpile(which.entry, join(pkg, 'dist', `${which.bin}.js`));
  transpile(which.module, join(pkg, 'dist', 'bootstrap', 'unlinked-workspace-dependency.js'));
  writeFileSync(join(pkg, 'dist', 'main.js'), main);
  return { root, bootstrap: join(pkg, 'dist', `${which.bin}.js`), main: join(pkg, 'dist', 'main.js') };
}

function run(runtime: 'node' | 'bun', file: string, args: readonly string[] = []): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(runtime, [file, ...args], {
    cwd: tempDir('r77-consumer-'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Node's async stack frames name the awaiting caller — the bootstrap in place of Node's own entry loader. */
const withoutAsyncFrames = (stderr: string): string =>
  stderr
    .split('\n')
    .filter((line) => !/^\s+at async /.test(line))
    .join('\n');

for (const which of ENTRIES) {
  describe(`${which.bin} bootstrap (${which.entry})`, () => {
    test(
      'an unlinked @shrkcrft package: exit 70 and ONE line naming the dependency, the package that needs it and where to install',
      () => {
        const { root, bootstrap, main } = fakeInstall(which, "import '@shrkcrft/zzz';\nconsole.log('unreachable');\n");
        const line = `shrk: workspace dependency @shrkcrft/zzz (needed by @shrkcrft/fake) is not linked — run \`bun install\` in ${root}\n`;
        const viaBootstrap = run('node', bootstrap, ['--version']);
        expect(viaBootstrap).toEqual({ status: 70, stdout: '', stderr: line });

        // What the bootstrap replaces: main.js run directly dies at link time with the raw resolver stack.
        const direct = run('node', main, ['--version']);
        expect(direct.status).toBe(1);
        expect(direct.stderr).toContain(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@shrkcrft/zzz' imported from ${main}`);

        // Bun's own shape of the same failure is rewritten to the same line.
        expect(run('bun', bootstrap, ['--version'])).toEqual({ status: 70, stdout: '', stderr: line });
      },
      TIMEOUT_MS,
    );

    test(
      'an unrelated thrown error keeps today\'s behaviour: same exit, same message and source line',
      () => {
        const { bootstrap, main } = fakeInstall(which, "export const x = 1;\nthrow new Error('boom from main');\n");
        const direct = run('node', main);
        const viaBootstrap = run('node', bootstrap);
        expect(direct.status).toBe(1);
        expect(viaBootstrap.status).toBe(direct.status);
        expect(viaBootstrap.stdout).toBe(direct.stdout);
        expect(viaBootstrap.stderr).toContain('Error: boom from main');
        expect(withoutAsyncFrames(viaBootstrap.stderr)).toBe(withoutAsyncFrames(direct.stderr));
      },
      TIMEOUT_MS,
    );

    test(
      'a missing third-party package is not a workspace link: byte-identical stderr and exit to running main.js directly',
      () => {
        const { bootstrap, main } = fakeInstall(which, "import 'left-pad-zzz';\n");
        const direct = run('node', main);
        expect(direct.status).toBe(1);
        expect(run('node', bootstrap)).toEqual(direct);
      },
      TIMEOUT_MS,
    );

    test(
      'a healthy entry passes straight through: its stdout and its exit code',
      () => {
        const { bootstrap } = fakeInstall(which, "process.stdout.write('SharkCraft v9.9.9\\n');\nprocess.exitCode = 3;\n");
        expect(run('node', bootstrap)).toEqual({ status: 3, stdout: 'SharkCraft v9.9.9\n', stderr: '' });
      },
      TIMEOUT_MS,
    );
  });
}

describe('the real entries, through their bootstraps, from source', () => {
  test(
    '`bun packages/cli/src/shrk.ts --version` runs the real CLI exactly as main.ts does (exit 0, the version)',
    () => {
      const viaBootstrap = run('bun', join(REPO_ROOT, 'packages/cli/src/shrk.ts'), ['--version']);
      const direct = run('bun', join(REPO_ROOT, 'packages/cli/src/main.ts'), ['--version']);
      // Parity first: whatever the tree's state, the bootstrap passes the real entry through.
      expect({ status: viaBootstrap.status, stdout: viaBootstrap.stdout }).toEqual({ status: direct.status, stdout: direct.stdout });
      expect(viaBootstrap.status).toBe(0);
      expect(viaBootstrap.stdout).toMatch(/^SharkCraft v\d+\.\d+\.\d+/);
    },
    TIMEOUT_MS,
  );

  test(
    '`bun packages/mcp-server/src/shrk-mcp.ts` serves: it answers a real MCP initialize over stdin, then exits 0 on EOF',
    () => {
      // Exit 0 alone would also be what a bootstrap that never STARTED the
      // server prints — the reply is the proof it loaded and served.
      const initialize = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r77', version: '1' } },
      });
      const res = spawnSync('bun', [join(REPO_ROOT, 'packages/mcp-server/src/shrk-mcp.ts')], {
        cwd: tempDir('r77-consumer-'),
        input: `${initialize}\n`,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      });
      expect(res.stderr ?? '').not.toContain('ERR_MODULE_NOT_FOUND');
      expect(res.status).toBe(0);
      const reply = (res.stdout ?? '')
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as { id?: unknown; result?: { serverInfo?: { name?: unknown } } })
        .find((message) => message.id === 1);
      expect(reply?.result?.serverInfo?.name).toBe('sharkcraft');
    },
    TIMEOUT_MS,
  );
});
