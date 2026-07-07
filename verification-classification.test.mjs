#!/usr/bin/env node

import { classifyVerificationPage, shouldSaveToReview, verifyLiveOffer } from './scan.mjs';

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

function offer(source = 'fakefuture-api') {
  return {
    source,
    url: 'https://jobs.example/apply/123',
    title: 'Solutions Engineer',
    company: 'ExampleCo',
    location: 'Remote, US',
    postedAt: Date.parse('2026-07-05T00:00:00Z'),
  };
}

const liveBody = 'A normal job page with role details, responsibilities, qualifications, benefits, compensation, and application instructions. '.repeat(6);

eq(
  'verified page classifies as verified_live',
  classifyVerificationPage(offer(), { ok: true, method: 'http', status: 200, finalUrl: 'https://jobs.example/apply/123', bodyText: liveBody }).classification,
  'verified_live',
);
eq(
  'HTTP 403 classifies as bot_blocked',
  classifyVerificationPage(offer(), { ok: true, method: 'http', status: 403, finalUrl: 'https://jobs.example/apply/123', bodyText: 'Forbidden' }).classification,
  'bot_blocked',
);
eq(
  'captcha classifies as human_gated',
  classifyVerificationPage(offer(), { ok: true, method: 'http', status: 200, finalUrl: 'https://jobs.example/apply/123', bodyText: 'Please complete captcha to continue' }).classification,
  'human_gated',
);
eq(
  'login page classifies as account_required',
  classifyVerificationPage(offer(), { ok: true, method: 'http', status: 200, finalUrl: 'https://jobs.example/apply/123', bodyText: 'Sign in or create an account to apply' }).classification,
  'account_required',
);
eq(
  'expired page classifies as expired_or_dead',
  classifyVerificationPage(offer(), { ok: true, method: 'http', status: 200, finalUrl: 'https://jobs.example/apply/123', bodyText: 'This job is no longer accepting applications' }).classification,
  'expired_or_dead',
);
eq(
  'fetch failure classifies as unknown_unverified',
  classifyVerificationPage(offer(), { ok: false, method: 'http', status: 0, finalUrl: 'https://jobs.example/apply/123', bodyText: '', error: 'network failed' }).classification,
  'unknown_unverified',
);

eq(
  'review flags default false',
  shouldSaveToReview('bot_blocked', 'jooble-api', {}),
  false,
);
eq(
  'global review flag enables class',
  shouldSaveToReview('bot_blocked', 'jooble-api', { SAVE_BOT_BLOCKED_TO_REVIEW: 'true' }),
  true,
);
eq(
  'provider-specific flag overrides global true',
  shouldSaveToReview('bot_blocked', 'adzuna-api', { SAVE_BOT_BLOCKED_TO_REVIEW: 'true', ADZUNA_SAVE_BOT_BLOCKED_TO_REVIEW: 'false' }),
  false,
);
eq(
  'provider-specific flag overrides global false',
  shouldSaveToReview('human_gated', 'jooble-api', { SAVE_HUMAN_GATED_TO_REVIEW: 'false', JOOBLE_SAVE_HUMAN_GATED_TO_REVIEW: 'true' }),
  true,
);
eq(
  'expired jobs never go to review',
  shouldSaveToReview('expired_or_dead', 'jooble-api', { JOOBLE_SAVE_UNKNOWN_UNVERIFIED_TO_REVIEW: 'true' }),
  false,
);
eq(
  'duplicates never go to review',
  shouldSaveToReview('duplicate', 'fakefuture-api', { SAVE_UNKNOWN_UNVERIFIED_TO_REVIEW: 'true' }),
  false,
);

const joobleBlocked = await verifyLiveOffer(offer('jooble-api'), {
  nowMs: Date.parse('2026-07-06T00:00:00Z'),
  fetchPage: async (_url, opts = {}) => {
    if (!opts.browserLike) return { ok: true, method: 'http', status: 403, finalUrl: 'https://jooble.org/away/123', bodyText: 'Forbidden' };
    return { ok: true, method: 'http-browser-headers', status: 403, finalUrl: 'https://jooble.org/away/123', bodyText: 'Access denied' };
  },
  playwrightVerify: async (url) => ({ ok: true, method: 'playwright', status: 403, finalUrl: url, bodyText: 'Access denied' }),
});
eq('Jooble follows generic bot-blocked classification', joobleBlocked.offer.classification, 'bot_blocked');

const futureProvider = await verifyLiveOffer(offer('newprovider-api'), {
  nowMs: Date.parse('2026-07-06T00:00:00Z'),
  fetchPage: async (_url) => ({ ok: true, method: 'http', status: 200, finalUrl: 'https://jobs.example/apply/123', bodyText: 'Register to apply for this job' }),
});
eq('Future provider inherits generic account-required classification', futureProvider.offer.classification, 'account_required');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
