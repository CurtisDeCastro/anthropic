# Localization (Approach B)

Rename a fixed set of generic slot columns per tenant instead of generating a
workbook. Use when the number of client columns has a known ceiling.

## Recipe

1. **Model generic slots once.** Name the variable columns `client_col_1`,
   `client_col_2`, … up to your maximum slot count.
2. **Keep a per-tenant mapping** (`client_col_1 -> "Dietary Preference"`, …) in a
   warehouse table. Use a **deterministic order** (for example, alphabetical by
   source column) so a given source column always lands in the same slot.
3. **Publish a translation file** mapping each generic label to the tenant's real
   label. Organization translation files are API-managed; workbook-level
   translations are uploaded from the workbook UI.
4. **Apply at embed time** with the `:lng` URL parameter, e.g. `&:lng=en-acme`.
   Use `:lng_variant` when one language has several consumer-specific variants.

## Translation file shape

A flat map of original string to translated string. **Edit only the values.
Never change the keys and never rename the file.**

```json
{
  "client_col_1": "Dietary Preference",
  "client_col_2": "Session Track",
  "client_col_3": "Role"
}
```

## Rules and limits

- Language codes are **case-sensitive**; URL-encode variant names in `:lng_variant`.
- Translations apply when **viewing/exploring** a published workbook, not while
  editing.
- **Custom views cannot be translated.**
- Localization renames columns; it does not add or remove them. Size the slot
  count for your largest tenant.
- Column-count and translation-file-size limits are not published — validate
  against your largest tenant before committing.
- **Version-tag interaction**: tagging a workbook version captures the
  workbook-level translation in force at tag time; otherwise the latest
  org-level file is used.

## References

- Manage workbook localization:
  https://help.sigmacomputing.com/docs/manage-workbook-localization
- Manage organization translation files:
  https://help.sigmacomputing.com/docs/manage-organization-translation-files
- Create organization translation file (API):
  https://help.sigmacomputing.com/reference/create-org-translation
