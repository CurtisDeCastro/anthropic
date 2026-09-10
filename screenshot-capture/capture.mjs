#!/usr/bin/env node
/**
 * capture.mjs — Sign single-use Sigma embed JWTs and screenshot the embedded
 * workbook per "tenant" with Playwright. Run this LOCALLY (where your machine
 * can reach app.sigmacomputing.com); the cloud agent environment blocks Sigma.
 *
 * Setup:
 *   npm install
 *   npx playwright install chromium
 *   cp .env.example .env   # fill in your values
 *   cp tenants.example.json tenants.json   # edit tenants
 *   node --env-file=.env capture.mjs
 *
 * Notes:
 * - Embed JWTs are SINGLE-USE. This script signs a fresh JWT per tenant load,
 *   so a normal run is fine. Do not reload a captured URL by hand.
 * - No secrets are printed. Nothing is written outside ./screenshots.
 */

import { chromium } from 'playwright';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const {
  SIGMA_EMBED_CLIENT_ID: CLIENT_ID,
  SIGMA_EMBED_SECRET: SECRET,
  WORKBOOK_EMBED_URL: EMBED_URL,
  SIGMA_SESSION_LENGTH = '3600',
  TENANTS_FILE = 'tenants.json',
  OUT_DIR = 'screenshots',
} = process.env;

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
if (!CLIENT_ID) die('SIGMA_EMBED_CLIENT_ID is not set (see .env.example).');
if (!SECRET) die('SIGMA_EMBED_SECRET is not set.');
if (!EMBED_URL) die('WORKBOOK_EMBED_URL is not set (the workbook URL to embed).');

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function signJwt(sub, extraClaims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: CLIENT_ID };
  const payload = {
    sub,
    iss: CLIENT_ID,
    jti: randomUUID(),
    iat: now,
    exp: now + Math.min(Number(SIGMA_SESSION_LENGTH), 2592000),
    ...extraClaims,
  };
  const unsigned = `${b64url(header)}.${b64url(payload)}`;
  const sig = createHmac('sha256', SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

// Build the embed URL preserving Sigma's literal ":" param keys.
function buildEmbedUrl(base, jwt, urlParams = {}) {
  const sep = base.includes('?') ? '&' : '?';
  const extra = Object.entries(urlParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}${sep}:embed=true&:jwt=${encodeURIComponent(jwt)}${extra ? '&' + extra : ''}`;
}

const tenants = JSON.parse(readFileSync(TENANTS_FILE, 'utf8'));
if (!Array.isArray(tenants) || tenants.length === 0) die(`${TENANTS_FILE} must be a non-empty JSON array.`);

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
try {
  for (const t of tenants) {
    if (!t.label || !t.email) { console.warn('skipping tenant without label/email'); continue; }
    const ctx = await browser.newContext({
      viewport: { width: t.width || 1600, height: t.height || 1000 },
      deviceScaleFactor: 2, // crisp screenshots
    });
    const page = await ctx.newPage();

    const jwt = signJwt(t.email, t.claims || {});
    const url = buildEmbedUrl(EMBED_URL, jwt, t.urlParams || {});

    process.stdout.write(`[${t.label}] loading… `);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 });

    // Let charts/tables finish rendering.
    if (t.waitForSelector) {
      await page.waitForSelector(t.waitForSelector, { timeout: 60_000 }).catch(() => {});
    }
    await page.waitForTimeout(t.settleMs ?? 6000);

    const stem = path.join(OUT_DIR, t.label.replace(/\W+/g, '_'));
    await page.screenshot({ path: `${stem}_full.png`, fullPage: true });
    await page.screenshot({ path: `${stem}_viewport.png` });

    // Optional per-element captures, e.g. a specific table or control.
    for (const s of t.elementSelectors || []) {
      const el = await page.$(s.selector);
      if (el) await el.screenshot({ path: `${stem}_${s.name}.png` });
      else console.warn(`\n  (selector not found: ${s.selector})`);
    }

    console.log(`saved ${stem}_full.png (+ viewport${(t.elementSelectors || []).length ? ' + elements' : ''})`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\nDone. Screenshots in ./${OUT_DIR}/`);
