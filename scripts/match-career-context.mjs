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

const sections = flattenSections(context)
  .map(section => {
    const scored = scoreText(`${section.title}\n${section.text || ''}`, jdTerms);
    return {
      group: section.group,
      title: section.title,
      key: section.key,
      score: scored.score,
      matched_terms: scored.matched_terms,
      top_bullets: scoreBullets(section, jdTerms),
    };
  })
  .filter(section => section.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, Number(args.sectionLimit || 12));

const result = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  job_id: jobId,
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
