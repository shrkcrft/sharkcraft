/**
 * `shrk docs references {check,explain,list}` — the prose-reference linter.
 *
 *   shrk docs references check [--id X] [--json]     # unresolved id → finding
 *   shrk docs references explain --id X              # every token + where it resolved
 *   shrk docs references list                        # the declared rules
 *
 * shrk validates the STRUCTURED `references[]` on knowledge entries. The same
 * ids written as prose — a README, an architecture doc, an agent skill file
 * saying `shrk gen nge.foo` — had no gate at all, and markdown has no build
 * behind it. This points the existing reference resolver at that surface.
 *
 * Read-only: it scans documents and consults registries. Nothing is written and
 * nothing is spawned.
 */
import * as nodePath from 'node:path';
import { formatEmptyRuleAdvice, type IDocReferenceRule } from '@shrkcrft/core';
import { planeScanExcludeDirs, readScopeCoverage } from '@shrkcrft/boundaries';
import { warmCliReferenceRegistries } from '../surface/cli-command-resolver.ts';
import {
  checkDocReferences,
  inspectSharkcraft,
  resolveProjectConfig,
  type IDocReferenceResult,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
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
import { buildGateEnvelope } from '../gates/gate-envelope.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { acceptedEmptyNote } from '../gates/accepted-empty-note.ts';
import { emptyRuleAdviceLines } from '../gates/empty-rule-advice-lines.ts';
import { qualifyCleanForUnits } from '../gates/qualify-clean-for-units.ts';
import { unitStateNotes } from '../gates/unit-state-notes.ts';
import { planeVerdictForExit } from '../gates/plane-verdict.ts';
import { seamRejectedRules } from '../gates/seam-rejected-rules.ts';
import type { IGateRuleResult } from '../gates/gate-envelope.ts';
import type { IVerdictCoverage } from '@shrkcrft/core';

const SCHEMA = 'sharkcraft.doc-references/v1';

/**
 * What one doc-reference rule examined — shared by `docs references check` and
 * the aggregate (`gates check`, `quality`), so both report the same scope.
 *
 * The unit is the id-shaped tokens the rule matched. Tokens it did NOT check
 * were skipped by the rule's own config — an `exempt` id, an in-file
 * `exemptMarker`, the `requireContext` gate — which is a deliberate narrowing,
 * so it is accepted by that config and printed as such rather than silently
 * shrinking the denominator.
 */
export function docReferenceCoverage(r: IDocReferenceResult): IVerdictCoverage {
  // An intended-empty rule (round 13: every `files` inclusion glob marked
  // `expectEmpty`, no document matched) is covered by its acceptance — the
  // settle's own record, printed at exit 0.
  if (r.emptyCoverage !== undefined) return r.emptyCoverage;
  // A document the reader could not read (over the read cap) folds in through
  // the one rule every plane uses: `examined N of M files`, named.
  return readScopeCoverage(planeDocReferenceCoverage(r), r.readScope);
}

function planeDocReferenceCoverage(r: IDocReferenceResult): IVerdictCoverage {
  if (r.error !== undefined) {
    return { unit: 'references', expected: 0, examined: 0, reason: 'the rule could not run' };
  }
  const expected = r.tokensChecked + r.tokensSkipped;
  return {
    unit: 'references',
    expected,
    examined: r.tokensChecked,
    ...(r.skipReason !== undefined
      ? { reason: r.skipReason }
      : r.tokensSkipped > 0
        ? { reason: "skipped by the rule's own exempt / exemptMarker / requireContext config" }
        : {}),
    ...(r.tokensSkipped > 0 && r.tokensChecked > 0
      ? { acceptedBy: 'the rule config (exempt / exemptMarker / requireContext)' }
      : {}),
  };
}

interface IPrepared {
  readonly cwd: string;
  readonly rules: readonly IDocReferenceRule[];
  readonly all: readonly IDocReferenceRule[];
  readonly excludeDirs: string[];
  readonly planeDiagnostics: readonly string[];
  /**
   * Pack doc-reference rules the merge seam REJECTED (`seamRejectedRules`, the
   * rows `gates check` fails on) — configured rules that never ran, narrowed
   * by `--id` (round 13, P3 review).
   */
  readonly rejected: readonly IGateRuleResult[];
}

async function prepare(
  args: ParsedArgs,
  /** `rejectedKnown`: the verdict verb may select a rejected rule by `--id` (its errored row). */
  opts: { readonly rejectedKnown?: boolean } = {},
): Promise<{ ok: true; value: IPrepared } | { ok: false; code: number }> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) {
    const msg = loaded.error.message;
    if (json) process.stdout.write(asJson({ schema: SCHEMA, error: msg }) + '\n');
    else process.stderr.write(`Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
    return { ok: false, code: ExitCode.UsageError };
  }
  const all = loaded.value.config.docReferences ?? [];
  // A pack doc-reference rule the merge seam REJECTED is a configured rule
  // that never ran — an ERRORED row on this verb exactly as on `gates check`
  // (round 13, P3 review). It was one `! … invalid docReference element … —
  // skipped` line under a ✓ at exit 0 (or "No doc-reference rules declared"
  // at 2 when it was the only rule) while `gates check` exited 1 on the tree.
  const rejectedAll = seamRejectedRules(loaded.value, ['doc-reference']);

  let rules = all;
  let rejected: readonly IGateRuleResult[] = rejectedAll;
  const id = flagString(args, 'id');
  if (id) {
    const wanted = id.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set([
      ...all.map((r) => r.id),
      ...(opts.rejectedKnown === true ? rejectedAll.map((r) => r.id) : []),
    ]);
    const unknown = wanted.filter((w) => !known.has(w));
    if (unknown.length > 0) {
      process.stderr.write(
        `Unknown doc-reference rule id(s): ${unknown.join(', ')}. Declared: ${[...known].join(', ') || '(none)'}\n`,
      );
      return { ok: false, code: ExitCode.UsageError };
    }
    rules = all.filter((r) => wanted.includes(r.id));
    rejected = rejectedAll.filter((r) => wanted.includes(r.id));
  }

  return {
    ok: true,
    value: {
      cwd,
      rules,
      all,
      rejected,
      // THE plane scan scope — the same authority `gates check` reads.
      excludeDirs: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir),
      planeDiagnostics: loaded.value.planeDiagnostics,
    },
  };
}

/**
 * Build the inspection the resolver needs.
 *
 * Deliberately lazy — it is only paid for when a `docReferences` rule exists,
 * so a repo without the plane never loads the registries just to be told it has
 * no rules.
 */
async function inspectionFor(cwd: string): Promise<ISharkcraftInspection> {
  // Playbook / construct ids come from a cache an ASYNC load populates; the
  // resolver is sync. Warming here is what makes a correct pack playbook cited
  // in prose actually resolve.
  const inspection = await inspectSharkcraft({ cwd });
  // WITH the command resolver: a `resolvesAs: ['command']` rule resolves
  // against the live command index (without it, `command` is unverifiable
  // and the rule refuses loudly).
  await warmCliReferenceRegistries(inspection);
  return inspection;
}

/**
 * The "no rules declared" landing. A VERDICT verb passes its name so its JSON
 * still carries the settled `gate` envelope — nothing declared is `2`.
 */
function writeNoRules(json: boolean, verb?: string): number {
  // A VERDICT verb settles first and renders second, in text AND JSON: nothing
  // declared proposes 0 and the run coverage (expected 0) settles it to 2. The
  // exit comes from the envelope — never a hard-coded code — so text, JSON and
  // gate.exit cannot disagree. List / explain subverbs stay informational.
  const gate =
    verb !== undefined
      ? buildGateEnvelope(verb, ExitCode.VerifiedPass, [], {
          unit: 'doc-reference rules',
          expected: 0,
          examined: 0,
          reason: 'no docReferences[] declared',
        })
      : undefined;
  const exit = gate?.exit ?? ExitCode.NotVerified;
  if (json) {
    process.stdout.write(
      asJson({
        schema: SCHEMA,
        results: [],
        evaluated: 0,
        verdict: gate ? planeVerdictForExit(gate.exit) : 'not-verified',
        ...(gate ? { exitCode: gate.exit, gate } : {}),
      }) + '\n',
    );
    return exit;
  }
  process.stdout.write(header('Doc references'));
  process.stdout.write(
    '  No doc-reference rules declared. Add `docReferences[]` to sharkcraft.config.ts to\n' +
      '  catch ids cited in prose (READMEs, docs, agent skill files) that no longer resolve\n' +
      '  (see docs/doc-references.md).\n',
  );
  if (gate) {
    const line = verdictLine(gate, 'Nothing declared — accepted.');
    if (line) process.stdout.write(`\n${line}\n`);
  }
  return exit;
}

function resultJson(r: IDocReferenceResult): Record<string, unknown> {
  return {
    id: r.ruleId,
    ...(r.description ? { description: r.description } : {}),
    status: r.status,
    severity: r.severity,
    filesScanned: r.filesScanned,
    tokensChecked: r.tokensChecked,
    tokensSkipped: r.tokensSkipped,
    findings: r.findings,
    ...(r.skipReason ? { skipReason: r.skipReason } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/**
 * The round-12 list-verb rejection note (K10): one line per pack doc-reference
 * rule the merge seam REJECTED — the rows `baseline list` / `gates list` print.
 */
function writeRejectedDocRules(rejected: readonly IGateRuleResult[]): void {
  if (rejected.length === 0) return;
  process.stdout.write(`\n  rejected at the pack-plane merge seam — never checked (${rejected.length}):\n`);
  for (const r of rejected) process.stdout.write(`  ✗ ${r.id}  REJECTED — ${r.error ?? 'failed validation'}\n`);
  process.stdout.write('  `shrk packs contributions` names every rejected entry.\n');
}

export const docsReferencesCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Scan configured docs for id-shaped tokens and assert each resolves to a registered id. Catches a README or skill file citing a template that no longer exists.',
  usage: 'shrk docs references check [--id <ids>] [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args, { rejectedKnown: true });
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    const rejected = prep.value.rejected;
    if (prep.value.rules.length === 0 && rejected.length === 0) return writeNoRules(json, 'docs references check');

    // The resolver's inspection is paid for only when a rule will run.
    const inspection = prep.value.rules.length > 0 ? await inspectionFor(prep.value.cwd) : undefined;
    const results = inspection
      ? prep.value.rules.map((r) => checkDocReferences(prep.value.cwd, r, inspection, prep.value.excludeDirs))
      : [];

    // A rule that ERRORED proved nothing — it never got as far as checking an
    // id. So it is not `evaluated`, whatever its severity: a warning-severity
    // rule that could not run must not leave the banner saying "not blocking"
    // over an exit code of 0, which is the same half-truth as a green banner
    // above a list of findings.
    const errored = results.filter((r) => r.status === 'error');
    const failed = results.filter((r) => r.status === 'failed');
    const blocking = [...failed, ...errored].filter((r) => r.severity === 'error');
    const evaluated = results.filter((r) => r.status !== 'skipped' && r.status !== 'error').length;
    const skipped = results.length - evaluated;
    // A rejected pack rule is a configured rule that never ran: 1, as on
    // `gates check` (its ERRORED row, `failed validation — NOT evaluated`).
    const proposed =
      blocking.length > 0 || rejected.length > 0
        ? ExitCode.Failure
        : evaluated === 0 || skipped > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;
    // Settle first, render second: the envelope is built for text AND JSON, so
    // both return the same settled exit and the ✓ line is printed only from it.
    const unexamined = [
      ...results.filter((r) => r.status === 'skipped' || r.status === 'error').map((r) => r.ruleId),
      ...rejected.map((r) => r.id),
    ];
    const env = buildGateEnvelope(
      'docs references check',
      proposed,
      [...results.map((r): IGateRuleResult => ({
        id: r.ruleId,
        type: 'doc-reference' as const,
        status: r.status,
        severity: r.severity,
        counts: { files: r.filesScanned, tokens: r.tokensChecked, skipped: r.tokensSkipped },
        violations: r.findings.map((f) => ({
          id: f.token,
          file: f.file,
          line: f.line,
          message: f.message,
          ...(f.didYouMean.length > 0 ? { hint: `did you mean: ${f.didYouMean.join(', ')}` } : {}),
        })),
        ...(r.skipReason ? { skipReason: r.skipReason } : {}),
        ...(r.error ? { error: r.error } : {}),
        coverage: docReferenceCoverage(r),
        // The rule's `expectEmpty` acceptance and unit lines (round 13),
        // folded into the envelope's one settle — the accepted line comes from it.
        ...(r.unitAcceptance !== undefined ? { unitAcceptance: r.unitAcceptance } : {}),
        ...(r.units !== undefined ? { units: r.units } : {}),
      })), ...rejected],
      {
        unit: 'doc-reference rules',
        expected: results.length + rejected.length,
        examined: results.length + rejected.length - unexamined.length,
        ...(unexamined.length > 0 ? { unexamined, reason: 'checked nothing or could not run' } : {}),
      },
    );
    const exit = env.exit;

    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          results: results.map(resultJson),
          evaluated,
          skipped,
          verdict: exit === ExitCode.Failure ? 'errors' : exit === ExitCode.VerifiedPass ? 'pass' : 'not-verified',
          rejected: rejected.map((r) => ({ id: r.id, error: r.error ?? null })),
          diagnostics: prep.value.planeDiagnostics,
          exitCode: exit,
          gate: env,
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Doc references'));
    // Round 13 (K6): the printed count is the envelope's (`gate.evaluated`), which
    // never counts a rule accepted as intended-empty — it is named apart. The
    // local `evaluated` keeps counting it for the "nothing ran" proposal above.
    process.stdout.write(
      kv('evaluated', `${env.evaluated} of ${prep.value.rules.length + rejected.length}${acceptedEmptyNote(env.acceptedEmpty)}`) +
        '\n',
    );
    // THE shared unit-state block (round 13, K2): a dead `files` glob of a rule
    // that still matched, and a LOCAL expectEmpty marker whose target appeared,
    // withhold the ✓ (exit unchanged); a pack marker is INFO.
    const unitNotes = unitStateNotes(
      results.map((r) => ({
        id: r.ruleId,
        ...(r.unitLiveness !== undefined ? { unitLiveness: r.unitLiveness } : {}),
        reportedEmpty: r.status === 'skipped' || r.skipReason !== undefined,
      })),
    );
    for (const r of results) {
      if (r.status === 'skipped') {
        process.stdout.write(`  – ${r.ruleId}  SKIPPED — ${r.skipReason}\n`);
        continue;
      }
      if (r.status === 'error') {
        process.stdout.write(`  ! ${r.ruleId}  ${r.error}\n`);
        continue;
      }
      if (r.status === 'passed') {
        // Rendered from the SETTLED rule: a pass over part of its scope is
        // `partial`, never a ✓ (the keystone emitter pattern, step 5).
        const settledRule = env.rules.find((x) => x.id === r.ruleId);
        process.stdout.write(
          settledRule?.status === 'partial'
            ? `  ~ ${r.ruleId}  PARTIAL — ${settledRule.shortfall ?? 'part of its scope was not examined'}\n`
            : `  ✓ ${r.ruleId}  (${r.tokensChecked} reference(s) across ${r.filesScanned} doc(s) all resolve)\n`,
        );
        continue;
      }
      // A rule that CHECKED nothing failed for a different reason than one with
      // findings, and the loud-skip contract is worthless if it does not say
      // which. `0 unresolved of 0 checked` would send the reader hunting for a
      // bad id when the real problem is a moved directory.
      if (r.skipReason) {
        process.stdout.write(`  ✗ ${r.ruleId}  FAILED — ${r.skipReason}\n`);
        process.stdout.write(
          '      Nothing was checked, so nothing was enforced.\n' +
            `      → ${formatEmptyRuleAdvice({ fails: true })}\n`,
        );
        continue;
      }
      process.stdout.write(
        `  ✗ ${r.ruleId}  ${r.findings.length} unresolved reference(s) of ${r.tokensChecked} checked\n`,
      );
      for (const f of r.findings.slice(0, 25)) {
        process.stdout.write(`      • ${f.token}  (${f.file}:${f.line})\n`);
        if (f.didYouMean.length > 0) {
          process.stdout.write(`          did you mean: ${f.didYouMean.join(', ')}\n`);
        }
      }
      if (r.findings.length > 25) {
        process.stdout.write(`      … (${r.findings.length - 25} more)\n`);
      }
      const hint = r.findings.find((f) => f.hint)?.hint;
      if (hint) process.stdout.write(`      → ${hint}\n`);
    }
    for (const r of rejected) process.stdout.write(`  ✗ ${r.id}  REJECTED — ${r.error ?? 'failed validation'}\n`);
    for (const d of prep.value.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    // THE empty-rule advice (round 13, K8) for a rule that matched nothing and
    // does not fail on it: only a FAILING empty rule was advised (inline,
    // above), so a soft skip was never told how to make it fail or to mark a
    // planned unit.
    for (const a of emptyRuleAdviceLines(results.filter((r) => r.status === 'skipped').map(() => ({ fails: false })))) {
      process.stdout.write(`  ${a}.\n`);
    }
    process.stdout.write(unitNotes.text);
    // A warning-severity rule reports without blocking, but the banner must
    // still say it FIRED. "Every id resolves ✓" printed under a list of
    // unresolved ids is the kind of half-truth that trains people to stop
    // reading the output.
    const warned = failed.filter((r) => r.severity !== 'error');
    const warnedCount = warned.reduce((n, r) => n + r.findings.length, 0);
    const line = verdictLine(
      env,
      warned.length > 0
        ? `${warnedCount} unresolved reference(s) reported by ${warned.length} warning rule(s) — not blocking.`
        : qualifyCleanForUnits('Every id cited in prose resolves. ✓', unitNotes),
      proposed === ExitCode.NotVerified
        ? errored.length > 0
          ? `${errored.length} rule(s) could not run — nothing was proved. This is NOT a pass.`
          : 'Nothing was checked — this is NOT a pass.'
        : undefined,
    );
    if (line) process.stdout.write(`\n${line}\n`);
    return exit;
  },
};

export const docsReferencesExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Show every id-shaped token ONE rule considered: where it was found, whether it resolved, and why a token was skipped.',
  usage: 'shrk docs references explain --id <id> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk docs references explain --id <id>\n');
      return ExitCode.UsageError;
    }
    const forwarded: ParsedArgs = { ...args, flags: new Map(args.flags) };
    forwarded.flags.set('id', id);
    // A rejected pack rule's id is a DECLARED one (K10): `explain` names its
    // rejection — it called the id unknown (a usage error, 3).
    const prep = await prepare(forwarded, { rejectedKnown: true });
    if (!prep.ok) return prep.code;
    const rule = prep.value.rules[0];
    if (!rule) {
      const rejectedRule = prep.value.rejected[0];
      if (rejectedRule === undefined) return writeNoRules(flagBool(args, 'json'));
      if (flagBool(args, 'json')) {
        process.stdout.write(
          asJson({
            schema: 'sharkcraft.doc-references-explain/v1',
            id: rejectedRule.id,
            rejected: true,
            error: rejectedRule.error ?? null,
          }) + '\n',
        );
      } else {
        process.stdout.write(header(`Doc references: ${rejectedRule.id}`));
        writeRejectedDocRules([rejectedRule]);
      }
      // A rule that never loaded cannot be explained: a failure, as every
      // registry verb answers a rejected pack registry.
      return ExitCode.Failure;
    }

    const inspection = await inspectionFor(prep.value.cwd);
    const result = checkDocReferences(prep.value.cwd, rule, inspection, prep.value.excludeDirs);

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.doc-references-explain/v1',
          ...resultJson(result),
          tokens: result.tokens,
          resolvesAs: rule.resolvesAs,
          requireContext: rule.requireContext ?? 'backtick',
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }

    process.stdout.write(header(`Doc references: ${rule.id}`));
    if (rule.description) process.stdout.write(`  ${rule.description}\n`);
    process.stdout.write(kv('files', rule.files.join(', ')) + '\n');
    process.stdout.write(kv('token pattern', `/${rule.tokenPattern}/`) + '\n');
    process.stdout.write(kv('resolves as', rule.resolvesAs.join(', ')) + '\n');
    process.stdout.write(kv('context gate', rule.requireContext ?? 'backtick') + '\n');
    process.stdout.write(kv('docs scanned', String(result.filesScanned)) + '\n');
    process.stdout.write(
      kv('tokens', `${result.tokensChecked} checked, ${result.tokensSkipped} skipped`) + '\n',
    );
    if (result.error) process.stdout.write(`  ! ${result.error}\n`);
    process.stdout.write('\n');
    for (const t of result.tokens.slice(0, 100)) {
      const verdict = t.skipped
        ? `skipped (${t.skipped})`
        : t.resolvedAs
          ? `✓ ${t.resolvedAs}`
          : '✗ UNRESOLVED';
      process.stdout.write(`  ${t.token}  (${t.file}:${t.line})  — ${verdict}\n`);
    }
    if (result.tokens.length > 100) {
      process.stdout.write(`  … (${result.tokens.length - 100} more)\n`);
    }
    return ExitCode.VerifiedPass;
  },
};

export const docsReferencesListCommand: ICommandHandler = {
  name: 'list',
  description: 'List every declared doc-reference rule: its globs, token shape, and target registries.',
  usage: 'shrk docs references list [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    // Round 13 (K10): a pack doc-reference rule the merge seam REJECTED is a
    // declared rule that never runs — listed, as `baseline list` / `gates
    // list` list theirs (it was absent from `list` and unknown to `explain`).
    const rejected = prep.value.rejected;
    if (prep.value.all.length === 0 && rejected.length === 0) return writeNoRules(json);
    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          rules: prep.value.all,
          rejected: rejected.map((r) => ({ id: r.id, error: r.error ?? null })),
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    process.stdout.write(header(`Doc-reference rules (${prep.value.all.length})`));
    for (const r of prep.value.all) {
      process.stdout.write(`  • ${r.id}\n`);
      process.stdout.write(`      files    ${r.files.join(', ')}\n`);
      process.stdout.write(`      token    /${r.tokenPattern}/\n`);
      process.stdout.write(`      resolves ${r.resolvesAs.join(', ')}\n`);
      process.stdout.write(`      context  ${r.requireContext ?? 'backtick'}\n`);
      if (r.description) process.stdout.write(`      ${r.description}\n`);
    }
    writeRejectedDocRules(rejected);
    return ExitCode.VerifiedPass;
  },
};

/** `shrk docs references <verb>` — dispatches to check / explain / list. */
export const docsReferencesCommand: ICommandHandler = {
  name: 'references',
  description:
    'Prose-reference linter: assert every id cited in free text (READMEs, docs, agent skill files) still resolves to a registered id.',
  usage: 'shrk docs references check | explain --id <id> | list',
  // Declared (round 11 review): the dispatcher guard refuses any other token
  // with the closest subverb, `help` and the index see the three verbs, and
  // the declared walk reaches the verdict path — so a bad flag on `docs
  // references check` is a usage error of `docs references check` (3), never
  // one of `docs references` (2).
  positionals: PositionalMode.None,
  subverbs: [
    {
      name: docsReferencesCheckCommand.name,
      description: docsReferencesCheckCommand.description,
      usage: docsReferencesCheckCommand.usage,
      positionals: PositionalMode.None,
    },
    {
      name: docsReferencesExplainCommand.name,
      description: docsReferencesExplainCommand.description,
      usage: docsReferencesExplainCommand.usage,
      positionals: PositionalMode.Free,
    },
    {
      name: docsReferencesListCommand.name,
      description: docsReferencesListCommand.description,
      usage: docsReferencesListCommand.usage,
      positionals: PositionalMode.None,
    },
  ],
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const rest: ParsedArgs = { ...args, positional: args.positional.slice(1) };
    if (sub === 'check') return docsReferencesCheckCommand.run(rest);
    if (sub === 'explain') return docsReferencesExplainCommand.run(rest);
    if (sub === 'list') return docsReferencesListCommand.run(rest);
    // Only a bare `shrk docs references` lands here: the guard refused any
    // other token before this body ran.
    process.stderr.write('Usage: shrk docs references check | explain --id <id> | list\n');
    return ExitCode.UsageError;
  },
};
