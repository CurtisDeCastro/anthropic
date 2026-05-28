# Tag Provisioning Library

This reference covers the shared library (`lib/tag-sync.js`) used by CLI scripts, Express routes, and serverless functions to push workbook specs and apply version tags via the Sigma REST API.

Requires admin OAuth credentials (`SIGMA_CLIENT_ID`, `SIGMA_CLIENT_SECRET`) in addition to the embed credentials. Authenticate first using the `sigma-api` skill's token exchange, or use the `makeClient` helper below which handles the exchange internally.

## Library Structure

All business logic lives in `lib/tag-sync.js`. Entry points (CLI, Express routes, Netlify functions) are thin wrappers — they supply env vars, wire the `onEvent` callback, and handle the HTTP response shape for their transport.

```
lib/
  embed.js          ← CUSTOMER_CONFIG, buildSpec, buildTemplateSpec, slugify
  tag-sync.js       ← makeClient, pushWorkbookSpec, tagWorkbookVersion,
                       syncCustomer, syncAllCustomers, propagateTemplate
scripts/
  sync-customer-tags.js   ← CLI entry point
server.js           ← Express routes (/api/sync-tags, /api/propagate-template)
netlify/functions/
  sync-tags.js
  propagate-template.js
  sync-status.js
```

## `makeClient` — Auto Dry-Run

When admin credentials are absent the client runs in dry-run mode: it logs payloads but makes no API calls. This makes the application fully runnable for demos without real credentials.

```js
async function makeClient({ apiBase, clientId, clientSecret, onEvent }) {
  const dryRun = !clientId || !clientSecret;
  if (dryRun) {
    onEvent?.({ level: 'warn', op: 'init', msg: 'No credentials — dry-run mode' });
    return { dryRun: true, onEvent };
  }
  // OAuth 2.0 client credentials exchange
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${apiBase}/v2/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const { access_token } = await res.json();
  return { apiBase, accessToken: access_token, dryRun: false, onEvent };
}
```

## Core Operations

### Push Workbook Spec

```js
async function pushWorkbookSpec(client, workbookId, spec) {
  client.onEvent?.({ level: 'info', op: 'push-spec', workbookId, dryRun: client.dryRun });
  if (client.dryRun) return;

  const res = await fetch(`${client.apiBase}/v2/workbooks/${workbookId}/spec`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(spec),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spec push failed (${res.status}): ${text}`);
  }
}
```

### Apply Version Tag

```js
async function tagWorkbookVersion(client, workbookId, tagName) {
  client.onEvent?.({ level: 'info', op: 'tag', workbookId, tagName, dryRun: client.dryRun });
  if (client.dryRun) return;

  const res = await fetch(`${client.apiBase}/v2/workbooks/tag`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workbookId, tagName }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tag failed (${res.status}): ${text}`);
  }
}
```

### Sync One Customer

```js
async function syncCustomer(client, customerId) {
  const { buildSpec, slugify, CANONICAL } = require('./embed');
  const spec = buildSpec(customerId);
  const tagName = slugify(customerId);
  try {
    await pushWorkbookSpec(client, CANONICAL.workbookId, spec);
    await tagWorkbookVersion(client, CANONICAL.workbookId, tagName);
    client.onEvent?.({ level: 'info', op: 'sync-customer', customer: customerId, tag: tagName, status: 'ok' });
    return { customer: customerId, tag: tagName, status: 'ok' };
  } catch (err) {
    client.onEvent?.({ level: 'error', op: 'sync-customer', customer: customerId, msg: err.message });
    return { customer: customerId, status: 'error', error: err.message };
  }
}
```

### Sync All Customers

Catches per-customer errors; a single failure does not abort the batch.

```js
async function syncAllCustomers(client) {
  const { CUSTOMER_CONFIG } = require('./embed');
  const results = [];
  for (const customerId of Object.keys(CUSTOMER_CONFIG)) {
    results.push(await syncCustomer(client, customerId));
  }
  return results;
}
```

### Propagate Template

Pushes the template spec, applies the `template` tag, then syncs all customers.

```js
async function propagateTemplate(client) {
  const { buildTemplateSpec, CANONICAL } = require('./embed');
  const spec = buildTemplateSpec();
  await pushWorkbookSpec(client, CANONICAL.workbookId, spec);
  await tagWorkbookVersion(client, CANONICAL.workbookId, 'template');
  client.onEvent?.({ level: 'info', op: 'template', status: 'ok' });
  return await syncAllCustomers(client);
}
```

## The `onEvent` Callback

Every operation emits a structured object. Callers attach their own handler:

```js
// CLI: JSON-per-line to stdout
const onEvent = (e) => console.log(JSON.stringify(e));

// Express / Netlify: collect for response body
const events = [];
const onEvent = (e) => events.push(e);
```

Event shape:
```js
{ level: 'info' | 'warn' | 'error', op: string, [customer]: string, [tag]: string, msg?: string }
```

## Express Routes

```js
async function runTagSync(res, op) {
  const events = [];
  try {
    const client = await makeClient({
      apiBase: process.env.SIGMA_API_BASE,
      clientId: process.env.SIGMA_CLIENT_ID,
      clientSecret: process.env.SIGMA_CLIENT_SECRET,
      onEvent: (e) => events.push(e),
    });
    const result = await op(client);
    res.json({ dryRun: client.dryRun, events, result });
  } catch (err) {
    res.status(500).json({ error: err.message, events });
  }
}

app.post('/api/sync-tags',           (_req, res) => runTagSync(res, syncAllCustomers));
app.post('/api/propagate-template',  (_req, res) => runTagSync(res, propagateTemplate));

// Read-only probe — no Sigma API calls, no side effects
app.get('/api/sync-status', (_req, res) => {
  const hasCreds = Boolean(process.env.SIGMA_CLIENT_ID && process.env.SIGMA_CLIENT_SECRET);
  res.json({ dryRun: !hasCreds });
});
```

## CLI Entry Point

```js
// scripts/sync-customer-tags.js
// Usage:
//   node scripts/sync-customer-tags.js                    # sync all customers
//   node scripts/sync-customer-tags.js --mode template    # propagate template
//   node scripts/sync-customer-tags.js --customer acme    # single customer
//   node scripts/sync-customer-tags.js --dry-run          # force dry-run

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'customers';
const targetCustomer = args.includes('--customer') ? args[args.indexOf('--customer') + 1] : null;
const forceDryRun = args.includes('--dry-run');

(async () => {
  const client = await makeClient({
    apiBase: process.env.SIGMA_API_BASE,
    clientId: forceDryRun ? null : process.env.SIGMA_CLIENT_ID,
    clientSecret: forceDryRun ? null : process.env.SIGMA_CLIENT_SECRET,
    onEvent: (e) => console.log(JSON.stringify(e)),
  });

  let results;
  if (mode === 'template') {
    results = await propagateTemplate(client);
  } else if (targetCustomer) {
    results = [await syncCustomer(client, targetCustomer)];
  } else {
    results = await syncAllCustomers(client);
  }

  const failed = results.filter((r) => r.status === 'error');
  process.exit(failed.length > 0 ? 1 : 0);
})();
```

## Dry-Run Probe Pattern

The UI should determine dry-run state at load time using a dedicated read-only endpoint, not by triggering a write operation:

```js
// On page load — check mode without side effects
const { dryRun } = await fetch('/api/sync-status').then(r => r.json());
banner.textContent = dryRun
  ? 'Running in dry-run mode — set SIGMA_CLIENT_ID and SIGMA_CLIENT_SECRET to enable live sync'
  : 'Live mode — sync operations will write to Sigma';
```

Never use `POST /api/sync-tags` as the probe. That runs the full sync on every page load.
