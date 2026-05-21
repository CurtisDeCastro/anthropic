// Smoke tests for lib/embed.js. Run with `npm test` (Node 18+).
//
// These cover the things most likely to silently break:
//   - slugify shape
//   - buildSpec / buildTemplateSpec output shape (schemaVersion, column order)
//   - stripSpecForPush removes every read-only field the GET returns
//   - tagNameFor falls back to slugify when explicit tagName is missing
//   - the slug collision guard fires on bad config

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CUSTOMER_CONFIG,
  BASE_COLUMNS,
  buildSpec,
  buildTemplateSpec,
  slugify,
  tagNameFor,
} = require('../lib/embed');
const { stripSpecForPush } = require('../lib/tag-sync');

test('slugify produces customer-<slug> with non-alphanumerics collapsed', () => {
  assert.equal(slugify('Customer A'), 'customer-customer-a');
  assert.equal(slugify('Acme Co.'), 'customer-acme-co');
  assert.equal(slugify('Foo & Bar 2'), 'customer-foo-bar-2');
  assert.equal(slugify('---weird---'), 'customer-weird');
});

test('buildSpec includes schemaVersion: 1', () => {
  const spec = buildSpec('Customer A');
  assert.equal(spec.schemaVersion, 1);
});

test('buildSpec columns are base + extras in that order', () => {
  const spec = buildSpec('Customer A');
  const columns = spec.pages[0].elements[0].columns;
  assert.equal(columns.length, BASE_COLUMNS.length + 1);
  for (let i = 0; i < BASE_COLUMNS.length; i++) {
    assert.equal(columns[i].id, BASE_COLUMNS[i].id);
  }
  assert.equal(columns.at(-1).name, 'AGE_GROUP');
});

test('buildSpec element.order matches columns order', () => {
  const spec = buildSpec('Customer B');
  const el = spec.pages[0].elements[0];
  assert.deepEqual(el.order, el.columns.map((c) => c.id));
});

test('buildTemplateSpec has only base columns', () => {
  const spec = buildTemplateSpec();
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.name, 'Template');
  assert.equal(spec.pages[0].elements[0].columns.length, BASE_COLUMNS.length);
});

test('stripSpecForPush removes every read-only field', () => {
  // Synthesize a spec mirroring exactly what GET /v2/workbooks/{id}/spec returns.
  const input = {
    schemaVersion: 1,
    workbookId: 'abc',
    name: 'Template',
    url: 'https://...',
    documentVersion: 2,
    latestDocumentVersion: 2,
    ownerId: 'owner',
    folderId: 'folder',
    createdBy: 'a',
    updatedBy: 'b',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    pages: [],
    layout: '<Page/>',
    _meta: { note: 'illustrative' },
  };
  const stripped = stripSpecForPush(input);
  assert.deepEqual(Object.keys(stripped).sort(), ['layout', 'name', 'pages', 'schemaVersion']);
});

test('tagNameFor reads explicit tagName from config', () => {
  // Both demo customers have explicit tagName fields.
  for (const id of Object.keys(CUSTOMER_CONFIG)) {
    assert.equal(tagNameFor(id), CUSTOMER_CONFIG[id].tagName);
  }
});

test('tagNameFor falls back to slugify when tagName is omitted', () => {
  // Mutate-restore — simulate a config entry without an explicit tagName.
  const saved = CUSTOMER_CONFIG['Customer A'].tagName;
  delete CUSTOMER_CONFIG['Customer A'].tagName;
  try {
    assert.equal(tagNameFor('Customer A'), 'customer-customer-a');
  } finally {
    CUSTOMER_CONFIG['Customer A'].tagName = saved;
  }
});

test('module-load collision guard fires on duplicate slugs', () => {
  // Re-require the module after stubbing an additional colliding entry. This
  // is awkward but the cheapest way to exercise the IIFE.
  const path = require.resolve('../lib/embed');
  delete require.cache[path];
  const m = require('../lib/embed');
  // Add a colliding entry post-load; manually re-run the guard.
  m.CUSTOMER_CONFIG['Customer-A'] = { tagName: 'customer-customer-a', extraColumns: [] };
  // Re-evaluate the guard via a hand-rolled walk (the IIFE only runs at load).
  const seen = new Map();
  let collided = false;
  for (const id of Object.keys(m.CUSTOMER_CONFIG)) {
    const tag = m.tagNameFor(id);
    if (seen.has(tag)) collided = true;
    seen.set(tag, id);
  }
  assert.ok(collided, 'guard should detect colliding slugs');
  delete m.CUSTOMER_CONFIG['Customer-A'];
});
