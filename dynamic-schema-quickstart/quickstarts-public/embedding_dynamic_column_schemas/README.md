# Embedding: Dynamic Column Schemas — companion code

Companion assets for the **Embedding Dynamic Column Schemas for Multi-Tenant
Workbooks** QuickStart. Serve one embedded Sigma report to many tenants when
each tenant's table has a different set of columns.

## Contents

- `skills/sigma-dynamic-embed-schema/` — an agent skill (Claude Code / Cursor /
  Codex) that teaches a coding agent to run the generation flow: discover a
  tenant's columns, assemble spine + dynamic columns, emit the data model /
  workbook spec, retarget controls, and hand off to your embed signer.
  - `SKILL.md` — the skill definition and procedure.
  - `reference/spec-shapes.md` — data model column/order JSON, control
    retargeting JSON.
  - `reference/localization.md` — the generic-slot + translation-file recipe.
  - `scripts/generate-tenant-spec.js` — runnable Node starting point.

## Try the generator

```bash
cd skills/sigma-dynamic-embed-schema/scripts
node generate-tenant-spec.js acme COST_ALLOC_WIDE
```

Replace `discoverTenantColumns()` with a real warehouse query and POST the
emitted spec through the Data Models as Code (GA) and workbook code
representation (beta) endpoints.

## Install the skill

- **Claude Code**: copy `skills/sigma-dynamic-embed-schema/` under your project's
  `.claude/skills/` (or your plugin's skills path).
- **Cursor / Codex**: follow the equivalent skills/agents convention.
