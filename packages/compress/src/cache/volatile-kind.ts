/**
 * Classes of volatile token that destabilise a provider's KV-cache prefix.
 * When these change between otherwise-identical prompts the cache misses, so
 * surfacing them lets a caller hoist/pin them for cheaper cache hits.
 */
export enum EVolatileKind {
  Uuid = 'uuid',
  Jwt = 'jwt',
  Iso8601 = 'iso8601',
  HexHash = 'hex-hash',
  EpochTimestamp = 'epoch-timestamp',
}
