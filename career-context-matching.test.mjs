import assert from 'assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const matcherPath = path.join(repoRoot, 'scripts/match-career-context.mjs');

function tmpDir(name) {
  return mkdtempSync(path.join(os.tmpdir(), `career-ops-${name}-`));
}

function writeContext(filePath) {
  writeFileSync(filePath, JSON.stringify({
    schema_version: 1,
    sections: {
      experience: [
        {
          title: 'Sales Engineering Evidence',
          key: 'sales_engineering_evidence',
          text: 'Discovery, demos, technical sales, stakeholder enablement, ROI framing, value selling, and customer-facing business cases.',
          bullets: [
            'Led discovery conversations, product demos, stakeholder enablement, and ROI-oriented business cases for customer-facing technical sales workflows.',
            'Translated customer pain points into concise demo narratives and proof-of-value materials.',
          ],
        },
        {
          title: 'Implementation Evidence',
          key: 'implementation_evidence',
          text: 'Salesforce, ServiceNow, onboarding, deployment, process mapping, requirements gathering, workflow documentation, configuration, and go-live support.',
          bullets: [
            'Mapped Salesforce and ServiceNow requirements into implementation plans, onboarding steps, workflow documentation, and go-live support.',
            'Coordinated deployment details, process mapping, and configuration notes for cross-functional implementation teams.',
          ],
        },
        {
          title: 'Customer Success Evidence',
          key: 'customer_success_evidence',
          text: 'Customer adoption, support, enablement, training, troubleshooting, first-response improvement, and measurable customer outcomes.',
          bullets: [
            'Created customer enablement and support materials that improved adoption, troubleshooting consistency, and customer outcomes.',
          ],
        },
      ],
      projects: [
        {
          title: 'AI FDE Project Evidence',
          key: 'ai_fde_project_evidence',
          text: 'Career Ops job scanner, GitHub project, AI workflows, agents, automation, technical prototyping, model evaluation, human data, and customer deployment patterns.',
          bullets: [
            'Built a Career Ops job scanner project around AI workflows, agent-style automation, technical prototyping, model evaluation signals, and customer deployment constraints.',
            'Turned ambiguous workflow requirements into a working automation prototype with auditable outputs.',
          ],
        },
      ],
    },
  }, null, 2), 'utf8');
}

function writeJob(filePath, body) {
  writeFileSync(filePath, [
    '# Job Description',
    '',
    '## Extracted Text',
    '',
    body,
    '',
  ].join('\n'), 'utf8');
}

function runMatcher({ root, contextPath, jobName, title, body }) {
  const jdPath = path.join(root, `${jobName}.md`);
  const outputPath = path.join(root, `${jobName}.json`);
  writeJob(jdPath, body);
  const result = spawnSync(process.execPath, [
    matcherPath,
    '--context', contextPath,
    '--jd', jdPath,
    '--output', outputPath,
    '--job-id', jobName,
    '--title', title,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

const root = tmpDir('context-matching');
mkdirSync(root, { recursive: true });
const contextPath = path.join(root, 'career-context.json');
writeContext(contextPath);

const salesMatch = runMatcher({
  root,
  contextPath,
  jobName: 'sales-engineer',
  title: 'Associate Sales Engineer',
  body: 'This Sales Engineer role owns customer discovery, demos, technical sales conversations, proof of value, stakeholder alignment, and ROI messaging.',
});
assert.equal(salesMatch.role_lane, 'sales_engineering');
assert.equal(salesMatch.sections[0].title, 'Sales Engineering Evidence');
assert(salesMatch.sections[0].lane_score > 0);

const fdeMatch = runMatcher({
  root,
  contextPath,
  jobName: 'forward-deployed-engineer',
  title: 'Forward Deployed Engineer, AI',
  body: 'This FDE role builds AI workflows, agents, automation prototypes, customer deployments, model evaluation workflows, and technical prototyping with ambiguous requirements.',
});
assert.equal(fdeMatch.role_lane, 'ai_fde');
assert.equal(fdeMatch.sections[0].title, 'AI FDE Project Evidence');
assert(fdeMatch.sections[0].lane_matched_terms.includes('career ops'));

const implementationMatch = runMatcher({
  root,
  contextPath,
  jobName: 'implementation-consultant',
  title: 'Implementation Consultant',
  body: 'This Implementation Consultant role focuses on Salesforce, ServiceNow, onboarding, process mapping, requirements gathering, deployment, configuration, and go-live support.',
});
assert.equal(implementationMatch.role_lane, 'implementation');
assert.equal(implementationMatch.sections[0].title, 'Implementation Evidence');
assert(implementationMatch.sections[0].lane_matched_terms.includes('salesforce'));

console.log('career-context-matching tests passed');
