#!/usr/bin/env node
/**
 * This package's bin (round 13, 13.2): a bootstrap that loads `./main.ts`
 * (emitted as `dist/main.js`) through a dynamic import, so a load failure of
 * the entry's STATIC module graph reaches a handler at all. One case is
 * rewritten — a workspace dependency of the installed tool that is not linked
 * (Node's raw `ERR_MODULE_NOT_FOUND: Cannot find package '@shrkcrft/x'`
 * resolver stack) — into one line naming the dependency, the package that
 * needs it and where to run the install, exit 70 (EX_SOFTWARE: the tool's own
 * install is broken; docs/exit-codes.md). Every other error is rethrown
 * untouched: the same message, source line and exit code as running
 * `dist/main.js` directly.
 *
 * node: builtins only, through the sibling ./bootstrap module — never an
 * `@shrkcrft` import: that package's link could be the missing one. The CLI
 * (`shrk`) and the MCP server (`shrk-mcp`) carry byte-identical copies of this
 * file and of ./bootstrap/unlinked-workspace-dependency.ts;
 * r77-bootstrap-rewrite.test.ts locks them together.
 */
import { unlinkedWorkspaceDependencyMessage } from './bootstrap/unlinked-workspace-dependency.ts';

try {
  await import('./main.ts');
} catch (error) {
  const message = unlinkedWorkspaceDependencyMessage(error);
  if (message === undefined) throw error;
  // Exit only once the line is flushed: stderr is asynchronous on a pipe.
  process.stderr.write(`${message}\n`, () => process.exit(70));
}
