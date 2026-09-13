/**
 * The two `shrk knowledge` rename previews a hint may suggest (round 15
 * follow-up, lane B — B1). Both verbs are read-only previews already, so
 * neither takes `--dry-run`: the dispatcher refuses the flag (exit 2), and a
 * hint that named it suggested a command that could not run.
 */
export enum KnowledgeRenameVerb {
  RenameSymbol = 'rename-symbol',
  RenameFile = 'rename-file',
}
