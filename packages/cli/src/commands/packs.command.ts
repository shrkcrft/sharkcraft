import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildPackContributionsInventoryAsync,
  buildPackDoctorReportAsync,
  ContributionKind,
  contributionKindForSlot,
  contributionKindOfLoader,
  formatEntryRejection,
  nearestIds,
  packDoctorCoverage,
  packEntryCounts,
  buildPackSignatureStatusReport,
  checkPackSymbolCompat,
  computePackContentDigests,
  describePackAssetFreshness,
  explainPackSignatureStatus,
  inspectSharkcraft,
  mergePackReleaseChecks,
  runPackReleaseCheck,
  runPackReleaseChecksForReport,
  type IPackSignatureExplainReport,
} from '@shrkcrft/inspector';
import type { IVerdictCoverage } from '@shrkcrft/core';
import { usageExitFor } from '../exit-codes.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import {
  CONTRIBUTION_FILE_KEYS,
  PACK_SECRET_ENV,
  signPackManifest,
  validatePackManifest,
  verifyPackManifest,
  type ISharkCraftPackManifest,
} from '@shrkcrft/plugin-api';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

function statusLabel(valid: boolean): string {
  return valid ? 'OK     ' : 'INVALID';
}

/**
 * Refuse a `--kind` / `--pack` that names no contribution kind / no discovered
 * pack (or carries no value): a usage error naming the known values and the
 * nearest, exit `usageExitFor` (3 — `packs contributions` is a verdict verb).
 * It used to narrow the view to nothing and settle a ✓ over it at exit 0 — a
 * flag that could not fail (round 12 review, A-1). `undefined` when the flag
 * is absent or names a known value.
 */
function refuseUnknownFilter(args: ParsedArgs, flag: 'kind' | 'pack', known: readonly string[]): number | undefined {
  if (!args.flags.has(flag)) return undefined;
  const raw = args.flags.get(flag);
  if (typeof raw === 'string' && known.includes(raw)) return undefined;
  const near = typeof raw === 'string' ? nearestIds(raw, known, 3).map((n) => n.id) : [];
  const knownText =
    known.length > 0 ? `known: ${known.join(', ')}` : flag === 'pack' ? 'no pack was discovered' : 'none is known';
  process.stderr.write(
    `unknown --${flag} ${typeof raw === 'string' ? `"${raw}"` : '(no value)'} — ${knownText}.${
      near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : ''
    }\n`,
  );
  return usageExitFor('packs contributions');
}

export const packsContributionsCommand: ICommandHandler = {
  name: 'contributions',
  description:
    'THE contributions report: every pack/local contribution across every loader-backed kind (how each id was derived — structural / regex-fallback / file-only), every file that failed to load, every entry a loader REJECTED with its reasons, and — per contributed file (`By file:`) — entries declared · accepted · rejected plus references that cannot be checked because their kind\'s registry is empty or undeclarable. Exit 0 · 1 an error-severity conflict, a load failure or a rejected entry · 2 only unresolvable references remain, or no contributed file is in view (NOT VERIFIED; --allow-empty accepts an empty view explicitly) · 3 an unknown --kind or --pack.',
  usage:
    'shrk packs contributions [--pack <name>] [--kind <kind>] [--allow-empty] [--format text|markdown|json] [--output <file>]',
  booleanFlags: new Set(['json', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const {
      collectUnresolvableReferences,
      contributionsReportOf,
      filterContributionsReport,
      renderContributionsByFileMarkdown,
      renderContributionsByFileText,
      renderInventoryMarkdown,
      renderInventoryText,
      inspectSharkcraft,
    } = await import('@shrkcrft/inspector');
    // A filter naming no kind is refused before anything loads; a pack name
    // is checked against the packs discovery found.
    const kindRefused = refuseUnknownFilter(args, 'kind', Object.values(ContributionKind));
    if (kindRefused !== undefined) return kindRefused;
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const packRefused = refuseUnknownFilter(
      args,
      'pack',
      [...new Set(inspection.packs.discoveredPacks.map((p) => p.packageName))].sort(),
    );
    if (packRefused !== undefined) return packRefused;
    // Use the async/structural-first variant so nested step.id and
    // sub-object ids don't show up as separate contribution ids.
    const inv = await buildPackContributionsInventoryAsync(inspection);
    const filterPack = flagString(args, 'pack');
    const filterKind = flagString(args, 'kind');
    // THE per-file report (round 12, ONE-CHANGE): the inventory, THE rejection
    // channel it carries, and the self-config doctor's own reference probes.
    const report = filterContributionsReport(
      contributionsReportOf(inspection, inv, await collectUnresolvableReferences(inspection)),
      { ...(filterPack ? { pack: filterPack } : {}), ...(filterKind ? { kind: filterKind } : {}) },
    );
    let entries = inv.entries;
    let conflicts = inv.conflicts;
    let loadFailures = inv.loadFailures;
    let rejections = inv.rejections;
    if (filterPack) {
      entries = entries.filter((e) => e.packageName === filterPack);
      conflicts = conflicts.filter((c) => c.sources.some((s) => s.packageName === filterPack));
      loadFailures = loadFailures.filter((f) => f.packageName === filterPack);
      rejections = rejections.filter((r) => r.packageName === filterPack);
    }
    if (filterKind) {
      entries = entries.filter((e) => e.kind === filterKind);
      conflicts = conflicts.filter((c) => c.contributionKind === filterKind);
      // The printed failures follow the same filter as the conflicts the exit
      // reads — never a failure listed next to an exit that ignores it. A
      // failure's loader `kind` maps through THE table the report's rows use
      // (`contributionKindOfLoader`), so the row and the exit read one answer.
      loadFailures = loadFailures.filter((f) => contributionKindOfLoader(f.kind) === filterKind);
      rejections = rejections.filter((r) => r.kind === filterKind);
    }
    const filtered = { ...inv, entries, conflicts, loadFailures, rejections };
    // THE verdict (round 12): 1 on an error-severity conflict, a file that
    // failed to load, or an entry a loader rejected (none of them takes
    // effect); settled against the references the view could not check, so
    // unresolvable references alone are 2 NOT VERIFIED — never a pass.
    const errorConflicts = conflicts.filter((c) => c.severity === 'error').length;
    const proposed = errorConflicts > 0 || loadFailures.length > 0 || rejections.length > 0 ? 1 : 0;
    // The contributed files in view are the run's unit (round 12 review,
    // A-1): an empty view — no contribution at all, or a filter selecting
    // none — examined nothing, so it is 2 NOT VERIFIED and never a ✓, unless
    // `--allow-empty` accepts it explicitly.
    const inView = report.totals.files;
    const narrowed = [filterPack ? `--pack ${filterPack}` : '', filterKind ? `--kind ${filterKind}` : '']
      .filter((s) => s.length > 0)
      .join(' ');
    const fileCoverage: IVerdictCoverage = {
      unit: 'contributed files',
      expected: inView,
      examined: inView,
      ...(inView === 0
        ? {
            reason: narrowed
              ? `no contributed file matches ${narrowed}`
              : 'no contributed file (local or pack) was discovered',
          }
        : {}),
      ...allowEmptyValve(args, inView),
    };
    const settled = settleVerdict(proposed, [
      fileCoverage,
      ...(report.referenceCoverage ? [report.referenceCoverage] : []),
    ]);
    const exit = settled.exit;
    const format = flagString(args, 'format') ?? 'text';
    if (flagBool(args, 'json') || format === 'json') {
      process.stdout.write(
        asJson({
          ...filtered,
          report,
          exitCode: exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
          accepted: settled.accepted,
        }) + '\n',
      );
      return exit;
    }
    const t = report.totals;
    const clean = `${t.accepted} of ${t.declared} declared entr${t.declared === 1 ? 'y' : 'ies'} accepted across ${t.files} contributed file(s); no rejected entry, load failure or error conflict. ✓`;
    const lead =
      t.files === 0
        ? 'Nothing was examined — no contributed file is in view.'
        : `No rejected entry, load failure or error conflict — but ${t.unresolvable} declared reference(s) could not be checked.`;
    const line = verdictLine(settled, clean, lead);
    const emptyHint =
      exit === 2 && t.files === 0 ? `Pass --${ALLOW_EMPTY_FLAG} to accept an empty view explicitly.\n` : '';
    const attention =
      exit === 1
        ? `Contributions need attention: ${rejections.length} rejected entr${rejections.length === 1 ? 'y' : 'ies'}, ${loadFailures.length} load failure(s), ${errorConflicts} error conflict(s).`
        : '';
    if (format === 'markdown') {
      process.stdout.write(renderInventoryMarkdown(filtered));
      process.stdout.write('\n' + renderContributionsByFileMarkdown(report));
      if (attention) process.stdout.write(`\n**${attention}**\n`);
      if (line) process.stdout.write(`\n${line}\n`);
      process.stdout.write(emptyHint);
      return exit;
    }
    process.stdout.write(renderInventoryText(filtered));
    process.stdout.write('\n' + renderContributionsByFileText(report));
    if (attention) process.stdout.write(`\n${attention}\n`);
    if (line) process.stdout.write(`\n${line}\n`);
    process.stdout.write(emptyHint);
    return exit;
  },
};

/** `convention 8 accepted · 2 REJECTED · helper 1 accepted` — kinds sorted, REJECTED only when > 0. */
function entryCountsLine(counts: Record<string, { files: number; accepted: number; rejected: number }>): string {
  const parts = Object.keys(counts)
    .sort()
    .filter((k) => counts[k]!.accepted > 0 || counts[k]!.rejected > 0)
    .map((k) => {
      const c = counts[k]!;
      return `${k} ${c.accepted} accepted${c.rejected > 0 ? ` · ${c.rejected} REJECTED` : ''}`;
    });
  return parts.length > 0 ? parts.join(' · ') : '(no entry loaded)';
}

/** The `files:` tokens: the six classic ones always, then every other non-zero slot as `<kind>=<n>`. */
const CLASSIC_FILE_SLOTS: ReadonlySet<string> = new Set([
  'knowledgeFiles',
  'ruleFiles',
  'pathFiles',
  'templateFiles',
  'pipelineFiles',
  'docsFiles',
]);

function extraFileTokens(counts: Readonly<Record<string, number | undefined>>): string {
  const parts: string[] = [];
  for (const slot of CONTRIBUTION_FILE_KEYS) {
    if (CLASSIC_FILE_SLOTS.has(slot)) continue;
    const n = counts[slot] ?? 0;
    if (n > 0) parts.push(`${contributionKindForSlot(slot) ?? slot}=${n}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export const packsSignatureStatusCommand: ICommandHandler = {
  name: 'signature-status',
  description:
    'Report pack signature freshness (present/stale/missing). Never fake-signs; never requires the secret. `--release-readiness` annotates each pack with whether it would block release:preflight (dev signature + no SHARKCRAFT_PACK_SECRET = blocking).',
  usage:
    'shrk packs signature-status [<pack>] [--release-readiness] [--allow-empty] [--format text|markdown|json]',
  booleanFlags: new Set(['release-readiness', 'json', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const { buildPackSignatureStatusReport, inspectSharkcraft } = await import('@shrkcrft/inspector');
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildPackSignatureStatusReport(inspection);
    const filter = args.positional[0];
    const packs = filter
      ? report.packs.filter(
          (p) => p.packageName === filter || p.packageRoot.endsWith(filter) || p.packageRoot.includes(filter),
        )
      : report.packs;
    // Derive release-blocking assessment per pack.
    const releaseReadiness = flagBool(args, 'release-readiness');
    const secretAvailable = report.secretAvailable;
    const annotated = packs.map((p) => {
      const isDev = p.dev === true;
      const releaseBlocking = isDev && !secretAvailable;
      const releaseBlockingReason = releaseBlocking
        ? 'dev signature + SHARKCRAFT_PACK_SECRET not set — release would publish a dev signature'
        : isDev && secretAvailable
          ? 'dev signature — re-sign before tagging (secret is available)'
          : undefined;
      return {
        ...p,
        dev: isDev,
        releaseBlocking,
        ...(releaseBlockingReason ? { releaseBlockingReason } : {}),
      };
    });
    const blockingCount = annotated.filter((p) => p.releaseBlocking).length;
    const devCount = annotated.filter((p) => p.dev).length;
    const filtered = {
      ...report,
      packs: annotated,
      releaseReadiness: releaseReadiness
        ? {
            enabled: true,
            secretAvailable,
            devSigned: devCount,
            releaseBlocking: blockingCount,
            wouldBlockReleasePreflight: blockingCount > 0,
          }
        : { enabled: false },
    };
    const format = flagString(args, 'format') ?? 'text';
    // Freshness comes from the one authority (content digests recorded at
    // signing). A signed pack whose signature records no digests is NOT
    // verified — never a pass: settle it as 2 when nothing is stale.
    const signed = annotated.filter((p) => p.status !== 'missing');
    const unverifiedPacks = annotated.filter((p) => p.status === 'unverified');
    const coverage: IVerdictCoverage[] =
      signed.length > 0
        ? [
            {
              unit: 'signed packs',
              expected: signed.length,
              examined: signed.length - unverifiedPacks.length,
              ...(unverifiedPacks.length > 0
                ? {
                    unexamined: unverifiedPacks.map((p) => p.packageName),
                    reason: 'their signature records no content digests — re-sign to verify freshness',
                  }
                : {}),
            },
          ]
        : [
            // Zero signed packs is not "every signature is fresh": nothing was
            // verified. 2, unless --allow-empty accepts the empty set explicitly.
            {
              unit: 'signed packs',
              expected: 0,
              examined: 0,
              reason: annotated.length === 0 ? 'no pack discovered' : 'no discovered pack carries a signature',
              ...allowEmptyValve(args, 0),
            },
          ];
    const settled = settleVerdict(
      filtered.summary.stale > 0 || (releaseReadiness && blockingCount > 0) ? 1 : 0,
      coverage,
    );
    const exitCode = settled.exit;
    if (flagBool(args, 'json') || format === 'json') {
      process.stdout.write(
        asJson({ ...filtered, exitCode, verdict: settled.verdict, shortfalls: settled.shortfalls }) + '\n',
      );
      return exitCode;
    }
    if (format === 'markdown') {
      const lines: string[] = ['# Pack signature status', ''];
      lines.push(`- generatedAt: ${filtered.generatedAt}`);
      lines.push(`- secret available: ${filtered.secretAvailable}`);
      lines.push(`- total: ${filtered.summary.total} (present ${filtered.summary.present} / stale ${filtered.summary.stale} / unverified ${filtered.summary.unverified} / missing ${filtered.summary.missing})`);
      if (releaseReadiness) {
        lines.push(`- dev-signed: ${devCount}`);
        lines.push(`- release-blocking: ${blockingCount}`);
      }
      lines.push('');
      lines.push('| Pack | Status | Dev | Release-blocking | Signed at | Reason | Next |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const p of annotated) {
        lines.push(
          `| \`${p.packageName}\` | ${p.status} | ${p.dev ? 'yes' : 'no'} | ${p.releaseBlocking ? 'YES' : 'no'} | ${p.signatureSignedAt ?? ''} | ${p.reason ?? p.releaseBlockingReason ?? ''} | ${p.nextCommand ?? ''} |`,
        );
      }
      process.stdout.write(lines.join('\n') + '\n');
      return exitCode;
    }
    process.stdout.write(`=== Pack signature status ===\n`);
    process.stdout.write(`  total       ${filtered.summary.total}\n`);
    process.stdout.write(`  present     ${filtered.summary.present}\n`);
    process.stdout.write(`  stale       ${filtered.summary.stale}\n`);
    process.stdout.write(`  unverified  ${filtered.summary.unverified}\n`);
    process.stdout.write(`  missing     ${filtered.summary.missing}\n`);
    process.stdout.write(`  secret env  ${filtered.secretAvailable ? 'set' : 'NOT set (no fake-signing — re-sign manually)'}\n`);
    if (releaseReadiness) {
      process.stdout.write(`  dev signed  ${devCount}\n`);
      process.stdout.write(`  release-blocking  ${blockingCount}\n`);
    }
    process.stdout.write('\n');
    for (const p of annotated) {
      const devTag = p.dev ? ' [dev]' : '';
      const blockTag = p.releaseBlocking ? ' [release-blocking]' : '';
      process.stdout.write(`  ${p.status.padEnd(8)} ${p.packageName}@${p.packageVersion}${devTag}${blockTag}\n`);
      if (p.reason) process.stdout.write(`           ${p.reason}\n`);
      if (p.releaseBlockingReason) process.stdout.write(`           ${p.releaseBlockingReason}\n`);
      if (p.nextCommand) process.stdout.write(`           next: ${p.nextCommand}\n`);
    }
    if (releaseReadiness && blockingCount > 0) {
      process.stdout.write(
        `\nRelease would FAIL CLOSED — set SHARKCRAFT_PACK_SECRET and run \`shrk packs sign <pack>\` for each dev-signed pack.\n`,
      );
    }
    const line = verdictLine(settled, '');
    if (line) process.stdout.write(`\n${line}\n`);
    if (signed.length === 0 && exitCode === 2) {
      process.stdout.write(`Pass --${ALLOW_EMPTY_FLAG} to accept a project with no signed pack explicitly.\n`);
    }
    return exitCode;
  },
};

export const packsConflictsCommand: ICommandHandler = {
  name: 'conflicts',
  description:
    'Surface duplicate-id / shadowed / stale-signature conflicts across pack contributions. Read-only.',
  usage: 'shrk packs conflicts [--severity error|warning|info] [--format text|markdown|json]',
  async run(args: ParsedArgs): Promise<number> {
    const { buildPackContributionsInventoryAsync, inspectSharkcraft, selectConflicts } = await import(
      '@shrkcrft/inspector'
    );
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    // Async/structural-first inventory eliminates nested-id duplicate noise.
    const inv = await buildPackContributionsInventoryAsync(inspection);
    let conflicts = selectConflicts(inv);
    const sev = flagString(args, 'severity');
    if (sev) conflicts = conflicts.filter((c) => c.severity === sev);
    if (flagBool(args, 'json') || flagString(args, 'format') === 'json') {
      process.stdout.write(asJson({ conflicts, totals: inv.totals }) + '\n');
      return conflicts.some((c) => c.severity === 'error') ? 1 : 0;
    }
    if (flagString(args, 'format') === 'markdown') {
      const lines: string[] = ['# Pack contributions conflicts', ''];
      if (conflicts.length === 0) {
        lines.push('None.');
      } else {
        lines.push('| Severity | Kind | Contribution | Id | Message |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const c of conflicts) {
          lines.push(`| ${c.severity} | \`${c.kind}\` | \`${c.contributionKind}\` | \`${c.id}\` | ${c.message} |`);
        }
      }
      process.stdout.write(lines.join('\n') + '\n');
      return conflicts.some((c) => c.severity === 'error') ? 1 : 0;
    }
    process.stdout.write(`=== Pack contributions conflicts (${conflicts.length}) ===\n`);
    if (conflicts.length === 0) {
      process.stdout.write('No conflicts.\n');
      return 0;
    }
    for (const c of conflicts) {
      process.stdout.write(
        `  ${c.severity.padEnd(7)} [${c.kind}] ${c.contributionKind} "${c.id}" — ${c.message}\n`,
      );
      if (c.nextCommand) process.stdout.write(`         next: ${c.nextCommand}\n`);
    }
    return conflicts.some((c) => c.severity === 'error') ? 1 : 0;
  },
};

export const packsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List discovered packs (valid + invalid).',
  usage: 'shrk [--cwd <dir>] packs list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const packs = inspection.packs.discoveredPacks;
    // Compiled-build freshness, from the one pack-asset freshness authority
    // (computed at inspection for packs serving compiled contributions).
    const freshnessByRoot = new Map((inspection.packAssetFreshness ?? []).map((f) => [f.packageRoot, f]));
    // Per-kind accepted / REJECTED entries, from THE contributions inventory
    // (round 12, 12.1b): a conventions-only pack printed all zeros, and a
    // partially-loaded file looked identical to a fully-loaded one.
    const inv = inspection.packs.validPacks.length > 0 ? await buildPackContributionsInventoryAsync(inspection) : null;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson(
          packs.map((p) => ({
            packageName: p.packageName,
            packageVersion: p.packageVersion,
            valid: p.valid,
            manifestPath: p.manifestPath,
            contributionCounts: p.contributionCounts,
            resolvedCounts: p.resolvedCounts,
            entryCounts: packEntryCounts(inv, p),
            signatureStatus: p.signatureStatus,
            signatureMessage: p.signatureMessage,
            signatureDev: p.signatureDev,
            loadError: p.loadError,
            validationIssues: p.validationIssues,
            buildFreshness: freshnessByRoot.get(p.packageRoot)?.build.state ?? 'not-compiled',
          })),
        ) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Packs (${packs.length})`));
    if (packs.length === 0) {
      process.stdout.write('  (no packs discovered in node_modules)\n');
      return 0;
    }
    for (const p of packs) {
      const c = p.contributionCounts;
      const r = p.resolvedCounts;
      const counts = packEntryCounts(inv, p);
      const rejected = Object.values(counts).reduce((n, x) => n + x.rejected, 0);
      const freshness = freshnessByRoot.get(p.packageRoot);
      const buildMark =
        freshness?.build.state === 'stale'
          ? '  STALE-BUILD'
          : freshness?.build.state === 'unrecorded'
            ? '  BUILD-UNVERIFIED'
            : '';
      process.stdout.write(
        `  ${statusLabel(p.valid)} ${p.packageName}@${p.packageVersion}${buildMark}${rejected > 0 ? '  REJECTED-ENTRIES' : ''}\n`,
      );
      if (freshness && buildMark) {
        const said = describePackAssetFreshness(freshness).build;
        if (said) process.stdout.write(`          ${said}\n`);
      }
      process.stdout.write(
        `          files:    k=${c.knowledgeFiles} r=${c.ruleFiles} p=${c.pathFiles} t=${c.templateFiles} pl=${c.pipelineFiles} d=${c.docsFiles}${extraFileTokens(c)}\n`,
      );
      if (r) {
        const totalEntries = r.knowledgeEntries + r.rules + r.pathConventions;
        process.stdout.write(
          `          resolved: entries=${totalEntries} templates=${r.templates} pipelines=${r.pipelines} docs=${r.docs}\n`,
        );
      }
      if (p.valid) {
        process.stdout.write(`          entries:  ${entryCountsLine(counts)}\n`);
        if (rejected > 0) {
          process.stdout.write(`          ↳ shrk packs contributions --pack ${p.packageName} names every rejected entry\n`);
        }
      }
      if (!p.valid) {
        if (p.loadError) process.stdout.write(`          error: ${p.loadError}\n`);
        for (const i of p.validationIssues) {
          process.stdout.write(`          issue: ${i.field}: ${i.message}\n`);
        }
      }
    }
    return 0;
  },
};

export const packsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show full info for one pack (by package name).',
  usage: 'shrk [--cwd <dir>] packs get <packageName> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk packs get <packageName>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const pack = inspection.packs.discoveredPacks.find((p) => p.packageName === id);
    if (!pack) {
      process.stderr.write(`No pack with name "${id}" was discovered.\n`);
      return 1;
    }
    // Every slot and every entry, from THE contributions inventory (round 12, 12.1b).
    const inv = pack.valid ? await buildPackContributionsInventoryAsync(inspection) : null;
    const counts = packEntryCounts(inv, pack);
    const rejections = (inv?.rejections ?? []).filter((r) => r.packageName === pack.packageName);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ ...pack, entryCounts: counts, rejections }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Pack: ${pack.packageName}`));
    process.stdout.write(kv('version', pack.packageVersion) + '\n');
    process.stdout.write(kv('status', pack.valid ? 'valid' : 'invalid') + '\n');
    process.stdout.write(kv('manifest', pack.manifestPath) + '\n');
    process.stdout.write(kv('package root', pack.packageRoot) + '\n');
    if (pack.manifest?.info.description) {
      process.stdout.write(kv('description', pack.manifest.info.description) + '\n');
    }
    const c = pack.contributionCounts;
    process.stdout.write('\nContribution files:\n');
    process.stdout.write(`  knowledge files:        ${c.knowledgeFiles}\n`);
    process.stdout.write(`  rule files:             ${c.ruleFiles}\n`);
    process.stdout.write(`  path files:             ${c.pathFiles}\n`);
    process.stdout.write(`  template files:         ${c.templateFiles}\n`);
    process.stdout.write(`  pipeline files:         ${c.pipelineFiles}\n`);
    process.stdout.write(`  docs files:             ${c.docsFiles}\n`);
    process.stdout.write(`  scaffold pattern files: ${c.scaffoldPatternFiles}\n`);
    // Every other declared slot (round 12, 12.1b) — conventions, helpers,
    // hints, gate planes, … were never shown.
    for (const slot of CONTRIBUTION_FILE_KEYS) {
      if (CLASSIC_FILE_SLOTS.has(slot) || slot === 'scaffoldPatternFiles') continue;
      const n = (c as Readonly<Record<string, number | undefined>>)[slot] ?? 0;
      if (n > 0) process.stdout.write(`  ${`${slot}:`.padEnd(24)}${n}\n`);
    }
    if (Object.keys(counts).length > 0) {
      process.stdout.write('\nEntries (accepted / rejected by their loader):\n');
      for (const k of Object.keys(counts).sort()) {
        const x = counts[k]!;
        process.stdout.write(`  ${`${k}:`.padEnd(24)}${x.accepted} accepted${x.rejected > 0 ? ` · ${x.rejected} REJECTED` : ''}\n`);
      }
      for (const r of rejections) {
        process.stdout.write(`    ✗ ${r.file}  ${formatEntryRejection(r)}\n`);
      }
    }
    if (pack.resolvedCounts) {
      const r = pack.resolvedCounts;
      process.stdout.write('\nResolved (after dedup against local):\n');
      process.stdout.write(`  knowledge entries:  ${r.knowledgeEntries}\n`);
      process.stdout.write(`  rules:              ${r.rules}\n`);
      process.stdout.write(`  path conventions:   ${r.pathConventions}\n`);
      process.stdout.write(`  templates:          ${r.templates}\n`);
      process.stdout.write(`  pipelines:          ${r.pipelines}\n`);
      process.stdout.write(`  docs:               ${r.docs}\n`);
      process.stdout.write(`  scaffold patterns:  ${r.scaffoldPatterns ?? 0}\n`);
    }
    if (pack.signatureStatus) {
      process.stdout.write('\nSignature:\n');
      process.stdout.write(`  status:  ${pack.signatureStatus}\n`);
      if (pack.signatureDev) {
        process.stdout.write('  dev:     yes (NOT release-trusted)\n');
      }
      if (pack.signatureMessage) {
        process.stdout.write(`  message: ${pack.signatureMessage}\n`);
      }
    }
    if (pack.loadError) process.stdout.write(`\nLoad error: ${pack.loadError}\n`);
    if (pack.validationIssues.length) {
      process.stdout.write('\nValidation issues:\n');
      for (const i of pack.validationIssues) {
        process.stdout.write(`  ${i.field}: ${i.message}\n`);
      }
    }
    if (pack.manifest?.postInstallNotes?.length) {
      process.stdout.write('\nPost-install notes:\n');
      for (const n of pack.manifest.postInstallNotes) {
        process.stdout.write(`  • ${n}\n`);
      }
    }
    return 0;
  },
};

export const packsInspectCommand: ICommandHandler = {
  name: 'inspect',
  description: 'Inspect pack discovery: scanned packages, valid/invalid counts, warnings.',
  usage: 'shrk [--cwd <dir>] packs inspect [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const { packs } = inspection;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          projectRoot: packs.projectRoot,
          nodeModulesPath: packs.nodeModulesPath,
          nodeModulesExists: packs.nodeModulesExists,
          scannedPackageCount: packs.scannedPackageCount,
          discoveredPackCount: packs.discoveredPacks.length,
          validPackCount: packs.validPacks.length,
          invalidPackCount: packs.invalidPacks.length,
          warnings: packs.warnings,
        }) + '\n',
      );
      return 0;
    }
    // Aggregate resolved counts across valid packs.
    const totals = { entries: 0, templates: 0, pipelines: 0, docs: 0, scaffoldPatterns: 0 };
    for (const p of packs.validPacks) {
      const r = p.resolvedCounts;
      if (!r) continue;
      totals.entries += r.knowledgeEntries + r.rules + r.pathConventions;
      totals.templates += r.templates;
      totals.pipelines += r.pipelines;
      totals.docs += r.docs;
      totals.scaffoldPatterns += r.scaffoldPatterns ?? 0;
    }
    process.stdout.write(header('Pack discovery'));
    process.stdout.write(kv('project root', packs.projectRoot) + '\n');
    process.stdout.write(kv('node_modules', packs.nodeModulesPath) + '\n');
    process.stdout.write(kv('exists', packs.nodeModulesExists ? 'yes' : 'no') + '\n');
    process.stdout.write(kv('scanned packages', packs.scannedPackageCount) + '\n');
    process.stdout.write(
      kv(
        'total resolved',
        `entries=${totals.entries} templates=${totals.templates} pipelines=${totals.pipelines} docs=${totals.docs} scaffoldPatterns=${totals.scaffoldPatterns}`,
      ) + '\n',
    );
    process.stdout.write(kv('discovered packs', packs.discoveredPacks.length) + '\n');
    process.stdout.write(kv('valid', packs.validPacks.length) + '\n');
    process.stdout.write(kv('invalid', packs.invalidPacks.length) + '\n');
    if (packs.warnings.length) {
      process.stdout.write('\nWarnings:\n');
      for (const w of packs.warnings) process.stdout.write(`  • ${w}\n`);
    }
    return 0;
  },
};

export const packsDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Validate pack discovery: invalid manifests, missing files, contribution files that failed to load, partially-resolved / empty contributions, stale compiled builds, unregistered group exports, duplicates, template/pipeline quality, action-hint coverage, signatures. `--release` folds pack-release-check findings into the report. `--typecheck` type-checks each pack\'s TS assets (exit 2 when nothing could be checked). `--signature-explain` adds per-pack signature explanation.',
  usage:
    'shrk [--cwd <dir>] packs doctor [--verify-signatures] [--require-signatures] [--allow-dev-signature] [--release] [--strict] [--typecheck] [--allow-empty] [--secret <secret>] [--signature-explain] [--json]',
  booleanFlags: new Set([
    'verify-signatures',
    'require-signatures',
    'allow-dev-signature',
    'release',
    'strict',
    'typecheck',
    ALLOW_EMPTY_FLAG,
    'signature-explain',
    'json',
  ]),
  async run(args: ParsedArgs): Promise<number> {
    const signatureExplain = flagBool(args, 'signature-explain');
    // `--signature-explain` implies signature verification so the lifecycle
    // states it prints are backed by a real HMAC check this run — otherwise a
    // bogus-HMAC-but-fresh-timestamp pack would be reported off freshness
    // alone instead of the honest "invalid".
    const verify =
      flagBool(args, 'verify-signatures') ||
      flagBool(args, 'require-signatures') ||
      signatureExplain;
    const required = flagBool(args, 'require-signatures');
    const release = flagBool(args, 'release');
    const strict = flagBool(args, 'strict');
    const secret = flagString(args, 'secret');
    const allowDev = flagBool(args, 'allow-dev-signature');
    const inspection = await inspectSharkcraft({
      cwd: resolveCwd(args),
      ...(verify ? { verifyPackSignatures: true } : {}),
      ...(secret !== undefined ? { packSecret: secret } : {}),
    });
    const typecheck = flagBool(args, 'typecheck');
    // The async doctor: registry load failures, unregistered group exports and
    // (opt-in) a typecheck of every pack's TS assets are gathered first.
    const report = await buildPackDoctorReportAsync(inspection, {
      requireSignatures: required,
      ...(allowDev ? { allowDevSignatures: true } : {}),
      ...(release ? { release: true } : {}),
      ...(strict ? { strict: true } : {}),
      ...(typecheck ? { typecheck: true } : {}),
    });
    if (release) {
      const releaseChecks = await runPackReleaseChecksForReport(inspection);
      mergePackReleaseChecks(inspection, report, releaseChecks, { strict });
    }
    let signatureExplanation: IPackSignatureExplainReport | undefined;
    if (signatureExplain) {
      signatureExplanation = explainPackSignatureStatus(inspection, { requireSignatures: required });
    }
    // The run examines the discovered packs. Zero is an empty selection — NOT
    // VERIFIED (2) unless --allow-empty says a pack-less project is expected.
    const discovered = inspection.packs.discoveredPacks.length;
    // THE pack-doctor coverage (`packDoctorCoverage`, which `packDoctorVerdict`
    // — MCP doctor_packs, the quality gate, bare `check` — settles on): the
    // discovered packs, with this verb's `--allow-empty` valve, and compiled
    // artifacts with no build record (never compared to their source).
    const coverage: IVerdictCoverage[] = packDoctorCoverage(report, inspection, allowEmptyValve(args, discovered));
    // `--typecheck` is a verdict over TS files: a pack with none to check
    // examined nothing — never a pass. (Zero packs is the run record's case.)
    if (typecheck && discovered > 0) {
      const packCount = inspection.packs.validPacks.length;
      coverage.push({
        unit: 'packs',
        expected: packCount,
        examined: packCount,
        reason: 'no valid pack discovered to type-check',
        ...allowEmptyValve(args, packCount),
      });
      for (const t of report.typecheckResults ?? []) {
        coverage.push({
          unit: 'TS files',
          expected: t.result.checkedFiles.length,
          examined: t.result.ran ? t.result.checkedFiles.length : 0,
          subject: t.packageName,
          ...(t.result.note ? { reason: t.result.note } : {}),
        });
      }
    }
    const settled = settleVerdict(report.passed ? 0 : 1, coverage);

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          // The settled verdict, never the pre-settlement report flag: a run
          // that verified nothing (exit 2) is not `passed`.
          passed: settled.exit === 0,
          packsChecked: report.packsChecked,
          summary: report.summary,
          discoveredPackCount: inspection.packs.discoveredPacks.length,
          validPackCount: inspection.packs.validPacks.length,
          invalidPackCount: inspection.packs.invalidPacks.length,
          issues: report.issues,
          ...(report.releaseChecks ? { releaseChecks: report.releaseChecks } : {}),
          ...(report.typecheckResults ? { typecheckResults: report.typecheckResults } : {}),
          ...(signatureExplanation ? { signatureExplanation } : {}),
          exitCode: settled.exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
        }) + '\n',
      );
      return settled.exit;
    }

    process.stdout.write(header('Pack doctor'));
    process.stdout.write(
      kv('discovered', String(inspection.packs.discoveredPacks.length)) + '\n',
    );
    process.stdout.write(kv('valid', String(inspection.packs.validPacks.length)) + '\n');
    process.stdout.write(kv('invalid', String(inspection.packs.invalidPacks.length)) + '\n');
    const modeParts: string[] = [];
    if (required) modeParts.push('require signatures');
    else if (verify) modeParts.push('verify signatures');
    else modeParts.push('structure only');
    if (release) modeParts.push('release-check');
    if (typecheck) modeParts.push('typecheck');
    if (strict) modeParts.push('strict');
    process.stdout.write(kv('mode', modeParts.join(' + ')) + '\n\n');
    if (report.issues.length === 0) {
      process.stdout.write('No pack issues.\n');
    } else {
      for (const i of report.issues) {
        process.stdout.write(
          `${i.severity.toUpperCase().padEnd(8)} ${i.packageName.padEnd(40)} ${i.code.padEnd(28)} ${i.message}\n`,
        );
        if (i.suggestion) {
          process.stdout.write(`         ↳ ${i.suggestion}\n`);
        }
        if (i.suggestedCommand) {
          process.stdout.write(`         $ ${i.suggestedCommand}\n`);
        }
      }
    }
    process.stdout.write(
      `\nSummary: ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.info} info\n`,
    );
    if (settled.exit === 1) process.stdout.write(`\nVerdict: pack issues need attention\n`);
    const verdict = verdictLine(settled, '\nVerdict: OK ✓');
    if (verdict) process.stdout.write(`${settled.exit === 0 ? '' : '\n'}${verdict}\n`);
    if (settled.exit === 2 && discovered === 0) {
      process.stdout.write('Pass --allow-empty to accept a project with no packs explicitly.\n');
    }
    if (signatureExplanation) {
      process.stdout.write('\n--- Signature explanation ---\n');
      process.stdout.write(`secret env: ${signatureExplanation.secretAvailable ? 'set' : 'NOT set'}\n`);
      process.stdout.write(`mode:       ${signatureExplanation.mode}\n\n`);
      for (const p of signatureExplanation.packs) {
        process.stdout.write(`  ${p.state.padEnd(14)} ${p.packageName}@${p.packageVersion}\n`);
        process.stdout.write(`           ${p.explanation}\n`);
        if (p.nextCommand) process.stdout.write(`           next: ${p.nextCommand}\n`);
      }
    }
    return settled.exit;
  },
};

export const packsVerifyCommand: ICommandHandler = {
  name: 'verify',
  description:
    'Verify HMAC signatures on every discovered pack. Unsigned packs are reported but do not fail. Under --required, a signed pack that could not be verified (no secret) or that carries a dev signature fails too — pass --allow-dev-signature to trust dev signatures for local-only flows.',
  usage:
    'shrk [--cwd <dir>] packs verify [--secret <secret>] [--required] [--allow-dev-signature] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const secret = flagString(args, 'secret');
    const allowDev = flagBool(args, 'allow-dev-signature');
    const inspection = await inspectSharkcraft({
      cwd: resolveCwd(args),
      verifyPackSignatures: true,
      ...(secret !== undefined ? { packSecret: secret } : {}),
    });
    const required = flagBool(args, 'required');
    type SigStatus =
      | 'verified'
      | 'invalid-signature'
      | 'missing-signature'
      | 'missing-secret'
      | 'dev-signature'
      | 'not-checked';
    const rows = inspection.packs.discoveredPacks.map((p) => {
      let signatureStatus: SigStatus = (p.signatureStatus ?? 'not-checked') as SigStatus;
      let signatureMessage = p.signatureMessage;
      let signatureDev = p.signatureDev === true;
      // --allow-dev-signature: actually run the HMAC check against the
      // well-known dev secret so a *tampered* dev signature still fails. The
      // default discovery path short-circuits to 'dev-signature' BEFORE
      // hashing, so we must re-verify here rather than blindly trust the tag.
      if (allowDev && signatureStatus === 'dev-signature' && p.manifest) {
        const v = verifyPackManifest(p.manifest, {
          allowDev: true,
          ...(secret !== undefined ? { secret } : {}),
        });
        signatureStatus = (v.ok ? 'verified' : v.status) as SigStatus;
        signatureMessage = v.ok ? 'Dev signature verified (--allow-dev-signature).' : v.message;
        signatureDev = true;
      }
      return {
        packageName: p.packageName,
        packageVersion: p.packageVersion,
        valid: p.valid,
        signatureStatus,
        signatureMessage,
        signatureDev,
      };
    });

    const tampered = rows.some((r) => r.signatureStatus === 'invalid-signature');
    const unsigned = rows.some((r) => r.signatureStatus === 'missing-signature');
    // A SIGNED pack we could NOT actually verify this run: the secret was
    // missing, or it carries a dev signature that is not release-trusted (and
    // --allow-dev-signature was not passed). Reporting these as "OK" was the
    // fail-open hole — required verification that could not run must FAIL.
    const missingSecretCount = rows.filter((r) => r.signatureStatus === 'missing-secret').length;
    const devCount = rows.filter((r) => r.signatureStatus === 'dev-signature').length;
    const unverifiable = missingSecretCount > 0 || devCount > 0;
    const signedCount = rows.filter(
      (r) => r.signatureStatus !== 'missing-signature' && r.signatureStatus !== 'not-checked',
    ).length;
    const verifiedCount = rows.filter((r) => r.signatureStatus === 'verified').length;
    const allSignedVerified = signedCount > 0 && verifiedCount === signedCount;
    const passed = !tampered && (!required || (!unsigned && !unverifiable));

    const verdict = ((): string => {
      if (tampered) return 'TAMPERED pack detected — abort!';
      if (required && (unverifiable || unsigned)) {
        const bits: string[] = [];
        if (missingSecretCount > 0)
          bits.push(
            `${missingSecretCount} signed pack(s) could not be verified (no secret) — set ${PACK_SECRET_ENV}`,
          );
        if (devCount > 0)
          bits.push(
            `${devCount} dev-signed pack(s) are not release-trusted — pass --allow-dev-signature to accept them`,
          );
        if (unsigned) bits.push('unsigned pack present');
        return bits.join('; ');
      }
      if (allSignedVerified && !unsigned && !unverifiable) return 'all signatures OK ✓';
      if (unverifiable || unsigned) {
        const bits: string[] = [];
        if (missingSecretCount > 0) bits.push(`${missingSecretCount} signed pack(s) unverified (no secret)`);
        if (devCount > 0) bits.push(`${devCount} dev-signed pack(s) not release-trusted`);
        if (unsigned) bits.push('unsigned pack present');
        return bits.join('; ') + ' (use --required to fail)';
      }
      return signedCount > 0 ? 'all signatures OK ✓' : 'no signatures to verify';
    })();

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          passed,
          required,
          allowDevSignature: allowDev,
          tampered,
          unsignedPresent: unsigned,
          unverifiable,
          unverifiableCount: missingSecretCount,
          devSignatureCount: devCount,
          packs: rows,
        }) + '\n',
      );
      return passed ? 0 : 1;
    }

    process.stdout.write(header(`Pack signatures (${rows.length})`));
    if (rows.length === 0) {
      process.stdout.write('No packs discovered.\n');
      return 0;
    }
    for (const r of rows) {
      const tag =
        r.signatureStatus === 'verified'
          ? 'VERIFIED'
          : r.signatureStatus === 'invalid-signature'
            ? 'TAMPERED'
            : r.signatureStatus === 'missing-signature'
              ? 'UNSIGNED'
              : r.signatureStatus === 'missing-secret'
                ? 'NO SECRET'
                : r.signatureStatus === 'dev-signature'
                  ? 'DEV'
                  : 'NOT CHECKED';
      const devNote = r.signatureStatus === 'dev-signature' ? ' (not release-trusted)' : '';
      process.stdout.write(
        `  ${tag.padEnd(12)} ${r.packageName.padEnd(40)} ${r.signatureMessage ?? ''}${devNote}\n`,
      );
    }
    process.stdout.write(`\nVerdict: ${verdict}\n`);
    if (!secret && !process.env[PACK_SECRET_ENV]) {
      process.stdout.write(
        `(Tip: set ${PACK_SECRET_ENV} or pass --secret to verify signed packs.)\n`,
      );
    }
    return passed ? 0 : 1;
  },
};

/**
 * Resolve the manifest source path given either a direct manifest file or a
 * package directory. If a directory is passed, read its package.json's
 * `sharkcraft.manifest` (or `sharkcraft` if it's a string) and resolve that.
 */
function resolveManifestInput(input: string): { manifestPath: string } | { error: string } {
  const absolute = nodePath.resolve(input);
  if (!existsSync(absolute)) {
    return { error: `Input does not exist: ${absolute}` };
  }
  const stat = statSync(absolute);
  if (stat.isFile()) {
    return { manifestPath: absolute };
  }
  if (!stat.isDirectory()) {
    return { error: `Input is neither a file nor a directory: ${absolute}` };
  }
  const pkgJsonPath = nodePath.join(absolute, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return { error: `Directory has no package.json: ${absolute}` };
  }
  let pkg: { sharkcraft?: unknown };
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { sharkcraft?: unknown };
  } catch (e) {
    return { error: `Failed to parse package.json: ${(e as Error).message}` };
  }
  const sc = pkg.sharkcraft;
  let manifestRel: string | undefined;
  if (typeof sc === 'string') manifestRel = sc;
  else if (sc && typeof sc === 'object') {
    const m = (sc as { manifest?: unknown }).manifest;
    if (typeof m === 'string') manifestRel = m;
  }
  if (!manifestRel) {
    return {
      error: `package.json does not declare sharkcraft.manifest at ${pkgJsonPath}`,
    };
  }
  const manifestPath = nodePath.resolve(absolute, manifestRel);
  if (!existsSync(manifestPath)) {
    return { error: `sharkcraft.manifest points at a non-existent file: ${manifestPath}` };
  }
  return { manifestPath };
}

/** The package root a manifest belongs to: the nearest ancestor with a package.json. */
function findPackRoot(manifestPath: string): string {
  let dir = nodePath.dirname(manifestPath);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(nodePath.join(dir, 'package.json'))) return dir;
    const up = nodePath.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return nodePath.dirname(manifestPath);
}

async function loadManifestFromPath(
  manifestPath: string,
): Promise<ISharkCraftPackManifest> {
  if (manifestPath.endsWith('.json')) {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as ISharkCraftPackManifest;
  }
  const mod = (await importModuleViaLoader(manifestPath)) as {
    default?: ISharkCraftPackManifest;
  };
  return (mod.default ?? (mod as unknown as ISharkCraftPackManifest)) as ISharkCraftPackManifest;
}

export const packsSignCommand: ICommandHandler = {
  name: 'sign',
  description:
    'Sign a pack manifest with HMAC-SHA256 and write a .signed.json next to the source. Accepts either the manifest file directly or a package directory (uses package.json sharkcraft.manifest). --if-needed signs only when stale; --check-only never signs; --print-command prints the exact signing command. --dev signs with the well-known dev secret and marks the signature `dev: true` (NOT release-trusted).',
  usage:
    'shrk packs sign <path-to-manifest.ts | package-dir> [--output <out.json>] [--secret <secret>] [--key-id <id>] [--dev] [--verify-after-sign] [--if-needed] [--check-only] [--print-command] [--write-todo] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const input = args.positional[0];
    if (!input) {
      process.stderr.write(
        'Usage: shrk packs sign <path-to-manifest.ts | package-dir> [--output <out.json>]\n',
      );
      return 2;
    }
    // `--print-command` is a fallback for agents without the
    // pack secret. Resolve cheaply (no manifest load required).
    const ifNeeded = flagBool(args, 'if-needed');
    const checkOnly = flagBool(args, 'check-only');
    const printCommand = flagBool(args, 'print-command');
    const writeTodo = flagBool(args, 'write-todo');
    const secretFromEnv = Boolean(process.env[PACK_SECRET_ENV]);
    const secretFromFlag = Boolean(flagString(args, 'secret'));
    const haveSecret = secretFromEnv || secretFromFlag;

    if (printCommand) {
      const printed = haveSecret
        ? `shrk packs sign ${input}`
        : `${PACK_SECRET_ENV}=<secret> shrk packs sign ${input}`;
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson({ printCommand: printed, secretAvailable: haveSecret }) + '\n');
      } else {
        process.stdout.write(`${printed}\n`);
      }
      return 0;
    }
    const resolved = resolveManifestInput(input);
    if ('error' in resolved) {
      process.stderr.write(resolved.error + '\n');
      return 1;
    }
    const manifestPath = resolved.manifestPath;

    if (ifNeeded || checkOnly) {
      // Inspect the workspace and decide if this pack is stale.
      const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
      const sigReport = buildPackSignatureStatusReport(inspection);
      const matching = sigReport.packs.find(
        (p) =>
          p.packageRoot === nodePath.dirname(manifestPath) ||
          p.packageRoot.endsWith(nodePath.dirname(input)) ||
          manifestPath.startsWith(p.packageRoot),
      );
      const status = matching?.status ?? 'unknown';
      if (checkOnly) {
        if (flagBool(args, 'json')) {
          process.stdout.write(asJson({ checkOnly: true, status, secretAvailable: haveSecret, pack: matching ?? null }) + '\n');
        } else {
          process.stdout.write(`pack status: ${status}\n`);
          if (matching?.reason) process.stdout.write(`reason:      ${matching.reason}\n`);
          process.stdout.write(`secret env:  ${haveSecret ? 'set' : 'NOT set'}\n`);
        }
        // Exit 0 only if the pack is "present"; otherwise non-zero.
        return status === 'present' ? 0 : 1;
      }
      if (ifNeeded && status === 'present') {
        if (flagBool(args, 'json')) {
          process.stdout.write(asJson({ skipped: true, reason: 'signature is current', status }) + '\n');
        } else {
          process.stdout.write(`Skipping sign: signature is current (status=${status}).\n`);
        }
        return 0;
      }
      if (ifNeeded && !haveSecret) {
        // Honest fallback: report and offer the TODO write.
        const todo = `Pack signature for ${input} is ${status}. Re-sign with:\n  ${PACK_SECRET_ENV}=<secret> shrk packs sign ${input}\n`;
        if (writeTodo) {
          const cwd = resolveCwd(args);
          const dir = nodePath.join(cwd, '.sharkcraft', 'reports');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const out = nodePath.join(dir, `pack-sign-todo-${nodePath.basename(input)}.md`);
          writeFileSync(out, `# Pack signing TODO\n\n${todo}\n`, 'utf8');
          process.stdout.write(`Wrote signing TODO: ${out}\n`);
        }
        if (flagBool(args, 'json')) {
          process.stdout.write(asJson({ skipped: true, reason: 'secret not available', status, todo }) + '\n');
        } else {
          process.stdout.write(`Cannot sign — ${PACK_SECRET_ENV} not set. Status: ${status}.\n`);
          process.stdout.write(todo);
        }
        return 1;
      }
      // Otherwise fall through to the actual sign path.
    }

    let manifest: ISharkCraftPackManifest;
    try {
      manifest = await loadManifestFromPath(manifestPath);
    } catch (e) {
      process.stderr.write(`Failed to load manifest: ${(e as Error).message}\n`);
      return 1;
    }

    const valid = validatePackManifest(manifest);
    if (!valid.valid) {
      process.stderr.write(
        `Refusing to sign: manifest is structurally invalid (${valid.issues
          .map((i) => i.field)
          .join(', ')})\n`,
      );
      return 1;
    }
    const secret = flagString(args, 'secret');
    const keyId = flagString(args, 'key-id');
    const dev = flagBool(args, 'dev');
    // Record what was signed — sha256 of every contribution file (and each
    // compiled artifact's mapped source) — with the ONE digest function pack
    // freshness compares against. Freshness is content divergence, never age.
    const contentDigests = computePackContentDigests(findPackRoot(manifestPath), manifest);
    const result = signPackManifest(manifest, {
      ...(secret !== undefined ? { secret } : {}),
      ...(keyId !== undefined ? { keyId } : {}),
      ...(dev ? { dev: true } : {}),
      contentDigests,
    });
    if (!result.ok) {
      process.stderr.write(result.message + '\n');
      return 1;
    }
    const outArg = flagString(args, 'output') ?? flagString(args, 'out');
    const outPath = outArg
      ? nodePath.resolve(outArg)
      : nodePath
          .join(
            nodePath.dirname(manifestPath),
            nodePath.basename(manifestPath).replace(/\.(ts|js|json)$/i, ''),
          )
          .concat('.signed.json');
    writeFileSync(outPath, JSON.stringify(result.manifest, null, 2) + '\n', 'utf8');

    // Optional post-sign verification.
    let verifyOutcome: 'verified' | 'failed' | 'skipped' = 'skipped';
    let verifyMessage = '';
    if (flagBool(args, 'verify-after-sign')) {
      const v = verifyPackManifest(result.manifest, {
        ...(secret !== undefined ? { secret } : {}),
      });
      verifyOutcome = v.ok ? 'verified' : 'failed';
      verifyMessage = v.ok ? 'Signature verified.' : v.message;
    }

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          source: manifestPath,
          outPath,
          signature: result.signature,
          verifyOutcome,
          verifyMessage,
        }) + '\n',
      );
      return verifyOutcome === 'failed' ? 1 : 0;
    }
    process.stdout.write(header('Pack manifest signed'));
    process.stdout.write(kv('source', manifestPath) + '\n');
    process.stdout.write(kv('output', outPath) + '\n');
    process.stdout.write(kv('algo', result.signature.algo) + '\n');
    process.stdout.write(kv('signed at', result.signature.signedAt) + '\n');
    process.stdout.write(
      kv('content digests', `${Object.keys(result.signature.contentDigests ?? {}).length} file(s) recorded`) + '\n',
    );
    if (result.signature.keyId) process.stdout.write(kv('key id', result.signature.keyId) + '\n');
    if (verifyOutcome !== 'skipped') {
      process.stdout.write(
        kv('verify-after-sign', `${verifyOutcome}${verifyMessage ? ` (${verifyMessage})` : ''}`) +
          '\n',
      );
    }
    process.stdout.write(`\n${result.signature.hmac}\n`);
    process.stdout.write(
      `\nHow to consume:\n  1. Ship ${nodePath.basename(outPath)} alongside the pack (or replace package.json sharkcraft.manifest with the .signed.json path).\n  2. Set SHARKCRAFT_PACK_SECRET on the consumer machine and run \`shrk packs verify\`.\n`,
    );
    return verifyOutcome === 'failed' ? 1 : 0;
  },
};

export const packsReleaseCheckCommand: ICommandHandler = {
  name: 'release-check',
  description:
    'Run a deterministic release-readiness check on a pack: manifest validation, contribution loading, signature, files whitelist. `--typecheck` also type-checks the pack\'s TS assets (exit 2 when no TS file could be checked).',
  usage: 'shrk packs release-check <path-to-pack> [--typecheck] [--json]',
  booleanFlags: new Set(['typecheck', 'json']),
  async run(args: ParsedArgs): Promise<number> {
    const target = args.positional[0];
    if (!target) {
      process.stderr.write('Usage: shrk packs release-check <path-to-pack>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const abs = nodePath.isAbsolute(target) ? target : nodePath.resolve(cwd, target);
    const typecheck = flagBool(args, 'typecheck');
    const result = await runPackReleaseCheck(abs, { typecheck });
    const coverage: IVerdictCoverage[] =
      typecheck && result.typecheck
        ? [
            {
              unit: 'TS files',
              expected: result.typecheck.checkedFiles,
              examined: result.typecheck.ran ? result.typecheck.checkedFiles : 0,
              ...(result.typecheck.note ? { reason: result.typecheck.note } : {}),
            },
          ]
        : [];
    const settled = settleVerdict(result.passed ? 0 : 1, coverage);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          ...result,
          // The settled verdict: a --typecheck that checked nothing (exit 2)
          // is not `passed`, whatever the findings list says.
          passed: settled.exit === 0,
          exitCode: settled.exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
        }) + '\n',
      );
      return settled.exit;
    }
    process.stdout.write(header(`Pack release check`));
    process.stdout.write(kv('pack', result.packPath) + '\n');
    process.stdout.write(kv('manifest', result.manifestFile ?? '(none)') + '\n');
    process.stdout.write(kv('contributions', String(result.contributionsFound)) + '\n');
    if (result.typecheck) {
      process.stdout.write(
        kv('typecheck', `${result.typecheck.ran ? result.typecheck.checkedFiles : 0} TS file(s) checked, ${result.typecheck.errors} error(s)`) + '\n',
      );
    }
    process.stdout.write(kv('passed', String(settled.exit === 0)) + '\n\n');
    if (result.findings.length === 0) {
      const line = verdictLine(settled, 'No issues.');
      if (line) process.stdout.write(line + '\n');
      return settled.exit;
    }
    for (const f of result.findings) {
      process.stdout.write(`  ${f.severity.toUpperCase().padEnd(8)} ${f.code.padEnd(28)} ${f.message}\n`);
      if (f.file) process.stdout.write(`         file: ${f.file}\n`);
      if (f.suggestedFix) process.stdout.write(`         fix: ${f.suggestedFix}\n`);
      if (f.suggestedCommand) process.stdout.write(`         $ ${f.suggestedCommand}\n`);
    }
    const line = verdictLine(settled, '');
    if (line) process.stdout.write(`\n${line}\n`);
    return settled.exit;
  },
};

export const packsCompatCommand: ICommandHandler = {
  name: 'compat',
  description:
    'Inspect a pack\'s plugin-api symbol compatibility. Resolves the consumer\'s installed @shrkcrft/plugin-api and diffs against the pack\'s imports. Surfaces both helper-missing import errors (from release-check) and symbol-level diffs.',
  usage:
    'shrk packs compat <path-to-pack> [--consumer-root <path>] [--dist-aware] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const target = args.positional[0];
    if (!target) {
      process.stderr.write('Usage: shrk packs compat <path-to-pack> [--consumer-root <path>] [--dist-aware]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const abs = nodePath.isAbsolute(target) ? target : nodePath.resolve(cwd, target);
    const consumerRootRaw = flagString(args, 'consumer-root');
    const consumerRoot = consumerRootRaw
      ? nodePath.isAbsolute(consumerRootRaw)
        ? consumerRootRaw
        : nodePath.resolve(cwd, consumerRootRaw)
      : null;
    const distAware = flagBool(args, 'dist-aware');
    // Run a release-check first; surfaces helper-missing diagnostics.
    const release = await runPackReleaseCheck(abs);
    const helperMissing = release.findings.filter((f) => f.code === 'contribution-helper-missing');
    // Symbol-level diff against the consumer's installed plugin-api.
    const symbol = checkPackSymbolCompat({ packPath: abs, consumerRoot, distAware });
    const passed = helperMissing.length === 0 && symbol.compatible;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.pack-compat-check/v1',
          pack: release.packPath,
          manifest: release.manifestFile,
          consumerRoot,
          helperMissing: helperMissing.map((f) => ({
            file: f.file,
            message: f.message,
            suggestedFix: f.suggestedFix,
            suggestedCommand: f.suggestedCommand,
          })),
          symbolCompat: symbol,
          passed,
        }) + '\n',
      );
      return passed ? 0 : 1;
    }
    process.stdout.write(header('Pack compatibility'));
    process.stdout.write(kv('pack', release.packPath) + '\n');
    process.stdout.write(kv('consumer root', consumerRoot ?? '(not specified)') + '\n');
    process.stdout.write(kv('plugin-api source', symbol.pluginApiSource ?? '(not found)') + '\n');
    process.stdout.write(kv('plugin-api resolution', symbol.pluginApiResolution) + '\n');
    process.stdout.write(kv('available symbols', String(symbol.availableSymbols.length)) + '\n');
    process.stdout.write(kv('source mode', symbol.sourceMode) + '\n');
    process.stdout.write(kv('confidence', symbol.confidence) + '\n');
    process.stdout.write(kv('files inspected', String(symbol.filesInspected.length)) + '\n');
    process.stdout.write(kv('helper-missing findings', String(helperMissing.length)) + '\n');
    process.stdout.write(kv('missing symbols', String(symbol.missingSymbols.length)) + '\n\n');
    if (helperMissing.length === 0 && symbol.missingSymbols.length === 0) {
      process.stdout.write('No backwards-compatibility issues detected.\n');
      if (symbol.suggestions.length > 0) {
        for (const s of symbol.suggestions) process.stdout.write(`  note: ${s}\n`);
      }
      return 0;
    }
    if (helperMissing.length > 0) {
      process.stdout.write('Helper-missing import errors:\n');
      for (const f of helperMissing) {
        process.stdout.write(`  ${f.message}\n`);
        if (f.suggestedFix) process.stdout.write(`    fix: ${f.suggestedFix}\n`);
        if (f.suggestedCommand) process.stdout.write(`    $   ${f.suggestedCommand}\n`);
      }
    }
    if (symbol.missingSymbols.length > 0) {
      process.stdout.write('\nMissing plugin-api symbols:\n');
      for (const f of symbol.findings.filter((x) => x.status === 'missing')) {
        process.stdout.write(`  - ${f.symbol}\n`);
        for (const file of f.files.slice(0, 5)) process.stdout.write(`      used in ${file}\n`);
      }
      process.stdout.write('\nSuggested fixes:\n');
      for (const s of symbol.suggestions) process.stdout.write(`  ${s}\n`);
    }
    return 1;
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Pack-author developer UX
// ──────────────────────────────────────────────────────────────────────────

export const packsDevStatusCommand: ICommandHandler = {
  name: 'dev-status',
  description:
    'Inspect a pack under development: how the consumer sees it, signed-manifest staleness, contribution counts. Read-only.',
  usage: 'shrk packs dev-status <packPath> [--consumer <repo>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const { buildPackDevStatus, renderPackDevStatusText } = await import('@shrkcrft/inspector');
    const packPath = args.positional[0];
    if (!packPath) {
      process.stderr.write('Usage: shrk packs dev-status <packPath>\n');
      return 2;
    }
    const consumer = flagString(args, 'consumer');
    const abs = nodePath.isAbsolute(packPath) ? packPath : nodePath.resolve(resolveCwd(args), packPath);
    const consumerAbs = consumer
      ? (nodePath.isAbsolute(consumer) ? consumer : nodePath.resolve(resolveCwd(args), consumer))
      : undefined;
    const status = await buildPackDevStatus({
      packPath: abs,
      ...(consumerAbs ? { consumerPath: consumerAbs } : {}),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(status) + '\n');
      return 0;
    }
    process.stdout.write(renderPackDevStatusText(status));
    return 0;
  },
};

export const packsWatchCommand: ICommandHandler = {
  name: 'watch',
  description:
    'Watch pack assets and re-run pack doctor on change. Never auto-signs; signing remains explicit.',
  usage: 'shrk packs watch <packPath> [--cwd <consumer>] [--command <cmd>] [--debounce <ms>] [--dry-run]',
  async run(args: ParsedArgs): Promise<number> {
    const { planPackWatchCommand } = await import('@shrkcrft/inspector');
    const packPath = args.positional[0];
    if (!packPath) {
      process.stderr.write('Usage: shrk packs watch <packPath>\n');
      return 2;
    }
    const abs = nodePath.isAbsolute(packPath) ? packPath : nodePath.resolve(resolveCwd(args), packPath);
    const command = flagString(args, 'command');
    const debounceStr = flagString(args, 'debounce');
    const debounceMs = debounceStr ? Number(debounceStr) : undefined;
    const consumer = flagString(args, 'consumer');
    const plan = planPackWatchCommand({
      packPath: abs,
      ...(consumer ? { consumerPath: consumer } : {}),
      ...(command ? { command } : {}),
      ...(debounceMs ? { debounceMs } : {}),
    });
    if (flagBool(args, 'dry-run')) {
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(plan) + '\n');
        return 0;
      }
      process.stdout.write('=== Pack watch plan ===\n');
      process.stdout.write(kv('pack', plan.packPath) + '\n');
      if (plan.consumerPath) process.stdout.write(kv('consumer', plan.consumerPath) + '\n');
      process.stdout.write(kv('command', plan.command) + '\n');
      process.stdout.write(kv('debounceMs', String(plan.debounceMs)) + '\n');
      process.stdout.write('Globs:\n');
      for (const g of plan.globs) process.stdout.write(`  • ${g}\n`);
      process.stdout.write('\nDry-run: no watcher started, no commands executed.\n');
      return 0;
    }
    // Live watcher mode — uses fs.watch with debouncing.
    const fs = await import('node:fs');
    const child = await import('node:child_process');
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    const trigger = (): void => {
      if (running) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        running = true;
        process.stdout.write(`[watch] running: ${plan.command}\n`);
        const r = child.spawnSync('bash', ['-lc', plan.command], {
          cwd: abs,
          stdio: 'inherit',
        });
        running = false;
        process.stdout.write(`[watch] exit ${r.status ?? 0}; waiting for next change.\n`);
      }, plan.debounceMs);
    };
    const watchRoots = [
      nodePath.join(abs, 'src', 'assets'),
      nodePath.join(abs, 'package.json'),
      nodePath.join(abs, 'manifest.json'),
      nodePath.join(abs, 'README.md'),
    ];
    for (const root of watchRoots) {
      if (!fs.existsSync(root)) continue;
      try {
        fs.watch(root, { recursive: true }, trigger);
      } catch {
        try {
          fs.watch(root, trigger);
        } catch {
          /* ignore */
        }
      }
    }
    process.stdout.write(`[watch] running. ctrl+c to stop.\n`);
    trigger();
    return await new Promise<number>(() => undefined);
  },
};
