/**
 * `shrk plugin` commands, driven by pack/local lifecycle profiles.
 *
 * shrk plugin rename <old> <new> [--profile <id>] [--output <plan.json>] [--json]
 * shrk plugin remove <name>      [--profile <id>] [--output <plan.json>] [--json]
 * shrk plugin lifecycle list      [--profile <id>] [--json]
 * shrk plugin lifecycle inspect <name> [--profile <id>] [--json]
 * shrk plugin lifecycle profiles  [--json]
 * shrk plugin lifecycle profile <id> [--json]
 * shrk plugin lifecycle doctor    [--profile <id>] [--json]
 *
 * Every command is plan-only by default. Source is never written by these
 * commands — humans run the regular plan-apply flow with --verify-signature
 * after reviewing the produced plan.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildPluginLifecycleListing,
  buildPluginRemovePlan,
  buildPluginRenamePlan,
  checkPluginLifecycleProfileHealth,
  inspectSharkcraft,
  listPluginLifecycleProfiles,
  listPluginLifecycleProfileIssues,
  PLUGIN_LIFECYCLE_SYNTHETIC_TEMPLATE,
  pluginLifecyclePlanToSavedPlan,
  renderPluginLifecyclePlanText,
  resolvePluginLifecycleProfile,
} from '@shrkcrft/inspector';
import { savePlanToFile, signPlan } from '@shrkcrft/generator';
import {
  flagBool,
  flagString,
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

async function resolveProfileOrError(
  cwd: string,
  args: ParsedArgs,
): Promise<{ entry?: Awaited<ReturnType<typeof resolvePluginLifecycleProfile>>['entry']; exitCode?: number }> {
  const inspection = await inspectSharkcraft({ cwd });
  const profileId = flagString(args, 'profile');
  const resolved = await resolvePluginLifecycleProfile(inspection, {
    profileId,
    allowSingleDefault: true,
  });
  if (!resolved.entry) {
    process.stderr.write(`${resolved.error}\n`);
    return { exitCode: 2 };
  }
  return { entry: resolved.entry };
}

export const pluginRenameCommand: ICommandHandler = {
  name: 'rename',
  description:
    'Generate a plan-only rename plan for a plugin (profile-driven). Never writes source. Plan covers the profile key-table + barrels + folder ops (with --emit-folder-ops). Pass --save-plan <file> to emit a saved plan applicable through `shrk apply --allow-folder-ops`.',
  usage:
    'shrk plugin rename <old> <new> [--profile <id>] [--output <plan.json>] [--emit-folder-ops] [--save-plan <file>] [--sign] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const oldName = args.positional[0];
    const newName = args.positional[1];
    if (!oldName || !newName) {
      process.stderr.write('Usage: shrk plugin rename <old> <new> [--profile <id>]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = await resolveProfileOrError(cwd, args);
    if (!resolved.entry) return resolved.exitCode ?? 2;
    const plan = buildPluginRenamePlan({
      projectRoot: cwd,
      profile: resolved.entry.profile,
      oldName,
      newName,
      ...(flagBool(args, 'emit-folder-ops') ? { emitFolderOps: true } : {}),
    });
    const output = flagString(args, 'output');
    const savePlanPath = flagString(args, 'save-plan');
    if (savePlanPath) {
      const saved = pluginLifecyclePlanToSavedPlan(plan, cwd);
      let toWrite = saved as unknown as Parameters<typeof savePlanToFile>[0];
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
        process.stdout.write(renderPluginLifecyclePlanText(plan));
        process.stdout.write(
          `\nSaved plan to ${abs}\nApply: shrk apply ${abs} --allow-folder-ops${plan.action === 'remove' ? ' --allow-delete-folder' : ''} --verify-signature\n`,
        );
      } else {
        process.stdout.write(asJson({ saved: abs, plan }) + '\n');
      }
      return 0;
    }
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
    process.stdout.write(renderPluginLifecyclePlanText(plan));
    if (output) {
      const abs = writePlanFile(asJson(plan), output, cwd);
      process.stdout.write(`\nSaved plan to ${abs}\n`);
    }
    return 0;
  },
};

export const pluginRemoveCommand: ICommandHandler = {
  name: 'remove',
  description:
    'Generate a plan-only remove plan for a plugin (profile-driven). Destructive; requires human approval. Source is never written. Pass --save-plan <file> to emit a saved plan applicable through `shrk apply --allow-folder-ops --allow-delete-folder`.',
  usage:
    'shrk plugin remove <name> [--profile <id>] [--output <plan.json>] [--emit-folder-ops] [--save-plan <file>] [--sign] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const name = args.positional[0];
    if (!name) {
      process.stderr.write('Usage: shrk plugin remove <name> [--profile <id>]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = await resolveProfileOrError(cwd, args);
    if (!resolved.entry) return resolved.exitCode ?? 2;
    const plan = buildPluginRemovePlan({
      projectRoot: cwd,
      profile: resolved.entry.profile,
      oldName: name,
      ...(flagBool(args, 'emit-folder-ops') ? { emitFolderOps: true } : {}),
    });
    const output = flagString(args, 'output');
    const savePlanPath = flagString(args, 'save-plan');
    if (savePlanPath) {
      const saved = pluginLifecyclePlanToSavedPlan(plan, cwd);
      let toWrite = saved as unknown as Parameters<typeof savePlanToFile>[0];
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
        process.stdout.write(renderPluginLifecyclePlanText(plan));
        process.stdout.write(
          `\n⚠ DESTRUCTIVE — saved plan written to ${abs}\nApply: shrk apply ${abs} --allow-folder-ops --allow-delete-folder --verify-signature\n`,
        );
      } else {
        process.stdout.write(asJson({ saved: abs, plan }) + '\n');
      }
      return 0;
    }
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
    process.stdout.write(renderPluginLifecyclePlanText(plan));
    process.stdout.write('\n⚠ DESTRUCTIVE — human approval required before any of these steps.\n');
    if (output) {
      const abs = writePlanFile(asJson(plan), output, cwd);
      process.stdout.write(`\nSaved plan to ${abs}\n`);
    }
    return 0;
  },
};

export const pluginLifecycleListCommand: ICommandHandler = {
  name: 'list',
  description: 'List plugins detected under the profile plugin roots + profile key-table entries.',
  usage: 'shrk plugin lifecycle list [--profile <id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const resolved = await resolveProfileOrError(cwd, args);
    if (!resolved.entry) return resolved.exitCode ?? 2;
    const listing = buildPluginLifecycleListing({ projectRoot: cwd, profile: resolved.entry.profile });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(listing) + '\n');
      return 0;
    }
    process.stdout.write(header(`Plugins by layer (profile=${resolved.entry.profile.id})`));
    for (const [layer, names] of Object.entries(listing.pluginsByLayer)) {
      process.stdout.write(`  ${layer} (${names.length})\n`);
      for (const n of names) process.stdout.write(`    • ${n}\n`);
    }
    process.stdout.write(header('Key table'));
    for (const k of listing.pluginKeys) {
      process.stdout.write(`  ${k.key.padEnd(28)} '${k.value}'\n`);
    }
    return 0;
  },
};

export const pluginLifecycleInspectCommand: ICommandHandler = {
  name: 'inspect',
  description: 'Inspect a plugin: which layers reference it, key-table entry, barrels.',
  usage: 'shrk plugin lifecycle inspect <name> [--profile <id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const name = args.positional[0];
    if (!name) {
      process.stderr.write('Usage: shrk plugin lifecycle inspect <name>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const resolved = await resolveProfileOrError(cwd, args);
    if (!resolved.entry) return resolved.exitCode ?? 2;
    const listing = buildPluginLifecycleListing({ projectRoot: cwd, profile: resolved.entry.profile });
    const presentInLayers = Object.entries(listing.pluginsByLayer)
      .filter(([, names]) => names.includes(name))
      .map(([layer]) => layer);
    const keyEntry = listing.pluginKeys.find((k) => k.value === name);
    const report = {
      name,
      profile: resolved.entry.profile.id,
      presentInLayers,
      pluginKeysEntry: keyEntry ?? null,
    };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(header(`Plugin inspect: ${name}`));
    process.stdout.write(`  profile      ${resolved.entry.profile.id}\n`);
    process.stdout.write(
      `  layers       ${presentInLayers.length > 0 ? presentInLayers.join(', ') : '(none)'}\n`,
    );
    process.stdout.write(
      `  key entry    ${keyEntry ? `${keyEntry.key} = '${keyEntry.value}'` : '(not registered)'}\n`,
    );
    return 0;
  },
};

export const pluginLifecycleProfilesCommand: ICommandHandler = {
  name: 'profiles',
  description: 'List registered plugin lifecycle profiles (pack + local).',
  usage: 'shrk plugin lifecycle profiles [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entries = await listPluginLifecycleProfiles(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entries) + '\n');
      return 0;
    }
    process.stdout.write(header('Plugin lifecycle profiles'));
    if (entries.length === 0) {
      process.stdout.write(
        '  (none registered — contribute via a pack manifest "pluginLifecycleProfileFiles" entry or sharkcraft/plugin-lifecycle-profiles.ts)\n',
      );
      return 0;
    }
    for (const e of entries) {
      const src = e.source === 'pack' ? `pack:${e.packageName}` : e.source;
      process.stdout.write(`  • ${e.profile.id.padEnd(20)} ${e.profile.title}  [${src}]\n`);
      if (e.profile.description) {
        process.stdout.write(`      ${e.profile.description}\n`);
      }
    }
    return 0;
  },
};

export const pluginLifecycleProfileCommand: ICommandHandler = {
  name: 'profile',
  description: 'Show a single plugin lifecycle profile.',
  usage: 'shrk plugin lifecycle profile <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk plugin lifecycle profile <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entries = await listPluginLifecycleProfiles(inspection);
    const entry = entries.find((e) => e.profile.id === id);
    if (!entry) {
      process.stderr.write(
        `Unknown profile "${id}". Available: ${entries.length === 0 ? '(none)' : entries.map((e) => e.profile.id).join(', ')}.\n`,
      );
      return 2;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entry) + '\n');
      return 0;
    }
    process.stdout.write(header(`Profile ${entry.profile.id}`));
    process.stdout.write(`  title         ${entry.profile.title}\n`);
    if (entry.profile.description) process.stdout.write(`  description   ${entry.profile.description}\n`);
    process.stdout.write(`  source        ${entry.source}${entry.packageName ? ' (' + entry.packageName + ')' : ''}\n`);
    process.stdout.write(`  sourceFile    ${entry.sourceFile}\n`);
    process.stdout.write(`  pluginRoots:\n`);
    for (const r of entry.profile.pluginRoots) {
      process.stdout.write(`    • ${r.id.padEnd(12)} ${r.path}${r.kind ? ' [' + r.kind + ']' : ''}\n`);
    }
    if (entry.profile.barrels && entry.profile.barrels.length > 0) {
      process.stdout.write(`  barrels:\n`);
      for (const b of entry.profile.barrels) {
        process.stdout.write(`    • ${b.id.padEnd(12)} ${b.path}\n`);
      }
    }
    if (entry.profile.keyTable) {
      process.stdout.write(
        `  keyTable      ${entry.profile.keyTable.path} (key=${entry.profile.keyTable.keyCase} value=${entry.profile.keyTable.valueCase})\n`,
      );
    }
    if (entry.profile.validationCommands && entry.profile.validationCommands.length > 0) {
      process.stdout.write(`  validation:\n`);
      for (const c of entry.profile.validationCommands) process.stdout.write(`    $ ${c}\n`);
    }
    return 0;
  },
};

export const pluginLifecycleDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Lifecycle-profile doctor: surface load issues + check profile paths exist.',
  usage: 'shrk plugin lifecycle doctor [--profile <id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const profileId = flagString(args, 'profile');
    const issues = [...(await listPluginLifecycleProfileIssues(inspection))];
    const healthByProfile: Record<string, ReturnType<typeof checkPluginLifecycleProfileHealth>> = {};
    const entries = await listPluginLifecycleProfiles(inspection);
    const targets = profileId ? entries.filter((e) => e.profile.id === profileId) : entries;
    if (profileId && targets.length === 0) {
      process.stderr.write(
        `Unknown profile "${profileId}". Available: ${entries.map((e) => e.profile.id).join(', ') || '(none)'}.\n`,
      );
      return 2;
    }
    for (const e of targets) {
      healthByProfile[e.profile.id] = checkPluginLifecycleProfileHealth(cwd, e.profile);
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ registryIssues: issues, healthByProfile }) + '\n');
      return 0;
    }
    process.stdout.write(header('Lifecycle profile doctor'));
    if (issues.length === 0) {
      process.stdout.write('  Registry: ok (no load issues)\n');
    } else {
      process.stdout.write(`  Registry issues (${issues.length}):\n`);
      for (const i of issues) {
        process.stdout.write(`    ${i.severity.padEnd(7)} [${i.code}] ${i.message}\n`);
      }
    }
    for (const [id, checks] of Object.entries(healthByProfile)) {
      process.stdout.write(`\n  ${id}:\n`);
      for (const c of checks) {
        process.stdout.write(`    ${c.severity.padEnd(7)} ${c.message}\n`);
      }
    }
    return 0;
  },
};

export const pluginLifecycleCommand: ICommandHandler = {
  name: 'lifecycle',
  description: 'Inspect / list profile-driven plugins; manage lifecycle profiles.',
  usage: 'shrk plugin lifecycle list|inspect|profiles|profile|doctor ...',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    args.positional = args.positional.slice(1);
    if (sub === 'list') return pluginLifecycleListCommand.run(args);
    if (sub === 'inspect') return pluginLifecycleInspectCommand.run(args);
    if (sub === 'profiles') return pluginLifecycleProfilesCommand.run(args);
    if (sub === 'profile') return pluginLifecycleProfileCommand.run(args);
    if (sub === 'doctor') return pluginLifecycleDoctorCommand.run(args);
    process.stderr.write('Usage: shrk plugin lifecycle list|inspect|profiles|profile|doctor ...\n');
    return 2;
  },
};

export const pluginCommand: ICommandHandler = {
  name: 'plugin',
  description:
    'Plugin lifecycle helpers (profile-driven). Plan-only — every command emits a structured plan that a human must review and apply.',
  usage: 'shrk plugin rename|remove|lifecycle ...',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    args.positional = args.positional.slice(1);
    if (sub === 'rename') return pluginRenameCommand.run(args);
    if (sub === 'remove') return pluginRemoveCommand.run(args);
    if (sub === 'lifecycle') return pluginLifecycleCommand.run(args);
    process.stderr.write('Usage: shrk plugin rename|remove|lifecycle ...\n');
    return 2;
  },
};
