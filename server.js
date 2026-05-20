const express = require('express');
const path = require('path');
const { CUSTOMER_CONFIG, handleEmbedRequest } = require('./lib/embed');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sigma embed POC running at http://localhost:${PORT}`));
