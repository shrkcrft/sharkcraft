/**
 * R29 PART 15 — SharkCraft self search tuning.
 *
 * Biases the deterministic search ranker toward R28/R29 surface so
 * agents find the right knowledge / template / playbook on the first
 * query.
 *
 * Boost keys are SEARCH-DOCUMENT ids — `<kind>:<id>` (`knowledge:…`,
 * `rule:…`, `template:…`), the same id `shrk search` prints. Until round 11
 * every key here was a bare id, which never matches a document: all 33 entries'
 * `boostIds` were dead, and the self-config doctor certified them (it looked the
 * whole key up in bare-id registries, so a bare key "resolved"). The keys were
 * rewritten from `shrk search tuning doctor`'s suggestions; ids that name no
 * search document at all (decision records, policies, scaffold patterns) were
 * retargeted at their live equivalent or dropped.
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
          'knowledge:engine.changed-only-boundaries': 5,
        },
        boostTags: { 'changed-only': 3, boundaries: 2 },
      },
      {
        whenTokens: ['changed', 'only'],
        boostIds: { 'knowledge:engine.changed-only-boundaries': 4 },
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
          'knowledge:engine.helper-plan-registry': 4,
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
        boostIds: { 'rule:engine.registry-lifecycle-rule': 4 },
        boostTags: { registry: 3 },
      },
      {
        whenTokens: ['register'],
        boostIds: { 'rule:engine.registry-lifecycle-rule': 2 },
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
          'template:engine.cli-command': 5,
        },
        boostTags: { cli: 3, command: 2 },
      },
      {
        whenTokens: ['shrk', 'command'],
        boostIds: { 'template:engine.cli-command': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.new-mcp-tool',
    taskHints: [
      {
        whenTokens: ['new', 'mcp', 'tool'],
        boostIds: {
          'template:engine.mcp-tool': 5,
          'rule:repo.safety.mcp-is-read-only': 3,
        },
        boostTags: { mcp: 3, 'read-only': 3 },
      },
      {
        whenTokens: ['mcp', 'tool'],
        boostIds: { 'template:engine.mcp-tool': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.new-inspector-module',
    taskHints: [
      {
        whenTokens: ['new', 'inspector', 'module'],
        boostTags: { inspector: 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.read-only-mcp',
    taskHints: [
      {
        whenTokens: ['read-only', 'mcp'],
        boostIds: {
          'rule:repo.safety.mcp-is-read-only': 5,
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
        boostTags: { policy: 2 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.knowledge-stale-check',
    taskHints: [
      {
        whenTokens: ['stale', 'knowledge'],
        boostIds: {
          'knowledge:engine.knowledge-stale-check': 5,
        },
        boostTags: { knowledge: 2, stale: 3 },
      },
      {
        whenTokens: ['stale-check'],
        boostIds: { 'knowledge:engine.knowledge-stale-check': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r29.bias.template-drift',
    taskHints: [
      {
        whenTokens: ['template', 'drift'],
        boostIds: {
          'knowledge:engine.template-drift': 5,
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
        boostIds: { 'knowledge:engine.fuzzy-impact': 5, 'knowledge:engine.fuzzy-trace-impact': 3 },
        boostTags: { impact: 2, fuzzy: 3 },
      },
      {
        whenTokens: ['impact', 'query'],
        boostIds: { 'knowledge:engine.fuzzy-impact': 4 },
      },
      {
        whenTokens: ['resolve', 'impact'],
        boostIds: { 'knowledge:engine.fuzzy-impact': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.ast-symbol',
    taskHints: [
      {
        whenTokens: ['ast', 'symbol'],
        boostIds: { 'knowledge:engine.ast-backed-symbol-verification': 5 },
        boostTags: { ast: 3, symbol: 3 },
      },
      {
        whenTokens: ['symbol', 'verification'],
        boostIds: { 'knowledge:engine.ast-backed-symbol-verification': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.knowledge-ci-gate',
    taskHints: [
      {
        whenTokens: ['stale-check', 'ci'],
        boostIds: { 'knowledge:engine.knowledge-stale-ci-gate': 5 },
        boostTags: { knowledge: 2, ci: 3 },
      },
      {
        whenTokens: ['knowledge', 'ci'],
        boostIds: { 'knowledge:engine.knowledge-stale-ci-gate': 4 },
      },
      {
        whenTokens: ['knowledge', 'gate'],
        boostIds: { 'knowledge:engine.knowledge-stale-ci-gate': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.template-drift-noise',
    taskHints: [
      {
        whenTokens: ['template', 'drift', 'noise'],
        boostIds: { 'knowledge:engine.template-drift-noise-control': 5 },
        boostTags: { templates: 2, drift: 3, noise: 2 },
      },
      {
        whenTokens: ['min-severity'],
        boostIds: { 'knowledge:engine.template-drift-noise-control': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.agent-test-strict',
    taskHints: [
      {
        whenTokens: ['agent', 'test', 'strict'],
        boostIds: { 'knowledge:engine.agent-test-strict-expectations': 5 },
        boostTags: { 'agent-tests': 3 },
      },
      {
        whenTokens: ['agent', 'test', 'ranker'],
        boostIds: { 'knowledge:engine.agent-test-strict-expectations': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.feedback-rules',
    taskHints: [
      {
        whenTokens: ['feedback', 'rules'],
        boostIds: { 'knowledge:engine.feedback-rules-pack-extensible': 5 },
        boostTags: { feedback: 3 },
      },
      {
        whenTokens: ['pack', 'feedback'],
        boostIds: { 'knowledge:engine.feedback-rules-pack-extensible': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r30.bias.ts-decisions',
    taskHints: [
      {
        whenTokens: ['typescript', 'decision'],
        boostIds: { 'knowledge:engine.ts-decisions-loader': 5 },
        boostTags: { decisions: 3 },
      },
      {
        whenTokens: ['decisions', 'ts'],
        boostIds: { 'knowledge:engine.ts-decisions-loader': 4 },
      },
      {
        whenTokens: ['decisions', 'doctor'],
        boostIds: { 'knowledge:engine.ts-decisions-loader': 3 },
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
        boostIds: { 'knowledge:engine.ci-integrity-gates': 5 },
        boostTags: { ci: 3 },
      },
      {
        whenTokens: ['ci', 'scaffold', 'knowledge'],
        boostIds: { 'knowledge:engine.ci-integrity-gates': 4 },
      },
    ],
  }),
  // ─────────────────────────── Polyglot terms ────────────────────────────
  defineSearchTuning({
    id: 'r29.bias.polyglot',
    taskHints: [
      {
        whenTokens: ['java'],
        boostIds: { 'knowledge:engine.language-tooling': 4 },
        boostTags: { polyglot: 3, java: 3 },
      },
      {
        whenTokens: ['python'],
        boostIds: { 'knowledge:engine.language-tooling': 4 },
        boostTags: { polyglot: 3, python: 3 },
      },
      {
        whenTokens: ['go'],
        boostIds: { 'knowledge:engine.language-tooling': 3 },
        boostTags: { polyglot: 2, go: 3 },
      },
      {
        whenTokens: ['rust'],
        boostIds: { 'knowledge:engine.language-tooling': 3 },
        boostTags: { polyglot: 2, rust: 3 },
      },
      {
        whenTokens: ['c#', 'csharp', 'dotnet'],
        boostIds: { 'knowledge:engine.language-tooling': 3 },
        boostTags: { polyglot: 2 },
      },
      {
        whenTokens: ['language', 'detection'],
        boostIds: { 'knowledge:engine.language-tooling': 4 },
      },
      {
        whenTokens: ['dependency', 'scanner'],
        boostIds: { 'knowledge:engine.language-tooling': 3 },
      },
      {
        whenTokens: ['test', 'impact'],
        boostIds: { 'knowledge:engine.fuzzy-trace-impact': 3 },
      },
      {
        whenTokens: ['polyglot', 'ci'],
        boostIds: { 'knowledge:engine.language-tooling': 3 },
      },
    ],
  }),
  // ─────────────────────────── R31 ────────────────────────────
  defineSearchTuning({
    id: 'r31.bias.ranker-why',
    taskHints: [
      {
        whenTokens: ['why'],
        boostIds: { 'knowledge:engine.ranker-why': 5 },
        boostTags: { ranker: 3, explainability: 3, why: 3 },
      },
      {
        whenTokens: ['ranker'],
        boostIds: { 'knowledge:engine.ranker-why': 4 },
        boostTags: { ranker: 3 },
      },
      {
        whenTokens: ['explain'],
        boostIds: { 'knowledge:engine.ranker-why': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.command-discovery',
    taskHints: [
      {
        whenTokens: ['suggest'],
        boostIds: { 'knowledge:engine.command-discovery': 4 },
      },
      {
        whenTokens: ['find', 'command'],
        boostIds: { 'knowledge:engine.command-discovery': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.watch-loops',
    taskHints: [
      {
        whenTokens: ['watch'],
        boostIds: { 'knowledge:engine.watch-loops': 5 },
        boostTags: { watch: 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.fix-preview',
    taskHints: [
      {
        whenTokens: ['fix'],
        boostIds: { 'knowledge:engine.fix-preview': 5 },
        boostTags: { fix: 3 },
      },
      {
        whenTokens: ['preview'],
        boostIds: { 'knowledge:engine.fix-preview': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.scaffold-coverage',
    taskHints: [
      {
        whenTokens: ['coverage', 'scaffolds'],
        boostIds: { 'knowledge:engine.scaffold-coverage': 5 },
        boostTags: { coverage: 3, scaffold: 3 },
      },
      {
        whenTokens: ['missing', 'template'],
        boostIds: { 'knowledge:engine.scaffold-coverage': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.symbol-impact',
    taskHints: [
      {
        whenTokens: ['symbol'],
        boostIds: { 'knowledge:engine.symbol-impact': 4 },
        boostTags: { symbol: 3 },
      },
      {
        whenTokens: ['impact', 'symbol'],
        boostIds: { 'knowledge:engine.symbol-impact': 5 },
      },
      {
        whenTokens: ['trace', 'symbol'],
        boostIds: { 'knowledge:engine.symbol-impact': 5 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.changes-summary',
    taskHints: [
      {
        whenTokens: ['changes'],
        boostIds: { 'knowledge:engine.changes-summary': 5 },
        boostTags: { changes: 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.pr-summary',
    taskHints: [
      {
        whenTokens: ['pr'],
        boostIds: { 'knowledge:engine.pr-summary': 4 },
        boostTags: { pr: 3, review: 3 },
      },
      {
        whenTokens: ['pull', 'request'],
        boostIds: { 'knowledge:engine.pr-summary': 4 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.ci-report',
    taskHints: [
      {
        whenTokens: ['ci', 'report'],
        boostIds: { 'knowledge:engine.ci-integrity-report': 5 },
        boostTags: { ci: 3, integrity: 3 },
      },
      {
        whenTokens: ['integrity'],
        boostIds: { 'knowledge:engine.ci-integrity-report': 3 },
      },
    ],
  }),
  defineSearchTuning({
    id: 'r31.bias.uncertainty',
    taskHints: [
      {
        whenTokens: ['uncertainty'],
        boostIds: { 'knowledge:engine.uncertainty-reporting': 5 },
        boostTags: { uncertainty: 3 },
      },
    ],
  }),
];
