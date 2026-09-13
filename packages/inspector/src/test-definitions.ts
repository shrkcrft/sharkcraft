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
  // ── Ranker-SURFACED (order-sensitive; may flip on unrelated content edits) ──
  // Each asserts the id is in THIS task's packet. A failure says whether the id
  // is registered at all (`unknown-id`) or merely did not rank (`not-surfaced`).
  expectedPipeline?: string;
  expectedTemplates?: readonly string[];
  expectedRules?: readonly string[];
  expectedForbiddenActions?: readonly string[];
  expectedVerificationCommands?: readonly string[];
  // ── Registry EXISTENCE (stable) ─────────────────────────────────────────
  /**
   * Each asserts the id is registered — answered by the shared reference
   * registry (the set the kind's `list` verb prints), never a private copy.
   * Each field is independent; missing fields are "no expectation".
   *
   * `expectedCommands` is a hybrid: surfaced by the packet OR resolves
   * against the live command index (injected by the CLI).
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
