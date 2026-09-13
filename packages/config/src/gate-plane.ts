/**
 * Which data-defined gate plane a rule belongs to — the seven rule planes of
 * `sharkcraft.config.ts`. `GATE_PLANE_CONFIG_KEY` names the config key each
 * plane's rules live under; the CLI's gate views and the inspector's plane
 * count both read that one record.
 */
export type GatePlane =
  | 'wiring'
  | 'policy'
  | 'registry'
  | 'registration'
  | 'baseline'
  | 'generated'
  | 'doc-reference';
