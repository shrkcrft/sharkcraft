import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { generatePackDocs } from '../index.ts';

describe('r18 pack docs generator', () => {
  test('generates a contribution table and safety notes', () => {
    const root = nodePath.join(tmpdir(), `r18-pack-docs-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({
        name: 'example/test-pack',
        version: '1.2.3',
        description: 'Example test pack.',
        sharkcraft: {
          manifestVersion: 'v1',
          ruleFiles: ['rules.ts'],
          templateFiles: ['templates.ts'],
        },
      }),
    );
    try {
      const docs = generatePackDocs(root);
      expect(docs.packName).toBe('example/test-pack');
      expect(docs.packVersion).toBe('1.2.3');
      expect(docs.body).toContain('## Contributions');
      expect(docs.body).toContain('## Safety notes');
      expect(docs.body).toContain('## Compatibility');
      expect(docs.body).toMatch(/rules.*\|\s*1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
