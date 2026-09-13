/**
 * `shrk self audit` — meaningful only inside the SharkCraft repo itself.
 *
 * Aggregates several existing read-only audits:
 *  - shrk commands doctor (catalog completeness)
 *  - mcp audit (no writable tools)
 *  - docs check
 *  - examples check
 *  - release readiness
 *  - runtime doctor
 *  - compat:node static report
 *  - packs doctor on example packs
 *
 * The aggregation is intentionally lightweight — every component is its own
 * command. `self audit` just wires the verdicts into one pass/fail and
 * suggests the next CLI step.
 *
 * When run outside the SharkCraft repo, the command returns a single
 * "not-applicable" finding instead of running anything.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export const SELF_AUDIT_SCHEMA = 'sharkcraft.self-audit/v1';

export interface ISelfAuditFinding {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  message: string;
  /** Suggested next command. */
  nextCommand?: string;
}

export interface ISelfAuditReport {
  schema: typeof SELF_AUDIT_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  isSharkcraftRepo: boolean;
  findings: readonly ISelfAuditFinding[];
  ok: boolean;
}

/** The package name of the CLI inside SharkCraft's own repository. */
const TOOL_CLI_PACKAGE = '@shrkcrft/cli';

/**
 * THE host authority: is `projectRoot` SharkCraft's OWN repository? Every
 * "is this the tool repo" decision reads it — `self audit`, `install smoke`,
 * the MCP self-audit tool, and the surface tier resolver that gates
 * tool-maintenance commands (round 11 §5.1) everywhere else.
 *
 * The tool's identity is its CLI package: `packages/cli/package.json` named
 * `@shrkcrft/cli`, plus either the root package named `sharkcraft` or the
 * sibling inspector + mcp-server packages. Directory markers alone would
 * misfire on any consumer monorepo that happens to have `packages/cli`,
 * `packages/inspector` and `packages/mcp-server`.
 */
export function detectSharkcraftRepo(projectRoot: string): boolean {
  const pkgFile = nodePath.join(projectRoot, 'package.json');
  if (!existsSync(pkgFile)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: string; workspaces?: string[] };
    if (!hasToolCliPackage(projectRoot)) return false;
    if (pkg.name === 'sharkcraft') return true;
    const markers = ['packages/inspector', 'packages/mcp-server'];
    return markers.every((m) => existsSync(nodePath.join(projectRoot, m)));
  } catch {
    return false;
  }
}

function hasToolCliPackage(projectRoot: string): boolean {
  const cliPkg = nodePath.join(projectRoot, 'packages', 'cli', 'package.json');
  if (!existsSync(cliPkg)) return false;
  try {
    return (JSON.parse(readFileSync(cliPkg, 'utf8')) as { name?: string }).name === TOOL_CLI_PACKAGE;
  } catch {
    return false;
  }
}

export interface ISelfAuditInput {
  /** Caller can pass pre-computed verdicts. */
  releaseReadinessReady?: boolean;
  releaseReadinessBlockers?: number;
  releaseReadinessWarnings?: number;
  commandsDoctorErrors?: number;
  commandsDoctorWarnings?: number;
  mcpAuditWriteToolCount?: number;
  docsCheckOk?: boolean;
  examplesCheckOk?: boolean;
  /** Has runtime doctor been run? Pass `null` to mark skipped. */
  runtimeDoctorOk?: boolean | null;
  /** Has compat:node been run? Pass `null` to mark skipped. */
  compatNodeOk?: boolean | null;
  /** Pack doctor verdict. Pass `null` to mark skipped. */
  packsDoctorOk?: boolean | null;
  demoPackageValidateOk?: boolean | null;
}

export function buildSelfAudit(projectRoot: string, input: ISelfAuditInput = {}): ISelfAuditReport {
  const isRepo = detectSharkcraftRepo(projectRoot);
  if (!isRepo) {
    return {
      schema: SELF_AUDIT_SCHEMA,
      generatedAt: new Date().toISOString(),
      projectRoot,
      isSharkcraftRepo: false,
      findings: [
        {
          id: 'not-sharkcraft-repo',
          title: 'Self audit applies only to the SharkCraft monorepo',
          status: 'skipped',
          // `release readiness` is itself a tool-maintenance command (gated
          // outside the tool repo); `quality` is the consumer's own gate.
          message: 'Run `shrk quality` instead for this repository\'s own pre-push verdict.',
          nextCommand: 'shrk quality',
        },
      ],
      ok: true,
    };
  }
  const findings: ISelfAuditFinding[] = [];
  // Release readiness
  if (input.releaseReadinessReady === undefined) {
    findings.push({
      id: 'release-readiness',
      title: 'Release readiness',
      status: 'skipped',
      message: 'No release readiness verdict was supplied — pass --include-readiness or run `shrk release readiness` directly.',
      nextCommand: 'shrk release readiness',
    });
  } else if (input.releaseReadinessReady) {
    findings.push({
      id: 'release-readiness',
      title: 'Release readiness',
      status: (input.releaseReadinessWarnings ?? 0) > 0 ? 'warn' : 'pass',
      message: `Blockers: ${input.releaseReadinessBlockers ?? 0}, warnings: ${input.releaseReadinessWarnings ?? 0}.`,
    });
  } else {
    findings.push({
      id: 'release-readiness',
      title: 'Release readiness',
      status: 'fail',
      message: `Blockers: ${input.releaseReadinessBlockers ?? '?'}.`,
      nextCommand: 'shrk release readiness --strict',
    });
  }
  // Commands doctor
  if (input.commandsDoctorErrors === undefined && input.commandsDoctorWarnings === undefined) {
    findings.push({
      id: 'commands-doctor',
      title: 'Commands catalog doctor',
      status: 'skipped',
      message: 'No verdict supplied — run `shrk commands doctor`.',
      nextCommand: 'shrk commands doctor',
    });
  } else if ((input.commandsDoctorErrors ?? 0) === 0 && (input.commandsDoctorWarnings ?? 0) === 0) {
    findings.push({
      id: 'commands-doctor',
      title: 'Commands catalog doctor',
      status: 'pass',
      message: 'Catalog is consistent.',
    });
  } else if ((input.commandsDoctorErrors ?? 0) > 0) {
    findings.push({
      id: 'commands-doctor',
      title: 'Commands catalog doctor',
      status: 'fail',
      message: `${input.commandsDoctorErrors} catalog error(s).`,
      nextCommand: 'shrk commands doctor',
    });
  } else {
    findings.push({
      id: 'commands-doctor',
      title: 'Commands catalog doctor',
      status: 'warn',
      message: `${input.commandsDoctorWarnings} catalog warning(s).`,
      nextCommand: 'shrk commands doctor',
    });
  }
  // MCP audit
  if (input.mcpAuditWriteToolCount === undefined) {
    findings.push({
      id: 'mcp-audit',
      title: 'MCP audit — no write tools',
      status: 'skipped',
      message: 'No verdict supplied — run `shrk safety audit`.',
      nextCommand: 'shrk safety audit',
    });
  } else if (input.mcpAuditWriteToolCount === 0) {
    findings.push({
      id: 'mcp-audit',
      title: 'MCP audit — no write tools',
      status: 'pass',
      message: 'Every registered tool is read-only.',
    });
  } else {
    findings.push({
      id: 'mcp-audit',
      title: 'MCP audit — no write tools',
      status: 'fail',
      message: `${input.mcpAuditWriteToolCount} MCP tool(s) report write capability — this breaks the safety contract.`,
      nextCommand: 'shrk safety audit',
    });
  }
  const flag = (id: string, title: string, ok: boolean | null | undefined, nextCommand: string): void => {
    if (ok === null || ok === undefined) {
      findings.push({ id, title, status: 'skipped', message: 'Not run.', nextCommand });
    } else if (ok) {
      findings.push({ id, title, status: 'pass', message: 'Clean.' });
    } else {
      findings.push({ id, title, status: 'fail', message: 'Reports errors.', nextCommand });
    }
  };
  flag('docs-check', 'Docs check', input.docsCheckOk, 'shrk docs check');
  flag('examples-check', 'Examples check', input.examplesCheckOk, 'shrk examples check');
  flag('runtime-doctor', 'Runtime doctor', input.runtimeDoctorOk ?? null, 'shrk runtime doctor');
  flag('compat-node', 'compat:node', input.compatNodeOk ?? null, 'bun run compat:node');
  flag('packs-doctor', 'Packs doctor', input.packsDoctorOk ?? null, 'shrk packs doctor --release');
  flag('demo-package-validate', 'Demo package validate', input.demoPackageValidateOk ?? null, 'shrk release smoke');
  const ok = findings.filter((f) => f.status === 'fail').length === 0;
  return {
    schema: SELF_AUDIT_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    isSharkcraftRepo: true,
    findings,
    ok,
  };
}

export function renderSelfAuditText(report: ISelfAuditReport): string {
  const lines: string[] = [];
  lines.push(`# Self audit — ${report.ok ? 'OK' : 'NOT OK'}`);
  lines.push(`Project: ${report.projectRoot}`);
  lines.push(`Is SharkCraft repo: ${report.isSharkcraftRepo}`);
  lines.push('');
  for (const f of report.findings) {
    lines.push(`  [${f.status.padEnd(8)}] ${f.title}: ${f.message}`);
    if (f.nextCommand) lines.push(`     → ${f.nextCommand}`);
  }
  return lines.join('\n') + '\n';
}
