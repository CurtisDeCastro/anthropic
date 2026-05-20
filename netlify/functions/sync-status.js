exports.handler = async () => {
  const hasCreds = Boolean(process.env.SIGMA_CLIENT_ID && process.env.SIGMA_CLIENT_SECRET);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: !hasCreds }),
  };
};
