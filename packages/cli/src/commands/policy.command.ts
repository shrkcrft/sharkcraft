import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  appendPolicyOverrideAudit,
  applyPolicyOverrides,
  ChangedScopeMode,
  classifyChangedScope,
  evaluatePolicy,
  inspectSharkcraft,
  listPolicyOverrides,
  PolicySeverity,
  resolveChangedFiles,
  runPolicySnapshot,
  runPolicyTest,
  runPolicyTestsForAll,
  summariseChangedScope,
  type IChangedScopeOptions,
  type IPolicyEvaluateInput,
  type IPolicyTestInput,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

function buildEvaluateInput(args: ParsedArgs): IPolicyEvaluateInput {
  const out: IPolicyEvaluateInput = {};
  const plan = flagString(args, 'plan');
  if (plan) out.planFile = plan;
  const bundle = flagString(args, 'bundle');
  if (bundle) out.bundleId = bundle;
  const session = flagString(args, 'session');
  if (session) out.sessionId = session;
  if (flagBool(args, 'no-pack-policies')) out.skipPackPolicies = true;
  if (flagBool(args, 'require-signed-policy-packs')) out.requireSignedPolicyPacks = true;
  const local = flagList(args, 'local-files');
  if (local.length > 0) out.localPolicyFiles = local;
  return out;
}

export const policyListCommand: ICommandHandler = {
  name: 'list',
  description: 'List registered policy checks (local + pack).',
  usage: 'shrk policy list [--json] [--no-pack-policies] [--require-signed-policy-packs]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = await evaluatePolicy(inspection, {
      ...buildEvaluateInput(args),
      onlyId: '__none__', // skip predicate execution; we only want registrations
    });
    const regs = report.registrations;
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(regs) + '\n');
      return 0;
    }
    process.stdout.write(header(`Policy checks (${regs.length})`));
    for (const r of regs) {
      process.stdout.write(
        `  [${r.source}] ${r.severity.padEnd(7)} ${r.id.padEnd(40)} ${r.title}\n`,
      );
    }
    return 0;
  },
};

export const policyGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show details for a registered policy check.',
  usage: 'shrk policy get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk policy get <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = await evaluatePolicy(inspection, {
      ...buildEvaluateInput(args),
      onlyId: '__none__',
    });
    const reg = report.registrations.find((r) => r.id === id);
    if (!reg) {
      process.stderr.write(`No policy check "${id}"\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(reg) + '\n');
      return 0;
    }
    process.stdout.write(`${reg.id}\n  title: ${reg.title}\n  severity: ${reg.severity}\n  source: ${reg.source}\n  file: ${reg.sourceFile}\n`);
    if (reg.packName) process.stdout.write(`  pack: ${reg.packName} (${reg.signatureStatus ?? 'unknown'})\n`);
    return 0;
  },
};

export const policyTestCommand: ICommandHandler = {
  name: 'test',
  description: 'Test policy checks against fixtures or inline JSON input.',
  usage:
    'shrk policy test <id> [--fixture <dir>] [--input <json>] [--update-snapshot] [--json]\n  shrk policy test --all [--fixture <dir>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const all = flagBool(args, 'all');
    const fixtureFlag = flagString(args, 'fixture');
    const inputFlag = flagString(args, 'input');
    const id = args.positional[0];

    if (all) {
      const batch = await runPolicyTestsForAll(inspection, {
        ...(fixtureFlag ? { fixtureDir: fixtureFlag } : {}),
      });
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(batch) + '\n');
        return batch.summary.failed === 0 ? 0 : 1;
      }
      process.stdout.write(header(`Policy tests (${batch.summary.total})`));
      for (const r of batch.results) {
        const tag = r.passed ? 'OK  ' : 'FAIL';
        process.stdout.write(`  ${tag} ${r.policyId.padEnd(36)} ${r.inputSource}\n`);
        for (const c of r.checks) {
          process.stdout.write(`         [${c.severity}] ${c.message}\n`);
        }
        if (r.expectationOutcome && !r.expectationOutcome.matched) {
          for (const m of r.expectationOutcome.mismatches)
            process.stdout.write(`         ! expectation: ${m}\n`);
        }
      }
      process.stdout.write(
        `\nSummary: ${batch.summary.passed}/${batch.summary.total} passed\n`,
      );
      return batch.summary.failed === 0 ? 0 : 1;
    }

    if (!id) {
      process.stderr.write('Usage: shrk policy test <id> [--fixture <dir>|--input <json>]\n');
      return 2;
    }

    let policyInput: IPolicyTestInput['policyInput'] | undefined;
    if (inputFlag) {
      try {
        // If inputFlag is a JSON path or inline JSON.
        if (existsSync(inputFlag)) {
          policyInput = JSON.parse(readFileSync(inputFlag, 'utf8'));
        } else {
          policyInput = JSON.parse(inputFlag);
        }
      } catch (e) {
        process.stderr.write(`Invalid --input: ${(e as Error).message}\n`);
        return 2;
      }
    }

    const wantSnapshotUpdate = flagBool(args, 'update-snapshot');
    if (wantSnapshotUpdate || (fixtureFlag && existsSync(nodePath.join(fixtureFlag, 'snapshot.json')))) {
      const snapshotFile = fixtureFlag
        ? nodePath.join(fixtureFlag, 'snapshot.json')
        : nodePath.join(cwd, '.sharkcraft', 'policy-snapshots', `${id}.snapshot.json`);
      const outcome = await runPolicySnapshot(
        inspection,
        {
          policyId: id,
          ...(fixtureFlag ? { fixtureDir: fixtureFlag } : {}),
          ...(policyInput ? { policyInput } : {}),
        },
        {
          snapshotFile,
          updateSnapshot: wantSnapshotUpdate,
        },
      );
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(outcome) + '\n');
        return outcome.matchesSnapshot ? 0 : 1;
      }
      process.stdout.write(header(`Policy snapshot: ${id}`));
      process.stdout.write(`snapshot: ${snapshotFile}\n`);
      process.stdout.write(`input: ${outcome.inputSource}\n`);
      process.stdout.write(`current: ${outcome.result.passed ? 'pass' : 'fail'}\n`);
      if (outcome.updated) process.stdout.write('snapshot: WRITTEN\n');
      if (!outcome.matchesSnapshot) {
        process.stdout.write('result: SNAPSHOT MISMATCH\n');
        for (const d of outcome.diffs) process.stdout.write(`  - ${d}\n`);
      } else {
        process.stdout.write('result: snapshot matches\n');
      }
      return outcome.matchesSnapshot ? 0 : 1;
    }

    const result = await runPolicyTest(inspection, {
      policyId: id,
      ...(fixtureFlag ? { fixtureDir: fixtureFlag } : {}),
      ...(policyInput ? { policyInput } : {}),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
      return result.passed ? 0 : 1;
    }
    process.stdout.write(header(`Policy test: ${id}`));
    process.stdout.write(`input: ${result.inputSource}\n`);
    if (result.registration) {
      process.stdout.write(
        `registered: [${result.registration.source}] severity=${result.registration.severity}\n`,
      );
    } else {
      process.stdout.write('registered: (not registered locally — fixture-only test)\n');
    }
    if (result.checks.length === 0) {
      process.stdout.write(`result: PASS\n`);
    } else {
      process.stdout.write(`result: FAIL\n`);
      for (const c of result.checks) {
        process.stdout.write(`  [${c.severity}] ${c.title} — ${c.message}\n`);
        if (c.suggestedFix) process.stdout.write(`    fix: ${c.suggestedFix}\n`);
        if (c.context) process.stdout.write(`    evidence: ${JSON.stringify(c.context)}\n`);
      }
    }
    if (result.expectationOutcome) {
      if (result.expectationOutcome.matched) {
        process.stdout.write('expectation: MET\n');
      } else {
        process.stdout.write('expectation: MISMATCH\n');
        for (const m of result.expectationOutcome.mismatches)
          process.stdout.write(`  - ${m}\n`);
      }
      return result.expectationOutcome.matched ? 0 : 1;
    }
    return result.passed ? 0 : 1;
  },
};

function readChangedScopeOptionsForPolicy(args: ParsedArgs, projectRoot: string): IChangedScopeOptions | null {
  const changedOnly = flagBool(args, 'changed-only');
  const since = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const files = flagList(args, 'files');
  if (!changedOnly && !since && !staged && files.length === 0) return null;
  return {
    projectRoot,
    ...(since ? { since } : {}),
    ...(staged ? { staged: true } : {}),
    ...(files.length > 0 ? { files } : {}),
    includeWorktree: changedOnly || !since,
  };
}

export const policyRunCommand: ICommandHandler = {
  name: 'run',
  description:
    'Run all policy checks; alias for `policy check` with richer output. `--explain-overrides` shows applied overrides; `--record-override-audit` appends them to `.sharkcraft/policy-override-audit.log`. `--changed-only|--since|--staged|--files` filters findings via the shared changed-scope classifier.',
  usage:
    'shrk policy run [--plan <plan.json>] [--bundle <id>] [--no-pack-policies] [--require-signed-policy-packs] [--explain-overrides] [--record-override-audit] [--changed-only|--since <ref>|--staged|--files a,b,c] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const baseReport = await evaluatePolicy(inspection, buildEvaluateInput(args));

    const overrides = listPolicyOverrides(inspection);
    const explainOverrides = flagBool(args, 'explain-overrides');
    const recordAudit = flagBool(args, 'record-override-audit');
    const { report, explain } = applyPolicyOverrides(baseReport, overrides);
    const changedScopeOpts = readChangedScopeOptionsForPolicy(args, cwd);
    const classification = changedScopeOpts
      ? (() => {
          const resolved = resolveChangedFiles(changedScopeOpts);
          return classifyChangedScope({
            projectRoot: cwd,
            current: report.checks.map((c) => ({
              key: `${c.id}:${(c.context as { file?: string })?.file ?? ''}`,
              code: c.id,
              severity: c.severity,
              message: c.message,
              file: (c.context as { file?: string })?.file,
            })),
            changedFiles: resolved.files,
          });
        })()
      : null;

    if (recordAudit && explain.applied.length > 0) {
      const entries = explain.applied.map((a) => ({
        policyId: a.policyId,
        ...(a.originalSeverity ? { originalSeverity: a.originalSeverity } : {}),
        ...(a.appliedSeverity ? { effectiveSeverity: a.appliedSeverity } : {}),
        disabled: a.disabled === true,
        ...(a.reason ? { reason: a.reason } : {}),
        sourceConfig: 'sharkcraft.config.ts',
        command: 'shrk policy run',
      }));
      appendPolicyOverrideAudit(inspection, entries);
    }

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          ...report,
          ...(explainOverrides ? { overrides: explain } : {}),
          ...(classification ? { changedScope: classification } : {}),
        }) + '\n',
      );
      return report.summary.passed ? 0 : 1;
    }
    process.stdout.write(header(`Policy run (${report.registrations.length} registered)`));
    process.stdout.write(
      `passed=${report.summary.passed} info=${report.summary.info} warning=${report.summary.warning} error=${report.summary.error} critical=${report.summary.critical}\n`,
    );
    if (classification) {
      process.stdout.write(`changed-scope: ${summariseChangedScope(classification)}\n`);
    }
    void ChangedScopeMode;
    process.stdout.write('Registered:\n');
    for (const r of report.registrations) {
      process.stdout.write(`  [${r.source}] ${r.id}\n`);
    }
    process.stdout.write('Findings:\n');
    for (const c of report.checks.slice(0, 50)) {
      process.stdout.write(`  [${c.severity}] ${c.id}: ${c.message}\n`);
    }
    if (explainOverrides) {
      process.stdout.write('Applied overrides:\n');
      for (const a of explain.applied) {
        const detail = a.disabled
          ? `disabled (was ${a.originalSeverity ?? '?'})`
          : `${a.originalSeverity ?? '?'} → ${a.appliedSeverity ?? '?'}`;
        process.stdout.write(`  • ${a.policyId} — ${detail}${a.reason ? ` — ${a.reason}` : ''}\n`);
      }
      if (explain.applied.length === 0) process.stdout.write('  (none)\n');
    }
    if (recordAudit) {
      if (explain.applied.length > 0)
        process.stdout.write(`Recorded ${explain.applied.length} entry/entries in policy-override-audit.log\n`);
      else process.stdout.write('No overrides applied — nothing recorded.\n');
    }
    void PolicySeverity;
    void existsSync;
    void readFileSync;
    void nodePath;
    return report.summary.passed ? 0 : 1;
  },
};

type SnapshotOutcomeBucket = 'passed' | 'drifted' | 'missing' | 'updated' | 'skipped';

export const policySnapshotCommand: ICommandHandler = {
  name: 'snapshot',
  description:
    'Capture / compare policy snapshots (writes only under fixture dirs). Supports --gate (CI) and --accept (rewrite after review).',
  usage:
    'shrk policy snapshot <id> [--input <json>|--fixture <dir>] [--gate] [--accept] [--update-snapshot] [--json]\n  shrk policy snapshot --all --fixture <dir> [--gate] [--accept] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const all = flagBool(args, 'all');
    const fixtureFlag = flagString(args, 'fixture');
    const inputFlag = flagString(args, 'input');
    const updateSnap = flagBool(args, 'update-snapshot') || flagBool(args, 'accept');
    const gate = flagBool(args, 'gate');
    const wantJson = flagBool(args, 'json');

    interface IRunOutcome {
      id: string;
      bucket: SnapshotOutcomeBucket;
      outcome: Awaited<ReturnType<typeof runPolicySnapshot>>;
    }

    const buckets: Record<SnapshotOutcomeBucket, IRunOutcome[]> = {
      passed: [],
      drifted: [],
      missing: [],
      updated: [],
      skipped: [],
    };

    const runOne = async (
      id: string,
      fixture: string | undefined,
      policyInput: IPolicyTestInput['policyInput'] | undefined,
    ): Promise<void> => {
      const snapshotFile = fixture
        ? nodePath.join(fixture, 'snapshot.json')
        : nodePath.join(cwd, '.sharkcraft', 'policy-snapshots', `${id}.snapshot.json`);
      const had = existsSync(snapshotFile);
      const outcome = await runPolicySnapshot(
        inspection,
        {
          policyId: id,
          ...(fixture ? { fixtureDir: fixture } : {}),
          ...(policyInput ? { policyInput } : {}),
        },
        { snapshotFile, updateSnapshot: updateSnap },
      );
      let bucket: SnapshotOutcomeBucket;
      if (!had) {
        bucket = updateSnap ? 'updated' : 'missing';
      } else if (outcome.updated) {
        bucket = 'updated';
      } else if (outcome.matchesSnapshot) {
        bucket = 'passed';
      } else {
        bucket = 'drifted';
      }
      buckets[bucket].push({ id, bucket, outcome });
    };

    if (all) {
      if (!fixtureFlag) {
        process.stderr.write('Usage: shrk policy snapshot --all --fixture <dir>\n');
        return 2;
      }
      if (!existsSync(fixtureFlag)) {
        process.stderr.write(`Fixture dir not found: ${fixtureFlag}\n`);
        return 1;
      }
      const { readdirSync } = await import('node:fs');
      const subs = readdirSync(fixtureFlag, { withFileTypes: true }).filter((e) => e.isDirectory());
      for (const s of subs) {
        await runOne(s.name, nodePath.join(fixtureFlag, s.name), undefined);
      }
    } else {
      const id = args.positional[0];
      if (!id) {
        process.stderr.write('Usage: shrk policy snapshot <id> [--input <json>|--fixture <dir>]\n');
        return 2;
      }
      let policyInput: IPolicyTestInput['policyInput'] | undefined;
      if (inputFlag) {
        try {
          policyInput = existsSync(inputFlag)
            ? JSON.parse(readFileSync(inputFlag, 'utf8'))
            : JSON.parse(inputFlag);
        } catch (e) {
          process.stderr.write(`Invalid --input: ${(e as Error).message}\n`);
          return 2;
        }
      }
      await runOne(id, fixtureFlag ?? undefined, policyInput);
    }

    const summary = {
      passed: buckets.passed.length,
      drifted: buckets.drifted.length,
      missing: buckets.missing.length,
      updated: buckets.updated.length,
      skipped: buckets.skipped.length,
      total:
        buckets.passed.length +
        buckets.drifted.length +
        buckets.missing.length +
        buckets.updated.length +
        buckets.skipped.length,
    };
    const gateFailed = gate && (summary.drifted > 0 || summary.missing > 0);

    if (wantJson) {
      const report = {
        schema: 'sharkcraft.policy-snapshot-batch/v1',
        summary,
        passed: buckets.passed.map((b) => b.outcome),
        drifted: buckets.drifted.map((b) => b.outcome),
        missing: buckets.missing.map((b) => b.outcome),
        updated: buckets.updated.map((b) => b.outcome),
        skipped: buckets.skipped.map((b) => b.outcome),
        gate,
        gatePassed: !gateFailed,
      };
      process.stdout.write(asJson(report) + '\n');
      return gateFailed ? 1 : 0;
    }

    process.stdout.write(header(`Policy snapshots (${summary.total})`));
    process.stdout.write(
      `passed=${summary.passed}  drifted=${summary.drifted}  missing=${summary.missing}  updated=${summary.updated}  skipped=${summary.skipped}\n`,
    );
    const printBucket = (label: string, tag: string, list: IRunOutcome[]): void => {
      if (list.length === 0) return;
      process.stdout.write(`\n${label}:\n`);
      for (const r of list) {
        process.stdout.write(`  ${tag} ${r.id.padEnd(36)} ${r.outcome.snapshotFile}\n`);
        for (const d of r.outcome.diffs.slice(0, 3)) {
          process.stdout.write(`         - ${d}\n`);
        }
      }
    };
    printBucket('Passed', 'OK   ', buckets.passed);
    printBucket('Drifted', 'DIFF ', buckets.drifted);
    printBucket('Missing snapshot', 'MISS ', buckets.missing);
    printBucket('Updated', 'WRITE', buckets.updated);
    printBucket('Skipped', 'SKIP ', buckets.skipped);
    if (gate) {
      process.stdout.write(`\nGate: ${gateFailed ? 'FAILED' : 'OK'}\n`);
    }
    return gateFailed ? 1 : 0;
  },
};

// Keep the existing `policy check` name for backwards compatibility.
export const policyCheckCommand: ICommandHandler = {
  name: 'check',
  description: 'Run policy engine across boundaries, ownership, plans, packs.',
  usage: 'shrk policy check [--plan <plan>] [--bundle <id>] [--session <id>] [--json]',
  run: policyRunCommand.run,
};
