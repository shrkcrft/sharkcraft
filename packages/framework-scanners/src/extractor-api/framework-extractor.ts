import type { IEdge, INode } from '@shrkcrft/graph';
import type { FrameworkName } from '../schema/framework-schema.ts';

/**
 * Plugin contract for a framework extractor.
 *
 * Each extractor inspects a single source file and returns the
 * framework-specific nodes + edges it produces. The runner walks the
 * project, applies every extractor whose `fileMatches` returns true,
 * dedupes, and writes the result to the framework store.
 *
 * Extractors must be **side-effect free** and deterministic. They take
 * file path + content and return data — no fs writes, no caching of
 * their own.
 */
export interface IFrameworkExtractor {
  /** Stable name (e.g. 'nestjs', 'react'). */
  framework: FrameworkName;
  /** Display label for diagnostics. */
  label: string;
  /**
   * Fast pre-filter: should the AST extractor pass run for this file?
   * Typically checks the path (e.g. `*.tsx`) and/or content fingerprint
   * (e.g. presence of `'@nestjs/common'` import or JSX).
   */
  fileMatches(file: { path: string; content: string }): boolean;
  /**
   * Run the full extraction against the file. Called only when
   * `fileMatches` returns true. Errors raised here are converted to
   * diagnostics by the runner — never propagated out of an index build.
   */
  extract(input: IExtractInput): IExtractOutput;
}

export interface IExtractInput {
  /** Project-relative POSIX path. */
  filePath: string;
  /** File contents. */
  content: string;
  /** Code-graph node id for the file (`file:<path>`). */
  fileNodeId: string;
}

export interface IExtractOutput {
  nodes: readonly INode[];
  edges: readonly IEdge[];
}
