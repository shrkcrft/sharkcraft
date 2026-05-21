/**
 * `shrk profiles ...` — unified read-only surface for all pack-/local-
 * contributed profiles (migration, and future kinds).
 */
import {
  findProfile,
  inspectSharkcraft,
  listProfileIssues,
  listProfiles,
  ProfileKind,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

function parseKind(value: string | undefined): ProfileKind | undefined {
  if (!value) return undefined;
  const known = Object.values(ProfileKind);
  if ((known as readonly string[]).includes(value)) return value as ProfileKind;
  return undefined;
}

export const profilesListCommand: ICommandHandler = {
  name: 'list',
  description: 'List all registered profiles (migration, ...).',
  usage: 'shrk profiles list [--kind <kind>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const kind = parseKind(flagString(args, 'kind'));
    const entries = await listProfiles(inspection, kind ? { kind } : {});
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entries) + '\n');
      return 0;
    }
    process.stdout.write(header(`Profiles (${entries.length}${kind ? `, kind=${kind}` : ''})`));
    if (entries.length === 0) {
      process.stdout.write(
        '  (none — contribute via packs: migrationProfileFiles, etc.)\n',
      );
      return 0;
    }
    for (const e of entries) {
      const src = e.source === 'pack' ? `pack:${e.packageName ?? '?'}` : e.source;
      process.stdout.write(
        `  • ${e.kind.padEnd(18)} ${e.id.padEnd(24)} ${e.title}  [${src}]\n`,
      );
    }
    return 0;
  },
};

export const profilesGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show one profile by id (and optional --kind).',
  usage: 'shrk profiles get <id> [--kind <kind>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk profiles get <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const kind = parseKind(flagString(args, 'kind'));
    const entry = await findProfile(inspection, id, kind);
    if (!entry) {
      process.stderr.write(`Unknown profile "${id}"${kind ? ` (kind=${kind})` : ''}.\n`);
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
  usage: 'shrk profiles search <query> [--kind <kind>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const query = args.positional[0];
    if (!query) {
      process.stderr.write('Usage: shrk profiles search <query>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const kind = parseKind(flagString(args, 'kind'));
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
    'List / inspect pack-contributed profiles (migration, conventions, …).',
  usage: 'shrk profiles list|get|doctor|search ...',
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
