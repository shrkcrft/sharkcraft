/**
 * Failure diagnostics.
 *
 * Common error surfaces should not just say "X failed" — they should say
 * "X failed, probable cause is Y, try Z next". This module is a curated set
 * of diagnostic helpers callers can use to enrich the human-facing message
 * without re-implementing the dispatch in every command.
 *
 * Pure data — no I/O, no shell calls, no writes. Safe to call from MCP.
 */

export const FAILURE_DIAGNOSTIC_SCHEMA = 'sharkcraft.failure-diagnostic/v1';

export type FailureDiagnosticCode =
  | 'missing-sharkcraft-config'
  | 'missing-node-modules'
  | 'pack-helper-missing'
  | 'mcp-cache-miss'
  | 'adoption-checkpoint-stale'
  | 'unknown-command'
  | 'missing-template-variables'
  | 'unsafe-path-refused'
  | 'failed-verification'
  | 'release-readiness-blocker'
  | 'plan-signature-mismatch'
  | 'workflow-file-not-found'
  // Polyglot diagnostics
  | 'java-cannot-find-symbol'
  | 'java-package-does-not-exist'
  | 'csharp-cs0246'
  | 'csharp-nu1101'
  | 'python-module-not-found'
  | 'python-pytest-collection-error'
  | 'go-cannot-find-module'
  | 'go-import-cycle'
  | 'rust-e0432'
  | 'rust-e0308';

export interface IFailureDiagnostic {
  schema: typeof FAILURE_DIAGNOSTIC_SCHEMA;
  code: FailureDiagnosticCode;
  problem: string;
  likelyCause: string;
  nextCommand: string;
  docsLink?: string;
  extra?: Record<string, unknown>;
}

function make(
  code: FailureDiagnosticCode,
  problem: string,
  likelyCause: string,
  nextCommand: string,
  docsLink?: string,
  extra?: Record<string, unknown>,
): IFailureDiagnostic {
  return {
    schema: FAILURE_DIAGNOSTIC_SCHEMA,
    code,
    problem,
    likelyCause,
    nextCommand,
    ...(docsLink ? { docsLink } : {}),
    ...(extra ? { extra } : {}),
  };
}

export function diagnoseMissingSharkcraftConfig(projectRoot: string): IFailureDiagnostic {
  return make(
    'missing-sharkcraft-config',
    `No sharkcraft/ directory at ${projectRoot}.`,
    'SharkCraft is not initialised here yet.',
    'shrk onboard --dry-run',
    'docs/onboarding.md',
  );
}

export function diagnoseMissingNodeModules(): IFailureDiagnostic {
  return make(
    'missing-node-modules',
    'node_modules/ not found — Bun cannot resolve workspace packages.',
    'Dependencies have not been installed yet.',
    'bun install',
    'docs/quickstart.md',
  );
}

export function diagnosePackHelperMissing(symbol: string, packName: string): IFailureDiagnostic {
  return make(
    'pack-helper-missing',
    `Pack "${packName}" imports "${symbol}" from @shrkcrft/plugin-api which is not exported.`,
    'The pack expects a newer plugin-api than the consumer has installed.',
    `shrk packs compat ${packName} --consumer-root <consumer-path>`,
    'docs/pack-authoring.md',
    { symbol, packName },
  );
}

export function diagnoseMcpCacheMiss(briefId: string): IFailureDiagnostic {
  return make(
    'mcp-cache-miss',
    `MCP brief cache miss for id "${briefId}".`,
    'The server restarted or the brief expired.',
    'Re-run start_agent_brief_chunks with the same input — briefIds are deterministic.',
    'docs/brief.md',
    { briefId },
  );
}

export function diagnoseAdoptionCheckpointStale(reason: string): IFailureDiagnostic {
  return make(
    'adoption-checkpoint-stale',
    `Adoption checkpoint is stale: ${reason}.`,
    'Drafts, targets or the rendered diff changed since the checkpoint was recorded.',
    'shrk onboard adopt diff --record-checkpoint',
    'docs/adoption-checkpoints.md',
  );
}

export function diagnoseUnknownCommand(command: string, suggestions: readonly string[]): IFailureDiagnostic {
  return make(
    'unknown-command',
    `Unknown command "${command}".`,
    suggestions.length > 0
      ? `Closest known commands: ${suggestions.slice(0, 3).join(', ')}`
      : 'No close match in the command catalog.',
    'shrk commands primary',
    'docs/start-here.md',
    { command, suggestions },
  );
}

export function diagnoseMissingTemplateVariables(templateId: string, missing: readonly string[]): IFailureDiagnostic {
  return make(
    'missing-template-variables',
    `Template "${templateId}" is missing variables: ${missing.join(', ')}.`,
    'The template expects these variables to be passed via --var key=value.',
    `shrk gen ${templateId} <name> ${missing.map((m) => `--var ${m}=<value>`).join(' ')}`,
    'docs/templates.md',
    { templateId, missing },
  );
}

export function diagnoseUnsafePathRefused(target: string): IFailureDiagnostic {
  return make(
    'unsafe-path-refused',
    `Path "${target}" is outside the project root or in a protected location.`,
    'SharkCraft refuses to write outside the project root, into node_modules, or dist.',
    'shrk doctor',
    'docs/safety-model.md',
    { target },
  );
}

export function diagnoseFailedVerification(verificationId: string, exitCode: number): IFailureDiagnostic {
  return make(
    'failed-verification',
    `Verification "${verificationId}" failed (exit code ${exitCode}).`,
    'A configured verification command in sharkcraft.config.ts returned non-zero.',
    `Run the verification command manually and inspect the output, then re-apply the plan.`,
    'docs/safety-model.md',
    { verificationId, exitCode },
  );
}

export function diagnoseReleaseReadinessBlocker(blockerId: string, message: string): IFailureDiagnostic {
  return make(
    'release-readiness-blocker',
    `Release readiness blocker: ${blockerId}.`,
    message,
    'shrk release readiness --json',
    'docs/release-readiness.md',
    { blockerId },
  );
}

export function diagnosePlanSignatureMismatch(planFile: string): IFailureDiagnostic {
  return make(
    'plan-signature-mismatch',
    `Plan signature did not verify for ${planFile}.`,
    'The plan has been edited after it was signed, or the signing secret has changed.',
    `shrk plan review ${planFile}`,
    'docs/security.md',
    { planFile },
  );
}

export function diagnoseWorkflowFileNotFound(file: string): IFailureDiagnostic {
  return make(
    'workflow-file-not-found',
    `Workflow file not found: ${file}.`,
    'The path may be wrong or the workflow has not been scaffolded yet.',
    'shrk ci scaffold github-actions',
    'docs/ci-scaffold.md',
    { file },
  );
}

// ─── Polyglot diagnostics ────────────────────────────────────────────────────

export function diagnoseJavaCannotFindSymbol(symbol: string): IFailureDiagnostic {
  return make(
    'java-cannot-find-symbol',
    `Java compiler reports "cannot find symbol${symbol ? `: ${symbol}` : ''}".`,
    'Missing import, typo, or a dependency that is not on the classpath.',
    'mvn dependency:tree | grep -i <symbol>  # then add the missing import or dependency',
    'docs/healing-plans.md',
    { symbol },
  );
}

export function diagnoseJavaPackageDoesNotExist(pkg: string): IFailureDiagnostic {
  return make(
    'java-package-does-not-exist',
    `Java reports "package ${pkg || '<name>'} does not exist".`,
    'Dependency not declared in pom.xml / build.gradle, or build cache out of date.',
    'mvn -U test  # or `./gradlew --refresh-dependencies test`',
    'docs/healing-plans.md',
    { pkg },
  );
}

export function diagnoseCSharpCs0246(typeName: string): IFailureDiagnostic {
  return make(
    'csharp-cs0246',
    `CS0246: the type or namespace "${typeName || '(unknown)'}" could not be found.`,
    'Missing `using` directive or NuGet package not restored.',
    'dotnet restore  # then check the using directives in the failing file',
    'docs/healing-plans.md',
    { typeName },
  );
}

export function diagnoseCSharpNu1101(packageName: string): IFailureDiagnostic {
  return make(
    'csharp-nu1101',
    `NU1101: package "${packageName || '(unknown)'}" not found.`,
    'NuGet feed misconfigured or package id misspelled.',
    'dotnet nuget list source  # verify the feed; then `dotnet restore --force-evaluate`',
    'docs/healing-plans.md',
    { packageName },
  );
}

export function diagnosePythonModuleNotFound(moduleName: string): IFailureDiagnostic {
  return make(
    'python-module-not-found',
    `ModuleNotFoundError: No module named "${moduleName || '(unknown)'}".`,
    'Dependency not installed in the active env, or import path is wrong.',
    'python -m pip install -r requirements.txt  # or `uv sync` / `poetry install`',
    'docs/healing-plans.md',
    { moduleName },
  );
}

export function diagnosePythonPytestCollectionError(detail: string): IFailureDiagnostic {
  return make(
    'python-pytest-collection-error',
    `pytest collection error: ${detail || '(see traceback above)'}.`,
    'Test file imports something missing, or a fixture / conftest fails to import.',
    'python -m pytest --collect-only  # narrow down the failing module',
    'docs/healing-plans.md',
    { detail },
  );
}

export function diagnoseGoCannotFindModule(moduleName: string): IFailureDiagnostic {
  return make(
    'go-cannot-find-module',
    `Go build reports "no required module provides package ${moduleName || '<name>'}".`,
    'go.mod is out of date — module not declared or not pulled.',
    'go mod tidy  # then `go test ./...`',
    'docs/healing-plans.md',
    { moduleName },
  );
}

export function diagnoseGoImportCycle(detail: string): IFailureDiagnostic {
  return make(
    'go-import-cycle',
    `Go build reports import cycle: ${detail || '(see error)'}.`,
    'Two packages import each other directly or transitively.',
    'go list -deps ./...  # then refactor: extract shared types into a new package',
    'docs/healing-plans.md',
    { detail },
  );
}

export function diagnoseRustE0432(detail: string): IFailureDiagnostic {
  return make(
    'rust-e0432',
    `Rust E0432: unresolved import (${detail || 'see compiler output'}).`,
    'Crate not declared in Cargo.toml, or `mod` declaration missing.',
    'cargo build  # then add the missing dependency to Cargo.toml or declare the mod',
    'docs/healing-plans.md',
    { detail },
  );
}

export function diagnoseRustE0308(detail: string): IFailureDiagnostic {
  return make(
    'rust-e0308',
    `Rust E0308: mismatched types (${detail || 'see compiler output'}).`,
    'Borrow / move / lifetime mismatch, or the expression returns a different type than expected.',
    'cargo check --message-format=short  # then inspect the offending expression',
    'docs/healing-plans.md',
    { detail },
  );
}

export function renderDiagnosticText(d: IFailureDiagnostic): string {
  const lines: string[] = [];
  lines.push(`⚠️  ${d.problem}`);
  lines.push(`   Likely cause: ${d.likelyCause}`);
  lines.push(`   Try next:    ${d.nextCommand}`);
  if (d.docsLink) lines.push(`   Docs:        ${d.docsLink}`);
  return lines.join('\n') + '\n';
}

/**
 * Registry of named diagnostics so the CLI / MCP can list them and
 * fetch by code. Each entry is a placeholder constructor — callers supply
 * the per-call data via `context`.
 */
export interface IDiagnosticRegistryEntry {
  code: FailureDiagnosticCode;
  description: string;
  /** Required keys in `context` for the constructor to produce a useful message. */
  contextKeys: readonly string[];
}

const REGISTRY: readonly IDiagnosticRegistryEntry[] = Object.freeze([
  {
    code: 'missing-sharkcraft-config',
    description: 'No sharkcraft/ directory in the project root.',
    contextKeys: ['projectRoot'],
  },
  {
    code: 'missing-node-modules',
    description: 'node_modules/ is absent — dependencies not installed yet.',
    contextKeys: [],
  },
  {
    code: 'pack-helper-missing',
    description: 'Pack imports a plugin-api symbol the consumer does not export.',
    contextKeys: ['symbol', 'packName'],
  },
  {
    code: 'mcp-cache-miss',
    description: 'MCP brief cache miss — the briefId is no longer cached.',
    contextKeys: ['briefId'],
  },
  {
    code: 'adoption-checkpoint-stale',
    description: 'Adoption checkpoint is stale (drafts / targets / diff hash changed, or age > max-age-days).',
    contextKeys: ['reason'],
  },
  {
    code: 'unknown-command',
    description: 'The user invoked a `shrk` command that is not in the catalog.',
    contextKeys: ['command'],
  },
  {
    code: 'missing-template-variables',
    description: 'Template generation is missing one or more required variables.',
    contextKeys: ['templateId', 'missing'],
  },
  {
    code: 'unsafe-path-refused',
    description: 'A target path resolved outside the project root or into a protected location.',
    contextKeys: ['target'],
  },
  {
    code: 'failed-verification',
    description: 'A `sharkcraft.config` verification command returned non-zero.',
    contextKeys: ['verificationId', 'exitCode'],
  },
  {
    code: 'release-readiness-blocker',
    description: 'Release readiness reported a blocker.',
    contextKeys: ['blockerId', 'message'],
  },
  {
    code: 'plan-signature-mismatch',
    description: 'A signed plan did not verify (the plan was edited or the secret rotated).',
    contextKeys: ['planFile'],
  },
  {
    code: 'workflow-file-not-found',
    description: 'A CI workflow file path was missing during audit.',
    contextKeys: ['file'],
  },
  // Polyglot
  { code: 'java-cannot-find-symbol', description: 'Java compiler "cannot find symbol".', contextKeys: ['symbol'] },
  { code: 'java-package-does-not-exist', description: 'Java compiler "package X does not exist".', contextKeys: ['pkg'] },
  { code: 'csharp-cs0246', description: 'CS0246 — type or namespace not found.', contextKeys: ['typeName'] },
  { code: 'csharp-nu1101', description: 'NU1101 — NuGet package not found.', contextKeys: ['packageName'] },
  { code: 'python-module-not-found', description: 'Python ModuleNotFoundError.', contextKeys: ['moduleName'] },
  { code: 'python-pytest-collection-error', description: 'pytest collection error.', contextKeys: ['detail'] },
  { code: 'go-cannot-find-module', description: 'Go "no required module provides package".', contextKeys: ['moduleName'] },
  { code: 'go-import-cycle', description: 'Go import cycle.', contextKeys: ['detail'] },
  { code: 'rust-e0432', description: 'Rust E0432 — unresolved import.', contextKeys: ['detail'] },
  { code: 'rust-e0308', description: 'Rust E0308 — mismatched types.', contextKeys: ['detail'] },
]);

export function listDiagnostics(): readonly IDiagnosticRegistryEntry[] {
  return REGISTRY;
}

export function getDiagnosticEntry(code: string): IDiagnosticRegistryEntry | null {
  return REGISTRY.find((e) => e.code === code) ?? null;
}

/**
 * Produce a diagnostic by code using a context bag. Missing context fields
 * fall back to `(unknown)` so the diagnostic remains useful as documentation.
 */
export function buildDiagnosticByCode(
  code: FailureDiagnosticCode,
  context: Record<string, unknown> = {},
): IFailureDiagnostic {
  const s = (k: string, fallback = '(unknown)'): string => {
    const v = context[k];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;
  };
  switch (code) {
    case 'missing-sharkcraft-config':
      return diagnoseMissingSharkcraftConfig(s('projectRoot', '(unknown)'));
    case 'missing-node-modules':
      return diagnoseMissingNodeModules();
    case 'pack-helper-missing':
      return diagnosePackHelperMissing(s('symbol'), s('packName'));
    case 'mcp-cache-miss':
      return diagnoseMcpCacheMiss(s('briefId'));
    case 'adoption-checkpoint-stale':
      return diagnoseAdoptionCheckpointStale(s('reason', 'unknown'));
    case 'unknown-command': {
      const suggestions = Array.isArray(context['suggestions'])
        ? (context['suggestions'] as string[])
        : [];
      return diagnoseUnknownCommand(s('command'), suggestions);
    }
    case 'missing-template-variables': {
      const missing = Array.isArray(context['missing']) ? (context['missing'] as string[]) : [];
      return diagnoseMissingTemplateVariables(s('templateId'), missing);
    }
    case 'unsafe-path-refused':
      return diagnoseUnsafePathRefused(s('target'));
    case 'failed-verification':
      return diagnoseFailedVerification(s('verificationId'), Number(context['exitCode'] ?? -1));
    case 'release-readiness-blocker':
      return diagnoseReleaseReadinessBlocker(s('blockerId'), s('message', 'see release readiness output'));
    case 'plan-signature-mismatch':
      return diagnosePlanSignatureMismatch(s('planFile'));
    case 'workflow-file-not-found':
      return diagnoseWorkflowFileNotFound(s('file'));
    case 'java-cannot-find-symbol':
      return diagnoseJavaCannotFindSymbol(s('symbol', ''));
    case 'java-package-does-not-exist':
      return diagnoseJavaPackageDoesNotExist(s('pkg', ''));
    case 'csharp-cs0246':
      return diagnoseCSharpCs0246(s('typeName', ''));
    case 'csharp-nu1101':
      return diagnoseCSharpNu1101(s('packageName', ''));
    case 'python-module-not-found':
      return diagnosePythonModuleNotFound(s('moduleName', ''));
    case 'python-pytest-collection-error':
      return diagnosePythonPytestCollectionError(s('detail', ''));
    case 'go-cannot-find-module':
      return diagnoseGoCannotFindModule(s('moduleName', ''));
    case 'go-import-cycle':
      return diagnoseGoImportCycle(s('detail', ''));
    case 'rust-e0432':
      return diagnoseRustE0432(s('detail', ''));
    case 'rust-e0308':
      return diagnoseRustE0308(s('detail', ''));
    default:
      return make(
        code,
        `Unknown diagnostic code "${code}".`,
        'The code may be misspelled.',
        'shrk diagnostics list',
        'docs/start-here.md',
      );
  }
}
