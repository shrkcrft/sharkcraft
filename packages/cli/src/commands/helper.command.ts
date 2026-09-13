/**
 * `shrk helper` commands.
 *
 * shrk helper list [--source builtin|local|pack]
 * shrk helper get <id>
 * shrk helper plan <id> --var k=v [--dry-run] [--output <plan.json>]
 * shrk helper doctor [--allow-empty]
 *
 * Every verb reads THE helper catalog (`listAllHelpers`): built-in helpers ∪
 * pack/local-contributed ones — the same list the id resolver and the MCP
 * helper tools read. Dry-run by default; never writes source.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IVerdictCoverage } from '@shrkcrft/core';
import {
  buildHelperPlan,
  buildPackHelperPlan,
  ContributionKind,
  HELPER_SYNTHETIC_TEMPLATE,
  HelperId,
  helperPlanToSavedPlan,
  inspectSharkcraft,
  listAllHelpers,
  renderHelperPlanText,
  type IHelperPlan,
  type IHelperView,
} from '@shrkcrft/inspector';
import { savePlanToFile, signPlan, type ISavedPlan } from '@shrkcrft/generator';
import {
  flagBool,
  flagString,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { asJson, header } from '../output/format-output.ts';
import { writeRejectedEntriesNote } from '../output/rejected-entries-note.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';

const HELPER_SOURCES: readonly string[] = ['builtin', 'local', 'pack'];

function writePlanFile(content: string, outputArg: string, cwd: string): string {
  const abs = nodePath.isAbsolute(outputArg) ? outputArg : nodePath.resolve(cwd, outputArg);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, content + '\n', 'utf8');
  return abs;
}

function describeSource(h: IHelperView): string {
  if (h.source === 'pack') return `pack ${h.packageName ?? '?'}`;
  return h.source;
}

export const helperListCommand: ICommandHandler = {
  name: 'list',
  description:
    'List every helper (built-in + pack/local-contributed) with its source. `--source builtin|local|pack` filters.',
  usage: 'shrk helper list [--source builtin|local|pack] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const source = flagString(args, 'source');
    if (args.flags.has('source') && (source === undefined || !HELPER_SOURCES.includes(source))) {
      process.stderr.write(
        `Invalid --source ${JSON.stringify(source ?? '')}. Expected one of: ${HELPER_SOURCES.join(', ')}\n`,
      );
      return 3;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const catalog = await listAllHelpers(inspection);
    const entries = source ? catalog.entries.filter((h) => h.source === source) : catalog.entries;
    const note = { ...(source ? { source } : {}), next: 'shrk helper doctor' };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entries) + '\n');
      await writeRejectedEntriesNote(inspection, [ContributionKind.Helper], { ...note, json: true });
      return 0;
    }
    process.stdout.write(header(`Helpers (${entries.length})`));
    if (entries.length > 0) {
      process.stdout.write(`                ${'ID'.padEnd(34)} ${'SOURCE'.padEnd(24)} DESCRIPTION\n`);
    }
    for (const h of entries) {
      const marker = h.destructive ? '[destructive] ' : '              ';
      process.stdout.write(`  ${marker}${h.id.padEnd(34)} ${describeSource(h).padEnd(24)} ${h.description}\n`);
    }
    // A FILE that did not load is said as such; an ENTRY its loader refused is
    // named with its reason (round 12, 12.1) — the old line counted both as
    // "helper file error(s)".
    const brokenFiles = catalog.files.filter((f) => f.status !== 'loaded').length;
    if (brokenFiles > 0) {
      process.stdout.write(
        `\n${brokenFiles} helper file(s) failed to load or are missing — run \`shrk helper doctor\`.\n`,
      );
    }
    // Load failures are the broken-file line above — never said twice.
    await writeRejectedEntriesNote(inspection, [ContributionKind.Helper], { ...note, loadFailures: false });
    return 0;
  },
};

export const helperGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show a helper definition (source, variables, safety flags, operations).',
  usage: 'shrk helper get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk helper get <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const def = (await listAllHelpers(inspection)).entries.find((h) => h.id === id);
    if (!def) {
      process.stderr.write(`Unknown helper: ${id}\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(def) + '\n');
      return 0;
    }
    process.stdout.write(header(`Helper: ${def.id}`));
    process.stdout.write(`  title           ${def.title}\n`);
    process.stdout.write(`  description     ${def.description}\n`);
    process.stdout.write(`  source          ${describeSource(def)}${def.sourceFile ? ` (${def.sourceFile})` : ''}\n`);
    process.stdout.write(`  output          ${def.outputKind}\n`);
    process.stdout.write(`  destructive     ${def.destructive ? 'yes' : 'no'}\n`);
    process.stdout.write(`  review          ${def.requiresHumanReview ? 'human review required' : 'auto'}\n`);
    if (def.requiresProfile) process.stdout.write(`  profile         required\n`);
    process.stdout.write(`  variables       ${def.variables.length}\n`);
    for (const v of def.variables) {
      const dflt = v.defaultValue !== undefined ? ` [default: ${v.defaultValue}]` : '';
      process.stdout.write(`    • ${v.name}${v.required ? ' (required)' : ''}${dflt} — ${v.description}\n`);
    }
    if (def.operations.length > 0) {
      process.stdout.write(`  operations      ${def.operations.length}\n`);
      for (const op of def.operations) {
        // A pack op may omit `description` (a manual-checklist op usually
        // carries only `checklist[]`) — never interpolate an absent field.
        const desc: string | undefined = op.description;
        const detail = desc && desc.trim().length > 0 ? desc : (op.checklist ?? []).join('; ');
        process.stdout.write(`    • ${op.kind}${op.targetPath ? ` ${op.targetPath}` : ''}${detail ? ` — ${detail}` : ''}\n`);
      }
    }
    if (def.manualChecklist.length > 0) {
      process.stdout.write(`  checklist       ${def.manualChecklist.length}\n`);
      for (const c of def.manualChecklist) process.stdout.write(`    • ${c}\n`);
    }
    return 0;
  },
};

function writePlanOutput(plan: IHelperPlan, args: ParsedArgs, cwd: string): number {
  const output = flagString(args, 'output');
  if (flagBool(args, 'json')) {
    const body = asJson(plan);
    if (output) {
      const abs = writePlanFile(body, output, cwd);
      process.stdout.write(`Wrote ${abs}\n`);
    } else {
      process.stdout.write(body + '\n');
    }
    return 0;
  }
  process.stdout.write(renderHelperPlanText(plan));
  if (plan.destructive) {
    process.stdout.write('\n⚠ DESTRUCTIVE — human approval required.\n');
  }
  if (output) {
    const abs = writePlanFile(asJson(plan), output, cwd);
    process.stdout.write(`\nSaved plan to ${abs}\n`);
  }
  return 0;
}

export const helperPlanCommand: ICommandHandler = {
  name: 'plan',
  description:
    'Generate a plan-only helper plan (dry-run by default). Built-in helpers: pass --save-plan <file> to emit a saved plan that flows through `shrk apply`. Pack/local helpers render their declarative operations; --save-plan is refused for them.',
  usage:
    'shrk helper plan <id> --var k=v [--output <plan.json>] [--save-plan <file>] [--sign] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk helper plan <id> --var k=v\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const def = (await listAllHelpers(inspection)).entries.find((h) => h.id === id);
    if (!def) {
      process.stderr.write(`Unknown helper: ${id}\n`);
      return 1;
    }
    const vars = flagVars(args);
    const savePlanPath = flagString(args, 'save-plan');

    if (def.source !== 'builtin') {
      if (savePlanPath) {
        // helperPlanToSavedPlan is an identity stub: writing its output would
        // produce a file `shrk apply` cannot read. Refuse loudly, never fake it.
        process.stderr.write(
          `Refusing --save-plan for ${describeSource(def)} helper "${id}": a declarative helper plan cannot yet be converted into a saved plan \`shrk apply\` reads. Use --output <file> (the preview JSON) and apply the operations by hand.\n`,
        );
        return 2;
      }
      if (def.requiresProfile) {
        process.stderr.write(`Helper "${id}" requires a registered profile. Available:\n  $ shrk profiles list\n`);
      }
      const built = buildPackHelperPlan(def, vars);
      if (!built.ok) {
        process.stderr.write(`${built.message}\n`);
        return 1;
      }
      return writePlanOutput(built.plan, args, cwd);
    }

    if (def.requiresProfile) {
      process.stderr.write(
        `Helper "${id}" requires a registered profile. Available:\n  $ shrk profiles list\n`,
      );
    }
    try {
      const plan = buildHelperPlan({ helperId: id as HelperId, projectRoot: cwd, vars });
      if (savePlanPath) {
        const saved = helperPlanToSavedPlan(plan, cwd);
        let toWrite = saved as unknown as ISavedPlan;
        if (flagBool(args, 'sign')) {
          const signed = signPlan(toWrite);
          if (signed.ok) toWrite = signed.value;
        }
        const abs = nodePath.isAbsolute(savePlanPath)
          ? savePlanPath
          : nodePath.resolve(cwd, savePlanPath);
        const writeResult = savePlanToFile(toWrite, abs);
        if (!writeResult.ok) {
          process.stderr.write(`Failed to save plan: ${writeResult.error.message}\n`);
          return 1;
        }
        if (!flagBool(args, 'json')) {
          process.stdout.write(renderHelperPlanText(plan));
          process.stdout.write(
            `\nSaved plan to ${abs}\nApply: shrk apply ${abs} --verify-signature\n`,
          );
        } else {
          process.stdout.write(asJson({ saved: abs, plan, synthetic: HELPER_SYNTHETIC_TEMPLATE }) + '\n');
        }
        return 0;
      }
      return writePlanOutput(plan, args, cwd);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
  },
};

export const helperDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Validate every helper file (local helpers.ts + pack helperFiles[]): load failures, invalid helpers, duplicate ids, unknown operation keys. Exit 0 clean · 1 errors · 2 nothing examined (pass --allow-empty to accept an empty helper set).',
  usage: 'shrk helper doctor [--allow-empty] [--json]',
  booleanFlags: new Set([ALLOW_EMPTY_FLAG, 'json']),
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const catalog = await listAllHelpers(inspection);
    const errors = catalog.issues.filter((i) => i.severity === 'error');
    const warnings = catalog.issues.filter((i) => i.severity === 'warning');
    const unexamined = catalog.files.filter((f) => f.status !== 'loaded');
    const coverage: IVerdictCoverage = {
      unit: 'helper files',
      expected: catalog.files.length,
      examined: catalog.files.length - unexamined.length,
      root: inspection.projectRoot,
      ...(unexamined.length > 0
        ? {
            unexamined: unexamined.slice(0, 20).map((f) => nodePath.relative(inspection.projectRoot, f.file) || f.file),
            unexaminedTotal: unexamined.length,
            reason: 'failed to load or missing',
          }
        : { reason: 'no helpers.ts and no pack helperFiles[] declared' }),
      ...allowEmptyValve(args, catalog.files.length),
    };
    const settled = settleVerdict(errors.length > 0 ? 1 : 0, [coverage]);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          helpers: catalog.entries.length,
          files: catalog.files,
          issues: catalog.issues,
          coverage,
          exitCode: settled.exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
          accepted: settled.accepted,
        }) + '\n',
      );
      return settled.exit;
    }
    process.stdout.write(header('Helper doctor'));
    process.stdout.write(
      `  helpers ${catalog.entries.length} · files ${catalog.files.length} (${catalog.files.length - unexamined.length} loaded)\n\n`,
    );
    for (const i of catalog.issues) {
      process.stdout.write(
        `  ${i.severity.toUpperCase().padEnd(8)} ${i.code.padEnd(16)} ${i.helperId ? `${i.helperId} ` : ''}${i.message}${i.source ? `  (${i.source})` : ''}\n`,
      );
    }
    if (catalog.issues.length > 0) process.stdout.write('\n');
    if (settled.exit === 1) {
      process.stdout.write(`${errors.length} helper error(s), ${warnings.length} warning(s).\n`);
    }
    const line = verdictLine(
      settled,
      `Helpers OK — ${catalog.entries.length} helper(s) from ${catalog.files.length} file(s)${warnings.length > 0 ? `, ${warnings.length} warning(s) above` : ''}. ✓`,
      catalog.files.length === 0 ? 'No helper files to examine.' : undefined,
    );
    if (line) process.stdout.write(line + '\n');
    if (settled.exit === 2 && catalog.files.length === 0) {
      process.stdout.write('Pass --allow-empty to accept an empty helper set explicitly.\n');
    }
    return settled.exit;
  },
};

export const helperCommand: ICommandHandler = {
  name: 'helper',
  positionals: PositionalMode.None,
  subverbs: [
    { name: 'list', description: 'List the helpers.', usage: 'shrk helper list [--json]' },
    { name: 'get', description: 'Show one helper.', usage: 'shrk helper get <id> [--json]', positionals: PositionalMode.Free },
    { name: 'plan', description: 'Plan one helper (dry-run).', usage: 'shrk helper plan <id> --var k=v', positionals: PositionalMode.Free },
    { name: 'doctor', description: 'Helper files loaded + validated.', usage: 'shrk helper doctor [--allow-empty] [--json]' },
  ],
  description: 'Helper plan generators (list / get / plan / doctor). Plan-only, dry-run default.',
  usage: 'shrk helper list|get <id>|plan <id> --var k=v|doctor',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const dispatch: Record<string, ICommandHandler> = {
      list: helperListCommand,
      get: helperGetCommand,
      plan: helperPlanCommand,
      doctor: helperDoctorCommand,
    };
    const handler = sub ? dispatch[sub] : undefined;
    if (handler) {
      args.positional = args.positional.slice(1);
      return handler.run(args);
    }
    process.stderr.write('Usage: shrk helper list|get <id>|plan <id>|doctor\n');
    return 2;
  },
};
