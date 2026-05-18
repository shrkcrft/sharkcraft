/**
 * Additive contract test.
 *
 * The headline guarantee of: running the additive surface
 * (`shrk grounding`, `shrk plan check`) against a repo NEVER modifies
 * any file outside `.sharkcraft/`. If shrk is uninstalled tomorrow,
 * the repo is bit-identical to before.
 *
 * Mechanism: snapshot every tracked file's bytes before running, then
 * run the surface, then re-snapshot and diff. Anything under
 * `.sharkcraft/` is ignored (it's gitignored anyway).
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { groundingCommand } from '../commands/grounding.command.ts';
import { planCheckCommand } from '../commands/plan-check.command.ts';
import {
  makeArgs,
  makeTestProject,
  type ITestProjectHandle,
} from './_helpers/test-project.ts';

const TEAM_PLAN_BODY = `---
title: Add billing endpoint
intent: Add POST /billing
affectedFiles:
  - apps/api/src/billing.ts
acceptanceCriteria:
  - id: ac-1
    text: Returns 200
    verifiedBy: [tests]
verificationCommandIds: [typecheck]
---

Body.
`;

let project: ITestProjectHandle;

beforeEach(() => {
  project = makeTestProject({
    projectName: 'r58-additive-test',
    description: 'r58 additive smoke',
    withFiles: {
      'docs/business/billing-rules.md': '# Billing rules\n\nDocument the rules.\n',
      'plans/feature.md': TEAM_PLAN_BODY,
    },
  });
});

afterEach(() => {
  project.cleanup();
});

interface IFileSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

function snapshotTree(root: string): IFileSnapshot[] {
  const out: IFileSnapshot[] = [];
  walk(root, root, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function walk(absDir: string, root: string, out: IFileSnapshot[]): void {
  const rel = nodePath.relative(root, absDir);
  // Ignore anything under `.sharkcraft/` — that's where shrk is allowed to write.
  if (rel.startsWith('.sharkcraft') || rel === '.sharkcraft') return;
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === '.sharkcraft') continue;
    const abs = nodePath.join(absDir, entry);
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(abs, root, out);
    } else if (s.isFile()) {
      const buf = readFileSync(abs);
      out.push({
        path: nodePath.relative(root, abs),
        sha256: createHash('sha256').update(buf).digest('hex'),
        sizeBytes: buf.length,
      });
    }
  }
}

describe('additive contract', () => {
  test('shrk grounding writes nothing outside .sharkcraft/', async () => {
    const before = snapshotTree(project.root);
    const rc = await groundingCommand.run(makeArgs(project.root, ['index billing rules'], { json: true }));
    expect(rc).toBe(0);
    const after = snapshotTree(project.root);
    expect(after).toEqual(before);
  });

  test('shrk plan check writes nothing outside .sharkcraft/', async () => {
    const before = snapshotTree(project.root);
    const rc = await planCheckCommand.run(
      makeArgs(project.root, ['plans/feature.md'], {
        extractor: 'markdown-frontmatter-loose',
        json: true,
      }),
    );
    expect(rc).toBe(0);
    const after = snapshotTree(project.root);
    expect(after).toEqual(before);
  });

  test('the input plan file is byte-identical after plan check', async () => {
    const planPath = nodePath.join(project.root, 'plans/feature.md');
    const before = readFileSync(planPath);
    await planCheckCommand.run(
      makeArgs(project.root, ['plans/feature.md'], {
        extractor: 'markdown-frontmatter-loose',
        json: true,
      }),
    );
    const after = readFileSync(planPath);
    expect(after.equals(before)).toBe(true);
  });

  test('deleting .sharkcraft/ leaves the repo byte-identical to before', async () => {
    const before = snapshotTree(project.root);
    await groundingCommand.run(makeArgs(project.root, ['demo'], { json: true }));
    await planCheckCommand.run(
      makeArgs(project.root, ['plans/feature.md'], {
        extractor: 'markdown-frontmatter-loose',
        json: true,
      }),
    );
    // Simulate uninstalling shrk by deleting its scratch directory.
    const scratch = nodePath.join(project.root, '.sharkcraft');
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    const after = snapshotTree(project.root);
    expect(after).toEqual(before);
  });
});
