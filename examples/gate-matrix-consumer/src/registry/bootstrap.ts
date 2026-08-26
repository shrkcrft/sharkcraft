// The THIRD hop: handlers must be declared, listed in HANDLERS, AND booted.
// Only ALPHA is booted, so the chain rule reports a break at hop 1→2 that a
// two-sided rule would attribute to the wrong seam.
import { ALPHA_HANDLER } from '../handlers/ALPHA_HANDLER';

export const BOOTSTRAPPED = [ALPHA_HANDLER];
