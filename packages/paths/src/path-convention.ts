import {
  defineKnowledgeEntry,
  KnowledgeType,
  type DefineKnowledgeInput,
  type IKnowledgeEntry,
} from '@shrkcrft/knowledge';

export interface IPathConvention extends IKnowledgeEntry {
  readonly metadata: Readonly<{ path: string; description?: string }> & Record<string, unknown>;
}

export type DefinePathConventionInput = Omit<DefineKnowledgeInput, 'type' | 'content'> & {
  /** The actual path (relative to project root). */
  path: string;
  /** Optional human description. Used as the entry content when no explicit content is given. */
  description?: string;
  /** Optional override for explicit content. */
  content?: string;
};

export function definePathConvention(input: DefinePathConventionInput): IPathConvention {
  const content =
    input.content ??
    `${input.description ?? input.title}\nCanonical path: ${input.path}`;
  const entry = defineKnowledgeEntry({
    ...input,
    type: KnowledgeType.Path,
    content,
    metadata: {
      ...(input.metadata ?? {}),
      path: input.path,
      description: input.description,
    },
  });
  return entry as IPathConvention;
}
