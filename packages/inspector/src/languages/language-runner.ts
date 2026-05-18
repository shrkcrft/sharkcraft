/**
 * Safe language command runner.
 *
 * Produces a `ILanguageRunPlan` describing the per-language commands the user
 * is about to run, then (optionally, with `--execute`) shells them out. The
 * MCP surface is plan-only — execution is CLI-only and never auto-runs
 * install/publish/deploy.
 *
 * Hard rules:
 *  - dry-run is the default; execution requires explicit `--execute`.
 *  - install / restore commands require `--allow-install`.
 *  - publish / deploy / push / release / clean -A / sudo / curl|bash are
 *    refused outright, even when the install allowlist is set.
 *  - the runner never resolves arbitrary user-provided commands; it only
 *    selects commands from `buildLanguageCommandReport`.
 */
import * as nodePath from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LanguageId } from './language-id.ts';
import { buildLanguageCommandReport, type ILanguageCommandReport, type ILanguageCommandSet } from './command-inference.ts';
import type { ILanguageProfileReport } from './language-detection.ts';

export const LANGUAGE_RUN_PLAN_SCHEMA = 'sharkcraft.language-run-plan/v1';

export type LanguageRunCategory = 'test' | 'build' | 'lint' | 'format' | 'check' | 'typecheck' | 'package' | 'run' | 'install' | 'restore' | 'all';

export interface ILanguageRunStep {
  language: LanguageId;
  category: LanguageRunCategory;
  command: string;
  /** True when the command is install/restore — gated behind --allow-install. */
  installLike: boolean;
  /** Skipped reason, e.g. "no test command for python (no pytest)". */
  skipped?: string;
}

export interface ILanguageRunResult {
  step: ILanguageRunStep;
  ranAt: string;
  durationMs: number;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface ILanguageRunPlan {
  schema: typeof LANGUAGE_RUN_PLAN_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  dryRun: boolean;
  allowInstall: boolean;
  selectedCommandId?: string;
  selectedCategory?: LanguageRunCategory;
  steps: readonly ILanguageRunStep[];
  refusedSteps: readonly { command: string; reason: string }[];
  results?: readonly ILanguageRunResult[];
  notes: readonly string[];
}

export interface IBuildLanguageRunPlanOptions {
  projectRoot: string;
  /** Reuse a cached profile report. */
  cached?: ILanguageProfileReport;
  /** Reuse a pre-computed command report (avoids double detection). */
  commandReport?: ILanguageCommandReport;
  /** One specific category to run; default `test`. */
  category?: LanguageRunCategory;
  /** Run every available category (per language). */
  allTests?: boolean;
  /** Restrict to a single language. */
  language?: LanguageId;
  /** Specific command id like `java.test` to disambiguate from category. */
  commandId?: string;
  /** When true, execute the commands instead of returning a plan only. */
  execute?: boolean;
  /** Required to run install/restore commands. */
  allowInstall?: boolean;
  /** Override the execution timeout per command, ms. Default 600000. */
  timeoutMs?: number;
}

const REFUSED_PATTERNS: readonly RegExp[] = [
  /\bpublish\b/i,
  /\bdeploy\b/i,
  /\brelease\b/i,
  /\bpush\b/i,
  /\brm\s+-rf\s+\//, // `rm -rf /...`
  /\bsudo\b/i,
  /\bcurl[^|]*\|\s*bash/i,
  /\bwget[^|]*\|\s*sh/i,
  /\bnpm\s+publish\b/i,
  /\bbun\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\byarn\s+publish\b/i,
  /\bgit\s+push\s+--?\w*\bforce\b/i,
];

// Allowlist/denylist loaded from `sharkcraft/runner.allowlist.json`.
export interface ILanguageRunnerAllowlistEntry {
  id?: string;
  command: string;
  reason?: string;
}

export interface ILanguageRunnerDenylistEntry {
  pattern: string;
  reason?: string;
}

export interface ILanguageRunnerPolicy {
  schema: 'sharkcraft.language-runner-policy/v1';
  source: 'config' | 'builtin';
  allow: ReadonlyArray<ILanguageRunnerAllowlistEntry>;
  deny: ReadonlyArray<ILanguageRunnerDenylistEntry>;
  builtinDeny: ReadonlyArray<string>;
}

function loadAllowlistConfig(projectRoot: string): {
  allow: ILanguageRunnerAllowlistEntry[];
  deny: ILanguageRunnerDenylistEntry[];
} {
  const file = nodePath.join(projectRoot, 'sharkcraft', 'runner.allowlist.json');
  if (!existsSync(file)) return { allow: [], deny: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      allow?: ILanguageRunnerAllowlistEntry[];
      deny?: ILanguageRunnerDenylistEntry[];
    };
    return {
      allow: Array.isArray(raw.allow) ? raw.allow : [],
      deny: Array.isArray(raw.deny) ? raw.deny : [],
    };
  } catch {
    return { allow: [], deny: [] };
  }
}

export function getLanguageRunnerPolicy(projectRoot: string): ILanguageRunnerPolicy {
  const { allow, deny } = loadAllowlistConfig(projectRoot);
  return {
    schema: 'sharkcraft.language-runner-policy/v1',
    source: allow.length + deny.length > 0 ? 'config' : 'builtin',
    allow,
    deny,
    builtinDeny: REFUSED_PATTERNS.map((re) => re.source),
  };
}

export interface ILanguageRunnerDecision {
  allowed: boolean;
  source: 'builtin-deny' | 'config-deny' | 'config-allow' | 'no-rule';
  rule: string;
  reason?: string;
}

export function explainCommandPolicy(
  command: string,
  projectRoot: string,
): ILanguageRunnerDecision {
  // 1) Built-in deny always wins.
  for (const re of REFUSED_PATTERNS) {
    if (re.test(command)) {
      return {
        allowed: false,
        source: 'builtin-deny',
        rule: re.source,
        reason: 'built-in dangerous pattern',
      };
    }
  }
  const { allow, deny } = loadAllowlistConfig(projectRoot);
  // 2) Config deny.
  for (const d of deny) {
    try {
      const re = new RegExp(d.pattern, 'i');
      if (re.test(command)) {
        return {
          allowed: false,
          source: 'config-deny',
          rule: d.pattern,
          ...(d.reason ? { reason: d.reason } : {}),
        };
      }
    } catch {
      /* skip invalid regex */
    }
  }
  // 3) Config allow.
  for (const a of allow) {
    if (a.command === command) {
      return {
        allowed: true,
        source: 'config-allow',
        rule: a.id ?? a.command,
        ...(a.reason ? { reason: a.reason } : {}),
      };
    }
  }
  return { allowed: true, source: 'no-rule', rule: '(no matching rule)' };
}

function isRefused(command: string, projectRoot?: string): string | null {
  // Built-in deny first.
  for (const re of REFUSED_PATTERNS) {
    if (re.test(command)) return `command matches refused pattern ${re.source}`;
  }
  // Config deny.
  if (projectRoot) {
    const { deny } = loadAllowlistConfig(projectRoot);
    for (const d of deny) {
      try {
        const re = new RegExp(d.pattern, 'i');
        if (re.test(command)) return `command matches config deny pattern ${d.pattern}${d.reason ? ` (${d.reason})` : ''}`;
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

function isInstallLike(command: string): boolean {
  return /\b(install|restore|fetch|sync|mod\s+download|cargo\s+fetch|dotnet\s+restore|poetry\s+install|uv\s+sync|bun\s+install|pnpm\s+install|npm\s+ci|npm\s+install|yarn\s+install)\b/i.test(command);
}

function commandFromSet(set: ILanguageCommandSet, category: LanguageRunCategory): string | undefined {
  switch (category) {
    case 'install': return set.install;
    case 'restore': return set.restore ?? set.install;
    case 'typecheck': return set.typecheck;
    case 'test': return set.test;
    case 'lint': return set.lint;
    case 'format': return set.format;
    case 'build': return set.build;
    case 'package': return set.package;
    case 'run': return set.run;
    case 'check': return set.typecheck ?? set.lint ?? set.test;
    case 'all': return undefined;
    default: return undefined;
  }
}

function allCategoriesFor(set: ILanguageCommandSet): readonly LanguageRunCategory[] {
  const out: LanguageRunCategory[] = [];
  if (set.typecheck) out.push('typecheck');
  if (set.lint) out.push('lint');
  if (set.test) out.push('test');
  if (set.build) out.push('build');
  return out;
}

export function buildLanguageRunPlan(
  options: IBuildLanguageRunPlanOptions,
): ILanguageRunPlan {
  const projectRoot = options.projectRoot;
  const commandReport = options.commandReport ?? buildLanguageCommandReport(projectRoot, options.cached);

  const category = options.category ?? 'test';
  const wantLanguage = options.language;
  const commandId = options.commandId;

  const allTests = !!options.allTests;
  const steps: ILanguageRunStep[] = [];
  const refusedSteps: { command: string; reason: string }[] = [];

  for (const set of commandReport.profiles) {
    if (wantLanguage && set.language !== wantLanguage) continue;
    if (commandId) {
      // Convention: <language>.<category>
      const [lang, cat] = commandId.split('.');
      if (!lang || !cat) continue;
      if (lang !== set.language) continue;
      const cmd = commandFromSet(set, cat as LanguageRunCategory);
      if (cmd) {
        const refusedReason = isRefused(cmd, projectRoot);
        if (refusedReason) {
          refusedSteps.push({ command: cmd, reason: refusedReason });
          continue;
        }
        steps.push({ language: set.language, category: cat as LanguageRunCategory, command: cmd, installLike: isInstallLike(cmd) });
      }
      continue;
    }
    const categories: readonly LanguageRunCategory[] = allTests ? ['test'] : (category === 'all' ? allCategoriesFor(set) : [category]);
    for (const cat of categories) {
      const cmd = commandFromSet(set, cat);
      if (!cmd) continue;
      const refusedReason = isRefused(cmd, projectRoot);
      if (refusedReason) {
        refusedSteps.push({ command: cmd, reason: refusedReason });
        continue;
      }
      const installLike = isInstallLike(cmd);
      const step: ILanguageRunStep = { language: set.language, category: cat, command: cmd, installLike };
      if (installLike && !options.allowInstall) {
        step.skipped = 'install/restore commands require --allow-install';
      }
      steps.push(step);
    }
  }

  const notes: string[] = [];
  if (refusedSteps.length > 0) notes.push(`Refused ${refusedSteps.length} potentially-destructive command(s).`);
  if (steps.length === 0) notes.push('No matching language commands found.');
  if (!options.execute) notes.push('Dry-run: no commands were executed. Pass --execute to run.');

  const dryRun = !options.execute;
  const allowInstall = !!options.allowInstall;

  const plan: ILanguageRunPlan = {
    schema: LANGUAGE_RUN_PLAN_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    dryRun,
    allowInstall,
    ...(commandId ? { selectedCommandId: commandId } : {}),
    ...(category && !commandId ? { selectedCategory: category } : {}),
    steps,
    refusedSteps,
    notes,
  };

  if (!options.execute) return plan;

  const timeoutMs = options.timeoutMs ?? 600_000;
  const results: ILanguageRunResult[] = [];
  for (const step of steps) {
    if (step.skipped) continue;
    const ranAt = new Date().toISOString();
    const start = Date.now();
    const proc = spawnSync(step.command, [], {
      cwd: projectRoot,
      shell: true,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: process.env,
    });
    const durationMs = Date.now() - start;
    const stdoutTail = trimTail(proc.stdout ?? '');
    const stderrTail = trimTail(proc.stderr ?? '');
    results.push({
      step,
      ranAt,
      durationMs,
      exitCode: typeof proc.status === 'number' ? proc.status : (proc.signal ? 128 : -1),
      stdoutTail,
      stderrTail,
    });
  }
  return { ...plan, dryRun: false, results };
}

function trimTail(s: string): string {
  if (s.length <= 4096) return s;
  return '… (truncated) …\n' + s.slice(s.length - 4096);
}

export function renderLanguageRunPlanText(plan: ILanguageRunPlan): string {
  let out = `=== Language run plan ===\n`;
  out += `  project root  ${plan.projectRoot}\n`;
  out += `  dry-run       ${plan.dryRun ? 'yes' : 'no'}\n`;
  out += `  steps         ${plan.steps.length}\n`;
  if (plan.steps.length === 0) {
    out += `  (no commands selected)\n`;
  } else {
    out += `\nSteps:\n`;
    for (const s of plan.steps) {
      const tag = s.skipped ? `[SKIPPED ${s.skipped}]` : '[OK]';
      out += `  ${tag} ${s.language}.${s.category}  →  ${s.command}\n`;
    }
  }
  if (plan.refusedSteps.length > 0) {
    out += `\nRefused:\n`;
    for (const r of plan.refusedSteps) out += `  - ${r.command}  (${r.reason})\n`;
  }
  if (plan.results) {
    out += `\nResults:\n`;
    for (const r of plan.results) {
      const status = r.exitCode === 0 ? 'PASS' : 'FAIL';
      out += `  [${status}] ${r.step.language}.${r.step.category} (${r.durationMs}ms)\n`;
      if (r.stderrTail) out += `    stderr: ${r.stderrTail.split('\n').slice(-3).join(' / ')}\n`;
    }
  }
  if (plan.notes.length > 0) {
    out += `\nNotes:\n`;
    for (const n of plan.notes) out += `  - ${n}\n`;
  }
  // Always include the next-command hint (for MCP read-only callers).
  out += `\nnext-command: shrk languages run --execute  # CLI-only`;
  return out + '\n';
}

export function renderLanguageRunPlanMarkdown(plan: ILanguageRunPlan): string {
  const lines: string[] = [];
  lines.push('# Language run plan');
  lines.push('');
  lines.push(`- Project root: \`${plan.projectRoot}\``);
  lines.push(`- Dry-run: **${plan.dryRun ? 'yes' : 'no'}**`);
  lines.push(`- Steps: **${plan.steps.length}**`);
  if (plan.steps.length > 0) {
    lines.push('');
    lines.push('| Language | Category | Command | Status |');
    lines.push('|---|---|---|---|');
    for (const s of plan.steps) {
      lines.push(`| \`${s.language}\` | \`${s.category}\` | \`${s.command}\` | ${s.skipped ? 'skipped: ' + s.skipped : 'planned'} |`);
    }
  }
  if (plan.refusedSteps.length > 0) {
    lines.push('');
    lines.push('## Refused');
    lines.push('');
    for (const r of plan.refusedSteps) lines.push(`- \`${r.command}\` — ${r.reason}`);
  }
  if (plan.results) {
    lines.push('');
    lines.push('## Results');
    lines.push('');
    for (const r of plan.results) {
      lines.push(`- ${r.exitCode === 0 ? '✅' : '❌'} \`${r.step.command}\` — exit=${r.exitCode}, ${r.durationMs}ms`);
    }
  }
  if (plan.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    for (const n of plan.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

export function renderLanguageRunPlanJson(plan: ILanguageRunPlan): string {
  return JSON.stringify(plan, null, 2);
}

/** Quick helper: produce the report path that --report would land at. */
export function defaultLanguageRunReportPath(projectRoot: string, generatedAt: string): string {
  const stamp = generatedAt.replace(/[:.]/g, '-');
  return nodePath.join(projectRoot, '.sharkcraft', 'reports', `language-run-${stamp}.json`);
}
