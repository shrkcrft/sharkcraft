import type { TemplateVariableValues } from '@shrkcrft/templates';
import type { NamingStrategy, OverwriteStrategy } from './overwrite-strategy.ts';

export interface IGenerationRequest {
  templateId: string;
  /** Primary "name" passed to the template — used as the kebab-case basename, etc. */
  name?: string;
  variables: TemplateVariableValues;
  projectRoot: string;
  overwriteStrategy?: OverwriteStrategy;
  namingStrategy?: NamingStrategy;
  /** If false (default), no files are written — only the plan is returned. */
  write?: boolean;
}
