import {
  coverageShortfall,
  resolveSourceGlobs,
  ruleVerdictRecords,
  type IRegistrationIdiom,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import { describeUnread, readScopeCoverage, unreadMatching } from '../util/read-scope-coverage.ts';
import type { IUnreadFile } from '../util/unread-file.ts';
import type { IIdiomRoleCoverage } from './i-idiom-role-coverage.ts';
import type { IRegistrationQueryVerdict } from './i-registration-query-verdict.ts';
import {
  registrationOrphans,
  registrationUnprovided,
  type IOrphanRegistration,
  type IRegistrationGraph,
  type IUnprovidedToken,
} from './registration-graph.ts';

/** At most this many demoted tokens ride on one coverage record. */
const TOKEN_LABEL_CAP = 20;

/**
 * THE registration graph's read-scope record: the idiom files the reader could
 * not read, named (`examined 3 of 4 files, 1 over the 1MB read cap: …`), or
 * `undefined` when it read every file its idioms matched. `wiring unprovided |
 * orphans`, finish's unprovided sub-gate and MCP `get_wiring_graph` all read
 * it here, so the verb and its siblings cannot disagree about what was read.
 */
export function registrationGraphCoverage(graph: IRegistrationGraph): IVerdictCoverage | undefined {
  if (!graph.readScope || graph.readScope.unread.length === 0) return undefined;
  return {
    ...readScopeCoverage(
      { unit: 'registration idioms', expected: graph.idioms.length, examined: graph.idioms.length },
      graph.readScope,
    ),
    subject: 'registration graph',
  };
}

/**
 * Every idiom's role records, as an absence query settles them (round 13, P4):
 * the role authority's coverage (`examined 2 of 3 roles … declared (0 files)`)
 * plus its expectEmpty acceptance, folded by core's `ruleVerdictRecords` and
 * subject-prefixed with the idiom. A role record that is only the idiom's read
 * gap is dropped while the graph's own read-scope record is carried — that
 * record already names every unread idiom file (a union over idioms); its
 * acceptance is kept, so a record B is never dropped silently.
 */
function roleRecords(graph: IRegistrationGraph, roles: readonly IIdiomRoleCoverage[]): IVerdictCoverage[] {
  const graphNamesUnread = registrationGraphCoverage(graph) !== undefined;
  return roles.flatMap((r) => {
    const records =
      graphNamesUnread && r.readGap
        ? r.unitAcceptance
          ? [r.unitAcceptance]
          : []
        : ruleVerdictRecords(r.coverage, r.unitAcceptance);
    return records.map((c) => ({ ...c, subject: c.subject ?? r.idiom }));
  });
}

/**
 * THE rule for an absence claim over an incomplete read. The graph merges
 * tokens across idioms, so a site of the missing role in ANY idiom satisfies a
 * token. When an unread file matches any idiom's `missingRole` globs, every
 * candidate could be refuted there: all are demoted to `unproven`, named in a
 * second coverage record. Otherwise the candidates are findings.
 *
 * Round 13 (P4): every idiom's ROLE coverage is carried too, always — the
 * graph's read scope said nothing about a role whose globs matched no file, so
 * "every declared token has a provider" printed a ✓ over a declared role that
 * examined nothing. A dead role never demotes a candidate (a finding stays a
 * finding, as on `gates check`); it keeps a clean answer from being a pass.
 */
function absenceVerdict<T extends { readonly token: string }>(
  graph: IRegistrationGraph,
  idioms: readonly IRegistrationIdiom[],
  roles: readonly IIdiomRoleCoverage[],
  missingRole: 'provided' | 'consumed',
  candidates: readonly T[],
  unit: string,
  subject: string,
): IRegistrationQueryVerdict<T> {
  const unread = graph.readScope?.unread ?? [];
  // Per idiom's role LIST, never a flattened union: a negation subtracts from
  // its own list only, so one idiom's `!x` cannot hide a refuting file from
  // another idiom that reads it. Deduped by path, sorted.
  const refutingByPath = new Map<string, IUnreadFile>();
  for (const i of unread.length > 0 ? idioms : []) {
    for (const u of unreadMatching(unread, resolveSourceGlobs(i[missingRole]))) {
      if (!refutingByPath.has(u.path)) refutingByPath.set(u.path, u);
    }
  }
  const refuting = [...refutingByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const unproven = refuting.length > 0 ? candidates : [];
  const fileRecord = registrationGraphCoverage(graph);
  const coverage: IVerdictCoverage[] = [
    ...(fileRecord ? [fileRecord] : []),
    ...roleRecords(graph, roles),
    ...(unproven.length > 0
      ? [
          {
            unit,
            expected: unproven.length,
            examined: 0,
            unexamined: unproven.slice(0, TOKEN_LABEL_CAP).map((t) => t.token),
            unexaminedTotal: unproven.length,
            reason: `may be ${missingRole} in a file the reader did not read — ${describeUnread(refuting)}`,
            subject,
          },
        ]
      : []),
  ];
  return {
    findings: refuting.length > 0 ? [] : candidates,
    unproven,
    coverage,
    shortfalls: coverage.flatMap((c) => {
      const s = coverageShortfall(c);
      return s === undefined ? [] : [s];
    }),
    unread,
  };
}

/**
 * `wiring unprovided` settled against what the graph read AND what every
 * idiom's roles examined (`roles`: `measureIdiomRoleCoverage`, THE role
 * authority — required, so no surface can forget the fold). `extra` adds
 * candidates found another way (finish's base-ref provider regressions); they
 * are merged by token and sorted, as finish always did.
 */
export function registrationUnprovidedVerdict(
  graph: IRegistrationGraph,
  idioms: readonly IRegistrationIdiom[],
  roles: readonly IIdiomRoleCoverage[],
  changedFiles?: readonly string[],
  extra?: readonly IUnprovidedToken[],
): IRegistrationQueryVerdict<IUnprovidedToken> {
  let candidates = registrationUnprovided(graph, changedFiles);
  if (extra !== undefined) {
    const byToken = new Map<string, IUnprovidedToken>();
    for (const u of [...candidates, ...extra]) if (!byToken.has(u.token)) byToken.set(u.token, u);
    candidates = [...byToken.values()].sort((a, b) => a.token.localeCompare(b.token));
  }
  return absenceVerdict(graph, idioms, roles, 'provided', candidates, 'unprovided tokens', 'unprovided');
}

/** `wiring orphans` settled against what the graph read and what every idiom's roles examined. */
export function registrationOrphansVerdict(
  graph: IRegistrationGraph,
  idioms: readonly IRegistrationIdiom[],
  roles: readonly IIdiomRoleCoverage[],
  changedFiles?: readonly string[],
): IRegistrationQueryVerdict<IOrphanRegistration> {
  return absenceVerdict(
    graph,
    idioms,
    roles,
    'consumed',
    registrationOrphans(graph, changedFiles),
    'orphan registrations',
    'orphans',
  );
}
