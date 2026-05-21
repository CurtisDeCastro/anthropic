const { makeClient, propagateTemplate } = require('../../lib/tag-sync');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { apiBase, adminClientId, adminClientSecret, canonicalWorkbookId } = body;
  const events = [];
  if (!canonicalWorkbookId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'canonicalWorkbookId is required', events }),
    };
  }

  try {
    const client = await makeClient({
      apiBase,
      clientId: adminClientId,
      clientSecret: adminClientSecret,
      onEvent: (e) => events.push(e),
    });
    const result = await propagateTemplate(client, canonicalWorkbookId);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: client.dryRun, events, result }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, events }),
    };
  }
};
