import { KnowledgeRenameVerb } from './knowledge-rename-verb.ts';

/** The `<old> <new>` placeholders each verb's usage line names. */
const PLACEHOLDERS: Readonly<Record<KnowledgeRenameVerb, readonly [string, string]>> = {
  [KnowledgeRenameVerb.RenameSymbol]: ['<old-symbol>', '<new-symbol>'],
  [KnowledgeRenameVerb.RenameFile]: ['<old-path>', '<new-path>'],
};

/** A value that is one shell word as written. Anything else is single-quoted. */
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

function shellWord(value: string): string {
  return PLAIN_WORD.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * THE `shrk knowledge rename-symbol|rename-file` command a hint suggests
 * (round 15 follow-up, lane B — B1). Every site that suggests a knowledge
 * rename builds the string here: the stale-check hint, the `fix preview
 * --knowledge-stale` suggestion, the knowledge-stale failure footer, the
 * feedback-ingestion rule, the codemod-assist plan and the MCP
 * `preview_knowledge_rename` next step.
 *
 * The result is always an invocation the dispatcher accepts. It has two
 * positionals and no `--dry-run` (both verbs are read-only previews; three
 * sites used to add the flag, and the dispatcher refused it with exit 2). A
 * value that is not one plain shell word is single-quoted. A missing value is
 * the verb's placeholder. A value that starts with `-` follows `--` (lane B
 * review): quoted or not — the shell strips the quotes — it read as a flag, and
 * the dispatcher refused `rename-file -weird.ts b.ts` (exit 2, `-weird.ts is
 * not a flag of this command`); after `--` it is a positional, verbatim.
 */
export function knowledgeRenameCommand(verb: KnowledgeRenameVerb, from?: string, to?: string): string {
  const [oldPlaceholder, newPlaceholder] = PLACEHOLDERS[verb];
  const word = (value: string | undefined, placeholder: string): string =>
    value !== undefined && value.length > 0 ? shellWord(value) : placeholder;
  const endOfFlags = [from, to].some((v) => v !== undefined && v.startsWith('-')) ? '-- ' : '';
  return `shrk knowledge ${verb} ${endOfFlags}${word(from, oldPlaceholder)} ${word(to, newPlaceholder)}`;
}
