import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function base(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-django-flask-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
  );
  return root;
}

describe('django extractor', () => {
  test('detects models, CBVs, FBVs, and URL patterns', () => {
    const root = base();
    try {
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'models.py' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'models.py'),
        [
          'from django.db import models',
          '',
          'class User(models.Model):',
          '    name = models.CharField(max_length=120)',
          '',
          'class Profile(models.Model):',
          '    user = models.OneToOneField(User, on_delete=models.CASCADE)',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'api', 'views.py'),
        [
          'from django.views.generic import TemplateView, ListView',
          'from django.http import HttpResponse',
          '',
          'class Home(TemplateView):',
          '    template_name = "home.html"',
          '',
          'class UserList(ListView):',
          '    model = "User"',
          '',
          'def about(request):',
          '    return HttpResponse("about")',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'services', 'api', 'urls.py'),
        [
          'from django.urls import path',
          'from . import views',
          '',
          "urlpatterns = [",
          "    path('', views.Home.as_view(), name='home'),",
          "    path('users/', views.UserList.as_view(), name='users'),",
          "    path('about/', views.about, name='about'),",
          ']',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['django'] });
      expect(r.manifest.countsBySubtype['django:model']).toBe(2);
      expect(r.manifest.countsBySubtype['django:view']).toBe(3);
      expect(r.manifest.countsBySubtype['django:url-pattern']).toBe(3);
      const api = FrameworkQueryApi.fromStore(root);
      const models = api.list({ framework: 'django', subtype: 'model' });
      expect(models.map((m) => m.label).sort()).toEqual(['Profile', 'User']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('flask extractor', () => {
  test('detects Flask app + Blueprint + routes with method extraction', () => {
    const root = base();
    try {
      mkdirSync(join(root, 'services', 'api'), { recursive: true });
      writeFileSync(
        join(root, 'services', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'app.py' }, null, 2),
      );
      writeFileSync(
        join(root, 'services', 'api', 'app.py'),
        [
          'from flask import Flask, Blueprint',
          '',
          'app = Flask(__name__)',
          "users_bp = Blueprint('users', __name__)",
          '',
          "@app.route('/health')",
          'def health():',
          "    return {'ok': True}",
          '',
          "@app.route('/echo', methods=['POST'])",
          'def echo():',
          "    return 'echoed'",
          '',
          "@users_bp.route('/users/<id>', methods=['GET', 'DELETE'])",
          'def user_handler(id):',
          "    return id",
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['flask'] });
      expect(r.manifest.countsBySubtype['flask:app']).toBe(1);
      expect(r.manifest.countsBySubtype['flask:blueprint']).toBe(1);
      // GET /health + POST /echo + GET /users/<id> + DELETE /users/<id> = 4 routes.
      expect(r.manifest.countsBySubtype['flask:route']).toBe(4);
      const api = FrameworkQueryApi.fromStore(root);
      const routes = api.list({ framework: 'flask', subtype: 'route' });
      const labels = routes.map((r) => r.label).sort();
      expect(labels).toEqual([
        'DELETE /users/<id>',
        'GET /health',
        'GET /users/<id>',
        'POST /echo',
      ]);
      const handles = api.edges().filter((e) => e.kind === EdgeKind.HandlesRoute);
      expect(handles.length).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
