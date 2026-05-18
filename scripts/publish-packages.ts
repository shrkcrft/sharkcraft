#!/usr/bin/env bun
// publish-packages: real npm publish for every @shrkcrft/* package, in
// topological order, with the same publish-mode package.json transform
// that publish-dry-run and install-smoke-test already exercise.
//
// Safety properties:
//   - package.json is ALWAYS restored, even on failure (try/finally).
//   - --dry-run runs `npm publish --dry-run` so you can see the exact npm
//     command output without touching the registry.
//   - --from <name> resumes after a partial publish (e.g. mid-run failure).
//   - --only <name> publishes exactly one package.
//   - private packages and examples are skipped automatically.
//   - Third-party packs live outside packages/ — they cannot be picked up by this script.
//
// Usage:
//   bun run scripts/publish-packages.ts --dry-run
//   bun run scripts/publish-packages.ts --tag alpha
//   bun run scripts/publish-packages.ts --only cli --tag alpha
//   bun run scripts/publish-packages.ts --from cli --tag alpha
//   bun run scripts/publish-packages.ts --otp 123456 --yes --tag alpha
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverPackages,
  matchPackage,
  topoSort,
  versionsByName,
  withPublishMode,
  type IPackageMeta,
} from './lib/publish-mode.ts';

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

// ── argv parsing ────────────────────────────────────────────────────────
interface IOptions {
  tag: string;
  access: string;
  dryRun: boolean;
  yes: boolean;
  from?: string;
  only?: string;
  otp?: string;
  skipPreflight: boolean;
  skipBuild: boolean;
}

function parseOptions(argv: readonly string[]): IOptions {
  const opts: IOptions = {
    tag: 'alpha',
    access: 'public',
    dryRun: false,
    yes: false,
    skipPreflight: false,
    skipBuild: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case '--tag':
        if (typeof next !== 'string') throw new Error('--tag requires a value');
        opts.tag = next;
        i += 1;
        break;
      case '--access':
        if (typeof next !== 'string') throw new Error('--access requires a value');
        opts.access = next;
        i += 1;
        break;
      case '--from':
        if (typeof next !== 'string') throw new Error('--from requires a value');
        opts.from = next;
        i += 1;
        break;
      case '--only':
        if (typeof next !== 'string') throw new Error('--only requires a value');
        opts.only = next;
        i += 1;
        break;
      case '--otp':
        if (typeof next !== 'string') throw new Error('--otp requires a value');
        opts.otp = next;
        i += 1;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--skip-preflight':
        opts.skipPreflight = true;
        break;
      case '--skip-build':
        opts.skipBuild = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }
  return opts;
}

const USAGE = `\
Usage: bun run publish:packages [options]

Options:
  --tag <tag>           npm dist-tag (default: alpha)
  --access <access>     npm access level (default: public)
  --dry-run             run \`npm publish --dry-run\` instead of a real publish
  --from <name>         start publishing from this package (inclusive)
  --only <name>         publish exactly one package
  --otp <code>          npm 2FA code (passed to \`npm publish --otp\`)
  --yes, -y             skip the interactive confirmation
  --skip-preflight      skip the release-preflight gate (NOT recommended)
  --skip-build          skip build:dist (assume dist/ is up to date)
  -h, --help            show this help

\`<name>\` accepts the short name (e.g. \"cli\") or full \`@shrkcrft/<name>\`.
`;

// ── small helpers ───────────────────────────────────────────────────────
function run(cmd: string, args: readonly string[], cwd: string = ROOT): void {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
}

function capture(cmd: string, args: readonly string[], cwd: string = ROOT): string {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  return (res.stdout ?? '').toString().trim();
}

function checkGitClean(): { clean: boolean; output: string } {
  const status = capture('git', ['status', '--short']);
  return { clean: status.length === 0, output: status };
}

async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  for await (const chunk of process.stdin) {
    const answer = chunk.toString('utf8').trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  }
  return false;
}

interface IPublishOutcome {
  short: string;
  name: string;
  version: string;
  status: 'published' | 'dry-run-ok' | 'skipped' | 'failed';
  command: string;
  message?: string;
}

function buildNpmPublishCommand(opts: IOptions): readonly string[] {
  const args = ['publish', `--access=${opts.access}`, `--tag=${opts.tag}`];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.otp) args.push(`--otp=${opts.otp}`);
  return args;
}

async function publishOne(
  pkg: IPackageMeta,
  versionByName: ReadonlyMap<string, string>,
  opts: IOptions,
): Promise<IPublishOutcome> {
  const args = buildNpmPublishCommand(opts);
  const commandLine = `npm ${args.join(' ')} (in ${pkg.dir})`;
  try {
    await withPublishMode(pkg.dir, versionByName, async () => {
      run('npm', [...args], pkg.dir);
    });
    return {
      short: pkg.short,
      name: pkg.name,
      version: pkg.version,
      status: opts.dryRun ? 'dry-run-ok' : 'published',
      command: commandLine,
    };
  } catch (e) {
    return {
      short: pkg.short,
      name: pkg.name,
      version: pkg.version,
      status: 'failed',
      command: commandLine,
      message: (e as Error).message,
    };
  }
}

// ── main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));

  if (!existsSync(PACKAGES_DIR)) {
    throw new Error(`packages/ directory not found under ${ROOT}`);
  }

  // Discover + topo sort.
  const all = discoverPackages(PACKAGES_DIR);
  const publishable = all.filter((p) => !p.private);
  const ordered = topoSort(publishable);

  // Resolve --from / --only.
  let targets: IPackageMeta[];
  if (opts.only) {
    const match = matchPackage(ordered, opts.only);
    if (!match) {
      throw new Error(`--only: no package matches "${opts.only}"`);
    }
    targets = [match];
  } else if (opts.from) {
    const idx = ordered.findIndex(
      (p) => p.short === opts.from || p.name === opts.from,
    );
    if (idx < 0) {
      throw new Error(`--from: no package matches "${opts.from}"`);
    }
    targets = ordered.slice(idx);
  } else {
    targets = ordered;
  }

  process.stdout.write(`[publish-packages] dist-tag: ${opts.tag}\n`);
  process.stdout.write(`[publish-packages] access:   ${opts.access}\n`);
  process.stdout.write(`[publish-packages] dry-run:  ${opts.dryRun}\n`);
  if (opts.otp) process.stdout.write(`[publish-packages] otp:      <set>\n`);
  process.stdout.write(`[publish-packages] order (${targets.length}):\n`);
  for (const p of targets) {
    process.stdout.write(`  - ${p.name}@${p.version}\n`);
  }

  // Git cleanliness warning.
  const git = checkGitClean();
  if (!git.clean) {
    process.stdout.write(
      `\n[publish-packages] WARNING: git working tree is not clean:\n${git.output}\n`,
    );
  }

  // Preflight gate.
  if (!opts.skipPreflight && !opts.dryRun) {
    process.stdout.write('\n[publish-packages] running release:preflight\n');
    try {
      run('bun', ['run', 'release:preflight']);
    } catch (e) {
      process.stderr.write(`\n[publish-packages] preflight failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  } else if (opts.skipPreflight) {
    process.stdout.write('\n[publish-packages] preflight SKIPPED (--skip-preflight)\n');
  } else if (opts.dryRun && !opts.skipBuild) {
    // Dry-run still wants a fresh dist so npm pack content matches reality.
    process.stdout.write('\n[publish-packages] dry-run: running build:dist for fresh tarballs\n');
    run('bun', ['run', 'build:dist']);
  }

  // Confirmation.
  if (!opts.yes && !opts.dryRun) {
    const ok = await confirm(
      `About to publish ${targets.length} package(s) with --tag=${opts.tag}. Continue?`,
    );
    if (!ok) {
      process.stdout.write('[publish-packages] aborted by user.\n');
      process.exit(0);
    }
  }

  // Publish loop.
  const versionByName = versionsByName(all);
  const outcomes: IPublishOutcome[] = [];
  for (const pkg of targets) {
    process.stdout.write(`\n=== ${pkg.name}@${pkg.version} ===\n`);
    const outcome = await publishOne(pkg, versionByName, opts);
    outcomes.push(outcome);
    if (outcome.status === 'failed') {
      process.stderr.write(
        `\n[publish-packages] STOPPED after failure on ${pkg.name}: ${outcome.message}\n`,
      );
      break;
    }
  }

  // Mark remaining as skipped.
  const publishedShorts = new Set(outcomes.map((o) => o.short));
  for (const pkg of targets) {
    if (!publishedShorts.has(pkg.short)) {
      outcomes.push({
        short: pkg.short,
        name: pkg.name,
        version: pkg.version,
        status: 'skipped',
        command: '(not run)',
      });
    }
  }

  // Summary.
  process.stdout.write('\n=== Publish summary ===\n');
  let failed = 0;
  for (const o of outcomes) {
    const tag =
      o.status === 'published'
        ? 'PUBLISHED'
        : o.status === 'dry-run-ok'
          ? 'DRY-RUN  '
          : o.status === 'skipped'
            ? 'SKIPPED  '
            : 'FAILED   ';
    process.stdout.write(`  ${tag} ${o.name}@${o.version}\n`);
    if (o.message) process.stdout.write(`           ↳ ${o.message}\n`);
    if (o.status === 'failed') failed += 1;
  }
  process.stdout.write('\n[publish-packages] package.json restored on every package.\n');

  if (failed > 0) {
    process.stdout.write(
      `\n[publish-packages] FAILED — to resume after fixing, re-run with --from ${
        outcomes.find((o) => o.status === 'failed')?.short ?? ''
      }\n`,
    );
    process.exit(1);
  }
  process.stdout.write('\n[publish-packages] all done ✓\n');
}

main().catch((err) => {
  process.stderr.write(`\n[publish-packages] error: ${(err as Error).message}\n`);
  process.exit(1);
});
