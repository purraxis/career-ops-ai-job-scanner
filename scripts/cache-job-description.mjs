#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const args = parseArgs(process.argv.slice(2));
const outputDir = args.outputDir || 'data/job-descriptions';

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

function decodeEntities(text) {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&([a-z]+);/gi, (match, key) => entities[key.toLowerCase()] || match);
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(match[1]).slice(0, 180) : '';
}

function cleanText(text) {
  return decodeEntities(String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function htmlToText(html) {
  const stripped = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  return cleanText(stripped);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(args.timeoutMs || 20000));
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get('content-type') || '',
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

const url = args.url;
if (!url || !String(url).startsWith('http') && !String(url).startsWith('data:')) {
  console.error('Missing required --url value.');
  process.exit(1);
}

const company = args.company || '';
const title = args.title || '';
const jobId = args.jobId || stableJobId(url, company, title);
const safeId = safeFileId(jobId);
const outputPath = path.join(outputDir, `${safeId}.md`);
const result = await fetchText(url);

if (!result.ok) {
  console.error(`Failed to cache JD: HTTP ${result.status}`);
  process.exit(2);
}

const pageTitle = result.contentType.includes('html') || result.body.includes('<html')
  ? extractTitle(result.body)
  : '';
const text = result.contentType.includes('html') || result.body.includes('<html')
  ? htmlToText(result.body)
  : cleanText(result.body);

if (text.length < Number(args.minChars || 160)) {
  console.error(`Failed to cache JD: extracted text too short (${text.length} chars)`);
  process.exit(3);
}

mkdirSync(outputDir, { recursive: true });
const markdown = [
  '# Cached Job Description',
  '',
  `- Cached At: ${new Date().toISOString()}`,
  `- Job ID: ${jobId}`,
  `- Company: ${company || 'Unknown'}`,
  `- Title: ${title || pageTitle || 'Unknown'}`,
  `- Source URL: ${url}`,
  `- Final URL: ${result.finalUrl || url}`,
  `- HTTP Status: ${result.status}`,
  '',
  '## Extracted Text',
  '',
  text.slice(0, Number(args.maxChars || 60000)),
  '',
].join('\n');

writeFileSync(outputPath, markdown, 'utf8');
console.log(JSON.stringify({
  ok: true,
  output_path: outputPath,
  final_url: result.finalUrl || url,
  status: result.status,
  chars: text.length,
}, null, 2));
