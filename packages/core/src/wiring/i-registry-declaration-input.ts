import type { IWiringSourceInput } from './i-wiring-source-input.ts';
import type { IRegistryDeclaration } from './registry-declaration.ts';

/** The AUTHORED registry declaration (round 13): `source` / `consumer` take the markable {@link IWiringSourceInput}. */
export interface IRegistryDeclarationInput extends Omit<IRegistryDeclaration, 'source' | 'consumer'> {
  readonly source: IWiringSourceInput;
  readonly consumer?: IWiringSourceInput;
}
