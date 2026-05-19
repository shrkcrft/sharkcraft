import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { importModuleViaLoader } from '@shrkcrft/core';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  evaluatePolicy,
  PolicySeverity,
  type IPackPolicyCheck,
  type IPolicyCheck,
  type IPolicyCheckRegistration,
  type IPolicyEvaluateInput,
} from './policy-engine.ts';

export const POLICY_TEST_SCHEMA = 'sharkcraft.policy-test/v1';
export const POLICY_SNAPSHOT_SCHEMA = 'sharkcraft.policy-snapshot/v1';

export interface IPolicyTestExpectation {
  /** When provided, fail unless the test result.passed matches. */
  passed?: boolean;
  /** Substring that must appear in any emitted check.message. */
  messageContains?: string;
  /** Minimum severity that must appear. */
  minSeverity?: PolicySeverity;
}

export interface IPolicyTestInput {
  policyId?: string;
  /** Optional pre-built input object — overrides the loader. */
  policyInput?: {
    projectRoot?: string;
    planTargets?: readonly string[];
    bundleAffectedFiles?: readonly string[];
  };
  fixtureDir?: string;
  expected?: IPolicyTestExpectation;
}

export interface IPolicyTestResult {
  policyId: string;
  passed: boolean;
  inputSource: string;
  evidence: readonly string[];
  checks: readonly IPolicyCheck[];
  registration: IPolicyCheckRegistration | null;
  expectation?: IPolicyTestExpectation;
  expectationOutcome?: { matched: boolean; mismatches: readonly string[] };
}

export interface IPolicyTestBatch {
  schema: typeof POLICY_TEST_SCHEMA;
  results: readonly IPolicyTestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

function readJsonOptional<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readFixtureInput(fixtureDir: string): {
  source: string;
  input: IPolicyTestInput['policyInput'];
  expected?: IPolicyTestExpectation;
} {
  const inputFile = nodePath.join(fixtureDir, 'policy-input.json');
  const expectedFile = nodePath.join(fixtureDir, 'expected.json');
  const expected = readJsonOptional<IPolicyTestExpectation>(expectedFile) ?? undefined;
  const direct = readJsonOptional<{
    projectRoot?: string;
    planTargets?: readonly string[];
    bundleAffectedFiles?: readonly string[];
  }>(inputFile);
  if (direct) {
    return {
      source: nodePath.relative(fixtureDir, inputFile) || 'policy-input.json',
      input: direct,
      ...(expected ? { expected } : {}),
    };
  }
  // Synthesize input from planTargets.json + bundleAffectedFiles.json.
  const planTargets = readJsonOptional<readonly string[]>(
    nodePath.join(fixtureDir, 'planTargets.json'),
  );
  const bundleAffectedFiles = readJsonOptional<readonly string[]>(
    nodePath.join(fixtureDir, 'bundleAffectedFiles.json'),
  );
  const input: NonNullable<IPolicyTestInput['policyInput']> = {
    projectRoot: fixtureDir,
    planTargets: planTargets ?? [],
    bundleAffectedFiles: bundleAffectedFiles ?? [],
  };
  return {
    source: 'planTargets+bundleAffectedFiles',
    input,
    ...(expected ? { expected } : {}),
  };
}

async function loadLocalPolicyChecks(
  inspection: ISharkcraftInspection,
  localFiles?: readonly string[],
): Promise<{
  decls: { check: IPackPolicyCheck; sourceFile: string; isLocal: boolean }[];
}> {
  const out: { check: IPackPolicyCheck; sourceFile: string; isLocal: boolean }[] = [];
  const sharkcraftDir = inspection.sharkcraftDir;
  const localCandidates =
    localFiles ?? [
      sharkcraftDir ? nodePath.join(sharkcraftDir, 'policies.ts') : null,
      sharkcraftDir ? nodePath.join(sharkcraftDir, 'policies.js') : null,
    ].filter((x): x is string => Boolean(x));
  for (const file of localCandidates) {
    if (!existsSync(file)) continue;
    try {
      const mod = (await importModuleViaLoader(file)) as {
        default?: readonly IPackPolicyCheck[];
        policyChecks?: readonly IPackPolicyCheck[];
      };
      const decls = mod.default ?? mod.policyChecks ?? [];
      for (const d of decls) out.push({ check: d, sourceFile: file, isLocal: true });
    } catch {
      /* ignore */
    }
  }
  // Pack-contributed policies — read directly so we can test individual ids.
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as {
      policyCheckFiles?: readonly string[];
    };
    for (const rel of contributions.policyCheckFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) continue;
      try {
        const mod = (await importModuleViaLoader(file)) as {
          default?: readonly IPackPolicyCheck[];
          policyChecks?: readonly IPackPolicyCheck[];
        };
        const decls = mod.default ?? mod.policyChecks ?? [];
        for (const d of decls) out.push({ check: d, sourceFile: file, isLocal: false });
      } catch {
        /* ignore */
      }
    }
  }
  return { decls: out };
}

function severityRank(s: PolicySeverity): number {
  switch (s) {
    case PolicySeverity.Critical:
      return 4;
    case PolicySeverity.Error:
      return 3;
    case PolicySeverity.Warning:
      return 2;
    case PolicySeverity.Info:
      return 1;
  }
  return 0;
}

function evaluateExpectation(
  result: Omit<IPolicyTestResult, 'expectation' | 'expectationOutcome'>,
  expected?: IPolicyTestExpectation,
): { matched: boolean; mismatches: string[] } | undefined {
  if (!expected) return undefined;
  const mismatches: string[] = [];
  if (typeof expected.passed === 'boolean' && expected.passed !== result.passed) {
    mismatches.push(`expected passed=${expected.passed}, got passed=${result.passed}`);
  }
  if (expected.messageContains) {
    const found = result.checks.some((c) => c.message.includes(expected.messageContains!));
    if (!found) mismatches.push(`no check message contained "${expected.messageContains}"`);
  }
  if (expected.minSeverity) {
    const max = result.checks.reduce(
      (acc, c) => Math.max(acc, severityRank(c.severity)),
      0,
    );
    if (max < severityRank(expected.minSeverity)) {
      mismatches.push(`min severity ${expected.minSeverity} not reached`);
    }
  }
  return { matched: mismatches.length === 0, mismatches };
}

export async function runPolicyTest(
  inspection: ISharkcraftInspection,
  input: IPolicyTestInput,
): Promise<IPolicyTestResult> {
  let source = 'live';
  let evidence: string[] = [];
  let expected: IPolicyTestExpectation | undefined = input.expected;

  // Resolve fixture if requested.
  let policyInput = input.policyInput;
  if (input.fixtureDir && existsSync(input.fixtureDir)) {
    const fx = readFixtureInput(input.fixtureDir);
    policyInput = policyInput ?? fx.input;
    source = `fixture:${nodePath.basename(input.fixtureDir)}`;
    if (!expected && fx.expected) expected = fx.expected;
    evidence.push(`fixture: ${fx.source}`);
  }

  // If no specific id is provided, we run the live engine and surface
  // everything.
  const id = input.policyId;
  const policyEvalInput: IPolicyEvaluateInput = {};
  if (id) policyEvalInput.onlyId = id;
  const report = await evaluatePolicy(inspection, policyEvalInput);

  // Filter checks/registrations to the requested id when provided.
  const checks = id
    ? report.checks.filter((c) => c.id === id || c.id.startsWith(id + ':'))
    : report.checks;
  const registration = id
    ? report.registrations.find((r) => r.id === id || r.id === `local:${id}` || r.id === `pack:${id}`) ?? null
    : null;

  // Optionally override with a synthetic evaluation when an explicit policyInput was passed.
  let extraChecks: IPolicyCheck[] = [];
  if (policyInput && id) {
    const { decls } = await loadLocalPolicyChecks(inspection);
    const match = decls.find((d) => d.check.id === id);
    if (match) {
      try {
        const evalResult = match.check.evaluate({
          projectRoot: policyInput.projectRoot ?? inspection.projectRoot,
          planTargets: policyInput.planTargets ?? [],
          bundleAffectedFiles: policyInput.bundleAffectedFiles ?? [],
        });
        if (evalResult !== true) {
          const detail =
            typeof evalResult === 'object'
              ? evalResult
              : { message: 'Policy check failed (synthetic fixture)' };
          extraChecks.push({
            id: match.check.id,
            title: match.check.title,
            severity: match.check.severity ?? PolicySeverity.Warning,
            checkType: match.check.checkType ?? ('path' as never),
            message: detail.message,
            ...(detail.suggestedFix ? { suggestedFix: detail.suggestedFix } : {}),
            ...(detail.context ? { context: detail.context } : {}),
          });
        }
        evidence.push(`evaluated ${match.check.id} against fixture input`);
      } catch (e) {
        extraChecks.push({
          id: `${match.check.id}:error`,
          title: match.check.title,
          severity: PolicySeverity.Warning,
          checkType: match.check.checkType ?? ('path' as never),
          message: `Policy check threw: ${(e as Error).message}`,
        });
      }
    }
  }
  const allChecks = [...checks, ...extraChecks];
  const passed = allChecks.length === 0;
  const result: Omit<IPolicyTestResult, 'expectation' | 'expectationOutcome'> = {
    policyId: id ?? '<all>',
    passed,
    inputSource: source,
    evidence,
    checks: allChecks,
    registration,
  };
  const outcome = evaluateExpectation(result, expected);
  return {
    ...result,
    ...(expected ? { expectation: expected } : {}),
    ...(outcome ? { expectationOutcome: outcome } : {}),
  };
}

export interface IPolicySnapshot {
  schema: typeof POLICY_SNAPSHOT_SCHEMA;
  policyId: string;
  inputHash: string;
  capturedAt: string;
  passed: boolean;
  severityHighest: PolicySeverity | null;
  /** First message of the first emitted check. */
  message: string | null;
  /** Concise evidence summary. */
  evidence: readonly string[];
}

export interface IPolicySnapshotInput {
  /** Where the snapshot file lives. */
  snapshotFile: string;
  /** When true, write a new snapshot regardless of current state. */
  updateSnapshot?: boolean;
}

export interface IPolicySnapshotOutcome {
  schema: typeof POLICY_SNAPSHOT_SCHEMA;
  policyId: string;
  inputSource: string;
  snapshotFile: string;
  /** Current run result (re-uses the policy-test machinery). */
  result: IPolicyTestResult;
  snapshot: IPolicySnapshot;
  /** When false, the current run differs from the saved snapshot. */
  matchesSnapshot: boolean;
  /** When updateSnapshot was set and a new snapshot was written. */
  updated: boolean;
  diffs: readonly string[];
}

function hashInput(input: NonNullable<IPolicyTestInput['policyInput']>): string {
  const canon = JSON.stringify({
    projectRoot: input.projectRoot ?? '',
    planTargets: [...(input.planTargets ?? [])].sort(),
    bundleAffectedFiles: [...(input.bundleAffectedFiles ?? [])].sort(),
  });
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

function summarizeChecks(checks: readonly IPolicyCheck[]): {
  severityHighest: PolicySeverity | null;
  message: string | null;
  evidence: string[];
} {
  if (checks.length === 0) return { severityHighest: null, message: null, evidence: [] };
  let max: PolicySeverity = PolicySeverity.Info;
  for (const c of checks) {
    if (severityRank(c.severity) > severityRank(max)) max = c.severity;
  }
  return {
    severityHighest: max,
    message: checks[0]!.message,
    evidence: checks.slice(0, 5).map((c) => `[${c.severity}] ${c.id}`),
  };
}

function snapshotsEqual(a: IPolicySnapshot, b: IPolicySnapshot): string[] {
  const diffs: string[] = [];
  if (a.passed !== b.passed) diffs.push(`passed: ${a.passed} → ${b.passed}`);
  if (a.severityHighest !== b.severityHighest)
    diffs.push(`severityHighest: ${a.severityHighest ?? 'null'} → ${b.severityHighest ?? 'null'}`);
  if ((a.message ?? '') !== (b.message ?? ''))
    diffs.push(`message: "${a.message ?? ''}" → "${b.message ?? ''}"`);
  if (JSON.stringify(a.evidence) !== JSON.stringify(b.evidence))
    diffs.push('evidence: changed');
  if (a.inputHash !== b.inputHash)
    diffs.push(`inputHash: ${a.inputHash} → ${b.inputHash}`);
  return diffs;
}

export async function runPolicySnapshot(
  inspection: ISharkcraftInspection,
  testInput: IPolicyTestInput,
  snapshot: IPolicySnapshotInput,
): Promise<IPolicySnapshotOutcome> {
  const result = await runPolicyTest(inspection, testInput);
  const policyInput = testInput.policyInput ?? {
    projectRoot: inspection.projectRoot,
    planTargets: [],
    bundleAffectedFiles: [],
  };
  const summary = summarizeChecks(result.checks);
  const next: IPolicySnapshot = {
    schema: POLICY_SNAPSHOT_SCHEMA,
    policyId: result.policyId,
    inputHash: hashInput(policyInput),
    capturedAt: new Date().toISOString(),
    passed: result.passed,
    severityHighest: summary.severityHighest,
    message: summary.message,
    evidence: summary.evidence,
  };

  let saved: IPolicySnapshot | null = null;
  if (existsSync(snapshot.snapshotFile)) {
    try {
      saved = JSON.parse(readFileSync(snapshot.snapshotFile, 'utf8')) as IPolicySnapshot;
    } catch {
      saved = null;
    }
  }

  let matchesSnapshot = true;
  let diffs: string[] = [];
  if (saved) {
    diffs = snapshotsEqual(saved, next);
    matchesSnapshot = diffs.length === 0;
  } else {
    matchesSnapshot = false;
    diffs = ['no snapshot found'];
  }

  let updated = false;
  if (snapshot.updateSnapshot || !saved) {
    // Snapshot writes always live under fixture dir / caller-specified location;
    // never under project source. Create parent dirs but only mkdir, never resolve outside.
    mkdirSync(nodePath.dirname(snapshot.snapshotFile), { recursive: true });
    writeFileSync(snapshot.snapshotFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
    updated = true;
    if (snapshot.updateSnapshot) matchesSnapshot = true;
  }

  return {
    schema: POLICY_SNAPSHOT_SCHEMA,
    policyId: result.policyId,
    inputSource: result.inputSource,
    snapshotFile: snapshot.snapshotFile,
    result,
    snapshot: next,
    matchesSnapshot,
    updated,
    diffs,
  };
}

export async function runPolicyTestsForAll(
  inspection: ISharkcraftInspection,
  options: { fixtureDir?: string } = {},
): Promise<IPolicyTestBatch> {
  const dir = options.fixtureDir;
  const results: IPolicyTestResult[] = [];
  if (!dir) {
    // Run every registered policy with no fixture.
    const report = await evaluatePolicy(inspection);
    for (const reg of report.registrations) {
      const checks = report.checks.filter((c) => c.id === reg.id || c.id.startsWith(reg.id + ':'));
      results.push({
        policyId: reg.id,
        passed: checks.length === 0,
        inputSource: 'live',
        evidence: [],
        checks,
        registration: reg,
      });
    }
  } else {
    // Iterate over <dir>/<policyId>/ subfolders.
    const subdirs = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
      : [];
    for (const sub of subdirs) {
      const fixturePath = nodePath.join(dir, sub.name);
      results.push(
        await runPolicyTest(inspection, { policyId: sub.name, fixtureDir: fixturePath }),
      );
    }
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    schema: POLICY_TEST_SCHEMA,
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
    },
  };
}
