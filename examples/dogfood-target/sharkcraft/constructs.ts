import { defineConstruct } from '@shrkcrft/plugin-api';

export default [
  defineConstruct({
    id: 'user-service',
    type: 'service',
    title: 'User service',
    description: 'HTTP handler + persistence for users.',
    tags: ['http', 'service'],
    files: ['src/services/user.service.ts'],
    publicApi: ['src/services/user.service.ts'],
    relatedKnowledge: ['app.services', 'http.routes.thin'],
    relatedTemplates: ['typescript.service'],
    relatedPathConventions: ['app.services'],
  }),
  defineConstruct({
    id: 'http-server',
    type: 'module',
    title: 'HTTP server',
    description: 'Bun-based HTTP entrypoint.',
    files: ['src/server.ts'],
    publicApi: ['src/server.ts'],
    events: ['server.start', 'server.stop'],
    relatedKnowledge: ['app.observability', 'http.routes.thin'],
  }),
];
