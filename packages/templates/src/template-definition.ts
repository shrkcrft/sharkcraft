import type { ITemplateVariable, TemplateVariableValues } from './template-variable.ts';

/**
 * Subset of @shrkcrft/generator's `IPlannedChange` re-declared here to
 * avoid a generator → templates → generator cycle. The two shapes are kept
 * structurally equal by `IPlannedChange` consumers.
 */
export interface ITemplateChange {
  targetPath: string;
  operation:
    | { kind: 'create'; content: string; description?: string }
    | { kind: 'append'; snippet: string; ifMissing?: string; description?: string }
    | { kind: 'insert-after'; anchor: string; snippet: string; ifMissing?: string; description?: string }
    | { kind: 'insert-before'; anchor: string; snippet: string; ifMissing?: string; description?: string }
    | { kind: 'replace'; find: string; replaceWith: string; expectMatches?: number; description?: string }
    | { kind: 'export'; from: string; symbols?: readonly string[]; ifMissing?: string; description?: string }
    | {
        kind: 'ensure-import';
        from: string;
        symbols?: readonly string[];
        typeOnly?: boolean;
        defaultBinding?: string;
        namespaceBinding?: string;
        description?: string;
      }
    | {
        kind: 'insert-enum-entry';
        enumName: string;
        entryName: string;
        entryValue: string;
        description?: string;
      }
    | {
        kind: 'insert-object-entry';
        objectName: string;
        entryKey: string;
        entryValue: string;
        shorthand?: boolean;
        description?: string;
      }
    | {
        kind: 'insert-before-closing-brace';
        containerName: string;
        snippet: string;
        ifMissing?: string;
        description?: string;
      }
    | {
        kind: 'insert-between-anchors';
        beginAnchor: string;
        endAnchor: string;
        snippet: string;
        ifMissing?: string;
        description?: string;
      };
}

/**
 * Anchor metadata declared by a template.
 *
 * Templates can declare:
 *   - `producedAnchors`: anchor strings that the template body GUARANTEES to
 *     produce (e.g. `// region:plugin-list`). Template drift verifies these
 *     anchors appear in the rendered output.
 *   - `requiredAnchors`: anchor strings that the template REQUIRES in its
 *     target files (for update ops). Self-config doctor / template drift
 *     verify that some other template or scaffold provides them; missing
 *     anchors surface as actionable diagnostics.
 */
export interface ITemplateAnchorDeclaration {
  /** Anchor literal as it must appear in the file. */
  anchor: string;
  /** Where the anchor lives (file glob or target path). */
  in: string;
  /** Why the template needs / produces this anchor. */
  purpose?: string;
  /** Operation kinds that use this anchor (informational). */
  usedBy?: ReadonlyArray<
    | 'insert-after'
    | 'insert-before'
    | 'insert-between-anchors'
    | 'insert-before-closing-brace'
    | 'insert-enum-entry'
    | 'insert-object-entry'
  >;
}

export interface ITemplateFile {
  /** Final file path relative to project root. */
  targetPath: string;
  /** File contents. */
  content: string;
  /** Optional MIME or hint, e.g. "typescript". */
  language?: string;
  /** Default: false (do not overwrite if exists). */
  overwrite?: boolean;
}

export type TargetPathResolver =
  | string
  | ((values: TemplateVariableValues) => string);

export type ContentResolver =
  | string
  | ((values: TemplateVariableValues) => string);

export type FilesResolver = (values: TemplateVariableValues) => ITemplateFile[];

export type ChangesResolver = (values: TemplateVariableValues) => ITemplateChange[];

export interface ITemplateDefinition {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
  scope: readonly string[];
  appliesWhen: readonly string[];
  variables: readonly ITemplateVariable[];
  /** Single-file template: target path. */
  targetPath?: TargetPathResolver;
  /** Single-file template: content. */
  content?: ContentResolver;
  /**
   * Multi-file template: file factory.
   * Each returned entry becomes a CREATE planned change.
   */
  files?: FilesResolver;
  /**
   * v2 template: mixed CREATE / UPDATE planned changes.
   * Templates may declare both `files()` and `changes()`; the rendered set is
   * the concatenation, with `files()` entries normalised to CREATE operations.
   */
  changes?: ChangesResolver;
  /** Post-generation notes shown to the user. */
  postGenerationNotes?: readonly string[];
  /** Related knowledge entry IDs. */
  related?: readonly string[];
  /**
   * Optional template profile metadata used by template-drift,
   * scaffold-coverage, and the `shrk task` recommender. All fields are
   * informational; the renderer ignores them. Generic engine code never
   * encodes project-specific values here.
   */
  metadata?: {
    /** Files that must NOT be produced by this template (regex fragments). */
    forbiddenPathFragments?: readonly string[];
    /** Plugin lifecycle profile ids this template depends on. */
    requiredProfileIds?: readonly string[];
    /** Convention ids this template's outputs are expected to satisfy. */
    requiredConventionIds?: readonly string[];
    /** Helper ids that complete the workflow around this template. */
    requiredHelperIds?: readonly string[];
    /** Language profiles required for this template to make sense. */
    requiredLanguages?: readonly string[];
    /** Framework profiles required for this template to make sense. */
    requiredFrameworks?: readonly string[];
    /** Anchors the template body GUARANTEES to produce. */
    producedAnchors?: readonly ITemplateAnchorDeclaration[];
    /** Anchors the template REQUIRES to exist in its target files. */
    requiredAnchors?: readonly ITemplateAnchorDeclaration[];
    /** Optional ids of registration hints applicable to this template. */
    registrationHintIds?: readonly string[];
  };
}

export function defineTemplate(input: ITemplateDefinition): ITemplateDefinition {
  if (!input.id) throw new Error("defineTemplate: 'id' is required");
  if (!input.name) throw new Error(`defineTemplate: 'name' is required for ${input.id}`);
  if (!input.files && !input.changes && !(input.targetPath && input.content)) {
    throw new Error(
      `defineTemplate: ${input.id} must provide either 'files', 'changes', or both 'targetPath' and 'content'`,
    );
  }
  return {
    ...input,
    tags: Object.freeze([...input.tags]),
    scope: Object.freeze([...input.scope]),
    appliesWhen: Object.freeze([...input.appliesWhen]),
    variables: Object.freeze([...input.variables]),
    postGenerationNotes: input.postGenerationNotes
      ? Object.freeze([...input.postGenerationNotes])
      : undefined,
    related: input.related ? Object.freeze([...input.related]) : undefined,
  };
}
