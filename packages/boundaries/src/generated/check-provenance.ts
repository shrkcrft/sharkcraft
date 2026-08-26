import type { IGeneratedArtifactRule } from '@shrkcrft/core';
import { safeCompile } from '../util/safe-regex.ts';

/** What a provenance finding is about. */
export type ProvenanceFindingKind =
  /** A file inside `generatedGlob` carries no "do not edit" header. */
  | 'missing-header'
  /** A file OUTSIDE the glob carries the header — a hand-written file mislabeled. */
  | 'mislabeled'
  /** Advisory: the header does not name how to regenerate the file. */
  | 'no-regen-pointer'
  /** In the tree, owned by no writer and not blessed as hand-maintained. */
  | 'unclassified'
  /** A `handMaintained` bless whose file no longer exists. */
  | 'stale-hand-maintained';

export interface IProvenanceFinding {
  readonly ruleId: string;
  readonly file: string;
  readonly kind: ProvenanceFindingKind;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

/** The head of a file, as the header contract sees it. */
function headOf(content: string, withinLines: number): string {
  const lines = content.split('\n');
  return lines.slice(0, Math.max(1, withinLines)).join('\n');
}

/**
 * Derive the globs to search for MISLABELED files when the rule doesn't name
 * them: one `**\/*.<ext>` per distinct extension in `generatedGlob`. Bounded and
 * deterministic — never a whole-tree read of every file type.
 */
export function deriveOutsideGlobs(generatedGlob: readonly string[]): string[] {
  const exts = new Set<string>();
  for (const g of generatedGlob) {
    const m = /\.([A-Za-z0-9]+)$/.exec(g);
    if (m) exts.add(m[1]!);
  }
  return [...exts].sort().map((e) => `**/*.${e}`);
}

/**
 * Tree-classification results a mixed-tree rule produces alongside its files.
 *
 * Passed in rather than recomputed so the classification a caller already did
 * (see `scanGeneratedFiles`) is the same one reported — two implementations of
 * "which files does this rule own?" is precisely the drift this plane exists
 * to catch.
 */
export interface IClassificationFindings {
  /** Files under the tree owned by no writer and not blessed. */
  readonly unclassified?: readonly string[];
  /** `handMaintained` patterns currently matching no file. */
  readonly staleHandMaintained?: readonly string[];
}

/**
 * Check the "this file is generated" header contract.
 *
 * Pure: the caller supplies the file contents, so this runs with no regen
 * command, no temp dir, and no spawn — a header-only rule is fully useful (and
 * safe to ship from a pack) on its own.
 *
 * `outside` should contain candidate files NOT in `generatedGlob`; pass an empty
 * map when `forbidOutside` is off.
 */
export function checkProvenanceHeaders(
  rule: IGeneratedArtifactRule,
  generated: ReadonlyMap<string, string>,
  outside: ReadonlyMap<string, string>,
  classification: IClassificationFindings = {},
): { findings: readonly IProvenanceFinding[]; error?: string } {
  const severity: 'error' | 'warning' = rule.severity ?? 'error';
  // Classification findings do not depend on the header contract — a mixed tree
  // must be fully accounted for whether or not the rule asserts headers, so
  // these are produced before the early return below.
  const classFindings: IProvenanceFinding[] = [
    ...(classification.unclassified ?? []).map((file) => ({
      ruleId: rule.id,
      file,
      kind: 'unclassified' as const,
      severity,
      message:
        'in the generated tree but owned by no `sources[]` glob and not listed in `handMaintained` — classify it',
    })),
    ...(classification.staleHandMaintained ?? []).map((pattern) => ({
      ruleId: rule.id,
      file: pattern,
      kind: 'stale-hand-maintained' as const,
      severity: 'warning' as const,
      message: '`handMaintained` entry matches no file — the blessed file was renamed or deleted',
    })),
  ];

  const header = rule.provenanceHeader;
  if (!header) return { findings: classFindings };
  const { re, error } = safeCompile(header.mustMatch, header.flags);
  if (error || !re) return { findings: classFindings, error: `provenanceHeader ${error}` };

  const within = header.withinLines ?? 10;
  const findings: IProvenanceFinding[] = [...classFindings];
  const test = (content: string): boolean => {
    re.lastIndex = 0;
    return re.test(headOf(content, within));
  };

  for (const file of [...generated.keys()].sort()) {
    const content = generated.get(file)!;
    if (!test(content)) {
      findings.push({
        ruleId: rule.id,
        file,
        kind: 'missing-header',
        severity,
        message: `generated file carries no provenance header matching /${header.mustMatch}/`,
      });
      continue;
    }
    // Advisory only — a header that names its regen command saves the next
    // editor a search, but its absence is not a correctness defect.
    if (header.pointsToRegenCommand && rule.regen) {
      const head = headOf(content, within);
      const verb = rule.regen.trim().split(/\s+/)[0] ?? '';
      if (verb !== '' && !head.includes(verb)) {
        findings.push({
          ruleId: rule.id,
          file,
          kind: 'no-regen-pointer',
          severity: 'warning',
          message: `provenance header does not name the regen command (\`${verb} …\`)`,
        });
      }
    }
  }

  if (header.forbidOutside) {
    for (const file of [...outside.keys()].sort()) {
      if (generated.has(file)) continue;
      if (!test(outside.get(file)!)) continue;
      findings.push({
        ruleId: rule.id,
        file,
        kind: 'mislabeled',
        severity,
        message:
          'hand-written file carries a generated-file header — either move it under the generated glob or drop the header',
      });
    }
  }

  return { findings };
}
