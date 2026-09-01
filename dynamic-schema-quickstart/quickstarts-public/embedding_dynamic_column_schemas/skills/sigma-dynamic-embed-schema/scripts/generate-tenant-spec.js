#!/usr/bin/env node
/**
 * generate-tenant-spec.js
 *
 * Starting point for the "spine + dynamic columns" pattern from the
 * Embedding Dynamic Column Schemas QuickStart. Given a tenant and its
 * discovered column list, emits a Sigma data-model table spec whose column
 * set = fixed spine columns + the tenant's dynamic columns.
 *
 * This is a template: replace discoverTenantColumns() with a real warehouse
 * query, and POST the emitted spec with your data-model / workbook code
 * representation calls. No external dependencies (Node 18+).
 *
 * Usage:
 *   node generate-tenant-spec.js <tenantId> [sourceTable]
 *   node generate-tenant-spec.js acme COST_ALLOC_WIDE
 */

'use strict';

// --- Configure your spine --------------------------------------------------
// The spine is identical for every tenant: join keys, dates, totals, and any
// column your formulas / filters / downstream elements depend on.
const SOURCE_MODEL_NAME = 'Cost Allocation';
const SPINE = [
  { warehouse: 'COST_CENTER' },
  { warehouse: 'PERIOD' },
  { warehouse: 'AMOUNT' },
];
// Calculated columns are part of the spine too (constant across tenants).
const SPINE_CALCULATED = [
  { id: 'k7f2q9', name: 'Cost per Head', formula: '[AMOUNT] / [Headcount]' },
];

// A stable hash stands in for the model's inode prefix. In a real spec this
// comes from the existing data model; keep it constant per source.
const INODE_PREFIX = 'inode-AbC123';

// --- Warehouse discovery (replace me) --------------------------------------
/**
 * Return this tenant's dynamic column names, in a deterministic order.
 * Replace the body with a real query, e.g.:
 *   SELECT DISTINCT question_key FROM <sourceTable>
 *   WHERE tenant = :tenantId ORDER BY question_key
 */
async function discoverTenantColumns(tenantId, sourceTable) {
  const MOCK = {
    acme: ['DIETARY_PREFERENCE', 'SESSION_TRACK', 'ROLE'],
    globex: ['REGION', 'BUSINESS_UNIT', 'PROJECT_CODE', 'APPROVER'],
  };
  const cols = MOCK[tenantId];
  if (!cols) {
    throw new Error(
      `No mock columns for tenant "${tenantId}". Wire up discoverTenantColumns() ` +
      `to query ${sourceTable || '<your table>'}.`
    );
  }
  return cols;
}

// --- Spec assembly ---------------------------------------------------------
function warehouseColumnId(name) {
  return `${INODE_PREFIX}/${name}`;
}

function buildTableSpec(dynamicColumnNames) {
  const columns = {};
  const order = [];

  // Spine warehouse columns
  for (const col of SPINE) {
    const id = warehouseColumnId(col.warehouse);
    columns[id] = { formula: `[${SOURCE_MODEL_NAME}/${col.warehouse}]` };
    order.push(id);
  }

  // Spine calculated columns
  for (const calc of SPINE_CALCULATED) {
    columns[calc.id] = { formula: calc.formula, name: calc.name };
    order.push(calc.id);
  }

  // Tenant dynamic columns (appended). Every column must be listed explicitly:
  // there is no wildcard, so re-discover and re-enumerate on every generation.
  for (const name of dynamicColumnNames) {
    const id = warehouseColumnId(name);
    columns[id] = { formula: `[${SOURCE_MODEL_NAME}/${name}]` };
    order.push(id);
  }

  return { kind: 'table', columns, order };
}

// --- Main ------------------------------------------------------------------
async function main() {
  const [, , tenantId, sourceTable] = process.argv;
  if (!tenantId) {
    console.error('Usage: node generate-tenant-spec.js <tenantId> [sourceTable]');
    process.exit(1);
  }

  const dynamicColumns = await discoverTenantColumns(tenantId, sourceTable);
  const table = buildTableSpec(dynamicColumns);

  const spec = { elements: { tenant_report: table } };

  // In production: POST this to createdatamodelspec (or update an existing
  // model), then create/update the workbook via code representation, then sign
  // the embed JWT and hand back the embed URL.
  console.log(JSON.stringify(spec, null, 2));
  console.error(
    `\n[${tenantId}] spine=${SPINE.length + SPINE_CALCULATED.length} ` +
    `dynamic=${dynamicColumns.length} total=${table.order.length} columns`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
