#!/usr/bin/env node

import { verifyLiveOffer } from './scan.mjs';

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

const liveBody = 'A real job application page with a complete description, responsibilities, qualifications, benefits, and apply instructions. '.repeat(6);
const expiredBody = 'This job has expired and is no longer accepting applications. '.repeat(10);

function joobleOffer(overrides = {}) {
  return {
    source: 'jooble-api',
    url: 'https://jooble.org/away/123?p=1',
    title: 'Solutions Engineer',
    company: 'Acme',
    location: 'Remote, US',
    postedAt: Date.parse('2026-07-05T00:00:00Z'),
    ...overrides,
  };
}

const recoveredCalls = [];
const recovered = await verifyLiveOffer(joobleOffer(), {
  nowMs: Date.parse('2026-07-06T00:00:00Z'),
  fetchPage: async (url, opts = {}) => {
    recoveredCalls.push({ url, opts });
    if (!opts.browserLike) {
      return { ok: true, method: 'http', status: 403, finalUrl: url, bodyText: 'Forbidden' };
    }
    return {
      ok: true,
      method: 'http-browser-headers',
      status: 200,
      finalUrl: 'https://company.example/jobs/solutions-engineer',
      bodyText: liveBody,
    };
  },
  playwrightVerify: async () => {
    throw new Error('playwright should not be called after browser-header success');
  },
});
eq('Jooble 403 recovers through browser-header fallback', recovered.status, 'verified');
eq('Jooble recovery method is browser headers', recovered.offer.verificationMethod, 'http-browser-headers');
eq('Jooble browser-header fallback was attempted', recoveredCalls.length, 2);
eq('Jooble browser-header fallback uses referer', recoveredCalls[1].opts.referer, 'https://jooble.org/');

const redirectRecovered = await verifyLiveOffer(joobleOffer(), {
  nowMs: Date.parse('2026-07-06T00:00:00Z'),
  fetchPage: async (_url, opts = {}) => {
    if (!opts.browserLike) {
      return {
        ok: true,
        method: 'http',
        status: 200,
        finalUrl: 'https://jooble.org/jobs',
        bodyText: liveBody,
      };
    }
    return {
      ok: true,
      method: 'http-browser-headers',
      status: 200,
      finalUrl: 'https://employer.example/apply/123',
      bodyText: liveBody,
    };
  },
  playwrightVerify: async () => {
    throw new Error('playwright should not be called after redirect fallback success');
  },
});
eq('Jooble generic redirect recovers through browser-header fallback', redirectRecovered.status, 'verified');
eq('Jooble redirect final URL retained', redirectRecovered.offer.finalUrl, 'https://employer.example/apply/123');

const stillBlocked = await verifyLiveOffer(joobleOffer(), {
  nowMs: Date.parse('2026-07-06T00:00:00Z'),
  fetchPage: async (_url, opts = {}) => {
    if (!opts.browserLike) return { ok: true, method: 'http', status: 403, finalUrl: 'https://jooble.org/away/123?p=1', bodyText: 'Forbidden' };
    return { ok: true, method: 'http-browser-headers', status: 403, finalUrl: 'https://jooble.org/away/123?p=1', bodyText: 'Access denied' };
  },
  playwrightVerify: async (url) => ({
    ok: true,
    method: 'playwright',
    status: 403,
    finalUrl: url,
    bodyText: 'Access denied. Please complete the captcha.',
  }),
});
eq('Jooble remains rejected when all fallbacks are blocked', stillBlocked.status, 'rejected');
eq('Jooble blocked rejection records playwright method', stillBlocked.offer.verificationMethod, 'playwright');
ok('Jooble blocked rejection gives reason', /HTTP 403|blocked page text|human-gated page text/.test(stillBlocked.offer.rejectionReason));

const expired = await verifyLiveOffer(joobleOffer(), {
  nowMs: Date.parse('2026-07-06T00:00:00Z'),
  fetchPage: async (_url, opts = {}) => {
    if (!opts.browserLike) return { ok: true, method: 'http', status: 403, finalUrl: 'https://jooble.org/away/123?p=1', bodyText: 'Forbidden' };
    return { ok: true, method: 'http-browser-headers', status: 200, finalUrl: 'https://company.example/jobs/old', bodyText: expiredBody };
  },
  playwrightVerify: async () => {
    throw new Error('playwright should not be called after expired browser-header page');
  },
});
eq('Jooble expired page remains rejected', expired.status, 'rejected');
ok('Jooble expired page reason is explicit', /expired page text/.test(expired.offer.rejectionReason));

const adzunaCalls = [];
const adzuna = await verifyLiveOffer({
  source: 'adzuna-api',
  url: 'https://www.adzuna.com/details/123',
  title: 'Solutions Engineer',
  company: 'Acme',
  postedAt: Date.parse('2026-07-05T00:00:00Z'),
}, {
  nowMs: Date.parse('2026-07-06T00:00:00Z'),
  fetchPage: async (url, opts = {}) => {
    adzunaCalls.push({ url, opts });
    if (!opts.browserLike) return { ok: true, method: 'http', status: 403, finalUrl: url, bodyText: 'Forbidden' };
    return { ok: true, method: 'http-browser-headers', status: 403, finalUrl: url, bodyText: 'Access denied' };
  },
  playwrightVerify: async (url) => ({ ok: true, method: 'playwright', status: 403, finalUrl: url, bodyText: 'Access denied' }),
});
eq('Adzuna 403 uses generic fallback and remains rejected', adzuna.status, 'rejected');
eq('Adzuna attempted browser-header fallback', adzunaCalls.length, 2);
eq('Adzuna final method records playwright fallback', adzuna.offer.verificationMethod, 'playwright');
eq('Adzuna rejected as bot blocked', adzuna.offer.classification, 'bot_blocked');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
