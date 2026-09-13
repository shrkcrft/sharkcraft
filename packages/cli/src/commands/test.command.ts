import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildTaskPacket,
  inspectSharkcraft,
  loadAgentContractTests,
  loadContextTests,
  nearestIds,
  runAgentContractTest,
  runContextTest,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagList,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { agentTestMissingExpectedHints, renderFailureHints } from '../output/failure-hints.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';
import { warmCliReferenceRegistries } from '../surface/cli-command-resolver.ts';
import { ExitCode } from '../exit-codes.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import type { ISettledVerdict } from '../gates/settled-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';

/**
 * The `--id` selection. An id that selects NOTHING is a usage error (3) — a
 * typo'd id used to print "No … tests configured." and exit 0, a green run
 * over an empty selection.
 */
function selectById<T extends { id: string }>(
  all: readonly T[],
  args: ParsedArgs,
  kind: 'agent' | 'context',
): { tests: readonly T[]; usageError?: string } {
  const filter = flagString(args, 'id');
  if (filter === undefined) return { tests: all };
  const tests = all.filter((t) => t.id === filter);
  if (tests.length > 0) return { tests };
  // An unknown DECLARED id — the same `nearestIds` every other id site uses
  // (`checks --rule`, `checks run`, `self-config resolve`), never the
  // command-typo scorer.
  const near = nearestIds(filter, all.map((t) => t.id)).map((n) => n.id);
  return {
    tests,
    usageError: `no ${kind} test with id '${filter}' (${all.length} configured)${
      near.length > 0 ? ` — did you mean ${near.map((n) => `'${n}'`).join(', ')}?` : ''
    }`,
  };
}

/** Print (or JSON-encode) the `--id` usage error and return 3. */
function writeUsageError(args: ParsedArgs, message: string): number {
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({ tests: 0, results: [], exitCode: ExitCode.UsageError, verdict: 'usage-error', error: message }) + '\n',
    );
  } else {
    process.stderr.write(`\`shrk test\`: ${message}\n`);
  }
  return ExitCode.UsageError;
}

/**
 * Zero tests configured examined nothing — NOT VERIFIED (2), the verdict
 * `shrk quality` gives the same empty gate, unless `--allow-empty` accepts it.
 */
function settleEmptySet(args: ParsedArgs, unit: string, reason: string, root: string): ISettledVerdict {
  return settleVerdict(ExitCode.VerifiedPass, [
    { unit, expected: 0, examined: 0, root, reason, ...allowEmptyValve(args, 0) },
  ]);
}

function writeEmptySet(args: ParsedArgs, title: string, none: string, settled: ISettledVerdict): number {
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        tests: 0,
        results: [],
        exitCode: settled.exit,
        verdict: settled.verdict,
        shortfalls: settled.shortfalls,
        accepted: settled.accepted,
      }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(header(title));
  process.stdout.write(`${none}\n`);
  const line = verdictLine(settled, 'Nothing to test — accepted.');
  if (line) process.stdout.write(line + '\n');
  if (settled.exit === ExitCode.NotVerified) {
    process.stdout.write(`Pass --${ALLOW_EMPTY_FLAG} to accept an empty test set explicitly.\n`);
  }
  return settled.exit;
}

async function runContextTests(args: ParsedArgs): Promise<number> {
  const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
  // Existence answers come from the shared reference registry — warm it.
  await warmCliReferenceRegistries(inspection);
  const all = await loadContextTests(inspection);
  const { tests, usageError } = selectById(all, args, 'context');
  if (usageError) return writeUsageError(args, usageError);
  if (tests.length === 0) {
    const settled = settleEmptySet(
      args,
      'context tests',
      'no context tests configured (sharkcraft/context-tests.ts, or a pack `contextTestFiles` contribution)',
      inspection.projectRoot,
    );
    return writeEmptySet(args, 'Context tests', 'No context tests configured.', settled);
  }
  const results = tests.map((t) => runContextTest(inspection, t));
  const failed = results.filter((r) => !r.passed);
  const settled = settleVerdict(failed.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass, [
    { unit: 'context tests', expected: results.length, examined: results.length },
  ]);
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        total: results.length,
        failed: failed.length,
        exitCode: settled.exit,
        verdict: settled.verdict,
        shortfalls: settled.shortfalls,
        results,
      }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(header(`Context tests (${results.length})`));
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`  ${tag}  ${r.id.padEnd(36)} task: ${r.task}\n`);
    if (!r.passed) {
      if (r.missingInclude.length) {
        process.stdout.write(`         missing must-include: ${r.missingInclude.join(', ')}\n`);
      }
      if (r.unexpectedInclude.length) {
        process.stdout.write(`         unexpected: ${r.unexpectedInclude.join(', ')}\n`);
      }
      for (const d of r.diagnostics ?? []) {
        process.stdout.write(
          `         · ${d.id} (${d.existsInRegistry ? 'exists' : 'missing from registry'}):\n`,
        );
        for (const s of d.suggestions) process.stdout.write(`             - ${s}\n`);
        if (d.topAlternatives?.length) {
          process.stdout.write('             top-ranked instead:\n');
          for (const a of d.topAlternatives.slice(0, 3)) {
            process.stdout.write(
              `               [${a.score}] ${a.id} — ${a.reasons.join('; ')}\n`,
            );
          }
        }
      }
    }
  }
  process.stdout.write(`\nSummary: ${results.length - failed.length}/${results.length} passed.\n`);
  const line = verdictLine(settled, '');
  if (line) process.stdout.write(line + '\n');
  return settled.exit;
}

async function runAgentTests(args: ParsedArgs): Promise<number> {
  const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
  const all = await loadAgentContractTests(inspection);
  const { tests, usageError } = selectById(all, args, 'agent');
  if (usageError) return writeUsageError(args, usageError);
  if (tests.length === 0) {
    const settled = settleEmptySet(
      args,
      'agent tests',
      'no agent contract tests configured (sharkcraft/agent-tests.ts, or a pack `agentTestFiles` contribution)',
      inspection.projectRoot,
    );
    return writeEmptySet(args, 'Agent contract tests', 'No agent contract tests configured.', settled);
  }
  // Warm the shared reference registry WITH the command resolver: existence
  // expectations read the registry `shrk <kind> list` prints, and
  // `expectedCommands` resolve against the live command index.
  await warmCliReferenceRegistries(inspection);
  const results = tests.map((t) => runAgentContractTest(inspection, t));
  const failed = results.filter((r) => !r.passed);
  // A test whose every failing expectation could not be evaluated is NOT
  // VERIFIED — an unexamined unit, never a pass and never a plain failure.
  const notVerified = results.filter((r) => r.verdict === 'not-verified');
  const anyFailed = results.some((r) => r.verdict === 'fail');
  const settled = settleVerdict(anyFailed ? ExitCode.Failure : ExitCode.VerifiedPass, [
    {
      unit: 'agent tests',
      expected: results.length,
      examined: results.length - notVerified.length,
      ...(notVerified.length > 0
        ? {
            unexamined: notVerified.slice(0, 20).map((r) => r.id),
            unexaminedTotal: notVerified.length,
            reason: 'an expectation could not be evaluated',
          }
        : {}),
    },
  ]);
  const exit = settled.exit;
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        total: results.length,
        failed: failed.length,
        notVerified: notVerified.length,
        exitCode: exit,
        verdict: settled.verdict,
        shortfalls: settled.shortfalls,
        results,
      }) + '\n',
    );
    return exit;
  }
  process.stdout.write(header(`Agent contract tests (${results.length})`));
  for (const r of results) {
    const tag = r.passed ? 'PASS' : r.verdict === 'not-verified' ? 'N/V ' : 'FAIL';
    process.stdout.write(`  ${tag}  ${r.id.padEnd(36)} task: ${r.task}\n`);
    if (!r.passed) {
      if ((r.unverified ?? []).length)
        process.stdout.write(`         NOT VERIFIED: ${r.unverified!.join(', ')}\n`);
      if (r.expectedPipeline) {
        process.stdout.write(`         expected pipeline: ${r.expectedPipeline}\n`);
        process.stdout.write(`         actual pipelines:  ${r.actualPipelines?.join(', ') ?? '(none)'}\n`);
      }
      if ((r.missingTemplates ?? []).length)
        process.stdout.write(`         missing templates: ${r.missingTemplates!.join(', ')}\n`);
      if ((r.missingRules ?? []).length)
        process.stdout.write(`         missing rules: ${r.missingRules!.join(', ')}\n`);
      if ((r.missingForbiddenActions ?? []).length)
        process.stdout.write(`         missing forbidden: ${r.missingForbiddenActions!.join('; ')}\n`);
      if ((r.missingVerificationCommands ?? []).length)
        process.stdout.write(`         missing verification: ${r.missingVerificationCommands!.join('; ')}\n`);
      if ((r.missingHelpers ?? []).length)
        process.stdout.write(`         missing helpers: ${r.missingHelpers!.join(', ')}\n`);
      if ((r.missingPlaybooks ?? []).length)
        process.stdout.write(`         missing playbooks: ${r.missingPlaybooks!.join(', ')}\n`);
      if ((r.missingPolicies ?? []).length)
        process.stdout.write(`         missing policies: ${r.missingPolicies!.join(', ')}\n`);
      if ((r.missingConstructs ?? []).length)
        process.stdout.write(`         missing constructs: ${r.missingConstructs!.join(', ')}\n`);
      if ((r.missingCommands ?? []).length)
        process.stdout.write(`         missing commands: ${r.missingCommands!.join(', ')}\n`);
      if ((r.missingKnowledge ?? []).length)
        process.stdout.write(`         missing knowledge: ${r.missingKnowledge!.join(', ')}\n`);
      if ((r.unexpectedlyIncluded ?? []).length)
        process.stdout.write(`         unexpectedly included: ${r.unexpectedlyIncluded!.join(', ')}\n`);
      for (const d of r.diagnostics ?? []) {
        const why = d.code ?? (d.existsInRegistry ? 'exists' : 'missing from registry');
        const where = d.consulted
          ? ` — ${d.assertion ?? 'check'} · consulted ${d.consulted.kind} (${d.consulted.listVerb}${d.consulted.kind === 'command' ? '' : `, ${d.consulted.size} ids`})`
          : '';
        process.stdout.write(`         · ${d.kind}: ${d.id} (${why})${where}:\n`);
        for (const s of d.suggestions) process.stdout.write(`             - ${s}\n`);
      }
    }
  }
  process.stdout.write(`\nSummary: ${results.length - failed.length}/${results.length} passed.\n`);
  // Surface explain/why hints when a failure lists an expected construct the
  // packet didn't include — that's the case the `shrk why`/`why-not` family
  // is built to diagnose.
  const anyMissingExpected = failed.some(
    (r) =>
      (r.missingTemplates ?? []).length > 0 ||
      (r.missingRules ?? []).length > 0 ||
      (r.missingForbiddenActions ?? []).length > 0 ||
      (r.missingVerificationCommands ?? []).length > 0 ||
      (r.missingHelpers ?? []).length > 0 ||
      (r.missingPlaybooks ?? []).length > 0 ||
      (r.missingPolicies ?? []).length > 0 ||
      (r.missingConstructs ?? []).length > 0 ||
      (r.missingCommands ?? []).length > 0 ||
      (r.missingKnowledge ?? []).length > 0,
  );
  if (anyMissingExpected) {
    process.stdout.write(renderFailureHints(agentTestMissingExpectedHints()));
  }
  const line = verdictLine(
    settled,
    '',
    exit === ExitCode.NotVerified ? 'Some expectations could not be evaluated (see NOT VERIFIED above).' : undefined,
  );
  if (line) process.stdout.write(line + '\n');
  return exit;
}

async function generateContextTest(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim();
  if (!task) {
    process.stderr.write('Usage: shrk test generate context "<task>"\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const packet = buildTaskPacket(inspection, task, { maxTokens: 3000 });
  const id = `inferred.context.${slug(task)}`;
  const body = renderContextTestDraft(id, task, packet);
  return writeDraft(args, cwd, 'context-tests.draft.ts', body, { id, task });
}

async function generateAgentTest(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim();
  if (!task) {
    process.stderr.write(
      'Usage: shrk test generate agent "<task>" [--pipeline <id>] [--template <id>] [--rule <id>]\n',
    );
    return 2;
  }
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const packet = buildTaskPacket(inspection, task, { maxTokens: 3000 });
  const id = `inferred.agent.${slug(task)}`;
  const pipeline = flagString(args, 'pipeline') ?? packet.recommendedPipelines[0]?.pipelineId;
  const templates = flagList(args, 'template');
  const rules = flagList(args, 'rule');
  const templatePicks =
    templates.length > 0 ? templates : packet.relevantTemplates.slice(0, 3).map((t) => t.id);
  const rulePicks =
    rules.length > 0 ? rules : packet.relevantRules.slice(0, 3).map((r) => r.id);
  const body = renderAgentTestDraft(id, task, {
    pipeline: pipeline ?? undefined,
    templates: templatePicks,
    rules: rulePicks,
    forbiddenActions: packet.forbiddenActions,
    verificationCommands: packet.verificationCommands,
  });
  return writeDraft(args, cwd, 'agent-tests.draft.ts', body, { id, task });
}

function writeDraft(
  args: ParsedArgs,
  cwd: string,
  filename: string,
  body: string,
  summary: { id: string; task: string },
): number {
  const wantJson = flagBool(args, 'json');
  const wantWrite = flagBool(args, 'write');
  const outDir = nodePath.join(cwd, 'sharkcraft', 'test-drafts');
  const outFile = nodePath.join(outDir, filename);

  if (!wantWrite) {
    if (wantJson) {
      process.stdout.write(asJson({ mode: 'dry-run', outFile, ...summary, bytes: body.length }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Test draft (dry-run): ${summary.id}`));
    process.stdout.write(kv('outFile', outFile) + '\n');
    process.stdout.write(kv('task', summary.task) + '\n\n');
    process.stdout.write(body);
    return 0;
  }
  mkdirSync(outDir, { recursive: true });
  if (!outFile.startsWith(outDir + nodePath.sep)) {
    process.stderr.write('Refusing to write outside test-drafts dir.\n');
    return 1;
  }
  writeFileSync(outFile, body, 'utf8');
  if (wantJson) {
    process.stdout.write(asJson({ mode: 'write', outFile, ...summary, bytes: body.length }) + '\n');
    return 0;
  }
  process.stdout.write(header(`Test draft written: ${summary.id}`));
  process.stdout.write(kv('outFile', outFile) + '\n');
  return 0;
}

function renderContextTestDraft(
  id: string,
  task: string,
  packet: { relevantRules: readonly { id: string }[]; relevantTemplates: readonly { id: string }[] },
): string {
  const lines: string[] = [];
  lines.push('// Context-test draft. Move into sharkcraft/context-tests.ts after review.');
  lines.push('export default [');
  lines.push(`  {`);
  lines.push(`    id: '${id}',`);
  lines.push(`    task: ${JSON.stringify(task)},`);
  lines.push(`    mustInclude: [`);
  for (const r of packet.relevantRules.slice(0, 5)) {
    lines.push(`      '${r.id}',`);
  }
  for (const t of packet.relevantTemplates.slice(0, 3)) {
    lines.push(`      '${t.id}',`);
  }
  lines.push(`    ],`);
  lines.push(`    mustNotInclude: [],`);
  lines.push(`  },`);
  lines.push('];');
  return lines.join('\n') + '\n';
}

function renderAgentTestDraft(
  id: string,
  task: string,
  picks: {
    pipeline?: string | undefined;
    templates: readonly string[];
    rules: readonly string[];
    forbiddenActions: readonly string[];
    verificationCommands: readonly string[];
  },
): string {
  const lines: string[] = [];
  lines.push('// Agent-contract test draft. Move into sharkcraft/agent-tests.ts after review.');
  lines.push('export default [');
  lines.push(`  {`);
  lines.push(`    id: '${id}',`);
  lines.push(`    task: ${JSON.stringify(task)},`);
  if (picks.pipeline) lines.push(`    expectedPipeline: '${picks.pipeline}',`);
  lines.push(`    expectedTemplates: ${JSON.stringify(picks.templates)},`);
  lines.push(`    expectedRules: ${JSON.stringify(picks.rules)},`);
  if (picks.forbiddenActions.length > 0) {
    lines.push(`    expectedForbiddenActions: ${JSON.stringify([...picks.forbiddenActions])},`);
  }
  if (picks.verificationCommands.length > 0) {
    lines.push(
      `    expectedVerificationCommands: ${JSON.stringify([...picks.verificationCommands])},`,
    );
  }
  lines.push(`  },`);
  lines.push('];');
  return lines.join('\n') + '\n';
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export const testCommand: ICommandHandler = {
  name: 'test',
  positionals: PositionalMode.None,
  subverbs: [
    { name: 'context', description: 'Run the context regression tests.', usage: 'shrk test context [--id <id>] [--allow-empty] [--json]' },
    { name: 'agent', description: 'Run the agent-contract tests.', usage: 'shrk test agent [--id <id>] [--allow-empty] [--watch] [--json]' },
    {
      name: 'generate',
      description: 'Generate a context or agent test from a task.',
      usage: 'shrk test generate <context|agent> "<task>" [--write]',
      positionals: PositionalMode.None,
      subverbs: [
        { name: 'context', description: 'Generate a context test.', usage: 'shrk test generate context "<task>" [--write]', positionals: PositionalMode.Free },
        { name: 'agent', description: 'Generate an agent test.', usage: 'shrk test generate agent "<task>" [--write]', positionals: PositionalMode.Free },
      ],
    },
  ],
  description:
    'Run or generate SharkCraft regression tests: `test context` / `test agent`, or `test generate context|agent "<task>"`.',
  usage:
    'shrk [--cwd <dir>] test <context|agent|generate> [args...] [--id <id>] [--allow-empty] [--json]',
  // `--allow-empty` never swallows a following positional.
  booleanFlags: new Set(['json', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const sliced = { ...args, positional: args.positional.slice(1) };
    if (sub === 'context') return runContextTests(sliced);
    if (sub === 'agent') {
      const watchExit = await maybeRunInWatchMode(sliced, runAgentTests);
      if (watchExit !== null) return watchExit;
      return runAgentTests(sliced);
    }
    if (sub === 'generate') {
      const which = args.positional[1];
      const sliced2 = { ...args, positional: args.positional.slice(2) };
      if (which === 'context') return generateContextTest(sliced2);
      if (which === 'agent') return generateAgentTest(sliced2);
      process.stderr.write(
        'Usage: shrk test generate <context|agent> "<task>" [--write]\n',
      );
      return 2;
    }
    process.stderr.write('Usage: shrk test <context|agent|generate> [--id <id>]\n');
    return 2;
  },
};
