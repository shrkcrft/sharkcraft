import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  AdoptionCheckpointStatus,
  evaluateAdoptionCheckpoint,
  hashContent,
  readAdoptionCheckpoint,
  recordAdoptionCheckpoint,
} from '../adoption-checkpoint.ts';

function fixture(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-checkpoint-'));
  mkdirSync(nodePath.join(root, 'sharkcraft/construct-drafts/adoption'), { recursive: true });
  writeFileSync(nodePath.join(root, 'sharkcraft/constructs.ts'), 'export default [];\n');
  writeFileSync(
    nodePath.join(root, 'sharkcraft/construct-drafts/constructs.draft.ts'),
    'export default [];\n',
  );
  return root;
}

describe('r15 adoption checkpoint', () => {
  test('missing checkpoint reports missing', () => {
    const root = fixture();
    const read = readAdoptionCheckpoint(root, 'construct');
    expect(read.exists).toBe(false);
    const evaluation = evaluateAdoptionCheckpoint(root, read.checkpoint, hashContent('diff'));
    expect(evaluation.status).toBe(AdoptionCheckpointStatus.Missing);
  });

  test('fresh checkpoint reports up-to-date when nothing changed', () => {
    const root = fixture();
    const diffHash = hashContent('canonical diff body');
    const checkpoint = recordAdoptionCheckpoint({
      projectRoot: root,
      kind: 'construct',
      command: 'test',
      diffHash,
      targets: ['sharkcraft/constructs.ts'],
      drafts: ['sharkcraft/construct-drafts/constructs.draft.ts'],
    });
    expect(checkpoint.diffHash).toBe(diffHash);
    const evaluation = evaluateAdoptionCheckpoint(root, checkpoint, diffHash);
    expect(evaluation.status).toBe(AdoptionCheckpointStatus.UpToDate);
  });

  test('target change reports stale-target', () => {
    const root = fixture();
    const diffHash = hashContent('initial');
    const checkpoint = recordAdoptionCheckpoint({
      projectRoot: root,
      kind: 'construct',
      command: 'test',
      diffHash,
      targets: ['sharkcraft/constructs.ts'],
      drafts: ['sharkcraft/construct-drafts/constructs.draft.ts'],
    });
    // Mutate the target file.
    writeFileSync(nodePath.join(root, 'sharkcraft/constructs.ts'), 'export default [1];\n');
    const evaluation = evaluateAdoptionCheckpoint(root, checkpoint, diffHash);
    expect(evaluation.status).toBe(AdoptionCheckpointStatus.StaleTarget);
    expect(evaluation.changedTargets).toContain('sharkcraft/constructs.ts');
  });

  test('draft change reports stale-draft', () => {
    const root = fixture();
    const diffHash = hashContent('initial');
    const checkpoint = recordAdoptionCheckpoint({
      projectRoot: root,
      kind: 'construct',
      command: 'test',
      diffHash,
      targets: ['sharkcraft/constructs.ts'],
      drafts: ['sharkcraft/construct-drafts/constructs.draft.ts'],
    });
    writeFileSync(
      nodePath.join(root, 'sharkcraft/construct-drafts/constructs.draft.ts'),
      'export default [{ id: "x" }];\n',
    );
    const evaluation = evaluateAdoptionCheckpoint(root, checkpoint, diffHash);
    expect(evaluation.status).toBe(AdoptionCheckpointStatus.StaleDraft);
    expect(evaluation.changedDrafts.length).toBeGreaterThan(0);
  });

  test('diff hash change reports stale-diff', () => {
    const root = fixture();
    const diffHash = hashContent('initial');
    const checkpoint = recordAdoptionCheckpoint({
      projectRoot: root,
      kind: 'construct',
      command: 'test',
      diffHash,
      targets: ['sharkcraft/constructs.ts'],
      drafts: ['sharkcraft/construct-drafts/constructs.draft.ts'],
    });
    const evaluation = evaluateAdoptionCheckpoint(root, checkpoint, hashContent('updated'));
    expect(evaluation.status).toBe(AdoptionCheckpointStatus.StaleDiff);
  });
});
