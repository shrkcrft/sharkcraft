/**
 * Scaffold patterns let a pack express "if you see a file matching these
 * paths, suggest this template id with these variables." Inference uses them
 * to seed `infer templates` / `onboard --scaffold-templates` with high-
 * confidence candidates without re-implementing pattern matching locally.
 *
 * Scaffold patterns are read-only data — they cannot execute code, shell
 * commands, or run any pack-provided functions. The match step happens in
 * the inspector layer.
 */

/** A single variable extraction strategy. Values are recognized strings. */
export type ScaffoldExtractionStrategy =
  | 'filename.kebab'
  | 'filename.pascal'
  | 'className'
  | `className.stripPrefix:${string}`
  | 'functionName'
  | 'directoryName'
  | 'nearestPackageName';

export interface IScaffoldPatternVariable {
  /** Variable name as exposed to the template renderer (e.g. "name"). */
  name: string;
  /** Where the value should come from. */
  from: ScaffoldExtractionStrategy;
  /** Optional human description of what this variable represents. */
  description?: string;
}

export interface IScaffoldPattern {
  /** Stable id, e.g. "myproj.plugin-contract-pattern". */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** What this pattern detects and where it points. */
  description: string;
  /** Glob-like include patterns relative to the project root. */
  matchPaths: readonly string[];
  /** Optional exclude patterns. */
  excludePaths?: readonly string[];
  /** Template id this pattern suggests when matched. */
  templateId: string;
  /** Variable extraction strategies. */
  variables: readonly IScaffoldPatternVariable[];
  /** Lifecycle hooks where this pattern is consulted. */
  appliesWhen: readonly ('onboard' | 'infer-template' | 'create-plugin' | string)[];
  /** Confidence floor when matched. */
  confidence: 'high' | 'medium' | 'low';
  /** Free-form tags for grouping. */
  tags?: readonly string[];
  /** Optional notes shown in pack doctor / scaffolds list. */
  notes?: readonly string[];
  /**
   * Optional evidence the inspector should check before accepting the match
   * (e.g. "the file exports an interface starting with I"). Strings only —
   * the actual checks are inspector-side.
   */
  requiredEvidence?: readonly string[];
}

export function defineScaffoldPattern(pattern: IScaffoldPattern): IScaffoldPattern {
  return pattern;
}

/** Helper used by pack authors to ship an array of scaffold patterns. */
export function defineScaffoldPatterns(
  patterns: readonly IScaffoldPattern[],
): readonly IScaffoldPattern[] {
  return patterns;
}

export const RECOGNIZED_SCAFFOLD_STRATEGIES: ReadonlySet<string> = new Set([
  'filename.kebab',
  'filename.pascal',
  'className',
  'functionName',
  'directoryName',
  'nearestPackageName',
]);

export function isRecognizedScaffoldStrategy(s: string): boolean {
  if (RECOGNIZED_SCAFFOLD_STRATEGIES.has(s)) return true;
  if (s.startsWith('className.stripPrefix:')) return true;
  return false;
}
