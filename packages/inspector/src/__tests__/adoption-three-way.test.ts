import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { previewThreeWay, ThreeWayVerdict } from '../adoption-three-way.ts';

function makeFile(content: string): { root: string; path: string; hash: string } {
  const root = mkdtempSync(join(tmpdir(), 'shrk-three-way-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  const rel = 'sharkcraft/rules.ts';
  writeFileSync(join(root, rel), content);
  const hash = createHash('sha256').update(content).digest('hex');
  return { root, path: rel, hash };
}

describe('three-way preview', () => {
  test('safe when target hash unchanged', () => {
    const { root, path, hash } = makeFile('// rules\n');
    const r = previewThreeWay({ projectRoot: root, relativePath: path, baseHash: hash });
    expect(r.verdict).toBe(ThreeWayVerdict.Safe);
    expect(r.targetUnchanged).toBe(true);
  });

  test('stale-target when file deleted', () => {
    const { root, path, hash } = makeFile('// rules\n');
    rmSync(join(root, path));
    const r = previewThreeWay({ projectRoot: root, relativePath: path, baseHash: hash });
    expect(r.verdict).toBe(ThreeWayVerdict.StaleTarget);
  });

  test('stale-draft when draft moved', () => {
    const { root, path, hash } = makeFile('// rules\n');
    const r = previewThreeWay({
      projectRoot: root,
      relativePath: path,
      baseHash: hash,
      draftChangedSinceState: true,
    });
    expect(r.verdict).toBe(ThreeWayVerdict.StaleDraft);
  });

  test('create-file-safe when base hash is "(missing)" and file is absent', () => {
    const { root, path } = makeFile('// rules\n');
    rmSync(join(root, path));
    const r = previewThreeWay({ projectRoot: root, relativePath: path, baseHash: '(missing)' });
    expect(r.verdict).toBe(ThreeWayVerdict.CreateFileSafe);
  });

  test('stale-target when "(missing)" base sees a file present', () => {
    const { root, path } = makeFile('// existed!\n');
    const r = previewThreeWay({ projectRoot: root, relativePath: path, baseHash: '(missing)' });
    expect(r.verdict).toBe(ThreeWayVerdict.StaleTarget);
  });

  test('probably-safe when target hash changed but file is non-empty', () => {
    const { root, path } = makeFile('// rules v1\n');
    const r = previewThreeWay({
      projectRoot: root,
      relativePath: path,
      baseHash: 'somethingelse',
    });
    expect(r.verdict).toBe(ThreeWayVerdict.ProbablySafe);
  });

  test('manual-review when append block is already in the file', () => {
    const fragment = '// adopted block';
    const { root, path, hash } = makeFile(`// rules\n${fragment}\n`);
    const r = previewThreeWay({
      projectRoot: root,
      relativePath: path,
      baseHash: hash,
      appendBlock: fragment,
    });
    expect(r.alreadyApplied).toBe(true);
    expect(r.verdict).toBe(ThreeWayVerdict.ManualReview);
  });
});
