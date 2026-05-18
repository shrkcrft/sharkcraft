# Scaffold patterns

A **scaffold pattern** is a pack contribution that says "when you see a
file matching this path/shape, suggest this template id with these
variables." Inference uses patterns to seed `infer templates` /
`onboard --scaffold-templates --ast` with high-confidence candidates
without re-implementing matching locally.

Patterns are **data**. The inspector layer interprets them — they cannot
run shell, evaluate code, or touch the network.

## Contributing patterns from a pack

Add a `scaffoldPatternFiles[]` entry to your pack manifest:

```ts
import { definePackManifest } from '@shrkcrft/plugin-api';

export default definePackManifest({
  schema: 'sharkcraft.pack/v1',
  info: { name: '@your-org/pack', version: '0.1.0' },
  contributions: {
    scaffoldPatternFiles: ['./src/assets/scaffold-patterns.ts'],
    // …
  },
});
```

Then default-export an array of patterns from that file:

```ts
import { defineScaffoldPatterns } from '@shrkcrft/plugin-api';

export default defineScaffoldPatterns([
  {
    id: 'app.service-contract-pattern',
    title: 'Service contract scaffold',
    description: 'Detects service contracts and maps them to app.service-contract.',
    matchPaths: ['packages/app/src/contracts/**/*.ts'],
    templateId: 'app.service-contract',
    variables: [
      { name: 'name', from: 'filename.kebab' },
      { name: 'pascal', from: 'className.stripPrefix:I' },
    ],
    appliesWhen: ['onboard', 'infer-template', 'create-service'],
    confidence: 'high',
    tags: ['app', 'service'],
  },
]);
```

## Variable extraction strategies

| Strategy                       | Source                                                           |
|--------------------------------|------------------------------------------------------------------|
| `filename.kebab`               | basename in kebab-case (`user-profile`)                          |
| `filename.pascal`              | basename in PascalCase (`UserProfile`)                           |
| `className`                    | PascalCase of basename (alias for `filename.pascal`)             |
| `className.stripPrefix:<P>`    | PascalCase basename with `<P>` stripped (e.g. `I` from `IUserService`)|
| `functionName`                 | camelCase of basename                                            |
| `directoryName`                | name of the file's parent directory                              |
| `nearestPackageName`           | nearest `package.json` `name` field                              |

## CLI

```bash
shrk scaffolds list           # every pattern with id, template, source
shrk scaffolds get <id>       # full pattern + match paths + variables
shrk scaffolds doctor         # validate (template exists, strategies recognized, …)
shrk infer templates --ast    # candidates using patterns first, AST second
```

## MCP

```jsonc
// list_scaffold_patterns        — every loaded pattern (read-only)
// get_scaffold_pattern          — one pattern by id
// get_scaffold_pattern_doctor   — validation issues + next CLI command
```

All three are read-only. They never load pack code with side effects.

## Doctor rules

`shrk scaffolds doctor` errors when:

- `id` is missing/empty
- `templateId` doesn't resolve to a known template
- `confidence` isn't one of `high|medium|low`
- `matchPaths` contains a non-string entry
- a variable's `from` strategy is unrecognized

Doctor warns when `title` or `description` is missing, when `appliesWhen`
is empty (the pattern will never be consulted), and when a `templateId`
isn't registered in the active project.

## Safety

- Patterns are pure data — they cannot run shell commands.
- Inference uses dynamic `import()` of pattern files (local file only, no
  network).
- `--trusted-load` in `shrk packs test` evaluates pack code but still
  doesn't run shell.
- The inspector layer interprets `matchPaths` via a tiny glob compiler;
  no `minimatch` dependency.

## Local scaffold patterns (R29)

R29 extends the loader to read a local `sharkcraft/scaffold-patterns.ts`
file (was pack-only). The SharkCraft engine repo ships 8 self-patterns
that describe how to add a new piece of engine surface (CLI command,
MCP tool, inspector module, command catalog entry, JSON schema export,
docs page, policy, decision). See `sharkcraft/scaffold-patterns.ts` for
the canonical list.

Loader order: local file first, pack contributions after — duplicate
ids from packs are skipped with a warning so local wins.
