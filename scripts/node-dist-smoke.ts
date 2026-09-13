#!/usr/bin/env bun
// node-dist-smoke (round 13, 13.2): run the EMITTED dist under node.
//
// Every Bun-run check — bun test, `bun run shrk`, the doctor-json audit, a
// `bun dist/main.js` smoke — resolves @shrkcrft/* through tsconfig paths, so it
// is blind to the workspace links a node run of dist/ depends on. The CLI's
// import graph is fully static (main.ts imports every command module), so ONE
// node probe of each entry catches a missing link on any package it reaches.
// Required in release:preflight (right after build-dist) and run by CI after
// its build.
//
// Probes, each from a fresh temp cwd (a consumer's position, not the repo's):
//   node packages/cli/dist/main.js --version      exit 0 and prints the version
//   node packages/cli/dist/shrk.js --version      the `shrk` bin bootstrap, same
//   node packages/mcp-server/dist/main.js         stdin closed: must not die with ERR_MODULE_NOT_FOUND
//   node packages/mcp-server/dist/shrk-mcp.js     the `shrk-mcp` bin bootstrap, same
// A bootstrap over a missing link exits 70 with one `shrk: workspace dependency
// … is not linked` line; that fails the probe like the raw resolver error does.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

interface IProbe {
  /** Repo-relative entry file. */
  readonly entry: string;
  /** `version`: `--version` must exit 0 and print the version. `server`: stdin closed, must not die at load. */
  readonly kind: 'version' | 'server';
}

const PROBES: readonly IProbe[] = [
  { entry: 'packages/cli/dist/main.js', kind: 'version' },
  { entry: 'packages/cli/dist/shrk.js', kind: 'version' },
  { entry: 'packages/mcp-server/dist/main.js', kind: 'server' },
  { entry: 'packages/mcp-server/dist/shrk-mcp.js', kind: 'server' },
];

/** A load-time failure: the raw resolver error, or the bootstrap's rewrite of it. */
const LOAD_FAILURE = /ERR_MODULE_NOT_FOUND|Cannot find package|is not linked — run/;
const SERVER_TIMEOUT_MS = 30_000;

function excerpt(text: string): string {
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 12)
    .map((l) => `      ${l}`)
    .join('\n');
}

function main(): number {
  const version = (JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as { version: string }).version;
  // The spawned node's version — this script runs under Bun, whose own
  // `process.version` is the Node version it emulates, not the probed runtime.
  const nodeVersion = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim() || 'node (version unknown)';
  const cwd = mkdtempSync(join(tmpdir(), 'shrk-node-dist-smoke-'));
  let failed = 0;
  try {
    for (const probe of PROBES) {
      const abs = join(ROOT, probe.entry);
      const shown = `node ${probe.entry}${probe.kind === 'version' ? ' --version' : ' (stdin closed)'}`;
      if (!existsSync(abs)) {
        process.stderr.write(`[node-dist-smoke] FAILED ${shown}: ${probe.entry} is missing — run \`bun run build:dist\` first\n`);
        failed += 1;
        continue;
      }
      const res = spawnSync('node', probe.kind === 'version' ? [abs, '--version'] : [abs], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: probe.kind === 'version' ? 60_000 : SERVER_TIMEOUT_MS,
      });
      const stdout = res.stdout ?? '';
      const stderr = res.stderr ?? '';
      const stillRunning = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      let reason: string | undefined;
      if (LOAD_FAILURE.test(stderr)) reason = `died at load (exit ${res.status ?? res.signal})`;
      else if (probe.kind === 'version' && res.status !== 0) reason = `exit ${res.status ?? res.signal}`;
      else if (probe.kind === 'version' && !stdout.includes(version)) reason = `did not print the version ${version}`;
      else if (probe.kind === 'server' && !stillRunning && res.status !== 0) reason = `exit ${res.status ?? res.signal}`;
      if (reason !== undefined) {
        process.stderr.write(`[node-dist-smoke] FAILED ${shown}: ${reason}\n${excerpt(stderr || stdout)}\n`);
        failed += 1;
        continue;
      }
      const observed =
        probe.kind === 'version'
          ? stdout.trim().split('\n')[0]
          : stillRunning
            ? `still serving after ${SERVER_TIMEOUT_MS / 1000}s`
            : 'exit 0 on stdin EOF';
      process.stdout.write(`[node-dist-smoke] ok ${shown} → ${observed}\n`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (failed > 0) {
    process.stderr.write(
      `[node-dist-smoke] ${failed} probe(s) failed — the emitted dist does not load under node ` +
        `(${nodeVersion}). A missing workspace link? run \`bun run scripts/lib/workspace-links.ts\`\n`,
    );
    return 1;
  }
  process.stdout.write(`[node-dist-smoke] ok — the emitted CLI and MCP entries load under node ${nodeVersion}\n`);
  return 0;
}

process.exit(main());
