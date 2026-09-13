/**
 * The recommender's built-in keyword recipes, matched through THE term
 * matcher. The old table was unanchored regex alternations — `/review|pr|…/`
 * matched `pr` inside "pricing", `/pack/` matched "package"/"packet",
 * `/publish|release|tag|…/` matched "stage"/"vintage" — and a recipe that
 * fired on a word fragment put a bogus row (and a bogus conflict note) into
 * the headline.
 */
import { matchTerm } from './match-terms.ts';
import type { IRecommendRecipe } from './recommend-recipe.ts';
import type { ITermQuery } from './term-query.ts';

export const RECOMMEND_RECIPES: readonly IRecommendRecipe[] = [
  {
    id: 'review',
    terms: ['review', 'pr', 'prs'],
    phrases: ['pull request'],
    recommendations: [
      { command: 'shrk review packet --v3 --since main', why: 'Generate an agent-ready PR review packet.' },
      { command: 'shrk impact --since main', why: 'See what changed and what depends on it.' },
      { command: 'shrk report site --output .sharkcraft/reports/site', why: 'Render the local read-only review site.' },
    ],
  },
  {
    id: 'start',
    terms: ['start', 'begin', 'feature'],
    phrases: ['new task'],
    recommendations: [
      { command: 'shrk brief "<task>"', why: 'Pre-work brief for the agent.' },
      { command: 'shrk dev start "<task>"', why: 'Start a tracked dev session.' },
      { command: 'shrk risk "<task>"', why: 'Classify the change intent and its risk first.' },
    ],
  },
  {
    id: 'release',
    terms: ['publish', 'release', 'tag', 'alpha', 'beta'],
    recommendations: [
      { command: 'shrk release readiness --strict', why: 'Confirm release gates.' },
      { command: 'shrk release smoke --scenario all', why: 'Validate the release smoke matrix.' },
      { command: 'bun run release:preflight', why: 'Run the full preflight.' },
    ],
  },
  {
    id: 'packs',
    terms: ['pack'],
    recommendations: [
      { command: 'shrk packs doctor --release --require-signatures', why: 'Validate discovered packs.' },
      { command: 'shrk packs compat <pack> --consumer-root .', why: 'Detect helper/symbol-missing issues.' },
      { command: 'shrk packs release-check <path>', why: 'Check the pack is release-ready.' },
    ],
  },
  {
    id: 'architecture',
    terms: ['boundary', 'architecture', 'layer'],
    recommendations: [
      { command: 'shrk architecture map', why: 'Layered architecture summary.' },
      { command: 'shrk check boundaries', why: 'Boundary scan.' },
      { command: 'shrk drift', why: 'Drift report.' },
    ],
  },
  {
    id: 'code-intel',
    terms: [],
    regex:
      /\b(?:code[-\s]?intel|code intelligence|code graph|graph status|graph health|import cycle|unresolved import|blast radius|callers|dependents|who calls|who uses|where is .*\bused|find usages|usages? of|is .*\bwired|wired (?:up|to)|wire[ds]? .*\bto\b|path (?:from|between)|reach(?:es|able)|connected to|who implements|implementations? of|subclass|subtype|load[-\s]?bearing|hubs?\b|most[-\s](?:depended|imported|referenced)|what.*change carefully|important.*\b(?:code|files?|symbols?)|what breaks if|what calls|call sites?|trace .*\b(?:symbol|function|usage))/i,
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
    id: 'delegate',
    terms: [],
    regex:
      /\b(?:delegate|mechanical (?:edit|task|change|refactor)|grunt (?:work|task)|boilerplate|repetitive edit|hand (?:this|it|off) (?:off |over )?to (?:a |the )?(?:local |worker|model)|add (?:a |an )?(?:barrel )?(?:export|import)\b|local (?:llm|model) (?:do|handle|make))/i,
    recommendations: [
      { command: 'shrk delegate list', why: 'See the MECHANICAL task recipes a local-LLM worker can handle (the engine verifies the result + auto-reverts on failure). Each is fenced to specific files + op kinds.' },
      { command: 'shrk delegate run "<task>" --recipe <id> --apply', why: 'Hand a mechanical, deterministically-verifiable edit to the LOCAL worker — you pay for a compact brief + result instead of reading the whole file and writing the edit. The edit lands only if it passes the recipe verification.' },
      { command: 'shrk delegate explain <id>', why: 'Audit a recipe before trusting it: the allowed ops, guardrail globs, and whether its verification is bound.' },
    ],
  },
];

/**
 * The evidence a recipe matched on — its matched terms and phrases, plus the
 * regex's matched text — distinct. Empty = the recipe does not apply.
 */
export function matchRecommendRecipe(recipe: IRecommendRecipe, query: ITermQuery, text: string): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    if (!out.includes(s)) out.push(s);
  };
  for (const t of recipe.terms) if (matchTerm(query, t)) add(t);
  for (const p of recipe.phrases ?? []) if (matchTerm(query, p)) add(p);
  if (recipe.regex) {
    const m = recipe.regex.exec(text);
    if (m) add(m[0].trim().toLowerCase());
  }
  return out;
}
