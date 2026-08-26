# Generated-artifact drift & provenance (`shrk generated check`)

Repos with codegen commit the generated output, and two things silently rot:

1. Someone **hand-edits** a generated file. The build compiles it perfectly
   happily; the next regen clobbers the edit, or the file quietly diverges from
   its source.
2. A generated file loses its **"do not edit" provenance header**, so the next
   person to open it has no idea it is generated.

Neither is visible to a type-checker, and an agent *remembering* to regenerate is
exactly the guarantee you cannot get. Only **regenerate-into-a-temp-dir-and-diff**
catches the edit deterministically.

```bash
shrk generated list                        # every declared rule
shrk generated check [--id X]              # regen → temp dir → diff both ways + headers
shrk generated check --headers-only        # header contract only; never spawns
shrk generated update [--id X]             # run the regen in place — the bless step
shrk generated explain --id X              # what the rule sees, without regenerating
```

> These share the `generated` noun with the generated-code **classifier**
> (`shrk generated report` / `protect`, see [generated-code.md](generated-code.md)):
> that half *finds* what is generated, this half *proves it has not drifted*.

## Configuring

```ts
export default defineSharkCraftConfig({
  generatedArtifacts: [
    {
      id: 'views',
      generatedGlob: ['src/**/generated/**/*.ts', 'src/**/generated/**/*.kt'],
      regen: 'npm run regen -- --out {TMP}',   // MUST write the full set into {TMP}
      compare: 'bytes',                         // 'bytes' | 'normalized-whitespace'
      provenanceHeader: {
        mustMatch: 'GENERATED .* do not edit',  // regex every generated file must carry
        withinLines: 10,                        // how much of the head counts as "the header"
        forbidOutside: true,                    // flag hand-written files WEARING the header
        pointsToRegenCommand: true,             // advisory: header should name the regen
      },
      failOnEmpty: true,
    },
  ],
});
```

`generatedGlob` is a list because the glob matcher has no brace expansion — list
one glob per extension.

> **Trust boundary.** `regen` (and every `sources[].regen`) spawns a shell
> command, so it is honoured only from the repo's **own**
> `sharkcraft.config.ts`; the pack-plane merge seam drops any pack-contributed
> rule that declares one. A **header-only** rule (no `regen`)
> never spawns anything and merges from a pack normally.

## Mixed trees: several writers + hand-maintained files

A real `generated/` directory is rarely one command's output. Two things break a
single-writer rule over such a tree, and both produce **false** findings — which
is worse than no rule, because you stop trusting the ones that are real:

- Files written by a **different** generator are reported `only-committed` (this
  regen no longer produces them — because it never did).
- Files that are legitimately **hand-maintained**, pending a generator that does
  not exist yet, are reported `missing-header`.

Declare the writers separately, and bless the hand-written files:

```ts
{
  id: 'views',
  generatedGlob: ['src/**/generated/*.ts'],              // the whole mixed tree
  sources: [                                              // N writers, each owns a sub-glob
    { id: 'views', regen: 'gen views --out {TMP}', glob: ['src/**/generated/*View.ts'] },
    { id: 'dtos',  regen: 'gen dtos  --out {TMP}', glob: ['src/**/generated/*Dto.ts'] },
  ],
  handMaintained: ['src/**/generated/LegacyThing.ts'],    // in the dir, legitimately hand-written
  provenanceHeader: { mustMatch: 'GENERATED .* do not edit', withinLines: 30 },
}
```

### `sources[]` — one regen per slice

Each writer regenerates into its **own** temp dir and is diffed against **only
its own** committed files, so one writer's output can never be reported as
another's stale file. The artifact is their union; `shrk generated update` runs
every writer, because blessing one slice and calling the artifact updated is
itself a way to drift.

`sources` and the single-writer `regen` are mutually exclusive — a rule is one
or the other, never both.

### `handMaintained[]` — a bless that cannot silently widen

Listed files are excluded from the header contract **and** from every byte
comparison. The exemption is deliberately narrow:

- **The last path segment must be a literal filename.**
  `src/**/generated/LegacyThing.ts` is fine (it names one file, at any depth);
  `src/**/generated/*.ts` is refused at config load. A wildcard basename would
  silently absorb every new file dropped into the directory, turning a reviewed
  per-file exemption into a blanket opt-out — and the rule would then pass
  forever without checking anything.
- **A pattern matching no file is reported** as a stale bless (warning). The
  blessed file was renamed or deleted, and the next file to take that name would
  otherwise inherit an exemption nobody reviewed.

### `handMaintainedMarker` — put the bless in the file

A real mixed tree can hold dozens of hand-written files, and enumerating them in
config means a list that drifts on every add or rename — with the churn landing
in a *different file* from the change that caused it. The marker moves the
exemption into the file itself:

```ts
{
  id: 'views',
  generatedGlob: ['src/**/generated/*.ts'],
  provenanceHeader: { mustMatch: 'GENERATED .* do not edit', withinLines: 30 },
  handMaintainedMarker: 'HAND-AUTHORED, NOT GENERATED',   // an in-file bless
  handMaintained: ['src/**/generated/CannotEditThis.ts'], // still supported
}
```

A file whose head carries the marker is hand-maintained — no config entry. The
exemption is then reviewed in the same diff that introduces it, which is where a
reviewer wants to see it. `shrk generated explain` labels which mechanism
blessed each file:

```
  hand-maintained    2 file(s) — exempt from header + byte checks
      src/generated/CannotEditThis.ts  (handMaintained[])
      src/generated/LegacyThing.ts     (in-file marker)
```

**The guarantees are unchanged:**

- **The marker may not overlap `provenanceHeader.mustMatch`** — in either
  direction, checked at config load. A marker a generated file's own header also
  satisfies would let every generated file exempt itself from the very check the
  marker exists to refine, and the rule would pass forever while enforcing
  nothing.
- **It is strictly per-file.** A file must literally carry the marker; there is
  still no wildcard blanket opt-out.
- **`unclassified` still applies.** A file with neither the generated header, nor
  the marker, nor a `handMaintained[]` entry is still a loud finding. The marker
  is a *third classification*, not an escape from being classified.
- The marker is read within the same `withinLines` window as the header, so "the
  top of the file" means one thing for both.

### `unclassified` — the tree must be fully accounted for

For a multi-writer rule the writers **partition** the tree. A file under
`generatedGlob` that matches no writer's glob and is not in `handMaintained` is
an `unclassified` finding at the rule's severity. Silence there would mean
quietly assuming a file is generated; you must say which it is.

(A single-writer rule owns everything its glob matches by definition, so nothing
in one can be unclassified.)

`shrk generated explain --id <id>` prints the full classification — per-writer
slices, the hand-maintained set, and anything unclassified — without running a
single regen.

## What the drift check catches

The comparison is deliberately **symmetric** — a one-directional check has the
same blind spot as a one-directional ledger:

| Difference | Meaning |
|---|---|
| `content` | present on both sides, bytes differ — the hand-edit signal (or a source change nobody regenerated) |
| `only-committed` | the regen no longer produces this file — a stale committed artifact |
| `only-regenerated` | the regen produces it but it was never committed |

`{TMP}` is substituted with a fresh empty directory, which is always removed
afterwards. The regenerated tree is matched onto the committed paths by longest
common **suffix**, because a regen rarely writes at the repo root; anything
unmatched is reported as `only-regenerated` rather than silently dropped. A regen
that writes **nothing** into `{TMP}` is an error, not a pass — it almost always
means the command ignores its output path.

`shrk generated update` runs the same command with `{TMP}` substituted for the
project root, so the one bless step is `update` + `git diff`.

## What the header check catches

Purely from reading files — no regen, no spawn:

| Finding | Meaning |
|---|---|
| `missing-header` | a file inside `generatedGlob` carries no matching header |
| `mislabeled` | a file **outside** the glob carries one — a hand-written file sending its next editor to a regen that will never touch it |
| `no-regen-pointer` | advisory (warning): the header does not name the regen command |

When `forbidOutside` is set without an explicit `outsideGlob`, the mislabel scan
is bounded to `**/*.<ext>` for each extension in `generatedGlob` — never a
whole-tree read of every file type.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every selected rule was checked and matches. |
| `1` | Drift, a hard header finding, or a failed regen. |
| `2` | Nothing was checked — every glob matched 0 files, or no rules are declared. |

Set `failOnEmpty: true` to make a stale glob a hard failure instead of a loud
skip. See [the loud-skip contract](gate-rules.md#the-loud-skip-contract).

## Worked example (this repo)

`docs/schemas/` is emitted by `shrk schemas emit` and committed:

```ts
generatedArtifacts: [{
  id: 'json-schemas',
  generatedGlob: ['docs/schemas/*.json', 'docs/schemas/INDEX.md'],
  regen: 'bun packages/cli/src/main.ts schemas emit --out {TMP} --write',
  compare: 'bytes',
  failOnEmpty: true,
}]
```

```
=== Generated-artifact drift ===
  evaluated          1 of 1
  ✓ json-schemas  (37 files, byte-identical to a fresh regen)
```
