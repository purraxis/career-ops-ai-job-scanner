import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
let passed = 0;

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'career-ops-ui-state-actions-'));
}

function writeFixture(root) {
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  writeFileSync(path.join(dataDir, 'pipeline.md'), [
    '# Pipeline',
    '',
    '## Pending',
    '',
    '- [ ] https://example.test/jobs/pipeline-fit | Example Co | Pipeline Fit Role | Remote |',
    '- [ ] https://example.test/jobs/pipeline-not-fit | Example Co | Pipeline Not Fit Role | Remote |',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(dataDir, 'needs-review.md'), [
    '# Needs Review',
    '',
    '### Example Co — Active Review Role',
    '- Provider: ashby',
    '- Location: Remote',
    '- Apply URL: https://example.test/jobs/active-review',
    '- Final URL: https://example.test/jobs/active-review',
    '- Classification: needs_review',
    '- Review Category: direct ATS strong title but unclear year requirement',
    '- Date scanned: 2026-07-25',
    '',
    '### Example Co — Review Not Fit Role',
    '- Provider: ashby',
    '- Location: Remote',
    '- Apply URL: https://example.test/jobs/review-not-fit',
    '- Final URL: https://example.test/jobs/review-not-fit',
    '- Classification: needs_review',
    '- Review Category: direct ATS strong title but unclear year requirement',
    '- Date scanned: 2026-07-25',
    '',
  ].join('\n'), 'utf8');

  writeFileSync(path.join(dataDir, 'rejected-jobs.tsv'), 'date\tprovider\tsource_url\tfinal_url\tfetched_at\tposted_at\thttp_status\tclassification\tverification_status\trejection_reason\ttitle\tcompany\tlocation\n', 'utf8');
  writeFileSync(path.join(dataDir, 'scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf8');
  writeFileSync(path.join(dataDir, 'generation-requests.tsv'), 'timestamp\ttype\tjob_id\tcompany\ttitle\turl\tstatus\tjd_cache_path\toutput_path\n', 'utf8');
  writeFileSync(path.join(dataDir, 'job-actions.tsv'), [
    'timestamp\taction\tjob_id\tcompany\ttitle\turl\tnote',
    '2026-07-25T00:00:00.000Z\tnot_a_fit\texample.test|/jobs/review-not-fit\tExample Co\tReview Not Fit Role\thttps://example.test/jobs/review-not-fit\tMarked not a fit from test',
    '2026-07-25T00:01:00.000Z\tnot_a_fit\texample.test|/jobs/pipeline-not-fit\tExample Co\tPipeline Not Fit Role\thttps://example.test/jobs/pipeline-not-fit\tMarked not a fit from test',
    '',
  ].join('\n'), 'utf8');
}

{
  const root = tmpDir();
  writeFixture(root);
  const outputPath = path.join(root, 'data/ui-state.json');
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/build-ui-state.mjs'), '--output', outputPath], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const state = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(state.stats.needs_review_count, 2);
  assert.equal(state.stats.active_review_count, 1);
  assert.equal(state.stats.handled_review_count, 1);
  assert.equal(state.stats.active_pipeline_count, 1);
  assert.equal(state.queues.active_review[0].title, 'Active Review Role');
  assert.equal(state.queues.handled_review[0].title, 'Review Not Fit Role');
  assert.equal(state.queues.handled_review[0].is_not_a_fit, true);
  assert.equal(state.queues.active_pipeline[0].title, 'Pipeline Fit Role');
  assert.equal(state.pipeline.find(item => item.title === 'Pipeline Not Fit Role').is_not_a_fit, true);
  assert.equal(state.queues.active_pipeline.some(item => item.title === 'Pipeline Not Fit Role'), false);
  passed += 1;
}

console.log(`ui-state-actions: ${passed} passed`);
