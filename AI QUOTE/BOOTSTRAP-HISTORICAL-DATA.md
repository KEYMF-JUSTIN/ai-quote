# Bootstrap Historical Data — v7.38.0

Two paths to load 648 orders + 238 quotes into the live AI Quote app:

## Option A — In-app (visual, 5 clicks per file)

1. Deploy v7.38.0 via GitHub Desktop. Wait 60s for Pages rebuild. Hard refresh (Ctrl+Shift+R) the live URL.
2. In AI Quote → left nav → **Invoice Archive** → click "📥 Import from JobBOSS".
3. Click "📁 Browse for invoice file" → pick **ORDERS.xlsx**.
4. Confirm "11 of 11 columns auto-detected" → click **Import**.
5. Left nav → **Quote Archive** → "📥 Import from JobBOSS" → pick **QUOTES.xlsx** → confirm "10 of 10 columns auto-detected" → **Import**.

Each import fuzzy-matches customer names to your existing customer list. The modal shows you how many will auto-link before you commit. SyncEngine pushes both archives to Firebase as soon as you click Import.

## Option B — One-paste console (no clicks after deploy)

1. Deploy v7.38.0. Open the live app. Sign in (Cloud Sync connected, green pill in header).
2. Open browser DevTools → Console tab.
3. Paste the snippet below and press Enter.

```js
(async () => {
  const data = await fetch('historical-bootstrap.json').then(r => r.json());
  const invMap = detectInvoiceColumns(data.archivedInvoices.headers);
  const qMap   = detectQuoteColumns(data.archivedQuotes.headers);
  const batch  = 'bootstrap-' + Date.now().toString(36);
  const invRecs = buildInvoicesFromCsv(data.archivedInvoices.rows, invMap, batch).records;
  const qRecs   = buildQuotesFromCsv(data.archivedQuotes.rows, qMap, batch).records;
  update(s => {
    if (!Array.isArray(s.archivedQuotes)) s.archivedQuotes = [];
    s.archivedInvoices.push(...invRecs);
    s.archivedQuotes.push(...qRecs);
  });
  const invMatched = invRecs.filter(r => r.customerId).length;
  const qMatched   = qRecs.filter(r => r.customerId).length;
  const invTotal   = invRecs.reduce((s,r) => s + (num(r.amount)||0), 0);
  const qTotal     = qRecs.reduce((s,r) => s + (num(r.amount)||0), 0);
  console.log(`OK: ${invRecs.length} invoices (${invMatched} customers linked, ${fmtMoney(invTotal)}) + ${qRecs.length} quotes (${qMatched} customers linked, ${fmtMoney(qTotal)})`);
})();
```

The snippet fetches `historical-bootstrap.json` from the same Pages origin, runs your existing fuzzy customer matcher, and pushes everything in one transaction. SyncEngine then propagates to Firebase.

## File checklist (must be committed together)

- `index.html` (v7.38.0 with Quote Archive feature)
- `historical-bootstrap.json` (886 rows of header data)
- `BOOTSTRAP-HISTORICAL-DATA.md` (this file — optional)
