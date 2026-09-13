# Template system

Templates are **typed code-generators**. Each template declares variables, target path(s), and content.

## Single-file template

```ts
import { defineTemplate } from '@shrkcrft/templates';

export const tsService = defineTemplate({
  id: 'typescript.service',
  name: 'TypeScript Service',
  description: 'Creates a TypeScript service class.',
  tags: ['typescript', 'service'],
  scope: ['typescript'],
  appliesWhen: ['generate-service'],
  variables: [
    { name: 'name', required: true },
    { name: 'className', required: true },
  ],
  targetPath: ({ name }) => `src/services/${name}.service.ts`,
  content: ({ className }) => `export class ${className} {}\n`,
  postGenerationNotes: ['Add a *.spec.ts if this service contains real logic.'],
});
```

## Multi-file template

```ts
defineTemplate({
  id: 'typescript.feature',
  // ...
  files: ({ name, pascal }) => [
    { targetPath: `src/features/${name}/index.ts`, content: '...' },
    { targetPath: `src/features/${name}/${name}.service.ts`, content: '...' },
  ],
});
```

## Variables

`validateTemplateVariables` enforces `required`, `pattern`, and `choices`. Defaults are applied if values are missing.

## Operation shape (round 11)

A `changes()` op is checked against ONE allow-list —
`PLANNED_OPERATION_FIELDS` in `@shrkcrft/generator`, with one row per operation
kind (a new kind without a row fails the build). `planGeneration` validates
every op BEFORE evaluating it:

- an unknown kind or a missing required field → a `conflict` change naming the
  template, the change index, the missing fields, the unknown keys and a
  near-miss hint — e.g. `template 'reg.add' change[0] (insert-array-entry):
  missing required entryValue; unknown keys key, value — did you mean
  value→entryValue?` — so `gen` exits 1 with that line instead of a TypeError;
- unknown extra keys with every required field present → a plan warning (the
  engine ignores them).

`shrk templates lint` / `doctor` render `changes()` with sample variables and
run the same validator: `invalid-operation` (error), `operation-unknown-keys`
(warning), `render-threw` (warning — the ops were not checked).

## Declared remainders — `notScaffolded` / `manualSteps` (round 11)

A template can say what it deliberately does NOT do, from a closed vocabulary
(`TemplateRemainder`: `build-config`, `path-alias`, `workspace-registration`,
`tests`, `docs`, `other`):

```ts
defineTemplate({
  id: 'workspace.lib',
  // …
  notScaffolded: ['build-config', 'path-alias'],
  manualSteps: [{ description: 'Add the lib to tsconfig paths', covers: ['path-alias'] }],
});
```

`gen` (dry-run and write), `templates preview` and `templates get` print the
block after the post-generation notes (`Not scaffolded by this template: …` /
`Manual steps: …`). The machine surfaces carry the fields: `templates get
--json` and MCP `get_template` carry `notScaffolded`, `manualSteps` and the
printed `remainderLines` (one shape, `templateRemainderFields`); a task
packet's template rows (`task --json`, MCP `get_task_packet`) carry the
declared ones (`templateRemainderSummary`); and `IGenerationPlan.remainderLines`
carries the printed block for `create_generation_plan`. Template lint adds `template-remainder-shape` (error — an
unknown value or an empty step) and the heuristic `undeclared-remainder`
(**info only**, never fails): a CREATE lands in a directory that does not exist
yet, nothing rendered is build config (`package.json`, `tsconfig*.json`,
`project.json`, …), and neither `notScaffolded` nor a manual step covers
`build-config`.

## Preview

```bash
shrk templates preview typescript.service user-profile --var className=UserProfileService
```

Or programmatically:

```ts
import { previewTemplate } from '@shrkcrft/templates';
const preview = previewTemplate(template, values);
// preview.rendered.files[0].targetPath / content
```

## Loading and rejected templates (round 12)

The loader registers an exported object with a string `id` and `name`. A
missing list field (`tags`, `scope`, `appliesWhen`, `variables`) is
normalised to `[]` — a pack template without `tags` used to crash `shrk
templates list`. An array member (or the `default` object) meant as a template
that lacks `id` / `name`, and a different object reusing an id, are REJECTED
entries: `shrk templates list` ends with `⚠ 1 entry rejected from <file>:
'tpl.bad' (default[1]) — name: must be a string → shrk templates doctor`, and
the self-config doctor reports `template-invalid` (error). They used to appear
on no surface at all.

## Safety

- Templates can only produce files; they cannot execute side effects.
- Target paths must resolve to a location **inside the project root** or the change is marked `conflict`.
- Overwrites are off by default and require `--write` plus an overwrite strategy.
