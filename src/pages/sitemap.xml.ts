import type { APIRoute } from 'astro';
import { apiBase, apiHeaders } from '../lib/apiClient';

const csps = ['aws', 'gcp', 'azure'] as const;

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function getLatestPubDate(site: URL, csp: string, locals: unknown) {
  const base = apiBase(site);
  try {
    const response = await fetch(`${base}/api/articles?csp=${csp}&lang=ko&limit=1`, { headers: apiHeaders(locals) });
    if (!response.ok) return null;
    const payload = (await response.json()) as { items?: Array<{ pub_date?: string }> };
    return payload.items?.[0]?.pub_date || null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ site, locals }) => {
  if (!site) {
    return new Response('site is not configured', { status: 500 });
  }

  const latestDates = await Promise.all(csps.map((csp) => getLatestPubDate(site, csp, locals)));
  const homeLastmod = latestDates.filter(Boolean).sort().reverse()[0] || new Date().toISOString();
  const urls = [
    { loc: new URL('/', site).toString(), priority: '1.0', changefreq: 'hourly', lastmod: homeLastmod },
    ...csps.map((csp, index) => ({
      loc: new URL(`/${csp}`, site).toString(),
      priority: '0.9',
      changefreq: 'hourly',
      lastmod: latestDates[index] || homeLastmod,
    })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${xmlEscape(url.loc)}</loc><lastmod>${xmlEscape(url.lastmod)}</lastmod><changefreq>${url.changefreq}</changefreq><priority>${url.priority}</priority></url>`).join('\n')}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
