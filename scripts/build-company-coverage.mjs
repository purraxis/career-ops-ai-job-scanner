#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const args = parseArgs(process.argv.slice(2));
const defaultPortals = process.env.CAREER_OPS_PORTALS
  || (existsSync('private/portals.yml') ? 'private/portals.yml' : 'portals.yml');
const portalsPath = args.file || args.portals || defaultPortals;
const outputPath = args.output || 'data/company-coverage.json';
const scanHistoryPath = args.scanHistory || 'data/scan-history.tsv';

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
  return String(value ?? '').trim();
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

function detectProvider(entry) {
  if (entry.provider) return entry.provider;
  const url = String(entry.careers_url || entry.api || '').toLowerCase();
  if (url.includes('jobs.ashbyhq.com/')) return 'ashby';
  if (url.includes('jobs.lever.co/')) return 'lever';
  if (
    url.includes('job-boards.greenhouse.io/')
    || url.includes('job-boards.eu.greenhouse.io/')
    || url.includes('boards.greenhouse.io/')
    || url.includes('boards-api.greenhouse.io/')
  ) return 'greenhouse';
  if (url.includes('myworkdayjobs.com') || url.includes('workdayjobs.com')) return 'workday';
  if (url.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (url.includes('comeet.com')) return 'comeet';
  if (url.includes('bamboohr.com')) return 'bamboohr';
  if (url.includes('rippling-ats.com') || url.includes('ats.rippling.com')) return 'rippling';
  return url ? 'unsupported/custom' : 'missing_url';
}

function normalizeCompany(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

const config = yaml.load(readText(portalsPath)) || {};
const scanHistory = parseTsv(readText(scanHistoryPath));
const historyByCompany = new Map();
for (const row of scanHistory) {
  const key = normalizeCompany(row.company);
  if (!key) continue;
  const existing = historyByCompany.get(key) || { count: 0, latest_seen: '', statuses: {} };
  existing.count += 1;
  if (row.first_seen > existing.latest_seen) existing.latest_seen = row.first_seen;
  const status = row.status || 'unknown';
  existing.statuses[status] = (existing.statuses[status] || 0) + 1;
  historyByCompany.set(key, existing);
}

const trackedCompanies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
const companies = trackedCompanies.map(entry => {
  const provider = detectProvider(entry);
  const history = historyByCompany.get(normalizeCompany(entry.name)) || null;
  return {
    name: entry.name || '',
    enabled: entry.enabled !== false,
    provider,
    careers_url: entry.careers_url || entry.api || '',
    priority: entry.priority || '',
    allow_empty_board: Boolean(entry.allow_empty_board),
    notes: entry.notes || entry.reason || '',
    last_seen: history?.latest_seen || '',
    scan_history_count: history?.count || 0,
    scan_statuses: history?.statuses || {},
  };
});

const aggregatorSources = Object.entries(config.us_aggregator_sources || {}).map(([name, source]) => ({
  name,
  enabled: source?.enabled === true,
  country: source?.country || '',
  priority: source?.priority || '',
  reason: source?.reason || '',
}));

const coverage = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_file: portalsPath,
  summary: {
    tracked_companies: companies.length,
    enabled_companies: companies.filter(company => company.enabled).length,
    disabled_companies: companies.filter(company => !company.enabled).length,
    by_provider: countBy(companies, 'provider'),
    zero_history_enabled_boards: companies.filter(company => company.enabled && company.scan_history_count === 0).length,
    allow_empty_boards: companies.filter(company => company.allow_empty_board).length,
    aggregator_sources: aggregatorSources.length,
    enabled_aggregator_sources: aggregatorSources.filter(source => source.enabled).length,
  },
  companies,
  aggregator_sources: aggregatorSources,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(coverage, null, 2) + '\n', 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`Tracked companies: ${coverage.summary.tracked_companies}`);
console.log(`Enabled companies: ${coverage.summary.enabled_companies}`);
console.log(`Providers: ${JSON.stringify(coverage.summary.by_provider)}`);
