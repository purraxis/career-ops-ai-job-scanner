// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Adzuna provider — official job search API.
// Docs: https://developer.adzuna.com/
// Env: ADZUNA_APP_ID, ADZUNA_APP_KEY

const API_BASE = 'https://api.adzuna.com/v1/api/jobs';
const DEFAULT_PAGE_SIZE = 25;

function missingCredentials() {
  return !process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY;
}

function disabledMissingCredentials() {
  return new Error('disabled_missing_credentials: ADZUNA_APP_ID and ADZUNA_APP_KEY are required');
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function salary(min, max) {
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return null;
  const resolvedMin = Number.isFinite(lo) ? lo : hi;
  const resolvedMax = Number.isFinite(hi) ? hi : lo;
  return { min: Math.min(resolvedMin, resolvedMax), max: Math.max(resolvedMin, resolvedMax), currency: 'USD' };
}

function normalize(job) {
  if (!job || typeof job !== 'object') return null;
  const title = typeof job.title === 'string' ? job.title.trim() : '';
  const url = typeof job.redirect_url === 'string' ? job.redirect_url.trim() : '';
  if (!title || !/^https?:\/\//i.test(url)) return null;
  return {
    title,
    url,
    company: typeof job.company?.display_name === 'string' ? job.company.display_name.trim() : 'Adzuna',
    location: typeof job.location?.display_name === 'string' ? job.location.display_name.trim() : '',
    description: typeof job.description === 'string' ? job.description : '',
    salary: salary(job.salary_min, job.salary_max),
    postedAt: toEpochMs(job.created),
  };
}

/** @type {Provider} */
export default {
  id: 'adzuna',

  detect(entry) {
    return entry?.provider === 'adzuna' ? { url: API_BASE } : null;
  },

  async fetch(entry, ctx) {
    if (missingCredentials()) throw disabledMissingCredentials();
    const country = String(entry.country || 'us').toLowerCase();
    const queries = Array.isArray(entry.queries) && entry.queries.length ? entry.queries : ['Solutions Engineer'];
    const maxPages = Math.max(1, Math.min(Number(entry.maxPages) || 1, 5));
    const pageSize = Math.max(1, Math.min(Number(entry.pageSize) || DEFAULT_PAGE_SIZE, 50));
    const out = [];

    for (const query of queries) {
      for (let page = 1; page <= maxPages; page++) {
        const url = new URL(`${API_BASE}/${encodeURIComponent(country)}/search/${page}`);
        url.searchParams.set('app_id', process.env.ADZUNA_APP_ID || '');
        url.searchParams.set('app_key', process.env.ADZUNA_APP_KEY || '');
        url.searchParams.set('what', String(query));
        url.searchParams.set('where', 'United States');
        url.searchParams.set('results_per_page', String(pageSize));
        url.searchParams.set('sort_by', 'date');
        url.searchParams.set('content-type', 'application/json');
        const json = await ctx.fetchJson(url.href, { redirect: 'error' });
        const jobs = Array.isArray(json?.results) ? json.results : [];
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
