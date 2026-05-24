import {
  flagBool,
  flagString,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';
import { COMMAND_CATALOG } from './command-catalog.ts';

/**
 * `shrk completion <bash|zsh|fish>` — print a sourcable completion
 * script. The list of verbs is generated from the registered
 * `COMMAND_CATALOG` so completion can't drift from the runtime
 * surface. Subverbs for the high-traffic groups (graph, arch,
 * impact, gate, context, search-structural) are hand-curated.
 */
export const completionCommand: ICommandHandler = {
  name: 'completion',
  description:
    'Print a sourcable shell-completion script for the `shrk` CLI. Pipe into your shell rc: `shrk completion bash >> ~/.bashrc`.',
  usage: 'shrk completion <bash|zsh|fish> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const shell = (args.positional[0] ?? flagString(args, 'shell') ?? 'bash').toLowerCase();
    const wantJson = flagBool(args, 'json');
    const verbs = collectTopLevelVerbs();
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.cli-completion/v1',
          shell,
          verbs,
          subverbs: SUBVERBS,
        }) + '\n',
      );
      return 0;
    }
    switch (shell) {
      case 'bash':
        process.stdout.write(renderBash(verbs));
        return 0;
      case 'zsh':
        process.stdout.write(renderZsh(verbs));
        return 0;
      case 'fish':
        process.stdout.write(renderFish(verbs));
        return 0;
      default:
        process.stderr.write(
          `Unknown shell "${shell}". Use bash | zsh | fish.\n`,
        );
        return 2;
    }
  },
};

/**
 * Subverbs the high-traffic verbs accept. Hand-curated because the
 * runtime catalog represents them as a single CLI surface; we don't
 * want to parse the dispatch chain at completion time.
 */
const SUBVERBS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  graph: ['index', 'status', 'search', 'context', 'impact', 'callers', 'cycles', 'unresolved', 'deps', 'why', 'export'],
  arch: ['check', 'baseline'],
  impact: ['tests', 'graph', 'baseline'],
  gate: ['scaffold-ci', 'scaffold-hook'],
  context: ['build', 'refresh', 'status', 'benchmark'],
  'search-structural': ['registry'],
  doctor: ['suppress', 'suppressions', 'acknowledge', 'acknowledgements', 'watch'],
});

function collectTopLevelVerbs(): readonly string[] {
  const set = new Set<string>();
  for (const e of COMMAND_CATALOG) {
    // `command` may carry an argument hint like 'fix preview' — keep
    // only the first token so completion works at the top level.
    const head = e.command.split(/\s+/)[0]!;
    if (head.length > 0) set.add(head);
  }
  return [...set].sort();
}

function renderBash(verbs: readonly string[]): string {
  const verbList = verbs.join(' ');
  const subverbCases = Object.entries(SUBVERBS)
    .map(
      ([verb, subs]) =>
        `      ${verb}) COMPREPLY=($(compgen -W "${subs.join(' ')}" -- "$cur")); return 0;;`,
    )
    .join('\n');
  return `# shrk bash completion. Source from ~/.bashrc:
#   eval "$(shrk completion bash)"
_shrk_complete() {
  local cur prev words cword
  _init_completion || return
  if [ "$cword" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${verbList}" -- "$cur"))
    return 0
  fi
  case "\${words[1]}" in
${subverbCases}
  esac
  COMPREPLY=()
}
complete -F _shrk_complete shrk
`;
}

function renderZsh(verbs: readonly string[]): string {
  const verbList = verbs.join(' ');
  const subverbCases = Object.entries(SUBVERBS)
    .map(([verb, subs]) => `    ${verb}) compadd -- ${subs.join(' ')};;`)
    .join('\n');
  return `# shrk zsh completion. Source from ~/.zshrc:
#   eval "$(shrk completion zsh)"
_shrk() {
  if [[ \${#words} -eq 2 ]]; then
    compadd -- ${verbList}
    return
  fi
  case "\${words[2]}" in
${subverbCases}
  esac
}
compdef _shrk shrk
`;
}

function renderFish(verbs: readonly string[]): string {
  const lines: string[] = [
    '# shrk fish completion. Source from ~/.config/fish/completions/shrk.fish:',
    '#   shrk completion fish > ~/.config/fish/completions/shrk.fish',
    'complete -e -c shrk',
    `complete -c shrk -n '__fish_use_subcommand' -a '${verbs.join(' ')}'`,
  ];
  for (const [verb, subs] of Object.entries(SUBVERBS)) {
    lines.push(
      `complete -c shrk -n '__fish_seen_subcommand_from ${verb}' -a '${subs.join(' ')}'`,
    );
  }
  return lines.join('\n') + '\n';
}
