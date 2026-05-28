# Sigma Embed

Generate server-side embed URLs that open a Sigma workbook inside a host application. This skill covers JWT signing, per-customer workbook variants via version tags, and automated tag provisioning. It does **not** cover admin API authentication — use the `sigma-api` skill for any REST calls required by the provisioning workflow.

`jsonwebtoken` (Node.js) or an equivalent HS256 JWT library for your runtime must be available. The embed secret is used only for HMAC signing and never leaves the server.

## Credential Types

Sigma embeds use **two separate credential sets** that must never be confused:

| Set | Where to find | Used for |
|-----|--------------|----------|
| Embed Client ID + Embed Secret | Sigma → Administration → Developer Access → Embed credentials | JWT signing (`kid` header + HMAC secret) |
| Admin OAuth Client ID + Secret | Sigma → Administration → Developer Access → API credentials | REST API calls (tag writes, spec push) — see `sigma-api` skill |

```sh
# Embed signing credentials (server env only — never browser-facing)
export SIGMA_EMBED_CLIENT_ID="your-embed-client-id"
export SIGMA_EMBED_SECRET="your-embed-secret"

# Canonical workbook (the one workbook all customers embed)
export SIGMA_CANONICAL_WORKBOOK_URL="https://app.sigmacomputing.com/embed/1-xxxx"
```

## Step 1 — Generate a Basic Embed URL

The JWT `kid` header must equal the Embed Client ID. `jti` must be a unique nonce per request (UUID v4). Set `exp` short — 5 minutes is standard.

```js
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

function generateEmbedUrl(userEmail) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userEmail,
    iat: now,
    exp: now + 300,         // 5-minute window
    jti: randomUUID(),      // replay-prevention nonce
  };
  const token = jwt.sign(payload, process.env.SIGMA_EMBED_SECRET, {
    algorithm: 'HS256',
    header: { kid: process.env.SIGMA_EMBED_CLIENT_ID },
  });
  const base = process.env.SIGMA_CANONICAL_WORKBOOK_URL;
  return `${base}?:jwt=${encodeURIComponent(token)}&:embed=true`;
}
```

Expose this through a server-side route; return only the signed URL to the browser, never the token components separately.

```js
// Express example
app.post('/api/embed-url', (req, res) => {
  const url = generateEmbedUrl(req.user.email);  // req.user from your auth layer
  res.json({ url });
});
```

## Step 2 — Point to a Tagged Version

Without tags every embedded user sees the current published state. Tags freeze a named snapshot, enabling per-customer variants and safe rollouts.

Insert the tag name as a **path segment** before the query string:

```
{workbookUrl}/tag/{tagName}?:jwt=...&:embed=true
```

```js
function generateTaggedEmbedUrl(userEmail, tagName) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userEmail,
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  };
  const token = jwt.sign(payload, process.env.SIGMA_EMBED_SECRET, {
    algorithm: 'HS256',
    header: { kid: process.env.SIGMA_EMBED_CLIENT_ID },
  });
  const base = process.env.SIGMA_CANONICAL_WORKBOOK_URL;
  return `${base}/tag/${tagName}?:jwt=${encodeURIComponent(token)}&:embed=true`;
}
```

Common tag naming conventions:

| Purpose | Tag name pattern | Example |
|---------|-----------------|---------|
| Per-customer variant | `customer-<slug>` | `customer-acme` |
| Base template (not embedded directly) | `template` | `template` |
| Environment separation | `env-staging`, `env-prod` | `env-prod` |

A slug is the customer identifier lowercased with non-alphanumeric runs replaced by `-`.

## Step 3 — Per-Customer Workbook Variants

If different customers need different columns or visible elements, maintain one `CUSTOMER_CONFIG` object in code and derive workbook specs programmatically. Apply each derived spec to the customer's tag; concurrent embed requests are safe because tags are immutable.

Load `reference/customer-config.md` for the full pattern including `buildSpec()`, `buildTemplateSpec()`, and the composition rules.

## Step 4 — Automate Tag Provisioning

Applying specs and tags via the Sigma REST API means operators never touch Sigma UI for routine onboarding or template propagation. The automation requires admin OAuth credentials (see `sigma-api` skill) in addition to embed credentials.

Key operations:
- **Push spec** — `PUT /v2/workbooks/{workbookId}/spec` with the composed JSON body
- **Apply tag** — `POST /v2/workbooks/tag` with `{ workbookId, tagName }`
- **Propagate template** — push template spec → tag as `template` → push each customer spec → tag as `customer-<slug>`

Load `reference/tag-sync.md` for the full library design, dry-run pattern, and CLI entry point.

## Step 5 — Verify the Embed

In the browser, open DevTools and confirm:
1. The `iframe src` contains `?:jwt=` and `&:embed=true`
2. The JWT is not readable to JavaScript running in the host page (it should be set as the iframe `src`, not stored in JS scope)
3. No Sigma credentials appear in Network requests initiated by the host page

## When to Escalate

The workbook-tag approach handles most per-customer use cases. Load `reference/escalation.md` when:
- Customers need different source databases or row-level security policies
- Per-customer differences are schema-level (column names driven by upstream data models)
- A single workbook visual layer is shared but the data binding differs per customer

## Security Notes

- Never generate embed URLs in browser JavaScript — the secret would be exposed.
- Never log `SIGMA_EMBED_SECRET` or return it in API responses.
- Set `exp` short (≤ 10 minutes); long-lived tokens weaken replay protection.
- Reusing `jti` values causes Sigma to reject the token — always generate a fresh UUID per request.
- Admin OAuth credentials and embed credentials are distinct; never substitute one for the other.
- Protect any server route that triggers spec pushes or tag writes — these are write operations on live workbooks.
