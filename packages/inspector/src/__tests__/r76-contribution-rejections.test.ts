/**
 * r76 — THE rejection channel, in-process: no contributed-asset loader drops
 * an entry silently (round 12, 12.1 / 12.1c / 12.1d / 12.1e).
 *
 * One REAL pack (copied under node_modules of a temp consumer) contributes a
 * valid entry and ONE invalid entry (always the last) to EVERY loader-backed
 * manifest slot — fixtures/r76-census, with `census.json` naming each slot's
 * expected kind, finding code, id, field and count. Asserted through the real
 * loaders (inspectSharkcraft + THE registry-outcome run):
 *
 *   - the census covers every CONTRIBUTION_FILE_KEYS slot (a slot may not
 *     silently leave the channel), and every slot has a contribution kind;
 *   - each slot's invalid entry is exactly ONE rejection, with its position,
 *     id, cause and the failing field — a module's helper values never are;
 *   - conservation: accepted + rejected === declared, per file;
 *   - a rejected id never resolves; the accepted one does (list ≡ resolve);
 *   - build time ≡ runtime: `validateContributionFile` refuses the same entry;
 *   - the inventory never certifies a rejected id (`ok`), and counts them;
 *   - accepted means usable: the self-config doctor resolves over it (a
 *     step-less playbook crashed it) and reports each rejection once, ERROR.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RejectionCause } from '@shrkcrft/core';
import { CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { collectContributionRejections, collectRegistryOutcomes } from '../contribution-load-failures.ts';
import type { IContributionEntryRejection } from '../i-contribution-entry-rejection.ts';
import type { IRegistryOutcomes } from '../i-registry-outcomes.ts';
import { buildPackContributionsInventoryAsync, contributionKindForSlot } from '../pack-contributions-inventory.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { referenceIdsFor, warmReferenceRegistries, type ReferenceKind } from '../reference-registry.ts';
import { validateContributionFile } from '../validate-contribution-file.ts';

const TIMEOUT_MS = 180_000;
const FIXTURE = join(import.meta.dir, 'fixtures', 'r76-census');

interface ICensusSlot {
  readonly file: string;
  readonly kind: string;
  readonly code: string;
  readonly entryId: string | null;
  readonly field: string;
  readonly declared: number;
  readonly list: readonly string[] | null;
}

const CENSUS = JSON.parse(readFileSync(join(FIXTURE, 'census.json'), 'utf8')) as {
  readonly pack: string;
  readonly slots: Readonly<Record<string, ICensusSlot>>;
};
const SLOTS = Object.entries(CENSUS.slots);

/** Each slot's accepted id (the first entry) and the reference kind it resolves in, where one exists. */
const RESOLVES: Readonly<Record<string, { readonly kind: ReferenceKind; readonly ok: string }>> = {
  knowledgeFiles: { kind: 'knowledge', ok: 'cz.k-ok' },
  ruleFiles: { kind: 'rule', ok: 'cz.r-ok' },
  pathFiles: { kind: 'path-convention', ok: 'cz.p-ok' },
  pathConventionFiles: { kind: 'path-convention', ok: 'cz.pc-ok' },
  templateFiles: { kind: 'template', ok: 'cz.t-ok' },
  pipelineFiles: { kind: 'pipeline', ok: 'cz.pl-ok' },
  boundaryFiles: { kind: 'boundary-rule', ok: 'cz-bd-ok' },
  scaffoldPatternFiles: { kind: 'scaffold-pattern', ok: 'cz.sp-ok' },
  constructFiles: { kind: 'construct', ok: 'cz.cn-ok' },
  playbookFiles: { kind: 'playbook', ok: 'cz.pb-ok' },
  contractTemplateFiles: { kind: 'contract-template', ok: 'cz.ctt-ok' },
  migrationProfileFiles: { kind: 'migration-profile', ok: 'cz.mp-ok' },
  conventionFiles: { kind: 'convention', ok: 'cz.cv-ok' },
  helperFiles: { kind: 'helper', ok: 'cz.h-ok' },
  taskRoutingHintFiles: { kind: 'routing-hint', ok: 'cz.rh-ok' },
  registrationHintFiles: { kind: 'registration-hint', ok: 'cz.reg-ok' },
};

let root = '';
let inspection: ISharkcraftInspection;
let outcomes: IRegistryOutcomes;
let rejections: readonly IContributionEntryRejection[];

const inFile = (file: string, name: string): boolean => file.replaceAll('\\', '/').endsWith(`/@r76/census/${name}`);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r76-census-'));
  cpSync(join(FIXTURE, 'consumer'), root, { recursive: true });
  cpSync(join(FIXTURE, 'pack'), join(root, 'node_modules', '@r76', 'census'), { recursive: true });
  inspection = await inspectSharkcraft({ cwd: root });
  outcomes = await collectRegistryOutcomes(inspection);
  rejections = collectContributionRejections(inspection, outcomes.rejections);
}, TIMEOUT_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('r76 THE rejection channel over every loader-backed slot', () => {
  test('the census covers EVERY contribution slot, and each slot has a kind — none may leave the channel', () => {
    expect(inspection.packs.validPacks.map((p) => p.packageName)).toEqual([CENSUS.pack]);
    expect(SLOTS.map(([slot]) => slot).sort()).toEqual([...CONTRIBUTION_FILE_KEYS].sort());
    expect(SLOTS.filter(([slot]) => contributionKindForSlot(slot) === undefined).map(([slot]) => slot)).toEqual([]);
  });

  test("each slot's invalid entry is exactly ONE rejection — position, id, cause and the failing field", () => {
    for (const [slot, c] of SLOTS) {
      const hits = rejections.filter((r) => inFile(r.file, c.file));
      const r = hits[0];
      expect({
        slot,
        count: hits.length,
        kind: r?.kind as string | undefined,
        index: r?.index,
        entryId: r?.entryId ?? null,
        cause: r?.cause,
        packageName: r?.packageName,
        field: r?.reasons.some((x) => x.startsWith(`${c.field}:`)),
      }).toEqual({
        slot,
        count: 1,
        kind: c.kind,
        index: c.declared - 1,
        entryId: c.entryId,
        cause: RejectionCause.Invalid,
        packageName: CENSUS.pack,
        field: true,
      });
    }
    // Exactly the census — `export const HELPER_NAMES = ['x']` in a knowledge
    // module is a helper value, never a rejected entry.
    expect(rejections.length).toBe(SLOTS.length);
  });

  test('conservation: accepted + rejected === declared, for every contributed file', () => {
    for (const [slot, c] of SLOTS) {
      const accepted =
        outcomes.accepted.filter((a) => inFile(a.file, c.file)).length +
        inspection.loaderDiagnostics
          .filter((d) => d.status === 'ok' && inFile(d.filePath, c.file))
          .reduce((n, d) => n + d.count, 0);
      const rejected = rejections.filter((r) => inFile(r.file, c.file)).length;
      expect({ slot, declared: accepted + rejected }).toEqual({ slot, declared: c.declared });
    }
  });

  test('a rejected id never resolves; the accepted one does (list ≡ resolve)', async () => {
    await warmReferenceRegistries(inspection);
    for (const [slot, r] of Object.entries(RESOLVES)) {
      const ids = referenceIdsFor(inspection, r.kind);
      const bad = CENSUS.slots[slot]!.entryId!;
      expect({ slot, ok: ids.includes(r.ok), bad: ids.includes(bad) }).toEqual({ slot, ok: true, bad: false });
    }
  });

  test('build time ≡ runtime: validateContributionFile refuses exactly the entry the loader refuses', async () => {
    const packRoot = join(root, 'node_modules', '@r76', 'census');
    for (const [slot, c] of SLOTS) {
      const v = await validateContributionFile(slot, join(packRoot, c.file));
      expect({
        slot,
        loaded: v.loaded,
        accepted: v.accepted,
        rejected: v.rejected.map((r) => [r.index, r.entryId ?? null]),
        field: v.rejected.some((r) => r.reasons.some((x) => x.startsWith(`${c.field}:`))),
      }).toEqual({ slot, loaded: true, accepted: c.declared - 1, rejected: [[c.declared - 1, c.entryId]], field: true });
    }
  });

  test('the inventory never certifies a rejected id, carries every rejection, and lists every loader-backed kind structurally', async () => {
    const inv = await buildPackContributionsInventoryAsync(inspection);
    expect(inv.rejections.length).toBe(SLOTS.length);
    expect(inv.extractionTotals.rejected).toBe(SLOTS.length);
    for (const [, c] of SLOTS) {
      if (c.entryId === null) continue;
      const certified = inv.entries.filter(
        (e) => e.id === c.entryId && e.validation === 'ok' && (e.sourceFile ?? '').endsWith(c.file),
      );
      expect({ id: c.entryId, certified: certified.length }).toEqual({ id: c.entryId, certified: 0 });
    }
    const structural = (kind: string, id: string): boolean =>
      inv.entries.some((e) => e.kind === kind && e.id === id && e.extractionMode === 'structural');
    // Kinds the inventory could only scrape (or not list at all) before round 12.
    expect(structural('registration-hint', 'cz.reg-ok')).toBe(true);
    expect(structural('preset', 'cz-ps-ok')).toBe(true);
    expect(structural('boundary', 'cz-bd-ok')).toBe(true);
    expect(structural('scaffold-pattern', 'cz.sp-ok')).toBe(true);
    expect(structural('construct', 'cz.cn-ok')).toBe(true);
    expect(structural('construct-facet', 'cz.cf-ok')).toBe(true);
    expect(structural('search-tuning', 'cz.st-ok')).toBe(true);
    expect(structural('decision', 'cz.dec-ok')).toBe(true);
    expect(structural('policy', 'cz.pol-ok')).toBe(true);
    expect(structural('feedback-rule', 'cz.fr-ok')).toBe(true);
    expect(structural('delegate-recipe', 'cz.dr-ok')).toBe(true);
    expect(structural('framework-extractor', 'cz-fx')).toBe(true);
    // No regex id of a loader-backed kind is ever `ok`.
    expect(inv.entries.filter((e) => e.extractionMode === 'regex-fallback' && e.validation === 'ok')).toEqual([]);
  });

  test('accepted means usable: the self-config doctor resolves and reports every rejection once, as an ERROR', async () => {
    const report = await buildSelfConfigDoctorReportV2(inspection);
    expect(report.verdict).toBe('errors');
    for (const [slot, c] of SLOTS) {
      const hits = report.findings.filter((f) => f.code === c.code && (f.file ?? '').endsWith(`/${c.file}`));
      expect({ slot, found: hits.length > 0, errors: hits.every((f) => f.severity === 'error') }).toEqual({
        slot,
        found: true,
        errors: true,
      });
    }
    // One reporter: the routing-hint family no longer emits its own copy.
    expect(report.findings.filter((f) => f.code === 'routing-hint-invalid' && f.sourceId === 'cz.rh-bad')).toHaveLength(1);
    // No finding borrows `unknown:` for a rejected entry.
    expect(report.findings.filter((f) => f.code.endsWith('-invalid') && f.sourceKind === 'unknown')).toEqual([]);
  });
});
