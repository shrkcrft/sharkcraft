import { OverviewPage } from './overview.page.tsx';
import { StatsPage } from './stats.page.tsx';
import { SessionsPage } from './sessions.page.tsx';
import { SessionDetailPage } from './session-detail.page.tsx';
import { QualityPage } from './quality.page.tsx';
import { SafetyPage } from './safety.page.tsx';
import { ArchitecturePage } from './architecture.page.tsx';
import { GraphPage } from './graph.page.tsx';
import { PacksPage } from './packs.page.tsx';
import { PresetsPipelinesPage } from './presets-pipelines.page.tsx';
import { McpPage } from './mcp.page.tsx';
import { CodeIntelligencePage } from './code-intelligence.page.tsx';
import { RoutesPage } from './routes.page.tsx';
import { MigrationsPage } from './migrations.page.tsx';
import { QualityGatesPage } from './quality-gates.page.tsx';
import { matchSegment } from '../utils/routing.ts';

export interface IResolvedRoute {
  title: string;
  node: JSX.Element;
}

// The dashboard surfaces ten pages — focused on "what is the state of
// this project right now". Commands / Onboarding / Reports / Review & CI
// were dropped in the alpha.8 trim: they were tied to advanced
// workflows, not project state. Their backing data endpoints stay live
// for power users / CLI consumers.

export function resolveRoute(path: string): IResolvedRoute {
  if (path === '/' || path === '/overview') return { title: 'Overview', node: <OverviewPage /> };
  if (path === '/stats') return { title: 'Statistics', node: <StatsPage /> };
  if (path === '/sessions') return { title: 'Dev Sessions', node: <SessionsPage /> };
  const sessMatch = matchSegment(path, '/sessions/:id');
  if (sessMatch) return { title: `Session ${sessMatch.id}`, node: <SessionDetailPage id={sessMatch.id!} /> };
  if (path === '/quality') return { title: 'Quality', node: <QualityPage /> };
  if (path === '/safety') return { title: 'Safety', node: <SafetyPage /> };
  if (path === '/architecture') return { title: 'Architecture', node: <ArchitecturePage /> };
  if (path === '/graph') return { title: 'Knowledge Graph', node: <GraphPage /> };
  if (path === '/packs') return { title: 'Packs', node: <PacksPage /> };
  if (path === '/presets-pipelines') return { title: 'Presets & Pipelines', node: <PresetsPipelinesPage /> };
  if (path === '/mcp') return { title: 'MCP', node: <McpPage /> };
  if (path === '/code-intelligence') return { title: 'Code Intelligence', node: <CodeIntelligencePage /> };
  if (path === '/routes') return { title: 'Routes', node: <RoutesPage /> };
  if (path === '/migrations') return { title: 'Migrations', node: <MigrationsPage /> };
  if (path === '/quality-gates') return { title: 'Quality Gates', node: <QualityGatesPage /> };
  return {
    title: 'Not found',
    node: (
      <div className="empty">
        <div className="empty__title">Page not found</div>
        <div>
          <a href="#/overview">Go to overview</a>
        </div>
      </div>
    ),
  };
}
