import type { SurfaceLayer } from './surface-layer.ts';

/**
 * Why a command is denied by `surface.disabled`: the selector that named it
 * and the layer that declared that selector. Carried on the tier resolution
 * and the surface view so the refusal text and `surface explain` name the
 * remedy that actually works (`surface allow` for a config deny, `surface
 * enable` over a profile deny).
 */
export interface ISurfaceDenial {
  readonly selector: string;
  readonly origin: SurfaceLayer;
}
