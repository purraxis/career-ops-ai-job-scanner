// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Careerjet provider — affiliate search API.
// Env: CAREERJET_AFFID or CAREERJET_API_KEY

const API_URL = 'https://public.api.careerjet.net/search';
const DEFAULT_PAGE_SIZE = 25;

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseSalary(value) {
  if (typeof value !== 'string') return null;
  const nums = value.match(/\d[\d,]*/g)?.map(s => Number(s.replace(/,/g, ''))).filter(Number.isFinite) || [];
  if (!nums.length) return null;
  return { min: Math.min(...nums), max: Math.max(...nums), currency: 'USD' };
}

function normalize(job) {
  if (!job || typeof job !== 'object') return null;
  const title = typeof job.title === 'string' ? job.title.trim() : '';
  const url = typeof job.url === 'string' ? job.url.trim() : '';
  if (!title || !/^https?:\/\//i.test(url)) return null;
  return {
    title,
    url,
    company: typeof job.company === 'string' && job.company.trim() ? job.company.trim() : 'Careerjet',
    location: typeof job.locations === 'string' ? job.locations.trim() : '',
    description: typeof job.description === 'string' ? job.description : '',
    salary: parseSalary(job.salary),
    postedAt: toEpochMs(job.date),
  };
}

/** @type {Provider} */
export default {
  id: 'careerjet',

  detect(entry) {
    return entry?.provider === 'careerjet' ? { url: API_URL } : null;
  },

  async fetch(entry, ctx) {
    const affid = process.env.CAREERJET_AFFID || process.env.CAREERJET_API_KEY;
    if (!affid) throw new Error('disabled_missing_credentials: CAREERJET_AFFID or CAREERJET_API_KEY is required');
    const queries = Array.isArray(entry.queries) && entry.queries.length ? entry.queries : ['Solutions Engineer'];
    const maxPages = Math.max(1, Math.min(Number(entry.maxPages) || 1, 5));
    const pageSize = Math.max(1, Math.min(Number(entry.pageSize) || DEFAULT_PAGE_SIZE, 99));
    const out = [];
    for (const query of queries) {
      for (let page = 1; page <= maxPages; page++) {
        const url = new URL(API_URL);
        url.searchParams.set('affid', affid);
        url.searchParams.set('keywords', query);
        url.searchParams.set('location', 'United States');
        url.searchParams.set('locale_code', 'en_US');
        url.searchParams.set('pagesize', String(pageSize));
        url.searchParams.set('page', String(page));
        url.searchParams.set('user_ip', String(entry.user_ip || '127.0.0.1'));
        url.searchParams.set('user_agent', String(entry.user_agent || 'career-ops/1.0'));
        url.searchParams.set('url', String(entry.url || 'https://career-ops.local'));
        const json = await ctx.fetchJson(url.href, { redirect: 'error' });
        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        for (const job of jobs) {
          const normalized = normalize(job);
          if (normalized) out.push(normalized);
        }
        if (jobs.length < pageSize) break;
      }
    }
    return out;
  },
};
