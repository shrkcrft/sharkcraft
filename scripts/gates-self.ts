/**
 * gates:self — run shrk's own data-defined rule planes over shrk.
 *
 * Every defect the improvement rounds surfaced was invisible to unit tests and
 * only appeared when a real, non-trivial config drove the engine. This repo HAS
 * such a config (`sharkcraft/sharkcraft.config.ts`: a wiring rule over 280+ MCP
 * tools, a shared `$use` extractor, a registry, a policy rule, a committed
 * baseline, a generated-artifact rule). Running it every commit means the
 * engine is exercised against real inputs continuously, and the examples in the
 * docs cannot quietly stop being true.
 *
 * Two verbs, two questions, both of which have to hold:
 *   `gates check`    — does anything VIOLATE a declared rule?
 *   `gates coverage` — is every rule still CONNECTED to something?
 *
 * `--strict` on coverage is the point: a rule that matched nothing is a bug in
 * the rule, and here that must fail the build rather than print a note nobody
 * reads.
 */
import { spawnSync } from 'node:child_process';

const CLI = ['packages/cli/src/main.ts'];

interface IStep {
  readonly label: string;
  readonly argv: readonly string[];
  /** Why this step exists, printed when it fails. */
  readonly why: string;
}

const STEPS: readonly IStep[] = [
  {
    label: 'gates check',
    argv: ['gates', 'check', '--no-hints'],
    why: 'a declared rule is violated — the engine found a real problem in this repo',
  },
  {
    label: 'gates coverage --strict',
    argv: ['gates', 'coverage', '--strict', '--no-hints'],
    why: 'a rule matched nothing — its selector has gone stale and it is enforcing nothing',
  },
];

let failed = 0;
for (const step of STEPS) {
  process.stdout.write(`\n=== ${step.label} ===\n`);
  const child = spawnSync('bun', [...CLI, ...step.argv], { stdio: 'inherit', encoding: 'utf8' });
  const code = child.status ?? 1;
  if (code !== 0) {
    failed += 1;
    process.stdout.write(`\n[gates:self] ${step.label} exited ${code} — ${step.why}\n`);
  }
}

if (failed > 0) {
  process.stdout.write(
    `\n[gates:self] ${failed} step(s) failed. shrk's own rules must hold on shrk.\n`,
  );
  process.exit(1);
}
process.stdout.write("\n[gates:self] shrk's own rule planes are green on shrk. ✓\n");
