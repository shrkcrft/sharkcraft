/**
 * Docs ↔ command honesty guard.
 *
 * Agent-facing docs are loaded into model context, so a `shrk <verb>` example
 * that names a command which no longer exists actively mis-trains every agent
 * that reads it. This test extracts every `shrk <top-level>` *invocation* from
 * the docs and asserts each top-level verb resolves against the live command
 * catalog (`COMMAND_CATALOG`).
 *
 * Scope (D3): the scan is repo-wide — every `docs/**\/*.md`, `README.md`, and
 * every `.claude/**\/SKILL.md` / `.agents/**\/SKILL.md`. (An earlier revision
 * only covered a curated subset; the catalog gaps it waited on — `shrk paths`
 * / `shrk pipelines` / `shrk checks` / `shrk audit` / `shrk ownership` — were
 * closed in D3-2, so the scan can now go wide.)
 *
 * Extraction is *invocation-aware*, not raw-regex: a `shrk <verb>` token only
 * counts when it (a) lives in a fenced code block or an inline `code` span and
 * (b) leads that line / span (after an optional `$`/`>` shell prompt). This
 * drops English prose ("shrk is a toolkit"), task strings that merely contain
 * the word "shrk" (`shrk smart-context "add a shrk subcommand"`), placeholder
 * phrases (`<exact shrk command to fix>`), and code comments — none of which
 * are command references — while still catching the dominant real pattern
 * (`shrk <verb>` at the head of a code example).
 *
 * The valid set is the curated `COMMAND_CATALOG`. A small, documented
 * allowlist covers three intentional exceptions:
 *   1. former CLI verbs that were removed and are referenced only inside
 *      "retired / removed — use the MCP tool" notes,
 *   2. registered group *aliases* that resolve live but use a singular form
 *      that is not a catalog top-word (e.g. `pipeline` → `pipelines`), and
 *   3. tokens that appear only as free-form did-you-mean *examples*, never as
 *      a real command.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMAND_CATALOG } from '../commands/command-catalog.ts';

// packages/cli/src/__tests__ → repo root is four levels up.
const REPO_ROOT = resolve(import.meta.dir, '../../../..');

/** Top-level command tokens the live catalog resolves (first word of each entry). */
const CATALOG_TOP: ReadonlySet<string> = new Set(
  COMMAND_CATALOG.map((e) => e.command.split(/\s+/)[0]!),
);

/**
 * Former CLI verbs that were REMOVED. Each is referenced only inside a
 * "retired / removed — use the MCP tool / replacement" note. Presenting any of
 * these as a live command is exactly the drift this test exists to catch.
 *
 * Note: `map` / `view` / `ai-readiness` / `routing` are deliberately NOT here —
 * those stale references are fixed in the docs (D3-1), not waved through.
 */
const ALLOWLIST_RETIRED_VERB_NOTES: readonly string[] = [
  'heal', // -> MCP create_healing_plan (docs/healing-plans.md)
  'agent', // `shrk agent graph` -> MCP create_execution_graph (docs/execution-graph.md)
  'compliance', // retired by R46 -> `shrk safety audit --deep` (docs/safety-model.md)
  'intelligence', // -> `shrk graph` / `shrk architecture map` (docs/architecture.md)
  'demo', // `shrk demo` namespace retired -> examples/dogfood-target scripts (README.md)
  'session', // `shrk session start` removed in R48 -> `shrk dev start` (docs/dev-workflow.md)
];

/**
 * Registered group ALIASES (main.ts `aliasGroup(...)`) that resolve live but
 * use a singular form not present as a catalog top-word. They're real commands;
 * the catalog just keys them under the canonical plural.
 */
const ALLOWLIST_REGISTERED_ALIASES: readonly string[] = [
  'pipeline', // alias for `pipelines` (README.md documents it as such)
];

/**
 * Tokens that follow `shrk` only inside a free-form *example* (e.g. a
 * did-you-mean demonstration) — never claimed as a real command.
 */
const ALLOWLIST_FREEFORM_EXAMPLES: readonly string[] = [
  'rename', // `shrk rename a service safely` — free-form did-you-mean (docs/command-entrypoints.md)
];

const ALLOWLIST: ReadonlySet<string> = new Set([
  ...ALLOWLIST_RETIRED_VERB_NOTES,
  ...ALLOWLIST_REGISTERED_ALIASES,
  ...ALLOWLIST_FREEFORM_EXAMPLES,
]);

/** Recursive scan: docs/**\/*.md + README.md + .claude|.agents **\/SKILL.md. */
function collectScannedFiles(): readonly string[] {
  const out = new Set<string>();
  for (const rel of readdirSync(resolve(REPO_ROOT, 'docs'), { recursive: true })) {
    if (typeof rel === 'string' && rel.endsWith('.md')) out.add(`docs/${rel}`);
  }
  out.add('README.md');
  for (const base of ['.claude', '.agents']) {
    const dir = resolve(REPO_ROOT, base);
    if (!existsSync(dir)) continue;
    for (const rel of readdirSync(dir, { recursive: true })) {
      if (typeof rel === 'string' && rel.endsWith('SKILL.md')) out.add(`${base}/${rel}`);
    }
  }
  return [...out].sort();
}

const SCANNED_FILES: readonly string[] = collectScannedFiles();

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/**
 * Extract every leading `shrk <verb>` from a doc's CODE regions only (fenced
 * blocks + inline spans). A verb counts only when `shrk` heads the line / span
 * after an optional shell prompt — so prose, task strings, and placeholders
 * that merely contain the word "shrk" don't register as invocations.
 */
function extractTopLevelVerbs(text: string): string[] {
  const verbs: string[] = [];
  const pushLeading = (segment: string): void => {
    const trimmed = segment.replace(/^\s+/, '').replace(/^[$>]\s+/, '').replace(/^\s+/, '');
    const m = /^shrk\s+([a-z][a-z0-9-]*)/.exec(trimmed);
    if (m) verbs.push(m[1]!);
  };
  // Fenced code blocks: one candidate per line.
  for (const block of text.match(/```[\s\S]*?```/g) ?? []) {
    for (const line of block.split('\n')) pushLeading(line);
  }
  // Inline code spans, outside fenced blocks.
  const withoutFences = text.replace(/```[\s\S]*?```/g, '\n');
  for (const m of withoutFences.matchAll(/`([^`\n]+)`/g)) pushLeading(m[1]!);
  return verbs;
}

describe('docs ↔ command honesty', () => {
  test('every documented `shrk <top-level>` resolves against the live catalog', () => {
    const offenders: string[] = [];
    for (const rel of SCANNED_FILES) {
      const text = read(rel);
      for (const verb of extractTopLevelVerbs(text)) {
        if (CATALOG_TOP.has(verb) || ALLOWLIST.has(verb)) continue;
        offenders.push(`${rel}: shrk ${verb}`);
      }
    }
    expect(
      offenders,
      `Docs reference top-level commands not in COMMAND_CATALOG (and not allowlisted):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  test('allowlist stays honest — no allowlisted token is actually a catalog command', () => {
    // If a verb gets (re)added to the catalog, drop it from the allowlist so a
    // genuinely-live command is checked normally rather than waved through.
    for (const verb of ALLOWLIST) {
      expect(
        CATALOG_TOP.has(verb),
        `allowlisted "${verb}" is now a catalog command — remove it from the allowlist`,
      ).toBe(false);
    }
  });

  test('allowlist stays honest — every allowlisted token is actually referenced', () => {
    // Prevent dead allowlist entries: each must appear as a leading `shrk `
    // invocation in at least one scanned file.
    const referenced = new Set<string>();
    for (const rel of SCANNED_FILES) {
      for (const verb of extractTopLevelVerbs(read(rel))) referenced.add(verb);
    }
    for (const verb of ALLOWLIST) {
      expect(
        referenced.has(verb),
        `allowlisted "${verb}" is no longer referenced in any scanned doc — remove it`,
      ).toBe(true);
    }
  });

  test('task-routing-hints.md retired the `shrk routing` CLI verbs (D3-1)', () => {
    // The `routing` namespace is MCP-only (list_task_routing_hints /
    // explain_task_routing). No doc may present `shrk routing …` as live.
    expect(read('docs/task-routing-hints.md')).not.toContain('shrk routing');
  });

  test('regenerated taxonomy lists no removed commands (D5)', () => {
    // docs/commands-taxonomy.md is auto-generated from the live catalog, so it
    // must contain NONE of the fully-removed verbs — even the ones the global
    // allowlist tolerates inside hand-written retirement notes.
    const taxonomy = read('docs/commands-taxonomy.md');
    const removed = ['map', 'demo', 'train', 'compliance', 'heal', 'agent', 'session', 'intelligence', 'view'];
    for (const verb of removed) {
      const re = new RegExp(`\\bshrk ${verb}(\\b|\`)`);
      expect(re.test(taxonomy), `taxonomy still references removed command \`shrk ${verb}\``).toBe(false);
    }
  });

  test('sharkcraft-dev skill uses `shrk dev`, not the removed `shrk session` (D2)', () => {
    for (const rel of [
      '.claude/skills/sharkcraft-dev/SKILL.md',
      '.agents/skills/sharkcraft-dev/SKILL.md',
    ]) {
      const text = read(rel);
      expect(text.includes('shrk dev start')).toBe(true);
      expect(text.includes('shrk dev diff')).toBe(true);
      expect(text.includes('shrk session')).toBe(false);
    }
  });
});
