// High-level repository rules for the SharkCraft engine monorepo.
//
// Plain default-exported array (no `@shrkcrft/rules` import — see
// sharkcraft.config.ts for the reason). The loader at
// `packages/knowledge/src/load/typescript-knowledge-loader.ts` accepts any
// object whose `id`, `title`, and `content` are strings, and uses `type:
// 'rule'` to classify the entry.
//
// `actionHints` are not decoration: shrk's context builder renders them as
// "preferred flow" guidance, and `shrk coverage` / `shrk doctor` use them to
// score AI-readiness. Each hint here is something an engine contributor
// would actually do — not filler.

export default [
  {
    id: 'repo.scope.no-unrelated-changes',
    title: 'Keep diffs scoped to the requested change',
    type: 'rule',
    priority: 'critical',
    scope: ['monorepo', 'engine'],
    tags: ['safety', 'scope'],
    appliesWhen: ['generate-code', 'review-code', 'agent-action'],
    summary: 'Do not edit files outside the task description.',
    content: `When fulfilling a task, only modify files whose change is required
by the request. Do not rename, reformat, or "tidy up" unrelated files in the
same diff — those changes belong in their own PR. Auto-formatters that touch
files outside the task scope must be skipped or scoped down. This rule exists
because the repo ships a deterministic CLI and MCP surface; unrelated edits
make plan/apply diffs hard to review and easy to revert.`,
    actionHints: {
      commands: [
        { command: 'git status --short', purpose: 'Confirm the diff scope before staging.', when: 'before' },
        { command: 'git diff --stat', purpose: 'Sanity-check file count + lines touched.', when: 'before' },
      ],
      verificationCommands: ['git status --short', 'git diff --stat'],
      forbiddenActions: [
        'Running repo-wide formatters or linters that touch files outside the task scope.',
        'Renaming, moving, or deleting files that the task did not explicitly request.',
        'Bundling unrelated cleanups into the same commit/PR.',
      ],
      safetyNotes: [
        'If you find a defect outside the task scope, open a separate issue / PR — do not silently expand the current diff.',
      ],
      writePolicy: 'cli-only',
    },
  },
  {
    id: 'repo.architecture.respect-layer-order',
    title: 'Respect the package layer order',
    type: 'rule',
    priority: 'critical',
    scope: ['monorepo', 'architecture'],
    tags: ['architecture', 'boundaries'],
    appliesWhen: ['generate-code', 'create-feature', 'review-code'],
    summary:
      'Lower layers (core → workspace → config → …) must not import from higher layers (cli, mcp-server, dashboard).',
    content: `Imports flow strictly from lower to higher layers, never the
reverse. The order is:

  core → workspace → config → knowledge → rules/paths/templates/pipelines/
  presets/boundaries → packs → generator → importer → inspector →
  mcp-server → cli, with dashboard-api ← dashboard at the edge.

Cross-package imports must use the absolute \`@shrkcrft/<pkg>\` name; no
relative paths across package boundaries. \`shared/\` and \`ai/\` may only
depend on \`core\` and a few stable peers. Run \`bun run check:circular-deps\`
whenever a change spans packages, and \`shrk check boundaries\` to enforce.`,
    actionHints: {
      commands: [
        {
          command: 'bun run shrk check boundaries',
          purpose: 'Mechanical enforcement of the layer order — runs the rules in sharkcraft/boundaries.ts.',
          when: 'after',
          required: true,
        },
        {
          command: 'bun run check:circular-deps',
          purpose: 'Cross-package cycle detector. Should stay green at all times.',
          when: 'after',
          required: true,
        },
      ],
      mcpTools: [
        { tool: 'check_boundaries', purpose: 'Same check, exposed to agents — read-only.' },
        { tool: 'get_import_graph_analysis', purpose: 'Inspect concrete import edges before adding a new cross-package import.' },
      ],
      verificationCommands: ['bun run shrk check boundaries', 'bun run check:circular-deps'],
      forbiddenActions: [
        'Using a relative import (`../packages/X` or `../../core`) across package boundaries.',
        'Importing a higher-layer package from a lower-layer one (e.g. `@shrkcrft/cli` from anywhere outside `packages/cli/`).',
        'Adding a new cross-package import without first checking the resulting layer position.',
      ],
      relatedPathConventions: ['engine.packages'],
      // R38: declare cli-only write policy explicitly so the action-hint
      // diagnostics doctor stops flagging this entry as missing one. The
      // remediation for a layer violation is always a CLI-driven edit; no
      // MCP path mutates source.
      writePolicy: 'cli-only',
    },
  },
  {
    id: 'repo.discovery.read-examples-first',
    title: 'Read examples/* and sibling code before scaffolding new structure',
    type: 'rule',
    priority: 'high',
    scope: ['monorepo', 'engine'],
    tags: ['conventions', 'discovery'],
    appliesWhen: ['create-feature', 'generate-code', 'agent-plan'],
    summary:
      'Mirror an existing sibling (CLI command, MCP tool, example consumer) rather than inventing new layout.',
    content: `Before adding a new CLI command, MCP tool, preset, template, or
package, find the closest existing sibling and copy its shape. For consumer-
style setups, \`examples/dogfood-target/sharkcraft/\` is the canonical
reference. For engine internals, the nearest neighbour in the same package
directory is the reference. Inventing a new file layout when one already
exists creates drift that the engine itself has to reason about — avoid it.`,
    actionHints: {
      mcpTools: [
        { tool: 'inspect_workspace', purpose: 'Confirm framework + workspace shape before suggesting a path.' },
        { tool: 'get_relevant_context', purpose: 'Token-budgeted rules + paths + templates for the task.', required: true },
        { tool: 'list_templates', purpose: 'Reuse an existing template before hand-writing.' },
        { tool: 'get_repo_area_map', purpose: 'See which area of the monorepo owns the closest sibling.' },
      ],
      relatedPathConventions: ['engine.packages', 'engine.examples'],
      relatedTemplates: ['engine.cli-command', 'engine.mcp-tool'],
      forbiddenActions: [
        'Adding a new CLI command without first reading the closest sibling in `packages/cli/src/commands/`.',
        'Adding a new MCP tool without first reading the closest sibling in `packages/mcp-server/src/tools/`.',
        'Introducing a new registration pattern when one already exists for the construct.',
      ],
      safetyNotes: [
        'When a sibling exists, name + register the new construct the same way. Do not introduce a new registration pattern.',
      ],
      // R38: this rule guides discovery — the follow-up edit is always via the
      // CLI. Declaring `writePolicy: 'cli-only'` and the relevant verification
      // commands clears the doctor's action-hint quality warning without
      // weakening the rule itself.
      writePolicy: 'cli-only',
      verificationCommands: [
        'shrk inspect workspace',
        'shrk start-here',
      ],
    },
  },
  {
    id: 'repo.generation.dry-run-by-default',
    title: 'shrk gen is dry-run by default; apply requires a clean plan',
    type: 'rule',
    priority: 'critical',
    scope: ['generation', 'safety'],
    tags: ['safety', 'generator'],
    appliesWhen: ['generate-code', 'agent-action'],
    summary:
      'Use --dry-run, save the plan, review it, only then apply with --verify-signature.',
    content: `Generation flow is: \`shrk gen <id> <name> --dry-run --save-plan
/tmp/plan.json\` → \`shrk plan review\` → \`shrk apply --verify-signature\`.
Never write files directly when a template exists; never bypass
\`--verify-signature\` for signed plans; never run \`apply\` on a plan with
divergence unless \`--allow-divergent\` is passed deliberately. MCP must never
perform the write step — agents return a next-command hint and let the human
or CLI execute it.`,
    actionHints: {
      commands: [
        {
          command: 'bun run shrk gen <templateId> <name> --dry-run --save-plan /tmp/plan.json',
          purpose: 'Produce a signed, reviewable plan. No files written yet.',
          when: 'during',
          required: true,
        },
        {
          command: 'bun run shrk plan review /tmp/plan.json',
          purpose: 'Surface conflicts, divergence, and boundary impact before apply.',
          when: 'during',
          required: true,
        },
        {
          command: 'bun run shrk apply /tmp/plan.json --verify-signature --validate --verification typecheck --verification unit-tests',
          purpose: 'Apply with signature verification AND gated on tsc + bun test.',
          when: 'after',
          required: true,
        },
      ],
      mcpTools: [
        { tool: 'create_generation_plan', purpose: 'MCP-side equivalent of `shrk gen --dry-run`.', required: true },
      ],
      preferredFlow: [
        'list_templates',
        'get_template',
        'create_generation_plan',
        'shrk plan review',
        'shrk apply --verify-signature --validate',
      ],
      forbiddenActions: [
        'Writing files directly (with Write/Edit) when a template exists for the construct.',
        'Bypassing `--verify-signature` on a signed plan.',
        'Running `shrk apply` on a divergent plan without explicitly passing `--allow-divergent`.',
      ],
      verificationCommands: ['bun x tsc -p tsconfig.base.json --noEmit', 'bun test'],
      requiresHumanReview: true,
      writePolicy: 'cli-only',
      relatedKnowledge: ['repo.safety.mcp-is-read-only'],
    },
  },
  {
    id: 'repo.safety.mcp-is-read-only',
    title: 'MCP and the dashboard are read-only — never add write paths',
    type: 'rule',
    priority: 'critical',
    scope: ['safety'],
    tags: ['safety', 'mcp', 'dashboard'],
    appliesWhen: ['create-feature', 'review-code', 'agent-action'],
    summary:
      'New MCP tools return data + a next-command hint. New dashboard routes are GET/HEAD only.',
    content: `The CLI (\`shrk\`) is the only write path in this system. MCP
tools must not write to disk, mutate state, or call external services that
do. The dashboard server returns 405 for any non-GET/HEAD method;
\`/api/health.readOnly\` is true and \`/api/capabilities.writeEndpoints\` is
the empty array. These contracts are exercised by
\`e2e/20-read-only-safety.e2e.ts\`. Do not add features that break them, and
do not silence the test if it fails — fix the feature.`,
    actionHints: {
      commands: [
        {
          command: 'bun run test:e2e:dashboard',
          purpose: 'Run the Playwright suite that includes the read-only contract test.',
          when: 'after',
          required: true,
        },
      ],
      forbiddenActions: [
        'Adding a tool handler that calls writeFile, mkdir, rm, or any node:fs write API.',
        'Returning a side-effect (e.g. spawned shell write) from an MCP tool.',
        'Adding a POST/PUT/PATCH/DELETE handler to the dashboard server.',
        'Silencing or skipping `e2e/20-read-only-safety.e2e.ts` to land a change.',
      ],
      writePolicy: 'none',
      verificationCommands: ['bun run test:e2e:dashboard'],
      safetyNotes: [
        'When an MCP tool needs to surface a write, return the next CLI command as a string in its output — never run it.',
      ],
      relatedKnowledge: ['repo.generation.dry-run-by-default'],
    },
  },
  {
    id: 'repo.testing.bun-only',
    title: 'Tests run with `bun test` — no Jest, no Vitest',
    type: 'rule',
    priority: 'high',
    scope: ['testing'],
    tags: ['testing', 'tooling'],
    appliesWhen: ['generate-test', 'create-feature', 'review-code'],
    summary:
      'Use `bun:test` everywhere. Playwright is the only exception, for the E2E suite under `e2e/`.',
    content: `All unit + integration tests in this repo use the built-in Bun
test runner. Test files end in \`.test.ts\` and live in
\`packages/<pkg>/src/__tests__/\`. The full suite runs in seconds with
\`bun test\`. Do NOT add Jest, Vitest, Mocha, or Chai — they are not
configured and will not run in CI. The single exception is Playwright for
end-to-end UI testing, under \`e2e/*.e2e.ts\`, which is opt-in via
\`bun run test:e2e:dashboard\`.`,
    actionHints: {
      commands: [
        { command: 'bun test', purpose: 'Full suite. Cheap on Bun — run it before claiming done.', when: 'after', required: true },
        { command: 'bun test <path/to/file.test.ts>', purpose: 'Focused run while iterating.', when: 'during' },
      ],
      forbiddenActions: [
        'Adding `jest`, `vitest`, `mocha`, `chai`, `ts-jest`, or any equivalent to package.json.',
        'Using `describe`/`it` from anywhere other than `bun:test` (or `@playwright/test` under e2e/).',
        'Marking tests `.skip` to land a change — fix the test or the code.',
      ],
      verificationCommands: ['bun test'],
      // R38: test creation lands via the CLI; declaring `cli-only` clears the
      // action-hint diagnostics warning without weakening the rule. (`bun test`
      // is a developer command, not a runtime write path.)
      writePolicy: 'cli-only',
    },
  },
  {
    id: 'repo.imports.no-lazy-node-builtin-require',
    title: 'No lazy `require(\'node:*\')` — use top-level imports',
    type: 'rule',
    priority: 'critical',
    scope: ['monorepo', 'engine'],
    tags: ['imports', 'hygiene', 'static-analysis'],
    appliesWhen: ['generate-code', 'create-feature', 'review-code'],
    summary:
      'Never write `const { ... } = require(\'node:fs\') as typeof import(\'node:fs\');` inside function bodies. Node built-ins gain nothing from lazy require and the cast is a hack to satisfy strict TS where a normal top-level `import` would have typed the call for free.',
    content: `R37 makes this a hard rule. The pattern

    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');

inside a function body is forbidden for these reasons:

1. **Node built-ins are already in memory.** \`node:fs\`, \`node:path\`,
   \`node:os\`, \`node:crypto\`, \`node:child_process\`, \`node:url\` are
   resolved before any user code runs. There is no startup cost to amortize.
2. **The cast hides the dependency from static analysis.** Tooling that
   walks the import graph (boundaries, drift, the import-hygiene checker)
   sees nothing.
3. **The cast itself is a smell.** \`require()\` returns \`any\`, so the
   only way to get types back is to retype the call. A top-level
   \`import { ... } from 'node:fs';\` types the call for free.
4. **Refactor-resistant in the wrong way.** Renaming the imported symbol
   silently breaks the cold path only at runtime, in code paths nobody
   tests.

The same logic applies to cross-module \`require('./x.ts')\` —
\`import { ... } from './x.ts';\` is correct. If a real cycle exists,
extract the shared types into a neutral lower-level module; do NOT hide
the cycle behind a runtime require.

The single legitimate exception is the import-hygiene allowlist (with a
required \`reason\` field), reserved for cases where dynamic loading is
actually intentional — e.g. CLI startup boundaries that defer loading a
heavy subcommand module.`,
    actionHints: {
      commands: [
        { command: 'shrk check imports', purpose: 'Scan for forbidden lazy require / inline import patterns.', when: 'after', required: true },
        { command: 'shrk check imports --json', purpose: 'Machine-readable form, used by preflight.', when: 'after' },
      ],
      verificationCommands: ['shrk check imports'],
      forbiddenActions: [
        'Writing `require(\'node:fs\')` (or any `node:*` builtin) inside a function body.',
        'Using `as typeof import(\'node:*\')` casts on a `require()` result.',
        'Adding `require(\'./x.ts\')` to dodge a perceived cycle. Extract the shared types instead.',
        'Adding an allowlist entry without a sentence-long `reason` justifying the lazy load.',
      ],
      safetyNotes: [
        'If `shrk check imports` reports an error in a file you are editing, fix it before landing — the checker is wired into `release:preflight`.',
      ],
      writePolicy: 'cli-only',
    },
  },
];
