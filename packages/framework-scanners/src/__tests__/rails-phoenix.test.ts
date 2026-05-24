import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-rails-phx-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
  );
  return root;
}

describe('rails extractor', () => {
  test('controller + actions + model + routes.rb', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'api', 'app', 'controllers'), { recursive: true });
      mkdirSync(join(root, 'services', 'api', 'app', 'models'), { recursive: true });
      mkdirSync(join(root, 'services', 'api', 'config'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'app.rb' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'app', 'controllers', 'users_controller.rb'),
        [
          'class UsersController < ApplicationController',
          '  def index',
          '  end',
          '',
          '  def show',
          '  end',
          '',
          '  def create',
          '  end',
          '',
          '  private',
          '',
          '  def _internal',
          '  end',
          'end',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'api', 'app', 'models', 'user.rb'),
        'class User < ApplicationRecord\nend',
      );
      writeFileSync(
        join(root, 'services', 'api', 'config', 'routes.rb'),
        [
          'Rails.application.routes.draw do',
          '  resources :users',
          '  resource :session',
          "  get '/health', to: 'health#check'",
          "  post '/auth/login' => 'auth#login'",
          'end',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['rails'] });
      expect(r.manifest.countsBySubtype['rails:controller']).toBe(1);
      expect(r.manifest.countsBySubtype['rails:model']).toBe(1);
      expect(r.manifest.countsBySubtype['rails:action']).toBe(3);
      expect(r.manifest.countsBySubtype['rails:route']).toBe(4);
      const api = FrameworkQueryApi.fromStore(root);
      const handles = api.edges().filter((e) => e.kind === EdgeKind.HandlesRoute);
      // Controller → 3 actions = 3 handles-route edges.
      expect(handles.length).toBe(3);
      const labels = api.list({ framework: 'rails', subtype: 'route' }).map((e) => e.label).sort();
      expect(labels).toContain('RESOURCES /users → index');
      expect(labels).toContain('RESOURCE /session → show');
      expect(labels).toContain('GET /health → health#check');
      expect(labels).toContain('POST /auth/login → auth#login');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('phoenix extractor', () => {
  test('controller + actions + router + schema', () => {
    const root = setup();
    try {
      mkdirSync(join(root, 'services', 'web'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web', main: 'lib/web.ex' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'web', 'user_controller.ex'),
        [
          'defmodule MyAppWeb.UserController do',
          '  use MyAppWeb, :controller',
          '',
          '  def index(conn, _params) do',
          '    json(conn, %{})',
          '  end',
          '',
          '  def show(conn, %{"id" => id}) do',
          '    json(conn, %{id: id})',
          '  end',
          'end',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'web', 'router.ex'),
        [
          'defmodule MyAppWeb.Router do',
          '  use Phoenix.Router',
          '',
          '  get "/users", MyAppWeb.UserController, :index',
          '  get "/users/:id", MyAppWeb.UserController, :show',
          '  post "/users", MyAppWeb.UserController, :create',
          'end',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'web', 'user.ex'),
        [
          'defmodule MyApp.User do',
          '  use Ecto.Schema',
          '',
          '  schema "users" do',
          '    field :name, :string',
          '  end',
          'end',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['phoenix'] });
      expect(r.manifest.countsBySubtype['phoenix:controller']).toBe(1);
      expect(r.manifest.countsBySubtype['phoenix:router']).toBe(1);
      expect(r.manifest.countsBySubtype['phoenix:schema']).toBe(1);
      expect(r.manifest.countsBySubtype['phoenix:action']).toBe(2);
      expect(r.manifest.countsBySubtype['phoenix:route']).toBe(3);
      const api = FrameworkQueryApi.fromStore(root);
      const labels = api.list({ framework: 'phoenix', subtype: 'route' }).map((e) => e.label).sort();
      expect(labels).toEqual([
        'GET /users → MyAppWeb.UserController.index',
        'GET /users/:id → MyAppWeb.UserController.show',
        'POST /users → MyAppWeb.UserController.create',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
