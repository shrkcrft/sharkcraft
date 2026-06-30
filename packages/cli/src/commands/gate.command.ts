import {
  QualityGateReportStore,
  renderGateReportMarkdown,
  runQualityGates,
} from '@shrkcrft/quality-gates';
import {
  inspectSharkcraft,
  resolveChangedFiles,
  resolveProjectConfig,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * `shrk gate` — run all code-intelligence quality gates and emit one
 * pass/fail report. Designed as the single command CI should call
 * before merge.
 *
 * Exit codes:
 *   - 0 if overall status is `pass` (no failures, no warnings)
 *   - 0 if overall is `warn` (default — opt-in to fail via --strict)
 *   - 1 if overall is `fail`
 *
 * Pass `--strict` to treat `warn` as failure.
 */
export const gateCommand: ICommandHandler = {
  name: 'gate',
  description:
    'Aggregator: runs the code-intelligence quality gates (graph freshness, architecture, impact-since-ref) and reports a single pass/fail.',
  usage:
    'shrk gate [--since <gitref>] [--changed-only] [--staged] [--files a,b,c] [--fail-on critical,high] [--arch-all] [--disable arch,impact,policy,knowledge-symbol,api-diff] [--api-baseline <path>] [--no-fail-on-breaking] [--strict] [--no-persist] [--json] [--markdown] [--output <path>]\n         (the arch gate is baseline-relative once a baseline is frozen — fails only on NEW errors; with no baseline it warns on errors rather than going perpetually red — --arch-all fails on total, --strict escalates the warn)\n         (--changed-only / --staged / --files / --since scope the wiring + policy + knowledge-symbol gates to the changeset; they also drive the impact gate — --since diffs the gitref, the others analyze the changed-file set)\n         shrk gate scaffold-ci [--provider github|generic] [--force] [--json]\n         shrk gate scaffold-hook [--provider husky|raw] [--force] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    if (args.positional[0] === 'scaffold-ci') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      return runGateScaffoldCi(sliced);
    }
    if (args.positional[0] === 'scaffold-hook') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      return runGateScaffoldHook(sliced);
    }
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const wantMarkdown = flagBool(args, 'markdown');
    const outputPath = flagString(args, 'output');
    const strict = flagBool(args, 'strict');
    const sinceRef = flagString(args, 'since');
    const failOnRaw = flagString(args, 'fail-on');
    const disableRaw = flagString(args, 'disable');
    const apiBaseline = flagString(args, 'api-baseline');
    const noFailOnBreaking = flagBool(args, 'no-fail-on-breaking');
    // `--fail-on` accepts only `high` / `critical`. An unknown token used to
    // silently REPLACE the default `['critical']`, leaving nothing able to fail
    // the gate — reject it loudly (exit 2) instead.
    const failOnTokens = failOnRaw
      ? failOnRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    if (failOnTokens) {
      const allowedRisk = new Set(['high', 'critical']);
      const unknown = failOnTokens.filter((t) => !allowedRisk.has(t));
      if (unknown.length > 0) {
        process.stderr.write(
          `Unknown --fail-on value(s): ${unknown.join(', ')}. Allowed: high, critical.\n`,
        );
        return 2;
      }
    }
    const failOn =
      failOnTokens && failOnTokens.length > 0
        ? (failOnTokens as readonly ('high' | 'critical')[])
        : undefined;
    const disable = disableRaw ? disableRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    // --arch-all: fail on TOTAL architecture errors (ignore the frozen baseline).
    // By default the arch gate is baseline-relative — it fails only on NEW errors.
    const archAll = flagBool(args, 'arch-all');
    // Changeset scope. `--changed-only` (tracked + untracked worktree),
    // `--staged`, `--files`, and `--since` all narrow the wiring + policy +
    // knowledge-symbol gates to the change. `--since` additionally drives the
    // (ref-based) impact gate, as before.
    const changedOnly = flagBool(args, 'changed-only');
    const staged = flagBool(args, 'staged');
    const filesRaw = flagString(args, 'files');
    const fileList = filesRaw ? filesRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const wantChangedScope = changedOnly || staged || Boolean(sinceRef) || fileList.length > 0;
    let changedFiles: readonly string[] | undefined;
    if (wantChangedScope) {
      const resolved = resolveChangedFiles({
        projectRoot: cwd,
        ...(fileList.length > 0 ? { files: fileList } : {}),
        ...(staged ? { staged: true } : {}),
        ...(sinceRef ? { since: sinceRef } : {}),
        ...(changedOnly && !staged && !sinceRef && fileList.length === 0
          ? { includeWorktree: true }
          : {}),
      });
      changedFiles = resolved.files;
    }
    // Wiring + policy rules come from the project config; each gate is skipped
    // (never red) when none are declared, so they're inert for projects that
    // don't opt in. An INVALID config is surfaced (warn) rather than silently
    // disabling the plane.
    const loadedConfig = await resolveProjectConfig(cwd);
    const wiringRules = loadedConfig.ok ? loadedConfig.value.config.wiringRules ?? [] : [];
    const policyRules = loadedConfig.ok ? loadedConfig.value.config.policyRules ?? [] : [];
    const configError = loadedConfig.ok ? undefined : loadedConfig.error.message;
    // Pack-plane merge notes (missing/invalid pack rule files, dropped
    // collisions) go to stderr so they never pollute the JSON/markdown report
    // on stdout that CI consumes.
    if (loadedConfig.ok) {
      for (const d of loadedConfig.value.planeDiagnostics) {
        process.stderr.write(`plane: ${d}\n`);
      }
    }
    const scopeOpts = wantChangedScope
      ? { changedOnly: true, changedFiles: changedFiles ?? [] }
      : {};
    // Knowledge symbol-ref integrity needs the loaded knowledge entries. The
    // inspection is async, so we build it here and inject it; the gate stays
    // synchronous and resolves the code graph itself. Best-effort — a failed
    // inspection just skips the gate rather than failing `shrk gate`.
    let inspection: ISharkcraftInspection | undefined;
    if (!disable?.includes('knowledge-symbol')) {
      try {
        inspection = await inspectSharkcraft({ cwd });
      } catch {
        inspection = undefined;
      }
    }
    const report = runQualityGates({
      projectRoot: cwd,
      ...(archAll ? { arch: { baselineRelative: false } } : {}),
      wiring: {
        ...(configError
          ? { configError }
          : wiringRules.length > 0
            ? { rules: wiringRules }
            : {}),
        ...scopeOpts,
      },
      policy: {
        ...(configError
          ? { configError }
          : policyRules.length > 0
            ? { rules: policyRules }
            : {}),
        ...scopeOpts,
      },
      ...(inspection
        ? {
            knowledgeSymbol: {
              inspection,
              ...(wantChangedScope ? { changedFiles: changedFiles ?? [] } : {}),
            },
          }
        : {}),
      impact: {
        ...(sinceRef ? { sinceRef } : {}),
        ...(failOn ? { failOn } : {}),
        // Scope the impact gate to the changeset too: with `--since` we keep the
        // gitref diff; with `--changed-only` / `--staged` / `--files` (and no
        // `--since`) we analyze the resolved changed-file set directly.
        ...(wantChangedScope && !sinceRef ? { files: changedFiles ?? [] } : {}),
      },
      ...(apiBaseline
        ? {
            apiDiff: {
              baselinePath: apiBaseline,
              failOnBreaking: !noFailOnBreaking,
            },
          }
        : {}),
      ...(disable ? { disable } : {}),
    });
    // Persist the report so dashboards and follow-up tooling can read
    // it without re-running every gate. Opt out with `--no-persist`.
    if (!flagBool(args, 'no-persist')) {
      try {
        new QualityGateReportStore(cwd).write(report);
      } catch {
        // Persistence is best-effort; never fail the gate on a
        // disk-write error.
      }
    }
    if (wantMarkdown) {
      const md = renderGateReportMarkdown(report);
      if (outputPath) {
        const abs = nodePath.isAbsolute(outputPath)
          ? outputPath
          : nodePath.resolve(cwd, outputPath);
        writeFileSync(abs, md, 'utf8');
        process.stdout.write(`Markdown report written → ${abs}\n`);
      } else {
        process.stdout.write(md);
      }
      return exitCode(report.overall, strict);
    }
    if (wantJson) {
      process.stdout.write(asJson(report) + '\n');
      return exitCode(report.overall, strict);
    }
    process.stdout.write(header(`Quality gates: ${report.overall.toUpperCase()}`));
    process.stdout.write(kv('total duration', `${report.totalDurationMs}ms`) + '\n');
    process.stdout.write(
      kv(
        'summary',
        `pass=${report.counts.pass} warn=${report.counts.warn} fail=${report.counts.fail} skipped=${report.counts.skipped}`,
      ) + '\n',
    );
    process.stdout.write('\nGates:\n');
    for (const g of report.gates) {
      const status = g.status.padEnd(8);
      process.stdout.write(`  [${status}] ${g.label}  (${g.durationMs}ms)\n`);
      process.stdout.write(`            ${g.message}\n`);
      if (g.nextCommands && g.nextCommands.length > 0) {
        for (const c of g.nextCommands) process.stdout.write(`              → ${c}\n`);
      }
    }
    return exitCode(report.overall, strict);
  },
};

function exitCode(overall: 'pass' | 'fail' | 'warn' | 'skipped', strict: boolean): number {
  if (overall === 'fail') return 1;
  if (overall === 'warn' && strict) return 1;
  return 0;
}

const GITHUB_WORKFLOW = `name: shrk gate

on:
  pull_request:
  push:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # full history so 'shrk impact --since main' works

      - name: Setup bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Index code-intelligence graph
        run: bunx shrk graph index

      - name: Run shrk gate
        run: bunx shrk gate --since origin/main --strict --markdown --output gate-report.md

      - name: Upload gate report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: shrk-gate-report
          path: |
            gate-report.md
            .sharkcraft/quality-gates/last.json

      - name: Comment on PR
        if: github.event_name == 'pull_request' && always()
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: shrk-gate
          path: gate-report.md
`;

const HUSKY_PRE_COMMIT = `#!/usr/bin/env sh
# shrk gate pre-commit hook (husky-compatible).
#
# Re-indexes the code graph from staged files only, then runs the
# default gate set against the change. Add or remove --disable flags
# to narrow the gate set if a particular check is too slow at this
# point in the loop.
. "$(dirname -- "$0")/_/husky.sh"

set -e

bunx shrk graph index --changed
bunx shrk gate --strict
`;

const RAW_PRE_COMMIT = `#!/usr/bin/env sh
# shrk gate pre-commit hook (raw .git/hooks variant).
#
# Symlink or copy this file into .git/hooks/pre-commit:
#   ln -s ../../scripts/pre-commit .git/hooks/pre-commit
# (or just \`cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit\`).
set -e

bunx shrk graph index --changed
bunx shrk gate --strict
`;

const GENERIC_SCRIPT = `#!/usr/bin/env bash
# Generic CI runner for shrk gate. Copy / adapt for your provider.
#
# Usage:
#   ./scripts/shrk-gate.sh
#
# Exit codes:
#   0 — gate pass or warn (non-strict)
#   1 — gate fail (or warn under --strict)
set -euo pipefail

# Ensure the code-intelligence graph is fresh.
bunx shrk graph index

# Run the aggregator. --strict turns warn into fail; drop it if you
# prefer to surface warnings without blocking merge.
bunx shrk gate \\
  --since "\${BASE_REF:-origin/main}" \\
  --strict \\
  --markdown \\
  --output gate-report.md
`;

async function runGateScaffoldHook(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const provider = flagString(args, 'provider') ?? 'husky';
  const force = flagBool(args, 'force');
  let target: string;
  let body: string;
  switch (provider) {
    case 'husky':
      target = nodePath.join(cwd, '.husky', 'pre-commit');
      body = HUSKY_PRE_COMMIT;
      break;
    case 'raw':
      target = nodePath.join(cwd, 'scripts', 'pre-commit');
      body = RAW_PRE_COMMIT;
      break;
    default:
      process.stderr.write(`Unknown --provider "${provider}". Use husky | raw.\n`);
      return 2;
  }
  if (existsSync(target) && !force) {
    const msg = `${target} already exists. Use --force to overwrite.\n`;
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: 'exists', path: target }) + '\n');
      return 1;
    }
    process.stderr.write(msg);
    return 1;
  }
  mkdirSync(nodePath.dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
  try {
    chmodSync(target, 0o755);
  } catch {
    // ignore — Windows / strict FS.
  }
  if (wantJson) {
    process.stdout.write(
      asJson({ ok: true, provider, wrote: target, bytes: body.length }) + '\n',
    );
    return 0;
  }
  process.stdout.write(`Scaffolded ${provider} pre-commit hook → ${target}\n`);
  if (provider === 'raw') {
    process.stdout.write(
      `Activate it with:\n  ln -s ../../scripts/pre-commit .git/hooks/pre-commit\n`,
    );
  }
  return 0;
}

async function runGateScaffoldCi(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const provider = flagString(args, 'provider') ?? 'github';
  const force = flagBool(args, 'force');
  let target: string;
  let body: string;
  switch (provider) {
    case 'github':
      target = nodePath.join(cwd, '.github', 'workflows', 'shrk-gate.yml');
      body = GITHUB_WORKFLOW;
      break;
    case 'generic':
      target = nodePath.join(cwd, 'scripts', 'shrk-gate.sh');
      body = GENERIC_SCRIPT;
      break;
    default:
      process.stderr.write(`Unknown --provider "${provider}". Use github | generic.\n`);
      return 2;
  }
  if (existsSync(target) && !force) {
    const msg = `${target} already exists. Use --force to overwrite.\n`;
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: 'exists', path: target }) + '\n');
      return 1;
    }
    process.stderr.write(msg);
    return 1;
  }
  mkdirSync(nodePath.dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
  if (provider === 'generic') {
    try {
      chmodSync(target, 0o755);
    } catch {
      // ignore — Windows or stricter FS.
    }
  }
  if (wantJson) {
    process.stdout.write(
      asJson({ ok: true, provider, wrote: target, bytes: body.length }) + '\n',
    );
    return 0;
  }
  process.stdout.write(`Scaffolded ${provider} CI runner → ${target}\n`);
  return 0;
}

