/**
 * `@shrkcrft/compress` — SharkCraft's deterministic context-compression
 * engine. Built to honour the engine's hard rule: no model inside. Every
 * transform is a pure function of its input — content routing, lossless
 * columnar/table compaction of object arrays, log/search/diff/line reduction,
 * and reversible Compress-Cache-Retrieve (CCR). Used by the CLI, MCP server,
 * and inspector to cut the tokens an agent pays for the same information.
 */

// Tokens / accounting
export { estimateTokens, measureSavings } from './tokens/estimate-tokens.ts';
export type { ITokenSavings } from './tokens/token-savings.ts';

// Content routing
export { EContentType } from './content/content-type.ts';
export { detectContentType } from './content/detect-content-type.ts';
export type { IContentSegment } from './content/segment.ts';
export { segmentContent, isRichSegmentType } from './content/segment.ts';

// CCR (Compress-Cache-Retrieve)
export type { ICcrEntry } from './ccr/ccr-entry.ts';
export type { ICcrStore } from './ccr/ccr-store.ts';
export { ccrKey } from './ccr/ccr-key.ts';
export { CCR_MARKER_RE, formatCcrMarker, parseCcrMarkers } from './ccr/ccr-marker.ts';
export type { ICcrMarkerRef } from './ccr/ccr-marker.ts';
export { InMemoryCcrStore } from './ccr/in-memory-ccr-store.ts';
export { FileCcrStore } from './ccr/file-ccr-store.ts';
export type { ITtlFileCcrStoreOptions } from './ccr/ttl-file-ccr-store.ts';
export { TtlFileCcrStore } from './ccr/ttl-file-ccr-store.ts';

// Table / columnar compaction (lossless)
export type { IFieldSpec } from './table/field-spec.ts';
export type { ITableCompaction } from './table/table-compaction.ts';
export { compactObjectArray } from './table/compact-object-array.ts';
export type { IColumnarTable } from './table/columnar-table.ts';
export {
  tableToColumnar,
  compactArrayToColumnar,
  isColumnarTable,
  expandColumnar,
} from './table/columnar-json.ts';
export { renderTable } from './table/render-table.ts';
export { renderCompactJson } from './json/render-compact-json.ts';
export { compressJson } from './json/compress-json.ts';

// Read-accuracy table encodings (P4.2): reversible CSV / Markdown-KV views.
export {
  columnarToCsv,
  csvToObjects,
  columnarToMarkdownKv,
  markdownKvToObjects,
} from './table/table-formats.ts';

// Object-map columnar (lossless): hoist a homogeneous keyed object's schema.
export type { IObjectMap } from './table/object-map.ts';
export { compactObjectMap, expandObjectMap, isObjectMap } from './table/object-map.ts';

// Adaptive sample sizing (P3.1): pick K from the data's information curve.
export type { AdaptiveBias, IAdaptiveOptions } from './table/adaptive-size.ts';
export { computeOptimalK, simhash, hammingDistance, kneedle, bigramCoverageCurve } from './table/adaptive-size.ts';

// BM25 relevance (P3.2): idf-weighted query biasing for the lossy samplers.
export type { IBm25Options } from './relevance/bm25.ts';
export { bm25Scores, topByBm25 } from './relevance/bm25.ts';

// Lossy statistical row-sampling (SmartCrusher) for huge homogeneous arrays
export type { ISampleOptions } from './table/sample-options.ts';
export type { ISampledTable } from './table/sampled-table.ts';
export { isSampledTable } from './table/sampled-table.ts';
export { sampleObjectArray } from './table/sample-object-array.ts';

// Result shapes / options
export { ECompressionStrategy } from './result/compression-strategy.ts';
export type { ICompressionResult } from './result/compression-result.ts';
export type { ICompressOptions } from './result/compress-options.ts';

// Text compressors
export { compressLog } from './text/compress-log.ts';
export { compressSearch } from './text/compress-search.ts';
export { compressDiff } from './text/compress-diff.ts';
export { compressLines } from './text/compress-lines.ts';
export { compressMarkdown } from './text/compress-markdown.ts';

// Code-aware compression (outline: keep imports/types/signatures, elide bodies)
export { compressCode } from './code/compress-code.ts';

// Cache alignment — volatile-token detection + active reversible substitution
export { EVolatileKind } from './cache/volatile-kind.ts';
export type { IVolatileToken } from './cache/volatile-token.ts';
export { detectVolatileTokens } from './cache/detect-volatile-tokens.ts';
export { PLACEHOLDER_RE, formatPlaceholder } from './cache/placeholder.ts';
export type { IAlignmentBinding, IAlignmentMap } from './cache/alignment-map.ts';
export type { IAlignmentResult } from './cache/alignment-result.ts';
export { alignVolatileTokens } from './cache/align-volatile-tokens.ts';
export { restoreVolatileTokens } from './cache/restore-volatile-tokens.ts';

// Router
export { compressContent } from './compress-content.ts';
