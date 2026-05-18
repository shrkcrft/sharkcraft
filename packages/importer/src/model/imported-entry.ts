import { KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';

/**
 * A single rule / fact parsed from an external agent file. Looser than
 * {@link IKnowledgeEntry} — fields are best-effort and the emitter fills the
 * gaps with conservative defaults.
 */
export interface IImportedEntry {
  /** Stable id derived from the source heading + slug. */
  id: string;
  /** First sentence / first line of the rule body — used as the entry title. */
  title: string;
  /** Best-guess knowledge type from the source. Defaults to rule. */
  type: KnowledgeType;
  /** Best-guess priority. Defaults to medium. */
  priority: KnowledgePriority;
  /** Heading the entry was found under (e.g. "Coding standards"). */
  section?: string;
  /** Tags inferred from heading or the entry body. */
  tags: string[];
  /** Full body content. Markdown is preserved as-is. */
  content: string;
  /** Source file (relative to the import root). */
  origin: string;
  /** Free-form notes the importer wants to surface (e.g. "rule had no header"). */
  importerNotes?: string[];
}
