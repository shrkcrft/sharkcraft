import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-gql-scopes-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
  );
  return root;
}

describe('graphql extractor', () => {
  test('detects types, interfaces, enums, inputs, unions, scalars, directives', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'schema.graphql' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'schema.graphql'),
        [
          '# Demo schema',
          'scalar DateTime',
          'directive @auth on FIELD_DEFINITION',
          '',
          'type User {',
          '  id: ID!',
          '  name: String!',
          '}',
          '',
          'interface Node {',
          '  id: ID!',
          '}',
          '',
          'enum Role { ADMIN USER GUEST }',
          '',
          'input UserInput {',
          '  name: String!',
          '}',
          '',
          'union SearchResult = User | Post',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['graphql'] });
      expect(r.manifest.countsBySubtype['graphql:type']).toBe(1);
      expect(r.manifest.countsBySubtype['graphql:interface']).toBe(1);
      expect(r.manifest.countsBySubtype['graphql:enum']).toBe(1);
      expect(r.manifest.countsBySubtype['graphql:input']).toBe(1);
      expect(r.manifest.countsBySubtype['graphql:union']).toBe(1);
      expect(r.manifest.countsBySubtype['graphql:scalar']).toBe(1);
      expect(r.manifest.countsBySubtype['graphql:directive']).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('extracts Query/Mutation/Subscription fields as operations', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'schema.graphql' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'schema.graphql'),
        [
          'type Query {',
          '  user(id: ID!): User',
          '  users: [User!]!',
          '}',
          'type Mutation {',
          '  createUser(input: UserInput!): User',
          '}',
          'type Subscription {',
          '  userCreated: User',
          '}',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['graphql'] });
      // 3 root types + 4 operation fields.
      expect(r.manifest.countsBySubtype['graphql:type']).toBe(3);
      expect(r.manifest.countsBySubtype['graphql:operation']).toBe(4);
      const api = FrameworkQueryApi.fromStore(root);
      const ops = api.list({ framework: 'graphql', subtype: 'operation' });
      const labels = ops.map((o) => o.label).sort();
      expect(labels).toEqual([
        'mutation createUser',
        'query user',
        'query users',
        'subscription userCreated',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('phoenix scope nesting', () => {
  test('combines scope prefixes into route paths', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'web'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web', main: 'router.ex' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'web', 'router.ex'),
        [
          'defmodule MyAppWeb.Router do',
          '  use Phoenix.Router',
          '',
          '  scope "/api", MyAppWeb do',
          '    get "/health", HealthController, :show',
          '    scope "/v1" do',
          '      get "/users", UserController, :index',
          '      post "/users", UserController, :create',
          '    end',
          '  end',
          '',
          '  get "/", PageController, :home',
          'end',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['phoenix'] });
      const api = FrameworkQueryApi.fromStore(root);
      const labels = api.list({ framework: 'phoenix', subtype: 'route' })
        .map((r) => r.label)
        .sort();
      // Note: Phoenix resolves the scope's module argument at compile
      // time, prefixing controllers with `MyAppWeb`. The regex extractor
      // captures the raw `Controller` name; the path prefix from
      // `scope "/api"` IS combined in.
      // The outer scope `scope "/api", MyAppWeb do` qualifies inner
      // controllers (HealthController). The inner `scope "/v1" do` has
      // no module arg, so UserController stays bare.
      expect(labels).toEqual([
        'GET / → PageController.home',
        'GET /api/health → MyAppWeb.HealthController.show',
        'GET /api/v1/users → UserController.index',
        'POST /api/v1/users → UserController.create',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rails namespace nesting', () => {
  test('combines namespace prefixes into route paths', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api', 'config'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'config/routes.rb' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'config', 'routes.rb'),
        [
          'Rails.application.routes.draw do',
          '  namespace :api do',
          '    namespace :v1 do',
          '      resources :users',
          "      get '/health', to: 'health#check'",
          '    end',
          '  end',
          '  resources :pages',
          'end',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['rails'] });
      const api = FrameworkQueryApi.fromStore(root);
      const labels = api.list({ framework: 'rails', subtype: 'route' })
        .map((r) => r.label)
        .sort();
      expect(labels).toContain('RESOURCES /api/v1/users → index');
      expect(labels).toContain('GET /api/v1/health → health#check');
      expect(labels).toContain('RESOURCES /pages → index');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
