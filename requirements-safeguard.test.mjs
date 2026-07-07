#!/usr/bin/env node

import { evaluateFreshnessGate, evaluateRequirementsSafeguard } from './scan.mjs';

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

const config = {
  enabled: true,
  manual_review_on_doubt: true,
  max_required_years: 3,
  entry_level_signals: ['junior', 'associate', 'entry level', 'early career', 'new grad', '0-2 years', '1-3 years'],
  senior_title_terms: ['senior', 'lead', 'staff', 'principal', 'manager', 'director', 'architect'],
  senior_requirement_patterns: ['lead a team', 'set technical direction', 'mentor junior'],
  sponsorship_reject_patterns: ['no sponsorship', 'visa sponsorship is not available', 'authorized to work without sponsorship', 'now or in the future'],
};

function job(overrides = {}) {
  return {
    title: 'Associate Solutions Engineer',
    company: 'Acme',
    location: 'Remote, US',
    description: 'Early career role for an associate solutions engineer. Requirements include 0-2 years of experience, demos, discovery, implementation, and customer enablement.',
    ...overrides,
  };
}

eq(
  'associate early-career role passes',
  evaluateRequirementsSafeguard(job(), config).status,
  'pass',
);

eq(
  'Associate Solutions Consultant is accepted when other filters pass',
  evaluateRequirementsSafeguard(job({
    title: 'Associate Solutions Consultant',
    description: 'Associate role for early career candidates with 0-2 years of experience, demos, discovery, and implementation support.',
  }), config).status,
  'pass',
);

eq(
  'senior title is rejected',
  evaluateRequirementsSafeguard(job({ title: 'Senior Solutions Engineer' }), config).status,
  'reject',
);

eq(
  'architect title is rejected even when solution aligned',
  evaluateRequirementsSafeguard(job({ title: 'Associate Solution Architect' }), config).status,
  'reject',
);

eq(
  'more than 3 years is rejected without entry signal',
  evaluateRequirementsSafeguard(job({
    title: 'Solutions Engineer',
    description: 'Requires 5+ years of professional experience in enterprise pre-sales and SaaS implementation.',
  }), config).status,
  'reject',
);

eq(
  'entry title with senior requirements is manual review',
  evaluateRequirementsSafeguard(job({
    title: 'Junior Solutions Engineer',
    description: 'Junior title, but this person will lead a team, set technical direction, and own executive architecture reviews.',
  }), config).status,
  'manual_review',
);

eq(
  'explicit no sponsorship language is rejected',
  evaluateRequirementsSafeguard(job({
    description: 'Associate role. Applicants must be authorized to work without sponsorship now or in the future.',
  }), config).status,
  'reject',
);

eq(
  'no sponsorship job is rejected even when title is strong match',
  evaluateRequirementsSafeguard(job({
    title: 'Associate Solutions Consultant',
    description: 'Associate Solutions Consultant role with customer demos. Visa sponsorship is not available for this role.',
  }), config).status,
  'reject',
);

eq(
  'no entry signal and no <=3 years evidence is manual review',
  evaluateRequirementsSafeguard(job({
    title: 'Solutions Engineer',
    description: 'Build demos, run discovery, partner with customers, and support implementation work.',
  }), config).status,
  'manual_review',
);

const nowMs = Date.parse('2026-07-07T12:00:00Z');

eq(
  'job posted 6 days ago passes freshness',
  evaluateFreshnessGate({ postedAt: Date.parse('2026-07-01T12:00:00Z') }, { maxJobAgeDays: 7, nowMs }).status,
  'pass',
);

eq(
  'job posted 8 days ago fails freshness',
  evaluateFreshnessGate({ postedAt: Date.parse('2026-06-29T12:00:00Z') }, { maxJobAgeDays: 7, nowMs }).status,
  'reject',
);

eq(
  'job with missing posting date does not auto-pass',
  evaluateFreshnessGate({}, { maxJobAgeDays: 7, nowMs }).status,
  'manual_review',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
