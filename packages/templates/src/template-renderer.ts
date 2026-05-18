import type {
  ITemplateChange,
  ITemplateDefinition,
  ITemplateFile,
} from './template-definition.ts';
import type { TemplateVariableValues } from './template-variable.ts';

export interface IRenderedTemplate {
  templateId: string;
  /**
   * CREATE-only files (legacy `files()` callback). Kept for v1 callers; the
   * generator package normalises these to CREATE-kind planned changes.
   */
  files: ITemplateFile[];
  /**
   * v2 planned changes (mixed CREATE/UPDATE). `files()` results are NOT
   * duplicated here — consumers handle both lists, treating `files` as the
   * CREATE-only legacy surface.
   */
  changes: ITemplateChange[];
  postGenerationNotes: readonly string[];
}

export function renderTemplate(
  template: ITemplateDefinition,
  values: TemplateVariableValues,
): IRenderedTemplate {
  const files: ITemplateFile[] = [];
  const changes: ITemplateChange[] = [];

  if (template.files) {
    for (const f of template.files(values)) {
      files.push({
        targetPath: f.targetPath,
        content: f.content,
        language: f.language,
        overwrite: f.overwrite ?? false,
      });
    }
  } else if (template.targetPath && template.content) {
    const target =
      typeof template.targetPath === 'function' ? template.targetPath(values) : template.targetPath;
    const content =
      typeof template.content === 'function' ? template.content(values) : template.content;
    files.push({ targetPath: target, content, overwrite: false });
  }

  if (template.changes) {
    for (const c of template.changes(values)) {
      changes.push(c);
    }
  }

  return {
    templateId: template.id,
    files,
    changes,
    postGenerationNotes: template.postGenerationNotes ?? [],
  };
}
