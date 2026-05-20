# PRD: Per-customer embed via workbook version tagging

> **Status:** Proposed. Supersedes the "🔮 spec push" note in `docs/about.md:110`.
> **Owners:** Sigma embed POC.
> **Scope:** Production architecture for the customer-specific embed pattern currently demoed in `lib/embed.js`.

---

## 1. Summary

Today's POC composes a customer-specific workbook spec at request time in `buildSpec()` (`lib/embed.js:60`) and returns it in the API response for illustration, while the actual embed loads one of two **pre-built workbooks** selected by URL. The composed spec has no real consumer. Each customer is its own Sigma document, and onboarding a new customer means duplicating a workbook in the Sigma UI and pasting a new URL into `CUSTOMER_CONFIG`.

This PRD specifies the production path: **one canonical embed workbook** with **per-customer tagged versions**. Each customer's tag is a frozen, immutable snapshot of the canonical workbook with that customer's JSON-extraction columns added on top. The embed URL targets the customer's tag by appending `/tag/<tagName>` to the canonical workbook URL before the JWT is signed.

Customer-specific workbook edits are performed **by hand in the Sigma UI** (open the `template` tag, restore as draft, add the customer's columns, publish, apply `customer-<slug>` tag). The application code only maintains the mapping from customer ID to tag name and signs the URL. There is no programmatic spec push — see §3.

This pattern is concurrency-safe by construction (tags are immutable), keeps embed latency at one HMAC sign, and reduces Sigma's document footprint from "one per customer" to "one for the embed, plus N tagged versions of it."

---

## 2. Goals and non-goals

### Goals

- One canonical workbook in Sigma, with N tagged versions that don't appear as separate documents in the file browser.
- Customer-specific column display names render as real labels in the Sigma UI (not parameterized placeholders).
- Embed request path makes zero Sigma API calls. Latency is bounded by one HMAC sign.
- Two concurrent embed requests from different customers cannot interfere with each other's view.
- Adding a new customer is a documented, repeatable Sigma-UI procedure that takes a few minutes and requires no code change beyond a `CUSTOMER_CONFIG` entry.

### Non-goals

- **Automated provisioning of customer column formulas.** The Sigma public REST API does not expose programmatic mutation of a workbook spec (see §3), so this PRD does not attempt it. Operator does the customization step in the Sigma UI.
- Live editing of customer overlays through the embed app UI. Overlays live in Sigma workbook tags.
- Multi-region / multi-tenant Sigma org support. One Sigma org assumed.
- Migrating the existing two pre-built workbooks. They are demo artifacts and will be replaced by a single canonical workbook with two tagged versions.

---

## 3. Why workbook-only (and what we are explicitly not doing)

The naïve plan — "mutate the canonical workbook's spec on every embed request" — fails for two reasons:

1. **A workbook spec is shared state.** Concurrent mutation by two tenant requests would interleave at the document level, so one tenant could briefly observe another's columns. There is no per-session scoping.
2. **The Sigma public REST API has no `setWorkbookSpec` endpoint.** Workbook-side programmatic surface is limited to create (`POST /v2/workbooks`), copy (`POST /v2/workbooks/{id}/copy`, `POST /v2/workbooks/{id}/tag/{versionTag}/copy`), template-save / template-instantiate, and tag (`POST /v2/workbooks/tag`). None of those let you push a new column formula into an existing workbook.

Version tagging solves problem 1 (tagged versions are immutable). For problem 2, we accept that the customer's column edits are an operator action performed in the Sigma UI, and we **do not invest in a regen script that tries to push spec changes through the public API** — the API surface does not support it. The composed JSON produced by today's `buildSpec()` therefore has no production consumer and is removed.

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

Two operator actions, both performed in the Sigma UI:

1. **Onboarding a new customer.** Operator opens the canonical workbook, navigates to Versions → Version history → restores `template` as a draft, adds the customer's JSON-extraction columns (e.g. `Text([Cust Json].AGE_GROUP)` named `AGE_GROUP`), publishes, then applies the `customer-<slug>` tag. They then add a `CUSTOMER_CONFIG` entry with that `tagName` and deploy the app.
2. **Updating shared base columns.** Operator edits the `template` tag, then for each existing `customer-<slug>` tag: restores that tag as draft, applies the same base change, re-applies the tag. This is the O(N) operation that scales with customer count and is the explicit cost of the simple approach.

The version-tag UI steps (restore-as-draft, publish, set-tag) are documented in Sigma's [Add version tags to workbooks](https://help.sigmacomputing.com/sigma-computing/docs/add-version-tags-to-workbooks-and-data-models) guide; the runbook in §7 links operators directly to that page.

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
},
```

The shared workbook ID and URL move into a single module-level `CANONICAL` constant:

```js
const CANONICAL = {
  workbookId: '<single canonical workbook id>',
  workbookUrl: 'https://staging.sigmacomputing.io/<slug>/workbook/Embed-Plugs-Electronics-<id>',
};
```

The per-customer entry has exactly one field that the app code consumes (`tagName`). Anything else operators want to track (e.g. which JSON keys this customer uses, who owns the account) can live in the same object as documentation, but the app does not read it.

### 5.2 Removed: `buildSpec()` and the spec preview UI

`buildSpec()` (`lib/embed.js:60`) has no production consumer in this architecture and is removed. `BASE_COLUMNS`, `BASE_SOURCE`, `PAGE_ID`, `ELEMENT_ID`, and `LAYOUT` (`lib/embed.js:11-39`) are also removed — they encoded a workbook structure that the app never pushes anywhere, and the source of truth for that structure is now the canonical workbook in Sigma itself.

The live spec preview pane in `public/index.html` is removed for the same reason. Keeping it would imply the app composes a spec that gets applied somewhere, which is misleading post-PRD.

### 5.3 `generateEmbedUrl` modification

Single change at the URL-composition point in `lib/embed.js:107`:

```js
const taggedUrl = `${workbookUrl}/tag/${encodeURIComponent(tagName)}`;
return `${taggedUrl}?:jwt=${encodeURIComponent(token)}&:embed=true`;
```

Pass `tagName` through from `handleEmbedRequest` to `generateEmbedUrl`. `handleEmbedRequest` (`lib/embed.js:110`) becomes a tag-lookup + URL-concatenation + JWT-sign, with no spec composition and no `spec` field in the response body.

### 5.4 Validation script (lightweight, optional but recommended)

A small script — `scripts/validate-customer-tags.js` — that on demand:

- Authenticates against the Sigma REST API via OAuth client credentials.
- Calls `GET /v2/workbooks/{CANONICAL.workbookId}/tags`.
- Confirms every `tagName` referenced in `CUSTOMER_CONFIG` exists in the response.
- Warns on orphan `customer-<slug>` tags that exist in Sigma but are not referenced by any `CUSTOMER_CONFIG` entry.

This is not a regen script — it pushes no spec changes and creates no tags. It is purely a CI-friendly check that the config and Sigma are in sync. Failure exits non-zero so it can be wired into a deploy gate.

Authentication uses `SIGMA_CLIENT_ID` / `SIGMA_CLIENT_SECRET` env vars, a **separate** OAuth client from the embed signing secret. These admin credentials are never loaded by the embed-url handler.

### 5.5 Concurrency and consistency properties

- **Embed request → embed request:** no shared mutable state. Each request reads from an immutable tagged version. Safe.
- **Embed request → operator editing in Sigma UI:** when an operator restores a tagged version as draft and re-tags it, the prior tagged version remains in version history and the new content takes the tag name atomically at tag-time. An embed request in flight during this transition sees either the pre-edit content or the post-edit content, never a partial state.

### 5.6 Performance

| Stage | Today | Post-PRD |
|---|---|---|
| `/api/embed-url` p50 | One HMAC sign (~1 ms) | One HMAC sign (~1 ms) |
| Sigma API calls in request path | 0 | 0 |
| Onboarding a new customer | Manual workbook build, paste URL into config | Manual workbook tag in Sigma UI, paste tag name into config |

No change in request-path latency.

---

## 6. Code changes (file by file)

### `lib/embed.js`
- Delete `BASE_SOURCE`, `BASE_COLUMNS`, `PAGE_ID`, `ELEMENT_ID`, `LAYOUT`. None are consumed.
- Replace `CUSTOMER_CONFIG[*].workbookId / workbookUrl / extraColumns` with `CUSTOMER_CONFIG[*].tagName`.
- Add module-level `CANONICAL = { workbookId, workbookUrl }`.
- Delete `buildSpec`.
- Update `generateEmbedUrl` to accept and append `tagName`.
- Update `handleEmbedRequest` to look up `tagName` and pass it through. Remove the `spec` field from the response body.

### `scripts/validate-customer-tags.js` (new, small)
- OAuth client-credentials auth against `POST /v2/auth/token`.
- `GET /v2/workbooks/{workbookId}/tags`.
- Diff against `CUSTOMER_CONFIG` tag names. Exit non-zero on missing tags.

### `package.json`
- Add a `validate-tags` npm script: `"validate-tags": "node scripts/validate-customer-tags.js"`.

### `public/index.html`
- Remove the live composed-spec preview pane. Keep the customer selector, credential form (for the POC), and the iframe.

### `docs/about.md`
- Replace the `🔮 spec push` block at line 110 with a one-paragraph summary of the version-tagging approach and a link to this PRD. Update the "Current limitations" and "Spec composition" sections to match: the demo no longer claims spec composition is a deferred production step — it is replaced by tag-based provisioning.

### `netlify/functions/embed-url.js`, `server.js`
- No changes. They are thin wrappers around `handleEmbedRequest`.

---

## 7. Operational runbook

### Onboarding a new customer

1. In the Sigma UI, open the canonical embed workbook.
2. Document menu → Versions → Version history. Locate the `template` tag.
3. More menu on the `template` row → **Restore version as draft**.
4. In the draft, add the customer's JSON-extraction column(s). Use `Text([Cust Json].YOUR_KEY)` or the appropriate path syntax for nested JSON.
5. Publish the draft.
6. Document menu → Versions → **Tag this version**. Choose or create the `customer-<slug>` tag (color is up to operator preference but should be consistent across customers).
7. In `lib/embed.js`, add to `CUSTOMER_CONFIG`:
   ```js
   'New Customer Name': { tagName: 'customer-<slug>' },
   ```
8. `npm run validate-tags` to confirm the new tag is visible to the API.
9. Deploy.

### Updating shared base columns

1. In the Sigma UI, restore the `template` tag as draft, apply the base change, publish, re-apply the `template` tag to the new version.
2. **For each existing customer:** restore the `customer-<slug>` tag as draft, apply the same base change (or merge from the new `template`), publish, re-apply the `customer-<slug>` tag.
3. `npm run validate-tags`. No code change required.

This step 2 is O(N) in customer count and is the explicit operational cost of the simple approach. If customer count grows past the point where this is comfortable, see §8.

### Removing a customer

1. In the Sigma UI, remove the `customer-<slug>` tag from its version (Document menu → Versions → Version history → More → Remove this tag). Note Sigma's warning: any user with access only to the tagged version loses access.
2. Delete the entry from `CUSTOMER_CONFIG`.
3. `npm run validate-tags` to confirm no orphans remain (or accept that the orphan is intentional and acknowledged).

---

## 8. When to outgrow this pattern

This PRD optimizes for **simplicity and operator-driven onboarding**. It is the right choice when:

- Customer count is small to moderate (low tens) and growing slowly.
- Customer-specific column logic is straightforward — JSON path extractions, simple casts.
- Operators are comfortable in the Sigma UI and shared-base changes are infrequent.

It is **not** the right choice when:

- Customer count grows fast enough that the O(N) re-tag operation for base changes becomes a real burden.
- Customer-specific logic grows complex (multiple data sources, materialized intermediates, cross-table joins).
- You need customer onboarding to be fully scripted — e.g. from a CI pipeline or a self-service signup flow.

In those cases, lift the customer-specific column logic out of the workbook and into a **Sigma data model**. Data models have a `PUT /v2/dataModels/{id}/spec` endpoint that does support programmatic spec mutation. The pattern is: one canonical data model with tagged versions per customer (programmatically maintained), and the canonical workbook's per-customer tags use `dataModelSourceTaggedVersions` (a parameter on `POST /v2/workbooks/tag`) to bind each workbook tag to the customer's data-model tag. The request path stays a single HMAC sign and a tag-URL append; the regen script becomes fully automated end-to-end. This is the natural extension of this PRD, but the additional moving piece (data model) is only worth introducing once the simple approach starts to hurt.

---

## 9. Failure modes and error handling

| Failure | Detection | Handling |
|---|---|---|
| Embed URL targets a tag that no longer exists | Sigma returns an error page in the iframe | `validate-customer-tags.js` catches this in CI before deploy. If it slips through, the iframe error is visible to the user and operator fixes the tag or the config. |
| Operator forgets to apply the tag after publishing | Same as above | Same as above. |
| Operator forgets to update `CUSTOMER_CONFIG` after tagging | New customer simply not selectable in the app | UI shows only customers from `CUSTOMER_CONFIG`. No silent breakage. |
| Two operators edit the workbook concurrently | Sigma's draft model enforces single-draft state | Sigma surfaces the conflict in its UI; not the app's problem. |
| Tag name conflict (someone reused a slug) | `POST /v2/workbooks/tag` returns 409 from the Sigma UI | Sigma rejects the operation and the operator chooses a different slug. |

---

## 10. Security

- **Embed signing secret** (current `secret` parameter in `handleEmbedRequest`): unchanged. Continues to live in server-side env vars only.
- **Sigma admin client credentials** (new, `SIGMA_CLIENT_ID` / `SIGMA_CLIENT_SECRET`): used only by `validate-customer-tags.js`. **Never** loaded by the embed-url handler. Scope: read-only access to tag and workbook metadata — `validate-customer-tags.js` does not need write scope.
- **Tag name as identifier**: tag names are user-visible in Sigma. Use `customer-<slug>` derived from a non-PII customer ID, not from customer email addresses or anything else PII-bearing.

---

## 11. Open questions

1. **Naming the canonical workbook in Sigma.** Pick once; this becomes the URL in `CANONICAL.workbookUrl` and changes are URL-breaking.
2. **Tag color convention.** Sigma offers six tag colors. Suggested: `bronze` for `template`, `cyan` for all `customer-<slug>`. Confirm with whoever owns the Sigma org's visual conventions.
3. **CI integration of the validation script.** Whether `npm run validate-tags` runs in PR checks (requires Sigma client creds in CI) or only locally pre-deploy.
4. **Sigma org plan limits.** Confirm there is no per-org tag-count limit that would constrain customer count.

---

## 12. Rollout plan

| Milestone | Deliverable | Validation |
|---|---|---|
| M1 | Create the canonical embed workbook in Sigma. Apply the `template` tag. Manually create `customer-customer-a` and `customer-customer-b` tags with the existing per-customer columns. | Both tags visible in Versions → Version history. |
| M2 | Refactor `lib/embed.js`: introduce `CANONICAL`, slim `CUSTOMER_CONFIG`, delete `buildSpec` and friends, update `generateEmbedUrl` to append `/tag/<tagName>`. Update `public/index.html` to remove the spec preview. | Existing two customers render correctly from the new tags. POC behavior is unchanged from the user's perspective. |
| M3 | Add `scripts/validate-customer-tags.js`. Wire `npm run validate-tags` into the deploy procedure. | Script passes against M1 state; intentionally breaks if a `CUSTOMER_CONFIG` entry points to a non-existent tag. |
| M4 | Update `docs/about.md`: replace the `🔮 spec push` block and the now-stale "spec composition" framing with the version-tagging description. | Docs match the implementation; the about page no longer claims spec composition is a deferred next step. |
| M5 | Decommission the two original pre-built customer workbooks (manual cleanup in Sigma). | Sigma file browser shows only the canonical workbook in the embed folder. |

---

## 13. Appendix: Sigma API endpoints used

All endpoints are on the Sigma public REST API (`/v2/...`).

| Use | Endpoint |
|---|---|
| OAuth token (validation script auth) | `POST /v2/auth/token` |
| List tags on the canonical workbook (validation script) | `GET /v2/workbooks/{workbookId}/tags` |

Tagged-URL embed format (no API call, URL-path composition only):
```
https://<org>.sigmacomputing.io/<slug>/workbook/<workbookName>-<workbookId>/tag/<tagName>
```

Tag creation, application, and removal are performed by the operator **in the Sigma UI**, not through the REST API. The REST endpoints for those operations (`POST /v2/workbooks/tag`, `DELETE /v2/workbooks/{workbookId}/tags/{tagId}`) exist and could be wired into automation later, but they are out of scope for this PRD.
