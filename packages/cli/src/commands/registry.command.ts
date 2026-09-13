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
 * An inventory that matched 0 ids answers NO query: `list` / `exists` / `where`
 * / `duplicates` all exit 2 (not verified) — 1 when the registry sets
 * `failOnEmpty` — whatever guard flag was passed.
 *
 * `<name>` resolves a `registries[]` declaration in sharkcraft.config.ts — one
 * deterministic multi-root scan that answers "is this id taken / where is it"
 * without an agent re-running a fragile grep.
 */
import { resolveProjectConfig } from '@shrkcrft/inspector';
import { REGISTRY_LIFECYCLE_FLAGS_USAGE, runRegistryLifecycle } from './registry-lifecycle-run.ts';
import { ALLOW_EMPTY_FLAG } from '../gates/allow-empty.ts';
import {
  planeScanExcludeDirs,
  scanRegistry,
  registryDuplicates,
  registryExists,
  registryWhere,
  type IRegistryInventory,
} from '@shrkcrft/boundaries';
import {
  failsWhenEmpty,
  RuleEmptiness,
  settleRuleEmptiness,
  type IRegistryDeclaration,
  type ISettledRuleEmptiness,
  type ISettledUnitLiveness,
} from '@shrkcrft/core';
import { registryLiveness } from '../gates/registry-liveness.ts';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson } from '../output/format-output.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { qualifyCleanForUnits } from '../gates/qualify-clean-for-units.ts';
import { unitStateNotes } from '../gates/unit-state-notes.ts';
import { answerIncompleteInventory } from '../gates/incomplete-registry-inventory.ts';
import type { IGateRuleResult } from '../gates/gate-envelope.ts';
import { seamRejectedRules } from '../gates/seam-rejected-rules.ts';
import { resolveRegistryNoun } from './registry-resolve.ts';

/** The inventory verbs, used to detect (and forgive) a verb-first invocation. */
const INVENTORY_VERBS: ReadonlySet<string> = new Set(['list', 'exists', 'where', 'duplicates']);

export const registryLifecycleCommand: ICommandHandler = {
  name: 'lifecycle',
  description: 'Scan the workspace for register/remove symmetry. Read-only.',
  usage: `shrk registry lifecycle ${REGISTRY_LIFECYCLE_FLAGS_USAGE}`,
  booleanFlags: new Set(['json', 'changed-only', ALLOW_EMPTY_FLAG]),
  // The same body as `check registry-lifecycle` (registry-lifecycle-run.ts):
  // one settled verdict, not a second copy of the exit derivation.
  run(args: ParsedArgs): Promise<number> {
    return runRegistryLifecycle(args, 'registry lifecycle');
  },
};

async function loadRegistries(
  cwd: string,
): Promise<
  | {
      ok: true;
      registries: readonly IRegistryDeclaration[];
      planeDiagnostics: readonly string[];
      /** THE plane scan scope — the tree `gates check`'s registry plane walks. */
      excludeDirs: readonly string[];
      /** Pack registries the merge seam rejected (round 12 review, R12-X1) — declared, never scanned. */
      rejected: readonly IGateRuleResult[];
    }
  | { ok: false; message: string }
> {
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) return { ok: false, message: loaded.error.message };
  return {
    ok: true,
    registries: loaded.value.config.registries ?? [],
    planeDiagnostics: loaded.value.planeDiagnostics,
    excludeDirs: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir),
    rejected: seamRejectedRules(loaded.value, ['registry']),
  };
}

function findRegistry(
  registries: readonly IRegistryDeclaration[],
  name: string,
): IRegistryDeclaration | undefined {
  return registries.find((r) => r.name === name);
}

/** Why an empty inventory proves nothing, in the words every inventory verb prints. */
const EMPTY_INVENTORY_REASON =
  'the source selector matched nothing — it is probably stale (see `shrk gates coverage`)';

/**
 * THE rule-emptiness settle of an inventory that matched 0 ids (round 13,
 * `settleRuleEmptiness`), over the registry's glob liveness
 * (`registryLiveness`, the one `gates check` reads) and THE failOnEmpty
 * authority (`failsWhenEmpty`; a registry is warning-severity, so an explicit
 * `failOnEmpty: true` is what makes it block). Every source inclusion glob
 * marked `expectEmpty` and no source file matched → an inventory over a
 * planned directory: INTENDED-empty, so a membership question has a real
 * answer (nothing is registered yet) and the acceptance is printed.
 */
function settleInventoryEmptiness(
  decl: IRegistryDeclaration,
  inventory: IRegistryInventory,
  liveness: ISettledUnitLiveness,
): ISettledRuleEmptiness {
  return settleRuleEmptiness({
    subject: decl.name,
    unitLabel: 'ids',
    filesMatched: inventory.readScope.read,
    unitsMatched: inventory.entries.length,
    unread: false,
    liveness,
    primaryLists: ['source.files'],
    failOnEmpty: failsWhenEmpty({
      ...(decl.failOnEmpty !== undefined ? { failOnEmpty: decl.failOnEmpty } : {}),
      severity: 'warning',
    }),
    noFilesReason: EMPTY_INVENTORY_REASON,
    noUnitsReason: EMPTY_INVENTORY_REASON,
  });
}

/**
 * The printed `expectEmpty` acceptance of the registry's glob units — settle
 * record B of THE settle `gates check` reads (`registryLiveness`), from the
 * settled verdict, never hand-built. It rides on every exit-0 answer (round 13
 * review): an inventory over a planned directory (where it IS the inventory's
 * emptiness record), AND a live inventory with a planned sibling glob — which
 * `gates check` accepted in print while every registry verb was silent.
 */
function acceptedUnitLines(liveness: ISettledUnitLiveness | undefined): readonly string[] {
  if (liveness?.acceptance === undefined) return [];
  return settleVerdict(ExitCode.VerifiedPass, [liveness.acceptance]).accepted;
}

/**
 * Answer a query over an inventory that matched NOTHING.
 *
 * An empty inventory cannot answer a membership question: `exists X` would say
 * "no" (1) for an id that IS declared — only the glob went stale — and `exists
 * X --fail-if-taken` would say "free" (0), so the documented duplicate guard
 * `exists X --fail-if-taken && <author>` marched on over a scan that saw
 * nothing. Every inventory verb therefore answers the empty inventory itself,
 * whatever guard flag was passed: not verified (2), or a failure (1) when the
 * registry sets `failOnEmpty`. Settled through the one coverage guard, so the
 * exit and the printed verdict cannot disagree.
 */
function answerEmptyInventory(
  inventory: IRegistryInventory,
  emptiness: ISettledRuleEmptiness,
  json: boolean,
  payload: Readonly<Record<string, unknown>>,
  diagnostics: readonly string[] = [],
): number {
  const failOnEmpty = emptiness.fails;
  const settled = settleVerdict(failOnEmpty ? ExitCode.Failure : ExitCode.VerifiedPass, [
    {
      unit: 'ids',
      expected: 0,
      examined: 0,
      subject: `registry "${inventory.name}"`,
      reason: emptiness.skipReason ?? EMPTY_INVENTORY_REASON,
    },
  ]);
  if (json) {
    process.stdout.write(
      asJson({
        ...payload,
        verified: false,
        exitCode: settled.exit,
        verdict: settled.verdict,
        shortfalls: settled.shortfalls,
      }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(
    `Registry "${inventory.name}" matched 0 ids — nothing was checked. This is NOT a pass;\n` +
      '  the source selector is probably stale (see `shrk gates coverage`).\n',
  );
  for (const d of diagnostics) process.stdout.write(`  ! ${d}\n`);
  if (failOnEmpty) {
    process.stdout.write('  The registry sets `failOnEmpty: true`, so an empty inventory is a failure.\n');
  }
  const line = verdictLine(settled, '');
  if (line) process.stdout.write(`${line}\n`);
  return settled.exit;
}

/** Run a `list | exists | where` query against a declared registry. */
async function runRegistryInventory(args: ParsedArgs, name: string): Promise<number> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const action = args.positional[1];
  const id = args.positional[2];

  const loaded = await loadRegistries(cwd);
  if (!loaded.ok) {
    // The registry is declared in the config that did not load: the query never
    // STARTED — a usage error (3), never the `1` that reads "missing" / "taken".
    if (json) {
      process.stdout.write(
        asJson({ error: loaded.message, exitCode: ExitCode.UsageError, verdict: 'usage-error' }) + '\n',
      );
    } else {
      process.stderr.write(`Could not load config: ${loaded.message}\n  Run \`shrk doctor\` for details.\n`);
    }
    return ExitCode.UsageError;
  }
  const decl = findRegistry(loaded.registries, name);
  const rejectedDecl = decl ? undefined : loaded.rejected.find((r) => r.id === name);
  if (rejectedDecl) {
    // Declared by a pack, refused by the merge seam: the inventory was never
    // scanned, so no query over it can be answered — a failure (1), never the
    // "unknown registry" usage error (round 12 review, R12-X1).
    const message = rejectedDecl.error ?? 'failed validation';
    if (json) {
      process.stdout.write(
        asJson({ name, rejected: true, error: message, exitCode: ExitCode.Failure, verdict: 'fail' }) + '\n',
      );
    } else {
      process.stdout.write(
        `Registry "${name}" was contributed by a pack and REJECTED — nothing was scanned, and that is a failure:\n` +
          `  ${message}\n  \`shrk packs contributions\` names every rejected entry.\n`,
      );
    }
    return ExitCode.Failure;
  }
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

  const inventory: IRegistryInventory = scanRegistry(cwd, decl, { excludeDirs: loaded.excludeDirs });
  // A source file the reader could not read (over the read cap): only a
  // positive finding is verified; any other answer settles NOT VERIFIED (2).
  const incomplete = answerIncompleteInventory(inventory, decl, action, id, json);
  if (incomplete !== undefined) return incomplete;

  // An inventory that matched 0 ids is decided by THE rule-emptiness settle
  // (round 13). STALE (a dead or unmarked selector): no query over it can be
  // answered — 2, or 1 under failOnEmpty. INTENDED-empty (every source glob
  // marked `expectEmpty`, no source file matched): nothing is registered yet,
  // so every verb answers as over any inventory, and prints the acceptance.
  //
  // The registry's glob units are settled with their `expectEmpty` markers —
  // THE settle `gates check` reads (`registryLiveness`) — when a unit is marked
  // (its acceptance rides on every exit-0 answer, round 13 review) or the
  // inventory is empty (what the empty inventory is decided from).
  const marked = [decl.source, decl.consumer].some((s) => (s?.expectEmptyUnits?.length ?? 0) > 0);
  const liveness =
    marked || inventory.entries.length === 0 ? registryLiveness(cwd, decl, loaded.excludeDirs) : undefined;
  const emptiness =
    inventory.entries.length === 0 && liveness !== undefined
      ? settleInventoryEmptiness(decl, inventory, liveness)
      : undefined;
  const stale = emptiness !== undefined && emptiness.state !== RuleEmptiness.IntendedEmpty ? emptiness : undefined;
  const accepted = acceptedUnitLines(liveness);
  const acceptedField = accepted.length > 0 ? { accepted } : {};
  const writeAccepted = (): void => {
    for (const a of accepted) process.stdout.write(`  ${a}\n`);
  };

  if (action === 'list' || action === undefined) {
    // Fold pack-plane merge notes (missing/invalid pack registry files, dropped
    // collisions) into the inventory's own scan diagnostics.
    const diagnostics = [...inventory.diagnostics, ...loaded.planeDiagnostics];
    if (stale !== undefined) {
      return answerEmptyInventory(
        inventory,
        stale,
        json,
        { name: inventory.name, count: 0, ids: [], diagnostics },
        diagnostics,
      );
    }
    if (json) {
      process.stdout.write(
        asJson({
          name: inventory.name,
          count: inventory.entries.length,
          ids: inventory.entries.map((e) => e.id),
          diagnostics,
          ...acceptedField,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(`Registry "${inventory.name}"${inventory.description ? ' — ' + inventory.description : ''}\n`);
    process.stdout.write(`  ${inventory.entries.length} id(s)\n`);
    for (const e of inventory.entries) {
      process.stdout.write(`  • ${e.id}  (${e.sites.length} site${e.sites.length === 1 ? '' : 's'})\n`);
    }
    for (const d of diagnostics) process.stdout.write(`  ! ${d}\n`);
    // THE shared unit-state block (round 13, K2): a LOCAL expectEmpty marker
    // whose target appeared, or a dead source / consumer glob, is listed; a
    // pack marker is INFO. (`registry` settles the globs the way `gates check`
    // does — `registryLiveness`.)
    process.stdout.write(
      unitStateNotes([{ id: inventory.name, unitLiveness: (liveness ?? registryLiveness(cwd, decl, loaded.excludeDirs)).units }]).text,
    );
    writeAccepted();
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
    // Neither "taken" nor "free" can be read off an inventory that saw nothing
    // — unless it is intended-empty (round 13): then nothing is taken yet.
    if (stale !== undefined) {
      return answerEmptyInventory(inventory, stale, json, { name: inventory.name, id, exists: null });
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
    // The acceptance rides on a PASSING answer only (settleVerdict's rule).
    if (json) {
      process.stdout.write(
        asJson({
          name: inventory.name,
          id,
          ...(resolved ? { resolvedId: canonical, resolvedVia: resolution?.via } : {}),
          exists,
          exitCode: code,
          ...(code === 0 ? acceptedField : {}),
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
    if (code === 0) writeAccepted();
    return code;
  }

  if (action === 'duplicates') {
    // Two roots claiming the same id compile fine; whichever registration wins
    // at runtime is an accident of load order. Every site is printed so the
    // duplicate can be resolved, not merely detected.
    const dupes = registryDuplicates(inventory);
    const diagnostics = [...inventory.diagnostics, ...loaded.planeDiagnostics];
    if (stale !== undefined) {
      return answerEmptyInventory(
        inventory,
        stale,
        json,
        { name: inventory.name, scanned: 0, duplicates: [], diagnostics },
        diagnostics,
      );
    }
    if (json) {
      process.stdout.write(
        asJson({
          name: inventory.name,
          scanned: inventory.entries.length,
          duplicates: dupes,
          diagnostics,
          ...acceptedField,
        }) + '\n',
      );
      return dupes.length > 0 ? 1 : 0;
    }
    if (dupes.length === 0) {
      // THE shared unit-state block (round 13, K2): a LOCAL expectEmpty marker
      // whose target appeared (or a dead glob) is listed and withholds the ✓;
      // a pack marker is INFO.
      const unitNotes = unitStateNotes([
        { id: inventory.name, unitLiveness: (liveness ?? registryLiveness(cwd, decl, loaded.excludeDirs)).units },
      ]);
      process.stdout.write(unitNotes.text);
      process.stdout.write(
        `${qualifyCleanForUnits(`No duplicate ids in registry "${inventory.name}" (${inventory.entries.length} scanned). ✓`, unitNotes)}\n`,
      );
      writeAccepted();
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
    if (stale !== undefined) {
      return answerEmptyInventory(inventory, stale, json, { name: inventory.name, id, found: null, entry: null });
    }
    const entry = registryWhere(inventory, id);
    if (json) {
      process.stdout.write(
        asJson({
          name: inventory.name,
          id,
          found: entry !== undefined,
          entry: entry ?? null,
          ...(entry !== undefined ? acceptedField : {}),
        }) + '\n',
      );
      return entry ? 0 : 1;
    }
    if (!entry) {
      process.stdout.write(`"${id}" is not declared in registry "${inventory.name}".\n`);
      return 1;
    }
    process.stdout.write(`"${id}" in registry "${inventory.name}":\n`);
    for (const s of entry.sites) process.stdout.write(`  declared  ${s.file}:${s.line}\n`);
    for (const s of entry.consumerSites ?? []) process.stdout.write(`  consumed  ${s.file}:${s.line}\n`);
    writeAccepted();
    return 0;
  }

  process.stderr.write(
    `Unknown action "${action}". Usage: shrk registry ${name} list | exists <id> | where <id> | duplicates\n`,
  );
  return ExitCode.UsageError;
}

export const registryCommand: ICommandHandler = {
  name: 'registry',
  // Free: positional[0] is a declared registry NAME (`registry <name> list`).
  // The inventory verbs are also accepted verb-first (`registry list <name>`).
  positionals: PositionalMode.Free,
  subverbs: [
    {
      name: 'lifecycle',
      description: 'Registry lifecycle symmetry (register ↔ unregister) across the tree.',
      usage:
        'shrk registry lifecycle [--scope <glob>] [--changed-only | --since <ref>] [--limit N] [--offset N] [--budget-ms N] [--allow-empty] [--json]',
    },
    ...[...INVENTORY_VERBS].map((verb) => ({
      name: verb,
      description: `The verb-first spelling of \`registry <name> ${verb}\`.`,
      usage: `shrk registry ${verb} <name>${verb === 'exists' || verb === 'where' ? ' <id>' : ''} [--json]`,
      positionals: PositionalMode.Free,
    })),
  ],
  description: 'Registry inspections: lifecycle symmetry + declared-registry inventory. Read-only.',
  usage:
    'shrk registry lifecycle | <name> list | <name> exists <id> [--resolve] [--fail-if-taken|--fail-if-missing] | <name> where <id> | <name> duplicates',
  // Guard-mode + query flags take no value — declare them so `exists <id>
  // --fail-if-taken` (flag last) and `exists --resolve <id>` (flag first) both
  // keep the id as a positional instead of swallowing it.
  booleanFlags: new Set(['json', 'resolve', 'fail-if-taken', 'fail-if-missing', 'changed-only', ALLOW_EMPTY_FLAG]),
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
        const known =
          loaded.ok &&
          (findRegistry(loaded.registries, second) !== undefined || loaded.rejected.some((r) => r.id === second));
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
