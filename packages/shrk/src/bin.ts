#!/usr/bin/env node
// Unscoped `shrk` bin. Forwards to @shrkcrft/cli's `runCli`. The file is
// intentionally named `bin.ts` (not `main.ts`) so the CLI's entry-point
// guard in @shrkcrft/cli/dist/main.js does NOT also fire when this module
// transitively loads it — we control the single entry from here.
import { runCli } from '@shrkcrft/cli';

const argv = process.argv.slice(2);
runCli(argv).then(
  (code: number) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
