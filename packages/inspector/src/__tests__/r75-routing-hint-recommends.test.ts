/**
 * r75 — routing-hint `recommends` channels are probed AND consumed (spec 4.6#2).
 *
 * `recommends` had no `pipelines` / `rules` / `paths` channel, the doctor never
 * probed the declared `knowledge` / `policies` channels (a dead id there was
 * invisible), and only `recommends.commands` had a consumer — every other
 * channel loaded, validated and reached nothing. One channel table now drives
 * the load lint, the doctor probes and `prepareAgentTask`. Real loaders only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ITaskRoutingRecommends } from '@shrkcrft/plugin-api';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { referenceIdsFor, warmReferenceRegistries } from '../reference-registry.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { prepareAgentTask } from '../agent-task-prep.ts';
import { ROUTING_RECOMMENDS_CHANNEL_KEYS } from '../routing-recommends-channels.ts';

const TIMEOUT_MS = 120_000;
const roots: string[] = [];

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-recommends-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'], ruleFiles: ['rules.ts'], pathFiles: ['paths.ts'] };\n`,
    'sharkcraft/knowledge.ts': `export default [{ id: 'fx.k', title: 'Fx knowledge', type: 'architecture', priority: 'high', scope: [], tags: [], appliesWhen: [], content: 'Fx.' }];\n`,
    'sharkcraft/pipelines.ts': `export default [{ id: 'fx.pipe', title: 'Fx pipeline', description: 'A fixture pipeline.', tags: [], steps: [{ id: 'step-1', type: 'manual', description: 'Do the thing.' }] }];\n`,
    'sharkcraft/rules.ts': `export default [{ id: 'fx.rule', title: 'Fx rule', type: 'rule', priority: 'high', scope: [], tags: [], appliesWhen: [], content: 'Fx rule.' }];\n`,
    'sharkcraft/paths.ts': `export default [{ id: 'fx.path', title: 'Fx path', type: 'path', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'Fx path.', metadata: { path: 'src' } }];\n`,
    'sharkcraft/policies.ts': `export default [{ id: 'fx.policy', title: 'Fx policy', severity: 'warning', checkType: 'path', evaluate: () => true }];\n`,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

let insp: ISharkcraftInspection;
let pipelineId = '';

beforeAll(async () => {
  // A pipeline id that is really registered (the built-ins every workspace loads).
  const probe = await inspectSharkcraft({ cwd: workspace({}) });
  pipelineId = referenceIdsFor(probe, 'pipeline')[0] ?? '';
  const hints = `export default [
  { id: 'h.bad', title: 'Bad targets', match: { keywords: ['badrecs'] },
    recommends: { pipelines: ['nope'], rules: ['nope'], paths: ['nope'], knowledge: ['no.such'], policies: ['no.such.policy'] } },
  { id: 'h.good', title: 'Good targets', match: { keywords: ['goodrecs'] },
    recommends: { pipelines: ['${pipelineId}'], rules: ['fx.rule'], paths: ['fx.path'], knowledge: ['fx.k'], policies: ['fx.policy'] } },
  { id: 'h.typo', title: 'Typo channel', match: { keywords: ['typorecs'] }, recommends: { pipeline: ['${pipelineId}'] } },
];
`;
  insp = await inspectSharkcraft({ cwd: workspace({ 'sharkcraft/task-routing-hints.ts': hints }) });
  await warmReferenceRegistries(insp);
}, TIMEOUT_MS);

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('r75 routing-hint recommends channels', () => {
  test('the fixture registers one id of every probed kind (else the test is blind)', () => {
    expect(pipelineId).not.toBe('');
    for (const kind of ['rule', 'path-convention', 'knowledge', 'policy'] as const) {
      expect({ kind, n: referenceIdsFor(insp, kind).length > 0 }).toEqual({ kind, n: true });
    }
  });

  test('dead ids in pipelines / rules / paths / knowledge / policies → 5 findings, each its own kind', async () => {
    const report = await buildSelfConfigDoctorReportV2(insp);
    const bad = report.findings
      .filter((f) => f.sourceId === 'h.bad' && f.code.startsWith('routing-hint-'))
      .map((f) => [f.code, f.targetKind, f.targetId])
      .sort();
    expect(bad).toEqual(
      [
        ['routing-hint-knowledge-missing', 'knowledge', 'no.such'],
        // Round 12: targetKind is THE kind the id resolved against (`selfKindOf`),
        // no longer relabelled (`path` was a display alias of `path-convention`).
        ['routing-hint-path-missing', 'path-convention', 'nope'],
        ['routing-hint-pipeline-missing', 'pipeline', 'nope'],
        ['routing-hint-policy-missing', 'policy', 'no.such.policy'],
        ['routing-hint-rule-missing', 'rule', 'nope'],
      ].sort(),
    );
    // The same channels holding registered ids → nothing.
    expect(report.findings.filter((f) => f.sourceId === 'h.good')).toEqual([]);
    const probe = report.probes['routing-hint-target'];
    expect(probe).toMatchObject({ missing: 5, unverified: 0 });
    expect(probe.resolved).toBeGreaterThanOrEqual(5);
  });

  test('a typo channel key (`pipeline`) is reported, with the channel it meant', async () => {
    const report = await buildSelfConfigDoctorReportV2(insp);
    const typo = report.findings.filter((f) => f.code === 'routing-hint-unknown-recommends-key');
    expect(typo.map((f) => f.sourceId)).toEqual(['h.typo']);
    expect(typo[0]!.message).toContain('Did you mean "pipelines"');
  });

  test('prepareAgentTask hands the agent the resolved assets — and never a dead one', async () => {
    const good = await prepareAgentTask(insp, 'goodrecs please');
    const assets = good.recommendedAssets.map((a) => `${a.kind}:${a.id}:${a.hintId}`).sort();
    expect(assets).toEqual(
      [
        `pipeline:${pipelineId}:h.good`,
        'rule:fx.rule:h.good',
        'path-convention:fx.path:h.good',
        'knowledge:fx.k:h.good',
        'policy:fx.policy:h.good',
      ].sort(),
    );
    expect(good.routingHints.find((h) => h.id === 'h.good')?.recommends.rules).toEqual(['fx.rule']);
    const bad = await prepareAgentTask(insp, 'badrecs please');
    expect(bad.recommendedAssets).toEqual([]);
  }, TIMEOUT_MS);

  test('channel-table completeness: every key of ITaskRoutingRecommends has a row', () => {
    // `Required<>` makes a channel added to the public shape without a row
    // here a compile error; the runtime check makes the table equal it.
    const full: Required<ITaskRoutingRecommends> = {
      commands: [],
      templates: [],
      playbooks: [],
      helpers: [],
      profiles: [],
      conventions: [],
      knowledge: [],
      policies: [],
      pipelines: [],
      rules: [],
      paths: [],
    };
    expect(Object.keys(full).sort()).toEqual([...ROUTING_RECOMMENDS_CHANNEL_KEYS].sort());
  });
});
