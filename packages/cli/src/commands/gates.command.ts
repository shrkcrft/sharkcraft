/**
 * `shrk gates` — the rule-authoring trust layer.
 *
 *   shrk gates list [--plane <p>]      # every data-defined rule, across every plane
 *   shrk gates coverage [--strict]     # what each rule MATCHED; flags every rule matching 0
 *   shrk gates explain <id>            # the concrete inputs one rule resolved
 *
 * Every rule engine in shrk is only as trustworthy as the author's ability to
 * see what a rule actually matched, and the dominant real-world failure is a
 * stale selector that silently matches nothing — a "pass" that checked zero
 * files. `gates coverage` is the detector: run it in CI and a rule quietly
 * dying becomes a failure in its own right.
 *
 * Distinct from `shrk gate` (singular), which RUNS the quality-gate pipeline.
 * This verb inspects the data-defined RULES themselves.
 */
import * as nodePath from 'node:path';
import type {
  IPolicyRule,
  IRegistrationIdiom,
  IRegistryDeclaration,
  IWiringRule,
} from '@shrkcrft/core';
import { explainWiring, inspectSource, scanRegistry } from '@shrkcrft/boundaries';
import { resolveProjectConfig } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import {
  collectGateRules,
  GATE_PLANES,
  type GatePlane,
  type IGateRuleView,
} from '../gates/gate-rule-view.ts';
import { buildGateCoverage } from '../gates/rule-coverage.ts';
import { buildGateEnvelope } from '../gates/gate-envelope.ts';
import { baselineExplainCommand } from './baseline.command.ts';
import { generatedExplainCommand } from './generated.command.ts';
import { renderPolicyExplain, runPolicyExplain } from './policy-lint.command.ts';
import { renderWiringExplain } from './wiring.command.ts';

const SCHEMA = 'sharkcraft.gates/v1';

interface IPrepared {
  readonly cwd: string;
  readonly rules: readonly IGateRuleView[];
  readonly excludeDirs: string[];
  readonly planeDiagnostics: readonly string[];
}

async function prepare(
  args: ParsedArgs,
): Promise<{ ok: true; value: IPrepared } | { ok: false; code: number }> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) {
    const msg = loaded.error.message;
    if (json) process.stdout.write(asJson({ schema: SCHEMA, error: msg }) + '\n');
    else process.stderr.write(`Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
    return { ok: false, code: ExitCode.UsageError };
  }
  const rel = nodePath.relative(cwd, loaded.value.sharkcraftDir).split(nodePath.sep).join('/');
  return {
    ok: true,
    value: {
      cwd,
      rules: collectGateRules(loaded.value.config),
      excludeDirs: rel && !rel.startsWith('..') ? [rel] : [],
      planeDiagnostics: loaded.value.planeDiagnostics,
    },
  };
}

/** Parse `--plane`, refusing an unknown value rather than silently matching nothing. */
function parsePlanes(args: ParsedArgs): { ok: true; planes?: Set<GatePlane> } | { ok: false } {
  const raw = flagString(args, 'plane');
  if (!raw) return { ok: true };
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !GATE_PLANES.includes(p as GatePlane));
  if (bad.length > 0) {
    process.stderr.write(`Unknown --plane "${bad.join(', ')}". Use ${GATE_PLANES.join(' | ')}.\n`);
    return { ok: false };
  }
  return { ok: true, planes: new Set(parts as GatePlane[]) };
}

function writeNoRules(json: boolean): number {
  if (json) {
    process.stdout.write(asJson({ schema: SCHEMA, rules: [], total: 0 }) + '\n');
    return ExitCode.NotVerified;
  }
  process.stdout.write(header('Gate rules'));
  process.stdout.write(
    '  No data-defined rules declared. These planes live in sharkcraft.config.ts:\n' +
      '    wiringRules[]        declared-here → registered-there completeness\n' +
      '    policyRules[]        forbidden content the compiler never sees\n' +
      '    registries[]         id inventories (`shrk registry <name> list`)\n' +
      '    registrationGraph[]  DI/registration idioms (`shrk wiring chain`)\n' +
      '    baselines[]          committed ledgers that must not silently drift\n' +
      '    generatedArtifacts[] generated files that must not be hand-edited\n',
  );
  return ExitCode.NotVerified;
}

export const gatesListCommand: ICommandHandler = {
  name: 'list',
  description: 'Every data-defined rule across every plane, with its severity and empty-match policy.',
  usage: 'shrk gates list [--plane wiring|policy|registry|registration|baseline|generated] [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const json = flagBool(args, 'json');
    const rules = planes.planes
      ? prep.value.rules.filter((r) => planes.planes!.has(r.plane))
      : prep.value.rules;
    if (rules.length === 0) return writeNoRules(json);

    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          total: rules.length,
          rules: rules.map((r) => ({
            id: r.id,
            plane: r.plane,
            description: r.description ?? null,
            severity: r.severity,
            failOnEmpty: r.failOnEmpty,
            selfTest: r.selfTest ?? null,
          })),
          diagnostics: prep.value.planeDiagnostics,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }

    process.stdout.write(header(`Gate rules (${rules.length})`));
    for (const plane of GATE_PLANES) {
      const inPlane = rules.filter((r) => r.plane === plane);
      if (inPlane.length === 0) continue;
      process.stdout.write(`\n${plane} (${inPlane.length})\n`);
      for (const r of inPlane) {
        const flags = [
          r.severity === 'warning' ? 'warning' : undefined,
          r.failOnEmpty ? 'failOnEmpty' : undefined,
          r.selfTest ? 'selfTest' : undefined,
        ].filter(Boolean);
        process.stdout.write(`  • ${r.id}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}\n`);
        if (r.description) process.stdout.write(`      ${r.description}\n`);
      }
    }
    for (const d of prep.value.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    process.stdout.write('\nRun `shrk gates coverage` to see what each one actually matches.\n');
    return ExitCode.VerifiedPass;
  },
};

export const gatesCoverageCommand: ICommandHandler = {
  name: 'coverage',
  description:
    'What every rule MATCHED against the live tree — the stale-selector detector. A rule matching 0 files/ids is a bug in the rule, never a pass. Also runs each rule\'s declared selfTest expectations.',
  usage: 'shrk gates coverage [--plane <p>] [--strict] [--json]',
  booleanFlags: new Set(['json', 'strict']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const json = flagBool(args, 'json');
    const rules = planes.planes
      ? prep.value.rules.filter((r) => planes.planes!.has(r.plane))
      : prep.value.rules;
    if (rules.length === 0) return writeNoRules(json);

    const report = buildGateCoverage(prep.value.cwd, rules, prep.value.excludeDirs);
    // A rule that matched nothing is NOT-VERIFIED (2) by default — it neither
    // passed nor failed, it never ran. `failOnEmpty` on the rule (or the global
    // --strict promotion) turns that into a hard failure.
    const hardFailures = report.rules.filter(
      (r) => r.status === 'error' || r.status === 'failed-expectation' || (r.status === 'empty' && r.failOnEmpty),
    );
    const softEmpty = report.rules.filter((r) => r.status === 'empty' && !r.failOnEmpty);
    const exit =
      hardFailures.length > 0
        ? ExitCode.Failure
        : softEmpty.length > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;

    if (json) {
      process.stdout.write(
        asJson({
          ...report,
          hardFailures: hardFailures.length,
          exitCode: exit,
          gate: buildGateEnvelope(
            'gates coverage',
            exit,
            report.rules.map((r) => ({
              id: r.id,
              type: r.plane,
              status:
                r.status === 'ok'
                  ? ('passed' as const)
                  : r.status === 'empty'
                    ? r.failOnEmpty
                      ? ('failed' as const)
                      : ('skipped' as const)
                    : r.status === 'error'
                      ? ('error' as const)
                      : ('failed' as const),
              severity: r.failOnEmpty ? ('error' as const) : ('warning' as const),
              counts: { files: r.filesMatched, units: r.unitsMatched },
              violations: r.expectationFailures.map((f) => ({ id: r.id, message: f })),
              ...(r.status === 'empty' ? { skipReason: `matched 0 ${r.unitLabel}` } : {}),
              ...(r.error ? { error: r.error } : {}),
            })),
          ),
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Gate-rule coverage'));
    process.stdout.write(kv('rules', String(report.total)) + '\n');
    process.stdout.write(
      kv('matched nothing', `${report.empty}${report.empty > 0 ? '  ← stale selector suspects' : ''}`) + '\n',
    );
    if (report.errored > 0) process.stdout.write(kv('misconfigured', String(report.errored)) + '\n');
    if (report.expectationFailures > 0) {
      process.stdout.write(kv('broken selfTest', String(report.expectationFailures)) + '\n');
    }
    process.stdout.write('\n');
    for (const r of report.rules) {
      const mark =
        r.status === 'ok' ? '✓' : r.status === 'empty' ? (r.failOnEmpty ? '✗' : '–') : '✗';
      process.stdout.write(
        `  ${mark} [${r.plane}] ${r.id}  —  ${r.unitsMatched} ${r.unitLabel} across ${r.filesMatched} file(s)\n`,
      );
      if (r.sampleIds.length > 0) {
        process.stdout.write(`      e.g. ${r.sampleIds.join(', ')}\n`);
      }
      if (r.status === 'empty') {
        process.stdout.write(
          `      ${r.failOnEmpty ? 'FAILED' : 'SKIPPED'} — matched nothing; the selector is probably stale\n`,
        );
      }
      if (r.error) process.stdout.write(`      ! ${r.error}\n`);
      for (const f of r.expectationFailures) process.stdout.write(`      ! selfTest: ${f}\n`);
    }
    if (exit === ExitCode.VerifiedPass) {
      process.stdout.write('\nEvery rule is connected to something. ✓\n');
    } else if (exit === ExitCode.NotVerified) {
      process.stdout.write(
        `\n${softEmpty.length} rule(s) matched nothing — NOT a pass. Fix the selector, or set \`failOnEmpty: true\`\n` +
          'once the rule is known to have real subjects (then this becomes a hard failure).\n',
      );
    }
    return exit;
  },
};

/** Render a registry inventory as the trust-layer explain view. */
function explainRegistry(cwd: string, decl: IRegistryDeclaration, excludeDirs: readonly string[]): void {
  const inventory = scanRegistry(cwd, decl, { excludeDirs });
  const insp = inspectSource(cwd, decl.source, excludeDirs);
  process.stdout.write(kv('files scanned', String(insp.filesScanned)) + '\n');
  process.stdout.write(kv('ids', String(inventory.entries.length)) + '\n');
  for (const e of inventory.entries.slice(0, 60)) {
    process.stdout.write(`  • ${e.id}  (${e.sites.map((s) => `${s.file}:${s.line}`).join(', ')})\n`);
  }
  if (inventory.entries.length > 60) {
    process.stdout.write(`  … (${inventory.entries.length - 60} more)\n`);
  }
  for (const d of inventory.diagnostics) process.stdout.write(`  ! ${d}\n`);
}

/** Render the three sides of a registration idiom. */
function explainRegistration(cwd: string, idiom: IRegistrationIdiom, excludeDirs: readonly string[]): void {
  for (const [label, source] of [
    ['declared', idiom.declared],
    ['provided', idiom.provided],
    ['consumed', idiom.consumed],
  ] as const) {
    const insp = inspectSource(cwd, source, excludeDirs);
    process.stdout.write(
      kv(label, `${insp.ids.length} token(s) across ${insp.filesScanned} file(s)`) + '\n',
    );
    if (insp.error) process.stdout.write(`      ! ${insp.error}\n`);
    for (const s of insp.sites.slice(0, 20)) {
      process.stdout.write(`      ${s.token}  (${s.file}:${s.line})\n`);
    }
    if (insp.sites.length > 20) process.stdout.write(`      … (${insp.sites.length - 20} more)\n`);
  }
  process.stdout.write(
    `\n  Query one token's chain with \`shrk wiring chain <token>\`.\n`,
  );
}

export const gatesExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'The universal introspection: for a rule of ANY plane, print the concrete inputs it resolved — files matched, ids extracted with file:line, and the computed diff.',
  usage: 'shrk gates explain <id> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk gates explain <id> [--json]\n');
      return ExitCode.UsageError;
    }
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const matches = prep.value.rules.filter((r) => r.id === id);
    if (matches.length === 0) {
      process.stderr.write(
        `No gate rule "${id}". Run \`shrk gates list\` to see the ${prep.value.rules.length} declared rule(s).\n`,
      );
      return ExitCode.UsageError;
    }
    // An id may legitimately exist on two planes (a wiring rule and a registry
    // can share a name); `--plane` disambiguates instead of guessing.
    const planes = parsePlanes(args);
    if (!planes.ok) return ExitCode.UsageError;
    const candidates = planes.planes
      ? matches.filter((r) => planes.planes!.has(r.plane))
      : matches;
    if (candidates.length > 1) {
      process.stderr.write(
        `"${id}" exists on ${candidates.length} planes (${candidates.map((c) => c.plane).join(', ')}). ` +
          'Disambiguate with --plane <p>.\n',
      );
      return ExitCode.UsageError;
    }
    const view = candidates[0];
    if (!view) {
      process.stderr.write(`No gate rule "${id}" on the requested plane.\n`);
      return ExitCode.UsageError;
    }
    const json = flagBool(args, 'json');

    // The two shell-executing planes own their explain output (and their trust
    // rules), so delegate rather than re-implement — one behaviour, one place.
    if (view.plane === 'baseline') {
      args.flags.set('id', view.id);
      return baselineExplainCommand.run(args);
    }
    if (view.plane === 'generated') {
      args.flags.set('id', view.id);
      return generatedExplainCommand.run(args);
    }

    if (view.plane === 'wiring') {
      const explain = explainWiring(prep.value.cwd, view.raw as IWiringRule, {
        excludeDirs: prep.value.excludeDirs,
      });
      renderWiringExplain(explain, json);
      return ExitCode.VerifiedPass;
    }

    if (view.plane === 'policy') {
      const explain = runPolicyExplain(prep.value.cwd, view.raw as IPolicyRule, prep.value.excludeDirs);
      renderPolicyExplain(explain, json);
      return ExitCode.VerifiedPass;
    }

    if (json) {
      const source =
        view.plane === 'registry'
          ? (view.raw as IRegistryDeclaration).source
          : (view.raw as IRegistrationIdiom).declared;
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.gates-explain/v1',
          id: view.id,
          plane: view.plane,
          ...inspectSource(prep.value.cwd, source, prep.value.excludeDirs),
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }

    process.stdout.write(header(`${view.plane} rule: ${view.id}`));
    if (view.description) process.stdout.write(`  ${view.description}\n`);
    if (view.plane === 'registry') {
      explainRegistry(prep.value.cwd, view.raw as IRegistryDeclaration, prep.value.excludeDirs);
    } else {
      explainRegistration(prep.value.cwd, view.raw as IRegistrationIdiom, prep.value.excludeDirs);
    }
    return ExitCode.VerifiedPass;
  },
};

/**
 * Try to explain `id` as a data-defined rule on ANY plane.
 *
 * Returns the exit code when the id resolves to exactly one declared rule, or
 * `undefined` when it is not a rule id at all — which lets `shrk explain` keep
 * its original topic-search behaviour for everything else. This is the D2
 * unification: a user holding a rule id no longer has to know which plane owns
 * it, and no existing invocation changes meaning.
 */
export async function tryExplainGateRule(
  args: ParsedArgs,
  id: string,
): Promise<number | undefined> {
  const cwd = resolveCwd(args);
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return undefined;
  const rules = collectGateRules(loaded.value.config);
  if (!rules.some((r) => r.id === id)) return undefined;
  const forwarded: ParsedArgs = { ...args, positional: [id] };
  return gatesExplainCommand.run(forwarded);
}

export const gatesCommand: ICommandHandler = {
  name: 'gates',
  description:
    'Rule-authoring trust layer: list every data-defined rule, show what each one MATCHED (the stale-selector detector), and explain any one of them. Read-only. Not `shrk gate`, which runs the quality-gate pipeline.',
  usage: 'shrk gates list | coverage [--strict] | explain <id>',
  booleanFlags: new Set(['json', 'strict']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    process.stderr.write(
      (sub ? `Unknown subcommand "${sub}". ` : '') +
        'Usage: shrk gates list | coverage [--plane <p>] [--strict] | explain <id>\n' +
        '(`shrk gate`, singular, runs the quality-gate pipeline — a different verb.)\n',
    );
    return ExitCode.UsageError;
  },
};
