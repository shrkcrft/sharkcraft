import type { IRegistryDeclaration } from '@shrkcrft/core';
import {
  describeUnread,
  readScopeCoverage,
  readScopeHasUnread,
  registryDuplicates,
  registryExists,
  type IRegistryInventory,
} from '@shrkcrft/boundaries';
import { ExitCode } from '../exit-codes.ts';
import { asJson } from '../output/format-output.ts';
import { settleVerdict } from './settle-verdict.ts';
import { verdictLine } from './verdict-line.ts';

/**
 * Answer a `registry <name> list | exists | where | duplicates` query over an
 * INCOMPLETE inventory: one whose source globs matched a file the reader did
 * not read (over the read cap). Returns `undefined` when the answer is
 * verified anyway, so the caller answers normally.
 *
 * Only a POSITIVE finding survives an incomplete read. An id found among the
 * files read is declared, and a duplicate found there is a duplicate. Absence
 * ("no", "not declared", "no duplicates") and the listing itself may be wrong,
 * because the unread file can hold the id. So those are NOT VERIFIED (2),
 * whatever guard flag was passed, and are settled through the one coverage
 * guard (`readScopeCoverage` → `settleVerdict`) so the exit and the printed
 * verdict agree. `exists X --fail-if-taken` over an unread file is never the
 * "free" 0 a duplicate guard would march on.
 */
export function answerIncompleteInventory(
  inventory: IRegistryInventory,
  decl: IRegistryDeclaration,
  action: string | undefined,
  id: string | undefined,
  json: boolean,
): number | undefined {
  if (!readScopeHasUnread(inventory.readScope)) return undefined;
  if ((action === 'exists' || action === 'where') && id !== undefined && registryExists(inventory, id)) {
    return undefined;
  }
  if (action === 'duplicates' && registryDuplicates(inventory).length > 0) return undefined;

  const coverage = {
    ...readScopeCoverage(
      { unit: 'ids', expected: inventory.entries.length, examined: inventory.entries.length },
      inventory.readScope,
    ),
    subject: `registry "${inventory.name}"`,
  };
  const settled = settleVerdict(ExitCode.VerifiedPass, [coverage]);
  const what = describeUnread(inventory.readScope.unread);
  if (json) {
    process.stdout.write(
      asJson({
        name: inventory.name,
        ...(action ? { action } : {}),
        ...(id !== undefined ? { id } : {}),
        ids: inventory.entries.map((e) => e.id),
        verified: false,
        unread: inventory.readScope.unread,
        exitCode: settled.exit,
        verdict: settled.verdict,
        shortfalls: settled.shortfalls,
      }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(
    `Registry "${inventory.name}"${decl.description ? ` — ${decl.description}` : ''}: its source globs matched ${what},\n` +
      '  so the inventory is incomplete and this answer is NOT verified.\n',
  );
  if (action === 'list' || action === undefined) {
    process.stdout.write(`  ${inventory.entries.length} id(s) among the files read:\n`);
    for (const e of inventory.entries) process.stdout.write(`  • ${e.id}\n`);
  } else if (id !== undefined) {
    process.stdout.write(`  "${id}" is not among the ids read; the unread file may declare it.\n`);
  }
  const line = verdictLine(settled, '');
  if (line) process.stdout.write(`${line}\n`);
  return settled.exit;
}
