import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { impactFor, loadOwnershipRules, matchFile } from '../index.ts';

describe('ownership', () => {
  it('parses CODEOWNERS', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-own-'));
    try {
      writeFileSync(nodePath.join(root, 'CODEOWNERS'), 'src/  @alice\npackages/api/  @bob @carol\n');
      const { rules, sources } = await loadOwnershipRules(root);
      expect(sources.length).toBe(1);
      expect(rules.length).toBe(2);
      expect(rules[0]!.owners).toContain('@alice');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches a file against owners', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-own-'));
    try {
      writeFileSync(nodePath.join(root, 'CODEOWNERS'), 'src/  @team\n');
      const { rules } = await loadOwnershipRules(root);
      const m = matchFile('src/foo.ts', rules);
      expect(m.owners).toContain('@team');
      const im = impactFor(['src/foo.ts', 'other/x.ts'], rules);
      expect(im.owners).toContain('@team');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
