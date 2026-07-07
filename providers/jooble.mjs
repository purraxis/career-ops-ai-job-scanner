// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Jooble provider — REST API.
// Env: JOOBLE_API_KEY

const API_BASE = 'https://jooble.org/api';
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 2;
const VALID_RADII = new Set(['0', '4', '8', '16', '26', '40', '80']);

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseSalary(value) {
  if (typeof value !== 'string') return null;
  const nums = value.match(/\d[\d,]*/g)?.map(s => Number(s.replace(/,/g, ''))).filter(Number.isFinite) || [];
  if (!nums.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { min, max, currency: 'USD' };
}

function duplicateKey({ title, company, location, url }) {
  let urlPart = '';
  try {
    const parsed = new URL(url);
    urlPart = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    urlPart = String(url || '').toLowerCase();
  }
  return [title, company, location, urlPart]
    .map(v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim())
    .join('::');
}

export function normalizeJoobleJob(job) {
  if (!job || typeof job !== 'object') return null;
  const title = typeof job.title === 'string' ? job.title.trim() : '';
  const url = typeof job.link === 'string' ? job.link.trim() : '';
  if (!title || !/^https?:\/\//i.test(url)) return null;
  const company = typeof job.company === 'string' && job.company.trim() ? job.company.trim() : 'Jooble';
  const location = typeof job.location === 'string' ? job.location.trim() : '';
  const externalId = typeof job.id === 'string' || typeof job.id === 'number'
    ? `jooble:${String(job.id).trim()}`
    : `jooble:${stableHash(duplicateKey({ title, company, location, url }))}`;
  return {
    source: 'jooble',
    external_id: externalId,
    externalId,
    title,
    url,
    company,
    location,
    description: typeof job.snippet === 'string' ? job.snippet : '',
    salary: parseSalary(job.salary),
    employment_type: typeof job.type === 'string' ? job.type : '',
    employmentType: typeof job.type === 'string' ? job.type : '',
    postedAt: toEpochMs(job.updated),
    updatedAt: toEpochMs(job.updated),
    duplicateKey: duplicateKey({ title, company, location, url }),
  };
}

function joobleErrorMessage(err) {
  if (err?.status === 403) return 'invalid_or_unauthorized_jooble_api_key';
  if (err?.status === 404) return 'bad_jooble_endpoint_or_config';
  return err?.message || 'jooble_api_error';
}

/** @type {Provider} */
export default {
  id: 'jooble',

  detect(entry) {
    return entry?.provider === 'jooble' ? { url: API_BASE } : null;
  },

  async fetch(entry, ctx) {
    const key = process.env.JOOBLE_API_KEY;
    if (!key) throw new Error('disabled_missing_credentials: JOOBLE_API_KEY is required');
    const queries = Array.isArray(entry.queries) && entry.queries.length ? entry.queries : ['Solutions Engineer'];
    const maxPages = Math.max(1, Math.min(Number(entry.maxPages) || DEFAULT_MAX_PAGES, 5));
    const pageSize = Math.max(1, Math.min(Number(entry.pageSize) || DEFAULT_PAGE_SIZE, 50));
    const location = typeof entry.location === 'string' && entry.location.trim()
      ? entry.location.trim()
      : (String(entry.country || '').toLowerCase() === 'us' ? 'United States' : String(entry.country || ''));
    const radius = VALID_RADII.has(String(entry.radius)) ? String(entry.radius) : undefined;
    const out = [];

    for (const query of queries) {
      for (let page = 1; page <= maxPages; page++) {
        let json;
        try {
          json = await ctx.fetchJson(`${API_BASE}/${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              keywords: String(query),
              location,
              ...(radius ? { radius } : {}),
              page,
              ResultOnPage: pageSize,
              SearchMode: Number(entry.SearchMode ?? entry.searchMode ?? 0),
              companysearch: 'false',
            }),
            redirect: 'error',
          });
        } catch (err) {
          throw new Error(joobleErrorMessage(err));
        }
        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        let normalizedCount = 0;
        for (const job of jobs) {
          const normalized = normalizeJoobleJob(job);
          if (normalized) {
            normalizedCount++;
            out.push(normalized);
          }
        }
        console.log(`  jooble query="${query}" page=${page} fetched=${jobs.length} normalized=${normalizedCount}`);
        if (jobs.length < pageSize) break;
      }
    }
    return out;
  },
};
