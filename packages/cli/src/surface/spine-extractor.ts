import type { IPipelineDefinition } from '@shrkcrft/pipelines';

/**
 * IDs of pipelines treated as the "spine" — pipelines whose
 * referenced commands are tier=Core regardless of any other catalog
 * derivation rule.
 *
 * Today only `engine.feature-dev` exists in the engine repo.
 * `engine.safe-generation` is a planned second spine pipeline; if a
 * project ships it, it's automatically picked up here.
 */
export const SPINE_PIPELINE_IDS: readonly string[] = Object.freeze([
  'engine.feature-dev',
  'engine.safe-generation',
]);

/**
 * Verbs the spine derivation is allowed to promote to core. The
 * spine pipelines reference write verbs (`apply`, `gen`, `plan
 * review`) too, but those are power-user surfaces; letting them
 * drift into core inflates the "brutally small" promise. Anything
 * outside this allowlist stays tier=extended even when the spine
 * references it.
 */
const CORE_SPINE_VERB_ALLOWLIST: ReadonlySet<string> = new Set([
  'context',
  'check boundaries',
]);

/**
 * Extract the catalog command names referenced from spine
 * pipelines AND in the core verb allowlist. The function does NOT
 * execute any pipeline — it walks `steps[].cliCommands[]` and parses
 * out the verb path.
 *
 * Parsing rule: each `cliCommands` entry is a shell-style string like
 * `bun run shrk plan review /tmp/plan.json`. The parser strips a
 * leading `bun run shrk` or `shrk` and returns the first 1-2 tokens
 * as a command path. Multi-token paths are joined with a space so
 * they match {@link ICommandCatalogEntry.command} entries that already
 * use this form (`pack author status`, `plan review`).
 */
export function extractSpineCommands(
  pipelines: readonly IPipelineDefinition[],
): ReadonlySet<string> {
  const out = new Set<string>();
  const spineIds = new Set(SPINE_PIPELINE_IDS);

  for (const pipeline of pipelines) {
    if (!spineIds.has(pipeline.id)) continue;
    for (const step of pipeline.steps ?? []) {
      for (const raw of step.cliCommands ?? []) {
        const verb = parseCommandVerb(raw);
        if (verb && CORE_SPINE_VERB_ALLOWLIST.has(verb)) out.add(verb);
      }
    }
  }

  return out;
}

/**
 * Parse a single CLI command string into its catalog `command`
 * path. Returns `undefined` if the string doesn't reference shrk.
 *
 * Examples:
 *   `bun run shrk doctor`                      → `doctor`
 *   `bun run shrk plan review /tmp/plan.json`  → `plan review`
 *   `bun run shrk pack author status`          → `pack author status`
 *   `bun run shrk context --task "<task>"`     → `context`
 *   `bun x tsc`                                → undefined
 */
export function parseCommandVerb(raw: string): string | undefined {
  let tokens = raw.trim().split(/\s+/);
  if (tokens.length === 0) return undefined;

  // Drop leading `bun run` / `npx` / `pnpm exec` wrappers.
  const wrappers = new Set(['bun', 'npx', 'pnpm', 'yarn']);
  if (wrappers.has(tokens[0]!)) {
    tokens = tokens.slice(1);
    if (tokens[0] === 'run' || tokens[0] === 'exec' || tokens[0] === 'x') {
      tokens = tokens.slice(1);
    }
  }

  // Drop the `shrk` binary name.
  if (tokens[0] !== 'shrk') return undefined;
  tokens = tokens.slice(1);

  // Stop at the first flag, placeholder (`<...>`), path-looking arg
  // (`/tmp/...`, `./...`), or quoted-string arg. Placeholders +
  // positional args inflate the verb path so we exclude them.
  const verbTokens: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('-')) break;
    if (t.startsWith('<') || t.endsWith('>')) break;
    if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../')) break;
    if (t.startsWith('"') || t.startsWith("'")) break;
    verbTokens.push(t);
  }

  if (verbTokens.length === 0) return undefined;
  return verbTokens.join(' ');
}
