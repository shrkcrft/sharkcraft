/**
 * Release smoke harness.
 *
 * Runs a safe, local, deterministic smoke suite against SharkCraft's own
 * surfaces. The harness does NOT execute external commands itself — it
 * declares the scenarios in a structured form so the CLI can run them
 * with the inherited environment, and validates expected artifacts.
 *
 * This module is the planner. The CLI command wires it to actual `bun`
 * subprocess invocations under a temp fixture root.
 *
 * Constraints (must hold):
 *  - never publishes
 *  - never calls the network
 *  - never calls external APIs
 *  - never runs `rm -rf`, `dd`, `mkfs`
 *  - writes only under the per-scenario temp dir (or the user-specified --temp-dir)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

export const RELEASE_SMOKE_SCHEMA = 'sharkcraft.release-smoke/v1';

export type SmokeScenarioId =
  | 'unconfigured-repo'
  | 'dev-workflow'
  | 'pr-review'
  | 'governance'
  | 'pack-authoring';

export type SmokeAssertionType =
  | 'stdout-contains'
  | 'stderr-not-contains'
  | 'json-path-exists'
  | 'file-exists'
  | 'file-contains'
  | 'output-not-empty';

export interface ISmokeAssertion {
  type: SmokeAssertionType;
  /** Pattern (stdout/stderr/file-contains) or path-relative-to-fixture (file-exists). */
  value?: string;
  /** Dotted path for json-path-exists (e.g. `summary.totalChanges`). */
  jsonPath?: string;
  /** When true, capture step stdout, parse as JSON, then walk jsonPath. */
  fromStdoutJson?: boolean;
  /** Relative path within fixture root (file-exists / file-contains). */
  file?: string;
  /** When true, failure marks the step as failed. Default true. */
  required?: boolean;
  /** Human note shown in the report. */
  note?: string;
}

export interface ISmokeStep {
  /** Short human-readable label for the step. */
  title: string;
  /** Command tokens (NOT a shell string). Used to spawn directly. */
  command: readonly string[];
  /** Allowed exit codes (defaults to [0]). */
  allowedExitCodes?: readonly number[];
  /** Files/directories that must exist after the step (relative to fixtureRoot). */
  expectArtifacts?: readonly string[];
  /** Files/directories that must NOT exist after the step (safety guard). */
  forbidArtifacts?: readonly string[];
  /** Content assertions evaluated after the step finishes. */
  assertions?: readonly ISmokeAssertion[];
  /** Note for reviewers — shown verbatim. */
  notes?: string;
}

export interface ISmokeAssertionResult {
  assertion: ISmokeAssertion;
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
}

export interface ISmokeScenario {
  id: SmokeScenarioId;
  title: string;
  description: string;
  /** Setup steps that prepare the fixture before the scenario runs. */
  setup: readonly ISmokeStep[];
  /** Main steps. */
  steps: readonly ISmokeStep[];
  /** Expected artifact directories at the end of the run. */
  expectArtifacts: readonly string[];
}

export interface ISmokeStepResult {
  step: ISmokeStep;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  status: 'pass' | 'fail' | 'skipped';
  stdoutTail: string;
  stderrTail: string;
  artifactsFound: readonly string[];
  artifactsMissing: readonly string[];
  forbiddenArtifactsFound: readonly string[];
  /** Per-assertion results. */
  assertionResults?: readonly ISmokeAssertionResult[];
}

export interface ISmokeScenarioResult {
  scenarioId: SmokeScenarioId;
  fixtureRoot: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'pass' | 'fail';
  steps: readonly ISmokeStepResult[];
}

export interface IReleaseSmokeReport {
  schema: typeof RELEASE_SMOKE_SCHEMA;
  generatedAt: string;
  scenarios: readonly ISmokeScenarioResult[];
  totalDurationMs: number;
  passed: boolean;
}

const SCENARIOS: Record<SmokeScenarioId, ISmokeScenario> = {
  'unconfigured-repo': {
    id: 'unconfigured-repo',
    title: 'Unconfigured repo onboarding',
    description: 'Create a minimal Bun/TS repo and onboard SharkCraft.',
    setup: [
      {
        title: 'Initialise fixture package.json',
        command: ['__fixture__:init-unconfigured'],
        notes: 'Inline fixture step (no external command).',
      },
    ],
    steps: [
      {
        title: 'Onboard dry-run',
        command: ['shrk', 'onboard', '--dry-run'],
        assertions: [
          { type: 'stdout-contains', value: 'onboard', required: false, note: 'onboard ran' },
          { type: 'output-not-empty', required: true },
        ],
      },
      {
        title: 'Doctor',
        command: ['shrk', 'doctor'],
        // doctor exits non-zero in an unconfigured repo by design; both 0 and 1 are OK here.
        allowedExitCodes: [0, 1],
        assertions: [
          { type: 'stdout-contains', value: 'doctor', required: false },
          { type: 'output-not-empty', required: true },
        ],
      },
    ],
    expectArtifacts: ['package.json'],
  },
  'dev-workflow': {
    id: 'dev-workflow',
    title: 'Dev workflow',
    description: 'Start a dev session against the dogfood fixture and produce a report.',
    setup: [
      {
        title: 'Initialise fixture from dogfood-target',
        command: ['__fixture__:copy-dogfood'],
      },
    ],
    steps: [
      {
        title: 'Brief',
        command: ['shrk', 'brief', 'smoke-test-task'],
        assertions: [
          { type: 'output-not-empty', required: true },
          { type: 'stdout-contains', value: 'smoke-test-task', required: false },
        ],
      },
      {
        title: 'Doctor',
        command: ['shrk', 'doctor'],
        assertions: [
          { type: 'stdout-contains', value: 'Verdict', required: false },
        ],
      },
    ],
    expectArtifacts: ['sharkcraft'],
  },
  'pr-review': {
    id: 'pr-review',
    title: 'PR review',
    description: 'Render impact + review surfaces against the dogfood fixture.',
    setup: [
      {
        title: 'Initialise fixture from dogfood-target',
        command: ['__fixture__:copy-dogfood'],
      },
    ],
    steps: [
      {
        title: 'Impact (JSON)',
        command: ['shrk', 'impact', '--format', 'json'],
        assertions: [
          { type: 'json-path-exists', jsonPath: 'schema', fromStdoutJson: true, required: false },
          { type: 'output-not-empty', required: true },
        ],
      },
      {
        title: 'Report site',
        command: ['shrk', 'report', 'site', '--output', '.sharkcraft/reports/site'],
        expectArtifacts: ['.sharkcraft/reports/site/index.html'],
        assertions: [
          { type: 'file-exists', file: '.sharkcraft/reports/site/index.html', required: true },
        ],
      },
    ],
    expectArtifacts: ['.sharkcraft'],
  },
  governance: {
    id: 'governance',
    title: 'Governance',
    description: 'Run quality, commands doctor, runtime doctor, safety audit, release readiness.',
    setup: [
      {
        title: 'Initialise fixture from dogfood-target',
        command: ['__fixture__:copy-dogfood'],
      },
    ],
    steps: [
      { title: 'Quality', command: ['shrk', 'quality'], assertions: [{ type: 'output-not-empty', required: true }] },
      {
        title: 'Commands doctor',
        command: ['shrk', 'commands', 'doctor'],
        assertions: [
          { type: 'stdout-contains', value: 'errors:', required: false, note: 'doctor mentions error count' },
        ],
      },
      { title: 'Safety audit', command: ['shrk', 'safety', 'audit'], assertions: [{ type: 'output-not-empty', required: false }] },
      {
        title: 'Release readiness',
        command: ['shrk', 'release', 'readiness'],
        assertions: [
          { type: 'stdout-contains', value: 'Verdict', required: false },
        ],
      },
    ],
    expectArtifacts: [],
  },
  'pack-authoring': {
    id: 'pack-authoring',
    title: 'Pack authoring',
    description: 'Scaffold a demo pack and run release-check + compat against it.',
    setup: [
      {
        title: 'Initialise empty fixture',
        command: ['__fixture__:init-empty-pack-root'],
      },
    ],
    steps: [
      {
        title: 'Pack release check (smoke)',
        command: ['shrk', 'packs', 'doctor', '--release'],
        allowedExitCodes: [0, 1],
        assertions: [
          { type: 'stdout-contains', value: 'Pack', required: false },
        ],
      },
    ],
    expectArtifacts: [],
  },
};

export function listSmokeScenarios(): SmokeScenarioId[] {
  return Object.keys(SCENARIOS) as SmokeScenarioId[];
}

export function getSmokeScenario(id: SmokeScenarioId): ISmokeScenario {
  const s = SCENARIOS[id];
  if (!s) throw new Error(`Unknown smoke scenario: ${id}`);
  return s;
}

export function pickScenarios(scope: SmokeScenarioId | 'all'): ISmokeScenario[] {
  if (scope === 'all') return listSmokeScenarios().map((id) => SCENARIOS[id]!);
  return [getSmokeScenario(scope)];
}

export interface IFixtureCreateInput {
  scenarioId: SmokeScenarioId;
  baseDir?: string;
  /** When true, do not delete fixtures after the scenario runs. */
  keep?: boolean;
}

export interface IFixtureCreateResult {
  fixtureRoot: string;
  keep: boolean;
}

export function createFixtureRoot(input: IFixtureCreateInput): IFixtureCreateResult {
  const base = input.baseDir ?? tmpdir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const root = nodePath.join(base, `sharkcraft-smoke-${input.scenarioId}-${ts}`);
  mkdirSync(root, { recursive: true });
  return { fixtureRoot: root, keep: input.keep ?? false };
}

/** Recursively collect file paths inside a fixture (deterministic order). */
export function collectFixtureFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else out.push(nodePath.relative(root, full));
    }
  };
  walk(root);
  return out;
}

/** Source-write safety: assert no files were written outside allowed prefixes. */
const ALLOWED_WRITE_PREFIXES = [
  '.sharkcraft',
  'sharkcraft',
  'examples',
  'package.json',
  'README.md',
  'tsconfig.json',
  'bun.lock',
  'bun.lockb',
];

export function assertSafeWrites(files: readonly string[]): string[] {
  const violations: string[] = [];
  for (const f of files) {
    const allowed = ALLOWED_WRITE_PREFIXES.some((p) => f === p || f.startsWith(p + nodePath.sep) || f.startsWith(p + '/'));
    if (!allowed) violations.push(f);
  }
  return violations;
}

/** Render the smoke report as plain text. */
export function renderSmokeReportText(report: IReleaseSmokeReport): string {
  const lines: string[] = [];
  lines.push(`# Release smoke — ${report.passed ? 'PASS ✓' : 'FAIL ✕'}`);
  lines.push(`Total: ${report.scenarios.length} scenario(s), ${report.totalDurationMs}ms`);
  for (const s of report.scenarios) {
    lines.push('');
    lines.push(`## ${s.scenarioId}  [${s.status}]  (${s.durationMs}ms)`);
    lines.push(`fixture: ${s.fixtureRoot}`);
    for (const step of s.steps) {
      lines.push(`  • ${step.step.title}  [${step.status}]  exit=${step.exitCode ?? '?'}  (${step.durationMs}ms)`);
      if (step.artifactsMissing.length > 0) {
        lines.push(`    missing artifacts: ${step.artifactsMissing.join(', ')}`);
      }
      if (step.forbiddenArtifactsFound.length > 0) {
        lines.push(`    ⚠ forbidden artifacts present: ${step.forbiddenArtifactsFound.join(', ')}`);
      }
      if (step.assertionResults && step.assertionResults.length > 0) {
        const passed = step.assertionResults.filter((a) => a.status === 'pass').length;
        const failed = step.assertionResults.filter((a) => a.status === 'fail').length;
        lines.push(`    assertions: ${passed}/${step.assertionResults.length} passed${failed > 0 ? ` (${failed} failed)` : ''}`);
        for (const a of step.assertionResults) {
          if (a.status === 'fail') {
            lines.push(`      ✗ ${a.assertion.type}: ${a.detail ?? ''}`);
          }
        }
      }
      if (step.status === 'fail') {
        const tail = (step.stderrTail || step.stdoutTail).split(/\r?\n/).slice(-6).join('\n      ');
        if (tail) lines.push(`    last output:\n      ${tail}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function renderSmokeReportMarkdown(report: IReleaseSmokeReport): string {
  const lines: string[] = [];
  lines.push(`# Release smoke — ${report.passed ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Scenarios: ${report.scenarios.length}  ·  Duration: ${report.totalDurationMs}ms`);
  lines.push('');
  for (const s of report.scenarios) {
    lines.push(`## \`${s.scenarioId}\` — ${s.status.toUpperCase()}`);
    lines.push('');
    lines.push(`Fixture: \`${s.fixtureRoot}\``);
    lines.push('');
    lines.push('| Step | Status | Exit | Duration | Notes |');
    lines.push('|------|--------|------|----------|-------|');
    for (const step of s.steps) {
      const notes: string[] = [];
      if (step.artifactsMissing.length > 0) notes.push(`missing: ${step.artifactsMissing.join(', ')}`);
      if (step.forbiddenArtifactsFound.length > 0) notes.push(`⚠ ${step.forbiddenArtifactsFound.join(', ')}`);
      lines.push(
        `| ${step.step.title} | ${step.status} | ${step.exitCode ?? '?'} | ${step.durationMs}ms | ${notes.join('; ') || ''} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderSmokeReportHtml(report: IReleaseSmokeReport): string {
  const out: string[] = [];
  out.push(`<!doctype html><html><head><meta charset="utf-8"><title>Release smoke — ${report.passed ? 'PASS' : 'FAIL'}</title>`);
  out.push('<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px}h1{font-size:22px}h2{font-size:16px;margin-top:24px;border-bottom:1px solid #e1e4e8;padding-bottom:4px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}.pass{color:#1a7f37}.fail{color:#b31d28}.muted{color:#586069}@media (prefers-color-scheme: dark){body{background:#0d1117;color:#c9d1d9}th{background:#161b22}.muted{color:#8b949e}}</style></head><body>');
  out.push(`<h1>Release smoke <span class="${report.passed ? 'pass' : 'fail'}">${report.passed ? 'PASS' : 'FAIL'}</span></h1>`);
  out.push(`<p class="muted">${escHtml(report.generatedAt)} · scenarios ${report.scenarios.length} · ${report.totalDurationMs}ms</p>`);
  for (const s of report.scenarios) {
    out.push(`<h2>${escHtml(s.scenarioId)} — <span class="${s.status === 'pass' ? 'pass' : 'fail'}">${escHtml(s.status)}</span></h2>`);
    out.push(`<p class="muted">${escHtml(s.fixtureRoot)} · ${s.durationMs}ms</p>`);
    out.push('<table><thead><tr><th>Step</th><th>Status</th><th>Exit</th><th>Duration</th><th>Notes</th></tr></thead><tbody>');
    for (const step of s.steps) {
      const notes: string[] = [];
      if (step.artifactsMissing.length > 0) notes.push(`missing: ${step.artifactsMissing.join(', ')}`);
      if (step.forbiddenArtifactsFound.length > 0) notes.push(`⚠ ${step.forbiddenArtifactsFound.join(', ')}`);
      out.push(
        `<tr><td>${escHtml(step.step.title)}</td><td class="${step.status === 'pass' ? 'pass' : 'fail'}">${escHtml(step.status)}</td><td>${step.exitCode ?? '?'}</td><td>${step.durationMs}ms</td><td>${escHtml(notes.join('; '))}</td></tr>`,
      );
    }
    out.push('</tbody></table>');
  }
  out.push('</body></html>');
  return out.join('\n') + '\n';
}

export function renderSmokeReport(report: IReleaseSmokeReport, format: 'text' | 'markdown' | 'html' | 'json'): string {
  if (format === 'json') return JSON.stringify(report, null, 2) + '\n';
  if (format === 'markdown') return renderSmokeReportMarkdown(report);
  if (format === 'html') return renderSmokeReportHtml(report);
  return renderSmokeReportText(report);
}

/** Used by the CLI to confirm the fixture dir was prepared cleanly. */
export function fixtureSummary(root: string): { exists: boolean; fileCount: number; files: readonly string[] } {
  if (!existsSync(root)) return { exists: false, fileCount: 0, files: [] };
  const files = collectFixtureFiles(root);
  return { exists: true, fileCount: files.length, files };
}

/**
 * Walk a dotted JSON path and report whether the leaf exists.
 * `a.b.c` walks into nested objects; numeric segments index arrays.
 */
function hasJsonPath(value: unknown, path: string): boolean {
  if (!path) return value !== undefined;
  const parts = path.split('.');
  let cursor: unknown = value;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return false;
    if (typeof cursor !== 'object') return false;
    const idx = Number(part);
    if (Number.isInteger(idx) && Array.isArray(cursor)) {
      cursor = (cursor as readonly unknown[])[idx];
    } else {
      cursor = (cursor as Record<string, unknown>)[part];
    }
  }
  return cursor !== undefined;
}

export interface IEvaluateAssertionInput {
  assertion: ISmokeAssertion;
  stdout: string;
  stderr: string;
  fixtureRoot: string;
}

/**
 * Evaluate a single assertion. Pure — uses fs only for `file-*` types.
 */
export function evaluateSmokeAssertion(input: IEvaluateAssertionInput): ISmokeAssertionResult {
  const a = input.assertion;
  const required = a.required ?? true;
  const pass = (detail?: string): ISmokeAssertionResult => ({
    assertion: a,
    status: 'pass',
    ...(detail ? { detail } : {}),
  });
  const fail = (detail: string): ISmokeAssertionResult => ({
    assertion: a,
    status: required ? 'fail' : 'skipped',
    detail,
  });
  switch (a.type) {
    case 'stdout-contains': {
      if (!a.value) return fail('stdout-contains requires `value`');
      return input.stdout.includes(a.value)
        ? pass()
        : fail(`stdout did not contain "${a.value.slice(0, 80)}"`);
    }
    case 'stderr-not-contains': {
      if (!a.value) return pass();
      return input.stderr.includes(a.value)
        ? fail(`stderr contained "${a.value.slice(0, 80)}"`)
        : pass();
    }
    case 'output-not-empty': {
      const combined = (input.stdout + input.stderr).trim();
      return combined.length > 0 ? pass() : fail('combined output was empty');
    }
    case 'file-exists': {
      if (!a.file) return fail('file-exists requires `file`');
      const full = nodePath.join(input.fixtureRoot, a.file);
      return existsSync(full) ? pass(full) : fail(`missing file: ${a.file}`);
    }
    case 'file-contains': {
      if (!a.file || !a.value) return fail('file-contains requires `file` and `value`');
      const full = nodePath.join(input.fixtureRoot, a.file);
      if (!existsSync(full)) return fail(`missing file: ${a.file}`);
      try {
        const body = readFileSync(full, 'utf8');
        return body.includes(a.value) ? pass() : fail(`file did not contain "${a.value.slice(0, 60)}"`);
      } catch (e) {
        return fail(`could not read ${a.file}: ${(e as Error).message}`);
      }
    }
    case 'json-path-exists': {
      if (!a.jsonPath) return fail('json-path-exists requires `jsonPath`');
      if (a.fromStdoutJson) {
        try {
          // Some CLI commands prepend a banner (`$ ...`) before the JSON body.
          const candidate = input.stdout.trim();
          const start = candidate.indexOf('{');
          if (start < 0) return fail('stdout did not contain a JSON object');
          const parsed = JSON.parse(candidate.slice(start));
          return hasJsonPath(parsed, a.jsonPath)
            ? pass()
            : fail(`stdout JSON did not have path "${a.jsonPath}"`);
        } catch (e) {
          return fail(`stdout was not JSON: ${(e as Error).message}`);
        }
      }
      if (!a.file) return fail('json-path-exists requires `file` or `fromStdoutJson`');
      const full = nodePath.join(input.fixtureRoot, a.file);
      if (!existsSync(full)) return fail(`missing file: ${a.file}`);
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf8'));
        return hasJsonPath(parsed, a.jsonPath)
          ? pass()
          : fail(`file JSON did not have path "${a.jsonPath}"`);
      } catch (e) {
        return fail(`could not parse ${a.file}: ${(e as Error).message}`);
      }
    }
    default:
      return fail(`unknown assertion type ${(a as { type: string }).type}`);
  }
}
