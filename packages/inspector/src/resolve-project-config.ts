/**
 * Pack-aware project-config resolution.
 *
 * The four "cross-file invariant as DATA" planes — `wiringRules`, `registries`,
 * `policyRules`, `reusePrimitives` — can be authored inline in a repo's
 * `sharkcraft.config.ts`. They can ALSO be SHIPPED by a framework pack (e.g. a
 * NestJS pack contributing "every @Injectable must be registered in a module"
 * as a wiring rule) via the new `wiringRuleFiles` / `registryFiles` /
 * `policyRuleFiles` / `reusePrimitiveFiles` manifest slots.
 *
 * The merge CANNOT live in `loadProjectConfig`: config sits at layer 3 and packs
 * at layer 6, so config cannot import the pack discovery. The inspector (layer
 * 10, above packs) is the lowest layer that can see both, so the merge seam
 * lives here.
 *
 * Precedence is LOCAL-WINS: a repo's own declaration always beats a pack's, and
 * a pack element whose key collides with a local (or an earlier pack) one is
 * dropped with a diagnostic. Pack elements are validated with the SAME exported
 * zod schemas the config loader uses, so a malformed pack element is skipped
 * (with a diagnostic) rather than crashing config resolution.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  importModuleViaLoader,
  ok,
  type AppError,
  type IPolicyRule,
  type IRegistryDeclaration,
  type IReusePrimitive,
  type IWiringRule,
  type Result,
} from '@shrkcrft/core';
import {
  loadProjectConfig,
  PolicyRuleSchema,
  RegistryDeclarationSchema,
  ReusePrimitiveSchema,
  WiringRuleSchema,
  type LoadedConfig,
} from '@shrkcrft/config';
import { discoverPacks, type IDiscoveredPack } from '@shrkcrft/packs';

/**
 * A {@link LoadedConfig} whose four data planes have had pack contributions
 * merged in (local-wins), plus the human-readable notes from that merge.
 */
export interface IResolvedProjectConfig extends LoadedConfig {
  /**
   * Notes from the pack-plane merge — missing/invalid pack files, dropped
   * collisions, pack-discovery failures. Empty when there are no packs (or no
   * pack contributions to the four planes). Surfaced by the readers that
   * consume the merged planes (`shrk check wiring`, `registry`, `policy-lint`,
   * `reuse`, `gate`).
   */
  readonly planeDiagnostics: readonly string[];
}

/** Minimal structural view of a zod schema's `safeParse` — avoids a zod dep here. */
interface IPlaneSchema {
  safeParse(value: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> };
  };
}

/** One pack's contribution file for a single plane. */
interface IPackContribFile {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly rel: string;
}

/**
 * Generic per-plane load + validate + merge. Seeds the merged map from the
 * LOCAL array (keyed by `keyOf`), then folds in pack elements only when their
 * key is free. Missing files, non-array default exports, schema-invalid
 * elements, and key collisions all become diagnostics and are skipped — never a
 * throw.
 */
async function mergePlane<T>(
  localArr: readonly T[],
  packContribs: readonly IPackContribFile[],
  schema: IPlaneSchema,
  keyOf: (item: T) => string,
  planeLabel: string,
  diagnostics: string[],
): Promise<readonly T[]> {
  const merged = new Map<string, T>();
  const localKeys = new Set<string>();
  for (const item of localArr) {
    const key = keyOf(item);
    merged.set(key, item);
    localKeys.add(key);
  }

  for (const contrib of packContribs) {
    const full = nodePath.resolve(contrib.packageRoot, contrib.rel);
    if (!existsSync(full)) {
      diagnostics.push(`pack ${contrib.packageName}: missing ${planeLabel} file ${contrib.rel}`);
      continue;
    }
    let mod: { default?: unknown };
    try {
      mod = await importModuleViaLoader<{ default?: unknown }>(full);
    } catch (e) {
      diagnostics.push(
        `pack ${contrib.packageName}: failed to load ${planeLabel} file ${contrib.rel} — ${(e as Error).message}`,
      );
      continue;
    }
    const arr = mod.default;
    if (!Array.isArray(arr)) {
      diagnostics.push(
        `pack ${contrib.packageName}: ${planeLabel} file ${contrib.rel} default export is not an array — skipped`,
      );
      continue;
    }
    for (const raw of arr) {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const summary =
          (parsed.error?.issues ?? [])
            .map((iss) => `${iss.path.join('.') || '<root>'}: ${iss.message}`)
            .join('; ') || 'invalid element';
        diagnostics.push(
          `pack ${contrib.packageName}: invalid ${planeLabel} element in ${contrib.rel} — ${summary} — skipped`,
        );
        continue;
      }
      const item = parsed.data as T;
      const key = keyOf(item);
      if (merged.has(key)) {
        diagnostics.push(
          localKeys.has(key)
            ? `pack ${contrib.packageName}: ${planeLabel} "${key}" already provided by local config — skipped`
            : `pack ${contrib.packageName}: ${planeLabel} "${key}" already provided — skipped`,
        );
        continue;
      }
      merged.set(key, item);
    }
  }
  return [...merged.values()];
}

/** Collect every pack contribution file for one manifest slot across valid packs. */
function gatherPackContribs(
  validPacks: readonly IDiscoveredPack[],
  slot: 'wiringRuleFiles' | 'registryFiles' | 'policyRuleFiles' | 'reusePrimitiveFiles',
): IPackContribFile[] {
  const out: IPackContribFile[] = [];
  for (const pack of validPacks) {
    // Mirror sharkcraft-inspector's pack-merge: read the slot off the
    // contributions bag with a narrow cast (the new slots are all string[]).
    const contributions = pack.manifest?.contributions as
      | Record<string, readonly string[] | undefined>
      | undefined;
    const files = contributions?.[slot];
    for (const rel of files ?? []) {
      out.push({ packageName: pack.packageName, packageRoot: pack.packageRoot, rel });
    }
  }
  return out;
}

/**
 * Load the project config, then merge pack-contributed `wiringRules` /
 * `registries` / `policyRules` / `reusePrimitives` over the local config
 * (local-wins). Returns the loader error untouched on failure, so callers keep
 * the same "invalid config vs. valid-with-no-rules" distinction they had with
 * {@link loadProjectConfig}. A pack-discovery failure degrades to a diagnostic
 * — it never fails config resolution.
 */
export async function resolveProjectConfig(
  cwd: string,
): Promise<Result<IResolvedProjectConfig, AppError>> {
  const loaded = await loadProjectConfig(cwd);
  if (!loaded.ok) return loaded;

  const diagnostics: string[] = [];
  const base = loaded.value;

  let validPacks: readonly IDiscoveredPack[] = [];
  try {
    const packs = await discoverPacks({ projectRoot: base.projectRoot });
    validPacks = packs.validPacks;
  } catch (e) {
    diagnostics.push(`pack discovery failed — pack-contributed planes skipped: ${(e as Error).message}`);
  }

  const wiringRules = await mergePlane<IWiringRule>(
    base.config.wiringRules ?? [],
    gatherPackContribs(validPacks, 'wiringRuleFiles'),
    WiringRuleSchema as IPlaneSchema,
    (r) => r.id,
    'wiringRule',
    diagnostics,
  );
  const registries = await mergePlane<IRegistryDeclaration>(
    base.config.registries ?? [],
    gatherPackContribs(validPacks, 'registryFiles'),
    RegistryDeclarationSchema as IPlaneSchema,
    (r) => r.name,
    'registry',
    diagnostics,
  );
  const policyRules = await mergePlane<IPolicyRule>(
    base.config.policyRules ?? [],
    gatherPackContribs(validPacks, 'policyRuleFiles'),
    PolicyRuleSchema as IPlaneSchema,
    (r) => r.id,
    'policyRule',
    diagnostics,
  );
  const reusePrimitives = await mergePlane<IReusePrimitive>(
    base.config.reusePrimitives ?? [],
    gatherPackContribs(validPacks, 'reusePrimitiveFiles'),
    ReusePrimitiveSchema as IPlaneSchema,
    (r) => r.symbol,
    'reusePrimitive',
    diagnostics,
  );

  return ok({
    ...base,
    config: { ...base.config, wiringRules, registries, policyRules, reusePrimitives },
    planeDiagnostics: diagnostics,
  });
}
