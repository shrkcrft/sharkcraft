export default [
  { id: 'cz.cv-ok', title: 'CV ok', kind: 'naming', severity: 'warning', rules: [] },
  // No `severity` — the round-12 report's own shape (a required field, dropped silently).
  { id: 'cz.cv-bad', title: 'CV bad', kind: 'naming', rules: [] },
];
