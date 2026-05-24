import {
  QualityGateReportStore,
  renderGateReportMarkdown,
  runQualityGates,
} from '@shrkcrft/quality-gates';
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
    'shrk gate [--since <gitref>] [--fail-on critical,high] [--disable arch,impact,api-diff] [--api-baseline <path>] [--no-fail-on-breaking] [--strict] [--no-persist] [--json] [--markdown] [--output <path>]\n         shrk gate scaffold-ci [--provider github|generic] [--force] [--json]\n         shrk gate scaffold-hook [--provider husky|raw] [--force] [--json]',
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
    const failOn = failOnRaw
      ? (failOnRaw.split(',').map((s) => s.trim()).filter(Boolean) as readonly ('high' | 'critical')[])
      : undefined;
    const disable = disableRaw ? disableRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const report = runQualityGates({
      projectRoot: cwd,
      impact: {
        ...(sinceRef ? { sinceRef } : {}),
        ...(failOn ? { failOn } : {}),
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

