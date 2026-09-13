import type { ScanZone } from '../scan/scan-zone.ts';
import type { AssetReferenceKind } from './asset-reference-kind.ts';
import type { IAssetReferenceCount } from './asset-reference-count.ts';

/**
 * A structured, verifiable pointer from an asset to a repo artefact.
 *
 * Knowledge entries have always declared these; boundary rules and policy
 * checks now may too, so the one staleness sweep can verify every asset kind's
 * claims. `IKnowledgeReference` (knowledge) is this type under its historical
 * name.
 *
 * Existence is the weakest possible proxy for what an asset actually claims: a
 * file survives a rename-inside refactor untouched while every statement about
 * its contents becomes false. The optional content assertions close that gap
 * without a language parser — every field is optional, so a plain path still
 * loads and checks exactly as before.
 */
export interface IAssetReference {
  kind: AssetReferenceKind;
  /** Project-relative path for `file` / `directory`, or the file a `symbol` is pinned to. */
  path?: string;
  /** Symbol name for `symbol` references — `Name`, or `Owner.member` for a class/interface/enum/object member. */
  symbol?: string;
  /** Id for `command` / `template` / `playbook` / `construct` / `helper` / `policy` / `boundary-rule` / `path-convention` / `package`. */
  id?: string;
  /** Raw command line for `command` (alternative to `id`). */
  command?: string;
  /** Whether the stale-check treats a missing target as an error (default false). */
  required?: boolean;
  /** Free-form note carried verbatim. */
  note?: string;
  /**
   * A literal substring the target must still contain — the file, or the
   * pinned symbol's declaration span. Reported with what was found instead, so
   * a fix is a one-token edit.
   */
  contains?: string;
  /**
   * A regular expression (source, compiled with the `m` flag) the target must
   * match. Separate from {@link contains} so a literal is never misread as a
   * regex.
   */
  matches?: string;
  /**
   * The lexical zone {@link contains} / {@link matches} read — the same
   * vocabulary the policy plane and the extraction DSL use. Default `all`;
   * `code` stops a claim from being satisfied by a comment that merely
   * describes it.
   */
  scan?: ScanZone;
  /** A count the asset claims, re-derived by the extraction authority. */
  count?: IAssetReferenceCount;
}
