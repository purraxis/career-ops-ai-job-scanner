#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import path from 'path';

const args = parseArgs(process.argv.slice(2));
const outputPath = args.output || 'data/generation-requests.tsv';
const allowedTypes = new Set(['resume', 'letter', 'application_answer']);

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
    appendFileSync(filePath, 'timestamp\ttype\tjob_id\tcompany\ttitle\turl\tstatus\toutput_path\n', 'utf8');
  }
}

const type = sanitize(args.type || '');
if (!allowedTypes.has(type)) {
  console.error(`Missing or invalid --type. Expected one of: ${[...allowedTypes].join(', ')}`);
  process.exit(1);
}

const url = sanitize(args.url || '');
const company = sanitize(args.company || '');
const title = sanitize(args.title || '');
const row = [
  new Date().toISOString(),
  type,
  sanitize(args.jobId || stableJobId(url, company, title)),
  company,
  title,
  url,
  sanitize(args.status || 'pending'),
  sanitize(args.outputPath || ''),
];

ensureHeader(outputPath);
appendFileSync(outputPath, `${row.join('\t')}\n`, 'utf8');

console.log(`Queued ${type} request in ${outputPath}`);
