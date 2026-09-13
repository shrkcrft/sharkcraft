/**
 * Registration hint.
 *
 * A registration hint describes a downstream registration step that a
 * generated construct typically needs (e.g. "register the new plugin in the
 * composer", "wire the new event into the route table"). Packs contribute
 * hints; the engine ships none.
 *
 * Hints are read-only data. The engine never auto-applies them — it can
 * preview them via `shrk registrations preview <hintId>` and link them
 * to templates via `template.metadata.registrationHintIds`.
 *
 * Discovery rules:
 *   - `discovery.targetFile` is a fixed relative path the hint applies to
 *     when present. If absent, `discovery.targetGlobs` lists candidate paths.
 *   - When more than one candidate matches, the hint MUST report
 *     `requiresHumanReview: true` and emit a conflict instead of guessing.
 *
 * Intended-empty discovery (round 13, docs/intended-empty.md): a `targetGlobs`
 * entry and `targetFile` also take `{ pattern, expectEmpty: true, reason? }` —
 * a target the hint names BEFORE the adopting app has it. The loader
 * normalises it ({@link normalizeRegistrationHint}) into the plain string the
 * readers consume plus an `expectEmptyUnits` ledger; `registrations doctor`
 * accepts it (printed) while nothing matches, and reports it as went-live
 * once the target appears. Needs engine 0.1.0-alpha.31 or later.
 */
import {
  describeEntryValue,
  err,
  mergeUnitMarks,
  normalizeUnitList,
  normalizeUnitScalar,
  ok,
  stampUnitMarks,
  UnitEntryForm,
  unitListProblems,
  unitProblemsError,
  unitProblemsOf,
  unitScalarProblems,
  type AppErrorImpl,
  type IUnitMark,
  type Result,
  type SelectorListEntry,
} from '@shrkcrft/core';

export interface IRegistrationHintDiscovery {
  /** Fixed relative path inside the project root, when known. */
  readonly targetFile?: string;
  /** Glob patterns (relative paths). Used when the target file varies. */
  readonly targetGlobs?: readonly string[];
  /**
   * Convention id(s) the target is expected to satisfy — a cross-reference,
   * NOT a filter: `registrations preview` does not narrow candidates by it
   * (round 15 corrected this comment, which claimed "used as filter"). The
   * self-config doctor resolves each id against the convention registry (a
   * typo is a `registration-hint-convention-missing` finding).
   */
  readonly conventionIds?: readonly string[];
  /**
   * WorkspaceProfile ids the hint applies to (`has-typescript`, `is-library`,
   * … — `shrk profiles list --kind workspace`). Resolved by the self-config
   * doctor against the builtin `workspace-profile` kind (a typo is a
   * `registration-hint-profile-missing` finding with a did-you-mean); NOT yet
   * evaluated as a filter by `registrations preview`.
   */
  readonly profileIds?: readonly string[];
}

/**
 * The AUTHORED discovery: `targetFile` and every `targetGlobs` entry may be a
 * `{ pattern, expectEmpty: true, reason? }` marker (round 13). The loaded
 * {@link IRegistrationHintDiscovery} keeps plain strings.
 */
export interface IRegistrationHintDiscoveryInput
  extends Omit<IRegistrationHintDiscovery, 'targetFile' | 'targetGlobs'> {
  /** Fixed relative path — or a marker naming a target that does not exist yet. */
  readonly targetFile?: SelectorListEntry;
  /** Glob patterns — any entry may be a marker. */
  readonly targetGlobs?: readonly SelectorListEntry[];
}

export type RegistrationHintOpKind =
  | 'ensure-import'
  | 'insert-enum-entry'
  | 'insert-object-entry'
  | 'insert-before-closing-brace'
  | 'insert-between-anchors'
  | 'insert-after'
  | 'insert-before'
  | 'append'
  | 'export';

export interface IRegistrationHintOperation {
  readonly kind: RegistrationHintOpKind;
  /** Anchor literal used by anchor-based ops. */
  readonly anchor?: string;
  /** Begin anchor for insert-between-anchors. */
  readonly beginAnchor?: string;
  /** End anchor for insert-between-anchors. */
  readonly endAnchor?: string;
  /** Container name (interface / class / enum / object literal) for body ops. */
  readonly containerName?: string;
  /** Enum identifier for insert-enum-entry. */
  readonly enumName?: string;
  /** Object literal identifier for insert-object-entry. */
  readonly objectName?: string;
  /** Snippet body. May contain `{{var}}` placeholders. */
  readonly snippet?: string;
  /** Idempotency marker. */
  readonly ifMissing?: string;
  /** Find text (replace op). */
  readonly find?: string;
  /** Replace text (replace op). */
  readonly replaceWith?: string;
  /** Symbols (ensure-import / export). */
  readonly symbols?: readonly string[];
  /** Module specifier (ensure-import / export). */
  readonly from?: string;
}

export interface IRegistrationHint {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /**
   * Variables the hint snippet references (templated via `{{var}}`). When a
   * `preview` is requested, the engine substitutes these values.
   */
  readonly variables?: ReadonlyArray<{
    readonly name: string;
    readonly required: boolean;
    readonly description?: string;
    readonly defaultValue?: string;
  }>;
  readonly discovery: IRegistrationHintDiscovery;
  /**
   * The operations that the hint would perform if applied. Today the engine
   * surfaces these as a *preview* only.
   */
  readonly operations: ReadonlyArray<IRegistrationHintOperation>;
  /** When true, the preview must include a "requires human review" badge. */
  readonly requiresHumanReview?: boolean;
  /** Validation commands recommended after the human applies the hint. */
  readonly validationCommands?: readonly string[];
  /** Optional explanatory text shown alongside the preview. */
  readonly explanation?: string;
  /** Safety notes shown before any preview. */
  readonly safetyNotes?: readonly string[];
  readonly tags?: readonly string[];
  /**
   * LOADED hints only (round 13): the discovery units marked `expectEmpty`
   * (`list` = `discovery.targetGlobs` / `discovery.targetFile`), each stamped
   * with the contributing pack by the loader. Derived — an author never writes
   * it (the validator refuses the key); write a marker entry instead.
   */
  readonly expectEmptyUnits?: readonly IUnitMark[];
}

/**
 * An AUTHORED registration hint: the {@link IRegistrationHint} a pack or
 * `sharkcraft/registration-hints.ts` writes, with markable discovery.
 */
export interface IRegistrationHintInput extends Omit<IRegistrationHint, 'discovery' | 'expectEmptyUnits'> {
  readonly discovery: IRegistrationHintDiscoveryInput;
}

/** Author one registration hint (markers allowed in `discovery`). */
export function defineRegistrationHint<T extends IRegistrationHintInput>(hint: T): T {
  return hint;
}

/** Author an array of registration hints. */
export function defineRegistrationHints<T extends IRegistrationHintInput>(hints: readonly T[]): readonly T[] {
  return hints;
}

export interface IRegistrationHintValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface IRegistrationHintValidationResult {
  readonly valid: boolean;
  readonly issues: readonly IRegistrationHintValidationIssue[];
}

const TARGET_GLOBS = 'discovery.targetGlobs';
const TARGET_FILE = 'discovery.targetFile';

/**
 * A core marker problem (`discovery.targetGlobs[1]: must be …`) as a validation
 * issue whose `field` names the entry (`discovery.targetGlobs[1]`), so the
 * rejection line reads `discovery.targetGlobs[1]: must be …` — never the list
 * path twice.
 */
function problemIssue(problem: string, listPath: string): IRegistrationHintValidationIssue {
  const rest = problem.startsWith(listPath) ? problem.slice(listPath.length) : undefined;
  const m = rest === undefined ? null : /^(\[\d+\])?: /.exec(rest);
  if (rest === undefined || m === null) return { field: listPath, message: problem };
  return { field: `${listPath}${m[1] ?? ''}`, message: rest.slice(m[0].length) };
}

/**
 * THE registration-hint shape check — the loader's acceptance predicate
 * (`registrationHintRejectionReasons`), `packs test --load` and the doctors all
 * read it. Round 13: every `targetGlobs` entry and `targetFile` must be a
 * string or a well-formed `{ pattern, expectEmpty: true, reason? }` marker
 * (THE core parser's problems, one per bad entry) — an object used to be
 * accepted here and crash the doctors (`glob.includes is not a function`).
 */
export function validateRegistrationHint(value: unknown): IRegistrationHintValidationResult {
  const issues: IRegistrationHintValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: [{ field: '<root>', message: 'hint must be an object' }] };
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) issues.push({ field: 'id', message: 'id required' });
  if (typeof o.title !== 'string' || o.title.length === 0) issues.push({ field: 'title', message: 'title required' });
  if ('expectEmptyUnits' in o) {
    issues.push({
      field: 'expectEmptyUnits',
      message:
        'expectEmptyUnits is derived by the loader — mark the unit itself: discovery.targetGlobs: [{ pattern, expectEmpty: true }]',
    });
  }
  if (!o.discovery || typeof o.discovery !== 'object') {
    issues.push({ field: 'discovery', message: 'discovery required' });
  } else {
    const d = o.discovery as Record<string, unknown>;
    const fileProblems = d.targetFile !== undefined ? unitScalarProblems(d.targetFile, TARGET_FILE) : [];
    const globsIsArray = Array.isArray(d.targetGlobs);
    if (d.targetGlobs !== undefined && !globsIsArray) {
      issues.push({ field: TARGET_GLOBS, message: `must be an array (got ${describeEntryValue(d.targetGlobs)})` });
    }
    const globProblems = globsIsArray ? unitListProblems(d.targetGlobs as readonly unknown[], TARGET_GLOBS) : [];
    for (const p of fileProblems) issues.push(problemIssue(p, TARGET_FILE));
    for (const p of globProblems) issues.push(problemIssue(p, TARGET_GLOBS));
    const fixed = fileProblems.length === 0 && d.targetFile !== undefined ? normalizeUnitScalar(d.targetFile, TARGET_FILE) : undefined;
    const hasFixed = fixed !== undefined && fixed.ok && fixed.value.unit.length > 0;
    const hasGlobs = globsIsArray && (d.targetGlobs as readonly unknown[]).length > 0;
    if (!hasFixed && !hasGlobs && fileProblems.length === 0) {
      issues.push({
        field: 'discovery',
        message: 'discovery requires either targetFile or targetGlobs[]',
      });
    }
    // Round 13 (K4): a fixed targetFile wins over targetGlobs — THE discovery
    // authority (`resolveRegistrationHintCandidates`) never walks the globs of
    // such a hint — so a marker on one of them is never judged: it could never
    // read intended-empty or went-live, it would simply vanish. Refused, never
    // dropped silently.
    if (hasFixed && hasGlobs && globProblems.length === 0) {
      (d.targetGlobs as readonly unknown[]).forEach((entry, i) => {
        if (entry === null || typeof entry !== 'object') return;
        const unit = (entry as { pattern?: unknown }).pattern;
        issues.push({
          field: `${TARGET_GLOBS}[${i}]`,
          message:
            `a marker on a list this hint's discovery mode never judges — a fixed discovery.targetFile wins over discovery.targetGlobs, ` +
            `so '${String(unit)}' is never read; mark discovery.targetFile instead, or drop targetFile so the globs are judged`,
        });
      });
    }
  }
  if (!Array.isArray(o.operations) || o.operations.length === 0) {
    issues.push({ field: 'operations', message: 'operations[] must be non-empty' });
  }
  return { valid: issues.length === 0, issues };
}

/**
 * THE loaded shape of a hint `validateRegistrationHint` accepted (round 13):
 * `discovery.targetGlobs` and `discovery.targetFile` as plain strings — what
 * every reader consumes — plus the `expectEmptyUnits` ledger of the units the
 * author marked, stamped with the contributing pack (`packageName`, from the
 * loader's provenance; `undefined` for a local hint). Idempotent: a loaded hint
 * normalises to itself (its ledger is kept). Refused (`CONFIG_INVALID`, the
 * core parser's problems in `details.problems`) only for a hint the validator
 * would have refused.
 */
export function normalizeRegistrationHint(
  input: IRegistrationHintInput | IRegistrationHint,
  packageName?: string,
): Result<IRegistrationHint, AppErrorImpl> {
  const d = input.discovery ?? {};
  const globs = d.targetGlobs !== undefined ? normalizeUnitList(d.targetGlobs, TARGET_GLOBS) : undefined;
  const file = d.targetFile !== undefined ? normalizeUnitScalar(d.targetFile, TARGET_FILE) : undefined;
  const problems = [
    ...(globs !== undefined && !globs.ok ? unitProblemsOf(globs.error) : []),
    ...(file !== undefined && !file.ok ? unitProblemsOf(file.error) : []),
  ];
  if (problems.length > 0) return err(unitProblemsError('discovery', problems, UnitEntryForm.List));
  const marks = mergeUnitMarks(
    (input as IRegistrationHint).expectEmptyUnits,
    globs?.ok ? globs.value.marks : [],
    file?.ok ? file.value.marks : [],
  );
  const stamped = stampUnitMarks(marks, packageName);
  const { expectEmptyUnits: _previous, ...rest } = input as IRegistrationHint;
  return ok({
    ...rest,
    discovery: {
      ...d,
      ...(globs?.ok ? { targetGlobs: globs.value.units } : {}),
      ...(file?.ok ? { targetFile: file.value.unit } : {}),
    },
    ...(stamped.length > 0 ? { expectEmptyUnits: stamped } : {}),
  } as IRegistrationHint);
}
