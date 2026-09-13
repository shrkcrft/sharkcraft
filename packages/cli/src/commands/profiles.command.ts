/**
 * `shrk profiles ...` — unified read-only surface for every profile kind: the
 * builtin `workspace` vocabulary (WorkspaceProfile ids, with this repo's
 * detection) and pack-/local-contributed `migration` profiles.
 */
import {
  ContributionKind,
  findProfile,
  formatReferenceKindDeclaration,
  inspectSharkcraft,
  isProfileKind,
  listProfileIssues,
  listProfiles,
  nearestIds,
  PROFILE_KIND_REFERENCE_KIND,
  ProfileKind,
  type IProfileEntry,
} from '@shrkcrft/inspector';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { usageExitFor } from '../exit-codes.ts';
import { asJson, header } from '../output/format-output.ts';
import { writeRejectedEntriesNote } from '../output/rejected-entries-note.ts';

/** Every profile kind, in enum order — what `--kind` accepts. */
const KNOWN_KINDS: string = Object.values(ProfileKind).join(', ');

/**
 * Parse `--kind`. An unknown (or valueless) kind is a usage error naming the
 * known kinds — it used to be dropped silently, so `--kind bogus` listed every
 * kind and a typo read as "no filter". Exit per THE usage split
 * (`usageExitFor`: 2 on this non-verdict verb).
 */
function parseKind(args: ParsedArgs, commandPath: string): { kind?: ProfileKind; exit?: number } {
  if (!args.flags.has('kind')) return {};
  const raw = args.flags.get('kind');
  if (typeof raw === 'string' && isProfileKind(raw)) return { kind: raw };
  process.stderr.write(
    `unknown --kind ${typeof raw === 'string' ? `"${raw}"` : '(no value)'} — known: ${KNOWN_KINDS}\n`,
  );
  return { exit: usageExitFor(commandPath) };
}

/**
 * The empty state, from THE declaration table — so it can only name paths
 * that really fill the kind (it used to say "contribute via packs:
 * migrationProfileFiles, etc.", where "etc." named nothing and the local path
 * went unmentioned).
 */
function emptyState(kind: ProfileKind | undefined): string {
  if (!kind) return '  (none)\n';
  return `  (none — ${kind} profiles are declared via: ${formatReferenceKindDeclaration(PROFILE_KIND_REFERENCE_KIND[kind])})\n`;
}

function sourceLabel(e: IProfileEntry): string {
  const src = e.source === 'pack' ? `pack:${e.packageName ?? '?'}` : e.source;
  return e.detected === true ? `${src} · detected` : src;
}

export const profilesListCommand: ICommandHandler = {
  name: 'list',
  description: 'List all registered profiles (workspace, migration).',
  usage: 'shrk profiles list [--kind workspace|migration] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const parsed = parseKind(args, 'profiles list');
    if (parsed.exit !== undefined) return parsed.exit;
    const { kind } = parsed;
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entries = await listProfiles(inspection, kind ? { kind } : {});
    // Only migration profiles are contributed (the workspace kind is builtin):
    // one its loader refused is named (round 12, 12.1) — it read "Invalid
    // migration profile at <file>; skipped." with no id, on `profiles doctor` only.
    const migration = !kind || kind === ProfileKind.Migration;
    const note = { next: 'shrk profiles doctor' };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entries) + '\n');
      if (migration) {
        await writeRejectedEntriesNote(inspection, [ContributionKind.MigrationProfile], { ...note, json: true });
      }
      return 0;
    }
    process.stdout.write(header(`Profiles (${entries.length}${kind ? `, kind=${kind}` : ''})`));
    if (entries.length === 0) process.stdout.write(emptyState(kind));
    for (const e of entries) {
      process.stdout.write(`  • ${e.kind.padEnd(18)} ${e.id.padEnd(24)} ${e.title}  [${sourceLabel(e)}]\n`);
    }
    if (migration) await writeRejectedEntriesNote(inspection, [ContributionKind.MigrationProfile], note);
    return 0;
  },
};

export const profilesGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show one profile by id (and optional --kind).',
  usage: 'shrk profiles get <id> [--kind workspace|migration] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk profiles get <id>\n');
      return 2;
    }
    const parsed = parseKind(args, 'profiles get');
    if (parsed.exit !== undefined) return parsed.exit;
    const { kind } = parsed;
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entry = await findProfile(inspection, id, kind);
    if (!entry) {
      const pool = (await listProfiles(inspection, kind ? { kind } : {})).map((e) => e.id);
      const near = nearestIds(id, pool, 3).map((n) => n.id);
      process.stderr.write(
        `Unknown profile "${id}"${kind ? ` (kind=${kind})` : ''}.${near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : ''}\n`,
      );
      return 2;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entry) + '\n');
      return 0;
    }
    process.stdout.write(header(`Profile ${entry.id} (${entry.kind})`));
    process.stdout.write(`  title         ${entry.title}\n`);
    if (entry.description) process.stdout.write(`  description   ${entry.description}\n`);
    process.stdout.write(`  source        ${entry.source}${entry.packageName ? ' (' + entry.packageName + ')' : ''}\n`);
    if (entry.detected !== undefined) {
      const reason = (entry.payload as { reason?: string } | undefined)?.reason;
      process.stdout.write(`  detected      ${entry.detected ? `yes${reason ? ` — ${reason}` : ''}` : 'no (not detected in this repo)'}\n`);
    }
    if (entry.sourceFile) process.stdout.write(`  sourceFile    ${entry.sourceFile}\n`);
    if (entry.tags && entry.tags.length > 0) process.stdout.write(`  tags          ${entry.tags.join(', ')}\n`);
    if (entry.appliesWhen && entry.appliesWhen.length > 0) {
      process.stdout.write(`  appliesWhen   ${entry.appliesWhen.join(', ')}\n`);
    }
    return 0;
  },
};

export const profilesDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Surface load issues across all profile kinds.',
  usage: 'shrk profiles doctor [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const issues = await listProfileIssues(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ issues }) + '\n');
      return issues.some((i) => i.severity === 'error') ? 1 : 0;
    }
    process.stdout.write(header('Profile registry doctor'));
    if (issues.length === 0) {
      process.stdout.write('  ok — no load issues across registered profile kinds.\n');
      return 0;
    }
    for (const i of issues) {
      process.stdout.write(`  ${i.severity.padEnd(7)} [${i.code}] ${i.message}\n`);
    }
    return issues.some((i) => i.severity === 'error') ? 1 : 0;
  },
};

export const profilesSearchCommand: ICommandHandler = {
  name: 'search',
  description: 'Search registered profiles by free-text token across id / title / tags.',
  usage: 'shrk profiles search <query> [--kind workspace|migration] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const query = args.positional[0];
    if (!query) {
      process.stderr.write('Usage: shrk profiles search <query>\n');
      return 2;
    }
    const parsed = parseKind(args, 'profiles search');
    if (parsed.exit !== undefined) return parsed.exit;
    const { kind } = parsed;
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const all = await listProfiles(inspection, kind ? { kind } : {});
    const q = query.toLowerCase();
    const matches = all.filter((e) => {
      const haystack = `${e.id} ${e.title} ${(e.tags ?? []).join(' ')} ${e.description ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(matches) + '\n');
      return 0;
    }
    process.stdout.write(header(`Profiles matching "${query}" (${matches.length})`));
    for (const e of matches) {
      process.stdout.write(`  • ${e.kind.padEnd(18)} ${e.id.padEnd(24)} ${e.title}\n`);
    }
    if (matches.length === 0) process.stdout.write('  (no matches)\n');
    return 0;
  },
};

export const profilesCommand: ICommandHandler = {
  name: 'profiles',
  description:
    'List / inspect profiles: the builtin workspace vocabulary (WorkspaceProfile ids, with detection) and migration profiles.',
  usage: 'shrk profiles list|get|doctor|search ...',
  booleanFlags: new Set(['json']),
  positionals: PositionalMode.None,
  subverbs: [
    { name: 'list', description: profilesListCommand.description, usage: profilesListCommand.usage },
    {
      name: 'get',
      description: profilesGetCommand.description,
      usage: profilesGetCommand.usage,
      positionals: PositionalMode.Free,
    },
    { name: 'doctor', description: profilesDoctorCommand.description, usage: profilesDoctorCommand.usage },
    {
      name: 'search',
      description: profilesSearchCommand.description,
      usage: profilesSearchCommand.usage,
      positionals: PositionalMode.Free,
    },
  ],
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    args.positional = args.positional.slice(1);
    if (sub === 'list') return profilesListCommand.run(args);
    if (sub === 'get') return profilesGetCommand.run(args);
    if (sub === 'doctor') return profilesDoctorCommand.run(args);
    if (sub === 'search') return profilesSearchCommand.run(args);
    process.stderr.write('Usage: shrk profiles list|get|doctor|search ...\n');
    return 2;
  },
};
