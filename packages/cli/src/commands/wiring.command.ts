import {
  buildRegistrationGraph,
  explainWiring,
  measureIdiomRoleCoverage,
  planeScanExcludeDirs,
  registrationChain,
  registrationGraphSignature,
  registrationOrphansVerdict,
  registrationUnprovidedVerdict,
  type IRegistrationGraph,
  type IRegistrationSite,
  type IWiringExplain,
} from '@shrkcrft/boundaries';
import {
  formatCoverage,
  formatEmptyRuleAdvice,
  ruleVerdictRecords,
  type IRegistrationIdiom,
  type IWiringRule,
} from '@shrkcrft/core';
import { refExists, resolveChangedFiles, resolveProjectConfig, type IChangedScopeOptions } from '@shrkcrft/inspector';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { buildGateEnvelope, type IGateEnvelope } from '../gates/gate-envelope.ts';
import { scanNote } from '../gates/gate-rule-view.ts';
import { planeVerdictForExit } from '../gates/plane-verdict.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { settleRegistrationGraph } from '../gates/registration-graph-verdict.ts';
import type { ISettledVerdict } from '../gates/settled-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { unitStateNotes } from '../gates/unit-state-notes.ts';

const SITE_DISPLAY_CAP = 50;

/**
 * The explained rule's verdict, SETTLED — through the same `settleVerdict` the
 * gate envelope uses, over the engine's own coverage for the rule. An `errors`
 * verdict proposes 1; anything else proposes 0 and the coverage vetoes it to 2
 * on a shortfall. `check wiring --explain` returns this exit (it runs under a
 * verdict verb, so its `$?` and trailer must not read 0 over a partial rule);
 * the renderer prints its final line from it.
 */
export function settleWiringExplain(report: IWiringExplain): ISettledVerdict {
  // The rule's `expectEmpty` acceptance joins its coverage through THE fold
  // (`ruleVerdictRecords`), as `check wiring`'s envelope folds it (round 13):
  // printed at exit 0, never silent; one record when they are the same claim.
  return settleVerdict(
    report.verdict === 'errors' ? ExitCode.Failure : ExitCode.VerifiedPass,
    ruleVerdictRecords(report.coverage, report.unitAcceptance),
  );
}

/**
 * Render an {@link IWiringExplain} to stdout. Shared by `wiring explain`,
 * `wiring test`, `gates explain` and `check wiring --explain` so all four speak
 * the same dialect. JSON emits the full payload; text mirrors `search tuning
 * explain` (header → loaded sets → per-site detail → the set-difference →
 * verdict). The status, coverage and final line come from the settled rule
 * (see {@link settleWiringExplain}), so explain can never read clean over a
 * rule `gates check` reports partial.
 * Always returns 0 — explain is informational; a verdict verb that wants the
 * rule's exit reads {@link settleWiringExplain}.
 */
export function renderWiringExplain(report: IWiringExplain, wantJson: boolean): number {
  if (wantJson) {
    process.stdout.write(asJson(report) + '\n');
    return 0;
  }

  process.stdout.write(header(`Wiring explain: ${report.ruleId} (${report.mode})`));
  if (report.description) process.stdout.write(`  ${report.description}\n`);
  if (report.groupBy) process.stdout.write(kv('groupBy', report.groupBy) + '\n');
  if (report.registeredMode === 'intersection') {
    process.stdout.write(kv('registeredMode', 'intersection (must be in EVERY sink)') + '\n');
  }
  process.stdout.write(kv('status', report.status) + '\n');
  process.stdout.write(kv('coverage', formatCoverage(report.coverage)) + '\n');
  process.stdout.write(
    kv(
      'declared',
      `${report.declared.distinctCount} distinct across ${report.declared.filesScanned} file(s)` +
        (report.declared.viaExtractor ? `  (via $use:${report.declared.viaExtractor})` : '') +
        scanNote(report.declared.scan, report.declared.blankedChars),
    ) + '\n',
  );
  process.stdout.write(
    kv(
      'registered',
      `${report.registered.distinctCount} distinct across ${report.registered.filesScanned} file(s)` +
        (report.registered.viaExtractor ? `  (via $use:${report.registered.viaExtractor})` : '') +
        scanNote(report.registered.scan, report.registered.blankedChars),
    ) + '\n',
  );

  if (report.declared.error) process.stdout.write(`  ! declared side: ${report.declared.error}\n`);
  if (report.registered.error) {
    process.stdout.write(`  ! registered side: ${report.registered.error}\n`);
  }

  writeSites('Declared sites', report.declared.sites);
  writeSites('Registered sites', report.registered.sites);

  if (report.declaredNotRegistered.length > 0) {
    process.stdout.write(
      `\nDeclared but NOT registered (${report.declaredNotRegistered.length}):\n`,
    );
    for (const s of report.declaredNotRegistered.slice(0, SITE_DISPLAY_CAP)) {
      process.stdout.write(`  ✗ ${s.token}  (${s.file}:${s.line})\n`);
    }
    if (report.declaredNotRegistered.length > SITE_DISPLAY_CAP) {
      process.stdout.write(`  … (${report.declaredNotRegistered.length - SITE_DISPLAY_CAP} more)\n`);
    }
  }
  if (report.registeredNotDeclared.length > 0) {
    // One set, two meanings: a parity rule FAILS on each token; a subset rule
    // never examined them, so they are a coverage shortfall (`partial`, exit 2)
    // unless `registeredExtras` accepts them.
    const parity = report.mode === 'parity';
    process.stdout.write(
      parity
        ? `\nRegistered but NOT declared (parity, ${report.registeredNotDeclared.length}):\n`
        : `\nRegistered with NO declared site (subset — never examined by this rule, ${report.registeredNotDeclared.length}):\n`,
    );
    for (const s of report.registeredNotDeclared.slice(0, SITE_DISPLAY_CAP)) {
      process.stdout.write(`  ${parity ? '✗' : '?'} ${s.token}  (${s.file}:${s.line})\n`);
    }
    if (report.registeredNotDeclared.length > SITE_DISPLAY_CAP) {
      process.stdout.write(`  … (${report.registeredNotDeclared.length - SITE_DISPLAY_CAP} more)\n`);
    }
    if (!parity) {
      process.stdout.write(
        '  → the declared selector may be incomplete. List known extras in `registeredExtras`,\n' +
          "    or set `mode: 'parity'` if the two sets should be equal.\n",
      );
    }
  }

  if (report.overlap.length > 0) {
    process.stdout.write(`\nPresent on BOTH sides (disjoint, ${report.overlap.length}):\n`);
    for (const s of report.overlap.slice(0, SITE_DISPLAY_CAP)) {
      process.stdout.write(`  ✗ ${s.token}  (${s.file}:${s.line})\n`);
    }
    if (report.overlap.length > SITE_DISPLAY_CAP) {
      process.stdout.write(`  … (${report.overlap.length - SITE_DISPLAY_CAP} more)\n`);
    }
  }
  if (report.hops && report.hops.length > 0) {
    process.stdout.write('\nChain hops:\n');
    for (const h of report.hops) {
      process.stdout.write(
        `  hop ${h.index}: ${h.fromCount} → ${h.toCount}` +
          `${h.missing > 0 ? `  ✗ ${h.missing} missing` : '  ✓'}\n`,
      );
    }
  }
  // A rule that checked NOTHING must never read like a clean pass.
  if (report.skipReason) {
    process.stdout.write(
      `\n! SKIPPED — ${report.skipReason}. A rule that matches nothing is a bug in the rule,\n` +
        `  not a pass. ${formatEmptyRuleAdvice({ fails: report.verdict === 'errors' })}.\n`,
    );
  }

  for (const d of report.diagnostics) process.stdout.write(`  ! ${d}\n`);
  // THE shared unit-state block (round 13 review): a LOCAL expectEmpty marker
  // whose target appeared, a dead glob of a rule that still matched and a pack
  // marker (INFO) — `check wiring --explain`, `wiring explain` and `gates
  // explain` said `Verdict: pass` over a went-live marker with no line for it.
  process.stdout.write(
    unitStateNotes(
      [
        {
          id: report.ruleId,
          ...(report.unitLiveness !== undefined ? { unitLiveness: report.unitLiveness } : {}),
          reportedEmpty: report.skipReason !== undefined,
        },
      ],
      // An explain view names every unit state — the intended-empty ones too
      // (round 13, K6), as the registry / registration explain views do.
      { intendedEmpty: true },
    ).text,
  );
  process.stdout.write(`\nVerdict: ${report.verdict}\n`);
  // The shortfall (or the acceptance that waived it) comes from the SETTLED
  // rule: `NOT VERIFIED: …` under a not-verified verdict, `(also not verified:
  // …)` under errors, `accepted by …` under a clean one — never silent.
  const settled = settleWiringExplain(report);
  const line = verdictLine(settled, '');
  if (line) process.stdout.write(`${line}\n`);
  return 0;
}

function writeSites(label: string, sites: IWiringExplain['declared']['sites']): void {
  process.stdout.write(`\n${label} (${sites.length}):\n`);
  if (sites.length === 0) {
    process.stdout.write('  (none extracted)\n');
    return;
  }
  for (const s of sites.slice(0, SITE_DISPLAY_CAP)) {
    process.stdout.write(`  • ${s.token}  (${s.file}:${s.line})\n`);
  }
  if (sites.length > SITE_DISPLAY_CAP) {
    process.stdout.write(`  … (${sites.length - SITE_DISPLAY_CAP} more)\n`);
  }
}

/** Light structural check: a candidate must at least name an id + both sides. */
function validateCandidate(raw: unknown): { rule?: IWiringRule; error?: string } {
  if (raw === null || typeof raw !== 'object') {
    return { error: 'candidate must be a JSON object describing a wiring rule' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || r['id'].length === 0) {
    return { error: 'candidate is missing a non-empty string "id"' };
  }
  const declared = r['declared'];
  if (declared === null || typeof declared !== 'object' || !Array.isArray((declared as { files?: unknown }).files)) {
    return { error: 'candidate "declared" must be a source object with a files[] glob list' };
  }
  if (r['registered'] === undefined) {
    return { error: 'candidate is missing "registered" (a source object or an array of them)' };
  }
  // Deeper misconfiguration (bad regex / no capture group) is surfaced as a
  // diagnostic by the engine, not rejected here — that is the point of a dry run.
  return { rule: raw as IWiringRule };
}

async function wiringExplain(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const ruleId = args.positional[1];
  if (!ruleId) {
    process.stderr.write('Usage: shrk wiring explain <ruleId> [--json]\n');
    return 2;
  }
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) {
    const msg = loaded.error.message;
    if (wantJson) process.stdout.write(asJson({ ok: false, error: msg }) + '\n');
    else process.stderr.write(`Could not load config: ${msg}\n`);
    return 1;
  }
  const rules = loaded.value.config.wiringRules ?? [];
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) {
    const ids = rules.map((r) => r.id);
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: 'not-found', ruleId, available: ids }) + '\n');
      return 2;
    }
    process.stderr.write(
      `No wiring rule "${ruleId}". Configured rules: ${ids.length > 0 ? ids.join(', ') : '(none)'}\n`,
    );
    return 2;
  }
  // THE plane scan scope, so `wiring explain` ≡ `check wiring --explain` ≡ `gates explain`.
  return renderWiringExplain(
    explainWiring(cwd, rule, { excludeDirs: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir) }),
    wantJson,
  );
}

async function wiringTest(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const candidateArg = args.positional[1];
  if (!candidateArg) {
    process.stderr.write(
      'Usage: shrk wiring test <candidate.json | inline-json> [--json]\n' +
        '  Dry-runs an ephemeral wiring rule against the live tree without writing config.\n',
    );
    return 2;
  }

  // A leading `{` is treated as inline JSON; otherwise the arg is a file path.
  let source: string;
  if (candidateArg.trimStart().startsWith('{')) {
    source = candidateArg;
  } else {
    if (!existsSync(candidateArg)) {
      const msg = `candidate file not found: ${candidateArg}`;
      if (wantJson) process.stdout.write(asJson({ ok: false, error: msg }) + '\n');
      else process.stderr.write(msg + '\n');
      return 2;
    }
    source = readFileSync(candidateArg, 'utf8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    const msg = `candidate is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
    if (wantJson) process.stdout.write(asJson({ ok: false, error: msg }) + '\n');
    else process.stderr.write(msg + '\n');
    return 2;
  }

  const { rule, error } = validateCandidate(parsed);
  if (!rule) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error }) + '\n');
    else process.stderr.write(`Invalid candidate: ${error}\n`);
    return 2;
  }
  return renderWiringExplain(explainWiring(cwd, rule), wantJson);
}

// ── registration / DI graph (chain | unprovided | orphans) ──────────────────

interface ILoadedRegistrationGraph {
  readonly ok: boolean;
  readonly graph?: IRegistrationGraph;
  readonly idioms: readonly IRegistrationIdiom[];
  readonly error?: string;
  /** THE plane scan scope the graph was built with — the role measurement walks the same tree. */
  readonly excludeDirs?: readonly string[];
}

/**
 * Load the configured DI/registration idioms and build the graph, cached by a
 * signature of the exact source files it reads + an idiom hash. Repeated session
 * queries (chain + unprovided + orphans) reuse ONE scan; any edit to a matched
 * file shifts the signature and rebuilds, so the cache can never return a stale
 * verdict (no `shrk graph index` required — the cache tracks its real data
 * source, not the unrelated code-graph digest). Best-effort — any read/write
 * error falls back to a fresh build.
 */
async function loadRegistrationGraph(cwd: string): Promise<ILoadedRegistrationGraph> {
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return { ok: false, idioms: [], error: loaded.error.message };
  const idioms = loaded.value.config.registrationGraph ?? [];
  if (idioms.length === 0) return { ok: true, idioms: [] };

  // THE plane scan scope, so these queries walk the tree `gates check`'s
  // registration plane and finish's unprovided sub-gate walk.
  const scan = { excludeDirs: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir) };
  const cacheKey = registrationCacheKey(cwd, idioms, scan);
  const cachePath = nodePath.join(cwd, '.sharkcraft', 'cache', 'registration-graph.json');
  if (cacheKey) {
    const cached = readRegistrationCache(cachePath, cacheKey);
    if (cached) return { ok: true, idioms, graph: cached, excludeDirs: scan.excludeDirs };
  }

  const graph = buildRegistrationGraph(cwd, idioms, scan);
  if (cacheKey) writeRegistrationCache(cachePath, cacheKey, graph);
  return { ok: true, idioms, graph, excludeDirs: scan.excludeDirs };
}

/**
 * The gate envelope of an absence query that examined nothing in its changed
 * scope (no changed file, or a scope that could not be resolved): 2, never a
 * pass — the same answer the verb returns, carried in `--json` as `gate`.
 */
function unexaminedScopeEnvelope(verb: string, root: string, reason: string): IGateEnvelope {
  return buildGateEnvelope(verb, ExitCode.VerifiedPass, [], {
    unit: 'changed files',
    expected: 0,
    examined: 0,
    root,
    reason,
  });
}

/**
 * The `--json` keys EVERY registration-query answer carries (round 13 review):
 * the empty-changed-scope and scoped-error answers carried only `gate`, against
 * the documented "always carries `coverage`, `exitCode`, `verdict`,
 * `shortfalls`, `accepted` and `gate`" — the idiom answer's keys.
 */
function scopeEnvelopeJson(gate: IGateEnvelope): Readonly<Record<string, unknown>> {
  return {
    coverage: [gate.coverage],
    exitCode: gate.exit,
    verdict: planeVerdictForExit(gate.exit),
    shortfalls: gate.shortfalls,
    accepted: gate.accepted,
    gate,
  };
}

/**
 * `<file-signature>:<idiom-hash>` — keyed on the mtime/size signature of the
 * exact files the graph is built from (its real data source), NOT the code-graph
 * index digest. Any source edit shifts the signature even when no reindex has
 * run, so the persisted cache can never return a stale wiring verdict. Undefined
 * only if signing itself throws (then the query rebuilds every time).
 */
function registrationCacheKey(
  cwd: string,
  idioms: readonly IRegistrationIdiom[],
  scan: { readonly excludeDirs: readonly string[] },
): string | undefined {
  try {
    const signature = registrationGraphSignature(cwd, idioms, scan);
    const idiomHash = createHash('sha1').update(JSON.stringify(idioms)).digest('hex').slice(0, 16);
    return `${signature}:${idiomHash}`;
  } catch {
    return undefined;
  }
}

function readRegistrationCache(cachePath: string, key: string): IRegistrationGraph | undefined {
  try {
    if (!existsSync(cachePath)) return undefined;
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      key?: string;
      graph?: IRegistrationGraph;
    };
    return cached.key === key && cached.graph ? cached.graph : undefined;
  } catch {
    return undefined;
  }
}

function writeRegistrationCache(cachePath: string, key: string, graph: IRegistrationGraph): void {
  try {
    mkdirSync(nodePath.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ key, graph }));
  } catch {
    // best-effort cache; a write failure never breaks the query.
  }
}

/**
 * No `registrationGraph[]` declared: the query examined nothing, so it is NOT
 * VERIFIED (2) — never "no unprovided tokens" at 0 — unless `--allow-empty`
 * accepts the empty graph explicitly (printed). `wiring unprovided|orphans|
 * chain` are registered verdict verbs; `check wiring` / `gates check` settle
 * the same empty request to 2, so the planes agree. Settled through the shared
 * gate envelope, which `--json` carries as `gate` (round 13, P4).
 */
function noIdiomsHint(args: ParsedArgs, wantJson: boolean, verb: string): number {
  const settled = buildGateEnvelope(verb, ExitCode.VerifiedPass, [], {
    unit: 'registration idioms',
    expected: 0,
    examined: 0,
    root: resolveCwd(args),
    reason: 'no registrationGraph[] declared',
    ...allowEmptyValve(args, 0),
  });
  if (wantJson) {
    process.stdout.write(
      asJson({
        schema: 'sharkcraft.registration-graph/v1',
        idioms: [],
        tokens: [],
        // The same keys as the idiom answer (round 13 review): `coverage` was
        // missing here, against the documented "always carries".
        coverage: [settled.coverage],
        exitCode: settled.exit,
        verdict: planeVerdictForExit(settled.exit),
        shortfalls: settled.shortfalls,
        accepted: settled.accepted,
        gate: settled,
      }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(header('Registration graph'));
  process.stdout.write(
    '  No registration idioms configured. Declare `registrationGraph[]` in\n' +
      '  sharkcraft.config.ts (declared/provided/consumed shapes) to model your DI\n' +
      '  wiring as a queryable graph — see docs/wiring.md.\n',
  );
  const line = verdictLine(settled, 'No registration idioms configured — accepted.');
  if (line) process.stdout.write(`\n${line}\n`);
  if (settled.exit === ExitCode.NotVerified) {
    process.stdout.write(`Pass --${ALLOW_EMPTY_FLAG} to accept an empty registration graph explicitly.\n`);
  }
  return settled.exit;
}

function siteLine(s: IRegistrationSite): string {
  return `${s.file}:${s.line} [${s.idiom}]`;
}

interface IChangedScopeResult {
  /** `undefined` = no scoping requested (whole-graph query). */
  readonly files?: readonly string[];
  /** Set when the requested scope could not be resolved (e.g. a bad --base ref). */
  readonly error?: string;
}

/**
 * The changed-file scope for a `--changed-only` / `--base <ref>` query, or an
 * empty result when neither flag is set (whole-graph query). `--base <ref>` diffs
 * against that ref; bare `--changed-only` uses the working tree. Reuses the same
 * {@link resolveChangedFiles} the `finish` composite and boundary gates use, so
 * the scope semantics match across every changed-only surface.
 *
 * Two honesty guards: an unresolvable `--base` ref returns a distinct `error`
 * (never a silent empty scope that reads as "nothing changed" over a typo'd ref);
 * and SHRK's own engine-written state under `.sharkcraft/` (this command writes a
 * cache + usage log) is excluded so it can't pollute an otherwise-clean tree into
 * a false non-empty scope.
 */
function changedScopeFor(args: ParsedArgs, cwd: string): IChangedScopeResult {
  const base = flagString(args, 'base');
  const changedOnly = flagBool(args, 'changed-only');
  if (!base && !changedOnly) return {};
  if (base && !refExists(cwd, base)) {
    return { error: `cannot resolve --base ref '${base}' — not a valid commit/branch` };
  }
  const opts: IChangedScopeOptions = base
    ? { projectRoot: cwd, since: base }
    : { projectRoot: cwd, includeWorktree: true };
  const files = resolveChangedFiles(opts).files.filter(
    (f) => f !== '.sharkcraft' && !f.startsWith('.sharkcraft/'),
  );
  return { files };
}

async function wiringChain(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const token = args.positional[1];
  if (!token) {
    process.stderr.write('Usage: shrk wiring chain <token> [--json]\n');
    return 2;
  }
  const loaded = await loadRegistrationGraph(cwd);
  if (!loaded.ok) {
    // The registration graph is declared in the config that did not load: the
    // query never STARTED — a usage error (3), never a `1` finding.
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: loaded.error, exitCode: ExitCode.UsageError }) + '\n');
    } else {
      process.stderr.write(`Could not load config: ${loaded.error}\n`);
    }
    return ExitCode.UsageError;
  }
  if (!loaded.graph) return noIdiomsHint(args, wantJson, 'wiring chain');

  const chain = registrationChain(loaded.graph, token);
  if (!chain) {
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: 'not-found', token }) + '\n');
      return 1;
    }
    process.stdout.write(header(`Wiring chain: ${token}`));
    process.stdout.write('  Token not found in the registration graph.\n');
    return 1;
  }
  // Round 13 review: settled like `wiring unprovided|orphans` (P4) — every
  // idiom the token's sites belong to folds its ROLE record and expectEmpty
  // acceptance from THE role authority (`measureIdiomRoleCoverage`) through
  // the shared envelope. A chain over a dead declared role printed "declared
  // (0)" and then "✓ declared → provided → consumed." at exit 0 while its
  // siblings said NOT VERIFIED; an acceptance was printed nowhere.
  const involved = new Set([...chain.declared, ...chain.provided, ...chain.consumed].map((s) => s.idiom));
  const matched = loaded.idioms.filter((i) => involved.has(i.name));
  const idioms = matched.length > 0 ? matched : loaded.idioms;
  const roles = measureIdiomRoleCoverage(cwd, idioms, loaded.excludeDirs ?? []);
  const gate = buildGateEnvelope(
    'wiring chain',
    ExitCode.VerifiedPass,
    roles.map((r) => ({
      id: r.idiom,
      type: 'registration' as const,
      status: 'passed' as const,
      severity: 'warning' as const,
      counts: {},
      violations: [],
      coverage: r.coverage,
      ...(r.unitAcceptance !== undefined ? { unitAcceptance: r.unitAcceptance } : {}),
    })),
    { unit: 'registration idioms', expected: idioms.length, examined: idioms.length },
  );
  const unprovided = !chain.isProvided && (chain.isDeclared || chain.isConsumed);
  const orphan = chain.isProvided && !chain.isConsumed;
  if (wantJson) {
    process.stdout.write(
      asJson({
        ...chain,
        coverage: roles.map((r) => r.coverage),
        exitCode: gate.exit,
        verdict: planeVerdictForExit(gate.exit),
        shortfalls: gate.shortfalls,
        accepted: gate.accepted,
        gate,
      }) + '\n',
    );
    return gate.exit;
  }
  process.stdout.write(header(`Wiring chain: ${token}`));
  const section = (label: string, sites: readonly IRegistrationSite[]): void => {
    process.stdout.write(`\n${label} (${sites.length}):\n`);
    if (sites.length === 0) process.stdout.write('  (none)\n');
    for (const s of sites) process.stdout.write(`  • ${siteLine(s)}\n`);
  };
  section('declared', chain.declared);
  section('provided', chain.provided);
  section('consumed', chain.consumed);
  if (unprovided) {
    process.stdout.write('\n  ⚠ UNPROVIDED — declared/injected but never provided (silent at runtime).\n');
  } else if (orphan) {
    process.stdout.write('\n  ⚠ ORPHAN — provided but nothing consumes it.\n');
  }
  // The ✓ only from the SETTLED verdict — a dead role is NOT VERIFIED (2), an
  // acceptance is printed under the clean line.
  const line = verdictLine(gate, unprovided || orphan ? '' : '  ✓ declared → provided → consumed.');
  if (line) process.stdout.write(`\n${line}\n`);
  return gate.exit;
}

async function wiringUnprovided(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const loaded = await loadRegistrationGraph(cwd);
  if (!loaded.ok) {
    // The registration graph is declared in the config that did not load: the
    // query never STARTED — a usage error (3), never a `1` finding.
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: loaded.error, exitCode: ExitCode.UsageError }) + '\n');
    } else {
      process.stderr.write(`Could not load config: ${loaded.error}\n`);
    }
    return ExitCode.UsageError;
  }
  if (!loaded.graph) return noIdiomsHint(args, wantJson, 'wiring unprovided');

  const scoped = changedScopeFor(args, cwd);
  if (scoped.error) {
    if (wantJson) {
      const gate = unexaminedScopeEnvelope('wiring unprovided', cwd, scoped.error);
      process.stdout.write(
        asJson({
          schema: loaded.graph.schema,
          scoped: true,
          error: scoped.error,
          verified: false,
          // The documented keys every answer carries (round 13 review).
          ...scopeEnvelopeJson(gate),
        }) + '\n',
      );
    } else {
      process.stderr.write(`error: ${scoped.error}\n`);
    }
    return ExitCode.NotVerified;
  }
  const scope = scoped.files;
  // An empty changed scope evaluated NOTHING — honest `2` (not-verified), never
  // a green `0` that reads as "no unprovided tokens" (a25 §1.1 exit contract).
  if (scope && scope.length === 0) {
    if (wantJson) {
      const gate = unexaminedScopeEnvelope('wiring unprovided', cwd, 'no file in the changed scope');
      process.stdout.write(
        asJson({
          schema: loaded.graph.schema,
          scoped: true,
          total: 0,
          unprovided: [],
          verified: false,
          ...scopeEnvelopeJson(gate),
        }) + '\n',
      );
      return ExitCode.NotVerified;
    }
    process.stdout.write(header('Unprovided tokens (declared/injected but never provided)'));
    process.stdout.write('  – No files in the changed scope — nothing to verify (not verified).\n');
    return ExitCode.NotVerified;
  }

  // Settled against what the graph READ and what every idiom's ROLES examined,
  // through the one boundaries helper finish and MCP use. An idiom file over
  // the read cap holds sites the graph never saw: a token whose provider could
  // sit there is `unproven`, not a finding (the registry plane's rule: only a
  // positive finding survives an incomplete read), and a clean answer over it
  // is NOT VERIFIED (2). Round 13 (P4): so is a clean answer over a role whose
  // globs matched no file — THE role authority `gates check` reads.
  const roles = measureIdiomRoleCoverage(cwd, loaded.idioms, loaded.excludeDirs ?? []);
  const verdict = registrationUnprovidedVerdict(loaded.graph, loaded.idioms, roles, scope);
  const unprovided = verdict.findings;
  const settled = settleRegistrationGraph({
    verb: 'wiring unprovided',
    verdict,
    proposed: unprovided.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass,
    clean: `  ✓ Every declared/injected token${scope ? ' in the changed scope' : ''} has a provider. ✓`,
    subject: 'unprovided',
    idioms: loaded.idioms.length,
  });
  if (wantJson) {
    process.stdout.write(
      asJson({ schema: loaded.graph.schema, scoped: scope !== undefined, total: unprovided.length, unprovided, ...settled.json }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(header('Unprovided tokens (declared/injected but never provided)'));
  if (scope) process.stdout.write(kv('scope', `changed-only (${scope.length} file(s))`) + '\n');
  if (unprovided.length > 0) {
    process.stdout.write(`  ${unprovided.length} token(s) resolve to nothing at runtime:\n`);
    for (const u of unprovided) {
      const site = u.declared[0] ?? u.consumed[0];
      const where = site ? `  (${siteLine(site)})` : '';
      process.stdout.write(`  ✗ ${u.token}${where}\n`);
    }
  }
  if (verdict.unproven.length > 0) {
    process.stdout.write(
      `  ${verdict.unproven.length} token(s) have no provider among the files read — NOT VERIFIED ` +
        '(a provider may sit in a file the reader did not read):\n',
    );
    for (const u of verdict.unproven) {
      const site = u.declared[0] ?? u.consumed[0];
      process.stdout.write(`  ? ${u.token}${site ? `  (${siteLine(site)})` : ''}\n`);
    }
  }
  if (settled.line) process.stdout.write(`${settled.line}\n`);
  return settled.exit;
}

async function wiringOrphans(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const loaded = await loadRegistrationGraph(cwd);
  if (!loaded.ok) {
    // The registration graph is declared in the config that did not load: the
    // query never STARTED — a usage error (3), never a `1` finding.
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: loaded.error, exitCode: ExitCode.UsageError }) + '\n');
    } else {
      process.stderr.write(`Could not load config: ${loaded.error}\n`);
    }
    return ExitCode.UsageError;
  }
  if (!loaded.graph) return noIdiomsHint(args, wantJson, 'wiring orphans');

  const scoped = changedScopeFor(args, cwd);
  if (scoped.error) {
    if (wantJson) {
      const gate = unexaminedScopeEnvelope('wiring orphans', cwd, scoped.error);
      process.stdout.write(
        asJson({
          schema: loaded.graph.schema,
          scoped: true,
          error: scoped.error,
          verified: false,
          // The documented keys every answer carries (round 13 review).
          ...scopeEnvelopeJson(gate),
        }) + '\n',
      );
    } else {
      process.stderr.write(`error: ${scoped.error}\n`);
    }
    return ExitCode.NotVerified;
  }
  const scope = scoped.files;
  if (scope && scope.length === 0) {
    if (wantJson) {
      const gate = unexaminedScopeEnvelope('wiring orphans', cwd, 'no file in the changed scope');
      process.stdout.write(
        asJson({
          schema: loaded.graph.schema,
          scoped: true,
          total: 0,
          orphans: [],
          verified: false,
          ...scopeEnvelopeJson(gate),
        }) + '\n',
      );
      return ExitCode.NotVerified;
    }
    process.stdout.write(header('Orphan registrations (provided but nothing consumes)'));
    process.stdout.write('  – No files in the changed scope — nothing to verify (not verified).\n');
    return ExitCode.NotVerified;
  }

  // Orphans never fail, but "every provider is consumed" over an idiom file
  // the reader could not read is NOT VERIFIED (2), settled like `unprovided`
  // through the same boundaries helper. A token whose consumer could sit in
  // such a file is `unproven`, never listed as an orphan. Round 13 (P4): so is
  // the answer over a role whose globs matched no file (THE role authority).
  const roles = measureIdiomRoleCoverage(cwd, loaded.idioms, loaded.excludeDirs ?? []);
  const verdict = registrationOrphansVerdict(loaded.graph, loaded.idioms, roles, scope);
  const orphans = verdict.findings;
  const settled = settleRegistrationGraph({
    verb: 'wiring orphans',
    verdict,
    proposed: ExitCode.VerifiedPass,
    clean:
      orphans.length === 0
        ? `  ✓ Every provided token${scope ? ' in the changed scope' : ''} is consumed somewhere. ✓`
        : '',
    subject: 'orphans',
    idioms: loaded.idioms.length,
  });
  if (wantJson) {
    process.stdout.write(
      asJson({ schema: loaded.graph.schema, scoped: scope !== undefined, total: orphans.length, orphans, ...settled.json }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(header('Orphan registrations (provided but nothing consumes)'));
  if (scope) process.stdout.write(kv('scope', `changed-only (${scope.length} file(s))`) + '\n');
  if (orphans.length > 0) {
    process.stdout.write(`  ${orphans.length} provided token(s) nothing injects:\n`);
    for (const o of orphans) {
      const site = o.provided[0];
      process.stdout.write(`  • ${o.token}${site ? `  (${siteLine(site)})` : ''}\n`);
    }
  }
  if (verdict.unproven.length > 0) {
    process.stdout.write(
      `  ${verdict.unproven.length} provided token(s) have no consumer among the files read — NOT VERIFIED ` +
        '(a consumer may sit in a file the reader did not read):\n',
    );
    for (const o of verdict.unproven) {
      const site = o.provided[0];
      process.stdout.write(`  ? ${o.token}${site ? `  (${siteLine(site)})` : ''}\n`);
    }
  }
  if (settled.line) process.stdout.write(`${settled.line}\n`);
  return settled.exit;
}

const WIRING_USAGE =
  'shrk wiring explain <ruleId> | test <candidate.json|inline> | chain <token> | unprovided | orphans [--changed-only | --base <ref>] [--allow-empty] [--json]';

export const wiringCommand: ICommandHandler = {
  name: 'wiring',
  positionals: PositionalMode.None,
  subverbs: [
    {
      name: 'explain',
      description: 'Dry-run one wiring rule: the declared / registered sets it extracts.',
      usage: 'shrk wiring explain <ruleId> [--json]',
      positionals: PositionalMode.Free,
    },
    {
      name: 'test',
      description: 'Dry-run a candidate wiring rule (a file or inline JSON) without touching config.',
      usage: 'shrk wiring test <candidate.json | inline-json> [--json]',
      positionals: PositionalMode.Path,
    },
    {
      name: 'chain',
      description: 'Trace one token declared → provided → consumed through the registration graph.',
      usage: 'shrk wiring chain <token> [--allow-empty] [--json]',
      positionals: PositionalMode.Free,
    },
    {
      name: 'unprovided',
      description: 'Tokens consumed but never provided — the silent-at-runtime DI bug.',
      usage: 'shrk wiring unprovided [--changed-only | --base <ref>] [--allow-empty] [--json]',
    },
    {
      name: 'orphans',
      description: 'Tokens provided that nothing injects.',
      usage: 'shrk wiring orphans [--changed-only | --base <ref>] [--allow-empty] [--json]',
    },
  ],
  description:
    'Author-loop + runtime-wiring queries (no config write): `explain <ruleId>` / `test <candidate>` show what a wiring rule extracts; `chain <token>` / `unprovided` / `orphans` query the DI/registration graph (declared→provided→consumed) for the silent-at-runtime bugs imports can\'t see. `unprovided` / `orphans` accept `--changed-only` (working tree) or `--base <ref>` to scope the verdict to the changeset.',
  usage: WIRING_USAGE,
  booleanFlags: new Set(['json', 'changed-only', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'explain') return wiringExplain(args);
    if (sub === 'test') return wiringTest(args);
    if (sub === 'chain') return wiringChain(args);
    if (sub === 'unprovided') return wiringUnprovided(args);
    if (sub === 'orphans') return wiringOrphans(args);
    process.stderr.write(`Usage: ${WIRING_USAGE}\n`);
    return 2;
  },
};
