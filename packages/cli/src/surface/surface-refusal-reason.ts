/**
 * Why the surface gate refused a command (exit 78). One gate, three reasons:
 *
 *   - `experimental`      — an experimental command not in `surface.enabled`
 *   - `tool-maintenance`  — a command that maintains SharkCraft itself, run
 *                           outside SharkCraft's own repository
 *   - `disabled`          — denied by a `surface.disabled` selector
 *
 * None of them is a check failure.
 */
export enum SurfaceRefusalReason {
  Experimental = 'experimental',
  ToolMaintenance = 'tool-maintenance',
  Disabled = 'disabled',
}
