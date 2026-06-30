import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { cliCommandNameSet } from './command-catalog.ts';
import {
  analyzeImportGraph,
  buildAgentBrief,
  buildContradictionReport,
  buildGeneratedCodeReport,
  buildRepositoryKnowledgeModel,
  buildTaskPacket,
  buildTaskRiskReport,
  classifyChangeIntent,
  detectLanguageProfiles,
  getChangedFiles,
  getStatusSummary,
  inspectSharkcraft,
  isGitRepo,
  listConstructs,
  loadRepositoryMemory,
  type IConstruct,
  type IImportGraphAnalysis,
  type IRepositoryKnowledgeModel,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { computeMtimeFreshness } from '../status/freshness.ts';

const CONTEXT_BASE = nodePath.join('.sharkcraft', 'context');

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 60) || 'task';
}

export const understandTaskCommand: ICommandHandler = {
  name: 'understand-task',
  description: 'Build a task-specific context bundle: intent + relevant rules + likely files + risks + recommended commands. Read-only unless --save is passed.',
  usage: 'shrk [--cwd <dir>] understand-task "<task>" [--format text|markdown|json] [--save] [--preset <id>]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional[0] ?? flagString(args, 'task');
    if (!task) {
      process.stderr.write('Usage: shrk understand-task "<task>"\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    const save = flagBool(args, 'save');
    const presets = flagList(args, 'preset');

    const explain = flagBool(args, 'explain');
    const inspection = await inspectSharkcraft({ cwd });
    const packet = buildTaskPacket(inspection, task);
    const intent = await classifyChangeIntent(task, inspection);
    const risk = await buildTaskRiskReport(task, inspection);
    const brief = await buildAgentBrief(inspection, { task });
    const model = await buildRepositoryKnowledgeModel({
      inspection,
      task,
      forcedPresetIds: presets,
    });
    const ranking = await collectLikelyFilesV2({ inspection, task, model, cwd });

    const data: ITaskData = {
      task,
      intent,
      relevantRules: packet.relevantRules.map((r) => ({ id: r.id, title: r.title, priority: String((r as { priority?: string }).priority ?? 'medium') })),
      relevantPaths: packet.relevantPaths.map((p) => ({ id: p.id, title: p.title })),
      likelyFiles: ranking.files.map((f) => f.path),
      likelyFilesExplained: ranking.files.slice(0, 30),
      likelyConstructs: ranking.constructs,
      likelyLanguages: ranking.languages,
      likelyTests: ranking.tests,
      riskyGeneratedFiles: ranking.generatedFiles,
      stabilityWarnings: ranking.stabilityWarnings,
      memoryWarnings: ranking.memoryWarnings,
      suggestedFirstCommands: ranking.suggestedFirstCommands,
      confidence: ranking.confidence,
      risks: risk.reasons.map((r) => r.message),
      riskLevel: risk.riskLevel,
      requiredValidations: packet.recommendedCliCommands.map((c) => ({ command: c, label: c })),
      recommendedContract: 'shrk contract create --task "<task>" --save',
      recommendedPlaybook: packet.recommendedPipelines[0]?.pipelineId ?? null,
      nextSafeCommand: pickNextCommand(brief) ?? packet.recommendedCliCommands[0] ?? 'shrk context --task "<task>"',
      relatedModelSections: model.selectedSections,
      transformationalIntents: model.transformationalIntents,
      explain,
    };

    if (save) {
      const dir = nodePath.join(cwd, CONTEXT_BASE, 'task-contexts');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = nodePath.join(dir, `${slug(task)}.json`);
      writeFileSync(file, asJson(data), 'utf8');
      process.stderr.write(`wrote ${file}\n`);
    }

    if (format === 'json') {
      process.stdout.write(asJson(data) + '\n');
      return 0;
    }
    if (format === 'markdown') {
      process.stdout.write(renderMarkdown(data) + '\n');
      return 0;
    }
    renderText(data);
    return 0;
  },
};

export const validateChangeCommand: ICommandHandler = {
  name: 'validate-change',
  description: 'Validate a proposed/staged change: boundary violations, missing tests, policy gates, memory risk, contradictions. Read-only.',
  usage: 'shrk [--cwd <dir>] validate-change [--files a,b,c] [--since <ref>] [--staged] [--format text|markdown|json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    const files = flagList(args, 'files');
    const since = flagString(args, 'since');
    const staged = flagBool(args, 'staged');
    const json = flagBool(args, 'json');

    const inspection = await inspectSharkcraft({ cwd });
    let changed: string[] = [...files];
    if (changed.length === 0) {
      if (isGitRepo(cwd)) {
        changed = getChangedFiles(cwd, { staged, ...(since ? { since } : {}) });
      }
    }
    // Fallback path through getStatusSummary not necessary — getChangedFiles already covers it.
    void getStatusSummary;

    const contradictions = buildContradictionReport({
      inspection,
      cliCommandNames: cliCommandNameSet(),
    });
    const generated = buildGeneratedCodeReport({ inspection });
    const generatedPaths = new Set(generated.generatedFiles.map((f) => f.path));

    const boundaryHits = changed.filter((f) => looksLikeBoundaryViolation(f));
    const generatedHits = changed.filter((f) => generatedPaths.has(f) || f.endsWith('.d.ts'));
    const missingTests = changed.filter(missingTestNeighbour(inspection));
    const docHits = changed.filter((f) => f.endsWith('.md'));
    const docContradictions = contradictions.findings.filter((c) => docHits.includes(c.source));

    const result = {
      changedFiles: changed,
      boundaryHits,
      generatedHits,
      missingTests,
      docContradictions: docContradictions.map((c) => ({ source: c.source, line: c.line, message: c.message })),
      requiredValidations: [
        'bun x tsc -p tsconfig.base.json --noEmit',
        'bun test',
        'shrk check boundaries',
      ],
      verdict: boundaryHits.length === 0 && generatedHits.length === 0 ? 'pass' : 'review',
    };

    if (json || format === 'json') {
      process.stdout.write(asJson(result) + '\n');
      return 0;
    }
    process.stdout.write(header('Validate change'));
    process.stdout.write(kv('files', changed.length) + '\n');
    process.stdout.write(kv('boundary hits', boundaryHits.length) + '\n');
    process.stdout.write(kv('generated hits', generatedHits.length) + '\n');
    process.stdout.write(kv('missing tests', missingTests.length) + '\n');
    process.stdout.write(kv('doc contradictions', docContradictions.length) + '\n');
    process.stdout.write(kv('verdict', result.verdict) + '\n');
    if (boundaryHits.length > 0) {
      process.stdout.write('\nBoundary-suspect files:\n');
      for (const f of boundaryHits.slice(0, 20)) process.stdout.write(`  - ${f}\n`);
    }
    if (generatedHits.length > 0) {
      process.stdout.write('\nGenerated-file edits (review required):\n');
      for (const f of generatedHits.slice(0, 20)) process.stdout.write(`  - ${f}\n`);
    }
    return 0;
  },
};

// Subcommands grafted onto the top-level `context` command.

export const contextBuildCommand: ICommandHandler = {
  name: 'build',
  description: 'Build and (optionally) save a task-specific context bundle under .sharkcraft/context/.',
  usage: 'shrk context build --task "<task>" [--preset <id>] [--format text|markdown|json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = flagString(args, 'task');
    if (!task) {
      process.stderr.write('Missing --task\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    const presets = flagList(args, 'preset');

    const inspection = await inspectSharkcraft({ cwd });
    const packet = buildTaskPacket(inspection, task);
    const model = await buildRepositoryKnowledgeModel({
      inspection,
      task,
      forcedPresetIds: presets,
    });

    const dir = nodePath.join(cwd, CONTEXT_BASE, 'task-contexts');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const baseName = slug(task);
    const jsonFile = nodePath.join(dir, `${baseName}.json`);
    const mdFile = nodePath.join(dir, `${baseName}.md`);

    const bundle = {
      task,
      generatedAt: new Date().toISOString(),
      rules: packet.relevantRules.map((r) => ({ id: r.id, title: r.title })),
      paths: packet.relevantPaths.map((p) => ({ id: p.id, title: p.title })),
      templates: packet.relevantTemplates.map((t) => ({ id: t.id, name: (t as { name?: string; title?: string }).name ?? t.id })),
      modelSections: model.selectedSections,
      modelPresets: model.presets.map((p) => p.preset.id),
      recommendedCommands: packet.recommendedCliCommands.map((c) => ({ command: c, label: c })),
    };
    writeFileSync(jsonFile, asJson(bundle), 'utf8');
    writeFileSync(mdFile, renderBundleMarkdown(bundle), 'utf8');

    const statusFile = nodePath.join(cwd, CONTEXT_BASE, 'status.json');
    const statusDir = nodePath.dirname(statusFile);
    if (!existsSync(statusDir)) mkdirSync(statusDir, { recursive: true });
    writeFileSync(statusFile, asJson({
      lastTask: task,
      lastBuilt: bundle.generatedAt,
      bundles: [jsonFile, mdFile],
    }), 'utf8');

    if (format === 'json') {
      process.stdout.write(asJson({ jsonFile, mdFile, bundle }) + '\n');
      return 0;
    }
    process.stdout.write(header('Context built'));
    process.stdout.write(kv('json', jsonFile) + '\n');
    process.stdout.write(kv('markdown', mdFile) + '\n');
    return 0;
  },
};

export const contextRefreshCommand: ICommandHandler = {
  name: 'refresh',
  description: 'Re-build the most recently-saved task context. Reads .sharkcraft/context/status.json.',
  usage: 'shrk context refresh',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const file = nodePath.join(cwd, CONTEXT_BASE, 'status.json');
    if (!existsSync(file)) {
      process.stderr.write('No saved task context to refresh. Run `shrk context build --task "..."` first.\n');
      return 1;
    }
    const { readFileSync } = await import('node:fs');
    const status = JSON.parse(readFileSync(file, 'utf8')) as { lastTask?: string };
    if (!status.lastTask) {
      process.stderr.write('No lastTask in status.json.\n');
      return 1;
    }
    const flags = new Map(args.flags);
    flags.set('task', status.lastTask);
    return contextBuildCommand.run({ ...args, flags });
  },
};

export const contextStatusCommand: ICommandHandler = {
  name: 'status',
  description: 'Show the current task context status (last task / built / bundles).',
  usage: 'shrk context status',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const file = nodePath.join(cwd, CONTEXT_BASE, 'status.json');
    if (!existsSync(file)) {
      process.stdout.write('No context status yet.\n');
      return 0;
    }
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(file, 'utf8');
    let status: { lastTask?: string; lastBuilt?: string; bundles?: readonly string[] };
    try {
      status = JSON.parse(body) as typeof status;
    } catch {
      status = {};
    }
    // Honest freshness: the saved context is stale once a source file changed
    // after it was built. Adds `state` + a warn line in both shapes.
    const fresh = computeMtimeFreshness(cwd, status.lastBuilt);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          ...status,
          state: fresh.state,
          lastBuiltAt: fresh.lastBuiltAt,
          lastChangedAt: fresh.lastChangedAt,
          behindMs: fresh.behindMs,
          ...(fresh.state === 'stale' ? { nextCommand: 'shrk context refresh' } : {}),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Context status'));
    process.stdout.write(kv('last task', status.lastTask ?? '-') + '\n');
    process.stdout.write(kv('last built', status.lastBuilt ?? '-') + '\n');
    process.stdout.write(kv('state', fresh.state) + '\n');
    if (fresh.state === 'stale') {
      process.stdout.write(
        `! stale — files changed since this context was built${fresh.lastChangedAt ? ` (last change ${fresh.lastChangedAt})` : ''}; re-run \`shrk context refresh\`\n`,
      );
    }
    return 0;
  },
};

interface ILikelyFile {
  path: string;
  score: number;
  reasons: readonly string[];
}

interface ILikelyFilesRanking {
  files: readonly ILikelyFile[];
  constructs: readonly { id: string; title: string; reason: string }[];
  languages: readonly string[];
  tests: readonly string[];
  generatedFiles: readonly string[];
  stabilityWarnings: readonly string[];
  memoryWarnings: readonly string[];
  suggestedFirstCommands: readonly string[];
  /** 0..100. */
  confidence: number;
}

interface ILikelyFilesInput {
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>;
  task: string;
  model: IRepositoryKnowledgeModel;
  cwd: string;
}

function tokenize(task: string): readonly string[] {
  return Array.from(new Set(
    task.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3),
  ));
}

function languagesFromTask(task: string): readonly string[] {
  const lower = task.toLowerCase();
  const out: string[] = [];
  if (/\bangular\b|\bcomponent\b|\bsignal\b|\bdirective\b/.test(lower)) out.push('typescript');
  if (/\btypescript\b|\b\.ts\b/.test(lower)) out.push('typescript');
  if (/\bjava\b|\bspring\b/.test(lower)) out.push('java');
  if (/\b(c#|csharp|dotnet|asp\.?net)\b/.test(lower)) out.push('csharp');
  if (/\bpython\b|\bdjango\b|\bfastapi\b|\bflask\b/.test(lower)) out.push('python');
  if (/\bgolang\b|\bgo\s+(service|module|test)\b/.test(lower)) out.push('go');
  if (/\brust\b|\bcargo\b/.test(lower)) out.push('rust');
  return Array.from(new Set(out));
}

function constructTokens(c: IConstruct): readonly string[] {
  const id = c.id.toLowerCase();
  const title = (c.title ?? '').toLowerCase();
  return Array.from(new Set([
    ...id.split(/[^a-z0-9]+/).filter((t) => t.length >= 3),
    ...title.split(/[^a-z0-9]+/).filter((t) => t.length >= 3),
  ]));
}

async function collectLikelyFilesV2(input: ILikelyFilesInput): Promise<ILikelyFilesRanking> {
  const { inspection, task, model } = input;
  const tokens = tokenize(task);
  const allFiles = inspection.sourceFiles;
  const scoreByPath = new Map<string, { score: number; reasons: Set<string> }>();
  const bump = (path: string, score: number, reason: string): void => {
    const cur = scoreByPath.get(path) ?? { score: 0, reasons: new Set<string>() };
    cur.score += score;
    cur.reasons.add(reason);
    scoreByPath.set(path, cur);
  };

  // 1) Token matching (baseline, but now scored by token-strength).
  for (const f of allFiles) {
    const lf = f.toLowerCase();
    for (const t of tokens) {
      if (lf.includes(t)) bump(f, t.length >= 6 ? 4 : 2, `token "${t}" appears in path`);
    }
  }

  // 2) Construct vocabulary + path matching.
  let constructs: readonly IConstruct[] = [];
  try { constructs = listConstructs(inspection); } catch { /* ignore */ }
  const constructMatches: { id: string; title: string; reason: string }[] = [];
  for (const c of constructs) {
    const ctokens = constructTokens(c);
    const overlap = ctokens.filter((t) => tokens.includes(t));
    if (overlap.length === 0) continue;
    constructMatches.push({ id: c.id, title: c.title, reason: `construct vocabulary overlap: ${overlap.join(', ')}` });
    const filesForConstruct = [...(c.files ?? []), ...(c.publicApi ?? [])];
    for (const f of filesForConstruct) bump(f, 6, `construct match: ${c.id}`);
  }

  // 3) Language vocabulary boost — files whose extension matches a detected
  // language token bias toward inclusion.
  const taskLangs = languagesFromTask(task);
  const profile = detectLanguageProfiles(input.cwd);
  const detectedLangs = profile.profiles.map((p) => p.language);
  const langsToBoost = taskLangs.length > 0 ? taskLangs : detectedLangs;
  for (const f of allFiles) {
    const lf = f.toLowerCase();
    for (const lang of langsToBoost) {
      if ((lang === 'typescript' && /\.tsx?$/.test(lf)) || (lang === 'java' && lf.endsWith('.java'))
        || (lang === 'csharp' && lf.endsWith('.cs')) || (lang === 'python' && lf.endsWith('.py'))
        || (lang === 'go' && lf.endsWith('.go')) || (lang === 'rust' && lf.endsWith('.rs'))) {
        if (scoreByPath.has(f)) bump(f, 1, `language match: ${lang}`);
      }
    }
  }

  // 4) Dependency-graph proximity — neighbours of a matched file (callers/callees).
  let graph: IImportGraphAnalysis | undefined;
  try { graph = analyzeImportGraph(input.cwd); } catch { /* ignore */ }
  if (graph) {
    const matchedSoFar = new Set([...scoreByPath.keys()]);
    for (const node of graph.topFanIn) {
      const file = node.file.replace(/\\/g, '/');
      if (matchedSoFar.has(file)) {
        bump(file, 2, `high fan-in (${node.in} importers)`);
      }
    }
  }

  // 5) Stability-aware boost / penalty.
  const stabilityWarnings: string[] = [];
  for (const area of model.stableExperimentalDeprecated.areas) {
    for (const f of [...scoreByPath.keys()]) {
      if (!f.startsWith(area.path + '/') && f !== area.path) continue;
      if (area.kind === 'public-api' || area.kind === 'stable') bump(f, 3, `under ${area.kind} area`);
      if (area.kind === 'deprecated' || area.kind === 'legacy') {
        bump(f, -3, `under ${area.kind} area`);
        stabilityWarnings.push(`${f} is under ${area.kind} area "${area.path}"`);
      }
      if (area.kind === 'experimental') {
        stabilityWarnings.push(`${f} is in experimental area "${area.path}"`);
      }
      if (area.kind === 'high-risk') stabilityWarnings.push(`${f} sits in high-risk area "${area.path}"`);
    }
  }

  // 6) Memory hotspot boost (repo memory if available).
  const memory = loadRepositoryMemory(input.cwd);
  const memoryWarnings: string[] = [];
  if (memory) {
    for (const f of memory.files) {
      const score = f.touchCount + f.conflictCount + f.failedValidationCount;
      if (score < 2) continue;
      if (scoreByPath.has(f.path)) {
        bump(f.path, Math.min(score, 6), `memory hotspot (${score}x)`);
        if (f.conflictCount > 0) memoryWarnings.push(`${f.path} has ${f.conflictCount} historical plan conflict(s)`);
      }
    }
  }

  // 7) Generated-code penalty + warning.
  const generatedFiles: string[] = [];
  for (const f of model.generatedVsHandwritten.generatedFiles) {
    if (scoreByPath.has(f.path)) {
      bump(f.path, -10, `generated file (${f.kind})`);
      generatedFiles.push(f.path);
    }
  }

  // 8) Path-convention boost — paths from rulesAndConventions.paths.
  for (const p of model.rulesAndConventions.paths) {
    const pattern = ((p as { pattern?: string }).pattern ?? '').toLowerCase();
    if (!pattern) continue;
    for (const f of [...scoreByPath.keys()]) {
      if (f.toLowerCase().includes(pattern.replace(/\*/g, '').replace(/\//g, ''))) {
        bump(f, 1, `path convention match: ${p.id}`);
      }
    }
  }

  // 10) Tests — files that look like they test the matched files.
  const tests: string[] = [];
  for (const f of [...scoreByPath.keys()]) {
    const base = f.replace(/\.(ts|tsx|js|jsx|java|cs|py|go|rs)$/, '');
    for (const cand of [`${base}.test.ts`, `${base}.spec.ts`, `${base}_test.go`, `${base}_test.py`, `${base}_spec.py`]) {
      if (allFiles.includes(cand)) tests.push(cand);
    }
  }

  // Sort and slice.
  const sorted = [...scoreByPath.entries()]
    .map(([path, v]) => ({ path, score: v.score, reasons: Array.from(v.reasons) }))
    .filter((f) => f.score > 0 && !generatedFiles.includes(f.path))
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);

  const confidence = Math.min(100, Math.round(
    20
    + Math.min(40, sorted.length * 2)
    + (constructMatches.length > 0 ? 15 : 0)
    + (graph ? 10 : 0)
    + (memory ? 10 : 0),
  ));

  const suggestedFirstCommands: string[] = [];
  if (constructMatches.length > 0) suggestedFirstCommands.push(`shrk constructs get ${constructMatches[0]!.id}`);
  if (sorted.length > 0 && sorted[0]) suggestedFirstCommands.push(`shrk impact ${sorted[0].path}`);
  if (generatedFiles.length > 0) suggestedFirstCommands.push('shrk generated report');
  if (stabilityWarnings.length > 0) suggestedFirstCommands.push('shrk stability map');
  if (suggestedFirstCommands.length === 0) suggestedFirstCommands.push('shrk task "' + task + '"');

  return {
    files: sorted,
    constructs: constructMatches.slice(0, 8),
    languages: langsToBoost.slice(0, 4),
    tests: Array.from(new Set(tests)).slice(0, 12),
    generatedFiles: generatedFiles.slice(0, 12),
    stabilityWarnings: Array.from(new Set(stabilityWarnings)).slice(0, 12),
    memoryWarnings: Array.from(new Set(memoryWarnings)).slice(0, 12),
    suggestedFirstCommands: Array.from(new Set(suggestedFirstCommands)).slice(0, 6),
    confidence,
  };
}

function looksLikeBoundaryViolation(file: string): boolean {
  // Heuristic: edits to cross-package barrels often signal a boundary change.
  return /(^|\/)packages\/[^\/]+\/src\/index\.(ts|tsx|js)$/.test(file);
}

function missingTestNeighbour(inspection: Awaited<ReturnType<typeof inspectSharkcraft>>) {
  const set = new Set(inspection.sourceFiles);
  return (file: string): boolean => {
    if (!/\.(ts|tsx)$/.test(file)) return false;
    if (/\.test\.|\.spec\.|__tests__\//.test(file)) return false;
    const base = file.replace(/\.(ts|tsx)$/, '');
    const candidates = [`${base}.test.ts`, `${base}.spec.ts`, `${base}.test.tsx`];
    return !candidates.some((c) => set.has(c));
  };
}

function renderMarkdown(data: ITaskData): string {
  const lines: string[] = [];
  lines.push(`# Understand task — ${data.task}`);
  lines.push('');
  lines.push(`- Risk: **${data.riskLevel}**`);
  lines.push(`- Confidence: **${data.confidence}/100**`);
  lines.push(`- Languages: ${data.likelyLanguages.map((l) => '`' + l + '`').join(', ') || '_(none)_'}`);
  lines.push('');
  if (data.relevantRules.length > 0) {
    lines.push('## Relevant rules');
    for (const r of data.relevantRules) lines.push(`- \`${r.id}\` — ${r.title} (priority: ${r.priority})`);
    lines.push('');
  }
  if (data.likelyFiles.length > 0) {
    lines.push('## Likely files');
    if (data.explain) {
      lines.push('| Score | Path | Reasons |');
      lines.push('|---|---|---|');
      for (const f of data.likelyFilesExplained.slice(0, 30)) {
        lines.push(`| ${f.score} | \`${f.path}\` | ${f.reasons.join('; ')} |`);
      }
    } else {
      for (const f of data.likelyFiles) lines.push(`- \`${f}\``);
    }
    lines.push('');
  }
  if (data.likelyConstructs.length > 0) {
    lines.push('## Likely constructs');
    for (const c of data.likelyConstructs) lines.push(`- \`${c.id}\` — ${c.title} (${c.reason})`);
    lines.push('');
  }
  if (data.likelyTests.length > 0) {
    lines.push('## Likely tests');
    for (const t of data.likelyTests) lines.push(`- \`${t}\``);
    lines.push('');
  }
  if (data.riskyGeneratedFiles.length > 0) {
    lines.push('## Risky generated files (do NOT edit by hand)');
    for (const f of data.riskyGeneratedFiles) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (data.stabilityWarnings.length > 0) {
    lines.push('## Stability warnings');
    for (const w of data.stabilityWarnings) lines.push(`- ${w}`);
    lines.push('');
  }
  if (data.memoryWarnings.length > 0) {
    lines.push('## Memory warnings');
    for (const w of data.memoryWarnings) lines.push(`- ${w}`);
    lines.push('');
  }
  if (data.suggestedFirstCommands.length > 0) {
    lines.push('## Suggested first commands');
    for (const c of data.suggestedFirstCommands) lines.push(`- \`${c}\``);
    lines.push('');
  }
  if (data.requiredValidations.length > 0) {
    lines.push('## Required validations');
    for (const v of data.requiredValidations) lines.push(`- \`${v.command}\``);
    lines.push('');
  }
  lines.push(`**Next safe command:** \`${data.nextSafeCommand}\``);
  return lines.join('\n');
}

function pickNextCommand(brief: { sections: readonly { id: string; items?: readonly { command?: string }[] }[] }): string | undefined {
  for (const s of brief.sections) {
    if (s.id === 'action-hints' && s.items && s.items.length > 0 && s.items[0]?.command) {
      return s.items[0].command;
    }
  }
  return undefined;
}

function renderBundleMarkdown(b: {
  task: string;
  generatedAt: string;
  rules: readonly { id: string; title: string }[];
  paths: readonly { id: string; title: string }[];
  templates: readonly { id: string; name: string }[];
  modelSections: readonly string[];
  modelPresets: readonly string[];
  recommendedCommands: readonly { command: string; label: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`# Task context — ${b.task}`);
  lines.push('');
  lines.push(`_Built ${b.generatedAt}._`);
  lines.push('');
  lines.push(`## Relevant rules (${b.rules.length})`);
  for (const r of b.rules) lines.push(`- \`${r.id}\` — ${r.title}`);
  lines.push('');
  lines.push(`## Relevant paths (${b.paths.length})`);
  for (const p of b.paths) lines.push(`- \`${p.id}\` — ${p.title}`);
  lines.push('');
  lines.push(`## Templates (${b.templates.length})`);
  for (const t of b.templates) lines.push(`- \`${t.id}\` — ${t.name}`);
  lines.push('');
  lines.push(`## Presets: ${b.modelPresets.join(', ') || '_(none)_'}`);
  lines.push('');
  lines.push('## Recommended commands');
  for (const c of b.recommendedCommands) lines.push(`- \`${c.command}\` — ${c.label}`);
  return lines.join('\n');
}

interface ITaskData {
  task: string;
  intent: unknown;
  relevantRules: readonly { id: string; title: string; priority: string }[];
  relevantPaths: readonly { id: string; title: string }[];
  likelyFiles: readonly string[];
  likelyFilesExplained: readonly { path: string; score: number; reasons: readonly string[] }[];
  likelyConstructs: readonly { id: string; title: string; reason: string }[];
  likelyLanguages: readonly string[];
  likelyTests: readonly string[];
  riskyGeneratedFiles: readonly string[];
  stabilityWarnings: readonly string[];
  memoryWarnings: readonly string[];
  suggestedFirstCommands: readonly string[];
  confidence: number;
  risks: readonly string[];
  riskLevel: string;
  requiredValidations: readonly { command: string; label: string }[];
  recommendedContract: string;
  recommendedPlaybook: string | null;
  nextSafeCommand: string;
  relatedModelSections: readonly string[];
  transformationalIntents: readonly string[];
  explain: boolean;
}

function renderText(data: ITaskData): void {
  process.stdout.write(header(`understand-task — ${data.task}`));
  process.stdout.write(kv('risk', data.riskLevel) + '\n');
  process.stdout.write(kv('confidence', `${data.confidence}/100`) + '\n');
  process.stdout.write(kv('rules', data.relevantRules.length) + '\n');
  process.stdout.write(kv('paths', data.relevantPaths.length) + '\n');
  process.stdout.write(kv('likely files', data.likelyFiles.length) + '\n');
  process.stdout.write(kv('likely constructs', data.likelyConstructs.length) + '\n');
  process.stdout.write(kv('likely languages', data.likelyLanguages.join(', ') || '-') + '\n');
  if (data.risks.length > 0) {
    process.stdout.write('\nRisks:\n');
    for (const r of data.risks.slice(0, 10)) process.stdout.write(`  - ${r}\n`);
  }
  if (data.likelyFiles.length > 0) {
    process.stdout.write('\nLikely files:\n');
    if (data.explain) {
      for (const f of data.likelyFilesExplained.slice(0, 20)) {
        process.stdout.write(`  [${f.score}] ${f.path}\n`);
        for (const r of f.reasons) process.stdout.write(`        - ${r}\n`);
      }
    } else {
      for (const f of data.likelyFiles.slice(0, 15)) process.stdout.write(`  - ${f}\n`);
    }
  }
  if (data.likelyTests.length > 0) {
    process.stdout.write('\nLikely tests:\n');
    for (const t of data.likelyTests.slice(0, 10)) process.stdout.write(`  - ${t}\n`);
  }
  if (data.riskyGeneratedFiles.length > 0) {
    process.stdout.write('\nGenerated files (do NOT edit by hand):\n');
    for (const f of data.riskyGeneratedFiles.slice(0, 10)) process.stdout.write(`  - ${f}\n`);
  }
  if (data.stabilityWarnings.length > 0) {
    process.stdout.write('\nStability warnings:\n');
    for (const w of data.stabilityWarnings.slice(0, 10)) process.stdout.write(`  - ${w}\n`);
  }
  if (data.memoryWarnings.length > 0) {
    process.stdout.write('\nMemory warnings:\n');
    for (const w of data.memoryWarnings.slice(0, 10)) process.stdout.write(`  - ${w}\n`);
  }
  if (data.suggestedFirstCommands.length > 0) {
    process.stdout.write('\nSuggested first commands:\n');
    for (const c of data.suggestedFirstCommands) process.stdout.write(`  - ${c}\n`);
  }
  if (data.requiredValidations.length > 0) {
    process.stdout.write('\nRequired validations:\n');
    for (const v of data.requiredValidations) process.stdout.write(`  - ${v.command}\n`);
  }
  process.stdout.write(`\nNext safe command: \`${data.nextSafeCommand}\`\n`);
  process.stdout.write(`Recommended contract: \`${data.recommendedContract}\`\n`);
  if (data.recommendedPlaybook) process.stdout.write(`Recommended playbook: \`${data.recommendedPlaybook}\`\n`);
}
