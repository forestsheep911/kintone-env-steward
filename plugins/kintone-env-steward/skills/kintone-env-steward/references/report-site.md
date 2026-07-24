# Local HTML report

Prefer the complete read-only pipeline:

```text
node scripts/analyze-environment.mjs \
  --workspace <active-workspace> \
  --environment <exact-environment-id>
```

To rebuild only the report site from an existing snapshot:

```text
node scripts/build-report-site.mjs \
  --snapshot <run-directory>/snapshot.json \
  --output <run-directory>/report-site
```

Start the loopback-only report server:

```text
node scripts/report-ui-server.mjs \
  --site <run-directory>/report-site \
  --port 4318
```

Use port 4318 by default. Keep the configuration console on port 4317. If 4318
is already occupied, inspect the exact listener before choosing a different
port. Never bind the report to a LAN address.

The generated directory contains:

- `index.html`: report entry page;
- `styles.css`: presentation;
- `app.js`: local filtering and App detail interactions;
- `report-data.json`: normalized, non-record governance evidence.

Do not copy credentials, record payloads, cookies, or tokens into the report.
Field names that suggest sensitive content may be listed as schema evidence,
but the corresponding record values must never be collected for this report.

Treat automatic functional categories as inference. Preserve source scope,
collection time, evidence coverage, limitations, confidence, and App IDs.
