import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const generatorPath = path.join(repoRoot, 'scripts/generate-queued-materials.mjs');
const materialsGuidePath = path.join(repoRoot, 'docs/materials-generation.md');
let passed = 0;

function tmpDir(name) {
  return mkdtempSync(path.join(os.tmpdir(), `career-ops-${name}-`));
}

function writeFixtureSources(root) {
  const privateDir = path.join(root, 'private');
  const configDir = path.join(privateDir, 'config');
  const supportDir = path.join(privateDir, 'support');
  const dataDir = path.join(root, 'data');
  const jdDir = path.join(dataDir, 'job-descriptions');
  const matchDir = path.join(dataDir, 'context-matches');

  for (const dir of [configDir, supportDir, jdDir, matchDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const profilePath = path.join(configDir, 'profile.yml');
  const cvPath = path.join(privateDir, 'cv.md');
  const rulesPath = path.join(configDir, 'resume_rules.yml');
  const githubEvidencePath = path.join(configDir, 'github_evidence.yml');
  const voicePath = path.join(supportDir, 'voice-dna.md');
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
  writeFileSync(voicePath, 'Use a warm, concise, direct tone in public-safe fixtures.\n', 'utf8');
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
  writeFileSync(githubEvidencePath, [
    'github_owner: purraxis',
    'skipped_repos:',
    '  - repo: weak-forked-starter',
    '    reason: "fork with no authored commits found in recent commit sample"',
    'github_evidenced_skills:',
    '  - skill: JavaScript',
    '    evidenced_by:',
    '      - career-ops-ai-job-scanner',
    '  - skill: Playwright',
    '    evidenced_by:',
    '      - career-ops-ai-job-scanner',
    'github_projects:',
    '  - repo: career-ops-ai-job-scanner',
    '    url: https://github.com/purraxis/career-ops-ai-job-scanner',
    '    one_line_description: "Personalized career operations dashboard that scans job sources, filters roles, manages review queues, and prepares application materials."',
    '    evidenced_technologies:',
    '      - JavaScript',
    '      - Playwright',
    '      - YAML',
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

  return { profilePath, cvPath, rulesPath, githubEvidencePath, voicePath, contextPath, jdPath, matchPath };
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

function runGenerator({ queuePath, contextPath, outputDir, profilePath, cvPath, rulesPath, githubEvidencePath, voicePath, dryRun = false, env = {} }) {
  const fixtureRoot = path.dirname(queuePath);
  return spawnSync(process.execPath, [
    generatorPath,
    '--queue',
    queuePath,
    '--context',
    contextPath,
    '--output-dir',
    outputDir,
    '--materials-guide',
    materialsGuidePath,
    ...(dryRun ? ['--dry-run'] : []),
  ], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAREER_OPS_PROFILE: profilePath,
      CAREER_OPS_CV: cvPath,
      CAREER_OPS_RESUME_RULES: rulesPath,
      CAREER_OPS_GITHUB_EVIDENCE: githubEvidencePath || path.join(fixtureRoot, 'private/config/github_evidence.yml'),
      CAREER_OPS_VOICE_DNA: voicePath || path.join(fixtureRoot, 'private/support/voice-dna.md'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_MODEL: '',
      ANTHROPIC_MODEL: '',
      ...env,
    },
  });
}

function rowByJobId(queuePath, jobId) {
  const [headerLine, ...lines] = readFileSync(queuePath, 'utf8').trim().split(/\r?\n/);
  const headers = headerLine.split('\t');
  const rows = lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [headers[index], value])));
  return rows.find(row => row.job_id === jobId);
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
  const root = tmpDir('materials-dry-run');
  const { profilePath, cvPath, rulesPath, githubEvidencePath, voicePath, contextPath } = writeFixtureSources(root);
  const queuePath = path.join(root, 'queue.tsv');
  const outputDir = path.join(root, 'output');
  const dataDir = path.join(root, 'data');
  const jdDir = path.join(dataDir, 'job-descriptions');
  const matchDir = path.join(dataDir, 'context-matches');
  const resumeJdPath = path.join(jdDir, 'resume-job.md');
  const letterJdPath = path.join(jdDir, 'letter-job.md');

  writeFileSync(resumeJdPath, [
    '# Sales Engineer',
    '',
    '## Extracted Text',
    '',
    'Sales Engineer role focused on discovery, demos, technical sales, proof of value, stakeholders, and ROI.',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(letterJdPath, [
    '# Solutions Consultant',
    '',
    '## Extracted Text',
    '',
    'Solutions Consultant role focused on implementation, customer workflows, demos, APIs, and stakeholder enablement.',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(path.join(matchDir, 'resume-job.json'), JSON.stringify({
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
  writeFileSync(path.join(matchDir, 'letter-job.json'), JSON.stringify({
    role_lane: 'solutions_engineering',
    role_lane_signals: ['solutions consultant', 'implementation', 'api'],
    sections: [{
      title: 'Solutions Evidence',
      group: 'experience',
      matched_terms: ['implementation', 'api', 'workflow'],
      lane_matched_terms: ['implementation', 'customer workflows'],
      top_bullets: [
        { bullet: 'Mapped customer workflow requirements into implementation plans and enablement materials.' },
        { bullet: 'Explained API and dashboard tradeoffs to technical and non-technical stakeholders.' },
      ],
    }],
  }, null, 2), 'utf8');
  writeQueue(queuePath, [
    {
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'resume',
      job_id: 'resume-job',
      company: 'Example',
      title: 'Sales Engineer',
      url: 'https://example.test/sales',
      status: 'pending',
      jd_cache_path: resumeJdPath,
    },
    {
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'letter',
      job_id: 'letter-job',
      company: 'Example',
      title: 'Solutions Consultant',
      url: 'https://example.test/letter',
      status: 'pending',
      jd_cache_path: letterJdPath,
    },
  ]);

  const beforeQueue = readFileSync(queuePath, 'utf8');
  const result = runGenerator({ queuePath, contextPath, outputDir, profilePath, cvPath, rulesPath, githubEvidencePath, voicePath, dryRun: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(queuePath, 'utf8'), beforeQueue);
  assert.ok(result.stdout.includes('Provider: OpenAI Chat Completions'));
  assert.ok(result.stdout.includes('Provider: Anthropic Claude'));
  assert.ok(result.stdout.includes('Model: gpt-4o'));
  assert.ok(result.stdout.includes('Model: claude-sonnet-5'));
  assert.ok(result.stdout.includes('Sales Engineer role focused on discovery'));
  assert.ok(result.stdout.includes('Solutions Consultant role focused on implementation'));
  assert.ok(result.stdout.includes('Use a warm, concise, direct tone'));
  assert.ok(result.stdout.includes('# GitHub Evidence YAML'));
  assert.ok(result.stdout.includes('github_projects:'));
  assert.ok(result.stdout.includes('career-ops-ai-job-scanner'));
  assert.ok(result.stdout.includes('weak-forked-starter'));
  assert.ok(result.stdout.includes('Do not use skipped, weak, forked, starter, or ambiguous repos unless they are explicitly marked as approved'));
  passed += 1;
}

{
  const root = tmpDir('materials-missing-github-evidence');
  const { profilePath, cvPath, rulesPath, voicePath, contextPath, jdPath } = writeFixtureSources(root);
  const queuePath = path.join(root, 'queue.tsv');
  const outputDir = path.join(root, 'output');
  writeQueue(queuePath, [{
    timestamp: '2026-07-25T00:00:00.000Z',
    type: 'resume',
    job_id: 'example-job',
    company: 'Example',
    title: 'Solutions Engineer',
    url: 'https://example.test/job',
    status: 'pending',
    jd_cache_path: jdPath,
  }]);

  const result = runGenerator({
    queuePath,
    contextPath,
    outputDir,
    profilePath,
    cvPath,
    rulesPath,
    githubEvidencePath: path.join(root, 'missing-github-evidence.yml'),
    voicePath,
    dryRun: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.includes('github evidence source not found'));
  assert.ok(result.stdout.includes('do not invent Selected Projects or GitHub-backed technologies'));
  passed += 1;
}

{
  const root = tmpDir('materials-missing-provider-keys');
  const { profilePath, cvPath, rulesPath, voicePath, contextPath, jdPath } = writeFixtureSources(root);
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
  ]);

  const result = runGenerator({ queuePath, contextPath, outputDir, profilePath, cvPath, rulesPath, voicePath });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const resumeRow = rowByJobId(queuePath, 'example-job');
  const letterRow = rowByJobId(queuePath, 'example-job-letter');
  assert.equal(resumeRow.status, 'blocked_missing_openai_api_key');
  assert.equal(letterRow.status, 'blocked_missing_anthropic_api_key');
  assert.ok(!resumeRow.output_path);
  assert.ok(!letterRow.output_path);
  assert.ok(result.stdout.includes('missing_openai_api_key'));
  assert.ok(result.stdout.includes('missing_anthropic_api_key'));
  passed += 1;
}

console.log(`materials-generation: ${passed} passed`);
