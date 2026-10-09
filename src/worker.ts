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

// Vulnerability-scanner noise. Bots constantly probe for exposed secrets, VCS
// metadata, WordPress, debug endpoints, etc. These paths don't exist here, so
// they'd fall through to Astro SSR and 404 — but Cloudflare's observability
// still classifies the pattern and files "Potential vulnerability scan" issues
// that bury real errors. Short-circuit them with a cheap 404 before any SSR or
// backend work so they never generate an issue or burn a D1 query.
const SCANNER_PATTERNS: RegExp[] = [
  /^\/wp-/i,                       // wordpress: /wp-login.php, /wp-admin, /wp-content
  /\/wp-(admin|login|content|includes|json)/i,
  /^\/(\.git|\.svn|\.hg)(\/|$)/i,  // source-control metadata
  /^\/\.env/i,                     // secret files: .env, .env.local
  /^\/\.(aws|ssh|docker|config)(\/|$)/i,
  /\/(id_rsa|id_dsa|\.htpasswd|\.htaccess|credentials|secrets?\.(ya?ml|json|txt))$/i,
  /^\/(phpmyadmin|pma|adminer|xmlrpc\.php|wlwmanifest\.xml)/i,
  /^\/(debug|actuator|telescope|_debugbar|server-status|server-info)(\/|$)/i,
  /\.(php|asp|aspx|jsp|cgi)$/i,    // we serve no server-scripting pages
  /^\/(cgi-bin|vendor\/phpunit|\.well-known\/security\.txt\.bak)/i,
];

function isScannerPath(pathname: string): boolean {
  return SCANNER_PATTERNS.some((re) => re.test(pathname));
}

// Astro's Cloudflare adapter builds a Worker whose responses are NOT
// automatically stored in Cloudflare's CDN cache — a Worker fetch response
// bypasses the edge cache unless we explicitly use the Cache API. Page routes
// set `Cache-Control: s-maxage=60, stale-while-revalidate=300` (see
// [csp].astro), but without this layer every request re-ran the full SSR
// render + backend D1 query, which showed up as a variable TTFB and large
// LCP spikes in the field. This wraps GET page renders in the Cache API so a
// hit serves cached HTML in ~tens of ms with no D1 round-trip.
async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  render: () => Promise<Response>,
): Promise<Response> {
  // Only cache top-level GET navigations. Skip anything with cookies/auth so
  // we never cache a personalized response.
  if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('cookie')) {
    return render();
  }
  const cache = (caches as unknown as { default: Cache }).default;
  // Normalize the cache key to the URL only (drop the request's own headers).
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('X-Edge-Cache', 'HIT');
    return hit;
  }

  const response = await render();

  // Only store cacheable successes that opted in via s-maxage. HTML pages do;
  // redirects (302 for unknown slugs) and errors do not.
  const cc = response.headers.get('Cache-Control') || '';
  if (response.status === 200 && /s-maxage=\d+/.test(cc)) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    const miss = new Response(response.body, response);
    miss.headers.set('X-Edge-Cache', 'MISS');
    return miss;
  }
  return response;
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
    // Drop vulnerability-scanner probes early with a plain 404 — before SSR,
    // backend, or cache work — so they don't file observability issues.
    if (isScannerPath(pathname)) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' },
      });
    }
    if (isApiRequest(pathname)) {
      return backend.fetch(safeRequest, env, ctx);
    }
    return withEdgeCache(safeRequest, ctx, () => handle(safeRequest, env as never, ctx));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return backend.scheduled(event, env, ctx);
  },

  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    return backend.queue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
