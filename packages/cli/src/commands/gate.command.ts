import {
  prepareQualityGateRun,
  QualityGateReportStore,
  renderGateReportMarkdown,
  runQualityGates,
  settleQualityGateReport,
} from '@shrkcrft/quality-gates';
import { ArchReportStore, archStoreMissing, runArchCheck } from '@shrkcrft/architecture-guard';
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
import { verdictLine } from '../gates/verdict-line.ts';

/**
 * `shrk gate` — run all code-intelligence quality gates and emit one
 * pass/fail report. Designed as the single command CI should call
 * before merge.
 *
 * Exit codes:
 *   - 0 if overall status is `pass` (no failures, no warnings)
 *   - 0 if overall is `warn` (default — opt-in to fail via --strict)
 *   - 1 if overall is `fail`
 *   - 2 if nothing failed but a gate examined only PART of what it was asked
 *     to (e.g. a wiring rule that passed over part of its scope, or a config
 *     that did not load): its `coverage` settles the proposed 0 to NOT
 *     VERIFIED through the CLI's one guard (`settleVerdict`) — a `warn` that
 *     says "this is not a pass" never exits 0.
 *
 * Pass `--strict` to treat `warn` as failure (1).
 */
export const gateCommand: ICommandHandler = {
  name: 'gate',
  description:
    'Aggregator: runs the code-intelligence quality gates (graph freshness, architecture, impact-since-ref) and reports a single pass/fail.',
  usage:
    'shrk gate [--since <gitref>] [--changed-only] [--staged] [--files a,b,c] [--fail-on critical,high] [--arch-all] [--disable arch,impact,policy,knowledge-symbol,api-diff] [--api-baseline <path>] [--no-fail-on-breaking] [--strict] [--no-persist] [--json] [--markdown] [--output <path>]\n         (the arch gate is change-scoped once a baseline is frozen — a NEW error blocks only when the working diff vs HEAD touched its origin file; drift in untouched files is informational — --arch-all fails on total, --strict escalates the warn)\n         (--changed-only / --staged / --files / --since scope the wiring + policy + knowledge-symbol gates to the changeset; they also drive the impact gate — --since diffs the gitref, the others analyze the changed-file set)\n         shrk gate scaffold-ci [--provider github|generic] [--force] [--json]\n         shrk gate scaffold-hook [--provider husky|raw] [--force] [--json]\n         shrk gate baseline --refreeze [--json]  (operational reset: re-freeze the arch baseline to the current state — NOT the change-scoped gate)',
  async run(args: ParsedArgs): Promise<number> {
    if (args.positional[0] === 'scaffold-ci') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      return runGateScaffoldCi(sliced);
    }
    if (args.positional[0] === 'scaffold-hook') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      return runGateScaffoldHook(sliced);
    }
    if (args.positional[0] === 'baseline') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      return runGateBaseline(sliced);
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
    // THE gate-run assembly (`prepareQualityGateRun`, @shrkcrft/quality-gates):
    // the project's wiring + policy rules (an INVALID config surfaced, never a
    // silent disable), THE plane scan scope, the knowledge inspection, the
    // change-scoped arch gate and the advisory impact gate. MCP
    // `get_quality_gate` calls the same one, so the two run the same gate set
    // (round 11 review: MCP passed the impact options only and read `pass`
    // where this verb exited 1).
    const prepared = await prepareQualityGateRun({
      cwd,
      ...(sinceRef ? { sinceRef } : {}),
      ...(changedOnly ? { changedOnly: true } : {}),
      ...(staged ? { staged: true } : {}),
      ...(fileList.length > 0 ? { files: fileList } : {}),
      ...(failOn ? { failOn } : {}),
      ...(archAll ? { archAll: true } : {}),
      ...(disable ? { disable } : {}),
      ...(apiBaseline ? { apiDiff: { baselinePath: apiBaseline, failOnBreaking: !noFailOnBreaking } } : {}),
    });
    // Pack-plane merge notes (missing/invalid pack rule files, dropped
    // collisions) go to stderr so they never pollute the JSON/markdown report
    // on stdout that CI consumes.
    for (const d of prepared.planeDiagnostics) process.stderr.write(`plane: ${d}\n`);
    const report = runQualityGates(prepared.options);
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
    // Settle first, render second: the proposed exit (from `overall`) is vetoed
    // by any gate coverage with a shortfall, for text, --json and --markdown alike.
    // THE settle (`settleQualityGateReport`) MCP `get_quality_gate` returns too.
    const settled = settleQualityGateReport(report, strict);
    const exit = settled.exit;
    const line = verdictLine(settled, '');
    if (wantMarkdown) {
      const md = renderGateReportMarkdown(report) + (line ? `\n${line}\n` : '');
      if (outputPath) {
        const abs = nodePath.isAbsolute(outputPath)
          ? outputPath
          : nodePath.resolve(cwd, outputPath);
        writeFileSync(abs, md, 'utf8');
        process.stdout.write(`Markdown report written → ${abs}\n`);
      } else {
        process.stdout.write(md);
      }
      return exit;
    }
    if (wantJson) {
      process.stdout.write(
        asJson({
          ...report,
          exitCode: exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
          accepted: settled.accepted,
        }) + '\n',
      );
      return exit;
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
    if (line) process.stdout.write(`\n${line}\n`);
    return exit;
  },
};

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

/**
 * `shrk gate baseline --refreeze` — deliberate operational reset that re-freezes
 * the architecture baseline to the CURRENT state, absorbing accumulated drift so
 * the informational "baseline drift" line resets to zero.
 *
 * This is an operational complement, NOT the gate itself: the gate's blocking
 * verdict is change-scoped (a NEW error blocks only when the working diff touched
 * its origin file), so a stale baseline never reds the gate on its own. Refreeze
 * is only for tidying the informational drift line. It mirrors `shrk arch
 * baseline write`.
 */
async function runGateBaseline(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const refreeze = flagBool(args, 'refreeze');
  if (!refreeze) {
    process.stderr.write(
      'Usage: shrk gate baseline --refreeze [--json]\n' +
        '  Re-freeze the architecture baseline to the current state (operational reset,\n' +
        '  not the change-scoped gate). Equivalent to `shrk arch baseline write`.\n',
    );
    return 2;
  }
  const report = runArchCheck({ projectRoot: cwd });
  if (archStoreMissing(report)) {
    process.stderr.write('Cannot refreeze — graph index missing. Run `shrk graph index` first.\n');
    return 2;
  }
  const store = new ArchReportStore(cwd);
  const snap = store.writeBaseline(report);
  if (wantJson) {
    process.stdout.write(asJson({ ok: true, wrote: store.baselinePath, baseline: snap }) + '\n');
    return 0;
  }
  process.stdout.write(`Architecture baseline re-frozen → ${store.baselinePath}\n`);
  process.stdout.write(
    kv(
      'violations',
      `${snap.countsBySeverity.error} error, ${snap.countsBySeverity.warning} warning`,
    ) + '\n',
  );
  return 0;
}

