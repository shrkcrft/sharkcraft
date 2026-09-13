# Quality baselines — retired

> **Retired.** The `shrk quality baseline create|compare|update|show|diff|prune|history`
> verbs were removed: the snapshot machinery was hidden and unused, and the
> commands this page used to list no longer run.

What covers the same ground today:

- **A committed ledger that must not drift** — the `baselines[]` gate plane
  (see [`gate-rules.md`](./gate-rules.md)). `shrk baseline check` fails on drift
  in BOTH directions (a lost entry fails like a gained one), `shrk baseline diff`
  shows the drift without a verdict, and `shrk baseline update` is the explicit,
  reviewable bless step. A baseline with `mode: 'ceiling'` ratchets a measured
  number — a count, a score — so it can only move one way.
- **Quality before a push** — `shrk quality` runs every check and every rule
  plane in one pass and prints each failure with its repro command; a gate that
  examined nothing is skipped, never passed.
- **The composite "safe to finish?"** — `shrk finish` runs the deciding gates
  over the changed files and returns one verdict.
