#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const DEFAULT_OUTPUT_PATH = 'data/ui-state.json';

const args = parseArgs(process.argv.slice(2));
const outputPath = args.output || DEFAULT_OUTPUT_PATH;

const paths = {
  pipeline: args.pipeline || 'data/pipeline.md',
  needsReview: args.needsReview || 'data/needs-review.md',
  rejectedJobs: args.rejectedJobs || 'data/rejected-jobs.tsv',
  scanHistory: args.scanHistory || 'data/scan-history.tsv',
  jobActions: args.jobActions || 'data/job-actions.tsv',
  latestScanSummary: args.latestScanSummary || 'data/latest-scan-summary.json',
  companyCoverage: args.companyCoverage || 'data/company-coverage.json',
  careerContext: args.careerContext || 'data/career-context.json',
};

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    parsed[key] = value;
  }
  return parsed;
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function normalizeBlank(value) {
  return String(value ?? '').trim();
}

function cleanMarkdownEscapes(value) {
  return normalizeBlank(value)
    .replace(/\\([\\[\]])/g, '$1')
    .replace(/&amp;/g, '&');
}

function extractPipelineUrl(line) {
  const markdownLink = line.match(/^- \[[ x]\]\s+\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/);
  if (markdownLink) return cleanMarkdownEscapes(markdownLink[1]);

  const rawUrl = line.match(/^- \[[ x]\]\s+(https?:\/\/[^\s|)]+)/);
  return rawUrl ? cleanMarkdownEscapes(rawUrl[1]) : '';
}

function extractPipelineLinkText(line) {
  const markdownLink = line.match(/^- \[[ x]\]\s+\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/);
  return markdownLink ? cleanMarkdownEscapes(markdownLink[1]) : '';
}

function splitPipelineColumns(line) {
  const parts = line.split('|').map(cleanMarkdownEscapes);
  return parts.slice(1);
}

function parsePipeline(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('- [ ]')) continue;
    const url = extractPipelineUrl(line);
    if (!url) continue;

    const columns = splitPipelineColumns(line);
    const linkText = extractPipelineLinkText(line);
    const company = columns[0] || splitLinkText(linkText).company || '';
    const title = columns[1] || splitLinkText(linkText).title || '';
    const location = columns[2] || '';
    const compensation = columns[3] || '';

    entries.push({
      id: stableJobId(url, company, title),
      status: 'pending',
      url,
      final_url: url,
      company,
      title,
      location,
      compensation,
      label: [company, title].filter(Boolean).join(' - ') || linkText || url,
    });
  }
  return entries;
}

function splitLinkText(value) {
  const text = cleanMarkdownEscapes(value);
  const match = text.match(/^(.+?)\s+-\s+(.+)$/);
  if (!match) return { company: '', title: text };
  return { company: match[1].trim(), title: match[2].trim() };
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

function parseNeedsReview(text) {
  const entries = [];
  const blocks = text.split(/\n(?=### )/g).filter(block => block.trim().startsWith('### '));
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const heading = cleanMarkdownEscapes(lines[0].replace(/^###\s+/, ''));
    const fields = {};
    for (const line of lines.slice(1)) {
      const match = line.match(/^- ([^:]+):\s*(.*)$/);
      if (match) fields[match[1].trim().toLowerCase()] = cleanMarkdownEscapes(match[2]);
    }
    const { company, title } = splitHeading(heading);
    const url = fields['apply url'] || fields['final url'] || '';
    entries.push({
      id: stableJobId(url || heading, company, title),
      status: 'needs_review',
      company,
      title,
      location: fields.location || '',
      provider: fields.provider || '',
      url,
      final_url: fields['final url'] || url,
      classification: fields.classification || '',
      verification_method: fields['verification method'] || '',
      verification_reason: fields['verification reason'] || '',
      review_category: fields['review category'] || '',
      why_not_rejected: fields['why not rejected'] || '',
      why_not_accepted: fields['why not accepted'] || '',
      date_scanned: fields['date scanned'] || '',
    });
  }
  return entries;
}

function splitHeading(value) {
  const parts = cleanMarkdownEscapes(value).split(/\s+—\s+/);
  if (parts.length < 2) return { company: '', title: value };
  return { company: parts[0].trim(), title: parts.slice(1).join(' — ').trim() };
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split('\t').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    return Object.fromEntries(headers.map((header, i) => [header, cleanMarkdownEscapes(cells[i] || '')]));
  });
}

function parseRejectedJobs(text) {
  return parseTsv(text).map(row => ({
    id: stableJobId(row.source_url || row.final_url || '', row.company, row.title),
    status: 'rejected',
    date: row.date || '',
    provider: row.provider || '',
    url: row.source_url || '',
    final_url: row.final_url || row.source_url || '',
    fetched_at: row.fetched_at || '',
    posted_at: row.posted_at || '',
    http_status: row.http_status || '',
    classification: row.classification || '',
    verification_status: row.verification_status || '',
    rejection_reason: row.rejection_reason || '',
    title: row.title || '',
    company: row.company || '',
    location: row.location || '',
  }));
}

function parseScanHistory(text) {
  return parseTsv(text).map(row => ({
    url: row.url || '',
    first_seen: row.first_seen || '',
    provider: row.portal || '',
    title: row.title || '',
    company: row.company || '',
    status: row.status || '',
    location: row.location || '',
  }));
}

function parseJobActions(text) {
  return parseTsv(text).map(row => ({
    timestamp: row.timestamp || '',
    action: row.action || '',
    job_id: row.job_id || '',
    company: row.company || '',
    title: row.title || '',
    url: row.url || '',
    note: row.note || '',
  }));
}

function readJson(filePath, fallback = null) {
  const text = readText(filePath);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function newestDate(values) {
  return values.filter(Boolean).sort().at(-1) || '';
}

const pipeline = parsePipeline(readText(paths.pipeline));
const needsReview = parseNeedsReview(readText(paths.needsReview));
const rejected = parseRejectedJobs(readText(paths.rejectedJobs));
const scanHistory = parseScanHistory(readText(paths.scanHistory));
const jobActions = parseJobActions(readText(paths.jobActions));
const latestScanSummary = readJson(paths.latestScanSummary);
const companyCoverage = readJson(paths.companyCoverage);
const careerContext = readJson(paths.careerContext);
const historyByUrl = new Map(scanHistory.filter(row => row.url).map(row => [row.url, row]));
for (const item of pipeline) {
  const history = historyByUrl.get(item.url);
  if (!history) continue;
  item.provider = history.provider || item.provider || '';
  item.first_seen = history.first_seen || '';
  item.scan_status = history.status || '';
}

const state = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  sources: paths,
  last_scan_at: newestDate([
    ...scanHistory.map(row => row.first_seen),
    ...needsReview.map(row => row.date_scanned),
    ...rejected.map(row => row.date),
  ]),
  stats: {
    pipeline_count: pipeline.length,
    needs_review_count: needsReview.length,
    rejected_count: rejected.length,
    scan_history_count: scanHistory.length,
    job_actions_count: jobActions.length,
    pipeline_by_company: countBy(pipeline, 'company'),
    needs_review_by_provider: countBy(needsReview, 'provider'),
    rejected_by_reason: countBy(rejected, 'rejection_reason'),
  },
  latest_scan_summary: latestScanSummary,
  company_coverage: companyCoverage,
  career_context: careerContext,
  job_actions: jobActions,
  pipeline,
  needs_review: needsReview,
  rejected,
  scan_history: scanHistory,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`Pipeline: ${pipeline.length}`);
console.log(`Needs review: ${needsReview.length}`);
console.log(`Rejected: ${rejected.length}`);
console.log(`Scan history rows: ${scanHistory.length}`);
