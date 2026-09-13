import { existsSync } from 'node:fs';
import { type IImportContext, safeImport, unitProblemsOf } from '@shrkcrft/core';
import {
  validateBoundaryRule,
  type IBoundaryRule,
  type IBoundaryRuleValidationIssue,
} from '../model/boundary-rule.ts';
import type { IBoundaryRuleInput } from '../model/boundary-rule-input.ts';
import { normalizeBoundaryRule } from '../model/normalize-boundary-rule.ts';

/** One rule a file declared that failed validation — dropped from the registry, never silently. */
export interface IBoundaryRuleInvalid {
  /** Position in the file's rule array. */
  readonly index: number;
  /** The rule's id, when it had a string one. */
  readonly ruleId?: string;
  /** The export the rule array came from (`default`, `rules` or `boundaries`). */
  readonly exportName?: string;
  readonly issues: readonly IBoundaryRuleValidationIssue[];
}

export interface ILoadedBoundaryRulesFile {
  source: string;
  rules: IBoundaryRule[];
  warnings: string[];
  /**
   * Rules that failed validation (round 11, 1.3#boundary-invalid-rule). They
   * used to be a warning string nobody rendered, and `check boundaries`
   * reported green over the fence that had just vanished. The structured list
   * lets every surface report them as ERRORED rules — never evaluated.
   */
  invalid: IBoundaryRuleInvalid[];
  /** The file could not be imported, or exported no rule array. Nothing in it was evaluated. */
  loadError?: string;
  /** The file does not exist. */
  missing?: boolean;
}

export interface ILoadBoundaryRulesOptions {
  importContext?: IImportContext;
  /**
   * The pack that contributed the file (round 13): stamped onto every
   * `expectEmpty` marker of its rules (`stampUnitMarks`), so a pack marker that
   * went live is reported as INFO and never fails the consumer, who cannot edit
   * it. Unset for local rules and `--rule-file` / `--diff-against` candidates.
   */
  packageName?: string;
}

export async function loadBoundaryRulesFromFile(
  absPath: string,
  options: ILoadBoundaryRulesOptions = {},
): Promise<ILoadedBoundaryRulesFile> {
  const out: ILoadedBoundaryRulesFile = {
    source: absPath,
    rules: [],
    warnings: [],
    invalid: [],
  };
  if (!existsSync(absPath)) {
    out.warnings.push(`boundary rules file not found: ${absPath}`);
    out.missing = true;
    return out;
  }
  const result = options.importContext
    ? await options.importContext.load<{
        default?: unknown;
        rules?: unknown;
        boundaries?: unknown;
      }>(absPath)
    : await safeImport<{ default?: unknown; rules?: unknown; boundaries?: unknown }>(absPath, {
        skipExistsCheck: true,
      });
  if (!result.ok) {
    const label = result.timedOut
      ? 'timed out loading boundary rules from'
      : 'failed to load boundary rules from';
    out.warnings.push(`${label} ${absPath}: ${result.error.message}`);
    out.loadError = result.error.message;
    return out;
  }
  const candidates =
    pickArray(result.module.default) ??
    pickArray(result.module.rules) ??
    pickArray(result.module.boundaries);
  if (candidates === null) {
    // A listed rule file that exports no array loads NOTHING — the same silent
    // vanishing act as an invalid rule, one level up.
    const message = 'exports no rule array (expected a default export, `rules` or `boundaries` array)';
    out.warnings.push(`${absPath}: ${message}`);
    out.loadError = message;
    return out;
  }
  // The export the rule array came from, so every rejection surface prints
  // `(default[1])` — one wording with every other contribution kind.
  const exportName =
    pickArray(result.module.default) !== null
      ? 'default'
      : pickArray(result.module.rules) !== null
        ? 'rules'
        : 'boundaries';
  candidates.forEach((c, index) => {
    const v = validateBoundaryRule(c);
    const id = (c as { id?: unknown } | null)?.id;
    if (!v.valid) {
      out.warnings.push(
        `${absPath}: skipping invalid boundary rule (${v.issues.map((i) => i.field).join(', ')})`,
      );
      out.invalid.push({ index, exportName, ...(typeof id === 'string' ? { ruleId: id } : {}), issues: v.issues });
      return;
    }
    // Round 13: the LOADED rule — plain string lists plus the expectEmptyUnits
    // ledger, each marker stamped with the contributing pack. Validation above
    // ran the same parser, so this cannot fail for a valid rule; if it ever
    // did, the rule is an errored rule, never a crash.
    const n = normalizeBoundaryRule(c as IBoundaryRuleInput, options.packageName);
    if (!n.ok) {
      const issues = unitProblemsOf(n.error).map((message) => ({ field: '<markers>', message }));
      out.invalid.push({ index, exportName, ...(typeof id === 'string' ? { ruleId: id } : {}), issues });
      return;
    }
    out.rules.push(n.value);
  });
  return out;
}

function pickArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  return null;
}
