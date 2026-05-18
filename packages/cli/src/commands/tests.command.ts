import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  analyzeTestImpact,
  inspectSharkcraft,
  readFeatureBundle,
  suggestTestPathFor,
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

function collectFiles(cwd: string, args: ParsedArgs): string[] {
  const files = flagList(args, 'files');
  const planFile = flagString(args, 'plan');
  const bundleId = flagString(args, 'bundle');
  const out: string[] = [...files];
  if (planFile) {
    const path = nodePath.isAbsolute(planFile) ? planFile : nodePath.join(cwd, planFile);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
          changes?: readonly { relativePath?: string }[];
          plan?: { changes?: readonly { relativePath?: string }[] };
        };
        const changes = parsed.changes ?? parsed.plan?.changes ?? [];
        for (const c of changes) if (c.relativePath) out.push(c.relativePath);
      } catch {
        /* ignore */
      }
    }
  }
  if (bundleId) {
    const b = readFeatureBundle(cwd, bundleId);
    if (b) {
      for (const f of b.affectedFiles) out.push(f);
      for (const p of b.plans) for (const t of p.expectedTargets) out.push(t);
    }
  }
  return [...new Set(out)];
}

export const testsImpactCommand: ICommandHandler = {
  name: 'impact',
  description: 'Test impact analysis for changed files / plan / bundle.',
  usage: 'shrk tests impact [--files a,b] [--plan <plan>] [--bundle <id>] "<task>"',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const task = args.positional.join(' ').trim() || undefined;
    const files = collectFiles(cwd, args);
    const result = analyzeTestImpact(inspection, {
      ...(task ? { task } : {}),
      files,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
      return 0;
    }
    process.stdout.write(header(`Test impact (${files.length} files)`));
    process.stdout.write(`Likely tests: ${result.likelyTestFiles.length}\n`);
    for (const f of result.likelyTestFiles.slice(0, 10)) process.stdout.write(`  + ${f}\n`);
    process.stdout.write(`Missing tests: ${result.missingTestFiles.length}\n`);
    for (const f of result.missingTestFiles.slice(0, 10)) process.stdout.write(`  - ${f}\n`);
    process.stdout.write(`Confidence: ${result.confidence}%\n`);
    return 0;
  },
};

export const testsSuggestCommand: ICommandHandler = {
  name: 'suggest',
  description: 'Suggest where a test for a given file should live.',
  usage: 'shrk tests suggest <file>',
  run(args: ParsedArgs): number {
    const file = args.positional[0];
    if (!file) {
      process.stderr.write('Usage: shrk tests suggest <file>\n');
      return 2;
    }
    process.stdout.write(suggestTestPathFor(file) + '\n');
    return 0;
  },
};

export const testsMissingCommand: ICommandHandler = {
  name: 'missing',
  description: 'Show missing test files for the given inputs.',
  usage: 'shrk tests missing --files a,b',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const files = collectFiles(cwd, args);
    const r = analyzeTestImpact(inspection, { files });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ missing: r.missingTestFiles }) + '\n');
      return 0;
    }
    for (const f of r.missingTestFiles) process.stdout.write(f + '\n');
    return 0;
  },
};
