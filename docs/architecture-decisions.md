# Architecture Decisions

## ADR 001: Keep Markdown/TSV/JSON Before Adding A Database

Status: accepted for current phase

The project should continue using local Markdown, TSV, and JSON files until the review workflow proves that a relational database is necessary.

Reasons:

- The scanner already produces auditable local files.
- The dashboard can consume `data/ui-state.json` without parsing source files directly.
- Append-only TSV action logs are easy to inspect and recover.
- Private job-search artifacts remain easy to ignore from git.
- SQLite can be added later behind the same adapter boundary if action history, joins, or multi-user workflows become complex.

Current persistence model:

- `data/pipeline.md`: verified jobs selected for application.
- `data/needs-review.md`: jobs requiring human review.
- `data/rejected-jobs.tsv`: scanner rejection audit.
- `data/job-actions.tsv`: human dashboard decisions.
- `data/generation-requests.tsv`: explicit document-generation requests.
- `data/job-descriptions/`: cached job descriptions.
- `data/context-matches/`: local career-context matching output.
- `data/ui-state.json`: generated UI contract.

Decision trigger for SQLite:

- If action updates need transactions.
- If job state needs edits instead of append-only logs.
- If generation request status needs retries, failures, or output tracking at scale.
- If the dashboard needs cross-scan history queries that become difficult against TSV/JSON.

Until then, a database would add operational weight without solving a current blocker.
