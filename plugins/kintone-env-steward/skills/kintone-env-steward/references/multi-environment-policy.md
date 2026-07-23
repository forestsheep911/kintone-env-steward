# Multi-environment Policy

Read the workspace environment contract before accessing kintone.

## Environment roles

- Treat `customer-source` as protected evidence and default it to `read-only`.
  Change it to `read-write` only through the local web confirmation flow.
- Treat `experiment` as isolated. Respect its `accessMode` and keep results
  separate by environment ID.
- Treat `customer-target` as controlled production and default it to
  `read-only` until the user confirms a `read-write` change in the local page.

## Administrator credentials

Prefer a dedicated system-administrator account for environment governance
because broad configuration evidence may require it. Do not confuse possession
of that credential with authorization to mutate.

Store only environment-variable names in the contract. Never request or accept
credential values in chat, reports, snapshots, or committed files. Use a
separate read-only App token when a record dump does not require administrator
scope.

## Dump workflow

Before a customer-data dump:

1. Confirm the exact environment ID and App IDs.
2. Confirm the environment is at least `read-only`.
3. Confirm the exact dump scope and data-handling details in the current chat.
4. Apply the agreed attachment, redaction, output, and retention rules.
5. Write a manifest containing source IDs, time, filters, counts, and hashes,
   but no credentials.
6. Analyze the local copy; do not repeatedly query the customer environment
   when the dump is sufficient.

## Experiment workflow

Record each hypothesis, selected experiment environment, intended change,
success criteria, observed result, and decision. Do not copy customer records
into an experiment unless the data policy explicitly allows it; prefer
synthetic or redacted fixtures.

## Authorization rule

An operation is permitted only when all are true:

- the authenticated identity has the technical capability;
- the environment `accessMode` permits the read or write class;
- the plugin version implements the operation;
- the current chat states the exact target and action;
- any change from `read-only` to `read-write` was confirmed in the local page.

Use the most restrictive result when these sources disagree.
