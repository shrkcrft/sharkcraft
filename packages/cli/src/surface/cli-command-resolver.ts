import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  warmReferenceRegistries,
  type ICommandResolution,
  type ICommandResolveOptions,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import { getActiveCommandIndex } from './command-index.ts';
import type { ICommandIndex } from './i-command-index.ts';
import type { ICommandStringContext } from './i-command-string-context.ts';
import { resolveCommandString } from './resolve-command-string.ts';

/**
 * The CLI side of the inspector's command-resolver seam.
 *
 * The inspector cannot import the CLI (layer order), so it answers `command`
 * references through a resolver the CLI injects — built here from the ACTIVE
 * command index (the registry this run dispatches from). Every CLI site that
 * warms the reference registries goes through {@link warmCliReferenceRegistries},
 * so a knowledge reference, a doctor probe and an agent-test expectation are
 * all answered by the same function.
 */

let toolNames: Promise<ReadonlySet<string> | undefined> | undefined;

/** Registered MCP tool names (loaded once per process, lazily). */
function loadMcpToolNames(): Promise<ReadonlySet<string> | undefined> {
  toolNames ??= importMcpToolNames();
  return toolNames;
}

/**
 * The lazy import behind {@link loadMcpToolNames}; a failed import reads as
 * "no MCP tool names". Written as `await import()` — the `import(…).then(…)`
 * shape is read by `shrk check imports` as an inline type import (an error
 * that fails release preflight).
 */
async function importMcpToolNames(): Promise<ReadonlySet<string> | undefined> {
  let mcp: { readonly ALL_TOOLS: readonly { readonly name: string }[] };
  try {
    mcp = await import('@shrkcrft/mcp-server');
  } catch {
    return undefined;
  }
  return new Set(mcp.ALL_TOOLS.map((t) => t.name));
}

/** Root package.json script names, or `undefined` when there is none to read. */
export function readPackageScripts(projectRoot: string): ReadonlySet<string> | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return undefined;
  }
}

/** The non-shrk sets the resolver checks against, for `projectRoot`. */
export async function loadCommandStringContext(projectRoot: string): Promise<ICommandStringContext> {
  const scripts = readPackageScripts(projectRoot);
  const mcpToolNames = await loadMcpToolNames();
  return {
    ...(scripts ? { scripts } : {}),
    ...(mcpToolNames ? { mcpToolNames } : {}),
    root: projectRoot,
  };
}

/**
 * A memoised `(raw, options?) => ICommandResolution` over the active command
 * index, or `undefined` outside a CLI run (no index) — the inspector then
 * reports every command reference NOT VERIFIED rather than guessing. The memo
 * keys on the reading too: `doctor` as a command reference and as free shell
 * text are two different questions.
 */
export async function cliCommandResolver(
  projectRoot: string,
  index: ICommandIndex | undefined = getActiveCommandIndex(),
): Promise<((raw: string, options?: ICommandResolveOptions) => ICommandResolution) | undefined> {
  if (!index) return undefined;
  const ctx = await loadCommandStringContext(projectRoot);
  const memo = new Map<string, ICommandResolution>();
  return (raw: string, options: ICommandResolveOptions = {}): ICommandResolution => {
    const key = [options.assumeShrk === true ? 'ref' : 'sh', raw].join(String.fromCharCode(0));
    const hit = memo.get(key);
    if (hit) return hit;
    const resolution = resolveCommandString(index, raw, ctx, options);
    memo.set(key, resolution);
    return resolution;
  };
}

/**
 * `warmReferenceRegistries` plus the injected command resolver. THE warm call
 * for CLI code: a bare warm leaves every `command` reference Unverifiable.
 */
export async function warmCliReferenceRegistries(inspection: ISharkcraftInspection): Promise<void> {
  const commandResolver = await cliCommandResolver(inspection.projectRoot);
  await warmReferenceRegistries(inspection, commandResolver ? { commandResolver } : {});
}
