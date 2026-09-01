# Dynamic Column Schemas QuickStart — drop-in bundle

This folder contains a complete Sigma QuickStart plus its companion agent skill,
laid out to mirror the two Sigma repos so you can copy each subtree straight in.

## What's here

```
dynamic-schema-quickstart/
├── site/sigmaguides/src/embedding_20_dynamic_column_schemas/
│   └── embedding_20_dynamic_column_schemas.md      → sigmaquickstarts repo
└── quickstarts-public/embedding_dynamic_column_schemas/
    ├── README.md                                    → quickstarts-public repo
    └── skills/sigma-dynamic-embed-schema/           → the bundled agent skill
        ├── SKILL.md
        ├── reference/spec-shapes.md
        ├── reference/localization.md
        └── scripts/generate-tenant-spec.js
```

## Where each piece goes

1. **The guide** →
   `github.com/sigmacomputing/sigmaquickstarts` at
   `site/sigmaguides/src/embedding_20_dynamic_column_schemas/embedding_20_dynamic_column_schemas.md`.
   Preview locally with `gulp serve` from `site/` (see that repo's README).
2. **The companion code + skill** →
   `github.com/sigmacomputing/quickstarts-public` at
   `embedding_dynamic_column_schemas/`.

## Open items before publishing

- **QuickStart id / series number.** `embedding_20_...` is a placeholder — assign
  the next free number in the embedding series and rename the folder, the `.md`
  file, and the `id:` header to match (all three must be identical).
- **`status:` header.** Currently `Draft`. Flip to `Published` when ready.
- **Footer asset.** The guide references `assets/sigma_footer.png`. Copy the
  standard footer image (and any screenshots you add) into an `assets/` folder
  next to the `.md`, following other embedding guides.
- **Beta content handling.** Workbook code representation is beta. The guide
  marks it clearly and deliberately does **not** publish private beta endpoint
  schemas — it points readers to the beta program. Confirm this framing is OK
  for a public page, or gate the workbook-generation step behind a beta note per
  docs-team guidance.
- **Screenshots.** The current draft is text/code-first. Add screenshots for the
  discovery, spec, and embed steps to match the visual density of other
  embedding QuickStarts.

## Sources this was built from

- Maritz precedent (transpose issue, code-rep + localization approaches, the
  no-wildcard gotcha) and the 8/26 #product thread on dynamic schemas.
- Sigma docs: data model / control code representation, workbook & org
  localization, actions, version tags / source swap.
- QuickStart format: `embedding_15_embed_sdk` and `embedding_01_getting_started_v3`.
