# When to Escalate Beyond Workbook Tags

The workbook-tag approach handles most per-customer embedding use cases. This reference describes the signals that indicate you've outgrown it and what to reach for instead.

## Signals

| Signal | Implication |
|--------|-------------|
| Customers need different source databases or connection credentials | Workbook tags can't change the data connection — escalate to data models or connection-level isolation |
| Per-customer differences are driven by upstream schema (column names come from the warehouse, not config) | Column names must be encoded at the data layer, not the workbook layer |
| More than one table/element needs per-customer customization | `CUSTOMER_CONFIG` extraColumns scales poorly across multiple elements; data model inheritance handles this more cleanly |
| Customer column names must change at embed request time (dynamic, not at tag-apply time) | Tags are immutable snapshots; dynamic bindings require a different mechanism |
| Row-level security policies differ per customer | Workbook tags share the same query path; data model CLS or warehouse-level RLS is the right layer |

## The Data Model Escape Hatch

Sigma data models expose a confirmed public REST API (`PUT /v2/dataModels/{id}/spec`) and support version tagging. Workbooks can be bound to a tagged version of a data model (`dataModelSourceTaggedVersions` on `POST /v2/workbooks/tag`).

This means:
- One workbook visual layer shared across all customers
- Per-customer column names and schema differences encoded in the data model spec
- The tag application step binds the workbook to the matching data model tag

See the `sigma-data-models` skill for the data model spec API.

## Recommended Architecture Progression

```
Stage 1 — Simple embed
  One workbook, no customization
  → sigma-embed SKILL.md Step 1

Stage 2 — Per-customer column variants
  One canonical workbook + CUSTOMER_CONFIG + workbook tags
  → sigma-embed SKILL.md Steps 2–4 + reference/customer-config.md

Stage 3 — Schema-driven or multi-element customization
  Data model tags + workbook tags bound together
  → sigma-data-models skill + sigma-embed reference/tag-sync.md

Stage 4 — Full tenant isolation
  Separate data connections or warehouse schemas per customer
  → Infrastructure-level isolation (outside Sigma embed scope)
```

## What Doesn't Change When Escalating

- JWT signing and embed URL construction (SKILL.md Steps 1–2) are identical regardless of the customization layer
- The `makeClient` / `onEvent` / dry-run pattern from `tag-sync.md` applies to data model API calls as well
- Admin credential separation (embed credentials vs. admin OAuth) remains the same
- The `slugify` tag naming convention can be reused for data model tags

## Rule of Thumb

Start with workbook tags. The complexity of managing data model specs on top of workbook specs is only justified when the customization can't reasonably be expressed in the `CUSTOMER_CONFIG` object. Three customers with two extra columns each: workbook tags. Twenty customers where column names come from a warehouse metadata table: data models.
