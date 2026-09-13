/**
 * r78 — MCP `preview_knowledge_rename` names its CLI next step through THE
 * rename-command helper (round 15 follow-up, lane B — B1).
 *
 * The tool built `shrk knowledge rename-symbol ${from} ${to}` by hand. A value
 * with a space came out as three words, so the step it named did not run as
 * written. It now goes through `knowledgeRenameCommand` (@shrkcrft/inspector),
 * the helper every rename hint uses. The CLI's r78-knowledge-rename-hints test
 * proves every string that helper builds resolves through the command-string
 * resolver (this package cannot import the CLI). Real inspection over a real
 * project.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, knowledgeRenameCommand, KnowledgeRenameVerb } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/all-tools.ts';

const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-mcp-rename-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const tool = ALL_TOOLS.find((t) => t.name === 'preview_knowledge_rename');

describe('r78 B1 — preview_knowledge_rename names its next step through THE helper', () => {
  test(
    'rename-symbol and rename-file: the next step is exactly the helper’s command — quoted when a value needs it, never --dry-run',
    async () => {
      expect(tool).toBeDefined();
      const root = project();
      const ctx = { inspection: await inspectSharkcraft({ cwd: root }), cwd: root };
      const cases: readonly [KnowledgeRenameVerb, string, string][] = [
        [KnowledgeRenameVerb.RenameSymbol, 'OldName', 'NewName'],
        [KnowledgeRenameVerb.RenameFile, 'src/old.ts', 'src/new.ts'],
        [KnowledgeRenameVerb.RenameFile, 'docs/my guide.md', 'docs/guide.md'],
      ];
      for (const [verb, from, to] of cases) {
        const out = await tool!.handler({ kind: verb, from, to }, ctx);
        expect(out.text).toBe(`Next: \`${knowledgeRenameCommand(verb, from, to)}\` (CLI is the only write path).`);
        expect(out.text).not.toContain('--dry-run');
      }
      const spaced = await tool!.handler({ kind: KnowledgeRenameVerb.RenameFile, from: 'docs/my guide.md', to: 'docs/guide.md' }, ctx);
      expect(spaced.text).toContain("rename-file 'docs/my guide.md' docs/guide.md");
    },
    T,
  );
});
