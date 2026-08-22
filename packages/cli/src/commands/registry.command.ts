/**
 * `shrk registry` commands.
 *
 *   shrk registry lifecycle [--json]            # register/remove symmetry
 *   shrk registry <name> list [--json]          # every declared id
 *   shrk registry <name> exists <id> [--json]   # is the id taken? (exit 1 if not)
 *       [--resolve]                             #   map a synonym → canonical id first
 *       [--fail-if-taken]                       #   guard: non-zero when taken (free → 0)
 *       [--fail-if-missing]                     #   guard: non-zero when NOT registered
 *   shrk registry <name> where <id> [--json]    # declaration (+ consumer) sites
 *   shrk registry <name> duplicates [--json]    # ids declared in more than one place
 *
 * `<name>` resolves a `registries[]` declaration in sharkcraft.config.ts — one
 * deterministic multi-root scan that answers "is this id taken / where is it"
 * without an agent re-running a fragile grep.
 */
import {
  buildRegistryLifecycleReport,
  renderRegistryLifecycleReportText,
  resolveChangedFiles,
  resolveProjectConfig,
} from '@shrkcrft/inspector';
import {
  scanRegistry,
  registryDuplicates,
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
import { ExitCode } from '../exit-codes.ts';
import { asJson } from '../output/format-output.ts';
import { resolveRegistryNoun } from './registry-resolve.ts';

/** The inventory verbs, used to detect (and forgive) a verb-first invocation. */
const INVENTORY_VERBS: ReadonlySet<string> = new Set(['list', 'exists', 'where', 'duplicates']);

export const registryLifecycleCommand: ICommandHandler = {
  name: 'lifecycle',
  description: 'Scan the workspace for register/remove symmetry. Read-only.',
  usage: 'shrk registry lifecycle [--scope <dir>] [--changed-only] [--since <ref>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const scope = flagString(args, 'scope');
    const changedOnly = flagBool(args, 'changed-only');
    const since = flagString(args, 'since');
    let files: readonly string[] | undefined;
    if (changedOnly || since) {
      const changed = resolveChangedFiles({
        projectRoot: cwd,
        ...(since ? { since } : {}),
        ...(changedOnly && !since ? { includeWorktree: true } : {}),
      });
      files = changed.files;
    }
    // Full-tree walk honors the project's skipDirs override.
    let skipDirs: readonly string[] | undefined;
    if (files === undefined) {
      const loaded = await resolveProjectConfig(cwd);
      if (loaded.ok) skipDirs = loaded.value.config.registryLifecycle?.skipDirs;
    }
    const report = buildRegistryLifecycleReport({
      projectRoot: cwd,
      ...(files !== undefined ? { files } : {}),
      ...(scope ? { scope } : {}),
      ...(skipDirs ? { skipDirs } : {}),
    });
    // Honest exit-code contract (a25 §1 / §2.5): a wedged/timed-out scan OR a
    // scope with zero registrations to check is NOT verified (`2`), never a
    // green `0` an agent's `&& next` would march past.
    const exit =
      report.timedOut || report.registersFound === 0
        ? ExitCode.NotVerified
        : report.missingRemovers.length === 0
          ? ExitCode.VerifiedPass
          : ExitCode.Failure;
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return exit;
    }
    process.stdout.write(renderRegistryLifecycleReportText(report));
    return exit;
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
    // Typing the verb first is the common stumble (siblings are verb-first).
    // Name the correct grammar instead of only reporting the miss.
    const verbFirst = INVENTORY_VERBS.has(name);
    if (json) {
      process.stdout.write(
        asJson({ error: `unknown registry "${name}"`, available: names, ...(verbFirst ? { hint: `did you mean 'registry <name> ${name}'?` } : {}) }) + '\n',
      );
    } else {
      process.stderr.write(`No registry named "${name}". ${avail}\n`);
      if (verbFirst) {
        const example = names[0] ?? '<name>';
        process.stderr.write(
          `"${name}" is a verb, not a registry — did you mean \`shrk registry ${example} ${name}\`?\n`,
        );
      }
    }
    return ExitCode.UsageError;
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
      process.stderr.write(`Usage: shrk registry ${name} exists <id> [--resolve] [--fail-if-taken|--fail-if-missing]\n`);
      return ExitCode.UsageError;
    }
    const failIfTaken = flagBool(args, 'fail-if-taken');
    const failIfMissing = flagBool(args, 'fail-if-missing');
    if (failIfTaken && failIfMissing) {
      process.stderr.write('Pass at most one of --fail-if-taken / --fail-if-missing.\n');
      return ExitCode.UsageError;
    }
    // `--resolve` maps a human noun to the canonical registered id before the
    // existence test — via the registry's declared `aliases` map AND generic
    // normalization (case-fold, singular/plural, suffix strip/append) — so a
    // duplicate guard can't return a false "free" on a synonym of an
    // already-taken slug (a25 §2.4).
    const doResolve = flagBool(args, 'resolve');
    const resolution = doResolve
      ? resolveRegistryNoun(inventory.entries.map((e) => e.id), decl.aliases, id)
      : undefined;
    const canonical = resolution ? resolution.canonical : id;
    const resolved = canonical !== id;
    const exists = registryExists(inventory, canonical);
    // Exit-code convention:
    //   --fail-if-taken   → non-zero when the id is already registered (free → 0),
    //                       so `exists <id> --fail-if-taken && <author>` is a natural guard.
    //   --fail-if-missing → non-zero when the id is NOT registered (the consume-side check).
    //   neither           → the historical query convention (taken → 0, free → 1).
    const code = failIfTaken ? (exists ? 1 : 0) : exists ? 0 : 1;
    if (json) {
      process.stdout.write(
        asJson({
          name: inventory.name,
          id,
          ...(resolved ? { resolvedId: canonical, resolvedVia: resolution?.via } : {}),
          exists,
          exitCode: code,
        }) + '\n',
      );
      return code;
    }
    if (resolved) {
      process.stdout.write(`resolved "${id}" → "${canonical}" (${resolution?.via})\n`);
    }
    process.stdout.write(
      `${exists ? 'yes' : 'no'} — "${canonical}" is ${exists ? 'declared' : 'NOT declared'} in registry "${inventory.name}".\n`,
    );
    return code;
  }

  if (action === 'duplicates') {
    // Two roots claiming the same id compile fine; whichever registration wins
    // at runtime is an accident of load order. Every site is printed so the
    // duplicate can be resolved, not merely detected.
    const dupes = registryDuplicates(inventory);
    if (json) {
      process.stdout.write(
        asJson({
          name: inventory.name,
          scanned: inventory.entries.length,
          duplicates: dupes,
          diagnostics: [...inventory.diagnostics, ...loaded.planeDiagnostics],
        }) + '\n',
      );
      return inventory.entries.length === 0 ? 2 : dupes.length > 0 ? 1 : 0;
    }
    if (inventory.entries.length === 0) {
      process.stdout.write(
        `Registry "${inventory.name}" matched 0 ids — nothing was checked. This is NOT a pass;\n` +
          '  the source selector is probably stale (see `shrk gates coverage`).\n',
      );
      return 2;
    }
    if (dupes.length === 0) {
      process.stdout.write(
        `No duplicate ids in registry "${inventory.name}" (${inventory.entries.length} scanned). ✓\n`,
      );
      return 0;
    }
    process.stdout.write(`Duplicate ids in registry "${inventory.name}" (${dupes.length}):\n`);
    for (const e of dupes) {
      process.stdout.write(`  ✗ ${e.id}  (${e.sites.length} declarations)\n`);
      for (const s of e.sites) process.stdout.write(`      ${s.file}:${s.line}\n`);
    }
    return 1;
  }

  if (action === 'where') {
    if (!id) {
      process.stderr.write(`Usage: shrk registry ${name} where <id>\n`);
      return ExitCode.UsageError;
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

  process.stderr.write(
    `Unknown action "${action}". Usage: shrk registry ${name} list | exists <id> | where <id> | duplicates\n`,
  );
  return ExitCode.UsageError;
}

export const registryCommand: ICommandHandler = {
  name: 'registry',
  description: 'Registry inspections: lifecycle symmetry + declared-registry inventory. Read-only.',
  usage:
    'shrk registry lifecycle | <name> list | <name> exists <id> [--resolve] [--fail-if-taken|--fail-if-missing] | <name> where <id> | <name> duplicates',
  // Guard-mode + query flags take no value — declare them so `exists <id>
  // --fail-if-taken` (flag last) and `exists --resolve <id>` (flag first) both
  // keep the id as a positional instead of swallowing it.
  booleanFlags: new Set(['json', 'resolve', 'fail-if-taken', 'fail-if-missing']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'lifecycle') {
      args.positional = args.positional.slice(1);
      return registryLifecycleCommand.run(args);
    }
    if (sub !== undefined && sub.length > 0) {
      // Grammar is `registry <name> <verb>`, but `baseline`/`generated` read
      // verb-first, so `registry list <name>` is the instinctive form. Accept
      // BOTH: when arg1 is a known verb and arg2 names a declared registry,
      // swap them. The canonical order is unchanged; the stumble is removed.
      const second = args.positional[1];
      if (INVENTORY_VERBS.has(sub) && second !== undefined && second.length > 0) {
        const loaded = await loadRegistries(resolveCwd(args));
        const known = loaded.ok && findRegistry(loaded.registries, second) !== undefined;
        if (known) {
          // [verb, name, ...rest] → [name, verb, ...rest]
          args.positional = [second, sub, ...args.positional.slice(2)];
          return runRegistryInventory(args, second);
        }
      }
      // `<name> list | exists <id> | where <id> | duplicates` — sub is the name.
      return runRegistryInventory(args, sub);
    }
    const cwd = resolveCwd(args);
    const loaded = await loadRegistries(cwd);
    const names = loaded.ok ? loaded.registries.map((r) => r.name) : [];
    process.stderr.write(
      'Usage: shrk registry lifecycle | <name> list | <name> exists <id> | <name> where <id> | <name> duplicates\n' +
        (names.length > 0 ? `Declared registries: ${names.join(', ')}.\n` : 'No registries declared (sharkcraft.config.ts `registries[]`).\n'),
    );
    return 2;
  },
};
