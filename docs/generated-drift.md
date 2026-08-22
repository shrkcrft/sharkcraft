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

> **Trust boundary.** `regen` spawns a shell command, so it is honoured only from
> the repo's **own** `sharkcraft.config.ts`; the pack-plane merge seam drops any
> pack-contributed rule that declares one. A **header-only** rule (no `regen`)
> never spawns anything and merges from a pack normally.

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
