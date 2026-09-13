import type { ISharkCraftConfig } from '@shrkcrft/config';
import type { ContributionFileKey } from '@shrkcrft/plugin-api';

/**
 * How ids of ONE reference kind come to exist — the declarability half of the
 * resolver contract.
 *
 * `list ≡ resolve` proves the resolver reads what the `list` verb prints; it
 * says nothing about a kind whose registry NOTHING can fill. Such a kind turns
 * every reference to it into a permanent loud skip (NOT VERIFIED forever), so
 * every kind the resolver answers for carries a row saying how it is filled,
 * and the r76 declarability lock declares one id through EVERY path listed
 * here and proves the resolver then lists it.
 *
 * At least one of `builtin` / `configKeys` / `localFiles` / `packKeys` is set
 * on every row (the lock fails a row with none).
 */
export interface IReferenceKindDeclaration {
  /**
   * The command that shows this kind's ids — its `list` verb, or `shrk
   * self-config resolve <id>` for a kind with no list verb yet (it reads the
   * same resolver). The doctor's `*-missing` findings print it as `next:`.
   */
  readonly listVerb: string;
  /** The engine ships this kind's ids itself — the registry is never empty. */
  readonly builtin?: true;
  /** `sharkcraft.config.ts` keys listing files (relative to the sharkcraft dir) that declare ids of this kind. */
  readonly configKeys?: readonly (keyof ISharkCraftConfig)[];
  /**
   * Files read by default, with no config key — relative to the project root
   * in the default layout (`sharkcraft/` is the sharkcraft dir; a custom
   * `sharkcraftDir` moves every `sharkcraft/…` path with it). A `*` stands for
   * one file per id (`sharkcraft/decisions/*.md`).
   */
  readonly localFiles?: readonly string[];
  /** Pack manifest `contributions` keys whose files declare ids of this kind. */
  readonly packKeys?: readonly ContributionFileKey[];
}
