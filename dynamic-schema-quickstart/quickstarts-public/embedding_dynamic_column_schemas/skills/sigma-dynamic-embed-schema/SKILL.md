---
name: sigma-dynamic-embed-schema
description: >-
  Generate a per-tenant Sigma workbook for embedded multi-tenant reporting when
  each tenant's table has a different set of columns. Use whenever the user
  wants one embedded report to serve many customers/tenants with variable
  column names and counts, needs to build a "spine + dynamic columns" data
  model or workbook with Sigma code representation, must enumerate a tenant's
  columns from a warehouse and emit a data model / workbook spec, wants to
  retarget filter controls per tenant, rename generic columns with Sigma
  localization, or decide between code representation, localization, and
  version-tag source-swap for per-tenant schemas.
---

# Sigma dynamic embed schema

Generate and embed a per-tenant Sigma workbook when tenants share a report but
differ in their columns. This skill encodes the "spine + dynamic columns"
pattern from the *Embedding Dynamic Column Schemas for Multi-Tenant Workbooks*
QuickStart.

## When to use this skill

Trigger on requests like "serve one embedded workbook to many customers with
different columns", "the pivot columns differ per client", "generate a workbook
per tenant", "each tenant names its GL codes / questions / dimensions
differently", or "our transpose leaks one customer's columns into another after
a source swap".

## Core model: spine + dynamic columns

Split every tenant's schema into two parts and never conflate them:

- **Spine columns** — fixed for every tenant. Join keys, dates, totals, and any
  column that formulas, filters, or downstream elements depend on. Modeled once.
- **Dynamic columns** — client-specific, varying in **name and count** per
  tenant. Supplied per tenant, never hardcoded at build time.

## Decision: which approach

1. **Code representation (preferred)** — generate the tenant's data model and
   workbook from its real column list. Use when column names/counts are
   open-ended. Data Models as Code is GA; workbook code representation is beta.
2. **Localization** — model a fixed set of generic slot columns once, rename
   them per tenant with translation files + the `:lng` URL parameter. Use when
   there is a known *maximum* column count.
3. **Version tag + source swap** — only for a small, stable set of look-alike
   tenants. Do **not** recommend it for variable schemas: it does not carry a
   variable column list, cannot swap across multiple data sources, does not
   update custom-SQL elements, and requires matching connection types.

Most production setups combine 1 and 2.

## Procedure (code representation)

1. **Confirm credentials are server-side.** Read the Sigma API token/OAuth
   client and the embed secret from environment variables. Never inline secrets
   into specs, logs, chat, or the browser.
2. **Discover the tenant's columns.** Query the warehouse for this tenant's
   column set, e.g. `SELECT DISTINCT question_key FROM <wide_table> WHERE
   tenant = :tenant ORDER BY question_key`. Use a deterministic order.
3. **Assemble the column list = spine + dynamic.** Start from the constant spine
   column ids; append the tenant's discovered columns.
4. **Emit the spec.** Build the data model (and workbook) spec. A table element
   has a `columns` map and an `order` array. Warehouse columns are keyed by
   `inode-<hash>/COLUMN_NAME` with a `formula` of `[table/column]`; calculated
   columns use a short id plus `formula` and display `name`. **List every column
   explicitly — there is no wildcard.** Any column absent from the spec is absent
   from the element.
5. **Create or update via REST.** Use the Data Models as Code endpoints
   (`getdatamodelspec` / `createdatamodelspec`) for the model. For the workbook
   itself, use the beta workbook code-representation endpoints obtained through
   the Sigma beta program; verify their exact request/response shapes against
   the current beta materials rather than assuming.
6. **Retarget filter controls** if a control's source column differs per tenant:
   rewrite the control's `columnId` in both its filter target and its value
   `source`. A control element is `"kind": "control"`.
7. **Embed.** Sign the embed JWT server-side (see the sigma-embed skill or the
   Getting Started with Embedding QuickStart) and return the embed URL for the
   generated workbook.

See `reference/spec-shapes.md` for concrete JSON, `reference/localization.md`
for the Approach B recipe, and `scripts/generate-tenant-spec.js` for a runnable
starting point.

## Critical gotchas

- **No wildcard columns.** Re-discover and re-enumerate the tenant's columns on
  every generation; new warehouse columns will not appear on their own.
- **Never "transpose then source-swap" for variable schemas.** Native transpose
  hardcodes columns at creation; the original tenant's columns leak after a
  swap. Generate per tenant instead.
- **Localization renames, it does not add/remove.** Size the slot count for the
  largest tenant. Custom views cannot be translated; translations apply on
  view/explore, not while editing.
- **Secrets stay server-side.** Embed secret and API credentials are environment
  variables only.

## Reference index

| File | Contents |
| --- | --- |
| `reference/spec-shapes.md` | Data model column/order JSON, control retargeting JSON, field notes. |
| `reference/localization.md` | Generic-slot + translation-file recipe, `:lng` / `:lng_variant` usage, limits. |
| `scripts/generate-tenant-spec.js` | Node starting point: discover columns, assemble spine + dynamic, emit a data model spec. |
