#!/usr/bin/env bun
/*
 * Node compatibility audit. Scans production sources for Bun.* usage, then
 * (when --runtime is passed) builds dist/ and tries to run the published CLI
 * + MCP server with `node`. Outputs a JSON report by default so CI can pin
 * Node compatibility status.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import { withAllPackagesPublishMode } from './lib/publish-mode.ts';

interface IBunUsage {
  file: string;
  line: number;
  snippet: string;
}

interface IRuntimeProbe {
  command: string;
  exitCode: number;
  passed: boolean;
  stderr: string;
  stdout: string;
}

interface ICompatReport {
  bunUsage: IBunUsage[];
  blockers: string[];
  passed: boolean;
  runtimeProbes: IRuntimeProbe[];
  notes: string[];
}

const REPO_ROOT = nodePath.resolve(import.meta.dir, '..');

function scanFile(file: string): IBunUsage[] {
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = body.split('\n');
  const out: IBunUsage[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // Skip when the line is a comment in its entirety.
    if (/^\s*\/\//.test(line)) continue;
    // Strip line-tail comments + string/template literals, then check for the
    // call shape. We only flag code-level `Bun.<id>` references — string
    // mentions in error messages are false positives.
    let code = line.replace(/\/\/.*$/, '');
    code = code.replace(/'(?:\\.|[^'\\])*'/g, "''");
    code = code.replace(/"(?:\\.|[^"\\])*"/g, '""');
    code = code.replace(/`(?:\\.|[^`\\])*`/g, '``');
    if (/\bBun\.[A-Za-z_$]/.test(code)) {
      out.push({ file: nodePath.relative(REPO_ROOT, file), line: i + 1, snippet: line.trim() });
    }
  }
  return out;
}

function walk(dir: string, files: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === '__tests__' || e === '.tmp') continue;
    const full = nodePath.join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, files);
    } else if (st.isFile() && /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e)) {
      files.push(full);
    }
  }
}

function scanProductionSources(): IBunUsage[] {
  const productionDirs = [
    'packages/cli/src',
    'packages/mcp-server/src',
    'packages/core/src',
    'packages/workspace/src',
    'packages/config/src',
    'packages/knowledge/src',
    'packages/rules/src',
    'packages/paths/src',
    'packages/templates/src',
    'packages/pipelines/src',
    'packages/presets/src',
    'packages/boundaries/src',
    'packages/packs/src',
    'packages/generator/src',
    'packages/importer/src',
    'packages/inspector/src',
    'packages/plugin-api/src',
    'packages/shared/src',
    'packages/ai/src',
  ];
  const files: string[] = [];
  for (const d of productionDirs) walk(nodePath.join(REPO_ROOT, d), files);
  return files.flatMap(scanFile);
}

function runCommand(cmd: string, args: readonly string[]): IRuntimeProbe {
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    command: `${cmd} ${args.join(' ')}`,
    exitCode: res.status ?? -1,
    passed: (res.status ?? -1) === 0,
    stderr: (res.stderr ?? '').slice(0, 2000),
    stdout: (res.stdout ?? '').slice(0, 2000),
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const wantRuntime = args.includes('--runtime');
  const cliOnly = args.includes('--cli');
  const mcpOnly = args.includes('--mcp');
  const wantJson = args.includes('--json') || args.includes('--ci');

  const bunUsage = scanProductionSources();
  const blockers: string[] = [];
  for (const u of bunUsage) {
    blockers.push(`${u.file}:${u.line} uses Bun.* — ${u.snippet}`);
  }
  const notes: string[] = [];
  const runtimeProbes: IRuntimeProbe[] = [];
  if (wantRuntime) {
    notes.push('Runtime probes require dist/ to be built; pass --build to do this in one shot.');
    const wantBuild = args.includes('--build');
    if (wantBuild) {
      const build = runCommand('bun', ['run', 'build:dist']);
      runtimeProbes.push(build);
    }
    // Node probes must run with every workspace package's package.json in
    // publish mode (main/exports pointing at dist/) — otherwise Node resolves
    // @shrkcrft/* to src/*.ts and dies on the .ts extension.
    await withAllPackagesPublishMode(
      nodePath.join(REPO_ROOT, 'packages'),
      () => {
        const cliDist = nodePath.join(REPO_ROOT, 'packages/cli/dist/main.js');
        if (cliOnly || !mcpOnly) {
          if (existsSync(cliDist)) {
            runtimeProbes.push(runCommand('node', [cliDist, 'version']));
            runtimeProbes.push(runCommand('node', [cliDist, 'help']));
            const dogfood = nodePath.join(REPO_ROOT, 'examples/dogfood-target');
            if (existsSync(dogfood)) {
              runtimeProbes.push(runCommand('node', [cliDist, '--cwd', dogfood, 'doctor']));
              runtimeProbes.push(runCommand('node', [cliDist, '--cwd', dogfood, 'task', 'review the dogfood-target setup', '--json']));
              runtimeProbes.push(runCommand('node', [cliDist, '--cwd', dogfood, 'check', 'boundaries', '--json']));
              runtimeProbes.push(runCommand('node', [cliDist, '--cwd', dogfood, 'quality', '--json']));
            }
          } else {
            notes.push('packages/cli/dist/main.js missing — run `bun run build:dist` first.');
          }
        }
        if (mcpOnly || !cliOnly) {
          const mcpDist = nodePath.join(REPO_ROOT, 'packages/mcp-server/dist/main.js');
          if (existsSync(mcpDist)) {
            // We don't actually start the MCP server (it blocks on stdio); just
            // probe `node --check` to confirm the entry parses.
            runtimeProbes.push(runCommand('node', ['--check', mcpDist]));
          } else {
            notes.push('packages/mcp-server/dist/main.js missing — run `bun run build:dist` first.');
          }
        }
      },
      { skip: ['dashboard'] },
    );
  }
  const failedProbes = runtimeProbes.filter((p) => !p.passed).length;
  const passed = blockers.length === 0 && failedProbes === 0;
  const report: ICompatReport = { bunUsage, blockers, passed, runtimeProbes, notes };

  // Always emit a machine-readable artifact next to the script so CI can pick
  // it up without re-running compat:node in --json mode.
  try {
    const artifactsDir = nodePath.join(REPO_ROOT, '.sharkcraft', 'reports');
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      nodePath.join(artifactsDir, 'compat-node-report.json'),
      JSON.stringify(report, null, 2) + '\n',
      'utf8',
    );
  } catch {
    /* non-fatal: the artifact is a convenience, not a contract */
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return passed ? 0 : 1;
  }
  process.stdout.write('=== Node compatibility audit ===\n');
  process.stdout.write(`  Bun.* usages:    ${bunUsage.length}\n`);
  process.stdout.write(`  Runtime probes:  ${runtimeProbes.length} (failed=${failedProbes})\n`);
  if (bunUsage.length > 0) {
    process.stdout.write('\nBun.* usages (blockers for pure-Node runtime):\n');
    for (const u of bunUsage.slice(0, 20)) {
      process.stdout.write(`  • ${u.file}:${u.line}  ${u.snippet}\n`);
    }
    if (bunUsage.length > 20) process.stdout.write(`  …and ${bunUsage.length - 20} more.\n`);
  }
  if (runtimeProbes.length > 0) {
    process.stdout.write('\nRuntime probes:\n');
    for (const p of runtimeProbes) {
      process.stdout.write(`  ${p.passed ? 'OK  ' : 'FAIL'}  ${p.command} (exit ${p.exitCode})\n`);
      if (!p.passed && p.stderr) process.stdout.write(`        ${p.stderr.slice(0, 200)}\n`);
    }
  }
  for (const n of notes) process.stdout.write(`note: ${n}\n`);
  process.stdout.write(`\nVerdict: ${passed ? 'OK ✓' : 'Node compatibility issues'}\n`);
  return passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`Fatal: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
