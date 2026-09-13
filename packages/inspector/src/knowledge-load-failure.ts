/**
 * One knowledge-bearing file (`knowledgeFiles` / `ruleFiles` / `pathFiles` /
 * `docsFiles`, local or pack-contributed) whose entries never reached the
 * corpus — it failed to import, timed out, was skipped as a cached failure, or
 * is declared by the config and does not exist.
 *
 * Read off `inspection.loaderDiagnostics` (the ONE record of what each loader
 * did) by `describeInspectionDiscovery`. A corpus verdict over a load failure
 * examined part of what it was told to, so it is never a pass.
 */
export interface IKnowledgeLoadFailure {
  /** Project-relative when inside the project, else absolute. */
  readonly file: string;
  /** The loader slot (`knowledge` / `rules` / `paths` / `docs`). */
  readonly kind: string;
  /** `failed` / `timeout` / `cached-failed` / `missing`. */
  readonly status: string;
  /** The loader's message (the import error), or why nothing was read. */
  readonly message: string;
  /** Set for a pack-contributed file. */
  readonly packName?: string;
}
