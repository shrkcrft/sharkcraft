import {
  getChangedFiles,
  impactFor,
  inspectSharkcraft,
  loadOwnershipRules,
  matchFile,
  readFeatureBundle,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

const DEFAULT_OWNERSHIP_FILES = [
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  'sharkcraft/ownership.ts',
] as const;

function configuredFiles(args: ParsedArgs): readonly string[] | undefined {
  const list = flagList(args, 'files');
  return list.length > 0 ? list : undefined;
}

export const ownershipListCommand: ICommandHandler = {
  name: 'list',
  description: 'List ownership rules from CODEOWNERS / sharkcraft/ownership.ts.',
  usage: 'shrk ownership list [--json] [--files a,b]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const cfg = (inspection.config as { ownershipFiles?: readonly string[] } | null)?.ownershipFiles;
    const fromArgs = configuredFiles(args);
    const files = fromArgs ?? cfg ?? DEFAULT_OWNERSHIP_FILES;
    const r = await loadOwnershipRules(cwd, files);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(r) + '\n');
      return 0;
    }
    process.stdout.write(header(`Ownership rules (${r.rules.length})`));
    for (const s of r.sources) process.stdout.write(`  source: ${s}\n`);
    for (const w of r.warnings) process.stdout.write(`  ! ${w}\n`);
    for (const rule of r.rules) {
      process.stdout.write(
        `  ${rule.id.padEnd(36)}  paths=${rule.paths.join(',')}  owners=${rule.owners.join(',')}\n`,
      );
    }
    return 0;
  },
};

export const ownershipForCommand: ICommandHandler = {
  name: 'for',
  description: 'Show ownership match for a single file.',
  usage: 'shrk ownership for <file> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const file = args.positional[0];
    if (!file) {
      process.stderr.write('Usage: shrk ownership for <file>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const cfg = (inspection.config as { ownershipFiles?: readonly string[] } | null)?.ownershipFiles;
    const fromArgs = configuredFiles(args);
    const files = fromArgs ?? cfg ?? DEFAULT_OWNERSHIP_FILES;
    const { rules } = await loadOwnershipRules(cwd, files);
    const m = matchFile(file, rules);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(m) + '\n');
      return 0;
    }
    process.stdout.write(`file: ${m.file}\n`);
    process.stdout.write(`owners: ${m.owners.join(', ') || '(none)'}\n`);
    process.stdout.write(`reviewers: ${m.reviewers.join(', ') || '(none)'}\n`);
    process.stdout.write(`requiredReview: ${m.requiredReview}\n`);
    return 0;
  },
};

export const ownershipAffectedCommand: ICommandHandler = {
  name: 'affected',
  description: 'Show owners affected by --since <ref>, --bundle <id>, or --files a,b.',
  usage:
    'shrk ownership affected [--since <ref>] [--bundle <id>] [--files a,b] [--staged] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const since = flagString(args, 'since');
    const bundleId = flagString(args, 'bundle');
    const explicit = flagList(args, 'files');
    const all: string[] = [...explicit];
    if (since) {
      const opts: { since: string; staged?: boolean } = { since };
      if (flagBool(args, 'staged')) opts.staged = true;
      all.push(...getChangedFiles(cwd, opts));
    } else if (flagBool(args, 'staged')) {
      all.push(...getChangedFiles(cwd, { staged: true }));
    }
    if (bundleId) {
      const b = readFeatureBundle(cwd, bundleId);
      if (b) {
        for (const f of b.affectedFiles) all.push(f);
        for (const p of b.plans) for (const t of p.expectedTargets) all.push(t);
      }
    }
    const cfg = (inspection.config as { ownershipFiles?: readonly string[] } | null)?.ownershipFiles;
    const fromArgs = configuredFiles(args);
    const files = fromArgs ?? cfg ?? DEFAULT_OWNERSHIP_FILES;
    const { rules } = await loadOwnershipRules(cwd, files);
    const impact = impactFor([...new Set(all)], rules);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(impact) + '\n');
      return 0;
    }
    process.stdout.write(header(`Ownership affected (${impact.files.length} files)`));
    process.stdout.write(`owners: ${impact.owners.join(', ') || '(none)'}\n`);
    process.stdout.write(`reviewers: ${impact.reviewers.join(', ') || '(none)'}\n`);
    if (impact.requiredReviewFiles.length > 0) {
      process.stdout.write(`requiredReview files:\n`);
      for (const f of impact.requiredReviewFiles) process.stdout.write(`  - ${f}\n`);
    }
    return 0;
  },
};
