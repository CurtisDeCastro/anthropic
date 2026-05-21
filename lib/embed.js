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

// The canonical workbook ID/URL is no longer a module-level constant. The
// values flow in from the request body (the in-app Sigma Org Configuration
// form fields) so the same server code runs against any Sigma org without
// rebuild or .env hot-loading. The CLI script (scripts/sync-customer-tags.js)
// gets the workbookId via its own flag / env handling.

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

// Per-customer overlay. The embed flow now reads `tagName` to construct the
// `/tag/<tagName>` URL; the sync script reads `extraColumns` to compose the
// per-customer spec that gets pushed to the canonical workbook (id supplied
// per-call from the request body or CLI env).
//
// `tagName` is computed below if omitted (just `slugify(customerId)`); it's
// listed explicitly for readability and so a special-case override is easy.
const CUSTOMER_CONFIG = {
  'Customer A': {
    tagName: 'customer-customer-a',
    extraColumns: [
      { id: 'syaasfXKHZ', formula: 'Text([Cust Json].AGE_GROUP)', name: 'AGE_GROUP' },
    ],
  },
  'Customer B': {
    tagName: 'customer-customer-b',
    extraColumns: [
      { id: 'syaasfXKHZ', formula: 'Text([Cust Json].LOYALTY_EXTRA.BIRTHDAY)', name: 'Birthday' },
    ],
  },
};

// Compose the spec for one customer's tagged workbook version. Output is what
// gets pushed to PUT /v2/workbooks/{id}/spec; workbookId/url live in the URL
// path / request context, not the body.
function buildSpec(customer) {
  const config = CUSTOMER_CONFIG[customer];
  if (!config) throw new Error(`Unknown customer: ${customer}`);

  const columns = [...BASE_COLUMNS, ...config.extraColumns];
  const order = columns.map((c) => c.id);

  return {
    schemaVersion: 1,
    name: customer,
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
      note: 'Composed at request time. _meta is illustrative only and stripped before push.',
      baseColumns: BASE_COLUMNS.map((c) => c.id),
      customerColumns: config.extraColumns.map((c) => c.id),
    },
  };
}

// Spec for the `template` tag: base columns only, no customer overlay.
function buildTemplateSpec() {
  const columns = [...BASE_COLUMNS];
  const order = columns.map((c) => c.id);

  return {
    schemaVersion: 1,
    name: 'Template',
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

// Map a customer key ("Customer A", "Acme Co.") to a deterministic, URL-safe
// tag name. Used as the fallback when CUSTOMER_CONFIG[customer].tagName is
// omitted, and (during the sync script's runtime collision check) to guard
// against two distinct customer keys ending up with the same slug.
function slugify(customerId) {
  const slug = String(customerId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `customer-${slug}`;
}

// Resolve the effective tag name for a customer. Prefers the explicit
// `tagName` field on the config entry; falls back to slugify(customerId).
function tagNameFor(customerId) {
  const config = CUSTOMER_CONFIG[customerId];
  if (!config) throw new Error(`Unknown customer: ${customerId}`);
  return config.tagName || slugify(customerId);
}

// Fail fast at module-load time if two customer keys would map to the same
// tag name. Sigma tags are unique across the org; a collision means one
// customer's tag would shadow another's.
(function checkSlugCollisions() {
  const seen = new Map();
  for (const customerId of Object.keys(CUSTOMER_CONFIG)) {
    const tag = tagNameFor(customerId);
    if (seen.has(tag)) {
      throw new Error(
        `CUSTOMER_CONFIG slug collision: "${seen.get(tag)}" and "${customerId}" both map to tag "${tag}". ` +
        `Set an explicit tagName on one of them.`,
      );
    }
    seen.set(tag, customerId);
  }
})();

function generateEmbedUrl(clientId, secret, workbookUrl, tagName, embedUserEmail, accountType, teams) {
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

  // Strip any existing query string / trailing slash so /tag/<tagName> lands
  // in the right URL segment. The canonical URL set in env may include things
  // like ?:link_source=share from a copied Sigma share link; the tag path
  // must come before the query, not after it.
  const cleanBase = workbookUrl.split('?')[0].replace(/\/+$/, '');
  const taggedUrl = `${cleanBase}/tag/${encodeURIComponent(tagName)}`;
  return `${taggedUrl}?:jwt=${encodeURIComponent(token)}&:embed=true`;
}

function handleEmbedRequest(body) {
  const {
    clientId, secret, email, customer, accountType, teams,
    canonicalWorkbookUrl, canonicalWorkbookId,
  } = body || {};

  if (!clientId || !secret || !email || !customer) {
    return { status: 400, body: { error: 'clientId, secret, email, and customer are required' } };
  }
  // "Template" is a valid embed target alongside the customer entries — it
  // points at the base-columns-only tag.
  const isTemplate = customer === 'Template';
  if (!isTemplate && !CUSTOMER_CONFIG[customer]) {
    return { status: 400, body: { error: `Unknown customer: ${customer}` } };
  }
  if (!canonicalWorkbookUrl) {
    return {
      status: 400,
      body: { error: 'canonicalWorkbookUrl is required (set it in Sigma Org Configuration).' },
    };
  }

  try {
    const tagName = isTemplate ? 'template' : tagNameFor(customer);
    const teamsArr = teams
      ? (Array.isArray(teams) ? teams : String(teams).split(',').map((t) => t.trim()).filter(Boolean))
      : [];
    const embedUrl = generateEmbedUrl(
      clientId, secret, canonicalWorkbookUrl, tagName, email, accountType, teamsArr,
    );
    return { status: 200, body: { embedUrl, tagName, workbookId: canonicalWorkbookId } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

module.exports = {
  CUSTOMER_CONFIG,
  BASE_COLUMNS,
  buildSpec,
  buildTemplateSpec,
  slugify,
  tagNameFor,
  generateEmbedUrl,
  handleEmbedRequest,
};
