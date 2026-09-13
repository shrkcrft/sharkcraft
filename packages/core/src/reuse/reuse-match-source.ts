/**
 * Which field of a reuse candidate an intent token hit — the evidence behind a
 * match, so "matched by its name" and "matched only through metadata" are
 * never reported the same way.
 */
export enum ReuseMatchSource {
  Symbol = 'symbol',
  Role = 'role',
  Keyword = 'keyword',
  Description = 'description',
}
