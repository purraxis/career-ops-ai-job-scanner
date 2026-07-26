#!/usr/bin/env node

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import OpenAI from 'openai';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

const args = parseArgs(process.argv.slice(2));
const queuePath = args.queue || process.env.CAREER_OPS_GENERATION_QUEUE || 'data/generation-requests.tsv';
const outputDir = args.outputDir || 'output/generated-materials';
const contextPath = args.context || 'data/career-context.json';
const profilePath = process.env.CAREER_OPS_PROFILE || 'private/config/profile.yml';
const cvPath = process.env.CAREER_OPS_CV || 'private/cv.md';
const rulesPath = process.env.CAREER_OPS_RESUME_RULES || 'private/config/resume_rules.yml';
const voiceDnaPath = process.env.CAREER_OPS_VOICE_DNA || 'private/support/voice-dna.md';
const materialsGuidePath = args.materialsGuide || 'docs/materials-generation.md';
const dryRun = Boolean(args.dryRun);
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o';
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const requiredPrivateSources = [cvPath, profilePath, rulesPath];
const header = ['timestamp', 'type', 'job_id', 'company', 'title', 'url', 'status', 'jd_cache_path', 'output_path'];

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

function sanitizeTsv(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split('\t').map(value => value.trim());
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    return Object.fromEntries(headers.map((key, i) => [key, cells[i] || '']));
  });
}

function writeQueue(rows) {
  const body = [
    header.join('\t'),
    ...rows.map(row => header.map(key => sanitizeTsv(row[key] || '')).join('\t')),
  ].join('\n');
  mkdirSync(path.dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, `${body}\n`, 'utf8');
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

function defaultContextMatchPath(request) {
  return path.join('data/context-matches', `${safeFileId(request.job_id)}.json`);
}

function readYaml(filePath) {
  return existsSync(filePath) ? yaml.load(readFileSync(filePath, 'utf8')) || {} : {};
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function markdownSection(markdown, heading) {
  const pattern = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
  return markdown.match(pattern)?.[1]?.trim() || '';
}

function stripCodeFence(markdown) {
  const text = String(markdown || '').trim();
  const fenced = text.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : text).trim();
}

function llmTextFromAnthropic(message) {
  return (message.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('\n')
    .trim();
}

function providerForRequest(type) {
  if (type === 'letter') return { provider: 'Anthropic Claude', model: anthropicModel };
  return { provider: 'OpenAI Chat Completions', model: openaiModel };
}

function buildMaterialPrompt({ type, request, context, match, jdText, sourceTexts, guideText }) {
  const sectionName = type === 'letter' ? 'Cover Letter Prompt' : 'Tailored Resume Prompt';
  const instructions = markdownSection(guideText, sectionName);
  if (!instructions) throw new Error(`missing_materials_generation_section_${safeFileId(sectionName)}`);
  const voice = type === 'letter'
    ? [
        '## Voice DNA',
        sourceTexts.voiceDna || '(voice-dna source not found; use the cover letter rules and source facts only)',
        '',
      ].join('\n')
    : '';

  // Future extension point: live GitHub repo evidence could be fetched here before prompt assembly.
  const user = [
    `# Material Request`,
    '',
    `Type: ${type}`,
    `Company: ${request.company || ''}`,
    `Role: ${request.title || ''}`,
    `URL: ${request.url || ''}`,
    `Job ID: ${request.job_id || request.id || ''}`,
    '',
    '# Private CV Source',
    '',
    sourceTexts.cv,
    '',
    '# Structured Profile YAML',
    '',
    sourceTexts.profile,
    '',
    '# Resume Rules YAML',
    '',
    sourceTexts.rules,
    '',
    voice,
    '# Cached Job Description',
    '',
    jdText,
    '',
    '# Local Career Context JSON',
    '',
    JSON.stringify(context || {}, null, 2),
    '',
    '# Matched Career Evidence JSON',
    '',
    JSON.stringify(match || {}, null, 2),
    '',
    '# Output Contract',
    '',
    type === 'letter'
      ? 'Return only the finished cover letter Markdown/text. It must be exactly three short paragraphs plus a plain signature line.'
      : 'Return only the finished tailored resume Markdown. Do not include analysis, notes, or code fences.',
  ].join('\n');

  return { system: instructions, user };
}

async function buildResumeDraft(request, context, match, jdText, sourceTexts, guideText) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is required for resume generation');
    error.blockReason = 'missing_openai_api_key';
    throw error;
  }
  const prompt = buildMaterialPrompt({ type: 'resume', request, context, match, jdText, sourceTexts, guideText });
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });
  const response = await client.chat.completions.create({
    model: openaiModel,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0.35,
  });
  const markdown = response.choices?.[0]?.message?.content || '';
  if (!markdown.trim()) throw new Error('OpenAI returned empty resume content');
  return stripCodeFence(markdown);
}

async function buildLetterDraft(request, context, match, jdText, sourceTexts, guideText) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const error = new Error('ANTHROPIC_API_KEY is required for cover letter generation');
    error.blockReason = 'missing_anthropic_api_key';
    throw error;
  }
  const prompt = buildMaterialPrompt({ type: 'letter', request, context, match, jdText, sourceTexts, guideText });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: anthropicModel,
    max_tokens: 1200,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    temperature: 0.35,
  });
  const markdown = llmTextFromAnthropic(response);
  if (!markdown.trim()) throw new Error('Anthropic returned empty cover letter content');
  return stripCodeFence(markdown);
}

function printDryRunPrompt(type, request, prompt) {
  const provider = providerForRequest(type);
  console.log(`\n===== DRY RUN: ${type.toUpperCase()} =====`);
  console.log(`Provider: ${provider.provider}`);
  console.log(`Model: ${provider.model}`);
  console.log(`Job: ${request.company || 'Unknown company'} - ${request.title || 'Untitled role'}`);
  console.log('\n--- SYSTEM / INSTRUCTIONS ---');
  console.log(prompt.system);
  console.log('\n--- USER PROMPT ---');
  console.log(prompt.user);
  console.log(`===== END DRY RUN: ${type.toUpperCase()} =====\n`);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownToHtml(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inList = false;
  let afterH1 = false;

  function closeList() {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith('# ')) {
      closeList();
      html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
      afterH1 = true;
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      afterH1 = false;
      continue;
    }
    if (line.startsWith('- ')) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      afterH1 = false;
      continue;
    }
    closeList();
    html.push(`<p${afterH1 ? ' class="contact"' : ''}>${escapeHtml(line)}</p>`);
    afterH1 = false;
  }
  closeList();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: Letter; margin: 0.42in 0.52in; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #111827; line-height: 1.18; font-size: 10.4px; margin: 0; }
    h1 { text-align: center; margin: 0 0 2px; font-size: 21px; line-height: 1.05; }
    h2 { border-bottom: 1px solid #9ca3af; font-size: 11.6px; margin: 7px 0 3px; padding-bottom: 1px; text-transform: uppercase; }
    ul { margin: 2px 0 4px 15px; padding: 0; }
    li { margin: 0 0 1.8px; padding-left: 1px; }
    p { margin: 2px 0 4px; }
    .contact { text-align: center; margin: 0 0 7px; }
    @media print {
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>${html.join('\n')}</body>
</html>
`;
}

function writeMaterial(request, markdown) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${safeFileId(request.company)}-${safeFileId(request.title)}-${safeFileId(request.type)}`.replace(/_+/g, '_');
  const dir = path.join(outputDir, safeFileId(request.job_id));
  mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${base}.md`);
  const htmlPath = path.join(dir, `${base}.html`);
  const pdfPath = path.join(dir, `${base}.pdf`);
  const validationPath = path.join(dir, `${base}.validation.json`);
  writeFileSync(mdPath, markdown, 'utf8');
  writeFileSync(htmlPath, markdownToHtml(markdown, `${request.company} ${request.title}`), 'utf8');
  return { mdPath, htmlPath, pdfPath, validationPath };
}

async function renderPdf(htmlPath, pdfPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
    await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'load' });
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }
}

function pdfInfo(pdfPath) {
  const result = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    return {
      available: false,
      error: (result.stderr || result.stdout || 'pdfinfo unavailable').trim(),
      pages: null,
    };
  }
  const pages = Number((result.stdout.match(/^Pages:\s+(\d+)/m) || [])[1] || 0) || null;
  return { available: true, pages };
}

function wordCount(markdown) {
  return (String(markdown || '')
    .replace(/^#+\s+/gm, ' ')
    .replace(/^- /gm, ' ')
    .match(/\b[\w+#.]+\b/g) || []).length;
}

function bulletCount(markdown) {
  return (String(markdown || '').match(/^- /gm) || []).length;
}

function hasHeading(markdown, heading) {
  return new RegExp(`^##\\s+${heading}\\s*$`, 'mi').test(markdown);
}

function paragraphCount(markdown) {
  return String(markdown || '')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(block => block && !block.startsWith('#') && !block.startsWith('- ')).length;
}

function validateContent(request, markdown, rules) {
  const issues = [];
  const words = wordCount(markdown);
  const bullets = bulletCount(markdown);
  const layoutRules = rules.layout || {};
  const contentQuality = rules.content_quality || rules.validation || {};

  if (request.type === 'resume') {
    const requiredHeadings = [
      'Professional Summary',
      'Core Competencies',
      'Experience Highlights',
      'Education And Technical Foundation',
    ];
    for (const heading of requiredHeadings) {
      if (!hasHeading(markdown, heading)) issues.push(`resume_missing_section_${safeFileId(heading)}`);
    }

    const minWords = Number(contentQuality.min_resume_words || 220);
    const minBullets = Number(contentQuality.min_resume_bullets || 6);
    const maxWords = Number(layoutRules.max_total_words || 0);

    if (words < minWords) issues.push(`resume_too_sparse_words_${words}_lt_${minWords}`);
    if (bullets < minBullets) issues.push(`resume_too_few_bullets_${bullets}_lt_${minBullets}`);
    if (maxWords && words > maxWords) issues.push(`resume_exceeds_word_budget_${words}_gt_${maxWords}`);
    if (/Add role-specific bullets|See private career source/i.test(markdown)) {
      issues.push('resume_contains_placeholder_text');
    }
  }

  if (request.type === 'letter') {
    const minWords = Number(contentQuality.min_letter_words || 80);
    const minParagraphs = Number(contentQuality.min_letter_paragraphs || 3);

    if (words < minWords) issues.push(`letter_too_sparse_words_${words}_lt_${minWords}`);
    if (paragraphCount(markdown) < minParagraphs) {
      issues.push(`letter_too_few_paragraphs_${paragraphCount(markdown)}_lt_${minParagraphs}`);
    }
  }

  return { words, bullets, issues };
}

function validateMaterial(request, pdfPath, markdown, rules) {
  const info = pdfInfo(pdfPath);
  const layoutIssues = [];
  const size = existsSync(pdfPath) ? readFileSync(pdfPath).length : 0;
  if (!existsSync(pdfPath)) layoutIssues.push('pdf_missing');
  if (size < 1000) layoutIssues.push('pdf_too_small');
  if (info.available && request.type === 'resume' && info.pages !== 1) {
    layoutIssues.push(`resume_expected_one_page_got_${info.pages}`);
  }
  if (info.available && request.type === 'letter' && info.pages > 2) {
    layoutIssues.push(`letter_expected_two_pages_or_less_got_${info.pages}`);
  }
  if (!info.available) layoutIssues.push('pdfinfo_unavailable_visual_review_required');

  const content = validateContent(request, markdown, rules || {});
  const issues = [...layoutIssues, ...content.issues];
  return {
    validated_at: new Date().toISOString(),
    pdf_path: pdfPath,
    type: request.type,
    pages: info.pages,
    bytes: size,
    words: content.words,
    bullets: content.bullets,
    layout_issues: layoutIssues,
    content_issues: content.issues,
    issues,
    passed: issues.length === 0,
  };
}

function statusForValidation(validation) {
  if (validation.passed) return 'generated_pdf';
  if (validation.layout_issues.length) return 'generated_needs_layout_review';
  if (validation.content_issues.length) return 'generated_needs_content_review';
  return 'generated_needs_review';
}

function markBlocked(request, reason) {
  request.status = `blocked_${reason}`;
  request.output_path = '';
}

const requests = existsSync(queuePath) ? parseTsv(readFileSync(queuePath, 'utf8')) : [];
const pending = requests.filter(request => request.status === 'pending');
const missingPrivateSources = requiredPrivateSources.filter(filePath => !existsSync(filePath));

console.log(`Generation queue: ${queuePath}`);
console.log(`Total requests: ${requests.length}`);
console.log(`Pending requests: ${pending.length}`);
if (dryRun) console.log('Dry run: prompts will be printed and no API calls, files, PDFs, or queue updates will be made.');

if (!requests.length || !pending.length) {
  console.log('No queued materials to generate.');
  process.exit(0);
}

const rules = readYaml(rulesPath);
const context = existsSync(contextPath) ? readJson(contextPath) : null;
const sourceTexts = {
  cv: readText(cvPath),
  profile: readText(profilePath),
  rules: readText(rulesPath),
  voiceDna: readText(voiceDnaPath),
};
const guideText = readText(materialsGuidePath);
let generated = 0;
let blocked = 0;

for (const request of pending) {
  request.jd_cache_path = request.jd_cache_path || defaultJdPath(request);
  request.context_match_path = request.context_match_path || defaultContextMatchPath(request);

  if (missingPrivateSources.length) {
    markBlocked(request, 'missing_private_sources');
    blocked += 1;
    continue;
  }
  if (!context) {
    markBlocked(request, 'missing_career_context');
    blocked += 1;
    continue;
  }
  if (!existsSync(request.jd_cache_path)) {
    markBlocked(request, 'missing_jd_cache');
    blocked += 1;
    continue;
  }
  if (!existsSync(request.context_match_path)) {
    markBlocked(request, 'missing_context_match');
    blocked += 1;
    continue;
  }

  const jdText = readFileSync(request.jd_cache_path, 'utf8');
  const match = readJson(request.context_match_path);
  if (dryRun) {
    const type = request.type === 'letter' ? 'letter' : 'resume';
    const prompt = buildMaterialPrompt({ type, request, context, match, jdText, sourceTexts, guideText });
    printDryRunPrompt(type, request, prompt);
    continue;
  }

  let markdown = '';
  try {
    markdown = request.type === 'letter'
      ? await buildLetterDraft(request, context, match, jdText, sourceTexts, guideText)
      : await buildResumeDraft(request, context, match, jdText, sourceTexts, guideText);
  } catch (error) {
    const reason = error.blockReason || (request.type === 'letter' ? 'anthropic_generation_failed' : 'openai_generation_failed');
    markBlocked(request, reason);
    blocked += 1;
    console.log(`Generation blocked for ${request.type}: ${request.company} - ${request.title}`);
    console.log(`  ${reason}: ${error.message}`);
    continue;
  }

  const output = writeMaterial(request, markdown);
  try {
    await renderPdf(output.htmlPath, output.pdfPath);
    const validation = validateMaterial(request, output.pdfPath, markdown, rules);
    writeFileSync(output.validationPath, JSON.stringify(validation, null, 2) + '\n', 'utf8');
    request.status = statusForValidation(validation);
    request.output_path = output.pdfPath;
    generated += 1;
    console.log(`Generated ${request.type}: ${request.company} - ${request.title}`);
    console.log(`- ${output.mdPath}`);
    console.log(`- ${output.htmlPath}`);
    console.log(`- ${output.pdfPath}`);
    console.log(`- ${output.validationPath}`);
    if (validation.issues.length) console.log(`  issues: ${validation.issues.join(', ')}`);
  } catch (error) {
    request.status = 'blocked_pdf_render_failed';
    request.output_path = output.htmlPath;
    blocked += 1;
    console.log(`PDF render failed for ${request.type}: ${request.company} - ${request.title}`);
    console.log(`- ${output.htmlPath}`);
    console.log(`  ${error.message}`);
  }
}

if (!dryRun) writeQueue(requests);

console.log(`Generated: ${generated}`);
console.log(`Blocked: ${blocked}`);
if (missingPrivateSources.length) {
  console.log('Missing required private sources:');
  for (const filePath of missingPrivateSources) console.log(`- ${filePath}`);
}
