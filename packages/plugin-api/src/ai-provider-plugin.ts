import type { ISharkCraftPlugin } from './sharkcraft-plugin.ts';

export interface IAiProviderRegistration {
  providerId: string;
  providerName: string;
}

export interface IAiProviderPlugin extends ISharkCraftPlugin {
  readonly providers: readonly IAiProviderRegistration[];
}
