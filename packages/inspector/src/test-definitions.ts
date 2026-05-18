export interface IContextTest {
  id: string;
  task: string;
  mustInclude?: readonly string[];
  mustNotInclude?: readonly string[];
  maxTokens?: number;
}

export function defineContextTest<T extends IContextTest>(t: T): T {
  return t;
}

export interface IAgentContractTest {
  id: string;
  task: string;
  expectedPipeline?: string;
  expectedTemplates?: readonly string[];
  expectedRules?: readonly string[];
  expectedForbiddenActions?: readonly string[];
  expectedVerificationCommands?: readonly string[];
  /**
   * Additional expectations that fail the test when the ranker /
   * search drifts. Each field is independent; missing fields are treated
   * as "no expectation".
   */
  expectedHelpers?: readonly string[];
  expectedPlaybooks?: readonly string[];
  expectedPolicies?: readonly string[];
  expectedConstructs?: readonly string[];
  expectedCommands?: readonly string[];
  expectedKnowledge?: readonly string[];
  /**
   * Minimum confidence the packet must surface (interpreted by callers).
   * Currently advisory — present so packs can declare intent. Not enforced
   * by the default runner.
   */
  minConfidence?: 'high' | 'medium' | 'low';
  /**
   * Ids that must NOT appear in the packet's relevant lists (templates,
   * rules, helpers, etc.). Catches ranker drift toward irrelevant entries.
   */
  mustNotInclude?: readonly string[];
}

export function defineAgentContractTest<T extends IAgentContractTest>(t: T): T {
  return t;
}
