# PRD: Programmatic per-customer embed workbooks via data-model version tagging

> **Status:** Proposed. Supersedes the "🔮 spec push" note in `docs/about.md:110`.
> **Owners:** Sigma embed POC.
> **Scope:** Production architecture for the customer-specific embed pattern currently demoed in `lib/embed.js`.

---

## 1. Summary

Today's POC composes a customer-specific workbook spec at request time in `buildSpec()` (`lib/embed.js:60`) and *returns it in the API response for illustration*, while the actual embed loads one of two pre-built workbooks selected by URL. The composed spec has no consumer. Onboarding a new customer requires a human in the Sigma UI hand-building a workbook and pasting its URL into `CUSTOMER_CONFIG`.

This PRD specifies the production path: a **single canonical embed workbook** that sources from a **single canonical data model**, with **per-customer tagged versions** of the data model carrying that customer's JSON-extraction columns. The embed URL targets a per-customer tag of the workbook; the workbook tag is bound at tag-time to the customer's data-model tag. Customer onboarding becomes a scripted, idempotent operation that runs against `CUSTOMER_CONFIG` with no human in Sigma's UI.

The pattern is concurrency-safe by construction (tagged versions are immutable snapshots), embed latency stays at one JWT-sign (no Sigma API calls in the request path), and Sigma's document count grows by **+1 workbook + 1 data model**, not "per customer" or "per request."

---

## 2. Goals and non-goals

### Goals

- Onboarding a new customer is a single script invocation against `CUSTOMER_CONFIG`. No Sigma UI work.
- Updating the shared base columns for *all* customers is a single script invocation. No Sigma UI work × N.
- Embed request path (`POST /api/embed-url`) makes zero Sigma API calls. Latency is bounded by one HMAC sign.
- Two concurrent embed requests from different customers cannot interfere with each other's view.
- Customer-specific column display names render as real labels in the Sigma UI (not parameterized placeholders).
- Sigma document count is **O(1)** in customer count, not O(N).

### Non-goals

- Per-row data isolation (row-level security). That is handled separately by Sigma row-level policies and is out of scope.
- Live editing of customer overlays through the embed app UI. Overlays are config-as-code in `CUSTOMER_CONFIG`.
- Migrating the existing two pre-built workbooks. Those are demo artifacts and will be replaced.
- Multi-region / multi-tenant Sigma org support. One Sigma org assumed.

---

## 3. Why this architecture (and why the obvious alternative does not work)

The naïve plan — "mutate the canonical workbook's spec on every embed request to reflect the viewer's customer" — fails for two reasons:

1. **Spec is shared state, not session state.** A workbook spec is the stored document definition. Concurrent mutation by two different tenant requests interleaves at the document level, so one tenant briefly observes the other's columns. There is no per-session scoping.
2. **The Sigma public REST API has no `setWorkbookSpec` endpoint.** Programmatic spec mutation exists for data models (`PUT /v2/dataModels/{id}/spec`) but not for workbooks. The composed JSON returned by `buildSpec()` cannot be pushed to a workbook through the documented public API.

Version tagging on its own solves problem #1 (tagged versions are immutable) but does not solve #2 for the workbook layer. The workaround is to **move the customer-specific overlay from workbook-column formulas into data-model column definitions**, because the data-model spec *is* programmatically mutable. The workbook stays thin and stable; the data model carries the per-customer variability.

---

## 4. Architecture

### 4.1 Sigma object inventory

Exactly two long-lived Sigma documents, plus tags:

| Object | Purpose | Tags |
|---|---|---|
| **Canonical data model** ("Embed — Plugs Electronics Model") | Defines base columns + the slot where customer-specific JSON extraction columns live. Single source of truth for the data shape. | `template`, plus `customer-<id>` per customer. |
| **Canonical workbook** ("Embed — Plugs Electronics") | Single thin workbook whose source is the canonical data model. Defines layout, page, and the table element. No customer-specific column formulas. | `template`, plus `customer-<id>` per customer. Each `customer-<id>` workbook tag is source-swapped at tag time to the matching `customer-<id>` data-model tag. |

### 4.2 Tag naming convention

- `template` — the clean starting state. **Never embedded.** Used as the input for the regen script and as the canonical reference an operator edits when making shared-base changes.
- `customer-<slug>` — one per customer. `<slug>` is the lowercased, dash-separated form of the customer ID in `CUSTOMER_CONFIG` (e.g. `customer-customer-a`, `customer-acme-co`). Stored verbatim in `CUSTOMER_CONFIG[customerId].tagName`.

Both tags exist on **both** the workbook and the data model. The regen script keeps the workbook tag's `dataModelSourceTaggedVersions` binding pointed at the matching data-model tag.

### 4.3 Embed request path

The signed embed URL is constructed by appending `/tag/<encodedTagName>` to the canonical workbook URL before the JWT is signed:

```
https://<org>.sigmacomputing.io/<slug>/workbook/<workbookName>-<workbookId>/tag/<tagName>?:jwt=<token>&:embed=true
```

This is a documented Sigma feature (see "Link to a tagged version of a document" in the Sigma version-tagging guide). It requires **no new JWT claim**. The change to `generateEmbedUrl` (`lib/embed.js:89`) is a single line of URL composition.

### 4.4 Operator workflow

There are three operator actions, all driven by the regen script:

1. **Update the shared base** — operator edits the `template` tag in the Sigma UI (or, equivalently, edits the data-model spec checked into the repo), then runs the regen script. The script propagates the new base to every `customer-<id>` tag.
2. **Onboard a new customer** — operator adds an entry to `CUSTOMER_CONFIG` and runs the regen script. The script creates the `customer-<id>` data-model tag with that customer's column additions, then tags the workbook against it.
3. **Update a single customer's columns** — operator edits `CUSTOMER_CONFIG[customerId].dataModelColumns` and runs the regen script. The script re-tags just that customer.

---

## 5. Detailed design

### 5.1 Data-model spec shape

Each customer's data-model tag holds a spec composed of:

- The base column set (shared, defined once in `BASE_DATA_MODEL_COLUMNS` in `lib/embed.js`):
  - `ORDER_NUMBER` ← `[Cust Json/Order Number]`
  - `SKU_NUMBER` ← `[Cust Json/Sku Number]`
  - `CUST_JSON` ← `[Cust Json/Cust Json]`
- Zero or more customer-specific columns appended after the base, defined per customer in `CUSTOMER_CONFIG[customerId].dataModelColumns`. Each has a real display name (`AGE_GROUP`, `Birthday`) and a formula extracting from `[CUST_JSON]`.

The exact format of the data-model "code representation" used by `PUT /v2/dataModels/{id}/spec` is the [Sigma data model code representation](https://help.sigmacomputing.com/sigma-computing/reference/getdatamodelspec) format. **Implementation note:** confirm the field names by `GET`-ing the existing canonical data model's spec once, then build the merge logic against that shape. Do not hand-roll the JSON from the OpenAPI schema alone — the API doc describes structure but the published examples are the ground truth for field-level keys.

### 5.2 Workbook tagging with source binding

Per-customer workbook tags are created via `POST /v2/workbooks/tag` with `dataModelSourceTaggedVersions` set to bind the workbook tag to the corresponding data-model tag. Request body shape:

```json
{
  "workbookId": "<canonical workbook id>",
  "tag": "customer-<slug>",
  "dataModelSourceTaggedVersions": [
    {
      "dataModelId": "<canonical data model id>",
      "fromVersionTagId": "<template data-model versionTagId or null>",
      "toVersionTagId": "<customer-<slug> data-model versionTagId>"
    }
  ],
  "isDefault": false
}
```

The response includes `versionTagId`, `taggedWorkbookId`, `taggedWorkbookVersion`, which the script logs but does not need to persist (the tag name is the lookup key, not the ID).

### 5.3 `CUSTOMER_CONFIG` shape change

Today (`lib/embed.js:41`):

```js
'Customer A': {
  workbookId: '5666ff98-...',
  workbookUrl: 'https://...',
  extraColumns: [
    { id: 'syaasfXKHZ', formula: 'Text([Cust Json].AGE_GROUP)', name: 'AGE_GROUP' },
  ],
},
```

Post-PRD shape:

```js
'Customer A': {
  tagName: 'customer-customer-a',
  dataModelColumns: [
    { name: 'AGE_GROUP', formula: '[CUST_JSON].AGE_GROUP' },
  ],
},
```

`workbookId` and `workbookUrl` move out of per-customer entries into a single module-level `CANONICAL` constant:

```js
const CANONICAL = {
  workbookId: '<single canonical workbook id>',
  workbookUrl: 'https://staging.sigmacomputing.io/<slug>/workbook/Embed-Plugs-Electronics-<id>',
  dataModelId: '<single canonical data model id>',
};
```

### 5.4 `buildSpec()` becomes `buildDataModelSpec(customer)`

The function changes:
- Inputs: customer key.
- Output: a data-model code-representation JSON suitable for `PUT /v2/dataModels/{id}/spec` (base columns + customer columns).
- Consumer: the regen script (not the request path).

It is **removed from the request path** of `/api/embed-url`. `handleEmbedRequest` (`lib/embed.js:110`) becomes a tag-lookup + URL-concatenation + JWT-sign with no spec composition.

### 5.5 `generateEmbedUrl` modification

Single change at `lib/embed.js:107`:

```js
const taggedUrl = `${workbookUrl}/tag/${encodeURIComponent(tagName)}`;
return `${taggedUrl}?:jwt=${encodeURIComponent(token)}&:embed=true`;
```

Pass `tagName` through from `handleEmbedRequest` to `generateEmbedUrl`.

### 5.6 New file: `scripts/regen-customer-tags.js`

A standalone Node script. Reads `CUSTOMER_CONFIG`, authenticates against the Sigma REST API via OAuth client credentials (separate from the embed signing secret), and reconciles Sigma state to match config. Key properties:

- **Idempotent.** Running it twice in a row makes no API calls on the second run if nothing changed.
- **Diffable.** Logs every action taken before performing it; a `--dry-run` flag is required to be supported.
- **Customer-scoped.** Accepts an optional `--customer <id>` filter to limit work to a single customer.
- **Source-of-truth-driven.** `CUSTOMER_CONFIG` is the input. Sigma state is reconciled to match. The script never reads Sigma state to *populate* config — only to compare.

Authentication: uses `SIGMA_CLIENT_ID` and `SIGMA_CLIENT_SECRET` environment variables (a separate OAuth client from the embed signing secret) to call `POST /v2/auth/token` and obtain a bearer token. These credentials are admin-scoped — they must never appear in any browser-facing surface and are not the same as the JWT-signing embed secret used by `/api/embed-url`.

### 5.7 Regen script algorithm

For each customer in `CUSTOMER_CONFIG`:

1. **Resolve current state.** `GET /v2/workbooks/{workbookId}/tags` and `GET /v2/dataModels/{dataModelId}/tags` to find existing `customer-<slug>` tags and their `versionTagId`s. `GET /v2/tags` to verify the tag-name registry.
2. **Ensure the version tag exists.** If `customer-<slug>` is not in the tag registry, `POST /v2/tags` to create it with a color (deterministically chosen from the slug hash so reruns are stable).
3. **Update the data-model `template` draft.** `PUT /v2/dataModels/{id}/spec` with the spec built by `buildDataModelSpec(customerId)`. Publish.
4. **Apply the data-model tag.** `POST /v2/dataModels/tag` to apply `customer-<slug>` to the just-published version.
5. **Apply the workbook tag with source binding.** `POST /v2/workbooks/tag` with `dataModelSourceTaggedVersions` pointing to the data-model tag from step 4.
6. **Reconcile orphans.** If a `customer-<slug>` tag exists in Sigma but the slug is not in `CUSTOMER_CONFIG`, log a warning but do not delete (deletion is opt-in via a separate `--prune` flag).

Step 3 mutates the canonical data model's draft state in place. This means concurrent runs of the regen script would race on the draft. The script must take an org-level advisory lock (a sentinel file in the repo or a lock row in a control table) before step 3. Document this in the runbook.

### 5.8 `template` tag handling

The `template` tag on both the workbook and the data model is **never embedded** and **never overwritten by the regen script**. It is the operator's working surface. To update the shared base:

1. Operator edits the `template` data-model tag's contents (either via the Sigma UI on a draft, then re-tagging, or by editing `BASE_DATA_MODEL_COLUMNS` in `lib/embed.js` and running the script with `--update-template`).
2. The regen script picks up the new base and propagates it to every `customer-<slug>` tag.

### 5.9 Concurrency and consistency properties

- **Embed request → embed request:** no shared mutable state. Each request reads from immutable tagged versions. Safe.
- **Embed request → regen script:** the regen script publishes new tags but does not remove old ones. An embed request in flight when the script updates `customer-<slug>` sees either the pre-update tag or the post-update tag, never a partial state.
- **Regen script → regen script:** races on the canonical data-model draft. Mitigated by an advisory lock (see 5.7).

### 5.10 Performance

| Stage | Today | Post-PRD |
|---|---|---|
| `/api/embed-url` p50 | One HMAC sign (~1 ms) | One HMAC sign (~1 ms) |
| `/api/embed-url` p99 | Same | Same |
| Sigma API calls in request path | 0 | 0 |
| Onboarding a new customer | Manual workbook build (~minutes) | One script run (~seconds per customer) |

No change in request-path latency; the entire shift is in the build/onboarding pipeline.

---

## 6. Code changes (file by file)

### `lib/embed.js`
- Replace `BASE_SOURCE` + `BASE_COLUMNS` with `BASE_DATA_MODEL_COLUMNS` keyed in the data-model code-representation format.
- Replace `CUSTOMER_CONFIG[*].extraColumns` with `CUSTOMER_CONFIG[*].dataModelColumns` and `CUSTOMER_CONFIG[*].tagName`.
- Remove `CUSTOMER_CONFIG[*].workbookId` and `.workbookUrl`. Introduce module-level `CANONICAL = { workbookId, workbookUrl, dataModelId }`.
- Rename `buildSpec` → `buildDataModelSpec`. Move it out of the request path; it's now only used by the regen script.
- Update `generateEmbedUrl` to accept and append `tagName` (single-line change at the URL composition point).
- Update `handleEmbedRequest` to look up `tagName` from `CUSTOMER_CONFIG` and pass it to `generateEmbedUrl`. Stop returning the composed spec in the API response (it has no consumer at request time).

### `scripts/regen-customer-tags.js` (new)
- OAuth client-credentials auth against `POST /v2/auth/token`.
- Implements the algorithm in §5.7.
- Flags: `--dry-run`, `--customer <id>`, `--update-template`, `--prune`.
- Exits non-zero on any failed API call; logs structured JSON to stdout for CI capture.

### `package.json`
- Add `node-fetch` (or use the built-in `fetch` if the runtime is Node ≥18; confirm before adding the dep).
- Add a `regen-tags` npm script: `"regen-tags": "node scripts/regen-customer-tags.js"`.

### `docs/about.md`
- Replace the `🔮` block at line 110 with a one-paragraph summary and a link to this PRD.

### `public/index.html`
- Remove the live "composed spec" preview pane. The composed spec is no longer part of the request response and the preview is misleading post-PRD. Keep the customer selector and iframe.

### `netlify/functions/embed-url.js`, `server.js`
- No changes required. They are thin wrappers around `handleEmbedRequest`.

---

## 7. Operational runbook

### Onboarding a new customer

1. Add an entry to `CUSTOMER_CONFIG` in `lib/embed.js` with `tagName` and `dataModelColumns`.
2. `npm run regen-tags -- --customer <id> --dry-run` — review the planned API calls.
3. `npm run regen-tags -- --customer <id>` — execute.
4. Verify via the embed app: load the customer in the dropdown, confirm the new columns appear.

### Updating shared base columns

1. Edit `BASE_DATA_MODEL_COLUMNS` in `lib/embed.js`.
2. `npm run regen-tags -- --dry-run` — review the planned API calls (one per customer tag).
3. `npm run regen-tags -- --update-template` — execute, including the `template` tag update.
4. Verify via the embed app for each customer.

### Updating a single customer's columns

Same as onboarding, but for an existing customer.

### Rolling back a bad tag

Tagged versions are not destroyed by re-tagging — the previous version remains in the workbook's version history. To roll back: in the Sigma UI, restore the prior tagged version as draft, publish, re-tag.

---

## 8. Failure modes and error handling

| Failure | Detection | Handling |
|---|---|---|
| Sigma auth token expired mid-script | 401 from a step-N call | Refresh token, retry once, then fail loudly. |
| Tag name conflict (someone else applied the tag) | 409 from `POST /v2/workbooks/tag` | Fail the script with a message naming the conflicting tag and the operator who applied it. Do not auto-resolve. |
| Data-model draft has uncommitted edits from a human | Detected via `GET /v2/dataModels/{id}` showing a draft state | Fail with a message telling the operator to publish or discard the draft first. Do not overwrite a human's work. |
| Embed URL targets a `customer-<slug>` tag that no longer exists | Sigma returns an error page in the iframe | The embed-url endpoint pre-validates: on startup, fetch tag list once and warn on any `CUSTOMER_CONFIG` entry whose `tagName` is not present. |
| Regen script killed mid-run | Sigma is in a partially reconciled state | The script is idempotent; re-running completes the work. No corruption is possible because each step is its own atomic API call. |

---

## 9. Security

- **Embed signing secret** (current `secret` parameter in `handleEmbedRequest`): unchanged. Continues to live in server-side env vars only.
- **Sigma admin client credentials** (new, `SIGMA_CLIENT_ID` / `SIGMA_CLIENT_SECRET`): used only by the regen script. **Never** loaded by the embed-url Lambda/Express handler. Stored in CI secret store; rotation runbook documented separately.
- **Tag name as identifier**: tag names are user-visible in Sigma. Use `customer-<slug>` not `customer-<email>` or anything PII-bearing.
- **Iframe isolation**: unchanged from POC. Each customer's iframe is its own JWT-scoped session; the JWT pins to the tagged URL.

---

## 10. Open questions

These need confirmation before implementation, but do not change the architectural shape:

1. **Data-model spec format.** The exact JSON shape for `PUT /v2/dataModels/{id}/spec` should be confirmed by `GET`-ing an existing data-model spec and pattern-matching the column-definition keys, not by hand-rolling from the OpenAPI. **Owner action:** capture one real data-model spec and check it into `docs/examples/`.
2. **Formula reference syntax inside a data model.** The current POC uses `Text([Cust Json].AGE_GROUP)` as a workbook-column formula. Inside a data-model column definition, the reference syntax may differ. Confirm by reading the captured example spec.
3. **OAuth scope for the regen client.** Confirm the minimum scope set needed for `PUT /v2/dataModels/{id}/spec`, `POST /v2/dataModels/tag`, and `POST /v2/workbooks/tag`. Avoid granting org-admin if a narrower scope works.
4. **Sigma org plan limits.** Confirm there is no per-org limit on tag count that would constrain customer count.

---

## 11. Rollout plan

| Milestone | Deliverable | Validation |
|---|---|---|
| M1 | Capture canonical data-model spec from a Sigma sandbox; check into `docs/examples/`. | Spec parses; column shape is documented. |
| M2 | Refactor `lib/embed.js` to the new shape (CANONICAL, dataModelColumns, tagName). Wire `/api/embed-url` to append `/tag/<tagName>`. | Existing two customers still render correctly using manually-created `customer-<slug>` tags. |
| M3 | Build `scripts/regen-customer-tags.js`. Cover `--dry-run` and `--customer <id>` first. | Dry-run output matches the manual tag operations from M2. |
| M4 | Bulk-customer onboarding via the script. Remove the manually-created tags from M2 and recreate them via the script. | Embeds for both customers still work end-to-end. |
| M5 | Remove the live spec preview from `public/index.html`. Replace the `🔮` block in `docs/about.md`. | UI no longer claims spec push is illustrative; PRD link is live. |

---

## 12. Appendix: Sigma API endpoints used

All endpoints are on the Sigma public REST API (`/v2/...`).

| Use | Endpoint |
|---|---|
| OAuth token (regen script auth) | `POST /v2/auth/token` |
| Get data-model spec (M1, debugging) | `GET /v2/dataModels/{dataModelId}/spec` |
| Update data-model spec (regen script, step 3) | `PUT /v2/dataModels/{dataModelId}/spec` |
| Tag a data-model version (regen script, step 4) | `POST /v2/dataModels/tag` |
| Tag a workbook version with source binding (regen script, step 5) | `POST /v2/workbooks/tag` (with `dataModelSourceTaggedVersions`) |
| Create a version tag in the registry (regen script, step 2) | `POST /v2/tags` |
| List tags on a workbook (regen script, step 1) | `GET /v2/workbooks/{workbookId}/tags` |
| List tags on a data model (regen script, step 1) | `GET /v2/dataModels/{dataModelId}/tags` |
| List tag registry (regen script, step 1) | `GET /v2/tags` |

Tagged-URL embed format (no API call, URL-path composition only):
```
https://<org>.sigmacomputing.io/<slug>/workbook/<workbookName>-<workbookId>/tag/<tagName>
```
