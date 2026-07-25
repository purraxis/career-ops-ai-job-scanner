#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import path from 'path';

const args = parseArgs(process.argv.slice(2));
const outputPath = args.output || 'data/job-actions.tsv';

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

function sanitize(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
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

function ensureHeader(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath) || !readFileSync(filePath, 'utf8').trim()) {
    appendFileSync(filePath, 'timestamp\taction\tjob_id\tcompany\ttitle\turl\tnote\n', 'utf8');
  }
}

if (!args.action) {
  console.error('Missing required --action value.');
  process.exit(1);
}

const url = sanitize(args.url || '');
const company = sanitize(args.company || '');
const title = sanitize(args.title || '');
const row = [
  new Date().toISOString(),
  sanitize(args.action),
  sanitize(args.jobId || stableJobId(url, company, title)),
  company,
  title,
  url,
  sanitize(args.note || ''),
];

ensureHeader(outputPath);
appendFileSync(outputPath, `${row.join('\t')}\n`, 'utf8');

console.log(`Logged ${row[1]} to ${outputPath}`);
