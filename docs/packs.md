# Packs

A **pack** is an npm package that ships SharkCraft assets:

- Knowledge entries
- Rules
- Path conventions
- Templates
- Pipelines
- Docs (markdown)

The pack itself is just an npm package with a `sharkcraft` field in
`package.json` pointing to a manifest. SharkCraft's discovery walks
`node_modules/` and surfaces every pack it finds.

> Packs ship *content*, not behavior. They are read-only contributions —
> they cannot make the MCP server write files, run shell commands, or modify
> your repo. Generation always goes through the CLI by a human.

## Anatomy of a pack

```
@scope/your-pack/
├── package.json                           # has a "sharkcraft" field
├── README.md
├── SECURITY.md                            # recommended (see below)
└── src/
    ├── sharkcraft.plugin.ts               # default-exports definePackManifest({...})
    ├── sharkcraft.plugin.signed.json      # optional: signed JSON manifest
    └── assets/
        ├── knowledge.ts
        ├── rules.ts
        ├── paths.ts
        ├── templates.ts
        ├── pipelines.ts
        ├── scaffold-patterns.ts           # optional — see docs/scaffold-patterns.md
        └── docs/
            ├── overview.md
            └── architecture.md
```

`package.json` declares which manifest the discovery should load:

```json
{
  "name": "@scope/your-pack",
  "version": "0.1.0",
  "sharkcraft": { "manifest": "./src/sharkcraft.plugin.ts" }
}
```

The manifest itself is a typed object:

```ts
import { definePackManifest } from '@shrkcrft/plugin-api';

export default definePackManifest({
  schema: 'sharkcraft.pack/v1',
  info: { name: '@scope/your-pack', version: '0.1.0' },
  contributions: {
    knowledgeFiles: ['./src/assets/knowledge.ts'],
    ruleFiles:      ['./src/assets/rules.ts'],
    pathFiles:      ['./src/assets/paths.ts'],
    templateFiles:  ['./src/assets/templates.ts'],
    pipelineFiles:  ['./src/assets/pipelines.ts'],
    docsFiles:      ['./src/assets/docs/overview.md'],
  },
  postInstallNotes: [
    'Run `shrk doctor` to confirm the pack loaded.',
  ],
});
```

## Cross-file invariant planes (wiring / registries / policy / reuse)

Four planes encode a cross-file invariant as **pure data** rather than a
template or a boundary rule:

| Plane | Slot | Default export | Merge key |
|---|---|---|---|
| Wiring / completeness (`shrk check wiring`) | `wiringRuleFiles` | `readonly IWiringRule[]` | `id` |
| Registry inventories (`shrk registry`) | `registryFiles` | `readonly IRegistryDeclaration[]` | `name` |
| Policy-lint (`shrk policy-lint`) | `policyRuleFiles` | `readonly IPolicyRule[]` | `id` |
| Reuse primitives (`shrk reuse`) | `reusePrimitiveFiles` | `readonly IReusePrimitive[]` | `symbol` |

These can be authored inline in a repo's `sharkcraft.config.ts`, **or shipped
by a pack** so a framework pack can ship an invariant once instead of every
consuming repo hand-copying it. For example, a NestJS pack can ship "every
`@Injectable` must be registered in a module" as a wiring rule:

```ts
// src/assets/wiring.ts — default-exports readonly IWiringRule[]
export default [
  {
    id: 'nestjs.injectable-registered',
    description: 'Every @Injectable must be listed in a module providers[].',
    declared:   { files: ['src/**/*.ts'], pattern: "@Injectable\\(\\)\\s*export class (\\w+)" },
    registered: { files: ['src/**/*.module.ts'], arrayProperty: 'providers' },
  },
];

// src/sharkcraft.plugin.ts
contributions: { wiringRuleFiles: ['./src/assets/wiring.ts'] }
```

**Precedence is LOCAL-WINS.** The merge happens in the inspector (the lowest
layer that can see both the config and the discovered packs — config itself
cannot import packs), surfaced through `shrk check wiring`, `shrk registry`,
`shrk policy-lint`, `shrk reuse`, and `shrk gate`:

- The repo's own declarations are seeded first.
- A pack element is added only if its merge key is free; a key that collides
  with a local declaration (or an earlier pack) is **dropped** with a
  diagnostic naming the pack.
- Every pack element is validated with the **same** schema the config loader
  uses; a malformed element is skipped with a diagnostic rather than crashing.
- A missing pack file is reported as a diagnostic, not a hard failure.

> `policyRuleFiles` (regex-over-surfaces data, read by `policy-lint`) is a
> different plane from `policyCheckFiles` (an executable `evaluate()` callback).
> A pack may ship either or both.

## Discovery + resolved counts

`shrk packs list` shows both the declared file counts and the **resolved**
object counts after dedup:

```
=== Packs (1) ===
  OK      @example/sharkcraft-pack@0.1.0
          files:    k=1 r=1 p=1 t=1 pl=1 d=5
          resolved: entries=61 templates=6 pipelines=5 docs=5
```

The `files:` row is "how many contribution files were declared". The
`resolved:` row is "how many objects actually loaded into the active
project". Discrepancies happen when:

- A contribution file is missing on disk.
- A contribution file is empty.
- An id duplicates a local id (local always wins).
- An id duplicates another pack's id (first pack wins; later packs skipped).

`shrk packs get <pack>` and the MCP `get_pack` tool show the full breakdown
per pack.

## Pack doctor

```bash
shrk packs doctor
shrk packs doctor --verify-signatures
shrk packs doctor --require-signatures
shrk packs doctor --require-signatures --secret "$PACK_SECRET"
```

The doctor checks:

| Check | Severity |
|---|---|
| Manifest is structurally valid | error |
| Contribution files exist on disk | error |
| Manifest has at least one resolved contribution | error |
| Tampered signature (`--verify-signatures`) | error |
| Pack ids collide with local ids | info |
| Pack ids collide with another pack | warning |
| Critical/high workflow rules have actionHints | warning |
| Templates have descriptions | warning |
| Pipelines have at least one step | warning |
| Pack is unsigned and `--require-signatures` is set | warning |

The same logic is exposed via the MCP `doctor_packs` tool.

## Pack contribution runtime test

`shrk packs test <path>` validates a pack at a given path. By default it
runs structural checks (package.json shape, expected asset files exist).
Pass `--load` to actually evaluate the pack:

```bash
shrk packs test ./my-pack --load
shrk packs test ./my-pack --trusted-load
shrk packs test ./my-pack --load --require-signature
```

`--load` imports each contribution file with dynamic `import()` (local
file only) and asserts the export shape:

- knowledge / rules / paths / templates / pipelines / presets / boundaries
  must export an array of items, each with a string `id`
- pipelines must declare at least one step
- `src/sharkcraft.plugin.ts` must default-export an object

`--trusted-load` adds template render probes — it calls each template's
`targetPath()` and `content()` with synthesized default variables and
flags any throws. The flag name says it: the loader evaluates pack code,
so only run `--trusted-load` on packs you trust.

What `--load` never does:

- run shell commands
- execute lifecycle scripts (postinstall, etc.)
- touch the network
- write to disk

Direct TS loading requires Bun. Under Node, `--load` reports the
limitation as a warning and falls back to the structural check.

## Signing a pack

```bash
export SHARKCRAFT_PACK_SECRET="$(openssl rand -hex 32)"

# Sign by manifest file:
shrk packs sign ./src/sharkcraft.plugin.ts --key-id mykey-v1

# Or sign by package directory (auto-resolves sharkcraft.manifest):
shrk packs sign ./my-sharkcraft-pack \
  --key-id my-pack-v1 \
  --verify-after-sign \
  --output ./my-sharkcraft-pack/src/sharkcraft.plugin.signed.json
```

Then either ship the `.signed.json` alongside the TS module, or replace the
TS manifest with the signed JSON in `package.json`:

```json
{ "sharkcraft": { "manifest": "./src/sharkcraft.plugin.signed.json" } }
```

Verification:

```bash
shrk packs verify                       # report-only
shrk packs verify --required            # exits 1 if any pack is unsigned/tampered
shrk packs doctor --require-signatures  # CI gate
```

## Signed JSON manifests (data, not code)

When `package.json` `sharkcraft.manifest` ends in `.json`:

- The discovery scanner reads it as JSON. It does **not** dynamic-import the
  file. JSON is data; treating it as code would defeat signing.
- The manifest's `contributions` paths still resolve relative to the
  package root.
- Signature verification is opt-in via `--verify-signatures`
  (or `verifyPackSignatures` in the inspector API).

This lets you ship signed, tamper-detectable manifests without forcing
consumers to run arbitrary TypeScript at config-load time.

## Trust model

- **TypeScript manifests / contribution files run via dynamic import.** Same
  trust model as `vite.config.ts` or `eslint.config.js`. Only install packs
  from sources you trust.
- **Signed JSON manifests give you tamper detection.** They do not make
  untrusted TS code safe; they prove the manifest content matches what the
  signer produced.
- **The MCP server never writes.** Pack manifests can declare templates and
  pipelines that an agent uses, but every write goes through `shrk apply`
  on a human's CLI.
- **Local entries always win.** A pack cannot override a project's rules or
  paths; duplicates are reported as warnings/info and the local version
  takes precedence.

Add a `SECURITY.md` to every pack you publish, documenting the signing
key, rotation policy, and how consumers should report tampering.

## Files whitelist

The pack tarball should contain knowledge + manifest only — no application
source, no build outputs, no `node_modules`. Tighten `files` in
`package.json`:

```json
{
  "files": [
    "src/sharkcraft.plugin.ts",
    "src/sharkcraft.plugin.signed.json",
    "src/assets/**/*.ts",
    "src/assets/**/*.md",
    "README.md",
    "SECURITY.md",
    "LICENSE"
  ]
}
```

Run `npm pack --dry-run` to confirm the file list.
