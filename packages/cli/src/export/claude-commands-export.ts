/**
 * `.claude/commands/` generator — emits per-project slash commands
 * for Claude Code. Companion to `claude-skill` export, but with a
 * different inversion semantics:
 *
 *   - **claude-skill** loads rules into Claude's prompt automatically
 *     based on description match. Passive — Claude reads the rules.
 *   - **claude-commands** registers slash commands the USER invokes
 *     (`/new-service`, `/check-changes`). Active — the command IS the
 *     recipe; Claude follows it step-by-step.
 *
 * Generated commands fall into two buckets:
 *
 * **Static commands** (always present, project-agnostic recipes):
 *   - `/follow-shrk` — short reminder of the apply-gate flow.
 *   - `/check-changes` — runs `shrk check boundaries --changed-only`
 *     scoped to the current diff and reports back.
 *   - `/shrk-brief` — runs `shrk brief` and uses the output for the
 *     current task.
 *   - `/explain-file <path>` — per-file rules / paths / boundary
 *     lookup (pairs with `shrk advise <path>` from Phase 3).
 *
 * **Per-template commands** (one per id in `sharkcraft/templates.ts`):
 *   - `/new-<template-id>` — Claude runs `shrk gen <template-id>
 *     <name> --dry-run --save-plan ...`, reviews the plan, and
 *     applies via `shrk apply ... --verify-signature --validate`.
 *
 * Generated files are self-contained markdown — no `@shrkcrft/*`
 * imports, no shell expansions. Each one is a complete "recipe in a
 * file" that Claude Code reads when the user types the slash command.
 */

import type { ISharkcraftInspection } from '@shrkcrft/inspector';

export interface IClaudeCommandFile {
  /** Path relative to project root (e.g. `.claude/commands/new-service.md`). */
  path: string;
  /** Full markdown body, including YAML frontmatter. */
  content: string;
  /** The slash name users type (e.g. `new-service` → `/new-service`). */
  slash: string;
  /** Why this command was generated — surfaces in the dry-run summary. */
  source: 'static' | 'template';
}

export interface IClaudeCommandsResult {
  files: readonly IClaudeCommandFile[];
}

// ─── Static commands (always emitted) ────────────────────────────────────────

const STATIC_FOLLOW_SHRK = `---
description: Reminder of the shrk apply-gate flow for this project. Use when generating or modifying code so the change passes the same boundary / validation gates the project CI uses.
---

# Follow the shrk apply-gate flow

This repo uses [SharkCraft](https://github.com/shrkcrft/sharkcraft) as the
gate for AI-written code. Skip the gate and CI will fail with the same
errors anyway — save the round-trip.

## The loop

1. **Get focused context first.**
   - Run: \`shrk task "<one-sentence task>"\` for a task packet (relevant rules + templates + verification commands).
   - Or: \`shrk brief\` for the single-page project brief.

2. **Scaffold via a template (not freehand).**
   - List options: \`shrk templates list\`.
   - Dry-run + save plan: \`shrk gen <template-id> <name> --dry-run --save-plan /tmp/plan.json\`.

3. **Apply the plan through the CLI.**
   - \`shrk apply /tmp/plan.json --verify-signature --validate\`.
   - Never write files directly through MCP — MCP is read-only in this repo.

4. **Verify before declaring done.**
   - \`shrk check boundaries --changed-only\` — fails if the diff broke any layer rule.
   - \`shrk check imports\` — fails on lazy requires / cross-package deep imports.
   - Project verification commands (from \`shrk task\`'s \`actionHints.verificationCommands\`).

## When this loop doesn't apply

- Tiny changes that don't touch source files (docs, comments).
- Read-only investigations.
- Anything where shrk would clearly be in the way.

In all other cases: **follow the loop**. The gates are short; the rework if you skip them is long.
`;

const STATIC_CHECK_CHANGES = `---
description: Run shrk's boundary + import-hygiene checks on the current git diff. Use after making any file change to confirm the change didn't violate the project's architecture rules before declaring the task done.
---

# Check the current diff for boundary violations

Run the diff-scoped boundary check:

\`\`\`bash
shrk check boundaries --changed-only
\`\`\`

Run the import-hygiene check on the changed files:

\`\`\`bash
shrk check imports
\`\`\`

## Interpreting the output

- **Exit 0, "0 violations":** safe to declare done.
- **Exit non-zero with violations listed:** fix each violation before continuing. Each violation has a \`suggestedFix\` line — apply it.
- **A violation on a file you didn't change:** that's a pre-existing violation in the repo. Ignore it; the \`--changed-only\` filter only fails on violations your diff introduced.

If the violations look like false positives, consult \`sharkcraft/boundaries.ts\` (the rule definitions) — don't disable them ad-hoc.
`;

const STATIC_SHRK_BRIEF = `---
description: Pull shrk's single-page project brief — focused rules, paths, verification commands. Use when starting work in this codebase so you have the project's actual conventions in context before writing any code.
---

# Pull the shrk brief for this project

Run the project brief:

\`\`\`bash
shrk brief
\`\`\`

This returns a compact markdown brief covering:
- Project overview (name, frameworks, package manager).
- Top rules that apply to code generation in this repo.
- Path conventions (where different file types belong).
- Action hints (commands, MCP tools, verification commands).
- Forbidden actions (what NOT to do).

For a per-task version (only the rules + paths + templates relevant to one task):

\`\`\`bash
shrk task "<one-sentence task description>"
\`\`\`

Both are read-only — no files are touched. Use the output to shape your plan before making any changes.
`;

const STATIC_EXPLAIN_FILE = `---
description: Look up the rules, path conventions, and boundary rules that apply to a specific file in this codebase. Use before editing an unfamiliar file so you follow the project's per-area conventions instead of generic patterns.
---

# Explain what applies to a file in this codebase

For a given file path (e.g. \`apps/users/src/profile.service.ts\`):

\`\`\`bash
shrk why <file-path>
\`\`\`

Returns:
- Which package / layer the file belongs to.
- Which path conventions apply (e.g. "services live in \`apps/<x>/src/services/\`").
- Which rules are scoped to this file's path.
- Which boundary rules constrain this file's imports.
- Cross-references to related knowledge entries.

Use this *before* editing. The output is the project's actual conventions for that area, not your guess based on the file's content.
`;

// ─── Per-template command generator ──────────────────────────────────────────

/**
 * Slugify a template id into a slash-command name. Template ids
 * conventionally look like `typescript.service`; the slash command is
 * `new-typescript-service` (or `new-service` if the segment after the
 * dot is unique and shorter).
 */
function templateSlash(templateId: string): string {
  // Use the LAST dot-separated segment as the primary name —
  // `typescript.service` → `new-service`. Falls back to the full id
  // when there's no dot or the segment is too generic (single char).
  const parts = templateId.split('.');
  const tail = parts[parts.length - 1] ?? templateId;
  const safeName =
    tail.length >= 3 ? tail : templateId.replace(/\./g, '-');
  return `new-${safeName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function templateCommandBody(template: {
  id: string;
  name?: string;
  description?: string;
}): string {
  const displayName = template.name ?? template.id;
  const description = template.description
    ? template.description.replace(/\s+/g, ' ').trim()
    : `Scaffold a new ${displayName} using the project's actual template (\`${template.id}\`). Follows the shrk plan → apply → validate flow.`;
  return `---
description: ${JSON.stringify(description)}
---

# /${templateSlash(template.id)} — scaffold ${displayName}

This command scaffolds a new ${displayName} using the project's actual template
defined in \`sharkcraft/templates.ts\`. The template encodes this repo's
conventions for path, naming, and structure — the result will match how
the rest of the codebase is organized, not generic patterns.

## The flow

When the user invokes \`/${templateSlash(template.id)} <name>\`:

1. **Generate a plan (no writes yet):**
   \`\`\`bash
   shrk gen ${template.id} <name> --dry-run --save-plan /tmp/${templateSlash(template.id)}.plan.json
   \`\`\`

2. **Read the plan back** from \`/tmp/${templateSlash(template.id)}.plan.json\` and show the user which files will be created.

3. **Confirm.** Wait for the user to approve. If they want changes, adjust the plan or re-run \`shrk gen\` with different flags.

4. **Apply through the validated CLI path:**
   \`\`\`bash
   shrk apply /tmp/${templateSlash(template.id)}.plan.json --verify-signature --validate
   \`\`\`

5. **Verify** the diff didn't break any boundary rules:
   \`\`\`bash
   shrk check boundaries --changed-only
   \`\`\`

## If the template doesn't fit

If the user's request doesn't match the \`${template.id}\` template
shape, fall back to:

- \`shrk templates list\` — see all available templates.
- \`shrk gen <other-template> <name> --dry-run\` — try a different template.
- Hand-author only as last resort, and run \`/check-changes\` after.

The whole point of using the template is consistency with the rest of
this codebase. Skipping it means the new code will look different from
what's already there.
`;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export interface IClaudeCommandsOptions {
  /**
   * Cap on the number of per-template commands to emit. Default 20.
   * Templates are sorted by id; the first N are kept.
   */
  maxTemplateCommands?: number;
}

/**
 * Build the full set of `.claude/commands/*.md` files for a project.
 *
 * Pure — caller writes the bytes. Same shape as the `synthesize-*`
 * functions in this codebase: input inspection → output file list.
 */
export function buildClaudeCommands(
  inspection: ISharkcraftInspection,
  options: IClaudeCommandsOptions = {},
): IClaudeCommandsResult {
  const files: IClaudeCommandFile[] = [];

  files.push({
    path: '.claude/commands/follow-shrk.md',
    slash: 'follow-shrk',
    source: 'static',
    content: STATIC_FOLLOW_SHRK,
  });
  files.push({
    path: '.claude/commands/check-changes.md',
    slash: 'check-changes',
    source: 'static',
    content: STATIC_CHECK_CHANGES,
  });
  files.push({
    path: '.claude/commands/shrk-brief.md',
    slash: 'shrk-brief',
    source: 'static',
    content: STATIC_SHRK_BRIEF,
  });
  files.push({
    path: '.claude/commands/explain-file.md',
    slash: 'explain-file',
    source: 'static',
    content: STATIC_EXPLAIN_FILE,
  });

  // Per-template commands — bounded so a pack with 50 templates
  // doesn't dump 50 slash commands into the user's palette. Sorted
  // by id for deterministic emit order.
  const cap = options.maxTemplateCommands ?? 20;
  const templates = [...inspection.templates].sort((a, b) => a.id.localeCompare(b.id));
  const seenSlash = new Set<string>(files.map((f) => f.slash));
  for (const t of templates) {
    if (files.filter((f) => f.source === 'template').length >= cap) break;
    let slash = templateSlash(t.id);
    if (seenSlash.has(slash)) {
      // Two templates with the same tail (e.g. `ts.service` and
      // `py.service` both → `new-service`) — fall back to the full id
      // to disambiguate the second one.
      slash = `new-${t.id.replace(/\./g, '-').toLowerCase()}`;
      if (seenSlash.has(slash)) continue;
    }
    seenSlash.add(slash);
    files.push({
      path: `.claude/commands/${slash}.md`,
      slash,
      source: 'template',
      content: templateCommandBody(t),
    });
  }

  return { files };
}
