/**
 * R29 PART 13 — SharkCraft self scaffold patterns.
 *
 * Each pattern describes how to scaffold one engine construct: CLI
 * command, MCP tool, inspector module, JSON schema, docs page, policy,
 * decision record. Loaded automatically when `sharkcraft/scaffold-patterns.ts`
 * is present.
 */

interface ILocalScaffoldPattern {
  id: string;
  title?: string;
  description?: string;
  appliesWhen: readonly string[];
  matchPaths: readonly string[];
  templateId: string;
  confidence: 'high' | 'medium' | 'low';
  strategy?: 'mirror-sibling' | 'fresh-create' | 'append-only';
  notes?: readonly string[];
}

function defineScaffoldPattern(p: ILocalScaffoldPattern): ILocalScaffoldPattern {
  return p;
}

export default [
  defineScaffoldPattern({
    id: 'sharkcraft.cli-command',
    title: 'shrk CLI command',
    description:
      'Add a new top-level or sub-grouped CLI command. Mirror the nearest sibling under packages/cli/src/commands/.',
    appliesWhen: ['adding-a-cli-command'],
    matchPaths: ['packages/cli/src/commands/*.command.ts'],
    templateId: 'engine.cli-command',
    confidence: 'high',
    strategy: 'mirror-sibling',
    notes: [
      'Register the new handler in packages/cli/src/main.ts.',
      'Add an entry to packages/cli/src/commands/command-catalog.ts with the right safety level.',
    ],
  }),
  defineScaffoldPattern({
    id: 'sharkcraft.mcp-tool',
    title: 'MCP tool (read-only)',
    description:
      'Add a new MCP tool. Must remain read-only — no writeFile, mkdir, rm, spawn-write side effects.',
    appliesWhen: ['adding-an-mcp-tool'],
    matchPaths: ['packages/mcp-server/src/tools/*.tool.ts'],
    templateId: 'engine.mcp-tool',
    confidence: 'high',
    strategy: 'mirror-sibling',
    notes: [
      'Add the tool to ALL_TOOLS in packages/mcp-server/src/tools/index.ts.',
      'Add a row to ALL_TOOLS_FOR_AUDIT in command-catalog.tool.ts.',
      'Tool body MUST return a next-CLI-command hint — never invoke writes.',
    ],
  }),
  defineScaffoldPattern({
    id: 'sharkcraft.inspector-module',
    title: 'Inspector module',
    description:
      'Add a new inspector module under packages/inspector/src/. Export from index.ts.',
    appliesWhen: ['adding-an-inspector-module'],
    matchPaths: ['packages/inspector/src/*.ts'],
    templateId: 'engine.cli-command',
    confidence: 'medium',
    strategy: 'fresh-create',
    notes: [
      'Export the module from packages/inspector/src/index.ts.',
      'If the module exposes a JSON shape, register the schema in packages/cli/src/schemas/json-schemas.ts.',
      'Add a test file under packages/inspector/src/__tests__/.',
    ],
  }),
  defineScaffoldPattern({
    id: 'sharkcraft.command-catalog-entry',
    title: 'command catalog entry',
    description:
      'Add a row to packages/cli/src/commands/command-catalog.ts describing a new shrk command.',
    appliesWhen: ['adding-a-cli-command'],
    matchPaths: ['packages/cli/src/commands/command-catalog.ts'],
    templateId: 'engine.cli-command',
    confidence: 'high',
    strategy: 'append-only',
  }),
  defineScaffoldPattern({
    id: 'sharkcraft.json-schema',
    title: 'JSON schema export',
    description:
      'Add a new schema definition to packages/cli/src/schemas/json-schemas.ts when an inspector module exposes a public data shape.',
    appliesWhen: ['adding-a-schema'],
    matchPaths: ['packages/cli/src/schemas/json-schemas.ts'],
    templateId: 'engine.cli-command',
    confidence: 'medium',
    strategy: 'append-only',
  }),
  defineScaffoldPattern({
    id: 'sharkcraft.docs-page',
    title: 'docs page',
    description: 'Add or update a docs page under docs/<topic>.md. Cross-link from docs/overview.md.',
    appliesWhen: ['adding-docs'],
    matchPaths: ['docs/*.md'],
    templateId: 'engine.cli-command',
    confidence: 'high',
    strategy: 'fresh-create',
    notes: [
      'Update CHANGELOG.md.',
      'If the change is safety-related, update docs/safety-model.md.',
    ],
  }),
  defineScaffoldPattern({
    id: 'sharkcraft.policy',
    title: 'policy check',
    description:
      'Add a policy check to sharkcraft/policies.ts. Pure function — no shell, no network.',
    appliesWhen: ['adding-a-policy'],
    matchPaths: ['sharkcraft/policies.ts'],
    templateId: 'engine.cli-command',
    confidence: 'medium',
    strategy: 'append-only',
    notes: [
      'If the policy is safety-related, mention it in docs/safety-model.md.',
    ],
  }),
  defineScaffoldPattern({
    id: 'sharkcraft.decision',
    title: 'decision record',
    description:
      'Add an ADR under sharkcraft/decisions/<id>.md. Status proposed → accepted after review.',
    appliesWhen: ['adding-a-decision'],
    matchPaths: ['sharkcraft/decisions/*.md', 'docs/adr/*.md'],
    templateId: 'engine.cli-command',
    confidence: 'high',
    strategy: 'fresh-create',
    notes: [
      'Use `shrk decisions new <id> --write-draft` for the bootstrap skeleton.',
    ],
  }),
];
