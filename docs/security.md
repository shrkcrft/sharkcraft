# Security model

SharkCraft is designed for **local, trusted** project intelligence. It is not
a sandboxed evaluator and does not load remote knowledge. The boundaries below
are the guarantees you can rely on; everything else is treated like normal
local TypeScript code.

## 1. Generation never escapes the project root

`@shrkcrft/generator` resolves every template-supplied target path through
`safeResolveTargetPath` in `@shrkcrft/core`. The rules:

| Input | Result |
|---|---|
| Empty / non-string path | rejected (`empty-path`) |
| Absolute path (`/etc/passwd`) | rejected (`absolute-path-rejected`) |
| Traversal that escapes root (`../../etc/passwd`) | rejected (`outside-project-root`) |
| Anything resolving inside the project root | allowed |

Rejected paths surface as `FileChangeType.Conflict` with a `reason` starting
with `Refused unsafe target path`. `shrk gen --write` refuses to write any
plan that has conflicts.

## 2. `shrk gen` is dry-run by default

Without `--write`, no files are touched. Even with `--write`:

- The plan must have **zero conflicts**.
- The default `OverwriteStrategy` is `Never`, so existing files are reported
  as conflicts unless the caller passes `--force` (an explicit, audited choice).
- The generator never deletes files in v0.1.

## 3. MCP tool inputs are validated

The MCP server runs every `tools/call` input through a zod schema before the
handler runs. Invalid input returns a structured error with `isError: true`
and an explanation of which field failed — it never crashes the server or
reaches the tool handler with garbage.

## 4. Knowledge files are trusted local code, not user input

Files inside `sharkcraft/` are imported with the standard module loader,
exactly like `vite.config.ts`, `eslint.config.js`, or `nx.json` — they execute
during load. The trust model:

- **Yes:** files written by the repo's maintainers.
- **No:** content downloaded from elsewhere, content checked into the repo by
  an untrusted contributor without review, anything you wouldn't run in CI.

If a repo's `sharkcraft/` files are untrusted, you shouldn't run any other
build tool against the repo either.

See `docs/knowledge-loading.md` for the loader's exact behavior.

## 5. No remote sources

The CLI and MCP server never fetch knowledge over the network. The only
network calls in the project are in `@shrkcrft/ai` (local Ollama HTTP
adapter) and they happen only when the user explicitly invokes
`shrk ask` or `shrk smart-context`, against an Ollama daemon they
control (`OLLAMA_HOST`/`OLLAMA_PORT`). When `LLAMACPP_MODEL_PATH` is set
instead, inference runs in-process and there are zero outbound calls.
SharkCraft never reaches a hosted LLM API.

## 6. No automatic shell execution

SharkCraft does not run arbitrary shell commands from knowledge or templates.
Templates are typed functions that return file contents; they cannot exec.

`shrk apply --validate` and `shrk dev validate` only run commands from
`sharkcraft.config.ts verificationCommands[]` (with `trusted !== false`),
plus any explicit `--command` flag. Pack-contributed verification commands
are **never** auto-run unless `--allow-pack-commands` is passed (and even
then v1 currently ignores it — the flag is reserved for a future feature).

## 7. Imports never write

`shrk import` parses external rule files (AGENTS.md / CLAUDE.md /
`.cursor/rules`) into **draft** TypeScript modules. By default the command
shows a preview only. With `--write` it writes the draft to
`sharkcraft/imports/<format>-import.draft.ts` — never directly into the
active knowledge files. Review the draft before merging it.

## 8. Pack signing (HMAC-SHA256)

Packs can be signed with an HMAC secret distributed out-of-band:

- Producer: `shrk packs sign <pack-dir> --key-id ... --verify-after-sign`.
- Consumer: `shrk packs verify --required` or
  `shrk packs doctor --require-signatures`.

The HMAC is computed over the canonical JSON of the **entire manifest with
the `signature` field removed** (keys sorted recursively, `undefined` dropped,
array order preserved) — i.e. `schema`, `info`, `contributions`, and
`postInstallNotes` are all covered. Tampering with any of them invalidates the
signature.

Signed JSON manifests are read as data (no dynamic import). They give you
tamper detection on the manifest content. They do **not** sandbox the
TypeScript contribution files the manifest points at — those still load
under the trusted-local-config trust model from rule #4.

**Dev signatures are not release-trusted.** `shrk packs sign --dev` marks the
signature `dev: true` and signs it with a **well-known, public** dev secret so
authors can iterate without the release secret. Because that secret is public,
a dev signature proves nothing about publisher identity. The verifier therefore
**rejects** a `dev: true` signature by default (`signatureStatus:
'dev-signature'`), *even if your own real secret is set*; it is only accepted
when you explicitly pass `--allow-dev-signature` (a local-only escape hatch,
which still fails a *tampered* dev signature). Under `--require-signatures` /
`--required`, a dev-signed pack fails the gate.

**`--required` fails closed when verification cannot run.** A genuinely signed
pack that cannot be checked because `SHARKCRAFT_PACK_SECRET` is unset reports
`signatureStatus: 'missing-secret'` and is treated as *unverifiable* — under
`--required` it FAILS and the verdict names the missing secret. The command
never prints "all signatures OK" unless every signed pack actually reached
`verified`. Freshness (`shrk packs doctor --signature-explain`) is likewise
not verification: a signature whose timestamp is merely newer than every
contribution file, with no HMAC check this run, is reported as
`present-unverified`, never `valid`.

For private/commercial packs:

- Distribute the signing secret only to trusted consumers.
- Set `--require-signatures` in CI so unsigned packs fail loudly.
- Add a `SECURITY.md` to every pack — see a published pack's `SECURITY.md`
  for an example of signing-key, rotation, and tamper-reporting docs.

## 9. Logging

The MCP server writes log lines to **stderr only** (so they don't interfere
with the JSON-RPC framing on stdout). Pass `--verbose` or set
`SHARKCRAFT_MCP_VERBOSE=1` to see lifecycle events.

## Out of scope (today)

- **Process-level sandboxing of generated content.** A malicious template
  could put arbitrary text inside a file; reading those files later still
  runs through your editor's normal trust path. Treat templates the same way
  you treat any code-mod tool.
- **Lockfile pinning of knowledge.** If `sharkcraft/` files import third-party
  npm packages, those packages run with full Node/Bun privileges at load time.
  Don't import unfamiliar packages into your knowledge files.

## Reporting a security issue

This is an alpha project. If you find a real security problem, open an issue
on the GitHub repository (see `repository.url` in any package.json) tagged
`security` rather than disclosing publicly. Coordinated disclosure preferred.
