/**
 * r78 — every knowledge-rename command a hint suggests is one the dispatcher
 * runs (round 15 follow-up, lane B — B1).
 *
 * `shrk knowledge rename-symbol` / `rename-file` are read-only previews that
 * take no `--dry-run`. Two sites still suggested `shrk knowledge rename-symbol
 * <old> <new> --dry-run`, which the dispatcher refuses (unknown flag, exit 2):
 * the stale-check failure hints (`failure-hints.ts`) and the
 * feedback-ingestion rename rule. F4 had fixed only the fix-preview site. Every
 * site now builds the command through ONE helper, `knowledgeRenameCommand`
 * (@shrkcrft/inspector).
 *
 * The lock: every string the helper builds, and every rename command a hint
 * suggests, resolves `ok` through THE command-string resolver, which shares
 * `judgeInvocation` with the dispatcher, over the real registry. A source scan
 * keeps a hand-built rename command, or a `--dry-run` on one, from coming back.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  CommandResolutionStatus,
  ingestFeedbackText,
  knowledgeRenameCommand,
  KnowledgeRenameVerb,
} from '@shrkcrft/inspector';
import { buildRegistry } from '../main.ts';
import { staleKnowledgeHints } from '../output/failure-hints.ts';
import { buildCommandIndex } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const index = buildCommandIndex(buildRegistry());
const RENAME = /\bknowledge rename-(?:symbol|file)\b/;

/** Every `[command, status]` pair whose status is not `ok` — `[]` when all run. */
function unresolved(commands: readonly string[]): [string, CommandResolutionStatus][] {
  return commands
    .map((c): [string, CommandResolutionStatus] => [c, resolveCommandString(index, c).status])
    .filter(([, s]) => s !== CommandResolutionStatus.Ok);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('r78 B1 — THE rename-command helper builds only invocations the dispatcher accepts', () => {
  test('the old `--dry-run` form is refused by the dispatcher judgement (the defect this locks)', () => {
    const r = resolveCommandString(index, 'shrk knowledge rename-symbol <old> <new> --dry-run');
    expect(r.status).toBe(CommandResolutionStatus.UnknownFlag);
  });

  test('every verb, with placeholders, plain values and values that need quoting, resolves ok', () => {
    const commands = Object.values(KnowledgeRenameVerb).flatMap((verb) => [
      knowledgeRenameCommand(verb),
      knowledgeRenameCommand(verb, 'OldName'),
      knowledgeRenameCommand(verb, 'src/old.ts', 'src/new.ts'),
      knowledgeRenameCommand(verb, 'docs/my guide.md', 'docs/your guide.md'),
      knowledgeRenameCommand(verb, '', ''),
      // A value that starts with `-` (review finding: it read as a flag — `unknown-flag`).
      knowledgeRenameCommand(verb, '-weird.ts', 'b.ts'),
      knowledgeRenameCommand(verb, 'a.ts', '-b.ts'),
      knowledgeRenameCommand(verb, '-my guide.md'),
    ]);
    expect(commands.filter((c) => c.includes('--dry-run'))).toEqual([]);
    expect(unresolved(commands)).toEqual([]);
    expect(knowledgeRenameCommand(KnowledgeRenameVerb.RenameFile, 'docs/my guide.md')).toBe(
      "shrk knowledge rename-file 'docs/my guide.md' <new-path>",
    );
    expect(knowledgeRenameCommand(KnowledgeRenameVerb.RenameFile, '-weird.ts', 'b.ts')).toBe(
      'shrk knowledge rename-file -- -weird.ts b.ts',
    );
    // The spelling it used to build is the one the dispatcher judgement refuses.
    expect(resolveCommandString(index, 'shrk knowledge rename-file -weird.ts b.ts').status).toBe(CommandResolutionStatus.UnknownFlag);
    // No `--` when nothing needs it: every ordinary hint is byte-identical.
    expect(knowledgeRenameCommand(KnowledgeRenameVerb.RenameSymbol, 'Old', 'New')).toBe('shrk knowledge rename-symbol Old New');
  });

  const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  test(
    'the dispatcher RUNS the helper’s `--` form and reads a dash-leading path verbatim (the bare form exits 2)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-rename-dash-'));
      roots.push(dir);
      mkdirSync(join(dir, 'sharkcraft'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
      writeFileSync(join(dir, 'sharkcraft', 'sharkcraft.config.ts'), "export default { projectName: 'fx' };\n");
      const run = (argv: readonly string[]) =>
        spawnSync('bun', ['--no-install', CLI_MAIN, '--no-hints', ...argv], { cwd: dir, encoding: 'utf8' });
      // Plain words only, so splitting on spaces is the shell's reading.
      const ok = run(knowledgeRenameCommand(KnowledgeRenameVerb.RenameFile, '-weird.ts', 'b.ts').split(' ').slice(1));
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('Rename file: -weird.ts → b.ts');
      const refused = run(['knowledge', 'rename-file', '-weird.ts', 'b.ts']);
      expect(refused.status).toBe(2);
    },
    60_000,
  );

  test('the knowledge stale-check failure hints: both rename previews, every hint resolves ok', () => {
    const commands = staleKnowledgeHints().map((h) => h.command);
    expect(commands).toContain(knowledgeRenameCommand(KnowledgeRenameVerb.RenameFile));
    expect(commands).toContain(knowledgeRenameCommand(KnowledgeRenameVerb.RenameSymbol));
    expect(unresolved(commands)).toEqual([]);
  });

  test('the feedback-ingestion rename rule suggests only runnable rename previews', () => {
    const report = ingestFeedbackText('## Bad\n- the service file was renamed and moved\n');
    const commands = report.findings.flatMap((f) => [...f.suggestedCommands]);
    const renames = commands.filter((c) => RENAME.test(c));
    expect(renames.sort()).toEqual(
      [knowledgeRenameCommand(KnowledgeRenameVerb.RenameFile), knowledgeRenameCommand(KnowledgeRenameVerb.RenameSymbol)].sort(),
    );
    expect(unresolved(commands)).toEqual([]);
  });

  test('no source spells a knowledge rename with --dry-run, and none builds one by hand but the verbs themselves', () => {
    // The verbs' own usage lines name their positionals; the changelog quotes
    // the old defect as prose. Every other site goes through the helper.
    const allowedByHand = new Set(['packages/cli/src/commands/knowledge.command.ts', 'packages/cli/src/commands/changelog-data.ts']);
    const dryRun: string[] = [];
    const byHand: string[] = [];
    for (const pkg of readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      let files: string[] = [];
      try {
        files = sourceFiles(join(REPO_ROOT, 'packages', pkg.name, 'src'));
      } catch {
        continue;
      }
      for (const file of files) {
        const rel = relative(REPO_ROOT, file).split('\\').join('/');
        if (rel === 'packages/cli/src/commands/changelog-data.ts') continue;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (/knowledge rename-(?:symbol|file)[^`'"\n]*--dry-run/.test(line)) dryRun.push(`${rel}:${i + 1}`);
            if (/shrk knowledge rename-(?:symbol|file) (?:<|\$\{)/.test(line) && !allowedByHand.has(rel)) byHand.push(`${rel}:${i + 1}`);
          });
      }
    }
    expect(dryRun).toEqual([]);
    expect(byHand).toEqual([]);
  });
});
