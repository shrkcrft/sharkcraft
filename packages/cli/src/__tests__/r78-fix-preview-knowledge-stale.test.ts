/**
 * r78 — the `fix --knowledge-stale` preview suggests only commands the
 * dispatcher RUNS, and says when an entry cannot be auto-fixed (round 15
 * follow-up, F4).
 *
 * Before: every stale row suggested `shrk knowledge rename-symbol <old> <new>
 * --dry-run` (refused — `--dry-run is not a flag of this command`, exit 2; the
 * verb is a read-only preview already), its draft said `rename-file … --dry-run`
 * (refused the same way), and `shrk fix preview --knowledge-stale <id>` (`fix`
 * takes no positional — the id was read as the flag's value, so the command
 * previewed EVERY kind). A Markdown entry's suggestion never said that `--apply`
 * cannot edit it.
 *
 * Every suggested command runs through the dispatcher's own judgement — the
 * command-string resolver shares `judgeInvocation` with it — over the real
 * registry.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommandResolutionStatus } from '@shrkcrft/inspector';
import { buildRegistry } from '../main.ts';
import { buildCommandIndex } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-fixprev-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface ISuggestion {
  readonly kind: string;
  readonly targetId: string;
  readonly description: string;
  readonly nextCommands: readonly string[];
  readonly draftBody?: string;
  readonly humanReviewRequired?: boolean;
}

const ENTRY = (id: string, refs: string): string =>
  `{ id: '${id}', title: '${id}', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'x', references: ${refs} }`;

const root = tree({
  'package.json': JSON.stringify({ name: 'r78-fixprev', version: '0.0.0', private: true }),
  'src/a.ts': 'export class Foo {}\n',
  'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78', knowledgeFiles: ['knowledge.ts', 'guide.md'] };\n",
  'sharkcraft/knowledge.ts':
    'export default [\n' +
    `  ${ENTRY('k.file', "[{ kind: 'file', path: 'src/gone.ts' }]")},\n` +
    `  ${ENTRY('k.sym', "[{ kind: 'symbol', symbol: 'Missing', path: 'src/a.ts' }]")},\n` +
    '];\n',
  'sharkcraft/guide.md': '---\nid: doc.guide\ntitle: Guide\nreferences: [file:src/missing.ts]\n---\n# Guide\n',
});

const index = buildCommandIndex(buildRegistry());

/** A suggested command with its placeholders filled the way a reader would. */
function filled(cmd: string): string {
  return cmd
    .replace('<new-path>', 'src/b.ts')
    .replace('<new-symbol>', 'Bar')
    .replace('<old>', 'src/gone.ts')
    .replace('<new>', 'src/b.ts');
}

function preview(argv: readonly string[] = []): ISuggestion[] {
  const r = shrk(root, ['fix', 'preview', '--knowledge-stale', ...argv, '--json']);
  return (JSON.parse(r.stdout) as { suggestions: ISuggestion[] }).suggestions.filter((s) => s.kind === 'knowledge-stale');
}

describe('r78 F4 — every suggested command is one the dispatcher runs', () => {
  test(
    'each nextCommand and each command a draft names resolves `ok` through the dispatcher judgement; none names --dry-run',
    () => {
      const suggestions = preview();
      expect(suggestions.map((s) => s.targetId).sort()).toEqual(['doc.guide', 'k.file', 'k.sym']);
      const commands = suggestions.flatMap((s) => [
        ...s.nextCommands,
        ...[...(s.draftBody ?? '').matchAll(/`(shrk [^`]+)`/g)].map((m) => m[1]!),
      ]);
      expect(commands.some((c) => c.includes('rename-file'))).toBe(true);
      expect(commands.some((c) => c.includes('rename-symbol'))).toBe(true);
      const bad = commands
        .map((c) => ({ c, status: resolveCommandString(index, filled(c)).status }))
        .filter((r) => r.status !== CommandResolutionStatus.Ok);
      expect(bad).toEqual([]);
      expect(commands.filter((c) => c.includes('--dry-run'))).toEqual([]);
    },
    T,
  );

  test(
    '`fix preview --knowledge-stale --target <id>` narrows the preview to that entry (the positional form previewed every kind)',
    () => {
      const narrowed = preview(['--target', 'doc.guide']);
      expect(narrowed.map((s) => s.targetId)).toEqual(['doc.guide']);
      // The suggested rename preview runs (it used to be refused with exit 2).
      expect(shrk(root, ['knowledge', 'rename-file', 'src/gone.ts', 'src/b.ts']).status).toBe(0);
    },
    T,
  );
});

describe('r78 F4 — an entry `--apply` cannot edit says so', () => {
  test(
    'a Markdown entry: "not auto-fixable", its .md named, human review, and no --apply command; a TypeScript entry gets one',
    () => {
      const suggestions = preview();
      const md = suggestions.find((s) => s.targetId === 'doc.guide')!;
      expect(md.description).toContain('not auto-fixable: doc.guide is declared in Markdown (sharkcraft/guide.md)');
      expect(md.humanReviewRequired).toBe(true);
      expect(md.nextCommands.filter((c) => c.includes('--apply'))).toEqual([]);
      const ts = suggestions.find((s) => s.targetId === 'k.file')!;
      expect(ts.description).not.toContain('not auto-fixable');
      expect(ts.nextCommands).toContain('shrk fix --knowledge-stale --apply --drop-stale');
      expect(ts.nextCommands).toContain('shrk knowledge rename-file src/gone.ts <new-path>');
      expect(suggestions.find((s) => s.targetId === 'k.sym')!.nextCommands).toContain('shrk knowledge rename-symbol Missing <new-symbol>');
      // A rename lands through `--apply`, which refuses a Markdown entry — never suggested for one.
      expect(md.nextCommands.filter((c) => c.includes('rename-'))).toEqual([]);
    },
    T,
  );
});

describe('r78 F4 review — the preview agrees with the stale-check, and a rename answers a moved target only', () => {
  const PACK = '@r78/fixprev-pack';
  const root2 = tree({
    'package.json': JSON.stringify({ name: 'r78-fixprev-2', version: '0.0.0', private: true }),
    'src/a.ts': 'export class Foo {}\n',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78b', knowledgeFiles: ['knowledge.ts'] };\n",
    'sharkcraft/knowledge.ts':
      'export default [\n' +
      `  ${ENTRY('k.cnt', "[{ kind: 'file', path: 'src/a.ts', contains: 'class Bar' }]")},\n` +
      `  ${ENTRY('k.cmd', "[{ kind: 'command', command: 'shrk bogus-verb' }]")},\n` +
      '];\n',
    [`node_modules/${PACK}/package.json`]: JSON.stringify({ name: PACK, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    [`node_modules/${PACK}/manifest.json`]: JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: PACK, version: '0.0.1' },
      contributions: { knowledgeFiles: ['./k.ts'] },
    }),
    [`node_modules/${PACK}/k.ts`]: `export default [\n  ${ENTRY('p.file', "[{ kind: 'file', path: 'docs/pgone.md' }]")},\n];\n`,
  });
  const at = (): ISuggestion[] => {
    const r = shrk(root2, ['fix', 'preview', '--knowledge-stale', '--json']);
    return (JSON.parse(r.stdout) as { suggestions: (ISuggestion & { title: string })[] }).suggestions.filter(
      (s) => s.kind === 'knowledge-stale',
    );
  };

  test(
    'a command: row is STALE as the stale-check reads it (registries warmed); a content mismatch and a pack entry get no rename',
    () => {
      const suggestions = at() as (ISuggestion & { title: string })[];
      const stale = JSON.parse(shrk(root2, ['knowledge', 'stale-check', '--json']).stdout) as {
        referenceChecks: { entryId: string; outcome: string }[];
      };
      expect(stale.referenceChecks.find((c) => c.entryId === 'k.cmd')?.outcome).toBe('stale');
      const cmd = suggestions.find((s) => s.targetId === 'k.cmd')!;
      expect(cmd.title).toBe('Stale reference k.cmd → shrk bogus-verb');
      expect(cmd.description).not.toContain('not injected');

      const cnt = suggestions.find((s) => s.targetId === 'k.cnt')!;
      expect(cnt.nextCommands.filter((c) => c.includes('rename-'))).toEqual([]);
      expect(cnt.nextCommands).toContain('shrk fix --knowledge-stale --apply --drop-stale');

      const pk = suggestions.find((s) => s.targetId === 'p.file')!;
      expect(pk.description).toContain(`not auto-fixable here: pack ${PACK} contributes p.file`);
      expect(pk.humanReviewRequired).toBe(true);
      expect(pk.nextCommands.filter((c) => c.includes('rename-') || c.includes('--apply'))).toEqual([]);
      // Every suggested command still resolves through the dispatcher judgement.
      const bad = suggestions
        .flatMap((s) => s.nextCommands)
        .filter((c) => resolveCommandString(index, filled(c)).status !== CommandResolutionStatus.Ok);
      expect(bad).toEqual([]);
    },
    T,
  );
});
