#!/usr/bin/env node

import ashby from './providers/ashby.mjs';
import greenhouse from './providers/greenhouse.mjs';
import lever from './providers/lever.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}

function ok(label, condition) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

const providers = [ashby, greenhouse, lever];

function detectedProviderId(careersUrl) {
  const entry = { name: 'Example', careers_url: careersUrl };
  for (const provider of providers) {
    if (provider.detect?.(entry)) return provider.id;
  }
  return null;
}

eq(
  'Ashby URL resolves to ashby provider',
  detectedProviderId('https://jobs.ashbyhq.com/Deepgram'),
  'ashby',
);
eq(
  'Lever URL resolves to lever provider',
  detectedProviderId('https://jobs.lever.co/ramp'),
  'lever',
);
eq(
  'Greenhouse job-boards URL resolves to greenhouse provider',
  detectedProviderId('https://job-boards.greenhouse.io/postman'),
  'greenhouse',
);
eq(
  'Greenhouse EU job-boards URL resolves to greenhouse provider',
  detectedProviderId('https://job-boards.eu.greenhouse.io/example'),
  'greenhouse',
);
eq(
  'Old Greenhouse boards URL resolves to greenhouse provider',
  detectedProviderId('https://boards.greenhouse.io/postman'),
  'greenhouse',
);

const greenhouseJobs = await greenhouse.fetch(
  { name: 'Postman', careers_url: 'https://boards.greenhouse.io/postman' },
  {
    fetchJson: async (url) => {
      eq(
        'old Greenhouse URL converts to boards-api endpoint',
        url,
        'https://boards-api.greenhouse.io/v1/boards/postman/jobs',
      );
      return {
        jobs: [
          {
            title: 'Associate Solutions Engineer',
            absolute_url: 'https://job-boards.greenhouse.io/postman/jobs/123',
            location: { name: 'Remote, US' },
            first_published: '2026-07-07T12:00:00Z',
          },
          {
            title: 'Missing URL Job',
            location: { name: 'Remote, US' },
          },
          {
            absolute_url: 'https://job-boards.greenhouse.io/postman/jobs/456',
          },
        ],
      };
    },
  },
);
eq('Greenhouse returns normalized jobs with URLs only', greenhouseJobs.length, 2);
eq('Greenhouse normalizes title', greenhouseJobs[0].title, 'Associate Solutions Engineer');
eq('Greenhouse normalizes URL', greenhouseJobs[0].url, 'https://job-boards.greenhouse.io/postman/jobs/123');
eq('Greenhouse normalizes company from entry', greenhouseJobs[0].company, 'Postman');
eq('Greenhouse normalizes location', greenhouseJobs[0].location, 'Remote, US');
ok('Greenhouse parses postedAt', Number.isFinite(greenhouseJobs[0].postedAt));
eq('Greenhouse tolerates missing optional fields', greenhouseJobs[1].title, '');
eq('Greenhouse missing optional location becomes empty string', greenhouseJobs[1].location, '');

const ashbyJobs = await ashby.fetch(
  { name: 'Deepgram', careers_url: 'https://jobs.ashbyhq.com/Deepgram' },
  {
    fetchJson: async (url) => {
      eq(
        'Ashby URL converts to posting-api endpoint',
        url,
        'https://api.ashbyhq.com/posting-api/job-board/Deepgram?includeCompensation=true',
      );
      return {
        jobs: [
          {
            title: 'Solutions Engineer',
            jobUrl: 'https://jobs.ashbyhq.com/Deepgram/123',
            location: 'Remote, US',
            publishedAt: '2026-07-07T12:00:00Z',
            compensation: {
              interval: '1 YEAR',
              minValue: 90000,
              maxValue: 120000,
              currency: 'USD',
            },
          },
          {
            title: 'Customer Engineer',
            jobUrl: 'https://jobs.ashbyhq.com/Deepgram/456',
          },
        ],
      };
    },
  },
);
eq('Ashby returns normalized jobs', ashbyJobs.length, 2);
eq('Ashby normalizes title', ashbyJobs[0].title, 'Solutions Engineer');
eq('Ashby normalizes URL', ashbyJobs[0].url, 'https://jobs.ashbyhq.com/Deepgram/123');
eq('Ashby normalizes company from entry', ashbyJobs[0].company, 'Deepgram');
eq('Ashby normalizes location', ashbyJobs[0].location, 'Remote, US');
eq('Ashby parses salary min', ashbyJobs[0].salary.min, 90000);
eq('Ashby parses salary max', ashbyJobs[0].salary.max, 120000);
ok('Ashby parses postedAt', Number.isFinite(ashbyJobs[0].postedAt));
eq('Ashby tolerates missing optional salary', ashbyJobs[1].salary, null);
eq('Ashby tolerates missing optional postedAt', ashbyJobs[1].postedAt, undefined);

const leverJobs = await lever.fetch(
  { name: 'Ramp', careers_url: 'https://jobs.lever.co/ramp' },
  {
    fetchJson: async (url) => {
      eq('Lever URL converts to API endpoint', url, 'https://api.lever.co/v0/postings/ramp');
      return [
        {
          text: 'Associate Solutions Consultant',
          hostedUrl: 'https://jobs.lever.co/ramp/123',
          categories: { location: 'New York, NY' },
          descriptionPlain: 'Associate customer-facing technical role with demos and implementation.',
          createdAt: Date.parse('2026-07-07T12:00:00Z'),
        },
        {
          hostedUrl: 'https://jobs.lever.co/ramp/456',
        },
      ];
    },
  },
);
eq('Lever returns normalized jobs', leverJobs.length, 2);
eq('Lever normalizes title', leverJobs[0].title, 'Associate Solutions Consultant');
eq('Lever normalizes URL', leverJobs[0].url, 'https://jobs.lever.co/ramp/123');
eq('Lever normalizes company from entry', leverJobs[0].company, 'Ramp');
eq('Lever normalizes location', leverJobs[0].location, 'New York, NY');
eq('Lever preserves description', leverJobs[0].description, 'Associate customer-facing technical role with demos and implementation.');
ok('Lever preserves postedAt', Number.isFinite(leverJobs[0].postedAt));
eq('Lever tolerates missing optional title', leverJobs[1].title, '');
eq('Lever tolerates missing optional location', leverJobs[1].location, '');
eq('Lever tolerates missing optional description', leverJobs[1].description, '');
eq('Lever tolerates missing optional postedAt', leverJobs[1].postedAt, undefined);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
