/**
 * Live session server v2: serves an HTML view for one dev session, optionally
 * with SSE-based "updated" notifications. Read-only — GET/HEAD only, no
 * source writes, no apply endpoints, no shell execution.
 *
 * Extracted from dev.command.ts so it can be tested directly.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { renderDevSessionHtml, scanDevSession, type IDevSessionLoad } from '@shrkcrft/inspector';

export interface ILiveSessionServerOptions {
  cwd: string;
  load: IDevSessionLoad;
  host?: string;
  port?: number;
  live?: boolean;
}

export interface ILiveSessionServerHandle {
  url: string;
  host: string;
  port: number;
  /** Force-broadcast a synthetic SSE event (used by tests). */
  triggerEvent: (event: string) => void;
  close: () => Promise<void>;
}

const LIVE_SCRIPT = `<script>(function(){try{var es=new EventSource('/events');es.onmessage=function(){location.reload()};es.addEventListener('change',function(){location.reload()})}catch(e){}})();</script><meta http-equiv="refresh" content="30">`;

export async function startLiveSessionServer(
  opts: ILiveSessionServerOptions,
): Promise<ILiveSessionServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const live = opts.live === true;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    process.stderr.write(
      `WARNING: --host ${host} exposes the session server beyond localhost. Press Ctrl+C to abort if unintended.\n`,
    );
  }
  type Subscriber = (event: string) => void;
  const subscribers = new Set<Subscriber>();
  let lastVersion = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const broadcast = (event: string): void => {
    for (const s of [...subscribers]) {
      try {
        s(event);
      } catch {
        subscribers.delete(s);
      }
    }
  };
  const scheduleBroadcast = (event: string): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      lastVersion += 1;
      broadcast(event);
    }, 200);
  };
  const watchers: { close(): void }[] = [];
  if (live) {
    for (const sub of ['session.json', 'plans', 'reports']) {
      const target = nodePath.join(opts.load.dir, sub);
      if (fs.existsSync(target)) {
        try {
          const w = fs.watch(target, { recursive: true }, () => scheduleBroadcast(sub));
          watchers.push(w);
        } catch {
          try {
            const w = fs.watch(target, () => scheduleBroadcast(sub));
            watchers.push(w);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  const server = http.createServer((req, res) => {
    try {
      if (live && req.url === '/events') {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        const send: Subscriber = (event) =>
          res.write(`event: change\ndata: ${event}\nid: ${lastVersion}\n\n`);
        subscribers.add(send);
        send('hello');
        req.on('close', () => {
          subscribers.delete(send);
        });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET, HEAD');
        res.end('Method not allowed');
        return;
      }
      const reload = scanDevSession(opts.cwd, opts.load.id) ?? opts.load;
      let html = renderDevSessionHtml(reload, {
        nextActionLine: reload.state?.nextAction ?? undefined,
      });
      if (live) html = html.replace('</head>', LIVE_SCRIPT + '</head>');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(html);
    } catch (e) {
      res.statusCode = 500;
      res.end(`Error: ${(e as Error).message}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const addr = server.address();
  const realPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://${host}:${realPort}`,
    host,
    port: realPort,
    triggerEvent: (event: string) => {
      lastVersion += 1;
      broadcast(event);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            /* ignore */
          }
        }
        server.close(() => resolve());
      }),
  };
}
