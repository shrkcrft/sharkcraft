/**
 * r75 — the test runners keep NO private id source (spec 4.3 #5, part 3).
 *
 * The agent-contract runner carried a parallel resolver: a `*Quietly` helper
 * per kind (the helper set missed pack helpers), a phantom
 * `inspection.commandCatalog` read (every correct `expectedCommands` entry
 * failed), and an `expectedRules` existence check against the KNOWLEDGE
 * entries — so a knowledge-but-not-rule id was told "exists but the ranker did
 * not surface it", a permanently red test with a false hint. The CLI and MCP
 * also took different paths. Every existence answer now comes from the shared
 * reference registry, and every diagnostic names the registry it consulted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommandResolutionStatus } from '../command-resolution-status.ts';
import { runPackTests } from '../pack-test-runner.ts';
import {
  referenceIdExists,
  referenceIdsFor,
  warmReferenceRegistries,
  type ReferenceKind,
} from '../reference-registry.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { loadAgentContractRegistries, runAgentContractTest } from '../test-runner.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const NONSENSE_TASK = 'qqzx wvvk plorf';

let repo: ISharkcraftInspection;

beforeAll(async () => {
  repo = await inspectSharkcraft({ cwd: REPO_ROOT });
  await warmReferenceRegistries(repo);
}, 120_000);

function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-runner-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe('PROPERTY: existence expectations ≡ referenceIdExists on the real repo', () => {
  const slots: readonly [ReferenceKind, 'expectedHelpers' | 'expectedPlaybooks' | 'expectedPolicies' | 'expectedConstructs' | 'expectedKnowledge', 'missingHelpers' | 'missingPlaybooks' | 'missingPolicies' | 'missingConstructs' | 'missingKnowledge'][] = [
    ['helper', 'expectedHelpers', 'missingHelpers'],
    ['playbook', 'expectedPlaybooks', 'missingPlaybooks'],
    ['policy', 'expectedPolicies', 'missingPolicies'],
    ['construct', 'expectedConstructs', 'missingConstructs'],
    ['knowledge', 'expectedKnowledge', 'missingKnowledge'],
  ];
  for (const [kind, field, missingField] of slots) {
    test(`${kind}: every listed id passes, a bogus one fails as unknown-id naming the ${kind} registry`, () => {
      const listed = [...referenceIdsFor(repo, kind)].slice(0, 40);
      const bogus = `r75.no-such-${kind}`;
      const result = runAgentContractTest(repo, {
        id: `prop-${kind}`,
        task: NONSENSE_TASK,
        [field]: [...listed, bogus],
      });
      expect(result[missingField]).toEqual([bogus]);
      for (const id of listed) expect(referenceIdExists(repo, kind, id)).toBe(true);
      const d = result.diagnostics?.find((x) => x.id === bogus);
      expect(d?.code).toBe('unknown-id');
      expect(d?.assertion).toBe('exists');
      expect(d?.consulted?.kind).toBe(kind);
      expect(d?.consulted?.size).toBe(referenceIdsFor(repo, kind).length);
      expect(result.verdict).toBe('fail');
    });
  }

  test('the deprecated snapshot is a projection of the same registry, never a second source', async () => {
    const snap = await loadAgentContractRegistries(repo);
    for (const kind of ['helper', 'playbook', 'policy', 'construct', 'knowledge'] as const) {
      const key = kind === 'helper' ? 'helpers' : kind === 'playbook' ? 'playbooks' : kind === 'policy' ? 'policies' : kind === 'construct' ? 'constructs' : 'knowledge';
      expect([...snap[key]].sort()).toEqual([...referenceIdsFor(repo, kind)].sort());
    }
  });
});

describe('surfaced vs exists — the rule registry, not the knowledge entries', () => {
  test('expectedRules with a knowledge-but-not-rule id → unknown-id, consulted `shrk rules list`', () => {
    const rules = new Set(referenceIdsFor(repo, 'rule'));
    const knowledgeOnly = referenceIdsFor(repo, 'knowledge').find((id) => !rules.has(id));
    expect(knowledgeOnly).toBeDefined();
    const r = runAgentContractTest(repo, { id: 'kr', task: NONSENSE_TASK, expectedRules: [knowledgeOnly!] });
    const d = r.diagnostics?.find((x) => x.kind === 'rule');
    expect(d?.code).toBe('unknown-id');
    expect(d?.assertion).toBe('surfaced');
    expect(d?.consulted).toEqual({ kind: 'rule', listVerb: 'shrk rules list', size: rules.size });
  });

  test('a real rule the ranker did not surface → not-surfaced', () => {
    const rule = referenceIdsFor(repo, 'rule')[0];
    expect(rule).toBeDefined();
    const r = runAgentContractTest(repo, { id: 'rs', task: NONSENSE_TASK, expectedRules: [rule!] });
    if (r.missingRules?.includes(rule!)) {
      expect(r.diagnostics?.find((x) => x.kind === 'rule')?.code).toBe('not-surfaced');
    }
  });

  test('the MCP path and the CLI path give identical results (no registries → same registry)', async () => {
    const test1 = { id: 'same', task: 'add a new CLI command', expectedPlaybooks: ['r75.nope'], expectedKnowledge: ['engine.changed-only-boundaries'] };
    const viaMcp = runAgentContractTest(repo, test1);
    const viaCli = runAgentContractTest(repo, test1, await loadAgentContractRegistries(repo));
    expect(JSON.stringify(viaCli)).toBe(JSON.stringify(viaMcp));
  });
});

describe('commands and cold caches are NOT VERIFIED, never a false pass or a false fail', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
      'sharkcraft/playbooks.ts': `export default [{ id: 'p.real', title: 'Real playbook', steps: [] }];\n`,
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('an unsurfaced expectedCommands entry without a resolver → not-verified / unverifiable', async () => {
    const inspection = await inspectSharkcraft({ cwd: root });
    await warmReferenceRegistries(inspection);
    const r = runAgentContractTest(inspection, { id: 'c', task: NONSENSE_TASK, expectedCommands: ['shrk doctor'] });
    expect(r.passed).toBe(false);
    expect(r.verdict).toBe('not-verified');
    expect(r.unverified).toEqual(['command:shrk doctor']);
    expect(r.diagnostics?.[0]?.code).toBe('unverifiable');
  });

  test('with the injected resolver: a real command passes, a dead one is unknown-command with a suggestion', async () => {
    const inspection = await inspectSharkcraft({ cwd: root });
    const asked: { raw: string; assumeShrk: boolean }[] = [];
    await warmReferenceRegistries(inspection, {
      commandResolver: (raw, options) => {
        asked.push({ raw, assumeShrk: options?.assumeShrk === true });
        return raw === 'shrk doctor'
          ? { status: CommandResolutionStatus.Ok, matched: 'doctor' }
          : { status: CommandResolutionStatus.UnknownVerb, closest: ['shrk doctor'] };
      },
    });
    const ok = runAgentContractTest(inspection, { id: 'ok', task: NONSENSE_TASK, expectedCommands: ['shrk doctor'] });
    expect(ok.passed).toBe(true);
    expect(ok.verdict).toBe('pass');
    // The runner keeps NO private normalisation: it hands the string verbatim
    // to the one resolver and asks for the command-REFERENCE reading (the CLI
    // resolver reads a bare `doctor` as `shrk doctor` — proven end to end in
    // cli r75-doctor-review-fixes.test.ts, against the real index).
    expect(asked).toContainEqual({ raw: 'shrk doctor', assumeShrk: true });
    runAgentContractTest(inspection, { id: 'bare', task: NONSENSE_TASK, expectedCommands: ['doctor'] });
    expect(asked).toContainEqual({ raw: 'doctor', assumeShrk: true });
    const dead = runAgentContractTest(inspection, { id: 'dead', task: NONSENSE_TASK, expectedCommands: ['shrk doctr'] });
    expect(dead.verdict).toBe('fail');
    expect(dead.diagnostics?.[0]).toMatchObject({ code: 'unknown-command', closest: ['shrk doctor'] });
  });

  test('a cache-backed kind read before any warm → unverifiable, not "your id is wrong"', async () => {
    const cold = workspace({
      'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
      'sharkcraft/playbooks.ts': `export default [{ id: 'p.real', title: 'Real playbook', steps: [] }];\n`,
    });
    try {
      const inspection = await inspectSharkcraft({ cwd: cold });
      const r = runAgentContractTest(inspection, { id: 'cold', task: NONSENSE_TASK, expectedPlaybooks: ['p.real'] });
      expect(r.verdict).toBe('not-verified');
      expect(r.diagnostics?.[0]?.code).toBe('unverifiable');
    } finally {
      rmSync(cold, { recursive: true, force: true });
    }
  });
});

describe('pack tests evaluate the existence fields they declare', () => {
  test('expectPlaybookIds with an unknown id FAILS as unknown-id (it was silently green)', async () => {
    const pack = workspace({
      'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
      'sharkcraft/playbooks.ts': `export default [{ id: 'p.real', title: 'Real playbook', steps: [] }];\n`,
      'sharkcraft/pack-tests.ts': `export default [
  { id: 'c1', task: '${NONSENSE_TASK}', expectPlaybookIds: ['p.real', 'p.typo'] },
];
`,
    });
    try {
      const report = await runPackTests({ packPath: pack });
      expect(report.ran).toBe(1);
      const c1 = report.cases[0]!;
      expect(c1.passed).toBe(false);
      expect(c1.diagnostics.map((d) => [d.code, d.expected, d.assertion])).toEqual([
        ['unknown-id', 'p.typo', 'exists'],
      ]);
      expect(c1.diagnostics[0]!.consulted?.kind).toBe('playbook');
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  }, 60_000);
});
