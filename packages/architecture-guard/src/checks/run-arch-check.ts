import { GraphQueryApi, GraphStore } from '@shrkcrft/graph';
import type { IArchContract } from '../schema/contract.ts';
import {
  ARCH_REPORT_SCHEMA,
  type ArchViolationKind,
  type ArchViolationSeverity,
  type IArchReport,
  type IArchViolation,
} from '../schema/violation.ts';
import { detectAdapterLeaks } from './adapter-leak.ts';
import { detectBarrelRisks } from './barrel-risks.ts';
import { detectCycles } from './cycle-severity.ts';
import { detectPublicApiMisuse } from './public-api-misuse.ts';
import { evaluateContract } from './contract-checks.ts';

export interface IRunArchCheckOptions {
  projectRoot: string;
  /** Optional project-specific contract. When absent only the generic checks run. */
  contract?: IArchContract;
  /**
   * Which checks to run. Default: all generic checks; contract runs only
   * when `contract` is provided.
   */
  enable?: Partial<{
    publicApi: boolean;
    barrels: boolean;
    cycles: boolean;
    contract: boolean;
    adapterLeaks: boolean;
  }>;
}

/**
 * Run the architecture-guard checks against the on-disk code graph.
 *
 * Returns a structured report. Missing graph → diagnostic + zero
 * violations (never throws on the read path; the CLI surfaces the
 * `nextCommand` hint).
 */
export function runArchCheck(options: IRunArchCheckOptions): IArchReport {
  const diagnostics: string[] = [];
  const graphStore = new GraphStore(options.projectRoot);
  if (!graphStore.exists()) {
    diagnostics.push("code-graph store missing — run `shrk graph index`");
    return emptyReport(diagnostics, 0);
  }
  const api = GraphQueryApi.fromStore(options.projectRoot);
  const enable = {
    publicApi: options.enable?.publicApi ?? true,
    barrels: options.enable?.barrels ?? true,
    cycles: options.enable?.cycles ?? true,
    contract: options.enable?.contract ?? !!options.contract,
    adapterLeaks: options.enable?.adapterLeaks ?? true,
  };
  const violations: IArchViolation[] = [];
  if (enable.publicApi) violations.push(...detectPublicApiMisuse(api));
  if (enable.barrels) violations.push(...detectBarrelRisks(api));
  if (enable.cycles) violations.push(...detectCycles(api));
  if (enable.adapterLeaks) violations.push(...detectAdapterLeaks(api));
  if (enable.contract && options.contract) {
    violations.push(...evaluateContract(api, options.contract));
  } else if (enable.contract && !options.contract) {
    diagnostics.push("contract check enabled but no contract provided — skipping");
  }
  const filesAnalyzed = [...api.allFiles()].length;
  const countsBySeverity: Record<ArchViolationSeverity, number> = { error: 0, warning: 0, info: 0 };
  const countsByKind: Record<ArchViolationKind, number> = {
    'public-api-misuse': 0,
    'barrel-cycle': 0,
    'barrel-fat': 0,
    cycle: 0,
    'contract-import': 0,
    'contract-layer-skip': 0,
  };
  for (const v of violations) {
    countsBySeverity[v.severity] += 1;
    countsByKind[v.kind] += 1;
  }
  return {
    schema: ARCH_REPORT_SCHEMA,
    filesAnalyzed,
    violations,
    countsBySeverity,
    countsByKind,
    diagnostics,
  };
}

function emptyReport(diagnostics: readonly string[], filesAnalyzed: number): IArchReport {
  return {
    schema: ARCH_REPORT_SCHEMA,
    filesAnalyzed,
    violations: [],
    countsBySeverity: { error: 0, warning: 0, info: 0 },
    countsByKind: {
      'public-api-misuse': 0,
      'barrel-cycle': 0,
      'barrel-fat': 0,
      cycle: 0,
      'contract-import': 0,
      'contract-layer-skip': 0,
    },
    diagnostics,
  };
}
