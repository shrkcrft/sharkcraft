import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { clearPackDiscoveryCache } from '@shrkcrft/packs';
import { getWiringGraphTool } from '../tools/get-wiring-graph.tool.ts';

/**
 * ApiToken: declared + provided + consumed → wired.
 * DbToken:  declared + provided, NOT consumed → orphan.
 * GhostToken: declared + consumed, NOT provided → unprovided (silent at runtime).
 */
function makeFixture(withIdioms: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-wiring-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    withIdioms
      ? `export default {
  registrationGraph: [
    { name: 'di',
      declared: { files: ['src/**/*.ts'], pattern: 'export const ([A-Za-z]+) = new InjectionToken' },
      provided: { files: ['src/**/*.ts'], arrayProperty: 'providers' },
      consumed: { files: ['src/**/*.ts'], pattern: 'inject[(]([A-Za-z]+)' } },
  ],
};
`
      : `export default {};\n`,
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'tokens.ts'),
    "export const ApiToken = new InjectionToken('api');\n" +
      "export const DbToken = new InjectionToken('db');\n" +
      "export const GhostToken = new InjectionToken('ghost');\n",
  );
  writeFileSync(join(root, 'src', 'module.ts'), 'const providers = [ApiToken, DbToken];\n');
  writeFileSync(
    join(root, 'src', 'service.ts'),
    'const a = inject(ApiToken);\nconst g = inject(GhostToken);\n',
  );
  return root;
}

describe('get_wiring_graph MCP tool', () => {
  beforeEach(() => clearPackDiscoveryCache());

  test('returns unprovided + orphans from the registration graph, and writes nothing', async () => {
    const root = makeFixture(true);
    try {
      const before = readdirSync(root).sort();
      const inspection = await inspectSharkcraft({ cwd: root });
      const result = await getWiringGraphTool.handler({}, { inspection, cwd: root });
      expect(result.isError ?? false).toBe(false);
      const data = result.data as {
        unprovided: { token: string }[];
        orphans: { token: string }[];
        unprovidedCount: number;
        orphanCount: number;
        nextCommand: string;
      };
      expect(data.unprovided.map((u) => u.token)).toEqual(['GhostToken']);
      expect(data.orphans.map((o) => o.token)).toEqual(['DbToken']);
      expect(data.unprovidedCount).toBe(1);
      expect(data.orphanCount).toBe(1);
      expect(data.nextCommand).toContain('shrk wiring');
      // Read-only: no persisted cache or any other file written.
      expect(readdirSync(root).sort()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('with a token, also returns that token\'s chain + verdict', async () => {
    const root = makeFixture(true);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const result = await getWiringGraphTool.handler({ token: 'ApiToken' }, { inspection, cwd: root });
      const data = result.data as {
        token: string;
        chain: { isDeclared: boolean; isProvided: boolean; isConsumed: boolean } | null;
      };
      expect(data.token).toBe('ApiToken');
      expect(data.chain?.isDeclared && data.chain?.isProvided && data.chain?.isConsumed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports a helpful note when no registration idioms are configured', async () => {
    const root = makeFixture(false);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const result = await getWiringGraphTool.handler({}, { inspection, cwd: root });
      const data = result.data as { idioms: string[]; note?: string; unprovided: unknown[] };
      expect(data.idioms).toEqual([]);
      expect(data.unprovided).toEqual([]);
      expect((data.note ?? '').toLowerCase()).toContain('no registration idioms');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
