import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPolicyOverrides } from '../policy-overrides.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

/**
 * Every top-level config key the docs tell users to write, and some verb
 * reads, must survive the STRICT config schema. One rejected key discards the
 * WHOLE config — every knowledge verb and gate plane goes empty — so each key
 * gets its own project here: a single rejection cannot hide behind another.
 *
 * Values are the documented examples:
 *   knowledgeCheck        docs/knowledge-integrity.md (read by `release readiness`)
 *   qualityGates          docs/quality-gates.md       (read by `quality`, `report quality`)
 *   policyOverrides       docs/policy-checks.md       (read by policy-overrides.ts)
 *   ownershipFiles        docs/ownership.md           (read by `owners`, `ownership`, MCP)
 *   taskRoutingHintFiles  docs/task-routing-hints.md  (read by task-routing-hint-registry.ts)
 *   playbookFiles         docs/playbooks.md           (read by playbook-registry.ts)
 */
const DOCUMENTED: ReadonlyArray<readonly [string, unknown]> = [
  ['knowledgeCheck', { enabled: true, strict: false, failOn: ['required'] }],
  [
    'qualityGates',
    {
      minReadiness: 70,
      requireBoundaryClean: true,
      requireDriftClean: true,
      requireAgentTests: true,
      requireContextTests: true,
      requirePackSignatures: true,
    },
  ],
  ['policyOverrides', [{ policyId: 'plan:unsigned', severity: 'info', reason: 'dev workspaces only' }]],
  ['ownershipFiles', ['sharkcraft/ownership.ts']],
  ['taskRoutingHintFiles', ['hints/extra.ts']],
  ['playbookFiles', ['pb/extra.ts']],
];

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeProject(extra: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-r75-dockeys-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r75-dockeys', version: '0.0.0', private: true }));
  const sc = join(root, 'sharkcraft');
  mkdirSync(sc);
  const body = { projectName: 'r75-dockeys', ...extra };
  writeFileSync(join(sc, 'sharkcraft.config.ts'), `export default ${JSON.stringify(body, null, 2)};\n`);
  return root;
}

describe('documented top-level config keys load', () => {
  test.each(DOCUMENTED)('%s is accepted and reaches inspection.config', async (key, value) => {
    const inspection = await inspectSharkcraft({ cwd: makeProject({ [key]: value }) });
    expect(inspection.configLoadError).toBeUndefined();
    expect(inspection.config).not.toBeNull();
    expect((inspection.config as unknown as Record<string, unknown>)[key]).toEqual(value);
  }, 30_000);

  test('all documented keys together load', async () => {
    const inspection = await inspectSharkcraft({ cwd: makeProject(Object.fromEntries(DOCUMENTED)) });
    expect(inspection.configLoadError).toBeUndefined();
    expect(inspection.config).not.toBeNull();
  }, 30_000);

  test('the policyOverrides consumer sees the documented override', async () => {
    const inspection = await inspectSharkcraft({
      cwd: makeProject({
        policyOverrides: [{ policyId: 'plan:unsigned', severity: 'info', reason: 'dev workspaces only' }],
      }),
    });
    expect(listPolicyOverrides(inspection)).toEqual([
      { policyId: 'plan:unsigned', severity: 'info', reason: 'dev workspaces only' } as never,
    ]);
  }, 30_000);

  test('a typo INSIDE a documented block still fails loudly — it is not silently ignored', async () => {
    const inspection = await inspectSharkcraft({ cwd: makeProject({ knowledgeCheck: { enable: true } }) });
    expect(inspection.config).toBeNull();
    expect(inspection.configLoadError?.issues.join('\n')).toContain('enable');
  }, 30_000);
});
