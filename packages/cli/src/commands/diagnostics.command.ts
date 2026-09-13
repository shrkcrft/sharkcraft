import { listDiagnostics } from '@shrkcrft/inspector';
import { flagBool, type ICommandHandler, type ParsedArgs } from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

// `diagnostics get` / `diagnostics suggest` were pruned from the surface (r48);
// their handlers lingered here unregistered, still printing usage for commands
// that exit 2. `list` is the one registered verb.
export const diagnosticsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List known SharkCraft failure diagnostics. Read-only.',
  usage: 'shrk diagnostics list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const entries = listDiagnostics();
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ schema: 'sharkcraft.diagnostic-registry/v1', entries }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Diagnostics (${entries.length})`));
    for (const e of entries) {
      const keys = e.contextKeys.length === 0 ? '' : ` context: ${e.contextKeys.join(', ')}`;
      process.stdout.write(`  ${e.code.padEnd(34)} ${e.description}${keys}\n`);
    }
    return 0;
  },
};
