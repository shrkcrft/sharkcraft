/**
 * R29 PART 15 — SharkCraft self search tuning.
 *
 * Biases the deterministic search ranker toward R28/R29 surface so
 * agents find the right knowledge / template / playbook on the first
 * query.
 */

interface ILocalSearchTaskHint {
  whenTokens?: readonly string[];
  boostTags?: Record<string, number>;
  boostKinds?: Record<string, number>;
  boostIds?: Record<string, number>;
}

interface ILocalSearchTuning {
  id: string;
  appliesToKinds?: readonly string[];
  mergeStrategy?: 'sum' | 'max';
  boostTags?: Record<string, number>;
  boostIds?: Record<string, number>;
  boostSources?: Record<string, number>;
  taskHints?: readonly ILocalSearchTaskHint[];
}

function defineSearchTuning(t: ILocalSearchTuning): ILocalSearchTuning {
  return t;
}

export default [
  defineSearchTuning({
    id: 'r29.bias.changed-only-boundaries',
    taskHints: [
      {
        whenTokens: ['changed-only', 'boundary'],
        boostIds: {
          'engine.changed-only-boundaries': 5,
          'changed-only-per-file': 3,
        },
        boostTags: { 'changed-only': 3, boundaries: 2 },
      },
      {
        whenTokens: ['changed', 'only'],
        boostIds: { 'engine.changed-only-boundaries': 4 },
        boostTags: { 'changed-only': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.helper-plan',
    taskHints: [
      {
        whenTokens: ['helper', 'plan'],
        boostIds: {
          'engine.helper-plan-registry': 4,
          'helpers-produce-plans-not-writes': 2,
        },
        boostTags: { helpers: 3, plan: 2 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.registry-lifecycle',
    taskHints: [
      {
        whenTokens: ['registry', 'lifecycle'],
        boostIds: { 'engine.registry-lifecycle-rule': 4 },
        boostTags: { registry: 3 },
      },
      {
        whenTokens: ['register'],
        boostIds: { 'engine.registry-lifecycle-rule': 2 },
      },
    ],
  }),
  // ─────────────────────────── SharkCraft engine ────────────────────────────
  defineSearchTuning({
    id: 'r29.bias.new-cli-command',
    taskHints: [
      {
        whenTokens: ['new', 'cli', 'command'],
        boostIds: {
          'sharkcraft.cli-command': 5,
        },
        boostTags: { cli: 3, command: 2 },
      },
      {
        whenTokens: ['shrk', 'command'],
        boostIds: { 'sharkcraft.cli-command': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.new-mcp-tool',
    taskHints: [
      {
        whenTokens: ['new', 'mcp', 'tool'],
        boostIds: {
          'sharkcraft.mcp-tool': 5,
          'mcp-read-only-forever': 3,
          'repo.safety.mcp-is-read-only': 3,
        },
        boostTags: { mcp: 3, 'read-only': 3 },
      },
      {
        whenTokens: ['mcp', 'tool'],
        boostIds: { 'sharkcraft.mcp-tool': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.new-inspector-module',
    taskHints: [
      {
        whenTokens: ['new', 'inspector', 'module'],
        boostIds: { 'sharkcraft.inspector-module': 5 },
        boostTags: { inspector: 3 },
      },
      {
        whenTokens: ['inspector', 'module'],
        boostIds: { 'sharkcraft.inspector-module': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.command-catalog',
    taskHints: [
      {
        whenTokens: ['command', 'catalog'],
        boostIds: { 'sharkcraft.command-catalog-entry': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.json-schema',
    taskHints: [
      {
        whenTokens: ['json', 'schema'],
        boostIds: { 'sharkcraft.json-schema': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.read-only-mcp',
    taskHints: [
      {
        whenTokens: ['read-only', 'mcp'],
        boostIds: {
          'mcp-read-only-forever': 5,
          'sharkcraft.mcp-read-only': 4,
        },
        boostTags: { mcp: 2, 'read-only': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.safety-audit',
    taskHints: [
      {
        whenTokens: ['safety', 'audit'],
        boostTags: { safety: 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.policy-decision',
    taskHints: [
      {
        whenTokens: ['policy'],
        boostIds: { 'sharkcraft.policy': 3 },
        boostTags: { policy: 2 },
      },
      {
        whenTokens: ['decision', 'adr'],
        boostIds: { 'sharkcraft.decision': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.knowledge-stale-check',
    taskHints: [
      {
        whenTokens: ['stale', 'knowledge'],
        boostIds: {
          'engine.knowledge-stale-check': 5,
          'knowledge-is-verifiable-not-tribal': 3,
        },
        boostTags: { knowledge: 2, stale: 3 },
      },
      {
        whenTokens: ['stale-check'],
        boostIds: { 'engine.knowledge-stale-check': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.template-drift',
    taskHints: [
      {
        whenTokens: ['template', 'drift'],
        boostIds: {
          'engine.template-drift': 5,
          'template-drift-checks-before-trust': 3,
        },
        boostTags: { templates: 2, drift: 3 },
      },
    ],
  }),
  // ─────────────────────────── R30 surface ────────────────────────────────
  defineSearchTuning({
    id: 'r30.bias.fuzzy-impact',
    taskHints: [
      {
        whenTokens: ['fuzzy', 'impact'],
        boostIds: { 'engine.fuzzy-impact': 5, 'engine.fuzzy-trace-impact': 3 },
        boostTags: { impact: 2, fuzzy: 3 },
      },
      {
        whenTokens: ['impact', 'query'],
        boostIds: { 'engine.fuzzy-impact': 4 },
      },
      {
        whenTokens: ['resolve', 'impact'],
        boostIds: { 'engine.fuzzy-impact': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.ast-symbol',
    taskHints: [
      {
        whenTokens: ['ast', 'symbol'],
        boostIds: { 'engine.ast-backed-symbol-verification': 5 },
        boostTags: { ast: 3, symbol: 3 },
      },
      {
        whenTokens: ['symbol', 'verification'],
        boostIds: { 'engine.ast-backed-symbol-verification': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.knowledge-ci-gate',
    taskHints: [
      {
        whenTokens: ['stale-check', 'ci'],
        boostIds: { 'engine.knowledge-stale-ci-gate': 5 },
        boostTags: { knowledge: 2, ci: 3 },
      },
      {
        whenTokens: ['knowledge', 'ci'],
        boostIds: { 'engine.knowledge-stale-ci-gate': 4 },
      },
      {
        whenTokens: ['knowledge', 'gate'],
        boostIds: { 'engine.knowledge-stale-ci-gate': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.template-drift-noise',
    taskHints: [
      {
        whenTokens: ['template', 'drift', 'noise'],
        boostIds: { 'engine.template-drift-noise-control': 5 },
        boostTags: { templates: 2, drift: 3, noise: 2 },
      },
      {
        whenTokens: ['min-severity'],
        boostIds: { 'engine.template-drift-noise-control': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.agent-test-strict',
    taskHints: [
      {
        whenTokens: ['agent', 'test', 'strict'],
        boostIds: { 'engine.agent-test-strict-expectations': 5 },
        boostTags: { 'agent-tests': 3 },
      },
      {
        whenTokens: ['agent', 'test', 'ranker'],
        boostIds: { 'engine.agent-test-strict-expectations': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.feedback-rules',
    taskHints: [
      {
        whenTokens: ['feedback', 'rules'],
        boostIds: { 'engine.feedback-rules-pack-extensible': 5 },
        boostTags: { feedback: 3 },
      },
      {
        whenTokens: ['pack', 'feedback'],
        boostIds: { 'engine.feedback-rules-pack-extensible': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.ts-decisions',
    taskHints: [
      {
        whenTokens: ['typescript', 'decision'],
        boostIds: { 'engine.ts-decisions-loader': 5 },
        boostTags: { decisions: 3 },
      },
      {
        whenTokens: ['decisions', 'ts'],
        boostIds: { 'engine.ts-decisions-loader': 4 },
      },
      {
        whenTokens: ['decisions', 'doctor'],
        boostIds: { 'engine.ts-decisions-loader': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.path-conventions',
    taskHints: [
      {
        whenTokens: ['path', 'convention'],
        boostTags: { paths: 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.ci-integrity',
    taskHints: [
      {
        whenTokens: ['ci', 'integrity'],
        boostIds: { 'engine.ci-integrity-gates': 5 },
        boostTags: { ci: 3 },
      },
      {
        whenTokens: ['ci', 'scaffold', 'knowledge'],
        boostIds: { 'engine.ci-integrity-gates': 4 },
      },
    ],
  }),
  // ─────────────────────────── Polyglot terms ────────────────────────────
  defineSearchTuning({
    id: 'r29.bias.polyglot',
    taskHints: [
      {
        whenTokens: ['java'],
        boostIds: { 'engine.language-tooling': 4 },
        boostTags: { polyglot: 3, java: 3 },
      },
      {
        whenTokens: ['python'],
        boostIds: { 'engine.language-tooling': 4 },
        boostTags: { polyglot: 3, python: 3 },
      },
      {
        whenTokens: ['go'],
        boostIds: { 'engine.language-tooling': 3 },
        boostTags: { polyglot: 2, go: 3 },
      },
      {
        whenTokens: ['rust'],
        boostIds: { 'engine.language-tooling': 3 },
        boostTags: { polyglot: 2, rust: 3 },
      },
      {
        whenTokens: ['c#', 'csharp', 'dotnet'],
        boostIds: { 'engine.language-tooling': 3 },
        boostTags: { polyglot: 2 },
      },
      {
        whenTokens: ['language', 'detection'],
        boostIds: { 'engine.language-tooling': 4 },
      },
      {
        whenTokens: ['dependency', 'scanner'],
        boostIds: { 'engine.language-tooling': 3 },
      },
      {
        whenTokens: ['test', 'impact'],
        boostIds: { 'engine.fuzzy-trace-impact': 3 },
      },
      {
        whenTokens: ['polyglot', 'ci'],
        boostIds: { 'engine.language-tooling': 3 },
      },
    ],
  }),
  // ─────────────────────────── R31 ────────────────────────────
  defineSearchTuning({
    id: 'r31.bias.ranker-why',
    taskHints: [
      {
        whenTokens: ['why'],
        boostIds: { 'engine.ranker-why': 5 },
        boostTags: { ranker: 3, explainability: 3, why: 3 },
      },
      {
        whenTokens: ['ranker'],
        boostIds: { 'engine.ranker-why': 4 },
        boostTags: { ranker: 3 },
      },
      {
        whenTokens: ['explain'],
        boostIds: { 'engine.ranker-why': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.command-discovery',
    taskHints: [
      {
        whenTokens: ['suggest'],
        boostIds: { 'engine.command-discovery': 4 },
      },
      {
        whenTokens: ['find', 'command'],
        boostIds: { 'engine.command-discovery': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.watch-loops',
    taskHints: [
      {
        whenTokens: ['watch'],
        boostIds: { 'engine.watch-loops': 5 },
        boostTags: { watch: 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.fix-preview',
    taskHints: [
      {
        whenTokens: ['fix'],
        boostIds: { 'engine.fix-preview': 5 },
        boostTags: { fix: 3 },
      },
      {
        whenTokens: ['preview'],
        boostIds: { 'engine.fix-preview': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.scaffold-coverage',
    taskHints: [
      {
        whenTokens: ['coverage', 'scaffolds'],
        boostIds: { 'engine.scaffold-coverage': 5 },
        boostTags: { coverage: 3, scaffold: 3 },
      },
      {
        whenTokens: ['missing', 'template'],
        boostIds: { 'engine.scaffold-coverage': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.symbol-impact',
    taskHints: [
      {
        whenTokens: ['symbol'],
        boostIds: { 'engine.symbol-impact': 4 },
        boostTags: { symbol: 3 },
      },
      {
        whenTokens: ['impact', 'symbol'],
        boostIds: { 'engine.symbol-impact': 5 },
      },
      {
        whenTokens: ['trace', 'symbol'],
        boostIds: { 'engine.symbol-impact': 5 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.changes-summary',
    taskHints: [
      {
        whenTokens: ['changes'],
        boostIds: { 'engine.changes-summary': 5 },
        boostTags: { changes: 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.pr-summary',
    taskHints: [
      {
        whenTokens: ['pr'],
        boostIds: { 'engine.pr-summary': 4 },
        boostTags: { pr: 3, review: 3 },
      },
      {
        whenTokens: ['pull', 'request'],
        boostIds: { 'engine.pr-summary': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.ci-report',
    taskHints: [
      {
        whenTokens: ['ci', 'report'],
        boostIds: { 'engine.ci-integrity-report': 5 },
        boostTags: { ci: 3, integrity: 3 },
      },
      {
        whenTokens: ['integrity'],
        boostIds: { 'engine.ci-integrity-report': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.uncertainty',
    taskHints: [
      {
        whenTokens: ['uncertainty'],
        boostIds: { 'engine.uncertainty-reporting': 5 },
        boostTags: { uncertainty: 3 },
      },
    ],
  }),
];
