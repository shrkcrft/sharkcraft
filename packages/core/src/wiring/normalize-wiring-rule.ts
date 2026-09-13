import { UnitEntryForm } from '../liveness/unit-entry-form.ts';
import { unitProblemsError } from '../liveness/unit-problems-error.ts';
import { unitProblemsOf } from '../liveness/unit-problems-of.ts';
import type { AppErrorImpl } from '../result/errors.ts';
import { err, ok, type Result } from '../result/result.ts';
import type { IWiringRuleInput } from './i-wiring-rule-input.ts';
import type { IWiringSourceInput } from './i-wiring-source-input.ts';
import { normalizeWiringSource } from './normalize-wiring-source.ts';
import type { IWiringRule, IWiringSource } from './wiring-rule.ts';

/**
 * Every source of one wiring rule through {@link normalizeWiringSource} —
 * `declared`, each `registered` sink, each `chain` hop — so the wiring engine's
 * entry (`runWiring` / `evaluateWiring`) normalises idempotently and a
 * hand-built rule with a marker object never crashes a glob reader. A problem
 * is named by its side (`declared.files[1]: …`, `chain[0].to.files[0]: …`).
 */
export function normalizeWiringRule(rule: IWiringRule | IWiringRuleInput): Result<IWiringRule, AppErrorImpl> {
  const problems: string[] = [];
  const one = (source: IWiringSource | IWiringSourceInput, side: string): IWiringSource => {
    const n = normalizeWiringSource(source);
    if (n.ok) return n.value;
    problems.push(...unitProblemsOf(n.error).map((p) => `${side}.${p}`));
    return source as IWiringSource;
  };
  const declared = rule.declared !== undefined ? one(rule.declared, 'declared') : undefined;
  const registered = Array.isArray(rule.registered)
    ? (rule.registered as readonly (IWiringSource | IWiringSourceInput)[]).map((s, i) => one(s, `registered[${i}]`))
    : rule.registered !== undefined
      ? one(rule.registered as IWiringSource | IWiringSourceInput, 'registered')
      : undefined;
  const chain = rule.chain?.map((s, i) => one(s, `chain[${i}]`));
  if (problems.length > 0) return err(unitProblemsError(rule.id, problems, UnitEntryForm.List));
  return ok({
    ...(rule as IWiringRule),
    ...(declared !== undefined ? { declared } : {}),
    ...(registered !== undefined ? { registered } : {}),
    ...(chain !== undefined ? { chain } : {}),
  });
}
