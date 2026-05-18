/**
 * Asset provenance CLI surface.
 *
 *   - `shrk provenance list [--kind <k>] [--id <id>] [--limit N]`
 *   - `shrk provenance show <assetId> [--kind <k>]`
 *   - `shrk provenance report`
 *
 * Read-only — the ledger is written by the authoring commands. CLI never
 * accepts arbitrary write requests.
 */

import {
  buildProvenanceReport,
  inspectSharkcraft,
  listProvenance,
  readProvenance,
  renderProvenanceMarkdown,
  showProvenance,
  type AssetKind,
  type AssetProvenanceOperation,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const provenanceListCommand: ICommandHandler = {
  name: 'list',
  description: 'List provenance ledger entries (most-recent first).',
  usage:
    'shrk provenance list [--kind <assetKind>] [--id <assetId>] [--operation <op>] [--limit N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const entries = listProvenance(cwd, {
      ...(flagString(args, 'kind') ? { assetKind: flagString(args, 'kind') as AssetKind } : {}),
      ...(flagString(args, 'id') ? { assetId: flagString(args, 'id') ?? undefined } : {}),
      ...(flagString(args, 'operation')
        ? { operation: flagString(args, 'operation') as AssetProvenanceOperation }
        : {}),
      ...(flagNumber(args, 'limit') ? { limit: flagNumber(args, 'limit') ?? undefined } : {}),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entries) + '\n');
      return 0;
    }
    process.stdout.write(header(`Provenance entries (${entries.length})`));
    if (entries.length === 0) {
      process.stdout.write('  (ledger is empty — run a `shrk knowledge author --write-preview` to start it)\n');
      return 0;
    }
    for (const e of entries) {
      process.stdout.write(
        `  ${e.generatedAt}  ${e.operation.padEnd(10)} ${e.assetKind}:${e.assetId}  ← ${e.source}${e.reason ? ` — ${e.reason}` : ''}\n`,
      );
    }
    return 0;
  },
};

export const provenanceShowCommand: ICommandHandler = {
  name: 'show',
  description: 'Show all provenance entries for one asset id.',
  usage: 'shrk provenance show <assetId> [--kind <assetKind>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk provenance show <assetId>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const result = showProvenance(
      cwd,
      id,
      flagString(args, 'kind') as AssetKind | undefined,
    );
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
      return 0;
    }
    process.stdout.write(header(`Provenance: ${result.assetKind}:${result.assetId}`));
    if (result.entries.length === 0) {
      process.stdout.write('  (no provenance entries — this asset has no recorded authoring history)\n');
      return 0;
    }
    for (const e of result.entries) {
      process.stdout.write(
        `  ${e.generatedAt}  ${e.operation}  ← ${e.source}${e.author ? ` (${e.author})` : ''}\n`,
      );
      if (e.reason) process.stdout.write(`    reason: ${e.reason}\n`);
      if (e.previewPath) process.stdout.write(`    preview: ${e.previewPath}\n`);
      if (e.relatedTask) process.stdout.write(`    task: ${e.relatedTask}\n`);
    }
    return 0;
  },
};

export const provenanceReportCommand: ICommandHandler = {
  name: 'report',
  description: 'Summary report of the asset provenance ledger.',
  usage: 'shrk provenance report [--recent N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const recent = flagNumber(args, 'recent') ?? 10;
    const report = buildProvenanceReport(cwd, recent);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(renderProvenanceMarkdown(report));
    return 0;
  },
};

/**
 * `shrk provenance missing`. Lists local-asset entries that have no
 * provenance ledger record. Old entries are exempted (advisory only).
 */
export const provenanceMissingCommand: ICommandHandler = {
  name: 'missing',
  description:
    'List local assets (rules / knowledge / templates) without provenance entries. Advisory.',
  usage: 'shrk provenance missing [--kind <kind>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const ledger = readProvenance(cwd);
    const seen = new Set<string>();
    for (const entry of ledger) {
      seen.add(`${entry.assetKind}:${entry.assetId}`);
    }
    const kindFilter = flagString(args, 'kind');
    type MissingRow = {
      kind: 'knowledge' | 'rule' | 'template';
      id: string;
      title?: string;
      source: 'local' | 'pack';
    };
    const missing: MissingRow[] = [];

    for (const k of inspection.knowledgeEntries) {
      const sourceInfo = inspection.entrySources.get(k.id);
      if (sourceInfo?.type !== 'local') continue; // only flag local — pack assets have their own provenance flow
      const kind: MissingRow['kind'] = k.type === 'rule' ? 'rule' : 'knowledge';
      if (kindFilter && kindFilter !== kind) continue;
      const ledgerKey = `${kind}:${k.id}`;
      if (seen.has(ledgerKey)) continue;
      // Asset-kind name in ledger may also be the literal entry.type — try both.
      if (seen.has(`${k.type}:${k.id}`)) continue;
      missing.push({ kind, id: k.id, title: k.title, source: 'local' });
    }
    for (const t of inspection.templates) {
      const sourceInfo = inspection.templateSources.get(t.id);
      if (sourceInfo?.type !== 'local') continue;
      if (kindFilter && kindFilter !== 'template') continue;
      if (seen.has(`template:${t.id}`)) continue;
      missing.push({
        kind: 'template',
        id: t.id,
        title: (t as { title?: string }).title,
        source: 'local',
      });
    }

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.provenance-missing/v1',
          generatedAt: new Date().toISOString(),
          missing,
          total: missing.length,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Assets without provenance (${missing.length})`));
    if (missing.length === 0) {
      process.stdout.write('  All local assets have at least one provenance entry. ✓\n');
      return 0;
    }
    for (const m of missing.slice(0, 100)) {
      process.stdout.write(`  ${m.kind.padEnd(10)} ${m.id}${m.title ? ` — ${m.title}` : ''}\n`);
    }
    process.stdout.write(
      '\nNote: missing provenance is advisory. Use the authoring CLI ' +
        '(`shrk knowledge update <id> --reason "..."`, `shrk rules scaffold ...`) ' +
        'to record a record going forward.\n',
    );
    return 0;
  },
};

/**
 * `shrk provenance doctor`. Schema-validates every ledger entry:
 * required fields present, generatedAt parses, operation/source match
 * the enums.
 */
export const provenanceDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Validate the provenance ledger — schema + required fields.',
  usage: 'shrk provenance doctor [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const ledger = readProvenance(cwd);
    const validOperations = new Set([
      'add',
      'update',
      'remove',
      'preview',
      'apply',
      'acknowledge',
    ]);
    const validSources = new Set(['manual', 'agent', 'cli', 'session', 'unknown']);
    const issues: Array<{
      index: number;
      assetId?: string;
      issue: string;
    }> = [];
    for (let i = 0; i < ledger.length; i += 1) {
      const e = ledger[i]!;
      if (!e.assetId) issues.push({ index: i, issue: 'missing assetId' });
      if (!e.assetKind) issues.push({ index: i, assetId: e.assetId, issue: 'missing assetKind' });
      if (!e.generatedAt || Number.isNaN(Date.parse(e.generatedAt))) {
        issues.push({
          index: i,
          assetId: e.assetId,
          issue: `invalid generatedAt: ${e.generatedAt}`,
        });
      }
      if (!validOperations.has(e.operation)) {
        issues.push({
          index: i,
          assetId: e.assetId,
          issue: `unknown operation: ${e.operation}`,
        });
      }
      if (!validSources.has(e.source)) {
        issues.push({
          index: i,
          assetId: e.assetId,
          issue: `unknown source: ${e.source}`,
        });
      }
    }
    const ok = issues.length === 0;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.provenance-doctor/v1',
          generatedAt: new Date().toISOString(),
          total: ledger.length,
          issues,
          ok,
        }) + '\n',
      );
      return ok ? 0 : 1;
    }
    process.stdout.write(header(`Provenance ledger doctor`));
    process.stdout.write(`  total entries:  ${ledger.length}\n`);
    process.stdout.write(`  issues:         ${issues.length}\n`);
    if (issues.length === 0) {
      process.stdout.write('\n  Ledger is valid. ✓\n');
      return 0;
    }
    process.stdout.write('\nIssues:\n');
    for (const issue of issues.slice(0, 50)) {
      process.stdout.write(
        `  ! [${issue.index}] ${issue.assetId ?? '(no id)'} — ${issue.issue}\n`,
      );
    }
    return 1;
  },
};
