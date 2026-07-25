#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const args = parseArgs(process.argv.slice(2));
const outputPath = args.output || 'data/latest-scan-summary.json';
const paths = {
  pipeline: args.pipeline || 'data/pipeline.md',
  needsReview: args.needsReview || 'data/needs-review.md',
  rejectedJobs: args.rejectedJobs || 'data/rejected-jobs.tsv',
  scanHistory: args.scanHistory || 'data/scan-history.tsv',
};

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

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function clean(value) {
  return String(value ?? '').trim().replace(/\\([\\[\]])/g, '$1');
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split('\t').map(clean);
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    return Object.fromEntries(headers.map((header, i) => [header, clean(cells[i] || '')]));
  });
}

function parseNeedsReview(text) {
  const blocks = text.split(/\n(?=### )/g).filter(block => block.trim().startsWith('### '));
  return blocks.map(block => {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^- ([^:]+):\s*(.*)$/);
      if (match) fields[match[1].trim().toLowerCase()] = clean(match[2]);
    }
    return {
      provider: fields.provider || '',
      review_category: fields['review category'] || '',
      verification_reason: fields['verification reason'] || '',
      date_scanned: fields['date scanned'] || '',
    };
  });
}

function parsePipelineCount(text) {
  return text.split(/\r?\n/).filter(line => line.trim().startsWith('- [ ]')).length;
}

function countBy(items, selector) {
  return items.reduce((acc, item) => {
    const value = selector(item) || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function newestDate(values) {
  return values.filter(Boolean).sort().at(-1) || '';
}

const scanHistory = parseTsv(readText(paths.scanHistory));
const rejected = parseTsv(readText(paths.rejectedJobs));
const needsReview = parseNeedsReview(readText(paths.needsReview));
const pipelineCount = parsePipelineCount(readText(paths.pipeline));

const latestScanAt = newestDate([
  ...scanHistory.map(row => row.first_seen),
  ...rejected.map(row => row.date),
  ...needsReview.map(row => row.date_scanned),
]);

const latestScanHistoryRows = latestScanAt
  ? scanHistory.filter(row => row.first_seen === latestScanAt)
  : scanHistory;
const latestRejectedRows = latestScanAt
  ? rejected.filter(row => row.date === latestScanAt)
  : rejected;
const latestReviewRows = latestScanAt
  ? needsReview.filter(row => row.date_scanned === latestScanAt)
  : needsReview;

const summary = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  latest_scan_at: latestScanAt,
  sources: paths,
  totals: {
    pipeline: pipelineCount,
    needs_review: needsReview.length,
    rejected: rejected.length,
    scan_history: scanHistory.length,
  },
  latest_scan: {
    fetched_or_seen: latestScanHistoryRows.length,
    saved_to_pipeline: latestScanHistoryRows.filter(row => row.status === 'added').length,
    needs_review: latestReviewRows.length,
    rejected: latestRejectedRows.length,
    by_provider: countBy(latestScanHistoryRows, row => row.portal),
    by_status: countBy(latestScanHistoryRows, row => row.status),
    rejected_by_reason: countBy(latestRejectedRows, row => row.rejection_reason),
    needs_review_by_provider: countBy(latestReviewRows, row => row.provider),
    needs_review_by_category: countBy(latestReviewRows, row => row.review_category),
  },
  all_time: {
    scan_history_by_provider: countBy(scanHistory, row => row.portal),
    scan_history_by_status: countBy(scanHistory, row => row.status),
    rejected_by_reason: countBy(rejected, row => row.rejection_reason),
    rejected_by_provider: countBy(rejected, row => row.provider),
    needs_review_by_provider: countBy(needsReview, row => row.provider),
    needs_review_by_category: countBy(needsReview, row => row.review_category),
  },
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`Latest scan: ${summary.latest_scan_at || 'unknown'}`);
console.log(`Pipeline: ${summary.totals.pipeline}`);
console.log(`Needs review: ${summary.totals.needs_review}`);
console.log(`Rejected: ${summary.totals.rejected}`);
