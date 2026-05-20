# PRD: Per-customer embed via workbook version tagging

> **Status:** Proposed. Supersedes the "🔮 spec push" note in `docs/about.md:110`.
> **Owners:** Sigma embed POC.
> **Scope:** Production architecture for the customer-specific embed pattern currently demoed in `lib/embed.js`.

---

## 1. Summary

Today's POC composes a customer-specific workbook spec at request time in `buildSpec()` (`lib/embed.js:60`) and returns it in the API response for illustration, while the actual embed loads one of two **pre-built workbooks** selected by URL. The composed spec has no real consumer. Each customer is its own Sigma document, and onboarding a new customer means duplicating a workbook in the Sigma UI and pasting a new URL into `CUSTOMER_CONFIG`.

This PRD specifies the production path: **one canonical embed workbook** with **per-customer tagged versions**. Each customer's tag is a frozen, immutable snapshot of the canonical workbook with that customer's JSON-extraction columns added on top. The embed URL targets the customer's tag by appending `/tag/<tagName>` to the canonical workbook URL before the JWT is signed.

A small reconciliation script (`scripts/sync-customer-tags.js`, exposed via two buttons in the Setup tab) walks `CUSTOMER_CONFIG`, builds the per-customer spec from `BASE_COLUMNS + extraColumns`, pushes it to the canonical workbook, and applies the `customer-<slug>` tag. A second mode pushes the `template` tag and then propagates that base across every customer tag. There is one open assumption about the workbook spec-push endpoint — see §3.

This pattern is concurrency-safe by construction (tags are immutable), keeps embed latency at one HMAC sign, and reduces Sigma's document footprint from "one per customer" to "one for the embed, plus N tagged versions of it."

---

## 2. Goals and non-goals

### Goals

- One canonical workbook in Sigma, with N tagged versions that don't appear as separate documents in the file browser.
- Customer-specific column display names render as real labels in the Sigma UI (not parameterized placeholders).
- Embed request path makes zero Sigma API calls. Latency is bounded by one HMAC sign.
- Two concurrent embed requests from different customers cannot interfere with each other's view.
- Onboarding a new customer is a `CUSTOMER_CONFIG` edit plus one button click. Updating shared base columns is a `BASE_COLUMNS` edit plus one button click.

### Non-goals

- Live editing of customer overlays through the embed app UI. Overlays live in `CUSTOMER_CONFIG` and are pushed via the sync script.
- Multi-region / multi-tenant Sigma org support. One Sigma org assumed.
- Migrating the existing two pre-built workbooks. They are demo artifacts and will be replaced by a single canonical workbook with two tagged versions.
- Reconciling state when an operator has hand-edited a tagged version in the Sigma UI between sync runs. The script treats `CUSTOMER_CONFIG` as source-of-truth and overwrites.

---

## 3. Why workbook-only

The naïve plan — "mutate the canonical workbook's spec on every embed request" — fails because a workbook spec is **shared state, not session state**. Concurrent mutation by two tenant requests would interleave at the document level, so one tenant could briefly observe another's columns. Version tagging solves this by making each customer's state an immutable snapshot.

The spec-push side has one open assumption worth calling out. The Sigma public REST API documents `PUT /v2/dataModels/{id}/spec` for data models but does not document an equivalent path for workbooks. This PRD assumes the workbook surface mirrors the data-model surface at `PUT /v2/workbooks/{workbookId}/spec`. The reconciliation script and demo buttons are wired against that path with the URL configurable via `SIGMA_SPEC_ENDPOINT_PATH` / `SIGMA_SPEC_ENDPOINT_METHOD` so the assumption is easy to swap. The tag-application step (`POST /v2/workbooks/tag`) is public and confirmed.

If the assumed endpoint turns out not to exist in your Sigma org, the fallback is to perform the spec edits in the Sigma UI ("restore tag as draft → edit → re-tag") and use the reconciliation script only to apply the tag. The script's two steps are decoupled for exactly this reason.

---

## 4. Architecture

### 4.1 Sigma object inventory

| Object | Purpose | Tags |
|---|---|---|
| **Canonical embed workbook** ("Embed — Plugs Electronics") | Single workbook containing the base layout, page, table element, and shared columns (`ORDER_NUMBER`, `SKU_NUMBER`, `CUST_JSON`). | `template`, plus `customer-<slug>` per customer. |

That's the entire inventory. One Sigma document. Tags do not appear as separate items in the file browser.

### 4.2 Tag naming convention

- `template` — the clean, customer-agnostic starting state. **Never embedded.** This is the version operators clone from when onboarding a new customer.
- `customer-<slug>` — one per customer. `<slug>` is the lowercased, dash-separated form of the customer key in `CUSTOMER_CONFIG` (e.g. `customer-customer-a`, `customer-acme-co`). Stored verbatim as `CUSTOMER_CONFIG[customerId].tagName`.

### 4.3 Embed request path

The signed embed URL is constructed by appending `/tag/<encodedTagName>` to the canonical workbook URL before the JWT is signed:

```
https://<org>.sigmacomputing.io/<slug>/workbook/<workbookName>-<workbookId>/tag/<tagName>?:jwt=<token>&:embed=true
```

This is a documented Sigma feature (see "Link to a tagged version of a document" in the Sigma version-tagging guide). It requires **no new JWT claim**. The change in `generateEmbedUrl` (`lib/embed.js:89`) is a single line of URL composition.

### 4.4 Operator workflow

Two operator actions, both driven from `CUSTOMER_CONFIG` and either the Setup-tab buttons or the equivalent CLI:

1. **Onboarding a new customer.** Operator adds an entry to `CUSTOMER_CONFIG` in `lib/embed.js` (workbook id/url for the legacy embed flow, a `tagName`, and the `extraColumns` array describing the customer's JSON extractions). Clicks **Sync customer tags from config** in the Setup tab — or runs `npm run sync-tags -- --customer "<name>"` — and the script pushes the composed spec to the canonical workbook and applies the `customer-<slug>` tag. Idempotent: re-running is a no-op if nothing changed.
2. **Updating shared base columns.** Operator edits `BASE_COLUMNS` in `lib/embed.js`. Clicks **Propagate template updates** — or runs `npm run propagate-template`. The script tags the new base as `template`, then iterates the per-customer rebuild so every `customer-<slug>` tag inherits the new base. This is the operation that scales with customer count, but it is one button click, not N Sigma-UI sessions.

Both buttons render a structured log of every API call below the buttons, so the operator can see exactly what was pushed and tagged. Dry-run is automatic when admin credentials aren't configured — the log shows what would be sent without performing the calls.

---

## 5. Detailed design

### 5.1 `CUSTOMER_CONFIG` shape change

Today (`lib/embed.js:41`):

```js
'Customer A': {
  workbookId: '5666ff98-...',
  workbookUrl: 'https://staging.sigmacomputing.io/.../workbook/Customer-A-...',
  extraColumns: [
    { id: 'syaasfXKHZ', formula: 'Text([Cust Json].AGE_GROUP)', name: 'AGE_GROUP' },
  ],
},
```

Post-PRD shape:

```js
'Customer A': {
  tagName: 'customer-customer-a',
  // workbookId / workbookUrl / extraColumns remain on each entry to drive
  // the legacy demo embed flow and the spec composition consumed by the
  // tag-sync script. The /api/embed-url path only reads `tagName` post-PRD.
},
```

The canonical embed workbook (the new target of all spec push + tag operations) lives in a single module-level `CANONICAL` constant, sourced from env so the same code runs in any Sigma org:

```js
const CANONICAL = {
  workbookId: process.env.SIGMA_CANONICAL_WORKBOOK_ID,
  workbookUrl: process.env.SIGMA_CANONICAL_WORKBOOK_URL,
};
```

### 5.2 `buildSpec()` keeps a real consumer

`buildSpec(customer)` (`lib/embed.js:60`) is retained because it's now the source of truth for the spec the reconciliation script pushes to Sigma. Two helpers are added next to it:

- `buildTemplateSpec()` — produces the base-only spec for the `template` tag.
- `buildCanonicalCustomerSpec(customer)` — re-targets `buildSpec()`'s output at `CANONICAL.workbookId` instead of the customer's demo workbook.
- `slugify(customerId)` — deterministic `customer-<slug>` tag name from a customer key.

The live spec preview pane in `public/index.html` is retained — post-PRD it actually previews what the sync buttons will push.

### 5.3 `generateEmbedUrl` modification

Single change at the URL-composition point in `lib/embed.js:107`:

```js
const taggedUrl = `${workbookUrl}/tag/${encodeURIComponent(tagName)}`;
return `${taggedUrl}?:jwt=${encodeURIComponent(token)}&:embed=true`;
```

Pass `tagName` through from `handleEmbedRequest` to `generateEmbedUrl`. `handleEmbedRequest` becomes a tag-lookup + URL-concatenation + JWT-sign in the request path, with no spec composition (the spec is only composed by the sync script, not by the embed handler).

### 5.4 Reconciliation script + demo buttons

`lib/tag-sync.js` is the shared library used by all three consumers:

- **CLI**: `scripts/sync-customer-tags.js` — copy-able standalone Node script. Flags `--mode customers|template`, `--customer <id>`, `--dry-run`. Exits non-zero on any failed customer. Heavily commented so an operator can drop the two files (`lib/tag-sync.js` + `scripts/sync-customer-tags.js`) into another project that mirrors this `CUSTOMER_CONFIG` shape.
- **Express routes**: `POST /api/sync-tags`, `POST /api/propagate-template`, and the read-only probe `GET /api/sync-status` (so the UI can render its dry-run banner without performing API calls).
- **Netlify functions**: `netlify/functions/sync-tags.js`, `netlify/functions/propagate-template.js`, `netlify/functions/sync-status.js`. Thin wrappers around the same library.

Per-customer step sequence:
1. Build spec via `buildCanonicalCustomerSpec(customerId)`. Strip `workbookId` / `url` / `_meta` (`stripSpecForPush` in `lib/tag-sync.js`).
2. `PUT /v2/workbooks/{CANONICAL.workbookId}/spec` with the stripped body (see §3 for the open-assumption note on this endpoint).
3. `POST /v2/workbooks/tag` with `{workbookId: CANONICAL.workbookId, tag: slugify(customerId)}`.
4. Emit a structured log event.

"Propagate template updates" runs the same sequence but step 1 uses `buildTemplateSpec()` (no customer columns) and step 3 applies the `template` tag — then it iterates the per-customer sync above.

Auto dry-run: if `SIGMA_CLIENT_ID` / `SIGMA_CLIENT_SECRET` aren't set on the server, both buttons run in dry-run mode and the log panel shows the payloads that would have been sent. Live mode kicks in automatically when credentials are present.

Authentication uses `SIGMA_CLIENT_ID` / `SIGMA_CLIENT_SECRET` env vars, a **separate** OAuth client from the embed signing secret. These admin credentials are never loaded by `/api/embed-url`.

### 5.5 Concurrency and consistency properties

- **Embed request → embed request:** no shared mutable state. Each request reads from an immutable tagged version. Safe.
- **Embed request → operator editing in Sigma UI:** when an operator restores a tagged version as draft and re-tags it, the prior tagged version remains in version history and the new content takes the tag name atomically at tag-time. An embed request in flight during this transition sees either the pre-edit content or the post-edit content, never a partial state.

### 5.6 Performance

| Stage | Today | Post-PRD |
|---|---|---|
| `/api/embed-url` p50 | One HMAC sign (~1 ms) | One HMAC sign (~1 ms) |
| Sigma API calls in request path | 0 | 0 |
| Onboarding a new customer | Manual workbook build, paste URL into config | `CUSTOMER_CONFIG` edit + one button click |
| Updating shared base across all customers | Manual workbook re-build × N | `BASE_COLUMNS` edit + one button click |

No change in request-path latency. All Sigma API calls are in the offline sync path.

---

## 6. Code changes (file by file)

### `lib/embed.js`
- Keep `BASE_SOURCE`, `BASE_COLUMNS`, `PAGE_ID`, `ELEMENT_ID`, `LAYOUT`, `buildSpec()` — they now have a real consumer (the sync script).
- Add module-level `CANONICAL = { workbookId, workbookUrl }` sourced from env vars.
- Add `buildTemplateSpec()`, `buildCanonicalCustomerSpec(customer)`, `slugify(customerId)`.
- Add `tagName` to each `CUSTOMER_CONFIG` entry.
- Update `generateEmbedUrl` to accept and append `tagName`.
- Update `handleEmbedRequest` to look up `tagName` and pass it through.

### `lib/tag-sync.js` (new)
- `makeClient({ apiBase, clientId, clientSecret, onEvent })` — handles OAuth and detects dry-run.
- `pushWorkbookSpec`, `tagWorkbookVersion` — primitive operations.
- `syncCustomer`, `syncAllCustomers`, `pushTemplate`, `propagateTemplate` — orchestration.
- Spec-push endpoint URL configurable via `SIGMA_SPEC_ENDPOINT_PATH` / `SIGMA_SPEC_ENDPOINT_METHOD`.

### `scripts/sync-customer-tags.js` (new, copy-able)
- Self-documenting CLI. Flags: `--mode customers|template`, `--customer <id>`, `--dry-run`.
- Imports from `lib/tag-sync.js` + `lib/embed.js`. Drop both files into any project that mirrors the `CUSTOMER_CONFIG` shape and it works.
- JSON-per-line structured log to stdout.

### Server routes (Express + Netlify)
- `server.js`: adds `POST /api/sync-tags`, `POST /api/propagate-template`, `GET /api/sync-status`.
- `netlify/functions/sync-tags.js`, `netlify/functions/propagate-template.js`, `netlify/functions/sync-status.js`: matching serverless handlers.

### `public/index.html`
- New "Step 5 — Sync customer version tags" panel in the Setup tab. Two buttons (sync customer tags, propagate template), one live-mode/dry-run banner, one structured log panel that renders the events array returned by the endpoints.

### `package.json`
- Add npm scripts:
  - `"sync-tags": "node scripts/sync-customer-tags.js"`
  - `"propagate-template": "node scripts/sync-customer-tags.js --mode template"`

### `public/index.html`
- Remove the live composed-spec preview pane. Keep the customer selector, credential form (for the POC), and the iframe.

### `docs/about.md`
- Replace the `🔮 spec push` block at line 110 with a one-paragraph summary of the version-tagging approach and a link to this PRD. Update the "Current limitations" and "Spec composition" sections to match: the demo no longer claims spec composition is a deferred production step — it is replaced by tag-based provisioning.

### `netlify/functions/embed-url.js`, `server.js`
- No changes. They are thin wrappers around `handleEmbedRequest`.

---

## 7. Operational runbook

### Onboarding a new customer

1. Add an entry to `CUSTOMER_CONFIG` in `lib/embed.js`:
   ```js
   'New Customer Name': {
     workbookId: '...',          // legacy demo embed flow
     workbookUrl: '...',
     tagName: 'customer-<slug>',
     extraColumns: [
       { id: '...', formula: 'Text([Cust Json].YOUR_KEY)', name: 'YOUR_LABEL' },
     ],
   },
   ```
2. Click **Sync customer tags from config** in the Setup tab (or `npm run sync-tags -- --customer "New Customer Name"`). Dry-run first if you want to inspect the payload.
3. Deploy.

### Updating shared base columns

1. Edit `BASE_COLUMNS` in `lib/embed.js`.
2. Click **Propagate template updates** in the Setup tab (or `npm run propagate-template`). This pushes the new base to the `template` tag, then iterates every customer-tag rebuild.
3. Deploy.

### Removing a customer

1. Delete the entry from `CUSTOMER_CONFIG`.
2. (Optional) In the Sigma UI, remove the orphaned `customer-<slug>` tag. Note Sigma's warning: any user with access only to the tagged version loses access.
3. Deploy.

---

## 8. When to outgrow this pattern

This PRD optimizes for **simplicity and operator-driven onboarding**. It is the right choice when:

- Customer count is small to moderate (low tens) and growing slowly.
- Customer-specific column logic is straightforward — JSON path extractions, simple casts.
- Operators are comfortable in the Sigma UI and shared-base changes are infrequent.

It is **not** the right choice when:

- Customer-specific logic grows complex (multiple data sources, materialized intermediates, cross-table joins).
- Schemas diverge enough that the single-element-per-page assumption stops holding.
- Customer count scales to a point where the JSON payload pushed in step 1 (per-customer spec body) becomes unwieldy to review in CI.

In those cases, lift the customer-specific column logic out of the workbook and into a **Sigma data model**. Data models have a `PUT /v2/dataModels/{id}/spec` endpoint with a published OpenAPI contract (no open assumption needed), and one canonical data model with tagged versions per customer combines with `dataModelSourceTaggedVersions` on `POST /v2/workbooks/tag` to give you per-customer source binding. The workbook stays thin and stable; complexity lives in the data model. The script changes shape but the embed request path (single HMAC sign, tag-URL append) is unchanged.

---

## 9. Failure modes and error handling

| Failure | Detection | Handling |
|---|---|---|
| Embed URL targets a tag that no longer exists | Sigma returns an error page in the iframe | Click **Sync customer tags from config** to recreate; the script is idempotent. |
| Spec push fails (assumed endpoint not present, 4xx/5xx) | Log panel surfaces the status + body. Per-customer failure isolates from the rest of the loop. | Override `SIGMA_SPEC_ENDPOINT_PATH` / `SIGMA_SPEC_ENDPOINT_METHOD`, or fall back to in-Sigma-UI edits for the spec step and run only the tag step. |
| OAuth token rejected mid-script | First API call after auth returns 401 | Script fails the affected customer and continues. Operator rotates `SIGMA_CLIENT_ID` / `SIGMA_CLIENT_SECRET` and re-runs. |
| Tag name conflict | `POST /v2/workbooks/tag` returns 409 | Script logs the conflict per customer. Operator either removes the conflicting tag or renames the customer slug. |
| Operator forgets to update `CUSTOMER_CONFIG` | New customer simply not selectable in the app | UI shows only customers from `CUSTOMER_CONFIG`. No silent breakage. |
| Two operators run the sync concurrently | Both write to the same canonical workbook draft | Sigma's draft model serializes; the second writer sees a conflict and the script reports it. Recommendation: gate the script behind a CI job that runs single-threaded. |

---

## 10. Security

- **Embed signing secret** (current `secret` parameter in `handleEmbedRequest`): unchanged. Continues to live in server-side env vars only.
- **Sigma admin client credentials** (new, `SIGMA_CLIENT_ID` / `SIGMA_CLIENT_SECRET`): used only by the sync script and the two button-backing routes. **Never** loaded by the embed-url handler. Required scopes: spec push on the canonical workbook and `POST /v2/workbooks/tag`.
- **Tag name as identifier**: tag names are user-visible in Sigma. Use `customer-<slug>` derived from a non-PII customer ID, not from customer email addresses or anything else PII-bearing.

---

## 11. Open questions

1. **Confirm the workbook spec-push endpoint.** The script assumes `PUT /v2/workbooks/{workbookId}/spec` (mirroring the data-model surface). Verify against the actual Sigma org and override `SIGMA_SPEC_ENDPOINT_PATH` / `SIGMA_SPEC_ENDPOINT_METHOD` if it differs. The dry-run mode of both buttons surfaces the exact URL that will be hit.
2. **Naming the canonical workbook in Sigma.** Pick once; this becomes the URL in `CANONICAL.workbookUrl` and changes are URL-breaking.
3. **Tag color convention.** Sigma offers six tag colors. Suggested: `bronze` for `template`, `cyan` for all `customer-<slug>`. Confirm with whoever owns the Sigma org's visual conventions.
4. **CI integration of the sync script.** Whether `npm run sync-tags` runs on merge-to-main (with secrets in CI) or only locally pre-deploy.
5. **Sigma org plan limits.** Confirm there is no per-org tag-count limit that would constrain customer count.

---

## 12. Rollout plan

| Milestone | Deliverable | Validation |
|---|---|---|
| M1 | Create the canonical embed workbook in Sigma. Capture its ID + URL into `SIGMA_CANONICAL_WORKBOOK_ID` / `SIGMA_CANONICAL_WORKBOOK_URL`. | `lib/embed.js`'s `CANONICAL` reads real values, not the placeholder strings. |
| M2 | Provision admin OAuth client credentials (`SIGMA_CLIENT_ID` / `SIGMA_CLIENT_SECRET`) with spec-push + tag scopes. | The Setup-tab banner reports "Live mode" instead of "Dry-run". |
| M3 | Verify the spec-push endpoint path by clicking **Sync customer tags from config** with one customer in `CUSTOMER_CONFIG`. Adjust `SIGMA_SPEC_ENDPOINT_PATH` / `SIGMA_SPEC_ENDPOINT_METHOD` if the default 404s. | A `customer-<slug>` tag appears in the canonical workbook's version history. |
| M4 | Click **Propagate template updates** to bootstrap the `template` tag + both demo customer tags from `CUSTOMER_CONFIG`. | All three tags visible. The embed endpoint hits each customer's tagged URL correctly. |
| M5 | Update `generateEmbedUrl` to append `/tag/<tagName>`; switch the `/api/embed-url` flow over to the canonical workbook URL. | Existing two customers render correctly from the tagged URLs. |
| M6 | Update `docs/about.md`: replace the `🔮 spec push` block with the version-tagging + script-driven description. | Docs match the implementation; the about page no longer claims spec composition is a deferred next step. |
| M7 | Decommission the two original pre-built customer workbooks. | Sigma file browser shows only the canonical workbook in the embed folder. |

---

## 13. Appendix: Sigma API endpoints used

| Use | Endpoint | Confirmed? |
|---|---|---|
| OAuth token for the sync script | `POST /v2/auth/token` | Confirmed public. |
| Push spec to the canonical workbook | `PUT /v2/workbooks/{workbookId}/spec` (default; overridable via env) | **Assumed.** Mirrors the data-model surface; not in the public OpenAPI. |
| Tag the published workbook version | `POST /v2/workbooks/tag` | Confirmed public. |

Tagged-URL embed format (no API call, URL-path composition only):
```
https://<org>.sigmacomputing.io/<slug>/workbook/<workbookName>-<workbookId>/tag/<tagName>
```
