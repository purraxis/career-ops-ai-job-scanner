#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const args = parseArgs(process.argv.slice(2));
const contextPath = args.context || 'data/career-context.json';
const outputDir = args.outputDir || 'data/context-matches';
const jobDescriptionDir = args.jobDescriptionDir || 'data/job-descriptions';

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'our', 'that', 'the', 'their', 'this', 'to', 'with', 'you',
  'your', 'we', 'will', 'work', 'role', 'team', 'teams', 'candidate', 'experience', 'using',
]);

const roleLanes = [
  {
    id: 'sales_engineering',
    label: 'Sales Engineering',
    title_terms: [
      'sales engineer',
      'associate sales engineer',
      'commercial sales engineer',
      'technical sales',
      'presales',
      'pre-sales',
    ],
    jd_terms: [
      'discovery',
      'demo',
      'demos',
      'technical sales',
      'presales',
      'pre-sales',
      'sales cycle',
      'value selling',
      'proof of concept',
      'proof of value',
      'roi',
      'stakeholder',
      'customer-facing',
      'enablement',
    ],
    evidence_terms: [
      'discovery',
      'demo',
      'demos',
      'technical sales',
      'sales',
      'stakeholder',
      'enablement',
      'roi',
      'business case',
      'customer-facing',
      'proof of concept',
      'proof of value',
    ],
  },
  {
    id: 'solutions_engineering',
    label: 'Solutions Engineering',
    title_terms: [
      'solutions engineer',
      'solution engineer',
      'solutions consultant',
      'solution consultant',
      'customer engineer',
      'technical solutions',
    ],
    jd_terms: [
      'workflow',
      'workflows',
      'api',
      'apis',
      'integration',
      'implementation',
      'customer pain',
      'pain points',
      'requirements',
      'technical enablement',
      'solution design',
      'customer workflows',
    ],
    evidence_terms: [
      'workflow',
      'workflows',
      'api',
      'apis',
      'integration',
      'implementation',
      'customer pain',
      'requirements',
      'technical enablement',
      'stakeholder',
      'solution',
      'dashboard',
    ],
  },
  {
    id: 'ai_fde',
    label: 'Forward Deployed / AI',
    title_terms: [
      'forward deployed',
      'fde',
      'ai engineer',
      'ai solutions',
      'ai deployment',
      'deployment engineer',
      'agentic',
    ],
    jd_terms: [
      'ai workflow',
      'ai workflows',
      'agent',
      'agents',
      'automation',
      'prototype',
      'prototyping',
      'customer deployment',
      'technical prototyping',
      'model evaluation',
      'human data',
    ],
    evidence_terms: [
      'ai workflow',
      'ai workflows',
      'agent',
      'agents',
      'automation',
      'prototype',
      'prototyping',
      'career ops',
      'job scanner',
      'github',
      'technical prototyping',
      'model evaluation',
      'workflow automation',
    ],
  },
  {
    id: 'customer_success',
    label: 'Technical Customer Success',
    title_terms: [
      'customer success',
      'technical success',
      'technical account manager',
      'customer engineer',
      'customer onboarding',
      'partner success',
      'client success',
    ],
    jd_terms: [
      'adoption',
      'support',
      'enablement',
      'customer outcomes',
      'retention',
      'expansion',
      'onboarding',
      'training',
      'troubleshooting',
      'post-sales',
    ],
    evidence_terms: [
      'adoption',
      'support',
      'enablement',
      'customer outcomes',
      'training',
      'troubleshooting',
      'support volume',
      'first-response',
      'user experience',
      'onboarding',
      'stakeholder',
    ],
  },
  {
    id: 'implementation',
    label: 'Implementation / Professional Services',
    title_terms: [
      'implementation',
      'implementation consultant',
      'implementation engineer',
      'professional services',
      'deployment',
      'onboarding specialist',
      'technical consultant',
    ],
    jd_terms: [
      'salesforce',
      'servicenow',
      'onboarding',
      'deployment',
      'configuration',
      'process mapping',
      'requirements gathering',
      'implementation',
      'go-live',
      'technical documentation',
    ],
    evidence_terms: [
      'salesforce',
      'servicenow',
      'onboarding',
      'deployment',
      'configuration',
      'process mapping',
      'requirements',
      'workflow',
      'documentation',
      'implementation',
      'go-live',
    ],
  },
];

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    parsed[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return parsed;
}

function stableJobId(url, company, title) {
  try {
    const parsed = new URL(url);
    return [
      parsed.hostname.toLowerCase(),
      parsed.pathname.replace(/\/+$/, '').toLowerCase(),
      parsed.searchParams.get('gh_jid') || '',
    ].filter(Boolean).join('|');
  } catch {
    return [url, company, title].filter(Boolean).join('|').toLowerCase();
  }
}

function safeFileId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180) || 'job';
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function tokenize(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !stopWords.has(token));
  return tokens;
}

function lowerText(text) {
  return String(text || '').toLowerCase();
}

function matchPhrases(text, phrases) {
  const lower = lowerText(text);
  return phrases.filter(phrase => lower.includes(phrase.toLowerCase()));
}

function detectRoleLane({ title = '', company = '', jdText = '' }) {
  const titleText = `${title}\n${company}`;
  const fullText = `${titleText}\n${jdText}`;
  const scored = roleLanes
    .map(lane => {
      const titleMatches = matchPhrases(titleText, lane.title_terms);
      const bodyTitleMatches = matchPhrases(jdText, lane.title_terms);
      const jdMatches = matchPhrases(fullText, lane.jd_terms);
      const score = (titleMatches.length * 8) + (bodyTitleMatches.length * 3) + jdMatches.length;
      return {
        id: lane.id,
        label: lane.label,
        score,
        matched_terms: [...new Set([...titleMatches, ...bodyTitleMatches, ...jdMatches])].slice(0, 16),
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const best = scored[0];
  return best && best.score > 0
    ? best
    : { id: 'general_technical_gtm', label: 'General Technical GTM', score: 0, matched_terms: [] };
}

function laneDefinition(laneId) {
  return roleLanes.find(lane => lane.id === laneId) || null;
}

function termFrequency(tokens) {
  const map = new Map();
  for (const token of tokens) map.set(token, (map.get(token) || 0) + 1);
  return map;
}

function topTerms(tokens, limit = 80) {
  return [...termFrequency(tokens).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function scoreText(text, jdTerms) {
  const tokens = tokenize(text);
  if (!tokens.length || !jdTerms.length) return { score: 0, matched_terms: [] };
  const terms = new Set(tokens);
  const matched = jdTerms.filter(term => terms.has(term));
  const density = matched.length / Math.max(Math.sqrt(tokens.length), 1);
  return {
    score: Number(density.toFixed(4)),
    matched_terms: matched.slice(0, 20),
  };
}

function scoreLaneFit(section, roleLane) {
  const lane = laneDefinition(roleLane.id);
  if (!lane) return { score: 0, matched_terms: [] };
  const haystack = [
    section.group,
    section.title,
    section.text,
    ...(section.bullets || []),
  ].join('\n');
  const matched = [...new Set(matchPhrases(haystack, lane.evidence_terms))];
  const groupBonus = (
    (roleLane.id === 'ai_fde' && section.group === 'projects') ||
    (roleLane.id === 'customer_success' && section.group === 'experience') ||
    (roleLane.id === 'implementation' && section.group === 'experience') ||
    (roleLane.id === 'sales_engineering' && section.group === 'experience') ||
    (roleLane.id === 'solutions_engineering' && ['experience', 'projects'].includes(section.group))
  ) ? 0.08 : 0;
  return {
    score: Number(((matched.length * 0.12) + groupBonus).toFixed(4)),
    matched_terms: matched.slice(0, 16),
  };
}

function flattenSections(context) {
  const out = [];
  for (const [group, sections] of Object.entries(context.sections || {})) {
    for (const section of sections || []) {
      out.push({ group, ...section });
    }
  }
  return out;
}

function scoreBullets(section, jdTerms) {
  return (section.bullets || [])
    .map(bullet => ({ bullet, ...scoreText(bullet, jdTerms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function scoreBulletsForLane(section, roleLane) {
  const lane = laneDefinition(roleLane.id);
  if (!lane) return [];
  return (section.bullets || [])
    .map(bullet => {
      const matched = [...new Set(matchPhrases(bullet, lane.evidence_terms))];
      return {
        bullet,
        score: Number((matched.length * 0.12).toFixed(4)),
        matched_terms: matched.slice(0, 12),
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

const jobId = args.jobId || stableJobId(args.url || '', args.company || '', args.title || '');
const safeId = safeFileId(jobId);
const jdPath = args.jd || path.join(jobDescriptionDir, `${safeId}.md`);
const outputPath = args.output || path.join(outputDir, `${safeId}.json`);

if (!existsSync(contextPath)) {
  console.error(`Missing career context: ${contextPath}. Run npm run build:career-context first.`);
  process.exit(1);
}

if (!existsSync(jdPath)) {
  console.error(`Missing cached job description: ${jdPath}. Run npm run cache:jd first.`);
  process.exit(2);
}

const context = readJson(contextPath);
const jdText = readFileSync(jdPath, 'utf8');
const jdTerms = topTerms(tokenize(jdText), Number(args.termLimit || 90));
const roleLane = detectRoleLane({
  title: args.title || '',
  company: args.company || '',
  jdText,
});

const sections = flattenSections(context)
  .map(section => {
    const scored = scoreText(`${section.title}\n${section.text || ''}`, jdTerms);
    const laneScored = scoreLaneFit(section, roleLane);
    const topBullets = [
      ...scoreBullets(section, jdTerms),
      ...scoreBulletsForLane(section, roleLane),
    ]
      .sort((a, b) => b.score - a.score)
      .filter((item, index, arr) => arr.findIndex(other => other.bullet === item.bullet) === index)
      .slice(0, 5);
    return {
      group: section.group,
      title: section.title,
      key: section.key,
      score: Number((scored.score + laneScored.score).toFixed(4)),
      term_score: scored.score,
      lane_score: laneScored.score,
      matched_terms: scored.matched_terms,
      lane_matched_terms: laneScored.matched_terms,
      top_bullets: topBullets,
    };
  })
  .filter(section => section.score > 0)
  .sort((a, b) => b.score - a.score || b.lane_score - a.lane_score || a.title.localeCompare(b.title))
  .slice(0, Number(args.sectionLimit || 12));

const result = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  job_id: jobId,
  role_lane: roleLane.id,
  role_lane_label: roleLane.label,
  role_lane_signals: roleLane.matched_terms,
  sources: {
    career_context: contextPath,
    job_description: jdPath,
  },
  jd_top_terms: jdTerms.slice(0, 40),
  sections,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  ok: true,
  output_path: outputPath,
  sections: sections.length,
  top_section: sections[0]?.title || '',
}, null, 2));
