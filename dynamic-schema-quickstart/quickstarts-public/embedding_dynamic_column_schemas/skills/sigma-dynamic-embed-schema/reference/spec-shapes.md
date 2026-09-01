# Spec shapes

Concrete JSON for the code-representation approach. These mirror Sigma's
published data-model code-representation examples. Verify against the current
docs and (for workbooks) the beta materials before relying on exact field names.

## Table element: columns + order

A table element carries a `columns` map and a sibling `order` array. The `order`
array lists all column ids left-to-right, mixing warehouse and calculated
columns.

```json
{
  "elements": {
    "tenant_report": {
      "kind": "table",
      "columns": {
        "inode-AbC123/COST_CENTER": { "formula": "[Cost Allocation/COST_CENTER]" },
        "inode-AbC123/PERIOD":      { "formula": "[Cost Allocation/PERIOD]" },
        "inode-AbC123/AMOUNT":      { "formula": "[Cost Allocation/AMOUNT]" },
        "k7f2q9": { "formula": "[AMOUNT] / [Headcount]", "name": "Cost per Head" }
      },
      "order": [
        "inode-AbC123/COST_CENTER",
        "inode-AbC123/PERIOD",
        "inode-AbC123/AMOUNT",
        "k7f2q9"
      ]
    }
  }
}
```

Field notes:

- **Warehouse columns**: keyed by `inode-<hash>/COLUMN_NAME`; value has a
  `formula` of `[table name/column name]` and no `name`.
- **Calculated columns**: keyed by a short alphanumeric id; value has a `formula`
  and a display `name`.
- **`order`**: controls left-to-right placement. Include every column id.
- **No wildcard**: a column not present in `columns`/`order` does not render.

## Spine + dynamic assembly

The spine ids are constant across tenants. For each tenant, append the tenant's
discovered columns to both `columns` and `order`:

```
columns = { ...spineColumns, ...tenantColumns }
order   = [ ...spineOrder, ...tenantOrder ]
```

## Control retargeting

A control is `"kind": "control"`. To point it at a different source column per
tenant, rewrite `columnId` in both the filter target and the value `source`.

```json
{
  "kind": "control",
  "controlType": "list",
  "controlId": "CostCenter",
  "filters": [
    { "source": { "kind": "table", "elementId": "tenant_report" },
      "columnId": "inode-AbC123/COST_CENTER" }
  ],
  "source": {
    "kind": "source",
    "source": { "kind": "table", "elementId": "tenant_report" },
    "columnId": "inode-AbC123/COST_CENTER"
  }
}
```

## Endpoints

- **Data model (GA)**: `getdatamodelspec`, `createdatamodelspec`.
- **Workbook (beta)**: workbook code-representation endpoints available through
  the Sigma beta program. Not in the public API reference; confirm request and
  response schemas against the beta materials you receive.
- **Plain workbook create**: `POST /v2/workbooks` creates an empty workbook
  (`name` required; optional `folderId`, `description`, `ownerId`) — it does not
  define elements or columns.

## Runtime column show/hide (no regeneration)

For end-user-driven show/hide, use the action option **"With names matching
control values"**: a List/Segmented control drives which columns are shown or
hidden by matching column names to the selected values. Candidate names can come
from an input-table column or a manual list. Prototype against your data before
committing.

## References

- Data model with a table and a calculated column:
  https://help.sigmacomputing.com/docs/example-representation-data-model-with-a-table-and-a-calculated-column
- Data model with a list values control:
  https://help.sigmacomputing.com/docs/example-representation-data-model-with-a-list-values-control
- Actions that modify or refresh elements:
  https://help.sigmacomputing.com/docs/create-actions-that-modify-or-refresh-elements
