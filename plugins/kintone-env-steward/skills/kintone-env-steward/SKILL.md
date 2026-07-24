---
name: kintone-env-steward
description: Guide non-technical users through secure kintone setup, then govern one or more environments with explicit roles, credential references, read/write boundaries, inventories, local dumps, snapshots, findings, experiments, diffs, exceptions, and remediation plans. Use when a user says they want to analyze, inspect, check, improve, or govern a kintone environment; needs first-time setup without editing JSON/YAML; configures a customer-source/lab/target topology; analyzes a local dump; compares environments; tests hypotheses; or plans an approved customer change.
---

# Steward kintone Environments

Default to read-only inspection. Treat configuration and schema as the primary
governance subject; use record data only as a scoped, preferably aggregated
supporting signal.

Version `0.0.17` includes an adaptive loopback-only React configuration
workspace with direct local credential entry, the
terminal/chat wizard, multi-environment governance, and the allowlisted
`kintone-official` MCP server for configuration discovery, including read-only
App enumeration for `*` scopes. Use only its exposed read tools. Do not bypass
the allowlist or start another instance with broader tools.

For a configured read-only analysis, run the deterministic pipeline instead of
assembling a snapshot ad hoc:

`node scripts/analyze-environment.mjs --workspace <active-workspace>
--environment <exact-id>`

It validates the selected environment and local credentials, uses only the
allowlisted official MCP read tools, expands `*`, collects each App with partial
failure isolation, writes a versioned snapshot, and builds the report site.
Then start
`scripts/report-ui-server.mjs --site <run>/report-site --port 4318`. Keep the
configuration console on 4317 and the report on 4318. Tell the user the exact
report URL. Read [report-site.md](references/report-site.md) when creating or
serving a report.

Treat users, organizations, and groups as first-class governance subjects. Read
[identity-governance.md](references/identity-governance.md) before collecting
or evaluating identities. Version 0.0.17 reserves identity coverage in the
snapshot and report but must label it `not-collected`; never imply that identity
governance was assessed.

## Load the environment contract

Look for `.kintone-env-steward/environments.yaml` in the active user workspace
or use the path the user provides. If only the legacy `environments.json`
exists, let the configuration console migrate it to YAML while retaining the
JSON file as a compatibility copy.

If no contract exists, start guided setup immediately. Do not ask the user to
edit JSON or YAML. First confirm the minimum useful non-secret facts in chat:
customer alias, kintone HTTPS address, App IDs or all Apps, and whether this is
one-environment analysis or a multi-environment experiment. Reuse facts the
user already provided instead of asking again.

In an interactive desktop session, write those non-secret facts to a temporary
or git-ignored local context file based on
`assets/config-context.example.json`, then prefer launching the local
configuration workspace:

`node scripts/config-ui-server.mjs --workspace <active-workspace> --initial-context <context.json> --ui-mode auto`

Use `--ui-mode simple` only when the user explicitly wants the shortest form,
or `--ui-mode advanced` when the user explicitly asks to see every governance
setting. In `auto`, start simple for a small analysis setup and show the full
workspace when the configuration includes several environments, a customer
target, or certificates. The user may switch modes without losing values.

The workspace listens on `127.0.0.1:4317`, validates the contract before
saving, and writes the environment contract plus a git-ignored local
credential file under the active workspace. Never put secrets in the initial
context file. The credential API must never return saved secret values to the
browser. Tell the user the exact local URL and both file paths. Explain that
the current local credential file is not sent externally and is not encrypted
at rest. Do not expose the server on a LAN address.

If a browser console is not appropriate, explain that passwords will not be
entered in chat, then ask one short question at a time:

1. Ask whether they only want to analyze one environment or configure the full
   customer-source → experiments → customer-target cycle.
2. Ask for a customer alias, never requiring the real legal name.
3. Ask for the source kintone HTTPS address.
4. Ask for App IDs or all Apps. Accept a POSIX-style integer set expression:
   comma-separated positive IDs, inclusive `start-end` ranges, or `*`.
5. For the full cycle, ask for the number and addresses of experiment
   environments and whether implementation returns to the source environment.
6. Default every governance identity to a dedicated system administrator.

After collecting non-secret answers, use
`scripts/setup-environments.mjs --answers <answers.json> --output
.kintone-env-steward/environments.yaml` to generate the contract and blank
credential checklist. Validate it before continuing. Never place credential
values in the answers file.

If the user prefers a terminal wizard, run
`node scripts/setup-environments.mjs` from this skill.

If a contract exists:

1. Run `scripts/validate-environments.mjs` before environment access.
2. Select the environment by its exact `id`.
3. Treat `accessMode` as the complete persisted permission boundary.
   `read-only` permits inspection and forbids mutation; `read-write` permits
   both. Define the exact requested action in the current chat instead of
   persisting per-operation checkboxes.
4. Check credential environment-variable references without printing values.
5. Treat `activeEnvironmentId` as the current MCP target.
6. Stop if `KINTONE_BASE_URL` or the connected base URL does not match the
   selected environment.

If the current chat requests a write while the selected environment is
`read-only`, do not treat the chat message alone as permission to change the
persisted boundary. Ensure the local configuration workspace is running, then
run:

`node scripts/request-access-change.mjs --workspace <active-workspace> --environment <id> --mode read-write --reason "<concrete chat request>"`

The open local page polls for this request and displays a blocking confirmation
dialog. The dialog must explain that confirmation changes
`environments.yaml` only and does not execute the requested operation. Wait for
the user to approve or deny it in the page, then reload and validate the
contract. Continue only if the new `accessMode` matches the operation and the
current implementation supports it. Never bypass this dialog by editing the
YAML directly.

Read [multi-environment-policy.md](references/multi-environment-policy.md) for
environment roles, administrator credential policy, dump workflow, and
approval gates.

## Select the operation level

1. Use **Level 0 — offline design** when working only from supplied files,
   exports, or requirements.
2. Use **Level 1 — read-only discovery** for inventory, snapshot, diff, or
   assessment tasks. This is the default.
3. Use **Level 2 — remediation planning** to describe exact proposed changes,
   dependencies, verification, and recovery without applying them.
4. Use **Level 3 — controlled change** only when an implementation explicitly
   supports the resource and the user authorizes the current target and diff.

Version `0.0.x` provides guidance for Levels 0–2 only. Do not improvise a live
write path.

## Follow the governance workflow

### 1. Establish scope

- Identify the engagement, environment ID, base URL, role, and exact App IDs.
- State whether the task concerns one environment, a time-based comparison, or
  a cross-environment comparison.
- Confirm the allowed operation level.
- Treat account capability and task authorization as separate gates.
- Minimize access to record content and secrets.

### 2. Collect evidence

- Require explicit App IDs, then prefer the bundled official MCP read tools
  for App details, fields, layouts, processes, general settings, and deployment
  status.
- If the official MCP is unavailable, report the missing base URL,
  authentication, runtime, or server initialization as a blocker; do not ask
  the user to paste credentials into the conversation.
- Treat permissions, views, JavaScript/CSS, Webhooks, and plugin configuration
  as coverage gaps until a separate source provides them.
- Use management UI observation only for settings unavailable through stable
  interfaces.
- Record source, target, collection time, and limitations.
- Keep observed facts distinct from inference.
- Record user, organization, and group coverage explicitly even when the
  current collector cannot access it.

Read [governance-model.md](references/governance-model.md) when designing a
snapshot, rule, finding, exception, or output contract.

### 3. Normalize and compare

- Normalize evidence before comparing it.
- Ignore volatile values unless they matter to governance.
- Report added, removed, and changed objects separately.
- Flag unknown or uncollected settings instead of assuming equivalence.

### 4. Evaluate

- Apply explicit rules where possible.
- Give every finding a stable rule ID, subject, evidence, severity, confidence,
  assessment, and recommendation.
- Treat an approved exception as governed state, not as a hidden suppression.
- Avoid calling a preference a defect unless a baseline or policy supports it.

### 5. Plan remediation

- Order work by risk, dependency, and reversibility.
- State the target and desired change precisely.
- Include impact, prerequisite, approval point, verification, and recovery.
- Never represent a plan as an applied change.

Read [safety-policy.md](references/safety-policy.md) before proposing or
performing any operation that could modify an environment.

### 6. Report

Lead with scope and the most consequential findings. Separate:

- observed facts;
- inferred risks;
- recommendations;
- unknown or inaccessible settings;
- approved exceptions.

Write generated artifacts to the user's active workspace, normally
`outputs/kintone-env-steward/<timestamp>/`. Include the snapshot, structured
report data, and local HTML report site when schema evidence was collected.
Do not write customer evidence, credentials, or run output into the installed
plugin.

## Keep the boundary clear

- Do not turn a schema audit into broad record export.
- Do not expose credentials, cookies, tokens, or unnecessary personal data.
- Do not infer mutation permission from environment access.
- Do not claim complete coverage when an API or UI surface was unavailable.
- Do not recommend automatic bulk fixes without resource-specific rollback and
  verification support.
