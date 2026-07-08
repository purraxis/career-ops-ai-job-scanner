#!/usr/bin/env node

import {
  evaluateFreshnessGate,
  evaluateRequirementsSafeguard,
  joobleJobAgeDecision,
  parseYearRequirement,
} from './scan.mjs';

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
  senior_title_terms: ['senior', 'lead', 'staff', 'principal', 'manager', 'director', 'architect', 'head of'],
  senior_requirement_patterns: ['lead a team', 'set technical direction', 'mentor junior'],
  sponsorship_reject_patterns: ['no sponsorship', 'visa sponsorship is not available', 'authorized to work without sponsorship', 'now or in the future', 'must be a us citizen', 'active security clearance', 'security clearance required', 'clearance required'],
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

function safeguard(overrides = {}, options = {}) {
  return evaluateRequirementsSafeguard(job(overrides), config, {
    source: 'greenhouse-api',
    roleTierMatch: { tier: 'tier_1_priority', title: overrides.title || 'Associate Solutions Engineer' },
    ...options,
  });
}

eq(
  'associate early-career role passes',
  safeguard().status,
  'pass',
);

eq(
  'Associate Solutions Consultant is accepted when other filters pass',
  safeguard({
    title: 'Associate Solutions Consultant',
    description: 'Associate role for early career candidates with 0-2 years of experience, demos, discovery, and implementation support.',
  }).status,
  'pass',
);

eq(
  'senior title is rejected',
  safeguard({ title: 'Senior Solutions Engineer' }).status,
  'reject',
);

eq(
  'architect title is rejected even when solution aligned',
  safeguard({ title: 'Associate Solution Architect' }).status,
  'reject',
);

eq(
  'more than 3 years is rejected without entry signal',
  safeguard({
    title: 'Solutions Engineer',
    description: 'Requires 5+ years of professional experience in enterprise pre-sales and SaaS implementation.',
  }).status,
  'reject',
);

eq(
  'entry title with senior requirements is manual review',
  safeguard({
    title: 'Junior Solutions Engineer',
    description: 'Junior title, but this person will lead a team, set technical direction, and own executive architecture reviews.',
  }).status,
  'manual_review',
);

eq(
  'explicit no sponsorship language is rejected',
  safeguard({
    description: 'Associate role. Applicants must be authorized to work without sponsorship now or in the future.',
  }).status,
  'reject',
);

eq(
  'no sponsorship job is rejected even when title is strong match',
  safeguard({
    title: 'Associate Solutions Consultant',
    description: 'Associate Solutions Consultant role with customer demos. Visa sponsorship is not available for this role.',
  }).status,
  'reject',
);

eq(
  'no entry signal and no <=3 years evidence is manual review',
  safeguard({
    title: 'Solutions Engineer',
    description: 'Build demos, run discovery, partner with customers, and support implementation work.',
  }, { source: 'greenhouse-api', roleTierMatch: { tier: 'tier_1_priority', title: 'Solutions Engineer' } }).status,
  'manual_review',
);

eq('2+ years of experience is accepted', parseYearRequirement('2+ years of experience', { maxRequiredYears: 3 }).decision, 'acceptable');
eq('3+ years of experience is accepted', parseYearRequirement('3+ years of experience', { maxRequiredYears: 3 }).decision, 'acceptable');
eq('1-3 years of experience is accepted', parseYearRequirement('1-3 years of experience', { maxRequiredYears: 3 }).decision, 'acceptable');
eq('minimum of 3 years is accepted', parseYearRequirement('minimum of 3 years of experience', { maxRequiredYears: 3 }).decision, 'acceptable');
eq('4+ years of experience is rejected', parseYearRequirement('4+ years of experience', { maxRequiredYears: 3 }).decision, 'reject');
eq('5+ years of experience is rejected', parseYearRequirement('5+ years of experience', { maxRequiredYears: 3 }).decision, 'reject');
eq('2-4 years of experience is rejected', parseYearRequirement('2-4 years of experience', { maxRequiredYears: 3 }).decision, 'reject');

eq(
  'senior role with missing posted_at is rejected, not reviewed',
  safeguard({ title: 'Senior Solutions Engineer', description: 'Customer-facing technical role.' }).status,
  'reject',
);

eq(
  'staff role with missing posted_at is rejected, not reviewed',
  safeguard({ title: 'Staff Solutions Engineer', description: 'Customer-facing technical role.' }).status,
  'reject',
);

eq(
  'head of role with missing posted_at is rejected, not reviewed',
  safeguard({ title: 'Head of Customer Engineering', description: 'Customer-facing technical role.' }).status,
  'reject',
);

eq(
  'US citizen language is rejected before manual review',
  safeguard({ description: 'Applicants must be a US citizen for this customer-facing role.' }).status,
  'reject',
);

eq(
  'clearance language is rejected before manual review',
  safeguard({ description: 'Active security clearance required for this customer-facing role.' }).status,
  'reject',
);

eq(
  'clearance required title is rejected before manual review',
  safeguard({ title: 'Solutions Engineer (Clearance Required)', description: 'Customer-facing technical role.' }).status,
  'reject',
);

eq(
  'Jooble URL with jobAge=105 is rejected',
  joobleJobAgeDecision({ url: 'https://jooble.org/away/foo?jobAge=105' }, 7).status,
  'reject',
);

eq(
  'Jooble URL with jobAge=3 may continue',
  joobleJobAgeDecision({ url: 'https://jooble.org/away/foo?jobAge=3' }, 7).status,
  'pass',
);

eq(
  'direct ATS job with strong title and unclear years can go to manual review',
  safeguard({
    title: 'Solutions Engineer',
    description: 'Run discovery, demos, and implementation work with customers.',
  }, { source: 'ashby-api', roleTierMatch: { tier: 'tier_1_priority', title: 'Solutions Engineer' } }).status,
  'manual_review',
);

eq(
  'direct ATS strong title with missing description uses missing-description reason',
  safeguard({
    title: 'Solutions Engineer',
    description: '',
  }, { source: 'ashby-api', roleTierMatch: { tier: 'tier_1_priority', title: 'Solutions Engineer' } }).reason,
  'missing_description_for_year_detection',
);

eq(
  'aggregator job with broad title and unclear years is rejected',
  safeguard({
    title: 'Business Analyst',
    description: 'Work with customers and internal stakeholders.',
  }, { source: 'jooble-api', roleTierMatch: { tier: 'tier_3_broad_fallback', title: 'Business Analyst' } }).status,
  'reject',
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
