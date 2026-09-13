/**
 * r78 — MCP `get_knowledge_stale_report` carries the knowledge entries the
 * LOADER refused (round 15 follow-up, F3 + F12), over THE census.
 *
 * The CLI stale-check, `quality` and `shrk doctor` read one list
 * (`knowledgeRejectedEntries`); the MCP report is the same report, so it must
 * name every refused knowledge-family entry — the census's Markdown one
 * included — and say how many on its text line, never summarise the survivors
 * as the whole corpus.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft, knowledgeRejectedEntries, type ISharkcraftInspection } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/all-tools.ts';

const TIMEOUT_MS = 180_000;
const FIXTURE = join(import.meta.dir, '..', '..', '..', 'inspector', 'src', '__tests__', 'fixtures', 'r76-census');
const KNOWLEDGE_KINDS = new Set(['knowledge', 'rule', 'path', 'path-convention', 'docs']);

interface ICensusFile {
  readonly file: string;
  readonly kind: string;
  readonly entryId: string | null;
}
const CENSUS = JSON.parse(readFileSync(join(FIXTURE, 'census.json'), 'utf8')) as {
  readonly slots: Readonly<Record<string, ICensusFile>>;
  readonly markdown?: { readonly files: readonly ICensusFile[] };
};
const EXPECTED = [...Object.values(CENSUS.slots), ...(CENSUS.markdown?.files ?? [])]
  .filter((c) => KNOWLEDGE_KINDS.has(c.kind))
  .map((c) => c.entryId!)
  .sort();

let root = '';
let inspection: ISharkcraftInspection;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r78-mcp-refused-'));
  cpSync(join(FIXTURE, 'consumer'), root, { recursive: true });
  cpSync(join(FIXTURE, 'pack'), join(root, 'node_modules', '@r76', 'census'), { recursive: true });
  inspection = await inspectSharkcraft({ cwd: root });
}, TIMEOUT_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('r78 MCP get_knowledge_stale_report — refused entries', () => {
  test(
    'data.rejectedEntries ≡ THE list (the Markdown entry included), and the text line counts them',
    async () => {
      const tool = ALL_TOOLS.find((t) => t.name === 'get_knowledge_stale_report');
      expect(tool).toBeDefined();
      const out = await tool!.handler({}, { inspection } as never);
      const data = out.data as { rejectedEntries: readonly { entryId?: string; source: string; pack?: string }[] };
      expect(EXPECTED).toContain('cz.kmd-bad');
      expect(data.rejectedEntries.map((r) => r.entryId).sort()).toEqual(EXPECTED);
      expect(data.rejectedEntries).toEqual(knowledgeRejectedEntries(inspection));
      expect(data.rejectedEntries.every((r) => r.pack === '@r76/census')).toBe(true);
      expect(out.text).toContain(`rejected at load: ${EXPECTED.length}`);
    },
    TIMEOUT_MS,
  );
});
