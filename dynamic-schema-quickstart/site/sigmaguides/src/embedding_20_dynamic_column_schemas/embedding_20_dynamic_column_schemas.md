author: Curtis Castro
id: embedding_20_dynamic_column_schemas
summary: Serve one embedded Sigma workbook to many tenants when each tenant's table has a different set of columns. Learn the "spine + dynamic columns" pattern, generate per-tenant workbooks with code representation, rename generic columns with localization, retarget filter controls per tenant, and hand the whole workflow to a coding agent with the bundled skill.
categories: Embedding
environments: web
status: Draft
feedback link: https://github.com/sigmacomputing/sigmaquickstarts/issues
tags: default
lastUpdated: 2026-09-01

# Embedding Dynamic Column Schemas for Multi-Tenant Workbooks

## Overview
Duration: 5

You are embedding Sigma into your application and every one of your customers ("tenants") wants the same report — but each tenant's data has a **different set of columns**. A cost-allocation report might share a fixed backbone of join keys and totals, yet each client names and counts its GL codes, cost centers, and custom dimensions differently. You do not want to build and maintain one workbook per tenant.

This QuickStart shows you how to serve **one logical report to many tenants with variable column schemas**, using patterns that Sigma customers run in production today.

### The core idea: a spine plus dynamic columns

Split every tenant's schema into two parts:

- **Spine columns** — a fixed set present for every tenant. Join keys, dates, totals, and any column your formulas, filters, or downstream elements depend on. You model these once.
- **Dynamic columns** — the client-specific columns that vary in **name and count** from tenant to tenant. You do not hardcode these at build time; you supply them per tenant.

Everything in this guide is a strategy for delivering the dynamic columns safely on top of a stable spine.

### Key advantages

- **One report to maintain, not N.** A single design serves every tenant; you change the pattern once.
- **No per-tenant rebuild.** New tenants and new columns flow in through data, code, or configuration — not manual workbook edits.
- **Tenant isolation.** Each tenant sees only its own columns, with real, human-readable names.

### Target audience

Embed developers and analytics engineers who already sign Sigma embed JWTs and now need per-tenant column variation. Familiarity with the Sigma REST API and the [Getting Started with Embedding](https://quickstarts.sigmacomputing.com/guide/embedding_01_getting_started_v3/index.html) QuickStart is assumed.

<aside class="positive">
<strong>IMPORTANT:</strong><br> Some screens in Sigma may appear slightly different from those shown in QuickStarts, as we are always improving the product. The concepts and steps remain the same.
</aside>

### Prerequisites

- A Sigma organization with **embedding** enabled and an embed client ID + secret.
- A cloud data warehouse connection (examples use Snowflake).
- Ability to sign embed JWTs from a server (see the Getting Started with Embedding QuickStart).
- For the code-representation path: access to the Sigma REST API and, optionally, a coding agent such as Claude Code, Cursor, or Codex.

<aside class="positive">
<strong>TIP:</strong><br> Use non-production resources (a test connection, test folder, and non-production embed credentials) while you work through this guide.
</aside>

Start a [Free Trial](https://www.sigmacomputing.com/free-trial) if you do not have an organization yet.

---

## Why one static workbook cannot do it
Duration: 5

Before choosing a solution, understand the constraint you are working around.

**Sigma workbook elements have a fixed schema.** A table, pivot, or chart element behaves like a SQL view: its columns are resolved when the element is built, not at view time. This is what makes Sigma fast and governable — and it is why you cannot point one statically-built table at tenant A and have it silently grow or rename columns for tenant B.

Two consequences follow, and both are common traps:

- **Native Transpose / pivot output is hardcoded at creation time.** If you transpose key-value rows into columns and then swap the underlying source per tenant, the *original* tenant's column names remain baked into the element. Tenant A's columns can appear over tenant B's data. Treat "transpose, then source-swap per tenant" as unsafe for variable schemas.
- **A warehouse-side dynamic pivot view does not help by itself.** Sigma resolves the element's schema when it is built and does not re-describe the pivot SQL on a later source swap, so the column list does not follow the tenant.

<aside class="negative">
<strong>NOTE:</strong><br> The takeaway is not "Sigma can't do this." It is that the column set must be made known to Sigma <em>per tenant</em> — either by generating the tenant's element from code, or by mapping a fixed set of generic columns to per-tenant names. The rest of this guide covers both.
</aside>

---

## Choose your approach
Duration: 3

Three approaches, in order of preference:

| Approach | Use it when | Trade-off |
| --- | --- | --- |
| **A. Code representation** (generate per-tenant) | Column names/counts are truly open-ended; you already build things programmatically. | You must enumerate each tenant's exact column set when you generate. |
| **B. Localization** (rename generic columns) | There is a known *maximum* number of client columns; you want to avoid generating workbooks. | Columns live in fixed "slots"; renaming is per tenant, not add/remove. |
| **C. Version tag + source swap** | You have a small, stable set of tenants and near-identical schemas. | Fragile for variable schemas; **not recommended** as your primary pattern. |

Most teams combine A and B: a spine modeled once, dynamic columns generated with code representation, and localization to keep generic labels readable where generation is overkill.

<aside class="negative">
<strong>NOTE:</strong><br> Approach C (tag a version, then swap the data source per tenant) can appear to work for a handful of look-alike tenants, but it does not carry a variable column list and breaks in common cases — you cannot source-swap a workbook that spans multiple data sources, custom-SQL elements are not updated on swap, and the connection type must match. Use tags for their intended purpose (staging vs. production lifecycle), not as a per-tenant schema mechanism.
</aside>

---

## Approach A — Generate per-tenant workbooks with code representation
Duration: 12

Code representation exposes a Sigma **data model** and **workbook** as a JSON/YAML spec you can create, read, and update through the REST API. Instead of one static workbook, you generate the tenant's data model and workbook (or just the varying elements) from the tenant's real column list.

**Data Models as Code** is generally available. **Workbook code representation** is in beta at the time of writing — see the note at the end of this step to join.

### The generation flow

1. **Discover the tenant's columns.** Query your warehouse for this tenant's column set (for a key-value source, `SELECT DISTINCT question_key FROM ... WHERE tenant = ?`).
2. **Assemble the column list = spine + dynamic.** The spine columns are constant across tenants; append the tenant's dynamic columns.
3. **Emit the spec.** Produce the data model (and workbook) spec with that column list.
4. **Create or update via the API**, then embed the generated workbook for that tenant.

### What the spec looks like

In a data model spec, a table element carries a `columns` array plus an `order` array that controls left-to-right placement. Warehouse-backed columns reference the physical column by formula; calculated columns carry a short id, a formula, and a display `name`:

```copy-code
{
  "elements": {
    "tenant_report": {
      "kind": "table",
      "columns": {
        "inode-AbC123/COST_CENTER":   { "formula": "[Cost Allocation/COST_CENTER]" },
        "inode-AbC123/PERIOD":        { "formula": "[Cost Allocation/PERIOD]" },
        "inode-AbC123/AMOUNT":        { "formula": "[Cost Allocation/AMOUNT]" },
        "k7f2q9":                     { "formula": "[AMOUNT] / [Headcount]", "name": "Cost per Head" }
      },
      "order": [
        "inode-AbC123/COST_CENTER",
        "inode-AbC123/PERIOD",
        "inode-AbC123/AMOUNT",
        "k7f2q9"
      ]
    }
  }
}
```

The **spine** columns (`COST_CENTER`, `PERIOD`, `AMOUNT`, and the calculated `Cost per Head`) stay constant. For each tenant you append that tenant's **dynamic** columns to both `columns` and `order`. See Sigma's documented example, [Representation of a data model with a table and a calculated column](https://help.sigmacomputing.com/docs/example-representation-data-model-with-a-table-and-a-calculated-column), for the full field reference.

### The one gotcha that will bite you

**Every column must be listed explicitly.** Code representation has no wildcard or "include everything" option — a column that is not declared in the spec does not appear in the generated element. For variable schemas this means your generator must enumerate the tenant's exact column set from the warehouse **every time** it generates. Build discovery (step 1 above) into the pipeline; do not assume new columns will appear on their own.

<aside class="positive">
<strong>TIP:</strong><br> Because generation is mechanical, it is an ideal task for a coding agent. This QuickStart ships a skill that teaches Claude Code, Cursor, or Codex to run exactly this flow — see <strong>Automate it with the bundled skill</strong>, below.
</aside>

<aside class="negative">
<strong>NOTE:</strong><br> Workbook code representation is in <strong>beta</strong>. Data Models as Code is generally available. To use the workbook spec endpoints, contact your Sigma account team or Sigma Support to join the beta, and verify the current request/response shapes against the beta materials you receive. This guide intentionally does not reproduce beta endpoint schemas.
</aside>

---

## Approach B — Rename generic columns with localization
Duration: 8

If the number of client columns has a known ceiling, you can skip generation entirely: model a fixed set of **generic slot columns** once, then rename them per tenant with Sigma's translation/localization feature.

### The recipe

1. **Model generic slots once.** In the data model, name the variable columns `client_col_1`, `client_col_2`, … up to your maximum.
2. **Keep a per-tenant mapping** (`client_col_1 → "Dietary Preference"`, …) in a warehouse table. Use a **deterministic order** — for example, alphabetical by source column — so a given source column always lands in the same slot.
3. **Publish a translation file** that maps each generic label to the tenant's real label. Organization translation files are API-managed; workbook-level translations are uploaded from the workbook UI.
4. **Apply the tenant's language at embed time** with the `:lng` URL parameter (for example `&:lng=en-acme`), and use `:lng_variant` when one language has several consumer-specific variants. Language codes are case-sensitive; URL-encode variant names.

A translation file is a flat map of original string to translated string. **Edit only the values; never change the keys and never rename the file.**

```copy-code
{
  "client_col_1": "Dietary Preference",
  "client_col_2": "Session Track",
  "client_col_3": "Role"
}
```

See [Manage workbook localization](https://help.sigmacomputing.com/docs/manage-workbook-localization) and [Manage organization translation files](https://help.sigmacomputing.com/docs/manage-organization-translation-files).

### Trade-offs

- Slots are fixed — localization renames columns, it does not add or remove them. Size your slot count for the largest tenant.
- Translations apply when **viewing/exploring** a published workbook, not while editing.
- **Custom views cannot be translated.**
- Column-count and translation-file-size limits are not published; validate against your largest tenant before committing to this path.

<aside class="positive">
<strong>TIP:</strong><br> Localization pairs well with code representation: generate the structural spine and any truly open-ended columns with Approach A, and use localization to keep a fixed band of generic slots human-readable without regenerating.
</aside>

---

## Retarget filter controls per tenant
Duration: 6

A filter control points at a specific source column. When that column differs per tenant, you have two options.

### At generation time (Approach A)

A control is an element of `"kind": "control"` whose target and value source are explicit fields. Retargeting a control to a different column for a tenant means rewriting the control's `columnId` (both its filter target and its value `source`) in the generated spec — the same create/update flow as the columns above:

```copy-code
{
  "kind": "control",
  "controlType": "list",
  "controlId": "CostCenter",
  "filters": [
    { "source": { "kind": "table", "elementId": "tenant_report" },
      "columnId": "inode-AbC123/COST_CENTER" }
  ],
  "source": {
    "kind": "source",
    "source": { "kind": "table", "elementId": "tenant_report" },
    "columnId": "inode-AbC123/COST_CENTER"
  }
}
```

See [Representation of a data model with a list values control](https://help.sigmacomputing.com/docs/example-representation-data-model-with-a-list-values-control).

### At runtime (native, no regeneration)

For show/hide behavior driven by the end user, use the action option **"With names matching control values."** A List or Segmented control drives which columns are shown or hidden by matching column names against the selected values; the candidate names can come from an input-table column or a manual list. See [Create actions that modify or refresh elements](https://help.sigmacomputing.com/docs/create-actions-that-modify-or-refresh-elements). This is the closest native primitive to letting a viewer retarget columns without regenerating the workbook — prototype it against your data before committing.

---

## Automate it with the bundled skill
Duration: 6

The generation flow in Approach A is mechanical and repetitive — exactly what a coding agent does well. This QuickStart ships an agent **skill** that teaches Claude Code, Cursor, or Codex to run the whole loop: discover a tenant's columns, assemble spine + dynamic columns, emit the data model and workbook specs, retarget controls, and hand off to your embed signer.

### Get the skill

Clone the companion repository and copy the skill into your agent's skills directory:

```copy-code
git clone https://github.com/sigmacomputing/quickstarts-public.git
```

The skill lives at `embedding_dynamic_column_schemas/skills/sigma-dynamic-embed-schema/`. For Claude Code, copy it under your project's `.claude/skills/` (or the plugin skills path); for Cursor and Codex, follow the equivalent skills/agents convention.

### Use it

With the skill installed, prompt your agent in plain language, for example:

```copy-code
Generate the embedded cost-allocation workbook for tenant "acme".
Spine columns: COST_CENTER, PERIOD, AMOUNT. Discover acme's dynamic
columns from Snowflake table COST_ALLOC_WIDE, append them, retarget the
Cost Center control, and give me the embed URL.
```

The skill walks the agent through discovery, spec assembly (including the "list every column" rule), the create/update calls, and embedding — following the same patterns documented in this guide.

<aside class="positive">
<strong>IMPORTANT:</strong><br> Keep your embed secret and any API credentials server-side only. The agent should read them from environment variables, never inline them into specs, logs, or the browser.
</aside>

---

## What we've covered
Duration: 2

You now have a durable pattern for serving one embedded report to many tenants with variable column schemas:

- **Spine + dynamic columns** — model the stable backbone once, supply the client-specific columns per tenant.
- **Approach A: code representation** — generate the tenant's data model and workbook from its real column list; remember that every column must be listed explicitly.
- **Approach B: localization** — rename a fixed set of generic slot columns per tenant with translation files and `:lng`.
- **Approach C: version tag + source swap** — understood as a caveat, not a primary pattern for variable schemas.
- **Filter controls** — retargeted per tenant at generation time, or shown/hidden at runtime with the "names matching control values" action.
- **The bundled skill** — hand the whole generation loop to a coding agent.

### Additional resource links

- [Sigma Blog](https://www.sigmacomputing.com/blog)
- [Sigma Community](https://community.sigmacomputing.com/)
- [Help Center](https://help.sigmacomputing.com/)
- [QuickStarts](https://quickstarts.sigmacomputing.com/)

Questions or improvements? Open an issue at the [feedback link](https://github.com/sigmacomputing/sigmaquickstarts/issues).

![Footer](assets/sigma_footer.png)
