# Registration hints (R35)

Pack-driven downstream registration. The engine ships zero hints; every
entry comes from a pack contribution (`registrationHintFiles[]`).

## Why

A generated construct often needs a downstream registration step that the
engine cannot guess — e.g. wire a plugin into the composer, add a route
entry, register a capability. Packs declare the *shape* of those steps as
**registration hints**; the engine surfaces them as previews. Apply stays
human-driven.

## Shape

```ts
interface IRegistrationHint {
  id: string;
  title: string;
  description?: string;
  variables?: { name; required; description?; defaultValue? }[];
  discovery: {
    targetFile?: string;                    // fixed relative path
    targetGlobs?: readonly string[];        // glob candidates
    conventionIds?: readonly string[];      // additional filter
    profileIds?: readonly string[];         // applicable lifecycle profiles
  };
  operations: ReadonlyArray<IRegistrationHintOperation>;
  requiresHumanReview?: boolean;
  validationCommands?: readonly string[];
  safetyNotes?: readonly string[];
  tags?: readonly string[];
}
```

`IRegistrationHintOperation` mirrors the plan-v2 source operation kinds
(`ensure-import`, `insert-enum-entry`, `insert-object-entry`,
`insert-before-closing-brace`, `insert-between-anchors`, `insert-after`,
`insert-before`, `append`, `export`).

## Commands

```bash
shrk registrations list [--source local|pack] [--json]
shrk registrations get <id> [--json]
shrk registrations doctor [--json]
shrk registrations preview <id> [--var key=value ...] [--json]
```

Preview is **read-only**. Ambiguous discovery (multiple glob matches)
emits `ambiguous: true` and refuses to guess.

## MCP

Three read-only tools (added to `ALL_TOOLS` and audit catalog):
- `list_registration_hints`
- `get_registration_hint`
- `preview_registration_hint`

No write tool. Preview is purely informational.

## Template metadata

Templates can declare which hints apply via
`metadata.registrationHintIds`. Self-config doctor cross-checks that the
referenced ids resolve; missing ids surface as
`template-registration-hint-missing`.

## Safety

- Hints are static data — no executable pack code.
- Operations are declarative; engine substitutes `{{var}}` placeholders.
- Engine never auto-applies a hint.
- Ambiguous discovery is reported, never guessed.
- `requiresHumanReview: true` is the default for any hint that uses
  `targetGlobs`.

## Schemas

- Registry: `sharkcraft.registration-hint-registry/v1`.
- Preview: `sharkcraft.registration-hint-preview/v1`.
