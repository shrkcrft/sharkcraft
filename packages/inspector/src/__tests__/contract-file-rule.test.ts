import { describe, expect, it } from 'bun:test';
import {
  ContractFileRuleKind,
  matchContractFileRule,
  rulesFromLegacyStrings,
} from '../contract-file-rule.ts';

describe('contract file rule matching', () => {
  it('exact match is case-insensitive', () => {
    expect(
      matchContractFileRule({ pattern: 'package.json', kind: ContractFileRuleKind.Exact }, 'package.json'),
    ).toBe(true);
    expect(
      matchContractFileRule({ pattern: 'package.json', kind: ContractFileRuleKind.Exact }, 'PACKAGE.JSON'),
    ).toBe(true);
    expect(
      matchContractFileRule({ pattern: 'package.json', kind: ContractFileRuleKind.Exact }, 'packages/x/package.json'),
    ).toBe(false);
  });

  it('path-prefix matches sub-trees', () => {
    expect(
      matchContractFileRule({ pattern: 'libs/demo', kind: ContractFileRuleKind.PathPrefix }, 'libs/demo/x/y.ts'),
    ).toBe(true);
    expect(
      matchContractFileRule({ pattern: 'libs/demo', kind: ContractFileRuleKind.PathPrefix }, 'libs/demo-other/x.ts'),
    ).toBe(false);
  });

  it('glob matches single + double star', () => {
    expect(
      matchContractFileRule({ pattern: '.git/**', kind: ContractFileRuleKind.Glob }, '.git/objects/ab/cdef'),
    ).toBe(true);
    expect(
      matchContractFileRule({ pattern: 'src/*.ts', kind: ContractFileRuleKind.Glob }, 'src/foo.ts'),
    ).toBe(true);
    expect(
      matchContractFileRule({ pattern: 'src/*.ts', kind: ContractFileRuleKind.Glob }, 'src/nested/foo.ts'),
    ).toBe(false);
    expect(
      matchContractFileRule({ pattern: '**/manifest.signed.json', kind: ContractFileRuleKind.Glob }, 'packages/foo/dist/manifest.signed.json'),
    ).toBe(true);
  });

  it('contains is the legacy substring fallback', () => {
    expect(
      matchContractFileRule({ pattern: 'package.json', kind: ContractFileRuleKind.Contains }, 'libs/x/package.json'),
    ).toBe(true);
    const legacy = rulesFromLegacyStrings(['package.json', '.git']);
    expect(legacy).toHaveLength(2);
    expect(legacy[0]!.kind).toBe(ContractFileRuleKind.Contains);
  });

  it('? matches a single non-separator character', () => {
    expect(
      matchContractFileRule({ pattern: 'src/foo?.ts', kind: ContractFileRuleKind.Glob }, 'src/fooX.ts'),
    ).toBe(true);
    expect(
      matchContractFileRule({ pattern: 'src/foo?.ts', kind: ContractFileRuleKind.Glob }, 'src/fooXY.ts'),
    ).toBe(false);
  });
});
