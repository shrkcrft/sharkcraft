/**
 * One `selfTest` expectation, evaluated against a rule's EXTRACTED SET.
 *
 * Every gate-plane selfTest field asserts on the same thing — what the rule's
 * primary selector extracted from the live tree — never on a ranker's output or
 * on a registry lookup. `assertion` names that class explicitly, so a JSON
 * reader can tell these apart from the ranker-surfaced and registry-existence
 * expectations of agent-contract and pack tests, which answer different
 * questions and fail for different reasons.
 */
export interface ISelfTestCheck {
  /** The selfTest field this check came from. */
  readonly field: 'expectMatchesAtLeast' | 'expectIds' | 'expectNotIds';
  /** What the field asserts on — always the rule's extracted set on a gate plane. */
  readonly assertion: 'extracted-set';
  /** The floor (`expectMatchesAtLeast`), or the id this check is about. */
  readonly expected: number | string;
  /**
   * `held` / `failed` were measured. `not-evaluable` means this plane shape
   * cannot produce the set the field asserts on, so the field is neither a
   * pass nor a fake "got 0".
   */
  readonly status: 'held' | 'failed' | 'not-evaluable';
  /** The measured count, for `expectMatchesAtLeast`. */
  readonly actual?: number;
  /** One sentence naming the unit counted and, on failure, the selector consulted. */
  readonly message: string;
}
