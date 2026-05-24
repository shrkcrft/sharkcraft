import { ARCH_CONTRACT_SCHEMA, type IArchContract } from '../schema/contract.ts';

/**
 * Build an architecture contract. Validates the layer references in
 * each rule; throws on undefined layer names so authoring mistakes are
 * caught at load time, not check time.
 */
export function defineArchContract(input: Omit<IArchContract, 'schema'>): IArchContract {
  const layerNames = new Set(input.layers.map((l) => l.name));
  for (const r of input.rules) {
    if (!layerNames.has(r.from)) {
      throw new Error(`arch-contract: rule.from refers to undefined layer "${r.from}"`);
    }
    for (const l of r.mayImport ?? []) {
      if (!layerNames.has(l)) throw new Error(`arch-contract: rule.mayImport refers to undefined layer "${l}"`);
    }
    for (const l of r.mayNotImport ?? []) {
      if (!layerNames.has(l)) throw new Error(`arch-contract: rule.mayNotImport refers to undefined layer "${l}"`);
    }
  }
  return { schema: ARCH_CONTRACT_SCHEMA, ...input };
}
