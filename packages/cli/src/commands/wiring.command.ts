import {
  buildRegistrationGraph,
  explainWiring,
  registrationChain,
  registrationGraphSignature,
  registrationOrphans,
  registrationUnprovided,
  type IRegistrationGraph,
  type IRegistrationSite,
  type IWiringExplain,
} from '@shrkcrft/boundaries';
import type { IRegistrationIdiom, IWiringRule } from '@shrkcrft/core';
import { resolveProjectConfig } from '@shrkcrft/inspector';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { flagBool, resolveCwd, type ICommandHandler, type ParsedArgs } from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const SITE_DISPLAY_CAP = 50;

/**
 * Render an {@link IWiringExplain} to stdout. Shared by `wiring explain`,
 * `wiring test`, and `check wiring --explain` so all three speak the same
 * dialect. JSON emits the full payload; text mirrors `search tuning explain`
 * (header → loaded sets → per-site detail → the set-difference → verdict).
 * Always returns 0 — explain is informational, the verdict is in the output.
 */
export function renderWiringExplain(report: IWiringExplain, wantJson: boolean): number {
  if (wantJson) {
    process.stdout.write(asJson(report) + '\n');
    return 0;
  }

  process.stdout.write(header(`Wiring explain: ${report.ruleId} (${report.mode})`));
  if (report.description) process.stdout.write(`  ${report.description}\n`);
  if (report.groupBy) process.stdout.write(kv('groupBy', report.groupBy) + '\n');
  process.stdout.write(
    kv('declared', `${report.declared.distinctCount} distinct across ${report.declared.filesScanned} file(s)`) +
      '\n',
  );
  process.stdout.write(
    kv(
      'registered',
      `${report.registered.distinctCount} distinct across ${report.registered.filesScanned} file(s)`,
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
    process.stdout.write(
      `\nRegistered but NOT declared (parity, ${report.registeredNotDeclared.length}):\n`,
    );
    for (const s of report.registeredNotDeclared.slice(0, SITE_DISPLAY_CAP)) {
      process.stdout.write(`  ✗ ${s.token}  (${s.file}:${s.line})\n`);
    }
    if (report.registeredNotDeclared.length > SITE_DISPLAY_CAP) {
      process.stdout.write(`  … (${report.registeredNotDeclared.length - SITE_DISPLAY_CAP} more)\n`);
    }
  }

  for (const d of report.diagnostics) process.stdout.write(`  ! ${d}\n`);
  process.stdout.write(`\nVerdict: ${report.verdict}\n`);
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
  return renderWiringExplain(explainWiring(cwd, rule), wantJson);
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

  const cacheKey = registrationCacheKey(cwd, idioms);
  const cachePath = nodePath.join(cwd, '.sharkcraft', 'cache', 'registration-graph.json');
  if (cacheKey) {
    const cached = readRegistrationCache(cachePath, cacheKey);
    if (cached) return { ok: true, idioms, graph: cached };
  }

  const graph = buildRegistrationGraph(cwd, idioms);
  if (cacheKey) writeRegistrationCache(cachePath, cacheKey, graph);
  return { ok: true, idioms, graph };
}

/**
 * `<file-signature>:<idiom-hash>` — keyed on the mtime/size signature of the
 * exact files the graph is built from (its real data source), NOT the code-graph
 * index digest. Any source edit shifts the signature even when no reindex has
 * run, so the persisted cache can never return a stale wiring verdict. Undefined
 * only if signing itself throws (then the query rebuilds every time).
 */
function registrationCacheKey(cwd: string, idioms: readonly IRegistrationIdiom[]): string | undefined {
  try {
    const signature = registrationGraphSignature(cwd, idioms);
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

function noIdiomsHint(wantJson: boolean): number {
  if (wantJson) {
    process.stdout.write(asJson({ schema: 'sharkcraft.registration-graph/v1', idioms: [], tokens: [] }) + '\n');
    return 0;
  }
  process.stdout.write(header('Registration graph'));
  process.stdout.write(
    '  No registration idioms configured. Declare `registrationGraph[]` in\n' +
      '  sharkcraft.config.ts (declared/provided/consumed shapes) to model your DI\n' +
      '  wiring as a queryable graph — see docs/wiring.md.\n',
  );
  return 0;
}

function siteLine(s: IRegistrationSite): string {
  return `${s.file}:${s.line} [${s.idiom}]`;
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
    if (wantJson) process.stdout.write(asJson({ ok: false, error: loaded.error }) + '\n');
    else process.stderr.write(`Could not load config: ${loaded.error}\n`);
    return 1;
  }
  if (!loaded.graph) return noIdiomsHint(wantJson);

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
  if (wantJson) {
    process.stdout.write(asJson(chain) + '\n');
    return 0;
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
  if (!chain.isProvided && (chain.isDeclared || chain.isConsumed)) {
    process.stdout.write('\n  ⚠ UNPROVIDED — declared/injected but never provided (silent at runtime).\n');
  } else if (chain.isProvided && !chain.isConsumed) {
    process.stdout.write('\n  ⚠ ORPHAN — provided but nothing consumes it.\n');
  } else {
    process.stdout.write('\n  ✓ declared → provided → consumed.\n');
  }
  return 0;
}

async function wiringUnprovided(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const loaded = await loadRegistrationGraph(cwd);
  if (!loaded.ok) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error: loaded.error }) + '\n');
    else process.stderr.write(`Could not load config: ${loaded.error}\n`);
    return 1;
  }
  if (!loaded.graph) return noIdiomsHint(wantJson);

  const unprovided = registrationUnprovided(loaded.graph);
  if (wantJson) {
    process.stdout.write(
      asJson({ schema: loaded.graph.schema, total: unprovided.length, unprovided }) + '\n',
    );
    return unprovided.length > 0 ? 1 : 0;
  }
  process.stdout.write(header('Unprovided tokens (declared/injected but never provided)'));
  if (unprovided.length === 0) {
    process.stdout.write('  ✓ Every declared/injected token has a provider. ✓\n');
    return 0;
  }
  process.stdout.write(`  ${unprovided.length} token(s) resolve to nothing at runtime:\n`);
  for (const u of unprovided) {
    const site = u.declared[0] ?? u.consumed[0];
    const where = site ? `  (${siteLine(site)})` : '';
    process.stdout.write(`  ✗ ${u.token}${where}\n`);
  }
  return 1;
}

async function wiringOrphans(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const loaded = await loadRegistrationGraph(cwd);
  if (!loaded.ok) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error: loaded.error }) + '\n');
    else process.stderr.write(`Could not load config: ${loaded.error}\n`);
    return 1;
  }
  if (!loaded.graph) return noIdiomsHint(wantJson);

  const orphans = registrationOrphans(loaded.graph);
  if (wantJson) {
    process.stdout.write(asJson({ schema: loaded.graph.schema, total: orphans.length, orphans }) + '\n');
    return 0;
  }
  process.stdout.write(header('Orphan registrations (provided but nothing consumes)'));
  if (orphans.length === 0) {
    process.stdout.write('  ✓ Every provided token is consumed somewhere. ✓\n');
    return 0;
  }
  process.stdout.write(`  ${orphans.length} provided token(s) nothing injects:\n`);
  for (const o of orphans) {
    const site = o.provided[0];
    process.stdout.write(`  • ${o.token}${site ? `  (${siteLine(site)})` : ''}\n`);
  }
  return 0;
}

const WIRING_USAGE =
  'shrk wiring explain <ruleId> | test <candidate.json|inline> | chain <token> | unprovided | orphans [--json]';

export const wiringCommand: ICommandHandler = {
  name: 'wiring',
  description:
    'Author-loop + runtime-wiring queries (no config write): `explain <ruleId>` / `test <candidate>` show what a wiring rule extracts; `chain <token>` / `unprovided` / `orphans` query the DI/registration graph (declared→provided→consumed) for the silent-at-runtime bugs imports can\'t see.',
  usage: WIRING_USAGE,
  booleanFlags: new Set(['json']),
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
