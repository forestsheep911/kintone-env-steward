# Development Notes

This repository develops the Codex plugin at
`plugins/kintone-env-steward/`.

## Product Direction

Treat the product as a kintone environment-governance assistant. Its primary
subject is configuration and schema: apps, fields, layouts, process management,
permissions, spaces, customizations, integrations, ownership, and lifecycle.
Record-level business analysis is an optional signal, not the core product.

Use this sequence:

1. discover the environment without mutation;
2. normalize evidence into a versioned snapshot;
3. evaluate explicit governance rules;
4. explain findings with evidence and confidence;
5. prepare a reviewable remediation plan;
6. change an environment only after explicit authorization and a fresh preview;
7. verify and record the result.

## Safety

- Default to read-only operation.
- Never infer permission to mutate from permission to inspect.
- Do not commit credentials, cookies, exported customer data, or run outputs.
- Identify the kintone domain and target app IDs before any operation.
- Separate observed facts, inferred risks, and recommendations.
- Treat browser-observed settings as evidence with provenance, not as an API
  contract.
- Require a recovery path for every supported mutation.

## Repository Conventions

- Keep user-facing project documentation under `docs/`.
- Keep runtime instructions required by Codex inside the plugin skill.
- Write generated artifacts under the user's active workspace, normally
  `outputs/kintone-env-steward/<timestamp>/`, never inside the plugin.
- Define versioned JSON schemas before adding deterministic collectors or
  policy evaluators.
- Add scripts only when they can be tested without a production environment.

