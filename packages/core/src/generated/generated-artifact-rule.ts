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

/**
 * One WRITER inside a mixed generated tree.
 *
 * A real `generated/` directory is rarely one command's output: several
 * generators write into it, each owning a slice. A single-writer rule over such
 * a tree regenerates ONE command's output and then reports every OTHER writer's
 * files as `only-committed` — all false, all noise, and the capability becomes
 * unusable on exactly the trees that most need it. Declaring the writers
 * separately lets each verify its own slice, and the artifact is their union.
 */
export interface IGeneratedSource {
  /**
   * Command regenerating THIS writer's slice into a temp directory. `{TMP}` is
   * substituted with an absolute path to a fresh empty directory, exactly as
   * for the single-writer {@link IGeneratedArtifactRule.regen}.
   */
  readonly regen: string;
  /** Project-relative globs selecting the committed files this writer owns. */
  readonly glob: readonly string[];
  /** Optional label used in output; defaults to the writer's index. */
  readonly id?: string;
  /** Wall-clock cap for this writer's `regen` (falls back to the rule's). */
  readonly timeoutMs?: number;
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
  /**
   * MULTI-WRITER form: N generators each owning a sub-glob of
   * {@link generatedGlob}. Each writer regenerates and diffs only its own
   * slice, so one writer's output is never reported as another's stale file.
   * Mutually exclusive with the single-writer {@link regen}.
   *
   * Like `regen`, these SPAWN — the pack-plane merge seam drops a
   * pack-contributed rule that declares any.
   */
  readonly sources?: readonly IGeneratedSource[];
  /**
   * Files inside {@link generatedGlob} that are legitimately HAND-MAINTAINED
   * (typically pending a generator that does not exist yet). They are excluded
   * from the header contract and from every byte comparison.
   *
   * The exemption is deliberately narrow: each pattern's LAST segment must be a
   * literal filename (`src/**\/generated/LegacyThing.kt` is fine,
   * `src/**\/generated/*.kt` is not). A wildcard basename would silently absorb
   * every new file dropped into the directory, turning a per-file bless into a
   * blanket opt-out — the drift check would then pass forever without checking
   * anything. A pattern matching NO file is reported as a stale bless.
   *
   * A file under `generatedGlob` that matches neither a writer's glob nor this
   * list is reported as `unclassified`: the tree must be fully accounted for,
   * loudly, rather than quietly assumed generated.
   */
  readonly handMaintained?: readonly string[];
  /**
   * A marker a file may carry IN ITS OWN HEAD to declare itself hand-maintained,
   * as an alternative to a config path list.
   *
   * A real mixed tree can hold dozens of hand-written files, and enumerating
   * them in config means a list that drifts on every add or rename — with the
   * churn landing in a different file from the change that caused it. An
   * in-file marker puts the exemption where a reviewer already looks: in the
   * diff that introduces the file.
   *
   * Scanned within {@link IProvenanceHeaderRule.withinLines} of the head (10 by
   * default), and matched as a regex. It stays strictly PER-FILE — a file must
   * literally carry the marker — so this is still not a wildcard opt-out, and
   * an unmarked, unheadered, unlisted file is still `unclassified`.
   *
   * Must not overlap `provenanceHeader.mustMatch`, or a generated file's own
   * header could exempt it from the very check that header exists to trigger.
   */
  readonly handMaintainedMarker?: string;
  /** Extra regex flags for {@link handMaintainedMarker}. */
  readonly handMaintainedMarkerFlags?: string;
  /** `bytes` (default) or `normalized-whitespace` (trailing WS + line endings). */
  readonly compare?: 'bytes' | 'normalized-whitespace';
  /** The "do not edit" header contract, checked without ever running `regen`. */
  readonly provenanceHeader?: IProvenanceHeaderRule;
  /**
   * Treat "this rule matched no files" as a FAILURE rather than a
   * loud skip. A rule that matches nothing is a bug in the rule, never a pass.
   *
   * DEFAULTS TO TRUE for `error`-severity rules (an error rule exists to block
   * a build; one matching zero subjects is broken). `warning`-severity rules
   * default to false, since a warning plane may legitimately cover an empty
   * set. Set explicitly to override either default.
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
