#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner with a plugin-based provider layer.
 *
 * Providers live in providers/*.mjs and are loaded at startup. Each provider
 * exports a default object with:
 *   - id: string — matched against `provider:` in portals.yml
 *   - detect(entry): {url}|null — optional auto-detection from careers_url
 *   - fetch(entry, ctx): [{title,url,company,location}] — required
 *
 * Files prefixed with _ are shared helpers (e.g. _http.mjs) and are never
 * loaded as providers. Adding a new HTTP/API source = drop a *.mjs into
 * providers/. Local executable parsers use `providers/local-parser.mjs` when
 * `parser.command` + `parser.script` are set in portals.yml.
 *
 * A tracked_companies entry can set `provider:` explicitly to bypass
 * URL-based auto-detection. The `transport:` field is reserved for future
 * transports — Phase A only ships the http transport.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --verify         # Playwright-check each new URL; drop expired postings
 *   node scan.mjs --verify --headed-fallback  # retry anti-bot-blocked URLs in a headed browser (needs a display)
 *   node scan.mjs --verify --throttle          # jittered ~5-10s gap between checks (stay under rate limits)
 *   node scan.mjs --verify --throttle=8000     # custom base gap in ms (waits base..2*base)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';
import 'dotenv/config';

import { makeHttpCtx } from './providers/_http.mjs';
import { buildTrustValidator } from './providers/_trust-validator.mjs';
import { mergeProviderPlugins } from './plugins/_engine.mjs';

const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || 'config/profile.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const REJECTED_JOBS_PATH = 'data/rejected-jobs.tsv';
const NEEDS_REVIEW_PATH = 'data/needs-review.md';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const PROVIDERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'providers');

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const DEFAULT_VERIFY_LIVE_JOBS = true;
const DEFAULT_MAX_JOB_AGE_DAYS = 7;
const LIVE_VERIFY_TIMEOUT_MS = 12_000;
const DEFAULT_REQUIREMENTS_SAFEGUARD_PATH = 'config/job_safeguards.yml';

// ── Provider loading ────────────────────────────────────────────────

async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;
  // Alphabetical order so detect() priority is deterministic across machines.
  const entries = readdirSync(dir)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();
  for (const file of entries) {
    const full = path.join(dir, file);
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      console.error(`⚠️  ${file}: failed to load — ${err.message}`);
      continue;
    }
    const p = mod.default;
    if (!p || typeof p.fetch !== 'function' || !p.id) {
      console.error(`⚠️  ${file}: skipping — default export must be { id, fetch }`);
      continue;
    }
    if (providers.has(p.id)) {
      console.error(`⚠️  ${file}: duplicate provider id "${p.id}" — keeping first`);
      continue;
    }
    providers.set(p.id, p);
  }
  return providers;
}

// Resolve which provider handles a tracked_companies entry.
// 1. Explicit `provider:` field wins (skips detect()).
// 2. local-parser when parser.command + script are configured (before API detect).
// 3. Otherwise each provider's detect() runs in load order; first hit wins.
function resolveProvider(entry, providers, { skipIds = [] } = {}) {
  if (entry.provider) {
    const p = providers.get(entry.provider);
    if (!p) return { error: `unknown provider: ${entry.provider}` };
    return { provider: p };
  }

  const localParser = providers.get('local-parser');
  if (localParser && !skipIds.includes('local-parser')) {
    try {
      const hit = localParser.detect?.(entry);
      if (hit) return { provider: localParser };
    } catch (err) {
      console.error(`⚠️  local-parser: detect() threw for "${entry.name}" — ${err.message}`);
    }
  }

  for (const p of providers.values()) {
    if (skipIds.includes(p.id)) continue;
    let hit;
    try {
      hit = p.detect?.(entry);
    } catch (err) {
      console.error(`⚠️  ${p.id}: detect() threw for "${entry.name}" — ${err.message}`);
      continue;
    }
    if (hit) return { provider: p };
  }
  return null;
}

// ── Title filter ────────────────────────────────────────────────────

// Compile a lowercased keyword into a matcher. Short all-letter acronyms
// (2-3 chars: cfo, coo, sdr, bdr, gsi…) match on WORD BOUNDARIES so "COO" no
// longer matches "Coordinator", "SDR" no longer matches anything mid-word, etc.
// Multi-word phrases and keywords containing non-letters (".NET", "SAP ",
// "L&D") keep fast, permissive substring matching.
export function compileKeyword(kw) {
  if (/^[a-z]{2,3}$/.test(kw)) {
    const re = new RegExp(`\\b${kw}\\b`);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

export function buildTitleFilter(titleFilter) {
  // Normalize defensively: a malformed title_filter (a null, numeric, or otherwise
  // non-string entry in the YAML) must not crash the scan via k.toLowerCase().
  const normalize = (arr) => (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 0)
    .map(compileKeyword);
  const positive = normalize(titleFilter?.positive);
  const negative = normalize(titleFilter?.negative);

  return (title) => {
    const lower = (title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(m => m(lower));
    const hasNegative = negative.some(m => m(lower));
    return hasPositive && !hasNegative;
  };
}

function dedupeStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function roleTierTitles(config = {}, tierNames = ['tier_1_priority', 'tier_2_strong_fit', 'tier_3_broad_fallback']) {
  const tiers = config.role_tiers && typeof config.role_tiers === 'object' ? config.role_tiers : {};
  return dedupeStrings(tierNames.flatMap(name => Array.isArray(tiers[name]) ? tiers[name] : []));
}

function buildRoleTierClassifier(config = {}) {
  const tiers = config.role_tiers && typeof config.role_tiers === 'object' ? config.role_tiers : {};
  const ordered = [
    ['tier_1_priority', dedupeStrings(tiers.tier_1_priority)],
    ['tier_2_strong_fit', dedupeStrings(tiers.tier_2_strong_fit)],
    ['tier_3_broad_fallback', dedupeStrings(tiers.tier_3_broad_fallback)],
  ].map(([tier, titles]) => [tier, titles.map(t => ({ title: t, match: compileKeyword(t.toLowerCase()) }))]);
  return (title) => {
    const lower = String(title || '').toLowerCase();
    for (const [tier, matchers] of ordered) {
      const hit = matchers.find(({ match }) => match(lower));
      if (hit) return { tier, title: hit.title };
    }
    return { tier: '', title: '' };
  };
}

function buildEffectiveTitleFilter(config = {}) {
  const titleFilter = config.title_filter || {};
  const positive = dedupeStrings([
    ...(Array.isArray(titleFilter.positive) ? titleFilter.positive : []),
    ...roleTierTitles(config),
  ]);
  return buildTitleFilter({ ...titleFilter, positive });
}

function buildTier3DescriptionGate(config = {}) {
  const scoring = config.role_scoring || {};
  const positive = normalizeKeywordList(scoring.tier_3_description_boost_keywords || [
    'demo',
    'discovery',
    'technical sales',
    'pre-sales',
    'proof of concept',
    'proof of value',
    'implementation',
    'onboarding',
    'customer enablement',
    'saas',
    'salesforce',
    'servicenow',
    'workflow automation',
    'ai automation',
    'genai',
    'llm',
    'api',
    'apis',
    'sql',
    'dashboard',
    'dashboards',
    'cloud',
    'value engineering',
    'roi',
    'stakeholder management',
  ]);
  const negative = normalizeKeywordList(scoring.tier_3_reject_keywords || [
    'help desk',
    'hardware service',
    'mechanical',
    'electrical field service',
    'field service technician',
    'desktop support',
    'it support only',
  ]);
  return (job) => {
    const description = typeof job.description === 'string' ? job.description.toLowerCase() : '';
    if (!description.trim()) return false;
    if (negative.some(k => description.includes(k))) return false;
    return positive.some(k => description.includes(k));
  };
}

// ── Location filter ─────────────────────────────────────────────────
// Optional. If `location_filter` is absent from portals.yml, all locations pass.
// Semantics (case-insensitive substring, in this order):
//   - Empty / whitespace-only / non-string location → pass (don't penalize
//     missing or malformed provider data)
//   - `always_allow` matches → pass (takes precedence over `block` — lets a
//     multi-location string like "Remote, Belgium or France" through because
//     the home region is an option, even though "france" is blocked)
//   - `block` matches → reject
//   - `allow` empty → pass (already cleared block)
//   - `allow` non-empty → must match at least one keyword

// Normalize a keyword list from portals.yml: tolerates a bare string
// (wrapped to a 1-item array), null/undefined (→ []), and non-string
// entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise
// match every location via String.includes(''), silently bypassing the
// other tiers.
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.length > 0 && alwaysAllow.some(k => lower.includes(k))) return true;
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some(k => lower.includes(k));
  };
}

// ── Content filter ──────────────────────────────────────────────────
// Optional. If `content_filter` is absent from portals.yml, all jobs pass.
// Filters on the job DESCRIPTION text to separate same-titled roles with
// different stacks (a "Software Engineer" listing that mentions "PHP" vs one
// that mentions "Rust"). Semantics (case-insensitive substring, in order):
//   - Empty / whitespace-only / non-string description → PASS. The scanner is
//     zero-token and only sees descriptions a provider already returns in its
//     list payload; providers without one must never be silently dropped.
//   - any `negative` keyword present → reject
//   - `positive` empty → pass (already cleared negatives)
//   - `positive` non-empty → at least one keyword must be present
//
// Provider support: only providers whose list API ships the description for
// free (no extra per-job request, which would break the zero-token design)
// populate `job.description`. Lever (`descriptionPlain`) does today; others
// leave it empty and therefore always pass this filter.

export function buildContentFilter(contentFilter) {
  if (!contentFilter) return () => true;
  const positive = normalizeKeywordList(contentFilter.positive);
  const negative = normalizeKeywordList(contentFilter.negative);

  return (description) => {
    if (typeof description !== 'string' || description.trim() === '') return true;
    const lower = description.toLowerCase();
    if (negative.length > 0 && negative.some(k => lower.includes(k))) return false;
    if (positive.length === 0) return true;
    return positive.some(k => lower.includes(k));
  };
}

const DEFAULT_WORK_AUTH_REJECT_PATTERNS = [
  /no sponsorship/i,
  /unable to sponsor/i,
  /does not sponsor/i,
  /must not require sponsorship/i,
  /permanent work authorization required/i,
  /green card holder/i,
  /must be a green card holder/i,
  /u\.?s\.? citizen or green card/i,
  /u\.?s\.? citizens? only/i,
  /must be a u\.?s\.? citizen/i,
  /active security clearance/i,
  /security clearance required/i,
  /\bts\/sci\b/i,
  /\bsecret clearance\b/i,
];

function buildWorkAuthorizationFilter(config = {}) {
  const terms = Array.isArray(config.work_authorization_filter?.reject_if_explicit)
    ? config.work_authorization_filter.reject_if_explicit.filter(t => typeof t === 'string' && t.trim())
    : [];
  const patterns = terms.length
    ? terms.map(t => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    : DEFAULT_WORK_AUTH_REJECT_PATTERNS;
  return (job) => {
    const text = [job.title, job.description, job.location].filter(Boolean).join(' ');
    return !patterns.some(pattern => pattern.test(text));
  };
}

const DEFAULT_REQUIREMENTS_SAFEGUARD = {
  enabled: true,
  manual_review_on_doubt: true,
  max_required_years: 3,
  entry_level_signals: [
    'junior',
    'associate',
    'entry level',
    'entry-level',
    'early career',
    'new grad',
    'new graduate',
    'university graduate',
    'graduate program',
    'campus',
    'academy',
    'rotational',
    '0-2 years',
    '0 to 2 years',
    '1-2 years',
    '1 to 2 years',
    '0-3 years',
    '1-3 years',
  ],
  senior_title_terms: [
    'senior',
    'sr.',
    'sr',
    'lead',
    'staff',
    'principal',
    'manager',
    'director',
    'architect',
    'head of',
    'vp',
    'vice president',
    'executive',
  ],
  senior_requirement_patterns: [
    'mentor junior',
    'mentoring junior',
    'lead a team',
    'lead technical strategy',
    'own technical strategy',
    'set technical direction',
    'architecture ownership',
    'enterprise architecture',
    'manage a team',
    'people management',
    'quota carrying account executive',
  ],
  sponsorship_reject_patterns: [
    'no sponsorship',
    'visa sponsorship is not available',
    'sponsorship is not available',
    'unable to sponsor',
    'does not sponsor',
    'will not sponsor',
    'cannot sponsor',
    'h1b sponsorship is not available',
    'h-1b sponsorship is not available',
    'no h1b sponsorship',
    'no h-1b sponsorship',
    'must not require sponsorship',
    'without sponsorship',
    'authorized to work without sponsorship',
    'authorized to work in the united states without sponsorship',
    'permanent work authorization required',
    'green card holder',
    'must be a green card holder',
    'u.s. citizen or green card',
    'us citizen or green card',
    'now or in the future',
    'u.s. citizen only',
    'us citizen only',
    'must be a u.s. citizen',
    'must be a us citizen',
    'active security clearance',
    'security clearance required',
    'secret clearance',
    'ts/sci',
  ],
};

function loadRequirementsSafeguard(config = {}) {
  const inline = config.requirements_safeguard && typeof config.requirements_safeguard === 'object'
    ? config.requirements_safeguard
    : {};
  const filePath = typeof inline.file === 'string' && inline.file.trim()
    ? inline.file.trim()
    : DEFAULT_REQUIREMENTS_SAFEGUARD_PATH;
  let fileConfig = {};
  if (existsSync(filePath)) {
    try {
      const loaded = yaml.load(readFileSync(filePath, 'utf-8'));
      if (loaded && typeof loaded === 'object') fileConfig = loaded;
    } catch (err) {
      console.error(`Warning: could not load requirements safeguard file ${filePath}: ${err.message}`);
    }
  }
  const merged = {
    ...DEFAULT_REQUIREMENTS_SAFEGUARD,
    ...fileConfig,
    ...inline,
    file: filePath,
  };
  for (const key of ['entry_level_signals', 'senior_title_terms', 'senior_requirement_patterns', 'sponsorship_reject_patterns']) {
    merged[key] = dedupeStrings([
      ...(Array.isArray(DEFAULT_REQUIREMENTS_SAFEGUARD[key]) ? DEFAULT_REQUIREMENTS_SAFEGUARD[key] : []),
      ...(Array.isArray(fileConfig[key]) ? fileConfig[key] : []),
      ...(Array.isArray(inline[key]) ? inline[key] : []),
    ]);
  }
  const maxRequiredYears = Number(merged.max_required_years ?? DEFAULT_REQUIREMENTS_SAFEGUARD.max_required_years);
  merged.max_required_years = Number.isFinite(maxRequiredYears) ? maxRequiredYears : DEFAULT_REQUIREMENTS_SAFEGUARD.max_required_years;
  merged.enabled = merged.enabled !== false && merged.enabled !== 'false';
  merged.manual_review_on_doubt = merged.manual_review_on_doubt !== false && merged.manual_review_on_doubt !== 'false';
  return merged;
}

function phrasePattern(phrase) {
  const escaped = String(phrase || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return null;
  return new RegExp(`(^|[^a-z0-9])${escaped.replace(/\s+/g, '\\s+')}(?=$|[^a-z0-9])`, 'i');
}

function hasPhrase(text, phrases = []) {
  return phrases.some((phrase) => {
    const pattern = phrasePattern(phrase);
    return pattern ? pattern.test(text) : false;
  });
}

function seniorTitleHit(title, terms = []) {
  const text = String(title || '');
  return terms.find((term) => {
    if (/^sr\.?$/i.test(term)) return /\bsr\.?\b/i.test(text);
    const pattern = phrasePattern(term);
    return pattern ? pattern.test(text) : false;
  }) || '';
}

function explicitEntryLevelSignal(text, signals = []) {
  return signals.find((signal) => {
    const pattern = phrasePattern(signal);
    return pattern ? pattern.test(text) : false;
  }) || '';
}

function experienceYearHits(text) {
  const hits = [];
  const patterns = [
    /(\d+)\s*\+\s*(?:years?|yrs?)(?:\s+of)?(?:\s+(?:professional|relevant|related|industry|sales|engineering|implementation|technical))?\s+experience/gi,
    /(\d+)\s*(?:or more|plus)\s*(?:years?|yrs?)(?:\s+of)?(?:\s+(?:professional|relevant|related|industry|sales|engineering|implementation|technical))?\s+experience/gi,
    /at least\s+(\d+)\s*(?:years?|yrs?)(?:\s+of)?(?:\s+(?:professional|relevant|related|industry|sales|engineering|implementation|technical))?\s+experience/gi,
    /minimum\s+of\s+(\d+)\s*(?:years?|yrs?)(?:\s+of)?(?:\s+(?:professional|relevant|related|industry|sales|engineering|implementation|technical))?\s+experience/gi,
    /requires?\s+(\d+)\s*(?:years?|yrs?)(?:\s+of)?(?:\s+(?:professional|relevant|related|industry|sales|engineering|implementation|technical))?\s+experience/gi,
    /(\d+)\s*-\s*(\d+)\s*(?:years?|yrs?)(?:\s+of)?(?:\s+(?:professional|relevant|related|industry|sales|engineering|implementation|technical))?\s+experience/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const min = Number(match[1]);
      const max = Number(match[2] || match[1]);
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      hits.push({ min, max, text: match[0].trim() });
    }
  }
  return hits;
}

function makeSafeguardRejection(job, source, reason, classification = 'requirements_safeguard') {
  return {
    ...job,
    source,
    fetchedAt: new Date().toISOString(),
    finalUrl: job.url,
    httpStatus: '',
    classification,
    activeVerificationStatus: 'rejected',
    rejectionReason: reason,
    requiresHumanReview: classification === 'manual_review',
  };
}

export function evaluateRequirementsSafeguard(job, config = DEFAULT_REQUIREMENTS_SAFEGUARD) {
  if (!config?.enabled) {
    return { status: 'pass', reason: 'requirements safeguard disabled' };
  }
  const title = String(job.title || '');
  const description = String(job.description || '');
  const location = String(job.location || '');
  const combined = [title, description, location].filter(Boolean).join(' ');
  const combinedLower = combined.toLowerCase();
  const titleLower = title.toLowerCase();
  const entrySignal = explicitEntryLevelSignal(combinedLower, config.entry_level_signals);

  const seniorTerm = seniorTitleHit(titleLower, config.senior_title_terms);
  if (seniorTerm) {
    return { status: 'reject', reason: `senior title term: ${seniorTerm}` };
  }

  const sponsorshipHit = config.sponsorship_reject_patterns.find((phrase) => {
    const pattern = phrasePattern(phrase);
    return pattern ? pattern.test(combinedLower) : false;
  });
  if (sponsorshipHit) {
    return { status: 'reject', reason: `explicit sponsorship/work authorization blocker: ${sponsorshipHit}` };
  }

  const seniorResponsibilityHit = config.senior_requirement_patterns.find((phrase) => {
    const pattern = phrasePattern(phrase);
    return pattern ? pattern.test(combinedLower) : false;
  });
  if (seniorResponsibilityHit && !entrySignal) {
    return { status: 'reject', reason: `senior-level responsibility without entry signal: ${seniorResponsibilityHit}` };
  }
  if (seniorResponsibilityHit && entrySignal) {
    return { status: config.manual_review_on_doubt ? 'manual_review' : 'reject', reason: `entry-level title conflicts with senior responsibility: ${seniorResponsibilityHit}` };
  }

  const years = experienceYearHits(combinedLower);
  const maxRequired = Math.max(0, Number(config.max_required_years ?? 3));
  const tooSeniorExperience = years.find((hit) => hit.min > maxRequired || hit.max > maxRequired);
  if (tooSeniorExperience && !entrySignal) {
    return { status: 'reject', reason: `requires more than ${maxRequired} years experience: ${tooSeniorExperience.text}` };
  }
  if (tooSeniorExperience && entrySignal) {
    return { status: config.manual_review_on_doubt ? 'manual_review' : 'reject', reason: `entry-level signal conflicts with >${maxRequired} years requirement: ${tooSeniorExperience.text}` };
  }

  if (!entrySignal && years.length === 0) {
    return {
      status: config.manual_review_on_doubt ? 'manual_review' : 'reject',
      reason: 'no clear junior/associate/entry-level/new-grad signal or <=3 years requirement',
    };
  }

  const passReason = entrySignal
    ? `entry-level signal matched: ${entrySignal}`
    : `experience requirement within ${maxRequired} years`;
  return { status: 'pass', reason: passReason };
}

// ── Salary filter ───────────────────────────────────────────────────
// Optional. If `salary_filter` is absent from portals.yml, all salaries pass.
// Semantics:
//   - min/max are annual compensation filters (use annualized values)
//   - max: 0 means "no upper limit"
//   - If no salary data exists on a job, it passes (conservative behavior)
//   - If both currencies are known and mismatch (e.g., USD filter, EUR job), it fails
//   - Partial ranges (min only or max only) work correctly via overlap logic
// Uses null-safe checks (!= null, ??) to preserve 0 values correctly.

export function buildSalaryFilter(salaryFilter) {
  if (!salaryFilter) return () => true;

  // Coerce and validate bounds — malformed YAML must not silently mis-filter
  const min = Number(salaryFilter.min ?? 0);
  const max = Number(salaryFilter.max ?? 0);
  const filterCurrency = (salaryFilter.currency || '').trim().toUpperCase();

  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
    console.error('Warning: salary_filter.min/max must be non-negative numbers — salary filter disabled');
    return () => true;
  }
  if (max > 0 && min > max) {
    console.error('Warning: salary_filter.min cannot exceed salary_filter.max — salary filter disabled');
    return () => true;
  }

  // If both min and max are 0, no filtering applied
  if (min === 0 && max === 0) return () => true;

  return (salary) => {
    // If no salary data exists, pass (conservative - many providers don't expose salary)
    if (!salary) return true;

    const jobMin = salary.min ?? salary.max ?? null;
    const jobMax = salary.max ?? salary.min ?? null;

    // If we have no usable salary values, pass conservatively
    if (jobMin == null && jobMax == null) return true;

    // Currency handling - reject only if BOTH currencies exist and mismatch
    const jobCurrency = (salary.currency || '').trim().toUpperCase();
    if (filterCurrency && jobCurrency && filterCurrency !== jobCurrency) {
      return false;
    }

    // Range overlap logic - reject ONLY if job is completely outside filter range
    // Job entirely below user minimum
    if (min > 0 && jobMax != null && jobMax < min) {
      return false;
    }
    // Job entirely above user maximum
    if (max > 0 && jobMin != null && jobMin > max) {
      return false;
    }

    // Otherwise pass (overlap exists or no valid range to compare)
    return true;
  };
}

const EXPIRED_TEXT_PATTERNS = [
  /job\s+(?:has\s+been\s+)?removed/i,
  /job\s+(?:is\s+)?no longer available/i,
  /no longer accepting applications/i,
  /not accepting applications/i,
  /this job has expired/i,
  /job posting has expired/i,
  /this (?:position|role|job) (?:is )?(?:closed|no longer)/i,
  /position has been filled/i,
  /\bexpired\b/i,
  /\bclosed\b/i,
];

const BLOCKED_TEXT_PATTERNS = [
  /access denied/i,
  /\bforbidden\b/i,
  /you don't have permission/i,
  /unusual traffic/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /request blocked/i,
  /enable javascript and cookies/i,
  /cloudflare/i,
  /bot detection/i,
  /suspicious traffic/i,
  /security check/i,
];

const HUMAN_GATED_TEXT_PATTERNS = [
  /verify you are (?:a |not a )?human/i,
  /\bcaptcha\b/i,
  /human verification/i,
  /continue in browser/i,
  /complete verification/i,
  /manual access required/i,
];

const ACCOUNT_REQUIRED_TEXT_PATTERNS = [
  /\bsign in\b/i,
  /\blog in\b/i,
  /create an account/i,
  /register to apply/i,
  /account required/i,
  /join to apply/i,
];

const GENERIC_REDIRECT_PATTERNS = [
  /\/jobs?\/?$/i,
  /\/careers?\/?$/i,
  /\/search\/?$/i,
  /\/job-search\/?$/i,
  /\/open-positions\/?$/i,
  /\/all-jobs\/?$/i,
];

function firstPatternMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

const REVIEW_CLASSIFICATIONS = new Set([
  'human_gated',
  'bot_blocked',
  'account_required',
  'unknown_unverified',
]);

function providerEnvPrefix(provider = '') {
  const raw = String(provider || 'unknown').replace(/-api$/i, '');
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function parseEnvBool(value) {
  if (value == null || value === '') return null;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  return null;
}

function reviewFlagFor(classification) {
  return {
    human_gated: 'SAVE_HUMAN_GATED_TO_REVIEW',
    bot_blocked: 'SAVE_BOT_BLOCKED_TO_REVIEW',
    account_required: 'SAVE_ACCOUNT_REQUIRED_TO_REVIEW',
    unknown_unverified: 'SAVE_UNKNOWN_UNVERIFIED_TO_REVIEW',
  }[classification] || '';
}

export function shouldSaveToReview(classification, provider = '', env = process.env) {
  if (!REVIEW_CLASSIFICATIONS.has(classification)) return false;
  const flag = reviewFlagFor(classification);
  const providerSpecific = parseEnvBool(env[`${providerEnvPrefix(provider)}_${flag}`]);
  if (providerSpecific !== null) return providerSpecific;
  return parseEnvBool(env[flag]) === true;
}

function isProviderEnabled(providerId, env = process.env) {
  const enabled = parseEnvBool(env[`${providerEnvPrefix(providerId)}_ENABLED`]);
  return enabled !== false;
}

function resolveMaxJobAgeDays(config = {}) {
  const parsed = Number(config.max_post_age_days ?? config.max_job_age_days ?? DEFAULT_MAX_JOB_AGE_DAYS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_JOB_AGE_DAYS;
}

function resolveVerifyLiveJobs(config = {}) {
  return config.verify_live_jobs !== false && config.verify_live_jobs !== 'false';
}

export function jobAgeDays(postedAt, nowMs = Date.now()) {
  if (!Number.isFinite(postedAt)) return null;
  return Math.floor((nowMs - postedAt) / (1000 * 60 * 60 * 24));
}

export function isOlderThanMaxAge(postedAt, maxAgeDays, nowMs = Date.now()) {
  const age = jobAgeDays(postedAt, nowMs);
  return age != null && age > maxAgeDays;
}

export function evaluateFreshnessGate(job, {
  maxJobAgeDays = DEFAULT_MAX_JOB_AGE_DAYS,
  nowMs = Date.now(),
  manualReviewOnMissingDate = true,
} = {}) {
  if (!Number.isFinite(job?.postedAt)) {
    return {
      status: manualReviewOnMissingDate ? 'manual_review' : 'reject',
      reason: 'missing reliable posted_at date',
    };
  }
  const age = jobAgeDays(job.postedAt, nowMs);
  if (age == null) {
    return {
      status: manualReviewOnMissingDate ? 'manual_review' : 'reject',
      reason: 'invalid posted_at date',
    };
  }
  if (age < 0) {
    return {
      status: 'pass',
      reason: `posted_at is dated in the future/within freshness window (${age}d <= ${maxJobAgeDays}d)`,
    };
  }
  if (age > maxJobAgeDays) {
    return {
      status: 'reject',
      reason: `posted_at older than max_post_age_days (${age}d > ${maxJobAgeDays}d)`,
    };
  }
  return {
    status: 'pass',
    reason: `posted_at within max_post_age_days (${age}d <= ${maxJobAgeDays}d)`,
  };
}

function isGenericRedirect(originalUrl, finalUrl) {
  if (!finalUrl || finalUrl === originalUrl) return false;
  let original;
  let final;
  try {
    original = new URL(originalUrl);
    final = new URL(finalUrl);
  } catch {
    return false;
  }
  if (original.hostname !== final.hostname) return false;
  if (final.pathname === '/' && original.pathname !== '/') return true;
  return GENERIC_REDIRECT_PATTERNS.some((pattern) => pattern.test(final.pathname));
}

function isJoobleRedirectUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)jooble\.org$/i.test(url.hostname) && /^\/away\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function shouldUseRedirectFallback(offer, page) {
  if (!page) return false;
  if ([403, 405, 406].includes(page.status)) return true;
  if (!page.ok && /redirect|fetch failed|network|timeout/i.test(String(page.error || ''))) return true;
  return isGenericRedirect(offer.url, page.finalUrl);
}

function stripHtml(text = '') {
  return String(text)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function verificationHeaders({ browserLike = false, referer = '' } = {}) {
  if (!browserLike) {
    return {
      'user-agent': 'Mozilla/5.0 (compatible; career-ops-live-verify/1.0)',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
  }
  return {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    ...(referer ? { referer } : {}),
  };
}

function redirectRefererFor(url) {
  if (isJoobleRedirectUrl(url)) return 'https://jooble.org/';
  try {
    return new URL(url).origin + '/';
  } catch {
    return '';
  }
}

function verificationResultFields(offer, page, classification, reason) {
  return {
    verified: classification === 'verified_live',
    classification,
    method: page?.method || 'http',
    status: page?.status ?? 0,
    final_url: page?.finalUrl || offer.url,
    reason: reason || '',
    requires_human_review: REVIEW_CLASSIFICATIONS.has(classification),
    provider: offer.source || '',
    source_url: offer.url,
  };
}

export function classifyVerificationPage(offer, page, { noDatePrefix = true } = {}) {
  if (!page?.ok) {
    const reason = offer.postedAt || !noDatePrefix
      ? (page?.error || 'verification failed')
      : `no fresh posted_at/date field and job URL could not be verified: ${page?.error || 'verification failed'}`;
    return verificationResultFields(offer, page, 'unknown_unverified', reason);
  }

  const bodyText = page.bodyText || '';

  if ([404, 410].includes(page.status)) {
    return verificationResultFields(offer, page, 'expired_or_dead', `HTTP ${page.status}`);
  }

  const expiredText = firstPatternMatch(EXPIRED_TEXT_PATTERNS, bodyText);
  if (expiredText) {
    return verificationResultFields(offer, page, 'expired_or_dead', `expired page text matched: ${expiredText.source}`);
  }

  const humanGatedText = firstPatternMatch(HUMAN_GATED_TEXT_PATTERNS, bodyText);
  if (humanGatedText) {
    return verificationResultFields(offer, page, 'human_gated', `human-gated page text matched: ${humanGatedText.source}`);
  }

  const accountRequiredText = firstPatternMatch(ACCOUNT_REQUIRED_TEXT_PATTERNS, bodyText);
  if (accountRequiredText) {
    return verificationResultFields(offer, page, 'account_required', `account-required page text matched: ${accountRequiredText.source}`);
  }

  if ([403, 405, 406].includes(page.status)) {
    return verificationResultFields(offer, page, 'bot_blocked', `HTTP ${page.status}`);
  }

  const blockedText = firstPatternMatch(BLOCKED_TEXT_PATTERNS, bodyText);
  if (blockedText) {
    return verificationResultFields(offer, page, 'bot_blocked', `blocked page text matched: ${blockedText.source}`);
  }

  if (isGenericRedirect(offer.url, page.finalUrl)) {
    return verificationResultFields(offer, page, 'unknown_unverified', `redirected to generic page: ${page.finalUrl}`);
  }

  if (!offer.postedAt && bodyText.trim().length < 300) {
    return verificationResultFields(offer, page, 'unknown_unverified', 'no fresh posted_at/date field and fetched page had insufficient content');
  }

  return verificationResultFields(offer, page, 'verified_live', '');
}

async function fetchJobPageForVerification(url, { browserLike = false, referer = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: verificationHeaders({ browserLike, referer }),
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await res.text().catch(() => '');
    return {
      ok: true,
      method: browserLike ? 'http-browser-headers' : 'http',
      status: res.status,
      finalUrl: res.url || url,
      bodyText: stripHtml(body),
    };
  } catch (err) {
    return {
      ok: false,
      method: browserLike ? 'http-browser-headers' : 'http',
      status: 0,
      finalUrl: url,
      bodyText: '',
      error: err?.name === 'AbortError' ? 'verification timeout' : (err?.message || 'verification failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

let liveVerifyBrowser = null;
let liveVerifyPage = null;
let liveVerifyPlaywrightUnavailable = false;

async function verifyWithPlaywright(url) {
  if (liveVerifyPlaywrightUnavailable) {
    return {
      ok: false,
      method: 'playwright',
      status: 0,
      finalUrl: url,
      bodyText: '',
      error: 'playwright unavailable',
    };
  }
  try {
    if (!liveVerifyPage) {
      const { chromium } = await import('playwright');
      liveVerifyBrowser = await chromium.launch({ headless: true });
      const context = await liveVerifyBrowser.newContext({
        userAgent: verificationHeaders({ browserLike: true })['user-agent'],
        locale: 'en-US',
      });
      liveVerifyPage = await context.newPage();
    }
  } catch (err) {
    liveVerifyPlaywrightUnavailable = true;
    return {
      ok: false,
      method: 'playwright',
      status: 0,
      finalUrl: url,
      bodyText: '',
      error: err?.message || 'playwright unavailable',
    };
  }
  try {
    const response = await liveVerifyPage.goto(url, { waitUntil: 'domcontentloaded', timeout: LIVE_VERIFY_TIMEOUT_MS });
    await liveVerifyPage.waitForTimeout(1_000);
    const bodyText = await liveVerifyPage.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    return {
      ok: true,
      method: 'playwright',
      status: response?.status() ?? 0,
      finalUrl: liveVerifyPage.url() || url,
      bodyText: stripHtml(bodyText),
    };
  } catch (err) {
    return {
      ok: false,
      method: 'playwright',
      status: 0,
      finalUrl: url,
      bodyText: '',
      error: err?.message || 'playwright verification failed',
    };
  }
}

function makeVerificationDecision(offer, base, page, { maxJobAgeDays, noDatePrefix = true } = {}) {
  const checked = {
    ...base,
    finalUrl: page.finalUrl,
    httpStatus: page.status,
    verificationMethod: page.method || 'http',
  };
  const verification = classifyVerificationPage(offer, page, { noDatePrefix });

  return {
    status: verification.verified ? 'verified' : 'rejected',
    offer: {
      ...checked,
      verification,
      classification: verification.classification,
      activeVerificationStatus: verification.verified ? 'active' : 'rejected',
      rejectionReason: verification.reason,
      requiresHumanReview: verification.requires_human_review,
    },
  };
}

export async function verifyLiveOffer(offer, {
  maxJobAgeDays = DEFAULT_MAX_JOB_AGE_DAYS,
  nowMs = Date.now(),
  fetchedAt = new Date().toISOString(),
  fetchPage = fetchJobPageForVerification,
  playwrightVerify = verifyWithPlaywright,
} = {}) {
  const base = {
    ...offer,
    fetchedAt,
    finalUrl: offer.url,
    verificationMethod: 'http',
    activeVerificationStatus: 'unknown',
    rejectionReason: '',
  };

  if (!Number.isFinite(offer.postedAt)) {
    return {
      status: 'rejected',
      offer: {
        ...base,
        activeVerificationStatus: 'rejected',
        rejectionReason: 'missing reliable posted_at date',
        verificationMethod: 'date',
        classification: 'unknown_unverified',
        requiresHumanReview: true,
        verification: {
          verified: false,
          classification: 'unknown_unverified',
          method: 'date',
          status: 0,
          final_url: offer.url,
          reason: 'missing reliable posted_at date',
          requires_human_review: true,
          provider: offer.source || '',
          source_url: offer.url,
        },
      },
    };
  }

  if (isOlderThanMaxAge(offer.postedAt, maxJobAgeDays, nowMs)) {
    const age = jobAgeDays(offer.postedAt, nowMs);
    return {
      status: 'rejected',
      offer: {
        ...base,
        activeVerificationStatus: 'rejected',
        rejectionReason: `posted_at older than max_post_age_days (${age}d > ${maxJobAgeDays}d)`,
        verificationMethod: 'date',
        classification: 'expired_or_dead',
        requiresHumanReview: false,
        verification: {
          verified: false,
          classification: 'expired_or_dead',
          method: 'date',
          status: 0,
          final_url: offer.url,
          reason: `posted_at older than max_post_age_days (${age}d > ${maxJobAgeDays}d)`,
          requires_human_review: false,
          provider: offer.source || '',
          source_url: offer.url,
        },
      },
    };
  }

  const page = await fetchPage(offer.url);
  const firstDecision = makeVerificationDecision(offer, base, page, { maxJobAgeDays });
  if (firstDecision.status === 'verified' || !shouldUseRedirectFallback(offer, page)) return firstDecision;

  const browserLikePage = await fetchPage(offer.url, {
    browserLike: true,
    referer: redirectRefererFor(offer.url),
  });
  const browserLikeDecision = makeVerificationDecision(offer, base, browserLikePage, { maxJobAgeDays });
  if (browserLikeDecision.status === 'verified' || !shouldUseRedirectFallback(offer, browserLikePage)) return browserLikeDecision;

  const playwrightPage = await playwrightVerify(offer.url);
  return makeVerificationDecision(offer, base, playwrightPage, { maxJobAgeDays, noDatePrefix: false });
}

async function verifyLiveOffers(offers, { maxJobAgeDays = DEFAULT_MAX_JOB_AGE_DAYS } = {}) {
  const verified = [];
  const rejected = [];
  for (const offer of offers) {
    const result = await verifyLiveOffer(offer, { maxJobAgeDays });
    const o = result.offer;
    const status = result.status === 'verified' ? 'active' : 'rejected';
    const reason = o.rejectionReason ? ` — ${o.rejectionReason}` : '';
    const postedAt = Number.isFinite(o.postedAt) ? new Date(o.postedAt).toISOString() : '';
    console.log(`  live:${status.padEnd(8)} provider=${o.source || ''} source_url=${o.url} fetched_at=${o.fetchedAt} posted_at=${postedAt} final_url=${o.finalUrl || ''} method=${o.verificationMethod || 'http'} http_status=${o.httpStatus || ''} classification=${o.classification || ''} requires_human_review=${o.requiresHumanReview ? 'true' : 'false'} verification_status=${o.activeVerificationStatus || status} rejection_reason=${o.rejectionReason || ''}${reason}`);
    if (result.status === 'verified') verified.push(o);
    else rejected.push(o);
  }
  return { verified, rejected };
}

export function companyMatch(jobCompany, windowCompany) {
  const cleanNoSpaces = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const c1NoSpaces = cleanNoSpaces(jobCompany);
  const c2NoSpaces = cleanNoSpaces(windowCompany);
  if (c1NoSpaces === c2NoSpaces) return true;

  const cleanWithSpaces = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const c1WithSpaces = cleanWithSpaces(jobCompany);
  const c2WithSpaces = cleanWithSpaces(windowCompany);
  if (!c1WithSpaces || !c2WithSpaces) return false;

  const regex1 = new RegExp('\\b' + c2WithSpaces.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b');
  const regex2 = new RegExp('\\b' + c1WithSpaces.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b');
  return regex1.test(c1WithSpaces) || regex2.test(c2WithSpaces);
}

export function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function loadReApplyWindows(profilePath = PROFILE_PATH) {
  if (!existsSync(profilePath)) return {};
  try {
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const windows = raw.re_apply_windows || {};
    const validWindows = {};
    for (const [company, win] of Object.entries(windows)) {
      if (!win || typeof win !== 'object') continue;
      const lastApplyDate = win.last_apply_date;
      if (typeof lastApplyDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastApplyDate)) continue;
      if (isNaN(Date.parse(lastApplyDate))) continue;

      const sameRoleDays = win.same_role_days;
      if (sameRoleDays !== undefined && (!Number.isInteger(sameRoleDays) || sameRoleDays < 0)) continue;

      if (win.applied_to !== undefined && !Array.isArray(win.applied_to)) continue;
      if (win.applied_to !== undefined && win.applied_to.some(x => typeof x !== 'string')) continue;

      if (win.cross_role_bucket !== undefined && typeof win.cross_role_bucket !== 'string') continue;

      validWindows[company] = win;
    }
    return validWindows;
  } catch {
    return {};
  }
}

export function buildCooldownFilter(windows, today) {
  if (!windows || Object.keys(windows).length === 0) {
    return () => ({ skip: false });
  }

  const genericKeywords = new Set(['all', 'roles', 'role', 'family', 'bucket', 'group', 'team']);

  return (job) => {
    const jobCompany = job.company || '';
    const jobTitleLower = (job.title || '').toLowerCase();

    for (const [windowCompany, window] of Object.entries(windows)) {
      if (companyMatch(jobCompany, windowCompany)) {
        const lastApplyDate = window.last_apply_date;
        const sameRoleDays = Number(window.same_role_days || 0);
        if (!lastApplyDate) continue;

        const cooldownUntil = addDays(lastApplyDate, sameRoleDays);
        if (today >= cooldownUntil) {
          continue;
        }

        if (Array.isArray(window.applied_to)) {
          const matchesApplied = window.applied_to.some(role => {
            const roleLower = role.toLowerCase();
            return jobTitleLower.includes(roleLower);
          });
          if (matchesApplied) {
            return { skip: true, reason: `cooldown:${windowCompany}:${cooldownUntil}`, cooldownUntil };
          }
        }

        if (window.cross_role_bucket) {
          const bucketKeywords = window.cross_role_bucket
            .toLowerCase()
            .split('_')
            .filter(kw => kw && !genericKeywords.has(kw));

          const matchesBucket = bucketKeywords.some(kw => {
            if (kw === 'em') {
              return /\bem\b/i.test(jobTitleLower) || jobTitleLower.includes('engineering manager');
            }
            return jobTitleLower.includes(kw);
          });

          if (matchesBucket) {
            return { skip: true, reason: `cooldown:${windowCompany}:${cooldownUntil}`, cooldownUntil };
          }
        }
      }
    }

    return { skip: false };
  };
}


// ── URL rediscovery (--rediscover-404) ──────────────────────────────
// When a tracked company's job URL returns 404/410, the role may have just
// moved to a new URL (Workday/Greenhouse rotate URLs without closing roles).
// These helpers back an opt-in search-and-reverify fallback before giving up.

// extractCareersUrlDomain returns the hostname of a company's careers_url, or
// null when it's missing/unparseable. The presence of a domain is what gates
// the fallback — broad-discovery offers without a careers_url stay ineligible.
export function extractCareersUrlDomain(careersUrl) {
  if (!careersUrl) return null;
  try {
    return new URL(careersUrl).hostname;
  } catch {
    return null;
  }
}

// resolveSearchHref unwraps a DuckDuckGo HTML redirect (`/l/?uddg=<encoded>`)
// to its real destination, so domain matching sees the actual host instead of
// duckduckgo.com. Non-redirect hrefs pass through unchanged.
function resolveSearchHref(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const isDdgHost = u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com');
    if (isDdgHost && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
    /* fall through to the raw href */
  }
  return href;
}

// pickRediscoveredUrl chooses the first result whose hostname *exactly* equals
// the careers domain (no substring/look-alike matches), unwrapping search-engine
// redirects first. Pure + exported so result-matching is unit-testable without
// driving a real browser. Returns null when nothing matches.
export function pickRediscoveredUrl(hrefs, domain) {
  if (!domain || !Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const href = resolveSearchHref(raw);
    let host;
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    if (host === domain) return href;
  }
  return null;
}

// REDISCOVER_TIMEOUT_MS bounds the single fallback search so a slow or blocked
// search engine can't stall the sequential verify loop.
const REDISCOVER_TIMEOUT_MS = 10_000;

// searchForNewUrl runs one site-scoped search for a moved tracked role and
// returns a same-domain URL if found, else null. Every failure path returns
// null — the fallback must never throw into the verify loop. Leaves the page on
// a blank document so the next checkUrlLiveness call starts clean.
async function searchForNewUrl(page, offer) {
  const domain = offer.careersUrlDomain;
  if (!domain) return null;
  const query = `"${offer.title}" "${offer.company}" site:${domain}`;
  try {
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: REDISCOVER_TIMEOUT_MS },
    );
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a.result__a'))
        .map((a) => a.getAttribute('href'))
        .filter(Boolean),
    );
    return pickRediscoveredUrl(hrefs, domain);
  } catch {
    return null;
  } finally {
    try {
      await page.goto('about:blank');
    } catch {
      /* ignore — best-effort cleanup */
    }
  }
}

// ── Dedup ───────────────────────────────────────────────────────────

const PERMANENT_SCAN_HISTORY_STATUSES = new Set([
  'skipped_invalid_url',
  'skipped_blocked_host',
]);

function daysBetweenIsoDates(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (startDate.toISOString().slice(0, 10) !== start || endDate.toISOString().slice(0, 10) !== end) return null;
  return Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
}

export function shouldDedupScanHistoryRow({ firstSeen, status = 'added' }, { recheckAfterDays = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (PERMANENT_SCAN_HISTORY_STATUSES.has(status)) return true;
  if (status.startsWith('cooldown:')) {
    const parts = status.split(':');
    const cooldownUntil = parts[parts.length - 1];
    return today < cooldownUntil;
  }
  if (status !== 'added') return true;
  if (recheckAfterDays == null) return true;
  const ageDays = daysBetweenIsoDates(firstSeen, today);
  if (ageDays == null) return true;
  return ageDays < recheckAfterDays;
}

function scanHistoryPolicy(config = {}) {
  const raw = config.scan_history?.recheck_after_days;
  const parsed = Number.parseInt(raw, 10);
  return {
    recheckAfterDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
  };
}

const DEFAULT_US_AGGREGATOR_QUERIES = [
  'Associate Solutions Engineer',
  'Solutions Engineer',
  'Sales Engineer',
  'Solutions Consultant',
  'Technical Consultant',
  'Implementation Consultant',
  'Implementation Engineer',
  'Customer Engineer',
  'Technical Success Engineer',
  'Product Solutions Specialist',
  'AI Solutions Consultant',
  'Data Solutions Consultant',
  'Cloud Solutions Consultant',
  'Professional Services Consultant',
];

function buildUsAggregatorEntries(config = {}) {
  const sources = config.us_aggregator_sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return [];
  const tierQueries = roleTierTitles(config, ['tier_1_priority', 'tier_2_strong_fit']);
  const explicitQueries = Array.isArray(config.us_aggregator_queries)
    ? dedupeStrings(config.us_aggregator_queries)
    : [];
  const queries = explicitQueries.length > 0
    ? explicitQueries
    : (tierQueries.length > 0 ? tierQueries : DEFAULT_US_AGGREGATOR_QUERIES);
  return Object.entries(sources)
    .filter(([id, cfg]) => id !== 'ziprecruiter' && cfg && typeof cfg === 'object' && cfg.enabled !== false)
    .map(([id, cfg]) => ({
      name: String(cfg.name || id),
      provider: id,
      country: String(cfg.country || 'us').toLowerCase(),
      priority: cfg.priority || 'medium',
      queries,
      maxPages: Number(cfg.maxPages || 1),
      pageSize: Number(cfg.pageSize || 25),
      _usAggregator: true,
    }));
}

export function loadSeenUrls(policy = {}) {
  const seen = new Set();
  let recheckEligible = 0;

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const [url, firstSeen, , , , status = 'added'] = line.split('\t');
      if (!url) continue;
      if (shouldDedupScanHistoryRow({ firstSeen, status }, policy)) seen.add(normalizeScanUrl(url));
      else recheckEligible++;
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(normalizeScanUrl(match[1]));
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(normalizeScanUrl(match[0]));
    }
  }

  return { seen, recheckEligible };
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function normalizeScanScalar(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function normalizeScanUrl(value) {
  const raw = String(value ?? '').trim().split(/\s+/)[0] || '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.hostname === 'adzuna.com' || url.hostname === 'www.adzuna.com') {
      const match = url.pathname.match(/^\/(?:land\/ad|details)\/(\d+)\/?$/i);
      if (match) return `https://www.adzuna.com/details/${match[1]}`;
    }
  } catch {
    return raw;
  }
  return raw;
}

const MARKDOWN_ESCAPE_CHARS = {
  '\\': '\\\\',
  '[': '\\[',
  ']': '\\]',
};

export function sanitizeMarkdownField(value) {
  return normalizeScanScalar(value)
    .replace(/[\\[\]]/g, char => MARKDOWN_ESCAPE_CHARS[char])
    .replace(/\|/g, '/');
}

function sanitizePipelineUrl(value) {
  return normalizeScanUrl(value)
    .replace(/[\\[\]]/g, char => MARKDOWN_ESCAPE_CHARS[char])
    .replace(/\|/g, '%7C');
}

export function sanitizeTsvField(value) {
  const normalized = normalizeScanScalar(value);
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

// Format an offer's parsed compensation (the annualized {min,max,currency} that
// providers like Ashby attach as `offer.salary`) into a compact, sanitized cell
// such as `120000-160000 USD`. Returns '' when there is no usable salary data.
// Non-positive bounds are dropped (a 0 min/max is meaningless comp data, not "$0").
export function formatCompensation(salary) {
  if (!salary || typeof salary !== 'object') return '';
  const num = (n) => (Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null);
  const lo = num(salary.min);
  const hi = num(salary.max);
  const range = lo && hi && lo !== hi ? `${lo}-${hi}` : (lo || hi || '');
  if (!range) return '';
  const currency = typeof salary.currency === 'string' ? salary.currency.trim() : '';
  return sanitizeMarkdownField(currency ? `${range} ${currency}` : range);
}

export function formatPipelineOffer(offer) {
  const url = sanitizePipelineUrl(offer.url);
  const company = sanitizeMarkdownField(offer.company);
  const title = sanitizeMarkdownField(offer.title);
  // Optional trailing columns, each sanitized like every other field:
  //   4th = location, 5th = compensation.
  // Gate location on an actual string so malformed provider data (a number or
  // object) degrades to the 3-column form instead of stringifying into a
  // spurious column. The columns are positional, so a present compensation
  // forces the (possibly empty) location cell to keep comp in column 5.
  // loadSeenUrls dedups on the URL and ignores trailing columns (backward-compatible).
  const location = typeof offer.location === 'string' ? sanitizeMarkdownField(offer.location) : '';
  const compensation = formatCompensation(offer.salary);
  const base = `- [ ] ${url} | ${company} | ${title}`;
  if (compensation) return `${base} | ${location} | ${compensation}`;
  return location ? `${base} | ${location}` : base;
}

export function formatScanHistoryRow(offer, date, status = 'added') {
  return [
    normalizeScanUrl(offer.url),
    date,
    offer.source,
    offer.title,
    offer.company,
    status,
    offer.location || '',
  ].map(sanitizeTsvField).join('\t');
}

export function formatRejectedJobRow(offer, date) {
  const postedAt = Number.isFinite(offer.postedAt) ? new Date(offer.postedAt).toISOString() : '';
  return [
    date,
    offer.source || '',
    normalizeScanUrl(offer.url),
    offer.fetchedAt || '',
    postedAt,
    normalizeScanUrl(offer.finalUrl || ''),
    offer.httpStatus || '',
    offer.classification || 'unknown_unverified',
    offer.activeVerificationStatus || 'rejected',
    offer.rejectionReason || '',
    offer.title || '',
    offer.company || '',
    offer.location || '',
  ].map(sanitizeTsvField).join('\t');
}

// Standard skeleton created on fresh install — matches the format documented
// in modes/pipeline.md and expected by /career-ops pipeline.
const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

// Current section names (English). Legacy Spanish names are checked as fallback
// so existing pipeline.md files created before this change keep working.
const PENDING_MARKERS = ['## Pending', '## Pendientes'];
const PROCESSED_MARKERS = ['## Processed', '## Procesadas'];

export function appendToPipeline(offers) {
  if (offers.length === 0) return;

  // Auto-create with standard skeleton if missing (fresh-install guard).
  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, PIPELINE_SKELETON, 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  const marker = PENDING_MARKERS.find(m => text.includes(m)) ?? null;
  const idx = marker !== null ? text.indexOf(marker) : -1;

  if (idx === -1) {
    // No Pending section found — insert one before Processed (or at end)
    const procIdx = PROCESSED_MARKERS.reduce((found, m) => {
      const i = text.indexOf(m);
      return (found === -1 || (i !== -1 && i < found)) ? i : found;
    }, -1);
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n## Pending\n\n` + offers.map(formatPipelineOffer).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pending content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(formatPipelineOffer).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

export function appendToScanHistory(offers, date, status = 'added') {
  // Ensure file + header exist. Location appended as 7th column for non-breaking
  // backward compat — older scan-history.tsv files with 6 columns still parse fine
  // since loadSeenUrls only reads column 0. `status` is parameterized so callers
  // can record verify outcomes (`skipped_expired`, etc.) without the legacy
  // `(expired)` suffix in `source`.
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  const lines = offers.map(o => formatScanHistoryRow(o, date, status)).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

export function appendToRejectedJobs(offers, date) {
  if (!offers.length) return;
  if (!existsSync(REJECTED_JOBS_PATH)) {
    writeFileSync(
      REJECTED_JOBS_PATH,
      'date\tprovider\tsource_url\tfetched_at\tposted_at\tfinal_url\thttp_status\tclassification\tverification_status\trejection_reason\ttitle\tcompany\tlocation\n',
      'utf-8',
    );
  }
  appendFileSync(REJECTED_JOBS_PATH, offers.map(o => formatRejectedJobRow(o, date)).join('\n') + '\n', 'utf-8');
}

function formatNeedsReviewEntry(offer, date) {
  const lines = [
    `### ${sanitizeMarkdownField(offer.company || 'Unknown company')} — ${sanitizeMarkdownField(offer.title || 'Untitled role')}`,
    '',
    `- Location: ${sanitizeMarkdownField(offer.location || 'N/A')}`,
    `- Provider: ${sanitizeMarkdownField(offer.source || 'unknown')}`,
    `- Apply URL: ${offer.url || ''}`,
    `- Final URL: ${offer.finalUrl || offer.url || ''}`,
    `- Classification: ${sanitizeMarkdownField(offer.classification || 'unknown_unverified')}`,
    `- Verification method: ${sanitizeMarkdownField(offer.verificationMethod || 'unknown')}`,
    `- Verification reason: ${sanitizeMarkdownField(offer.rejectionReason || 'N/A')}`,
    `- Date scanned: ${date}`,
    '- Note: Requires manual review. Not saved to verified pipeline.',
    '',
  ];
  return lines.join('\n');
}

export function appendToNeedsReview(offers, date) {
  if (!offers.length) return;
  if (!existsSync(NEEDS_REVIEW_PATH)) {
    writeFileSync(
      NEEDS_REVIEW_PATH,
      '# Needs Review\n\nRelevant jobs that require human access, account login, captcha, bot-blocked browsing, or manual review. Not saved to verified pipeline.\n\n',
      'utf-8',
    );
  }
  appendFileSync(NEEDS_REVIEW_PATH, offers.map(o => formatNeedsReviewEntry(o, date)).join('\n'), 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function verifyOffers(offers, { headedFallback = false, throttleBaseMs = 0, rediscover = false } = {}) {
  // Dynamic imports keep the default zero-token path free of Playwright startup
  let chromium;
  let checkUrlLiveness;
  let checkUrlLivenessWithFallback;
  let createHeadedPageProvider;
  let newLivenessPage;
  let jitteredDelayMs;
  let sleep;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness, checkUrlLivenessWithFallback, createHeadedPageProvider, newLivenessPage, jitteredDelayMs, sleep } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--verify requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `--verify could not launch Chromium (run "npx playwright install chromium" or re-run without --verify): ${err.message}`,
      { cause: err },
    );
  }

  // Three permanent buckets + one transient passthrough:
  //   verified  → active pages and transient nav errors (retry next scan)
  //   expired   → classifier-confirmed dead postings (HTTP 4xx, redirect markers,
  //               body patterns, listing pages, insufficient content)
  //   dropped   → page loaded but classifier saw no Apply control. --verify is an
  //               opt-in stricter filter; keeping these defeats the purpose.
  //   invalid   → up-front URL guard rejections (malformed / non-http / private)
  const verified = [];
  const expired = [];
  const dropped = [];
  const invalid = [];
  const migrated = [];

  const headed = headedFallback ? createHeadedPageProvider(chromium) : null;
  const getHeadedPage = headed ? () => headed.get() : undefined;

  try {
    const page = await newLivenessPage(browser);
    // Sequential — project rule: never Playwright in parallel
    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i];
      const { result, code, reason } = headed
        ? await checkUrlLivenessWithFallback(page, offer.url, { getHeadedPage })
        : await checkUrlLiveness(page, offer.url);
      if (result === 'expired') {
        // 404/410 on a tracked company may just be a moved role — run one
        // search + re-verify before giving up (opt-in via --rediscover-404).
        // Only http_gone (HTTP 404/410) qualifies; soft-expiry signals
        // (redirect/body/listing) are real closures, not URL moves.
        if (rediscover && code === 'http_gone' && offer.tracked && offer.careersUrlDomain) {
          const newUrl = await searchForNewUrl(page, offer);
          if (newUrl) {
            // Mirror the primary check: without the headed fallback, a
            // challenge-prone domain would flag the rediscovered URL as
            // expired just because the recheck hit the same anti-bot wall.
            const recheck = headed
              ? await checkUrlLivenessWithFallback(page, newUrl, { getHeadedPage })
              : await checkUrlLiveness(page, newUrl);
            // Require a *confirmed* live page before migrating. A transient
            // 'uncertain' (timeout/DNS/5xx) must not commit an unverified URL —
            // fall through to expired (the original 404/410 is a real closure).
            if (recheck.result === 'active') {
              migrated.push({ ...offer, url: newUrl, previousUrl: offer.url });
              console.log(`  🔄 migrated  ${offer.company} | ${offer.title} → ${newUrl}`);
              continue;
            }
          }
        }
        expired.push({ ...offer, reason });
        console.log(`  ❌ expired   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && GUARD_CODES.has(code)) {
        // Guard failures are permanent (not transient like a timeout) — record them
        // separately so they don't end up in pipeline.md but DO appear in scan-history
        // with a precise status, dedup-blocking them on subsequent scans.
        invalid.push({ ...offer, code, reason });
        console.log(`  ⛔ invalid   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && code === 'no_apply_control') {
        // Page loaded but classifier could not find an Apply control. Treat like
        // expired for routing — drop from pipeline AND record in scan-history so
        // we don't burn a verify cycle on the same URL next scan.
        dropped.push({ ...offer, reason });
        console.log(`  ⚠️ no-apply  ${offer.company} | ${offer.title} (${reason})`);
      } else {
        // 'active' or 'uncertain' due to navigation_error (transient — retry next scan)
        verified.push(offer);
        const icon = result === 'active' ? '✅' : '⚠️';
        console.log(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}`);
      }

      const wait = i < offers.length - 1 ? jitteredDelayMs(throttleBaseMs) : 0;
      if (wait) await sleep(wait);
    }
  } finally {
    if (headed) await headed.close();
    await browser.close();
  }

  return { verified, expired, dropped, invalid, migrated };
}

// Stable codes from liveness-browser's up-front URL guard. Routing dispatches
// on these codes (not on regex over reason strings) so wording can change
// without breaking the pipeline.
const GUARD_CODES = new Set(['invalid_url', 'unsupported_protocol', 'blocked_host']);

// guardStatusFor maps a guard code to the canonical scan-history status string.
function guardStatusFor(code) {
  if (code === 'blocked_host') return 'skipped_blocked_host';
  // invalid_url and unsupported_protocol both surface as malformed input
  return 'skipped_invalid_url';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');
  // Opt-in: on an anti-bot challenge (e.g. pracuj.pl Cloudflare wall), retry the
  // URL in a headed browser. Off by default — headed Chromium needs a display, so
  // scheduled/unattended scans should not rely on it.
  const headedFallback = args.includes('--headed-fallback');
  // --throttle or --throttle=<ms>: jittered gap between --verify checks to stay
  // under rate-based WAF limits (pracuj.pl flags the session after a few rapid
  // hits). Default base 5000ms. Off by default — most ATS feeds don't need it.
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  // --rediscover-404: when a tracked company's URL 404/410s, search for the
  // moved role and re-verify before marking it expired. Opt-in; rides on --verify.
  const rediscover = args.includes('--rediscover-404');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Load providers
  const providers = await loadProviders(PROVIDERS_DIR);
  // Opt-in: merge enabled keyed/auth-gated provider plugins. Returns immediately
  // (no discovery, no dotenv, no process.env mutation) when config/plugins.yml is
  // absent — so a plain scan with no plugins configured stays byte-identical.
  await mergeProviderPlugins(providers, { root: path.dirname(PROVIDERS_DIR) });
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }

  // 2. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  let rawConfig;
  try {
    rawConfig = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Error: failed to parse ${PORTALS_PATH}: ${err.message}`);
    process.exit(1);
  }
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const companies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
  const boards = [
    ...buildUsAggregatorEntries(config),
    ...(Array.isArray(config.job_boards) ? config.job_boards : []),
  ];
  const titleFilter = buildEffectiveTitleFilter(config);
  const roleTierClassifier = buildRoleTierClassifier(config);
  const tier3DescriptionGate = buildTier3DescriptionGate(config);
  const verifyLiveJobs = resolveVerifyLiveJobs(config);
  const maxJobAgeDays = resolveMaxJobAgeDays(config);

  // Seniority tier classifier integration
  let classifyTier = null;
  const skipTiers = Array.isArray(config.skip_tiers)
    ? config.skip_tiers.filter(t => typeof t === 'string').map(t => t.toLowerCase())
    : [];
  if (skipTiers.length > 0) {
    const mod = await import('./classify-tier.mjs');
    classifyTier = mod.classifyTier || mod.default;
  }

  const locationFilter = buildLocationFilter(config.location_filter);
  const salaryFilter = buildSalaryFilter(config.salary_filter);
  const trustValidator = buildTrustValidator(config.trust_filter);
  const contentFilter = buildContentFilter(config.content_filter);
  const workAuthFilter = buildWorkAuthorizationFilter(config);
  const requirementsSafeguard = loadRequirementsSafeguard(config);
  if (requirementsSafeguard.enabled) {
    console.log(`Requirements safeguard: enabled (${requirementsSafeguard.file}, max required years: ${requirementsSafeguard.max_required_years})`);
  }

  // 3. Resolve a provider for each enabled company / board
  const targets = [];
  let skippedCount = 0;
  let boardCount = 0;
  const resolveErrors = [];
  const agentHandoff = [];

  /**
   * Processes a list of configuration entries, resolves their appropriate data providers,
   * and appends valid entries to the global scanning targets list.
   * @param {Array<{ name?: string, enabled?: boolean, [key: string]: unknown }>} entries - List of entries.
   * @param {{ isBoard?: boolean }} [options={}] - Configuration options.
   */
  function resolveEntries(entries, { isBoard = false } = {}) {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.enabled === false) continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        console.error(`⚠️  Skipping entry — missing or non-string 'name' field: ${JSON.stringify(entry)}`);
        continue;
      }
      if (filterCompany && !entry.name.toLowerCase().includes(filterCompany)) continue;

      const resolved = resolveProvider(entry, providers);
      if (!resolved) {
        skippedCount++;
        if (entry.scan_method === 'websearch') {
          agentHandoff.push({
            company: entry.name,
            method: 'websearch',
            query: entry.scan_query || entry.search_query || entry.careers_url || '',
          });
        }
        continue;
      }

      if (resolved.error) {
        resolveErrors.push({ company: entry.name, error: resolved.error });
        continue;
      }
      if (!isProviderEnabled(resolved.provider.id)) {
        resolveErrors.push({ company: entry.name, error: `disabled_by_env: ${providerEnvPrefix(resolved.provider.id)}_ENABLED=false` });
        continue;
      }

      targets.push({ ...entry, _provider: resolved.provider, _isBoard: isBoard });
      if (isBoard) boardCount++;
    }
  }

  resolveEntries(companies);
  resolveEntries(boards, { isBoard: true });

  const localParserCount = targets.filter(t => t._provider.id === 'local-parser').length;
  const companyCount = targets.length - boardCount;
  const parts = [`${companyCount} companies`];
  if (boardCount > 0) parts.push(`${boardCount} job boards`);
  parts.push(`${localParserCount} local parser`);
  parts.push(`${skippedCount} skipped — no provider matched`);
  console.log(`Scanning ${parts.join('; ')} via providers`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 4. Load dedup sets
  const historyPolicy = scanHistoryPolicy(config);
  const seenUrlState = loadSeenUrls(historyPolicy);
  const seenUrls = seenUrlState.seen;
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 5. Fetch from each target
  const date = new Date().toISOString().slice(0, 10);
  const windows = loadReApplyWindows();
  const cooldownFilter = buildCooldownFilter(windows, date);
  let totalFilteredCooldown = 0;
  const cooldownOffers = [];
  let totalFound = 0;
  let totalFilteredTitle = 0;
  let totalFilteredTier = 0;
  let totalFilteredLocation = 0;
  let totalFilteredSalary = 0;
  let totalFilteredWorkAuth = 0;
  let totalFilteredContent = 0;
  let totalFilteredFreshness = 0;
  let totalManualReviewFreshness = 0;
  let totalFilteredSafeguard = 0;
  let totalManualReviewSafeguard = 0;
  let totalDupes = 0;
  const newOffers = [];
  const freshnessRejectedOffers = [];
  const freshnessReviewOffers = [];
  const safeguardRejectedOffers = [];
  const safeguardReviewOffers = [];
  const errors = [...resolveErrors];
  const providerFetchCounts = {};
  const providerStats = {};

  function ensureProviderStats(source) {
    const key = source || 'unknown';
    if (!providerStats[key]) {
      providerStats[key] = {
        fetched: 0,
        rejectedTitle: 0,
        rejectedTier: 0,
        rejectedLocation: 0,
        rejectedSalary: 0,
        rejectedWorkAuth: 0,
        rejectedContent: 0,
        rejectedFreshness: 0,
        manualReviewFreshness: 0,
        rejectedSafeguard: 0,
        manualReviewSafeguard: 0,
        duplicates: 0,
        rejectedStale: 0,
        humanGated: 0,
        botBlocked: 0,
        accountRequired: 0,
        unknownUnverified: 0,
        expiredDead: 0,
        savedToReview: 0,
        rejected: 0,
        verifiedLive: 0,
        saved: 0,
      };
    }
    return providerStats[key];
  }

  const tasks = targets.map(company => async () => {
    let provider = company._provider;
    const ctx = makeHttpCtx();
    let sourceName = provider.id === 'local-parser' ? 'local-parser' : `${provider.id}-api`;
    try {
      let jobs;
      try {
        jobs = await provider.fetch(company, ctx);
      } catch (parserErr) {
        if (provider.id !== 'local-parser') throw parserErr;
        const fallback = resolveProvider(company, providers, { skipIds: ['local-parser'] });
        if (!fallback || fallback.error) throw parserErr;
        provider = fallback.provider;
        sourceName = `${provider.id}-api`;
        jobs = await provider.fetch(company, ctx);
        errors.push({
          company: company.name,
          error: `local parser failed, used API fallback: ${parserErr.message}`,
        });
      }
      if (!Array.isArray(jobs)) {
        throw new Error(`${provider.id}: fetch() did not return an array`);
      }
      totalFound += jobs.length;
      providerFetchCounts[sourceName] = (providerFetchCounts[sourceName] || 0) + jobs.length;
      ensureProviderStats(sourceName).fetched += jobs.length;

      for (const job of jobs) {
        job.url = normalizeScanUrl(job.url);

        // Trust enrichment — runs before filters, never drops
        const trustResult = trustValidator(job);
        job.trustScore = trustResult.score;
        job.trustFlags = trustResult.flags;
        job.trustLevel = trustResult.level;

        const freshness = evaluateFreshnessGate(job, {
          maxJobAgeDays,
          nowMs: Date.now(),
          manualReviewOnMissingDate: true,
        });
        if (freshness.status !== 'pass') {
          const stats = ensureProviderStats(sourceName);
          const rejectedOffer = makeSafeguardRejection(
            job,
            sourceName,
            freshness.reason,
            freshness.status === 'manual_review' ? 'manual_review' : 'freshness_gate',
          );
          if (freshness.status === 'manual_review') {
            totalManualReviewFreshness++;
            stats.manualReviewFreshness++;
            freshnessReviewOffers.push(rejectedOffer);
          } else {
            totalFilteredFreshness++;
            stats.rejectedFreshness++;
          }
          stats.rejected++;
          freshnessRejectedOffers.push(rejectedOffer);
          continue;
        }

        if (!titleFilter(job.title)) {
          totalFilteredTitle++;
          const stats = ensureProviderStats(sourceName);
          stats.rejectedTitle++;
          stats.rejected++;
          continue;
        }
        const roleTierMatch = roleTierClassifier(job.title);
        if (roleTierMatch.tier === 'tier_3_broad_fallback' && !tier3DescriptionGate(job)) {
          totalFilteredContent++;
          const stats = ensureProviderStats(sourceName);
          stats.rejectedContent++;
          stats.rejected++;
          continue;
        }
        if (classifyTier && skipTiers.includes(classifyTier(job.title))) {
          totalFilteredTier++;
          const stats = ensureProviderStats(sourceName);
          stats.rejectedTier++;
          stats.rejected++;
          continue;
        }
        if (!locationFilter(job.location)) {
          totalFilteredLocation++;
          const stats = ensureProviderStats(sourceName);
          stats.rejectedLocation++;
          stats.rejected++;
          continue;
        }
        if (!salaryFilter(job.salary)) {
          totalFilteredSalary++;
          const stats = ensureProviderStats(sourceName);
          stats.rejectedSalary++;
          stats.rejected++;
          continue;
        }
        if (!workAuthFilter(job)) {
          totalFilteredWorkAuth++;
          const stats = ensureProviderStats(sourceName);
          stats.rejectedWorkAuth++;
          stats.rejected++;
          continue;
        }
        if (!contentFilter(job.description)) {
          totalFilteredContent++;
          const stats = ensureProviderStats(sourceName);
          stats.rejectedContent++;
          stats.rejected++;
          continue;
        }
        const safeguard = evaluateRequirementsSafeguard(job, requirementsSafeguard);
        if (safeguard.status !== 'pass') {
          const stats = ensureProviderStats(sourceName);
          const rejectedOffer = makeSafeguardRejection(
            job,
            sourceName,
            safeguard.reason,
            safeguard.status === 'manual_review' ? 'manual_review' : 'requirements_safeguard',
          );
          if (safeguard.status === 'manual_review') {
            totalManualReviewSafeguard++;
            stats.manualReviewSafeguard++;
            safeguardReviewOffers.push(rejectedOffer);
          } else {
            totalFilteredSafeguard++;
            stats.rejectedSafeguard++;
          }
          stats.rejected++;
          safeguardRejectedOffers.push(rejectedOffer);
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          const stats = ensureProviderStats(sourceName);
          stats.duplicates++;
          stats.rejected++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          const stats = ensureProviderStats(sourceName);
          stats.duplicates++;
          stats.rejected++;
          continue;
        }
        const cooldownResult = cooldownFilter(job);
        if (cooldownResult.skip) {
          totalFilteredCooldown++;
          cooldownOffers.push({
            job: { ...job, source: sourceName },
            status: cooldownResult.reason,
          });
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        // Tag with the company's careers domain so verify can offer a 404/410
        // rediscovery fallback. A null domain (no careers_url) marks the offer
        // as broad-discovery — ineligible for the fallback, per the issue scope.
        const careersUrlDomain = extractCareersUrlDomain(company.careers_url);
        newOffers.push({
          ...job,
          roleTier: roleTierMatch.tier,
          roleTierMatchedTitle: roleTierMatch.title,
          safeguardStatus: safeguard.status,
          safeguardReason: safeguard.reason,
          source: sourceName,
          tracked: Boolean(careersUrlDomain),
          careersUrlDomain,
        });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5.5. Optional liveness verification — drop expired and guard-rejected postings
  let verifiedOffers = newOffers;
  let expiredOffers = [];
  let droppedOffers = [];
  let invalidOffers = [];
  let migratedOffers = [];
  let liveVerifiedOffers = [];
  let liveRejectedOffers = [];
  let needsReviewOffers = [];
  let finalSafeguardRejectedOffers = [];
  if (verifyLiveJobs && newOffers.length > 0) {
    console.log(`\nVerifying ${newOffers.length} candidate job(s) before saving (max age: ${maxJobAgeDays} days)...`);
    const liveResult = await verifyLiveOffers(newOffers, { maxJobAgeDays });
    liveVerifiedOffers = liveResult.verified;
    liveRejectedOffers = liveResult.rejected;
    for (const offer of liveVerifiedOffers) ensureProviderStats(offer.source).verifiedLive++;
    for (const offer of liveRejectedOffers) {
      const stats = ensureProviderStats(offer.source);
      stats.rejectedStale++;
      stats.rejected++;
      if (offer.classification === 'human_gated') stats.humanGated++;
      else if (offer.classification === 'bot_blocked') stats.botBlocked++;
      else if (offer.classification === 'account_required') stats.accountRequired++;
      else if (offer.classification === 'unknown_unverified') stats.unknownUnverified++;
      else if (offer.classification === 'expired_or_dead') stats.expiredDead++;

      if (shouldSaveToReview(offer.classification, offer.source)) {
        needsReviewOffers.push(offer);
        stats.savedToReview++;
      }
    }
    verifiedOffers = liveVerifiedOffers;
  }
  if (verify && newOffers.length > 0) {
    console.log(`\nVerifying liveness of ${verifiedOffers.length} new offer(s) with Playwright (sequential)...`);
    const result = await verifyOffers(verifiedOffers, { headedFallback, throttleBaseMs, rediscover });
    verifiedOffers = result.verified;
    expiredOffers = result.expired;
    droppedOffers = result.dropped;
    invalidOffers = result.invalid;
    migratedOffers = result.migrated;
    // Migrated offers re-enter the pipeline at their newly discovered URL.
    if (migratedOffers.length > 0) {
      verifiedOffers = [...verifiedOffers, ...migratedOffers];
    }
  }

  if (requirementsSafeguard.enabled && verifiedOffers.length > 0) {
    const finalSafeguardPassed = [];
    for (const offer of verifiedOffers) {
      const safeguard = evaluateRequirementsSafeguard(offer, requirementsSafeguard);
      if (safeguard.status === 'pass') {
        const passedOffer = { ...offer, safeguardStatus: 'pass', safeguardReason: safeguard.reason };
        console.log(`  safeguard:pass provider=${passedOffer.source || ''} source_url=${passedOffer.url} company=${passedOffer.company || ''} title=${passedOffer.title || ''} reason=${safeguard.reason}`);
        finalSafeguardPassed.push(passedOffer);
        continue;
      }
      const stats = ensureProviderStats(offer.source);
      const rejectedOffer = makeSafeguardRejection(
        offer,
        offer.source,
        safeguard.reason,
        safeguard.status === 'manual_review' ? 'manual_review' : 'requirements_safeguard',
      );
      rejectedOffer.fetchedAt = offer.fetchedAt || rejectedOffer.fetchedAt;
      rejectedOffer.finalUrl = offer.finalUrl || offer.url;
      rejectedOffer.httpStatus = offer.httpStatus || '';
      finalSafeguardRejectedOffers.push(rejectedOffer);
      safeguardRejectedOffers.push(rejectedOffer);
      if (stats.verifiedLive > 0) stats.verifiedLive--;
      stats.rejected++;
      if (safeguard.status === 'manual_review') {
        totalManualReviewSafeguard++;
        stats.manualReviewSafeguard++;
        safeguardReviewOffers.push(rejectedOffer);
      } else {
        totalFilteredSafeguard++;
        stats.rejectedSafeguard++;
      }
      console.log(`  safeguard:reject provider=${offer.source || ''} source_url=${offer.url} company=${offer.company || ''} title=${offer.title || ''} reason=${safeguard.reason}`);
    }
    verifiedOffers = finalSafeguardPassed;
    liveVerifiedOffers = finalSafeguardPassed;
  }

  // 6. Write results
  if (!dryRun && verifiedOffers.length > 0) {
    appendToPipeline(verifiedOffers);
    appendToScanHistory(verifiedOffers, date);
  }
  if (!dryRun) {
    for (const offer of verifiedOffers) ensureProviderStats(offer.source).saved++;
  }
  if (!dryRun && cooldownOffers.length > 0) {
    const cooldownGroups = {};
    for (const item of cooldownOffers) {
      if (!cooldownGroups[item.status]) {
        cooldownGroups[item.status] = [];
      }
      cooldownGroups[item.status].push(item.job);
    }
    for (const [status, group] of Object.entries(cooldownGroups)) {
      appendToScanHistory(group, date, status);
    }
  }
  // Expired postings — plus the old URLs of migrated offers — are recorded as
  // skipped_expired so subsequent scans dedup-skip the dead URLs.
  const expiredForHistory = [
    ...expiredOffers,
    ...migratedOffers.map(o => ({ ...o, url: o.previousUrl })),
  ];
  if (!dryRun && expiredForHistory.length > 0) {
    appendToScanHistory(expiredForHistory, date, 'skipped_expired');
  }
  // Pages that loaded but had no Apply control: record so we don't re-verify
  // them next scan, but never let them reach pipeline.md.
  if (!dryRun && droppedOffers.length > 0) {
    appendToScanHistory(droppedOffers, date, 'skipped_no_apply_control');
  }
  // Guard-rejected URLs (invalid / unsupported protocol / blocked host) are
  // recorded with a precise status so subsequent scans dedup-skip them via
  // loadSeenUrls, but they never reach pipeline.md.
  if (!dryRun && invalidOffers.length > 0) {
    // Group by code so the TSV reflects the actual reason category.
    const byStatus = new Map();
    for (const o of invalidOffers) {
      const status = guardStatusFor(o.code);
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(o);
    }
    for (const [status, group] of byStatus) {
      appendToScanHistory(group, date, status);
    }
  }
  if (!dryRun && liveRejectedOffers.length > 0) {
    appendToRejectedJobs(liveRejectedOffers, date);
    appendToScanHistory(liveRejectedOffers, date, 'skipped_live_verification_failed');
  }
  if (!dryRun && freshnessRejectedOffers.length > 0) {
    appendToRejectedJobs(freshnessRejectedOffers, date);
    appendToScanHistory(freshnessRejectedOffers, date, 'skipped_freshness_gate');
  }
  if (!dryRun && safeguardRejectedOffers.length > 0) {
    appendToRejectedJobs(safeguardRejectedOffers, date);
    appendToScanHistory(safeguardRejectedOffers, date, 'skipped_requirements_safeguard');
  }
  // Pipeline contains only verified live jobs. Review contains relevant jobs
  // requiring manual review, and only when explicitly enabled by env flags.
  const allNeedsReviewOffers = [...needsReviewOffers, ...freshnessReviewOffers, ...safeguardReviewOffers];
  if (!dryRun && allNeedsReviewOffers.length > 0) {
    appendToNeedsReview(allNeedsReviewOffers, date);
  }

  // 7. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  const summaryCompanies = targets.filter(t => !t._isBoard).length;
  const summaryBoards = targets.filter(t => t._isBoard).length;
  console.log(`Companies scanned:     ${summaryCompanies}`);
  if (summaryBoards > 0) console.log(`Job boards scanned:    ${summaryBoards}`);
  console.log(`Total jobs found:      ${totalFound}`);
  if (Object.keys(providerFetchCounts).length > 0) {
    console.log('Jobs fetched by provider:');
    for (const [source, count] of Object.entries(providerFetchCounts).sort()) {
      console.log(`  ${source}: ${count}`);
    }
  }
  console.log(`Filtered by title:     ${totalFilteredTitle} removed`);
  console.log(`Filtered by freshness: ${totalFilteredFreshness} removed`);
  console.log(`Freshness review:      ${totalManualReviewFreshness} held`);
  if (skipTiers.length > 0) {
    console.log(`Filtered by tier:      ${totalFilteredTier} removed`);
  }
  console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  console.log(`Filtered by salary:   ${totalFilteredSalary} removed`);
  console.log(`Filtered by work auth: ${totalFilteredWorkAuth} removed`);
  console.log(`Filtered by content:  ${totalFilteredContent} removed`);
  if (requirementsSafeguard.enabled) {
    console.log(`Safeguard rejected:    ${totalFilteredSafeguard} removed`);
    console.log(`Safeguard review:      ${totalManualReviewSafeguard} held`);
  }
  if (Object.keys(windows).length > 0 || totalFilteredCooldown > 0) {
    console.log(`Filtered by cooldown:  ${totalFilteredCooldown} removed`);
  }
  console.log(`Duplicates:            ${totalDupes} skipped`);
  if (historyPolicy.recheckAfterDays != null) {
    console.log(`Recheck eligible:      ${seenUrlState.recheckEligible} old scan-history URL(s)`);
  }
  if (verify) {
    console.log(`Expired (verified):    ${expiredOffers.length} dropped`);
    console.log(`Rediscovered (moved):  ${migratedOffers.length} migrated`);
    console.log(`No apply control:      ${droppedOffers.length} dropped`);
    console.log(`Invalid (guarded):     ${invalidOffers.length} dropped`);
  }
  if (verifyLiveJobs) {
    console.log(`Live verified:         ${liveVerifiedOffers.length} active`);
    console.log(`Rejected as stale:     ${liveRejectedOffers.length} rejected`);
    console.log(`Needs review:          ${allNeedsReviewOffers.length} ${dryRun ? 'would be saved' : 'saved'}`);
  }
  console.log(`New offers added:      ${verifiedOffers.length}`);
  console.log(`Saved to pipeline:     ${dryRun ? 0 : verifiedOffers.length}`);

  if (Object.keys(providerStats).length > 0) {
    console.log('\nProvider-level report:');
    for (const [source, stats] of Object.entries(providerStats).sort()) {
      console.log(`  ${source}: fetched=${stats.fetched}, normalized=${stats.fetched}, rejected_freshness=${stats.rejectedFreshness}, manual_review_freshness=${stats.manualReviewFreshness}, rejected_title=${stats.rejectedTitle}, rejected_location=${stats.rejectedLocation}, rejected_work_auth=${stats.rejectedWorkAuth}, rejected_content=${stats.rejectedContent}, rejected_safeguard=${stats.rejectedSafeguard}, manual_review_safeguard=${stats.manualReviewSafeguard}, duplicates=${stats.duplicates}, verified_live=${stats.verifiedLive}, saved=${stats.saved}, human_gated=${stats.humanGated}, bot_blocked=${stats.botBlocked}, account_required=${stats.accountRequired}, unknown_unverified=${stats.unknownUnverified}, saved_to_needs_review=${stats.savedToReview}, expired_dead=${stats.expiredDead}, rejected=${stats.rejected}`);
    }
  }

  if (liveRejectedOffers.length > 0) {
    console.log('\nRejected stale/unverified jobs:');
    for (const o of liveRejectedOffers) {
      console.log(`  - ${o.source || 'unknown'} | ${o.company} | ${o.title} | ${o.url} → ${o.finalUrl || 'N/A'} | ${o.classification || 'unknown_unverified'} | ${o.rejectionReason}`);
    }
    if (!dryRun) console.log(`\nRejected jobs saved to ${REJECTED_JOBS_PATH}`);
  }

  if (freshnessRejectedOffers.length > 0) {
    console.log('\nRejected by freshness gate:');
    for (const o of freshnessRejectedOffers) {
      console.log(`  - ${o.source || 'unknown'} | ${o.company} | ${o.title} | ${o.url} | ${o.classification || 'freshness_gate'} | ${o.rejectionReason}`);
    }
    if (!dryRun) console.log(`\nFreshness rejects saved to ${REJECTED_JOBS_PATH}`);
  }

  if (safeguardRejectedOffers.length > 0) {
    console.log('\nRejected by requirements safeguard:');
    for (const o of safeguardRejectedOffers) {
      console.log(`  - ${o.source || 'unknown'} | ${o.company} | ${o.title} | ${o.url} | ${o.classification || 'requirements_safeguard'} | ${o.rejectionReason}`);
    }
    if (!dryRun) console.log(`\nSafeguard rejects saved to ${REJECTED_JOBS_PATH}`);
  }

  if (allNeedsReviewOffers.length > 0) {
    console.log('\nNeeds manual review:');
    for (const o of allNeedsReviewOffers) {
      console.log(`  - ${o.source || 'unknown'} | ${o.company} | ${o.title} | ${o.classification} | ${o.rejectionReason}`);
    }
    if (!dryRun) console.log(`\nReview jobs saved to ${NEEDS_REVIEW_PATH}`);
  }

  // Trust validation summary (only when trust_filter is configured)
  if (config.trust_filter && config.trust_filter.enabled !== false && verifiedOffers.length > 0) {
    const trustHigh = verifiedOffers.filter(o => o.trustLevel === 'high').length;
    const trustMedium = verifiedOffers.filter(o => o.trustLevel === 'medium').length;
    const trustLow = verifiedOffers.filter(o => o.trustLevel === 'low').length;
    console.log(`Trust validation:      ${trustHigh} high, ${trustMedium} medium, ${trustLow} low`);
    // Flag breakdown
    /** @type {Record<string, number>} */
    const flagCounts = {};
    for (const o of verifiedOffers) {
      for (const f of (o.trustFlags || [])) {
        flagCounts[f] = (flagCounts[f] || 0) + 1;
      }
    }
    if (Object.keys(flagCounts).length > 0) {
      const parts = Object.entries(flagCounts).map(([k, v]) => `${k}: ${v}`);
      console.log(`Trust flags:           ${parts.join(', ')}`);
    }
  }

  if (agentHandoff.length > 0) {
    console.log(`Agent/WebSearch handoff: ${agentHandoff.length} compan${agentHandoff.length === 1 ? 'y' : 'ies'} not handled by zero-token providers`);
    for (const item of agentHandoff.slice(0, 25)) {
      const hint = item.query ? ` — ${item.query}` : '';
      console.log(`  • ${item.company} (${item.method})${hint}`);
    }
    if (agentHandoff.length > 25) {
      console.log(`  … ${agentHandoff.length - 25} more omitted; narrow with --company or inspect portals.yml`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (verifiedOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of verifiedOffers) {
      const trustSuffix = o.trustScore != null && o.trustScore < 100
        ? ` [Trust: ${o.trustScore}/100${o.trustFlags?.length ? ' — ' + o.trustFlags.join(', ') : ''}]`
        : '';
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}${trustSuffix}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Only run main() when invoked directly (`node scan.mjs`), not when imported by tests.
// `|| ''` guards the case where Node is invoked without a script arg (e.g. `node -e`).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
