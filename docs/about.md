# About this app

> **Status:** Proof of concept. Claims marked 🔮 describe the intended production architecture, not what is currently implemented.

This app is a proof of concept for embedding customer-specific Sigma workbooks using JWT-signed URLs. The goal is to demonstrate a practical pattern for serving different customers through a shared application shell, while still letting each customer see a workbook that reflects their own schema.

Today, the demo uses a small static customer map in `lib/embed.js`. Conceptually, though, the important pattern is that workbook configuration is assembled at request time from two layers:

- a shared base definition that applies to every customer, and
- a customer-specific overlay that defines which additional columns should be exposed.

That seam is the real point of the POC. The static map can later be replaced by a database-backed mapping table without changing the rest of the request pipeline.

---

## What this POC proves

This demo proves that the application can:

- accept a customer selection in the browser,
- look up customer-specific workbook configuration on the server,
- compose a customer-specific workbook definition,
- sign a secure Sigma embed URL using a server-held secret, and
- reload the embed so the customer sees a workbook with the right custom column.

In other words, it shows that customer-driven workbook variation can be handled at request time — from a single application — instead of maintaining entirely separate embed applications per customer.

---

## What this POC does not prove yet

This is still a demo, not a production-ready reference implementation. It does not yet prove:

- performance at production scale,
- operational behavior across many customers,
- automated lifecycle management for workbook specs,
- schema drift handling over time,
- observability and alerting,
- cache or rate-limit behavior under load,
- rollout/versioning strategy for spec changes, or
- security hardening beyond the basic JWT pattern.

Those items are the main areas that would need to be filled in before using this pattern as a production architecture.

---

## Request flow

Three actors are involved:

- the **browser**, which collects inputs and renders the iframe,
- the **Express server** (or Netlify Function in production), which holds the embed secret and signs the JWT, and
- **Sigma**, which validates the token and serves the embedded workbook.

The flow is:

1. The browser collects the selected customer and embed-user context.
2. The browser sends a `POST` request to `/api/embed-url`.
3. The server looks up that customer's workbook metadata.
4. The server composes the workbook spec from the shared base plus the customer-specific column configuration.
5. The server signs a JWT using the Sigma embed secret.
6. The server returns the final embed URL.
7. The browser sets `iframe.src` to that URL.
8. Sigma validates the JWT and renders the workbook.

Once the signed URL is returned, the app server is no longer in the rendering path. The browser talks directly to Sigma through the iframe.

**Important security property:** in production, the embed secret only ever exists on the server. The current demo collects it via a form to make the POC easy to run without redeploying — see the warning in the UI. In any real deployment, credentials move to server-side environment variables and the form fields are removed.

---

## Architecture summary

At a high level, the architecture has four logical layers.

### 1. Shared base definition

The base definition contains the common table structure shared by all customers. In this demo, that includes the shared source table and the columns that always exist:

- `ORDER_NUMBER`
- `SKU_NUMBER`
- `CUST_JSON`

This base definition should stay as stable as possible. It acts as the contract every customer inherits from.

### 2. Customer-specific overlay

Each customer has a small configuration object that defines:

- which custom column(s) to expose,
- how those columns are derived from `CUST_JSON`,
- what labels should be shown in the workbook, and
- which workbook URL should be used.

In the current demo:

- **Customer A** exposes the `AGE_GROUP` column, derived from `Text([Cust Json].AGE_GROUP)`
- **Customer B** exposes the `Birthday` column, derived from `Text([Cust Json].LOYALTY_EXTRA.BIRTHDAY)`

The important design choice is that the customer-specific logic is metadata-driven — it lives in one configuration object (`CUSTOMER_CONFIG` in `lib/embed.js`), not scattered across the codebase.

### 3. Server-side spec composition

The server merges the shared base with the customer overlay at request time using `buildSpec(customer)`.

That function is the architectural seam of the whole demo. It is the place where the system decides which workbook definition to generate for a given customer.

Today that logic is simple and static. In production, the same function would read from a mapping table keyed on customer ID.

> 🔮 **Note on spec push:** the composed spec is currently returned in the API response and rendered in the UI for illustrative purposes, but is **not pushed to Sigma** at request time. The embed loads one of two pre-built workbooks. The intended production path — programmatically applying the composed spec to a workbook — requires either a customer provisioning step at onboarding time or a different architectural approach; see the [PRD](#) for the proposed production path.

### 4. JWT embed delivery

After the spec is chosen, the server signs a JWT with the Sigma embed secret and returns a secure embed URL to the browser.

This keeps secret material off the client and follows the correct trust boundary for secure Sigma embedding.

---

## Spec composition

The demo currently stores customer configuration in a static `CUSTOMER_CONFIG` object inside `lib/embed.js`.

That object contains three kinds of information:

- customer identity,
- workbook destination metadata (the pre-built workbook URL), and
- custom column overrides.

The flow is:

1. Start with `BASE_COLUMNS`
2. Look up the selected customer in `CUSTOMER_CONFIG`
3. Append customer-specific column definitions
4. Associate the resulting spec with the correct workbook URL
5. Sign and return the embed URL

This is intentionally simple so the demo is easy to understand. The intended production path is:

```
customer ID → mapping table → customer column overrides + workbook URL → composed spec → signed embed URL
```

That is the cleanest way to keep the application logic stable while scaling to more customers.

---

## Why server-side signing is required

The JWT is signed with a Sigma embed secret. That secret must never be exposed to the browser.

For that reason:

- signing must happen server-side,
- the browser should only receive the final signed URL,
- credentials should not be collected through the frontend in production.

The current form-based credential input exists only to make the POC easy to run without redeploying. For any real deployment, move credentials to environment variables and remove those form fields from the UI.

---

## Data model assumptions

This POC assumes a shared base table with a JSON field (`CUST_JSON`), where customer-specific attributes can be extracted into workbook columns.

That assumption is important. The demo works because the custom attributes can be expressed as derived fields from a shared data source.

If future customer schemas diverge beyond "same base table plus different JSON extractions," this pattern will need one of the following:

- a stronger normalization layer upstream,
- a richer mapping/spec-generation layer, or
- explicit per-customer workbook variants generated from a common template.

This demo is best suited to cases where customers share a common semantic base and differ mostly in optional custom attributes.

---

## Why this pattern matters

The value of this pattern is not just that the embed changes when a customer changes. The real value is operational.

Without a composition layer, teams often end up with:

- many hand-maintained workbooks,
- duplicated logic across customers,
- fragile onboarding for new tenants, and
- high change-management overhead when base logic evolves.

With a composition layer, the system can move toward:

- one canonical base definition,
- one structured metadata layer for per-customer differences,
- automated onboarding for new customers, and
- eventually version-controlled, programmatic workbook generation.

That is the long-term architectural direction this POC is pointing toward.

---

## Current limitations

### Static configuration

Customer metadata is hard-coded in `lib/embed.js`. This is fine for a demo, but not for production operations.

### Full embed reload on customer change

When the selected customer changes, the iframe is rebuilt and the workbook reloads. That is acceptable for a POC, but the UX cost should be measured before adopting it broadly.

### Spec composition is illustrative, not live

The spec viewer in the UI shows the composed spec in real time, and the server builds and returns it on every request. However, that spec is not currently pushed to Sigma — it selects between two pre-built workbooks. The live push behavior is the intended next implementation step.

### Minimal error handling

The demo focuses on the happy path. Extend it to handle: unknown customer IDs, missing workbook mappings, JWT signing failures, Sigma API failures, and iframe load failures.

### No observability layer

There is currently no structured logging, tracing, or metrics.

### No spec versioning

No formal versioning exists yet for the base spec, customer overlays, or generated outputs.

---

## File map

| File | Role |
|---|---|
| `lib/embed.js` | Source of truth for `CUSTOMER_CONFIG`, `BASE_COLUMNS`, `buildSpec()`, `generateEmbedUrl()`, and `handleEmbedRequest()`. This is the composition layer. |
| `server.js` | Thin Express wrapper for local development. Imports from `lib/embed.js`. |
| `netlify/functions/embed-url.js` | Production serverless handler. Imports from `lib/embed.js`. |
| `netlify.toml` | Netlify deploy config. Publishes `public/`, routes `/api/*` to functions. |
| `public/index.html` | Single-page frontend: credential form, customer selector, live spec preview, Sigma iframe. |
| `package.json` | Runtime dependencies: `express`, `jsonwebtoken`, `uuid`. |

---

## Handoff notes

If you are picking up this project for the first time, start by understanding these three things in order:

1. How `buildSpec(customer)` in `lib/embed.js` assembles the runtime workbook definition.
2. How `/api/embed-url` signs and returns the final embed URL.
3. Which parts of the current implementation are demo scaffolding (the credential form, the static `CUSTOMER_CONFIG`) versus intended production pattern (the `buildSpec` seam, the composition layer).

The key insight is that the demo is less about the specific two customers shown on screen, and more about the composition boundary between a shared workbook base and customer-specific metadata. That boundary is what makes the pattern scalable.
