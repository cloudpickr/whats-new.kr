import { env } from 'cloudflare:workers';

// Shared helper for SSR calls from this Astro site to its own backend API
// (api.whats-new.kr). Sends the "site" API_KEY_RING token so the backend can
// tell our own server-side rendering apart from direct/agent calls to
// /api/articles, which should go through POST /mcp instead. See worker/index.js
// (requiredKeyTypeForPath, SITE_API_ENFORCEMENT) and README.md for the gate.
//
// The SITE_API_TOKEN must match the "site"-type entry in the Worker's
// API_KEY_RING; SSR only authenticates once this deployment ships with the
// token in place.

export function apiBase(site: URL) {
  return `${site.protocol}//api.${site.host}`;
}

// In @astrojs/cloudflare v14 (Astro 7) the old `locals.runtime.env` was removed;
// Worker env/secrets come from the "cloudflare:workers" `env` import instead.
// SITE_API_TOKEN is the "site"-type API_KEY_RING token this SSR sends to the
// backend /api/articles gate. `locals` is kept in the signature for call-site
// compatibility but is no longer read.
export function apiHeaders(_locals?: unknown): Record<string, string> {
  const token = (env as { SITE_API_TOKEN?: string } | undefined)?.SITE_API_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
