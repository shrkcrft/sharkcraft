import type {
  IBaselineRule,
  IGeneratedArtifactRule,
  IPolicyRule,
  IRegistrationIdiom,
  IRegistryDeclaration,
  IRuleSelfTest,
  IWiringRule,
} from '@shrkcrft/core';
import {
  inspectSource,
  runPolicyLint,
  scanGeneratedFiles,
  wiringSourceSide,
} from '@shrkcrft/boundaries';
import type { IGateRuleView } from './gate-rule-view.ts';

export const GATE_COVERAGE_SCHEMA = 'sharkcraft.gate-coverage/v1' as const;

/**
 * Whether a rule is connected to anything at all.
 *
 * `empty` is the finding this whole surface exists for: a stale selector that
 * matches nothing passes every gate forever, so the ONLY way to notice is to
 * report the match count itself and flag zero. `failed-expectation` is the
 * stronger form — the author wrote down what the rule should match, and it
 * doesn't.
 */
export type GateCoverageStatus = 'ok' | 'empty' | 'error' | 'failed-expectation';

export interface IGateCoverage {
  readonly id: string;
  readonly plane: IGateRuleView['plane'];
  readonly description?: string;
  readonly status: GateCoverageStatus;
  /** Files the rule's primary selector matched. */
  readonly filesMatched: number;
  /** Ids/units the rule extracted (findings scanned, for the policy plane). */
  readonly unitsMatched: number;
  /** What "units" means for this plane, for honest reporting. */
  readonly unitLabel: string;
  /** A few of the extracted ids, so the author can eyeball correctness. */
  readonly sampleIds: readonly string[];
  /** True when a zero match is a hard failure for this rule. */
  readonly failOnEmpty: boolean;
  readonly error?: string;
  /** Unmet `selfTest` expectations, each a human-readable sentence. */
  readonly expectationFailures: readonly string[];
}

export interface IGateCoverageReport {
  readonly schema: typeof GATE_COVERAGE_SCHEMA;
  readonly rules: readonly IGateCoverage[];
  readonly total: number;
  readonly empty: number;
  readonly errored: number;
  readonly expectationFailures: number;
  /**
   * `pass` — every rule matched something and met its expectations.
   * `stale` — at least one rule matched nothing (or broke an expectation).
   */
  readonly verdict: 'pass' | 'stale';
}

/** Evaluate the author's declared expectations against what the rule extracted. */
function checkExpectations(
  selfTest: IRuleSelfTest | undefined,
  ids: readonly string[],
  unitsMatched: number,
): string[] {
  if (!selfTest) return [];
  const out: string[] = [];
  if (
    selfTest.expectMatchesAtLeast !== undefined &&
    unitsMatched < selfTest.expectMatchesAtLeast
  ) {
    out.push(
      `expected at least ${selfTest.expectMatchesAtLeast} match(es), got ${unitsMatched}`,
    );
  }
  const present = new Set(ids);
  for (const id of selfTest.expectIds ?? []) {
    if (!present.has(id)) out.push(`expected id "${id}" was NOT extracted`);
  }
  for (const id of selfTest.expectNotIds ?? []) {
    if (present.has(id)) out.push(`id "${id}" was extracted but is listed in expectNotIds`);
  }
  return out;
}

/** What one rule's primary selector resolved to, before expectations are applied. */
interface IPrimaryMatch {
  readonly filesMatched: number;
  readonly unitsMatched: number;
  readonly unitLabel: string;
  readonly ids: readonly string[];
  readonly error?: string;
}

function matchWiring(cwd: string, rule: IWiringRule, excludeDirs: readonly string[]): IPrimaryMatch {
  const side = wiringSourceSide(rule);
  if (!side) return { filesMatched: 0, unitsMatched: 0, unitLabel: 'ids', ids: [], error: 'rule sets no source side' };
  const insp = inspectSource(cwd, side, excludeDirs);
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'ids',
    ids: insp.ids,
    ...(insp.error ? { error: insp.error } : {}),
  };
}

function matchPolicy(cwd: string, rule: IPolicyRule, excludeDirs: readonly string[]): IPrimaryMatch {
  const report = runPolicyLint(cwd, [rule], { excludeDirs });
  const result = report.rules[0];
  return {
    // A policy rule's "files" and "units" differ only for inline templates.
    filesMatched: result?.unitsScanned ?? 0,
    unitsMatched: result?.unitsScanned ?? 0,
    unitLabel: 'content units',
    ids: [],
    ...(result?.error ? { error: result.error } : {}),
  };
}

function matchRegistry(cwd: string, decl: IRegistryDeclaration, excludeDirs: readonly string[]): IPrimaryMatch {
  const insp = inspectSource(cwd, decl.source, excludeDirs);
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'ids',
    ids: insp.ids,
    ...(insp.error ? { error: insp.error } : {}),
  };
}

function matchRegistration(cwd: string, idiom: IRegistrationIdiom, excludeDirs: readonly string[]): IPrimaryMatch {
  const insp = inspectSource(cwd, idiom.declared, excludeDirs);
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'declared tokens',
    ids: insp.ids,
    ...(insp.error ? { error: insp.error } : {}),
  };
}

function matchBaseline(cwd: string, rule: IBaselineRule, excludeDirs: readonly string[]): IPrimaryMatch {
  // Only the EXTRACTOR half can be inspected without spawning. A command
  // compute is reported honestly as un-inspectable rather than guessed at —
  // `shrk baseline explain --id X` runs it on purpose.
  if (rule.compute.kind !== 'extractor' || !rule.compute.source) {
    return {
      filesMatched: 0,
      unitsMatched: 0,
      unitLabel: 'entries (command compute — not inspected)',
      ids: [],
    };
  }
  const insp = inspectSource(cwd, rule.compute.source, excludeDirs);
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'entries',
    ids: insp.ids,
    ...(insp.error ? { error: insp.error } : {}),
  };
}

function matchGenerated(cwd: string, rule: IGeneratedArtifactRule, excludeDirs: readonly string[]): IPrimaryMatch {
  const scan = scanGeneratedFiles(cwd, rule, excludeDirs);
  const files = [...scan.generated.keys()];
  return {
    filesMatched: files.length,
    unitsMatched: files.length,
    unitLabel: 'generated files',
    ids: files,
  };
}

/**
 * Resolve every declared rule against the live tree and report what it matched.
 *
 * The `command`-compute baseline is the one rule kind that cannot be inspected
 * without side effects; it is reported as un-inspected (never as `empty`), so
 * the report never claims a fact it did not check.
 */
export function buildGateCoverage(
  cwd: string,
  rules: readonly IGateRuleView[],
  excludeDirs: readonly string[] = [],
): IGateCoverageReport {
  const out: IGateCoverage[] = [];
  for (const view of rules) {
    let match: IPrimaryMatch;
    switch (view.plane) {
      case 'wiring':
        match = matchWiring(cwd, view.raw as IWiringRule, excludeDirs);
        break;
      case 'policy':
        match = matchPolicy(cwd, view.raw as IPolicyRule, excludeDirs);
        break;
      case 'registry':
        match = matchRegistry(cwd, view.raw as IRegistryDeclaration, excludeDirs);
        break;
      case 'registration':
        match = matchRegistration(cwd, view.raw as IRegistrationIdiom, excludeDirs);
        break;
      case 'baseline':
        match = matchBaseline(cwd, view.raw as IBaselineRule, excludeDirs);
        break;
      default:
        match = matchGenerated(cwd, view.raw as IGeneratedArtifactRule, excludeDirs);
        break;
    }
    const expectationFailures = checkExpectations(view.selfTest, match.ids, match.unitsMatched);
    const uninspected = match.unitLabel.includes('not inspected');
    const status: GateCoverageStatus =
      match.error !== undefined
        ? 'error'
        : expectationFailures.length > 0
          ? 'failed-expectation'
          : match.unitsMatched === 0 && !uninspected
            ? 'empty'
            : 'ok';
    out.push({
      id: view.id,
      plane: view.plane,
      ...(view.description ? { description: view.description } : {}),
      status,
      filesMatched: match.filesMatched,
      unitsMatched: match.unitsMatched,
      unitLabel: match.unitLabel,
      sampleIds: match.ids.slice(0, 5),
      failOnEmpty: view.failOnEmpty,
      ...(match.error ? { error: match.error } : {}),
      expectationFailures,
    });
  }
  const empty = out.filter((r) => r.status === 'empty').length;
  const errored = out.filter((r) => r.status === 'error').length;
  const expectationFailures = out.filter((r) => r.status === 'failed-expectation').length;
  return {
    schema: GATE_COVERAGE_SCHEMA,
    rules: out,
    total: out.length,
    empty,
    errored,
    expectationFailures,
    verdict: empty + errored + expectationFailures > 0 ? 'stale' : 'pass',
  };
}
