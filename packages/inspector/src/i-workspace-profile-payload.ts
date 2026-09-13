/**
 * The payload of a builtin `workspace` profile entry
 * (`ProfileKind.Workspace`): whether THIS repo exhibits the profile, and the
 * detector's evidence when it does. The id itself is valid either way — the
 * vocabulary is the engine's, detection is the repo's.
 */
export interface IWorkspaceProfilePayload {
  readonly detected: boolean;
  /** The detector's evidence (`tsconfig.json or typescript dependency present`); set only when detected. */
  readonly reason?: string;
}
