/**
 * Test fixtures + re-exports used by the feature-accelerator tests.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

export {
  buildUncertaintyReport,
  type IUncertaintyReport,
} from '../uncertainty-report.ts';

import type { IRegistrationHint } from '@shrkcrft/plugin-api';
export type { IRegistrationHint };

export async function buildRegistrationHintRegistryFixture(): Promise<{
  entries: { hint: { id: string; title: string } }[];
  issues: { severity: 'info' | 'warning' | 'error' }[];
}> {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r35-reghint-'));
  const sharkcraftDir = nodePath.join(dir, 'sharkcraft');
  mkdirSync(sharkcraftDir, { recursive: true });
  // Provide a config file so the workspace loader treats this as a project.
  writeFileSync(
    nodePath.join(dir, 'package.json'),
    JSON.stringify({ name: 'r35-fixture' }, null, 2),
    'utf8',
  );
  writeFileSync(
    nodePath.join(sharkcraftDir, 'sharkcraft.config.ts'),
    `export default { projectName: 'r35-fixture' } as const;\n`,
    'utf8',
  );
  writeFileSync(
    nodePath.join(sharkcraftDir, 'registration-hints.ts'),
    `export default [
  {
    id: 'fixture.example',
    title: 'Fixture registration hint',
    discovery: { targetFile: 'src/composer.ts' },
    operations: [{ kind: 'append', snippet: '// fixture' }],
  },
];
`,
    'utf8',
  );

  const { inspectSharkcraft, loadRegistrationHints } = await import('../index.ts');
  const inspection = await inspectSharkcraft({ cwd: dir });
  const { entries, issues } = await loadRegistrationHints(inspection);
  return {
    entries: entries.map((e) => ({ hint: { id: e.hint.id, title: e.hint.title } })),
    issues: issues.map((i) => ({ severity: i.severity })),
  };
}
