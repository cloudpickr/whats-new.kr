import { env } from 'cloudflare:workers';
import backend from '../../worker/index.js';

// SSR → backend API bridge for the unified Worker.
//
// This project runs one Worker that serves both the Astro SSR site and the
// backend API (worker/index.js). SSR must NOT call the API over HTTP: a Worker
// cannot send a subrequest to its own origin (Cloudflare error 1042), and the
// api.<host> round-trip would also need the website-only auth token. Instead,
// SSR invokes the backend fetch handler in-process and reads the Response
// directly. The X-Internal-SSR header marks the call as trusted so the backend
// skips the /api/articles website-only gate; src/worker.ts strips that header
// from every inbound external request, so it cannot be forged from outside.

type BackendFetch = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

// Minimal ExecutionContext stub — the /api/articles path doesn't use waitUntil
// or passThroughOnException, but the handler signature expects a ctx.
const noopCtx = {
  waitUntil(_promise: Promise<unknown>) {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

// Call the backend API handler in-process. `path` is an API path like
// "/api/articles?csp=aws&lang=ko&limit=15". Returns the parsed JSON body typed
// as T. Any failure (non-OK status, bad JSON) resolves to `fallback` so a page
// still renders.
export async function callBackend<T>(path: string, fallback: T): Promise<T> {
  try {
    const req = new Request(`https://internal${path}`, {
      method: 'GET',
      headers: { 'X-Internal-SSR': '1' },
    });
    const res = await (backend as { fetch: BackendFetch }).fetch(req, env, noopCtx);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}
