#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const args = parseArgs(process.argv.slice(2));
const type = args.type || 'resume';
const jobId = args.jobId || '';
const company = args.company || '';
const title = args.title || '';
const url = args.url || '';
const outputDir = args.outputDir || 'output/final-generation-packages';
const cvPath = args.cv || process.env.CAREER_OPS_CV || 'private/cv.md';
const profilePath = args.profile || process.env.CAREER_OPS_PROFILE || 'private/config/profile.yml';
const rulesPath = args.rules || process.env.CAREER_OPS_RESUME_RULES || 'private/config/resume_rules.yml';
const githubEvidencePath = args.githubEvidence || process.env.CAREER_OPS_GITHUB_EVIDENCE || 'private/config/github_evidence.yml';
const jdPath = args.jd || defaultJdPath(jobId);
const contextPath = args.context || defaultContextPath(jobId);
const guidePath = args.guide || 'docs/materials-generation.md';
const voicePath = args.voice || process.env.CAREER_OPS_VOICE_DNA || 'private/support/voice-dna.md';
const articleDigestPath = args.articleDigest || 'private/support/article-digest.md';
const privateMaterialKitDir = args.materialKit || 'private/material-kit';

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

function safeFileId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180) || 'job';
}

function defaultJdPath(id) {
  return path.join('data/job-descriptions', `${safeFileId(id)}.md`);
}

function defaultContextPath(id) {
  return path.join('data/context-matches', `${safeFileId(id)}.json`);
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function readYaml(filePath) {
  const text = readText(filePath);
  return text ? yaml.load(text) || {} : {};
}

function readJson(filePath) {
  const text = readText(filePath);
  return text ? JSON.parse(text) : null;
}

function requiredSource(name, filePath) {
  return { name, path: filePath, exists: existsSync(filePath), required: true };
}

function optionalSource(name, filePath) {
  return { name, path: filePath, exists: existsSync(filePath), required: false };
}

function privateMaterialKitSources(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .filter(file => file.endsWith('.md'))
    .sort()
    .map(file => optionalSource(`private material kit: ${file}`, path.join(dirPath, file)));
}

function fenced(label, content) {
  return [
    `## ${label}`,
    '',
    '```text',
    content.trim() || '(missing or empty)',
    '```',
    '',
  ].join('\n');
}

function finalInstructions(materialType) {
  if (materialType === 'letter') {
    return [
      'Create a short, warm, direct cover letter for this role.',
      '',
      'Rules:',
      '- Exactly 3 short paragraphs.',
      '- Use private career facts only.',
      '- Mention the company/product specifically.',
      '- Connect one or two strongest proof points to the role.',
      '- Avoid corporate fluff, over-explaining, exaggerated claims, and invented facts.',
      '- Signature must be plain text only: use the candidate name from the private profile.',
      '- Do not include HTML tags such as <br>.',
      '- Final delivery should be ready to render as PDF.',
    ].join('\n');
  }

  return [
    'Create a one-page, ATS-readable, job-description-matched tailored resume.',
    '',
    'Rules:',
    '- Use private/cv.md as the master factual career database.',
    '- Use profile.yml for positioning and proof points.',
    '- Use resume_rules.yml for length, spacing, density, sections, and formatting.',
    '- Use the cached JD and context match to tailor this resume materially to the role.',
    '- Do not invent facts, tools, employers, credentials, certifications, dates, metrics, or responsibilities.',
    '- If the JD asks for something unsupported, bridge only with truthful adjacent experience.',
    '- At least 5 bullets should be role-specific or materially rewritten.',
    '- Prioritize role-relevant discovery, demos, implementation, AI workflows, Salesforce, ServiceNow, SQL, APIs, dashboards, stakeholder alignment, technical enablement, customer workflows, and ROI when supported.',
    '- Selected Projects must only use real public GitHub evidence from purraxis repos; feature career-ops-ai-job-scanner prominently when a projects section is included.',
    '- Use only technologies and project claims evidenced in the GitHub Evidence YAML. Do not use skipped, weak, forked, starter, or ambiguous repos unless explicitly marked as approved.',
    '- Default to one page and prepare final content for PDF rendering.',
  ].join('\n');
}

function summarizeContext(match) {
  if (!match?.sections?.length) return [];
  return match.sections.slice(0, 8).map(section => ({
    title: section.title,
    group: section.group,
    matched_terms: section.matched_terms || [],
    top_bullets: (section.top_bullets || []).slice(0, 5).map(item => item.bullet || item),
  }));
}

if (!['resume', 'letter'].includes(type)) {
  console.error('Missing or invalid --type. Expected resume or letter.');
  process.exit(1);
}
if (!jobId) {
  console.error('Missing required --job-id value.');
  process.exit(1);
}

const sources = [
  requiredSource('master cv', cvPath),
  requiredSource('profile', profilePath),
  requiredSource('resume rules', rulesPath),
  optionalSource('github evidence', githubEvidencePath),
  requiredSource('cached job description', jdPath),
  requiredSource('career context match', contextPath),
  optionalSource('materials generation guide', guidePath),
  optionalSource('voice dna', voicePath),
  optionalSource('article digest', articleDigestPath),
  ...privateMaterialKitSources(privateMaterialKitDir),
];

const missingRequired = sources.filter(source => source.required && !source.exists);
if (missingRequired.length) {
  console.error('Missing required sources:');
  for (const source of missingRequired) console.error(`- ${source.name}: ${source.path}`);
  process.exit(1);
}

const profile = readYaml(profilePath);
const rules = readYaml(rulesPath);
const match = readJson(contextPath);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(outputDir, safeFileId(jobId));
mkdirSync(dir, { recursive: true });
const base = `${stamp}-${safeFileId(type)}-final-package`;
const packagePath = path.join(dir, `${base}.md`);
const manifestPath = path.join(dir, `${base}.json`);

const manifest = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  type,
  job: { job_id: jobId, company, title, url },
  output: { package_path: packagePath, manifest_path: manifestPath },
  sources,
  role_context: {
    target_roles: profile.target_roles || {},
    positioning: profile.positioning || profile.narrative || {},
    resume_rules_summary: {
      layout: rules.layout || {},
      content_budget: rules.content_budget || {},
      project_source_rules: rules.project_source_rules || {},
    },
    github_evidence: {
      path: githubEvidencePath,
      exists: existsSync(githubEvidencePath),
      flagship_repo: 'career-ops-ai-job-scanner',
    },
    matched_sections: summarizeContext(match),
  },
};

const packageMarkdown = [
  `# Final ${type === 'letter' ? 'Cover Letter' : 'Resume'} Generation Package`,
  '',
  'This package is private local output. It is intended for an explicit final AI generation step and should stay out of git.',
  '',
  '## Token-Cost Boundary',
  '',
  'Do not call an LLM automatically. Use this package only when the user explicitly chooses final resume or cover letter generation.',
  '',
  '## Job',
  '',
  `- Company: ${company || 'Unknown'}`,
  `- Title: ${title || 'Unknown'}`,
  `- URL: ${url || 'Unknown'}`,
  `- Job ID: ${jobId}`,
  '',
  '## Final Generation Instructions',
  '',
  finalInstructions(type),
  '',
  fenced('Cached Job Description', readText(jdPath)),
  fenced('Career Context Match JSON', JSON.stringify(match, null, 2)),
  fenced('Master CV', readText(cvPath)),
  fenced('Structured Profile YAML', readText(profilePath)),
  fenced('Resume Rules YAML', readText(rulesPath)),
  fenced('GitHub Evidence YAML', readText(githubEvidencePath)),
  fenced('Materials Generation Guide', readText(guidePath)),
  fenced('Voice DNA', readText(voicePath)),
  fenced('Article Digest / Proof Points', readText(articleDigestPath)),
  ...privateMaterialKitSources(privateMaterialKitDir)
    .filter(source => source.exists)
    .map(source => fenced(source.name, readText(source.path))),
].join('\n');

writeFileSync(packagePath, packageMarkdown, 'utf8');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  ok: true,
  type,
  job_id: jobId,
  package_path: packagePath,
  manifest_path: manifestPath,
}, null, 2));
