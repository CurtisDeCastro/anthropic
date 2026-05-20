const { makeClient, propagateTemplate } = require('../../lib/tag-sync');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const events = [];
  const onEvent = (e) => events.push(e);

  try {
    const client = await makeClient({
      apiBase: process.env.SIGMA_API_BASE,
      clientId: process.env.SIGMA_CLIENT_ID,
      clientSecret: process.env.SIGMA_CLIENT_SECRET,
      onEvent,
    });
    const result = await propagateTemplate(client);
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
