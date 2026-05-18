import { useEffect, useState } from 'react';
import { Sidebar } from './components/layout/Sidebar.tsx';
import { Topbar } from './components/layout/Topbar.tsx';
import { resolveRoute } from './routes/route-map.tsx';
import { useRoute } from './utils/routing.ts';
import { getHealth } from './api/endpoints.ts';

export function App(): JSX.Element {
  const route = useRoute();
  const resolved = resolveRoute(route.path);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);

  useEffect(() => {
    getHealth()
      .then((r) => setProjectRoot(r.projectRoot))
      .catch(() => setProjectRoot(null));
  }, []);

  useEffect(() => {
    document.title = `SharkCraft — ${resolved.title}`;
  }, [resolved.title]);

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <Topbar projectRoot={projectRoot} />
        <main className="page" key={route.path}>
          {resolved.node}
        </main>
      </div>
    </div>
  );
}
