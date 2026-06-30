import * as nodePath from 'node:path';
import type { IPolicyRule, PolicySurface } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import { extractInlineTemplates } from './extract-templates.ts';
import { evaluatePolicy, type IPolicyReport, type IPolicyUnit } from './evaluate-policy.ts';

/** Per-surface default globs when a rule omits `files`. */
const SURFACE_DEFAULT_GLOBS: Record<PolicySurface, readonly string[]> = {
  // markup files (scanned whole) + source files (inline `template:` extracted).
  template: ['**/*.html', '**/*.htm', '**/*.ts', '**/*.tsx'],
  style: ['**/*.css', '**/*.scss', '**/*.sass', '**/*.less', '**/*.styl'],
  ts: ['**/*.ts', '**/*.tsx'],
};

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export interface IRunPolicyOptions {
  /** Restrict to rules on these surfaces. */
  readonly surfaces?: readonly PolicySurface[];
  /** Run only these rule ids. */
  readonly only?: readonly string[];
  /** When true, only run rules whose globs match a changed file. */
  readonly changedOnly?: boolean;
  readonly changedFiles?: readonly string[];
  /** Project-relative directories to prune from the walk (e.g. the SharkCraft asset dir). */
  readonly excludeDirs?: readonly string[];
}

function globsFor(rule: IPolicyRule): readonly string[] {
  return rule.files && rule.files.length > 0 ? rule.files : SURFACE_DEFAULT_GLOBS[rule.surface];
}

/**
 * Filesystem-backed policy-lint. Walks the project once; on the `template`
 * surface, source files contribute their inline `template:` bodies (with real
 * source line numbers) while `.html` files are scanned whole. Pure-engine
 * output; the only IO is the read-only walk + reads.
 */
export function runPolicyLint(
  projectRoot: string,
  rules: readonly IPolicyRule[],
  options: IRunPolicyOptions = {},
): IPolicyReport {
  let selected = rules;
  if (options.surfaces && options.surfaces.length > 0) {
    const s = new Set(options.surfaces);
    selected = selected.filter((r) => s.has(r.surface));
  }
  if (options.only && options.only.length > 0) {
    const ids = new Set(options.only);
    selected = selected.filter((r) => ids.has(r.id));
  }
  if (options.changedOnly) {
    const changed = options.changedFiles ?? [];
    selected = selected.filter((r) => changed.some((c) => matchesAny(c, globsFor(r))));
  }
  if (selected.length === 0) {
    return { schema: 'sharkcraft.policy-lint/v1', rules: [], findings: [], diagnostics: [], evaluated: 0, verdict: 'pass' };
  }

  // Under --changed-only, restrict the SCANNED files to the changed set too (not
  // just rule selection). Per-file regex findings have no cross-file dependency,
  // so a pre-existing violation in a file the diff never touched is out of scope
  // — this mirrors how `check boundaries`/wiring restrict to the changeset and
  // stops the gate failing RED on untouched legacy debt.
  const changedSet = options.changedOnly ? new Set(options.changedFiles ?? []) : undefined;
  const allGlobs = [...new Set(selected.flatMap((r) => [...globsFor(r)]))];
  const cache = readMatchingFiles(projectRoot, allGlobs, new Set(options.excludeDirs ?? []));

  return evaluatePolicy(selected, (rule) => {
    const globs = globsFor(rule);
    const units: IPolicyUnit[] = [];
    for (const [path, content] of cache) {
      if (changedSet && !changedSet.has(path)) continue;
      if (!matchesAny(path, globs)) continue;
      const ext = nodePath.extname(path).toLowerCase();
      if (rule.surface === 'template' && SOURCE_EXT.has(ext)) {
        for (const tpl of extractInlineTemplates(content)) {
          units.push({ path, content: tpl.body, baseLine: tpl.startLine, inlineTemplate: true });
        }
      } else {
        // .html on the template surface, and all style/ts files: scan whole.
        units.push({ path, content, baseLine: 1 });
      }
    }
    return units;
  });
}
