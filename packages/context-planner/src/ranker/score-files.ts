import { GraphQueryApi, type INode } from '@shrkcrft/graph';
import type { TaskIntent } from '../schema/context-pack.ts';

export interface IScoredFile {
  node: INode;
  score: number;
  reasons: readonly string[];
}

export interface IScoreInput {
  /** Free-text task. */
  task: string;
  /** Classified intent (drives weights). */
  intent: TaskIntent;
  /** Optional file hints from the caller (pre-selected). */
  hintedFiles?: readonly string[];
  /** Optional package hints. */
  hintedPackages?: readonly string[];
  /** Per-package weight multipliers from intent. */
  weights?: Partial<IRankerWeights>;
}

export interface IRankerWeights {
  /** Match between task keywords and file path. */
  pathKeyword: number;
  /** Match between task keywords and any declared symbol in the file. */
  symbolKeyword: number;
  /** File is among the caller's hints. */
  hintedFile: number;
  /** File belongs to a hinted package. */
  hintedPackage: number;
  /** Penalty for generated files (subtract). */
  generatedPenalty: number;
  /**
   * Test-file weight, applied as a SIGNED term (`score -= testPenalty`). A
   * positive value penalises test files (the default for non-bug-fix intents);
   * a negative value boosts them (bug-fix sets `-0.2`, turning the term into a
   * `+0.2` boost so a co-located test survives the cut).
   */
  testPenalty: number;
}

const DEFAULT_WEIGHTS: IRankerWeights = {
  pathKeyword: 1.0,
  symbolKeyword: 0.7,
  hintedFile: 2.0,
  hintedPackage: 0.5,
  generatedPenalty: 0.6,
  testPenalty: 0.3,
};

const STOPWORDS = new Set([
  'a','an','and','or','the','of','for','to','in','on','with','add','make','do',
  'is','are','be','as','at','by','from','that','this','it','i','we','our','your',
  'should','want','need','please','can','could','would','use','using','also',
]);

/**
 * Rank every file node in the graph against the task. Returns scored
 * files sorted descending by score, with explicit reasons attached so
 * the agent can see why a file was picked.
 *
 * Deterministic — no LLM calls. Weights are intent-tunable but the
 * keyword extractor and the scoring formula are pure.
 */
export function scoreFiles(api: GraphQueryApi, input: IScoreInput): readonly IScoredFile[] {
  const weights: IRankerWeights = { ...DEFAULT_WEIGHTS, ...applyIntentTuning(input.intent), ...input.weights };
  const keywords = extractKeywords(input.task);
  const hintedFiles = new Set(input.hintedFiles ?? []);
  const hintedPackages = new Set(input.hintedPackages ?? []);

  const candidates: IScoredFile[] = [];
  for (const node of api.allFiles()) {
    const reasons: string[] = [];
    let score = 0;
    if (hintedFiles.has(node.path!)) {
      score += weights.hintedFile;
      reasons.push('hinted file');
    }
    if (hintedPackages.size > 0) {
      const pkg = node.path!.split('/').slice(0, 2).join('/');
      if (hintedPackages.has(pkg)) {
        score += weights.hintedPackage;
        reasons.push('hinted package');
      }
    }
    if (keywords.size > 0) {
      const pathHits = countKeywordHits(node.path!, keywords);
      if (pathHits > 0) {
        score += weights.pathKeyword * Math.min(1, pathHits / 2);
        reasons.push(`path matches ${pathHits} keyword(s)`);
      }
      // Symbol-name matches.
      const symbolMatches = api.symbolsIn(node.id).filter((s) => keywords.has(s.label.toLowerCase()));
      if (symbolMatches.length > 0) {
        score += weights.symbolKeyword * Math.min(1, symbolMatches.length / 3);
        reasons.push(`declares ${symbolMatches.length} matching symbol(s)`);
      }
    }
    // Penalty for generated/test files (unless intent justifies them).
    if ((node.tags ?? []).includes('generated')) {
      score -= weights.generatedPenalty;
      reasons.push('generated (penalty)');
    }
    if ((node.tags ?? []).includes('test')) {
      // Apply the test weight as a SIGNED term unconditionally. For most intents
      // `testPenalty` is positive, so this subtracts (a real penalty). bug-fix
      // tuning sets it negative, so `score -= (-0.2)` becomes a `+0.2` boost —
      // previously the boost lived inside an `intent !== 'bug-fix'` guard and so
      // never ran, leaving the bug-fix knob dead.
      score -= weights.testPenalty;
      reasons.push(weights.testPenalty < 0 ? 'test (intent-relevant boost)' : 'test (intent-mismatched penalty)');
    }
    if (score <= 0) continue;
    candidates.push({ node, score, reasons });
  }
  candidates.sort((a, b) => b.score - a.score || a.node.path!.localeCompare(b.node.path!));
  return candidates;
}

function applyIntentTuning(intent: TaskIntent): Partial<IRankerWeights> {
  switch (intent) {
    case 'bug-fix':
      return { testPenalty: -0.2 }; // negative weight = boost for co-located tests
    case 'refactor':
      return { symbolKeyword: 0.9 };
    case 'docs':
      return { pathKeyword: 1.2 };
    case 'release':
      return { hintedPackage: 0.7 };
    case 'migration':
      return { symbolKeyword: 1.0, pathKeyword: 1.1 };
    case 'feature':
    case 'unknown':
    default:
      return {};
  }
}

function extractKeywords(task: string): Set<string> {
  const out = new Set<string>();
  const tokens = task.toLowerCase().split(/[^a-z0-9_$]+/).filter(Boolean);
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function countKeywordHits(text: string, keywords: ReadonlySet<string>): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const k of keywords) {
    if (lower.includes(k)) n += 1;
  }
  return n;
}

