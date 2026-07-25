#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const args = parseArgs(process.argv.slice(2));
const cvPath = args.cv || process.env.CAREER_OPS_CV || 'private/cv.md';
const profilePath = args.profile || process.env.CAREER_OPS_PROFILE || 'private/config/profile.yml';
const outputPath = args.output || 'data/career-context.json';

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

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function splitMarkdownSections(markdown) {
  const sections = [];
  let current = { level: 0, title: 'root', key: 'root', content: [] };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      if (current.content.length || current.title !== 'root') {
        sections.push({ ...current, content: current.content.join('\n').trim() });
      }
      current = {
        level: heading[1].length,
        title: heading[2].trim(),
        key: normalizeKey(heading[2]),
        content: [],
      };
    } else {
      current.content.push(line);
    }
  }
  if (current.content.length || current.title !== 'root') {
    sections.push({ ...current, content: current.content.join('\n').trim() });
  }
  return sections;
}

function bulletsFrom(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
}

function includesAny(value, terms) {
  const lower = value.toLowerCase();
  return terms.some(term => lower.includes(term));
}

function sectionGroup(section) {
  const haystack = `${section.title}\n${section.content}`.toLowerCase();
  if (includesAny(haystack, ['experience', 'amgen', 'sales representative', 'technical product manager'])) return 'experience';
  if (includesAny(haystack, ['project', 'scanner', 'prototype', 'github'])) return 'projects';
  if (includesAny(haystack, ['proof', 'metric', 'scaled', 'improved', 'reduced', 'secured'])) return 'proof_points';
  if (includesAny(haystack, ['skill', 'competenc', 'tools'])) return 'skills';
  if (includesAny(haystack, ['education', 'university', 'coursework', 'certification', 'program'])) return 'education';
  if (includesAny(haystack, ['leadership', 'association for computing machinery', 'acm'])) return 'leadership';
  if (includesAny(haystack, ['authorization', 'stem opt', 'sponsorship'])) return 'work_authorization';
  return 'other';
}

function compactProfile(profile) {
  return {
    target_roles: profile.target_roles || {},
    narrative: profile.narrative || {},
    work_authorization: profile.work_authorization || {},
    compensation: profile.compensation || {},
    location: profile.location || profile.location_preferences || {},
    education: profile.education || {},
  };
}

const cvText = readText(cvPath);
const profileText = readText(profilePath);
const profile = profileText ? yaml.load(profileText) || {} : {};
const sections = splitMarkdownSections(cvText).filter(section => section.title !== 'root');
const grouped = sections.reduce((acc, section) => {
  const group = sectionGroup(section);
  if (!acc[group]) acc[group] = [];
  acc[group].push({
    title: section.title,
    key: section.key,
    level: section.level,
    bullets: bulletsFrom(section.content),
    text: section.content,
  });
  return acc;
}, {});

const context = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  sources: {
    cv: cvPath,
    profile: profilePath,
  },
  section_counts: Object.fromEntries(Object.entries(grouped).map(([key, value]) => [key, value.length])),
  sections: grouped,
  profile: compactProfile(profile),
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(context, null, 2) + '\n', 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`Sections: ${sections.length}`);
console.log(`Groups: ${JSON.stringify(context.section_counts)}`);
