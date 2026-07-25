#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

const args = parseArgs(process.argv.slice(2));
const queuePath = args.queue || process.env.CAREER_OPS_GENERATION_QUEUE || 'data/generation-requests.tsv';
const outputDir = args.outputDir || 'output/generated-materials';
const contextPath = args.context || 'data/career-context.json';
const profilePath = process.env.CAREER_OPS_PROFILE || 'private/config/profile.yml';
const cvPath = process.env.CAREER_OPS_CV || 'private/cv.md';
const rulesPath = process.env.CAREER_OPS_RESUME_RULES || 'private/config/resume_rules.yml';
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function cleanLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, limit = 180) {
  const text = cleanLine(value);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function textFromMarkdownSection(markdown, heading) {
  const pattern = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
  return markdown.match(pattern)?.[1]?.trim() || '';
}

function candidateContact(profile) {
  const candidate = profile.candidate || profile.personal || {};
  return {
    name: candidate.full_name || candidate.name || 'Candidate',
    line: [
      candidate.location,
      candidate.phone,
      candidate.email,
      candidate.linkedin,
      candidate.github || candidate.portfolio_url,
    ].filter(Boolean).join(' | '),
  };
}

function extractJdTerms(jdText) {
  const text = textFromMarkdownSection(jdText, 'Extracted Text') || jdText;
  const matches = text
    .toLowerCase()
    .match(/\b[a-z][a-z0-9+#.]{2,}\b/g) || [];
  const stop = new Set(['and', 'the', 'for', 'with', 'you', 'our', 'are', 'this', 'that', 'will', 'role', 'work', 'team', 'from', 'your']);
  const counts = new Map();
  for (const term of matches) {
    if (!stop.has(term)) counts.set(term, (counts.get(term) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([term]) => term);
}

function topBullets(match, limit = 8) {
  const bullets = [];
  for (const section of match.sections || []) {
    for (const item of section.top_bullets || []) {
      const bullet = truncate(item.bullet, 190);
      if (bullet && !bullets.includes(bullet)) bullets.push(bullet);
      if (bullets.length >= limit) return bullets;
    }
  }
  return bullets;
}

function topSections(match, limit = 5) {
  return (match.sections || [])
    .slice(0, limit)
    .map(section => ({
      title: section.title,
      group: section.group,
      terms: (section.matched_terms || []).slice(0, 8).join(', '),
    }));
}

function inferLane(request, terms) {
  const haystack = `${request.title} ${terms.join(' ')}`.toLowerCase();
  if (haystack.includes('implementation') || haystack.includes('onboarding')) return 'implementation and customer onboarding';
  if (haystack.includes('forward') || haystack.includes('deployed') || haystack.includes('ai')) return 'AI workflow and forward-deployed solution work';
  if (haystack.includes('sales') || haystack.includes('solutions') || haystack.includes('presales')) return 'solutions engineering and technical GTM';
  if (haystack.includes('customer success') || haystack.includes('technical success')) return 'technical customer success';
  return 'customer-facing technical solutions';
}

function buildResumeDraft(request, profile, context, match, jdText) {
  const contact = candidateContact(profile);
  const terms = extractJdTerms(jdText);
  const lane = inferLane(request, terms);
  const bullets = topBullets(match, 8);
  const sections = topSections(match, 4);
  const skills = [
    ...(context.sections?.skills?.[0]?.bullets || []),
    terms.join(' | '),
  ].filter(Boolean).join(' | ');
  const education = truncate(context.sections?.education?.[0]?.text || '', 420);

  return [
    `# ${contact.name}`,
    '',
    contact.line,
    '',
    '## Professional Summary',
    '',
    `${contact.name} is a computer science candidate focused on ${lane}, with experience translating business needs into AI automation, enterprise workflows, dashboards, enablement, and stakeholder support outcomes.`,
    '',
    '## Core Competencies',
    '',
    skills || terms.join(' | '),
    '',
    '## Experience Highlights',
    '',
    ...(bullets.length ? bullets.map(bullet => `- ${bullet}`) : ['- Add role-specific bullets from the private career source after reviewing the cached job description.']),
    '',
    '## Selected Evidence For This Role',
    '',
    ...sections.map(section => `- ${section.title}${section.terms ? `: ${section.terms}` : ''}`),
    '',
    '## Education And Technical Foundation',
    '',
    education || 'See private career source for education and technical foundation.',
    '',
  ].join('\n');
}

function buildLetterDraft(request, profile, match, jdText) {
  const contact = candidateContact(profile);
  const terms = extractJdTerms(jdText);
  const lane = inferLane(request, terms);
  const bullets = topBullets(match, 3);
  const proof = bullets.length
    ? bullets.slice(0, 2).join(' ')
    : 'My background combines technical problem solving, workflow improvement, and customer-facing communication.';

  return [
    `Dear ${request.company ? `${request.company} Hiring Team` : 'Hiring Team'},`,
    '',
    `I am interested in the ${request.title || 'open role'} at ${request.company || 'your company'} because it sits close to the kind of ${lane} work I am targeting: technical discovery, practical implementation, and clear communication with stakeholders.`,
    '',
    `${proof} I would bring that same mix of technical execution and customer-aware communication to this role, especially where the work involves understanding workflows, explaining tradeoffs, and helping teams adopt better systems.`,
    '',
    `I would welcome the chance to discuss how my background could support ${request.company || 'the team'} in this role.`,
    '',
    contact.name,
    '',
  ].join('\n');
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

function validatePdf(request, pdfPath) {
  const info = pdfInfo(pdfPath);
  const issues = [];
  const size = existsSync(pdfPath) ? readFileSync(pdfPath).length : 0;
  if (!existsSync(pdfPath)) issues.push('pdf_missing');
  if (size < 1000) issues.push('pdf_too_small');
  if (info.available && request.type === 'resume' && info.pages !== 1) {
    issues.push(`resume_expected_one_page_got_${info.pages}`);
  }
  if (info.available && request.type === 'letter' && info.pages > 2) {
    issues.push(`letter_expected_two_pages_or_less_got_${info.pages}`);
  }
  if (!info.available) issues.push('pdfinfo_unavailable_visual_review_required');
  return {
    validated_at: new Date().toISOString(),
    pdf_path: pdfPath,
    type: request.type,
    pages: info.pages,
    bytes: size,
    issues,
    passed: issues.length === 0,
  };
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

if (!requests.length || !pending.length) {
  console.log('No queued materials to generate.');
  process.exit(0);
}

const profile = readYaml(profilePath);
const context = existsSync(contextPath) ? readJson(contextPath) : null;
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
  const markdown = request.type === 'letter'
    ? buildLetterDraft(request, profile, match, jdText)
    : buildResumeDraft(request, profile, context, match, jdText);
  const output = writeMaterial(request, markdown);
  try {
    await renderPdf(output.htmlPath, output.pdfPath);
    const validation = validatePdf(request, output.pdfPath);
    writeFileSync(output.validationPath, JSON.stringify(validation, null, 2) + '\n', 'utf8');
    request.status = validation.passed ? 'generated_pdf' : 'generated_needs_layout_review';
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

writeQueue(requests);

console.log(`Generated: ${generated}`);
console.log(`Blocked: ${blocked}`);
if (missingPrivateSources.length) {
  console.log('Missing required private sources:');
  for (const filePath of missingPrivateSources) console.log(`- ${filePath}`);
}
