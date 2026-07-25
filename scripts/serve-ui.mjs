#!/usr/bin/env node

import { createServer } from 'http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { extname, join, normalize } from 'path';
import { spawn } from 'child_process';
import { networkInterfaces } from 'os';

const PORT = Number(process.env.CAREER_OPS_UI_PORT || 4173);
const HOST = process.env.CAREER_OPS_UI_HOST || '127.0.0.1';
const ROOT = process.cwd();
const UI_DIR = join(ROOT, 'ui');
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const UI_STATE_PATH = join(ROOT, 'data/ui-state.json');
const JOB_ACTIONS_PATH = join(ROOT, 'data/job-actions.tsv');
const GENERATION_REQUESTS_PATH = join(ROOT, 'data/generation-requests.tsv');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function localNetworkUrls(port) {
  const urls = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const details of interfaces || []) {
      if (details.family === 'IPv4' && !details.internal) {
        urls.push(`http://${details.address}:${port}`);
      }
    }
  }
  return urls;
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function runNodeScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `${script} exited with ${code}`));
    });
  });
}

async function rebuildAppState() {
  for (const script of [
    'scripts/build-scan-summary.mjs',
    'scripts/build-company-coverage.mjs',
    'scripts/build-career-context.mjs',
    'scripts/build-ui-state.mjs',
  ]) {
    await runNodeScript(script);
  }
}

function ensureUiState() {
  if (!existsSync(UI_STATE_PATH)) {
    throw new Error('data/ui-state.json is missing. Run npm run build:ui-state first.');
  }
  return JSON.parse(readFileSync(UI_STATE_PATH, 'utf8'));
}

function pipelineLine(job) {
  const parts = [
    `- [ ] ${job.url}`,
    job.company,
    job.title,
    job.location,
    job.compensation,
  ].filter(value => String(value || '').trim());
  return parts.join(' | ');
}

function sanitizeTsv(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
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

function safeFileId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180) || 'job';
}

function jobDescriptionPath(job = {}) {
  const id = job.id || stableJobId(job.url || job.final_url || '', job.company, job.title);
  return join('data/job-descriptions', `${safeFileId(id)}.md`);
}

function appendJobAction(action, job = {}, note = '') {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  if (!existsSync(JOB_ACTIONS_PATH) || !readFileSync(JOB_ACTIONS_PATH, 'utf8').trim()) {
    appendFileSync(JOB_ACTIONS_PATH, 'timestamp\taction\tjob_id\tcompany\ttitle\turl\tnote\n', 'utf8');
  }
  const row = [
    new Date().toISOString(),
    sanitizeTsv(action),
    sanitizeTsv(job.id || stableJobId(job.url || job.final_url || '', job.company, job.title)),
    sanitizeTsv(job.company),
    sanitizeTsv(job.title),
    sanitizeTsv(job.url || job.final_url || ''),
    sanitizeTsv(note),
  ];
  appendFileSync(JOB_ACTIONS_PATH, `${row.join('\t')}\n`, 'utf8');
}

function appendGenerationRequest(type, job = {}) {
  if (!['resume', 'letter', 'application_answer'].includes(type)) {
    throw new Error('invalid generation request type');
  }
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  mkdirSync(join(ROOT, 'data/job-descriptions'), { recursive: true });
  if (!existsSync(GENERATION_REQUESTS_PATH) || !readFileSync(GENERATION_REQUESTS_PATH, 'utf8').trim()) {
    appendFileSync(GENERATION_REQUESTS_PATH, 'timestamp\ttype\tjob_id\tcompany\ttitle\turl\tstatus\tjd_cache_path\toutput_path\n', 'utf8');
  }
  const row = [
    new Date().toISOString(),
    sanitizeTsv(type),
    sanitizeTsv(job.id || stableJobId(job.url || job.final_url || '', job.company, job.title)),
    sanitizeTsv(job.company),
    sanitizeTsv(job.title),
    sanitizeTsv(job.url || job.final_url || ''),
    'pending',
    sanitizeTsv(job.jd_cache_path || jobDescriptionPath(job)),
    '',
  ];
  appendFileSync(GENERATION_REQUESTS_PATH, `${row.join('\t')}\n`, 'utf8');
}

function moveToPipeline(job) {
  if (!job?.url || !String(job.url).startsWith('http')) {
    throw new Error('job.url is required');
  }
  const text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf8') : '# Pipeline — Pending URLs\n\n## Pending\n\n## Processed\n';
  if (text.includes(job.url)) return { moved: false, reason: 'already_in_pipeline' };

  const marker = '## Pending';
  const idx = text.indexOf(marker);
  if (idx === -1) throw new Error('pipeline is missing ## Pending section');
  const insertAt = idx + marker.length;
  const next = `${text.slice(0, insertAt)}\n\n${pipelineLine(job)}${text.slice(insertAt)}`;
  writeFileSync(PIPELINE_PATH, next.replace(/\n{4,}/g, '\n\n\n'), 'utf8');
  return { moved: true };
}

function serveStatic(req, res) {
  const requested = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(UI_DIR, safePath);
  if (!filePath.startsWith(UI_DIR) || !existsSync(filePath)) {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return;
  }
  send(res, 200, readFileSync(filePath), MIME[extname(filePath)] || 'application/octet-stream');
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/state') {
      send(res, 200, ensureUiState());
      return;
    }

    if (req.method === 'POST' && req.url === '/api/build-ui-state') {
      await rebuildAppState();
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/move-to-pipeline') {
      const body = await readBody(req);
      const result = moveToPipeline(body.job);
      appendJobAction(result.moved ? 'moved_to_pipeline' : 'move_to_pipeline_skipped', body.job, result.reason || '');
      await rebuildAppState();
      send(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/job-action') {
      const body = await readBody(req);
      if (!body.action) {
        send(res, 400, { ok: false, error: 'action_required' });
        return;
      }
      appendJobAction(body.action, body.job || {}, body.note || '');
      await rebuildAppState();
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/generation-request') {
      const body = await readBody(req);
      appendGenerationRequest(body.type, body.job || {});
      await rebuildAppState();
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/cache-job-description') {
      const body = await readBody(req);
      const job = body.job || {};
      const url = job.final_url || job.url || body.url || '';
      if (!url) {
        send(res, 400, { ok: false, error: 'url_required' });
        return;
      }
      const result = await runNodeScript('scripts/cache-job-description.mjs', [
        '--url', url,
        '--job-id', job.id || stableJobId(url, job.company, job.title),
        '--company', job.company || '',
        '--title', job.title || '',
      ]);
      await rebuildAppState();
      let parsed = null;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = { stdout: result.stdout, stderr: result.stderr };
      }
      send(res, 200, { ok: true, ...parsed });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/generate-resume') {
      send(res, 402, {
        ok: false,
        token_cost_action: true,
        message: 'Resume generation is intentionally not automatic. Wire this endpoint to the existing generation workflow when you want an explicit token-spending action.',
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/generate-cover-letter') {
      send(res, 402, {
        ok: false,
        token_cost_action: true,
        message: 'Cover letter generation is intentionally not automatic. Wire this endpoint to the existing generation workflow when you want an explicit token-spending action.',
      });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    send(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (error) {
    send(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Career Ops UI running at http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') {
    const urls = localNetworkUrls(PORT);
    if (urls.length) {
      console.log('Same-network device URLs:');
      for (const url of urls) console.log(`- ${url}`);
    }
  }
});
