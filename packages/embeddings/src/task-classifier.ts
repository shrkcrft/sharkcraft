/**
 * Lightweight task-type classifier. Runs in microseconds (regex-only),
 * no model needed. Used by smart-context to pick a task-appropriate
 * prompt + plan schema so abstract design questions don't get a
 * "modify these files" plan.
 *
 * Categories were chosen to match the *shape of the plan* the agent
 * needs back, not to mirror engineering taxonomies. Bugfix wants a
 * root-cause investigation skeleton; architecture wants design
 * questions + candidate models; refactor wants a scope-and-migration
 * list, etc.
 */

export enum TaskType {
  Bugfix = 'bugfix',
  Implementation = 'implementation',
  Scaffold = 'scaffold',
  Refactor = 'refactor',
  Architecture = 'architecture',
  Investigation = 'investigation',
  Validation = 'validation',
  Generic = 'generic',
}

export interface ITaskClassification {
  type: TaskType;
  confidence: number;
  signals: string[];
  scores: Partial<Record<TaskType, number>>;
}

interface ICategoryRule {
  type: TaskType;
  /** Each pattern carries a weight; matches accumulate into the type's score. */
  patterns: Array<{ re: RegExp; weight: number; label?: string }>;
}

// Patterns are intentionally loose. The goal is to be *helpful by default*
// rather than precise — the agent can pass `--task-type` to override.
const RULES: readonly ICategoryRule[] = [
  {
    type: TaskType.Architecture,
    patterns: [
      { re: /\b(design|architect|architecture)\b/, weight: 2, label: 'design' },
      { re: /\bcreate a (process|system|workflow|protocol|pipeline|service|architecture|orchestrat\w*|sidecar)\b/, weight: 2.5, label: 'create-a-process' },
      { re: /\bbuild a (process|system|workflow|protocol|pipeline|service|architecture)\b/, weight: 2 },
      { re: /\bworkflow\b/, weight: 1 },
      { re: /\bsidecar\b/, weight: 2, label: 'sidecar' },
      { re: /\borchestrat\w*/, weight: 1.5, label: 'orchestrate' },
      { re: /\bprotocol\b/, weight: 1.5 },
      { re: /\bintegration\b/, weight: 0.5 },
      { re: /\bin parallel with\b/, weight: 2, label: 'in-parallel-with' },
      { re: /\b(constantly|continuously)\b.*\b(serves?|feeds?|streams?|sends?)\b/, weight: 2, label: 'continuous-feed' },
      { re: /\b(real[- ]?time|streaming|background process|daemon|watcher|watch[- ]?mode)\b/, weight: 1.5, label: 'realtime/background' },
      { re: /\bhow (should|to|can) (we|i|you) (design|architect|structure|approach)\b/, weight: 2 },
      { re: /\bpattern for\b/, weight: 1, label: 'pattern-for' },
      { re: /\bplugin\b/, weight: 0.5 },
      { re: /\bMCP\b/, weight: 0.5 },
    ],
  },
  {
    type: TaskType.Bugfix,
    patterns: [
      { re: /\b(bug|broken|regression|crashes?|hangs?|stack ?trace)\b/, weight: 2 },
      { re: /\bfix(es|ing)?\b/, weight: 1.5, label: 'fix' },
      { re: /\bnot working\b/, weight: 2 },
      { re: /\b(why does|why is) .* (fail|return|throw)/, weight: 1.5 },
      { re: /\b(panic|exception|error message)\b/, weight: 1 },
      { re: /\bdoes not work\b/, weight: 2 },
    ],
  },
  {
    type: TaskType.Refactor,
    patterns: [
      { re: /\brefactor(ing)?\b/, weight: 3, label: 'refactor' },
      { re: /\brewrite\b/, weight: 2 },
      { re: /\b(rename|extract|inline|deduplicate|consolidate|split up|flatten)\b/, weight: 2 },
      { re: /\bcleanup\b/, weight: 1 },
      { re: /\bmove (the )?(function|class|module|file)\b/, weight: 2 },
    ],
  },
  {
    type: TaskType.Scaffold,
    patterns: [
      { re: /\bscaffold(ing)?\b/, weight: 3 },
      { re: /\bgenerate (a |the )?(new )?\w+\b/, weight: 2 },
      { re: /\bnew (cli|mcp|template|preset|pack|rule|pipeline) (command|tool|file)\b/, weight: 2.5 },
      { re: /\bcreate a new (cli command|mcp tool|rule|preset|template|pack)\b/, weight: 3, label: 'create-new-construct' },
      { re: /\bshrk gen\b/, weight: 2 },
    ],
  },
  {
    type: TaskType.Investigation,
    patterns: [
      { re: /\binvestigat\w*/, weight: 3, label: 'investigate' },
      { re: /\b(find out|figure out|understand|trace|track down)\b/, weight: 2 },
      { re: /\b(why|how does|where is) .* (work|happen|come from|live|defined)/, weight: 1.5 },
      { re: /\b(research|explore|look into|dig into)\b/, weight: 1.5 },
      { re: /\bdebug(ging)?\b/, weight: 1.5 },
    ],
  },
  {
    type: TaskType.Validation,
    patterns: [
      // Use a non-capturing leading boundary so we don't accidentally match
      // "doctor check that surfaces …". Validation language puts "review",
      // "validate", "audit", or "check whether/if" at the *start* of the
      // intent — not as a noun phrase inside a larger sentence.
      { re: /^(please |can you )?review\b/, weight: 2.5 },
      { re: /\b(validate|verify|audit)\b/, weight: 2 },
      { re: /\bcheck (if|whether)\b/, weight: 1.5 },
      { re: /^(test|assert|confirm) (that|whether|if)\b/, weight: 1 },
    ],
  },
  {
    type: TaskType.Implementation,
    patterns: [
      // Tight: "add a new feature" (no adjective between new + noun).
      { re: /\b(add|implement|introduce) (a |the )?(new )?(feature|field|option|flag|method|endpoint|command|check|rule)\b/, weight: 2 },
      // Loose: "add a new doctor check" (allow one adjective). Covers the
      // common "add a new <thing> <construct>" pattern.
      { re: /\b(add|implement|introduce) (a |the )?(new )?\w+\s+(check|command|rule|endpoint|method|field|option|flag|feature|preset|template|pack|pipeline)\b/, weight: 2.5, label: 'add-new-<adj>-construct' },
      { re: /\bsupport (for |the )?\w+/, weight: 1 },
      { re: /\bwire (up |into )/, weight: 1 },
      { re: /\bport \w+ to\b/, weight: 1 },
      { re: /\benable \w+/, weight: 0.5 },
    ],
  },
];

/**
 * Run the classifier. Returns the best-scoring type; ties prefer
 * Architecture > Bugfix > Refactor > Scaffold > Investigation >
 * Validation > Implementation > Generic (so abstract tasks lean
 * design-first, which is the change this module was added to make).
 */
export function classifyTask(task: string): ITaskClassification {
  const lower = task.toLowerCase();
  const scores: Partial<Record<TaskType, number>> = {};
  const signals: string[] = [];
  for (const rule of RULES) {
    let score = 0;
    for (const p of rule.patterns) {
      const m = p.re.exec(lower);
      if (!m) continue;
      score += p.weight;
      const label = p.label ?? m[0];
      signals.push(`${rule.type}:${label.slice(0, 32)}`);
    }
    if (score > 0) scores[rule.type] = score;
  }

  const ranked = (Object.entries(scores) as Array<[TaskType, number]>).sort(
    (a, b) => b[1] - a[1] || tieRank(a[0]) - tieRank(b[0]),
  );

  if (ranked.length === 0) {
    return { type: TaskType.Generic, confidence: 0, signals, scores };
  }
  const [bestType, bestScore] = ranked[0]!;
  // Confidence: normalised against a saturation cap of 5 + the gap to #2.
  const second = ranked[1]?.[1] ?? 0;
  const cap = 5;
  const base = Math.min(1, bestScore / cap);
  const gap = Math.min(0.3, (bestScore - second) / cap);
  const confidence = Math.min(1, base * 0.7 + gap + (bestScore >= 2 ? 0.1 : 0));
  return { type: bestType, confidence, signals, scores };
}

function tieRank(t: TaskType): number {
  switch (t) {
    case TaskType.Architecture: return 0;
    case TaskType.Bugfix: return 1;
    case TaskType.Refactor: return 2;
    case TaskType.Scaffold: return 3;
    case TaskType.Investigation: return 4;
    case TaskType.Validation: return 5;
    case TaskType.Implementation: return 6;
    case TaskType.Generic: return 7;
  }
}

/**
 * Parse a user-supplied `--task-type` override. Accepts any
 * case-insensitive prefix of a category name as a convenience.
 */
export function parseTaskTypeOverride(raw: string | undefined): TaskType | null {
  if (!raw || raw.trim().length === 0) return null;
  const lower = raw.trim().toLowerCase();
  for (const t of Object.values(TaskType)) {
    if (t === lower) return t;
    if (t.startsWith(lower)) return t;
  }
  return null;
}
