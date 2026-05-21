/**
 * SharkCraft self agent-tests.
 * Engine self-config no longer hosts project-specific tests.
 * Project-specific agent tests live in the consumer pack.
 *
 * Each test specifies a task string + the expected rule / template /
 * forbidden actions / verification commands / playbooks / policies /
 * constructs / commands / knowledge the inspection must surface.
 * Run with `shrk test agent`.
 */
interface ILocalAgentContractTest {
  id: string;
  task: string;
  expectedPipeline?: string;
  expectedTemplates?: readonly string[];
  expectedRules?: readonly string[];
  expectedForbiddenActions?: readonly string[];
  expectedVerificationCommands?: readonly string[];
  expectedHelpers?: readonly string[];
  expectedPlaybooks?: readonly string[];
  expectedPolicies?: readonly string[];
  expectedConstructs?: readonly string[];
  expectedCommands?: readonly string[];
  expectedKnowledge?: readonly string[];
  minConfidence?: 'high' | 'medium' | 'low';
  mustNotInclude?: readonly string[];
}

function defineAgentContractTest(t: ILocalAgentContractTest): ILocalAgentContractTest {
  return t;
}

export default [
  defineAgentContractTest({
    id: 'fix-changed-only-boundary',
    task: 'fix a boundary issue introduced in my changed files only',
    expectedKnowledge: ['engine.changed-only-boundaries'],
  }),
  defineAgentContractTest({
    id: 'add-a-new-cli-command',
    task: 'add a new shrk CLI command for templates rollback',
    expectedTemplates: ['engine.cli-command'],
  }),
  defineAgentContractTest({
    id: 'add-a-new-mcp-tool',
    task: 'add a new read-only MCP tool that exposes the registry lifecycle report',
    expectedTemplates: ['engine.mcp-tool'],
    expectedRules: ['repo.safety.mcp-is-read-only'],
    expectedPolicies: ['sharkcraft.mcp-read-only'],
  }),
  defineAgentContractTest({
    id: 'add-polyglot-java-support',
    task: 'add Java language detection and command inference',
    expectedKnowledge: ['engine.language-tooling'],
    expectedPolicies: ['sharkcraft.language-runner-allowlist'],
  }),
  defineAgentContractTest({
    id: 'debug-module-not-found-error',
    task: 'debug a ModuleNotFoundError in a Python test runner',
    expectedKnowledge: ['engine.language-tooling'],
  }),
  defineAgentContractTest({
    id: 'r31.find-command-for-feedback-rules',
    task: 'find the shrk command for listing feedback rules',
    expectedKnowledge: ['engine.command-discovery'],
  }),
  defineAgentContractTest({
    id: 'r31.generate-pr-summary',
    task: 'generate a PR summary for the staged changes',
    expectedKnowledge: ['engine.pr-summary', 'engine.changes-summary'],
  }),
  defineAgentContractTest({
    id: 'r31.scaffold-coverage-generic',
    task: 'show scaffold coverage gaps for the current task',
    expectedKnowledge: ['engine.scaffold-coverage'],
  }),
  defineAgentContractTest({
    id: 'r31.watch-knowledge-stale-check',
    task: 'watch knowledge stale check for local development',
    expectedKnowledge: ['engine.watch-loops'],
  }),
];
