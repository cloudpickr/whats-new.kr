#!/usr/bin/env node
// Korean card quality report — pulls live cards from the API and runs the same
// heuristics the worker uses in assessTranslationQuality, grouped by model tag.
// Usage: node scripts/ko-quality-report.mjs [limit-per-csp=80]
//   Compare fluent-korean-v1 (old) vs v2 (new) as the daily refresh rolls through.
const LIMIT = Number(process.argv[2] || 80);
// API base follows SITE_URL (api.<host>) so one variable moves everything;
// API_BASE still overrides directly if needed.
const SITE_URL = process.env.SITE_URL || 'https://whats-new.kr';
const API = process.env.API_BASE || `https://api.${new URL(SITE_URL).host}`;

function splitSentences(text) {
  return String(text || '').replace(/(\d)\.(\d)/g, '$1·$2').split(/(?<=[.!?。])\s+/).map((s) => s.trim()).filter(Boolean);
}
function tokens(text) {
  return new Set(String(text || '').replace(/(\d)\.(\d)/g, '$1·$2').split(/[^가-힣A-Za-z0-9·]+/)
    .map((t) => t.replace(/(을|를|이|가|은|는|과|와|의|에|에서|으로|로|도|만|에게|부터|까지)$/, '')).filter((t) => t.length >= 2));
}
function overlap(a, b) { const A = tokens(a), B = tokens(b); if (A.size < 3) return 0; let hit = 0; for (const t of A) if (B.has(t)) hit++; return hit / A.size; }

function checks(card) {
  const title = card.title || '', summary = card.summary || '', target = card.target || '';
  const sents = splitSentences(summary);
  const r = [];
  if (sents.length < 1 || sents.length > 2) r.push('sentence-count');
  if (sents.length >= 2 && (overlap(sents[1], sents[0]) >= 0.6 || overlap(sents[1], target) >= 0.7 || overlap(sents[1], `${title} ${target}`) >= 0.8)) r.push('redundant-2nd');
  if (/(?:합니다|됩니다|습니다|[다요])\.?$/.test(title) || /\.$/.test(title)) r.push('title-is-sentence');
  if (title.length > 55) r.push('title>55');
  if (/^(이는|또한|이제|이 기능|이 변경|이러한|이 업데이트|이 새로운)/.test(summary)) r.push('omits-subject');
  if (sents.slice(1).some((s) => /^(또한|이는|이를 통해)\s/.test(s))) r.push('filler-connector');
  if (/(?:하세요|하십시오|바랍니다|해 보세요|해보세요)[.!]?(?:\s|$)/.test(summary)) r.push('imperative');
  if (/[A-Za-z]{3,}(?:하거나|하여|합니다|되며|됩니다|했습니다|되었습니다|하는 |되는 )/.test(summary)) r.push('english-stem');
  if (/\b(delivers|announces|now supports|is now available)\b/i.test(title) || !/[가-힣]/.test(title)) r.push('title-not-translated');
  if (/\b[a-z]{2,}(?:-[a-z]+)? [a-z]{2,} [a-z]{2,}\b/.test(summary) || /[가-힣][A-Z]{3,}/.test(`${title} ${summary}`)) r.push('untranslated-phrase');
  if (/Amazon Connect Customer(?!\s*Profiles)/.test(title + summary + target)) r.push('connect-customer');
  if (/ Feature (For|for) /.test(title + summary + target)) r.push('gcp-heading-leak');
  return r;
}

const cards = [];
for (const csp of ['aws', 'gcp', 'azure']) {
  const res = await fetch(`${API}/api/articles?csp=${csp}&lang=ko&limit=${LIMIT}`);
  cards.push(...((await res.json()).items || []));
}
const groups = new Map();
for (const c of cards) {
  const g = groups.get(c.model_used || '?') || { n: 0, flagged: 0, reasons: {}, examples: {} };
  const r = checks(c);
  g.n++; if (r.length) g.flagged++;
  for (const k of r) { g.reasons[k] = (g.reasons[k] || 0) + 1; (g.examples[k] ||= []).length < 2 && g.examples[k].push(`${c.title} — ${String(c.summary).slice(0, 90)}…`); }
  groups.set(c.model_used || '?', g);
}
console.log(`Korean cards: ${cards.length} (limit ${LIMIT}/csp) — ${new Date().toISOString().slice(0, 16)}Z\n`);
for (const [model, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`== ${model}: ${g.n} cards, ${g.flagged} flagged (${Math.round(100 * g.flagged / g.n)}%)`);
  for (const [k, v] of Object.entries(g.reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(20)} ${String(v).padStart(3)}  (${Math.round(100 * v / g.n)}%)`);
  }
  if (process.argv.includes('--examples')) for (const [k, ex] of Object.entries(g.examples)) { console.log(`   · ${k}:`); ex.forEach((e) => console.log(`       ${e}`)); }
  console.log();
}
