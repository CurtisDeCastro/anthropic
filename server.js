const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Spec composition layer
//
// BASE_COLUMNS are the columns shared by every customer's workbook view.
// CUSTOMER_CONFIG adds per-customer details: the workbook URL (used as the
// embed target) and the extra columns unique to that customer.
//
// POC architecture note:
//   In production this map would be driven by a DB/API mapping table.
//   The seam is the `extraColumns` array — swap the static object below for
//   a table lookup (keyed on customer ID) and the rest of the pipeline is
//   unchanged.
// ---------------------------------------------------------------------------

const BASE_SOURCE = {
  connectionId: 'd9f838b4-c7ed-4bdd-8791-aa2471978a84',
  kind: 'warehouse-table',
  path: ['EXAMPLES', 'PLUGS_ELECTRONICS', 'PLUGS_ELECTRONICS_HANDS_ON_LAB_DATA'],
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

// Per-customer configuration.
// `extraColumns` is the seam that a mapping-table lookup would replace.
const CUSTOMER_CONFIG = {
  'Customer A': {
    workbookId: '5666ff98-6831-4927-a11f-21571f87205c',
    workbookUrl:
      'https://staging.sigmacomputing.io/test-drive-staging-oai-demo/workbook/Customer-A-2D2ps4NFZpYHNHO7PGw1OY',
    extraColumns: [
      {
        id: 'syaasfXKHZ',
        formula: 'Text([Cust Json].AGE_GROUP)',
        name: 'AGE_GROUP',
      },
    ],
  },
  'Customer B': {
    workbookId: 'a5a45a80-2418-402d-9584-c43ad55c5559',
    workbookUrl:
      'https://staging.sigmacomputing.io/test-drive-staging-oai-demo/workbook/Customer-B-52yQjgbpjd4i6fN9s9xF7X',
    extraColumns: [
      {
        id: 'syaasfXKHZ',
        formula: 'Text([Cust Json].LOYALTY_EXTRA.BIRTHDAY)',
        name: 'Birthday',
      },
    ],
  },
};

/**
 * Compose the full workbook spec for a given customer by merging the shared
 * base columns with the customer's extra columns.
 *
 * The returned spec mirrors the shape returned by the Sigma GET workbook
 * endpoint.  The key difference when *pushing* (creating/updating via API)
 * is that Sigma ignores the read-only metadata fields (workbookId, ownerId,
 * createdAt, etc.) — only `pages` and `layout` drive the content.
 */
function buildSpec(customer) {
  const config = CUSTOMER_CONFIG[customer];
  if (!config) throw new Error(`Unknown customer: ${customer}`);

  const columns = [...BASE_COLUMNS, ...config.extraColumns];
  const order = columns.map((c) => c.id);

  return {
    workbookId: config.workbookId,
    name: customer,
    url: config.workbookUrl,
    pages: [
      {
        id: PAGE_ID,
        name: 'Page 1',
        elements: [
          {
            id: ELEMENT_ID,
            kind: 'table',
            source: BASE_SOURCE,
            columns,
            order,
            visibleAsSource: false,
          },
        ],
      },
    ],
    layout: LAYOUT,
    // Fields below are read-only metadata — included for spec fidelity but
    // ignored by the Sigma API when pushing a workbook definition.
    _meta: {
      note: 'workbookId, ownerId, createdAt, etc. are read-only; omit them when pushing to the API',
      baseColumns: BASE_COLUMNS.map((c) => c.id),
      customerColumns: config.extraColumns.map((c) => c.id),
    },
  };
}

// ---------------------------------------------------------------------------
// JWT generation
//
// Sigma JWT embed URL format (recommended approach per docs):
//   {workbookUrl}?:jwt={signedToken}&:embed=true
//
// The secret signs with HS256; `kid` in the header must equal the client ID.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// API route
// ---------------------------------------------------------------------------

app.post('/api/embed-url', (req, res) => {
  const { clientId, secret, email, customer, accountType, teams } = req.body;

  if (!clientId || !secret || !email || !customer) {
    return res.status(400).json({ error: 'clientId, secret, email, and customer are required' });
  }

  if (!CUSTOMER_CONFIG[customer]) {
    return res.status(400).json({ error: `Unknown customer: ${customer}` });
  }

  try {
    const spec = buildSpec(customer);
    const embedUrl = generateEmbedUrl(
      clientId,
      secret,
      spec.url,
      email,
      accountType,
      teams ? teams.split(',').map((t) => t.trim()).filter(Boolean) : [],
    );

    res.json({ embedUrl, spec });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers', (_req, res) => {
  res.json({ customers: Object.keys(CUSTOMER_CONFIG) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sigma embed POC running at http://localhost:${PORT}`));
