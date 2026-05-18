import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildAgentBrief,
  buildPlaybookPreview,
  buildPlaybookScript,
  buildRunbook,
  inspectSharkcraft,
  loadPlaybooks,
  recommendPlaybooks,
  validatePlaybook,
  type IPlaybook,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

async function loadAll(args: ParsedArgs): Promise<{
  playbooks: readonly IPlaybook[];
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>;
}> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const playbooks = await loadPlaybooks(inspection);
  return { playbooks, inspection };
}

export const playbooksListCommand: ICommandHandler = {
  name: 'list',
  description: 'List registered playbooks.',
  usage: 'shrk playbooks list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const { playbooks } = await loadAll(args);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(playbooks) + '\n');
      return 0;
    }
    process.stdout.write(header(`Playbooks (${playbooks.length})`));
    if (playbooks.length === 0) process.stdout.write('  (none)\n');
    for (const p of playbooks) {
      process.stdout.write(`  ${p.id.padEnd(36)} ${p.title}\n`);
    }
    return 0;
  },
};

export const playbooksGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show playbook details.',
  usage: 'shrk playbooks get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk playbooks get <id>\n');
      return 2;
    }
    const { playbooks } = await loadAll(args);
    const p = playbooks.find((x) => x.id === id);
    if (!p) {
      process.stderr.write(`No playbook "${id}"\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(p) + '\n');
      return 0;
    }
    process.stdout.write(header(`Playbook: ${p.id}`));
    if (p.description) process.stdout.write(`${p.description}\n\n`);
    process.stdout.write(`Steps:\n`);
    for (const s of p.steps) {
      process.stdout.write(`  ${s.id}: ${s.title}\n`);
    }
    return 0;
  },
};

export const playbooksRecommendCommand: ICommandHandler = {
  name: 'recommend',
  description: 'Recommend playbooks for a task.',
  usage: 'shrk playbooks recommend "<task>" [--limit N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk playbooks recommend "<task>"\n');
      return 2;
    }
    const { playbooks } = await loadAll(args);
    const recs = recommendPlaybooks(playbooks, task);
    const limit = flagNumber(args, 'limit') ?? 5;
    const top = recs.slice(0, limit);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(top) + '\n');
      return 0;
    }
    process.stdout.write(header(`Playbook recommendations for: ${task}`));
    if (top.length === 0) process.stdout.write('  (none matched)\n');
    for (const r of top) {
      process.stdout.write(`  ${String(r.score).padStart(4)}  ${r.playbook.id}  — ${r.playbook.title}\n`);
      for (const why of r.reasons.slice(0, 3)) {
        process.stdout.write(`        (${why})\n`);
      }
    }
    return 0;
  },
};

export const playbooksRunbookCommand: ICommandHandler = {
  name: 'runbook',
  description: 'Render a playbook as a structured human/agent runbook.',
  usage: 'shrk playbooks runbook <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk playbooks runbook <id>\n');
      return 2;
    }
    const { playbooks } = await loadAll(args);
    const p = playbooks.find((x) => x.id === id);
    if (!p) {
      process.stderr.write(`No playbook "${id}"\n`);
      return 1;
    }
    const rb = buildRunbook(p);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(rb) + '\n');
      return 0;
    }
    process.stdout.write(`# Runbook: ${rb.title}\n\n`);
    for (let i = 0; i < rb.steps.length; i += 1) {
      const s = rb.steps[i]!;
      process.stdout.write(`## Step ${i + 1}: ${s.title}\n`);
      if (s.description) process.stdout.write(`${s.description}\n`);
      if (s.commands?.length) {
        process.stdout.write('\nCommands:\n');
        for (const c of s.commands) process.stdout.write(`  $ ${c}\n`);
      }
      if (s.verificationCommands?.length) {
        process.stdout.write('\nVerify:\n');
        for (const c of s.verificationCommands) process.stdout.write(`  ? ${c}\n`);
      }
      if (s.safetyNotes?.length) {
        process.stdout.write('\nSafety:\n');
        for (const c of s.safetyNotes) process.stdout.write(`  ! ${c}\n`);
      }
      if (s.humanReview) {
        process.stdout.write('\n  (human review required before continuing)\n');
      }
      process.stdout.write('\n');
    }
    return 0;
  },
};

export const playbooksBriefCommand: ICommandHandler = {
  name: 'brief',
  description: 'Render a playbook as an agent brief (Markdown).',
  usage: 'shrk playbooks brief <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk playbooks brief <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const playbooks = await loadPlaybooks(inspection);
    const p = playbooks.find((x) => x.id === id);
    if (!p) {
      process.stderr.write(`No playbook "${id}"\n`);
      return 1;
    }
    const brief = await buildAgentBrief(inspection, { task: p.title });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ playbook: p, brief }) + '\n');
      return 0;
    }
    process.stdout.write(`# Playbook brief: ${p.title}\n\n`);
    process.stdout.write(`Description: ${p.description ?? '(none)'}\n\n`);
    process.stdout.write(`Steps: ${p.steps.length}\n\n`);
    process.stdout.write(`---\n\n${brief.markdown}`);
    return 0;
  },
};

export const playbooksScriptCommand: ICommandHandler = {
  name: 'script',
  description: 'Render a playbook as a bash-like preview script (no execution).',
  usage: 'shrk playbooks script <id> [--task "<task>"] [--output <path>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk playbooks script <id> [--task "<task>"] [--output <path>]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const playbooks = await loadPlaybooks(inspection);
    const p = playbooks.find((x) => x.id === id);
    if (!p) {
      process.stderr.write(`No playbook "${id}"\n`);
      return 1;
    }
    const task = flagString(args, 'task');
    const result = buildPlaybookScript(p, task ? { task } : {});
    const output = flagString(args, 'output');
    if (output) {
      const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, result.script, { mode: 0o755 });
      if (flagBool(args, 'json')) process.stdout.write(asJson({ wrote: abs, ...result }) + '\n');
      else process.stdout.write(`Wrote ${abs}\n`);
      return 0;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
      return 0;
    }
    process.stdout.write(result.script);
    return 0;
  },
};

export const playbooksPreviewCommand: ICommandHandler = {
  name: 'preview',
  description: 'Show a playbook preview (structured steps + recommendations).',
  usage: 'shrk playbooks preview <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk playbooks preview <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const playbooks = await loadPlaybooks(inspection);
    const p = playbooks.find((x) => x.id === id);
    if (!p) {
      process.stderr.write(`No playbook "${id}"\n`);
      return 1;
    }
    const preview = buildPlaybookPreview(p);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(preview) + '\n');
      return 0;
    }
    process.stdout.write(header(`Playbook preview: ${preview.title}`));
    if (preview.description) process.stdout.write(`${preview.description}\n\n`);
    for (let i = 0; i < preview.steps.length; i += 1) {
      const s = preview.steps[i]!;
      process.stdout.write(`Step ${i + 1}: ${s.title}${s.humanReview ? '  (human review)' : ''}\n`);
      if (s.commands.length) for (const c of s.commands) process.stdout.write(`  $ ${c}\n`);
      if (s.mcpTools.length)
        process.stdout.write(`  mcp: ${s.mcpTools.join(', ')}\n`);
      if (s.verificationCommands.length) {
        process.stdout.write(`  verify:\n`);
        for (const v of s.verificationCommands) process.stdout.write(`    ? ${v}\n`);
      }
      if (s.safetyNotes.length) {
        for (const n of s.safetyNotes) process.stdout.write(`  ! ${n}\n`);
      }
    }
    if (preview.outputs.length > 0) {
      process.stdout.write('\nOutputs:\n');
      for (const o of preview.outputs) process.stdout.write(`  - ${o}\n`);
    }
    return 0;
  },
};

export const playbooksValidateCommand: ICommandHandler = {
  name: 'validate',
  description: 'Validate a playbook against the registered templates / pipelines.',
  usage: 'shrk playbooks validate <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk playbooks validate <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const playbooks = await loadPlaybooks(inspection);
    const p = playbooks.find((x) => x.id === id);
    if (!p) {
      process.stderr.write(`No playbook "${id}"\n`);
      return 1;
    }
    const v = validatePlaybook(p, inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(v) + '\n');
      return v.passed ? 0 : 1;
    }
    process.stdout.write(header(`Playbook validate: ${id}`));
    if (v.issues.length === 0) {
      process.stdout.write('No issues.\n');
      return 0;
    }
    for (const i of v.issues) {
      process.stdout.write(`  ${i.severity.toUpperCase().padEnd(8)} ${i.code.padEnd(28)} ${i.message}\n`);
    }
    return v.passed ? 0 : 1;
  },
};

void flagString;
