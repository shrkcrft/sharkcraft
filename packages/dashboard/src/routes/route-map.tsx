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
import { OnboardingPage } from './onboarding.page.tsx';
import { ReportsPage } from './reports.page.tsx';
import { ReviewCiPage } from './review-ci.page.tsx';
import { CommandsPage } from './commands.page.tsx';
import { McpPage } from './mcp.page.tsx';
import { matchSegment } from '../utils/routing.ts';

export interface IResolvedRoute {
  title: string;
  node: JSX.Element;
}

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
  if (path === '/onboarding') return { title: 'Onboarding', node: <OnboardingPage /> };
  if (path === '/reports') return { title: 'Reports', node: <ReportsPage /> };
  if (path === '/review-ci') return { title: 'Review & CI', node: <ReviewCiPage /> };
  if (path === '/commands') return { title: 'Commands', node: <CommandsPage /> };
  if (path === '/mcp') return { title: 'MCP', node: <McpPage /> };
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
