import type { IRuleSelfTest } from '../wiring/wiring-rule.ts';

/**
 * Generated-artifact drift & provenance rules.
 *
 * Repos with codegen commit the generated output, and two things silently rot:
 * someone HAND-EDITS a generated file (the build compiles it happily; the next
 * regen clobbers the edit or the file diverges from its source), and a generated
 * file loses its "do not edit" PROVENANCE HEADER so nobody downstream knows it
 * is generated.
 *
 * Only a regenerate-into-a-temp-dir-and-diff catches the edit deterministically.
 * An agent "remembering" to regenerate is exactly the guarantee you cannot get.
 */

/** The "this file is generated" header contract. */
export interface IProvenanceHeaderRule {
  /** Regex every generated file's head must match (e.g. `GENERATED .* do not edit`). */
  readonly mustMatch: string;
  /** Extra regex flags (the scan is always case-sensitive unless `i` is given). */
  readonly flags?: string;
  /** How many leading lines count as "the header" (default 10). */
  readonly withinLines?: number;
  /**
   * Also flag files OUTSIDE `generatedGlob` that carry the header — a
   * hand-written file wearing a generated header is a mislabel that sends the
   * next editor to a regen command that will never touch it.
   */
  readonly forbidOutside?: boolean;
  /** Globs to search for mislabels (default: `**\/*.<ext>` for each generated ext). */
  readonly outsideGlob?: readonly string[];
  /** Advisory: the header should also name how to regenerate the file. */
  readonly pointsToRegenCommand?: boolean;
}

export interface IGeneratedArtifactRule {
  /** Stable id, used with `--id` and reported in every finding. */
  readonly id: string;
  /** What this artifact set is / where it comes from. */
  readonly description?: string;
  /** Project-relative globs selecting the COMMITTED generated files. */
  readonly generatedGlob: readonly string[];
  /**
   * Command that regenerates the FULL set into a temp directory. `{TMP}` is
   * substituted with an absolute path to a fresh empty directory.
   *
   * Only ever run from the repo's OWN `sharkcraft.config.ts` — the pack-merge
   * seam drops a pack-contributed rule that declares one, mirroring the
   * "pack-contributed verification commands are NOT auto-run" contract. A rule
   * without `regen` is a header-only rule (still fully useful, never spawns).
   */
  readonly regen?: string;
  /** `bytes` (default) or `normalized-whitespace` (trailing WS + line endings). */
  readonly compare?: 'bytes' | 'normalized-whitespace';
  /** The "do not edit" header contract, checked without ever running `regen`. */
  readonly provenanceHeader?: IProvenanceHeaderRule;
  /**
   * Treat "no generated files matched" as a FAILURE rather than a loud skip.
   * A glob that goes stale after a directory move otherwise reports green
   * forever.
   */
  readonly failOnEmpty?: boolean;
  /** Author-declared expectations checked by `shrk gates coverage`. */
  readonly selfTest?: IRuleSelfTest;
  /** `error` (default) fails the check; `warning` reports without failing. */
  readonly severity?: 'error' | 'warning';
  /** Wall-clock cap for `regen` (default 120_000 ms). */
  readonly timeoutMs?: number;
  /** Remediation hint shown on drift (defaults to the `shrk generated update` line). */
  readonly hint?: string;
}
