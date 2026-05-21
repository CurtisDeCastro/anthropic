# About this app

> **Status:** Working proof of concept, wired against a live Sigma org. See [`docs/prd.md`](./prd.md) for the production-architecture design this app implements.

This app is a proof of concept for embedding customer-specific Sigma workbooks using JWT-signed URLs. It demonstrates a practical pattern for serving different customers through a shared application shell, where each customer sees a workbook with their own custom columns — backed by a **single canonical workbook with per-customer version tags**, not N separate documents.

The demo keeps a small customer map in `lib/embed.js`. Workbook configuration is assembled at request time from two layers:

- a shared **base definition** that applies to every customer (`BASE_COLUMNS`), and
- a **customer-specific overlay** that defines which additional columns to expose (`CUSTOMER_CONFIG[customer].extraColumns`).

That seam is the real point of the POC. The static map can be replaced by a database-backed mapping table without changing the rest of the request pipeline. The composition function (`buildSpec()`) is the only place this logic lives.

---

## What this POC proves

This demo proves that the application can:

- accept a customer selection in the browser,
- look up customer-specific workbook configuration on the server,
- **programmatically compose and push** a customer-specific workbook definition to Sigma via `PUT /v2/workbooks/{id}/spec`,
- create and apply Sigma **version tags** so each customer's view is an immutable snapshot under one canonical workbook,
- sign a secure JWT embed URL pointing at the customer's tagged version, and
- reload the embed so the customer sees a workbook with the right custom column.

In other words, it shows that customer-driven workbook variation can be handled programmatically — from a single application, against a single canonical workbook — instead of maintaining entirely separate embed applications or workbooks per customer.

---

## What this POC does not prove yet

This is a working demo against a real Sigma org, not a production-ready reference implementation. It does not yet prove:

- performance at production scale,
- operational behavior across many customers (the live verification used two),
- schema drift handling over time,
- observability and alerting beyond the structured operation log,
- cache or rate-limit behavior under load,
- rollout / version-pinning strategy for spec changes, or
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

The server merges the shared base with the customer overlay using `buildSpec(customer)` (used by the sync script) and produces an embed URL pointing at the customer's tag using `handleEmbedRequest` (used by `/api/embed-url` at request time).

`buildSpec()` is the architectural seam of the whole design — it's the place where the system decides which workbook definition to generate for a given customer. Today that logic is simple and static. In production, the same function would read from a mapping table keyed on customer ID.

**Spec push is real.** The reconciliation script (`scripts/sync-customer-tags.js`, also wired to two buttons in the Setup tab) pushes the composed spec to `PUT /v2/workbooks/{id}/spec` and applies the customer's version tag via `POST /v2/workbooks/tag`. The previously-illustrative `buildSpec()` output is now the input the sync uses.

### 4. JWT embed delivery

At embed time, `handleEmbedRequest` looks up the customer's tag name, appends `/tag/<tagName>` to the canonical workbook URL, signs a JWT with the embed secret, and returns the URL. No Sigma API calls happen in this hot path — the spec push and tag application were done offline by the sync script.

This keeps secret material off the client and follows the correct trust boundary for secure Sigma embedding.

---

## Spec composition

The demo keeps customer configuration in a static `CUSTOMER_CONFIG` object inside `lib/embed.js`. Each entry contains:

- `tagName` — the Sigma version tag this customer's embed targets (e.g. `customer-customer-a`)
- `extraColumns` — the customer-specific column formulas that get added on top of `BASE_COLUMNS`

The two flows are:

**Sync (offline, via the script or the Setup-tab buttons):**

1. Start with `BASE_COLUMNS`
2. Look up the selected customer in `CUSTOMER_CONFIG`
3. Append `extraColumns` to produce the per-customer spec
4. `POST /v2/tags` to ensure the version tag exists (idempotent)
5. `PUT /v2/workbooks/{CANONICAL.workbookId}/spec` with the composed spec
6. `POST /v2/workbooks/tag` to apply `tagName` to the new published version

**Embed (online, at request time):**

1. Look up `tagName` in `CUSTOMER_CONFIG`
2. Construct `${CANONICAL.workbookUrl}/tag/${tagName}`
3. Sign a JWT and append `?:jwt=<token>&:embed=true`
4. Return the URL — done in one HMAC sign, no Sigma API calls

The intended production path replaces step 2 of the sync flow with a database-backed mapping table lookup; nothing else changes.

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

### Minimal error handling

The demo focuses on the happy path. Extend it to handle: unknown customer IDs, missing workbook mappings, JWT signing failures, Sigma API failures, and iframe load failures. The sync script does already handle per-customer failures gracefully (one customer's failure doesn't block the rest) and exits with a non-zero status — see `scripts/sync-customer-tags.js`.

### Limited observability

The sync script emits structured JSON log events; the Setup-tab log panel renders them. There's no metrics emission, no tracing, and no alerting wiring. For production, route those events into a logger (`pino`, structured stdout to your log aggregator, etc.) and add timing on the spec push + tag steps.

### No spec versioning beyond Sigma's

Sigma's own version-tag system is the source of truth for "what each customer was seeing as of when." There's no application-side versioning on top of `CUSTOMER_CONFIG` itself — git history is the only record. For controlled rollouts, consider adding a `specVersion` field per customer and gating tag updates on it.

---

## File map

| File | Role |
|---|---|
| `lib/embed.js` | Source of truth for `CUSTOMER_CONFIG`, `BASE_COLUMNS`, `CANONICAL`, `buildSpec()`, `buildTemplateSpec()`, `slugify()`, `tagNameFor()`, `generateEmbedUrl()`, and `handleEmbedRequest()`. Module-load slug-collision guard runs here. |
| `lib/tag-sync.js` | Sigma REST client + reconciliation logic. `makeClient`, `ensureTagExists`, `pushWorkbookSpec`, `tagWorkbookVersion`, `syncCustomer`, `syncAllCustomers`, `pushTemplate`, `propagateTemplate`. Used by the CLI and the two button-backing routes. |
| `scripts/sync-customer-tags.js` | Copy-able CLI. `--mode customers\|template`, `--customer <id>`, `--dry-run`. Auto dry-runs when admin credentials are absent. |
| `test/embed.test.js` | Node built-in test runner. Smoke tests on slugify, build*, stripSpecForPush, tag-name resolution, and the collision guard. Run with `npm test`. |
| `server.js` | Express dev server: `/api/embed-url`, `/api/sync-tags`, `/api/propagate-template`, `/api/sync-status`. |
| `netlify/functions/*.js` | Matching Netlify Functions for production deploy. |
| `netlify.toml` | Netlify deploy config. Publishes `public/`, routes `/api/*` to functions. |
| `public/index.html` | Single-page frontend: credential form, customer selector, live spec preview, Sigma iframe, Setup-tab admin actions. |
| `package.json` | npm scripts (`start`, `dev`, `sync-tags`, `propagate-template`, `test`). Deps: `express`, `jsonwebtoken`, `uuid`. |

---

## Handoff notes

If you are picking up this project for the first time, start with these three things in order:

1. **`lib/embed.js`** — how `buildSpec(customer)` assembles the workbook definition, and how `handleEmbedRequest` constructs the `/tag/<tagName>` embed URL.
2. **`lib/tag-sync.js`** — how the reconciliation script turns `CUSTOMER_CONFIG` into Sigma API calls (spec push → tag).
3. **`docs/prd.md`** — the production-architecture design and the rollout milestones.

The key insight is that the demo is less about the specific two customers shown on screen, and more about the composition boundary between a shared workbook base and customer-specific metadata. That boundary is what makes the pattern scalable.
