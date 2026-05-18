/**
 * Inferred SharkCraft construct drafts.
 *
 * This file is written by `shrk constructs infer --write-drafts`.
 * Review carefully and copy the bits you want into `sharkcraft/constructs.ts`.
 * SharkCraft does NOT load this file automatically.
 * Generated: 2026-05-13T20:41:57.311Z
 */
import { defineConstruct } from '@shrkcrft/plugin-api';

export default [
  defineConstruct({
    id: 'service.apply-test',
    type: 'service',
    title: 'apply-test service',
    description: 'Inferred (high confidence). Replace with a real description.',
    files: [
      'src/services/apply-test.service.ts',
    ],
    relatedPathConventions: ['app.services'],
  }),
  defineConstruct({
    id: 'service.signed-demo',
    type: 'service',
    title: 'signed-demo service',
    description: 'Inferred (high confidence). Replace with a real description.',
    files: [
      'src/services/signed-demo.service.ts',
    ],
    relatedPathConventions: ['app.services'],
  }),
  defineConstruct({
    id: 'service.user',
    type: 'service',
    title: 'user service',
    description: 'Inferred (high confidence). Replace with a real description.',
    files: [
      'src/services/user.service.ts',
    ],
    publicApi: [
      'src/services/user.service.ts',
    ],
    relatedPathConventions: ['app.services'],
  }),
];
