// Unified Worker entrypoint (Astro 7 + @astrojs/cloudflare v14).
//
// This project runs one Worker that serves both the Astro SSR site and the
// backend API/pipeline that used to live in a separate Worker (worker/index.js):
//   - fetch:     API routes (/api/*, /mcp) → backend handler; everything else
//                falls through to Astro SSR (pages, assets).
//   - scheduled: RSS ingestion / translation cron → backend handler.
//   - queue:     translation queue consumer → backend handler.
//
// The @astrojs/cloudflare adapter's `handle` runs the Astro request pipeline
// (static assets via the ASSETS binding + on-demand rendered routes).
import { handle } from '@astrojs/cloudflare/handler';
import backend from '../worker/index.js';

// Paths owned by the backend API. Anything else is an Astro route.
const API_PREFIXES = ['/api/', '/mcp'];

function isApiRequest(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (isApiRequest(pathname)) {
      return backend.fetch(request, env, ctx);
    }
    return handle(request, env as never, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return backend.scheduled(event, env, ctx);
  },

  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    return backend.queue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
