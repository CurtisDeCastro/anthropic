// ---------------------------------------------------------------------------
// Pure async functions for reconciling Sigma workbook version tags to match
// CUSTOMER_CONFIG. Used by:
//
//   - scripts/sync-customer-tags.js   (CLI for operators / CI)
//   - netlify/functions/sync-tags.js  (button in the demo UI)
//   - netlify/functions/propagate-template.js (other button)
//   - server.js                       (Express routes for local dev)
//
// All functions take an injected `client` object so they are testable and so
// the HTTP handlers can capture log events into the response body. Build one
// with makeClient() below.
//
// SPEC-PUSH ENDPOINT (the one open assumption in this file)
//   The Sigma public REST API documents spec push for data models
//   (PUT /v2/dataModels/{id}/spec) but does not document an equivalent path
//   for workbooks. This module assumes the workbook surface mirrors it:
//
//     PUT /v2/workbooks/{workbookId}/spec
//
//   If your Sigma org exposes spec push at a different path, override via:
//     SIGMA_SPEC_ENDPOINT_PATH    e.g. /v2/workbooks/{workbookId}/code
//     SIGMA_SPEC_ENDPOINT_METHOD  e.g. POST
//
//   The tag application step uses POST /v2/workbooks/tag, which IS public and
//   confirmed.
//
// REQUIREMENTS: Node 18+ (uses built-in fetch).
// ---------------------------------------------------------------------------

const {
  CUSTOMER_CONFIG,
  CANONICAL,
  buildTemplateSpec,
  buildCanonicalCustomerSpec,
  slugify,
} = require('./embed');

const SPEC_ENDPOINT_PATH =
  process.env.SIGMA_SPEC_ENDPOINT_PATH || '/v2/workbooks/{workbookId}/spec';
const SPEC_ENDPOINT_METHOD =
  (process.env.SIGMA_SPEC_ENDPOINT_METHOD || 'PUT').toUpperCase();
const TAG_ENDPOINT_PATH = '/v2/workbooks/tag';
const AUTH_PATH = '/v2/auth/token';
const DEFAULT_API_BASE = 'https://aws-api.sigmacomputing.com';

// Fields on the buildSpec()/buildTemplateSpec() return that the spec-push
// endpoint should not receive in its body: workbookId lives in the URL path,
// `url` is read-only metadata, `_meta` is illustrative-only.
function stripSpecForPush(spec) {
  const { workbookId, url, _meta, ...body } = spec;
  return body;
}

async function getAccessToken({ apiBase, clientId, clientSecret, fetchImpl }) {
  const res = await fetchImpl(`${apiBase}${AUTH_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${text}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Auth response not JSON: ${text}`); }
  if (!data.access_token) throw new Error('Auth response missing access_token');
  return data.access_token;
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

async function pushWorkbookSpec(client, workbookId, spec) {
  const body = stripSpecForPush(spec);
  const path = SPEC_ENDPOINT_PATH.replace('{workbookId}', encodeURIComponent(workbookId));
  const url = `${client.apiBase}${path}`;

  client.onEvent({
    level: 'info',
    action: 'pushWorkbookSpec',
    method: SPEC_ENDPOINT_METHOD,
    url,
    workbookId,
    columnCount: body?.pages?.[0]?.elements?.[0]?.columns?.length,
    spec: body,
  });

  if (client.dryRun) {
    return { dryRun: true, action: 'pushWorkbookSpec' };
  }

  const res = await client.fetchImpl(url, {
    method: SPEC_ENDPOINT_METHOD,
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    client.onEvent({ level: 'error', action: 'pushWorkbookSpec', status: res.status, response: text });
    throw new Error(`Spec push failed (${res.status}): ${text}`);
  }
  const parsed = tryParseJson(text);
  client.onEvent({ level: 'info', action: 'pushWorkbookSpec:ok', status: res.status, response: parsed });
  return parsed;
}

async function tagWorkbookVersion(client, workbookId, tag) {
  const url = `${client.apiBase}${TAG_ENDPOINT_PATH}`;
  const body = { workbookId, tag };

  client.onEvent({ level: 'info', action: 'tagWorkbookVersion', method: 'POST', url, body });

  if (client.dryRun) {
    return { dryRun: true, action: 'tagWorkbookVersion', tag };
  }

  const res = await client.fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    client.onEvent({ level: 'error', action: 'tagWorkbookVersion', status: res.status, response: text });
    throw new Error(`Tag failed (${res.status}): ${text}`);
  }
  const parsed = tryParseJson(text);
  client.onEvent({ level: 'info', action: 'tagWorkbookVersion:ok', status: res.status, response: parsed });
  return parsed;
}

// --- Higher-level operations -----------------------------------------------

async function syncCustomer(client, customerId) {
  const config = CUSTOMER_CONFIG[customerId];
  if (!config) throw new Error(`Unknown customer: ${customerId}`);

  const tag = slugify(customerId);
  const spec = buildCanonicalCustomerSpec(customerId);
  const workbookId = CANONICAL.workbookId;

  client.onEvent({ level: 'info', action: 'syncCustomer:start', customerId, tag, workbookId });
  await pushWorkbookSpec(client, workbookId, spec);
  const tagResult = await tagWorkbookVersion(client, workbookId, tag);
  client.onEvent({ level: 'info', action: 'syncCustomer:done', customerId, tag });
  return { customerId, tag, tagResult };
}

async function syncAllCustomers(client) {
  const results = [];
  for (const customerId of Object.keys(CUSTOMER_CONFIG)) {
    try {
      const result = await syncCustomer(client, customerId);
      results.push({ customerId, ok: true, result });
    } catch (err) {
      client.onEvent({ level: 'error', action: 'syncCustomer:failed', customerId, error: err.message });
      results.push({ customerId, ok: false, error: err.message });
    }
  }
  return results;
}

async function pushTemplate(client) {
  const spec = buildTemplateSpec();
  const workbookId = CANONICAL.workbookId;
  client.onEvent({ level: 'info', action: 'pushTemplate:start', workbookId });
  await pushWorkbookSpec(client, workbookId, spec);
  const tagResult = await tagWorkbookVersion(client, workbookId, 'template');
  client.onEvent({ level: 'info', action: 'pushTemplate:done' });
  return { tag: 'template', tagResult };
}

async function propagateTemplate(client) {
  const template = await pushTemplate(client);
  const customers = await syncAllCustomers(client);
  return { template, customers };
}

// --- Client construction ---------------------------------------------------

async function makeClient({ apiBase, clientId, clientSecret, onEvent, fetchImpl }) {
  const dryRun = !clientId || !clientSecret;
  const fetcher = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetcher) {
    throw new Error('No fetch implementation available. Requires Node 18+ or an explicit fetchImpl.');
  }
  const base = apiBase || DEFAULT_API_BASE;
  const log = onEvent || (() => {});

  if (dryRun) {
    log({
      level: 'warn',
      action: 'makeClient:dryRun',
      reason: 'SIGMA_CLIENT_ID and/or SIGMA_CLIENT_SECRET not set — no Sigma API calls will be made',
    });
    return { apiBase: base, accessToken: null, fetchImpl: fetcher, dryRun: true, onEvent: log };
  }

  log({ level: 'info', action: 'makeClient:auth', apiBase: base });
  const accessToken = await getAccessToken({ apiBase: base, clientId, clientSecret, fetchImpl: fetcher });
  return { apiBase: base, accessToken, fetchImpl: fetcher, dryRun: false, onEvent: log };
}

module.exports = {
  makeClient,
  stripSpecForPush,
  pushWorkbookSpec,
  tagWorkbookVersion,
  syncCustomer,
  syncAllCustomers,
  pushTemplate,
  propagateTemplate,
};
