/**
 * Round 11 §1.4#b — the in-process TypeScript check moved down one layer
 * (`typecheckFiles` in @shrkcrft/inspector) so pack health can use it;
 * `typecheckEmittedFiles` is now a thin wrapper and `gen --typecheck` must be
 * unchanged. Same emitted fixture → same errors, through both entry points.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { typecheckFiles } from '@shrkcrft/inspector';
import { typecheckEmittedFiles } from '../validation/typecheck-emitted.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-tcparity-'));
  roots.push(root);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' } }));
  writeFileSync(join(root, 'lib.ts'), 'export const answer: number = 42;\n');
  return root;
}

describe('typecheckEmittedFiles ≡ typecheckFiles over an overlay', () => {
  test('an emitted type error: same file / line / column / message through both entry points', () => {
    const root = project();
    const files = [
      { absPath: join(root, 'src/bad.ts'), contents: "import { answer } from '../lib';\nexport const s: string = answer;\n" },
      { absPath: join(root, 'src/good.ts'), contents: "import { answer } from '../lib';\nexport const n: number = answer;\n" },
    ];
    const wrapped = typecheckEmittedFiles(root, files);
    const direct = typecheckFiles(root, {
      rootNames: files.map((f) => resolve(f.absPath)),
      overlay: new Map(files.map((f) => [resolve(f.absPath), f.contents] as const)),
    });
    expect(wrapped.ran).toBe(true);
    expect(wrapped.errors.length).toBe(1);
    expect(wrapped.errors[0]).toMatchObject({ file: resolve(root, 'src/bad.ts'), line: 2 });
    expect(wrapped.errors).toEqual(direct.errors.map(({ file, line, column, message }) => ({ file, line, column, message })));
    expect(wrapped.note).toBe(`checked against ${resolve(root, 'tsconfig.json')}`);
    // Nothing was written to disk.
    expect(() => require('node:fs').readFileSync(join(root, 'src/bad.ts'))).toThrow();
  });

  test('a docs-only emit set does not run', () => {
    const root = project();
    expect(typecheckEmittedFiles(root, [{ absPath: join(root, 'README.md'), contents: '# x' }])).toEqual({
      ran: false,
      errors: [],
      note: 'no TS/TSX files in the emit set',
    });
  });

  test('reportOnlyUnder widens the scope to imported files under a directory (the pack mode)', () => {
    const root = project();
    writeFileSync(join(root, 'group.ts'), 'export const g: number = "not a number";\n');
    writeFileSync(join(root, 'index.ts'), "import { g } from './group';\nexport default [g];\n");
    expect(typecheckFiles(root, { rootNames: ['index.ts'] }).errors).toEqual([]);
    const widened = typecheckFiles(root, { rootNames: ['index.ts'], reportOnlyUnder: root });
    expect(widened.errors.map((e) => e.file)).toEqual([resolve(root, 'group.ts')]);
  });
});
