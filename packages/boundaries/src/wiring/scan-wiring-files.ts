import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import {
  evaluateWiring,
  type IWiringFileEntry,
  type IWiringReport,
} from './evaluate-wiring.ts';

/** All file globs a rule references: its declared side + every registered source (union). */
function ruleGlobs(rule: IWiringRule): string[] {
  const reg = rule.registered;
  const sources: readonly IWiringSource[] = Array.isArray(reg)
    ? (reg as readonly IWiringSource[])
    : [reg as IWiringSource];
  return [...rule.declared.files, ...sources.flatMap((s) => [...s.files])];
}

export interface IRunWiringOptions {
  /** Only run rules touched by these (project-relative) changed files. */
  readonly changedFiles?: readonly string[];
  /** When true with no changed files, run nothing (matches `--changed-only` with a clean tree). */
  readonly changedOnly?: boolean;
  /** Run only these rule ids. */
  readonly only?: readonly string[];
  /** Project-relative directories to prune from the walk (e.g. the SharkCraft asset dir). */
  readonly excludeDirs?: readonly string[];
}

/**
 * Filesystem-backed wiring run: walks the project once, reads only the files a
 * rule references (skipping oversized files), and evaluates every (selected)
 * rule. Pure-engine output; the only IO is the read-only tree walk + reads.
 */
export function runWiring(
  projectRoot: string,
  rules: readonly IWiringRule[],
  options: IRunWiringOptions = {},
): IWiringReport {
  let selected = rules;
  if (options.only && options.only.length > 0) {
    const ids = new Set(options.only);
    selected = selected.filter((r) => ids.has(r.id));
  }
  if (options.changedOnly) {
    const changed = options.changedFiles ?? [];
    selected = selected.filter((r) => {
      const globs = ruleGlobs(r);
      return changed.some((c) => matchesAny(c, globs));
    });
  }
  if (selected.length === 0) {
    return {
      schema: 'sharkcraft.wiring/v1',
      rules: [],
      violations: [],
      diagnostics: [],
      evaluated: 0,
      verdict: 'pass',
    };
  }

  // Union of all globs across selected rules → one tree walk, cached reads.
  const allGlobs = [...new Set(selected.flatMap(ruleGlobs))];
  const cache = readMatchingFiles(projectRoot, allGlobs, new Set(options.excludeDirs ?? []));
  const entries: IWiringFileEntry[] = [...cache.entries()].map(([path, content]) => ({ path, content }));

  return evaluateWiring(selected, (source) => entries.filter((f) => matchesAny(f.path, source.files)));
}
