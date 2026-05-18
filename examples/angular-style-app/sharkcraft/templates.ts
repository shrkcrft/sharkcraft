import { defineTemplate } from '@shrkcrft/templates';

export const angularComponent = defineTemplate({
  id: 'angular.component',
  name: 'Angular Component',
  description: 'Creates a minimal Angular standalone component (style-only example).',
  tags: ['angular', 'component'],
  scope: ['angular'],
  appliesWhen: ['generate-component'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case file basename' },
    { name: 'pascal', required: true, description: 'PascalCase class name (without "Component")' },
  ],
  files: ({ name, pascal }) => [
    {
      targetPath: `src/app/components/${name}/${name}.component.ts`,
      content: `import { Component, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-${name}',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: \`<p>${pascal} works</p>\`,
})
export class ${pascal}Component {}
`,
    },
  ],
  postGenerationNotes: ['Add a spec file next to the component if it contains real logic.'],
});

export default [angularComponent];
