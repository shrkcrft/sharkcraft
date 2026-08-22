import type { IGeneratedArtifactRule } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import { deriveOutsideGlobs } from './check-provenance.ts';

/** The committed generated files plus the mislabel-candidate set. */
export interface IGeneratedScan {
  /** Files matching `generatedGlob` (project-relative path → content). */
  readonly generated: ReadonlyMap<string, string>;
  /** Candidates for the `forbidOutside` mislabel check (empty when it is off). */
  readonly outside: ReadonlyMap<string, string>;
  /** Globs actually used for the outside scan (derived or configured). */
  readonly outsideGlobs: readonly string[];
}

/**
 * Read the committed side of a generated-artifact rule. Pure filesystem reads —
 * the regen command (if any) is orchestrated by the caller, which is also where
 * the local-config-only trust decision is enforced.
 */
export function scanGeneratedFiles(
  projectRoot: string,
  rule: IGeneratedArtifactRule,
  excludeDirs: readonly string[] = [],
): IGeneratedScan {
  const exclude = new Set(excludeDirs);
  const generated = readMatchingFiles(projectRoot, rule.generatedGlob, exclude);

  const wantOutside = rule.provenanceHeader?.forbidOutside === true;
  if (!wantOutside) {
    return { generated, outside: new Map(), outsideGlobs: [] };
  }
  const outsideGlobs =
    rule.provenanceHeader?.outsideGlob && rule.provenanceHeader.outsideGlob.length > 0
      ? [...rule.provenanceHeader.outsideGlob]
      : deriveOutsideGlobs(rule.generatedGlob);
  const all = readMatchingFiles(projectRoot, outsideGlobs, exclude);
  const outside = new Map<string, string>();
  for (const [path, content] of all) {
    if (matchesAny(path, rule.generatedGlob)) continue;
    outside.set(path, content);
  }
  return { generated, outside, outsideGlobs };
}
