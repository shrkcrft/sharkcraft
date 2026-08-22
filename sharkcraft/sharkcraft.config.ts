// Self-dogfood SharkCraft config for the engine monorepo itself.
//
// This file is intentionally written as a plain default export rather than
// using `defineSharkCraftConfig` from `@shrkcrft/config`. The repo root has
// no `@shrkcrft/*` symlinks in its `node_modules/` (the workspace deps live
// inside each `packages/<x>/node_modules/`), so an absolute workspace import
// from here would fail to resolve. The loader at
// `packages/config/src/config-loader.ts` validates this object via zod and
// only requires the shape — no helper call is needed.

export default {
  projectName: 'sharkcraft-monorepo',
  description:
    'Self-dogfood SharkCraft configuration for the engine repository itself. Describes the monorepo to its own tooling so the dashboard, doctor, and MCP have a real workspace to read.',
  knowledgeFiles: ['knowledge.ts'],
  ruleFiles: ['rules.ts'],
  pathFiles: ['paths.ts'],
  templateFiles: ['templates.ts'],
  pipelineFiles: ['pipelines.ts'],
  boundaryFiles: ['boundaries.ts'],
  docsFiles: [],
  defaultMaxTokens: 3500,
  defaultScope: ['typescript', 'monorepo', 'engine'],
  // Commands available to `shrk apply --validate --verification <id>`. Only
  // entries marked `trusted: true` run by default. These are the checks a
  // contributor would run by hand anyway — wiring them here means `apply` can
  // gate on them automatically.
  verificationCommands: [
    {
      id: 'typecheck',
      label: 'TypeScript: noEmit typecheck (base config)',
      command: 'bun x tsc -p tsconfig.base.json --noEmit',
      trusted: true,
    },
    {
      id: 'unit-tests',
      label: 'Bun test suite',
      command: 'bun test',
      trusted: true,
    },
    {
      id: 'doctor',
      label: 'shrk doctor (config + entries health)',
      command: 'bun run shrk doctor',
      trusted: true,
    },
    {
      id: 'boundaries',
      label: 'shrk check boundaries (layer order enforcement)',
      command: 'bun run shrk check boundaries',
      trusted: true,
    },
  ],
  // ---------------------------------------------------------------------------
  // Cross-file invariants as DATA. These are the planes the compiler cannot see;
  // the engine is generic, these rules are this repo's own.
  // ---------------------------------------------------------------------------

  // Completeness: an MCP tool that is exported but never added to ALL_TOOLS
  // compiles green and is simply absent from the wire.
  wiringRules: [
    {
      id: 'mcp-tool-registered',
      description:
        'Every exported `*Tool` definition must be listed in ALL_TOOLS, or the tool is invisible to every MCP client while the build stays green.',
      declared: {
        files: ['packages/mcp-server/src/tools/*.tool.ts'],
        extract: 'export-names',
        match: 'Tool$',
        // Deliberately retired exports, kept for their pruning guards. A NEW
        // omission still turns this rule red.
        exclude:
          '^(simulateWorkflowTool|listReleaseTrainsTool|getReleaseTrainTool|queryRepositoryIntelligenceTool|previewComplianceEvidencePacketTool|previewIngestAdoptionPlanTool)$',
      },
      registered: {
        files: ['packages/mcp-server/src/tools/all-tools.ts'],
        extract: 'array-members',
        anchor: 'ALL_TOOLS',
      },
      message: '{id} is exported as an MCP tool but never added to ALL_TOOLS',
      hint: 'Import it in packages/mcp-server/src/tools/all-tools.ts and add it to the ALL_TOOLS array.',
      failOnEmpty: true,
      selfTest: {
        expectMatchesAtLeast: 200,
        expectIds: ['checkBoundariesTool'],
        expectNotIds: ['simulateWorkflowTool'],
      },
    },
  ],

  // Id inventory: "is this MCP tool name taken / where is it defined?" without a
  // fragile multi-root grep.
  registries: [
    {
      name: 'mcp-tools',
      description: 'Wire-visible MCP tool names (the `name:` of each tool definition).',
      source: {
        files: ['packages/mcp-server/src/tools/*.tool.ts'],
        extract: 'regex-capture',
        pattern: "^  name: '([a-z][a-z0-9_]*)',?$",
        flags: 'm',
      },
    },
  ],

  // Content plane: `require('node:…')` inside a function body is forbidden by
  // this repo's policy — but every occurrence in the tree is prose ABOUT the
  // rule, so the rule scans the CODE zone only.
  policyRules: [
    {
      id: 'no-lazy-node-require',
      description:
        'Lazy `require("node:*")` inside a function body — forbidden; use a top-level import.',
      surface: 'ts',
      files: ['packages/*/src/**/*.ts'],
      pattern: "require\\(['\"]node:",
      scan: 'code',
      // Test files legitimately construct the forbidden shape as a fixture for
      // this very rule. Exempted, not deleted: `policy-lint explain` still
      // lists every suppressed hit and names the exemption that applied.
      exemptFiles: ['**/__tests__/**'],
      exemptLines: 'policy-allow:no-lazy-node-require',
      message: 'lazy require of a node builtin — use a top-level `import` instead',
      severity: 'error',
      failOnEmpty: true,
      selfTest: { expectMatchesAtLeast: 100 },
    },
  ],

  // Committed ledger: the MCP tool surface. Two-way, so a tool silently REMOVED
  // from the wire fails exactly like one silently added.
  baselines: [
    {
      id: 'mcp-tool-surface',
      description: 'The exact set of tools registered in ALL_TOOLS — the public MCP surface.',
      baseline: 'baselines/mcp-tools.json',
      compute: {
        kind: 'extractor',
        source: {
          files: ['packages/mcp-server/src/tools/all-tools.ts'],
          extract: 'array-members',
          anchor: 'ALL_TOOLS',
        },
      },
      direction: 'two-way',
      failOnEmpty: true,
      hint: 'If the change is intentional, bless it with `shrk baseline update --id mcp-tool-surface`.',
    },
  ],

  // Generated + committed: `docs/schemas/` is emitted by `shrk schemas emit`.
  generatedArtifacts: [
    {
      id: 'json-schemas',
      description: 'JSON Schemas emitted by `shrk schemas emit` and committed under docs/schemas/.',
      generatedGlob: ['docs/schemas/*.json', 'docs/schemas/INDEX.md'],
      regen: 'bun packages/cli/src/main.ts schemas emit --out {TMP} --write',
      compare: 'bytes',
      failOnEmpty: true,
      hint: 'Re-emit with `shrk generated update --id json-schemas` (or `shrk schemas emit --write`) and commit.',
    },
  ],

  metadata: {
    selfDogfood: true,
    audience: 'engine-contributors',
    note: 'This is the SharkCraft engine repo, not a generic consumer. Knowledge entries / docs intentionally stay empty; rules, paths, templates, pipelines, and boundaries describe the monorepo layout and the canonical engine-development flow.',
  },
// surface.profile picked by `shrk init` (override): no high-signal profile match — fell back to the default developer profile.
  surface: {
    profile: "developer",
    enabled: [],
    hidden: [],
  },
};
