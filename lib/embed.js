const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

// ---------------------------------------------------------------------------
// Shared spec composition + JWT signing.
// Imported by both server.js (local dev) and netlify/functions/embed-url.js
// (production). Keeping this in one file ensures the two deploy targets can't
// drift.
// ---------------------------------------------------------------------------

const BASE_SOURCE = {
  connectionId: 'd9f838b4-c7ed-4bdd-8791-aa2471978a84',
  kind: 'warehouse-table',
  path: ['EXAMPLES', 'PLUGS_ELECTRONICS', 'PLUGS_ELECTRONICS_HANDS_ON_LAB_DATA'],
};

// Single canonical workbook the tag-sync script targets. The per-customer
// `workbookId` / `workbookUrl` entries in CUSTOMER_CONFIG below are the demo's
// pre-built workbooks; the production architecture (see docs/prd.md) collapses
// them into this one workbook with per-customer version tags.
const CANONICAL = {
  workbookId: process.env.SIGMA_CANONICAL_WORKBOOK_ID || '<set SIGMA_CANONICAL_WORKBOOK_ID>',
  workbookUrl:
    process.env.SIGMA_CANONICAL_WORKBOOK_URL ||
    '<set SIGMA_CANONICAL_WORKBOOK_URL e.g. https://staging.sigmacomputing.io/{slug}/workbook/Embed-{id}>',
};

const BASE_COLUMNS = [
  {
    id: 'inode-LDg6HOO23KsDKbK4oR4hL/ORDER_NUMBER',
    formula: '[PLUGS_ELECTRONICS_HANDS_ON_LAB_DATA/Order Number]',
  },
  {
    id: 'inode-LDg6HOO23KsDKbK4oR4hL/SKU_NUMBER',
    formula: '[PLUGS_ELECTRONICS_HANDS_ON_LAB_DATA/Sku Number]',
  },
  {
    id: 'inode-LDg6HOO23KsDKbK4oR4hL/CUST_JSON',
    formula: '[PLUGS_ELECTRONICS_HANDS_ON_LAB_DATA/Cust Json]',
  },
];

const PAGE_ID = 'Tj2Vjg-d_8';
const ELEMENT_ID = '4fkt5Yee3Y';

const LAYOUT = `<?xml version="1.0" encoding="utf-8"?>
<Page type="grid" gridTemplateColumns="repeat(24, 1fr)" gridTemplateRows="auto" id="${PAGE_ID}">
  <LayoutElement elementId="${ELEMENT_ID}" gridColumn="1 / 25" gridRow="1 / 21"/>
</Page>
`;

const CUSTOMER_CONFIG = {
  'Customer A': {
    workbookId: '5666ff98-6831-4927-a11f-21571f87205c',
    workbookUrl:
      'https://staging.sigmacomputing.io/test-drive-staging-oai-demo/workbook/Customer-A-2D2ps4NFZpYHNHO7PGw1OY',
    extraColumns: [
      { id: 'syaasfXKHZ', formula: 'Text([Cust Json].AGE_GROUP)', name: 'AGE_GROUP' },
    ],
  },
  'Customer B': {
    workbookId: 'a5a45a80-2418-402d-9584-c43ad55c5559',
    workbookUrl:
      'https://staging.sigmacomputing.io/test-drive-staging-oai-demo/workbook/Customer-B-52yQjgbpjd4i6fN9s9xF7X',
    extraColumns: [
      { id: 'syaasfXKHZ', formula: 'Text([Cust Json].LOYALTY_EXTRA.BIRTHDAY)', name: 'Birthday' },
    ],
  },
};

function buildSpec(customer) {
  const config = CUSTOMER_CONFIG[customer];
  if (!config) throw new Error(`Unknown customer: ${customer}`);

  const columns = [...BASE_COLUMNS, ...config.extraColumns];
  const order = columns.map((c) => c.id);

  return {
    schemaVersion: 1,
    workbookId: config.workbookId,
    name: customer,
    url: config.workbookUrl,
    pages: [
      {
        id: PAGE_ID,
        name: 'Page 1',
        elements: [
          { id: ELEMENT_ID, kind: 'table', source: BASE_SOURCE, columns, order, visibleAsSource: false },
        ],
      },
    ],
    layout: LAYOUT,
    _meta: {
      note: 'workbookId, ownerId, createdAt, etc. are read-only; omit them when pushing to the API',
      baseColumns: BASE_COLUMNS.map((c) => c.id),
      customerColumns: config.extraColumns.map((c) => c.id),
    },
  };
}

// Spec for the `template` tag: base columns only, no customer overlay.
// Targets CANONICAL.workbookId (not any per-customer demo workbook).
function buildTemplateSpec() {
  const columns = [...BASE_COLUMNS];
  const order = columns.map((c) => c.id);

  return {
    schemaVersion: 1,
    workbookId: CANONICAL.workbookId,
    name: 'Template',
    url: CANONICAL.workbookUrl,
    pages: [
      {
        id: PAGE_ID,
        name: 'Page 1',
        elements: [
          { id: ELEMENT_ID, kind: 'table', source: BASE_SOURCE, columns, order, visibleAsSource: false },
        ],
      },
    ],
    layout: LAYOUT,
    _meta: {
      note: 'Template spec — base columns only, no customer-specific extractions',
      baseColumns: BASE_COLUMNS.map((c) => c.id),
    },
  };
}

// Spec for a per-customer tag pushed to CANONICAL.workbookId (rather than the
// customer's demo workbook). Same column composition as buildSpec() but
// retargeted at the canonical workbook so tag-sync produces a single document
// with N tagged versions instead of N separate workbooks.
function buildCanonicalCustomerSpec(customer) {
  const spec = buildSpec(customer);
  return { ...spec, workbookId: CANONICAL.workbookId, url: CANONICAL.workbookUrl };
}

// Sigma version-tag names must be unique. Map a customer key (e.g. "Customer A",
// "Acme Co.") to a deterministic, URL-safe tag name.
function slugify(customerId) {
  const slug = String(customerId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `customer-${slug}`;
}

function generateEmbedUrl(clientId, secret, workbookUrl, embedUserEmail, accountType, teams) {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    sub: embedUserEmail,
    iss: clientId,
    jti: uuid(),
    iat: now,
    exp: now + 3600,
    ...(accountType && { account_type: accountType }),
    ...(teams?.length && { teams }),
  };

  const token = jwt.sign(payload, secret, {
    algorithm: 'HS256',
    header: { alg: 'HS256', kid: clientId },
  });

  return `${workbookUrl}?:jwt=${encodeURIComponent(token)}&:embed=true`;
}

function handleEmbedRequest(body) {
  const { clientId, secret, email, customer, accountType, teams } = body || {};

  if (!clientId || !secret || !email || !customer) {
    return { status: 400, body: { error: 'clientId, secret, email, and customer are required' } };
  }
  if (!CUSTOMER_CONFIG[customer]) {
    return { status: 400, body: { error: `Unknown customer: ${customer}` } };
  }

  try {
    const spec = buildSpec(customer);
    const teamsArr = teams
      ? (Array.isArray(teams) ? teams : String(teams).split(',').map((t) => t.trim()).filter(Boolean))
      : [];
    const embedUrl = generateEmbedUrl(clientId, secret, spec.url, email, accountType, teamsArr);
    return { status: 200, body: { embedUrl, spec } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

module.exports = {
  CUSTOMER_CONFIG,
  BASE_COLUMNS,
  CANONICAL,
  buildSpec,
  buildTemplateSpec,
  buildCanonicalCustomerSpec,
  slugify,
  generateEmbedUrl,
  handleEmbedRequest,
};
