var VAR_RE = new RegExp([
    '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?', // ISO timestamp
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', // UUID
    '0x[0-9a-fA-F]+', // hex literal
    '\b[0-9a-fA-F]{12,}\b', // long hash
    '"(?:[^"\\]|\\.)*"', // double-quoted string
    "'(?:[^'\\]|\\.)*'", // single-quoted string
    '\d+(?:\.\d+)?', // integer / decimal
].join('|'), 'g');
var testCases = [
    // Current working cases
    '"simple string"',
    "'single quoted'",
    '"string with \\"escaped\\" quotes"',
    '0x123abc',
    '123',
    '1.23',
    // Python/shell triple quotes (proposed issue)
    '"""triple quoted string"""',
    "'''single triple quotes'''",
    '"""with \\"nested\\" quotes"""',
    // Real cases
    'error: {"msg":"failed"}',
];
console.log('VAR_RE test results:\n');
testCases.forEach(function (tc) {
    var matches = tc.match(VAR_RE) || [];
    console.log("Input: ".concat(tc));
    console.log("Matches: [".concat(matches.join(', '), "]"));
    console.log("Count: ".concat(matches.length, "\n"));
});
// Test the critical case: column ordering
var line1 = 'info """multi-line""" 123 ended';
var matches1 = line1.match(VAR_RE) || [];
console.log("\nCRITICAL: line=\"".concat(line1, "\""));
console.log("matches=[".concat(matches1.join(', '), "] (count=").concat(matches1.length, ")"));
