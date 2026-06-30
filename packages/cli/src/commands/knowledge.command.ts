import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as nodePathJoin, resolve as nodePathResolve } from 'node:path';
import {
  buildAnchorUpdatePlan,
  buildKnowledgeStaleReport,
  buildRenameFilePlan,
  buildRenameSymbolPlan,
  inspectSharkcraft,
  ReferenceCheckOutcome,
  resolveChangedFiles,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import {
  ALL_KNOWLEDGE_TYPES,
  formatEntryCompact,
  formatEntryFull,
  isKnowledgeType,
  projectKnowledgeEntryForJson,
  searchKnowledge,
} from '@shrkcrft/knowledge';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';
import { renderFailureHints, staleKnowledgeHints } from '../output/failure-hints.ts';

interface IStaleCheckCiPayload {
  schema: string;
  entries: number;
  totalReferences: number;
  totalAnchors: number;
  counts: { ok: number; stale: number; missing: number; unknown: number };
  referenceChecks: readonly {
    entryId: string;
    reference: { kind: string; id?: string; path?: string; symbol?: string; required?: boolean };
    outcome: string;
    message: string;
    suggestion?: string;
  }[];
  anchorChecks: readonly { entryId: string; anchor: { id: string; kind: string }; outcome: string; message: string }[];
  ci: {
    ci: boolean;
    strict: boolean;
    failOn: readonly string[];
    requiredStale: number;
    requiredMissing: number;
    totalRequiredFailing: number;
    exitNonZero: boolean;
    exitReason?: string;
  };
  baselineComparison?: {
    baseline: string;
    newStale: number;
    newMissing: number;
    resolved: number;
  };
}

function renderStaleCheckMarkdown(p: IStaleCheckCiPayload): string {
  const out: string[] = [];
  out.push(`# Knowledge stale-check`);
  out.push('');
  out.push(`- entries: ${p.entries}`);
  out.push(`- references: ${p.totalReferences}`);
  out.push(`- anchors: ${p.totalAnchors}`);
  out.push(`- counts: ok=${p.counts.ok}, stale=${p.counts.stale}, missing=${p.counts.missing}, unknown=${p.counts.unknown}`);
  if (p.ci.ci || p.ci.strict || p.ci.failOn.length > 0) {
    out.push(`- required failing: ${p.ci.totalRequiredFailing} (stale=${p.ci.requiredStale}, missing=${p.ci.requiredMissing})`);
  }
  if (p.baselineComparison) {
    out.push(`- baseline (${p.baselineComparison.baseline}): new-stale=${p.baselineComparison.newStale}, new-missing=${p.baselineComparison.newMissing}, resolved=${p.baselineComparison.resolved}`);
  }
  out.push('');
  out.push(`## Reference issues`);
  for (const c of p.referenceChecks) {
    if (c.outcome === 'ok') continue;
    const req = c.reference.required ? ' **(required)**' : '';
    out.push(`- **${c.outcome.toUpperCase()}**${req} \`${c.entryId}\` → \`${c.reference.kind}:${c.reference.id ?? c.reference.path ?? c.reference.symbol ?? '?'}\` — ${c.message}`);
  }
  if (p.ci.exitNonZero && p.ci.exitReason) {
    out.push('');
    out.push(`> FAIL: ${p.ci.exitReason}`);
  }
  out.push('');
  return out.join('\n');
}

function renderStaleCheckHtml(p: IStaleCheckCiPayload): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const rows: string[] = [];
  for (const c of p.referenceChecks) {
    if (c.outcome === 'ok') continue;
    rows.push(
      `<tr><td>${esc(c.outcome.toUpperCase())}</td><td>${c.reference.required ? '✓' : ''}</td><td>${esc(c.entryId)}</td><td>${esc(c.reference.kind)}:${esc(c.reference.id ?? c.reference.path ?? c.reference.symbol ?? '?')}</td><td>${esc(c.message)}</td></tr>`,
    );
  }
  return `<!doctype html><meta charset="utf-8"><title>Knowledge stale-check</title>
<style>body{font:14px/1.4 sans-serif;margin:1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.25rem .5rem;text-align:left}h1{margin-top:0}</style>
<h1>Knowledge stale-check</h1>
<p>entries=${p.entries}, references=${p.totalReferences}, anchors=${p.totalAnchors}, ok=${p.counts.ok}, stale=${p.counts.stale}, missing=${p.counts.missing}, unknown=${p.counts.unknown}</p>
<table><thead><tr><th>Outcome</th><th>Required</th><th>Entry</th><th>Reference</th><th>Message</th></tr></thead><tbody>${rows.join('')}</tbody></table>
${p.ci.exitNonZero ? `<p style="color:#a40000;font-weight:bold">FAIL: ${esc(p.ci.exitReason ?? '')}</p>` : ''}
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
      return 0;
    }

    process.stdout.write(header(`Knowledge (${entries.length})`));
    for (const e of entries) process.stdout.write(formatEntryCompact(e) + '\n');
    return 0;
  },
};

export const knowledgeGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show full content of one knowledge entry.',
  usage: 'shrk knowledge get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk knowledge get <id>\n');
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
    process.stdout.write(formatEntryFull(entry) + '\n');
    return 0;
  },
};

export const knowledgeSearchCommand: ICommandHandler = {
  name: 'search',
  description: 'Search knowledge by query.',
  usage: 'shrk knowledge search <query> [--type x,y] [--scope x,y] [--limit 10] [--json]',
  async run(args: ParsedArgs): Promise<number> {
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

export const knowledgeStaleCheckCommand: ICommandHandler = {
  name: 'stale-check',
  description:
    'Validate `references[]` + `anchors[]` on each knowledge entry against the workspace. CI flags and `--watch [--once] [--debounce N]` supported. Read-only.',
  usage:
    'shrk knowledge stale-check [--changed-only|--since <ref>|--staged|--files a,b,c] [--ci] [--strict] [--fail-on required|stale|missing|all] [--baseline <file>] [--report] [--format text|markdown|html|json] [--output <path>] [--json] [--watch [--once] [--debounce N]]',
  async run(args: ParsedArgs): Promise<number> {
    const watchExit = await maybeRunInWatchMode(args, knowledgeStaleCheckImpl);
    if (watchExit !== null) return watchExit;
    return knowledgeStaleCheckImpl(args);
  },
};

async function knowledgeStaleCheckImpl(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const scopeOpts = readChangedScopeOptionsForKnowledge(args, cwd);
    const changedFiles = scopeOpts ? resolveChangedFiles(scopeOpts).files : undefined;
    const report = buildKnowledgeStaleReport(inspection, {
      ...(changedFiles ? { changedFiles } : {}),
    });

    // CI/preflight flags.
    const ci = flagBool(args, 'ci');
    const strict = flagBool(args, 'strict');
    const failOnRaw = (flagString(args, 'fail-on') ?? '').toLowerCase();
    const failOn = new Set(
      failOnRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const baselineFile = flagString(args, 'baseline');
    const wantReport = flagBool(args, 'report');
    const formatRaw = (flagString(args, 'format') ?? '').toLowerCase();
    const wantJson = flagBool(args, 'json') || formatRaw === 'json';
    const wantMarkdown = formatRaw === 'markdown' || formatRaw === 'md';
    const wantHtml = formatRaw === 'html';
    const output = flagString(args, 'output');

    // Required-reference computation. A reference is "required" when its
    // `required: true` (default false). Stale + missing are the same outcome
    // family.
    let requiredStale = 0;
    let requiredMissing = 0;
    for (const c of report.referenceChecks) {
      const isRequired = (c.reference as { required?: boolean }).required === true;
      if (isRequired && c.outcome === ReferenceCheckOutcome.Stale) requiredStale++;
      if (isRequired && c.outcome === ReferenceCheckOutcome.Missing) requiredMissing++;
    }
    const totalRequiredFailing = requiredStale + requiredMissing;

    // Decide exit code.
    let exitNonZero = false;
    let exitReason: string | undefined;
    const considerFailOn = (cat: string): boolean => failOn.has(cat) || failOn.has('all');
    if (ci) {
      // CI mode — required failing refs are blocking. Optional refs warn only.
      if (totalRequiredFailing > 0) {
        exitNonZero = true;
        exitReason = `${totalRequiredFailing} required references failing in --ci mode`;
      }
    } else if (strict) {
      // Strict — any stale/missing required ref fails. Same as CI essentially.
      if (totalRequiredFailing > 0) {
        exitNonZero = true;
        exitReason = `${totalRequiredFailing} required references failing in --strict mode`;
      }
    } else if (failOn.size > 0) {
      if (considerFailOn('required') && totalRequiredFailing > 0) {
        exitNonZero = true;
        exitReason = `${totalRequiredFailing} required reference issues (--fail-on=required)`;
      }
      if (considerFailOn('stale') && report.counts.stale > 0) {
        exitNonZero = true;
        exitReason = `${report.counts.stale} stale references (--fail-on=stale)`;
      }
      if (considerFailOn('missing') && report.counts.missing > 0) {
        exitNonZero = true;
        exitReason = `${report.counts.missing} missing references (--fail-on=missing)`;
      }
    } else {
      // Default — non-CI: only the legacy "any missing or stale" condition fails.
      if (report.counts.missing + report.counts.stale > 0) {
        exitNonZero = true;
        exitReason = `${report.counts.missing + report.counts.stale} stale or missing references (legacy default)`;
      }
    }

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
    const ciPayload = {
      ...report,
      ci: {
        ci,
        strict,
        failOn: [...failOn],
        requiredStale,
        requiredMissing,
        totalRequiredFailing,
        exitNonZero,
        exitReason,
      },
      baselineComparison,
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

    // Format-specific output.
    if (wantJson) {
      process.stdout.write(asJson(ciPayload) + '\n');
      return exitNonZero ? 1 : 0;
    }
    if (wantMarkdown) {
      process.stdout.write(renderStaleCheckMarkdown(ciPayload));
      return exitNonZero ? 1 : 0;
    }
    if (wantHtml) {
      process.stdout.write(renderStaleCheckHtml(ciPayload));
      return exitNonZero ? 1 : 0;
    }
    // Default text output.
    process.stdout.write(header('Knowledge stale-check'));
    process.stdout.write(
      `entries=${report.entries} references=${report.totalReferences} anchors=${report.totalAnchors}\n`,
    );
    process.stdout.write(
      `ok=${report.counts.ok} stale=${report.counts.stale} missing=${report.counts.missing} unknown=${report.counts.unknown}\n`,
    );
    if (ci || strict || failOn.size > 0) {
      process.stdout.write(
        `required: stale=${requiredStale} missing=${requiredMissing} (total failing: ${totalRequiredFailing})\n`,
      );
    }
    if (baselineComparison) {
      process.stdout.write(
        `baseline: new-stale=${baselineComparison.newStale} new-missing=${baselineComparison.newMissing} resolved=${baselineComparison.resolved}\n`,
      );
    }
    process.stdout.write('\n');
    for (const c of report.referenceChecks) {
      if (c.outcome === ReferenceCheckOutcome.Ok) continue;
      const tag = c.outcome.toUpperCase().padEnd(7);
      const req = (c.reference as { required?: boolean }).required === true ? '[REQ] ' : '      ';
      process.stdout.write(`  ${tag} ${req}${c.entryId} → ${c.reference.kind}:${c.reference.id ?? c.reference.path ?? c.reference.symbol ?? '?'} — ${c.message}\n`);
      if (c.suggestion) process.stdout.write(`           ↳ ${c.suggestion}\n`);
    }
    for (const c of report.anchorChecks) {
      if (c.outcome === ReferenceCheckOutcome.Ok) continue;
      const tag = c.outcome.toUpperCase().padEnd(7);
      process.stdout.write(`  ${tag} ${c.entryId} anchor[${c.anchor.id}] (${c.anchor.kind}) — ${c.message}\n`);
    }
    if (exitNonZero && exitReason) {
      process.stdout.write(`\nFAIL: ${exitReason}\n`);
    }
    if (exitNonZero) {
      process.stdout.write(renderFailureHints(staleKnowledgeHints()));
    }
    return exitNonZero ? 1 : 0;
}

export const knowledgeVerifyCommand: ICommandHandler = {
  name: 'verify',
  description:
    'Alias for `knowledge stale-check`. Read-only.',
  usage: 'shrk knowledge verify [--changed-only|--since|--staged|--files] [--json]',
  run(args: ParsedArgs): Promise<number> {
    return knowledgeStaleCheckCommand.run(args) as Promise<number>;
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
        const target = r.id ?? r.path ?? r.symbol ?? r.command ?? '?';
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
