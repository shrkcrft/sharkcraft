/** Advisory findings of a staleness sweep. None of them changes the exit code on its own. */
export enum KnowledgeAdvisoryCode {
  /**
   * An entry whose references are all file / directory paths names, in its
   * prose, a symbol one of those files declares — a rename inside the file
   * would leave the entry wrong while every reference still resolves.
   */
  PathOnlyReference = 'path-only-reference',
  /**
   * A boundary rule's `from` glob has a static prefix that does not exist —
   * the rule governs nothing there (implicit reference, `--fail-on implicit`).
   */
  ImplicitPathMissing = 'implicit-path-missing',
  /** Policy checks keep their scope inside `evaluate()`, which cannot be read without running it. */
  PolicyScopeUnverifiable = 'policy-scope-unverifiable',
}
