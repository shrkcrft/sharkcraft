/**
 * What `resolveCommandString` checks NON-shrk commands against.
 *
 * Each field is optional: an absent set means "cannot check that family", and
 * the resolver reports those strings `NotShrk` (skipped, counted) instead of
 * inventing an answer.
 */
export interface ICommandStringContext {
  /** Root `package.json` script names, for `<pm> run <script>`. */
  readonly scripts?: ReadonlySet<string>;
  /** Registered MCP tool names, for bare tool ids (`get_task_packet`). */
  readonly mcpToolNames?: ReadonlySet<string>;
  /**
   * The project root a path-mode argument is looked up under — the
   * dispatcher's cwd. Absent → no argument names a file (a disk-free reading):
   * a verb-shaped token under a path-mode command is then a verb it lacks.
   */
  readonly root?: string;
}
