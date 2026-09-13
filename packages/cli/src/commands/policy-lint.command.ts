import * as nodePath from 'node:path';
import { formatEmptyRuleAdvice, type IPolicyRule, type IVerdictCoverage, type PolicySurface } from '@shrkcrft/core';
import {
  planeScanExcludeDirs,
  runPolicyLint,
  type IPolicyFinding,
  type IPolicyReport,
  type IPolicySuppression,
} from '@shrkcrft/boundaries';
import { classifyChangedScope, resolveChangedFiles, resolveProjectConfig } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ExitCode } from '../exit-codes.ts';
import { buildGateEnvelope } from '../gates/gate-envelope.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { acceptedEmptyNote } from '../gates/accepted-empty-note.ts';
import { emptyRuleAdviceLines } from '../gates/empty-rule-advice-lines.ts';
import { qualifyCleanForUnits } from '../gates/qualify-clean-for-units.ts';
import { unitStateNotes } from '../gates/unit-state-notes.ts';
import { planeVerdictForExit } from '../gates/plane-verdict.ts';
import { seamRejectedRules } from '../gates/seam-rejected-rules.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const VALID_SURFACES: ReadonlySet<string> = new Set(['template', 'style', 'ts']);

/**
 * What one policy rule examined — the ENGINE's record
 * (`IPolicyRuleResult.coverage`, @shrkcrft/boundaries), read here and never
 * recomputed, so `policy-lint`, the aggregate (`gates check`, `quality`), `shrk
 * gate` and `finish` all report one scope for one rule. A policy rule examines
 * every content unit its globs matched; one that scanned nothing (or could not
 * run) examined nothing.
 */
export function policyRuleCoverage(r: { readonly coverage: IVerdictCoverage }): IVerdictCoverage {
  return r.coverage;
}


export const POLICY_EXPLAIN_SCHEMA = 'sharkcraft.policy-explain/v1' as const;

/** What ONE policy rule resolved to against the live tree. */
export interface IPolicyExplain {
  readonly schema: typeof POLICY_EXPLAIN_SCHEMA;
  readonly ruleId: string;
  readonly description?: string;
  readonly surface: PolicySurface;
  readonly severity: 'error' | 'warning';
  readonly pattern: string;
  readonly scan: string;
  /** Content units the rule scanned (files, or inline-template bodies). */
  readonly unitsScanned: number;
  readonly status: string;
  /** Every hit that COUNTED, with file:line. */
  readonly findings: readonly IPolicyFinding[];
  /** Every hit an exemption or the scan zone dropped, and which one applied. */
  readonly suppressed: readonly IPolicySuppression[];
  readonly exemptFiles: readonly string[];
  readonly exemptLines?: string;
  readonly diagnostics: readonly string[];
  /** Why the rule scanned nothing, when it did. */
  readonly skipReason?: string;
  /**
   * The rule's non-live `files` units as the engine settled them (round 13
   * review) — the explain view prints a dead unit and a went-live marker
   * through THE shared unit-state renderer, as `policy-lint` does.
   */
  readonly unitLiveness?: IPolicyReport['rules'][number]['unitLiveness'];
}

/**
 * Dry-run ONE policy rule and return everything it saw — including the hits an
 * exemption swallowed.
 *
 * Showing suppressed hits is the point: an exemption that silently deletes a
 * finding is indistinguishable from a stale glob, so both the kept and the
 * dropped hits are reported, each labelled with the exemption that applied.
 */
export function runPolicyExplain(
  cwd: string,
  rule: IPolicyRule,
  excludeDirs: readonly string[],
): IPolicyExplain {
  const report: IPolicyReport = runPolicyLint(cwd, [rule], { excludeDirs });
  const result = report.rules[0];
  const skip = report.skipped[0];
  return {
    schema: POLICY_EXPLAIN_SCHEMA,
    ruleId: rule.id,
    ...(rule.description ? { description: rule.description } : {}),
    surface: rule.surface,
    severity: rule.severity ?? 'error',
    pattern: rule.pattern,
    scan: rule.scan ?? 'all',
    unitsScanned: result?.unitsScanned ?? 0,
    status: result?.status ?? 'error',
    findings: report.findings,
    suppressed: report.suppressed,
    exemptFiles: rule.exemptFiles ?? [],
    ...(rule.exemptLines ? { exemptLines: rule.exemptLines } : {}),
    diagnostics: report.diagnostics,
    ...(skip ? { skipReason: skip.reason } : {}),
    ...(result?.unitLiveness !== undefined ? { unitLiveness: result.unitLiveness } : {}),
  };
}

/** Render an {@link IPolicyExplain}. Always returns 0 — explain is informational. */
export function renderPolicyExplain(explain: IPolicyExplain, wantJson: boolean): number {
  if (wantJson) {
    process.stdout.write(asJson(explain) + '\n');
    return 0;
  }
  process.stdout.write(header(`Policy explain: ${explain.ruleId} (${explain.surface})`));
  if (explain.description) process.stdout.write(`  ${explain.description}\n`);
  process.stdout.write(kv('pattern', `/${explain.pattern}/`) + '\n');
  process.stdout.write(kv('scan zone', explain.scan) + '\n');
  process.stdout.write(kv('units scanned', String(explain.unitsScanned)) + '\n');
  process.stdout.write(kv('status', explain.status) + '\n');
  if (explain.exemptFiles.length > 0) {
    process.stdout.write(kv('exemptFiles', explain.exemptFiles.join(', ')) + '\n');
  }
  if (explain.exemptLines) process.stdout.write(kv('exemptLines', explain.exemptLines) + '\n');

  process.stdout.write(`\nHits that COUNT (${explain.findings.length}):\n`);
  for (const f of explain.findings.slice(0, 60)) {
    process.stdout.write(
      `  ✗ ${f.match}  (${f.file}:${f.line})${f.inlineTemplate ? ' [inline template]' : ''}\n`,
    );
  }
  if (explain.findings.length > 60) {
    process.stdout.write(`  … (${explain.findings.length - 60} more)\n`);
  }
  if (explain.suppressed.length > 0) {
    process.stdout.write(`\nHits an exemption DROPPED (${explain.suppressed.length}):\n`);
    for (const s of explain.suppressed.slice(0, 60)) {
      process.stdout.write(`  – ${s.match}  (${s.file}:${s.line})  via ${s.via}\n`);
    }
    if (explain.suppressed.length > 60) {
      process.stdout.write(`  … (${explain.suppressed.length - 60} more)\n`);
    }
  }
  if (explain.skipReason) {
    process.stdout.write(
      `\n! SKIPPED — ${explain.skipReason}. A rule that scans nothing is a bug in the rule,\n` +
        `  not a pass. ${formatEmptyRuleAdvice({ fails: explain.status === 'failed' })}.\n`,
    );
  }
  // THE shared unit-state block (round 13 review): a dead `files` glob, a
  // LOCAL marker whose target appeared and a pack marker (INFO) — as
  // `policy-lint` prints them; explain said `status passed` over a went-live one.
  process.stdout.write(
    unitStateNotes(
      [
        {
          id: explain.ruleId,
          ...(explain.unitLiveness !== undefined ? { unitLiveness: explain.unitLiveness } : {}),
          reportedEmpty: explain.skipReason !== undefined,
        },
      ],
      // An explain view names every unit state — the intended-empty ones too
      // (round 13, K6), as the registry / registration explain views do.
      { intendedEmpty: true },
    ).text,
  );
  for (const d of explain.diagnostics) process.stdout.write(`  ! ${d}\n`);
  return 0;
}


export const policyLintExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Dry-run ONE policyRule and print every hit with file:line — INCLUDING the hits an exemption or the scan zone dropped, each labelled with which one applied.',
  usage: 'shrk policy-lint explain <ruleId> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk policy-lint explain <ruleId> [--json]\n');
      return ExitCode.UsageError;
    }
    const cwd = resolveCwd(args);
    const loaded = await resolveProjectConfig(cwd);
    if (!loaded.ok) {
      process.stderr.write(`Could not load config: ${loaded.error.message}\n`);
      return ExitCode.UsageError;
    }
    const rules = loaded.value.config.policyRules ?? [];
    const rule = rules.find((r) => r.id === id);
    if (!rule) {
      process.stderr.write(
        `No policy rule "${id}". Configured: ${rules.map((r) => r.id).join(', ') || '(none)'}\n`,
      );
      return ExitCode.UsageError;
    }
    const excludeDirs = planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir);
    return renderPolicyExplain(runPolicyExplain(cwd, rule, excludeDirs), flagBool(args, 'json'));
  },
};

export const policyLintCommand: ICommandHandler = {
  name: 'policy-lint',
  // Flag-driven; `explain` is a trie child. A bare token used to be ignored.
  positionals: PositionalMode.None,
  description:
    'Lint template/markup, stylesheet, and AOT-invisible TS surfaces against data-defined policyRules[] (e.g. flag raw markup when a primitive exists). Sees `.html` files AND inline `template:` strings — surfaces tsc/AOT cannot. Deterministic; no AI.',
  usage:
    'shrk [--cwd <dir>] policy-lint [--surface template|style|ts] [--changed-only] [--new-only] [--since <ref>] [--only <ids>] [--allow-empty] [--json]\n         (--changed-only SCANS just the changed files; --new-only scans the whole tree but shows only findings the change introduced, hiding pre-existing baseline debt)',
  booleanFlags: new Set(['json', 'changed-only', 'new-only', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const changedOnly = flagBool(args, 'changed-only');
    // --new-only: scan the WHOLE tree, then show only findings the current change
    // introduced (baseline debt is bucketed as hidden, not printed) — the
    // finding-level complement to --changed-only's file-level scoping.
    const newOnly = flagBool(args, 'new-only');
    const since = flagString(args, 'since');
    const only = flagString(args, 'only');

    const surfaceRaw = flagString(args, 'surface');
    let surfaces: PolicySurface[] | undefined;
    if (surfaceRaw) {
      const parts = surfaceRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = parts.filter((s) => !VALID_SURFACES.has(s));
      if (bad.length > 0) {
        process.stderr.write(`Unknown --surface "${bad.join(', ')}". Use template | style | ts.\n`);
        return ExitCode.UsageError;
      }
      surfaces = parts as PolicySurface[];
    }

    // Distinguish invalid config from valid-with-no-rules (no silent fail-open).
    const loaded = await resolveProjectConfig(cwd);
    if (!loaded.ok) {
      const msg = loaded.error.message;
      if (wantJson) {
        process.stdout.write(
          asJson({ schema: 'sharkcraft.policy-lint/v1', error: msg, rules: [], findings: [], diagnostics: [msg], evaluated: 0, verdict: 'errors' }) + '\n',
        );
        return ExitCode.UsageError;
      }
      process.stdout.write(header('Policy lint'));
      process.stdout.write(`  ✗ Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
      // A broken config is a USAGE error (3), not "violations found" (1).
      return ExitCode.UsageError;
    }
    const rules = loaded.value.config.policyRules ?? [];
    const planeDiagnostics = loaded.value.planeDiagnostics;
    // A pack policy rule the merge seam rejected is a configured rule that did
    // NOT run — an errored row, exit 1 (round 12 review, R12-X1). It used to be
    // an advisory diagnostic under "No policy violations ✓".
    const rejectedAll = seamRejectedRules(loaded.value, ['policy']);

    if (rules.length === 0 && rejectedAll.length === 0) {
      // Nothing declared is NOT a pass — the request covered zero rules, so it
      // proved nothing: `2`, unless the caller accepts the empty set explicitly.
      const emptyEnv = buildGateEnvelope('policy-lint', ExitCode.VerifiedPass, [], {
        unit: 'policy rules',
        expected: 0,
        examined: 0,
        reason: 'no policyRules[] declared',
        ...allowEmptyValve(args, 0),
      });
      if (wantJson) {
        process.stdout.write(
          asJson({
            schema: 'sharkcraft.policy-lint/v1',
            rules: [],
            findings: [],
            diagnostics: [],
            evaluated: 0,
            verdict: emptyEnv.exit === ExitCode.VerifiedPass ? 'pass' : 'not-verified',
            exitCode: emptyEnv.exit,
            gate: emptyEnv,
          }) + '\n',
        );
        return emptyEnv.exit;
      }
      process.stdout.write(header('Policy lint'));
      process.stdout.write(
        '  No policy rules configured. Declare `policyRules[]` in sharkcraft.config.ts to lint\n' +
          '  templates / styles / AOT-invisible TS shapes (see docs/policy-lint.md).\n',
      );
      process.stdout.write(`\n${verdictLine(emptyEnv, 'Nothing declared — accepted.')}\n`);
      if (emptyEnv.exit !== ExitCode.VerifiedPass) {
        process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty rule set explicitly.\n`);
      }
      return emptyEnv.exit;
    }

    // A typo'd --only id must not silently select nothing and report green. A
    // rejected rule's id is a declared one: `--only` selects its errored row.
    const onlyIds = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    if (onlyIds) {
      const known = new Set([...rules.map((r) => r.id), ...rejectedAll.map((r) => r.id)]);
      const unknown = onlyIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        process.stderr.write(
          `Unknown --only rule id(s): ${unknown.join(', ')}. Configured: ${[...known].join(', ') || '(none)'}\n`,
        );
        return ExitCode.UsageError;
      }
    }
    const rejected = onlyIds ? rejectedAll.filter((r) => onlyIds.includes(r.id)) : rejectedAll;

    let changedFiles: readonly string[] | undefined;
    if (changedOnly || newOnly || since) {
      changedFiles = resolveChangedFiles({
        projectRoot: cwd,
        ...(since ? { since } : {}),
        ...((changedOnly || newOnly) && !since ? { includeWorktree: true } : {}),
      }).files;
    }

    // Don't lint SharkCraft's own asset/config dir by default (its .ts files
    // hold the rule definitions themselves, which can self-match).
    // THE plane scan scope — the same authority `gates check`, `quality`,
    // `finish` and `shrk gate` read for this rule.
    const excludeDirs = planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir);

    const reportRaw = runPolicyLint(cwd, rules, {
      ...(surfaces ? { surfaces } : {}),
      // --changed-only narrows the SCAN; --new-only scans the full tree so it can
      // still diff findings (it filters after, below).
      ...((changedOnly || since) && !newOnly ? { changedOnly: true, changedFiles: changedFiles ?? [] } : {}),
      ...(only ? { only: only.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(excludeDirs.length > 0 ? { excludeDirs } : {}),
    });
    // Surface pack-plane merge notes (missing/invalid pack policy files, dropped
    // collisions) in the same diagnostics array the engine already emits.
    let report =
      planeDiagnostics.length > 0
        ? { ...reportRaw, diagnostics: [...reportRaw.diagnostics, ...planeDiagnostics] }
        : reportRaw;

    // --new-only: partition the full-tree findings against the changed set and
    // keep only the ones the current change introduced; pre-existing baseline
    // debt is bucketed as hidden (reported as a count, never printed as green).
    let hiddenBaseline = 0;
    if (newOnly) {
      const keyOf = (f: IPolicyFinding): string => `${f.ruleId}|${f.file}:${f.line}|${f.match}`;
      const classification = classifyChangedScope({
        projectRoot: cwd,
        current: report.findings.map((f) => ({
          key: keyOf(f),
          file: f.file,
          code: f.ruleId,
          severity: f.severity,
          message: f.message,
        })),
        changedFiles: changedFiles ?? [],
      });
      const newKeys = new Set(classification.newIssues.map((n) => n.key));
      const newFindings = report.findings.filter((f) => newKeys.has(keyOf(f)));
      hiddenBaseline = report.findings.length - newFindings.length;
      const verdict = newFindings.some((f) => f.severity === 'error')
        ? 'errors'
        : newFindings.length > 0
          ? report.verdict
          : 'pass';
      report = { ...report, findings: newFindings, verdict };
    }

    // Settle first, render second: ONE proposed exit for text and JSON (the two
    // used to disagree when a rule skipped next to a warning finding), settled
    // against what each rule actually scanned.
    //
    // An EMPTY selection (no rule's globs intersect the changeset, or --only
    // picked nothing) proposes 0 and lets the run coverage decide: expected 0
    // is a shortfall (2) unless --allow-empty accepted it. Proposing 2 here
    // would make the valve unreachable on exactly the case it exists for.
    const proposed =
      report.verdict === 'errors' || report.skipped.some((sk) => sk.failed) || rejected.length > 0
        ? ExitCode.Failure
        : (report.evaluated === 0 && report.rules.length > 0) || report.skipped.length > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;
    const unexaminedRules = [
      ...report.skipped.map((s) => s.ruleId),
      ...report.rules.filter((r) => r.status === 'error').map((r) => r.ruleId),
      ...rejected.map((r) => r.id),
    ];
    const inScope = report.rules.length + rejected.length;
    const env = buildGateEnvelope(
      'policy-lint',
      proposed,
      [...report.rules.map((r) => {
        const skip = report.skipped.find((s) => s.ruleId === r.ruleId);
        return {
          id: r.ruleId,
          type: 'policy' as const,
          status: r.status,
          severity: r.severity,
          counts: {
            units: r.unitsScanned,
            findings: r.findingCount,
            suppressed: r.suppressedCount,
          },
          violations: report.findings
            .filter((f) => f.ruleId === r.ruleId)
            .map((f) => ({
              id: f.match,
              file: f.file,
              line: f.line,
              message: f.message,
              ...(f.suggest ? { hint: f.suggest } : {}),
            })),
          ...(skip ? { skipReason: skip.reason } : {}),
          ...(r.error ? { error: r.error } : {}),
          coverage: policyRuleCoverage(r),
          // The rule's `expectEmpty` acceptance and unit lines (round 13),
          // folded into the envelope's one settle — the accepted line comes from it.
          ...(r.unitAcceptance !== undefined ? { unitAcceptance: r.unitAcceptance } : {}),
          ...(r.units !== undefined ? { units: r.units } : {}),
        };
      }), ...rejected],
      {
        unit: 'policy rules',
        expected: inScope,
        examined: inScope - unexaminedRules.length,
        ...(unexaminedRules.length > 0
          ? { unexamined: unexaminedRules, reason: 'scanned nothing or could not run' }
          : {}),
        ...(inScope === 0
          ? {
              reason:
                changedOnly || since
                  ? "no rule's globs match content in the changeset (a deleted file, or one with nothing on the rule's surface, puts nothing in scope)"
                  : 'no rule selected',
            }
          : {}),
        ...allowEmptyValve(args, inScope),
      },
    );
    const exit = env.exit;

    if (wantJson) {
      process.stdout.write(
        asJson({
          ...report,
          // Pack policy rules the merge seam refused — errored rows in `gate.rules`.
          rejected: rejected.map((r) => ({ id: r.id, error: r.error ?? null })),
          ...(newOnly ? { newOnly: true, hiddenBaseline } : {}),
          // The plane verdict derives from the SETTLED exit — never `warnings`
          // / `pass` next to exitCode 2.
          verdict: planeVerdictForExit(exit, report.verdict),
          exitCode: exit,
          gate: env,
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Policy lint'));
    if (rejected.length > 0) {
      process.stdout.write(
        `  ✗ ${rejected.length} pack policy rule(s) failed validation at the pack-plane merge seam — NOT evaluated, FAILED:\n`,
      );
      for (const r of rejected) process.stdout.write(`    ✗ ${r.id} — ${r.error ?? 'failed validation'}\n`);
      process.stdout.write('    `shrk packs contributions` names every rejected entry.\n');
    }
    // `evaluated` counts rules that actually scanned ≥1 file. When 0 rules
    // evaluated, say so loudly — "scanned nothing" must never read as the green
    // "no policy violations" pass. `2` (or `1` when a `failOnEmpty` rule
    // promotes it), unless --allow-empty accepted an empty scope explicitly.
    if (report.evaluated === 0) {
      process.stdout.write(
        `  ! Nothing evaluated — ${rules.length} rule(s) configured, ${report.rules.length} in scope, none matched files` +
          (changedOnly || since ? ' (changed-only).\n' : '.\n'),
      );
      for (const sk of report.skipped) {
        process.stdout.write(`    – ${sk.ruleId}: ${sk.reason}${sk.failed ? '  (failOnEmpty → FAILED)' : ''}\n`);
      }
      // THE empty-rule advice (round 13) — this branch returned before the only
      // advice site, so a rule that matched nothing got none.
      for (const a of emptyRuleAdviceLines(report.skipped.map((sk) => ({ fails: sk.failed === true })))) {
        process.stdout.write(`    ${a}.\n`);
      }
      const line = verdictLine(env, 'Nothing in scope — accepted.');
      if (line) process.stdout.write(`\n${line}\n`);
      if (report.rules.length === 0 && exit === ExitCode.NotVerified) {
        process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty changeset explicitly.\n`);
      }
      return exit;
    }
    // Round 13 (K6): a rule accepted as intended-empty examined 0 files, so the
    // printed count leaves it out and names it apart (`IPolicyReport.evaluated`
    // keeps counting it only so the `evaluated === 0` guard above never reads
    // an accepted plan as "nothing ran").
    const acceptedNote = acceptedEmptyNote(report.acceptedEmpty);
    process.stdout.write(
      kv('rules evaluated', `${report.evaluated - report.acceptedEmpty} of ${inScope}${acceptedNote}`) + '\n',
    );
    const errors = report.findings.filter((f) => f.severity === 'error').length;
    const warnings = report.findings.filter((f) => f.severity === 'warning').length;
    process.stdout.write(kv('findings', `${errors} error(s), ${warnings} warning(s)`) + '\n');
    if (report.suppressed.length > 0) {
      process.stdout.write(
        kv('suppressed', `${report.suppressed.length} hit(s) dropped by an exemption — see \`policy-lint explain <id>\``) + '\n',
      );
    }
    for (const sk of report.skipped) {
      process.stdout.write(
        `  ${sk.failed ? '✗' : '–'} ${sk.ruleId} ${sk.failed ? 'FAILED' : 'SKIPPED'} — ${sk.reason}\n`,
      );
    }
    if (newOnly) {
      process.stdout.write(
        kv('scope', `new-only (${hiddenBaseline} pre-existing finding(s) hidden — run without --new-only to see all)`) + '\n',
      );
    }
    if (report.diagnostics.length > 0) {
      process.stdout.write('\nMisconfigured rules:\n');
      for (const d of report.diagnostics) process.stdout.write(`  ! ${d}\n`);
    }
    // THE shared unit-state block (round 13, K2): a dead `files` glob of a
    // rule that still matched, and a LOCAL expectEmpty marker whose target
    // appeared, withhold the ✓ (exit unchanged); a pack marker is INFO.
    const unitNotes = unitStateNotes(
      report.rules.map((r) => ({
        id: r.ruleId,
        ...(r.unitLiveness !== undefined ? { unitLiveness: r.unitLiveness } : {}),
        reportedEmpty: report.skipped.some((s) => s.ruleId === r.ruleId),
      })),
    );
    process.stdout.write(unitNotes.text);
    if (report.skipped.length > 0) {
      // THE empty-rule advice (round 13) — one sentence per REAL `fails`
      // value, from the shared renderer: a soft skip was told nothing.
      process.stdout.write('\nA rule that matched nothing is a bug in the rule, not a pass.\n');
      for (const a of emptyRuleAdviceLines(report.skipped.map((sk) => ({ fails: sk.failed === true })))) {
        process.stdout.write(`  ${a}.\n`);
      }
    }
    if (report.skipped.some((sk) => sk.failed)) {
      const line = verdictLine(env, '');
      if (line) process.stdout.write(`${line}\n`);
      return exit;
    }
    // A non-failing skip still means "partially verified" — never a green 0.
    if (report.skipped.length > 0 && report.findings.length === 0) {
      const line = verdictLine(
        env,
        '',
        `${report.skipped.length} rule(s) scanned nothing — partially verified, not a full green.`,
      );
      if (line) process.stdout.write(`\n${line}\n`);
      return exit;
    }
    if (report.findings.length === 0 && report.diagnostics.length === 0) {
      const line = verdictLine(
        env,
        qualifyCleanForUnits(
          newOnly
            ? `No NEW policy violations from this change${hiddenBaseline > 0 ? ` (${hiddenBaseline} pre-existing hidden)` : ''}. ✓`
            : 'No policy violations on the scanned surfaces. ✓',
          unitNotes,
        ),
      );
      if (line) process.stdout.write(`\n${line}\n`);
      return exit;
    }
    // Group findings by rule.
    const byRule = new Map<string, IPolicyFinding[]>();
    for (const f of report.findings) {
      const arr = byRule.get(f.ruleId) ?? [];
      arr.push(f);
      byRule.set(f.ruleId, arr);
    }
    for (const r of report.rules) {
      const fs = byRule.get(r.ruleId);
      if (!fs || fs.length === 0) continue;
      process.stdout.write(`\n[${r.severity}] ${r.ruleId} (${r.surface}) — ${fs[0]!.message}\n`);
      for (const f of fs.slice(0, 50)) {
        const tag = f.inlineTemplate ? ' [inline template]' : '';
        process.stdout.write(`    • ${f.match}  (${f.file}:${f.line})${tag}\n`);
      }
      if (fs.length > 50) process.stdout.write(`    … (${fs.length - 50} more)\n`);
      const suggest = fs.find((f) => f.suggest)?.suggest;
      if (suggest) process.stdout.write(`    → ${suggest}\n`);
    }
    // The final line and the exit come from the SETTLED verdict — the same
    // `exit` the JSON returns. A warning finding next to a rule that scanned
    // nothing used to exit 0 here (no verdict line) while --json said 2.
    const tail = verdictLine(
      env,
      warnings > 0
        ? `No blocking policy violations — ${warnings} warning(s) reported above.`
        : 'No policy violations on the scanned surfaces (see the diagnostics above).',
      report.skipped.length > 0
        ? `${report.skipped.length} rule(s) scanned nothing — partially verified, not a full green.`
        : undefined,
    );
    if (tail) process.stdout.write(`\n${tail}\n`);
    return exit;
  },
};
