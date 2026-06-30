/**
 * `shrk registry` commands.
 *
 *   shrk registry lifecycle [--json]            # register/remove symmetry
 *   shrk registry <name> list [--json]          # every declared id
 *   shrk registry <name> exists <id> [--json]   # is the id taken? (exit 1 if not)
 *   shrk registry <name> where <id> [--json]    # declaration (+ consumer) sites
 *
 * `<name>` resolves a `registries[]` declaration in sharkcraft.config.ts — one
 * deterministic multi-root scan that answers "is this id taken / where is it"
 * without an agent re-running a fragile grep.
 */
import {
  buildRegistryLifecycleReport,
  renderRegistryLifecycleReportText,
  resolveProjectConfig,
} from '@shrkcrft/inspector';
import {
  scanRegistry,
  registryExists,
  registryWhere,
  type IRegistryInventory,
} from '@shrkcrft/boundaries';
import type { IRegistryDeclaration } from '@shrkcrft/core';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const registryLifecycleCommand: ICommandHandler = {
  name: 'lifecycle',
  description: 'Scan the workspace for register/remove symmetry. Read-only.',
  usage: 'shrk registry lifecycle [--scope <dir>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const scope = flagString(args, 'scope');
    const report = buildRegistryLifecycleReport({ projectRoot: cwd, ...(scope ? { scope } : {}) });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return report.missingRemovers.length === 0 ? 0 : 1;
    }
    process.stdout.write(renderRegistryLifecycleReportText(report));
    return report.missingRemovers.length === 0 ? 0 : 1;
  },
};

async function loadRegistries(
  cwd: string,
): Promise<
  | { ok: true; registries: readonly IRegistryDeclaration[]; planeDiagnostics: readonly string[] }
  | { ok: false; message: string }
> {
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return { ok: false, message: loaded.error.message };
  return {
    ok: true,
    registries: loaded.value.config.registries ?? [],
    planeDiagnostics: loaded.value.planeDiagnostics,
  };
}

function findRegistry(
  registries: readonly IRegistryDeclaration[],
  name: string,
): IRegistryDeclaration | undefined {
  return registries.find((r) => r.name === name);
}

/** Run a `list | exists | where` query against a declared registry. */
async function runRegistryInventory(args: ParsedArgs, name: string): Promise<number> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const action = args.positional[1];
  const id = args.positional[2];

  const loaded = await loadRegistries(cwd);
  if (!loaded.ok) {
    if (json) process.stdout.write(asJson({ error: loaded.message }) + '\n');
    else process.stderr.write(`Could not load config: ${loaded.message}\n  Run \`shrk doctor\` for details.\n`);
    return 1;
  }
  const decl = findRegistry(loaded.registries, name);
  if (!decl) {
    const names = loaded.registries.map((r) => r.name);
    const avail = names.length > 0 ? `Declared registries: ${names.join(', ')}.` : 'No registries declared in sharkcraft.config.ts `registries[]`.';
    if (json) process.stdout.write(asJson({ error: `unknown registry "${name}"`, available: names }) + '\n');
    else process.stderr.write(`No registry named "${name}". ${avail}\n`);
    return 2;
  }

  const inventory: IRegistryInventory = scanRegistry(cwd, decl);

  if (action === 'list' || action === undefined) {
    // Fold pack-plane merge notes (missing/invalid pack registry files, dropped
    // collisions) into the inventory's own scan diagnostics.
    const diagnostics = [...inventory.diagnostics, ...loaded.planeDiagnostics];
    if (json) {
      process.stdout.write(
        asJson({ name: inventory.name, count: inventory.entries.length, ids: inventory.entries.map((e) => e.id), diagnostics }) + '\n',
      );
      return 0;
    }
    process.stdout.write(`Registry "${inventory.name}"${inventory.description ? ' — ' + inventory.description : ''}\n`);
    process.stdout.write(`  ${inventory.entries.length} id(s)\n`);
    for (const e of inventory.entries) {
      process.stdout.write(`  • ${e.id}  (${e.sites.length} site${e.sites.length === 1 ? '' : 's'})\n`);
    }
    for (const d of diagnostics) process.stdout.write(`  ! ${d}\n`);
    return 0;
  }

  if (action === 'exists') {
    if (!id) {
      process.stderr.write(`Usage: shrk registry ${name} exists <id>\n`);
      return 2;
    }
    const exists = registryExists(inventory, id);
    if (json) process.stdout.write(asJson({ name: inventory.name, id, exists }) + '\n');
    else process.stdout.write(`${exists ? 'yes' : 'no'} — "${id}" is ${exists ? 'declared' : 'NOT declared'} in registry "${inventory.name}".\n`);
    return exists ? 0 : 1;
  }

  if (action === 'where') {
    if (!id) {
      process.stderr.write(`Usage: shrk registry ${name} where <id>\n`);
      return 2;
    }
    const entry = registryWhere(inventory, id);
    if (json) {
      process.stdout.write(asJson({ name: inventory.name, id, found: entry !== undefined, entry: entry ?? null }) + '\n');
      return entry ? 0 : 1;
    }
    if (!entry) {
      process.stdout.write(`"${id}" is not declared in registry "${inventory.name}".\n`);
      return 1;
    }
    process.stdout.write(`"${id}" in registry "${inventory.name}":\n`);
    for (const s of entry.sites) process.stdout.write(`  declared  ${s.file}:${s.line}\n`);
    for (const s of entry.consumerSites ?? []) process.stdout.write(`  consumed  ${s.file}:${s.line}\n`);
    return 0;
  }

  process.stderr.write(`Unknown action "${action}". Usage: shrk registry ${name} list | exists <id> | where <id>\n`);
  return 2;
}

export const registryCommand: ICommandHandler = {
  name: 'registry',
  description: 'Registry inspections: lifecycle symmetry + declared-registry inventory. Read-only.',
  usage: 'shrk registry lifecycle | <name> list | <name> exists <id> | <name> where <id>',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'lifecycle') {
      args.positional = args.positional.slice(1);
      return registryLifecycleCommand.run(args);
    }
    if (sub !== undefined && sub.length > 0) {
      // `<name> list | exists <id> | where <id>` — sub is the registry name.
      return runRegistryInventory(args, sub);
    }
    const cwd = resolveCwd(args);
    const loaded = await loadRegistries(cwd);
    const names = loaded.ok ? loaded.registries.map((r) => r.name) : [];
    process.stderr.write(
      'Usage: shrk registry lifecycle | <name> list | <name> exists <id> | <name> where <id>\n' +
        (names.length > 0 ? `Declared registries: ${names.join(', ')}.\n` : 'No registries declared (sharkcraft.config.ts `registries[]`).\n'),
    );
    return 2;
  },
};
