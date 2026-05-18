import {
  buildSafetyAudit,
  buildSafetyAuditDeep,
  inspectSharkcraft,
  type ISafetyAuditReport,
} from '@shrkcrft/inspector';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { COMMAND_CATALOG } from './command-catalog.ts';

const PLAN_SECRET_ENV = 'SHARKCRAFT_PLAN_SECRET';

export const safetyCommand: ICommandHandler = {
  name: 'safety',
  description:
    'Audit the SharkCraft safety model: which commands write source, which run shell, MCP read-only invariant, pack signature status, plan-signing status. Read-only.',
  usage: 'shrk safety audit [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub !== 'audit') {
      process.stderr.write('Usage: shrk safety audit [--json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    // Lazy-load the MCP tool list to avoid a static import dependency.
    const mcpToolList = await listMcpTools();
    const report = buildSafetyAudit({
      inspection,
      catalog: COMMAND_CATALOG,
      mcpTools: mcpToolList,
      planSecretEnv: PLAN_SECRET_ENV,
      planSecretConfigured: typeof process.env[PLAN_SECRET_ENV] === 'string',
    });
    let deep: Awaited<ReturnType<typeof buildSafetyAuditDeep>> | null = null;
    if (flagBool(args, 'deep')) {
      deep = await buildSafetyAuditDeep(inspection);
    }
    if (flagBool(args, 'json')) {
      const merged = deep ? { ...report, deep } : report;
      process.stdout.write(asJson(merged) + '\n');
      const failed = report.mcp.anyWritable || (deep ? !deep.passed : false);
      return failed ? 1 : 0;
    }
    printSafetyAudit(report);
    if (deep) {
      process.stdout.write('\n=== Deep audit ===\n');
      process.stdout.write(`  passed: ${deep.passed ? 'yes' : 'no'}\n`);
      process.stdout.write(`  info-only findings: ${deep.infoOnlyFindings}\n`);
      process.stdout.write(`  report-site external JS: ${deep.reportSiteExternalJs.length}\n`);
      process.stdout.write(`  demo destructive lines: ${deep.demoDestructiveLines.length}\n`);
      process.stdout.write(`  CI workflows scanned: ${deep.ciGeneratedWorkflowPermissions.length}\n`);
      // Dev-signed packs surface as a top-level deep-audit line so it
      // doesn't get lost in the per-check list.
      if (deep.devSignedPacks && deep.devSignedPacks.length > 0) {
        process.stdout.write(`  dev-signed packs: ${deep.devSignedPacks.length}\n`);
        for (const p of deep.devSignedPacks) {
          process.stdout.write(
            `    • ${p.packageName}@${p.packageVersion}${p.signedAt ? ` (signed-at ${p.signedAt})` : ''}\n`,
          );
        }
        // Dev-signed pack findings are info-level by design. The
        // deep-audit verdict ignores them; release readiness is enforced
        // elsewhere. Spell that out so `passed: yes` next to a non-empty
        // dev-signed list stops reading contradictory.
        process.stdout.write(
          '\n  Dev-signed packs are info-level findings — the deep-audit verdict ignores them.\n' +
            '  Release readiness is gated by `shrk packs signature-status --release-readiness`.\n',
        );
      }
      if (deep.checks.length > 0) {
        process.stdout.write('  checks:\n');
        for (const c of deep.checks)
          process.stdout.write(`    [${c.severity}] ${c.id} — ${c.message}\n`);
      }
    }
    const failed = report.mcp.anyWritable || (deep ? !deep.passed : false);
    return failed ? 1 : 0;
  },
};

async function listMcpTools(): Promise<{ name: string; description: string }[]> {
  try {
    const mod = (await import('@shrkcrft/mcp-server')) as {
      ALL_TOOLS?: readonly { name: string; description: string }[];
    };
    return [...(mod.ALL_TOOLS ?? [])].map((t) => ({ name: t.name, description: t.description }));
  } catch {
    return [];
  }
}

function printSafetyAudit(r: ISafetyAuditReport): void {
  process.stdout.write(header('SharkCraft safety audit'));
  process.stdout.write(kv('MCP tools', String(r.mcp.tools.length)) + '\n');
  process.stdout.write(
    kv('MCP writable', r.mcp.anyWritable ? 'YES — INVARIANT VIOLATED' : 'no (read-only ✓)') + '\n',
  );
  process.stdout.write(kv('packs', String(r.packs.discovered)) + '\n');
  process.stdout.write(
    kv(
      'pack signatures',
      `verified=${r.packs.signedAndVerified} not-checked=${r.packs.signedNotVerified} unsigned=${r.packs.unsigned} invalid=${r.packs.invalid}`,
    ) + '\n',
  );
  process.stdout.write(
    kv(
      'plan signing',
      r.planSigning.secretConfigured
        ? `${r.planSigning.secretEnv} configured`
        : `${r.planSigning.secretEnv} not set`,
    ) + '\n',
  );
  process.stdout.write('\nCommand safety by level:\n');
  process.stdout.write(`  read-only:       ${r.commands.readOnly.length}\n`);
  process.stdout.write(`  writes-session:  ${r.commands.writesSession.length}\n`);
  process.stdout.write(`  writes-drafts:   ${r.commands.writesDrafts.length}\n`);
  process.stdout.write(`  writes-source:   ${r.commands.writesSource.length}\n`);
  process.stdout.write(`  runs-shell:      ${r.commands.runsShell.length}\n`);
  if (r.commands.writesSource.length > 0) {
    process.stdout.write('\nCommands that write source (require human approval):\n');
    for (const c of r.commands.writesSource) {
      process.stdout.write(`  • ${c.command.padEnd(34)} ${c.description}\n`);
    }
  }
  if (r.verifications.untrusted.length > 0) {
    process.stdout.write('\nLocal verification commands NOT marked trusted:\n');
    for (const v of r.verifications.untrusted) {
      process.stdout.write(`  • ${v.id.padEnd(20)} ${v.command}\n`);
    }
  }
  if (r.verifications.pack.length > 0) {
    process.stdout.write('\nPack-contributed verification commands (NOT auto-run):\n');
    for (const v of r.verifications.pack) {
      process.stdout.write(`  • ${v.id.padEnd(20)} (${v.packPackageName ?? '?'})\n`);
    }
  }
  if (r.recommendations.length > 0) {
    process.stdout.write('\nRecommendations:\n');
    for (const rec of r.recommendations) process.stdout.write(`  • ${rec}\n`);
  }
  process.stdout.write(
    `\nVerdict: ${r.mcp.anyWritable ? 'MCP INVARIANT VIOLATED' : 'safety model intact ✓'}\n`,
  );
}
