# Bootstrap Historical Records — v7.39.0

This version puts the 2024–2026 history into the **live** Quotes + Orders workspaces (not the Archive). Records show up as `📜 imported` pill badges in the lists. Quote totals are frozen (immune to markup changes); order totals are stored snapshots.

## How to load

1. Commit + push: `index.html` (v7.39.0) and `historical-bootstrap.json` together.
2. Wait ~60s for the GitHub Pages rebuild. Hard refresh (Ctrl+Shift+R) the live URL — header pill should read **v7.39.0**.
3. Sign in. Cloud Sync pill should be green.
4. Open **Quotes** (or **Orders**) → top-right **🗃 Import History** button → confirm dialog → done.

The button calls `App.bootstrapLiveHistoricalRecords()` which:

- Fetches `historical-bootstrap.json` from the same Pages origin
- Builds 238 quote records (status=sent, frozen total)
- Builds 648 order records (status mapped from JobBOSS Open/Closed, total stored)
- Skips any record whose Quote # / Order # already exists in your data
- Fuzzy-matches every record's customer to your customer list (by code, then by name)
- Fuzzy-links each order back to its originating quote: same customer, quote ≤90 days before order, scored by date + amount distance
- Pushes everything via SyncEngine → Firebase → all signed-in browsers see it

Toast at the end reports counts: `Imported N quotes + M orders · X customer links · Y quote→order links`.

## What changed in v7.39.0

- `APP_VERSION` → `'7.39.0'`
- `quoteTotalAt()` now honors `quote.importedTotal` when `quote.imported === true` — frozen totals
- New helpers in module body: `buildLiveQuoteFromRow`, `buildLiveOrderFromRow`, `fuzzyLinkLiveOrdersToQuotes`
- New App method: `bootstrapLiveHistoricalRecords()`
- New buttons on Quotes + Orders page headers
- List renderers show `📜 imported` pill and "historical (no line items)" subtitle on imported records

## Imported record flags

Imported quotes carry: `imported: true`, `importedTotal`, `importedSalesman`, `importedCustomerName`, `importedCustomerCode`, `importBatch`, `importedAt`.

Imported orders carry: `imported: true`, `importedSalesman`, `importedRawStatus`, `importedCustomerName`, `importedCustomerCode`, `importBatch`, `importedAt`, plus the normal `total`, `status`, `fromQuoteId/Num` (if linkage matched).

`parts: []` on both. Detail pages render gracefully — the existing renderers handle empty parts arrays. UX polish on the detail view for historical records is a follow-up.

## Re-running

The button is **idempotent** — the dedup-by-number check means clicking twice won't double-load. Safe to re-run if the first attempt errored.

## Files to commit

- `index.html` (v7.39.0)
- `historical-bootstrap.json` (886 rows, ~155 KB)
- `AI QUOTE/BOOTSTRAP-HISTORICAL-DATA.md` (this file — optional)
