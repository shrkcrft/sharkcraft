import type { CommandRegistry } from '../command-registry.ts';
import { header } from '../output/format-output.ts';

/**
 * Short product start screen for bare `shrk` / `shrk --help`. Pruned
 * to the core tier set; extended verbs live one link away via
 * `shrk surface list`.
 *
 * Returns the lines (without trailing newline). Pulled into a function
 * so tests can assert on the structure without grepping stdout.
 */
export function renderStartScreen(): string {
  const lines: string[] = [];
  lines.push('SharkCraft CLI — deterministic, local-first project intelligence for AI coding agents.');
  lines.push('Usage: shrk [--cwd <dir>] <command> [...args]');
  lines.push('');
  lines.push('Core (always on):');
  lines.push('  $ shrk recommend "<task>"        — what should I do?');
  lines.push('  $ shrk doctor                    — is the workspace healthy?');
  lines.push('  $ shrk context --task "<task>"   — focused context for a task');
  lines.push('  $ shrk init                      — create sharkcraft/ + config skeleton');
  lines.push('  $ shrk check boundaries          — boundary enforcement');
  lines.push('  $ shrk surface list              — every command grouped by tier');
  lines.push('');
  lines.push('Discover the rest (extended tier — always callable):');
  lines.push('  $ shrk surface list              — full surface, grouped by tier and profile');
  lines.push('  $ shrk surface profiles          — named profiles (small-app / monorepo / ci / agent / pack-author)');
  lines.push('  $ shrk surface explain <cmd>     — why a command has its current tier');
  lines.push('  $ shrk help <command>            — usage for a specific command');
  lines.push('  $ shrk --full-help               — the long, exhaustive help');
  lines.push('  $ shrk --about                   — what shrk is and is not');
  lines.push('');
  lines.push('Free-form input is fine — `shrk "<task>"` routes to `shrk recommend`.');
  return lines.join('\n') + '\n';
}

export function makeHelpCommand(registry: CommandRegistry) {
  return {
    name: 'help',
    description: 'Show CLI help. Bare `shrk help` prints a short start screen — pass `--full` for the long catalog.',
    usage: 'shrk help [<command>] [--full]',
    run(args: { positional: string[]; flags: Map<string, string | boolean> }): number {
      const requested = args.positional[0];
      const wantsFull =
        args.flags.get('full') === true ||
        args.flags.get('verbose') === true ||
        args.flags.get('full-help') === true;
      if (requested) {
        // Multi-segment help. `shrk help "pack author"` or
        // positional args ["pack", "author"] resolve through the trie.
        const tokens = args.positional[0]?.includes(' ')
          ? args.positional[0]!.split(/\s+/).filter(Boolean)
          : args.positional.filter(Boolean);
        const { handler, matchedPath, node } = registry.resolve(tokens);
        if (handler && matchedPath.join(' ') === tokens.join(' ')) {
          // Exact match on a callable command.
          const canonical = registry.listCommandAliases().get(tokens[0]!);
          process.stdout.write(`${matchedPath.join(' ')} — ${handler.description}\n${handler.usage}\n`);
          if (canonical && tokens.length === 1) {
            process.stdout.write(`(alias for: ${canonical})\n`);
          }
          return 0;
        }
        if (node.children.size > 0) {
          // It's a group (with or without its own handler). List children.
          const aliasNote =
            matchedPath.length === 1 && registry.listGroupAliases().get(tokens[0]!) !== undefined
              ? ` (alias for: ${registry.listGroupAliases().get(tokens[0]!)})`
              : '';
          const groupLabel = matchedPath.length > 0 ? matchedPath.join(' ') : tokens.join(' ');
          process.stdout.write(header(`shrk ${groupLabel}${aliasNote}`));
          if (handler) {
            process.stdout.write(`  (this group is itself callable)\n`);
            process.stdout.write(`  ${groupLabel.padEnd(20)} — ${handler.description}\n`);
            process.stdout.write(`      ${handler.usage}\n\n`);
          }
          for (const [name, child] of node.children) {
            if (child.handler) {
              process.stdout.write(`  ${groupLabel} ${name.padEnd(12)} — ${child.handler.description}\n`);
              process.stdout.write(`      ${child.handler.usage}\n`);
            } else if (child.children.size > 0) {
              // Nested subgroup — show one-line summary.
              const verbList = [...child.children.keys()].slice(0, 4).join(', ');
              process.stdout.write(`  ${groupLabel} ${name.padEnd(12)} — subgroup: ${verbList}…\n`);
            }
          }
          return 0;
        }
        process.stderr.write(`Unknown command: ${tokens.join(' ')}\n`);
        return 1;
      }
      if (!wantsFull) {
        process.stdout.write(renderStartScreen());
        return 0;
      }
      process.stdout.write(`SharkCraft CLI — structured project intelligence for AI coding agents\n`);
      process.stdout.write(`Usage: shrk [--cwd <dir>] <command> [...args]\n`);

      process.stdout.write(header('Top-level commands'));
      for (const c of registry.list()) {
        process.stdout.write(`  ${c.name.padEnd(10)} — ${c.description}\n`);
      }

      // Show each canonical group once.
      const canonicalGroups: string[] = [];
      const aliasMap = registry.listGroupAliases();
      const seen = new Set<string>();
      for (const g of registry.listGroups()) {
        const canonical = aliasMap.get(g) ?? g;
        if (!seen.has(canonical)) {
          seen.add(canonical);
          canonicalGroups.push(canonical);
        }
      }
      const aliasesByCanonical = new Map<string, string[]>();
      for (const [alias, canonical] of aliasMap.entries()) {
        const list = aliasesByCanonical.get(canonical) ?? [];
        list.push(alias);
        aliasesByCanonical.set(canonical, list);
      }
      for (const group of canonicalGroups) {
        const aliases = aliasesByCanonical.get(group) ?? [];
        const aliasNote = aliases.length ? ` (also: ${aliases.join(', ')})` : '';
        process.stdout.write(header(`shrk ${group} <sub>${aliasNote}`));
        for (const s of registry.listGroup(group)) {
          process.stdout.write(`  ${group} ${s.name.padEnd(10)} — ${s.description}\n`);
        }
      }
      process.stdout.write('\nRun `shrk help <command>` for detailed usage.\n');
      return 0;
    },
  };
}
