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
import { matchTerm, prepareTermQuery } from './match-terms.ts';
import { classifyQueryIntent } from './query-intent.ts';
import { QueryIntent } from './query-intent-kind.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { detectSharkcraftRepo } from './self-audit.ts';

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
  /** THE query-intent classification this kind was checked against (round 11). */
  queryIntent?: QueryIntent;
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
  // Consumer-applicable: `docs check` / `release readiness` maintain SharkCraft
  // itself and exit 78 outside its repository (round 11 review CLI-7).
  [ChangeIntentKind.Docs, 'shrk docs references check'],
  [ChangeIntentKind.Migration, 'shrk brief "<task>" && shrk orchestrate "<task>" --mode conservative'],
  [ChangeIntentKind.Architecture, 'shrk architecture map'],
  [ChangeIntentKind.Policy, 'shrk policy run --explain-overrides'],
  [ChangeIntentKind.Release, 'shrk quality'],
  [ChangeIntentKind.Unknown, 'shrk start-here'],
]);

/**
 * Inside SharkCraft's own repository (THE host authority,
 * `detectSharkcraftRepo`) the docs / release intents keep the tool's own
 * gates — there they apply.
 */
const TOOL_REPO_SUGGESTED_COMMAND: ReadonlyMap<ChangeIntentKind, string> = new Map([
  [ChangeIntentKind.Docs, 'shrk docs check'],
  [ChangeIntentKind.Release, 'shrk release readiness --strict'],
]);

/**
 * Domains through THE term matcher: `lower.includes(kw)` fired `ci` on
 * "decide" / "specific" / "pricing" and `sign` (pack) on "design" / "assign",
 * inflating the signal-count confidence below.
 */
function detectDomains(task: string): string[] {
  const query = prepareTermQuery(task);
  const out: string[] = [];
  for (const [domain, keywords] of DOMAIN_KEYWORDS) {
    for (const kw of keywords) {
      if (matchTerm(query, kw)) {
        out.push(domain);
        break;
      }
    }
  }
  return [...new Set(out)];
}

/** Ids whose (≥ 3 char) segments appear as task terms — THE term matcher, not substring. */
function idsMentioned(ids: readonly string[], task: string): string[] {
  const query = prepareTermQuery(task);
  return ids.filter((id) => {
    const tokens = id.split(/[.\-_/]/).filter((t) => t.length >= 3);
    return tokens.some((t) => matchTerm(query, t));
  });
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

  const matched = matchKind(trimmed);
  let { kind, riskHints, requiresReview } = matched;
  const { matchedPatterns } = matched;
  // Consult THE query-intent classifier: a create word used as a noun or
  // adjective ("fix the broken BUILD", "why does the NEW route fail") must not
  // make a repair / diagnosis query a feature.
  const queryIntent = classifyQueryIntent(trimmed);
  const repairShaped = queryIntent.intent === QueryIntent.Repair || queryIntent.intent === QueryIntent.Diagnose;
  const overridden = repairShaped && (kind === ChangeIntentKind.Feature || kind === ChangeIntentKind.Unknown);
  if (overridden) {
    const bugfix = MATCHERS.find((m) => m.kind === ChangeIntentKind.Bugfix);
    kind = ChangeIntentKind.Bugfix;
    riskHints = bugfix?.riskHints ? [...bugfix.riskHints] : [];
    requiresReview = bugfix?.requiresReview === true;
  }
  const domains = detectDomains(trimmed);

  // Likely constructs / templates / pipelines: any id whose segments appear as task terms.
  const likelyConstructs = idsMentioned(listConstructs(inspection).map((c) => c.id), trimmed);
  const likelyTemplates = idsMentioned(inspection.templates.map((t) => t.id), trimmed);
  const likelyPipelines = idsMentioned(inspection.pipelines.map((p) => p.id), trimmed);

  const reasons: string[] = [];
  if (overridden) {
    reasons.push(
      `Query intent is "${queryIntent.intent}"${queryIntent.vetoedBy ? ` ("${queryIntent.vetoedBy}" vetoes the create reading)` : ''} — classified as "${kind}".`,
    );
  } else if (matchedPatterns > 0) {
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

  const suggestedFirstCommand =
    (TOOL_REPO_SUGGESTED_COMMAND.has(kind) && detectSharkcraftRepo(inspection.projectRoot)
      ? TOOL_REPO_SUGGESTED_COMMAND.get(kind)
      : undefined) ??
    SUGGESTED_COMMAND.get(kind) ??
    'shrk start-here';

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
    queryIntent: queryIntent.intent,
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
