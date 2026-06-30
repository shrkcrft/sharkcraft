# Pack signature freshness (R33)

`shrk packs signature-status` reports whether each discovered pack's
manifest signature is fresh, stale, or missing. **It never fake-signs.**

## Commands

```bash
shrk packs signature-status [<pack>] [--format text|markdown|json]
shrk packs sign <manifest.signed.json>   # requires SHARKCRAFT_PACK_SECRET

# R43 — agent-friendly modifiers (no fake signing in any of these):
shrk packs sign <pack> --if-needed       # sign only when status != present
shrk packs sign <pack> --check-only      # exit 1 if stale, never sign
shrk packs sign <pack> --print-command   # print the exact secret-aware command
shrk packs sign <pack> --if-needed --write-todo   # writes a signing TODO under .sharkcraft/reports/

shrk packs doctor --signature-explain     # per-pack lifecycle states
```

## Detection

`stale` = at least one contribution file's mtime is newer than the
signature's `signedAt` timestamp. Pure timestamp heuristic — the real
HMAC validation still runs inside `shrk packs doctor`.

## Behaviour

- `present` = signature exists and no contribution file is newer than
  the signed timestamp.
- `stale` = signature exists, some contribution file is newer. The CLI
  exits 1 in `text` / `markdown` mode when at least one stale pack is
  present.
- `missing` = no signature block on the manifest.

The next-command hint always names the exact `shrk packs sign` command
to run with the secret. When the secret is not set the CLI says so
explicitly (`secret env NOT set (no fake-signing — re-sign manually)`).

## MCP

- `get_pack_signature_status` — read-only.

## Schema

`sharkcraft.pack-signature-status/v1`.
`sharkcraft.pack-signature-explain/v1` (R43, `shrk packs doctor --signature-explain`).

## R43 lifecycle states (`--signature-explain`)

| State | Meaning |
| --- | --- |
| `valid` | HMAC **verified** at inspection time. Reserved strictly for a real verifier pass — freshness alone never earns `valid`. |
| `present-unverified` | Signature present and newer than every contribution file, but the HMAC was **not** checked this run. Freshness is not verification — run `shrk packs verify --required`. |
| `dev-signature` | Manifest carries a dev signature (`sig.dev = true`) — verified only against the well-known public dev secret, NOT release-trusted. |
| `unsigned` | Manifest has no signature block. |
| `stale` | Signature exists but at least one contribution file's mtime is newer. |
| `invalid` | Manifest signature failed HMAC verification — pack contents may have been tampered with. |
| `secret-missing` | `SHARKCRAFT_PACK_SECRET` is unset; cannot verify or re-sign in this session. |
| `not-required` | Signatures are not required in this run (no `--require-signatures`). |
| `unknown` | Verifier did not run; rerun with `--verify-signatures`. |

`--signature-explain` implies `--verify-signatures`, so the states above are
backed by a real HMAC check (a bogus-HMAC-but-fresh-timestamp pack reports
`invalid`, never `present-unverified`).

The engine never fake-signs. When the secret is missing, the command
prints (or, with `--write-todo`, writes) the exact `SHARKCRAFT_PACK_SECRET=… shrk packs sign …` line a human or a follow-up
session needs to run.

## R44 — combined pending view

`shrk pack author pending` (alias: `shrk packs pending`) composes the
four pending signals into a single report:

- modified pack asset files (mtime > signature),
- generated preview drafts under `.sharkcraft/authoring/` and
  `.sharkcraft/fixes/`,
- stale signature state (delegated to `buildPackSignatureStatusReport`),
- pending provenance entries (operations with `operation=preview` that
  have no follow-up `apply` / `remove`).

Schema: `sharkcraft.pack-pending/v1`. When `SHARKCRAFT_PACK_SECRET` is
missing the report carries an explicit `secretMissingHint` — an
agent-friendly explanation plus the exact next command. Pass
`--write-todo` to land that hint as a markdown file under
`.sharkcraft/reports/pack-signing-todo.md`.

## R49–R52 — Dev signatures vs release signatures

`shrk packs sign --dev` exists for the inner-loop case: an author is
iterating on a pack and needs the signature to verify so the rest of
`shrk` keeps working, without holding the release secret. The dev
signature carries `sig.dev = true` on the manifest. **A dev signature
is never release-trusted.**

The dev secret (`PACK_DEV_SECRET`) is **well-known and public**, so a dev
signature proves nothing about publisher identity. The verifier therefore
**rejects a `dev: true` signature by default** — reporting `signatureStatus:
'dev-signature'` — *even when your own `SHARKCRAFT_PACK_SECRET` is set*. To
accept a dev signature for a local-only flow, pass `--allow-dev-signature`:

```bash
shrk packs verify --allow-dev-signature           # trust dev signatures (local only)
shrk packs verify --required                       # dev-signed pack FAILS the gate
shrk packs doctor --require-signatures --allow-dev-signature
```

Under `--required` / `--require-signatures` a dev-signed pack fails unless
`--allow-dev-signature` is given. Even with `--allow-dev-signature`, a
*tampered* dev signature still fails (the HMAC is actually re-checked, not
blindly trusted).

| Form | Secret needed | `sig.dev` | When to use |
| --- | --- | --- | --- |
| `shrk packs sign <pack>` | `SHARKCRAFT_PACK_SECRET` (release) | absent / false | Before tagging — produces a release signature. |
| `shrk packs sign <pack> --dev` | `PACK_DEV_SECRET` (or ephemeral) | `true` | Inner-loop work without the release secret. |
| `shrk packs sign <pack> --if-needed` | release or dev (matching current state) | preserved | Re-sign only when stale. |

### Fail-closed when verification cannot run

`shrk packs verify --required` (and `packs doctor --require-signatures`) treat
a *signed* pack that could not be verified as a **failure**, not a pass:

- a real signed pack with no `SHARKCRAFT_PACK_SECRET` reports
  `signatureStatus: 'missing-secret'` → unverifiable → the gate fails and the
  verdict says so;
- a dev-signed pack (without `--allow-dev-signature`) → unverifiable → fails.

"all signatures OK" is printed only when **every** signed pack reached
`verified`.

### Release-preflight contract (R52)

`shrk release readiness` (and therefore `bun run release:preflight`,
which folds the readiness report in) **fails closed** when:

- at least one discovered pack carries `sig.dev = true`, AND
- `SHARKCRAFT_PACK_SECRET` is not set in the current environment.

The blocker is named `pack-signature-release` and the suggestion lists
the exact `shrk packs sign <pack>` command(s) needed. When the secret
IS set, the same condition downgrades to a warning ("Release secret is
available — re-sign before tagging."). When no dev signatures exist,
the gate passes silently.

### Mid-session recovery

```
# Did some pack work, secret is set — re-sign with release signature:
$ shrk packs sign <pack> --if-needed

# Did some pack work, secret is NOT set — keep iterating with dev sig:
$ shrk packs sign <pack> --dev --if-needed

# About to ship — check what would happen:
$ shrk packs signature-status --release-readiness
```

`signature-status --release-readiness` annotates each pack with whether
it would block `release:preflight` (dev signature + no release secret =
blocking). The flag composes with `--format text|markdown|json`.

### `safety audit --deep` dev-signature line

`shrk safety audit --deep` enumerates dev-signed packs in its output so
a release engineer sees them without running a separate command:

```
=== Deep audit ===
  passed: yes
  ...
  dev-signed packs: 1
    • my-sharkcraft-pack@0.1.0 (signed-at 2026-05-12T11:32:01Z)
```

This is informational (severity = `info`) — the audit's pass/fail
verdict is unchanged. The release-readiness gate above is the
authoritative blocker.
