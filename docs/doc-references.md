# Prose-reference rot (`shrk docs references check`)

shrk validates id references — but only the **structured** `references[]` on a
knowledge entry. The same ids written as **free text** are unchecked:

```md
| Task        | Command                          |
|-------------|----------------------------------|
| A component | `shrk gen nge.angular-component` |
| A sandbox   | `shrk gen nge.angular-renderer`  |   ← this template was renamed
```

Markdown has no build and no type-check. That table drifts from the registry
with **zero signal** until someone runs the command and it fails. A real audit
found ten stale template ids in one agent skill file this way.

```bash
shrk docs references check [--id <ids>] [--json]   # unresolved id → finding
shrk docs references explain --id <id>             # every token + where it resolved
shrk docs references list                          # the declared rules
```

It also joins [`shrk gates`](gate-rules.md) like every other plane — `gates
check`, `gates coverage`, `gates explain <id>`, `gates try`.

> Not to be confused with `shrk docs check`, which verifies **shrk's own
> required-doc completeness** (does `overview.md` exist, does the README carry
> its sections). This verifies **id references inside project prose**.

## Configuring

```ts
export default defineSharkCraftConfig({
  docReferences: [
    {
      id: 'doc-template-ids',
      description: 'Every nge.* id cited in prose must be a registered template.',
      files: ['.claude/skills/**/*.md', 'docs/**/*.md', 'README.md'],
      tokenPattern: '\\bnge[.-][a-z0-9-]+\\b',   // the id SHAPE worth considering
      resolvesAs: ['template', 'playbook'],       // registries to try
      requireContext: 'backtick',                 // default — see below
      exempt: ['nge.example-foo'],                // known non-references
      exemptMarker: 'ref-allow',                  // `<!-- ref-allow -->` skips a line
      severity: 'error',
      hint: 'Run `shrk templates list` and cite a registered id.',
    },
  ],
});
```

`tokenPattern` is deliberately project-supplied: the engine has no business
guessing what an id looks like in someone else's namespace.

`files` is a glob list like every gate plane's: a leading `!` excludes
(`['docs/**/*.md', '!docs/drafts/**']` — drafts are never scanned),
order-independently; at least one inclusion glob is required. See
[negation globs](gate-rules.md#negation-globs-round-12).

### Writing a `tokenPattern` that does not over-match

`\b` is weaker than it looks — it sits between a word and a non-word character,
so `\bengine\.[a-z-]+\b` also matches the tail of
`@scope/generator-engine.generate`, because the `-` before `engine` is a word
boundary. That produces a confident finding about a module path.

Anchor the *left* side against the characters your ids never follow:

```jsonc
"tokenPattern": "(?<![\\w./-])nge[.-][a-z0-9-]+\\b"
```

`gates try --rule-file <f> --full` is the way to check this before committing
the rule: it dumps every token the pattern captured, so an over-match is visible
in one run instead of arriving as noise in CI.

### `resolvesAs` — the registries a token may resolve against

A token resolving in **any** listed registry passes — a `nge.foo` may
legitimately be a template *or* a playbook.

| Kind | Ids come from |
|---|---|
| `template` | `shrk templates list` |
| `pipeline` | `shrk pipelines list` |
| `playbook` | `shrk playbooks list` |
| `construct` | `shrk constructs list` |
| `policy` | the policy **declarations** — loaded, never run |
| `boundary-rule` | the boundary registry |
| `path-convention` | `shrk paths list` |
| `helper` | built-in + pack-contributed helpers |
| `command` | shape (`shrk …` / `bun …`) — the catalog lives above this layer |

### One resolver, sourced per kind from its own `list` verb

Every consumer of "does this id exist" reads **one** module
(`reference-registry`): this plane, the structured `references[]` on a knowledge
entry, and the self-config doctor's cross-reference checks. Each kind reads the
exact source its `list` verb prints — not a parallel array that happens to
agree.

That used to be a claim in this file rather than a property of the code, and the
two were not the same thing. Three modules resolved ids from their own sources;
the self-config doctor's hand-written "known ids" union omitted policies,
decisions, scaffold patterns and paths, so **seventeen** of shrk's own correctly
registered ids were reported unknown. A `list`/`resolve` divergence on any kind
is now a test failure the day it is introduced.

The resolver also answers for kinds prose never cites — `knowledge`, `rule`,
`decision`, `convention`, `contract-template`, `migration-profile`,
`workspace-profile`, `routing-hint`, `registration-hint`, `scaffold-pattern` —
so that the doctor and this plane cannot drift apart. `resolvesAs` is
unchanged: it still accepts exactly the kinds in the table above.

### Declarability (round 12)

`list ≡ resolve` proves the resolver reads what the `list` verb prints — over
ids that already exist, so a kind whose registry NOTHING can fill would pass it
vacuously and turn every reference to it into a permanent NOT VERIFIED. So
every kind the resolver answers for is also **declarable**: it has a row in
`REFERENCE_KIND_DECLARATIONS` (`packages/inspector/src/reference-kind-declarations.ts`,
a `Record<IdReferenceKind, …>` — a kind added without a row does not compile)
naming how its ids come to exist, and the r76 lock declares one id through
EVERY path of every row (a real pack under `node_modules` for a pack key) and
proves the resolver then lists it.

| kind | declared via | shown by |
|---|---|---|
| `template` | config/pack `templateFiles` · `sharkcraft/templates.ts` | `shrk templates list` |
| `pipeline` | config/pack `pipelineFiles` · `sharkcraft/pipelines.ts` | `shrk pipelines list` |
| `playbook` | config/pack `playbookFiles` · `sharkcraft/playbooks.ts` | `shrk playbooks list` |
| `policy` | pack `policyCheckFiles` · `sharkcraft/policies.ts` | `shrk policy list` |
| `construct` | pack `constructFiles` · `sharkcraft/constructs.ts` | `shrk constructs list` |
| `helper` | pack `helperFiles` · `sharkcraft/helpers.ts` | `shrk helper list` |
| `boundary-rule` | config/pack `boundaryFiles` | `shrk boundaries list` |
| `path-convention` | config/pack `pathFiles`, pack `pathConventionFiles` · `sharkcraft/paths.ts` | `shrk paths list` |
| `rule` | config/pack `ruleFiles` · `sharkcraft/rules.ts` | `shrk rules list` |
| `knowledge` | config/pack `knowledgeFiles` / `docsFiles` · `sharkcraft/knowledge.ts` | `shrk knowledge list` |
| `decision` | pack `decisionFiles` · `sharkcraft/decisions.ts` · `sharkcraft/decisions/*.md` · `docs/adr/*.md` | `shrk self-config resolve <id>` |
| `convention` | config/pack `conventionFiles` · `sharkcraft/conventions.ts` | `shrk conventions list` |
| `contract-template` | pack `contractTemplateFiles` · `sharkcraft/contract-templates.ts` | `shrk contract template list` |
| `migration-profile` | pack `migrationProfileFiles` · `sharkcraft/migration-profiles.ts` | `shrk profiles list --kind migration` |
| `workspace-profile` | builtin (the `WorkspaceProfile` vocabulary) | `shrk profiles list --kind workspace` |
| `routing-hint` | config/pack `taskRoutingHintFiles` · `sharkcraft/task-routing-hints.ts` | `shrk self-config resolve <id>` |
| `registration-hint` | pack `registrationHintFiles` · `sharkcraft/registration-hints.ts` | `shrk registrations list` |
| `scaffold-pattern` | pack `scaffoldPatternFiles` · `sharkcraft/scaffold-patterns.ts` | `shrk scaffolds list` |

(Each local file also has its `…/index.ts` twin where the loader reads one; the
table in code is the authority.) The table has three consumers, so it cannot
drift into a doc-only list: the self-config doctor's loud-skip reason names how
to fill an empty kind (`… — declare migration-profile via pack key
migrationProfileFiles · sharkcraft/migration-profiles.ts …`), its `*-missing`
findings print the list verb as `next:`, and `shrk profiles list` renders its
empty state from it. `isReferenceKindDeclarable(kind)` is THE answer to "can
anything fill this kind?".

The lock has a **binding** half too, because declarability alone would not
have caught round 12's defect: `discovery.profileIds` was bound to the
declarable `migration-profile` kind — the wrong vocabulary. `PROBED_ID_FIELDS`
is the one field → kind table the doctor iterates; every `*Ids` field of
`IConventionAppliesTo`, `IRegistrationHintDiscovery` and template `metadata`
must have a row naming a declarable kind.

**Kind order is specificity.** A rule and a path convention are knowledge
entries of one type, so `rule` and `path-convention` are listed before their
superset `knowledge`. `referenceKindsOf(id)` returns EVERY kind that lists an
id, most specific first; `referenceKindOf(id)` is its first element (it used to
answer `knowledge` for every rule id).

**The structured twin.** This plane checks ids cited in PROSE. Ids in declared
`related`-style asset fields (knowledge `related` / `seeAlso` / `supersededBy`,
construct and boundary `related*`, template `related`) are resolved by the
declared cross-reference collector, through the same resolver — see
[self-config-doctor.md](self-config-doctor.md#declared-cross-references-round-11).

**Warming.** Several kinds load asynchronously (playbooks, constructs, policies,
pack helpers, conventions, contract templates, migration profiles, routing and
registration hints, scaffold patterns) while the resolver is synchronous. Every
CLI entry point calls `warmReferenceRegistries` first; an embedder calling
`checkDocReferences` directly must do the same. Forgetting is not silent — see
the next section.

### Refusing rather than crying wolf

Resolving against an **empty** registry cannot succeed, so every id checked
against it comes back unresolved. That is a gate confidently flagging *correct*
usage — worse than no gate, and the fastest way to get one switched off. So when
**every** kind a rule lists is empty, the rule reports an error instead of a
page of false findings:

```
! doc-playbook-ids  no ids are registered for playbook — nothing could resolve,
                    so every reference would be reported wrong (call
                    warmReferenceRegistries() before checking, or this repo has
                    no playbooks)
```

A rule listing several kinds still lints while **any** of them is populated —
only all-empty refuses.

The same reasoning drives the resolver's shape. A policy is listed under **both**
its declared id (`sharkcraft.mcp-read-only`, the name authors cite) and the
namespaced id the policy report prints (`local:sharkcraft.mcp-read-only`).
Listing only one of the two names would reject every reference written in the
other.

### Dot-directories

Prose lives where the code walkers deliberately do not go — an agent skill file
sits in `.claude/skills`. A rule's globs say which dot-directories it means, and
it gets **exactly those**: `.claude/skills/**` opens `.claude`, while `docs/**`
still never wanders into `.venv` or `.yarn`.

## Keeping it low-noise

The one real risk is flagging prose that merely *contains* an id-shaped string.
A linter that cries wolf gets switched off, so there are three controls.

**1 · `requireContext` — when a match counts as a reference**

| Value | Counts |
|---|---|
| `backtick` (default) | only tokens inside a `` `code span` `` or a fenced block |
| `off` | every match — right for a file that is *only* a reference table |
| `after` | only tokens **immediately** following one of `afterWords` |

A genuine instruction is nearly always written as code, so `backtick` catches
real references while a sentence musing about `nge.something` in plain prose is
left alone.

`after` means *immediately* follows: in `shrk gen nge.a — and nge.b`, only
`nge.a` qualifies. (Anything else would re-flag every later token on the line,
since the cue word still appears somewhere before it.) `requireContext: 'after'`
without `afterWords` is refused at config load — no token could ever qualify, so
the rule could only ever be a loud skip.

**2 · `exempt[]` and `exemptMarker`** — the `handMaintained` model. A global
allowlist for genuine examples, or a per-line `<!-- ref-allow -->` marker so the
exemption is reviewed in the diff that adds it. The marker may carry the reason
— `<!-- ref-allow: planned, not built yet -->` — which is the point of a
diff-reviewed exemption. It is **line-scoped**: it exempts tokens on its own
line only, so re-wrapping a paragraph can never silently widen it.

**3 · `gates coverage`** reports how many **tokens** the rule validated — not
how many files it matched. A rule whose globs hit 40 docs but whose context gate
rejects every token is enforcing nothing, and this is what makes that visible.

## `did you mean`

An unresolved reference carries the closest registered ids:

```
✗ doc-template-ids  2 unresolved reference(s) of 3 checked
    • nge.angular-renderer  (.claude/skills/which-template.md:6)
    • nge.sandbox-demo      (.claude/skills/which-template.md:7)
        did you mean: nge.sandbox-harness
```

Note the first finding gets **no** suggestion: nothing was close enough. The
cutoff scales with the query's length and is capped, because printing the
alphabetically-first id beside every typo trains people to ignore the line —
which costs more than the occasional missed hint.

## The loud-skip contract

A rule that checked nothing enforced nothing, and the two ways that happens need
different fixes, so they are reported distinctly:

```
✗ doc-template-ids  FAILED — 0 documents matched (moved-away/**/*.md)
✗ doc-template-ids  FAILED — 3 document(s) scanned but no token counted as a
                             reference (4 matched and were skipped — check `requireContext`)
```

`failOnEmpty` defaults to **true** for `error`-severity rules, as on every
plane. Set it explicitly when a rule may legitimately cover no docs.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every id cited in prose resolves (warnings may still be reported — the banner says so). |
| `1` | An `error`-severity rule has an unresolved reference, a broken pattern, or checked nothing. |
| `2` | Nothing was checked — no rules declared, or every rule skipped. |
| `3` | Usage error — unknown `--id`, bad config. |

## Trust boundary

The plane reads documents and consults registries. It **writes nothing and
spawns nothing**, so unlike `baselines[].compute.run` and
`generatedArtifacts[].regen`, a pack may contribute a `docReferences` rule
freely.

## Contributing rules from a pack (`docReferenceFiles`)

A pack ships doc-reference rules through the `docReferenceFiles` manifest slot
— each file default-exports `readonly IDocReferenceRule[]`, merged local-wins by
`id` at the pack-plane merge seam (a local rule with the same id wins):

```jsonc
// the pack's manifest
{
  "schema": "sharkcraft.pack/v1",
  "info": { "name": "@acme/docs-pack", "version": "1.0.0" },
  "contributions": { "docReferenceFiles": ["./doc-references.ts"] }
}
```

Each element is validated with the SAME schema a local `docReferences[]` rule
is (`DocReferenceRuleSchema`); there is no shell to veto. Since round 13 the
slot is declared (`CONTRIBUTION_FILE_KEYS`, contribution kind `doc-reference`),
so a refused element travels the round-12 rejection channel like every other
gate plane: `packs contributions` names the file and the entry (exit 1), `packs
list` / `packs get` count the `doc-reference` kind, `packs test --load` reports
`asset-entry-rejected` before you publish, `self-config doctor` reports
`doc-reference-invalid`, and `gates check` and `docs references check` — the
plane's own verb — carry the rule as an ERRORED row (`failed validation — NOT
evaluated`, exit `1`; `docs references check --json` lists it under `rejected`,
and `--id` selects it). Before, the merge read the key but no
manifest declared it: a refused rule was one `! … invalid docReference element
… — skipped` line under a ✓, and a valid one was enforced while `packs
contributions` said the pack contributed no file. `expectEmpty` markers on a
pack rule's `files` need engine ≥ 0.1.0-alpha.31 (see
[intended-empty.md](intended-empty.md)).
