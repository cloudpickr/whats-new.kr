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
    // Strip the internal-SSR trust header from every inbound external request
    // so it can't be forged. Only this Worker's own SSR (via apiClient's
    // in-process callBackend) is allowed to set it; see worker/index.js
    // (isInternalSsrCall) for the /api/articles gate bypass it unlocks.
    let safeRequest = request;
    if (request.headers.has('X-Internal-SSR')) {
      const headers = new Headers(request.headers);
      headers.delete('X-Internal-SSR');
      safeRequest = new Request(request, { headers });
    }

    const { pathname } = new URL(safeRequest.url);
    if (isApiRequest(pathname)) {
      return backend.fetch(safeRequest, env, ctx);
    }
    return handle(safeRequest, env as never, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return backend.scheduled(event, env, ctx);
  },

  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    return backend.queue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
