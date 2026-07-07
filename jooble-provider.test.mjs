#!/usr/bin/env node

import jooble, { normalizeJoobleJob } from './providers/jooble.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}

function ok(label, condition) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

const sample = {
  id: 12345,
  title: 'Solutions Engineer',
  company: 'Acme SaaS',
  location: 'Remote, US',
  snippet: 'Customer-facing API implementation role.',
  salary: '$75,000 - $95,000',
  type: 'Full-time',
  link: 'https://example.com/jobs/solutions-engineer?ref=jooble',
  updated: '2026-07-05T12:00:00Z',
};

const normalized = normalizeJoobleJob(sample);
eq('normalizes Jooble source', normalized.source, 'jooble');
eq('normalizes external id', normalized.external_id, 'jooble:12345');
eq('normalizes title', normalized.title, 'Solutions Engineer');
eq('normalizes company', normalized.company, 'Acme SaaS');
eq('normalizes location', normalized.location, 'Remote, US');
eq('normalizes description from snippet', normalized.description, 'Customer-facing API implementation role.');
eq('normalizes employment type', normalized.employment_type, 'Full-time');
eq('normalizes apply URL', normalized.url, 'https://example.com/jobs/solutions-engineer?ref=jooble');
eq('parses salary minimum', normalized.salary.min, 75000);
eq('parses salary maximum', normalized.salary.max, 95000);
ok('parses updated date', Number.isFinite(normalized.postedAt));

const fallbackId = normalizeJoobleJob({ ...sample, id: undefined });
ok('builds fallback external id when Jooble id missing', /^jooble:[0-9a-f]{8}$/.test(fallbackId.external_id));

const invalid = normalizeJoobleJob({ ...sample, title: '', link: 'not a url' });
eq('drops invalid Jooble jobs', invalid, null);

const previousKey = process.env.JOOBLE_API_KEY;
delete process.env.JOOBLE_API_KEY;
try {
  await jooble.fetch({ queries: ['Solutions Engineer'] }, { fetchJson: async () => ({ jobs: [] }) });
  ok('missing API key should throw', false);
} catch (err) {
  ok('missing API key is non-fatal disabled_missing_credentials signal', String(err.message).includes('disabled_missing_credentials'));
}

process.env.JOOBLE_API_KEY = 'test-key';
const requests = [];
const jobs = await jooble.fetch(
  { queries: ['Solutions Engineer'], location: 'Remote', radius: '40', maxPages: 1, pageSize: 20 },
  {
    fetchJson: async (_url, opts) => {
      requests.push(JSON.parse(opts.body));
      return { totalCount: 1, jobs: [sample] };
    },
  },
);
eq('fetch returns normalized jobs', jobs.length, 1);
eq('uses ResultOnPage request field', requests[0].ResultOnPage, 20);
eq('uses companysearch false', requests[0].companysearch, 'false');
eq('uses configured radius', requests[0].radius, '40');
eq('uses configured location', requests[0].location, 'Remote');

try {
  await jooble.fetch(
    { queries: ['Solutions Engineer'] },
    {
      fetchJson: async () => {
        const err = new Error('HTTP 403');
        err.status = 403;
        throw err;
      },
    },
  );
  ok('403 should throw mapped error', false);
} catch (err) {
  eq('maps 403 to invalid/unauthorized key', err.message, 'invalid_or_unauthorized_jooble_api_key');
}

if (previousKey === undefined) delete process.env.JOOBLE_API_KEY;
else process.env.JOOBLE_API_KEY = previousKey;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
