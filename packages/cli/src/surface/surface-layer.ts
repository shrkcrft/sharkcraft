/**
 * Which layer of the `surface{}` composition declared a selector: the
 * project's own `sharkcraft.config.ts`, or the active surface profile it
 * selects. Config wins over the profile — an explicit `surface.enabled`
 * overrides a PROFILE's deny, never a config deny.
 */
export enum SurfaceLayer {
  Config = 'config',
  Profile = 'profile',
}
