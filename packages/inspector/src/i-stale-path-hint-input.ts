import type { KnowledgeSourceFormat } from '@shrkcrft/knowledge';
import type { IReferencePackOrigin } from './i-reference-pack-origin.ts';

/** What `stalePathHint` needs to name the fix for a reference whose path is missing. */
export interface IStalePathHintInput {
  /** The reference kind (`file`, `directory`, `symbol`, …). */
  readonly kind: string;
  /** The missing path as declared, normalised (project-relative, or pack-relative for `root: pack`). */
  readonly path: string;
  /** The pack that contributes the subject — its reference is fixed in the pack. */
  readonly pack?: IReferencePackOrigin;
  /** The path resolved against the pack's directory (`root: pack`). */
  readonly packRooted: boolean;
  /** How the subject is declared — a Markdown entry is fixed in its `references:` frontmatter. */
  readonly sourceFormat?: KnowledgeSourceFormat;
  /** The declaring file, project-relative — a Markdown hint names it. */
  readonly source?: string;
}
