/**
 * `shrk helper` commands.
 *
 * shrk helper list
 * shrk helper get <id>
 * shrk helper plan <id> --var k=v [--dry-run] [--output <plan.json>]
 *
 * Dry-run by default; never writes source.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildHelperPlan,
  HELPERS,
  HELPER_SYNTHETIC_TEMPLATE,
  HelperId,
  helperPlanToSavedPlan,
  renderHelperPlanText,
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
import { asJson, header } from '../output/format-output.ts';

function writePlanFile(content: string, outputArg: string, cwd: string): string {
  const abs = nodePath.isAbsolute(outputArg) ? outputArg : nodePath.resolve(cwd, outputArg);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, content + '\n', 'utf8');
  return abs;
}

export const helperListCommand: ICommandHandler = {
  name: 'list',
  description: 'List available helpers (one-shot plan generators).',
  usage: 'shrk helper list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(HELPERS) + '\n');
      return 0;
    }
    process.stdout.write(header(`Helpers (${HELPERS.length})`));
    for (const h of HELPERS) {
      const marker = h.destructive ? '[destructive] ' : '              ';
      process.stdout.write(`  ${marker}${h.id.padEnd(34)} ${h.description}\n`);
    }
    return 0;
  },
};

export const helperGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show a helper definition (variables, safety flags).',
  usage: 'shrk helper get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk helper get <id>\n');
      return 2;
    }
    const def = HELPERS.find((h) => h.id === id);
    if (!def) {
      process.stderr.write(`Unknown helper: ${id}\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(def) + '\n');
      return 0;
    }
    process.stdout.write(header(`Helper: ${def.id}`));
    process.stdout.write(`  description     ${def.description}\n`);
    process.stdout.write(`  destructive     ${def.destructive ? 'yes' : 'no'}\n`);
    process.stdout.write(`  review          ${def.requiresHumanReview ? 'human review required' : 'auto'}\n`);
    process.stdout.write(`  variables       ${def.variables.length}\n`);
    for (const v of def.variables) {
      process.stdout.write(`    • ${v.name}${v.required ? ' (required)' : ''} — ${v.description}\n`);
    }
    return 0;
  },
};

export const helperPlanCommand: ICommandHandler = {
  name: 'plan',
  description:
    'Generate a plan-only helper plan (dry-run by default). Pass --save-plan <file> to emit a saved plan that flows through `shrk apply`.',
  usage:
    'shrk helper plan <id> --var k=v [--output <plan.json>] [--save-plan <file>] [--sign] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk helper plan <id> --var k=v\n');
      return 2;
    }
    const def = HELPERS.find((h) => h.id === id);
    if (!def) {
      process.stderr.write(`Unknown helper: ${id}\n`);
      return 1;
    }
    // Helpers with requiresProfile must error explicitly when no
    // profile is available. Today the helper-registry detects this inside
    // buildHelperPlan via requireProfile(); we surface a friendly message.
    if ('requiresProfile' in def && (def as { requiresProfile?: boolean }).requiresProfile) {
      process.stderr.write(
        `Helper "${id}" requires a plugin-lifecycle profile. Available:\n  $ shrk plugin lifecycle profiles\n`,
      );
      // Still try to build the plan; the registry throws with the same idea.
    }
    const cwd = resolveCwd(args);
    const vars = flagVars(args);
    try {
      const plan = buildHelperPlan({ helperId: id as HelperId, projectRoot: cwd, vars });
      const savePlanPath = flagString(args, 'save-plan');
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
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
  },
};

export const helperCommand: ICommandHandler = {
  name: 'helper',
  description: 'Helper plan generators (list / get / plan). Plan-only, dry-run default.',
  usage: 'shrk helper list|get <id>|plan <id> --var k=v',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'list') {
      args.positional = args.positional.slice(1);
      return helperListCommand.run(args);
    }
    if (sub === 'get') {
      args.positional = args.positional.slice(1);
      return helperGetCommand.run(args);
    }
    if (sub === 'plan') {
      args.positional = args.positional.slice(1);
      return helperPlanCommand.run(args);
    }
    process.stderr.write('Usage: shrk helper list|get <id>|plan <id>\n');
    return 2;
  },
};
