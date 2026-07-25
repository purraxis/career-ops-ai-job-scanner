#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';

const queuePath = process.env.CAREER_OPS_GENERATION_QUEUE || 'data/generation-requests.tsv';

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split('\t').map(value => value.trim());
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    return Object.fromEntries(headers.map((header, i) => [header, cells[i] || '']));
  });
}

const requests = existsSync(queuePath) ? parseTsv(readFileSync(queuePath, 'utf8')) : [];
const pending = requests.filter(request => request.status === 'pending');

console.log(`Generation queue: ${queuePath}`);
console.log(`Total requests: ${requests.length}`);
console.log(`Pending requests: ${pending.length}`);

if (!pending.length) {
  console.log('No queued materials to generate.');
  process.exit(0);
}

console.log('Explicit token-cost generation is not wired yet.');
console.log('Next implementation should read private career sources, cached job descriptions, and resume rules before writing ignored output files.');
for (const request of pending.slice(0, 20)) {
  console.log(`- ${request.type}: ${request.company} - ${request.title}`);
}
