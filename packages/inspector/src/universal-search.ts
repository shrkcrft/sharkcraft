/**
 * Universal search (v2).
 *
 * `shrk search "<query>"` becomes a discovery palette across every
 * contribution kind the workspace can produce. Output is a 7-section
 * report — read-only, deterministic.
 *
 *   1. Best actions
 *   2. Exact / strong command matches
 *   3. Relevant project / pack contributions
 *   4. Relevant knowledge / docs
 *   5. Relevant validation commands
 *   6. Uncertainty / no-match explanation
 *   7. Why these ranked
 */
import { buildPackContributionsInventory } from './pack-contributions-inventory.ts';
import { listConventions } from './convention-registry.ts';
import { listPackHelpers } from './pack-helper-registry.ts';
import { explainTaskRouting } from './task-routing-hint-registry.ts';
import { listPluginLifecycleProfiles } from './plugin-lifecycle-profile-registry.ts';
import { uncertaintyReportFromSummary, type IUncertaintyReport } from './uncertainty-report.ts';
import { buildUncertaintySummary } from './uncertainty.ts';
import { buildTaskPacket } from './task-packet.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const UNIVERSAL_SEARCH_SCHEMA = 'sharkcraft.universal-search/v2';

export enum SearchResultKind {
  Command = 'command',
  McpTool = 'mcp-tool',
  Knowledge = 'knowledge',
  Rule = 'rule',
  Path = 'path',
  Convention = 'convention',
  Template = 'template',
  Helper = 'helper',
  Playbook = 'playbook',
  Construct = 'construct',
  Policy = 'policy',
  Decision = 'decision',
  ScaffoldPattern = 'scaffold-pattern',
  ContractTemplate = 'contract-template',
  MigrationProfile = 'migration-profile',
  PluginLifecycleProfile = 'plugin-lifecycle-profile',
  FeedbackRule = 'feedback-rule',
  TaskRoutingHint = 'task-routing-hint',
  Docs = 'docs',
  Report = 'report',
  Action = 'action',
}

export interface IUniversalSearchHit {
  readonly kind: SearchResultKind;
  readonly id: string;
  readonly title: string;
  readonly source: 'builtin' | 'local' | 'pack' | 'fixture';
  readonly packageName?: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly snippet?: string;
  readonly nextCommand?: string;
}

export interface IUniversalSearchSections {
  readonly bestActions: readonly IUniversalSearchHit[];
  readonly commands: readonly IUniversalSearchHit[];
  readonly contributions: readonly IUniversalSearchHit[];
  readonly knowledge: readonly IUniversalSearchHit[];
  readonly validation: readonly IUniversalSearchHit[];
}

export interface IUniversalSearchReport {
  readonly schema: typeof UNIVERSAL_SEARCH_SCHEMA;
  readonly generatedAt: string;
  readonly query: string;
  readonly sections: IUniversalSearchSections;
  readonly uncertainty: IUncertaintyReport;
  readonly whyTheseRanked: readonly string[];
  readonly nextSuggestions: readonly string[];
}

export interface IUniversalSearchOptions {
  readonly kind?: SearchResultKind;
  readonly source?: 'builtin' | 'local' | 'pack' | 'fixture';
  readonly limit?: number;
  readonly commandsOnly?: boolean;
  readonly actionsOnly?: boolean;
}

function score(text: string, q: string): { score: number; reasons: readonly string[] } {
  const reasons: string[] = [];
  let s = 0;
  const tLower = text.toLowerCase();
  const qLower = q.toLowerCase();
  if (tLower === qLower) {
    s += 20;
    reasons.push('exact match');
  } else if (tLower.includes(qLower)) {
    s += 10;
    reasons.push('substring match');
  }
  const tokens = qLower.split(/[^a-z0-9]+/).filter((x) => x.length >= 3);
  for (const tok of tokens) {
    if (tLower.includes(tok)) {
      s += 3;
      reasons.push(`token "${tok}"`);
    }
  }
  return { score: s, reasons };
}

function makeHit(
  kind: SearchResultKind,
  id: string,
  title: string,
  source: IUniversalSearchHit['source'],
  packageName: string | undefined,
  raw: { score: number; reasons: readonly string[] },
  nextCommand: string | undefined,
  snippet?: string,
): IUniversalSearchHit {
  return {
    kind,
    id,
    title,
    source,
    ...(packageName ? { packageName } : {}),
    score: raw.score,
    reasons: raw.reasons,
    ...(snippet ? { snippet } : {}),
    ...(nextCommand ? { nextCommand } : {}),
  };
}

export async function buildUniversalSearch(
  inspection: ISharkcraftInspection,
  query: string,
  options: IUniversalSearchOptions = {},
): Promise<IUniversalSearchReport> {
  const q = query.trim();
  const limit = options.limit ?? 8;

  // Pull pieces we'll rank against.
  const inv = buildPackContributionsInventory(inspection);
  const conventions = await listConventions(inspection);
  const helpers = await listPackHelpers(inspection);
  const routing = await explainTaskRouting(inspection, q);
  const lifecycle = await listPluginLifecycleProfiles(inspection);
  const knowledgeEntries = inspection.knowledgeEntries;

  const allHits: IUniversalSearchHit[] = [];

  // Knowledge
  for (const k of knowledgeEntries) {
    const s = score(`${k.id} ${k.title} ${(k.tags ?? []).join(' ')}`, q);
    if (s.score > 0) {
      allHits.push(
        makeHit(
          SearchResultKind.Knowledge,
          k.id,
          k.title,
          k.source?.loader === 'pack' ? 'pack' : 'local',
          undefined,
          s,
          `shrk knowledge get ${k.id}`,
          k.summary?.slice(0, 120),
        ),
      );
    }
  }

  // Conventions
  for (const c of conventions) {
    const s = score(`${c.convention.id} ${c.convention.title} ${(c.convention.tags ?? []).join(' ')}`, q);
    if (s.score > 0) {
      allHits.push(
        makeHit(
          SearchResultKind.Convention,
          c.convention.id,
          c.convention.title,
          c.source === 'pack' ? 'pack' : 'local',
          c.packageName,
          s,
          `shrk conventions get ${c.convention.id}`,
        ),
      );
    }
  }

  // Pack helpers
  for (const h of helpers) {
    const s = score(`${h.helper.id} ${h.helper.title} ${(h.helper.tags ?? []).join(' ')}`, q);
    if (s.score > 0) {
      allHits.push(
        makeHit(
          SearchResultKind.Helper,
          h.helper.id,
          h.helper.title,
          h.source === 'pack' ? 'pack' : 'local',
          h.packageName,
          s,
          `shrk helper plan ${h.helper.id}`,
        ),
      );
    }
  }

  // Plugin lifecycle profiles
  for (const p of lifecycle) {
    const s = score(`${p.profile.id} ${p.profile.title} ${(p.profile.tags ?? []).join(' ')}`, q);
    if (s.score > 0) {
      allHits.push(
        makeHit(
          SearchResultKind.PluginLifecycleProfile,
          p.profile.id,
          p.profile.title,
          p.source === 'pack' ? 'pack' : 'local',
          p.packageName,
          s,
          `shrk plugin lifecycle profile ${p.profile.id}`,
        ),
      );
    }
  }

  // Pack contributions (catch-all for kinds we didn't iterate above)
  for (const e of inv.entries) {
    if (allHits.find((h) => h.id === e.id && String(h.kind) === e.kind)) continue;
    const s = score(`${e.id} ${e.title ?? ''}`, q);
    if (s.score > 0) {
      const kindMap: Record<string, SearchResultKind> = {
        knowledge: SearchResultKind.Knowledge,
        rule: SearchResultKind.Rule,
        path: SearchResultKind.Path,
        'path-convention': SearchResultKind.Path,
        template: SearchResultKind.Template,
        pipeline: SearchResultKind.Action,
        playbook: SearchResultKind.Playbook,
        construct: SearchResultKind.Construct,
        'scaffold-pattern': SearchResultKind.ScaffoldPattern,
        policy: SearchResultKind.Policy,
        decision: SearchResultKind.Decision,
        'contract-template': SearchResultKind.ContractTemplate,
        'migration-profile': SearchResultKind.MigrationProfile,
        'plugin-lifecycle-profile': SearchResultKind.PluginLifecycleProfile,
        'feedback-rule': SearchResultKind.FeedbackRule,
        'task-routing-hint': SearchResultKind.TaskRoutingHint,
        helper: SearchResultKind.Helper,
        convention: SearchResultKind.Convention,
        docs: SearchResultKind.Docs,
      };
      const kind = kindMap[e.kind] ?? SearchResultKind.Action;
      allHits.push(
        makeHit(kind, e.id, e.title ?? e.id, e.source as IUniversalSearchHit['source'], e.packageName, s, undefined),
      );
    }
  }

  // Routing hints — promote them as "best actions".
  const routingHits: IUniversalSearchHit[] = routing.slice(0, limit).map((m) => ({
    kind: SearchResultKind.Action,
    id: m.hint.id,
    title: m.hint.title,
    source: m.source === 'pack' ? 'pack' : 'local',
    ...(m.packageName ? { packageName: m.packageName } : {}),
    score: m.score,
    reasons: m.reasons,
    ...(m.hint.recommends.commands && m.hint.recommends.commands.length > 0
      ? { nextCommand: m.hint.recommends.commands[0] }
      : {}),
  }));

  // Filter by options.
  let filtered = allHits;
  if (options.kind) filtered = filtered.filter((h) => h.kind === options.kind);
  if (options.source) filtered = filtered.filter((h) => h.source === options.source);

  filtered.sort((a, b) => b.score - a.score);

  const sections: IUniversalSearchSections = {
    bestActions: routingHits.slice(0, limit),
    commands: filtered.filter((h) => h.nextCommand && h.kind !== SearchResultKind.Knowledge).slice(0, limit),
    contributions: filtered
      .filter((h) =>
        [
          SearchResultKind.Convention,
          SearchResultKind.Helper,
          SearchResultKind.Template,
          SearchResultKind.Playbook,
          SearchResultKind.Construct,
          SearchResultKind.Policy,
          SearchResultKind.ContractTemplate,
          SearchResultKind.MigrationProfile,
          SearchResultKind.PluginLifecycleProfile,
          SearchResultKind.ScaffoldPattern,
          SearchResultKind.FeedbackRule,
          SearchResultKind.TaskRoutingHint,
          SearchResultKind.Path,
          SearchResultKind.Rule,
        ].includes(h.kind),
      )
      .slice(0, limit),
    knowledge: filtered.filter((h) => h.kind === SearchResultKind.Knowledge || h.kind === SearchResultKind.Docs).slice(0, limit),
    validation: filtered
      .filter((h) => /\bvalidat|doctor|drift|stale|safety|check\b/i.test(h.title))
      .slice(0, limit),
  };

  // Apply commandsOnly / actionsOnly.
  if (options.commandsOnly) {
    return {
      schema: UNIVERSAL_SEARCH_SCHEMA,
      generatedAt: new Date().toISOString(),
      query: q,
      sections: {
        bestActions: [],
        commands: sections.commands,
        contributions: [],
        knowledge: [],
        validation: [],
      },
      uncertainty: uncertaintyReportFromSummary(buildUncertaintySummary(buildTaskPacket(inspection, q))),
      whyTheseRanked: [`Filtered to commands-only.`],
      nextSuggestions: [],
    };
  }
  if (options.actionsOnly) {
    return {
      schema: UNIVERSAL_SEARCH_SCHEMA,
      generatedAt: new Date().toISOString(),
      query: q,
      sections: {
        bestActions: sections.bestActions,
        commands: [],
        contributions: [],
        knowledge: [],
        validation: [],
      },
      uncertainty: uncertaintyReportFromSummary(buildUncertaintySummary(buildTaskPacket(inspection, q))),
      whyTheseRanked: [`Filtered to actions-only (task routing hints).`],
      nextSuggestions: [],
    };
  }

  // Uncertainty.
  const packet = buildTaskPacket(inspection, q);
  const uncertainty = uncertaintyReportFromSummary(buildUncertaintySummary(packet), `shrk search "${q}"`);

  const totalHits =
    sections.bestActions.length +
    sections.commands.length +
    sections.contributions.length +
    sections.knowledge.length +
    sections.validation.length;
  const nextSuggestions: string[] = [];
  if (totalHits === 0) {
    nextSuggestions.push(
      `shrk coverage scaffolds --task "${q}"`,
      `shrk feedback ingest <file>`,
      `shrk why <id> --for-task "${q}"`,
      `shrk commands suggest "${q}"`,
    );
  }

  const whyTheseRanked = [
    'Scoring: exact match +20, substring +10, token ≥3 chars +3 per match.',
    'Best actions come from pack/local task routing hints (highest score first).',
    'Validation section filters titles for `doctor / drift / stale / safety / check`.',
  ];

  return {
    schema: UNIVERSAL_SEARCH_SCHEMA,
    generatedAt: new Date().toISOString(),
    query: q,
    sections,
    uncertainty,
    whyTheseRanked,
    nextSuggestions,
  };
}

export function renderUniversalSearchText(report: IUniversalSearchReport): string {
  const lines: string[] = [];
  lines.push(`=== shrk search "${report.query}" ===`);
  lines.push('');

  const renderSection = (title: string, hits: readonly IUniversalSearchHit[]): void => {
    lines.push(`▶ ${title} (${hits.length})`);
    if (hits.length === 0) {
      lines.push('   (none)');
    } else {
      for (const h of hits) {
        const src = h.source === 'pack' ? `pack:${h.packageName ?? '?'}` : h.source;
        lines.push(`   • [${h.kind}] ${h.id.padEnd(28)} ${h.title}  [${src}] score=${h.score}`);
        if (h.snippet) lines.push(`        ${h.snippet}`);
        if (h.nextCommand) lines.push(`        → ${h.nextCommand}`);
      }
    }
    lines.push('');
  };

  renderSection('Best actions', report.sections.bestActions);
  renderSection('Exact / strong command matches', report.sections.commands);
  renderSection('Relevant project / pack contributions', report.sections.contributions);
  renderSection('Relevant knowledge / docs', report.sections.knowledge);
  renderSection('Relevant validation commands', report.sections.validation);

  lines.push('▶ Uncertainty');
  lines.push(`   confidence: ${report.uncertainty.confidence.toUpperCase()}`);
  if (report.uncertainty.confidence === 'low' || report.uncertainty.confidence === 'unknown') {
    lines.push('   ⚠ Low confidence — see "What would increase confidence" below.');
  }
  for (const r of report.uncertainty.reasons.slice(0, 4)) lines.push(`     • ${r}`);
  if (report.uncertainty.whatWouldIncreaseConfidence.length > 0) {
    lines.push('   What would increase confidence:');
    for (const w of report.uncertainty.whatWouldIncreaseConfidence.slice(0, 4)) {
      lines.push(`     • ${w}`);
    }
  }
  lines.push(`   safe fallback: ${report.uncertainty.safeFallbackCommand}`);
  lines.push('');

  if (report.nextSuggestions.length > 0) {
    lines.push('▶ No matches — try:');
    for (const s of report.nextSuggestions) lines.push(`   $ ${s}`);
    lines.push('');
  }

  lines.push('▶ Why these ranked');
  for (const w of report.whyTheseRanked) lines.push(`   • ${w}`);

  return lines.join('\n') + '\n';
}

export function renderUniversalSearchMarkdown(report: IUniversalSearchReport): string {
  const lines: string[] = [];
  lines.push(`# Search "${report.query}"`);
  lines.push('');
  const renderSection = (title: string, hits: readonly IUniversalSearchHit[]): void => {
    lines.push(`## ${title}`);
    if (hits.length === 0) {
      lines.push('(none)');
    } else {
      lines.push('| Kind | Id | Title | Source | Score | Next |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const h of hits) {
        const src = h.source === 'pack' ? `pack:${h.packageName ?? '?'}` : h.source;
        lines.push(`| \`${h.kind}\` | \`${h.id}\` | ${h.title} | ${src} | ${h.score} | ${h.nextCommand ?? ''} |`);
      }
    }
    lines.push('');
  };
  renderSection('Best actions', report.sections.bestActions);
  renderSection('Exact / strong command matches', report.sections.commands);
  renderSection('Relevant project / pack contributions', report.sections.contributions);
  renderSection('Relevant knowledge / docs', report.sections.knowledge);
  renderSection('Relevant validation commands', report.sections.validation);
  lines.push(`## Uncertainty`);
  lines.push(`- confidence: **${report.uncertainty.confidence.toUpperCase()}**`);
  for (const r of report.uncertainty.reasons.slice(0, 4)) lines.push(`- ${r}`);
  lines.push('');
  lines.push('## Why these ranked');
  for (const w of report.whyTheseRanked) lines.push(`- ${w}`);
  return lines.join('\n') + '\n';
}
