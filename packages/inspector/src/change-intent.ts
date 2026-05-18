/**
 * Deterministic change-intent classifier.
 *
 * Given a task string + the loaded SharkCraft inspection, classify the
 * intent (feature / bugfix / refactor / test / docs / migration /
 * architecture / policy / release) plus likely constructs / templates /
 * pipelines, risk hints, and a suggested first command.
 *
 * No AI. Heuristics only — verbs, known construct/template/pipeline
 * names + tags, action-hint command surface, and the search index when
 * available.
 */
import { listConstructs, loadConstructs } from './construct-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const CHANGE_INTENT_SCHEMA = 'sharkcraft.change-intent/v1';

export enum ChangeIntentKind {
  Feature = 'feature',
  Bugfix = 'bugfix',
  Refactor = 'refactor',
  Test = 'test',
  Docs = 'docs',
  Migration = 'migration',
  Architecture = 'architecture',
  Policy = 'policy',
  Release = 'release',
  Unknown = 'unknown',
}

export enum ChangeIntentConfidence {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export interface IChangeIntent {
  schema: typeof CHANGE_INTENT_SCHEMA;
  task: string;
  kind: ChangeIntentKind;
  domains: readonly string[];
  likelyConstructs: readonly string[];
  likelyTemplates: readonly string[];
  likelyPipelines: readonly string[];
  riskHints: readonly string[];
  requiredHumanReview: boolean;
  suggestedFirstCommand: string;
  confidence: ChangeIntentConfidence;
  reasons: readonly string[];
}

interface IKindMatcher {
  kind: ChangeIntentKind;
  patterns: readonly RegExp[];
  riskHints?: readonly string[];
  requiresReview?: boolean;
}

const MATCHERS: readonly IKindMatcher[] = [
  {
    kind: ChangeIntentKind.Bugfix,
    patterns: [/\bfix\b/i, /\bbug\b/i, /\bbroken\b/i, /\bcrash/i, /\bregress/i, /\berror\b/i, /\bdoesn'?t work/i],
    riskHints: ['Reproduce the issue with a failing test before patching.'],
  },
  {
    kind: ChangeIntentKind.Refactor,
    patterns: [/\brefactor/i, /\brename\b/i, /\bextract\b/i, /\bcleanup\b/i, /\btidy\b/i, /\bsimplif/i],
    riskHints: ['Keep behaviour identical; rely on the existing test suite.'],
  },
  {
    kind: ChangeIntentKind.Test,
    patterns: [/\btest\b/i, /\bspec\b/i, /\bcoverage\b/i, /\bsnapshot\b/i, /\bgolden\b/i],
  },
  {
    kind: ChangeIntentKind.Docs,
    patterns: [/\bdocs?\b/i, /\bdocument\b/i, /\breadme/i, /\bchangelog\b/i, /\bguide\b/i],
  },
  {
    kind: ChangeIntentKind.Migration,
    patterns: [/\bmigrat/i, /\bbackfill/i, /\bschema\b/i, /\bdata\b.*\bmove/i, /\bupgrade\b/i],
    riskHints: ['Migrations require an explicit human-approval step.'],
    requiresReview: true,
  },
  {
    kind: ChangeIntentKind.Architecture,
    patterns: [/\barchitecture/i, /\bboundar/i, /\blayer/i, /\bmodul/i, /\bpackag/i, /\bdepend/i, /\bimport\b/i],
    riskHints: ['Surface boundary/layer changes via `shrk check boundaries` and `shrk drift`.'],
    requiresReview: true,
  },
  {
    kind: ChangeIntentKind.Policy,
    patterns: [/\bpolicy\b/i, /\bcompliance/i, /\bgovernance/i, /\bownership\b/i, /\bsafety\b/i, /\baudit\b/i],
    requiresReview: true,
  },
  {
    kind: ChangeIntentKind.Release,
    patterns: [/\brelease\b/i, /\btag\b/i, /\bpublish\b/i, /\bchangelog\b/i, /\balpha\b/i, /\bbeta\b/i, /\bsmoke\b/i],
    riskHints: ['Release work must not auto-publish. Run preflight + readiness gates.'],
    requiresReview: true,
  },
  {
    kind: ChangeIntentKind.Feature,
    patterns: [
      /\badd\b/i,
      /\bnew\b/i,
      /\bcreate\b/i,
      /\bbuild\b/i,
      /\bimplement\b/i,
      /\bsupport\b/i,
      /\benable\b/i,
      /\bplugin\b/i,
      /\bcapability\b/i,
    ],
  },
];

const DOMAIN_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['plugin', ['plugin', 'extension']],
  ['mcp', ['mcp', 'tool', 'agent']],
  ['cli', ['cli', 'command', 'subcommand', 'shrk']],
  ['ci', ['ci', 'pipeline', 'workflow', 'github-actions', 'gitlab', 'bitbucket']],
  ['docs', ['doc', 'docs', 'readme', 'guide']],
  ['safety', ['safety', 'audit', 'policy', 'governance']],
  ['boundaries', ['boundary', 'boundaries', 'layer', 'import-graph']],
  ['release', ['release', 'tag', 'publish', 'alpha', 'beta', 'smoke', 'preflight']],
  ['report', ['report', 'site', 'dashboard']],
  ['pack', ['pack', 'manifest', 'sign', 'plugin-api']],
  ['onboard', ['onboard', 'adopt', 'drafts']],
  ['intelligence', ['graph', 'map', 'intelligence']],
  ['orchestrate', ['orchestrate', 'plan', 'session', 'brief', 'handoff']],
  ['intent', ['intent', 'classify']],
]);

const SUGGESTED_COMMAND: ReadonlyMap<ChangeIntentKind, string> = new Map([
  [ChangeIntentKind.Feature, 'shrk brief "<task>"'],
  [ChangeIntentKind.Bugfix, 'shrk impact --since main'],
  [ChangeIntentKind.Refactor, 'shrk check boundaries --json'],
  [ChangeIntentKind.Test, 'shrk tests missing --since main'],
  [ChangeIntentKind.Docs, 'shrk docs check'],
  [ChangeIntentKind.Migration, 'shrk brief "<task>" && shrk orchestrate "<task>" --mode conservative'],
  [ChangeIntentKind.Architecture, 'shrk architecture map'],
  [ChangeIntentKind.Policy, 'shrk policy run --explain-overrides'],
  [ChangeIntentKind.Release, 'shrk release readiness --strict'],
  [ChangeIntentKind.Unknown, 'shrk start-here'],
]);

function lc(s: string): string {
  return s.toLowerCase();
}

function detectDomains(task: string): string[] {
  const lower = lc(task);
  const out: string[] = [];
  for (const [domain, keywords] of DOMAIN_KEYWORDS) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        out.push(domain);
        break;
      }
    }
  }
  return [...new Set(out)];
}

function matchKind(task: string): { kind: ChangeIntentKind; riskHints: string[]; requiresReview: boolean; matchedPatterns: number } {
  let best: { kind: ChangeIntentKind; riskHints: string[]; requiresReview: boolean; matchedPatterns: number } = {
    kind: ChangeIntentKind.Unknown,
    riskHints: [],
    requiresReview: false,
    matchedPatterns: 0,
  };
  for (const m of MATCHERS) {
    let count = 0;
    for (const p of m.patterns) {
      if (p.test(task)) count++;
    }
    if (count > best.matchedPatterns) {
      best = {
        kind: m.kind,
        riskHints: m.riskHints ? [...m.riskHints] : [],
        requiresReview: m.requiresReview === true,
        matchedPatterns: count,
      };
    }
  }
  return best;
}

export async function classifyChangeIntent(
  task: string,
  inspection: ISharkcraftInspection,
): Promise<IChangeIntent> {
  await loadConstructs(inspection);
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    return {
      schema: CHANGE_INTENT_SCHEMA,
      task: trimmed,
      kind: ChangeIntentKind.Unknown,
      domains: [],
      likelyConstructs: [],
      likelyTemplates: [],
      likelyPipelines: [],
      riskHints: ['Empty task — provide a one-sentence description.'],
      requiredHumanReview: true,
      suggestedFirstCommand: 'shrk start-here',
      confidence: ChangeIntentConfidence.Low,
      reasons: ['Empty task string.'],
    };
  }

  const { kind, riskHints, requiresReview, matchedPatterns } = matchKind(trimmed);
  const domains = detectDomains(trimmed);

  // Likely constructs: any construct id whose tokens appear in the task.
  const constructs = listConstructs(inspection).map((c) => c.id);
  const likelyConstructs = constructs.filter((id) => {
    const tokens = id.split(/[.\-_/]/).filter((t) => t.length >= 3);
    return tokens.some((t) => lc(trimmed).includes(lc(t)));
  });

  // Likely templates / pipelines: by id token match.
  const templates = inspection.templates.map((t) => t.id);
  const likelyTemplates = templates.filter((id) => {
    const tokens = id.split(/[.\-_/]/).filter((t) => t.length >= 3);
    return tokens.some((t) => lc(trimmed).includes(lc(t)));
  });

  const pipelines = inspection.pipelines.map((p) => p.id);
  const likelyPipelines = pipelines.filter((id) => {
    const tokens = id.split(/[.\-_/]/).filter((t) => t.length >= 3);
    return tokens.some((t) => lc(trimmed).includes(lc(t)));
  });

  const reasons: string[] = [];
  if (matchedPatterns > 0) {
    reasons.push(`Matched ${matchedPatterns} pattern(s) for kind "${kind}".`);
  } else {
    reasons.push('No strong verb match; defaulted by domain hints.');
  }
  if (domains.length > 0) reasons.push(`Domains: ${domains.join(', ')}.`);
  if (likelyConstructs.length > 0)
    reasons.push(`Construct id tokens matched: ${likelyConstructs.slice(0, 4).join(', ')}.`);

  let confidence = ChangeIntentConfidence.Low;
  const signals = matchedPatterns + domains.length + (likelyConstructs.length > 0 ? 1 : 0) + (likelyTemplates.length > 0 ? 1 : 0);
  if (signals >= 4) confidence = ChangeIntentConfidence.High;
  else if (signals >= 2) confidence = ChangeIntentConfidence.Medium;

  const requiredHumanReview =
    requiresReview ||
    kind === ChangeIntentKind.Architecture ||
    kind === ChangeIntentKind.Policy ||
    kind === ChangeIntentKind.Release ||
    kind === ChangeIntentKind.Migration;

  const suggestedFirstCommand = SUGGESTED_COMMAND.get(kind) ?? 'shrk start-here';

  return {
    schema: CHANGE_INTENT_SCHEMA,
    task: trimmed,
    kind,
    domains,
    likelyConstructs,
    likelyTemplates,
    likelyPipelines,
    riskHints,
    requiredHumanReview,
    suggestedFirstCommand,
    confidence,
    reasons,
  };
}

export function renderChangeIntentText(intent: IChangeIntent): string {
  const lines: string[] = [];
  lines.push('=== Change intent ===');
  lines.push(`  task           ${intent.task}`);
  lines.push(`  kind           ${intent.kind}`);
  lines.push(`  confidence     ${intent.confidence}`);
  lines.push(`  domains        ${intent.domains.length === 0 ? '(none)' : intent.domains.join(', ')}`);
  lines.push(`  review needed  ${intent.requiredHumanReview ? 'yes' : 'no'}`);
  lines.push(`  first command  ${intent.suggestedFirstCommand}`);
  if (intent.likelyConstructs.length > 0)
    lines.push(`  constructs     ${intent.likelyConstructs.slice(0, 8).join(', ')}`);
  if (intent.likelyTemplates.length > 0)
    lines.push(`  templates      ${intent.likelyTemplates.slice(0, 8).join(', ')}`);
  if (intent.likelyPipelines.length > 0)
    lines.push(`  pipelines      ${intent.likelyPipelines.slice(0, 8).join(', ')}`);
  if (intent.riskHints.length > 0) {
    lines.push('Risk hints:');
    for (const r of intent.riskHints) lines.push(`  • ${r}`);
  }
  lines.push('Reasons:');
  for (const r of intent.reasons) lines.push(`  • ${r}`);
  return lines.join('\n') + '\n';
}
