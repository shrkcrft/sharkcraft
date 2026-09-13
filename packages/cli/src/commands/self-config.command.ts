/**
 * `shrk self-config doctor|graph|broken-links|report` — cross-reference
 * walker. Read-only; `report` writes to `.sharkcraft/reports/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { DEAD_SELECTOR_CAUSES, UnitLivenessState, type IVerdictCoverage } from '@shrkcrft/core';
import {
  assetDoctorProposedExit,
  buildDeclaredXrefReport,
  buildSelfConfigDoctorReportV2,
  buildSelfConfigGraph,
  declaredXrefCoverage,
  inspectSharkcraft,
  isUnresolvedReferenceFinding,
  isWrongKindReferenceFinding,
  SelfConfigSeverityV2,
  withDeclaredXrefEdges,
  projectSelfConfigDoctorV2ToV1,
  renderSelfConfigDoctorMarkdown,
  renderSelfConfigDoctorText,
  renderSelfConfigDoctorV2Markdown,
  renderSelfConfigDoctorV2Text,
  type ISelfConfigDoctorReportV2,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { asJson } from '../output/format-output.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { assetDoctorFailingUnits } from '../gates/asset-doctor-failing-units.ts';
import { assetDoctorFailureLine } from '../gates/asset-doctor-failure-line.ts';
import { warmCliReferenceRegistries } from '../surface/cli-command-resolver.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import type { ISettledVerdict } from '../gates/settled-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { selfConfigResolveCommand, selfConfigXrefsCommand } from './self-config-xrefs.command.ts';

/**
 * The self-config graph plus one edge per declared cross-reference id, from THE
 * collector the doctor reads — so `graph`, `broken-links` and `report` show the
 * same dangling ids as `doctor` (the v1 graph alone saw only file references).
 */
async function selfConfigGraphWithXrefs(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
): Promise<{
  graph: Awaited<ReturnType<typeof buildSelfConfigGraph>>;
  base: Awaited<ReturnType<typeof buildSelfConfigGraph>>;
  xrefs: Awaited<ReturnType<typeof buildDeclaredXrefReport>>;
}> {
  const xrefs = await buildDeclaredXrefReport(inspection);
  const base = await buildSelfConfigGraph(inspection);
  return { graph: withDeclaredXrefEdges(base, xrefs), base, xrefs };
}

/**
 * THE coverage `self-config broken-links` settles on (round 11 review
 * R11-GAP-4): the references it examined of the references declared — every
 * file reference of the graph (each checked on disk) plus every declared
 * cross-reference id (`declaredXrefCoverage`: one that could not be looked up
 * is unexamined). Nothing declared is `expected: 0` — NOT VERIFIED (2) unless
 * `--allow-empty` accepts it, as every sibling doctor settles "nothing to
 * examine". It used to settle against NO record over an empty config and print
 * "No broken references. ✓" at 0.
 */
function brokenLinksCoverage(
  base: Awaited<ReturnType<typeof buildSelfConfigGraph>>,
  xrefs: Awaited<ReturnType<typeof buildDeclaredXrefReport>>,
  args: ParsedArgs,
): IVerdictCoverage {
  const ids = declaredXrefCoverage(xrefs);
  const fileRefs = base.edges.filter((e) => e.to.kind === 'file').length;
  const expected = fileRefs + ids.expected;
  return {
    unit: 'references',
    expected,
    examined: fileRefs + ids.examined,
    ...(ids.unexamined !== undefined
      ? { unexamined: ids.unexamined, unexaminedTotal: ids.unexaminedTotal ?? ids.unexamined.length, reason: ids.reason ?? 'not examined' }
      : {}),
    ...(expected === 0 ? { reason: 'no file reference and no declared cross-reference id to examine' } : {}),
    ...allowEmptyValve(args, expected),
  };
}

/** The shared dead-selector valve (boundary, gate and asset planes spell it the same). */
const FAIL_ON_DEAD_UNITS_FLAG = 'fail-on-dead-units';

const DOCTOR_FLAGS: ReadonlySet<string> = new Set(['json', 'strict', FAIL_ON_DEAD_UNITS_FLAG]);

/**
 * THE self-config verdict — one settle for `--schema v1` and v2 alike (v1 is a
 * projection of the same report), for `self-config doctor` and `self-config
 * report`, through THE asset-doctor proposal MCP `get_self_config_doctor`
 * reads too (round 13): 1 on errors, on warnings under `--strict`, or on a
 * settled selector unit THE `--fail-on-dead-units` predicate fails (a dead
 * unit, or a stale LOCAL expectEmpty marker); else 0. The engine's coverage
 * (command strings, tuning keys + triggers, routing hints + their ids,
 * registration discovery, scaffold globs) settles it: a dead or unverifiable
 * unit turns 0 into 2, never a pass; an intended-empty unit is a printed
 * acceptance.
 */
function settleSelfConfig(report: ISelfConfigDoctorReportV2, args: ParsedArgs): ISettledVerdict {
  const proposed = assetDoctorProposedExit(
    { errors: report.totals.error, warnings: report.totals.warning, units: report.selectorUnits },
    { strict: flagBool(args, 'strict'), failOnDeadUnits: flagBool(args, FAIL_ON_DEAD_UNITS_FLAG) },
  );
  return settleVerdict(proposed, report.coverage);
}

/**
 * THE units that fail the self-config verdict (round 13 review) — the
 * predicate `settleSelfConfig` proposes from — so the verbs can say why a
 * `--fail-on-dead-units` run exited 1 (its header read `verdict OK` and no line
 * named the failure).
 */
function selfConfigFailing(report: ISelfConfigDoctorReportV2, args: ParsedArgs): ReturnType<typeof assetDoctorFailingUnits> {
  return assetDoctorFailingUnits(report.selectorUnits, {
    failOnDeadUnits: flagBool(args, FAIL_ON_DEAD_UNITS_FLAG),
    strict: flagBool(args, 'strict'),
  });
}

/** The settled verdict's fields on `--json` — the vocabulary the sibling doctors use (`verdict` stays the report's own). */
function settledJson(
  settled: ISettledVerdict,
  failing: ReturnType<typeof assetDoctorFailingUnits> = [],
): {
  readonly exitCode: number;
  readonly settledVerdict: ISettledVerdict['verdict'];
  readonly shortfalls: readonly string[];
  readonly accepted: readonly string[];
  readonly failingUnits: readonly { readonly list: string; readonly unit: string; readonly state: string; readonly message: string }[];
} {
  return {
    exitCode: settled.exit,
    settledVerdict: settled.verdict,
    shortfalls: settled.shortfalls,
    accepted: settled.accepted,
    failingUnits: failing.map((u) => ({ list: u.list, unit: u.unit, state: u.state, message: u.message })),
  };
}

/**
 * What the command probes did NOT prove, said out loud in the clean line: a
 * `prefix-only` tail (verb proven, internally-dispatched tail not) and a
 * `not-shrk` string (never checked — narrowed out of the coverage) are not
 * "resolved".
 */
function commandProbeCaveats(report: ISelfConfigDoctorReportV2): string {
  const c = report.probes.command;
  const parts: string[] = [];
  if (c.prefixOnly > 0) parts.push(`${c.prefixOnly} prefix-only tail(s) unproven`);
  if (c.notShrk > 0) parts.push(`${c.notShrk} non-shrk command string(s) not checked`);
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

/**
 * The exit-0 sentence. "every checked probe resolved ✓" is printed only when
 * it is true: an INFO-severity unresolved reference (a routing / registration
 * hint's related id, a convention's applicability profile id, a pipeline step
 * reference — THE doctor's `isUnresolvedReferenceFinding`) never fails the
 * run, but it is not "resolved", so it is counted instead of certified. So is
 * an info-severity WRONG-KIND reference (`isWrongKindReferenceFinding`: a
 * pipeline step naming a construct) — it resolves, but not as its field
 * accepts (round 12, 12.4 split it out of `pipeline-reference-missing`).
 */
function cleanSentence(report: ISelfConfigDoctorReportV2): string {
  const caveats = commandProbeCaveats(report);
  const info = report.findings.filter((f) => f.severity === SelfConfigSeverityV2.Info);
  const unresolvedInfo = info.filter(isUnresolvedReferenceFinding).length;
  const wrongKindInfo = info.filter(isWrongKindReferenceFinding).length;
  // A stale LOCAL expectEmpty marker is not "resolved" either (round 13): it is
  // counted, never certified (a pack's is INFO — the consumer cannot edit it).
  const staleMarkers = report.selectorUnits.filter(
    (u) => u.state === UnitLivenessState.WentLive && u.mark?.packageName === undefined,
  ).length;
  const reported = [
    ...(report.totals.warning > 0 ? [`${report.totals.warning} warning(s)`] : []),
    ...(unresolvedInfo > 0 ? [`${unresolvedInfo} unresolved reference(s)`] : []),
    ...(wrongKindInfo > 0 ? [`${wrongKindInfo} wrong-kind reference(s)`] : []),
    ...(staleMarkers > 0 ? [`${staleMarkers} stale expectEmpty marker(s)`] : []),
  ];
  if (reported.length === 0) return `No cross-reference issues — every checked probe resolved${caveats}. ✓`;
  const where = report.totals.warning > 0 ? 'reported above' : 'reported as info above';
  const listed =
    reported.length > 1 ? `${reported.slice(0, -1).join(', ')} and ${reported[reported.length - 1]}` : reported[0];
  return `No blocking cross-reference issues${caveats} — ${listed} ${where}.`;
}

async function buildDoctorReport(
  args: ParsedArgs,
): Promise<{ cwd: string; inspection: Awaited<ReturnType<typeof inspectSharkcraft>>; report: ISelfConfigDoctorReportV2 }> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  // Warm WITH the command resolver so every prescribed command string resolves
  // against the live command index — for both schemas.
  await warmCliReferenceRegistries(inspection);
  return { cwd, inspection, report: await buildSelfConfigDoctorReportV2(inspection) };
}

export const selfConfigDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Self-config cross-reference doctor — validates the graph of refs, with per-unit coverage (exit 0 pass · 1 errors · 2 a dead or unverified unit). Defaults to v2 schema; pass --schema v1 for the legacy shape (same checks).',
  usage:
    'shrk self-config doctor [--schema v1|v2] [--format text|markdown|json] [--strict] [--fail-on-dead-units]',
  booleanFlags: DOCTOR_FLAGS,
  async run(args: ParsedArgs): Promise<number> {
    const format = flagString(args, 'format') ?? 'text';
    const wantJson = flagBool(args, 'json') || format === 'json';
    const useV1 = flagString(args, 'schema') === 'v1';
    const { report } = await buildDoctorReport(args);
    const settled = settleSelfConfig(report, args);
    const failing = selfConfigFailing(report, args);
    if (wantJson) {
      const payload = useV1 ? projectSelfConfigDoctorV2ToV1(report) : report;
      process.stdout.write(asJson({ ...payload, ...settledJson(settled, failing) }) + '\n');
      return settled.exit;
    }
    if (useV1) {
      const v1 = projectSelfConfigDoctorV2ToV1(report);
      process.stdout.write(format === 'markdown' ? renderSelfConfigDoctorMarkdown(v1) : renderSelfConfigDoctorText(v1));
    } else {
      process.stdout.write(
        format === 'markdown' ? renderSelfConfigDoctorV2Markdown(report) : renderSelfConfigDoctorV2Text(report),
      );
    }
    const line = verdictLine(settled, cleanSentence(report));
    if (line) process.stdout.write(line + '\n');
    // Round 13 review: a 1 from --fail-on-dead-units names its units — the
    // header above reads the REPORT's own verdict (`verdict OK`).
    if (settled.exit === 1) {
      const failure = assetDoctorFailureLine('self-config doctor', failing);
      if (failure) process.stdout.write(failure + '\n');
    }
    if (settled.exit !== 0 && report.deadUnits.length > 0 && !flagBool(args, FAIL_ON_DEAD_UNITS_FLAG)) {
      process.stdout.write(
        `Fix each dead unit (${report.deadUnits.length}) — ${DEAD_SELECTOR_CAUSES}; pass --${FAIL_ON_DEAD_UNITS_FLAG} to fail on them.\n`,
      );
    }
    return settled.exit;
  },
};

export const selfConfigGraphCommand: ICommandHandler = {
  name: 'graph',
  description: 'Render the self-config reference graph as JSON or DOT/mermaid.',
  usage: 'shrk self-config graph [--format json|mermaid|dot]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const { graph } = await selfConfigGraphWithXrefs(inspection);
    const format = flagString(args, 'format') ?? 'json';
    if (format === 'mermaid') {
      const lines: string[] = ['graph TD'];
      for (const e of graph.edges) {
        lines.push(`  ${e.from.kind}_${e.from.id} --> ${e.to.kind}_${e.to.id}`);
      }
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }
    if (format === 'dot') {
      const lines: string[] = ['digraph G {'];
      for (const e of graph.edges) {
        lines.push(`  "${e.from.kind}/${e.from.id}" -> "${e.to.kind}/${e.to.id}";`);
      }
      lines.push('}');
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }
    process.stdout.write(asJson(graph) + '\n');
    return 0;
  },
};

export const selfConfigBrokenLinksCommand: ICommandHandler = {
  name: 'broken-links',
  description:
    'List only the broken references — missing referenced files AND every dangling / wrong-kind declared cross-reference id (the rows `self-config doctor` reports). Exit 0 none · 1 broken · 2 an id could not be looked up, or nothing to examine (--allow-empty accepts that).',
  usage: 'shrk self-config broken-links [--allow-empty] [--json]',
  booleanFlags: new Set(['json', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const { graph, base, xrefs } = await selfConfigGraphWithXrefs(inspection);
    // Always settled against what was examined: an id that could not be looked
    // up, or nothing to examine at all, is never "no broken references".
    const coverage = brokenLinksCoverage(base, xrefs, args);
    const settled = settleVerdict(graph.brokenEdges.length === 0 ? 0 : 1, [coverage]);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          brokenEdges: graph.brokenEdges,
          coverage,
          exitCode: settled.exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
          accepted: settled.accepted,
        }) + '\n',
      );
      return settled.exit;
    }
    if (graph.brokenEdges.length > 0) {
      process.stdout.write(`=== Broken self-config references (${graph.brokenEdges.length}) ===\n`);
      for (const e of graph.brokenEdges.slice(0, 100)) {
        process.stdout.write(`  • ${e.from.kind}:${e.from.id} -> ${e.to.kind}:${e.to.id}  (${e.relation})\n`);
      }
    }
    const line = verdictLine(
      settled,
      'No broken references. ✓',
      coverage.expected === 0
        ? `NOT VERIFIED — nothing to examine: no file reference and no declared cross-reference id. Pass --${ALLOW_EMPTY_FLAG} to accept that.`
        : undefined,
    );
    if (line) process.stdout.write(line + '\n');
    return settled.exit;
  },
};

export const selfConfigReportCommand: ICommandHandler = {
  name: 'report',
  description:
    'Write the self-config doctor + graph reports under .sharkcraft/reports/, and settle the doctor verdict (exit 0 pass · 1 errors · 2 a dead or unverified unit), the same as `self-config doctor`.',
  usage: 'shrk self-config report [--schema v1|v2] [--output <dir>] [--strict] [--fail-on-dead-units] [--json]',
  booleanFlags: DOCTOR_FLAGS,
  async run(args: ParsedArgs): Promise<number> {
    const useV1 = flagString(args, 'schema') === 'v1';
    const { cwd, inspection, report } = await buildDoctorReport(args);
    const { graph } = await selfConfigGraphWithXrefs(inspection);
    const outArg = flagString(args, 'output');
    const outDir = outArg
      ? (nodePath.isAbsolute(outArg) ? outArg : nodePath.resolve(cwd, outArg))
      : nodePath.join(cwd, '.sharkcraft', 'reports');
    mkdirSync(outDir, { recursive: true });
    const base = 'self-config-doctor';
    const settled = settleSelfConfig(report, args);
    if (useV1) {
      const v1 = projectSelfConfigDoctorV2ToV1(report);
      writeFileSync(nodePath.join(outDir, `${base}.json`), JSON.stringify(v1, null, 2) + '\n', 'utf8');
      writeFileSync(nodePath.join(outDir, `${base}.md`), renderSelfConfigDoctorMarkdown(v1), 'utf8');
    } else {
      writeFileSync(nodePath.join(outDir, `${base}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');
      writeFileSync(nodePath.join(outDir, `${base}.md`), renderSelfConfigDoctorV2Markdown(report), 'utf8');
    }
    writeFileSync(
      nodePath.join(outDir, `${base}-graph.json`),
      JSON.stringify(graph, null, 2) + '\n',
      'utf8',
    );
    if (flagBool(args, 'json')) {
      // The same settled fields as `self-config doctor --json` (round 13): a
      // registered verdict verb, so its 2 survives a pipe and a bad flag is 3.
      const rel = (name: string): string => nodePath.relative(cwd, nodePath.join(outDir, name)) || name;
      process.stdout.write(
        asJson({
          written: [rel(`${base}.json`), rel(`${base}.md`), rel(`${base}-graph.json`)],
          schema: useV1 ? 'v1' : 'v2',
          verdict: report.verdict,
          ...settledJson(settled, selfConfigFailing(report, args)),
        }) + '\n',
      );
      return settled.exit;
    }
    process.stdout.write(
      `Wrote ${nodePath.relative(cwd, outDir)}/${base}.{json,md} (${useV1 ? 'v1' : 'v2'}) and ${base}-graph.json\n`,
    );
    const line = verdictLine(settled, cleanSentence(report));
    if (line) process.stdout.write(line + '\n');
    // Round 13 review: a 1 from --fail-on-dead-units names its units.
    if (settled.exit === 1) {
      const failure = assetDoctorFailureLine('self-config report', selfConfigFailing(report, args));
      if (failure) process.stdout.write(failure + '\n');
    }
    return settled.exit;
  },
};

export const selfConfigCommand: ICommandHandler = {
  name: 'self-config',
  positionals: PositionalMode.None,
  subverbs: [
    {
      name: 'doctor',
      description: 'Cross-reference doctor over the self-config + pack contributions.',
      usage:
        'shrk self-config doctor [--schema v1|v2] [--format text|markdown|json] [--strict] [--fail-on-dead-units] [--json]',
    },
    { name: 'graph', description: 'The self-config reference graph.', usage: 'shrk self-config graph [--dangling-only] [--json]' },
    {
      name: 'broken-links',
      description: 'References that resolve to nothing (exit 2 when nothing could be examined; --allow-empty accepts that).',
      usage: 'shrk self-config broken-links [--allow-empty] [--json]',
    },
    {
      name: 'report',
      description:
        'Write the self-config report, settling the doctor verdict (exit 0 pass · 1 errors · 2 a dead or unverified unit).',
      usage: 'shrk self-config report [--schema v1|v2] [--output <dir>] [--strict] [--fail-on-dead-units] [--json]',
    },
    { name: 'resolve', description: 'Resolve one id across every kind.', usage: 'shrk self-config resolve <id> [--json]', positionals: PositionalMode.Free },
    { name: 'xrefs', description: 'Declared cross-references between assets.', usage: 'shrk self-config xrefs [--json]' },
  ],
  description: 'Cross-reference doctor over SharkCraft self-config + pack contributions.',
  usage: 'shrk self-config doctor|graph|broken-links|report|resolve|xrefs ...',
  // The group parses every subverb's argv, so the subverbs' boolean flags live here too.
  booleanFlags: new Set([...DOCTOR_FLAGS, 'dangling-only', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    args.positional = args.positional.slice(1);
    if (sub === 'doctor') return selfConfigDoctorCommand.run(args);
    if (sub === 'graph') return selfConfigGraphCommand.run(args);
    if (sub === 'broken-links') return selfConfigBrokenLinksCommand.run(args);
    if (sub === 'report') return selfConfigReportCommand.run(args);
    if (sub === 'resolve') return selfConfigResolveCommand.run(args);
    if (sub === 'xrefs') return selfConfigXrefsCommand.run(args);
    process.stderr.write('Usage: shrk self-config doctor|graph|broken-links|report|resolve|xrefs ...\n');
    return 2;
  },
};
