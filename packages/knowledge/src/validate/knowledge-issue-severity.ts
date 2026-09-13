/**
 * How serious one knowledge validation finding is (round 15 follow-up, lane B
 * — B3): THE severity of an `IKnowledgeValidationIssue` and of an
 * `IReferenceRootProblem`. The `root` predicate's problem becomes a validator
 * issue as it is, so the two share this one closed set — they were two
 * separate `'error' | 'warning'` unions that agreed only by coincidence.
 * `Error` makes `validateKnowledgeEntries` report `valid: false`; `Warning`
 * never does.
 */
export enum KnowledgeIssueSeverity {
  Error = 'error',
  Warning = 'warning',
}
