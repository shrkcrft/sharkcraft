/**
 * Heuristic file matchers for IKnowledgeEntry-style rules.
 *
 * Rules in the knowledge model don't carry path patterns directly the
 * way boundary rules do. The bridge needs to know "which files does
 * this rule apply to?" — we derive that from two sources, in order:
 *
 *   1. **Explicit**: `rule.metadata.appliesTo` — an array of glob
 *      patterns. Authoritative when present.
 *   2. **Tag-based heuristics**: well-known tags map to file
 *      patterns. For example a rule tagged `mcp` likely applies to
 *      files under `packages/mcp-server/**`. The map is intentionally
 *      conservative — when no tag matches, the rule is *not* bridged
 *      (better silent than noisy).
 *
 * Authors who want predictable bridging set `metadata.appliesTo`.
 */

const TAG_PATTERNS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  // Engine packages.
  ['mcp', ['packages/mcp-server/**']],
  ['cli', ['packages/cli/**']],
  ['dashboard', ['packages/dashboard/**', 'packages/dashboard-api/**']],
  ['generator', ['packages/generator/**']],
  ['importer', ['packages/importer/**']],
  ['inspector', ['packages/inspector/**']],
  ['packs', ['packages/packs/**']],
  ['core', ['packages/core/**']],
  // Asset categories.
  ['boundaries', ['sharkcraft/boundaries.ts', 'packages/boundaries/**']],
  ['rules', ['sharkcraft/rules.ts', 'packages/rules/**']],
  ['paths', ['sharkcraft/paths.ts', 'packages/paths/**']],
  ['templates', ['sharkcraft/templates.ts', 'packages/templates/**']],
  ['pipelines', ['sharkcraft/pipelines.ts', 'packages/pipelines/**']],
  ['presets', ['sharkcraft/presets.ts', 'packages/presets/**']],
  // Cross-cutting concerns.
  ['imports', ['packages/**/*.ts']],
  ['testing', []], // signal-only; the bridge attaches via the file's `tags: test` separately
  ['tests', []],
]);

export interface IRuleApplicability {
  /** Glob patterns to match against file paths. */
  patterns: readonly string[];
  /**
   * When non-empty, the rule applies to every file whose `tags` array
   * intersects this set. Currently used by `testing`-tagged rules.
   */
  fileTags: readonly string[];
  /** How we derived the applicability — useful for diagnostics. */
  source: 'metadata' | 'tags' | 'none';
}

export function deriveApplicability(rule: {
  tags?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}): IRuleApplicability {
  const explicit = rule.metadata?.['appliesTo'];
  if (Array.isArray(explicit) && explicit.every((p) => typeof p === 'string')) {
    return { patterns: explicit as readonly string[], fileTags: [], source: 'metadata' };
  }
  const tags = rule.tags ?? [];
  const patterns: string[] = [];
  const fileTags: string[] = [];
  for (const tag of tags) {
    if (tag === 'testing' || tag === 'tests') {
      fileTags.push('test');
      continue;
    }
    const mapped = TAG_PATTERNS.get(tag);
    if (mapped) {
      for (const p of mapped) {
        if (!patterns.includes(p)) patterns.push(p);
      }
    }
  }
  if (patterns.length === 0 && fileTags.length === 0) {
    return { patterns: [], fileTags: [], source: 'none' };
  }
  return { patterns, fileTags, source: 'tags' };
}
