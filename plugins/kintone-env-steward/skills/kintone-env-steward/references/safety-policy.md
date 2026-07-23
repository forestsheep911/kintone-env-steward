# Safety Policy

Read this file before any potentially mutating workflow.

## Default

Operate read-only. Access to an environment authorizes only the inspection the
user requested.

## Required gates for a change

Proceed only when all gates pass:

1. The plugin implementation explicitly supports the resource and operation.
2. The exact domain, App ID, and configuration object are identified.
3. Current state was freshly read.
4. A current-to-desired diff is shown.
5. Dependencies and side effects are described.
6. The user explicitly authorizes that target and diff in the current task.
7. A recovery or rollback path exists.
8. The result can be re-read and verified.

If any gate fails, stop at remediation planning.

## Secrets and evidence

- Read credentials only from the active workspace or an approved credential
  provider.
- Never print, copy into reports, or commit passwords, tokens, cookies, or
  session storage.
- Avoid capturing record content, user personal data, or screenshots unless
  required for the scoped finding.
- Store run artifacts in the active user workspace, outside the plugin.

## Failure behavior

- Stop after the first unexpected mutation result.
- Do not retry a non-idempotent write blindly.
- Re-read the target before deciding whether to retry or recover.
- Report partial success precisely.
- Preserve diagnostic evidence after redacting secrets.
