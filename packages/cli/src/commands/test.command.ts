import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildTaskPacket,
  inspectSharkcraft,
  loadAgentContractTests,
  loadContextTests,
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
import { asJson, header, kv } from '../output/format-output.ts';
import { agentTestMissingExpectedHints, renderFailureHints } from '../output/failure-hints.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';

async function runContextTests(args: ParsedArgs): Promise<number> {
  const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
  const all = await loadContextTests(inspection);
  const filter = flagString(args, 'id');
  const tests = filter ? all.filter((t) => t.id === filter) : all;
  if (tests.length === 0) {
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ tests: 0, results: [] }) + '\n');
      return 0;
    }
    process.stdout.write(header('Context tests'));
    process.stdout.write('No context tests configured.\n');
    return 0;
  }
  const results = tests.map((t) => runContextTest(inspection, t));
  const failed = results.filter((r) => !r.passed);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({ total: results.length, failed: failed.length, results }) + '\n');
    return failed.length > 0 ? 1 : 0;
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
  return failed.length > 0 ? 1 : 0;
}

async function runAgentTests(args: ParsedArgs): Promise<number> {
  const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
  const all = await loadAgentContractTests(inspection);
  const filter = flagString(args, 'id');
  const tests = filter ? all.filter((t) => t.id === filter) : all;
  if (tests.length === 0) {
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ tests: 0, results: [] }) + '\n');
      return 0;
    }
    process.stdout.write(header('Agent contract tests'));
    process.stdout.write('No agent contract tests configured.\n');
    return 0;
  }
  // Pre-load policy / construct / playbook id sets so the runner can
  // evaluate strict expectations accurately.
  const { loadAgentContractRegistries } = await import('@shrkcrft/inspector');
  const registries = await loadAgentContractRegistries(inspection);
  const results = tests.map((t) => runAgentContractTest(inspection, t, registries));
  const failed = results.filter((r) => !r.passed);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({ total: results.length, failed: failed.length, results }) + '\n');
    return failed.length > 0 ? 1 : 0;
  }
  process.stdout.write(header(`Agent contract tests (${results.length})`));
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`  ${tag}  ${r.id.padEnd(36)} task: ${r.task}\n`);
    if (!r.passed) {
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
        process.stdout.write(
          `         · ${d.kind}: ${d.id} (${d.existsInRegistry ? 'exists' : 'missing from registry'}):\n`,
        );
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
  return failed.length > 0 ? 1 : 0;
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
  description:
    'Run or generate SharkCraft regression tests: `test context` / `test agent`, or `test generate context|agent "<task>"`.',
  usage:
    'shrk [--cwd <dir>] test <context|agent|generate> [args...] [--id <id>] [--json]',
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
