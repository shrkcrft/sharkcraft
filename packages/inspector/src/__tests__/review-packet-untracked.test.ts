/**
 * `buildReviewPacket` working-tree default must include non-ignored untracked
 * files, so a just-generated, never-staged source file is visible to review
 * (and to the missing-test heuristic). Consistent with `shrk changes summary`,
 * which already counts untracked files via `getChangedFiles`. `.gitignore`'d
 * files stay excluded, and `{ untracked: false }` restores the legacy
 * tracked-only `git diff` view.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewPacket } from '../review-packet.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

function stub(projectRoot: string): ISharkcraftInspection {
  return {
    projectRoot,
    knowledgeEntries: [],
    templates: [],
    pipelines: [],
    presetRegistry: { list: () => [] },
    workspace: { profiles: [] },
    ruleService: { list: () => [] },
    pathService: { list: () => [] },
    boundaryRegistry: { size: () => 0, list: () => [] },
    pipelineRegistry: { get: () => undefined },
    config: null,
  } as unknown as ISharkcraftInspection;
}

function git(cwd: string, ...subargs: string[]): void {
  execSync(`git ${subargs.map((a) => JSON.stringify(a)).join(' ')}`, {
    cwd,
    stdio: 'pipe',
  });
}

let WORK: string;
beforeEach(() => {
  WORK = mkdtempSync(join(tmpdir(), 'shrk-review-untracked-'));
  git(WORK, 'init', '-q');
  git(WORK, 'config', 'user.email', 'test@test.test');
  git(WORK, 'config', 'user.name', 'test');
  git(WORK, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(WORK, '.gitignore'), 'ignored.ts\nnode_modules\n');
  git(WORK, 'add', '.gitignore');
  git(WORK, 'commit', '-q', '-m', 'init');
  // A brand-new, never-staged source file with no test pair.
  mkdirSync(join(WORK, 'src'), { recursive: true });
  writeFileSync(join(WORK, 'src/new.ts'), 'export const x = 1;\n');
  // A gitignored file that must never surface in the review packet.
  writeFileSync(join(WORK, 'ignored.ts'), 'export const y = 2;\n');
});
afterEach(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('buildReviewPacket — untracked working-tree default', () => {
  test('includes a non-ignored untracked source file', () => {
    const packet = buildReviewPacket(stub(WORK), {});
    expect(packet.changedFiles).toContain('src/new.ts');
  });

  test('flags the untracked source file as missing a test', () => {
    const packet = buildReviewPacket(stub(WORK), {});
    expect(
      packet.missingTestsHeuristic.some((m) => m.startsWith('src/new.ts')),
    ).toBe(true);
  });

  test('excludes a .gitignore-d file', () => {
    const packet = buildReviewPacket(stub(WORK), {});
    expect(packet.changedFiles).not.toContain('ignored.ts');
  });

  test('{ untracked: false } restores the tracked-only diff (no untracked file)', () => {
    const packet = buildReviewPacket(stub(WORK), { untracked: false });
    expect(packet.changedFiles).not.toContain('src/new.ts');
    expect(packet.changedFiles).not.toContain('ignored.ts');
  });
});
