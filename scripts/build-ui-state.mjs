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
  generationRequests: args.generationRequests || 'data/generation-requests.tsv',
  jobDescriptionDir: args.jobDescriptionDir || 'data/job-descriptions',
  contextMatchesDir: args.contextMatchesDir || 'data/context-matches',
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

function parseGenerationRequests(text) {
  return parseTsv(text).map(row => ({
    timestamp: row.timestamp || '',
    type: row.type || '',
    job_id: row.job_id || '',
    company: row.company || '',
    title: row.title || '',
    url: row.url || '',
    status: row.status || '',
    jd_cache_path: row.jd_cache_path || '',
    output_path: row.output_path || '',
  }));
}

function safeFileId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180) || 'job';
}

function jobDescriptionPath(item) {
  const id = item.id || stableJobId(item.url || item.final_url || '', item.company, item.title);
  return path.join(paths.jobDescriptionDir, `${safeFileId(id)}.md`);
}

function contextMatchPath(item) {
  const id = item.id || stableJobId(item.url || item.final_url || '', item.company, item.title);
  return path.join(paths.contextMatchesDir, `${safeFileId(id)}.json`);
}

function enrichJobDescriptionState(items) {
  return items.map(item => {
    const jdCachePath = jobDescriptionPath(item);
    const matchPath = contextMatchPath(item);
    return {
      ...item,
      jd_cache_path: jdCachePath,
      jd_cached: existsSync(jdCachePath),
      context_match_path: matchPath,
      context_matched: existsSync(matchPath),
    };
  });
}

function latestActionsByJobId(actions) {
  const byId = new Map();
  for (const action of actions) {
    const ids = [
      action.job_id,
      stableJobId(action.url, action.company, action.title),
    ].filter(Boolean);
    for (const id of ids) {
      const previous = byId.get(id);
      if (!previous || action.timestamp > previous.timestamp) byId.set(id, action);
    }
  }
  return byId;
}

function actionForItem(item, actionsById) {
  return actionsById.get(item.id)
    || actionsById.get(stableJobId(item.url || item.final_url || '', item.company, item.title))
    || null;
}

function applyActionState(items, actionsById) {
  return items.map(item => {
    const latestAction = actionForItem(item, actionsById);
    const action = latestAction?.action || '';
    const isApplied = action === 'applied';
    const isRejectedByUser = action === 'rejected_by_user';
    const isMovedToPipeline = action === 'moved_to_pipeline' || action === 'move_to_pipeline_skipped';
    return {
      ...item,
      latest_action: latestAction,
      is_handled: Boolean(latestAction && ['applied', 'rejected_by_user', 'moved_to_pipeline', 'move_to_pipeline_skipped'].includes(action)),
      is_applied: isApplied,
      is_rejected_by_user: isRejectedByUser,
      is_moved_to_pipeline: isMovedToPipeline,
    };
  });
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

function validationPathForOutput(outputPath) {
  return outputPath && outputPath.endsWith('.pdf')
    ? outputPath.replace(/\.pdf$/, '.validation.json')
    : '';
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
const generationRequests = parseGenerationRequests(readText(paths.generationRequests));
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
const actionsById = latestActionsByJobId(jobActions);
const actionedPipeline = enrichJobDescriptionState(applyActionState(pipeline, actionsById));
const actionedNeedsReview = enrichJobDescriptionState(applyActionState(needsReview, actionsById));
const actionedRejected = enrichJobDescriptionState(applyActionState(rejected, actionsById));
const enrichedGenerationRequests = generationRequests.map(request => {
  const jdCachePath = request.jd_cache_path || jobDescriptionPath({
    id: request.job_id,
    url: request.url,
    company: request.company,
    title: request.title,
  });
  const matchPath = contextMatchPath({
    id: request.job_id,
    url: request.url,
    company: request.company,
    title: request.title,
  });
  const validationPath = validationPathForOutput(request.output_path);
  const validation = validationPath ? readJson(validationPath) : null;
  return {
    ...request,
    jd_cache_path: jdCachePath,
    jd_cached: existsSync(jdCachePath),
    context_match_path: matchPath,
    context_matched: existsSync(matchPath),
    output_exists: Boolean(request.output_path && existsSync(request.output_path)),
    validation_path: validationPath,
    validation_exists: Boolean(validationPath && existsSync(validationPath)),
    validation,
  };
});
const today = new Date().toISOString().slice(0, 10);
const queues = {
  active_review: actionedNeedsReview.filter(item => !item.is_moved_to_pipeline && !item.is_rejected_by_user),
  handled_review: actionedNeedsReview.filter(item => item.is_moved_to_pipeline || item.is_rejected_by_user),
  active_pipeline: actionedPipeline.filter(item => !item.is_applied && !item.is_rejected_by_user),
  applied: actionedPipeline.filter(item => item.is_applied),
  apply_today: actionedPipeline.filter(item => {
    const action = item.latest_action;
    return !item.is_applied
      && !item.is_rejected_by_user
      && action?.action === 'moved_to_pipeline'
      && action.timestamp?.slice(0, 10) === today;
  }),
};

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
    generation_requests_count: enrichedGenerationRequests.length,
    pending_generation_requests_count: enrichedGenerationRequests.filter(request => request.status === 'pending').length,
    generated_pdf_count: enrichedGenerationRequests.filter(request => request.status === 'generated_pdf').length,
    generated_needs_content_review_count: enrichedGenerationRequests.filter(request => request.status === 'generated_needs_content_review').length,
    generated_needs_layout_review_count: enrichedGenerationRequests.filter(request => request.status === 'generated_needs_layout_review').length,
    pending_generation_missing_jd_count: enrichedGenerationRequests.filter(request => request.status === 'pending' && !request.jd_cached).length,
    pending_generation_missing_context_match_count: enrichedGenerationRequests.filter(request => request.status === 'pending' && !request.context_matched).length,
    active_review_count: queues.active_review.length,
    handled_review_count: queues.handled_review.length,
    active_pipeline_count: queues.active_pipeline.length,
    applied_count: queues.applied.length,
    apply_today_count: queues.apply_today.length,
    pipeline_by_company: countBy(pipeline, 'company'),
    needs_review_by_provider: countBy(needsReview, 'provider'),
    rejected_by_reason: countBy(rejected, 'rejection_reason'),
  },
  latest_scan_summary: latestScanSummary,
  company_coverage: companyCoverage,
  career_context: careerContext,
  job_actions: jobActions,
  generation_requests: enrichedGenerationRequests,
  queues,
  pipeline: actionedPipeline,
  needs_review: actionedNeedsReview,
  rejected: actionedRejected,
  scan_history: scanHistory,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`Pipeline: ${pipeline.length}`);
console.log(`Needs review: ${needsReview.length}`);
console.log(`Rejected: ${rejected.length}`);
console.log(`Scan history rows: ${scanHistory.length}`);
console.log(`Active review: ${queues.active_review.length}`);
console.log(`Active pipeline: ${queues.active_pipeline.length}`);
console.log(`Apply today: ${queues.apply_today.length}`);
