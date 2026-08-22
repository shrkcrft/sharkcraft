import * as nodePath from 'node:path';
import type { IPolicyRule, PolicySurface } from '@shrkcrft/core';
import {
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
import { asJson, header, kv } from '../output/format-output.ts';

const VALID_SURFACES: ReadonlySet<string> = new Set(['template', 'style', 'ts']);


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
        '  not a pass. Fix the glob, or set `failOnEmpty: true` to make this a hard failure.\n',
    );
  }
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
      return 2;
    }
    const cwd = resolveCwd(args);
    const loaded = await resolveProjectConfig(cwd);
    if (!loaded.ok) {
      process.stderr.write(`Could not load config: ${loaded.error.message}\n`);
      return 2;
    }
    const rules = loaded.value.config.policyRules ?? [];
    const rule = rules.find((r) => r.id === id);
    if (!rule) {
      process.stderr.write(
        `No policy rule "${id}". Configured: ${rules.map((r) => r.id).join(', ') || '(none)'}\n`,
      );
      return 2;
    }
    const rel = nodePath.relative(cwd, loaded.value.sharkcraftDir).split(nodePath.sep).join('/');
    const excludeDirs = rel && !rel.startsWith('..') ? [rel] : [];
    return renderPolicyExplain(runPolicyExplain(cwd, rule, excludeDirs), flagBool(args, 'json'));
  },
};

export const policyLintCommand: ICommandHandler = {
  name: 'policy-lint',
  description:
    'Lint template/markup, stylesheet, and AOT-invisible TS surfaces against data-defined policyRules[] (e.g. flag raw markup when a primitive exists). Sees `.html` files AND inline `template:` strings — surfaces tsc/AOT cannot. Deterministic; no AI.',
  usage:
    'shrk [--cwd <dir>] policy-lint [--surface template|style|ts] [--changed-only] [--new-only] [--since <ref>] [--only <ids>] [--json]\n         (--changed-only SCANS just the changed files; --new-only scans the whole tree but shows only findings the change introduced, hiding pre-existing baseline debt)',
  booleanFlags: new Set(['json', 'changed-only', 'new-only']),
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
        return 2;
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
        return 1;
      }
      process.stdout.write(header('Policy lint'));
      process.stdout.write(`  ✗ Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
      return 1;
    }
    const rules = loaded.value.config.policyRules ?? [];
    const planeDiagnostics = loaded.value.planeDiagnostics;

    if (rules.length === 0) {
      if (wantJson) {
        process.stdout.write(
          asJson({ schema: 'sharkcraft.policy-lint/v1', rules: [], findings: [], diagnostics: [], evaluated: 0, verdict: 'pass' }) + '\n',
        );
        return 0;
      }
      process.stdout.write(header('Policy lint'));
      process.stdout.write(
        '  No policy rules configured. Declare `policyRules[]` in sharkcraft.config.ts to lint\n' +
          '  templates / styles / AOT-invisible TS shapes (see docs/policy-lint.md).\n',
      );
      return 0;
    }

    // A typo'd --only id must not silently select nothing and report green.
    if (only) {
      const requested = only.split(',').map((s) => s.trim()).filter(Boolean);
      const known = new Set(rules.map((r) => r.id));
      const unknown = requested.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        process.stderr.write(
          `Unknown --only rule id(s): ${unknown.join(', ')}. Configured: ${[...known].join(', ') || '(none)'}\n`,
        );
        return 2;
      }
    }

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
    const sharkcraftRel = nodePath.relative(cwd, loaded.value.sharkcraftDir).split(nodePath.sep).join('/');
    const excludeDirs = sharkcraftRel && !sharkcraftRel.startsWith('..') ? [sharkcraftRel] : [];

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

    if (wantJson) {
      process.stdout.write(asJson({ ...report, ...(newOnly ? { newOnly: true, hiddenBaseline } : {}) }) + '\n');
      return report.verdict === 'errors' ? 1 : 0;
    }

    process.stdout.write(header('Policy lint'));
    // `evaluated` counts rules that actually scanned ≥1 file. When 0 rules
    // evaluated but rules ARE configured, say so loudly — "scanned nothing" must
    // never read as the green "no policy violations" pass.
    if (report.evaluated === 0) {
      process.stdout.write(
        `  ! Nothing evaluated — ${report.rules.length} rule(s) configured but none matched files in scope` +
          (changedOnly || since ? ' (changed-only).\n' : '.\n'),
      );
      for (const sk of report.skipped) {
        process.stdout.write(`    – ${sk.ruleId}: ${sk.reason}${sk.failed ? '  (failOnEmpty → FAILED)' : ''}\n`);
      }
      // Scanning nothing is not a pass. `2` = not verified (the repo-wide
      // contract); a `failOnEmpty` rule promotes it to a real failure.
      return report.skipped.some((sk) => sk.failed) ? 1 : 2;
    }
    process.stdout.write(kv('rules evaluated', `${report.evaluated} of ${report.rules.length}`) + '\n');
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
    if (report.skipped.some((sk) => sk.failed)) {
      process.stdout.write(
        '\nA rule with `failOnEmpty: true` matched nothing — that is a bug in the rule, not a pass.\n',
      );
      return 1;
    }
    if (report.findings.length === 0 && report.diagnostics.length === 0) {
      process.stdout.write(
        newOnly
          ? `\nNo NEW policy violations from this change${hiddenBaseline > 0 ? ` (${hiddenBaseline} pre-existing hidden)` : ''}. ✓\n`
          : '\nNo policy violations on the scanned surfaces. ✓\n',
      );
      return 0;
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
    return report.verdict === 'errors' ? 1 : 0;
  },
};
