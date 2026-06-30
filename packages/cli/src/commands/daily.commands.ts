import {
  buildAiReadinessReport,
  buildTaskPacket,
  inspectSharkcraft,
  runDoctor,
} from '@shrkcrft/inspector';
import { recommendPresets } from '@shrkcrft/presets';
import {
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

// ────────────────────────────────────────────────────────────────────────
// shrk next — "what should I do right now in this repo?"
// ────────────────────────────────────────────────────────────────────────
export const nextCommand: ICommandHandler = {
  name: 'next',
  description:
    'Recommend next actions for the current repo: doctor status, readiness, suggested presets/pipelines, missing setup.',
  usage: 'shrk [--cwd <dir>] next [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const doctor = runDoctor(inspection);
    const readiness = buildAiReadinessReport(inspection);
    const presetRecs = recommendPresets(inspection.presetRegistry.list(), {
      profiles: inspection.workspace.profiles,
      limit: 3,
    });
    const pipelineIds = inspection.pipelineRegistry.list().map((p) => p.id);

    const actions: string[] = [];
    if (!inspection.hasSharkcraftFolder) {
      actions.push('Run `shrk init --preset generic` to scaffold sharkcraft/.');
    }
    if (!doctor.passed) {
      actions.push('Run `shrk doctor` to fix the errors above.');
    }
    if (readiness.score < 70) {
      actions.push(`Improve readiness (current ${readiness.score}/100) — see recommendations below.`);
    }
    if (inspection.templates.length === 0) {
      actions.push('Add at least one template via `shrk presets apply <id> --merge --write`.');
    }
    if (inspection.pipelines.length === 0) {
      actions.push('Add a pipeline (feature-dev, context-only) — see suggested presets below.');
    }

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          doctorPassed: doctor.passed,
          readiness: { score: readiness.score, grade: readiness.grade },
          detectedProfiles: inspection.workspace.profiles,
          presetRecommendations: presetRecs.map((r) => ({
            id: r.preset.id,
            confidence: r.confidence,
            score: r.score,
          })),
          pipelines: pipelineIds,
          actions,
          topRecommendations: readiness.topRecommendations,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header('Next actions'));
    process.stdout.write(kv('doctor', doctor.passed ? 'pass' : `${doctor.summary.errors} errors`) + '\n');
    process.stdout.write(kv('readiness', `${readiness.score}/100 (${readiness.grade})`) + '\n');
    process.stdout.write(
      kv('profiles', inspection.workspace.profiles.join(', ') || '(none)') + '\n',
    );
    if (presetRecs.length) {
      process.stdout.write('\nSuggested presets:\n');
      for (const r of presetRecs) {
        process.stdout.write(
          `  • ${r.preset.id} (${r.confidence}) — ${r.preset.title}\n`,
        );
      }
    }
    if (pipelineIds.length) {
      process.stdout.write('\nKnown pipelines:\n');
      for (const id of pipelineIds.slice(0, 6)) process.stdout.write(`  • ${id}\n`);
    }
    if (actions.length) {
      process.stdout.write('\nDo next:\n');
      for (const a of actions) process.stdout.write(`  $ ${a}\n`);
    }
    if (readiness.topRecommendations.length) {
      process.stdout.write('\nReadiness recommendations:\n');
      for (const r of readiness.topRecommendations) {
        process.stdout.write(`  • ${r}\n`);
      }
    }
    if (actions.length === 0 && doctor.passed && readiness.score >= 70) {
      process.stdout.write(
        '\nNothing urgent. Try `shrk task "<task>"` when you have something to ship.\n',
      );
    }
    return 0;
  },
};

// ────────────────────────────────────────────────────────────────────────
// shrk find — grouped search across all SharkCraft kinds.
// ────────────────────────────────────────────────────────────────────────
function lc(s: string): string {
  return s.toLowerCase();
}

function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const q = lc(query);
  return texts.some((t) => typeof t === 'string' && lc(t).includes(q));
}

export const findCommand: ICommandHandler = {
  name: 'find',
  description:
    'Search across knowledge / rules / paths / templates / pipelines / packs / presets in one place.',
  usage: 'shrk [--cwd <dir>] find "<query>" [--limit N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const query = args.positional.join(' ').trim();
    if (!query) {
      process.stderr.write('Usage: shrk find "<query>"\n');
      return 2;
    }
    const limit = flagNumber(args, 'limit') ?? 8;
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });

    const knowledge = inspection.knowledgeEntries
      .filter((e) => matches(query, e.id, e.title, e.content, e.tags.join(' ')))
      .slice(0, limit);
    const rules = inspection.ruleService.list()
      .filter((r) => matches(query, r.id, r.title, r.content))
      .slice(0, limit);
    const paths = inspection.pathService.list()
      .filter((p) => matches(query, p.id, p.title, p.content))
      .slice(0, limit);
    const templates = inspection.templates
      .filter((t) => matches(query, t.id, t.name, t.description))
      .slice(0, limit);
    const pipelines = inspection.pipelines
      .filter((p) => matches(query, p.id, p.title, p.description))
      .slice(0, limit);
    const packs = inspection.packs.discoveredPacks
      .filter((p) => matches(query, p.packageName, p.manifest?.info.description))
      .slice(0, limit);
    const presets = inspection.presetRegistry
      .list()
      .filter((p) => matches(query, p.id, p.title, p.description, (p.tags ?? []).join(' ')))
      .slice(0, limit);

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          query,
          knowledge: knowledge.map((e) => ({ id: e.id, title: e.title, type: e.type })),
          rules: rules.map((r) => ({ id: r.id, title: r.title })),
          paths: paths.map((p) => ({ id: p.id, title: p.title })),
          templates: templates.map((t) => ({ id: t.id, name: t.name })),
          pipelines: pipelines.map((p) => ({ id: p.id, title: p.title })),
          packs: packs.map((p) => ({ name: p.packageName, version: p.packageVersion })),
          presets: presets.map((p) => ({ id: p.id, title: p.title })),
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`find: ${query}`));
    function group(title: string, items: { line: string }[]): void {
      if (items.length === 0) return;
      process.stdout.write(`\n${title} (${items.length}):\n`);
      for (const it of items) process.stdout.write(`  ${it.line}\n`);
    }
    group(
      'Knowledge',
      knowledge.map((e) => ({ line: `${e.id.padEnd(30)} ${e.title}` })),
    );
    group(
      'Rules',
      rules.map((r) => ({ line: `${r.id.padEnd(30)} ${r.title}` })),
    );
    group(
      'Paths',
      paths.map((p) => ({ line: `${p.id.padEnd(30)} ${p.title}` })),
    );
    group(
      'Templates',
      templates.map((t) => ({ line: `${t.id.padEnd(30)} ${t.name}` })),
    );
    group(
      'Pipelines',
      pipelines.map((p) => ({ line: `${p.id.padEnd(30)} ${p.title}` })),
    );
    group(
      'Packs',
      packs.map((p) => ({ line: `${p.packageName}@${p.packageVersion}` })),
    );
    group(
      'Presets',
      presets.map((p) => ({ line: `${p.id.padEnd(22)} ${p.title}` })),
    );
    const total =
      knowledge.length +
      rules.length +
      paths.length +
      templates.length +
      pipelines.length +
      packs.length +
      presets.length;
    if (total === 0) {
      process.stdout.write('\n(no matches)\n');
    }
    return 0;
  },
};

// ────────────────────────────────────────────────────────────────────────
// shrk explain <topic> — compact local explanation, no AI.
// ────────────────────────────────────────────────────────────────────────
export const explainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Search the project knowledge / rules / paths / templates / pipelines for a topic and print a compact explanation. No AI required.',
  usage: 'shrk [--cwd <dir>] explain "<topic>" [--max-entries N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const topic = args.positional.join(' ').trim();
    if (!topic) {
      process.stderr.write('Usage: shrk explain "<topic>"\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const maxEntries = flagNumber(args, 'max-entries') ?? 6;

    const packet = buildTaskPacket(inspection, topic, { maxTokens: 2500 });
    const top = inspection.knowledgeEntries
      .filter((e) => matches(topic, e.id, e.title, e.content, e.tags.join(' ')))
      .slice(0, maxEntries);

    // Surface the matched items themselves, not just counts. `explain`
    // otherwise duplicates `shrk search`'s job while hiding what matched.
    const relevantRules = packet.relevantRules.map((r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
    }));
    const relevantPaths = packet.relevantPaths.map((p) => ({
      id: p.id,
      title: p.title,
      priority: p.priority,
    }));
    const relevantTemplates = packet.relevantTemplates.map((t) => ({
      id: t.id,
      name: t.name,
    }));

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          topic,
          summary: {
            relevantRules: relevantRules.length,
            relevantPaths: relevantPaths.length,
            relevantTemplates: relevantTemplates.length,
          },
          relevantRules,
          relevantPaths,
          relevantTemplates,
          entries: top.map((e) => ({
            id: e.id,
            title: e.title,
            type: e.type,
            priority: e.priority,
            content: e.content,
          })),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`explain: ${topic}`));
    process.stdout.write(
      kv(
        'matches',
        `rules=${relevantRules.length} paths=${relevantPaths.length} templates=${relevantTemplates.length}`,
      ) + '\n\n',
    );
    if (relevantRules.length > 0) {
      process.stdout.write('Rules:\n');
      for (const r of relevantRules) {
        process.stdout.write(`  • [${r.priority}] ${r.id} — ${r.title}\n`);
      }
      process.stdout.write('\n');
    }
    if (relevantPaths.length > 0) {
      process.stdout.write('Paths:\n');
      for (const p of relevantPaths) {
        process.stdout.write(`  • [${p.priority}] ${p.id} — ${p.title}\n`);
      }
      process.stdout.write('\n');
    }
    if (relevantTemplates.length > 0) {
      process.stdout.write('Templates:\n');
      for (const t of relevantTemplates) {
        process.stdout.write(`  • ${t.id} — ${t.name}\n`);
      }
      process.stdout.write('\n');
    }
    if (top.length === 0) {
      if (relevantRules.length + relevantPaths.length + relevantTemplates.length === 0) {
        process.stdout.write('(no matching knowledge entries)\n');
      }
      return 0;
    }
    process.stdout.write('Knowledge:\n');
    for (const e of top) {
      process.stdout.write(`• [${e.priority}] ${e.id} — ${e.title}\n`);
      const body = e.content
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .slice(0, 3)
        .join('\n  ');
      process.stdout.write(`  ${body}\n\n`);
    }
    return 0;
  },
};
