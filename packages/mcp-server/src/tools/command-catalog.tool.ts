import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

// DX#4 — the previous `ALL_TOOLS_FOR_AUDIT` static list was a manual
// duplicate of `ALL_TOOLS` from `./all-tools.ts`. Every round that added
// MCP tools had to edit both lists or trip the parity test suite.
//
// The duplication was a workaround for a module-evaluation cycle that
// would form if this file imported from `./index.ts`. The cycle is
// broken now: this file lives outside `tools/index.ts` (the barrel),
// and consumers that need the list import it directly from
// `./all-tools.ts` (which uses live-binding closures, so the cycle
// through the audit-list users is resolved at handler-call time).
//
// Consumers (safety-audit.tool.ts, dashboard-summary.tool.ts,
// runtime-reports.tool.ts) now import `ALL_TOOLS` directly from
// `./all-tools.ts` and project it inline.

interface ICatalogEntry {
  command: string;
  description: string;
  category: string;
  safetyLevel: string;
  writesFiles: boolean;
  writesSource: boolean;
  runsShell: boolean;
  requiresReview: boolean;
  mcpAvailable: boolean;
  aliases: readonly string[];
  /**
   * Coarse tier classification. The MCP catalog snapshot lacks
   * the spine pipelines + project surface config available to the
   * CLI's tier resolver, so this is a static fallback:
   *   - `core` for bootstrap commands (doctor, init, recommend, etc.)
   *   - `extended` for everything else.
   * Agents querying through MCP that need the precise tier should
   * call `shrk surface list --json` via the host's shell instead.
   */
  tier?: 'core' | 'extended' | 'experimental';
}

const MCP_BOOTSTRAP_CORE: ReadonlySet<string> = new Set([
  'doctor',
  'init',
  'recommend',
  'surface',
  'commands',
  'start-here',
  'help',
  'version',
  // Spine commands the CLI resolver promotes to core. Mirrored here so
  // the MCP catalog matches the CLI's --json output for the most
  // load-bearing entries.
  'context',
  'apply',
  'gen',
  'plan review',
  'check boundaries',
]);

// Mirror of the CLI catalog. We re-state it here rather than import the CLI
// to keep the MCP server independent of the CLI build. Tests assert the
// invariant that both lists contain the same `command` keys.
export const COMMAND_CATALOG_EXPORT: readonly ICatalogEntry[] = Object.freeze([
  entry('doctor', 'Workspace doctor: config + entry validation.', 'core', 'read-only', { mcpAvailable: true }),
  entry('context', 'Focused context for a task.', 'core', 'read-only', { mcpAvailable: true }),
  entry('task', 'Full task packet for a task.', 'core', 'read-only', { mcpAvailable: true }),
  entry('inspect', 'Aggregate inspection of registries + packs.', 'core', 'read-only', { mcpAvailable: true }),
  entry('coverage', 'Coverage report across knowledge axes.', 'core', 'read-only', { mcpAvailable: true }),
  entry('drift', 'Stale-entry drift report.', 'core', 'read-only', { mcpAvailable: true }),
  entry('graph', 'Knowledge graph — nodes, edges, paths, exports.', 'core', 'read-only', { mcpAvailable: true }),
  entry('check boundaries', 'Boundary enforcement check.', 'core', 'read-only', { mcpAvailable: true }),
  entry('review', 'PR-review packet.', 'review', 'read-only', { mcpAvailable: true }),
  entry('review render-comment', 'Render PR-comment markdown (CLI-only writes).', 'review', 'writes-drafts', {
    writesFiles: true,
  }),
  entry('init', 'Create sharkcraft/ scaffold.', 'core', 'writes-source', { writesFiles: true, writesSource: true }),
  entry('gen', 'Generate from template (CLI write only).', 'core', 'writes-source', {
    writesFiles: true,
    writesSource: true,
    requiresReview: true,
  }),
  entry('apply', 'Apply a saved plan — CLI only.', 'core', 'writes-source', {
    writesFiles: true,
    writesSource: true,
    requiresReview: true,
  }),
  entry('dev start', 'Start a dev session.', 'dev', 'writes-session', { writesFiles: true }),
  entry('dev plan', 'Generate session plans.', 'dev', 'writes-session', { writesFiles: true }),
  entry('dev validate', 'Run validation in a session.', 'dev', 'runs-shell', {
    runsShell: true,
    writesFiles: true,
  }),
  entry('dev report', 'Audit-trail report.', 'dev', 'writes-session', { writesFiles: true }),
  entry('dev mark-applied', 'Metadata-only mark applied.', 'dev', 'writes-session', { writesFiles: true }),
  entry('dev mark-validated', 'Metadata-only mark validated.', 'dev', 'writes-session', { writesFiles: true }),
  entry('dev diff', 'Diff two dev sessions.', 'dev', 'read-only', {}),
  entry('dev list', 'List dev sessions.', 'dev', 'read-only', {}),
  entry('dev archive', 'Archive a session.', 'dev', 'writes-session', { writesFiles: true }),
  entry('dev clean', 'Clean old sessions (dry-run by default).', 'dev', 'writes-session', {
    writesFiles: true,
    requiresReview: true,
  }),
  entry('onboard', 'Onboard an existing repo.', 'onboarding', 'read-only', { mcpAvailable: true }),
  entry('onboard --write-drafts', 'Write onboarding drafts.', 'onboarding', 'writes-drafts', {
    writesFiles: true,
    requiresReview: true,
  }),
  entry('onboard adopt', 'Adoption classification.', 'onboarding', 'read-only', { mcpAvailable: true }),
  entry('onboard adopt --write-patch', 'Write adoption pseudo-patch.', 'onboarding', 'writes-drafts', {
    writesFiles: true,
    requiresReview: true,
  }),
  entry('packs list', 'List packs.', 'packs', 'read-only', { mcpAvailable: true }),
  entry('packs doctor', 'Validate pack discovery.', 'packs', 'read-only', { mcpAvailable: true }),
  entry('packs sign', 'Sign pack manifest.', 'packs', 'writes-source', {
    writesFiles: true,
    requiresReview: true,
  }),
  entry('packs verify', 'Verify pack signatures.', 'packs', 'read-only', {}),
  entry('packs new', 'Scaffold a new pack (CLI dry-run by default).', 'packs', 'writes-source', {
    writesFiles: true,
    requiresReview: true,
  }),
  entry('packs test', 'Validate a pack at the given path.', 'packs', 'read-only', {}),
  entry('quality', 'Quality gate orchestrator.', 'gates', 'runs-shell', {}),
  entry('ci scaffold github-actions', 'Scaffold GitHub Actions workflow.', 'gates', 'writes-source', {
    writesFiles: true,
  }),
  entry('boundaries list', 'List boundary rules.', 'boundaries', 'read-only', { mcpAvailable: true }),
  entry('boundaries infer', 'Infer boundary candidates.', 'boundaries', 'read-only', {}),
  entry('boundaries explain', 'Explain a boundary rule.', 'boundaries', 'read-only', { mcpAvailable: true }),
  entry('test context', 'Run context retrieval tests.', 'tests', 'read-only', { mcpAvailable: true }),
  entry('test agent', 'Run agent contract tests.', 'tests', 'read-only', { mcpAvailable: true }),
  entry('test generate context', 'Generate a context-test draft.', 'tests', 'writes-drafts', {
    writesFiles: true,
  }),
  entry('test generate agent', 'Generate an agent-test draft.', 'tests', 'writes-drafts', {
    writesFiles: true,
  }),
  entry('commands', 'List all CLI commands with safety labels.', 'meta', 'read-only', { mcpAvailable: true }),
  entry('mcp', 'Start the read-only MCP server.', 'meta', 'read-only', {}),
  entry('version', 'Print CLI version.', 'meta', 'read-only', {}),
]);

function entry(
  command: string,
  description: string,
  category: string,
  safetyLevel: string,
  opts: {
    writesFiles?: boolean;
    writesSource?: boolean;
    runsShell?: boolean;
    requiresReview?: boolean;
    mcpAvailable?: boolean;
    aliases?: readonly string[];
  },
): ICatalogEntry {
  return {
    command,
    description,
    category,
    safetyLevel,
    writesFiles: opts.writesFiles ?? false,
    writesSource: opts.writesSource ?? false,
    runsShell: opts.runsShell ?? false,
    requiresReview: opts.requiresReview ?? false,
    mcpAvailable: opts.mcpAvailable ?? false,
    aliases: opts.aliases ?? [],
    tier: MCP_BOOTSTRAP_CORE.has(command) ? 'core' : 'extended',
  };
}

export const getCommandCatalogTool: IToolDefinition = {
  name: 'get_command_catalog',
  description:
    'List every `shrk` command with its safety level, side effects, and MCP availability. Read-only. Useful when an agent needs to choose a CLI command for the user without scanning the source tree.',
  inputSchema: {
    type: 'object',
    properties: {
      safetyLevel: { type: 'string', description: 'Filter by safety level (read-only, writes-session, writes-drafts, writes-source, runs-shell, requires-review).' },
      category: { type: 'string', description: 'Filter by category.' },
      ...FORMAT_INPUT_PROPERTY,
    },
    additionalProperties: false,
  },
  async handler(input) {
    const safety = (input as { safetyLevel?: unknown }).safetyLevel;
    const category = (input as { category?: unknown }).category;
    let entries: readonly ICatalogEntry[] = COMMAND_CATALOG_EXPORT;
    if (typeof safety === 'string') entries = entries.filter((e) => e.safetyLevel === safety);
    if (typeof category === 'string') entries = entries.filter((e) => e.category === category);
    const data = {
      entries,
      totals: {
        total: COMMAND_CATALOG_EXPORT.length,
        returned: entries.length,
      },
    };
    // `format:"table"` columnar-encodes the homogeneous `entries` array
    // (the ~11-field catalog rows); the `totals` scalar object is left
    // untouched. Default/`format:"json"` returns the object unchanged.
    return { data: formatObjectArrays(data, input) };
  },
};
