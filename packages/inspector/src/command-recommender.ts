/**
 * Deterministic command recommender.
 *
 * Given an input ("what I want to do" or stderr blob), surface the
 * most relevant commands from the catalog + diagnostics + start-here
 * flow + intent classification. No AI, no embeddings.
 */
import { classifyChangeIntent, ChangeIntentKind } from './change-intent.ts';
import { buildDiagnosticByCode, listDiagnostics } from './failure-diagnostics.ts';
import {
  buildUncertaintyReport,
  type IUncertaintyReport,
} from './uncertainty-report.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const COMMAND_RECOMMENDER_SCHEMA = 'sharkcraft.command-recommender/v1';

export interface ICommandRecommendation {
  command: string;
  why: string;
  safetyLevel: 'read-only' | 'writes-drafts' | 'writes-session' | 'writes-source' | 'runs-shell';
  docsLink?: string;
}

export interface ICommandRecommendationReport {
  schema: typeof COMMAND_RECOMMENDER_SCHEMA;
  generatedAt: string;
  query: string;
  role?: string;
  recommendations: readonly ICommandRecommendation[];
  nextCommand: string;
  warnings: readonly string[];
  /** Uncertainty report (confidence + reasons + safe fallback). */
  uncertainty: IUncertaintyReport;
}

interface IRecipe {
  match: RegExp;
  recommendations: readonly Omit<ICommandRecommendation, 'safetyLevel'>[];
}

const RECIPES: readonly IRecipe[] = [
  {
    match: /review|pr|pull[-\s]?request/i,
    recommendations: [
      { command: 'shrk review packet --v3 --since main', why: 'Generate an agent-ready PR review packet.' },
      { command: 'shrk impact --since main', why: 'See what changed and what depends on it.' },
      { command: 'shrk report site --output .sharkcraft/reports/site', why: 'Render the local read-only review site.' },
    ],
  },
  {
    match: /start|begin|new task|feature/i,
    recommendations: [
      { command: 'shrk brief "<task>"', why: 'Pre-work brief for the agent.' },
      { command: 'shrk dev start "<task>"', why: 'Start a tracked dev session.' },
      { command: 'shrk intent "<task>"', why: 'Classify the change intent first.' },
    ],
  },
  {
    match: /publish|release|tag|alpha|beta/i,
    recommendations: [
      { command: 'shrk release readiness --strict', why: 'Confirm release gates.' },
      { command: 'shrk release smoke --scenario all', why: 'Validate the release smoke matrix.' },
      { command: 'bun run release:preflight', why: 'Run the full preflight.' },
    ],
  },
  {
    match: /pack/i,
    recommendations: [
      { command: 'shrk packs doctor --release --require-signatures', why: 'Validate discovered packs.' },
      { command: 'shrk packs compat <pack> --consumer-root .', why: 'Detect helper/symbol-missing issues.' },
      { command: 'shrk packs quality <path>', why: 'Score pack maturity.' },
    ],
  },
  {
    match: /boundary|architecture|layer/i,
    recommendations: [
      { command: 'shrk architecture map', why: 'Layered architecture summary.' },
      { command: 'shrk check boundaries', why: 'Boundary scan.' },
      { command: 'shrk drift', why: 'Drift report.' },
    ],
  },
  {
    match: /code[-\s]?intel|code intelligence|code graph|graph status|graph health|import cycle|unresolved import|blast radius|callers|dependents|who calls|who uses|where is .*\bused|find usages|usages? of|is .*\bwired|wired (up|to)|wire[ds]? .*\bto\b|path (from|between)|reach(es|able)|connected to|who implements|implementations? of|subclass|subtype|load[-\s]?bearing|\bhubs?\b|most[-\s](depended|imported|referenced)|what.*change carefully|important.*\b(code|files?|symbols?)|what breaks if|what calls|call sites?|trace .*\b(symbol|function|usage)/i,
    recommendations: [
      { command: 'shrk graph callers <symbol>', why: 'Who calls / references a symbol, as path:line — the grep replacement for "who calls X / where is X used".' },
      { command: 'shrk graph path <from> <to>', why: 'Is code A actually wired to code B? Shortest import/call/implements path between two files or symbols — the deterministic answer to "is X wired to Y".' },
      { command: 'shrk graph hubs', why: 'The most-depended-on symbols/files (biggest blast radius) — what to change carefully or understand first when onboarding.' },
      { command: 'shrk graph context <file-or-symbol>', why: 'Inspect one file or symbol with imports, callers, subtypes/supertypes, bridge context, and framework hits — answers "is X wired".' },
      { command: 'shrk graph impact <file-or-symbol> --full', why: 'What breaks if you change it: graph-backed dependents, caller files, rules, and likely tests.' },
      { command: 'shrk code-intel', why: 'One-shot health view across the code graph, bridge, and quality gates.' },
      { command: 'shrk graph status', why: 'Check whether the code graph is present, fresh, and internally consistent.' },
      { command: 'shrk graph unresolved', why: 'Find unresolved imports that undercut graph accuracy.' },
    ],
  },
  {
    match: /delegate|mechanical (edit|task|change|refactor)|grunt (work|task)|boilerplate|repetitive edit|hand (this|it|off) (off |over )?to (a |the )?(local |worker|model)|add (a |an )?(barrel )?(export|import)\b|local (llm|model) (do|handle|make)/i,
    recommendations: [
      { command: 'shrk delegate list', why: 'See the MECHANICAL task recipes a local-LLM worker can handle (the engine verifies the result + auto-reverts on failure). Each is fenced to specific files + op kinds.' },
      { command: 'shrk delegate run "<task>" --recipe <id> --apply', why: 'Hand a mechanical, deterministically-verifiable edit to the LOCAL worker — you pay for a compact brief + result instead of reading the whole file and writing the edit. The edit lands only if it passes the recipe verification.' },
      { command: 'shrk delegate explain <id>', why: 'Audit a recipe before trusting it: the allowed ops, guardrail globs, and whether its verification is bound.' },
    ],
  },
];

function safetyLevelFor(command: string): ICommandRecommendation['safetyLevel'] {
  if (/^shrk delegate run/i.test(command)) return 'writes-source';
  if (/^shrk (gen|init|apply|import|presets apply --write|packs (sign|new))/i.test(command)) return 'writes-source';
  if (/^shrk (onboard|brief|dev start|handoff|export|report site|impact|ci scaffold|simulate|orchestrate)/i.test(command)) return 'writes-drafts';
  if (/^shrk (session|dev report)/i.test(command)) return 'writes-session';
  if (/^bun |^npm |^node |^git /i.test(command)) return 'runs-shell';
  return 'read-only';
}

export async function recommendCommands(
  inspection: ISharkcraftInspection,
  query: string,
  options: { fromError?: string; role?: string } = {},
): Promise<ICommandRecommendationReport> {
  const warnings: string[] = [];
  const trimmed = query.trim();
  let recommendations: ICommandRecommendation[] = [];

  // Recipe matching by query.
  for (const r of RECIPES) {
    if (r.match.test(trimmed)) {
      for (const rec of r.recommendations) recommendations.push({ ...rec, safetyLevel: safetyLevelFor(rec.command) });
    }
  }

  // If a stderr-like input was provided, do a diagnostic-suggest pass.
  if (options.fromError && options.fromError.length > 0) {
    for (const e of listDiagnostics()) {
      const built = buildDiagnosticByCode(e.code, {});
      if (new RegExp(e.code, 'i').test(options.fromError) || new RegExp(built.problem.slice(0, 20), 'i').test(options.fromError)) {
        recommendations.push({
          command: built.nextCommand,
          why: `Diagnostic match: ${e.code}.`,
          safetyLevel: safetyLevelFor(built.nextCommand),
          ...(built.docsLink ? { docsLink: built.docsLink } : {}),
        });
      }
    }
  }

  // Intent-driven fallback.
  if (recommendations.length === 0) {
    const intent = await classifyChangeIntent(trimmed, inspection);
    recommendations.push({
      command: intent.suggestedFirstCommand,
      why: `Intent fallback (${intent.kind}, confidence ${intent.confidence}).`,
      safetyLevel: safetyLevelFor(intent.suggestedFirstCommand),
    });
    if (intent.kind === ChangeIntentKind.Unknown) {
      recommendations.push({ command: 'shrk start-here', why: 'No clear intent — start here.', safetyLevel: 'read-only' });
    }
  }

  // Dedup by command (keep first).
  const seen = new Set<string>();
  recommendations = recommendations.filter((r) => (seen.has(r.command) ? false : (seen.add(r.command), true)));

  // Top of list = first recommendation.
  const nextCommand = recommendations[0]?.command ?? 'shrk start-here';

  // Build an uncertainty report from the recommendation signals.
  const usedRecipe = RECIPES.some((r) => r.match.test(trimmed));
  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'medium';
  const reasons: string[] = [];
  const missing: { id: string; message: string }[] = [];
  const increase: string[] = [];
  if (usedRecipe) {
    confidence = 'high';
    reasons.push(`Recipe matched the query "${trimmed}".`);
  } else if (recommendations.length > 0 && recommendations[0]?.why.startsWith('Intent fallback')) {
    confidence = 'low';
    reasons.push('No recipe matched — fell back to intent classification.');
    missing.push({ id: 'no-recipe-match', message: 'No recommender recipe matched the query.' });
    increase.push('Add a routing hint or recommender recipe for this task class.');
  } else if (recommendations.length === 0) {
    confidence = 'unknown';
    reasons.push('No recommendations could be produced.');
  }
  const uncertainty = buildUncertaintyReport({
    confidence,
    reasons,
    missingSignals: missing,
    suggestedCommands: recommendations.slice(0, 3).map((r) => r.command),
    safeFallbackCommand: 'shrk start-here',
    whatWouldIncreaseConfidence: increase,
  });

  return {
    schema: COMMAND_RECOMMENDER_SCHEMA,
    generatedAt: new Date().toISOString(),
    query: trimmed,
    ...(options.role ? { role: options.role } : {}),
    recommendations,
    nextCommand,
    warnings,
    uncertainty,
  };
}
