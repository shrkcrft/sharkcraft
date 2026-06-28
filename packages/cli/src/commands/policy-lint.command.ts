import * as nodePath from 'node:path';
import type { PolicySurface } from '@shrkcrft/core';
import { runPolicyLint, type IPolicyFinding } from '@shrkcrft/boundaries';
import { loadProjectConfig } from '@shrkcrft/config';
import { resolveChangedFiles } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const VALID_SURFACES: ReadonlySet<string> = new Set(['template', 'style', 'ts']);

export const policyLintCommand: ICommandHandler = {
  name: 'policy-lint',
  description:
    'Lint template/markup, stylesheet, and AOT-invisible TS surfaces against data-defined policyRules[] (e.g. flag raw markup when a primitive exists). Sees `.html` files AND inline `template:` strings — surfaces tsc/AOT cannot. Deterministic; no AI.',
  usage:
    'shrk [--cwd <dir>] policy-lint [--surface template|style|ts] [--changed-only] [--since <ref>] [--only <ids>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const changedOnly = flagBool(args, 'changed-only');
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
    const loaded = await loadProjectConfig(cwd);
    if (!loaded.ok) {
      const msg = loaded.error.message;
      if (wantJson) {
        process.stdout.write(
          asJson({ schema: 'sharkcraft.policy-lint/v1', error: msg, rules: [], findings: [], diagnostics: [msg], verdict: 'errors' }) + '\n',
        );
        return 1;
      }
      process.stdout.write(header('Policy lint'));
      process.stdout.write(`  ✗ Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
      return 1;
    }
    const rules = loaded.value.config.policyRules ?? [];

    if (rules.length === 0) {
      if (wantJson) {
        process.stdout.write(
          asJson({ schema: 'sharkcraft.policy-lint/v1', rules: [], findings: [], diagnostics: [], verdict: 'pass' }) + '\n',
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
    if (changedOnly || since) {
      changedFiles = resolveChangedFiles({
        projectRoot: cwd,
        ...(since ? { since } : {}),
        ...(changedOnly && !since ? { includeWorktree: true } : {}),
      }).files;
    }

    // Don't lint SharkCraft's own asset/config dir by default (its .ts files
    // hold the rule definitions themselves, which can self-match).
    const sharkcraftRel = nodePath.relative(cwd, loaded.value.sharkcraftDir).split(nodePath.sep).join('/');
    const excludeDirs = sharkcraftRel && !sharkcraftRel.startsWith('..') ? [sharkcraftRel] : [];

    const report = runPolicyLint(cwd, rules, {
      ...(surfaces ? { surfaces } : {}),
      ...(changedOnly || since ? { changedOnly: true, changedFiles: changedFiles ?? [] } : {}),
      ...(only ? { only: only.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(excludeDirs.length > 0 ? { excludeDirs } : {}),
    });

    if (wantJson) {
      process.stdout.write(asJson(report) + '\n');
      return report.verdict === 'errors' ? 1 : 0;
    }

    process.stdout.write(header('Policy lint'));
    process.stdout.write(kv('rules evaluated', String(report.rules.length)) + '\n');
    const errors = report.findings.filter((f) => f.severity === 'error').length;
    const warnings = report.findings.filter((f) => f.severity === 'warning').length;
    process.stdout.write(kv('findings', `${errors} error(s), ${warnings} warning(s)`) + '\n');
    if (report.diagnostics.length > 0) {
      process.stdout.write('\nMisconfigured rules:\n');
      for (const d of report.diagnostics) process.stdout.write(`  ! ${d}\n`);
    }
    if (report.findings.length === 0 && report.diagnostics.length === 0) {
      process.stdout.write('\nNo policy violations on the scanned surfaces. ✓\n');
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
