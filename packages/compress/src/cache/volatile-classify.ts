import { EVolatileKind } from './volatile-kind.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A JWT's first segment is base64url of a `{"alg":...}` header, which always
// starts with `eyJ` — require it so ordinary dotted identifiers
// (`config.settings.default`, `lodash.debounce.cancel`) aren't flagged.
const JWT = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}$/;
const ISO8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const HEX_HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;
// Plausible unix epochs only (leading `1`: ~2001–2033 in seconds, ~2001–2286 in
// millis) so phone numbers / arbitrary IDs (`5551234567`, `9999999999`) don't
// register as timestamps.
const EPOCH = /^1\d{9}$|^1\d{12}$/;

/** Minimum cleaned-token length before classification is attempted. */
export const MIN_VOLATILE_LEN = 8;

/**
 * Strip surrounding quotes / brackets / punctuation a token tends to carry.
 * Shared by both detection and active alignment so they never drift.
 */
export function clean(token: string): string {
  return token.replace(/^[("'[<{]+/, '').replace(/[)"'\]>}.,;:]+$/, '');
}

/** Classify a CLEANED token into a volatile kind, or null. */
export function classify(token: string): EVolatileKind | null {
  if (UUID.test(token)) return EVolatileKind.Uuid;
  if (token.includes('.') && JWT.test(token)) return EVolatileKind.Jwt;
  if (ISO8601.test(token)) return EVolatileKind.Iso8601;
  if (HEX_HASH.test(token)) return EVolatileKind.HexHash;
  if (EPOCH.test(token)) return EVolatileKind.EpochTimestamp;
  return null;
}
