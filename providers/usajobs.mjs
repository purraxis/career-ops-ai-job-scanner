// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// USAJOBS provider — official federal jobs API.
// Disabled by default in portals.yml because many roles require citizenship.
// Env: USAJOBS_API_KEY, plus USAJOBS_USER_AGENT or USAJOBS_EMAIL

const API_URL = 'https://data.usajobs.gov/api/search';
const DEFAULT_PAGE_SIZE = 25;

const STRICT_REJECT_PATTERNS = [
  /u\.?s\.? citizens?/i,
  /united states citizens?/i,
  /citizenship is required/i,
  /security clearance/i,
  /top secret/i,
  /\bsecret\b/i,
  /federal employees/i,
  /status candidates/i,
  /career transition/i,
];

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function textFromDescriptor(d) {
  return [
    d?.UserArea?.Details?.JobSummary,
    d?.UserArea?.Details?.WhoMayApply?.Name,
    d?.UserArea?.Details?.SecurityClearance,
    d?.QualificationSummary,
  ].filter(Boolean).join(' ');
}

function shouldRejectFederal(descriptor) {
  const text = textFromDescriptor(descriptor);
  return STRICT_REJECT_PATTERNS.some(re => re.test(text));
}

function normalize(item) {
  const d = item?.MatchedObjectDescriptor;
  if (!d || shouldRejectFederal(d)) return null;
  const title = typeof d.PositionTitle === 'string' ? d.PositionTitle.trim() : '';
  const url = typeof d.PositionURI === 'string' ? d.PositionURI.trim() : '';
  if (!title || !/^https?:\/\//i.test(url)) return null;
  return {
    title,
    url,
    company: typeof d.OrganizationName === 'string' && d.OrganizationName.trim() ? d.OrganizationName.trim() : 'USAJOBS',
    location: typeof d.PositionLocationDisplay === 'string' ? d.PositionLocationDisplay.trim() : '',
    description: textFromDescriptor(d),
    postedAt: toEpochMs(d.PublicationStartDate || d.PositionStartDate),
  };
}

/** @type {Provider} */
export default {
  id: 'usajobs',

  detect(entry) {
    return entry?.provider === 'usajobs' ? { url: API_URL } : null;
  },

  async fetch(entry, ctx) {
    const apiKey = process.env.USAJOBS_API_KEY;
    const userAgent = process.env.USAJOBS_USER_AGENT || process.env.USAJOBS_EMAIL;
    if (!apiKey || !userAgent) {
      throw new Error('disabled_missing_credentials: USAJOBS_API_KEY and USAJOBS_USER_AGENT or USAJOBS_EMAIL are required');
    }
    const queries = Array.isArray(entry.queries) && entry.queries.length ? entry.queries : ['Technical Consultant'];
    const maxPages = Math.max(1, Math.min(Number(entry.maxPages) || 1, 5));
    const pageSize = Math.max(1, Math.min(Number(entry.pageSize) || DEFAULT_PAGE_SIZE, 100));
    const out = [];
    for (const query of queries) {
      for (let page = 1; page <= maxPages; page++) {
        const url = new URL(API_URL);
        url.searchParams.set('Keyword', String(query));
        url.searchParams.set('LocationName', 'United States');
        url.searchParams.set('ResultsPerPage', String(pageSize));
        url.searchParams.set('Page', String(page));
        const json = await ctx.fetchJson(url.href, {
          headers: {
            Host: 'data.usajobs.gov',
            'User-Agent': userAgent,
            'Authorization-Key': apiKey,
          },
          redirect: 'error',
        });
        const jobs = json?.SearchResult?.SearchResultItems;
        if (!Array.isArray(jobs)) break;
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
