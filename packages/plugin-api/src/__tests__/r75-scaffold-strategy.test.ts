/**
 * Round 11 §4.6#4 — one scaffold-strategy table. "Which strategies exist" and
 * "what each yields" used to be two hand-synced lists (a recognised-name set
 * here, an if/else chain in the inspector); `directoryName.pascal`,
 * `className.stripSuffix:` & co. were missing from both and shipped empty.
 */
import { describe, expect, test } from 'bun:test';
import {
  EXACT_SCAFFOLD_STRATEGY_NAMES,
  isRecognizedScaffoldStrategy,
  PARAMETERISED_SCAFFOLD_STRATEGY_PREFIXES,
  RECOGNIZED_SCAFFOLD_STRATEGIES,
  resolveScaffoldStrategy,
  SCAFFOLD_STRATEGY_SAMPLE,
} from '../index.ts';

const PASCAL_FILE = { basename: 'UserProfileService', directory: 'user-profile', packageName: '@acme/app' };
const DOTTED_FILE = { basename: 'user-profile.service', directory: 'user-profile', packageName: '@acme/app' };

describe('resolveScaffoldStrategy — table-driven', () => {
  const cases: readonly [string, typeof PASCAL_FILE, string][] = [
    ['filename.kebab', PASCAL_FILE, 'user-profile-service'],
    ['filename.pascal', PASCAL_FILE, 'UserProfileService'],
    ['className', PASCAL_FILE, 'UserProfileService'],
    ['className.stripPrefix:User', PASCAL_FILE, 'ProfileService'],
    ['className.stripSuffix:Service', PASCAL_FILE, 'UserProfile'],
    ['className.stripSuffix:Service', DOTTED_FILE, 'UserProfile'],
    ['filename.stripSuffix:Service', PASCAL_FILE, 'UserProfile'],
    ['filename.stripSuffix:.service', DOTTED_FILE, 'user-profile'],
    ['functionName', PASCAL_FILE, 'userProfileService'],
    ['directoryName', PASCAL_FILE, 'user-profile'],
    ['directoryName.kebab', { ...PASCAL_FILE, directory: 'UserProfile' }, 'user-profile'],
    ['directoryName.pascal', PASCAL_FILE, 'UserProfile'],
    ['nearestPackageName', PASCAL_FILE, '@acme/app'],
  ];
  for (const [strategy, ctx, expected] of cases) {
    test(`${strategy} on ${ctx.directory}/${ctx.basename} → ${expected}`, () => {
      expect(resolveScaffoldStrategy(strategy, ctx)).toEqual({ recognized: true, value: expected });
    });
  }

  test('a suffix equal to the whole name is not stripped to nothing', () => {
    expect(resolveScaffoldStrategy('filename.stripSuffix:Service', { basename: 'Service', directory: 'x' }).value).toBe('Service');
  });

  test('an unknown strategy is unrecognised (the caller reports it), never an empty value', () => {
    expect(resolveScaffoldStrategy('directoryName.snake', PASCAL_FILE)).toEqual({ recognized: false });
  });
});

describe('recognised ≡ implemented (one table)', () => {
  test('every recognised strategy yields a non-empty value for the sample', () => {
    for (const s of EXACT_SCAFFOLD_STRATEGY_NAMES) {
      expect({ s, value: resolveScaffoldStrategy(s, SCAFFOLD_STRATEGY_SAMPLE).value }).toEqual({
        s,
        value: expect.stringMatching(/.+/),
      });
    }
    for (const p of PARAMETERISED_SCAFFOLD_STRATEGY_PREFIXES) {
      expect(resolveScaffoldStrategy(`${p}Service`, SCAFFOLD_STRATEGY_SAMPLE).value).toMatch(/.+/);
    }
  });

  test('isRecognizedScaffoldStrategy(s) === resolveScaffoldStrategy(s).recognized over a fixed fuzz set', () => {
    const fuzz = [
      ...EXACT_SCAFFOLD_STRATEGY_NAMES,
      ...PARAMETERISED_SCAFFOLD_STRATEGY_PREFIXES,
      ...PARAMETERISED_SCAFFOLD_STRATEGY_PREFIXES.map((p) => `${p}X`),
      'className.stripPrefix',
      'className.strip:X',
      'directoryName.snake',
      'filename.camel',
      'FILENAME.KEBAB',
      '',
      ' filename.kebab',
      'nearestPackageName ',
    ];
    for (const s of fuzz) {
      expect({ s, recognized: isRecognizedScaffoldStrategy(s) }).toEqual({
        s,
        recognized: resolveScaffoldStrategy(s, SCAFFOLD_STRATEGY_SAMPLE).recognized,
      });
    }
  });

  test('RECOGNIZED_SCAFFOLD_STRATEGIES is derived from the table (back-compat export)', () => {
    expect([...RECOGNIZED_SCAFFOLD_STRATEGIES].sort()).toEqual([...EXACT_SCAFFOLD_STRATEGY_NAMES].sort());
    expect(RECOGNIZED_SCAFFOLD_STRATEGIES.has('directoryName.pascal')).toBe(true);
  });
});
