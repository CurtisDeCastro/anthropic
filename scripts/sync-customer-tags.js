#!/usr/bin/env node
// ---------------------------------------------------------------------------
// sync-customer-tags.js
//
// Reconciles Sigma workbook version tags to match CUSTOMER_CONFIG in
// lib/embed.js. Drop this script into any project that mirrors the same
// CUSTOMER_CONFIG / buildSpec shape and it works without modification.
//
// USAGE
//   node scripts/sync-customer-tags.js [flags]
//
// FLAGS
//   --mode customers   (default)  For each entry in CUSTOMER_CONFIG: push the
//                                  composed spec to the canonical workbook and
//                                  apply the customer-<slug> tag.
//   --mode template               First push the BASE_COLUMNS-only spec and
//                                  apply the `template` tag, THEN run the
//                                  per-customer sync above. Use this when the
//                                  shared base has changed and you want every
//                                  customer tag to inherit the new base.
//
//   --customer <key>              Only sync the named customer. Ignored in
//                                  --mode template.
//   --dry-run                     Print operations without making API calls.
//                                  Implicit when SIGMA_CLIENT_ID or
//                                  SIGMA_CLIENT_SECRET is unset.
//   -h, --help                    Show this help.
//
// ENVIRONMENT
//   SIGMA_API_BASE                 e.g. https://aws-api.sigmacomputing.com
//                                  (defaults to AWS US (West) host)
//   SIGMA_CLIENT_ID                Admin OAuth client id. NOT the embed
//                                  signing client id — these are separate
//                                  credentials with admin scope on the org.
//   SIGMA_CLIENT_SECRET            Admin OAuth client secret.
//   SIGMA_CANONICAL_WORKBOOK_ID    Canonical embed workbook id (target of all
//                                  spec push + tag operations).
//   SIGMA_CANONICAL_WORKBOOK_URL   Canonical embed workbook URL (only used by
//                                  the demo's spec preview, not the script).
//
//   Optional, only needed if your Sigma org's spec-push endpoint differs from
//   the assumption documented in lib/tag-sync.js:
//     SIGMA_SPEC_ENDPOINT_PATH     Default: /v2/workbooks/{workbookId}/spec
//     SIGMA_SPEC_ENDPOINT_METHOD   Default: PUT
//
// EXIT CODES
//   0   All requested syncs succeeded (or dry-run completed).
//   1   At least one customer sync failed, OR a fatal error before the loop
//       (auth, missing env, unknown --customer).
//
// REQUIREMENTS
//   Node 18+ (uses built-in fetch).
// ---------------------------------------------------------------------------

const {
  makeClient,
  syncCustomer,
  syncAllCustomers,
  propagateTemplate,
} = require('../lib/tag-sync');
const { CUSTOMER_CONFIG } = require('../lib/embed');

function parseArgs(argv) {
  const args = { mode: 'customers', customer: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--customer') args.customer = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  if (!['customers', 'template'].includes(args.mode)) {
    console.error(`Invalid --mode: ${args.mode}. Expected "customers" or "template".`);
    process.exit(1);
  }
  return args;
}

function printHelp() {
  // Strip the leading "// " from this file's header block so --help shows the
  // same text as the comment at the top.
  const fs = require('fs');
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\/ -+\n([\s\S]*?)\n\/\/ -+/);
  if (m) {
    console.log(m[1].replace(/^\/\/ ?/gm, ''));
  } else {
    console.log('Usage: node scripts/sync-customer-tags.js [--mode customers|template] [--customer ID] [--dry-run]');
  }
}

function logEvent(e) {
  // Pretty-print structured events as JSON, one per line. Easy to grep,
  // friendly to CI log capture.
  process.stdout.write(JSON.stringify(e) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiBase = process.env.SIGMA_API_BASE;
  const clientId = process.env.SIGMA_CLIENT_ID;
  const clientSecret = process.env.SIGMA_CLIENT_SECRET;
  const workbookId = process.env.SIGMA_CANONICAL_WORKBOOK_ID || '<workbookId-not-set>';
  const forceDry = args.dryRun || !clientId || !clientSecret;

  if (forceDry && !args.dryRun) {
    process.stderr.write(
      '# Dry-run mode (SIGMA_CLIENT_ID or SIGMA_CLIENT_SECRET unset). No API calls will be made.\n',
    );
  }
  if (!forceDry && !process.env.SIGMA_CANONICAL_WORKBOOK_ID) {
    process.stderr.write(
      '# WARNING: SIGMA_CANONICAL_WORKBOOK_ID not set — operations will target the placeholder ID.\n',
    );
  }

  const client = await makeClient({
    apiBase,
    clientId: forceDry ? null : clientId,
    clientSecret: forceDry ? null : clientSecret,
    onEvent: logEvent,
  });

  let result;
  let exitCode = 0;

  if (args.customer) {
    if (!CUSTOMER_CONFIG[args.customer]) {
      console.error(`Unknown customer: ${args.customer}. Known: ${Object.keys(CUSTOMER_CONFIG).join(', ')}`);
      process.exit(1);
    }
    if (args.mode === 'template') {
      console.error('--customer is incompatible with --mode template');
      process.exit(1);
    }
    try {
      result = await syncCustomer(client, workbookId, args.customer);
    } catch (err) {
      logEvent({ level: 'error', action: 'fatal', error: err.message });
      exitCode = 1;
    }
  } else if (args.mode === 'template') {
    result = await propagateTemplate(client, workbookId);
    const failed = (result.customers || []).filter((c) => !c.ok);
    if (failed.length) exitCode = 1;
  } else {
    result = await syncAllCustomers(client, workbookId);
    if (result.some((c) => !c.ok)) exitCode = 1;
  }

  process.stdout.write(
    JSON.stringify(
      { done: true, dryRun: client.dryRun, mode: args.mode, customer: args.customer, result },
      null,
      2,
    ) + '\n',
  );
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`FATAL: ${err.message}\n`);
    process.exit(1);
  });
}
