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
import type { IDocReferenceRule } from '@shrkcrft/core';
import {
  checkDocReferences,
  inspectSharkcraft,
  warmReferenceRegistries,
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
import { ExitCode } from '../exit-codes.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { buildGateEnvelope } from '../gates/gate-envelope.ts';

const SCHEMA = 'sharkcraft.doc-references/v1';

interface IPrepared {
  readonly cwd: string;
  readonly rules: readonly IDocReferenceRule[];
  readonly all: readonly IDocReferenceRule[];
  readonly excludeDirs: string[];
  readonly planeDiagnostics: readonly string[];
}

async function prepare(
  args: ParsedArgs,
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
  const rel = nodePath.relative(cwd, loaded.value.sharkcraftDir).split(nodePath.sep).join('/');

  let rules = all;
  const id = flagString(args, 'id');
  if (id) {
    const wanted = id.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(all.map((r) => r.id));
    const unknown = wanted.filter((w) => !known.has(w));
    if (unknown.length > 0) {
      process.stderr.write(
        `Unknown doc-reference rule id(s): ${unknown.join(', ')}. Declared: ${[...known].join(', ') || '(none)'}\n`,
      );
      return { ok: false, code: ExitCode.UsageError };
    }
    rules = all.filter((r) => wanted.includes(r.id));
  }

  return {
    ok: true,
    value: {
      cwd,
      rules,
      all,
      excludeDirs: rel && !rel.startsWith('..') ? [rel] : [],
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
  await warmReferenceRegistries(inspection);
  return inspection;
}

function writeNoRules(json: boolean): number {
  if (json) {
    process.stdout.write(asJson({ schema: SCHEMA, results: [], evaluated: 0, verdict: 'not-verified' }) + '\n');
    return ExitCode.NotVerified;
  }
  process.stdout.write(header('Doc references'));
  process.stdout.write(
    '  No doc-reference rules declared. Add `docReferences[]` to sharkcraft.config.ts to\n' +
      '  catch ids cited in prose (READMEs, docs, agent skill files) that no longer resolve\n' +
      '  (see docs/doc-references.md).\n',
  );
  return ExitCode.NotVerified;
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

export const docsReferencesCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Scan configured docs for id-shaped tokens and assert each resolves to a registered id. Catches a README or skill file citing a template that no longer exists.',
  usage: 'shrk docs references check [--id <ids>] [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const prep = await prepare(args);
    if (!prep.ok) return prep.code;
    const json = flagBool(args, 'json');
    if (prep.value.rules.length === 0) return writeNoRules(json);

    const inspection = await inspectionFor(prep.value.cwd);
    const results = prep.value.rules.map((r) =>
      checkDocReferences(prep.value.cwd, r, inspection, prep.value.excludeDirs),
    );

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
    const exit =
      blocking.length > 0
        ? ExitCode.Failure
        : evaluated === 0 || skipped > 0
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;

    if (json) {
      process.stdout.write(
        asJson({
          schema: SCHEMA,
          results: results.map(resultJson),
          evaluated,
          skipped,
          verdict: blocking.length > 0 ? 'errors' : evaluated === 0 ? 'not-verified' : 'pass',
          diagnostics: prep.value.planeDiagnostics,
          exitCode: exit,
          gate: buildGateEnvelope(
            'docs references check',
            exit,
            results.map((r) => ({
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
            })),
          ),
        }) + '\n',
      );
      return exit;
    }

    process.stdout.write(header('Doc references'));
    process.stdout.write(kv('evaluated', `${evaluated} of ${prep.value.rules.length}`) + '\n');
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
        process.stdout.write(
          `  ✓ ${r.ruleId}  (${r.tokensChecked} reference(s) across ${r.filesScanned} doc(s) all resolve)\n`,
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
          '      Nothing was checked, so nothing was enforced. Fix the glob, or set\n' +
            '      `failOnEmpty: false` if this rule may legitimately cover no docs.\n',
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
    for (const d of prep.value.planeDiagnostics) process.stdout.write(`  ! ${d}\n`);
    // A warning-severity rule reports without blocking, but the banner must
    // still say it FIRED. "Every id resolves ✓" printed under a list of
    // unresolved ids is the kind of half-truth that trains people to stop
    // reading the output.
    const warned = failed.filter((r) => r.severity !== 'error');
    if (exit === ExitCode.VerifiedPass && warned.length > 0) {
      const count = warned.reduce((n, r) => n + r.findings.length, 0);
      process.stdout.write(
        `\n${count} unresolved reference(s) reported by ${warned.length} warning rule(s) — not blocking.\n`,
      );
    } else if (exit === ExitCode.VerifiedPass) {
      process.stdout.write('\nEvery id cited in prose resolves. ✓\n');
    } else if (exit === ExitCode.NotVerified) {
      process.stdout.write(
        errored.length > 0
          ? `\n${errored.length} rule(s) could not run — nothing was proved. This is NOT a pass.\n`
          : '\nNothing was checked — this is NOT a pass.\n',
      );
    }
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
    const prep = await prepare(forwarded);
    if (!prep.ok) return prep.code;
    const rule = prep.value.rules[0];
    if (!rule) return writeNoRules(flagBool(args, 'json'));

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
    if (prep.value.all.length === 0) return writeNoRules(json);
    if (json) {
      process.stdout.write(asJson({ schema: SCHEMA, rules: prep.value.all }) + '\n');
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
    return ExitCode.VerifiedPass;
  },
};

/** `shrk docs references <verb>` — dispatches to check / explain / list. */
export const docsReferencesCommand: ICommandHandler = {
  name: 'references',
  description:
    'Prose-reference linter: assert every id cited in free text (READMEs, docs, agent skill files) still resolves to a registered id.',
  usage: 'shrk docs references check | explain --id <id> | list',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const rest: ParsedArgs = { ...args, positional: args.positional.slice(1) };
    if (sub === 'check') return docsReferencesCheckCommand.run(rest);
    if (sub === 'explain') return docsReferencesExplainCommand.run(rest);
    if (sub === 'list') return docsReferencesListCommand.run(rest);
    process.stderr.write(
      (sub ? `Unknown subcommand "${sub}". ` : '') +
        'Usage: shrk docs references check | explain --id <id> | list\n',
    );
    return ExitCode.UsageError;
  },
};
