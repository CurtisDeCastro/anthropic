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
// in-app "Sigma Org Configuration" form is the source of truth; the server
// itself holds nothing per-org.
async function runTagSync(req, res, op) {
  const events = [];
  const {
    apiBase, adminClientId, adminClientSecret, canonicalWorkbookId,
  } = req.body || {};

  if (!canonicalWorkbookId) {
    return res.status(400).json({ error: 'canonicalWorkbookId is required', events });
  }

  try {
    const client = await makeClient({
      apiBase,
      clientId: adminClientId,
      clientSecret: adminClientSecret,
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
