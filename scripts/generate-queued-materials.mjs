#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import path from 'path';

const queuePath = process.env.CAREER_OPS_GENERATION_QUEUE || 'data/generation-requests.tsv';
const requiredPrivateSources = [
  process.env.CAREER_OPS_CV || 'private/cv.md',
  process.env.CAREER_OPS_PROFILE || 'private/config/profile.yml',
  process.env.CAREER_OPS_RESUME_RULES || 'private/config/resume_rules.yml',
];

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split('\t').map(value => value.trim());
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    return Object.fromEntries(headers.map((header, i) => [header, cells[i] || '']));
  });
}

function safeFileId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180) || 'job';
}

function defaultJdPath(request) {
  return path.join('data/job-descriptions', `${safeFileId(request.job_id)}.md`);
}

function defaultContextPath(request) {
  return path.join('data/context-matches', `${safeFileId(request.job_id)}.json`);
}

const requests = existsSync(queuePath) ? parseTsv(readFileSync(queuePath, 'utf8')) : [];
const pending = requests.filter(request => request.status === 'pending');
const missingPrivateSources = requiredPrivateSources.filter(filePath => !existsSync(filePath));

console.log(`Generation queue: ${queuePath}`);
console.log(`Total requests: ${requests.length}`);
console.log(`Pending requests: ${pending.length}`);
if (missingPrivateSources.length) {
  console.log('Missing required private sources:');
  for (const filePath of missingPrivateSources) console.log(`- ${filePath}`);
}

if (!pending.length) {
  console.log('No queued materials to generate.');
  process.exit(0);
}

console.log('Readiness check only. No token-cost generation is wired yet.');
for (const request of pending.slice(0, 20)) {
  const jdPath = request.jd_cache_path || defaultJdPath(request);
  const contextPath = request.context_match_path || defaultContextPath(request);
  const blockers = [];
  if (!existsSync(jdPath)) blockers.push(`missing JD cache (${jdPath})`);
  if (missingPrivateSources.length) blockers.push('missing private sources');
  const warnings = [];
  if (!existsSync(contextPath)) warnings.push(`missing context match (${contextPath})`);
  const status = blockers.length ? `blocked: ${blockers.join('; ')}` : 'ready';
  const suffix = warnings.length ? ` | warning: ${warnings.join('; ')}` : '';
  console.log(`- ${request.type}: ${request.company} - ${request.title} | ${status}${suffix}`);
}
