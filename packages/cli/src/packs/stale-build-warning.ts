/**
 * The CLI startup warning for a pack serving compiled contributions built from
 * an OLDER source — "shrk is serving the previous build". Read from the
 * inspection's `packAssetFreshness` (THE pack-asset freshness authority,
 * content digests, never mtimes); printed once per process, to stderr, only
 * for a real divergence (`build.state === 'stale'`). An unrecorded build is a
 * doctor / `packs doctor` / `packs dev-status` finding, not a startup banner.
 */
import { describePackAssetFreshness, type ISharkcraftInspection } from '@shrkcrft/inspector';

let warned = false;

export function warnStaleCompiledPacks(
  inspection: Pick<ISharkcraftInspection, 'packAssetFreshness'>,
  write: (s: string) => void = (s) => void process.stderr.write(s),
): void {
  if (warned) return;
  const lines = (inspection.packAssetFreshness ?? [])
    .filter((f) => f.build.state === 'stale')
    .map((f) => describePackAssetFreshness(f).build)
    .filter((l): l is string => Boolean(l));
  if (lines.length === 0) return;
  warned = true;
  for (const l of lines) write(`⚠ ${l}\n`);
}
