import { normalizeWiringRule, resolveSourceGlobs, type IWiringRule } from '@shrkcrft/core';
import { globListSelects } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import { unreadMatching } from '../util/read-scope-coverage.ts';
import { globListUnits } from '../util/dead-glob-units.ts';
import { settleGlobLists } from '../util/settle-glob-lists.ts';
import { sourceLivenessRequest } from '../extract/source-liveness-request.ts';
import { loadTsconfigPaths } from '../scan/tsconfig-aliases.ts';
import {
  evaluateWiring,
  wiringGlobsOf,
  wiringSourcesOf,
  type IWiringFileEntry,
  type IWiringReport,
} from './evaluate-wiring.ts';
import { wiringLabeledSources } from './wiring-labeled-sources.ts';

/** All file globs a rule references: every side / every hop. */
function ruleGlobs(rule: IWiringRule): string[] {
  return wiringGlobsOf(rule);
}

export interface IRunWiringOptions {
  /** Only run rules touched by these (project-relative) changed files. */
  readonly changedFiles?: readonly string[];
  /** When true with no changed files, run nothing (matches `--changed-only` with a clean tree). */
  readonly changedOnly?: boolean;
  /** Run only these rule ids. */
  readonly only?: readonly string[];
  /** Project-relative directories to prune from the walk (e.g. the SharkCraft asset dir). */
  readonly excludeDirs?: readonly string[];
}

/**
 * Filesystem-backed wiring run: walks the project once, reads only the files a
 * rule references, and evaluates every (selected) rule. A matched file the
 * reader could not read (over the read cap) is handed to the engine as
 * unread, so the rule's coverage names it instead of passing over it.
 * Pure-engine output; the only IO is the read-only tree walk + reads.
 */
export function runWiring(
  projectRoot: string,
  rules: readonly IWiringRule[],
  options: IRunWiringOptions = {},
): IWiringReport {
  // The engine entry normalises idempotently (round 13): a loaded rule comes
  // back equal, a hand-built `{ pattern, expectEmpty }` entry becomes a glob
  // plus a marker. A MALFORMED entry stays on the authored rule, which
  // `evaluateWiring` reports as misconfigured — no glob reader here sees it.
  const malformed = new Set<IWiringRule>();
  let selected = rules.map((r) => {
    const n = normalizeWiringRule(r);
    if (n.ok) return n.value;
    malformed.add(r);
    return r;
  });
  if (options.only && options.only.length > 0) {
    const ids = new Set(options.only);
    selected = selected.filter((r) => ids.has(r.id));
  }
  if (options.changedOnly) {
    const changed = options.changedFiles ?? [];
    // Per SOURCE, never through the flattened union: a negation subtracts from
    // its own list only, so one side's `!x` cannot hide a changed file another
    // side reads, and a change touching only excluded files selects nothing.
    // A malformed rule has no footprint to prove it out of scope: it stays in.
    selected = selected.filter(
      (r) =>
        malformed.has(r) ||
        wiringSourcesOf(r).some((s) => changed.some((c) => globListSelects(c, resolveSourceGlobs(s)))),
    );
  }
  if (selected.length === 0) {
    return {
      schema: 'sharkcraft.wiring/v1',
      rules: [],
      violations: [],
      diagnostics: [],
      skipped: [],
      evaluated: 0,
      acceptedEmpty: 0,
      verdict: 'pass',
    };
  }

  // Union of all globs across selected rules → one POSITIVE tree walk, cached
  // reads; each source then selects its own files from it (`globListSelects`).
  const allGlobs = [...new Set(selected.filter((r) => !malformed.has(r)).flatMap(ruleGlobs))];
  const excludeDirs = options.excludeDirs ?? [];
  const matched = readMatchingFiles(projectRoot, allGlobs, new Set(excludeDirs));
  const entries: IWiringFileEntry[] = [...matched.files.entries()].map(([path, content]) => ({ path, content }));
  const walked = entries.map((f) => f.path);
  // THE one dead-unit decision (`globListUnits`, the one `gates coverage` and
  // `policy-lint` read) over this run's positive walk.
  const unitsOf = (globs: readonly string[]) => globListUnits(walked, matched.unread, globs);

  // The tsconfig paths let an `import-edges` source resolve alias specifiers the
  // way the compiler does — the same map `check boundaries` resolves with.
  return evaluateWiring(
    selected,
    (source) => entries.filter((f) => globListSelects(f.path, resolveSourceGlobs(source))),
    { tsconfigPaths: loadTsconfigPaths(projectRoot) },
    (source) => unreadMatching(matched.unread, resolveSourceGlobs(source)),
    // Which negations emptied a source's list, so its skip reason says so (R12-DOC-2).
    (source) => {
      const units = unitsOf(resolveSourceGlobs(source));
      return units.allExcluded ? units.negations : undefined;
    },
    // Every source's glob units settled with their `expectEmpty` markers
    // (round 13) — THE per-source request `gates coverage` builds too
    // (`sourceLivenessRequest` over the engine's own side labels), so `check
    // wiring` and `gates coverage` accept, and word, one planned glob alike.
    (rule) => settleGlobLists(sourceLivenessRequest(projectRoot, wiringLabeledSources(rule), excludeDirs, rule.id, unitsOf)),
  );
}
