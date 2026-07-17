# Application Materials Generation Guide

This guide captures the default rules for generating tailored application materials from the private Career Ops workspace. It is intentionally source-first: generated content should use the private career source files and the target job description, while avoiding invented facts or generic reuse.

## Tailored Resume Prompt

When generating a tailored resume for Dinh Pham inside the Career Ops AI Job Scanner project, use these inputs:

- Job description
- `private/cv.md` as the master factual career database
- `private/config/profile.yml` for structured positioning, preferences, sponsorship context, and proof points
- `private/config/resume_rules.yml` for length, spacing, section limits, and formatting
- Golden resume wording or structure, when available

Goal: create a one-page, ATS-readable, job-description-matched resume that is meaningfully tailored to the specific role.

Source-of-truth rules:

- Use `private/cv.md` as the master factual career database.
- Use the golden resume as the source of truth for concise wording, titles, dates, and one-page positioning.
- Use `private/config/profile.yml` for role preferences, target positioning, sponsorship context, and proof points.
- Use `private/config/resume_rules.yml` for length, spacing, section limits, and formatting.
- Do not invent facts, tools, employers, credentials, certifications, dates, metrics, or responsibilities.
- If a job description asks for something unsupported, bridge only with truthful adjacent experience.

Tailoring process:

1. Extract role signals from the job description: job title, role lane, required skills, preferred skills, responsibilities, tools, customer-facing expectations, technical expectations, business keywords, seniority level, and measurable outcomes the company values.
2. Compare the job description against the master profile. Emphasize matching experience, move buried but relevant proof points higher, strengthen weak-but-supported matches with truthful context or metrics, translate adjacent experience honestly, and omit unsupported claims.
3. Build a meaningfully tailored resume. The resume must not be a generic copy of prior resumes. At least five bullets should be role-specific or materially rewritten for the job description. The summary must reflect the role lane and top requirements. Core competencies should prioritize the job description's exact skill themes. Experience bullets should be reordered and rewritten around the employer's needs. Selected projects should appear only when they strengthen fit.
4. Keep the resume one page and application-ready. Use clean ATS-friendly sections, no icons, no tables, no images, no exaggerated claims, and no dense walls of text.
5. Apply a similarity guard. Before finalizing, compare the resume conceptually against other generated resumes in the same batch. If it is mostly identical, rewrite the summary, reorder competencies, rewrite bullets, or select different projects when appropriate.

Preferred emphasis when supported by the job description:

- Discovery
- Demos
- Implementation
- AI automation
- Salesforce
- ServiceNow
- SQL
- APIs
- Dashboards
- Stakeholder alignment
- Technical enablement
- Customer workflows
- ROI

Output only the finished tailored resume content, ready to render as PDF or DOCX.

## Cover Letter Prompt

When generating a cover letter for a role, use these inputs:

- `private/cv.md` for facts
- `private/config/profile.yml` for positioning
- `voice-dna.md` and writing samples, if available
- The job description for company-specific motivation

Rules:

- Write exactly three short paragraphs.
- Keep the tone warm, direct, and human.
- Do not use corporate fluff.
- Do not over-explain.
- Do not invent facts.
- Mention the company or product specifically.
- Connect one or two of Dinh's strongest proof points to the role.
- Use a plain signature with only the name:

```text
Dinh Pham
```

Do not include HTML tags such as `<br>`.
