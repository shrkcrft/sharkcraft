export default [
  {
    id: 'cz.reg-ok',
    title: 'REG ok',
    discovery: { targetFile: 'src/a.ts' },
    operations: [{ kind: 'append', snippet: 'export const b = 2;' }],
  },
  { id: 'cz.reg-bad', title: 'REG bad', discovery: { targetFile: 'src/a.ts' } },
];
