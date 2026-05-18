import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
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

function readOwnershipFiles(args: ParsedArgs): readonly string[] | undefined {
  const list = flagList(args, 'files');
  return list.length > 0 ? list : undefined;
}

export const ownersListCommand: ICommandHandler = {
  name: 'list',
  description: 'List ownership rules.',
  usage: 'shrk owners list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const cfg = (inspection.config as { ownershipFiles?: readonly string[] } | null)?.ownershipFiles;
    const { rules, sources, warnings } = await loadOwnershipRules(cwd, cfg);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ rules, sources, warnings }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Ownership rules (${rules.length})`));
    for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
    for (const r of rules) {
      process.stdout.write(`  ${r.id}  paths=${r.paths.join(',')}  owners=${r.owners.join(',')}\n`);
    }
    return 0;
  },
};

export const ownersMatchCommand: ICommandHandler = {
  name: 'match',
  description: 'Show ownership match for a file.',
  usage: 'shrk owners match <file>',
  async run(args: ParsedArgs): Promise<number> {
    const file = args.positional[0];
    if (!file) {
      process.stderr.write('Usage: shrk owners match <file>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const cfg = (inspection.config as { ownershipFiles?: readonly string[] } | null)?.ownershipFiles;
    const { rules } = await loadOwnershipRules(cwd, cfg);
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

export const ownersImpactCommand: ICommandHandler = {
  name: 'impact',
  description: 'Ownership impact for files / plan / bundle.',
  usage: 'shrk owners impact --files a,b | --plan <plan.json> | --bundle <id>',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const planFile = flagString(args, 'plan');
    const bundleId = flagString(args, 'bundle');
    const files = flagList(args, 'files');
    const all: string[] = [...files];
    if (planFile) {
      const path = nodePath.isAbsolute(planFile) ? planFile : nodePath.join(cwd, planFile);
      if (existsSync(path)) {
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
            changes?: readonly { relativePath?: string }[];
            plan?: { changes?: readonly { relativePath?: string }[] };
          };
          const changes = parsed.changes ?? parsed.plan?.changes ?? [];
          for (const c of changes) if (c.relativePath) all.push(c.relativePath);
        } catch {
          /* ignore */
        }
      }
    }
    if (bundleId) {
      const b = readFeatureBundle(cwd, bundleId);
      if (b) {
        for (const f of b.affectedFiles) all.push(f);
        for (const p of b.plans) for (const t of p.expectedTargets) all.push(t);
      }
    }
    const cfg = (inspection.config as { ownershipFiles?: readonly string[] } | null)?.ownershipFiles;
    const { rules } = await loadOwnershipRules(cwd, cfg);
    const impact = impactFor([...new Set(all)], rules);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(impact) + '\n');
      return 0;
    }
    process.stdout.write(header(`Ownership impact (${impact.files.length} files)`));
    process.stdout.write(`owners: ${impact.owners.join(', ') || '(none)'}\n`);
    process.stdout.write(`reviewers: ${impact.reviewers.join(', ') || '(none)'}\n`);
    if (impact.requiredReviewFiles.length > 0) {
      process.stdout.write(`requiredReview files:\n`);
      for (const f of impact.requiredReviewFiles) process.stdout.write(`  - ${f}\n`);
    }
    // Silence unused-var lint for readOwnershipFiles
    void readOwnershipFiles;
    return 0;
  },
};
