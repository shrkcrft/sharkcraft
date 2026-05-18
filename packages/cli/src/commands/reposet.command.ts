import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildReposetMap,
  loadReposetConfig,
  previewReposetInit,
  renderReposetMapText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

function requireConfig(
  cwd: string,
  opts?: { json?: boolean },
): ReturnType<typeof loadReposetConfig> | null {
  const cfg = loadReposetConfig(cwd);
  if (!cfg) {
    if (opts?.json) {
      // Emit a structured JSON envelope on stdout so callers that
      // pass `--json` always get parseable output, even on misconfiguration.
      process.stdout.write(
        asJson({
          ok: false,
          error: 'reposet-config-missing',
          message: 'No reposet config found.',
          hint: 'Run `shrk reposet init --dry-run` to preview a starter file.',
        }) + '\n',
      );
    } else {
      process.stderr.write(
        'No reposet config found. Run `shrk reposet init --dry-run` to preview a starter file.\n',
      );
    }
    return null;
  }
  return cfg;
}

export const reposetInitCommand: ICommandHandler = {
  name: 'init',
  description: 'Preview a reposet starter config (sharkcraft.reposet.json). Dry-run by default.',
  usage: 'shrk reposet init [--write] [--dry-run]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const preview = previewReposetInit(cwd);
    if (flagBool(args, 'write')) {
      if (existsSync(preview.targetPath)) {
        process.stderr.write(`Refusing to overwrite ${preview.targetPath}\n`);
        return 1;
      }
      mkdirSync(nodePath.dirname(preview.targetPath), { recursive: true });
      writeFileSync(preview.targetPath, preview.body, 'utf8');
      process.stdout.write(`Wrote ${preview.targetPath}\n`);
      return 0;
    }
    process.stdout.write(`# Dry-run — would write ${preview.targetPath}\n${preview.body}\n`);
    return 0;
  },
};

export const reposetListCommand: ICommandHandler = {
  name: 'list',
  description: 'List repos in the local reposet config.',
  usage: 'shrk reposet list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const cfg = requireConfig(cwd);
    if (!cfg) return 1;
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(cfg) + '\n');
      return 0;
    }
    for (const r of cfg.repos) process.stdout.write(`${r.id.padEnd(20)} ${r.role.padEnd(12)} ${r.root}\n`);
    return 0;
  },
};

export const reposetDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Sanity-check the reposet: every root exists.',
  usage: 'shrk reposet doctor [--parallel] [--concurrency <n>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const cfg = requireConfig(cwd, { json: wantJson });
    if (!cfg) return 1;
    const parallel = flagBool(args, 'parallel');
    const concurrency = Number(flagString(args, 'concurrency') ?? '4');
    const map = await buildReposetMap(cfg, { parallel, concurrency });
    const missing = map.repos.filter((r) => !r.exists);
    if (wantJson) {
      process.stdout.write(asJson({ ok: missing.length === 0, missing }) + '\n');
      return missing.length === 0 ? 0 : 1;
    }
    process.stdout.write(renderReposetMapText(map));
    if (missing.length === 0) {
      process.stdout.write('All repos present.\n');
      return 0;
    }
    process.stdout.write(`${missing.length} repo(s) missing.\n`);
    return 1;
  },
};

export const reposetMapCommand: ICommandHandler = {
  name: 'map',
  description: 'Aggregate map across the reposet — read-only.',
  usage: 'shrk reposet map [--parallel] [--concurrency <n>] [--json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const cfg = requireConfig(cwd);
    if (!cfg) return 1;
    const parallel = flagBool(args, 'parallel');
    const concurrency = Number(flagString(args, 'concurrency') ?? '4');
    const map = await buildReposetMap(cfg, { parallel, concurrency });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(map) + '\n');
      return 0;
    }
    const output = flagString(args, 'output');
    const body = renderReposetMapText(map);
    if (output) {
      const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
      process.stdout.write(`Wrote ${abs}\n`);
      return 0;
    }
    process.stdout.write(body);
    return 0;
  },
};
