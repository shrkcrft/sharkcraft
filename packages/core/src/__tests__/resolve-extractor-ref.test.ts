import { describe, expect, test } from 'bun:test';
import type { IWiringSource } from '../wiring/wiring-rule.ts';
import { referencedExtractorIds, resolveExtractorRef } from '../wiring/resolve-extractor-ref.ts';
import { resolvePlaneExtractors } from '../wiring/resolve-plane-extractors.ts';

const HANDLERS: IWiringSource = {
  files: ['src/handlers/*.ts'],
  extract: 'export-names',
  match: '_HANDLER$',
};
const EXTRACTORS = { handlers: HANDLERS } as const;

describe('resolveExtractorRef', () => {
  test('an inline source is returned untouched — `$use` is opt-in', () => {
    const inline: IWiringSource = { files: ['a/*.ts'], extract: 'export-names' };
    const out = resolveExtractorRef(inline, EXTRACTORS);
    expect(out.error).toBeUndefined();
    expect(out.source).toEqual(inline);
  });

  test('a `$use` reference adopts the named extractor and keeps provenance', () => {
    const out = resolveExtractorRef({ $use: 'handlers' }, EXTRACTORS);
    expect(out.error).toBeUndefined();
    expect(out.source.files).toEqual(['src/handlers/*.ts']);
    expect(out.source.extract).toBe('export-names');
    expect(out.source.match).toBe('_HANDLER$');
    // Provenance survives so `gates explain` can name where the selector came from.
    expect(out.source.$use).toBe('handlers');
  });

  test('a local field OVERRIDES the shared one — sharing is not all-or-nothing', () => {
    const out = resolveExtractorRef({ $use: 'handlers', match: '^ALPHA' }, EXTRACTORS);
    expect(out.source.files).toEqual(['src/handlers/*.ts']);
    expect(out.source.match).toBe('^ALPHA');
  });

  test('an unknown id is an ERROR, never a source that silently matches nothing', () => {
    const out = resolveExtractorRef({ $use: 'handlerz' }, EXTRACTORS);
    expect(out.error).toContain('unknown extractor "handlerz"');
    // The known ids are listed so the typo is fixable without opening the config.
    expect(out.error).toContain('handlers');
  });

  test('an unknown id with NO extractors declared still names the problem', () => {
    const out = resolveExtractorRef({ $use: 'handlers' }, undefined);
    expect(out.error).toContain('(none)');
  });

  test('referencedExtractorIds dedupes in first-seen order', () => {
    expect(
      referencedExtractorIds([{ $use: 'b' }, { $use: 'a' }, { $use: 'b' }, undefined, { files: ['x'] }]),
    ).toEqual(['b', 'a']);
  });
});

describe('resolvePlaneExtractors', () => {
  test('rewrites every side of every plane, and reports the dotted path on failure', () => {
    const out = resolvePlaneExtractors(
      {
        wiringRules: [
          {
            id: 'w1',
            declared: { $use: 'handlers' },
            registered: [{ $use: 'handlers' }, { $use: 'nope' }],
          },
        ],
        registries: [{ name: 'r1', source: { $use: 'handlers' }, consumer: { $use: 'handlers' } }],
        registrationGraph: [
          {
            name: 'g1',
            declared: { $use: 'handlers' },
            provided: { $use: 'handlers' },
            consumed: { $use: 'handlers' },
          },
        ],
        baselines: [
          { id: 'b1', baseline: 'x.txt', compute: { kind: 'extractor', source: { $use: 'handlers' } } },
        ],
      },
      EXTRACTORS,
    );

    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]!.path).toBe('wiringRules[w1].registered[1]');

    expect(out.wiringRules![0]!.declared!.files).toEqual(['src/handlers/*.ts']);
    expect(out.registries![0]!.source.files).toEqual(['src/handlers/*.ts']);
    expect(out.registries![0]!.consumer!.files).toEqual(['src/handlers/*.ts']);
    expect(out.registrationGraph![0]!.provided.files).toEqual(['src/handlers/*.ts']);
    expect(out.baselines![0]!.compute.source!.files).toEqual(['src/handlers/*.ts']);
  });

  test('a chain rule resolves every hop', () => {
    const out = resolvePlaneExtractors(
      { wiringRules: [{ id: 'c', chain: [{ $use: 'handlers' }, { files: ['sink.ts'], pattern: '(\\w+)' }] }] },
      EXTRACTORS,
    );
    expect(out.errors).toHaveLength(0);
    expect(out.wiringRules![0]!.chain![0]!.files).toEqual(['src/handlers/*.ts']);
  });

  test('planes absent from the input stay absent — no invented empty planes', () => {
    const out = resolvePlaneExtractors({ wiringRules: [] }, EXTRACTORS);
    expect(out.wiringRules).toEqual([]);
    expect(out.registries).toBeUndefined();
    expect(out.baselines).toBeUndefined();
  });

  test('a baseline with a command compute (no source) passes through untouched', () => {
    const rule = { id: 'b', baseline: 'x.txt', compute: { kind: 'command' as const, run: 'echo hi' } };
    const out = resolvePlaneExtractors({ baselines: [rule] }, EXTRACTORS);
    expect(out.errors).toHaveLength(0);
    expect(out.baselines![0]).toBe(rule);
  });
});
