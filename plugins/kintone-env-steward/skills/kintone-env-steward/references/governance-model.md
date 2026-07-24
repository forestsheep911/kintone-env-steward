# Governance Model

Use this model when creating durable snapshots and findings. Keep schemas
versioned once implemented.

## Snapshot

A snapshot should include:

- `schema_version`
- `run_id`
- `collected_at`
- `target` with domain identifier and scoped App IDs
- `sources` with method, status, and limitations
- `assets` for spaces, Apps, owners, and lifecycle metadata
- `identity_coverage` for users, organizations, groups, collection status, and
  limitations
- `configurations` for fields, layouts, views, processes, permissions,
  customizations, plugins, Webhooks, and integrations
- `unknowns` for requested but unavailable evidence

Never embed credentials. Avoid record payloads unless the user explicitly
scopes a data-health check; prefer aggregates.

Read [identity-governance.md](identity-governance.md) before designing identity
findings or collecting user, organization, or group evidence.

## Finding

Use these fields:

- `rule_id`: stable identifier
- `subject`: type and stable object identifier
- `observation`: source-backed fact
- `evidence`: snapshot path or captured source reference
- `assessment`: contextual interpretation
- `severity`: `critical`, `high`, `medium`, `low`, or `info`
- `confidence`: `high`, `medium`, or `low`
- `recommendation`: proposed next action
- `verification`: success check
- `exception_id`: optional approved exception

Severity describes likely impact, while confidence describes evidence quality.
Do not lower severity merely because evidence is incomplete; lower confidence
and identify the missing evidence.

## Exception

An exception should include:

- `exception_id`
- `rule_id` and subject
- owner and approver
- business reason
- approval and expiry dates
- compensating control
- review status

Expired exceptions should reappear as findings.

## Diff

Classify differences as added, removed, or changed. For each difference, retain
both normalized values and the evidence source. Separate expected volatility
from governed configuration.

## Minimum report

Include:

1. scope and operation level;
2. evidence coverage and limitations;
3. environment summary;
4. prioritized findings;
5. configuration differences when applicable;
6. exceptions;
7. remediation plan;
8. verification plan.
