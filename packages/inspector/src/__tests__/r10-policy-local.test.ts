import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { evaluatePolicy, inspectSharkcraft } from '../index.ts';

describe('local policy checks', () => {
  it('loads sharkcraft/policies.ts and runs the declared predicate', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r10-pol-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const policiesDir = nodePath.join(root, 'sharkcraft');
      writeFileSync(
        nodePath.join(root, 'sharkcraft.policies.json.placeholder'),
        '',
      );
      // Use writeFileSync with mkdirSync indirectly via path existence.
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '0.0.0' }),
      );
      // We need a sharkcraft/ directory.
      mkdirSync(policiesDir, { recursive: true });
      writeFileSync(
        nodePath.join(policiesDir, 'policies.ts'),
        `const policies = [{
          id: 'test.always-fail',
          title: 'always-fail predicate',
          severity: 'warning',
          checkType: 'path',
          evaluate() { return { message: 'always-fail fired' }; },
        }];
        export default policies;
        `,
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await evaluatePolicy(inspection);
      const myReg = r.registrations.find((x) => x.id === 'local:test.always-fail');
      expect(myReg).toBeDefined();
      expect(r.checks.some((c) => c.id === 'local:test.always-fail')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
