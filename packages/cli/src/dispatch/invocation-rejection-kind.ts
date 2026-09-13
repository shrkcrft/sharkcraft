/**
 * What a pre-run refusal refused. The dispatcher prints the message either
 * way; the command-string resolver maps the kind onto its own vocabulary
 * (`UnknownSubverb` / `UnknownFlag`), so "does this command run?" is answered
 * by the dispatcher's judgement, never by a parallel model of it.
 */
export enum InvocationRejectionKind {
  /** A bare token under a command group, or under a `positionals: None` handler, that names no subverb. */
  UnknownSubcommand = 'unknown-subcommand',
  /** `positionals: Path` + a verb-shaped token that is neither a subverb nor an existing file. */
  NoSuchVerbOrFile = 'no-such-verb-or-file',
  /** A flag outside a declared set, or one no documentation of the command names. */
  UnknownFlag = 'unknown-flag',
}
