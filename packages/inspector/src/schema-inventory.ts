/**
 * Schema version inventory.
 *
 * SharkCraft ships ~200 internal `sharkcraft.<id>/v<N>` envelope schemas
 * plus ~36 hand-written JSON schemas under `shrk schemas list`. Several
 * envelope schemas have been versioned over time (e.g.
 * `self-config-doctor/v1` → v2). The inventory is a small, curated,
 * read-only surface that:
 *
 *   - lists every schema id known to the engine,
 *   - lists every version that has ever shipped,
 *   - names the current default version,
 *   - flags `deprecated` / `backcompat-only` versions,
 *   - gives a one-line "what this schema describes" hint.
 *
 * Purpose: an agent can answer "is there a newer version of this
 * schema?" in one command instead of grepping.
 *
 * The inventory is curated — adding a new schema or bumping a version
 * means updating this file. Tests assert the inventory stays in sync
 * with the engine.
 */

export const SCHEMA_INVENTORY_SCHEMA = 'sharkcraft.schema-inventory/v1';

export enum SchemaStatus {
  Current = 'current',
  Deprecated = 'deprecated',
  Backcompat = 'backcompat-only',
}

export interface ISchemaVersion {
  readonly version: string;
  readonly status: SchemaStatus;
  /** Optional note: when v1 is kept around for downstream consumers. */
  readonly note?: string;
}

export interface ISchemaInventoryEntry {
  readonly id: string;
  readonly versions: ReadonlyArray<ISchemaVersion>;
  readonly currentVersion: string;
  readonly summary: string;
  /** CLI command that emits this schema (best-effort). */
  readonly emittedBy?: string;
  /** Documentation file in `docs/`, if any. */
  readonly docs?: string;
}

export interface ISchemaInventoryReport {
  readonly schema: typeof SCHEMA_INVENTORY_SCHEMA;
  readonly entries: ReadonlyArray<ISchemaInventoryEntry>;
  readonly multiVersionIds: ReadonlyArray<string>;
}

const SCHEMA_ENTRIES: ReadonlyArray<ISchemaInventoryEntry> = [
  {
    id: 'sharkcraft.self-config-doctor',
    versions: [
      { version: 'v1', status: SchemaStatus.Backcompat, note: 'kept for downstream consumers; opt out via --schema v1' },
      { version: 'v2', status: SchemaStatus.Current, note: 'rich finding shape with sourceKind/targetKind/relation' },
    ],
    currentVersion: 'v2',
    summary: 'Cross-reference doctor over the sharkcraft/ registries (knowledge, search-tuning, agent-tests, routing, packs).',
    emittedBy: 'shrk self-config doctor',
  },
  {
    id: 'sharkcraft.architecture-map',
    versions: [
      { version: 'v2', status: SchemaStatus.Current, note: 'layers + public API + boundary rules' },
    ],
    currentVersion: 'v2',
    summary: 'Layered architecture map with public API and boundary-rule wiring.',
    emittedBy: 'shrk architecture map',
  },
  {
    id: 'sharkcraft.impact-analysis',
    versions: [
      { version: 'v2', status: SchemaStatus.Current, note: 'symbol-aware impact analysis' },
    ],
    currentVersion: 'v2',
    summary: 'Architecture impact analysis for a task / file / plan / bundle.',
    emittedBy: 'shrk impact',
  },
  {
    id: 'sharkcraft.plan',
    versions: [
      { version: 'v1', status: SchemaStatus.Backcompat, note: 'simple saved plan (templateId + variables)' },
      { version: 'v2', status: SchemaStatus.Current, note: 'plan-v2 with explicit operation kinds (file/folder/...)' },
    ],
    currentVersion: 'v2',
    summary: 'Generator saved plan (the only artifact `shrk apply` consumes).',
    emittedBy: 'shrk gen --save-plan',
    docs: 'docs/security.md',
  },
  {
    id: 'sharkcraft.universal-search',
    versions: [
      { version: 'v2', status: SchemaStatus.Current, note: 'ranked search across all registries' },
    ],
    currentVersion: 'v2',
    summary: 'Cross-registry search results (knowledge, rules, templates, playbooks, ...).',
    emittedBy: 'shrk search',
  },
  {
    id: 'sharkcraft.inferred-template-candidate',
    versions: [
      { version: 'v2', status: SchemaStatus.Current },
    ],
    currentVersion: 'v2',
    summary: 'Inferred template draft candidate emitted by onboarding.',
    emittedBy: 'shrk onboard',
  },
  {
    id: 'sharkcraft.feedback-actions',
    versions: [
      { version: 'v2', status: SchemaStatus.Current, note: 'typed action shapes' },
    ],
    currentVersion: 'v2',
    summary: 'Feedback ingestion → typed actions (convert-to-backlog / suppress / ...).',
    emittedBy: 'shrk feedback actions',
  },
  {
    id: 'sharkcraft.pack-manifest',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Pack manifest envelope (signed). Consumed by `shrk packs *`.',
    emittedBy: 'shrk packs build',
    docs: 'docs/security.md',
  },
  {
    id: 'sharkcraft.agent-contract',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Agent contract — declares risk, files, gates an agent commits to.',
    emittedBy: 'shrk contract',
  },
  {
    id: 'sharkcraft.changes-summary',
    versions: [
      { version: 'v1', status: SchemaStatus.Current, note: 'grouped diff + risk verdict' },
    ],
    currentVersion: 'v1',
    summary: 'Grouped diff summary with risk verdict + suggested validation commands.',
    emittedBy: 'shrk changes summary',
  },
  {
    id: 'sharkcraft.acceptance-replay',
    versions: [
      { version: 'v1', status: SchemaStatus.Current, note: 'picks previous validation commands to re-run' },
    ],
    currentVersion: 'v1',
    summary: 'Acceptance-command replay: which validation commands should re-run given a change set.',
    emittedBy: 'shrk changes acceptance-replay',
  },
  {
    id: 'sharkcraft.area-explore',
    versions: [
      { version: 'v1', status: SchemaStatus.Current, note: 'workspace-aware explain-this-directory' },
    ],
    currentVersion: 'v1',
    summary: 'Workspace-aware explanation for one directory (modules / tests / commands / risks).',
    emittedBy: 'shrk explore <path>',
  },
  {
    id: 'sharkcraft.entrypoint-matrix',
    versions: [
      { version: 'v1', status: SchemaStatus.Current, note: 'entrypoint classification' },
    ],
    currentVersion: 'v1',
    summary: 'Curated entrypoint classification (human-interactive / agent-mcp / machine-json / debug).',
    emittedBy: 'shrk commands entrypoints',
  },
  {
    id: 'sharkcraft.command-taxonomy',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Curated grouping of every shrk command into start-here / daily / ... buckets.',
    emittedBy: 'shrk commands taxonomy',
  },
  {
    id: 'sharkcraft.changed-boundary-report',
    versions: [
      { version: 'v1', status: SchemaStatus.Current, note: 'changed-only boundary report' },
    ],
    currentVersion: 'v1',
    summary: 'Boundary violations filtered to the changed file set.',
    emittedBy: 'shrk check boundaries --changed-only',
  },
  {
    id: 'sharkcraft.changed-preflight',
    versions: [
      { version: 'v1', status: SchemaStatus.Current, note: 'changed-only preflight orchestrator' },
    ],
    currentVersion: 'v1',
    summary: 'Read-only preflight gate plan derived from the changed-file set.',
    emittedBy: 'shrk preflight',
  },
  {
    id: 'sharkcraft.safety-audit',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Safety audit envelope — MCP read-only enforcement, signing, write paths.',
    emittedBy: 'shrk safety audit',
    docs: 'docs/security.md',
  },
  {
    id: 'sharkcraft.compliance',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Compliance profile + check envelope.',
    emittedBy: 'shrk compliance check',
  },
  {
    id: 'sharkcraft.review-packet',
    versions: [
      { version: 'v1', status: SchemaStatus.Backcompat, note: 'compat with the legacy review pipeline' },
      { version: 'v2', status: SchemaStatus.Current, note: 'review packet v2 — risk + missing tests + intent' },
    ],
    currentVersion: 'v2',
    summary: 'PR review packet — changed files, affected rules, missing tests, risk.',
    emittedBy: 'shrk review packet',
  },
  {
    id: 'sharkcraft.adoption-state',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Adoption-plan state envelope.',
    emittedBy: 'shrk onboard adopt status',
  },
  {
    id: 'sharkcraft.dev-cycle',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Dev-cycle gate plan (sequence of read-only validation gates).',
    emittedBy: 'shrk dev cycle --explain',
  },
  {
    id: 'sharkcraft.apply-dispatch-trace',
    versions: [
      { version: 'v1', status: SchemaStatus.Current, note: 'dispatch trace' },
    ],
    currentVersion: 'v1',
    summary: 'Apply-dispatch trace — which dispatch path apply would take.',
    emittedBy: 'shrk apply --explain-dispatch',
  },
  {
    id: 'sharkcraft.doctor-suppressions',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Doctor suppressions / acknowledgements registry.',
    emittedBy: 'shrk doctor acknowledge',
  },
  {
    id: 'sharkcraft.dev-session',
    versions: [
      { version: 'v1', status: SchemaStatus.Current },
    ],
    currentVersion: 'v1',
    summary: 'Dev session state under .sharkcraft/sessions/.',
    emittedBy: 'shrk dev start',
  },
];

export function buildSchemaInventory(): ISchemaInventoryReport {
  const sorted = [...SCHEMA_ENTRIES].sort((a, b) => a.id.localeCompare(b.id));
  const multiVersionIds = sorted.filter((e) => e.versions.length > 1).map((e) => e.id);
  return {
    schema: SCHEMA_INVENTORY_SCHEMA,
    entries: sorted,
    multiVersionIds,
  };
}

export function renderSchemaInventoryText(report: ISchemaInventoryReport): string {
  const lines: string[] = [];
  lines.push(`=== Schema inventory (${report.entries.length} ids, ${report.multiVersionIds.length} multi-version) ===`);
  for (const e of report.entries) {
    const versionsText = e.versions
      .map((v) => `${v.version}${v.status === SchemaStatus.Current ? '*' : v.status === SchemaStatus.Backcompat ? '(compat)' : '(deprecated)'}`)
      .join(' ');
    lines.push(`  ${e.id.padEnd(46)} ${versionsText.padEnd(22)} — ${e.summary}`);
    if (e.emittedBy) lines.push(`     emitted by: ${e.emittedBy}`);
    if (e.docs) lines.push(`     docs:       ${e.docs}`);
    for (const v of e.versions) {
      if (v.note) lines.push(`     ${v.version}: ${v.note}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function renderSchemaInventoryMarkdown(report: ISchemaInventoryReport): string {
  const lines: string[] = [];
  lines.push('# SharkCraft schema inventory');
  lines.push('');
  lines.push(`${report.entries.length} schemas tracked; ${report.multiVersionIds.length} have multiple versions.`);
  lines.push('');
  lines.push('| Schema id | Current | All versions | Emitted by | Summary |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const e of report.entries) {
    const versions = e.versions
      .map((v) => `${v.version} (${v.status})`)
      .join('<br/>');
    lines.push(
      `| \`${e.id}\` | ${e.currentVersion} | ${versions} | ${e.emittedBy ? `\`${e.emittedBy}\`` : '—'} | ${e.summary} |`,
    );
  }
  return lines.join('\n') + '\n';
}

/** Lookup: returns the entry for one schema id, or null. */
export function findSchemaInventoryEntry(id: string): ISchemaInventoryEntry | null {
  return SCHEMA_ENTRIES.find((e) => e.id === id) ?? null;
}
