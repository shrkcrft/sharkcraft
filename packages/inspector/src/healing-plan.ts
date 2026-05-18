/**
 * Self-healing plans.
 *
 * Given a stderr blob, failed report/plan, or command exit-code, produce a
 * deterministic recovery plan. Never auto-fixes; never writes source.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildDiagnosticByCode,
  listDiagnostics,
  type FailureDiagnosticCode,
  type IFailureDiagnostic,
} from './failure-diagnostics.ts';
import { suggestDiagnostic } from './diagnostics-suggest.ts';

export const HEALING_PLAN_SCHEMA = 'sharkcraft.healing-plan/v1';

export enum HealingInputKind {
  Error = 'error',
  File = 'file',
  Report = 'report',
  Command = 'command',
}

export interface IHealingPlan {
  schema: typeof HEALING_PLAN_SCHEMA;
  generatedAt: string;
  inputKind: HealingInputKind;
  inputSummary: string;
  detectedDiagnostics: readonly IFailureDiagnostic[];
  confidence: 'low' | 'medium' | 'high';
  likelyCauses: readonly string[];
  safeRecoverySteps: readonly string[];
  forbiddenQuickFixes: readonly string[];
  recommendedCommands: readonly string[];
  relatedConstructs: readonly string[];
  relatedDocs: readonly string[];
  humanApprovalRequired: boolean;
  sourceWritesInvolved: boolean;
  nextSafestCommand: string;
  notes: readonly string[];
}

interface IBuildContext {
  inputKind: HealingInputKind;
  inputSummary: string;
  text: string;
  exitCode?: number;
  command?: string;
}

const GENERIC_NEXT = 'shrk diagnostics suggest "<paste error text here>"';

function inferFromKeywords(text: string): { causes: string[]; recover: string[]; cmds: string[]; constructs: string[]; docs: string[]; humanApproval: boolean; sourceWrite: boolean } {
  const causes: string[] = [];
  const recover: string[] = [];
  const cmds: string[] = [];
  const constructs: string[] = [];
  const docs: string[] = [];
  let humanApproval = false;
  let sourceWrite = false;
  const lower = text.toLowerCase();

  // Plan conflicts.
  if (lower.includes('conflict') || lower.includes('anchor not found')) {
    causes.push('Saved plan has a conflict: file already exists, anchor missing, or replace mismatch.');
    recover.push('Review the saved plan and inspect anchors / target files.');
    cmds.push('shrk plan review <plan.json>');
    cmds.push('shrk plan simulate <plan.json> --include-boundaries --include-impact');
    cmds.push('shrk plan simulate <plan.json> --format markdown --output /tmp/plan-sim.md');
    constructs.push('plan v2 operations: append / insert-after / insert-before / replace / export');
    docs.push('docs/plan-simulation.md');
  }

  // Missing barrel / anchor.
  if (lower.includes('barrel') || lower.includes('export *') || lower.includes('missing anchor')) {
    causes.push('Missing barrel or anchor in the target file.');
    recover.push('Open the barrel/index file referenced by the plan and confirm the anchor exists exactly once.');
    cmds.push('grep -n "<anchor text>" <barrel file>');
  }

  // Pack signing missing secret.
  if (
    lower.includes('signing') ||
    lower.includes('hmac') ||
    lower.includes('signature') ||
    lower.includes('packs sign') ||
    lower.includes('signed.json')
  ) {
    causes.push('Pack signing failed: secret missing or signature mismatch.');
    recover.push('Provide the signing secret via the CLI (do not commit it).');
    cmds.push('shrk packs sign <packPath> --secret-env SHARKCRAFT_PACK_SIGNING_KEY');
    cmds.push('shrk packs verify');
    humanApproval = true;
    docs.push('docs/security.md');
  }

  // Migration readiness.
  if (lower.includes('migration') && (lower.includes('readiness') || lower.includes('blocker'))) {
    causes.push('Migration readiness gate reported a blocker.');
    recover.push('Resolve each blocker before re-running the gate.');
    cmds.push('shrk migration readiness --profile <id>');
    cmds.push('shrk migration profiles');
    docs.push('docs/migration-readiness.md');
  }

  // Unknown command.
  if (lower.includes('unknown command') || lower.includes('command not found') || lower.includes('not a known')) {
    causes.push('Unknown shrk command (alias / typo / removed command).');
    recover.push('List supported commands; do not invent commands.');
    cmds.push('shrk --help');
    cmds.push('shrk commands');
  }

  // Module not found.
  if (lower.includes('cannot find module') || lower.includes('module_not_found')) {
    causes.push('Dependency missing — node_modules not installed or alias unresolved.');
    recover.push('Install dependencies; do not patch package.json blindly.');
    cmds.push('bun install');
    cmds.push('shrk doctor');
    humanApproval = false;
  }

  // Verification failed.
  if (lower.includes('verification failed') || lower.includes('tests failed') || lower.includes('typecheck failed')) {
    causes.push('A verification command failed.');
    recover.push('Re-run the failing command locally and read its output.');
    cmds.push('bun x tsc -p tsconfig.base.json --noEmit');
    cmds.push('bun test');
  }

  // Release readiness.
  if (lower.includes('release readiness') || lower.includes('preflight')) {
    causes.push('Release readiness reported a blocker.');
    recover.push('Resolve each blocker; do NOT publish to bypass the gate.');
    cmds.push('shrk release readiness --strict');
    cmds.push('bun run release:preflight');
    humanApproval = true;
  }

  // polyglot Java
  if (lower.includes('cannot find symbol')) {
    causes.push('Java compiler reports "cannot find symbol" — missing import or dependency.');
    recover.push('Add the missing import / dependency; run `mvn dependency:tree` to verify.');
    cmds.push('mvn -U test');
    docs.push('docs/healing-plans.md');
  }
  if (lower.includes('package does not exist')) {
    causes.push('Java dependency is not on the classpath.');
    recover.push('Declare the dependency in pom.xml / build.gradle and refresh.');
    cmds.push('mvn -U test');
    cmds.push('./gradlew --refresh-dependencies test');
  }

  // polyglot C#
  if (lower.includes('cs0246')) {
    causes.push('CS0246 — type or namespace not found.');
    recover.push('Add the missing `using` directive or restore the NuGet package.');
    cmds.push('dotnet restore');
    cmds.push('dotnet build');
  }
  if (lower.includes('nu1101')) {
    causes.push('NU1101 — NuGet package not found.');
    recover.push('Verify the package id and feed; then re-restore.');
    cmds.push('dotnet nuget list source');
    cmds.push('dotnet restore --force-evaluate');
  }

  // polyglot Python
  if (lower.includes('modulenotfounderror') || lower.includes('no module named')) {
    causes.push('Python ModuleNotFoundError — dependency not installed in active env.');
    recover.push('Install the dependency; do NOT add bare paths to sys.path as a workaround.');
    cmds.push('python -m pip install -r requirements.txt');
    cmds.push('uv sync');
    cmds.push('poetry install');
  }
  if (lower.includes('pytest') && (lower.includes('collected 0 items') || lower.includes('errors during collection'))) {
    causes.push('pytest collection error — a test file fails to import or a fixture is missing.');
    recover.push('Narrow down with `pytest --collect-only`; fix the failing import first.');
    cmds.push('python -m pytest --collect-only');
  }

  // polyglot Go
  if (lower.includes('no required module provides package') || lower.includes('cannot find module')) {
    causes.push('Go module missing — go.mod is out of date.');
    recover.push('Run `go mod tidy` to bring go.mod in sync.');
    cmds.push('go mod tidy');
    cmds.push('go test ./...');
  }
  if (lower.includes('import cycle')) {
    causes.push('Go import cycle — two packages import each other.');
    recover.push('Refactor: extract shared types into a new neutral package.');
    cmds.push('go list -deps ./...');
  }

  // polyglot Rust
  if (lower.includes('e0432') || lower.includes('unresolved import')) {
    causes.push('Rust E0432 — unresolved import. Crate or mod declaration missing.');
    recover.push('Add the dependency to Cargo.toml or declare the `mod` line.');
    cmds.push('cargo build');
  }
  if (lower.includes('e0308') || lower.includes('mismatched types')) {
    causes.push('Rust E0308 — mismatched types or lifetime/borrow conflict.');
    recover.push('Inspect the offending expression with `cargo check --message-format=short`.');
    cmds.push('cargo check --message-format=short');
  }

  return { causes, recover, cmds, constructs, docs, humanApproval, sourceWrite };
}

function summarize(text: string, max = 240): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned;
}

function buildPlan(ctx: IBuildContext): IHealingPlan {
  const suggest = suggestDiagnostic(ctx.text);
  const codes = new Set<FailureDiagnosticCode>();
  for (const c of suggest.candidates) codes.add(c.code as FailureDiagnosticCode);

  // Add command-exit-driven codes.
  if (ctx.exitCode !== undefined && ctx.exitCode !== 0 && ctx.command) {
    codes.add('failed-verification' as FailureDiagnosticCode);
  }

  const detectedDiagnostics: IFailureDiagnostic[] = [];
  for (const code of codes) {
    detectedDiagnostics.push(
      buildDiagnosticByCode(code, {
        command: ctx.command ?? '',
        exitCode: ctx.exitCode ?? -1,
      }),
    );
  }

  const inferred = inferFromKeywords(ctx.text);

  // Confidence.
  const top = suggest.topSuggestion?.confidence ?? (detectedDiagnostics.length > 0 ? 'medium' : 'low');
  const confidence: IHealingPlan['confidence'] = top as IHealingPlan['confidence'];

  // Recommended commands.
  const recommendedCommands: string[] = [];
  for (const d of detectedDiagnostics) {
    if (d.nextCommand) recommendedCommands.push(d.nextCommand);
  }
  for (const c of inferred.cmds) recommendedCommands.push(c);
  if (recommendedCommands.length === 0) recommendedCommands.push(GENERIC_NEXT);

  // Likely causes.
  const likelyCauses: string[] = [];
  for (const d of detectedDiagnostics) likelyCauses.push(d.likelyCause ?? d.problem);
  for (const c of inferred.causes) likelyCauses.push(c);
  if (likelyCauses.length === 0) likelyCauses.push('Unable to classify automatically — run generic triage.');

  // Safe recovery steps.
  const safeRecoverySteps: string[] = [
    'Re-read the failing command output carefully (do not skip).',
    'Reproduce the failure locally before changing code.',
    'If unsure, run `shrk doctor` and `shrk diagnostics suggest`.',
  ];
  for (const r of inferred.recover) safeRecoverySteps.push(r);

  const forbiddenQuickFixes: string[] = [
    'Do NOT bypass safety hooks (--no-verify).',
    'Do NOT silence the failing test/check — fix the root cause.',
    'Do NOT commit secrets or signing keys to recover.',
    'Do NOT delete .sharkcraft/sessions or .sharkcraft/plans to clear state.',
  ];

  const relatedDocs = [...new Set(inferred.docs)];
  const relatedConstructs = [...new Set(inferred.constructs)];

  const humanApprovalRequired = inferred.humanApproval || detectedDiagnostics.some((d) => d.code === 'release-readiness-blocker' || d.code === 'plan-signature-mismatch');
  const sourceWritesInvolved = inferred.sourceWrite;

  const nextSafestCommand = recommendedCommands[0] ?? GENERIC_NEXT;

  return {
    schema: HEALING_PLAN_SCHEMA,
    generatedAt: new Date().toISOString(),
    inputKind: ctx.inputKind,
    inputSummary: summarize(ctx.inputSummary || ctx.text),
    detectedDiagnostics,
    confidence,
    likelyCauses: [...new Set(likelyCauses)],
    safeRecoverySteps: [...new Set(safeRecoverySteps)],
    forbiddenQuickFixes,
    recommendedCommands: [...new Set(recommendedCommands)],
    relatedConstructs,
    relatedDocs,
    humanApprovalRequired,
    sourceWritesInvolved,
    nextSafestCommand,
    notes: [
      'Heal output is advisory only. No automatic fixes. No source writes.',
      'CLI is the only write path; MCP stays read-only.',
    ],
  };
}

export function buildHealingPlanFromError(errorText: string): IHealingPlan {
  return buildPlan({
    inputKind: HealingInputKind.Error,
    inputSummary: summarize(errorText, 120),
    text: errorText,
  });
}

export function buildHealingPlanFromFile(filePath: string): IHealingPlan {
  if (!existsSync(filePath)) {
    return buildPlan({
      inputKind: HealingInputKind.File,
      inputSummary: `(missing file) ${filePath}`,
      text: '',
    });
  }
  const text = readFileSync(filePath, 'utf8');
  return buildPlan({
    inputKind: HealingInputKind.File,
    inputSummary: filePath,
    text,
  });
}

export function buildHealingPlanFromReport(reportPath: string): IHealingPlan {
  if (!existsSync(reportPath)) {
    return buildPlan({
      inputKind: HealingInputKind.Report,
      inputSummary: `(missing report) ${reportPath}`,
      text: '',
    });
  }
  let text = readFileSync(reportPath, 'utf8');
  // Flatten the report so keyword scanning works.
  try {
    const j = JSON.parse(text);
    text = JSON.stringify(j);
  } catch {
    /* not JSON */
  }
  return buildPlan({
    inputKind: HealingInputKind.Report,
    inputSummary: reportPath,
    text,
  });
}

export function buildHealingPlanFromCommand(
  command: string,
  exitCode: number,
  stderrText: string,
): IHealingPlan {
  return buildPlan({
    inputKind: HealingInputKind.Command,
    inputSummary: `${command} (exit ${exitCode})`,
    text: stderrText,
    command,
    exitCode,
  });
}

void listDiagnostics;

export function renderHealingPlanText(p: IHealingPlan): string {
  let out = `=== Healing plan ===\n`;
  out += `  input            ${p.inputKind} — ${p.inputSummary}\n`;
  out += `  confidence       ${p.confidence}\n`;
  out += `  human approval   ${p.humanApprovalRequired ? 'REQUIRED' : 'not required'}\n`;
  out += `  source writes    ${p.sourceWritesInvolved ? 'YES' : 'no'}\n\n`;
  out += `Likely causes:\n`;
  for (const c of p.likelyCauses) out += `  • ${c}\n`;
  out += `\nSafe recovery steps:\n`;
  for (const s of p.safeRecoverySteps) out += `  • ${s}\n`;
  out += `\nForbidden quick fixes:\n`;
  for (const f of p.forbiddenQuickFixes) out += `  • ${f}\n`;
  out += `\nRecommended commands:\n`;
  for (const c of p.recommendedCommands) out += `  $ ${c}\n`;
  if (p.detectedDiagnostics.length > 0) {
    out += `\nDetected diagnostics:\n`;
    for (const d of p.detectedDiagnostics) out += `  • [${d.code}] ${d.problem}\n`;
  }
  if (p.relatedDocs.length) out += `\nRelated docs: ${p.relatedDocs.join(', ')}\n`;
  if (p.relatedConstructs.length) out += `Related constructs: ${p.relatedConstructs.join(', ')}\n`;
  out += `\nNext safest command:\n  $ ${p.nextSafestCommand}\n`;
  return out;
}

export function renderHealingPlanMarkdown(p: IHealingPlan): string {
  let out = `# Healing plan\n\n`;
  out += `- **input**: ${p.inputKind} — ${p.inputSummary}\n`;
  out += `- **confidence**: ${p.confidence}\n`;
  out += `- **human approval**: ${p.humanApprovalRequired ? 'REQUIRED' : 'not required'}\n`;
  out += `- **source writes**: ${p.sourceWritesInvolved ? 'YES' : 'no'}\n\n`;
  out += `## Likely causes\n` + p.likelyCauses.map((c) => `- ${c}`).join('\n') + '\n\n';
  out += `## Safe recovery steps\n` + p.safeRecoverySteps.map((s) => `- ${s}`).join('\n') + '\n\n';
  out += `## Forbidden quick fixes\n` + p.forbiddenQuickFixes.map((f) => `- ${f}`).join('\n') + '\n\n';
  out += `## Recommended commands\n` + p.recommendedCommands.map((c) => `- \`${c}\``).join('\n') + '\n\n';
  if (p.detectedDiagnostics.length) {
    out += `## Detected diagnostics\n` + p.detectedDiagnostics.map((d) => `- **${d.code}** — ${d.problem}`).join('\n') + '\n\n';
  }
  if (p.relatedDocs.length) out += `**Related docs**: ${p.relatedDocs.join(', ')}\n\n`;
  if (p.relatedConstructs.length) out += `**Related constructs**: ${p.relatedConstructs.join(', ')}\n\n`;
  out += `\n**Next safest command**: \`${p.nextSafestCommand}\`\n`;
  return out;
}
