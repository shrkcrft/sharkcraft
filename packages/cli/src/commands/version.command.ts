import { SHARKCRAFT_VERSION } from '@shrkcrft/shared';
import type { ICommandHandler } from '../command-registry.ts';

export const versionCommand: ICommandHandler = {
  name: 'version',
  description: 'Show SharkCraft version.',
  usage: 'shrk version',
  run(): number {
    process.stdout.write(`SharkCraft v${SHARKCRAFT_VERSION}\n`);
    return 0;
  },
};
