import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { IPipelineDefinition } from '@shrkcrft/pipelines';
import type { IPreset, IResolvedPreset } from '@shrkcrft/presets';

/**
 * Deterministic relevance ranker.
 *
 * Inputs: a free-text task + structured signals (tags, scope, priority,
 * appliesWhen, title, description, actionHints.relatedTemplates /
 * relatedPathConventions, pipeline steps/templates, preset appliesTo).
 *
 * No AI. No embeddings. Pure scoring + reasons.
 */

export interface IRankedItem<T> {
  item: T;
  score: number;
  reasons: string[];
}

// ── Verb hints (what kind of work) ──────────────────────────────────────
const VERB_HINTS: { regex: RegExp; appliesWhen: string[]; tags: string[] }[] = [
  {
    regex: /\b(create|add|implement|generate|new|build|introduce|provide)\b/,
    appliesWhen: ['generate-code', 'generate-service', 'generate-utility', 'generate-template'],
    tags: ['feature', 'generation'],
  },
  {
    regex: /\b(refactor|rewrite|migrate|extract|rename)\b/,
    appliesWhen: ['refactor'],
    tags: ['refactor', 'safe', 'generation'],
  },
  {
    regex: /\b(test|spec|coverage)\b/,
    appliesWhen: ['generate-test'],
    tags: ['test', 'testing'],
  },
  {
    regex: /\b(fix|bug|broken|crash)\b/,
    appliesWhen: ['fix-bug'],
    tags: ['safety'],
  },
  {
    regex: /\b(review|audit|inspect)\b/,
    appliesWhen: ['review-pr', 'check-boundaries'],
    tags: ['review'],
  },
];

// ── Domain hints (what *kind of thing* is being worked on) ──────────────
// These boost rules/templates/pipelines whose own `appliesWhen` or `tags`
// declare the same domain — much higher signal than verb hints alone for
// "create a *service*" vs "add a *utility*".
const DOMAIN_HINTS: { token: string; appliesWhen: string[]; tags: string[] }[] = [
  {
    token: 'service',
    appliesWhen: ['generate-service'],
    tags: ['service'],
  },
  {
    token: 'utility',
    appliesWhen: ['generate-utility'],
    tags: ['utility', 'utils'],
  },
  {
    token: 'utilities',
    appliesWhen: ['generate-utility'],
    tags: ['utility', 'utils'],
  },
  {
    token: 'pipeline',
    appliesWhen: ['create-pipeline'],
    tags: ['pipeline'],
  },
  {
    token: 'route',
    appliesWhen: ['generate-route'],
    tags: ['http', 'routes', 'api'],
  },
];

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function uniqueTokens(s: string): Set<string> {
  return new Set(tokenize(s));
}

function score(reasons: string[], by: number, why: string): number {
  reasons.push(why);
  return by;
}

function commonTokens(a: Set<string>, b: Iterable<string>): string[] {
  const out: string[] = [];
  for (const t of b) if (a.has(t)) out.push(t);
  return out;
}

/** Match free-text task tokens against a string corpus and return a token-hit count. */
function tokenHits(taskTokens: Set<string>, ...corpus: (string | undefined)[]): number {
  let hits = 0;
  for (const c of corpus) {
    if (!c) continue;
    const tokens = tokenize(c);
    for (const t of tokens) if (taskTokens.has(t)) hits += 1;
  }
  return hits;
}

interface ITaskContext {
  /** Verb-driven appliesWhen tokens. */
  verbAppliesWhen: Set<string>;
  /** Verb-driven tag tokens. */
  verbTags: Set<string>;
  /** Domain-driven appliesWhen tokens (plugin/capability/…). */
  domainAppliesWhen: Set<string>;
  /** Domain-driven tag tokens. */
  domainTags: Set<string>;
  /** Domain tokens detected verbatim in the task. */
  domainTokens: Set<string>;
  /** All task tokens (length ≥ 3). */
  taskTokens: Set<string>;
}

function deriveContext(task: string): ITaskContext {
  const lower = task.toLowerCase();
  const verbAppliesWhen = new Set<string>();
  const verbTags = new Set<string>();
  for (const v of VERB_HINTS) {
    if (v.regex.test(lower)) {
      for (const a of v.appliesWhen) verbAppliesWhen.add(a);
      for (const t of v.tags) verbTags.add(t);
    }
  }
  const taskTokens = uniqueTokens(task);
  const domainAppliesWhen = new Set<string>();
  const domainTags = new Set<string>();
  const domainTokens = new Set<string>();
  for (const d of DOMAIN_HINTS) {
    if (taskTokens.has(d.token)) {
      domainTokens.add(d.token);
      for (const a of d.appliesWhen) domainAppliesWhen.add(a);
      for (const t of d.tags) domainTags.add(t);
    }
  }
  return {
    verbAppliesWhen,
    verbTags,
    domainAppliesWhen,
    domainTags,
    domainTokens,
    taskTokens,
  };
}

// Domain-tag matches outweigh generic verb-tag matches. The intent: a rule
// tagged `plugin` should rank above a generic `feature` rule when the task
// mentions a plugin.
const DOMAIN_TAG_WEIGHT = 6;
const VERB_TAG_WEIGHT = 2;
const DOMAIN_APPLIES_WEIGHT = 6;
const VERB_APPLIES_WEIGHT = 4;
const TITLE_DOMAIN_TOKEN_WEIGHT = 4;

function applyTagScore(
  itemTags: readonly string[],
  ctx: ITaskContext,
  reasons: string[],
): number {
  let s = 0;
  const itemTagSet = new Set(itemTags ?? []);
  const domainHits = commonTokens(ctx.domainTags, itemTagSet);
  if (domainHits.length) {
    s += score(reasons, DOMAIN_TAG_WEIGHT * domainHits.length, `domain tags: ${domainHits.join(', ')}`);
  }
  const verbHits = commonTokens(ctx.verbTags, itemTagSet);
  if (verbHits.length) {
    s += score(reasons, VERB_TAG_WEIGHT * verbHits.length, `tags: ${verbHits.join(', ')}`);
  }
  return s;
}

function applyAppliesWhenScore(
  itemAppliesWhen: readonly string[] | undefined,
  ctx: ITaskContext,
  reasons: string[],
): number {
  let s = 0;
  const set = new Set(itemAppliesWhen ?? []);
  const domainHits = commonTokens(ctx.domainAppliesWhen, set);
  if (domainHits.length) {
    s += score(
      reasons,
      DOMAIN_APPLIES_WEIGHT * domainHits.length,
      `appliesWhen(domain): ${domainHits.join(', ')}`,
    );
  }
  const verbHits = commonTokens(ctx.verbAppliesWhen, set);
  if (verbHits.length) {
    s += score(
      reasons,
      VERB_APPLIES_WEIGHT * verbHits.length,
      `appliesWhen: ${verbHits.join(', ')}`,
    );
  }
  return s;
}

function applyTitleDomainBoost(
  text: string | undefined,
  ctx: ITaskContext,
  reasons: string[],
): number {
  if (!text) return 0;
  let s = 0;
  const titleTokens = new Set(tokenize(text));
  for (const dom of ctx.domainTokens) {
    if (titleTokens.has(dom)) {
      s += score(reasons, TITLE_DOMAIN_TOKEN_WEIGHT, `title mentions "${dom}"`);
    }
  }
  return s;
}

function applyIdDomainBoost(
  id: string,
  ctx: ITaskContext,
  reasons: string[],
): number {
  let s = 0;
  const idLower = id.toLowerCase();
  for (const dom of ctx.domainTokens) {
    if (idLower.includes(dom)) {
      s += score(reasons, 3, `id contains "${dom}"`);
    }
  }
  return s;
}

// ── Knowledge entries (rules, paths, other) ─────────────────────────────
export function rankKnowledgeEntries(
  entries: readonly IKnowledgeEntry[],
  task: string,
): IRankedItem<IKnowledgeEntry>[] {
  const ctx = deriveContext(task);
  const out: IRankedItem<IKnowledgeEntry>[] = [];
  for (const e of entries) {
    const reasons: string[] = [];
    let s = 0;
    // Priority baseline — lower than before to let structured matches dominate.
    const p = String(e.priority);
    if (p === 'critical') s += score(reasons, 4, 'priority:critical');
    else if (p === 'high') s += score(reasons, 3, 'priority:high');
    else if (p === 'medium') s += score(reasons, 1, 'priority:medium');
    s += applyAppliesWhenScore(e.appliesWhen, ctx, reasons);
    s += applyTagScore(e.tags ?? [], ctx, reasons);
    s += applyTitleDomainBoost(e.title, ctx, reasons);
    s += applyIdDomainBoost(e.id, ctx, reasons);
    const hits = tokenHits(ctx.taskTokens, e.title, e.content, (e.tags ?? []).join(' '));
    if (hits) s += score(reasons, Math.min(6, hits), `token hits: ${hits}`);
    if (s > 0) out.push({ item: e, score: s, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── Templates ───────────────────────────────────────────────────────────
export function rankTemplates(
  templates: readonly ITemplateDefinition[],
  task: string,
): IRankedItem<ITemplateDefinition>[] {
  const ctx = deriveContext(task);
  const out: IRankedItem<ITemplateDefinition>[] = [];
  for (const t of templates) {
    const reasons: string[] = [];
    let s = 0;
    s += applyAppliesWhenScore(t.appliesWhen, ctx, reasons);
    s += applyTagScore(t.tags ?? [], ctx, reasons);
    s += applyTitleDomainBoost(t.name, ctx, reasons);
    s += applyTitleDomainBoost(t.description, ctx, reasons);
    s += applyIdDomainBoost(t.id, ctx, reasons);
    const hits = tokenHits(ctx.taskTokens, t.id, t.name, t.description, (t.tags ?? []).join(' '));
    if (hits) s += score(reasons, Math.min(8, hits * 2), `token hits: ${hits}`);
    if (s > 0) out.push({ item: t, score: s, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── Path conventions (treated like knowledge entries with type "path") ──
export function rankPathConventions(
  paths: readonly IKnowledgeEntry[],
  task: string,
): IRankedItem<IKnowledgeEntry>[] {
  return rankKnowledgeEntries(paths, task);
}

// ── Pipelines ───────────────────────────────────────────────────────────
export function rankPipelines(
  pipelines: readonly IPipelineDefinition[],
  task: string,
): IRankedItem<IPipelineDefinition>[] {
  const ctx = deriveContext(task);
  const out: IRankedItem<IPipelineDefinition>[] = [];
  for (const p of pipelines) {
    const reasons: string[] = [];
    let s = 0;
    s += applyTagScore(p.tags ?? [], ctx, reasons);
    s += applyTitleDomainBoost(p.title, ctx, reasons);
    s += applyTitleDomainBoost(p.description, ctx, reasons);
    s += applyIdDomainBoost(p.id, ctx, reasons);
    const stepReasons: string[] = [];
    for (const step of p.steps ?? []) {
      const stepHits = tokenHits(ctx.taskTokens, step.id, step.description, step.instruction);
      if (stepHits > 0) {
        s += Math.min(3, stepHits);
        stepReasons.push(`${step.id}:${stepHits}`);
      }
      // Step references to templates that match the domain.
      for (const ref of step.references ?? []) {
        for (const dom of ctx.domainTokens) {
          if (ref.toLowerCase().includes(dom)) {
            s += score(reasons, 2, `step ${step.id} references ${ref}`);
            break;
          }
        }
      }
    }
    if (stepReasons.length) reasons.push(`step hits: ${stepReasons.join(', ')}`);
    const titleHits = tokenHits(ctx.taskTokens, p.title, p.description);
    if (titleHits) s += score(reasons, Math.min(8, titleHits * 2), `title/description hits: ${titleHits}`);
    if (s > 0) out.push({ item: p, score: s, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── Presets ─────────────────────────────────────────────────────────────
export function rankPresets(
  presets: readonly IPreset[],
  task: string,
  detectedProfiles: readonly string[],
): IRankedItem<IPreset>[] {
  const ctx = deriveContext(task);
  const profileSet = new Set(detectedProfiles);
  const out: IRankedItem<IPreset>[] = [];
  for (const p of presets) {
    const reasons: string[] = [];
    let s = p.weight ?? 5;
    if (s > 0) reasons.push(`base weight: ${s}`);
    let blocked = false;
    for (const need of p.appliesTo ?? []) {
      if (profileSet.has(need as string)) {
        s += score(reasons, 5, `profile matches: ${need}`);
      }
    }
    for (const block of p.notAppropriateFor ?? []) {
      if (profileSet.has(block as string)) {
        blocked = true;
        reasons.push(`not appropriate: ${block}`);
        break;
      }
    }
    if (blocked) continue;
    s += applyTagScore(p.tags ?? [], ctx, reasons);
    s += applyTitleDomainBoost(p.title, ctx, reasons);
    s += applyTitleDomainBoost(p.description, ctx, reasons);
    s += applyIdDomainBoost(p.id, ctx, reasons);
    const hits = tokenHits(ctx.taskTokens, p.id, p.title, p.description);
    if (hits) s += score(reasons, Math.min(6, hits), `token hits: ${hits}`);
    out.push({ item: p, score: s, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── Convenience: top-N of each ──────────────────────────────────────────
export interface IRankAllResult {
  rules: IRankedItem<IKnowledgeEntry>[];
  paths: IRankedItem<IKnowledgeEntry>[];
  templates: IRankedItem<ITemplateDefinition>[];
  pipelines: IRankedItem<IPipelineDefinition>[];
  presets: IRankedItem<IPreset>[];
}

export function rankAll(
  inspection: {
    knowledgeEntries: readonly IKnowledgeEntry[];
    templates: readonly ITemplateDefinition[];
    pipelines: readonly IPipelineDefinition[];
    presetRegistry: { list: () => readonly IPreset[] };
    workspace: { profiles: readonly string[] };
    ruleService: { list: () => readonly IKnowledgeEntry[] };
    pathService: { list: () => readonly IKnowledgeEntry[] };
  },
  task: string,
  limit: number = 10,
): IRankAllResult {
  const initialRules = rankKnowledgeEntries(inspection.ruleService.list(), task);
  const initialPaths = rankPathConventions(inspection.pathService.list(), task);
  const initialTemplates = rankTemplates(inspection.templates, task);
  const initialPipelines = rankPipelines(inspection.pipelines, task);

  // Cross-link boost: once we know the top templates and paths, walk the
  // top entries again and bump rules whose actionHints reference those
  // ids. This produces the "related-X amplifies Y" signal without making
  // the per-rule scoring expensive.
  const topTemplateIds = new Set(initialTemplates.slice(0, 8).map((r) => r.item.id));
  const topPathIds = new Set(initialPaths.slice(0, 8).map((r) => r.item.id));
  const rules = initialRules.map((r) => {
    let extra = 0;
    const extraReasons: string[] = [];
    const ah = r.item.actionHints;
    if (ah) {
      for (const tid of ah.relatedTemplates ?? []) {
        if (topTemplateIds.has(tid)) {
          extra += 4;
          extraReasons.push(`relatedTemplate hit: ${tid}`);
        }
      }
      for (const pid of ah.relatedPathConventions ?? []) {
        if (topPathIds.has(pid)) {
          extra += 3;
          extraReasons.push(`relatedPath hit: ${pid}`);
        }
      }
    }
    if (extra === 0) return r;
    return { item: r.item, score: r.score + extra, reasons: [...r.reasons, ...extraReasons] };
  });
  rules.sort((a, b) => b.score - a.score);

  // Pipeline → template cross-link: bump templates that the top pipeline
  // references in any step.
  const topPipeline = initialPipelines[0]?.item;
  const referencedFromTopPipeline = new Set<string>();
  if (topPipeline) {
    for (const step of topPipeline.steps ?? []) {
      for (const ref of step.references ?? []) referencedFromTopPipeline.add(ref);
    }
  }
  const templates = initialTemplates.map((r) => {
    if (!referencedFromTopPipeline.has(r.item.id)) return r;
    return {
      item: r.item,
      score: r.score + 3,
      reasons: [...r.reasons, `referenced by top pipeline ${topPipeline?.id}`],
    };
  });
  templates.sort((a, b) => b.score - a.score);

  return {
    rules: rules.slice(0, limit),
    paths: initialPaths.slice(0, limit),
    templates: templates.slice(0, limit),
    pipelines: initialPipelines.slice(0, limit),
    presets: rankPresets(
      inspection.presetRegistry.list(),
      task,
      inspection.workspace.profiles,
    ).slice(0, limit),
  };
}

// Expose a small "explain" formatter for CLI/MCP output.
export function explainRanked<T>(
  items: readonly IRankedItem<T>[],
  describe: (item: T) => string,
  limit: number = 5,
): string {
  return items
    .slice(0, limit)
    .map((r) => `  • [${r.score}] ${describe(r.item)}  — ${r.reasons.join('; ')}`)
    .join('\n');
}

/** Re-export resolved-preset for callers that want to combine ranker + composition. */
export type { IResolvedPreset };
