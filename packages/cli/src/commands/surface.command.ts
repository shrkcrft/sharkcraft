import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv, table } from '../output/format-output.ts';
import { loadSurfaceContext } from '../surface/load-surface-context.ts';
import {
  buildSurfaceSummary,
  findCommandInSummary,
  type ISurfaceCommandView,
  type ISurfaceSummary,
} from '../surface/surface-summary.ts';
import { CommandTier } from './command-catalog.ts';
import {
  applySurfaceEdit,
  defaultConfigFile,
  planSurfaceEdit,
  type ISurfaceConfigEdit,
} from '../surface/surface-config-writer.ts';

/**
 * `shrk surface`. Top-level introspection + opt-in management
 * for the adaptive command surface. Subcommands:
 *
 *   - list                  every command grouped by tier
 *   - enable  <command>     promote experimental → callable
 *   - disable <command>     undo a prior enable
 *   - hide    <command>     hide an extended command from --help
 *   - unhide  <command>     reverse hide
 *   - reset                 clear surface.enabled + surface.hidden
 *   - explain <command>     why this command has its current tier
 *   - profiles [get <id>]   list surface profiles (or show one)
 */
export const surfaceCommand: ICommandHandler = {
  name: 'surface',
  description:
    'Inspect or change the adaptive command surface (core / extended / experimental tiers).',
  usage:
    'shrk surface <list|enable|disable|hide|unhide|reset|explain|profiles> [name] [--write] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const [verb, ...rest] = args.positional;
    const json = flagBool(args, 'json');
    const write = flagBool(args, 'write');
    const cwd = resolveCwd(args);

    switch (verb) {
      case undefined:
      case 'list':
        return await runList({ cwd, json });
      case 'explain':
        return await runExplain({ cwd, json, target: rest[0] });
      case 'enable':
        return await runMutate({ cwd, json, write, target: rest[0], op: 'enable' });
      case 'disable':
        return await runMutate({ cwd, json, write, target: rest[0], op: 'disable' });
      case 'hide':
        return await runMutate({ cwd, json, write, target: rest[0], op: 'hide' });
      case 'unhide':
        return await runMutate({ cwd, json, write, target: rest[0], op: 'unhide' });
      case 'reset':
        return await runReset({ cwd, json, write });
      case 'profiles':
        return await runProfiles({ cwd, json, sub: rest[0], target: rest[1] });
      default:
        process.stderr.write(`Unknown subcommand: surface ${verb}\nSee \`shrk surface --help\`.\n`);
        return 2;
    }
  },
};

async function runProfiles(opts: { cwd: string; json: boolean; sub: string | undefined; target: string | undefined }): Promise<number> {
  const { context, inspection, availableProfiles, activeProfile } = await loadSurfaceContext({ cwd: opts.cwd });
  void inspection;
  void context;
  if (!opts.sub || opts.sub === 'list') {
    if (opts.json) {
      process.stdout.write(asJson({
        schema: 'sharkcraft.surface.profiles.v1',
        active: activeProfile?.id ?? null,
        profiles: availableProfiles,
      }) + '\n');
      return 0;
    }
    process.stdout.write(header('Surface profiles'));
    process.stdout.write(kv('active', activeProfile?.id ?? '(none — set via sharkcraft.config.ts surface.profile)') + '\n');
    process.stdout.write('\n');
    for (const p of availableProfiles) {
      const isActive = activeProfile?.id === p.id;
      const tag = isActive ? '*' : ' ';
      const src = p.source === 'pack' ? ` (pack: ${p.pack})` : ` (builtin)`;
      const hiddenCount = p.hidden?.length ?? 0;
      const enabledCount = p.enabled?.length ?? 0;
      process.stdout.write(`  ${tag} ${p.id.padEnd(14)} ${src.padEnd(20)} hides=${hiddenCount}, enables=${enabledCount}\n`);
      process.stdout.write(`      ${p.description}\n`);
    }
    return 0;
  }
  if (opts.sub === 'get') {
    if (!opts.target) {
      process.stderr.write('Usage: shrk surface profiles get <id>\n');
      return 2;
    }
    const found = availableProfiles.find((p) => p.id === opts.target);
    if (!found) {
      process.stderr.write(`Unknown profile: ${opts.target}\n`);
      return 2;
    }
    if (opts.json) {
      process.stdout.write(asJson(found) + '\n');
      return 0;
    }
    process.stdout.write(header(`Profile — ${found.id}`));
    process.stdout.write(kv('description', found.description) + '\n');
    process.stdout.write(kv('source', found.source + (found.pack ? ` (${found.pack})` : '')) + '\n');
    process.stdout.write(kv('hidden', String(found.hidden?.length ?? 0)) + '\n');
    process.stdout.write(kv('enabled', String(found.enabled?.length ?? 0)) + '\n');
    if (found.hidden && found.hidden.length > 0) {
      process.stdout.write('\nHidden:\n');
      for (const h of found.hidden) process.stdout.write(`  - ${h}\n`);
    }
    if (found.enabled && found.enabled.length > 0) {
      process.stdout.write('\nEnabled:\n');
      for (const e of found.enabled) process.stdout.write(`  + ${e}\n`);
    }
    return 0;
  }
  process.stderr.write(`Unknown subcommand: surface profiles ${opts.sub}\nUse: list, get <id>\n`);
  return 2;
}

interface IListArgs {
  cwd: string;
  json: boolean;
}

async function runList({ cwd, json }: IListArgs): Promise<number> {
  const { context, activeProfile } = await loadSurfaceContext({ cwd });
  const summary = buildSurfaceSummary(context);

  if (json) {
    process.stdout.write(asJson({ ...summary, activeProfile: activeProfile?.id ?? null }) + '\n');
    return 0;
  }

  renderSurfaceText(summary, activeProfile?.id);
  return 0;
}

function renderSurfaceText(summary: ISurfaceSummary, activeProfileId?: string): void {
  process.stdout.write(header('Command surface'));
  process.stdout.write(kv('schema', summary.schema) + '\n');
  process.stdout.write(kv('hash', summary.hash) + '\n');
  process.stdout.write(kv('profile', activeProfileId ?? '(none — sharkcraft.config.ts surface.profile not set)') + '\n');
  process.stdout.write(kv('core', String(summary.totals.core)) + '\n');
  process.stdout.write(kv('extended', String(summary.totals.extended)) + '\n');
  process.stdout.write(kv('experimental', String(summary.totals.experimental)) + '\n');
  process.stdout.write(kv('visible in --help', String(summary.totals.visible)) + '\n');
  process.stdout.write(kv('callable', String(summary.totals.callable)) + '\n');
  process.stdout.write('\n');

  printBucket('core', summary.tiers.core);
  printBucket('extended', summary.tiers.extended);
  printBucket('experimental', summary.tiers.experimental);

  if (summary.warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const w of summary.warnings) {
      process.stdout.write(`  ! ${w.code}: ${w.message}\n`);
    }
  }
}

function printBucket(label: string, items: readonly ISurfaceCommandView[]): void {
  process.stdout.write(`-- ${label} (${items.length}) --\n`);
  if (items.length === 0) {
    process.stdout.write('  (empty)\n');
    return;
  }
  const rows = items.map((c) => {
    const flags: string[] = [];
    if (c.hidden) flags.push('hidden');
    if (c.enabled) flags.push('enabled');
    if (!c.callable) flags.push('gated');
    if (c.pack) flags.push(`pack:${c.pack}`);
    return [
      '  ' + c.command,
      c.source,
      flags.join(','),
      c.detail ?? '',
    ];
  });
  process.stdout.write(table(rows) + '\n');
}

interface IExplainArgs {
  cwd: string;
  json: boolean;
  target: string | undefined;
}

async function runExplain({ cwd, json, target }: IExplainArgs): Promise<number> {
  if (!target) {
    process.stderr.write('Usage: shrk surface explain <command>\n');
    return 2;
  }
  const { context, activeProfile, availableProfiles } = await loadSurfaceContext({ cwd });
  const summary = buildSurfaceSummary(context);
  const view = findCommandInSummary(summary, target);
  if (!view) {
    // A common mix-up: `surface explain <profile>`. `explain` is for commands;
    // point the user at the profile-aware verb instead of a bare "unknown".
    if (availableProfiles.some((p) => p.id === target)) {
      process.stderr.write(
        `'${target}' is a surface profile, not a command. Try: shrk surface profiles get ${target}\n`,
      );
      return 2;
    }
    process.stderr.write(`Unknown command: ${target}\n`);
    return 2;
  }

  // Attribute the hide/enable to a profile when one is active.
  const hiddenByProfile = !!activeProfile?.hidden?.includes(target);
  const enabledByProfile = !!activeProfile?.enabled?.includes(target);

  if (json) {
    process.stdout.write(
      asJson({
        ...view,
        activeProfile: activeProfile?.id ?? null,
        hiddenByProfile,
        enabledByProfile,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(header(`Surface — ${target}`));
  process.stdout.write(kv('tier', view.tier) + '\n');
  process.stdout.write(kv('source', view.source) + '\n');
  if (view.detail) process.stdout.write(kv('detail', view.detail) + '\n');
  process.stdout.write(kv('callable', String(view.callable)) + '\n');
  process.stdout.write(kv('visible-in-help', String(view.visibleInHelp)) + '\n');
  process.stdout.write(kv('hidden-by-config', String(view.hidden)) + '\n');
  process.stdout.write(kv('enabled-by-config', String(view.enabled)) + '\n');
  if (view.pack) process.stdout.write(kv('pack', view.pack) + '\n');
  if (activeProfile) {
    process.stdout.write(kv('active-profile', activeProfile.id + (activeProfile.pack ? ` (${activeProfile.pack})` : ' (builtin)')) + '\n');
    if (hiddenByProfile) process.stdout.write(kv('hidden-by-profile', 'yes — profile hides this from --help') + '\n');
    if (enabledByProfile) process.stdout.write(kv('enabled-by-profile', 'yes — profile turns this on') + '\n');
  }

  if (view.tier === CommandTier.Experimental && !view.callable) {
    process.stdout.write('\nWhy gated: ' + (view.detail ?? 'experimental — opt-in required.') + '\n');
    process.stdout.write('\nTo enable:\n');
    process.stdout.write(`  $ shrk surface enable ${target} --write\n`);
    if (activeProfile) {
      process.stdout.write(`\nOr switch profile (current: ${activeProfile.id}):\n`);
      process.stdout.write('  $ shrk surface profiles list\n');
    }
  } else if (view.tier === CommandTier.Extended && view.hidden) {
    const reason = hiddenByProfile
      ? `Hidden by the active profile (${activeProfile?.id}).`
      : 'Hidden by surface.hidden in sharkcraft.config.ts.';
    process.stdout.write('\n' + reason + ' To restore visibility:\n');
    process.stdout.write(`  $ shrk surface unhide ${target} --write\n`);
  }

  return 0;
}

interface IMutateArgs {
  cwd: string;
  json: boolean;
  write: boolean;
  target: string | undefined;
  op: 'enable' | 'disable' | 'hide' | 'unhide';
}

async function runMutate({ cwd, json, write, target, op }: IMutateArgs): Promise<number> {
  if (!target) {
    process.stderr.write(`Usage: shrk surface ${op} <command> [--write]\n`);
    return 2;
  }
  const { context, inspection } = await loadSurfaceContext({ cwd });
  const summary = buildSurfaceSummary(context);
  const view = findCommandInSummary(summary, target);
  if (!view) {
    process.stderr.write(`Unknown command: ${target}\n`);
    return 2;
  }

  const refusal = refuseIfInvalid(op, view);
  if (refusal) {
    process.stderr.write(refusal + '\n');
    return 2;
  }

  const edit: ISurfaceConfigEdit = toEdit(op, target);
  const configFile = inspection.configFile ?? defaultConfigFile(
    inspection.sharkcraftDir ?? `${cwd}/sharkcraft`,
  );
  const diff = planSurfaceEdit(configFile, context.surfaceConfig, [edit]);

  if (json) {
    process.stdout.write(asJson({ diff, willWrite: write }) + '\n');
  } else {
    renderDiffText(diff, write);
  }

  if (!write) return 0;

  const result = applySurfaceEdit(diff);
  if (!json) {
    process.stdout.write(`\nWrote ${result.configFile} (${result.edits.length} edit${result.edits.length === 1 ? '' : 's'}).\n`);
  }
  return 0;
}

function refuseIfInvalid(op: IMutateArgs['op'], view: ISurfaceCommandView): string | null {
  if (view.tier === CommandTier.Core && (op === 'disable' || op === 'hide')) {
    return `Cannot ${op} a core command (${view.command}).`;
  }
  if (op === 'hide' && view.tier === CommandTier.Experimental) {
    return `Cannot hide an experimental command (${view.command}); use disable instead.`;
  }
  if (op === 'enable' && view.tier !== CommandTier.Experimental && !view.enabled) {
    return `Refusing no-op: ${view.command} is not experimental (tier=${view.tier}).`;
  }
  if (op === 'disable' && !view.enabled) {
    return `Refusing no-op: ${view.command} is not currently enabled.`;
  }
  if (op === 'unhide' && !view.hidden) {
    return `Refusing no-op: ${view.command} is not currently hidden.`;
  }
  return null;
}

function toEdit(op: IMutateArgs['op'], command: string): ISurfaceConfigEdit {
  switch (op) {
    case 'enable':
      return { field: 'enabled', command, operation: 'add' };
    case 'disable':
      return { field: 'enabled', command, operation: 'remove' };
    case 'hide':
      return { field: 'hidden', command, operation: 'add' };
    case 'unhide':
      return { field: 'hidden', command, operation: 'remove' };
  }
}

interface IResetArgs {
  cwd: string;
  json: boolean;
  write: boolean;
}

async function runReset({ cwd, json, write }: IResetArgs): Promise<number> {
  const { context, inspection } = await loadSurfaceContext({ cwd });
  const edits: ISurfaceConfigEdit[] = [];
  for (const name of context.surfaceConfig?.enabled ?? []) {
    edits.push({ field: 'enabled', command: name, operation: 'remove' });
  }
  for (const name of context.surfaceConfig?.hidden ?? []) {
    edits.push({ field: 'hidden', command: name, operation: 'remove' });
  }

  const configFile = inspection.configFile ?? defaultConfigFile(
    inspection.sharkcraftDir ?? `${cwd}/sharkcraft`,
  );
  const diff = planSurfaceEdit(configFile, context.surfaceConfig, edits);

  if (json) {
    process.stdout.write(asJson({ diff, willWrite: write }) + '\n');
  } else {
    renderDiffText(diff, write);
  }

  if (!write) return 0;
  applySurfaceEdit(diff);
  if (!json) process.stdout.write(`\nWrote ${diff.configFile} (reset).\n`);
  return 0;
}

function renderDiffText(diff: { configFile: string; edits: readonly ISurfaceConfigEdit[] }, willWrite: boolean): void {
  process.stdout.write(header('Surface config edit'));
  process.stdout.write(kv('configFile', diff.configFile) + '\n');
  process.stdout.write(kv('edits', String(diff.edits.length)) + '\n');
  for (const edit of diff.edits) {
    const sign = edit.operation === 'add' ? '+' : '-';
    process.stdout.write(`  ${sign} surface.${edit.field}: ${edit.command}\n`);
  }
  if (!willWrite) {
    process.stdout.write('\nDry run. Pass --write to apply.\n');
  }
}
