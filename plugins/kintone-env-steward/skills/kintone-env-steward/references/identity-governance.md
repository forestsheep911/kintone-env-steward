# Identity governance

Treat users, organizations, and groups as first-class governance subjects, not
as labels attached to App permissions.

## User checks

- active, suspended, and departed-account status;
- accounts with no clear owner or employment identity;
- duplicate identities and shared accounts;
- system administrators and other privileged identities;
- direct permission grants that bypass managed groups;
- last-review and deprovisioning evidence;
- service accounts, API use, and credential rotation ownership.

Do not infer that an account is abandoned from inactivity alone. Distinguish
observed account state, HR or directory evidence, and governance inference.

## Organization checks

- hierarchy depth, stale branches, and duplicate organization codes;
- temporary project organizations mixed with formal departments;
- organization managers and delegated administrators;
- permission inheritance that becomes unexpectedly broad after transfers;
- lifecycle ownership for reorganizations, mergers, and dissolved teams.

## Group checks

- stable purpose and owner for each group;
- nested or overlapping membership;
- empty groups and groups with only one person;
- groups used for privileged App, record, or field permissions;
- manual membership drift from the source directory;
- naming, expiry, and periodic access-review policy.

## Snapshot contract

Preserve identity collection separately from App configuration:

- `identity_coverage.status`;
- `identity_coverage.users`;
- `identity_coverage.organizations`;
- `identity_coverage.groups`;
- limitations and source provenance.

Never include passwords, API tokens, session cookies, private profile fields,
or unrelated personal data. Prefer stable codes and governance-relevant status
over display names when producing durable diffs.

Version 0.0.17 reserves this structure but does not collect identity data.
Reports must show it as an explicit coverage gap rather than silently omitting
the subject.
