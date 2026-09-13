export default [
  {
    id: 'cz.sp-ok',
    title: 'SP ok',
    description: 'Census scaffold pattern.',
    templateId: 'cz.t-ok',
    matchPaths: ['src/**/*.ts'],
    variables: [],
    appliesWhen: ['infer-template'],
    confidence: 'high',
  },
  { id: 'cz.sp-bad', title: 'SP bad', templateId: 'cz.t-ok', matchPaths: ['src/**/*.ts'] },
];
