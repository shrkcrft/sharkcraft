import type { CommandRegistry } from '../command-registry.ts';
import { header } from '../output/format-output.ts';
import { COMMAND_CATALOG, defaultShowInHelp, listExplainFamily } from './command-catalog.ts';

/** First sentence of a catalog description, for the compact explain-family list. */
function firstSentence(description: string): string {
  const dot = description.indexOf('. ');
  const head = dot > 0 ? description.slice(0, dot + 1) : description;
  return head.length > 100 ? head.slice(0, 97).trimEnd() + '…' : head;
}

const EXTRA_HELP_LINES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  graph: [
    '',
    'Code-intelligence subverbs:',
    '  graph index      — build or refresh the code graph',
    '  graph status     — freshness, counts, and unresolved-import summary',
    '  graph search     — find files/symbols/packages in the code graph',
    '  graph context    — inspect one file or symbol with bridge enrichment',
    '  graph impact     — reverse dependent closure for a file or symbol',
    '  graph callers    — files that call/reference a symbol',
    '  graph cycles     — list import cycles',
    '  graph unresolved — list unresolved imports grouped by file',
    '  graph deps       — inbound/outbound package dependencies',
    '  graph why        — shortest-path explanation in the knowledge graph',
  ],
});

/**
 * Product start screen for bare `shrk` / `shrk --help`. Shows the
 * curated ~20-command "starter" surface organized by workflow phase.
 * Everything else stays callable; users see the full ~70-verb catalog
 * via `shrk --full-help` or browse it through `shrk surface list`.
 *
 * Returns the lines (without trailing newline). Pulled into a function
 * so tests can assert on the structure without grepping stdout.
 */
export function renderStartScreen(): string {
  const lines: string[] = [];
  lines.push('SharkCraft CLI — deterministic, local-first project intelligence for AI coding agents.');
  lines.push('Usage: shrk [--cwd <dir>] <command> [...args]');
  lines.push('');
  lines.push('Bootstrap:');
  lines.push('  $ shrk init --infer --write      — scan the repo + populate sharkcraft/ from real signals (new repos)');
  lines.push('  $ shrk doctor                    — is the workspace healthy?');
  lines.push('  $ shrk onboard                   — analyze an existing repo (advisory)');
  lines.push('');
  lines.push('Use it for a task:');
  lines.push('  $ shrk recommend "<task>"        — what should I do?');
  lines.push('  $ shrk context --task "<task>"   — token-budgeted relevant context');
  lines.push('  $ shrk task "<task>"             — full AI-ready task packet (JSON)');
  lines.push('  $ shrk why <file>                — which rules govern this file');
  lines.push('  $ shrk impact <file>             — blast radius: what breaks if I change this');
  lines.push('');
  lines.push('Generate code safely:');
  lines.push('  $ shrk gen <template> <name>     — generate from template (dry-run by default)');
  lines.push('  $ shrk apply <plan.json>         — apply a reviewed plan (CLI is the only write path)');
  lines.push('  $ shrk check boundaries          — enforce layer / import boundaries');
  lines.push('  $ shrk quality                   — pre-PR gate (doctor + boundaries + coverage + drift)');
  lines.push('');
  lines.push('Browse what shrk knows:');
  lines.push('  $ shrk graph status              — code-graph freshness and health');
  lines.push('  $ shrk coverage                  — what knowledge is missing');
  lines.push('  $ shrk knowledge list            — knowledge entries');
  lines.push('');
  lines.push('Run shrk for an agent:');
  lines.push('  $ shrk mcp serve                 — start the MCP server (stdio) for live queries');
  lines.push('  $ shrk dashboard                 — start the local read-only dashboard');
  lines.push('');
  lines.push('Discover the rest (everything stays callable — this screen shows ~17 of ~70 verbs):');
  lines.push('  $ shrk surface list              — full catalog by tier');
  lines.push('  $ shrk help <command>            — usage for a specific command');
  lines.push('  $ shrk --full-help               — long, exhaustive help (incl. the explain/dry-run family)');
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
        if (handler && matchedPath.join(' ') === tokens.join(' ') && node.children.size === 0) {
          // Exact match on a callable command.
          const canonical = registry.listCommandAliases().get(tokens[0]!);
          process.stdout.write(`${matchedPath.join(' ')} — ${handler.description}\n${handler.usage}\n`);
          const extra = EXTRA_HELP_LINES[matchedPath.join(' ')];
          if (extra) process.stdout.write(extra.join('\n') + '\n');
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
      const wantsAll = args.flags.get('all') === true;
      process.stdout.write(`SharkCraft CLI — structured project intelligence for AI coding agents\n`);
      process.stdout.write(`Usage: shrk [--cwd <dir>] <command> [...args]\n`);

      // The catalog has ~360 entries; only ~30 top-level verbs pay
      // rent (see PRIMARY_VERBS_ALLOWLIST in command-catalog.ts).
      // Default --full-help filters to that set; `--full-help --all`
      // dumps the entire catalog for power users.
      const visibleVerbs = new Set<string>();
      if (!wantsAll) {
        for (const entry of COMMAND_CATALOG) {
          if (defaultShowInHelp(entry)) {
            const verb = entry.command.split(/\s+/)[0] ?? '';
            if (verb) visibleVerbs.add(verb);
          }
        }
      }
      const visibleTopLevel = registry.list().filter((c) => {
        if (wantsAll) return true;
        return visibleVerbs.has(c.name);
      });
      process.stdout.write(header('Top-level commands'));
      for (const c of visibleTopLevel) {
        process.stdout.write(`  ${c.name.padEnd(10)} — ${c.description}\n`);
      }
      if (!wantsAll) {
        const hiddenCount = registry.list().length - visibleTopLevel.length;
        if (hiddenCount > 0) {
          process.stdout.write(
            `\n  …and ${hiddenCount} more, hidden from default help. Run \`shrk --full-help --all\` to see them, ` +
              `or \`shrk surface list\` to browse by tier.\n`,
          );
        }
      }

      // Show each canonical group once — also filtered by the allowlist
      // unless --all was passed.
      const canonicalGroups: string[] = [];
      const aliasMap = registry.listGroupAliases();
      const seen = new Set<string>();
      for (const g of registry.listGroups()) {
        const canonical = aliasMap.get(g) ?? g;
        if (!seen.has(canonical)) {
          seen.add(canonical);
          if (wantsAll || visibleVerbs.has(canonical)) {
            canonicalGroups.push(canonical);
          }
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
      // Explain / dry-run family — several carry an Advanced surface and are
      // filtered out of the listings above, so surface them explicitly. These
      // show you what a gate, ranker, or graph SEES before you act; an agent
      // would otherwise find them only by guessing (the #4.4 friction).
      const explainFamily = listExplainFamily();
      if (explainFamily.length > 0) {
        process.stdout.write(header('Inspect / explain (dry-run what a gate, ranker, or graph sees)'));
        for (const e of explainFamily) {
          process.stdout.write(`  ${e.command.padEnd(24)} — ${firstSentence(e.description)}\n`);
        }
        process.stdout.write('  (also: shrk check wiring --explain <ruleId>)\n');
      }

      process.stdout.write('\nRun `shrk help <command>` for detailed usage.\n');
      return 0;
    },
  };
}
