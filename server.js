const express = require('express');
const path = require('path');
const { CUSTOMER_CONFIG, handleEmbedRequest } = require('./lib/embed');
const { makeClient, syncAllCustomers, propagateTemplate } = require('./lib/tag-sync');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/embed-url', (req, res) => {
  const { status, body } = handleEmbedRequest(req.body);
  res.status(status).json(body);
});

app.get('/api/customers', (_req, res) => {
  res.json({ customers: Object.keys(CUSTOMER_CONFIG) });
});

// Tag-sync operations take all Sigma config from the request body. The
// in-app Sigma Configuration form is the source of truth; the server itself
// holds nothing per-org. The clientId/secret used here are the same pair
// that signs the embed JWT — the consolidated UI sends one credential.
async function runTagSync(req, res, op) {
  const events = [];
  const {
    apiBase, clientId, secret, canonicalWorkbookId,
  } = req.body || {};

  if (!canonicalWorkbookId) {
    return res.status(400).json({ error: 'canonicalWorkbookId is required', events });
  }

  try {
    const client = await makeClient({
      apiBase,
      clientId,
      clientSecret: secret,
      onEvent: (e) => events.push(e),
    });
    const result = await op(client, canonicalWorkbookId);
    res.json({ dryRun: client.dryRun, events, result });
  } catch (err) {
    res.status(500).json({ error: err.message, events });
  }
}

app.post('/api/sync-tags', (req, res) => runTagSync(req, res, syncAllCustomers));
app.post('/api/propagate-template', (req, res) => runTagSync(req, res, propagateTemplate));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sigma embed POC running at http://localhost:${PORT}`));
