import {
  err,
  normalizeWiringSource,
  ok,
  UnitEntryForm,
  unitProblemsError,
  unitProblemsOf,
  type AppErrorImpl,
  type IWiringSource,
  type Result,
} from '@shrkcrft/core';
import { GATE_PLANE_CONFIG_KEY, GATE_PLANE_ORDER } from './gate-plane-config-keys.ts';
import { normalizePlaneRule } from './normalize-plane-rule.ts';
import type { ISharkCraftConfig } from './sharkcraft-config.ts';

/**
 * Every gate plane of a (schema-validated) config, and the top-level
 * `extractors` map, through {@link normalizePlaneRule} / core's
 * `normalizeWiringSource` (round 13): the loaded config the engines read, with
 * plain string lists and `expectEmptyUnits` ledgers. The config loader calls it
 * after the schema and BEFORE `$use` resolution, so a `$use` consumer inherits
 * an extractor's markers from its ledger. A problem is named by its path
 * (`policyRules[no-react].files[1]: …`); the schema has already refused every
 * malformed marker, so an error here means a caller skipped it.
 */
export function normalizePlaneConfig(config: ISharkCraftConfig): Result<ISharkCraftConfig, AppErrorImpl> {
  const problems: string[] = [];
  const planes: Record<string, readonly unknown[]> = {};
  for (const plane of GATE_PLANE_ORDER) {
    const key = GATE_PLANE_CONFIG_KEY[plane];
    const rules = config[key] as readonly unknown[] | undefined;
    if (rules === undefined) continue;
    planes[key] = rules.map((rule, i) => {
      const n = normalizePlaneRule(plane, rule);
      if (n.ok) return n.value;
      problems.push(...unitProblemsOf(n.error).map((p) => `${key}[${elementLabel(rule, i)}].${p}`));
      return rule;
    });
  }
  let extractors: Record<string, IWiringSource> | undefined;
  if (config.extractors !== undefined) {
    extractors = {};
    for (const [id, definition] of Object.entries(config.extractors)) {
      const n = normalizeWiringSource(definition);
      if (n.ok) {
        extractors[id] = n.value;
        continue;
      }
      problems.push(...unitProblemsOf(n.error).map((p) => `extractors.${id}.${p}`));
      extractors[id] = definition;
    }
  }
  if (problems.length > 0) return err(unitProblemsError('config', problems, UnitEntryForm.List));
  return ok({ ...config, ...planes, ...(extractors !== undefined ? { extractors } : {}) } as ISharkCraftConfig);
}

/** How a problem names a rule: its id / name, else its index. */
function elementLabel(rule: unknown, index: number): string {
  if (rule !== null && typeof rule === 'object') {
    const r = rule as Record<string, unknown>;
    for (const k of ['id', 'name'] as const) if (typeof r[k] === 'string') return r[k] as string;
  }
  return String(index);
}
