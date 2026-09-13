import {
  failsWhenEmpty,
  normalizeRuleList,
  RuleEmptiness,
  settleRuleEmptiness,
  unitStateLists,
  UnitLivenessState,
  type IDocReferenceRule,
  type IUnitLiveness,
  type IUnitStateLists,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import {
  dotDirsNamedBy,
  readGlobListLiveness,
  readSelectedFiles,
  safeCompile,
  type IReadScope,
} from '@shrkcrft/boundaries';
import { nearestIds } from './nearest-id.ts';
import {
  emptyReferenceKinds,
  isCacheBackedKind,
  referenceIdExists,
  referenceIdPool,
  type DocReferenceKind,
} from './reference-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * The prose-reference linter.
 *
 * Scans configured docs for id-shaped tokens and asserts each resolves to a
 * real registered id. The failure it exists to catch is silent: a table of
 * template ids in a README or an agent skill file drifts from the registry and
 * nothing — no build, no type-check, no existing gate — notices until someone
 * runs the command and it fails.
 *
 * Everything here is deterministic text work plus a registry lookup. No model,
 * no network, no guessing what a doc "meant".
 */

/** One token the rule considered. */
export interface IDocReferenceToken {
  readonly token: string;
  /** Project-relative path of the document. */
  readonly file: string;
  /** 1-based line. */
  readonly line: number;
  /** The registry that accepted it, when it resolved. */
  readonly resolvedAs?: string;
  /** Why it was not treated as a reference, when it was skipped. */
  readonly skipped?: 'context' | 'exempt' | 'exempt-marker';
}

/** An id-shaped token that resolved to nothing. */
export interface IDocReferenceFinding {
  readonly ruleId: string;
  readonly token: string;
  readonly file: string;
  readonly line: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Closest registered ids, nearest first. Empty when nothing is close. */
  readonly didYouMean: readonly string[];
  readonly hint?: string;
}

/** One rule's outcome. */
export interface IDocReferenceResult {
  readonly ruleId: string;
  readonly description?: string;
  readonly severity: 'error' | 'warning';
  readonly status: 'passed' | 'failed' | 'skipped' | 'error';
  /** Documents the globs matched. */
  readonly filesScanned: number;
  /** Tokens that counted as references (context-gated, non-exempt). */
  readonly tokensChecked: number;
  /** Tokens matched but deliberately not treated as references. */
  readonly tokensSkipped: number;
  readonly findings: readonly IDocReferenceFinding[];
  /** Every token considered — the `explain` view. */
  readonly tokens: readonly IDocReferenceToken[];
  readonly skipReason?: string;
  readonly error?: string;
  /**
   * Set only when a document the globs matched was NOT read (over the read
   * cap, or unreadable): the documents read, and the unread ones. A reference
   * in an unread document was never checked, so the rule's coverage names it
   * (`readScopeCoverage`) and it is never a pass.
   */
  readonly readScope?: IReadScope;
  /**
   * Set only when the rule is INTENDED-empty (round 13): every inclusion glob
   * of its `files` is marked `expectEmpty` and no document matched. It is the
   * settle's acceptance and stands in for the rule's own coverage record
   * (`docReferenceCoverage`), so the rule passes with the acceptance printed.
   */
  readonly emptyCoverage?: IVerdictCoverage;
  /** Settle record B of the rule's `files` — the acceptance of its intended-empty units. */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live `files` units as printed lines (`unitStateLists`). */
  readonly units?: IUnitStateLists;
  /** The rule's non-live `files` units, for `--fail-on-dead-units` (`selectorUnitFails`). */
  readonly unitLiveness?: readonly IUnitLiveness[];
}

/** Matches `<!-- marker -->`, with or without a trailing `: reason`. */
function markerRe(marker: string): RegExp {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<!--\\s*${escaped}\\s*(?::[^>]*)?-->`);
}

/** Character ranges of a line that sit inside a `code span`. */
function backtickRanges(line: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const re = /(`+)([^`]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

/**
 * Whether a match at `index` counts as a reference under the rule's context
 * gate.
 *
 * `insideFence` is passed separately because a fenced block spans lines: its
 * contents are code regardless of backticks on the line itself.
 */
function passesContext(
  rule: IDocReferenceRule,
  line: string,
  index: number,
  insideFence: boolean,
): boolean {
  const mode = rule.requireContext ?? 'backtick';
  if (mode === 'off') return true;
  if (mode === 'after') {
    // "Follows a cue word" has to mean IMMEDIATELY follows. A plain
    // `includes` would qualify every later token on the line too, because the
    // cue still appears somewhere before it — so `shrk gen nge.a — and nge.b`
    // would lint `nge.b` as well. Only whitespace may separate the two.
    const before = line.slice(0, index).toLowerCase();
    return (rule.afterWords ?? []).some((w) => {
      const cue = w.toLowerCase();
      const at = before.lastIndexOf(cue);
      if (at === -1) return false;
      return before.slice(at + cue.length).trim() === '';
    });
  }
  if (insideFence) return true;
  return backtickRanges(line).some((r) => index >= r.start && index < r.end);
}

/** Evaluate one doc-reference rule against the tree. */
export function checkDocReferences(
  projectRoot: string,
  authored: IDocReferenceRule,
  inspection: ISharkcraftInspection,
  excludeDirs: readonly string[] = [],
): IDocReferenceResult {
  const severity = authored.severity ?? 'error';
  const base = {
    ruleId: authored.id,
    ...(authored.description ? { description: authored.description } : {}),
    severity,
  } as const;
  // The engine entry normalises idempotently (round 13): a loaded rule comes
  // back as the SAME object; a hand-built `{ pattern, expectEmpty }` entry is a
  // glob plus a marker; a malformed entry is a misconfigured rule, never a crash.
  const normalized = normalizeRuleList(authored, 'files');
  if (!normalized.ok) {
    return {
      ...base,
      status: 'error',
      filesScanned: 0,
      tokensChecked: 0,
      tokensSkipped: 0,
      findings: [],
      tokens: [],
      error: `files ${normalized.error.message}`,
    };
  }
  const rule = normalized.value;
  // The rule's `files` judged per unit off the walk the check reads (its
  // dot-dirs included) and settled with its `expectEmpty` markers — what an
  // empty rule is decided from, and what rides on the result.
  const live = readGlobListLiveness(projectRoot, 'files', rule.files, rule.expectEmptyUnits ?? [], {
    subject: rule.id,
    excludeDirs: new Set(excludeDirs),
    allowDotDirs: dotDirsNamedBy(rule.files),
  });
  const nonLive = live.liveness.units.filter((u) => u.state !== UnitLivenessState.Live);
  const unitFields = {
    ...(live.liveness.acceptance !== undefined ? { unitAcceptance: live.liveness.acceptance } : {}),
    ...(live.liveness.dead.length + live.liveness.intendedEmpty.length + live.liveness.wentLive.length > 0
      ? { units: unitStateLists(live.liveness) }
      : {}),
    ...(nonLive.length > 0 ? { unitLiveness: nonLive } : {}),
  };

  const compiled = safeCompile(rule.tokenPattern, `${rule.tokenPatternFlags ?? ''}g`);
  if (compiled.error || !compiled.re) {
    return {
      ...base,
      status: 'error',
      filesScanned: 0,
      tokensChecked: 0,
      tokensSkipped: 0,
      findings: [],
      tokens: [],
      error: `tokenPattern ${compiled.error}`,
    };
  }

  const kinds = rule.resolvesAs as readonly DocReferenceKind[];

  // Resolving against an EMPTY registry cannot succeed, so every id checked
  // against it is reported unresolved — a gate confidently flagging CORRECT
  // usage. That is worse than no gate at all (it is the fastest way to get one
  // switched off), so refuse loudly instead of emitting a page of false
  // findings.
  const empty = emptyReferenceKinds(inspection, kinds);
  if (empty.length === kinds.length && kinds.length > 0) {
    const warmable = empty.filter(isCacheBackedKind);
    return {
      ...base,
      status: 'error',
      filesScanned: 0,
      tokensChecked: 0,
      tokensSkipped: 0,
      findings: [],
      tokens: [],
      error:
        `no ids are registered for ${empty.join(' / ')} — nothing could resolve, ` +
        `so every reference would be reported wrong` +
        (warmable.length > 0
          ? ` (call warmReferenceRegistries() before checking, or this repo has no ${warmable.join(' / ')})`
          : ''),
    };
  }

  // Prose lives in places the code walkers deliberately avoid — an agent skill
  // file sits in `.claude/skills`. The rule's own globs say which dot-dirs it
  // means, and it gets exactly those.
  // The files the rule's list SELECTS: a `!docs/drafts/**` entry excludes.
  const matched = readSelectedFiles(
    projectRoot,
    rule.files,
    new Set(excludeDirs),
    dotDirsNamedBy(rule.files),
  );
  const docs = [...matched.files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const unread = matched.unread;
  const readScope: IReadScope | undefined = unread.length > 0 ? { read: docs.length, unread } : undefined;

  const pool = referenceIdPool(inspection, kinds);
  const exempt = new Set(rule.exempt ?? []);
  const marker = rule.exemptMarker;

  const tokens: IDocReferenceToken[] = [];
  const findings: IDocReferenceFinding[] = [];

  for (const [file, content] of docs) {
    const lines = content.split('\n');
    let insideFence = false;
    for (const [i, rawLine] of lines.entries()) {
      // A ``` toggles the fenced-code state for every FOLLOWING line; the fence
      // line itself carries no tokens worth checking.
      if (/^\s*```/.test(rawLine)) {
        insideFence = !insideFence;
        continue;
      }
      // `<!-- ref-allow -->` and `<!-- ref-allow: why this is not a reference -->`
      // both count. An exemption whose whole justification is that it was
      // reviewed in a diff needs somewhere to say WHY, and a marker that must
      // be byte-exact leaves the reason to a comment on another line — where
      // this gate cannot see it, so the exemption silently stops applying.
      const markerHit = marker !== undefined && markerRe(marker).test(rawLine);
      compiled.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = compiled.re.exec(rawLine)) !== null) {
        const token = m[0];
        const site = { token, file, line: i + 1 };
        if (markerHit) {
          tokens.push({ ...site, skipped: 'exempt-marker' });
          continue;
        }
        if (exempt.has(token)) {
          tokens.push({ ...site, skipped: 'exempt' });
          continue;
        }
        if (!passesContext(rule, rawLine, m.index, insideFence)) {
          tokens.push({ ...site, skipped: 'context' });
          continue;
        }
        const resolvedAs = kinds.find((kind) => referenceIdExists(inspection, kind, token));
        if (resolvedAs !== undefined) {
          tokens.push({ ...site, resolvedAs });
          continue;
        }
        tokens.push(site);
        const suggestions = nearestIds(token, pool).map((n) => n.id);
        findings.push({
          ruleId: rule.id,
          ...site,
          severity,
          message: `"${token}" is not a registered ${kinds.join(' / ')}`,
          didYouMean: suggestions,
          ...(rule.hint ? { hint: rule.hint } : {}),
        });
        // A zero-width match would loop forever; nudge past it.
        if (m[0].length === 0) compiled.re.lastIndex += 1;
      }
    }
  }

  const tokensChecked = tokens.filter((t) => t.skipped === undefined).length;
  const tokensSkipped = tokens.length - tokensChecked;

  // Its globs matched a document the reader could not read: its zero is not
  // "matched nothing". It ran over everything readable and is PARTIAL (its
  // coverage names the unread document), never failOnEmpty's 1 and never a pass.
  if (tokensChecked === 0 && readScope !== undefined) {
    return {
      ...base,
      status: 'passed',
      filesScanned: docs.length,
      tokensChecked,
      tokensSkipped,
      findings: [],
      tokens,
      readScope,
      ...unitFields,
    };
  }

  // A rule that CHECKED nothing enforced nothing. Which of "0 docs" or "0
  // tokens" happened matters to whoever has to fix it, so the reason says.
  if (tokensChecked === 0) {
    // THE rule-emptiness settle (round 13, `settleRuleEmptiness`), with THE
    // failOnEmpty authority (`failsWhenEmpty`) — never re-derived inline. Every
    // inclusion glob of `files` marked `expectEmpty` and no document matched →
    // the intended empty, accepted and printed. Documents that cite no token
    // are the stale-extractor loud skip — never assertable.
    const emptiness = settleRuleEmptiness({
      subject: rule.id,
      unitLabel: 'references',
      filesMatched: docs.length,
      unitsMatched: 0,
      unread: false,
      liveness: live.liveness,
      primaryLists: ['files'],
      failOnEmpty: failsWhenEmpty(rule),
      noFilesReason: `0 documents matched (${rule.files.join(', ')})`,
      noUnitsReason:
        `${docs.length} document(s) scanned but no token counted as a reference` +
        (tokensSkipped > 0 ? ` (${tokensSkipped} matched and were skipped — check \`requireContext\`)` : ''),
    });
    if (emptiness.state === RuleEmptiness.IntendedEmpty && emptiness.coverage !== undefined) {
      return {
        ...base,
        status: 'passed',
        filesScanned: docs.length,
        tokensChecked,
        tokensSkipped,
        findings: [],
        tokens,
        ...unitFields,
        emptyCoverage: emptiness.coverage,
      };
    }
    return {
      ...base,
      status: emptiness.fails ? 'failed' : 'skipped',
      filesScanned: docs.length,
      tokensChecked,
      tokensSkipped,
      findings: [],
      tokens,
      ...unitFields,
      ...(emptiness.skipReason !== undefined ? { skipReason: emptiness.skipReason } : {}),
    };
  }

  return {
    ...base,
    status: findings.length > 0 && severity === 'error' ? 'failed' : findings.length > 0 ? 'failed' : 'passed',
    filesScanned: docs.length,
    tokensChecked,
    tokensSkipped,
    findings,
    tokens,
    ...(readScope !== undefined ? { readScope } : {}),
    ...unitFields,
  };
}
