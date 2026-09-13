# Constructs (`shrk constructs ...`)

A **construct** is a generic, project-defined "thing" — service, plugin,
module, feature, policy, capability, etc. Constructs bundle related
files, public-API entries, events, tokens, commands, and links to
knowledge / rules / templates / pipelines so that `shrk constructs
trace <id>` produces a single coherent view of how the concept lives in
the codebase.

SharkCraft does **not** hardcode a fixed set of types. The `type` field
is a free string — packs and projects model their own domains.

## Defining constructs

In `sharkcraft/constructs.ts`:

```ts
import { defineConstruct } from '@shrkcrft/plugin-api';

export default [
  defineConstruct({
    id: 'user-service',
    type: 'service',
    title: 'User service',
    description: 'HTTP handler + persistence for users.',
    files: ['src/services/user.service.ts'],
    publicApi: ['src/services/user.service.ts'],
    events: ['user.created', 'user.deleted'],
    tokens: ['USER_REPOSITORY'],
    relatedKnowledge: ['app.services'],
    relatedRules: ['http.routes.thin'],
    relatedTemplates: ['typescript.service'],
  }),
];
```

Packs contribute constructs via the manifest:

```ts
contributions: {
  constructFiles: ['./src/assets/constructs.ts'],
  constructFacetFiles: ['./src/assets/construct-facets.ts'], // optional
}
```

`defineConstructFacet` works similarly for stand-alone facet files that
get folded back into their target construct.

### Related ids are validated (round 11)

`relatedKnowledge`, `relatedRules`, `relatedTemplates`, `relatedPipelines` and
`relatedPathConventions` are resolved by `shrk self-config doctor` (and `packs
doctor` for a pack's constructs): an id no registry has is `xref-dangling`, one
that resolves only in the wrong kind (a template id in `relatedRules`) is
`xref-wrong-kind`. `shrk constructs related <id>` prints each id with the
namespace it resolved into, or `UNRESOLVED` (`--json` adds `resolvedAs` /
`status`).

A facet value is free-form (an event topic, a token name) unless it declares
what it names:

```ts
facets: {
  'boundary-rules': [{ id: 'b1', value: 'app.no-db-in-ui', resolvesAs: ['boundary-rule'] }],
}
```

Only values with `resolvesAs` are resolved; the rest are counted
(`examined.facetValuesUndeclared`). An unknown kind name in `resolvesAs` is an
error (`xref-unknown-kind`) — a typo must not quietly turn an id back into text.
Stand-alone facet files carry `resolvesAs` too.

## CLI

```
shrk constructs list [--type <type>]
shrk constructs get <id>
shrk constructs trace <id>
shrk constructs api <id>
shrk constructs events [<id>]
shrk constructs tokens [<id>]
shrk constructs facets <id>
shrk constructs search <query>
shrk constructs infer [--type X] [--confidence high|medium|low] [--limit N] [--write-drafts]
```

## Auto-discovery (R12)

`shrk constructs infer` proposes construct candidates by scanning:

- Folder names (`services/`, `routes/`, `controllers/`, `components/`,
  `features/`, `modules/`).
- Filename suffixes (`*.service.ts`, `*.controller.ts`).
- Import-graph clusters (files imported by N siblings).
- Simple string-constant patterns inside the candidate files.

```bash
shrk constructs infer
shrk constructs infer --type service --confidence high
shrk constructs infer --json --limit 20
shrk constructs infer --write-drafts
```

`--write-drafts` writes `sharkcraft/construct-drafts/constructs.draft.ts`
that contains `defineConstruct({...})` bodies for human review. The
generated module is **not loaded** by SharkCraft — copy the entries you
want into your live `sharkcraft/constructs.ts`.

MCP: `infer_constructs_preview` returns the same payload without writes.

## Required fields and rejected constructs (round 12)

A construct needs a non-empty `id` and a string `type` (`IConstructInput`); a
facet needs string `id` / `constructId` / `kind` / `value`, and a
`constructId` that names a loaded construct. An id-less construct and a facet
with no target used to be dropped silently, a construct without `type` was
ACCEPTED and crashed `shrk constructs list`, and a construct file that failed
to import was swallowed. Now each refused entry is a REJECTED entry — `shrk
constructs list` ends with `⚠ N entries rejected from <file>: …`, the
self-config doctor reports `construct-invalid` / `construct-facet-invalid`
(error) — and a file that fails to import is a load failure on `shrk packs
doctor` / `packs contributions`.

## MCP (read-only)

- `list_constructs`
- `get_construct`
- `trace_construct`
- `get_construct_api`
- `list_construct_facets`
- `infer_constructs_preview`
