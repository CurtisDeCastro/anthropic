# Per-Customer Workbook Configuration

This reference covers the `CUSTOMER_CONFIG` pattern for maintaining per-customer column sets without creating N separate workbooks in Sigma UI.

## Why Not User Attributes

Sigma user attributes can parameterize formula *values* at embed time. They cannot change column display names. If per-customer column names are required, spec composition with version tags is the correct approach.

## The Config Object

```js
// lib/embed.js

const BASE_COLUMNS = [
  // Columns every customer receives
  { id: 'col-name',    name: 'Name',    type: 'text',   source: 'name' },
  { id: 'col-status',  name: 'Status',  type: 'text',   source: 'status' },
  { id: 'col-created', name: 'Created', type: 'datetime', source: 'created_at' },
];

const CUSTOMER_CONFIG = {
  acme: {
    extraColumns: [
      { id: 'acme-revenue', name: 'Revenue', type: 'number', source: 'revenue' },
    ],
  },
  beta: {
    extraColumns: [],   // base columns only; still needs its own tag for isolation
  },
};
```

## Spec Composition Functions

```js
const PAGE_ID    = 'page-1';
const ELEMENT_ID = 'element-1';
const BASE_SOURCE = { type: 'table', schema: 'PUBLIC', table: 'orders' };
const LAYOUT = [];  // fill with element layout descriptors if needed

function buildSpec(customerId) {
  const customer = CUSTOMER_CONFIG[customerId];
  if (!customer) throw new Error(`Unknown customer: ${customerId}`);
  const columns = [...BASE_COLUMNS, ...(customer.extraColumns ?? [])];
  const order = columns.map((c) => c.id);
  return {
    name: `Customer ${customerId}`,
    pages: [{
      id: PAGE_ID,
      name: 'Page 1',
      elements: [{
        id: ELEMENT_ID,
        kind: 'table',
        source: BASE_SOURCE,
        columns,
        order,
        visibleAsSource: false,
      }],
    }],
    layout: LAYOUT,
  };
}

// Template spec — base columns only, never embedded directly
function buildTemplateSpec() {
  const columns = [...BASE_COLUMNS];
  const order = columns.map((c) => c.id);
  return {
    name: 'Template',
    pages: [{
      id: PAGE_ID,
      name: 'Page 1',
      elements: [{
        id: ELEMENT_ID,
        kind: 'table',
        source: BASE_SOURCE,
        columns,
        order,
        visibleAsSource: false,
      }],
    }],
    layout: LAYOUT,
  };
}
```

## Slug Derivation

Tag names must be URL-safe. Derive slugs deterministically:

```js
function slugify(customerId) {
  return 'customer-' + String(customerId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
// slugify('Acme Corp') → 'customer-acme-corp'
// slugify('beta')     → 'customer-beta'
```

## Embed Request Integration

The embed endpoint calls `slugify` to derive the tag name; it does **not** push specs on each request:

```js
app.post('/api/embed-url', (req, res) => {
  const { customerId, userEmail } = req.body;
  if (!CUSTOMER_CONFIG[customerId]) return res.status(400).json({ error: 'Unknown customer' });
  const tagName = slugify(customerId);
  const url = generateTaggedEmbedUrl(userEmail, tagName);
  res.json({ url });
});
```

Spec pushes and tag applications happen in the provisioning step (see `tag-sync.md`), not during embed URL generation.

## Adding a New Customer

1. Add an entry to `CUSTOMER_CONFIG` with the desired `extraColumns`.
2. Run the sync script or click the "Sync customer tags" button in the admin UI.
3. The new `customer-<slug>` tag is created; existing customer tags are unaffected.

## Rules

- `buildSpec` and `buildTemplateSpec` are pure functions — no API calls, safe to unit test.
- Never call a spec push API from the embed URL request path. Tags are immutable; the embed path only needs to sign a JWT and compose a URL.
- Element and page IDs must match the canonical workbook exactly. Export the workbook spec once to confirm them, then define them as named constants.
