/**
 * The filters an `IConventionAppliesTo` may declare — a CLOSED set (round 15,
 * 15.1). `validateConvention` refuses any other `appliesTo` key as an ERROR,
 * with a did-you-mean: a typo'd filter (`fileGlob`) used to be ignored, which
 * silently WIDENED the convention to every file.
 *
 * What each filter means is decided by ONE authority, `conventionApplicability`
 * (`@shrkcrft/inspector`): any listed value matches within a filter, every
 * declared filter must match, an absent or empty filter imposes nothing.
 */
export enum ConventionAppliesToFilter {
  /** Per file: the file's language, by extension (the `shrk stats` vocabulary — `typescript`, `python`, …). */
  Languages = 'languages',
  /** Workspace: a detected framework id (`angular`, `nextjs`, `nestjs`, … — `FrameworkId`, `@shrkcrft/workspace`). */
  Frameworks = 'frameworks',
  /** Per file: a glob list — `**` spans zero or more segments, a `!` entry subtracts. */
  FileGlobs = 'fileGlobs',
  /** RESERVED — no deterministic file → construct-kind authority exists; the loader warns and the convention applies regardless. */
  ConstructKinds = 'constructKinds',
  /** Workspace: a detected WorkspaceProfile id (`has-typescript`, `has-turborepo`, … — `shrk profiles list --kind workspace`). */
  ProfileIds = 'profileIds',
}
