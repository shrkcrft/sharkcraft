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

## Safety

- Templates can only produce files; they cannot execute side effects.
- Target paths must resolve to a location **inside the project root** or the change is marked `conflict`.
- Overwrites are off by default and require `--write` plus an overwrite strategy.
