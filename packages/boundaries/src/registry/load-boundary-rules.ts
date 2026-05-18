import { existsSync } from 'node:fs';
import { type IImportContext, safeImport } from '@shrkcrft/core';
import { validateBoundaryRule, type IBoundaryRule } from '../model/boundary-rule.ts';

export interface ILoadedBoundaryRulesFile {
  source: string;
  rules: IBoundaryRule[];
  warnings: string[];
}

export interface ILoadBoundaryRulesOptions {
  importContext?: IImportContext;
}

export async function loadBoundaryRulesFromFile(
  absPath: string,
  options: ILoadBoundaryRulesOptions = {},
): Promise<ILoadedBoundaryRulesFile> {
  const out: ILoadedBoundaryRulesFile = {
    source: absPath,
    rules: [],
    warnings: [],
  };
  if (!existsSync(absPath)) {
    out.warnings.push(`boundary rules file not found: ${absPath}`);
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
    return out;
  }
  const candidates =
    pickArray(result.module.default) ??
    pickArray(result.module.rules) ??
    pickArray(result.module.boundaries) ??
    [];
  for (const c of candidates) {
    const v = validateBoundaryRule(c);
    if (!v.valid) {
      out.warnings.push(
        `${absPath}: skipping invalid boundary rule (${v.issues.map((i) => i.field).join(', ')})`,
      );
      continue;
    }
    out.rules.push(c as IBoundaryRule);
  }
  return out;
}

function pickArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  return null;
}
