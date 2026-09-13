import type { ReferenceKind } from './reference-registry.ts';
import type { SearchTuningKeyStatus } from './search-tuning-key-status.ts';

/**
 * One finding of THE search-tuning lint (`lintSearchTuning`). `search tuning
 * doctor` prints it as-is; the self-config doctor prefixes the code
 * (`search-tuning-<code>`) — one lint, two renderers.
 */
export interface ISearchTuningLintIssue {
  readonly severity: 'info' | 'warning' | 'error';
  /**
   * `target-missing` · `key-unprefixed` · `key-unknown-kind` ·
   * `boost-excluded-by-kind` · `duplicate-trigger` · `unreachable-trigger` ·
   * `unknown-kind` · `unknown-source` · `cap-discards`.
   */
  readonly code: string;
  readonly message: string;
  /** The tuning entry (for `cap-discards`: the contributing entries, `+`-joined). */
  readonly tuningId: string;
  readonly source?: string;
  /** The boost key, exactly as declared. */
  readonly key?: string;
  readonly status?: SearchTuningKeyStatus;
  /**
   * The registry the target id resolves (or would resolve) in: set for every
   * key THE key resolver could place (a resolvable bare key included), and for
   * a `cap-discards` document whose prefix has an id registry. Absent means
   * the target is not a registry id (a registry-less document, a declaration)
   * or resolves nowhere.
   */
  readonly referenceKind?: ReferenceKind;
  /**
   * The bare id the key names (or the whole key when unprefixed); for a
   * `cap-discards` document with an id registry, its bare id
   * (`knowledge:gamma.entry` → `gamma.entry`).
   */
  readonly targetId?: string;
  /** How many boost maps of this entry declare the key — one issue, not one per map. */
  readonly occurrences?: number;
  /** The key (or kind) to write instead. */
  readonly suggestion?: string;
  /** `duplicate-trigger` / `unreachable-trigger`: the task hint's `whenTokens`. */
  readonly trigger?: readonly string[];
  /**
   * `cap-discards`: the document the global cap clips. When its prefix has an
   * id registry the issue ALSO carries `referenceKind` + the bare `targetId`,
   * so the document is named in its registry, never as an unknown id.
   */
  readonly docId?: string;
  /** `cap-discards`: how much of the composed delta the cap discards. */
  readonly discarded?: number;
  /**
   * The declaration a SHAPE finding is about — it names no id: the task hint's
   * `taskHints[<i>].whenTokens` (`duplicate-trigger`, `unreachable-trigger`),
   * `appliesToKinds` / `taskHints[<i>].boostKinds` (`unknown-kind`),
   * `boostSources` (`unknown-source`).
   */
  readonly field?: string;
  /** The `cap-discards` summary issue: how many more documents the cap clips past the per-run issue cap. */
  readonly moreDocuments?: number;
}
