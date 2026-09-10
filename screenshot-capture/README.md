# Sigma embed screenshot capture

Signs **single-use** Sigma embed JWTs and screenshots an embedded workbook once
per "tenant" with Playwright. Run this **locally** — the cloud agent environment
blocks `*.sigmacomputing.com`, so the capture has to happen from a machine that
can reach Sigma.

## Setup

```bash
cd screenshot-capture
npm install
npx playwright install chromium

cp .env.example .env            # fill in creds + WORKBOOK_EMBED_URL
cp tenants.example.json tenants.json   # edit the tenant list
```

## Configure

- **`.env`** — your embed `CLIENT_ID` / `SECRET` and `WORKBOOK_EMBED_URL` (the
  workbook to embed). `.env` is gitignored; don't commit it.
- **`tenants.json`** — one entry per view you want to capture. Each entry signs
  its own JWT:
  - `label` — used for the output filenames.
  - `email` — the embed user (`sub`). Auto-provisions an embed user on first use.
  - `claims` — optional JWT claims to drive per-tenant data: `account_type`,
    `teams`, `user_attributes`. Set these to whatever your workbook uses to vary
    columns/rows per customer (e.g. RLS user attributes).
  - `urlParams` — optional embed URL params (e.g. `":hide_folder_navigation"`,
    `":theme"`).
  - `settleMs` — how long to wait after load for charts/tables to render.
  - `waitForSelector` — optional CSS selector to wait for before capturing.
  - `elementSelectors` — optional `[{ "name": "...", "selector": "..." }]` to
    also capture individual elements (a specific table, a control, etc.).

## Run

```bash
npm run capture
# or: node --env-file=.env capture.mjs
```

Screenshots land in `./screenshots/` — a `_full.png` (full page) and
`_viewport.png` per tenant, plus any element captures. Send me that folder and
I'll crop, caption, and wire the images into the quickstart steps.

## Getting the two-tenant "different columns" shot

The guide's key visual is the *same* report showing *different* columns for two
tenants. To produce it, point `WORKBOOK_EMBED_URL` at the workbook that varies
columns per tenant, and give two `tenants.json` entries whose `claims` select
the two customers (matching whatever the workbook keys on). The two `_full.png`
files are your before/after pair.

## Notes

- Embed JWTs are single-use; the script mints a fresh one per tenant load. Just
  re-run the script to capture again — don't hand-reload a URL.
- Nothing is written outside `./screenshots`, and no secrets are printed.
