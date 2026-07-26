import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';

const repoRoot = process.cwd();
const generatorPath = path.join(repoRoot, 'scripts/generate-queued-materials.mjs');
let passed = 0;
let skipped = 0;

function tmpDir(name) {
  return mkdtempSync(path.join(os.tmpdir(), `career-ops-${name}-`));
}

function writeFixtureSources(root) {
  const privateDir = path.join(root, 'private');
  const configDir = path.join(privateDir, 'config');
  const dataDir = path.join(root, 'data');
  const jdDir = path.join(dataDir, 'job-descriptions');
  const matchDir = path.join(dataDir, 'context-matches');

  for (const dir of [configDir, jdDir, matchDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const profilePath = path.join(configDir, 'profile.yml');
  const cvPath = path.join(privateDir, 'cv.md');
  const rulesPath = path.join(configDir, 'resume_rules.yml');
  const contextPath = path.join(dataDir, 'career-context.json');
  const jdPath = path.join(jdDir, 'example-job.md');
  const matchPath = path.join(matchDir, 'example-job.json');

  writeFileSync(profilePath, [
    'candidate:',
    '  name: "Example Candidate"',
    '  location: "Tampa, FL"',
    '  email: "candidate@example.test"',
    '  linkedin: "https://linkedin.example.test/example"',
    '  github: "https://github.example.test/example"',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(cvPath, '# Example CV\n\nPublic-safe fixture only.\n', 'utf8');
  writeFileSync(rulesPath, [
    'resume:',
    '  pages: 1',
    'content_quality:',
    '  min_resume_words: 90',
    '  min_resume_bullets: 6',
    '  min_letter_words: 50',
    '  min_letter_paragraphs: 3',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(contextPath, JSON.stringify({
    sections: {
      skills: [{
        bullets: ['AI workflow design | SQL | Salesforce | ServiceNow | stakeholder enablement'],
      }],
      education: [{
        text: 'Example University - B.S. Computer Science - Expected December 2026',
      }],
    },
  }, null, 2), 'utf8');

  writeFileSync(jdPath, [
    '# Example Job',
    '',
    '## Extracted Text',
    '',
    'Solutions Engineer role focused on demos, APIs, AI workflows, customer discovery, implementation, and technical enablement.',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(matchPath, JSON.stringify({
    sections: [
      {
        title: 'AI Automation Experience',
        group: 'experience',
        matched_terms: ['ai', 'workflow', 'automation', 'stakeholder'],
        top_bullets: [
          { bullet: 'Built AI workflow support materials that helped business users understand automation tradeoffs and adoption steps.' },
          { bullet: 'Translated stakeholder needs into technical requirements, dashboards, and enablement plans.' },
          { bullet: 'Connected customer discovery themes to implementation plans, acceptance criteria, and practical enablement materials.' },
        ],
      },
      {
        title: 'Implementation Experience',
        group: 'experience',
        matched_terms: ['implementation', 'customer', 'enablement'],
        top_bullets: [
          { bullet: 'Supported implementation planning across enterprise workflow systems and customer-facing support processes.' },
          { bullet: 'Created concise documentation for technical and non-technical stakeholders.' },
          { bullet: 'Mapped business requirements into repeatable workflows that helped teams reduce ambiguity during adoption.' },
        ],
      },
    ],
  }, null, 2), 'utf8');
  writeFileSync(path.join(matchDir, 'example-job-letter.json'), readFileSync(matchPath, 'utf8'), 'utf8');
  writeFileSync(path.join(matchDir, 'sparse-job.json'), JSON.stringify({ sections: [] }, null, 2), 'utf8');

  return { profilePath, cvPath, rulesPath, contextPath, jdPath, matchPath };
}

function writeQueue(queuePath, rows) {
  const header = 'timestamp\ttype\tjob_id\tcompany\ttitle\turl\tstatus\tjd_cache_path\toutput_path\n';
  const body = rows.map(row => [
    row.timestamp,
    row.type,
    row.job_id,
    row.company,
    row.title,
    row.url,
    row.status,
    row.jd_cache_path,
    row.output_path || '',
  ].join('\t')).join('\n');
  writeFileSync(queuePath, `${header}${body}\n`, 'utf8');
}

function runGenerator({ queuePath, contextPath, outputDir, profilePath, cvPath, rulesPath }) {
  const fixtureRoot = path.dirname(queuePath);
  return spawnSync(process.execPath, [
    generatorPath,
    '--queue',
    queuePath,
    '--context',
    contextPath,
    '--output-dir',
    outputDir,
  ], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAREER_OPS_PROFILE: profilePath,
      CAREER_OPS_CV: cvPath,
      CAREER_OPS_RESUME_RULES: rulesPath,
    },
  });
}

async function canLaunchChromium() {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

function rowByJobId(queuePath, jobId) {
  const [headerLine, ...lines] = readFileSync(queuePath, 'utf8').trim().split(/\r?\n/);
  const headers = headerLine.split('\t');
  const rows = lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [headers[index], value])));
  return rows.find(row => row.job_id === jobId);
}

function markdownPathForOutput(outputPath) {
  return outputPath.replace(/\.(pdf|html)$/, '.md');
}

{
  const root = tmpDir('materials-missing-sources');
  const { contextPath, jdPath } = writeFixtureSources(root);
  const queuePath = path.join(root, 'queue.tsv');
  const outputDir = path.join(root, 'output');
  writeQueue(queuePath, [{
    timestamp: '2026-07-25T00:00:00.000Z',
    type: 'resume',
    job_id: 'missing-sources-job',
    company: 'Example',
    title: 'Example Role',
    url: 'https://example.test/job',
    status: 'pending',
    jd_cache_path: jdPath,
  }]);

  const result = runGenerator({
    queuePath,
    contextPath,
    outputDir,
    profilePath: path.join(root, 'missing-profile.yml'),
    cvPath: path.join(root, 'missing-cv.md'),
    rulesPath: path.join(root, 'missing-rules.yml'),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(rowByJobId(queuePath, 'missing-sources-job').status, 'blocked_missing_private_sources');
  passed += 1;
}

{
  const root = tmpDir('materials-lane-aware');
  const { profilePath, cvPath, rulesPath, contextPath } = writeFixtureSources(root);
  const queuePath = path.join(root, 'queue.tsv');
  const outputDir = path.join(root, 'output');
  const dataDir = path.join(root, 'data');
  const jdDir = path.join(dataDir, 'job-descriptions');
  const matchDir = path.join(dataDir, 'context-matches');
  const salesJdPath = path.join(jdDir, 'sales-job.md');
  const fdeJdPath = path.join(jdDir, 'fde-job.md');

  writeFileSync(salesJdPath, [
    '# Sales Engineer',
    '',
    '## Extracted Text',
    '',
    'Sales Engineer role focused on discovery, demos, technical sales, proof of value, stakeholders, and ROI.',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(fdeJdPath, [
    '# Forward Deployed Engineer',
    '',
    '## Extracted Text',
    '',
    'Forward Deployed Engineer role focused on AI workflows, agents, automation, customer deployment, and technical prototyping.',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(path.join(matchDir, 'sales-job.json'), JSON.stringify({
    role_lane: 'sales_engineering',
    role_lane_signals: ['sales engineer', 'discovery', 'demo', 'roi'],
    sections: [{
      title: 'Sales Engineering Evidence',
      group: 'experience',
      matched_terms: ['discovery', 'demos', 'roi'],
      lane_matched_terms: ['discovery', 'demo', 'roi'],
      top_bullets: [
        { bullet: 'Led discovery conversations, product demos, stakeholder enablement, and ROI-oriented business cases for technical sales workflows.' },
        { bullet: 'Translated customer pain points into proof-of-value narratives and demo recommendations.' },
      ],
    }],
  }, null, 2), 'utf8');
  writeFileSync(path.join(matchDir, 'fde-job.json'), JSON.stringify({
    role_lane: 'ai_fde',
    role_lane_signals: ['forward deployed', 'ai workflow', 'automation'],
    sections: [{
      title: 'AI FDE Project Evidence',
      group: 'projects',
      matched_terms: ['ai', 'workflow', 'automation'],
      lane_matched_terms: ['career ops', 'technical prototyping', 'automation'],
      top_bullets: [
        { bullet: 'Built a Career Ops job scanner project around AI workflows, agent-style automation, technical prototyping, and auditable outputs.' },
        { bullet: 'Turned ambiguous workflow requirements into a working automation prototype with clear operating constraints.' },
      ],
    }],
  }, null, 2), 'utf8');
  writeQueue(queuePath, [
    {
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'resume',
      job_id: 'sales-job',
      company: 'Example',
      title: 'Sales Engineer',
      url: 'https://example.test/sales',
      status: 'pending',
      jd_cache_path: salesJdPath,
    },
    {
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'resume',
      job_id: 'fde-job',
      company: 'Example',
      title: 'Forward Deployed Engineer',
      url: 'https://example.test/fde',
      status: 'pending',
      jd_cache_path: fdeJdPath,
    },
  ]);

  const result = runGenerator({ queuePath, contextPath, outputDir, profilePath, cvPath, rulesPath });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const salesRow = rowByJobId(queuePath, 'sales-job');
  const fdeRow = rowByJobId(queuePath, 'fde-job');
  const salesMarkdown = readFileSync(markdownPathForOutput(salesRow.output_path), 'utf8');
  const fdeMarkdown = readFileSync(markdownPathForOutput(fdeRow.output_path), 'utf8');

  assert.ok(salesMarkdown.includes('sales engineering and technical GTM'));
  assert.ok(salesMarkdown.includes('## Sales Engineering Evidence'));
  assert.ok(salesMarkdown.includes('Discovery | Product Demos | Technical Sales'));
  assert.ok(fdeMarkdown.includes('AI workflows and forward-deployed solution work'));
  assert.ok(fdeMarkdown.includes('## AI/FDE Evidence'));
  assert.ok(fdeMarkdown.includes('AI Workflows | Automation | Technical Prototyping'));
  assert.notEqual(salesMarkdown, fdeMarkdown);
  passed += 1;
}

if (await canLaunchChromium()) {
  const root = tmpDir('materials-pdf');
  const { profilePath, cvPath, rulesPath, contextPath, jdPath } = writeFixtureSources(root);
  const queuePath = path.join(root, 'queue.tsv');
  const outputDir = path.join(root, 'output');
  writeQueue(queuePath, [
    {
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'resume',
      job_id: 'example-job',
      company: 'Example',
      title: 'Solutions Engineer',
      url: 'https://example.test/job',
      status: 'pending',
      jd_cache_path: jdPath,
    },
    {
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'letter',
      job_id: 'example-job-letter',
      company: 'Example',
      title: 'Solutions Engineer',
      url: 'https://example.test/job',
      status: 'pending',
      jd_cache_path: jdPath,
    },
    {
      timestamp: '2026-07-25T00:00:02.000Z',
      type: 'resume',
      job_id: 'sparse-job',
      company: 'Example',
      title: 'Sparse Resume',
      url: 'https://example.test/sparse-job',
      status: 'pending',
      jd_cache_path: jdPath,
    },
  ]);

  const result = runGenerator({ queuePath, contextPath, outputDir, profilePath, cvPath, rulesPath });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const resumeRow = rowByJobId(queuePath, 'example-job');
  const letterRow = rowByJobId(queuePath, 'example-job-letter');
  const sparseRow = rowByJobId(queuePath, 'sparse-job');
  assert.equal(resumeRow.status, 'generated_pdf');
  assert.equal(letterRow.status, 'generated_pdf');
  assert.equal(sparseRow.status, 'generated_needs_content_review');
  assert.ok(resumeRow.output_path.endsWith('.pdf'));
  assert.ok(letterRow.output_path.endsWith('.pdf'));
  assert.ok(sparseRow.output_path.endsWith('.pdf'));
  assert.ok(existsSync(resumeRow.output_path), resumeRow.output_path);
  assert.ok(existsSync(letterRow.output_path), letterRow.output_path);
  assert.ok(existsSync(sparseRow.output_path), sparseRow.output_path);

  const resumeValidationPath = resumeRow.output_path.replace(/\.pdf$/, '.validation.json');
  const letterValidationPath = letterRow.output_path.replace(/\.pdf$/, '.validation.json');
  const sparseValidationPath = sparseRow.output_path.replace(/\.pdf$/, '.validation.json');
  const resumeValidation = JSON.parse(readFileSync(resumeValidationPath, 'utf8'));
  const letterValidation = JSON.parse(readFileSync(letterValidationPath, 'utf8'));
  const sparseValidation = JSON.parse(readFileSync(sparseValidationPath, 'utf8'));
  assert.equal(resumeValidation.passed, true);
  assert.equal(resumeValidation.pages, 1);
  assert.deepEqual(resumeValidation.content_issues, []);
  assert.equal(letterValidation.passed, true);
  assert.ok(letterValidation.pages <= 2);
  assert.equal(sparseValidation.passed, false);
  assert.ok(sparseValidation.content_issues.some(issue => issue.startsWith('resume_too_few_bullets')));
  assert.ok(sparseValidation.content_issues.includes('resume_contains_placeholder_text'));

  const resumeMarkdown = readFileSync(resumeRow.output_path.replace(/\.pdf$/, '.md'), 'utf8');
  const letterMarkdown = readFileSync(letterRow.output_path.replace(/\.pdf$/, '.md'), 'utf8');
  assert.ok(!resumeMarkdown.includes('Generation Notes'));
  assert.ok(!letterMarkdown.includes('Generated from cached JD'));
  passed += 1;
} else {
  console.log('Skipping PDF rendering assertion: Playwright Chromium is not available in this environment.');
  skipped += 1;
}

console.log(`materials-generation: ${passed} passed, ${skipped} skipped`);
