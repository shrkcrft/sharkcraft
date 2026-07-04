import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { finishCommand } from '../commands/finish.command.ts';

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr ?? ''}`);
}

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-finish-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: '@d/a', main: 'src/index.ts' }));
  writeFileSync(join(root, 'packages', 'b', 'package.json'), JSON.stringify({ name: '@d/b', main: 'src/index.ts' }));
  writeFileSync(join(root, 'packages', 'a', 'src', 'index.ts'), 'export function a() { return 1; }\n');
  writeFileSync(
    join(root, 'packages', 'b', 'src', 'index.ts'),
    "import { a } from '@d/a';\nexport function b() { return a(); }\n",
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  buildFullIndex({ projectRoot: root });
  return root;
}

/**
 * A git repo whose sharkcraft.config.ts models a DI idiom over InjectionToken
 * code — GhostToken is declared + injected but never provided (unprovided). Lets
 * the finish composite exercise the runtime-wiring `unprovided` graph gate.
 */
function setupRepoWithIdioms(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-finish-di-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'di-demo', version: '0.0.0' }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {
  registrationGraph: [
    {
      name: 'di',
      declared: { files: ['src/**/*.ts'], pattern: 'export const ([A-Za-z]+) = new InjectionToken' },
      provided: { files: ['src/**/*.ts'], arrayProperty: 'providers' },
      consumed: { files: ['src/**/*.ts'], pattern: 'inject[(]([A-Za-z]+)' },
    },
  ],
};
`,
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'tokens.ts'),
    "export const ApiToken = new InjectionToken('api');\nexport const GhostToken = new InjectionToken('ghost');\n",
  );
  writeFileSync(join(root, 'src', 'module.ts'), 'const providers = [ApiToken];\n');
  writeFileSync(
    join(root, 'src', 'service.ts'),
    'const a = inject(ApiToken);\nconst g = inject(GhostToken);\n',
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  buildFullIndex({ projectRoot: root });
  return root;
}

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const f = new Map<string, string | boolean>([['cwd', root], ['json', true]]);
  for (const [k, v] of Object.entries(flags)) f.set(k, v);
  return { positional, flags: f, multiFlags: new Map() };
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

function gateByName(
  report: {
    gates: {
      name: string;
      status: string;
      items?: { message: string; file?: string; line?: number }[];
    }[];
  },
  name: string,
) {
  return report.gates.find((g) => g.name === name);
}

describe('shrk finish (composite gate)', () => {
  test('FAILS when a deletion orphans a surviving importer', async () => {
    const root = setupRepo();
    try {
      unlinkSync(join(root, 'packages', 'a', 'src', 'index.ts'));
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(report.verdict).toBe('fail');
      expect(gateByName(report, 'orphans')?.status).toBe('fail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('PASSES a clean changeset, reporting skipped sub-gates loudly', async () => {
    const root = setupRepo();
    try {
      // Touch (not delete) a file so there is a changeset but no orphan.
      writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), "import { a } from '@d/a';\nexport function b() { return a() + 1; }\n");
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(report.verdict).toBe('pass');
      // No sharkcraft config in the fixture → wiring/policy are skipped, NOT failed.
      expect(gateByName(report, 'wiring')?.status).toBe('skipped');
      expect(gateByName(report, 'policy')?.status).toBe('skipped');
      // Nothing deleted → orphans skipped (loud), not a green pass masking a no-op.
      expect(gateByName(report, 'orphans')?.status).toBe('skipped');
      // Absence of config must NOT force a fail.
      expect(report.configError).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('includes a best-effort impact summary when the graph is indexed', async () => {
    const root = setupRepo();
    try {
      writeFileSync(join(root, 'packages', 'a', 'src', 'index.ts'), 'export function a() { return 2; }\n');
      const cap = capture();
      await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(report.impact.ran).toBe(true);
      expect(typeof report.impact.risk).toBe('string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--files scope skips the orphan gate (no diff to read deletions from)', async () => {
    const root = setupRepo();
    try {
      const cap = capture();
      const code = await finishCommand.run(args(root, ['packages/b/src/index.ts']));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(report.scope.mode).toBe('files');
      expect(gateByName(report, 'orphans')?.status).toBe('skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('shrk finish — honest 0/1/2 verdict (a26 §1.3)', () => {
  test('NOT-VERIFIED (exit 2) when nothing changed — "evaluated nothing" is never a green 0', async () => {
    const root = setupRepo();
    try {
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(2);
      expect(report.exit).toBe(2);
      expect(report.verdict).toBe('not-verified');
      expect(report.summary).toContain('Not verified');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('NOT-VERIFIED (exit 2) when the change touches only NON-code files', async () => {
    const root = setupRepo();
    try {
      // A committed markdown file, then a markdown-only edit → the changeset has
      // no code the boundary/import/wiring gates can evaluate, so every deciding
      // gate skips. Pre-fix this painted a green pass; it must now read as 2.
      writeFileSync(join(root, 'NOTES.md'), '# notes\n');
      git(root, 'add', 'NOTES.md');
      git(root, 'commit', '-q', '-m', 'notes');
      writeFileSync(join(root, 'NOTES.md'), '# notes\nmore\n');
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(2);
      expect(report.verdict).toBe('not-verified');
      expect(gateByName(report, 'boundaries')?.status).toBe('skipped');
      expect(gateByName(report, 'imports')?.status).toBe('skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the composite now runs the unprovided (DI graph) + arch sub-gates', async () => {
    const root = setupRepo();
    try {
      writeFileSync(join(root, 'packages', 'a', 'src', 'index.ts'), 'export function a() { return 3; }\n');
      const cap = capture();
      await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      // Both new gate names are present in every run (skipped here — no idioms /
      // no cycle — but reported loudly, never silently absent).
      expect(gateByName(report, 'unprovided')).toBeDefined();
      expect(gateByName(report, 'arch')).toBeDefined();
      expect(typeof report.exit).toBe('number');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('FAILS (exit 1) when the change leaves a DI token unprovided (graph gate slotted in)', async () => {
    const root = setupRepoWithIdioms();
    try {
      // Touch the file that injects the never-provided GhostToken so it is in the
      // changed scope; the unprovided graph gate must then fail the composite.
      writeFileSync(
        join(root, 'src', 'service.ts'),
        'const a = inject(ApiToken);\nconst g = inject(GhostToken);\nconst extra = 1;\n',
      );
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(report.verdict).toBe('fail');
      const gate = gateByName(report, 'unprovided');
      expect(gate?.status).toBe('fail');
      expect(JSON.stringify(gate?.items)).toContain('GhostToken');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('FAILS (exit 1) when the change DELETES the last provider of a used token (provider regression)', async () => {
    const root = setupRepoWithIdioms();
    try {
      // ApiToken is wired at HEAD (provided in module.ts, injected in service.ts).
      // Remove the ONLY provider — this leaves NO registration site in the changed
      // file, so post-change site-scoping can't see it; the base-ref diff must.
      writeFileSync(join(root, 'src', 'module.ts'), 'const providers = [];\n');
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(report.verdict).toBe('fail');
      const gate = gateByName(report, 'unprovided');
      expect(gate?.status).toBe('fail');
      expect(JSON.stringify(gate?.items)).toContain('ApiToken');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does NOT false-fail when a changed provider file still provides the token', async () => {
    const root = setupRepoWithIdioms();
    try {
      // Reorder/keep ApiToken provided — a provider-file edit that does NOT drop
      // the provider must not be reported as a regression.
      writeFileSync(join(root, 'src', 'module.ts'), 'const providers = [ApiToken];\nconst x = 1;\n');
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      const gate = gateByName(report, 'unprovided');
      expect(gate?.status).not.toBe('fail');
      expect(code).not.toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
