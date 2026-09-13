import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as nodePathJoin, resolve as nodePathResolve } from 'node:path';
import {
  buildAnchorUpdatePlan,
  buildKnowledgeRefResolver,
  buildKnowledgeStaleReport,
  buildRenameFilePlan,
  buildRenameSymbolPlan,
  ContributionKind,
  describeInspectionDiscovery,
  inspectSharkcraft,
  KnowledgeAdvisoryCode,
  KnowledgeEntryVerdict,
  ReferenceAssetKind,
  ReferenceCheckOutcome,
  resolveChangedFiles,
  type IChangedScopeOptions,
  type IInspectionDiscovery,
  type IKnowledgeStaleReport,
} from '@shrkcrft/inspector';
import {
  ALL_KNOWLEDGE_TYPES,
  formatEntryCompact,
  formatEntryFull,
  formatKnowledgeReference,
  isKnowledgeType,
  isValidVerifiedOn,
  parseStaleAfterDays,
  projectKnowledgeEntryForJson,
  searchKnowledge,
  type IKnowledgeEntry,
} from '@shrkcrft/knowledge';
import { writeRejectedEntriesNote } from '../output/rejected-entries-note.ts';

/** Every contribution kind the knowledge loader reads (knowledge, rules, paths, docs). */
const KNOWLEDGE_FAMILY_KINDS = [
  ContributionKind.Knowledge,
  ContributionKind.Rule,
  ContributionKind.Path,
  ContributionKind.PathConvention,
  ContributionKind.Docs,
] as const;
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  requireInputSelector,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';
import { renderFailureHints, staleKnowledgeHints } from '../output/failure-hints.ts';
import { ExitCode } from '../exit-codes.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { buildGateEnvelope, type IGateEnvelope } from '../gates/gate-envelope.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import {
  evaluateKnowledgeStaleGate,
  formatPct,
  KNOWLEDGE_FAIL_ON_CATEGORIES,
  knowledgeStaleGateInput,
  knowledgeStaleWindowProblem,
  parseMinReferenced,
} from '../knowledge/knowledge-stale-gate.ts';

/** What `knowledge stale-check --json` / `--report` / `--format markdown|html` render from. */
interface IStaleCheckCiPayload extends IKnowledgeStaleReport {
  ci: {
    ci: boolean;
    strict: boolean;
    failOn: readonly string[];
    requiredStale: number;
    requiredMissing: number;
    totalRequiredFailing: number;
    /** The SETTLED exit is non-zero — a failure or a not-verified run. */
    exitNonZero: boolean;
    exitReason?: string;
    minReferenced?: number;
    requireReferences: boolean;
  };
  baselineComparison?: {
    baseline: string;
    newStale: number;
    newMissing: number;
    resolved: number;
  };
  /** Where discovery landed — named by the refusal when 0 entries loaded. */
  discovery: IInspectionDiscovery;
  exitCode: number;
  gate: IGateEnvelope;
}

/** Unverifiable ids shown in text / markdown before the rest are summarised. */
const UNVERIFIABLE_SHOWN = 50;

/**
 * The three buckets, with the unverifiable share — on the line where a bare
 * `0 stale` used to sit, so a corpus checked a quarter of the way can never
 * summarise as healthy.
 */
function bucketLine(r: IKnowledgeStaleReport): string {
  const c = r.coverage;
  const pct = c.entriesInScope > 0 ? formatPct(c.unverifiable / c.entriesInScope) : '0%';
  return `entries in scope: ${c.entriesInScope} · verified: ${c.verified} · stale: ${c.stale} · unverifiable: ${c.unverifiable} (${pct})`;
}

/** Unverifiable entry ids grouped by the file that declares them — the file to edit. */
function unverifiableGroups(r: IKnowledgeStaleReport): { source: string; ids: string[] }[] {
  const by = new Map<string, string[]>();
  for (const v of r.entryVerdicts) {
    if (v.verdict !== KnowledgeEntryVerdict.Unverifiable) continue;
    const list = by.get(v.source) ?? [];
    list.push(v.entryId);
    by.set(v.source, list);
  }
  return [...by.entries()].map(([source, ids]) => ({ source, ids }));
}

/** `sharkcraft/rules.ts (7): a, b, …` lines, capped across groups. */
function unverifiableLines(r: IKnowledgeStaleReport, indent: string): string[] {
  const out: string[] = [];
  let shown = 0;
  for (const g of unverifiableGroups(r)) {
    const room = UNVERIFIABLE_SHOWN - shown;
    if (room <= 0) break;
    const ids = g.ids.slice(0, room);
    shown += ids.length;
    out.push(`${indent}${g.source} (${g.ids.length}): ${ids.join(', ')}${ids.length < g.ids.length ? ', …' : ''}`);
  }
  const rest = r.unverifiableIds.length - shown;
  if (rest > 0) out.push(`${indent}… ${rest} more (--json for all)`);
  return out;
}

/** Load failures listed in text / markdown before the rest are summarised. */
const LOAD_FAILURES_SHOWN = 50;

/**
 * `LOAD FAILED (N)` — the knowledge-bearing files whose entries never reached
 * the corpus. Printed at ANY corpus size: a clean sweep of the rest is not a
 * verdict over these.
 */
function loadFailureLines(d: IInspectionDiscovery, indent: string): string[] {
  const failed = d.knowledgeLoadFailures;
  if (failed.length === 0) return [];
  const out = [
    `LOAD FAILED (${failed.length} of ${Math.max(d.knowledgeFilesAttempted, failed.length)} knowledge files) — their entries were never checked:`,
  ];
  for (const f of failed.slice(0, LOAD_FAILURES_SHOWN)) {
    out.push(
      `${indent}${f.status.toUpperCase().padEnd(14)}${f.kind.padEnd(10)}${f.file}${f.packName ? ` (pack ${f.packName})` : ''} — ${f.message}`,
    );
  }
  if (failed.length > LOAD_FAILURES_SHOWN) out.push(`${indent}… ${failed.length - LOAD_FAILURES_SHOWN} more (--json for all)`);
  out.push('');
  return out;
}

/**
 * The per-kind table. A kind the sweep never visited says so in words — a row
 * of zeros cannot tell "clean" from "never looked".
 */
function kindTableLines(r: IKnowledgeStaleReport): string[] {
  const cols = (b: IKnowledgeStaleReport['byAssetKind'][ReferenceAssetKind]): string =>
    [b.scanned, b.zeroReferences, b.referencesChecked, b.verified, b.stale, b.unverifiable]
      .map((n, i) => String(n).padStart(i === 0 ? 7 : i === 1 ? 10 : i === 2 ? 5 : i === 3 ? 9 : i === 4 ? 6 : 13))
      .join('');
  const row = (label: string, b: IKnowledgeStaleReport['byAssetKind'][ReferenceAssetKind], empty: string): string =>
    b.scanned === 0 ? `  ${label.padEnd(22)}${empty}` : `  ${label.padEnd(22)}${cols(b)}`;
  const lines = [`  ${'kind'.padEnd(22)}scanned zero-refs refs verified stale unverifiable`];
  lines.push(row('knowledge', r.byAssetKind[ReferenceAssetKind.Knowledge], 'none in scope'));
  for (const type of Object.keys(r.byEntryType).sort()) {
    lines.push(row(`  type:${type}`, r.byEntryType[type]!, 'none in scope'));
  }
  lines.push(row('boundary-rule', r.byAssetKind[ReferenceAssetKind.BoundaryRule], 'none declared'));
  lines.push(
    r.policySweep.loaded
      ? row('policy', r.byAssetKind[ReferenceAssetKind.Policy], 'none declared')
      : `  ${'policy'.padEnd(22)}not in sweep (policy registry not loaded)`,
  );
  return lines;
}

function refLabel(c: IKnowledgeStaleReport['referenceChecks'][number]): string {
  return formatKnowledgeReference(c.reference);
}

function renderStaleCheckMarkdown(p: IStaleCheckCiPayload, verdict: string): string {
  const out: string[] = [];
  out.push(`# Knowledge stale-check`);
  out.push('');
  out.push(`- ${bucketLine(p)}`);
  out.push(`- references: ${p.totalReferences}`);
  out.push(`- anchors: ${p.totalAnchors}`);
  out.push(
    `- counts: ok=${p.counts.ok}, stale=${p.counts.stale}, missing=${p.counts.missing}, unknown=${p.counts.unknown}, invalid=${p.counts.invalid}`,
  );
  if (p.ci.ci || p.ci.strict || p.ci.failOn.length > 0) {
    out.push(`- required failing: ${p.ci.totalRequiredFailing} (stale=${p.ci.requiredStale}, missing=${p.ci.requiredMissing})`);
  }
  if (p.baselineComparison) {
    out.push(`- baseline (${p.baselineComparison.baseline}): new-stale=${p.baselineComparison.newStale}, new-missing=${p.baselineComparison.newMissing}, resolved=${p.baselineComparison.resolved}`);
  }
  out.push('');
  out.push('```');
  for (const line of kindTableLines(p)) out.push(line);
  out.push('```');
  const loadFailed = loadFailureLines(p.discovery, '- ').filter((l) => l !== '');
  if (loadFailed.length > 0) {
    out.push('');
    out.push(`## ${loadFailed[0]}`);
    for (const line of loadFailed.slice(1)) out.push(line);
  }
  if (p.coverage.unverifiable > 0) {
    out.push('');
    out.push(`## Unverifiable entries (${p.coverage.unverifiable}) — declare references[]`);
    for (const line of unverifiableLines(p, '- ')) out.push(line);
  }
  out.push('');
  out.push(`## Reference issues`);
  for (const c of [...p.referenceChecks, ...p.assetReferenceChecks]) {
    if (c.outcome === 'ok') continue;
    const req = c.reference.required ? ' **(required)**' : '';
    const kind = c.assetKind ? ` [${c.implicit ? 'implicit ' : ''}${c.assetKind}]` : '';
    out.push(`- **${c.outcome.toUpperCase()}**${req}${kind} \`${c.entryId}\` → \`${refLabel(c)}\` — ${c.message}`);
  }
  out.push('');
  for (const line of verdict.split('\n')) out.push(`> ${line}`);
  out.push('');
  return out.join('\n');
}

function renderStaleCheckHtml(p: IStaleCheckCiPayload, verdict: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const rows: string[] = [];
  for (const c of [...p.referenceChecks, ...p.assetReferenceChecks]) {
    if (c.outcome === 'ok') continue;
    rows.push(
      `<tr><td>${esc(c.outcome.toUpperCase())}</td><td>${c.reference.required ? '✓' : ''}</td><td>${esc(c.entryId)}</td><td>${esc(refLabel(c))}</td><td>${esc(c.message)}</td></tr>`,
    );
  }
  const unverifiable = unverifiableLines(p, '').map((l) => `<li>${esc(l)}</li>`).join('');
  const loadFailedLines = loadFailureLines(p.discovery, '').filter((l) => l !== '');
  const loadFailed =
    loadFailedLines.length > 0
      ? `<h2>${esc(loadFailedLines[0]!)}</h2><ul>${loadFailedLines
          .slice(1)
          .map((l) => `<li>${esc(l)}</li>`)
          .join('')}</ul>`
      : '';
  return `<!doctype html><meta charset="utf-8"><title>Knowledge stale-check</title>
<style>body{font:14px/1.4 sans-serif;margin:1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.25rem .5rem;text-align:left}h1{margin-top:0}</style>
<h1>Knowledge stale-check</h1>
<p>${esc(bucketLine(p))}</p>
<p>references=${p.totalReferences}, anchors=${p.totalAnchors}, ok=${p.counts.ok}, stale=${p.counts.stale}, missing=${p.counts.missing}, unknown=${p.counts.unknown}, invalid=${p.counts.invalid}</p>
<pre>${esc(kindTableLines(p).join('\n'))}</pre>
${loadFailed}
${unverifiable ?`<h2>Unverifiable entries (${p.coverage.unverifiable})</h2><ul>${unverifiable}</ul>` : ''}
<table><thead><tr><th>Outcome</th><th>Required</th><th>Entry</th><th>Reference</th><th>Message</th></tr></thead><tbody>${rows.join('')}</tbody></table>
<p style="font-weight:bold${p.exitCode === 0 ? '' : ';color:#a40000'}">${esc(verdict).replace(/\n/g, '<br>')}</p>
`;
}

/**
 * Validate `--type` filter values against the KnowledgeType vocabulary and
 * reject (exit 2) on any unknown value. Without this a typo'd `--type` would
 * silently filter every entry out and return an empty result with exit 0.
 * Returns the exit code to propagate when a value is unknown, or null when all
 * values are valid (or none were supplied).
 */
function rejectUnknownKnowledgeTypes(types: readonly string[]): number | null {
  const unknown = types.filter((t) => !isKnowledgeType(t));
  if (unknown.length === 0) return null;
  process.stderr.write(
    `Unknown --type ${unknown.join(', ')}. Valid: ${ALL_KNOWLEDGE_TYPES.join(', ')}\n`,
  );
  return 2;
}

export const knowledgeListCommand: ICommandHandler = {
  name: 'list',
  description: 'List knowledge entries.',
  usage: 'shrk knowledge list [--type rule] [--scope x,y] [--top N] [--brief] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const types = flagList(args, 'type');
    const typeReject = rejectUnknownKnowledgeTypes(types);
    if (typeReject !== null) return typeReject;
    const scope = flagList(args, 'scope');

    let entries = inspection.knowledgeEntries;
    if (types.length) entries = entries.filter((e) => types.includes(String(e.type)));
    if (scope.length) entries = entries.filter((e) => scope.some((s) => e.scope.includes(s)));

    // --top N: a deterministic, token-bounded slice. Sort by id first so the
    // "top N" is stable across machines (entries otherwise load in fs-scan
    // order). Reduce at the source instead of piping through `shrk compress`.
    const top = flagNumber(args, 'top');
    if (top !== undefined && top > 0) {
      entries = [...entries].sort((a, b) => a.id.localeCompare(b.id)).slice(0, top);
    }

    if (flagBool(args, 'json')) {
      // --brief: project to the high-signal fields, dropping content / examples
      // / metadata (the bulk of the payload) so an agent pays far fewer tokens.
      const payload = flagBool(args, 'brief')
        ? entries.map((e) => ({
            id: e.id,
            type: e.type,
            priority: e.priority,
            title: e.title,
            scope: e.scope,
            tags: e.tags,
            appliesWhen: e.appliesWhen,
          }))
        : // Project the declared IKnowledgeEntry fields by direct access rather
          // than spreading (`{ ...e }`), which copies only own-enumerable props
          // and would strip pack entries whose fields are getters/non-enumerable.
          entries.map(projectKnowledgeEntryForJson);
      process.stdout.write(asJson(payload) + '\n');
      await writeRejectedEntriesNote(inspection, KNOWLEDGE_FAMILY_KINDS, { json: true, next: 'shrk doctor' });
      return 0;
    }

    if (inspection.knowledgeEntries.length === 0) {
      // A query, not a gate — the exit stays 0 — but an empty corpus is almost
      // always a wrong root, so say where discovery landed (as `knowledge lint`).
      const d = describeInspectionDiscovery(inspection, resolveCwd(args));
      process.stderr.write(
        `WARN  loaded 0 knowledge entries from ${d.resolvedRoot} (sharkcraft/ folder: ${d.sharkcraftDir ?? 'missing'}` +
          `${d.configError !== undefined ? `; config failed to load — ${d.configError}` : ''}).` +
          `${d.configuredAncestor ? ` A configured ancestor exists: rerun with --cwd ${d.configuredAncestor}.` : ''}\n`,
      );
    }
    // A knowledge file that never loaded makes the list PARTIAL — say which.
    const failedLoads = describeInspectionDiscovery(inspection, resolveCwd(args)).knowledgeLoadFailures;
    if (failedLoads.length > 0) {
      process.stderr.write(
        `WARN  ${failedLoads.length} knowledge file(s) never loaded — this list is partial: ${failedLoads
          .map((f) => `${f.file} (${f.status})`)
          .join(', ')}. Run \`shrk doctor\` for the error.\n`,
      );
    }
    process.stdout.write(header(`Knowledge (${entries.length})`));
    for (const e of entries) process.stdout.write(formatEntryCompact(e) + '\n');
    // An array member meant as an entry that the loader refused (no `content`,
    // a reused id) is named (round 12, 12.1) — it used to vanish silently.
    // Load failures are the partial-list WARN above — never said twice.
    await writeRejectedEntriesNote(inspection, KNOWLEDGE_FAMILY_KINDS, { next: 'shrk doctor', loadFailures: false });
    return 0;
  },
};

export const knowledgeGetCommand: ICommandHandler = {
  name: 'get',
  description:
    'Show full content of one knowledge entry. A superseded entry opens with a banner naming its successor (resolved, with its title); `--follow` renders the current entry after it. Cross-reference ids print with the namespace they resolve into.',
  usage: 'shrk knowledge get <id> [--follow] [--json]',
  booleanFlags: new Set(['follow', 'json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk knowledge get <id> [--follow] [--json]\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const entry = inspection.index.get(id);
    if (!entry) {
      process.stderr.write(`No knowledge entry with id "${id}".\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entry) + '\n');
      return 0;
    }
    // Warm first: a construct / playbook id is otherwise NOT VERIFIED, and a
    // successor must be named with the registry that actually holds it.
    await (await import('../surface/cli-command-resolver.ts')).warmCliReferenceRegistries(inspection);
    const resolveRef = buildKnowledgeRefResolver(inspection);
    process.stdout.write(formatEntryFull(entry, { resolveRef }) + '\n');
    if (flagBool(args, 'follow')) {
      const followed = followSupersession(inspection.index, entry, inspection.knowledgeEntries.length);
      if (followed.terminal) {
        process.stdout.write(`\n--- following supersededBy: ${followed.path.join(' → ')} ---\n\n`);
        process.stdout.write(formatEntryFull(followed.terminal, { resolveRef }) + '\n');
      } else {
        process.stderr.write(`--follow: ${followed.reason}\n`);
      }
    }
    return 0;
  },
};

/**
 * Walk `supersededBy` from `entry` to the ONE current entry, cycle-safe and
 * bounded by the corpus size. Refuses (with the reason) on a fork, a successor
 * that is not a knowledge entry, or a cycle — never guesses which branch.
 */
function followSupersession(
  index: { get(id: string): IKnowledgeEntry | null | undefined },
  entry: IKnowledgeEntry,
  bound: number,
): { terminal?: IKnowledgeEntry; path: readonly string[]; reason?: string } {
  const path = [entry.id];
  const seen = new Set<string>(path);
  let cur = entry;
  for (let step = 0; step <= bound; step += 1) {
    const next = (cur.supersededBy ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (next.length === 0) {
      return path.length > 1
        ? { terminal: cur, path }
        : { path, reason: `"${entry.id}" is not superseded — nothing to follow.` };
    }
    if (next.length > 1) {
      return { path, reason: `"${cur.id}" names ${next.length} successors (${next.join(', ')}) — pick one: shrk knowledge get <id>` };
    }
    const successor = index.get(next[0] ?? '');
    if (!successor) return { path, reason: `successor "${next[0]}" of "${cur.id}" is not a knowledge entry.` };
    if (seen.has(successor.id)) {
      return { path: [...path, successor.id], reason: `supersededBy forms a cycle (${[...path, successor.id].join(' → ')}) — no entry in it is current.` };
    }
    seen.add(successor.id);
    path.push(successor.id);
    cur = successor;
  }
  return { path, reason: 'the supersededBy chain is longer than the corpus.' };
}

export const knowledgeSearchCommand: ICommandHandler = {
  name: 'search',
  description: 'Search knowledge by query.',
  usage: 'shrk knowledge search <query> [--type x,y] [--scope x,y] [--limit 10] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    // No query and no filter is "you gave me nothing to search" — a usage
    // error (3), never `Results (0)` at exit 0 (round 11 §1.2#5).
    const noSelector = requireInputSelector(args, {
      flags: ['type', 'scope', 'tag', 'appliesWhen'],
      positional: true,
      usage: 'shrk knowledge search <query> [--type x,y] [--scope x,y] [--limit 10] [--json]',
    });
    if (noSelector !== null) return noSelector;
    const query = args.positional.join(' ').trim();
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const types = flagList(args, 'type');
    const typeReject = rejectUnknownKnowledgeTypes(types);
    if (typeReject !== null) return typeReject;
    const scope = flagList(args, 'scope');
    const tags = flagList(args, 'tag');
    const appliesWhen = flagList(args, 'appliesWhen');
    const limit = flagNumber(args, 'limit') ?? 20;

    const results = searchKnowledge(inspection.knowledgeEntries, {
      query: query.length ? query : undefined,
      types: types.length ? types : undefined,
      scope: scope.length ? scope : undefined,
      tags: tags.length ? tags : undefined,
      appliesWhen: appliesWhen.length ? appliesWhen : undefined,
      limit,
    });

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(results) + '\n');
      return 0;
    }

    process.stdout.write(header(`Results (${results.length})`));
    for (const r of results) {
      process.stdout.write(`[${r.score.toFixed(1)}] ${formatEntryCompact(r.entry)}\n`);
      if (r.reasons.length) {
        const top = r.reasons.slice(0, 3).map((x) => `${x.field}=${x.match}`).join(', ');
        process.stdout.write(`        reasons: ${top}\n`);
      }
    }
    return 0;
  },
};

function readChangedScopeOptionsForKnowledge(
  args: ParsedArgs,
  projectRoot: string,
): IChangedScopeOptions | null {
  const changedOnly = flagBool(args, 'changed-only');
  const since = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const files = flagList(args, 'files');
  if (!changedOnly && !since && !staged && files.length === 0) return null;
  return {
    projectRoot,
    ...(since ? { since } : {}),
    ...(staged ? { staged: true } : {}),
    ...(files.length > 0 ? { files } : {}),
    includeWorktree: changedOnly || !since,
  };
}

/** Boolean flags of the stale-check — none of them may swallow a following token. */
const STALE_CHECK_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'ci',
  'strict',
  'report',
  'changed-only',
  'staged',
  'watch',
  'once',
  'require-references',
  ALLOW_EMPTY_FLAG,
]);

const STALE_CHECK_USAGE =
  'shrk knowledge stale-check [--changed-only|--since <ref>|--staged|--files a,b,c] [--ci] [--strict] [--fail-on <category,...>] [--min-referenced <ratio|NN%>] [--require-references] [--allow-empty] [--stale-after <Nd|Nw|Nm|Ny> [--as-of YYYY-MM-DD]] [--baseline <file>] [--report] [--format text|markdown|html|json] [--output <path>] [--json] [--watch [--once] [--debounce N]]';

export const knowledgeStaleCheckCommand: ICommandHandler = {
  name: 'stale-check',
  description:
    'Verify every knowledge entry against the workspace in three buckets — verified / stale / UNVERIFIABLE (no checkable reference). Strict by default: any unverifiable entry keeps the run at exit 2 unless accepted (--min-referenced). CI flags and `--watch [--once] [--debounce N]` supported. Read-only.',
  usage: STALE_CHECK_USAGE,
  booleanFlags: STALE_CHECK_BOOLEAN_FLAGS,
  async run(args: ParsedArgs): Promise<number> {
    return runStaleCheck(args, 'knowledge stale-check');
  },
};

async function runStaleCheck(args: ParsedArgs, verb: string): Promise<number> {
  const impl = (a: ParsedArgs): Promise<number> => knowledgeStaleCheckImpl(a, verb);
  const watchExit = await maybeRunInWatchMode(args, impl);
  if (watchExit !== null) return watchExit;
  return impl(args);
}

/** A malformed invocation: `3` (the gate never started) with the usage line. */
function staleCheckUsageError(message: string): number {
  process.stderr.write(`${message}\nUsage: ${STALE_CHECK_USAGE}\n`);
  return ExitCode.UsageError;
}

async function knowledgeStaleCheckImpl(args: ParsedArgs, verb: string): Promise<number> {
    const cwd = resolveCwd(args);

    // ── Validate the request first: a bad flag value is `3`, never a verdict. ──
    const failOnFlag = args.flags.get('fail-on');
    if (failOnFlag === true) {
      return staleCheckUsageError(`--fail-on needs a value: ${KNOWLEDGE_FAIL_ON_CATEGORIES.join(', ')}.`);
    }
    const failOnList = (typeof failOnFlag === 'string' ? failOnFlag : '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknownFailOn = failOnList.filter((c) => !KNOWLEDGE_FAIL_ON_CATEGORIES.includes(c));
    if (unknownFailOn.length > 0) {
      return staleCheckUsageError(
        `Unknown --fail-on value(s): ${unknownFailOn.join(', ')}. Valid: ${KNOWLEDGE_FAIL_ON_CATEGORIES.join(', ')}.`,
      );
    }
    const minFlag = args.flags.get('min-referenced');
    let minReferenced: { ratio: number; acceptedBy: string } | undefined;
    if (minFlag !== undefined) {
      const ratio = typeof minFlag === 'string' ? parseMinReferenced(minFlag) : null;
      if (ratio === null) {
        return staleCheckUsageError(
          `--min-referenced takes a ratio 0..1 or a percentage (0.8, 80%) — got ${JSON.stringify(minFlag)}.`,
        );
      }
      minReferenced = { ratio, acceptedBy: `--min-referenced ${minFlag}` };
    }
    const staleAfterFlag = args.flags.get('stale-after');
    let staleAfterDays: number | undefined;
    if (staleAfterFlag !== undefined) {
      const days = typeof staleAfterFlag === 'string' ? parseStaleAfterDays(staleAfterFlag) : null;
      if (days === null) {
        return staleCheckUsageError(
          `--stale-after takes a duration such as 90d, 12w, 6m or 1y — got ${JSON.stringify(staleAfterFlag)}.`,
        );
      }
      staleAfterDays = days;
    }
    const asOfFlag = args.flags.get('as-of');
    if (asOfFlag !== undefined && (typeof asOfFlag !== 'string' || !isValidVerifiedOn(asOfFlag))) {
      return staleCheckUsageError(`--as-of takes a date written YYYY-MM-DD — got ${JSON.stringify(asOfFlag)}.`);
    }
    const asOf = typeof asOfFlag === 'string' ? asOfFlag : undefined;
    // A category that can never fire is a malformed request (the `--fail-on
    // bogus` class): `aged` / `--as-of` measure against a --stale-after window.
    // (The same check runs again below over `knowledgeCheck.failOn`.)
    const windowProblem = knowledgeStaleWindowProblem(new Set(failOnList), false, staleAfterDays, asOf);
    if (windowProblem) return staleCheckUsageError(windowProblem);

    const inspection = await inspectSharkcraft({ cwd });
    // `command` references resolve against the live command index — injected
    // here; without it they are NOT VERIFIED (never "Command available").
    // The same call warms every async-filled registry (playbook / policy /
    // construct / helper) before anything resolves.
    await (await import('../surface/cli-command-resolver.ts')).warmCliReferenceRegistries(inspection);
    const scopeOpts = readChangedScopeOptionsForKnowledge(args, cwd);
    const changedFiles = scopeOpts ? resolveChangedFiles(scopeOpts).files : undefined;
    const report = buildKnowledgeStaleReport(inspection, {
      ...(changedFiles ? { changedFiles } : {}),
      ...(staleAfterDays !== undefined ? { staleAfterDays } : {}),
      ...(asOf ? { asOf } : {}),
    });

    // CI/preflight flags, folded over the config's `knowledgeCheck` block by
    // THE input builder — `shrk quality` and release readiness build theirs
    // there too, so a config-only request is one verdict on all three.
    const discovery = describeInspectionDiscovery(inspection, cwd);
    const gateInput = knowledgeStaleGateInput({
      flags: {
        ci: flagBool(args, 'ci'),
        strict: flagBool(args, 'strict'),
        failOn: failOnList,
        ...(minReferenced ? { minReferenced } : {}),
        requireReferences: flagBool(args, 'require-references'),
        emptyAcceptance: allowEmptyValve(args, report.coverage.entriesInScope),
        ...(staleAfterDays !== undefined ? { staleAfterDays } : {}),
        ...(asOf ? { asOf } : {}),
      },
      knowledgeCheck: inspection.config?.knowledgeCheck,
      discovery,
      scoped: changedFiles !== undefined,
    });
    // `knowledgeCheck.failOn: ['aged']` with no --stale-after window: a
    // category that can never fire is a malformed request, never a verdict.
    if (gateInput.usageProblem) return staleCheckUsageError(gateInput.usageProblem);
    const ci = gateInput.ci;
    const strict = gateInput.strict;
    const effectiveFailOn = [...gateInput.failOn];
    const requireReferences = gateInput.requireReferences;
    const baselineFile = flagString(args, 'baseline');
    const wantReport = flagBool(args, 'report');
    const formatRaw = (flagString(args, 'format') ?? '').toLowerCase();
    const wantJson = flagBool(args, 'json') || formatRaw === 'json';
    const wantMarkdown = formatRaw === 'markdown' || formatRaw === 'md';
    const wantHtml = formatRaw === 'html';
    const output = flagString(args, 'output');

    // ── Settle first, render second. ──
    const gate = evaluateKnowledgeStaleGate(report, gateInput);
    const env = buildGateEnvelope(verb, gate.proposed, gate.rules, gate.runCoverage);
    const exit = env.exit;
    const { verified, entriesInScope } = report.coverage;
    // Round 13: the ✓ line never contradicts a STALE row printed above it — a
    // failing reference this mode waives (`required: false` under --ci, …) is
    // named here and printed as an acceptance below it.
    const entriesVerified = `${verified} of ${entriesInScope} knowledge ${entriesInScope === 1 ? 'entry' : 'entries'} verified`;
    const verdict = verdictLine(
      env,
      gate.waived > 0
        ? `${entriesVerified} — ${gate.waived} failing reference(s) listed above do not block this mode (accepted below). ✓`
        : `${entriesVerified} — no stale or missing references. ✓`,
      exit === ExitCode.NotVerified ? gate.notVerifiedLead : undefined,
    );
    const requiredStale = gate.requiredStale;
    const requiredMissing = gate.requiredMissing;
    const totalRequiredFailing = requiredStale + requiredMissing;
    const exitReason =
      gate.reasons.length > 0
        ? gate.reasons.join('; ')
        : exit === ExitCode.NotVerified
          ? `not verified — ${env.shortfalls[0] ?? 'nothing was proved'}`
          : undefined;

    // Baseline comparison (informational).
    let baselineComparison: {
      baseline: string;
      newStale: number;
      newMissing: number;
      resolved: number;
    } | undefined;
    if (baselineFile) {
      const baselineAbs = nodePathResolve(cwd, baselineFile);
      if (existsSync(baselineAbs)) {
        try {
          const prev = JSON.parse(readFileSync(baselineAbs, 'utf8')) as {
            referenceChecks?: readonly { entryId: string; reference: { path?: string; symbol?: string; id?: string }; outcome: string }[];
          };
          const prevKey = (rc: { entryId: string; reference: { path?: string; symbol?: string; id?: string } }) =>
            `${rc.entryId}|${rc.reference.path ?? rc.reference.symbol ?? rc.reference.id ?? ''}`;
          const prevFailing = new Map<string, string>();
          for (const rc of prev.referenceChecks ?? []) {
            if (rc.outcome === 'stale' || rc.outcome === 'missing') {
              prevFailing.set(prevKey(rc), rc.outcome);
            }
          }
          let newStale = 0;
          let newMissing = 0;
          let resolved = 0;
          const currentKeys = new Set<string>();
          for (const rc of report.referenceChecks) {
            const k = prevKey(rc);
            currentKeys.add(k);
            if (
              (rc.outcome === ReferenceCheckOutcome.Stale ||
                rc.outcome === ReferenceCheckOutcome.Missing) &&
              !prevFailing.has(k)
            ) {
              if (rc.outcome === ReferenceCheckOutcome.Stale) newStale++;
              else newMissing++;
            }
          }
          for (const [k] of prevFailing) {
            // Resolved = was failing, now ok or not present.
            const cur = report.referenceChecks.find(
              (rc) => prevKey(rc) === k,
            );
            if (!cur || cur.outcome === ReferenceCheckOutcome.Ok) resolved++;
            void currentKeys;
          }
          baselineComparison = {
            baseline: baselineAbs,
            newStale,
            newMissing,
            resolved,
          };
        } catch (e) {
          process.stderr.write(`Baseline read failed: ${(e as Error).message}\n`);
        }
      } else {
        process.stderr.write(`Baseline file not found: ${baselineAbs}\n`);
      }
    }

    // Build the structured payload (always built, even for text output).
    const ciPayload: IStaleCheckCiPayload = {
      ...report,
      ci: {
        ci,
        strict,
        // The EFFECTIVE categories (a --fail-on flag, else knowledgeCheck.failOn).
        failOn: effectiveFailOn,
        requiredStale,
        requiredMissing,
        totalRequiredFailing,
        exitNonZero: exit !== ExitCode.VerifiedPass,
        ...(exitReason ? { exitReason } : {}),
        ...(gateInput.minReferenced ? { minReferenced: gateInput.minReferenced.ratio } : {}),
        requireReferences,
      },
      ...(baselineComparison ? { baselineComparison } : {}),
      discovery,
      exitCode: exit,
      gate: env,
    };

    // Optional report file.
    if (wantReport || output) {
      const reportsDir = nodePathJoin(cwd, '.sharkcraft', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const defaultPath = nodePathJoin(reportsDir, `knowledge-stale-${ts}.json`);
      const outPath = output
        ? nodePathResolve(cwd, output)
        : defaultPath;
      writeFileSync(outPath, JSON.stringify(ciPayload, null, 2), 'utf8');
      if (!wantJson && !wantMarkdown && !wantHtml) {
        process.stdout.write(`Wrote report → ${outPath}\n`);
      }
    }

    // Format-specific output — every format returns the SETTLED exit.
    if (wantJson) {
      process.stdout.write(asJson(ciPayload) + '\n');
      return exit;
    }
    if (wantMarkdown) {
      process.stdout.write(renderStaleCheckMarkdown(ciPayload, verdict));
      return exit;
    }
    if (wantHtml) {
      process.stdout.write(renderStaleCheckHtml(ciPayload, verdict));
      return exit;
    }
    writeStaleCheckText(ciPayload, {
      verdict,
      reasons: gate.reasons,
      showRequired: ci || strict || effectiveFailOn.length > 0,
      allowEmptyHint: exit === ExitCode.NotVerified && entriesInScope === 0 && !gate.discoveryFailed,
    });
    return exit;
}

/** Advisories printed in text before the rest are summarised. */
const ADVISORIES_SHOWN = 20;
/** Aged entries printed in text before the rest are summarised. */
const AGED_SHOWN = 50;

function writeStaleCheckText(
  p: IStaleCheckCiPayload,
  o: { verdict: string; reasons: readonly string[]; showRequired: boolean; allowEmptyHint: boolean },
): void {
  const w = (s: string): void => void process.stdout.write(s);
  w(header('Knowledge stale-check'));
  const d = p.discovery;
  if (d.entriesLoaded === 0) {
    // Name where discovery landed, so a wrong root is visible on the screen
    // that refuses to pass.
    w('Loaded 0 knowledge entries.\n');
    w(`  resolved root:       ${d.resolvedRoot}${d.rootMarkers.length > 0 ? ` (${d.rootMarkers.join(', ')})` : ' (no root marker)'}\n`);
    w(`  sharkcraft/ folder:  ${d.sharkcraftDir ?? 'missing'}\n`);
    w(`  config:              ${d.configError !== undefined ? `failed to load — ${d.configError}` : (d.configFile ?? '(none)')}\n`);
    if (d.configuredAncestor) {
      w(`  configured ancestor: ${d.configuredAncestor} — rerun with --cwd ${d.configuredAncestor}\n`);
    }
    w('\n');
  }
  for (const line of loadFailureLines(d, '  ')) w(`${line}\n`);
  w(`${bucketLine(p)}\n`);
  w(
    `references: ${p.totalReferences} · anchors: ${p.totalAnchors} · ok=${p.counts.ok} stale=${p.counts.stale} missing=${p.counts.missing} unknown=${p.counts.unknown} invalid=${p.counts.invalid}\n`,
  );
  const failures = Object.entries(p.failureCounts).filter(([, n]) => n > 0);
  if (failures.length > 0) w(`failures: ${failures.map(([k, n]) => `${k}=${n}`).join(' ')}\n`);
  if (p.entriesInScope !== p.entries) {
    w(`scope: ${p.entriesInScope} of ${p.entries} entries reference the changed files\n`);
  }
  if (o.showRequired) {
    w(`required: stale=${p.ci.requiredStale} missing=${p.ci.requiredMissing} (total failing: ${p.ci.totalRequiredFailing})\n`);
  }
  if (p.baselineComparison) {
    w(
      `baseline: new-stale=${p.baselineComparison.newStale} new-missing=${p.baselineComparison.newMissing} resolved=${p.baselineComparison.resolved}\n`,
    );
  }
  if (p.age) {
    w(
      `verifiedOn: ${p.age.aged.length} older than ${p.age.staleAfterDays}d, ${p.age.neverVerified.length} never verified (as of ${p.age.asOf})\n`,
    );
  }
  w('\n');
  for (const line of kindTableLines(p)) w(`${line}\n`);
  if (p.coverage.unverifiable > 0) {
    w(`\nUNVERIFIABLE (${p.coverage.unverifiable}) — never checked; declare references[] (or anchors[]):\n`);
    for (const line of unverifiableLines(p, '  ')) w(`${line}\n`);
  }
  const issues = [...p.referenceChecks, ...p.assetReferenceChecks].filter(
    (c) => c.outcome !== ReferenceCheckOutcome.Ok,
  );
  const badAnchors = p.anchorChecks.filter((c) => c.outcome !== ReferenceCheckOutcome.Ok);
  if (issues.length + badAnchors.length > 0) w('\n');
  for (const c of issues) {
    const tag = (c.implicit ? 'IMPLICIT' : c.outcome.toUpperCase()).padEnd(8);
    const req = c.reference.required === true ? '[REQ] ' : '      ';
    const kind = c.assetKind ? `[${c.assetKind}] ` : '';
    w(`  ${tag}${req}${kind}${c.entryId} → ${formatKnowledgeReference(c.reference)} — ${c.message}\n`);
    if (c.expected !== undefined || c.actual !== undefined) {
      w(`           expected: ${String(c.expected ?? '?')} · actual: ${String(c.actual ?? '?')}\n`);
    }
    if (c.suggestion) w(`           ↳ ${c.suggestion}\n`);
  }
  for (const c of badAnchors) {
    w(`  ${c.outcome.toUpperCase().padEnd(8)}${c.entryId} anchor[${c.anchor.id}] (${c.anchor.kind}) — ${c.message}\n`);
  }
  // Implicit boundary references were listed with the issues above.
  const advisories = p.advisories.filter((a) => a.code !== KnowledgeAdvisoryCode.ImplicitPathMissing);
  if (advisories.length > 0) {
    w(`\nAdvisories (${advisories.length}) — reported, never gating:\n`);
    for (const a of advisories.slice(0, ADVISORIES_SHOWN)) w(`  ${a.code}  ${a.subjectId} — ${a.message}\n`);
    if (advisories.length > ADVISORIES_SHOWN) {
      w(`  … ${advisories.length - ADVISORIES_SHOWN} more (--json for all)\n`);
    }
  }
  if (p.age && p.age.aged.length > 0) {
    w(`\nAged — not verified within ${p.age.staleAfterDays}d (oldest first):\n`);
    for (const a of p.age.aged.slice(0, AGED_SHOWN)) {
      w(`  ${a.entryId}  verifiedOn ${a.verifiedOn} (${a.ageDays}d)  ${a.source}\n`);
    }
    if (p.age.aged.length > AGED_SHOWN) w(`  … ${p.age.aged.length - AGED_SHOWN} more (--json for all)\n`);
  }
  if (o.reasons.length > 0) {
    w(`\nFAIL: ${o.reasons.join('; ')}\n`);
    w(renderFailureHints(staleKnowledgeHints()));
  }
  if (o.allowEmptyHint) w('\nPass --allow-empty to accept an empty scope explicitly.\n');
  w(`\n${o.verdict}\n`);
}

export const knowledgeVerifyCommand: ICommandHandler = {
  name: 'verify',
  description:
    'Alias for `knowledge stale-check` — the same three-bucket verdict, flags and exit codes. Read-only.',
  usage: STALE_CHECK_USAGE.replace('knowledge stale-check', 'knowledge verify'),
  booleanFlags: STALE_CHECK_BOOLEAN_FLAGS,
  run(args: ParsedArgs): Promise<number> {
    return runStaleCheck(args, 'knowledge verify');
  },
};

export const knowledgeReferencesCommand: ICommandHandler = {
  name: 'references',
  description: 'List references/anchors for one knowledge entry. Read-only.',
  usage: 'shrk knowledge references <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk knowledge references <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const entry = inspection.index.get(id);
    if (!entry) {
      process.stderr.write(`No knowledge entry with id "${id}".\n`);
      return 1;
    }
    const data = {
      id: entry.id,
      title: entry.title,
      references: entry.references ?? [],
      anchors: entry.anchors ?? [],
    };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(data) + '\n');
      return 0;
    }
    process.stdout.write(header(`References for ${id}`));
    if (data.references.length === 0 && data.anchors.length === 0) {
      process.stdout.write('  (no references / anchors declared)\n');
      return 0;
    }
    if (data.references.length > 0) {
      process.stdout.write(`References (${data.references.length}):\n`);
      for (const r of data.references) {
        // One grammar: a pinned symbol renders `Name@path` (it used to render
        // as its path, hiding the symbol it pins).
        const target = formatKnowledgeReference(r).slice(r.kind.length + 1);
        process.stdout.write(`  • ${r.kind}: ${target}${r.required ? ' [required]' : ''}\n`);
      }
    }
    if (data.anchors.length > 0) {
      process.stdout.write(`Anchors (${data.anchors.length}):\n`);
      for (const a of data.anchors) {
        process.stdout.write(`  • ${a.id} (${a.kind}) → ${a.targetId ?? a.path ?? a.symbol ?? '?'}\n`);
      }
    }
    return 0;
  },
};

export const knowledgeAnchorsCommand: ICommandHandler = {
  name: 'anchors',
  description: 'List all anchors across the knowledge corpus. Read-only.',
  usage: 'shrk knowledge anchors [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const out: { entryId: string; anchor: unknown }[] = [];
    for (const e of inspection.knowledgeEntries) {
      for (const a of e.anchors ?? []) {
        out.push({ entryId: e.id, anchor: a });
      }
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ anchors: out, count: out.length }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Anchors (${out.length})`));
    for (const { entryId, anchor } of out) {
      const a = anchor as { id: string; kind: string };
      process.stdout.write(`  ${entryId} → ${a.id} (${a.kind})\n`);
    }
    return 0;
  },
};

/**
 * Read-only preview of which knowledge entries' references / anchors
 * would change when a symbol or file is renamed. Source-side symbol
 * rename remains out of scope until an AST-aware path exists. Use
 * `shrk fix --knowledge-stale --apply` to land entry-side renames.
 */
export const knowledgeRenameSymbolCommand: ICommandHandler = {
  name: 'rename-symbol',
  description:
    'Preview which knowledge entries reference a symbol and would be updated by a rename. Read-only. To land entry-side renames, run `shrk fix --knowledge-stale --apply` (uses the engine\'s replaceWith signal).',
  usage: 'shrk knowledge rename-symbol <old> <new> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const [from, to] = args.positional;
    if (!from || !to) {
      process.stderr.write('Usage: shrk knowledge rename-symbol <old> <new>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const plan = buildRenameSymbolPlan(inspection, { from, to });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(plan) + '\n');
      return 0;
    }
    process.stdout.write(header(`Rename symbol: ${from} → ${to}`));
    if (plan.matches.length === 0) {
      process.stdout.write('  no knowledge entries reference this symbol.\n');
      return 0;
    }
    for (const m of plan.matches) {
      process.stdout.write(`  • ${m.entryId} [${m.field}]\n`);
    }
    process.stdout.write(
      '\n(preview only — use `shrk fix --knowledge-stale --apply` to land entry-side renames.)\n',
    );
    return 0;
  },
};

export const knowledgeRenameFileCommand: ICommandHandler = {
  name: 'rename-file',
  description:
    'Preview which knowledge entries reference a file path and would be updated by a rename. Read-only. To land entry-side renames, run `shrk fix --knowledge-stale --apply`.',
  usage: 'shrk knowledge rename-file <old-path> <new-path> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const [from, to] = args.positional;
    if (!from || !to) {
      process.stderr.write('Usage: shrk knowledge rename-file <old> <new>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const plan = buildRenameFilePlan(inspection, { from, to });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(plan) + '\n');
      return 0;
    }
    process.stdout.write(header(`Rename file: ${from} → ${to}`));
    if (plan.matches.length === 0) {
      process.stdout.write('  no knowledge entries reference this path.\n');
      return 0;
    }
    for (const m of plan.matches) {
      process.stdout.write(`  • ${m.entryId} [${m.field}]\n`);
    }
    process.stdout.write(
      '\n(preview only — use `shrk fix --knowledge-stale --apply` to land entry-side renames.)\n',
    );
    return 0;
  },
};

export const knowledgeUpdateAnchorCommand: ICommandHandler = {
  name: 'update-anchor',
  description:
    'Preview an anchor update. Read-only. To land entry-side updates, edit the entry source directly.',
  usage:
    'shrk knowledge update-anchor <anchorId> [--to-symbol <name>] [--to-path <path>] [--to-target-id <id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const anchorId = args.positional[0];
    if (!anchorId) {
      process.stderr.write('Usage: shrk knowledge update-anchor <anchorId> [--to-symbol|--to-path|--to-target-id <value>]\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const plan = buildAnchorUpdatePlan(inspection, {
      anchorId,
      ...(flagString(args, 'to-symbol') ? { toSymbol: flagString(args, 'to-symbol')! } : {}),
      ...(flagString(args, 'to-path') ? { toPath: flagString(args, 'to-path')! } : {}),
      ...(flagString(args, 'to-target-id') ? { toTargetId: flagString(args, 'to-target-id')! } : {}),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(plan) + '\n');
      return 0;
    }
    process.stdout.write(header(`Update anchor: ${anchorId}`));
    if (plan.matches.length === 0) {
      process.stdout.write('  no anchors match this id.\n');
      return 0;
    }
    for (const m of plan.matches) {
      process.stdout.write(`  • ${m.entryId} [${m.field}]\n`);
    }
    process.stdout.write('\n(preview only.)\n');
    return 0;
  },
};
