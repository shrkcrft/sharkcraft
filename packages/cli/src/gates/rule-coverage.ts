import type {
  IBaselineRule,
  IGeneratedArtifactRule,
  IPolicyRule,
  IRegistrationIdiom,
  IRegistryDeclaration,
  IRuleSelfTest,
  IWiringRule,
  IWiringSource,
  IDocReferenceRule,
} from '@shrkcrft/core';
import { referencedExtractorIds } from '@shrkcrft/core';
import {
  inspectSource,
  runPolicyLint,
  scanGeneratedFiles,
  walkMatching,
  withFileReadCache,
  wiringSourceSide,
} from '@shrkcrft/boundaries';
import { gateRuleSources } from './gate-rule-globs.ts';
import { checkDocReferences, type ISharkcraftInspection } from '@shrkcrft/inspector';
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
  /**
   * Every extracted id. Populated only when the caller asks (`includeAllIds`),
   * because a full set on every rule would bloat `gates coverage --json` for a
   * fact almost no consumer of it needs — `gates try --full` does.
   */
  readonly allIds?: readonly string[];
  /** True when a zero match is a hard failure for this rule. */
  readonly failOnEmpty: boolean;
  readonly error?: string;
  /**
   * A diagnosis for a zero-match that is correct but probably not intended —
   * e.g. an `import-edges` rule targeting `to.files` against barrel imports.
   */
  readonly hint?: string;
  /** Unmet `selfTest` expectations, each a human-readable sentence. */
  readonly expectationFailures: readonly string[];
  /**
   * Named extractor this rule's primary selector came from. Present only for a
   * `$use` consumer — the answer to "is this rule looking at the shared set, or
   * a copy of it that has since drifted?".
   */
  readonly viaExtractor?: string;
}

/**
 * One named extractor, reported ONCE with the rules that share it.
 *
 * The point of a shared extractor is that its consumers cannot disagree about
 * which set they check. Reporting it once — with its match count and its
 * consumer list — makes that guarantee visible: one line proves N rules are
 * pointed at the same, live, non-empty set.
 */
export interface ISharedExtractorCoverage {
  readonly id: string;
  /** Rule ids (plane-qualified) that resolve their primary selector from it. */
  readonly consumers: readonly string[];
  readonly filesMatched: number;
  readonly idsMatched: number;
  readonly sampleIds: readonly string[];
  readonly error?: string;
}

export interface IGateCoverageReport {
  readonly schema: typeof GATE_COVERAGE_SCHEMA;
  readonly rules: readonly IGateCoverage[];
  readonly total: number;
  readonly empty: number;
  readonly errored: number;
  readonly expectationFailures: number;
  /** Named extractors referenced by at least one rule, each reported once. */
  readonly extractors: readonly ISharedExtractorCoverage[];
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
  readonly hint?: string;
  /** Named extractor this rule's primary side resolved from, when it used one. */
  readonly viaExtractor?: string;
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
    ...(side.$use ? { viaExtractor: side.$use } : {}),
    ...(insp.error ? { error: insp.error } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
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
    ...(decl.source.$use ? { viaExtractor: decl.source.$use } : {}),
    ...(insp.error ? { error: insp.error } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
  };
}

function matchRegistration(cwd: string, idiom: IRegistrationIdiom, excludeDirs: readonly string[]): IPrimaryMatch {
  const insp = inspectSource(cwd, idiom.declared, excludeDirs);
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'declared tokens',
    ids: insp.ids,
    ...(idiom.declared.$use ? { viaExtractor: idiom.declared.$use } : {}),
    ...(insp.error ? { error: insp.error } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
  };
}

function matchBaseline(cwd: string, rule: IBaselineRule, excludeDirs: readonly string[]): IPrimaryMatch {
  // Only the EXTRACTOR half can be inspected without spawning. A command
  // compute is reported honestly as un-inspectable rather than guessed at —
  // `shrk baseline explain --id X` runs it on purpose.
  if (rule.compute.kind !== 'extractor' || !rule.compute.source) {
    // ...but its INPUTS can still be probed. `watchFiles` names the files that
    // feed the command, so globbing them (never spawning) answers the one
    // question the trust layer otherwise cannot: is this rule still connected
    // to the repo at all? A command baseline whose watchFiles point at a moved
    // directory is indistinguishable from a healthy one without this.
    const watch = rule.watchFiles ?? [];
    if (watch.length === 0) {
      return {
        filesMatched: 0,
        unitsMatched: 0,
        unitLabel: 'entries (command compute — not inspected; add `watchFiles` to enable the probe)',
        ids: [],
      };
    }
    const probed = walkMatching(cwd, watch, new Set(excludeDirs));
    return {
      filesMatched: probed.length,
      unitsMatched: probed.length,
      // A zero here is a REAL empty (stale watchFiles), so the label must not
      // carry the "not inspected" marker that suppresses the empty verdict.
      unitLabel: 'watchFiles input(s) (compute unverified — command never run)',
      ids: probed.slice(0, 5),
    };
  }
  const insp = inspectSource(cwd, rule.compute.source, excludeDirs);
  return {
    filesMatched: insp.filesScanned,
    unitsMatched: insp.ids.length,
    unitLabel: 'entries',
    ids: insp.ids,
    ...(rule.compute.source.$use ? { viaExtractor: rule.compute.source.$use } : {}),
    ...(insp.error ? { error: insp.error } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
  };
}

/**
 * A doc-reference rule's "match" is how many id-shaped TOKENS it validated.
 *
 * Files alone would lie: a rule whose globs match 40 docs but whose
 * `requireContext` gate rejects every token is enforcing nothing, and coverage
 * exists precisely to make that visible.
 */
function matchDocReference(
  cwd: string,
  rule: IDocReferenceRule,
  inspection: ISharkcraftInspection,
  excludeDirs: readonly string[],
): IPrimaryMatch {
  const res = checkDocReferences(cwd, rule, inspection, excludeDirs);
  return {
    filesMatched: res.filesScanned,
    unitsMatched: res.tokensChecked,
    unitLabel: 'doc reference(s)',
    ids: [...new Set(res.tokens.filter((t) => t.skipped === undefined).map((t) => t.token))].sort(),
    ...(res.error ? { error: res.error } : {}),
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
  extractors: Readonly<Record<string, IWiringSource>> = {},
  includeAllIds = false,
  inspection?: ISharkcraftInspection,
): IGateCoverageReport {
  // Safe to memo the tree reads for exactly this call: coverage NEVER spawns
  // (the `command` baseline is probed, not run) and never writes, so nothing
  // can change the tree between the first rule's scan and the last one's.
  return withFileReadCache(() =>
    buildGateCoverageUncached(cwd, rules, excludeDirs, extractors, includeAllIds, inspection),
  );
}

function buildGateCoverageUncached(
  cwd: string,
  rules: readonly IGateRuleView[],
  excludeDirs: readonly string[],
  extractors: Readonly<Record<string, IWiringSource>>,
  includeAllIds: boolean,
  inspection: ISharkcraftInspection | undefined,
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
      case 'doc-reference':
        // The inspection is only built when this plane is actually present, so
        // a repo without it never pays for the registries.
        match = inspection
          ? matchDocReference(cwd, view.raw as IDocReferenceRule, inspection, excludeDirs)
          : {
              filesMatched: 0,
              unitsMatched: 0,
              unitLabel: 'doc reference(s) (registries not loaded — not inspected)',
              ids: [],
            };
        break;
      default:
        match = matchGenerated(cwd, view.raw as IGeneratedArtifactRule, excludeDirs);
        break;
    }
    const expectationFailures = checkExpectations(view.selfTest, match.ids, match.unitsMatched);
    const uninspected = match.unitLabel.includes('not inspected');
    // A FENCE asserts emptiness, so for it a zero match is the verified state,
    // not a stale-selector suspect. Without this the rule is permanently red in
    // `gates coverage` and could never be part of a green CI.
    const emptyIsExpected = view.expectEmpty === true && match.unitsMatched === 0;
    const status: GateCoverageStatus =
      match.error !== undefined
        ? 'error'
        : expectationFailures.length > 0
          ? 'failed-expectation'
          : match.unitsMatched === 0 && !uninspected && !emptyIsExpected
            ? 'empty'
            : 'ok';
    out.push({
      id: view.id,
      plane: view.plane,
      ...(view.description ? { description: view.description } : {}),
      status,
      filesMatched: match.filesMatched,
      unitsMatched: match.unitsMatched,
      unitLabel: emptyIsExpected ? `${match.unitLabel} (empty — the asserted state)` : match.unitLabel,
      sampleIds: match.ids.slice(0, 5),
      ...(includeAllIds ? { allIds: match.ids } : {}),
      failOnEmpty: view.failOnEmpty,
      ...(match.error ? { error: match.error } : {}),
      ...(match.hint ? { hint: match.hint } : {}),
      ...(match.viaExtractor ? { viaExtractor: match.viaExtractor } : {}),
      expectationFailures,
    });
  }

  // Report each SHARED extractor once, with the rules that consume it. One
  // resolve per extractor, not per consumer — the shared definition is a single
  // fact about the tree, and stating it N times would invite the reader to
  // treat N agreeing consumers as N independent confirmations.
  //
  // Consumers are collected from EVERY side of every rule, not just the side
  // coverage happens to inspect: a rule bound to the extractor through its
  // `registered` sink is every bit as bound as one using it for `declared`, and
  // listing half of them would understate the guarantee.
  const consumersByExtractor = new Map<string, string[]>();
  for (const view of rules) {
    const label = `${view.plane}:${view.id}`;
    for (const id of referencedExtractorIds(gateRuleSources(view))) {
      const list = consumersByExtractor.get(id) ?? [];
      if (!list.includes(label)) list.push(label);
      consumersByExtractor.set(id, list);
    }
  }
  const extractorCoverage: ISharedExtractorCoverage[] = [...consumersByExtractor.keys()]
    .sort()
    .map((id) => {
      const definition = extractors[id];
      if (!definition) {
        return {
          id,
          consumers: consumersByExtractor.get(id)!,
          filesMatched: 0,
          idsMatched: 0,
          sampleIds: [],
          error: 'referenced but not declared in `extractors`',
        };
      }
      const insp = inspectSource(cwd, definition, excludeDirs);
      return {
        id,
        consumers: consumersByExtractor.get(id)!,
        filesMatched: insp.filesScanned,
        idsMatched: insp.ids.length,
        sampleIds: insp.ids.slice(0, 5),
        ...(insp.error ? { error: insp.error } : {}),
    ...(insp.hint ? { hint: insp.hint } : {}),
      };
    });
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
    extractors: extractorCoverage,
    verdict: empty + errored + expectationFailures > 0 ? 'stale' : 'pass',
  };
}
