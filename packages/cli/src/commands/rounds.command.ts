/**
 * `shrk rounds capture` and `shrk diff rounds`.
 *
 * The rounds verb captures a snapshot of the engine surface (commands,
 * MCP tools, docs) at HEAD and persists it under
 * `.sharkcraft/rounds/<id>/`. The diff verb compares two snapshots and
 * answers the "what shipped in round X vs round Y?" question without
 * scraping git logs.
 */
// DX#4 — `ALL_TOOLS_FOR_AUDIT` was deleted; project ALL_TOOLS inline.
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import {
  captureRoundSnapshot,
  diffRounds as diffRoundSnapshots,
  listRoundIds,
  loadRoundSnapshot,
  renderRoundsDiffMarkdown,
  writeRoundSnapshot,
  type IRoundCommandEntry,
  type IRoundToolEntry,
} from '@shrkcrft/inspector';
import { COMMAND_CATALOG } from './command-catalog.ts';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

function collectCommandsFromCatalog(): IRoundCommandEntry[] {
  return COMMAND_CATALOG.map((e) => ({
    name: e.command,
    description: e.description,
  }));
}

function collectMcpTools(): IRoundToolEntry[] {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
  }));
}

export const roundsCaptureCommand: ICommandHandler = {
  name: 'capture',
  description:
    'Capture a snapshot of the engine surface at HEAD under .sharkcraft/rounds/<id>/.',
  usage: 'shrk rounds capture --id <id> [--title <text>] [--json]',
  run(args: ParsedArgs): number {
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk rounds capture --id <id> [--title <text>] [--json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const title = flagString(args, 'title') ?? undefined;
    const snapshot = captureRoundSnapshot({
      projectRoot: cwd,
      id,
      ...(title ? { title } : {}),
      commands: collectCommandsFromCatalog(),
      mcpTools: collectMcpTools(),
    });
    const { snapshotFile, metaFile } = writeRoundSnapshot(cwd, snapshot);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ snapshot, files: { snapshotFile, metaFile } }) + '\n');
    } else {
      process.stdout.write(header(`Round snapshot ${id}`));
      process.stdout.write(`  commands:  ${snapshot.commands.length}\n`);
      process.stdout.write(`  mcp tools: ${snapshot.mcpTools.length}\n`);
      process.stdout.write(`  docs:      ${snapshot.docs.length}\n`);
      process.stdout.write(`  files:\n    ${snapshotFile}\n    ${metaFile}\n`);
    }
    return 0;
  },
};

export const roundsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List captured round snapshots.',
  usage: 'shrk rounds list [--json]',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    const ids = listRoundIds(cwd);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ rounds: ids }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Captured rounds (${ids.length})`));
    if (ids.length === 0) {
      process.stdout.write('  (none — run `shrk rounds capture --id <id>`)\n');
    } else {
      for (const id of ids) process.stdout.write(`  • ${id}\n`);
    }
    return 0;
  },
};

export const roundsShowCommand: ICommandHandler = {
  name: 'show',
  description: 'Print one captured round snapshot.',
  usage: 'shrk rounds show <id> [--json]',
  run(args: ParsedArgs): number {
    const id = args.positional[0] ?? flagString(args, 'id');
    if (!id) {
      process.stderr.write('Usage: shrk rounds show <id> [--json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const snap = loadRoundSnapshot(cwd, id);
    if (!snap) {
      if (flagBool(args, 'json')) {
        process.stdout.write(
          asJson({ ok: false, error: 'round-not-found', id }) + '\n',
        );
      } else {
        process.stderr.write(`No snapshot found for round "${id}".\n`);
      }
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(snap) + '\n');
      return 0;
    }
    process.stdout.write(header(`Round ${snap.id}${snap.title ? ` — ${snap.title}` : ''}`));
    process.stdout.write(`  capturedAt: ${snap.capturedAt}\n`);
    process.stdout.write(`  commands:   ${snap.commands.length}\n`);
    process.stdout.write(`  mcp tools:  ${snap.mcpTools.length}\n`);
    process.stdout.write(`  docs:       ${snap.docs.length}\n`);
    return 0;
  },
};

export const diffParentCommand: ICommandHandler = {
  name: 'diff',
  description:
    'Diff two artifacts. Currently supports `diff rounds` for round-to-round snapshot diffs.',
  usage: 'shrk diff rounds --from <id> --to <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'rounds') {
      const rest: ParsedArgs = { ...args, positional: args.positional.slice(1) };
      return diffRoundsCommand.run(rest);
    }
    process.stderr.write('Usage: shrk diff rounds --from <id> --to <id> [--json]\n');
    return 2;
  },
};

export const roundsParentCommand: ICommandHandler = {
  name: 'rounds',
  description: 'Capture / list / show round snapshots under .sharkcraft/rounds/.',
  usage: 'shrk rounds [capture|list|show] [args]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const rest: ParsedArgs = { ...args, positional: args.positional.slice(1) };
    if (sub === 'capture') return roundsCaptureCommand.run(rest);
    if (sub === 'list') return roundsListCommand.run(rest);
    if (sub === 'show') return roundsShowCommand.run(rest);
    process.stderr.write('Usage: shrk rounds [capture|list|show] [args]\n');
    return 2;
  },
};

export const diffRoundsCommand: ICommandHandler = {
  name: 'rounds',
  description: 'Diff two captured round snapshots — what shipped in the target round vs the baseline.',
  usage: 'shrk diff rounds --from <id> --to <id> [--json]',
  run(args: ParsedArgs): number {
    const fromId = flagString(args, 'from');
    const toId = flagString(args, 'to');
    if (!fromId || !toId) {
      process.stderr.write('Usage: shrk diff rounds --from <id> --to <id> [--json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const fromSnap = loadRoundSnapshot(cwd, fromId);
    const toSnap = loadRoundSnapshot(cwd, toId);
    const wantJson = flagBool(args, 'json');
    if (!fromSnap || !toSnap) {
      const missing = !fromSnap ? fromId : toId;
      if (wantJson) {
        process.stdout.write(
          asJson({ ok: false, error: 'round-not-found', missing }) + '\n',
        );
      } else {
        process.stderr.write(
          `No snapshot found for round "${missing}". Capture it with \`shrk rounds capture --id ${missing}\`.\n`,
        );
      }
      return 1;
    }
    const diff = diffRoundSnapshots(fromSnap, toSnap);
    if (wantJson) {
      process.stdout.write(asJson(diff) + '\n');
      return 0;
    }
    process.stdout.write(renderRoundsDiffMarkdown(diff));
    return 0;
  },
};
