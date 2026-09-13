import type { ISurfaceConfig } from '@shrkcrft/config';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { asJson, header, kv, table } from '../output/format-output.ts';
import { loadSurfaceContext, type ILoadedSurfaceContext } from '../surface/load-surface-context.ts';
import {
  buildSurfaceSummary,
  findCommandInSummary,
  type ISurfaceCommandView,
  type ISurfaceSummary,
} from '../surface/surface-summary.ts';
import { CommandAudience, CommandTier } from './command-catalog.ts';
import { CommandDispatchKind } from '../surface/command-dispatch-kind.ts';
import { isBootstrapFamily, TierSource } from '../surface/tier.ts';
import { firstMatchingSelector, matchesSurfaceSelector } from '../surface/surface-selector.ts';
import { surfaceRefusalFor } from '../surface/not-enabled-error.ts';
import { SurfaceLayer } from '../surface/surface-layer.ts';
import { SurfaceRefusalReason } from '../surface/surface-refusal-reason.ts';
import {
  applySurfaceEdit,
  defaultConfigFile,
  planSurfaceEdit,
  type ISurfaceConfigDiff,
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
 *   - deny    <selector>    disable a command or a group (`<group> *`)
 *   - allow   <selector>    reverse a deny
 *   - reset                 clear surface.enabled + hidden + disabled
 *   - explain <command>     why this command has its current tier
 *   - profiles [get <id>]   list surface profiles (or show one)
 *
 * Every mutation edits the project config's OWN `surface{}` block (never the
 * profile-merged view) and preserves its `profile`.
 */
export const surfaceCommand: ICommandHandler = {
  name: 'surface',
  positionals: PositionalMode.None,
  subverbs: [
    { name: 'list', description: 'Every command grouped by tier (the default).', usage: 'shrk surface list [--json]' },
    { name: 'explain', description: 'Why a command has its current tier.', usage: 'shrk surface explain <command> [--json]', positionals: PositionalMode.Free },
    { name: 'enable', description: 'Promote an experimental (or gated tool-maintenance) command to callable.', usage: 'shrk surface enable <command> [--write] [--json]', positionals: PositionalMode.Free },
    { name: 'disable', description: 'Undo a prior enable.', usage: 'shrk surface disable <command> [--write] [--json]', positionals: PositionalMode.Free },
    { name: 'hide', description: 'Hide an extended command from --help.', usage: 'shrk surface hide <command> [--write] [--json]', positionals: PositionalMode.Free },
    { name: 'unhide', description: 'Reverse a hide.', usage: 'shrk surface unhide <command> [--write] [--json]', positionals: PositionalMode.Free },
    {
      name: 'deny',
      description: 'Disable a command or a group (`<group> *`) here: not callable (exit 78), absent from --help.',
      usage: "shrk surface deny <command|'<group> *'> [--write] [--json]",
      positionals: PositionalMode.Free,
    },
    {
      name: 'allow',
      description: 'Reverse a deny: remove the selector from surface.disabled.',
      usage: "shrk surface allow <command|'<group> *'> [--write] [--json]",
      positionals: PositionalMode.Free,
    },
    { name: 'reset', description: 'Clear surface.enabled + surface.hidden + surface.disabled.', usage: 'shrk surface reset [--write] [--json]' },
    { name: 'profiles', description: 'List the surface profiles, or show one.', usage: 'shrk surface profiles [get <id>] [--json]', positionals: PositionalMode.Free },
  ],
  description:
    'Inspect or change the adaptive command surface (core / extended / experimental tiers).',
  usage:
    'shrk surface <list|enable|disable|hide|unhide|deny|allow|reset|explain|profiles> [name] [--write] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const [verb, ...rest] = args.positional;
    const json = flagBool(args, 'json');
    const write = flagBool(args, 'write');
    const cwd = resolveCwd(args);
    // A multi-word path (`surface enable docs check`) names ONE command.
    const target = rest.length > 0 ? rest.join(' ') : undefined;

    switch (verb) {
      case undefined:
      case 'list':
        return await runList({ cwd, json });
      case 'explain':
        return await runExplain({ cwd, json, target });
      case 'enable':
      case 'disable':
      case 'hide':
      case 'unhide':
        return await runMutate({ cwd, json, write, target, op: verb });
      case 'deny':
        return await runDeny({ cwd, json, write, target });
      case 'allow':
        return await runAllow({ cwd, json, write, target });
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

/** The project config's OWN `surface{}` block — what every mutation edits. */
function rawSurface(loaded: ILoadedSurfaceContext): ISurfaceConfig | undefined {
  return loaded.inspection.config?.surface ?? undefined;
}

function configFileOf(loaded: ILoadedSurfaceContext, cwd: string): string {
  return (
    loaded.inspection.configFile ??
    defaultConfigFile(loaded.inspection.sharkcraftDir ?? `${cwd}/sharkcraft`)
  );
}

function allViews(summary: ISurfaceSummary): ISurfaceCommandView[] {
  return [...summary.tiers.core, ...summary.tiers.extended, ...summary.tiers.experimental];
}

async function runProfiles(opts: { cwd: string; json: boolean; sub: string | undefined; target: string | undefined }): Promise<number> {
  const { availableProfiles, activeProfile } = await loadSurfaceContext({ cwd: opts.cwd });
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
      const disabledCount = p.disabled?.length ?? 0;
      process.stdout.write(
        `  ${tag} ${p.id.padEnd(14)} ${src.padEnd(20)} hides=${hiddenCount}, enables=${enabledCount}, disables=${disabledCount}\n`,
      );
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
    process.stdout.write(kv('disabled', String(found.disabled?.length ?? 0)) + '\n');
    if (found.hidden && found.hidden.length > 0) {
      process.stdout.write('\nHidden:\n');
      for (const h of found.hidden) process.stdout.write(`  - ${h}\n`);
    }
    if (found.enabled && found.enabled.length > 0) {
      process.stdout.write('\nEnabled:\n');
      for (const e of found.enabled) process.stdout.write(`  + ${e}\n`);
    }
    if (found.disabled && found.disabled.length > 0) {
      process.stdout.write('\nDisabled:\n');
      for (const d of found.disabled) process.stdout.write(`  x ${d}\n`);
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
    process.stdout.write(
      asJson({ ...summary, activeProfile: activeProfile?.id ?? null, isToolRepo: context.isToolRepo }) + '\n',
    );
    return 0;
  }

  renderSurfaceText(summary, activeProfile?.id, context.isToolRepo);
  return 0;
}

function renderSurfaceText(summary: ISurfaceSummary, activeProfileId: string | undefined, isToolRepo: boolean): void {
  process.stdout.write(header('Command surface'));
  process.stdout.write(kv('schema', summary.schema) + '\n');
  process.stdout.write(kv('hash', summary.hash) + '\n');
  process.stdout.write(kv('profile', activeProfileId ?? '(none — sharkcraft.config.ts surface.profile not set)') + '\n');
  process.stdout.write(
    kv(
      'host',
      isToolRepo
        ? "SharkCraft's own repository (tool-maintenance commands callable)"
        : 'not the SharkCraft repository (tool-maintenance commands gated)',
    ) + '\n',
  );
  process.stdout.write(kv('core', String(summary.totals.core)) + '\n');
  process.stdout.write(kv('extended', String(summary.totals.extended)) + '\n');
  process.stdout.write(kv('experimental', String(summary.totals.experimental)) + '\n');
  process.stdout.write(kv('visible in --help', String(summary.totals.visible)) + '\n');
  process.stdout.write(kv('callable', String(summary.totals.callable)) + '\n');
  process.stdout.write(kv('uncatalogued', String(summary.totals.uncatalogued)) + '\n');
  if (!summary.registryBacked) {
    // Only reachable from a direct engine call: never pass a partial listing
    // off as the dispatch table.
    process.stdout.write(
      kv('inventory', 'PARTIAL — catalog rows only (no command registry); run `shrk surface list`') + '\n',
    );
  }
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
  // command | what it does | who it is for | flags. The tier `detail` stays in
  // `surface explain` and `--json`: it used to be the only text column, and
  // for every extended row it was the same placeholder sentence. The audience
  // column answers "is this for me?" next to "does this exist?".
  const rows = items.map((c) => {
    const flags: string[] = [];
    if (c.hidden) flags.push('hidden');
    if (c.enabled) flags.push('enabled');
    if (c.disabled) flags.push('disabled');
    if (!c.callable) flags.push('gated');
    if (!c.catalogued && c.dispatch !== CommandDispatchKind.Meta) flags.push('uncatalogued');
    if (c.audience.includes(CommandAudience.ToolMaintenance)) flags.push('tool-maintenance');
    if (c.pack) flags.push(`pack:${c.pack}`);
    return ['  ' + c.command, oneLineDescription(c.description), c.audience.join(','), flags.join(',')];
  });
  process.stdout.write(table(rows) + '\n');
}

/** First sentence of a description, at most 72 characters. */
function oneLineDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const dot = flat.search(/[.!?](\s|$)/);
  const sentence = dot > 0 ? flat.slice(0, dot + 1) : flat;
  return sentence.length > 72 ? sentence.slice(0, 71).trimEnd() + '…' : sentence;
}

/** Why a view has its tier, when the resolver attached no detail. */
function tierExplanation(view: ISurfaceCommandView): string | undefined {
  if (view.detail) return view.detail;
  if (view.source === TierSource.Default) {
    return `${view.tier} — default tier (not in a spine pipeline, not pack-contributed)`;
  }
  return undefined;
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

  // Attribute the hide/enable to a profile when one is active (the same
  // selector matcher the resolver uses — `bundle *` names `bundle list`).
  const hiddenByProfile = firstMatchingSelector(activeProfile?.hidden, [view.command]) !== undefined;
  const enabledByProfile = firstMatchingSelector(activeProfile?.enabled, [view.command]) !== undefined;
  const disabledByProfile = view.deniedBy?.origin === SurfaceLayer.Profile;

  if (json) {
    process.stdout.write(
      asJson({
        ...view,
        activeProfile: activeProfile?.id ?? null,
        isToolRepo: context.isToolRepo,
        hiddenByProfile,
        enabledByProfile,
        disabledByProfile,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(header(`Surface — ${view.command}`));
  process.stdout.write(kv('description', view.description) + '\n');
  if (view.usage) process.stdout.write(kv('usage', view.usage) + '\n');
  process.stdout.write(kv('dispatch', view.dispatch) + '\n');
  process.stdout.write(
    kv(
      'catalogued',
      view.catalogued
        ? 'yes'
        : context.isToolRepo
          ? 'no — run `shrk commands doctor`'
          : "no — missing from SharkCraft's command catalog (a SharkCraft catalog gap)",
    ) + '\n',
  );
  process.stdout.write(kv('audience', view.audience.join(', ')) + '\n');
  if (view.variants.length > 0) process.stdout.write(kv('variants', view.variants.join(' · ')) + '\n');
  process.stdout.write(kv('tier', view.tier) + '\n');
  process.stdout.write(kv('source', view.source) + '\n');
  const explanation = tierExplanation(view);
  if (explanation) process.stdout.write(kv('detail', explanation) + '\n');
  process.stdout.write(kv('callable', String(view.callable)) + '\n');
  process.stdout.write(kv('visible-in-help', String(view.visibleInHelp)) + '\n');
  process.stdout.write(kv('hidden-by-config', String(view.hidden)) + '\n');
  process.stdout.write(kv('enabled-by-config', String(view.enabled)) + '\n');
  process.stdout.write(kv('disabled', String(view.disabled)) + '\n');
  if (view.pack) process.stdout.write(kv('pack', view.pack) + '\n');
  if (activeProfile) {
    process.stdout.write(kv('active-profile', activeProfile.id + (activeProfile.pack ? ` (${activeProfile.pack})` : ' (builtin)')) + '\n');
    if (hiddenByProfile) process.stdout.write(kv('hidden-by-profile', 'yes — profile hides this from --help') + '\n');
    if (enabledByProfile) process.stdout.write(kv('enabled-by-profile', 'yes — profile turns this on') + '\n');
    if (disabledByProfile) process.stdout.write(kv('disabled-by-profile', 'yes — profile disables this') + '\n');
  }

  if (view.tier === CommandTier.Experimental && !view.callable) {
    const refusal = surfaceRefusalFor(view);
    process.stdout.write('\nWhy gated: ' + (view.detail ?? 'experimental — opt-in required.') + '\n');
    if (refusal.reasonCode === SurfaceRefusalReason.ToolMaintenance) {
      process.stdout.write(
        "It maintains SharkCraft itself (its docs set, examples, release artifacts or command catalog), so it does not apply to this repository. Invoking it exits 78 — this is not a check failure.\n",
      );
    }
    const remedy = refusal.enableCommand.endsWith('--write') ? refusal.enableCommand : `${refusal.enableCommand} --write`;
    const allowAgain =
      refusal.reasonCode === SurfaceRefusalReason.Disabled && view.deniedBy?.origin === SurfaceLayer.Config;
    process.stdout.write(allowAgain ? '\nTo allow it again:\n' : '\nTo enable:\n');
    process.stdout.write(`  $ ${remedy}\n`);
    // Another profile only helps when the profile is what gates it.
    const profileGated =
      refusal.reasonCode === SurfaceRefusalReason.Experimental || view.deniedBy?.origin === SurfaceLayer.Profile;
    if (activeProfile && profileGated) {
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
  const loaded = await loadSurfaceContext({ cwd });
  const summary = buildSurfaceSummary(loaded.context);
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

  // The canonical path (never a flag variant, which no selector would match).
  const edit: ISurfaceConfigEdit = toEdit(op, view.command);
  const diff = planSurfaceEdit(configFileOf(loaded, cwd), rawSurface(loaded), [edit]);
  return await emitDiff(diff, { json, write });
}

function refuseIfInvalid(op: IMutateArgs['op'], view: ISurfaceCommandView): string | null {
  if (view.tier === CommandTier.Core && (op === 'disable' || op === 'hide')) {
    return `Cannot ${op} a core command (${view.command}).`;
  }
  if (op === 'hide' && view.tier === CommandTier.Experimental) {
    return `Cannot hide an experimental command (${view.command}); use disable instead.`;
  }
  if (op === 'enable' && view.deniedBy?.origin === SurfaceLayer.Config) {
    return (
      `${view.command} is disabled by surface.disabled ('${view.deniedBy.selector}'), which wins over surface.enabled. ` +
      `Run: shrk surface allow '${view.deniedBy.selector}' --write`
    );
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

interface ISelectorArgs {
  cwd: string;
  json: boolean;
  write: boolean;
  target: string | undefined;
}

/** A command a deny can never reach: Core (bootstrap / spine / meta) or a bootstrap subverb. */
function isDenyProtected(view: ISurfaceCommandView): boolean {
  return view.tier === CommandTier.Core || isBootstrapFamily(view.command);
}

/**
 * `surface deny <selector>` — add an exact path or `<group> *` to
 * `surface.disabled`. Refused (2) when the selector names no command, only
 * core commands, or is already denied.
 */
async function runDeny({ cwd, json, write, target }: ISelectorArgs): Promise<number> {
  if (!target) {
    process.stderr.write("Usage: shrk surface deny <command|'<group> *'> [--write]\n");
    return 2;
  }
  const loaded = await loadSurfaceContext({ cwd });
  const summary = buildSurfaceSummary(loaded.context);
  const matched = allViews(summary).filter((v) => matchesSurfaceSelector(target, v.command));
  if (matched.length === 0) {
    process.stderr.write(
      `'${target}' names no command. A group selector is '<group> *' (e.g. 'bundle *'); ` +
        'run `shrk surface list` for the paths.\n',
    );
    return 2;
  }
  const protectedViews = matched.filter(isDenyProtected);
  const deniable = matched.filter((v) => !isDenyProtected(v));
  if (deniable.length === 0) {
    process.stderr.write(
      `Cannot disable a core command (${matched.map((v) => v.command).join(', ')}).\n`,
    );
    return 2;
  }
  const raw = rawSurface(loaded);
  if ((raw?.disabled ?? []).includes(target)) {
    process.stderr.write(`Refusing no-op: '${target}' is already in surface.disabled.\n`);
    return 2;
  }
  const diff = planSurfaceEdit(configFileOf(loaded, cwd), raw, [
    { field: 'disabled', command: target, operation: 'add' },
  ]);
  const notes = [`Denies ${deniable.length} command(s): ${previewList(deniable.map((v) => v.command))}`];
  if (protectedViews.length > 0) {
    notes.push(
      `Stays callable (core / bootstrap): ${previewList(protectedViews.map((v) => v.command))}`,
    );
  }
  return await emitDiff(diff, {
    json,
    write,
    notes,
    extra: { denies: deniable.map((v) => v.command), protected: protectedViews.map((v) => v.command) },
  });
}

/** `surface allow <selector>` — remove a selector from the config's `surface.disabled`. */
async function runAllow({ cwd, json, write, target }: ISelectorArgs): Promise<number> {
  if (!target) {
    process.stderr.write("Usage: shrk surface allow <command|'<group> *'> [--write]\n");
    return 2;
  }
  const loaded = await loadSurfaceContext({ cwd });
  const raw = rawSurface(loaded);
  const configDisabled = raw?.disabled ?? [];
  if (!configDisabled.includes(target)) {
    const profile = loaded.activeProfile;
    if (profile?.disabled?.includes(target)) {
      process.stderr.write(
        `'${target}' is disabled by the '${profile.id}' surface profile, not by surface.disabled. ` +
          'Override it for one command with `shrk surface enable "<command>" --write`, or choose another profile.\n',
      );
      return 2;
    }
    process.stderr.write(
      `Refusing no-op: '${target}' is not in surface.disabled` +
        (configDisabled.length > 0 ? ` (entries: ${configDisabled.join(', ')}).\n` : '.\n'),
    );
    return 2;
  }
  const diff = planSurfaceEdit(configFileOf(loaded, cwd), raw, [
    { field: 'disabled', command: target, operation: 'remove' },
  ]);
  return await emitDiff(diff, { json, write });
}

interface IResetArgs {
  cwd: string;
  json: boolean;
  write: boolean;
}

async function runReset({ cwd, json, write }: IResetArgs): Promise<number> {
  const loaded = await loadSurfaceContext({ cwd });
  const raw = rawSurface(loaded);
  const edits: ISurfaceConfigEdit[] = [];
  for (const name of raw?.enabled ?? []) {
    edits.push({ field: 'enabled', command: name, operation: 'remove' });
  }
  for (const name of raw?.hidden ?? []) {
    edits.push({ field: 'hidden', command: name, operation: 'remove' });
  }
  for (const name of raw?.disabled ?? []) {
    edits.push({ field: 'disabled', command: name, operation: 'remove' });
  }
  const diff = planSurfaceEdit(configFileOf(loaded, cwd), raw, edits);

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

/** Print (text or JSON) a planned edit, and apply it under `--write`. */
async function emitDiff(
  diff: ISurfaceConfigDiff,
  opts: { json: boolean; write: boolean; notes?: readonly string[]; extra?: Record<string, unknown> },
): Promise<number> {
  if (opts.json) {
    process.stdout.write(asJson({ diff, willWrite: opts.write, ...(opts.extra ?? {}) }) + '\n');
  } else {
    renderDiffText(diff, opts.write, opts.notes ?? []);
  }
  if (!opts.write) return 0;
  const result = applySurfaceEdit(diff);
  if (!opts.json) {
    process.stdout.write(`\nWrote ${result.configFile} (${result.edits.length} edit${result.edits.length === 1 ? '' : 's'}).\n`);
  }
  return 0;
}

function renderDiffText(
  diff: { configFile: string; edits: readonly ISurfaceConfigEdit[] },
  willWrite: boolean,
  notes: readonly string[] = [],
): void {
  process.stdout.write(header('Surface config edit'));
  process.stdout.write(kv('configFile', diff.configFile) + '\n');
  process.stdout.write(kv('edits', String(diff.edits.length)) + '\n');
  for (const edit of diff.edits) {
    const sign = edit.operation === 'add' ? '+' : '-';
    process.stdout.write(`  ${sign} surface.${edit.field}: ${edit.command}\n`);
  }
  for (const note of notes) process.stdout.write(`${note}\n`);
  if (!willWrite) {
    process.stdout.write('\nDry run. Pass --write to apply.\n');
  }
}

/** At most eight paths, then `(+N more)`. */
function previewList(paths: readonly string[]): string {
  const head = paths.slice(0, 8).join(', ');
  return paths.length > 8 ? `${head} (+${paths.length - 8} more)` : head;
}
