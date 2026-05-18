/**
 * Command taxonomy report.
 *
 * Groups CLI commands into a human-friendly hierarchy. Built from the
 * shared command-catalog (passed in to avoid an inspector → CLI cycle).
 */
export const COMMAND_TAXONOMY_SCHEMA = 'sharkcraft.command-taxonomy/v1';

export interface ICommandTaxonomyEntry {
  command: string;
  description: string;
  safetyLevel: string;
  primary: boolean;
  docsLink?: string;
}

export interface ICommandTaxonomyGroup {
  id: string;
  title: string;
  description: string;
  commands: readonly ICommandTaxonomyEntry[];
}

export interface ICommandTaxonomyReport {
  schema: typeof COMMAND_TAXONOMY_SCHEMA;
  generatedAt: string;
  groups: readonly ICommandTaxonomyGroup[];
  uncategorised: readonly ICommandTaxonomyEntry[];
}

const GROUP_DEFS: readonly { id: string; title: string; description: string; match: RegExp; primary: readonly string[] }[] = [
  {
    id: 'start-here',
    title: 'Start here',
    description: 'First-time orientation.',
    match: /^(start-here|doctor|commands(\s|$)|commands primary|map|version)/,
    primary: ['start-here', 'doctor', 'commands primary', 'map'],
  },
  {
    id: 'daily-development',
    title: 'Daily development',
    description: 'The agentic write flow.',
    match: /^(brief|dev start|dev report|dev open|gen|apply|plan(\s|$)|plan review)/,
    primary: ['brief', 'dev start', 'gen', 'plan review', 'apply'],
  },
  {
    id: 'ai-agent-context',
    title: 'AI agent context',
    description: 'Brief / handoff / orchestrate / simulate / intent / recommend.',
    match: /^(brief|handoff|orchestrate|simulate|intent|recommend|context|task)/,
    primary: ['brief', 'handoff', 'orchestrate', 'simulate'],
  },
  {
    id: 'review-impact',
    title: 'Review and impact',
    description: 'Review packets, impact graphs, tests impact.',
    match: /^(review|impact|tests (impact|missing|suggest)|owners |ownership )/,
    primary: ['review packet', 'impact', 'tests impact'],
  },
  {
    id: 'architecture',
    title: 'Architecture intelligence',
    description: 'Architecture map / intelligence graph / boundaries / drift / coverage.',
    match: /^(architecture|intelligence|check boundaries|drift|coverage|boundaries|graph|constructs)/,
    primary: ['architecture map', 'intelligence graph', 'check boundaries'],
  },
  {
    id: 'governance-compliance',
    title: 'Governance and compliance',
    description: 'Safety audit, compliance, policy, decisions.',
    match: /^(safety|compliance|policy|decisions)/,
    primary: ['safety audit', 'compliance check', 'policy run', 'decisions list'],
  },
  {
    id: 'packs',
    title: 'Packs and ecosystem',
    description: 'Pack discovery, doctor, release-check, quality, compat.',
    match: /^(packs)/,
    primary: ['packs doctor', 'packs release-check', 'packs quality'],
  },
  {
    id: 'ci-reports',
    title: 'CI and reports',
    description: 'CI scaffold, report site, dashboard export, demo workflows.',
    match: /^(ci|report|dashboard|demo)/,
    primary: ['report site', 'ci scaffold github-actions', 'demo workflow pr-review'],
  },
  {
    id: 'release-readiness',
    title: 'Release readiness',
    description: 'release readiness / smoke / install smoke / train / runtime doctor.',
    match: /^(release|install|runtime|train|version)/,
    primary: ['release readiness', 'release smoke', 'install smoke'],
  },
  {
    id: 'diagnostics',
    title: 'Diagnostics and troubleshooting',
    description: 'self audit, diagnostics, upgrade.',
    match: /^(self audit|diagnostics|upgrade|api)/,
    primary: ['self audit', 'diagnostics suggest', 'upgrade check'],
  },
  {
    id: 'advanced',
    title: 'Advanced / internal',
    description: 'Schemas, exports, imports, ask.',
    match: /^(ask|export|import|schemas|infer|init|presets|scaffolds|pipelines|playbooks|knowledge|rules|paths|templates|git |session|inspect|find|next|explain|reposet|view|quality |watch|search|owners)/,
    primary: [],
  },
];

export interface IBuildCommandTaxonomyInput {
  catalog: readonly { command: string; description: string; category?: string; safetyLevel?: string }[];
}

export function buildCommandTaxonomy(input: IBuildCommandTaxonomyInput): ICommandTaxonomyReport {
  const groups: ICommandTaxonomyGroup[] = GROUP_DEFS.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    commands: [],
  })) as unknown as ICommandTaxonomyGroup[];
  const groupedCommands = groups.map((g) => g.commands as ICommandTaxonomyEntry[]);
  const uncategorised: ICommandTaxonomyEntry[] = [];

  for (const e of input.catalog) {
    const entry: ICommandTaxonomyEntry = {
      command: e.command,
      description: e.description,
      safetyLevel: e.safetyLevel ?? 'read-only',
      primary: false,
    };
    let placed = false;
    for (let i = 0; i < GROUP_DEFS.length; i++) {
      const g = GROUP_DEFS[i]!;
      const target = groupedCommands[i];
      if (!target) continue;
      if (g.match.test(e.command)) {
        entry.primary = g.primary.some((p) => e.command === p || e.command.startsWith(p));
        target.push(entry);
        placed = true;
        break;
      }
    }
    if (!placed) uncategorised.push(entry);
  }
  for (const arr of groupedCommands) arr.sort((a, b) => a.command.localeCompare(b.command));
  return {
    schema: COMMAND_TAXONOMY_SCHEMA,
    generatedAt: new Date().toISOString(),
    groups,
    uncategorised,
  };
}

export function renderCommandTaxonomyText(report: ICommandTaxonomyReport): string {
  const lines: string[] = [];
  lines.push('=== Command taxonomy ===');
  for (const g of report.groups) {
    lines.push(`\n## ${g.title} (${g.commands.length})`);
    if (g.description) lines.push(`   ${g.description}`);
    for (const c of g.commands) {
      const star = c.primary ? '★ ' : '  ';
      lines.push(`   ${star}shrk ${c.command.padEnd(36)} [${c.safetyLevel}]`);
    }
  }
  if (report.uncategorised.length > 0) {
    lines.push(`\n## Uncategorised (${report.uncategorised.length})`);
    for (const c of report.uncategorised) lines.push(`     shrk ${c.command}`);
  }
  return lines.join('\n') + '\n';
}

export function renderCommandTaxonomyMarkdown(report: ICommandTaxonomyReport): string {
  const lines: string[] = [];
  lines.push('# SharkCraft command taxonomy');
  lines.push('');
  for (const g of report.groups) {
    lines.push(`## ${g.title}`);
    lines.push('');
    if (g.description) lines.push(`_${g.description}_`);
    lines.push('');
    for (const c of g.commands) {
      const star = c.primary ? '**★** ' : '';
      lines.push(`- ${star}\`shrk ${c.command}\` — ${c.description} _(${c.safetyLevel})_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
