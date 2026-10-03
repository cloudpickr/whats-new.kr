import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// `site` drives canonical URLs, the sitemap, and SSR's apiBase() (which derives
// the Worker API host as api.<site.host>). The live value comes from the
// SITE_URL build-time variable (GitHub Actions repo variable); the literal is
// only the fallback for bare local builds. Point the service variable at a new
// domain to move the site — don't edit this file.
const SITE_URL = process.env.SITE_URL || 'https://whats-new.kr';

export default defineConfig({
  site: SITE_URL,
  output: 'server',
  adapter: cloudflare(),
  vite: {
    plugins: [tailwindcss()],
  },
});
