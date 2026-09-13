/**
 * r76 — the round-12 MCP pack outputs, over THE census (round 12 review, T1).
 *
 * `get_pack_contributions` gained `report: { files[], totals, … }` and
 * `rejections[]`; `list_packs` / `get_pack` gained per-kind `entryCounts`. No
 * MCP test asserted any of them, so a regression dropping them from the
 * agent-facing surface would have passed. One REAL pack (fixtures/r76-census,
 * copied under node_modules) contributes one invalid entry to every
 * loader-backed slot; the real registered handlers run over a real inspection.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/all-tools.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const FIXTURE = join(REPO_ROOT, 'packages/inspector/src/__tests__/fixtures/r76-census');
const PACK_DIR = 'node_modules/@r76/census';
const TIMEOUT_MS = 300_000;

interface ICensusSlot {
  readonly file: string;
  readonly kind: string;
  readonly entryId: string | null;
  readonly declared: number;
  /** The rejected entry's position when it is not `declared - 1` (a Markdown file: -1). */
  readonly index?: number;
}
const CENSUS = JSON.parse(readFileSync(join(FIXTURE, 'census.json'), 'utf8')) as {
  readonly pack: string;
  readonly slots: Readonly<Record<string, ICensusSlot>>;
  /** Round 15 follow-up (F12): Markdown knowledge files, each under an existing slot. */
  readonly markdown?: { readonly files: readonly (ICensusSlot & { readonly slot: string })[] };
};
const SLOTS = Object.entries(CENSUS.slots);
/** Every census FILE — one per slot, plus the Markdown knowledge files (round 15 follow-up, F12). */
const FILES: readonly (readonly [string, ICensusSlot])[] = [
  ...SLOTS,
  ...(CENSUS.markdown?.files ?? []).map((f) => [f.slot, f] as const),
];
/** Where the loader records the invalid entry: its array index, or -1 for a one-entry Markdown file. */
const rejectedIndex = (c: ICensusSlot): number => c.index ?? c.declared - 1;

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
};

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r76-mcp-census-'));
  cpSync(join(FIXTURE, 'consumer'), root, { recursive: true });
  cpSync(join(FIXTURE, 'pack'), join(root, PACK_DIR), { recursive: true });
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type EntryCounts = Record<string, { files: number; accepted: number; rejected: number }>;

describe('r76 MCP pack outputs over the census', () => {
  test(
    'get_pack_contributions: `report.files` has one row per census slot with its declared / accepted / rejected, and `rejections` names every one',
    async () => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const data = (await tool('get_pack_contributions').handler({}, { inspection, cwd: root })).data as {
        rejections: { file: string; entryId?: string }[];
        report: {
          files: { file: string; declared: number; accepted: number; rejected: { entryId?: string; index: number }[] }[];
          totals: { rejected: number };
        };
      };
      for (const [slot, c] of FILES) {
        const row = data.report.files.find((f) => f.file === `${PACK_DIR}/${c.file}`);
        expect({
          slot,
          declared: row?.declared,
          accepted: row?.accepted,
          rejected: row?.rejected.map((r) => [r.entryId ?? null, r.index]),
        }).toEqual({ slot, declared: c.declared, accepted: c.declared - 1, rejected: [[c.entryId, rejectedIndex(c)]] });
      }
      expect(data.rejections).toHaveLength(FILES.length);
      expect(data.report.totals.rejected).toBe(FILES.length);
    },
    TIMEOUT_MS,
  );

  test(
    'list_packs and get_pack: `entryCounts[kind].rejected ≥ 1` for every census kind; get_pack lists the rejections',
    async () => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const ctx = { inspection, cwd: root };
      const rows = (await tool('list_packs').handler({}, ctx)).data as { packageName: string; entryCounts: EntryCounts }[];
      const listed = rows.find((p) => p.packageName === CENSUS.pack)!.entryCounts;
      const got = (await tool('get_pack').handler({ packageName: CENSUS.pack }, ctx)).data as {
        entryCounts: EntryCounts;
        rejections: unknown[];
      };
      for (const [slot, c] of FILES) {
        expect({ slot, list: (listed[c.kind]?.rejected ?? 0) >= 1, get: (got.entryCounts[c.kind]?.rejected ?? 0) >= 1 }).toEqual({
          slot,
          list: true,
          get: true,
        });
      }
      expect(got.rejections.length).toBe(FILES.length);
    },
    TIMEOUT_MS,
  );
});
