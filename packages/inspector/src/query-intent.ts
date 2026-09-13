/**
 * THE query-intent classifier.
 *
 * One answer to "what shape of work does this query ask for?". It replaces
 * three parallel create/planning detectors (the inspector's
 * `looksLikeScaffolding`, the CLI's `looksLikeCreateBuild` /
 * `looksLikePlanning`) and is consulted by change-intent and
 * prepare-agent-task instead of their own verb regexes. Deterministic; terms
 * come from THE term normaliser (`match-terms.ts`).
 *
 * Create rules — the ones the recommender's source-writing gate hangs on:
 *   - a create verb in slot 0 is STRONG, unless the next term shows it is a
 *     subject noun ("build is broken", "build fails");
 *   - a create verb in slots 1–3 right after a lead-in ("please add",
 *     "I want to generate", "we should add") is STRONG;
 *   - any other create verb in slots 1–3 is LOOSE, and a repair/diagnosis
 *     marker anywhere in the query VETOES it ("fix the broken build",
 *     "why does the new route fail");
 *   - `new` is never strong on its own — it is an adjective as often as a verb.
 * A strong create survives a marker ("add a fix for the crash" is create work).
 */
import { normaliseTerms } from './match-terms.ts';
import { QueryIntent } from './query-intent-kind.ts';
import type { IQueryIntentResult } from './query-intent-result.ts';

/** Only the first four terms carry the query's verb ("help me plan …"). */
const SLOT_WINDOW = 4;

const CREATE_VERBS: ReadonlySet<string> = new Set([
  'create',
  'build',
  'add',
  'generate',
  'scaffold',
  'implement',
  'make',
  'new',
  'introduce',
  'write',
]);

/** Create words that are never a strong create signal on their own. */
const WEAK_CREATE_WORDS: ReadonlySet<string> = new Set(['new']);

/** A create verb right after one of these is an imperative ("please add", "want to generate"). */
const CREATE_LEAD_INS: ReadonlySet<string> = new Set([
  'please',
  'to',
  'i',
  'we',
  'lets',
  'let',
  'want',
  'need',
  'can',
  'should',
  'must',
  'will',
  'me',
  'us',
  'just',
  'also',
]);

/** After a slot-0 create word, these show it is the subject noun, not a verb. */
const NOUN_FOLLOWERS: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'keeps',
  'kept',
  'broke',
  'breaks',
  'broken',
  'fails',
  'failed',
  'failing',
  'crashes',
  'crashed',
  'doesnt',
  'didnt',
  'cannot',
  'cant',
  'wont',
  'isnt',
  'wasnt',
  'error',
  'errors',
  'hangs',
  'stopped',
  'stops',
]);

const REPAIR_MARKERS: ReadonlySet<string> = new Set(['fix', 'fixes', 'fixing', 'repair', 'resolve', 'unbreak', 'restore']);

const DIAGNOSE_MARKERS: ReadonlySet<string> = new Set([
  'broken',
  'fail',
  'fails',
  'failing',
  'failed',
  'failure',
  'failures',
  'error',
  'errors',
  'crash',
  'crashes',
  'crashed',
  'crashing',
  'bug',
  'bugs',
  'buggy',
  'why',
  'debug',
  'diagnose',
  'investigate',
  'violation',
  'violations',
  'regression',
  'regressions',
  'doesnt',
  'didnt',
  'cannot',
  'cant',
  'wont',
  'isnt',
  'flaky',
  'hang',
  'hangs',
  'wrong',
]);

/** Markers that, followed by one of {@link MARKER_COMPOUND_NOUNS}, name a THING ("error handling"). */
const COMPOUNDABLE_MARKERS: ReadonlySet<string> = new Set(['error', 'errors', 'bug', 'bugs', 'crash', 'failure']);

const MARKER_COMPOUND_NOUNS: ReadonlySet<string> = new Set([
  'handling',
  'handler',
  'handlers',
  'message',
  'messages',
  'page',
  'pages',
  'boundary',
  'boundaries',
  'type',
  'types',
  'code',
  'codes',
  'class',
  'classes',
  'report',
  'reports',
  'reporting',
  'tracker',
  'tracking',
  'state',
  'states',
]);

/** The planning verbs (moved from the CLI's DX#2 classifier, unchanged). */
const PLANNING_VERBS: ReadonlySet<string> = new Set([
  'plan',
  'design',
  'propose',
  'review',
  'audit',
  'analyze',
  'analyse',
  'explore',
  'consider',
  'investigate',
  'survey',
  'compare',
  'evaluate',
  'assess',
]);

const REVIEW_VERBS: ReadonlySet<string> = new Set(['review', 'audit']);

/** "review" + one of these reviews a CHANGE (a PR), not a design. */
const REVIEW_OBJECTS: ReadonlySet<string> = new Set([
  'pr',
  'prs',
  'pull',
  'diff',
  'diffs',
  'change',
  'changes',
  'changeset',
  'branch',
  'commit',
  'commits',
  'patch',
  'mr',
]);

const REFACTOR_VERBS: ReadonlySet<string> = new Set([
  'refactor',
  'refactoring',
  'rename',
  'extract',
  'cleanup',
  'clean',
  'tidy',
  'simplify',
  'restructure',
  'reorganize',
  'reorganise',
  'move',
  'split',
  'consolidate',
  'dedupe',
  'deduplicate',
  'rewrite',
  'inline',
  'decouple',
]);

const RELEASE_VERBS: ReadonlySet<string> = new Set(['release', 'publish', 'ship', 'tag', 'bump', 'version', 'deploy']);

const EXPLAIN_LEADS: ReadonlySet<string> = new Set([
  'explain',
  'what',
  'how',
  'where',
  'which',
  'who',
  'describe',
  'show',
  'understand',
  'trace',
  'list',
  'find',
]);

/** "let's" → "lets", "doesn't" → "doesnt": one term, so the marker/lead-in sets can name it. */
function expandContractions(query: string): string {
  return query.replace(/\b(let|don|doesn|didn|can|won|isn|wasn|aren)['’](s|t)\b/gi, '$1$2');
}

/** "error handling", "bug report": the marker word names a thing, not a failure. */
function isCompound(terms: readonly string[], i: number): boolean {
  const next = terms[i + 1];
  return COMPOUNDABLE_MARKERS.has(terms[i]!) && next !== undefined && MARKER_COMPOUND_NOUNS.has(next);
}

function isMarker(terms: readonly string[], i: number): boolean {
  const t = terms[i]!;
  if (!REPAIR_MARKERS.has(t) && !DIAGNOSE_MARKERS.has(t)) return false;
  return !isCompound(terms, i);
}

function firstIn(terms: readonly string[], set: ReadonlySet<string>, window = terms.length): number {
  const n = Math.min(window, terms.length);
  for (let i = 0; i < n; i++) if (set.has(terms[i]!)) return i;
  return -1;
}

interface ICreateSighting {
  readonly index: number;
  readonly verb: string;
  readonly strong: boolean;
}

/** The best create sighting in the slot window: a strong one beats a loose one; earliest among equals. */
function findCreate(terms: readonly string[]): ICreateSighting | undefined {
  let loose: ICreateSighting | undefined;
  const n = Math.min(SLOT_WINDOW, terms.length);
  for (let i = 0; i < n; i++) {
    const t = terms[i]!;
    if (!CREATE_VERBS.has(t)) continue;
    let strong = false;
    if (!WEAK_CREATE_WORDS.has(t)) {
      if (i === 0) {
        // "build is broken" / "build error in billing": the create word is the
        // subject noun. "add error handling" is not — `error handling` is a thing.
        const next = terms[1];
        if (next !== undefined && NOUN_FOLLOWERS.has(next) && !isCompound(terms, 1)) continue;
        strong = true;
      } else if (CREATE_LEAD_INS.has(terms[i - 1]!)) {
        strong = true;
      }
    }
    if (strong) return { index: i, verb: t, strong: true };
    if (!loose) loose = { index: i, verb: t, strong: false };
  }
  return loose;
}

/**
 * THE eligibility rule for SOURCE-WRITING offers — a scaffold, a `gen` /
 * `apply` command, a suggested generation: only a create/build query admits
 * them. The recommender gates its writes-source candidates on it and the task
 * packet gates its suggested generation on it, so the two cannot disagree
 * about one query (spec 2.3, round 11 review R11-GAP-6).
 */
export function intentAdmitsSourceWrites(intent: IQueryIntentResult): boolean {
  return intent.intent === QueryIntent.Create;
}

/**
 * A diagnose / repair query ("fix the broken build", "why does the new route
 * fail"): a create/scaffold pipeline, a template, or a source-writing command
 * is never an answer to it — the task packet drops them.
 */
export function intentIsRepairOrDiagnosis(intent: IQueryIntentResult): boolean {
  return intent.intent === QueryIntent.Repair || intent.intent === QueryIntent.Diagnose;
}

/** Classify a free-text query. Pure and deterministic. */
export function classifyQueryIntent(query: string): IQueryIntentResult {
  const terms = normaliseTerms(expandContractions(query));
  if (terms.length === 0) return { intent: QueryIntent.Unknown, terms };

  let marker: string | undefined;
  let repair = false;
  for (let i = 0; i < terms.length; i++) {
    if (!isMarker(terms, i)) continue;
    marker ??= terms[i]!;
    if (REPAIR_MARKERS.has(terms[i]!)) repair = true;
  }

  const create = findCreate(terms);
  const createDetected = create !== undefined && (create.strong || marker === undefined);
  const planIndex = firstIn(terms, PLANNING_VERBS, SLOT_WINDOW);
  const planVerb = planIndex >= 0 ? terms[planIndex] : undefined;
  const base = {
    terms,
    ...(createDetected ? { createVerb: create!.verb } : {}),
    ...(planVerb !== undefined ? { planVerb } : {}),
    ...(create !== undefined && !createDetected && marker !== undefined ? { vetoedBy: marker } : {}),
  };

  if (createDetected && !(planIndex >= 0 && planIndex < create!.index)) {
    return { intent: QueryIntent.Create, ...base };
  }
  if (repair) return { intent: QueryIntent.Repair, ...base };
  if (marker !== undefined) return { intent: QueryIntent.Diagnose, ...base };
  if (firstIn(terms, REVIEW_VERBS, SLOT_WINDOW) >= 0 && firstIn(terms, REVIEW_OBJECTS) >= 0) {
    return { intent: QueryIntent.Review, ...base };
  }
  if (planVerb !== undefined) return { intent: QueryIntent.Plan, ...base };
  if (firstIn(terms, REFACTOR_VERBS, SLOT_WINDOW) >= 0) return { intent: QueryIntent.Refactor, ...base };
  if (firstIn(terms, RELEASE_VERBS, SLOT_WINDOW) >= 0) return { intent: QueryIntent.Release, ...base };
  if (EXPLAIN_LEADS.has(terms[0]!)) return { intent: QueryIntent.Explain, ...base };
  return { intent: QueryIntent.Unknown, ...base };
}
