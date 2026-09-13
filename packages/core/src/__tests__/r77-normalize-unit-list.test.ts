/**
 * r77 — THE parser for `expectEmpty` markers (round 13, DECISIONS §1–§2).
 *
 * One entry form serves every markable list — `string | { pattern,
 * expectEmpty: true, reason? }` — plus a value form for boost maps and the
 * scalar `discovery.targetFile`. The loaded lists stay PLAIN strings; the
 * marks ride in a ledger. Every refusal is locked by its exact message, and
 * idempotence (engines normalise defensively at entry) is locked as a property.
 */
import { describe, expect, test } from 'bun:test';
import {
  ERROR_CODES,
  exemptionListProblem,
  globListProblem,
  indexListPath,
  levenshtein,
  markedListFailOnEmptyConflict,
  mergeUnitMarks,
  nearestIds,
  normalizeUnitList,
  normalizeUnitMap,
  normalizeUnitScalar,
  qualifyListPath,
  qualifyUnitMarks,
  stampUnitMarks,
  unitListProblems,
  unitMapProblems,
  unitProblemsOf,
  unitScalarProblems,
  type IUnitList,
  type IUnitMap,
  type IUnitMark,
} from '../index.ts';

const SHAPE = '{ pattern, expectEmpty: true, reason? }';

function okList(list: readonly unknown[], listPath = 'forbiddenImports'): IUnitList {
  const r = normalizeUnitList(list, listPath);
  if (!r.ok) throw new Error(`expected a well-formed list, got: ${unitProblemsOf(r.error).join(' | ')}`);
  return r.value;
}

function problems(list: readonly unknown[], listPath = 'forbiddenImports'): readonly string[] {
  const r = normalizeUnitList(list, listPath);
  if (r.ok) throw new Error('expected a refusal');
  return unitProblemsOf(r.error);
}

function okMap(record: unknown, listPath = 'boostIds'): IUnitMap {
  const r = normalizeUnitMap(record, listPath);
  if (!r.ok) throw new Error(`expected a well-formed map, got: ${unitProblemsOf(r.error).join(' | ')}`);
  return r.value;
}

describe('normalizeUnitList — passthrough and marks', () => {
  test('plain strings pass through untouched (duplicates and negations included), with no marks', () => {
    expect(okList(['a', '!b', 'a'], 'files')).toEqual({ units: ['a', '!b', 'a'], marks: [] });
    expect(okList([], 'files')).toEqual({ units: [], marks: [] });
  });

  test("spec 13.1's exact syntax loads verbatim", () => {
    expect(okList(['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }])).toEqual({
      units: ['@scope/kernel-*', '@scope/plugin-react'],
      marks: [{ list: 'forbiddenImports', unit: '@scope/plugin-react' }],
    });
  });

  test('a marker joins the units IN PLACE and its reason rides on the mark', () => {
    const l = okList(['x', { pattern: 'y', expectEmpty: true, reason: 'planned binding (ADR-7)' }, 'z'], 'allowedImports');
    expect(l.units).toEqual(['x', 'y', 'z']);
    expect(l.marks).toEqual([{ list: 'allowedImports', unit: 'y', reason: 'planned binding (ADR-7)' }]);
  });

  test("a negation keeps its '!' inside pattern — and the ! shape rules run on the normalised units", () => {
    const l = okList(['src/**/*.ts', { pattern: '!src/**/*.generated.ts', expectEmpty: true }], 'files');
    expect(l.units).toEqual(['src/**/*.ts', '!src/**/*.generated.ts']);
    expect(l.marks).toEqual([{ list: 'files', unit: '!src/**/*.generated.ts' }]);
    expect(globListProblem(l.units)).toBeUndefined();
    // `{ pattern: '!' }` is refused exactly like `'!'`: normalisation passes the
    // unit through, the one shape rule refuses it.
    const bang = okList([{ pattern: '!', expectEmpty: true }], 'files').units;
    expect(globListProblem(bang)).toBe(globListProblem(['!']));
    expect(globListProblem(bang)).toBeDefined();
    const exempt = okList([{ pattern: '!x/**', expectEmpty: true }], 'exemptFiles').units;
    expect(exemptionListProblem(exempt)).toBe(exemptionListProblem(['!x/**']));
    expect(exemptionListProblem(exempt)).toBeDefined();
  });

  test('plain duplicates stay legal; a unit plain AND marked once is legal; the same unit MARKED twice is refused', () => {
    expect(okList(['a', 'a'])).toEqual({ units: ['a', 'a'], marks: [] });
    expect(okList(['a', { pattern: 'a', expectEmpty: true }])).toEqual({
      units: ['a', 'a'],
      marks: [{ list: 'forbiddenImports', unit: 'a' }],
    });
    expect(
      problems([
        { pattern: 'a', expectEmpty: true },
        { pattern: 'a', expectEmpty: true, reason: 'again' },
      ]),
    ).toEqual(["forbiddenImports[1]: 'a' is already marked expectEmpty at forbiddenImports[0] — mark a unit once"]);
  });
});

describe('normalizeUnitList — every refusal, with its exact message', () => {
  const cases: readonly (readonly [string, unknown, readonly string[]])[] = [
    ['a number', 42, [`forbiddenImports[0]: must be a string or ${SHAPE} (got 42)`]],
    ['null', null, [`forbiddenImports[0]: must be a string or ${SHAPE} (got null)`]],
    ['an array', ['x'], [`forbiddenImports[0]: must be a string or ${SHAPE} (got an array)`]],
    ['a boolean', true, [`forbiddenImports[0]: must be a string or ${SHAPE} (got true)`]],
    [
      'a marker naming no unit',
      { expectEmpty: true },
      ["forbiddenImports[0]: a marker naming no unit — write { pattern: '<glob or specifier>', expectEmpty: true }"],
    ],
    [
      'a synonym key instead of pattern (the unit is `pattern` on every list)',
      { glob: 'src/x/**', expectEmpty: true },
      [
        'forbiddenImports[0]: a marker naming no unit — the unit is named `pattern` on every list: write { pattern: "src/x/**", expectEmpty: true } instead of `glob`',
      ],
    ],
    ['an empty pattern', { pattern: '', expectEmpty: true }, ['forbiddenImports[0]: pattern must be a non-empty string (got "")']],
    ['a non-string pattern', { pattern: 7, expectEmpty: true }, ['forbiddenImports[0]: pattern must be a non-empty string (got 7)']],
    [
      'expectEmpty missing',
      { pattern: 'x' },
      ['forbiddenImports[0]: an object entry must set expectEmpty: true — write the plain string otherwise'],
    ],
    [
      'expectEmpty false',
      { pattern: 'x', expectEmpty: false },
      ['forbiddenImports[0]: expectEmpty must be the literal true (got false) — write the plain string otherwise'],
    ],
    [
      'expectEmpty "true" (a string)',
      { pattern: 'x', expectEmpty: 'true' },
      ['forbiddenImports[0]: expectEmpty must be the literal true (got "true") — write the plain string otherwise'],
    ],
    [
      'an unknown key no known key is near',
      { pattern: 'x', expectEmpty: true, allowDead: true },
      [`forbiddenImports[0]: unknown key 'allowDead'; an entry is ${SHAPE}`],
    ],
    [
      'a misspelled key → did-you-mean through the one scorer',
      { pattern: 'x', expectEmpty: true, reson: 'r' },
      [`forbiddenImports[0]: unknown key 'reson' — did you mean 'reason'?; an entry is ${SHAPE}`],
    ],
    [
      'a case-only miss is named, and the missing expectEmpty too',
      { pattern: 'x', expectempty: true },
      [
        `forbiddenImports[0]: unknown key 'expectempty' — did you mean 'expectEmpty'?; an entry is ${SHAPE}`,
        'forbiddenImports[0]: an object entry must set expectEmpty: true — write the plain string otherwise',
      ],
    ],
    [
      'packageName is STAMPED by a loader, never authored',
      { pattern: 'x', expectEmpty: true, packageName: '@evil/pack' },
      [`forbiddenImports[0]: unknown key 'packageName'; an entry is ${SHAPE}`],
    ],
    [
      'an empty reason',
      { pattern: 'x', expectEmpty: true, reason: '  ' },
      ['forbiddenImports[0]: reason must be a non-empty string (got "  ")'],
    ],
    [
      'a non-string reason',
      { pattern: 'x', expectEmpty: true, reason: 3 },
      ['forbiddenImports[0]: reason must be a non-empty string (got 3)'],
    ],
  ];
  for (const [name, entry, expected] of cases) {
    test(name, () => {
      expect(problems([entry])).toEqual(expected);
      // unitListProblems is a thin projection of the same refusal.
      expect(unitListProblems([entry], 'forbiddenImports')).toEqual(expected);
    });
  }

  test('every bad entry is reported at once, each with its own index; the error is CONFIG_INVALID', () => {
    const r = normalizeUnitList([1, 'ok', { pattern: 'y' }], 'files');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(ERROR_CODES.CONFIG_INVALID);
    expect(unitProblemsOf(r.error)).toEqual([
      `files[0]: must be a string or ${SHAPE} (got 1)`,
      'files[2]: an object entry must set expectEmpty: true — write the plain string otherwise',
    ]);
    expect(r.error.message).toBe(`files[0]: must be a string or ${SHAPE} (got 1) (+1 more)`);
    expect(r.error.details?.['listPath']).toBe('files');
    expect(r.error.suggestion).toContain('{ pattern, expectEmpty: true, reason? }');
  });

  test('a well-formed list has no problems', () => {
    expect(unitListProblems(['a', { pattern: 'b', expectEmpty: true, reason: 'planned' }], 'files')).toEqual([]);
  });
});

describe('normalizeUnitList — idempotence (engines normalise defensively at entry)', () => {
  const ALPHABET: readonly unknown[] = [
    'a',
    '!b',
    'c/**',
    { pattern: 'd', expectEmpty: true },
    { pattern: '!e', expectEmpty: true, reason: 'planned' },
  ];
  function* lists(maxLength: number): Generator<unknown[]> {
    yield [];
    let layer: unknown[][] = [[]];
    for (let len = 1; len <= maxLength; len += 1) {
      const next: unknown[][] = [];
      for (const prefix of layer) for (const entry of ALPHABET) next.push([...prefix, entry]);
      for (const l of next) yield l;
      layer = next;
    }
  }

  test('normalize(normalize(x).units) ≡ { units, marks: [] } over every list of up to 3 entries', () => {
    let checked = 0;
    for (const list of lists(3)) {
      const r = normalizeUnitList(list, 'files');
      if (!r.ok) {
        // The only way a list of well-formed entries is refused: a unit marked twice.
        for (const p of unitProblemsOf(r.error)) expect(p).toContain('is already marked expectEmpty');
        continue;
      }
      const again = normalizeUnitList(r.value.units, 'files');
      expect(again.ok).toBe(true);
      if (!again.ok) continue;
      expect(again.value).toEqual({ units: r.value.units, marks: [] });
      expect(r.value.units.length).toBe(list.length);
      expect(r.value.marks.length).toBe(list.filter((e) => typeof e !== 'string').length);
      for (const m of r.value.marks) expect(r.value.units).toContain(m.unit);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('normalizeUnitMap — the boost value form (the unit is the key)', () => {
  test('numbers pass through; a marked value contributes its weight and a mark', () => {
    expect(
      okMap({ 'knowledge:a': 2, 'knowledge:b': { weight: 3, expectEmpty: true, reason: 'planned entry' } }),
    ).toEqual({
      values: { 'knowledge:a': 2, 'knowledge:b': 3 },
      marks: [{ list: 'boostIds', unit: 'knowledge:b', reason: 'planned entry' }],
    });
  });

  test('every refusal, with its exact message (a non-number value is refused LOUDLY, never clamped to 0)', () => {
    const cases: readonly (readonly [unknown, readonly string[]])[] = [
      [{ k: 'high' }, ['boostIds["k"]: must be a number or { weight, expectEmpty: true, reason? } (got "high")']],
      [{ k: null }, ['boostIds["k"]: must be a number or { weight, expectEmpty: true, reason? } (got null)']],
      [{ k: { expectEmpty: true } }, ['boostIds["k"]: a marker with no weight — write { weight: <number>, expectEmpty: true }']],
      [
        { k: { boost: 2, expectEmpty: true } },
        ['boostIds["k"]: a marker with no weight — write { weight: 2, expectEmpty: true } instead of `boost`'],
      ],
      [{ k: { weight: '2', expectEmpty: true } }, ['boostIds["k"]: weight must be a number (got "2")']],
      [
        { k: { weight: 2 } },
        ['boostIds["k"]: an object entry must set expectEmpty: true — write the plain number otherwise'],
      ],
      [
        { k: { weight: 2, expectEmpty: true, wieght: 1 } },
        ["boostIds[\"k\"]: unknown key 'wieght' — did you mean 'weight'?; an entry is { weight, expectEmpty: true, reason? }"],
      ],
    ];
    for (const [record, expected] of cases) {
      const r = normalizeUnitMap(record, 'boostIds');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(unitProblemsOf(r.error)).toEqual(expected);
      expect(unitMapProblems(record, 'boostIds')).toEqual(expected);
    }
    expect(unitMapProblems(['x'], 'boostIds')).toEqual([
      'boostIds: must be a map of key → number or { weight, expectEmpty: true, reason? } (got an array)',
    ]);
  });

  test('idempotent, and a `__proto__` key stays a key', () => {
    const first = okMap({ 'knowledge:a': 1, 'knowledge:b': { weight: 2, expectEmpty: true } });
    expect(okMap(first.values)).toEqual({ values: first.values, marks: [] });
    const proto = okMap(JSON.parse('{"__proto__": 1, "knowledge:x": 2}'));
    expect(Object.prototype.hasOwnProperty.call(proto.values, '__proto__')).toBe(true);
    expect(Object.keys(proto.values).sort()).toEqual(['__proto__', 'knowledge:x']);
  });

  test('the taskHints list path is built by indexListPath, the same way loader and reporter build it', () => {
    const path = indexListPath('taskHints[i].boostIds', 2);
    expect(path).toBe('taskHints[2].boostIds');
    expect(okMap({ 'knowledge:a': { weight: 1, expectEmpty: true } }, path).marks).toEqual([
      { list: 'taskHints[2].boostIds', unit: 'knowledge:a' },
    ]);
    expect(indexListPath('a[i].b[i].c', 1)).toBe('a[1].b[i].c');
  });
});

describe('normalizeUnitScalar — discovery.targetFile', () => {
  test('a string passes through; a marker yields one mark; idempotent', () => {
    const plain = normalizeUnitScalar('src/app/routes.ts', 'discovery.targetFile');
    expect(plain.ok && plain.value).toEqual({ unit: 'src/app/routes.ts', marks: [] });
    const marked = normalizeUnitScalar(
      { pattern: 'src/app/routes.ts', expectEmpty: true, reason: 'routing lands in M3' },
      'discovery.targetFile',
    );
    expect(marked.ok && marked.value).toEqual({
      unit: 'src/app/routes.ts',
      marks: [{ list: 'discovery.targetFile', unit: 'src/app/routes.ts', reason: 'routing lands in M3' }],
    });
    if (marked.ok) {
      const again = normalizeUnitScalar(marked.value.unit, 'discovery.targetFile');
      expect(again.ok && again.value).toEqual({ unit: 'src/app/routes.ts', marks: [] });
    }
  });

  test('refusals carry the scalar path, no index', () => {
    expect(unitScalarProblems(42, 'discovery.targetFile')).toEqual([
      `discovery.targetFile: must be a string or ${SHAPE} (got 42)`,
    ]);
    expect(unitScalarProblems({ pattern: 'x' }, 'discovery.targetFile')).toEqual([
      'discovery.targetFile: an object entry must set expectEmpty: true — write the plain string otherwise',
    ]);
    expect(unitScalarProblems({ path: 'src/x.ts', expectEmpty: true }, 'discovery.targetFile')).toEqual([
      'discovery.targetFile: a marker naming no unit — the unit is named `pattern` on every list: write { pattern: "src/x.ts", expectEmpty: true } instead of `path`',
    ]);
    expect(unitScalarProblems('src/x.ts', 'discovery.targetFile')).toEqual([]);
  });
});

describe('ledger helpers', () => {
  const marks: readonly IUnitMark[] = [
    { list: 'files', unit: 'a' },
    { list: 'files', unit: 'b', reason: 'r' },
  ];

  test('stampUnitMarks stamps pack provenance; a local element is returned unchanged', () => {
    expect(stampUnitMarks(marks, undefined)).toBe(marks);
    expect(stampUnitMarks(marks, '')).toBe(marks);
    expect(stampUnitMarks(marks, '@scope/fence-pack')).toEqual([
      { list: 'files', unit: 'a', packageName: '@scope/fence-pack' },
      { list: 'files', unit: 'b', reason: 'r', packageName: '@scope/fence-pack' },
    ]);
  });

  test('mergeUnitMarks dedupes by (list, unit), first wins', () => {
    expect(
      mergeUnitMarks(marks, [{ list: 'files', unit: 'a', reason: 'later' }, { list: 'to.files', unit: 'a' }], undefined),
    ).toEqual([...marks, { list: 'to.files', unit: 'a' }]);
  });

  test('qualifyUnitMarks / qualifyListPath build the same qualified path', () => {
    expect(qualifyListPath('declared', 'files')).toBe('declared.files');
    expect(qualifyListPath('', 'files')).toBe('files');
    expect(qualifyUnitMarks(marks, 'registered[1]').map((m) => m.list)).toEqual([
      qualifyListPath('registered[1]', 'files'),
      qualifyListPath('registered[1]', 'files'),
    ]);
  });
});

describe('markedListFailOnEmptyConflict — failOnEmpty: true over an all-marked primary list', () => {
  test('refused only when failOnEmpty is EXPLICITLY true and every inclusion unit is marked', () => {
    const all = okList([{ pattern: 'src/ui/**', expectEmpty: true }, '!src/ui/**/*.spec.ts'], 'files');
    expect(markedListFailOnEmptyConflict(all, 'files', true)).toBe(
      "every inclusion unit of `files` is asserted empty (expectEmpty), so the rule's empty result is intended — failOnEmpty: true asserts the opposite; drop one of them",
    );
    // the default failOnEmpty of an error rule is not a conflict: that rule settles IntendedEmpty
    expect(markedListFailOnEmptyConflict(all, 'files', undefined)).toBeUndefined();
    expect(markedListFailOnEmptyConflict(all, 'files', false)).toBeUndefined();
    const partial = okList(['src/core/**', { pattern: 'src/ui/**', expectEmpty: true }], 'files');
    expect(markedListFailOnEmptyConflict(partial, 'files', true)).toBeUndefined();
    expect(markedListFailOnEmptyConflict(okList([], 'files'), 'files', true)).toBeUndefined();
  });
});

describe('the one did-you-mean scorer lives in core now', () => {
  test('levenshtein and nearestIds answer exactly as the inspector copy did', () => {
    const pairs: readonly (readonly [string, string, number])[] = [
      ['doctr', 'doctor', 1],
      ['', 'abc', 3],
      ['kitten', 'sitting', 3],
      ['auth-flow', 'auth-flow-smoke', 6],
      ['chian', 'chain', 1],
    ];
    for (const [a, b, d] of pairs) expect({ a, b, d: levenshtein(a, b) }).toEqual({ a, b, d });
    expect(nearestIds('auth-flow', ['auth-flow-smoke', 'billing-route-test']).map((n) => n.id)).toEqual([
      'auth-flow-smoke',
    ]);
  });
});
