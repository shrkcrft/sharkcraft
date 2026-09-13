import type { ConventionAppliesToFilter } from '@shrkcrft/plugin-api';
import type { ConventionFilterLevel } from './convention-filter-level.ts';

/** One declared `appliesTo` filter, judged — a line of `conventionApplicability(...).reasons`. */
export interface IConventionApplicabilityReason {
  readonly filter: ConventionAppliesToFilter;
  readonly level: ConventionFilterLevel;
  /** The values the convention declares for this filter. */
  readonly declared: readonly string[];
  /**
   * What the filter was compared with: the detected profiles / frameworks, the
   * file's language, the file path — or, over a file list, the distinct values
   * seen. Empty for a reserved filter and for a per-file filter judged without a file.
   */
  readonly observed: readonly string[];
  /**
   * Did this filter admit the convention? A reserved filter always does (it is
   * not evaluated); a per-file filter judged without a file does too (it is
   * decided per file). Over a file list where no file passed (`conventionScope`),
   * a per-file filter that admitted at least one file is `true` — it did not
   * exclude the convention, another filter did — unless EVERY per-file filter
   * admitted some file and none passed them all: then each is `false` and says
   * the intersection is empty. So a not-applicable convention's `!matched`
   * reasons are never empty and never name a filter that excluded nothing.
   */
  readonly matched: boolean;
  /** One printable sentence: `appliesTo.profileIds [has-turborepo]: none detected (detected: has-typescript)`. */
  readonly message: string;
}
