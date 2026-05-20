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

async function runTagSync(res, op) {
  const events = [];
  try {
    const client = await makeClient({
      apiBase: process.env.SIGMA_API_BASE,
      clientId: process.env.SIGMA_CLIENT_ID,
      clientSecret: process.env.SIGMA_CLIENT_SECRET,
      onEvent: (e) => events.push(e),
    });
    const result = await op(client);
    res.json({ dryRun: client.dryRun, events, result });
  } catch (err) {
    res.status(500).json({ error: err.message, events });
  }
}

app.post('/api/sync-tags', (_req, res) => runTagSync(res, syncAllCustomers));
app.post('/api/propagate-template', (_req, res) => runTagSync(res, propagateTemplate));

// Read-only probe so the UI can tell dry-run vs live without running a sync.
app.get('/api/sync-status', (_req, res) => {
  const hasCreds = Boolean(process.env.SIGMA_CLIENT_ID && process.env.SIGMA_CLIENT_SECRET);
  res.json({ dryRun: !hasCreds });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sigma embed POC running at http://localhost:${PORT}`));
