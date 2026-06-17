/**
 * Serialize a tool's structured `data` into the text the MCP wire carries.
 *
 * The default is **minified** JSON: still valid JSON (identical shape, so
 * JSON-parsing clients are unaffected), but without the pretty-print
 * indentation that every `JSON.stringify(data, null, 2)` paid for. Across
 * ~200 tools that indentation is pure token overhead an agent reads and pays
 * for. Set `SHRK_MCP_PRETTY=1` to restore indented output for debugging.
 *
 * This transform is lossless and structure-preserving by design. Lossy /
 * shape-changing compaction (columnar tables, CCR offload) is opt-in per
 * tool, never applied blindly here.
 */
export function serializeToolData(data: unknown): string {
  if (wantsPretty()) return JSON.stringify(data, null, 2) ?? 'null';
  return JSON.stringify(data) ?? 'null';
}

function wantsPretty(): boolean {
  const v = process.env.SHRK_MCP_PRETTY;
  return v === '1' || v === 'true' || v === 'yes';
}
