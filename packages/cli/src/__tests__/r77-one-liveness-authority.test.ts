/**
 * r77 — ONE liveness authority (round 13; DECISIONS §2 and §9; DESIGN-D1 tests
 * item 10). THE TWO-WAY LOCK.
 *
 * Three rounds fixed the same shape: two code paths answering one question,
 * agreeing only by coincidence. Round 13 gives "is this selector unit dead,
 * intended-empty or went-live?" and "may this empty rule pass?" ONE answer
 * each, in `@shrkcrft/core` (packages/core/src/liveness/): `settleUnitLiveness`
 * and `settleRuleEmptiness`. This file keeps it that way:
 *
 *   (a) DEAD_UNIT_REPORTERS — every non-test source file that builds or carries
 *       a dead-unit list is a row; every PRODUCER row calls settleUnitLiveness(;
 *       every file calling settleUnitLiveness( is a producer row; an EXEMPT row
 *       (a renderer, a type) may only READ a settled list; every markable list
 *       has a producer.
 *   (b) RULE_EMPTINESS_SITES — the same two-way lock for settleRuleEmptiness(,
 *       over every site that decides what a rule that matched nothing is.
 *   (c) grep locks — the retired wording `typo or retired target` is gone; no
 *       inline `failOnEmpty ??` severity default (failsWhenEmpty is the one
 *       authority); no `.expectEmpty` read outside core/liveness, the config
 *       schema and the baseline rule view.
 *   (d) census — an exhaustive Record<MarkableUnitList, …>: each case declares
 *       one marked unit through the REAL loader, runs the REAL reporter, asserts
 *       intended-empty + the acceptance, then creates the target and asserts
 *       went-live. Adding a list without a case fails tsc.
 *
 * EXPECTED RED until lanes B (boundaries), G (gate planes) and A (assets) land
 * their migrations; the final gate requires it green. Every failure names the
 * owning lane and the exact fix. Lanes own their rows and census cases: edit
 * them here as the design lands (a row may move, never silently disappear).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  levenshtein as coreLevenshtein,
  MARKABLE_UNIT_LISTS,
  MarkableListOwner,
  MarkableUnitList,
  nearestIds as coreNearestIds,
  UnitEntryForm,
} from '@shrkcrft/core';
import { blankZoneKinds, lexCodeZones } from '@shrkcrft/boundaries';
import { levenshtein, nearestIds } from '@shrkcrft/inspector';

// packages/cli/src/__tests__ → repo root is four levels up.
const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_MAIN = join(REPO_ROOT, 'packages', 'cli', 'src', 'main.ts');

/** The round-13 lanes that own a row or a census case (DECISIONS §9). */
type Lane = 'B' | 'G' | 'A';

const LANE_OF_OWNER: Readonly<Record<MarkableListOwner, Lane>> = {
  [MarkableListOwner.Boundaries]: 'B',
  [MarkableListOwner.GatePlanes]: 'G',
  [MarkableListOwner.Assets]: 'A',
};

/** Which lane owns a path, for grep-lock messages (DECISIONS §9 ownership). */
const LANE_BY_PATH: readonly (readonly [RegExp, Lane])[] = [
  [/^packages\/boundaries\/src\/(evaluate|model|registry)\//, 'B'],
  [/^packages\/boundaries\/src\/scan\/import-pattern\.ts$/, 'B'],
  [/^packages\/inspector\/src\/(run-boundary-check|boundary-[^/]*)\.ts$/, 'B'],
  [/^packages\/cli\/src\/commands\/(check|boundaries|explain)\.command\.ts$/, 'B'],
  [/^packages\/mcp-server\/src\/tools\/[^/]*boundar[^/]*\.ts$/, 'B'],
  [/^packages\/boundaries\/src\/(util|policy|extract|wiring)\//, 'G'],
  [/^packages\/config\/src\//, 'G'],
  [/^packages\/core\/src\/(wiring|baseline)\//, 'G'],
  [/^packages\/inspector\/src\/(resolve-project-config|doc-references)\.ts$/, 'G'],
  [/^packages\/cli\/src\/gates\//, 'G'],
  [/^packages\/cli\/src\/commands\/(gates|baseline|generated|policy-lint|docs-references|registry|wiring)\.command\.ts$/, 'G'],
  [/^packages\/inspector\/src\/(registration-hint-registry|scaffold-patterns|search-tuning-[^/]*|self-config-doctor[^/]*|i-search-tuning-lint-report)\.ts$/, 'A'],
  [/^packages\/cli\/src\/commands\/(registrations|scaffolds|search|self-config)\.command\.ts$/, 'A'],
  [/^packages\/mcp-server\/src\/tools\/(scaffold|self-config)[^/]*\.ts$/, 'A'],
  [/^packages\/plugin-api\/src\/(registration-hint|scaffold-pattern|search-tuning)\.ts$/, 'A'],
];

function laneOfPath(rel: string): string {
  const hit = LANE_BY_PATH.find(([re]) => re.test(rel));
  return hit ? `lane ${hit[1]}` : 'the owning lane (DECISIONS §9)';
}

// ── the source census ─────────────────────────────────────────────────────

interface ISource {
  /** Repo-relative, `/`-separated. */
  readonly rel: string;
  readonly text: string;
  /** `text` with comments blanked (equal length), so a doc comment describing a construct is not a hit. */
  readonly code: string;
}

let sourceCache: readonly ISource[] | undefined;

/** Every non-test `.ts` under packages/<pkg>/src (no __tests__, dist, node_modules, *.test.ts, *.d.ts). */
function sources(): readonly ISource[] {
  if (sourceCache) return sourceCache;
  const out: ISource[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
        walk(abs);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
      const text = readFileSync(abs, 'utf8');
      const code = blankZoneKinds(text, lexCodeZones(text), new Set(['comment'] as const)).content;
      out.push({ rel: relative(REPO_ROOT, abs).split(sep).join('/'), text, code });
    }
  };
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    if (existsSync(src) && statSync(src).isDirectory()) walk(src);
  }
  sourceCache = out;
  return out;
}

function sourceAt(rel: string): ISource | undefined {
  return sources().find((s) => s.rel === rel);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** The one authority's own module — it defines what the locks look for. */
const LIVENESS_DIR = 'packages/core/src/liveness/';
/** THE failOnEmpty authority (`failsWhenEmpty`). */
const FAIL_ON_EMPTY_AUTHORITY = 'packages/core/src/wiring/rule-empty-policy.ts';

/** A file that builds or carries a dead-unit list (refined against the round-13 tree). */
const DEAD_LIST_MENTION = /\b(?:deadUnits|deadGlobUnits|ruleDead)\b\s*(?:\.push\(|[:=](?!=))/;
/** BUILDING one, rather than reading a settled one: a push, an array-literal init, or a mapped/filtered derivation. */
const DEAD_LIST_BUILD =
  /\b(?:deadUnits|deadGlobUnits|ruleDead)\s*\.push\(|\b(?:const|let)\s+(?:deadUnits|deadGlobUnits|ruleDead)\b[^=;\n]*=\s*\[|\b(?:deadUnits|deadGlobUnits)\s*:\s*(?:\[\s*[^\]\s]|[\w$.?]+\.(?:map|filter|flatMap)\()/;
const SETTLE_UNITS_CALL = /\bsettleUnitLiveness\(/;
const SETTLE_RULE_CALL = /\bsettleRuleEmptiness\(/;
/** A site that decides (or re-derives) what a rule that matched nothing is. */
const EMPTINESS_SITE = /\bfailsWhenEmpty\(|\bboundaryRuleFailsOnEmpty\(|\bfailOnEmpty\s*\?\?|\.failOnEmpty\s*===\s*true/;

// ── (a) DEAD_UNIT_REPORTERS ───────────────────────────────────────────────

interface IProducerRow {
  readonly lane: Lane;
  /** The markable lists this reporter judges. Empty: it settles only unmarkable (out-of-scope) units. */
  readonly produces: readonly MarkableUnitList[];
  readonly note?: string;
}

interface IExemptRow {
  readonly lane: Lane;
  /** Why this file may mention a dead-unit list without settling one: it only READS a settled list. */
  readonly exempt: string;
}

type IReporterRow = IProducerRow | IExemptRow;

const BOUNDARY_LISTS: readonly MarkableUnitList[] = [
  MarkableUnitList.BoundaryFrom,
  MarkableUnitList.BoundaryFromNegation,
  MarkableUnitList.BoundaryExemptFiles,
  MarkableUnitList.BoundaryForbiddenImports,
  MarkableUnitList.BoundaryAllowedImports,
];

const GATE_LISTS: readonly MarkableUnitList[] = (Object.keys(MARKABLE_UNIT_LISTS) as MarkableUnitList[]).filter(
  (l) => MARKABLE_UNIT_LISTS[l].owner === MarkableListOwner.GatePlanes,
);

/**
 * Seeded from the round-13 census (`deadUnits` / `deadGlobUnits` / `ruleDead`
 * producers and carriers in packages/*\/src), each row naming its owning lane.
 */
const DEAD_UNIT_REPORTERS: Readonly<Record<string, IReporterRow>> = {
  // ── lane B — boundaries ──────────────────────────────────────────────────
  // Landed (round 13, lane B): ONE boundary settle, settleBoundaryRule, which
  // both the evaluator and the unread re-settle call — so the seeded producer
  // rows moved: evaluate-boundaries.ts / run-boundary-check.ts now OBSERVE and
  // READ (exempt), and inspector/src/boundary-unit-liveness.ts (the re-settle
  // `check boundaries` AND `--diff-against` call, V1-U1 / P2) re-settles
  // through settleBoundaryRule and carries no dead list of its own (no row).
  'packages/boundaries/src/evaluate/settle-boundary-rule.ts': {
    lane: 'B',
    produces: BOUNDARY_LISTS,
    note: 'THE boundary settle (units + rule emptiness): from inclusions Coverage, from negations / exemptFiles / forbidden / allowed Advisory; the evaluator and the unread re-settle both call it',
  },
  'packages/boundaries/src/evaluate/evaluate-boundaries.ts': {
    lane: 'B',
    exempt: 'the evaluator OBSERVES each unit (exists / live) and hands the rule to settleBoundaryRule; its deadUnits are the settled .dead, aggregated by reading',
  },
  'packages/boundaries/src/evaluate/i-boundary-rule-settlement.ts': {
    lane: 'B',
    exempt: "type declaration: settleBoundaryRule's answer carries the settled dead list",
  },
  'packages/boundaries/src/evaluate/with-boundary-rule-settlement.ts': {
    lane: 'B',
    exempt: 'applies a settlement to a rule coverage record — copies the settled dead list, derives nothing',
  },
  'packages/inspector/src/run-boundary-check.ts': {
    lane: 'B',
    exempt: 'the orchestrator: re-settles each rule through boundaryUnitLiveness → settleBoundaryRule (withProvableDeadUnits, which dropped claims silently, is gone) and reads the settled lists',
  },
  'packages/inspector/src/boundary-check-result.model.ts': {
    lane: 'B',
    exempt: 'type declaration: carries the settled dead list',
  },
  'packages/cli/src/commands/check.command.ts': {
    lane: 'B',
    exempt: 'renderer: prints / serialises the settled boundary dead list',
  },
  'packages/mcp-server/src/tools/check-boundaries.tool.ts': {
    lane: 'B',
    exempt: 'renderer: MCP check_boundaries output of the settled list',
  },
  'packages/mcp-server/src/tools/r28-changed-boundary.tool.ts': {
    lane: 'B',
    exempt: "renderer: MCP get_changed_boundary_report passes the orchestrator's settled list through (round 13 review)",
  },
  // ── lane G — gate planes ─────────────────────────────────────────────────
  'packages/boundaries/src/policy/run-policy.ts': {
    lane: 'G',
    produces: [MarkableUnitList.PolicyFiles],
    note: "policyRules[].files glob units (globListUnits observations: exists = matched > 0, live = not dead)",
  },
  'packages/cli/src/gates/rule-coverage.ts': {
    lane: 'G',
    produces: GATE_LISTS,
    note: 'gates coverage / gates try: every source, watchFiles, generatedGlob and docReferences glob, and import-edges to.files (newly judged)',
  },
  'packages/boundaries/src/util/settle-glob-lists.ts': {
    lane: 'G',
    produces: GATE_LISTS,
    note: 'THE gate-plane glob settle the plane engines call before deciding an empty rule (runWiring, the registration role measurement, the baseline / generated / doc-reference / registry emptiness) — settleUnitLiveness over the one input builder (globListLivenessInput) run-policy and rule-coverage use too',
  },
  // ── lane A — assets ──────────────────────────────────────────────────────
  'packages/inspector/src/registration-hint-registry.ts': {
    lane: 'A',
    produces: [MarkableUnitList.RegistrationHintTargetGlobs, MarkableUnitList.RegistrationHintTargetFile],
  },
  'packages/inspector/src/scaffold-patterns.ts': {
    lane: 'A',
    produces: [MarkableUnitList.ScaffoldPatternMatchPaths],
    note: 'the derived pattern-level unit is intended-empty iff all its globs are: one acceptance, not dead=2',
  },
  'packages/inspector/src/search-tuning-lint.ts': {
    lane: 'A',
    produces: [MarkableUnitList.SearchTuningBoostIds, MarkableUnitList.SearchTuningTaskHintBoostIds],
  },
  'packages/inspector/src/self-config-doctor-v2.ts': {
    lane: 'A',
    produces: [],
    note: 'aggregates the asset settles; its own routing-hint dead units (OUT of marker scope) settle unmarked, so its dead list still has one derivation',
  },
  'packages/inspector/src/self-config-doctor.ts': { lane: 'A', exempt: 'renderer: v1 passes the settled report.deadUnits through' },
  'packages/inspector/src/i-search-tuning-lint-report.ts': { lane: 'A', exempt: 'type declaration: carries the settled dead list' },
  'packages/cli/src/commands/registrations.command.ts': { lane: 'A', exempt: 'renderer: registrations doctor text / --json' },
  'packages/cli/src/commands/scaffolds.command.ts': { lane: 'A', exempt: 'renderer: scaffolds doctor text / --json' },
  'packages/cli/src/commands/search.command.ts': { lane: 'A', exempt: 'renderer: search tuning doctor text / --json' },
  'packages/mcp-server/src/tools/scaffold-patterns.tool.ts': {
    lane: 'A',
    exempt: 'renderer: MCP get_scaffold_pattern_doctor output of the settled list',
  },
};

function isProducer(row: IReporterRow): row is IProducerRow {
  return 'produces' in row;
}

const MIGRATE_REPORTER =
  'build one IUnitObservation per unit (exists = RAW target existence, live = today\'s dead predicate negated), pass the element\'s expectEmptyUnits as marks, call settleUnitLiveness once, and report settled.dead / .shortfall / .acceptance (@shrkcrft/core, packages/core/src/liveness/; docs/intended-empty.md)';

describe('(a) DEAD_UNIT_REPORTERS — every dead-unit list comes from settleUnitLiveness', () => {
  test('every source file that builds or carries a dead-unit list has a row', () => {
    const missing = sources()
      .filter((s) => !s.rel.startsWith(LIVENESS_DIR) && DEAD_LIST_MENTION.test(s.code) && !(s.rel in DEAD_UNIT_REPORTERS))
      .map(
        (s) =>
          `${laneOfPath(s.rel)}: ${s.rel} builds or carries a dead-unit list but has no DEAD_UNIT_REPORTERS row — add one: a producer row (it must call settleUnitLiveness() — ${MIGRATE_REPORTER}) or an exempt row saying why it only reads a settled list`,
      );
    expect(missing).toEqual([]);
  });

  test('every producer row settles through settleUnitLiveness(', () => {
    const failures: string[] = [];
    for (const [rel, row] of Object.entries(DEAD_UNIT_REPORTERS)) {
      if (!isProducer(row)) continue;
      const s = sourceAt(rel);
      if (s === undefined) {
        failures.push(`lane ${row.lane}: ${rel} does not exist — ${row.note ?? 'create it'} (or move this row to where the design landed)`);
        continue;
      }
      if (!SETTLE_UNITS_CALL.test(s.code)) {
        const lists = row.produces.length > 0 ? row.produces.join(', ') : 'unmarkable units';
        failures.push(`lane ${row.lane}: ${rel} reports dead units (${lists}) but never calls settleUnitLiveness( — ${MIGRATE_REPORTER}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('every file that calls settleUnitLiveness( is a producer row', () => {
    const failures: string[] = [];
    for (const s of sources()) {
      if (s.rel.startsWith(LIVENESS_DIR) || !SETTLE_UNITS_CALL.test(s.code)) continue;
      const row = DEAD_UNIT_REPORTERS[s.rel];
      if (row === undefined) {
        failures.push(`${laneOfPath(s.rel)}: ${s.rel} calls settleUnitLiveness( but has no DEAD_UNIT_REPORTERS row — add a producer row naming its lane and the MarkableUnitLists it judges`);
      } else if (!isProducer(row)) {
        failures.push(`lane ${row.lane}: ${s.rel} is an EXEMPT row but calls settleUnitLiveness( — make it a producer row`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('an exempt row only READS a settled list — and is not stale', () => {
    const failures: string[] = [];
    for (const [rel, row] of Object.entries(DEAD_UNIT_REPORTERS)) {
      if (isProducer(row)) continue;
      const s = sourceAt(rel);
      if (s === undefined) {
        failures.push(`lane ${row.lane}: ${rel} no longer exists — delete its exempt row`);
        continue;
      }
      const built = DEAD_LIST_BUILD.exec(s.code);
      if (built !== null) {
        failures.push(
          `lane ${row.lane}: ${rel}:${lineOf(s.code, built.index)} is exempt (${row.exempt}) but builds a dead-unit list itself (\`${built[0].trim()}\`) — read the settled .dead instead, or make it a producer row that calls settleUnitLiveness(`,
        );
      }
      if (!DEAD_LIST_MENTION.test(s.code)) {
        failures.push(`lane ${row.lane}: ${rel} no longer mentions a dead-unit list — delete its exempt row`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('every MarkableUnitList has a producer row, and every row names real lists', () => {
    const known = new Set<string>(Object.values(MarkableUnitList));
    const produced = new Set<MarkableUnitList>();
    const bad: string[] = [];
    for (const [rel, row] of Object.entries(DEAD_UNIT_REPORTERS)) {
      if (!isProducer(row)) continue;
      for (const l of row.produces) {
        if (!known.has(l)) bad.push(`${rel}: unknown list ${String(l)}`);
        produced.add(l);
      }
    }
    const orphans = Object.values(MarkableUnitList)
      .filter((l) => !produced.has(l))
      .map((l) => `lane ${LANE_OF_OWNER[MARKABLE_UNIT_LISTS[l].owner]}: ${l} has no producer row — name the reporter that judges it`);
    expect([...bad, ...orphans]).toEqual([]);
  });
});

// ── (b) RULE_EMPTINESS_SITES ──────────────────────────────────────────────

interface ISettleSiteRow {
  readonly lane: Lane;
  readonly settles: true;
  readonly note?: string;
}

type IEmptinessRow = ISettleSiteRow | IExemptRow;

/**
 * Every site that decides what a rule that matched nothing IS (seeded from the
 * round-13 census: failsWhenEmpty( / boundaryRuleFailsOnEmpty( callers and the
 * inline re-derivations), each naming its owning lane.
 */
const RULE_EMPTINESS_SITES: Readonly<Record<string, IEmptinessRow>> = {
  // ── lane B ───────────────────────────────────────────────────────────────
  // Moved (round 13, lane B): the decision lives in THE boundary settle, which
  // the evaluator and the unread re-settle both call; evaluate-boundaries.ts
  // no longer decides emptiness itself.
  'packages/boundaries/src/evaluate/settle-boundary-rule.ts': {
    lane: 'B',
    settles: true,
    note: 'a rule whose from globs govern no file (IntendedEmpty when every from inclusion is marked; c5-from-only-future 1 → 0)',
  },
  'packages/boundaries/src/model/boundary-rule-scope.ts': {
    lane: 'B',
    exempt: 'boundaryRuleFailsOnEmpty: the boundary view of the failOnEmpty ANSWER — it must delegate to failsWhenEmpty (grep lock c)',
  },
  'packages/cli/src/commands/boundaries.command.ts': {
    lane: 'B',
    exempt: '`boundaries explain` prints the effective failOnEmpty; it decides no emptiness',
  },
  'packages/mcp-server/src/tools/get-boundary-rule.tool.ts': {
    lane: 'B',
    exempt: 'MCP get_boundary_rule reports the effective failOnEmpty; it decides no emptiness',
  },
  // ── lane G ───────────────────────────────────────────────────────────────
  'packages/boundaries/src/wiring/evaluate-wiring.ts': { lane: 'G', settles: true, note: 'the source side matched 0 files / 0 ids' },
  'packages/boundaries/src/policy/evaluate-policy.ts': { lane: 'G', settles: true, note: '0 content units matched the rule globs' },
  'packages/cli/src/gates/rule-coverage.ts': { lane: 'G', settles: true, note: "gates coverage `empty` status and the fence acceptance (today's view.expectEmpty read)" },
  'packages/cli/src/gates/run-gate-planes.ts': { lane: 'G', settles: true, note: 'registries[] and registrationGraph[] in gates check (inline `failOnEmpty === true` today)' },
  'packages/cli/src/commands/registry.command.ts': { lane: 'G', settles: true, note: 'the registry verbs over an empty inventory' },
  'packages/cli/src/commands/baseline.command.ts': { lane: 'G', settles: true, note: 'ledger AND ceiling branches (P1: count extractor units, never text)' },
  'packages/cli/src/commands/generated.command.ts': { lane: 'G', settles: true },
  'packages/inspector/src/doc-references.ts': { lane: 'G', settles: true, note: 'the 0-documents branch (inline `failOnEmpty ?? severity` today)' },
  'packages/cli/src/gates/gate-rule-view.ts': {
    lane: 'G',
    exempt: 'the rule view reports the EFFECTIVE failOnEmpty (failsWhenEmpty) to list verbs and coverage; it decides no emptiness',
  },
  'packages/config/src/config-schema.ts': {
    lane: 'G',
    exempt: 'the load-time expectEmpty × failOnEmpty conflict; it decides no emptiness',
  },
};

function settles(row: IEmptinessRow): row is ISettleSiteRow {
  return 'settles' in row;
}

const MIGRATE_SITE =
  'settle the rule\'s units first (settleUnitLiveness), then call settleRuleEmptiness({ filesMatched, unitsMatched, unread, emptiedByNegations, liveness, primaryLists, assertsEmptyOutput: ruleAssertsEmptyOutput(rule), failOnEmpty: failsWhenEmpty(rule), noFilesReason, noUnitsReason }) and report from its state / skipped / fails / skipReason / coverage (@shrkcrft/core)';

describe('(b) RULE_EMPTINESS_SITES — every "matched nothing" decision comes from settleRuleEmptiness', () => {
  test('every site that decides (or re-derives) rule emptiness has a row', () => {
    const missing = sources()
      .filter(
        (s) =>
          !s.rel.startsWith(LIVENESS_DIR) &&
          s.rel !== FAIL_ON_EMPTY_AUTHORITY &&
          EMPTINESS_SITE.test(s.code) &&
          !(s.rel in RULE_EMPTINESS_SITES),
      )
      .map(
        (s) =>
          `${laneOfPath(s.rel)}: ${s.rel} decides what an empty rule is but has no RULE_EMPTINESS_SITES row — add a settles row (${MIGRATE_SITE}) or an exempt row saying why it decides nothing`,
      );
    expect(missing).toEqual([]);
  });

  test('every settles row calls settleRuleEmptiness(', () => {
    const failures: string[] = [];
    for (const [rel, row] of Object.entries(RULE_EMPTINESS_SITES)) {
      if (!settles(row)) continue;
      const s = sourceAt(rel);
      if (s === undefined) {
        failures.push(`lane ${row.lane}: ${rel} does not exist — move this row to where the decision lives now`);
        continue;
      }
      if (!SETTLE_RULE_CALL.test(s.code)) {
        failures.push(`lane ${row.lane}: ${rel} decides rule emptiness${row.note ? ` (${row.note})` : ''} but never calls settleRuleEmptiness( — ${MIGRATE_SITE}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('every file that calls settleRuleEmptiness( is a settles row', () => {
    const failures: string[] = [];
    for (const s of sources()) {
      if (s.rel.startsWith(LIVENESS_DIR) || !SETTLE_RULE_CALL.test(s.code)) continue;
      const row = RULE_EMPTINESS_SITES[s.rel];
      if (row === undefined) {
        failures.push(`${laneOfPath(s.rel)}: ${s.rel} calls settleRuleEmptiness( but has no RULE_EMPTINESS_SITES row — add a settles row naming its lane`);
      } else if (!settles(row)) {
        failures.push(`lane ${row.lane}: ${s.rel} is an EXEMPT row but calls settleRuleEmptiness( — make it a settles row`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('an exempt row still is an emptiness site (not stale)', () => {
    const failures: string[] = [];
    for (const [rel, row] of Object.entries(RULE_EMPTINESS_SITES)) {
      if (settles(row)) continue;
      const s = sourceAt(rel);
      if (s === undefined) failures.push(`lane ${row.lane}: ${rel} no longer exists — delete its exempt row`);
      else if (!EMPTINESS_SITE.test(s.code)) failures.push(`lane ${row.lane}: ${rel} decides nothing about emptiness any more — delete its exempt row`);
    }
    expect(failures).toEqual([]);
  });
});

// ── (c) grep locks ────────────────────────────────────────────────────────

const RETIRED_WORDING = 'typo or retired target';
const RETIRED_WORDING_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['packages/cli/src/commands/changelog-data.ts', 'the round-12 changelog entry quotes the wording it retired — released history is immutable'],
]);
/** Where a rule's `.expectEmpty` may be read: the authority, the schema, and the baseline rule view. */
const EXPECT_EMPTY_READERS: readonly (readonly [string, string])[] = [
  [LIVENESS_DIR, 'the one authority (ruleAssertsEmptyOutput, the marker parser)'],
  ['packages/config/src/config-schema.ts', 'the schema and its load-time conflict'],
  ['packages/cli/src/gates/gate-rule-view.ts', 'the baseline rule view copies the field for the coverage report'],
];

describe('(c) grep locks', () => {
  test("the retired dead-selector wording ('typo or retired target') is gone from packages/*/src", () => {
    expect(RETIRED_WORDING_EXEMPT.size).toBe(1);
    const hits: string[] = [];
    for (const s of sources()) {
      if (RETIRED_WORDING_EXEMPT.has(s.rel)) continue;
      for (let i = s.text.indexOf(RETIRED_WORDING); i >= 0; i = s.text.indexOf(RETIRED_WORDING, i + 1)) {
        hits.push(
          `${laneOfPath(s.rel)}: ${s.rel}:${lineOf(s.text, i)} still carries the retired wording — word a dead unit through formatUnitLiveness / DEAD_SELECTOR_CAUSES ('typo, retired target, or a target that does not exist yet (see expectEmpty)', @shrkcrft/core)`,
        );
      }
    }
    expect(hits).toEqual([]);
  });

  test('no inline `failOnEmpty ??` severity default — failsWhenEmpty is the one authority', () => {
    const hits: string[] = [];
    for (const s of sources()) {
      if (s.rel === FAIL_ON_EMPTY_AUTHORITY || s.rel.startsWith(LIVENESS_DIR)) continue;
      for (const m of s.code.matchAll(/\bfailOnEmpty\s*\?\?/g)) {
        hits.push(
          `${laneOfPath(s.rel)}: ${s.rel}:${lineOf(s.code, m.index ?? 0)} defaults failOnEmpty inline — ask the one authority, failsWhenEmpty(rule) (@shrkcrft/core), and pass its answer to settleRuleEmptiness`,
        );
      }
    }
    expect(hits).toEqual([]);
  });

  test('no `.expectEmpty` read outside core/liveness, config-schema.ts and the baseline rule view', () => {
    const hits: string[] = [];
    for (const s of sources()) {
      if (EXPECT_EMPTY_READERS.some(([prefix]) => s.rel.startsWith(prefix))) continue;
      for (const m of s.code.matchAll(/\.expectEmpty\b/g)) {
        hits.push(
          `${laneOfPath(s.rel)}: ${s.rel}:${lineOf(s.code, m.index ?? 0)} reads .expectEmpty — pass ruleAssertsEmptyOutput(rule) to settleRuleEmptiness as assertsEmptyOutput (a marker's own expectEmpty is read only by the core parser)`,
        );
      }
    }
    expect(hits).toEqual([]);
  });
});

// ── (d) the census ────────────────────────────────────────────────────────

/** A lane's real check, or `{ todo }` until it lands (a todo FAILS). */
type ICensusCase = { readonly todo: Lane } | { readonly check: () => void | Promise<void> };

const censusRoots: string[] = [];
afterAll(() => {
  for (const r of censusRoots) rmSync(r, { recursive: true, force: true });
});

/** A real workspace for a census case: `package.json` plus the given files (paths relative to the root). */
function censusFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-census-'));
  censusRoots.push(root);
  const all: Record<string, string> = { 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }), ...files };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** Run the CLI FROM SOURCE against a fixture (the global `shrk` is stale). */
function runCli(root: string, argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  const r = spawnSync('bun', [CLI_MAIN, '--cwd', root, ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// ── lane A census cases (round 13 — assets) ───────────────────────────────

const PLAIN_CONFIG = "export default { projectName: 'fx' };\n";
const KNOWLEDGE_CONFIG = "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n";
const knowledgeFile = (ids: readonly string[]): string =>
  `export default [${ids
    .map((id) => `{ id: '${id}', title: '${id}', type: 'architecture', priority: 'high', tags: [], content: 'About ${id}.' }`)
    .join(', ')}];\n`;

/** A pack under the fixture's node_modules contributing ONE file to `slot`. */
function packFiles(slot: string, file: string, body: string): Record<string, string> {
  return {
    'node_modules/@fx/census-pack/package.json': JSON.stringify({ name: '@fx/census-pack', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    'node_modules/@fx/census-pack/manifest.json': JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@fx/census-pack', version: '0.0.1' },
      contributions: { [slot]: [`./${file}`] },
    }),
    [`node_modules/@fx/census-pack/${file}`]: body,
  };
}

/** A registration hint whose discovery is `discovery` (TS source). */
const hintFile = (discovery: string): string =>
  `export default [{ id: 'fx.hint', title: 'Hint', discovery: ${discovery}, operations: [{ kind: 'append', snippet: 'x' }] }];\n`;

interface IAssetDoctorJson {
  readonly accepted: readonly string[];
  readonly deadUnits: readonly string[];
  readonly units: { readonly intendedEmpty: readonly string[]; readonly wentLive: readonly string[] };
}

/**
 * The asset census, end to end through the real loader and the real doctor:
 * the planned unit reads intended-empty and its acceptance is printed (exit 0,
 * no dead unit); once the target exists it reads went-live — exit 0 (no ✓),
 * and `--fail-on-dead-units` fails a LOCAL stale marker (1), never a pack one.
 */
function assertAssetCensus(
  root: string,
  doctor: readonly string[],
  unit: string,
  createTarget: () => void,
  pack: boolean,
): void {
  const planned = runCli(root, [...doctor, '--json']);
  expect({ code: planned.code, stderr: planned.code === 0 ? '' : planned.err }).toEqual({ code: 0, stderr: '' });
  const before = JSON.parse(planned.out) as IAssetDoctorJson;
  expect(before.accepted.join('\n')).toContain('accepted by expectEmpty');
  expect(before.deadUnits).toEqual([]);
  expect(before.units.intendedEmpty.join('\n')).toContain(unit);
  if (pack) expect(before.units.intendedEmpty.join('\n')).toContain('[marker from pack @fx/census-pack]');
  createTarget();
  const live = runCli(root, [...doctor, '--json']);
  expect(live.code).toBe(0);
  const after = JSON.parse(live.out) as IAssetDoctorJson;
  expect(after.accepted).toEqual([]);
  expect(after.units.wentLive.join('\n')).toContain('expectEmpty is stale');
  expect(runCli(root, [...doctor, '--fail-on-dead-units']).code).toBe(pack ? 0 : 1);
  if (pack) expect(after.units.wentLive.join('\n')).toContain('reported as INFO, never fails');
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const REGISTRATION_TARGET_GLOBS_CENSUS: ICensusCase = {
  check: () => {
    const discovery = "{ targetGlobs: ['src/app/**/app.ts', { pattern: 'src/plugins/**/registry.ts', expectEmpty: true }] }";
    const local = censusFixture({
      'sharkcraft/sharkcraft.config.ts': PLAIN_CONFIG,
      'sharkcraft/registration-hints.ts': hintFile(discovery),
      'src/app/main/app.ts': 'export {};\n',
    });
    assertAssetCensus(local, ['registrations', 'doctor'], 'src/plugins/**/registry.ts', () => write(local, 'src/plugins/a/registry.ts', 'export {};\n'), false);
    // The same marker contributed by a pack: stamped, and a pack marker that went live is INFO.
    const packed = censusFixture({
      'sharkcraft/sharkcraft.config.ts': PLAIN_CONFIG,
      'src/app/main/app.ts': 'export {};\n',
      ...packFiles('registrationHintFiles', 'registration-hints.ts', hintFile(discovery)),
    });
    assertAssetCensus(packed, ['registrations', 'doctor'], 'src/plugins/**/registry.ts', () => write(packed, 'src/plugins/a/registry.ts', 'export {};\n'), true);
  },
};

const REGISTRATION_TARGET_FILE_CENSUS: ICensusCase = {
  check: () => {
    const root = censusFixture({
      'sharkcraft/sharkcraft.config.ts': PLAIN_CONFIG,
      'sharkcraft/registration-hints.ts': hintFile("{ targetFile: { pattern: 'src/app/routes.ts', expectEmpty: true, reason: 'routing lands with the app shell' } }"),
    });
    assertAssetCensus(root, ['registrations', 'doctor'], 'src/app/routes.ts', () => write(root, 'src/app/routes.ts', 'export {};\n'), false);
  },
};

const SCAFFOLD_MATCH_PATHS_CENSUS: ICensusCase = {
  check: () => {
    const root = censusFixture({
      'sharkcraft/sharkcraft.config.ts': PLAIN_CONFIG,
      'sharkcraft/scaffold-patterns.ts':
        "export default [{ id: 'fx.plugin', title: 'Plugin', description: 'A plugin', templateId: 'fx.none', matchPaths: [{ pattern: 'src/plugins/*/plugin.ts', expectEmpty: true }], variables: [], appliesWhen: ['infer-template'], confidence: 'high' }];\n",
    });
    // ONE planned fact is ONE acceptance — the derived pattern-level unit is not a second dead unit.
    const planned = JSON.parse(runCli(root, ['scaffolds', 'doctor', '--json']).out) as IAssetDoctorJson & { dead: number };
    expect({ dead: planned.dead, accepted: planned.accepted.length }).toEqual({ dead: 0, accepted: 1 });
    assertAssetCensus(root, ['scaffolds', 'doctor'], 'src/plugins/*/plugin.ts', () => write(root, 'src/plugins/a/plugin.ts', 'export {};\n'), false);
  },
};

const tuningCensus = (tuning: string): ICensusCase => ({
  check: () => {
    const root = censusFixture({
      'sharkcraft/sharkcraft.config.ts': KNOWLEDGE_CONFIG,
      'sharkcraft/knowledge.ts': knowledgeFile(['fx.other']),
      'sharkcraft/search-tuning.ts': `export default [${tuning}];\n`,
    });
    // The marked weight is kept — never clamped to 0.
    const listed = JSON.parse(runCli(root, ['search', 'tuning', 'list', '--json']).out) as { expectEmptyUnits?: unknown[] }[];
    expect(listed[0]?.expectEmptyUnits?.length).toBe(1);
    assertAssetCensus(root, ['search', 'tuning', 'doctor'], 'knowledge:fx.guide', () =>
      write(root, 'sharkcraft/knowledge.ts', knowledgeFile(['fx.other', 'fx.guide'])),
    false);
  },
});

// ── lane B census cases (round 13) ────────────────────────────────────────

const BOUNDARY_CENSUS_CONFIG = "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n";
/** The governed file every boundary case scans: it imports only `node:path` (a builtin). */
const BOUNDARY_CENSUS_APP = "import { join } from 'node:path';\nexport const a = join('a');\n";

interface IBoundaryCensusJson {
  readonly exitCode: number;
  readonly intendedEmpty: readonly { readonly unit: string; readonly selector: string }[];
  readonly wentLive: readonly { readonly unit: string; readonly selector: string; readonly state: string; readonly packageName?: string }[];
  readonly failingUnits: readonly unknown[];
  readonly gate: { readonly accepted: readonly string[] };
}

function boundaryCensusWrite(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/**
 * One boundary list through the REAL loader (`boundaryFiles`) and the real
 * reporter (`check boundaries --json`): the marked unit reads intended-empty
 * and is accepted; once its target is created it reads went-live.
 */
function boundaryCensus(rule: string, unit: string, selector: string, makeLive: (root: string) => void): ICensusCase {
  return {
    check: () => {
      const root = censusFixture({
        'src/app/a.ts': BOUNDARY_CENSUS_APP,
        'sharkcraft/sharkcraft.config.ts': BOUNDARY_CENSUS_CONFIG,
        'sharkcraft/boundaries.ts': `export default [${rule}];\n`,
      });
      const planned = runCli(root, ['check', 'boundaries', '--json']);
      const p = JSON.parse(planned.out) as IBoundaryCensusJson;
      expect({ code: planned.code, exitCode: p.exitCode }).toEqual({ code: 0, exitCode: 0 });
      expect(p.intendedEmpty.map((u) => [u.unit, u.selector])).toEqual([[unit, selector]]);
      expect(p.gate.accepted.join('\n')).toContain('accepted by expectEmpty');
      makeLive(root);
      const live = JSON.parse(runCli(root, ['check', 'boundaries', '--json']).out) as IBoundaryCensusJson;
      expect(live.wentLive.map((u) => [u.unit, u.selector, u.state])).toEqual([[unit, selector, 'went-live']]);
      expect(live.intendedEmpty).toEqual([]);
    },
  };
}

const BOUNDARY_FORBIDDEN_CENSUS: ICensusCase = {
  check: async () => {
    const rule = "{ id: 'census.forbidden', title: 'c', from: ['src/**'], forbiddenImports: ['node:fs', { pattern: '@census/planned', expectEmpty: true }] }";
    const plannedPackage = JSON.stringify({ name: '@census/planned', version: '0.0.0' });
    const local = boundaryCensus(rule, 'forbidden', '@census/planned', (root) =>
      boundaryCensusWrite(root, 'packages/planned/package.json', plannedPackage),
    );
    if ('check' in local) await local.check();
    // The pack-contributed marker: stamped with the pack, went-live INFO, never a failure.
    const PACK = '@r77/census-fence';
    const root = censusFixture({
      'src/app/a.ts': BOUNDARY_CENSUS_APP,
      'packages/planned/package.json': plannedPackage,
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
      [`node_modules/${PACK}/package.json`]: JSON.stringify({ name: PACK, version: '0.0.1', type: 'module', sharkcraft: { manifest: './manifest.json' } }),
      [`node_modules/${PACK}/manifest.json`]: JSON.stringify({
        schema: 'sharkcraft.pack/v1',
        info: { name: PACK, version: '0.0.1' },
        contributions: { boundaryFiles: ['./boundaries.ts'] },
      }),
      [`node_modules/${PACK}/boundaries.ts`]: `export default [${rule}];\n`,
    });
    const r = runCli(root, ['check', 'boundaries', '--fail-on-dead-units', '--json']);
    const j = JSON.parse(r.out) as IBoundaryCensusJson;
    expect({ code: r.code, exitCode: j.exitCode }).toEqual({ code: 0, exitCode: 0 });
    expect(j.wentLive.map((u) => [u.selector, u.packageName])).toEqual([['@census/planned', PACK]]);
    expect(j.failingUnits).toEqual([]);
  },
};

// ── lane G census cases (round 13 — gate planes) ──────────────────────────

interface IGateCensusJson {
  readonly gate: { readonly exit: number; readonly accepted: readonly string[] };
  readonly rules?: readonly {
    readonly id: string;
    readonly units?: { readonly intendedEmpty: readonly string[]; readonly wentLive: readonly string[] };
  }[];
}

/** A config with the given planes (TS source, no regex backslashes needed by any case). */
const gateConfig = (planes: string): string => `export default { projectName: 'fx', ${planes} };\n`;

/**
 * One gate-plane list through the REAL loader (the local `sharkcraft.config.ts`,
 * or a pack under node_modules) and the real reporters: the plane verb accepts
 * the planned unit (exit 0, `gate.accepted` names it) and `gates coverage`
 * reads it intended-empty on the rule's row; once the target exists it reads
 * went-live — the ✓ withheld, the exit unchanged — and `--fail-on-dead-units`
 * fails a LOCAL stale marker (1), never a pack one (INFO).
 */
function gateCensus(spec: {
  readonly files: Readonly<Record<string, string>>;
  readonly verb: readonly string[];
  readonly ruleId: string;
  readonly unit: string;
  readonly target: readonly [string, string];
  readonly pack?: boolean;
}): ICensusCase {
  return {
    check: () => {
      const root = censusFixture(spec.files);
      const planned = runCli(root, [...spec.verb, '--json']);
      expect({ code: planned.code, err: planned.code === 0 ? '' : `${planned.err}${planned.out.slice(0, 1500)}` }).toEqual({
        code: 0,
        err: '',
      });
      const accepted = (JSON.parse(planned.out) as IGateCensusJson).gate.accepted.join('\n');
      expect(accepted).toContain('accepted by expectEmpty');
      expect(accepted).toContain(spec.unit);
      const before = JSON.parse(runCli(root, ['gates', 'coverage', '--json']).out) as IGateCensusJson;
      expect(before.gate.exit).toBe(0);
      expect(before.rules?.find((r) => r.id === spec.ruleId)?.units?.intendedEmpty.join('\n') ?? '').toContain(spec.unit);
      write(root, spec.target[0], spec.target[1]);
      const after = JSON.parse(runCli(root, ['gates', 'coverage', '--json']).out) as IGateCensusJson;
      const wentLive = after.rules?.find((r) => r.id === spec.ruleId)?.units?.wentLive.join('\n') ?? '';
      expect(wentLive).toContain('expectEmpty is stale');
      expect(after.gate.exit).toBe(0);
      if (spec.pack) expect(wentLive).toContain('reported as INFO, never fails');
      expect(runCli(root, ['gates', 'coverage', '--fail-on-dead-units']).code).toBe(spec.pack ? 0 : 1);
    },
  };
}

const NOTHING = 'export const nothing = 1;\n';
const WIRING_REGISTRY = { 'src/core/a.ts': 'export const A_PLUGIN = 1;\n', 'src/registry.ts': "export const REGISTERED = ['A'];\n" };
const REGISTRATION_SOURCES = { 'src/tokens.ts': 'export const T1 = token;\n', 'src/app.ts': 'provide(T1);\ninject(T1);\n' };
const registrationIdiom = (declared: string, provided: string, consumed: string): string =>
  gateConfig(
    `registrationGraph: [{ name: 'g.idiom', declared: { files: ${declared}, pattern: 'export const ([A-Z0-9]+) = token' }, ` +
      `provided: { files: ${provided}, pattern: 'provide[(]([A-Z0-9]+)[)]' }, consumed: { files: ${consumed}, pattern: 'inject[(]([A-Z0-9]+)[)]' } }]`,
  );
const EXPORTED_A = { 'appA/a.ts': 'export const a = 1;\n', 'baselines/g.json': `${JSON.stringify(['a'], null, 2)}\n` };
const POLICY_RULE = (id: string): string =>
  `{ id: '${id}', surface: 'ts', pattern: 'react', message: 'no react', files: ['src/core/**/*.ts', { pattern: 'src/ui/**/*.ts', expectEmpty: true }] }`;

const G_CENSUS: Readonly<Partial<Record<MarkableUnitList, ICensusCase>>> = {
  [MarkableUnitList.WiringDeclaredFiles]: gateCensus({
    files: {
      ...WIRING_REGISTRY,
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "wiringRules: [{ id: 'g.wiring', declared: { files: ['src/core/*.ts', { pattern: 'src/plugins/*.ts', expectEmpty: true }], pattern: 'export const ([A-Z]+)_PLUGIN' }, registered: { files: ['src/registry.ts'], arrayProperty: 'REGISTERED' } }]",
      ),
    },
    verb: ['check', 'wiring'],
    ruleId: 'g.wiring',
    unit: 'src/plugins/*.ts',
    target: ['src/plugins/b.ts', NOTHING],
  }),
  [MarkableUnitList.WiringRegisteredFiles]: gateCensus({
    files: {
      ...WIRING_REGISTRY,
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "wiringRules: [{ id: 'g.wiring', declared: { files: ['src/core/*.ts'], pattern: 'export const ([A-Z]+)_PLUGIN' }, registered: { files: ['src/registry.ts', { pattern: 'src/extra/*.ts', expectEmpty: true }], arrayProperty: 'REGISTERED' } }]",
      ),
    },
    verb: ['check', 'wiring'],
    ruleId: 'g.wiring',
    unit: 'src/extra/*.ts',
    target: ['src/extra/x.ts', NOTHING],
  }),
  [MarkableUnitList.WiringChainFiles]: gateCensus({
    files: {
      'src/a.ts': 'export const X_T = 1;\n',
      'src/b.ts': 'export const X_T = 2;\n',
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "wiringRules: [{ id: 'g.chain', chain: [{ files: ['src/a.ts'], pattern: 'export const ([A-Z]+)_T' }, { files: ['src/b.ts', { pattern: 'src/c/*.ts', expectEmpty: true }], pattern: 'export const ([A-Z]+)_T' }] }]",
      ),
    },
    verb: ['check', 'wiring'],
    ruleId: 'g.chain',
    unit: 'src/c/*.ts',
    target: ['src/c/d.ts', NOTHING],
  }),
  [MarkableUnitList.RegistrySourceFiles]: gateCensus({
    files: {
      'src/cmds/a.ts': "export const c = { name: 'alpha' };\n",
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "registries: [{ name: 'g.reg', source: { files: ['src/cmds/a.ts', { pattern: 'src/more/*.ts', expectEmpty: true }], pattern: \"name: '([a-z]+)'\" } }]",
      ),
    },
    verb: ['gates', 'check'],
    ruleId: 'g.reg',
    unit: 'src/more/*.ts',
    target: ['src/more/b.ts', NOTHING],
  }),
  [MarkableUnitList.RegistryConsumerFiles]: gateCensus({
    files: {
      'src/cmds/a.ts': "export const c = { name: 'alpha' };\n",
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "registries: [{ name: 'g.reg', source: { files: ['src/cmds/a.ts'], pattern: \"name: '([a-z]+)'\" }, consumer: { files: [{ pattern: 'src/use/*.ts', expectEmpty: true }], pattern: 'uses ([a-z]+)' } }]",
      ),
    },
    verb: ['gates', 'check'],
    ruleId: 'g.reg',
    unit: 'src/use/*.ts',
    target: ['src/use/x.ts', '// uses alpha\n'],
  }),
  [MarkableUnitList.RegistrationDeclaredFiles]: gateCensus({
    files: {
      ...REGISTRATION_SOURCES,
      'sharkcraft/sharkcraft.config.ts': registrationIdiom(
        "['src/tokens.ts', { pattern: 'src/more-tokens/*.ts', expectEmpty: true }]",
        "['src/app.ts']",
        "['src/app.ts']",
      ),
    },
    verb: ['gates', 'check'],
    ruleId: 'g.idiom',
    unit: 'src/more-tokens/*.ts',
    target: ['src/more-tokens/x.ts', NOTHING],
  }),
  [MarkableUnitList.RegistrationProvidedFiles]: gateCensus({
    files: {
      ...REGISTRATION_SOURCES,
      'sharkcraft/sharkcraft.config.ts': registrationIdiom(
        "['src/tokens.ts']",
        "['src/app.ts', { pattern: 'src/providers/*.ts', expectEmpty: true }]",
        "['src/app.ts']",
      ),
    },
    verb: ['gates', 'check'],
    ruleId: 'g.idiom',
    unit: 'src/providers/*.ts',
    target: ['src/providers/p.ts', NOTHING],
  }),
  [MarkableUnitList.RegistrationConsumedFiles]: gateCensus({
    files: {
      ...REGISTRATION_SOURCES,
      'sharkcraft/sharkcraft.config.ts': registrationIdiom(
        "['src/tokens.ts']",
        "['src/app.ts']",
        "['src/app.ts', { pattern: 'src/features/*.ts', expectEmpty: true }]",
      ),
    },
    verb: ['gates', 'check'],
    ruleId: 'g.idiom',
    unit: 'src/features/*.ts',
    target: ['src/features/f.ts', NOTHING],
  }),
  [MarkableUnitList.BaselineComputeSourceFiles]: gateCensus({
    files: {
      ...EXPORTED_A,
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "baselines: [{ id: 'g.base', baseline: 'baselines/g.json', compute: { kind: 'extractor', source: { files: ['appA/*.ts', { pattern: 'appB/*.ts', expectEmpty: true }], extract: 'export-names' } } }]",
      ),
    },
    verb: ['baseline', 'check'],
    ruleId: 'g.base',
    unit: 'appB/*.ts',
    target: ['appB/b.ts', 'const b = 2;\n'],
  }),
  [MarkableUnitList.BaselineWatchFiles]: gateCensus({
    files: {
      ...EXPORTED_A,
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "baselines: [{ id: 'g.base', baseline: 'baselines/g.json', watchFiles: ['appA/*.ts', { pattern: 'appW/*.ts', expectEmpty: true }], compute: { kind: 'extractor', source: { files: ['appA/*.ts'], extract: 'export-names' } } }]",
      ),
    },
    verb: ['baseline', 'check'],
    ruleId: 'g.base',
    unit: 'appW/*.ts',
    target: ['appW/w.ts', 'const w = 1;\n'],
  }),
  [MarkableUnitList.ExtractorFiles]: gateCensus({
    files: {
      'src/h/a.ts': 'export const A_H = 1;\n',
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "extractors: { handlers: { files: ['src/h/*.ts', { pattern: 'src/h2/*.ts', expectEmpty: true }], pattern: 'export const ([A-Z]+)_H' } }, registries: [{ name: 'g.ext', source: { $use: 'handlers' } }]",
      ),
    },
    verb: ['gates', 'check'],
    ruleId: 'g.ext',
    unit: 'src/h2/*.ts',
    target: ['src/h2/x.ts', NOTHING],
  }),
  [MarkableUnitList.ImportEdgesToFiles]: gateCensus({
    files: {
      'appA/a.ts': 'export const a = 1;\n',
      'appB/b.ts': 'export const b = 2;\n',
      'baselines/fence.json': '[]\n',
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "baselines: [{ id: 'g.fence', baseline: 'baselines/fence.json', direction: 'additions-only', expectEmpty: true, compute: { kind: 'extractor', source: { files: ['appA/*.ts'], extract: 'import-edges', to: { files: ['appB/**', { pattern: 'appC/**', expectEmpty: true }] } } } }]",
      ),
    },
    verb: ['baseline', 'check'],
    ruleId: 'g.fence',
    unit: 'appC/**',
    target: ['appC/c.ts', NOTHING],
  }),
  [MarkableUnitList.PolicyFiles]: {
    check: async () => {
      const local = gateCensus({
        files: { 'src/core/a.ts': NOTHING, 'sharkcraft/sharkcraft.config.ts': gateConfig(`policyRules: [${POLICY_RULE('g.policy')}]`) },
        verb: ['policy-lint'],
        ruleId: 'g.policy',
        unit: 'src/ui/**/*.ts',
        target: ['src/ui/b.ts', NOTHING],
      });
      if ('check' in local) await local.check();
      // The same marker contributed by a pack: stamped with the pack at the
      // merge seam, and a pack marker that went live is INFO, never a failure.
      const packed = gateCensus({
        files: {
          'src/core/a.ts': NOTHING,
          'sharkcraft/sharkcraft.config.ts': PLAIN_CONFIG,
          ...packFiles('policyRuleFiles', 'policy.ts', `export default [${POLICY_RULE('g.pack-policy')}];\n`),
        },
        verb: ['policy-lint'],
        ruleId: 'g.pack-policy',
        unit: 'src/ui/**/*.ts',
        target: ['src/ui/b.ts', NOTHING],
        pack: true,
      });
      if ('check' in packed) await packed.check();
    },
  },
  [MarkableUnitList.GeneratedGlob]: gateCensus({
    files: {
      'src/gen/a.ts': '// GENERATED\nexport const a = 1;\n',
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "generatedArtifacts: [{ id: 'g.gen', generatedGlob: ['src/gen/**', { pattern: 'src/gen2/**', expectEmpty: true }], provenanceHeader: { mustMatch: 'GENERATED' } }]",
      ),
    },
    verb: ['generated', 'check'],
    ruleId: 'g.gen',
    unit: 'src/gen2/**',
    target: ['src/gen2/b.ts', '// GENERATED\nexport const b = 1;\n'],
  }),
  [MarkableUnitList.DocReferenceFiles]: gateCensus({
    files: {
      'docs/guide.md': 'Run `shrk doctor` first.\n',
      'sharkcraft/sharkcraft.config.ts': gateConfig(
        "docReferences: [{ id: 'g.docs', files: ['docs/guide.md', { pattern: 'docs/adr/**/*.md', expectEmpty: true }], tokenPattern: 'shrk [a-z]+', resolvesAs: ['command'] }]",
      ),
    },
    verb: ['docs', 'references', 'check'],
    ruleId: 'g.docs',
    unit: 'docs/adr/**/*.md',
    target: ['docs/adr/0001.md', 'Run `shrk doctor`.\n'],
  }),
};

/** Lane G's census case for `list` — declared in {@link G_CENSUS} (a missing one fails, never passes). */
function gCensus(list: MarkableUnitList): ICensusCase {
  return G_CENSUS[list] ?? { todo: 'G' };
}

/**
 * THE census: one case per markable list, exhaustive by type. Each lane
 * replaces its `{ todo }` cases with `{ check }`: declare ONE marked unit through
 * the real loader (a `censusFixture`, a pack under the fixture's node_modules
 * where the list is pack-contributable), run the real reporter (`runCli`, or the
 * real engine entry), assert the unit reads intended-empty AND the acceptance is
 * printed ('accepted by expectEmpty' / `gate.accepted`); then create the target
 * and assert it reads went-live.
 */
const CENSUS: Readonly<Record<MarkableUnitList, ICensusCase>> = {
  [MarkableUnitList.BoundaryFrom]: boundaryCensus(
    "{ id: 'census.from', title: 'c', from: ['src/app/**', { pattern: 'src/plugin/**', expectEmpty: true }], forbiddenImports: ['node:fs'] }",
    'from',
    'src/plugin/**',
    (root) => boundaryCensusWrite(root, 'src/plugin/p.ts', 'export const p = 1;\n'),
  ),
  [MarkableUnitList.BoundaryFromNegation]: boundaryCensus(
    "{ id: 'census.negation', title: 'c', from: ['src/**', { pattern: '!src/**/*.gen.ts', expectEmpty: true }], forbiddenImports: ['node:fs'] }",
    'exemptFiles',
    '!src/**/*.gen.ts',
    (root) => boundaryCensusWrite(root, 'src/app/x.gen.ts', 'export const g = 1;\n'),
  ),
  [MarkableUnitList.BoundaryExemptFiles]: boundaryCensus(
    "{ id: 'census.exempt', title: 'c', from: ['src/**'], exemptFiles: [{ pattern: 'src/generated/**', expectEmpty: true }], forbiddenImports: ['node:fs'] }",
    'exemptFiles',
    'src/generated/**',
    (root) => boundaryCensusWrite(root, 'src/generated/g.ts', 'export const g = 1;\n'),
  ),
  [MarkableUnitList.BoundaryForbiddenImports]: BOUNDARY_FORBIDDEN_CENSUS,
  [MarkableUnitList.BoundaryAllowedImports]: boundaryCensus(
    "{ id: 'census.allowed', title: 'c', from: ['src/**'], allowedImports: ['node:path', { pattern: '@census/future-sdk', expectEmpty: true }] }",
    'allowed',
    '@census/future-sdk',
    (root) => boundaryCensusWrite(root, 'packages/future-sdk/package.json', JSON.stringify({ name: '@census/future-sdk', version: '0.0.0' })),
  ),
  [MarkableUnitList.WiringDeclaredFiles]: gCensus(MarkableUnitList.WiringDeclaredFiles),
  [MarkableUnitList.WiringRegisteredFiles]: gCensus(MarkableUnitList.WiringRegisteredFiles),
  [MarkableUnitList.WiringChainFiles]: gCensus(MarkableUnitList.WiringChainFiles),
  [MarkableUnitList.RegistrySourceFiles]: gCensus(MarkableUnitList.RegistrySourceFiles),
  [MarkableUnitList.RegistryConsumerFiles]: gCensus(MarkableUnitList.RegistryConsumerFiles),
  [MarkableUnitList.RegistrationDeclaredFiles]: gCensus(MarkableUnitList.RegistrationDeclaredFiles),
  [MarkableUnitList.RegistrationProvidedFiles]: gCensus(MarkableUnitList.RegistrationProvidedFiles),
  [MarkableUnitList.RegistrationConsumedFiles]: gCensus(MarkableUnitList.RegistrationConsumedFiles),
  [MarkableUnitList.BaselineComputeSourceFiles]: gCensus(MarkableUnitList.BaselineComputeSourceFiles),
  [MarkableUnitList.BaselineWatchFiles]: gCensus(MarkableUnitList.BaselineWatchFiles),
  [MarkableUnitList.ExtractorFiles]: gCensus(MarkableUnitList.ExtractorFiles),
  [MarkableUnitList.ImportEdgesToFiles]: gCensus(MarkableUnitList.ImportEdgesToFiles),
  [MarkableUnitList.PolicyFiles]: gCensus(MarkableUnitList.PolicyFiles),
  [MarkableUnitList.GeneratedGlob]: gCensus(MarkableUnitList.GeneratedGlob),
  [MarkableUnitList.DocReferenceFiles]: gCensus(MarkableUnitList.DocReferenceFiles),
  [MarkableUnitList.RegistrationHintTargetGlobs]: REGISTRATION_TARGET_GLOBS_CENSUS,
  [MarkableUnitList.RegistrationHintTargetFile]: REGISTRATION_TARGET_FILE_CENSUS,
  [MarkableUnitList.ScaffoldPatternMatchPaths]: SCAFFOLD_MATCH_PATHS_CENSUS,
  [MarkableUnitList.SearchTuningBoostIds]: tuningCensus(
    "{ id: 'fx.t', boostIds: { 'knowledge:fx.guide': { weight: 3, expectEmpty: true, reason: 'the guide ships next sprint' } } }",
  ),
  [MarkableUnitList.SearchTuningTaskHintBoostIds]: tuningCensus(
    "{ id: 'fx.t', taskHints: [{ whenTokens: ['guide'], boostIds: { 'knowledge:fx.guide': { weight: 2, expectEmpty: true } } }] }",
  ),
};

function enumKeyOf(list: MarkableUnitList): string {
  return Object.entries(MarkableUnitList).find(([, v]) => v === list)?.[0] ?? list;
}

function censusTodo(list: MarkableUnitList, lane: Lane): string {
  const spec = MARKABLE_UNIT_LISTS[list];
  const marker =
    spec.form === UnitEntryForm.WeightMap
      ? `a key whose value is { weight, expectEmpty: true }`
      : spec.form === UnitEntryForm.Scalar
        ? `{ pattern, expectEmpty: true } as the value`
        : `one { pattern, expectEmpty: true } entry`;
  return (
    `lane ${lane}: MarkableUnitList.${enumKeyOf(list)} (${spec.container} → ${spec.listPath}, ${spec.weight} weight) has no census case yet. ` +
    `Replace { todo: '${lane}' } in packages/cli/src/__tests__/r77-one-liveness-authority.test.ts CENSUS with { check }: declare ${marker} in ${spec.listPath} ` +
    `through the real loader (censusFixture + runCli, or a pack under node_modules), run the real reporter, assert the unit reads intended-empty AND the ` +
    `'accepted by expectEmpty' acceptance; then create the target and assert it reads went-live (${spec.wentLive}).`
  );
}

describe('(d) census — every markable list through the real loader and the real reporter', () => {
  for (const list of Object.values(MarkableUnitList)) {
    test(
      `census: ${list}`,
      async () => {
        const c = CENSUS[list];
        if ('todo' in c) throw new Error(censusTodo(list, c.todo));
        await c.check();
      },
      60_000,
    );
  }
});

// ── structure (green from the keystone on) ────────────────────────────────

describe('structure', () => {
  test('MARKABLE_UNIT_LISTS and CENSUS cover exactly the MarkableUnitList values', () => {
    const values = [...Object.values(MarkableUnitList)].sort();
    expect(Object.keys(MARKABLE_UNIT_LISTS).sort()).toEqual(values);
    expect(Object.keys(CENSUS).sort()).toEqual(values);
  });

  test('every census todo names the lane that owns the list', () => {
    const wrong = Object.values(MarkableUnitList).flatMap((list) => {
      const c = CENSUS[list];
      const owner = LANE_OF_OWNER[MARKABLE_UNIT_LISTS[list].owner];
      return 'todo' in c && c.todo !== owner ? [`${list}: todo names lane ${c.todo}, the spec's owner is lane ${owner}`] : [];
    });
    expect(wrong).toEqual([]);
  });

  test('every ledger row names the lane that owns its file', () => {
    const wrong: string[] = [];
    for (const [rel, row] of [...Object.entries(DEAD_UNIT_REPORTERS), ...Object.entries(RULE_EMPTINESS_SITES)]) {
      const lane = laneOfPath(rel);
      if (lane !== `lane ${row.lane}`) wrong.push(`${rel}: row says lane ${row.lane}, the path belongs to ${lane}`);
    }
    expect(wrong).toEqual([]);
  });

  test('one did-you-mean scorer: inspector re-exports core\'s levenshtein and nearestIds — the same functions', () => {
    expect(levenshtein).toBe(coreLevenshtein);
    expect(nearestIds).toBe(coreNearestIds);
  });

  test('the census harness: censusFixture writes a real workspace and runCli runs the CLI from source against it', () => {
    const root = censusFixture({ 'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n" });
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    const r = runCli(root, ['--version']);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(r.out.trim()).toMatch(/\d+\.\d+\.\d+/);
  }, 60_000);
});
