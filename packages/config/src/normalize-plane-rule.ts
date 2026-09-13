import {
  err,
  normalizeRuleList,
  normalizeWiringSource,
  ok,
  stampUnitMarks,
  UnitEntryForm,
  unitProblemsError,
  unitProblemsOf,
  type AppErrorImpl,
  type IBaselineRule,
  type IDocReferenceRule,
  type IGeneratedArtifactRule,
  type IPolicyRule,
  type IRegistrationIdiom,
  type IRegistryDeclaration,
  type IUnitMark,
  type IWiringRule,
  type IWiringSource,
  type Result,
} from '@shrkcrft/core';
import type { GatePlane } from './gate-plane.ts';

/**
 * THE normaliser of one gate-plane rule's markable lists (round 13) — the
 * `MARKABLE_UNIT_LISTS` paths of its plane, through core's normalisers
 * (`normalizeWiringSource` for a source, `normalizeRuleList` for a rule-level
 * list, both over the one parser):
 *
 *   wiring        declared / registered[i] / chain[i]: `files`, `to.files`
 *   registry      source / consumer: `files`, `to.files`
 *   registration  declared / provided / consumed: `files`, `to.files`
 *   baseline      compute.source: `files`, `to.files`; the rule's `watchFiles`
 *   policy        `files`
 *   generated     `generatedGlob`
 *   doc-reference `files`
 *
 * Source-carried markers land in that source's `expectEmptyUnits` (`list:
 * 'files'` / `'to.files'`, so `$use` carries them and a local `files` override
 * replaces them — `resolveExtractorRef`); rule-level lists land in the rule's
 * own `expectEmptyUnits`. Every list comes back a plain string list.
 *
 * `packageName` STAMPS every marker (the pack merge seam passes the
 * contributing pack; the local config passes nothing). IDEMPOTENT: a loaded
 * rule comes back equal. Called by the config loader (after the schema, BEFORE
 * `$use` resolution), by the pack merge seam (`resolveProjectConfig`) and by
 * `gates try`, so one authored rule loads identically on every path. A
 * malformed marker — reachable only through a caller that skipped the schema —
 * is a `CONFIG_INVALID` error naming each bad entry by its path.
 */
export function normalizePlaneRule<T>(plane: GatePlane, rule: T, packageName?: string): Result<T, AppErrorImpl> {
  const problems: string[] = [];

  const source = (s: IWiringSource | undefined, side: string): IWiringSource | undefined => {
    if (s === undefined) return undefined;
    const n = normalizeWiringSource(s);
    if (!n.ok) {
      problems.push(...unitProblemsOf(n.error).map((p) => `${side}.${p}`));
      return s;
    }
    return stamped(n.value, packageName);
  };
  const list = <R extends { readonly expectEmptyUnits?: readonly IUnitMark[] }>(r: R, field: keyof R & string): R => {
    const n = normalizeRuleList(r, field);
    if (!n.ok) {
      problems.push(...unitProblemsOf(n.error));
      return r;
    }
    return stamped(n.value, packageName);
  };

  let out: unknown = rule;
  switch (plane) {
    case 'wiring': {
      const r = rule as unknown as IWiringRule;
      const declared = source(r.declared, 'declared');
      const registered = Array.isArray(r.registered)
        ? (r.registered as readonly IWiringSource[]).map((s, i) => source(s, `registered[${i}]`) ?? s)
        : source(r.registered as IWiringSource | undefined, 'registered');
      const chain = r.chain?.map((s, i) => source(s, `chain[${i}]`) ?? s);
      out = {
        ...r,
        ...(declared !== undefined ? { declared } : {}),
        ...(registered !== undefined ? { registered } : {}),
        ...(chain !== undefined ? { chain } : {}),
      };
      break;
    }
    case 'registry': {
      const r = rule as unknown as IRegistryDeclaration;
      const consumer = source(r.consumer, 'consumer');
      out = { ...r, source: source(r.source, 'source') ?? r.source, ...(consumer !== undefined ? { consumer } : {}) };
      break;
    }
    case 'registration': {
      const r = rule as unknown as IRegistrationIdiom;
      out = {
        ...r,
        declared: source(r.declared, 'declared') ?? r.declared,
        provided: source(r.provided, 'provided') ?? r.provided,
        consumed: source(r.consumed, 'consumed') ?? r.consumed,
      };
      break;
    }
    case 'baseline': {
      const r = rule as unknown as IBaselineRule;
      const compute =
        r.compute?.source !== undefined
          ? { ...r.compute, source: source(r.compute.source, 'compute.source') ?? r.compute.source }
          : r.compute;
      out = list({ ...r, compute }, 'watchFiles');
      break;
    }
    case 'policy':
      out = list(rule as unknown as IPolicyRule, 'files');
      break;
    case 'generated':
      out = list(rule as unknown as IGeneratedArtifactRule, 'generatedGlob');
      break;
    case 'doc-reference':
      out = list(rule as unknown as IDocReferenceRule, 'files');
      break;
  }
  if (problems.length > 0) return err(unitProblemsError(ruleLabel(rule), problems, UnitEntryForm.List));
  return ok(out as T);
}

/** `item` with every marker of its own ledger stamped with `packageName` (unchanged when there is none). */
function stamped<T extends { readonly expectEmptyUnits?: readonly IUnitMark[] }>(item: T, packageName: string | undefined): T {
  const marks = item.expectEmptyUnits;
  if (marks === undefined || marks.length === 0 || packageName === undefined) return item;
  return { ...item, expectEmptyUnits: stampUnitMarks(marks, packageName) };
}

/** A rule's id / name, for an error's `listPath`. */
function ruleLabel(rule: unknown): string {
  if (rule !== null && typeof rule === 'object') {
    const r = rule as Record<string, unknown>;
    for (const k of ['id', 'name'] as const) if (typeof r[k] === 'string') return r[k] as string;
  }
  return 'rule';
}
