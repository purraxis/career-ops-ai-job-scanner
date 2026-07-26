import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const repoRoot = process.cwd();
let passed = 0;
let skipped = 0;

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'career-ops-ui-smoke-'));
}

function copyFile(relativePath, targetRoot) {
  const source = path.join(repoRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

function writeFixtureRepo(root) {
  for (const relativePath of [
    'scripts/serve-ui.mjs',
    'scripts/build-scan-summary.mjs',
    'scripts/build-company-coverage.mjs',
    'scripts/build-career-context.mjs',
    'scripts/build-ui-state.mjs',
    'scripts/generate-queued-materials.mjs',
    'scripts/prepare-final-generation-package.mjs',
    'ui/index.html',
    'ui/app.js',
    'ui/styles.css',
  ]) {
    copyFile(relativePath, root);
  }

  mkdirSync(path.join(root, 'data'), { recursive: true });
  mkdirSync(path.join(root, 'data/job-descriptions'), { recursive: true });
  mkdirSync(path.join(root, 'data/context-matches'), { recursive: true });
  mkdirSync(path.join(root, 'private/config'), { recursive: true });
  mkdirSync(path.join(root, 'output/generated-materials/example-job'), { recursive: true });
  if (existsSync(path.join(repoRoot, 'node_modules'))) {
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  }

  writeFileSync(path.join(root, 'data/pipeline.md'), [
    '# Pipeline',
    '',
    '## Pending',
    '',
    '- [ ] https://example.test/jobs/solutions-engineer | Example Co | Solutions Engineer | Remote |',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(root, 'data/needs-review.md'), [
    '# Needs Review',
    '',
    '### Example Co — Associate Solutions Consultant',
    '- Provider: ashby',
    '- Location: Remote',
    '- Apply URL: https://example.test/jobs/associate-solutions-consultant',
    '- Final URL: https://example.test/jobs/associate-solutions-consultant',
    '- Classification: needs_review',
    '- Review Category: direct ATS strong title but unclear year requirement',
    '- Why not accepted: fixture needs review',
    '- Date scanned: 2026-07-25',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(root, 'data/rejected-jobs.tsv'), [
    'date\tprovider\tsource_url\tfinal_url\tfetched_at\tposted_at\thttp_status\tclassification\tverification_status\trejection_reason\ttitle\tcompany\tlocation',
    '2026-07-25\tadzuna-api\thttps://example.test/rejected\thttps://example.test/rejected\t2026-07-25T00:00:00.000Z\t2026-07-24\t200\trejected\tverified_live\tsenior_title\tSenior Role\tExample Co\tRemote',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(root, 'data/scan-history.tsv'), [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
    'https://example.test/jobs/solutions-engineer\t2026-07-25\tgreenhouse\tSolutions Engineer\tExample Co\tadded\tRemote',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(root, 'data/job-actions.tsv'), [
    'timestamp\taction\tjob_id\tcompany\ttitle\turl\tnote',
    '2026-07-25T01:00:00.000Z\tnot_a_fit\texample.test|/jobs/associate-solutions-consultant\tExample Co\tAssociate Solutions Consultant\thttps://example.test/jobs/associate-solutions-consultant\tMarked not a fit from fixture',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(path.join(root, 'data/job-descriptions/example-job.md'), [
    '# Example Job',
    '',
    '## Extracted Text',
    '',
    'Solutions Engineer role focused on discovery, demos, implementation, APIs, and customer enablement.',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(path.join(root, 'data/context-matches/example-job.json'), JSON.stringify({
    sections: [{
      title: 'Example Experience',
      group: 'experience',
      matched_terms: ['discovery', 'demos', 'implementation'],
      top_bullets: [{ bullet: 'Built workflow automation and customer enablement materials.' }],
    }],
  }, null, 2), 'utf8');
  writeFileSync(path.join(root, 'data/generation-requests.tsv'), [
    'timestamp\ttype\tjob_id\tcompany\ttitle\turl\tstatus\tjd_cache_path\toutput_path',
    '2026-07-25T00:00:00.000Z\tresume\texample-job\tExample Co\tSolutions Engineer\thttps://example.test/jobs/solutions-engineer\tgenerated_pdf\tdata/job-descriptions/example-job.md\toutput/generated-materials/example-job/example-resume.pdf',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(root, 'output/generated-materials/example-job/example-resume.pdf'), 'fixture pdf bytes\n', 'utf8');
  writeFileSync(path.join(root, 'output/generated-materials/example-job/example-resume.html'), '<!doctype html><title>Fixture</title>\n', 'utf8');
  writeFileSync(path.join(root, 'output/generated-materials/example-job/example-resume.md'), '# Fixture Resume\n', 'utf8');
  writeFileSync(path.join(root, 'output/generated-materials/example-job/example-resume.validation.json'), JSON.stringify({
    passed: true,
    pages: 1,
    words: 240,
    issues: [],
  }, null, 2), 'utf8');

  writeFileSync(path.join(root, 'portals.yml'), [
    'tracked_companies:',
    '  - name: "Example Co"',
    '    enabled: true',
    '    careers_url: "https://job-boards.greenhouse.io/example"',
    '    priority: high',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(root, 'private/cv.md'), [
    '# Example Candidate',
    '',
    '## Experience',
    '- Built workflow automation and customer enablement materials.',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(root, 'private/config/profile.yml'), [
    'candidate:',
    '  name: "Example Candidate"',
    'target_roles:',
    '  primary:',
    '    - "Solutions Engineer"',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(root, 'private/config/resume_rules.yml'), [
    'resume:',
    '  pages: 1',
    'content_quality:',
    '  min_resume_words: 90',
    '  min_resume_bullets: 6',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(path.join(root, 'private/config/github_evidence.yml'), [
    'github_owner: purraxis',
    'skipped_repos:',
    '  - repo: weak-forked-starter',
    '    reason: "fork with no authored commits found in recent commit sample"',
    'github_projects:',
    '  - repo: career-ops-ai-job-scanner',
    '    url: https://github.com/purraxis/career-ops-ai-job-scanner',
    '    one_line_description: "Personalized job scanner dashboard."',
    '    evidenced_technologies:',
    '      - JavaScript',
    '      - Playwright',
    '      - YAML',
    '',
  ].join('\n'), 'utf8');
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`server did not start\n${stdout}\n${stderr}`)), 8000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('Career Ops UI running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('exit', code => {
      if (code !== null && !stdout.includes('Career Ops UI running')) {
        clearTimeout(timeout);
        const error = new Error(`server exited with ${code}\n${stdout}\n${stderr}`);
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function request(port, method, pathname, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const root = tmpDir();
  writeFixtureRepo(root);
  const buildState = spawn(process.execPath, ['scripts/build-ui-state.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      CAREER_OPS_CV: 'private/cv.md',
      CAREER_OPS_PROFILE: 'private/config/profile.yml',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    buildState.stdout.on('data', chunk => {
      stdout += chunk;
    });
    buildState.stderr.on('data', chunk => {
      stderr += chunk;
    });
    buildState.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`fixture build-ui-state failed with ${code}\n${stdout}\n${stderr}`));
    });
  });

  const port = 49000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['scripts/serve-ui.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      CAREER_OPS_UI_PORT: String(port),
      CAREER_OPS_UI_HOST: '127.0.0.1',
      CAREER_OPS_CV: 'private/cv.md',
      CAREER_OPS_PROFILE: 'private/config/profile.yml',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    try {
      await waitForServer(child);
    } catch (error) {
      if (String(error.stderr || error.message).includes('listen EPERM')) {
        console.log('Skipping UI smoke assertion: local port binding is blocked in this environment.');
        skipped += 1;
        return;
      }
      throw error;
    }

    const html = await request(port, 'GET', '/');
    assert.equal(html.status, 200);
    assert.ok(html.body.startsWith('<!doctype html>'));
    assert.ok(html.body.includes('Career Ops Job Scanner'));
    assert.ok(html.body.includes('id="runScan"'));
    assert.ok(html.body.includes('Run Scan'));

    const appJs = await request(port, 'GET', '/app.js');
    assert.equal(appJs.status, 200);
    assert.ok(appJs.body.startsWith('let state = null;'));

    const css = await request(port, 'GET', '/styles.css');
    assert.equal(css.status, 200);
    assert.ok(css.body.includes(':root'));

    const stateResponse = await request(port, 'GET', '/api/state');
    assert.equal(stateResponse.status, 200);
    const state = JSON.parse(stateResponse.body);
    assert.equal(state.schema_version, 1);
    assert.equal(state.stats.pipeline_count, 1);
    assert.equal(state.stats.needs_review_count, 1);
    assert.equal(state.stats.active_review_count, 0);
    assert.equal(state.stats.handled_review_count, 1);
    assert.equal(state.stats.pending_generation_requests_count, 0);
    assert.equal(state.stats.generated_pdf_count, 1);
    assert.equal(state.queues.active_review.length, 0);
    assert.equal(state.queues.handled_review[0].is_not_a_fit, true);
    assert.equal(state.queues.handled_review[0].latest_action.action, 'not_a_fit');
    assert.equal(state.generation_requests[0].output_exists, true);
    assert.equal(state.generation_requests[0].html_exists, true);
    assert.equal(state.generation_requests[0].markdown_exists, true);
    assert.equal(state.generation_requests[0].validation_exists, true);

    const localFile = await request(port, 'GET', '/api/local-file?path=output%2Fgenerated-materials%2Fexample-job%2Fexample-resume.html');
    assert.equal(localFile.status, 200);
    assert.ok(localFile.body.includes('<!doctype html>'));

    const runResponse = await request(port, 'POST', '/api/generate-queued-materials', '{}');
    assert.equal(runResponse.status, 200);
    const runResult = JSON.parse(runResponse.body);
    assert.equal(runResult.ok, true);
    assert.ok(runResult.stdout.includes('Generation queue: data/generation-requests.tsv'));

    const packageResponse = await request(port, 'POST', '/api/prepare-final-generation-package', JSON.stringify({
      type: 'resume',
      job: state.generation_requests[0],
    }));
    assert.equal(packageResponse.status, 200);
    const packageResult = JSON.parse(packageResponse.body);
    assert.equal(packageResult.ok, true);
    assert.ok(packageResult.package_path.endsWith('-resume-final-package.md'));

    const packageFile = await request(port, 'GET', `/api/local-file?path=${encodeURIComponent(packageResult.package_path)}`);
    assert.equal(packageFile.status, 200);
    assert.ok(packageFile.body.includes('Final Resume Generation Package'));
    assert.ok(packageFile.body.includes('GitHub Evidence YAML'));
    assert.ok(packageFile.body.includes('career-ops-ai-job-scanner'));
    assert.ok(packageFile.body.includes('weak-forked-starter'));

    assert.ok(existsSync(path.join(root, 'data/ui-state.json')));
    passed += 1;
  } finally {
    child.kill('SIGTERM');
  }
}

await main();
console.log(`ui-smoke: ${passed} passed, ${skipped} skipped`);
