import type { APIRoute } from 'astro';
import { callBackend } from '../lib/apiClient';

const csps = ['aws', 'gcp', 'azure', 'oci'] as const;

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function getLatestPubDate(csp: string) {
  const payload = await callBackend<{ items?: Array<{ pub_date?: string }> }>(
    `/api/articles?csp=${csp}&lang=ko&limit=1`,
    { items: [] }
  );
  return payload.items?.[0]?.pub_date || null;
}

export const GET: APIRoute = async ({ site }) => {
  if (!site) {
    return new Response('site is not configured', { status: 500 });
  }

  const latestDates = await Promise.all(csps.map((csp) => getLatestPubDate(csp)));
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
