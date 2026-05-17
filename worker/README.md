# AI Quote Worker

Cloudflare Worker that brokers Anthropic API calls (and future McMaster API
calls) for the AI Quote frontend. The Worker holds all secrets server-side
so the browser never sees them and they never land in source control.

## What it does

- `GET  /api/health` — sanity check + version info
- `POST /api/claude/extract-rfq` — Claude Vision parses RFQ emails + attached drawings into structured quote data
- `POST /api/claude/extract-document` — Claude Vision parses receipts, packing slips, drawings, POs into structured data

## First-time setup (one-time, ~10 minutes)

You only do this once per machine, then `npm run deploy` is enough for future updates.

### 1. Install Wrangler

From the `worker/` directory:

```powershell
npm install
```

This installs the Wrangler CLI locally (no global install needed).

### 2. Log into Cloudflare

```powershell
npx wrangler login
```

Opens your browser. Authorize the Wrangler app. The CLI saves a token in
`%USERPROFILE%\.wrangler\` — you stay logged in across sessions.

### 3. Set the Anthropic API key as a Worker secret

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
```

Wrangler prompts you to paste the value. Paste your `sk-ant-api03-...` key
from your password manager, hit Enter. The key is uploaded directly to
Cloudflare's secret store — it never touches git, never appears in logs.

### 4. Deploy

```powershell
npx wrangler deploy
```

Wrangler bundles `src/index.js` and pushes it to Cloudflare's edge. On
success it prints a URL like:

```
https://ai-quote-worker.<your-subdomain>.workers.dev
```

**Copy that URL** — that's the endpoint AI Quote will call. Paste it back
to Claude in the chat so we can wire it into `index.html`.

### 5. Verify it's live

Open in browser (or curl):

```
https://ai-quote-worker.<your-subdomain>.workers.dev/api/health
```

You should see JSON like:

```json
{
  "ok": true,
  "worker_version": "0.1.0",
  "model": "claude-sonnet-4-6",
  "has_anthropic_key": true,
  "time": "2026-05-17T..."
}
```

If `has_anthropic_key` is `false`, re-run step 3.

## Future updates

After step 1–3 are done once, deploying a code change is just:

```powershell
npx wrangler deploy
```

Tailing logs in real-time:

```powershell
npx wrangler tail
```

Local dev (runs Worker on `localhost:8787`):

```powershell
npx wrangler dev
```

For local dev with the Anthropic key, create `worker/.dev.vars`:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

(`.dev.vars` is in `.gitignore` — never commit it.)

## Architecture notes

- **CORS** locked to `https://keymf-justin.github.io`. Change `ALLOWED_ORIGIN`
  in `wrangler.toml` if you ever serve the frontend from a different domain.
- **Model selection**: `CLAUDE_MODEL` in `wrangler.toml` is the default. The
  frontend can override per-request by passing a `model` field (e.g. to try
  Haiku for cost-sensitive lookups). Default is Sonnet 4.6 for accuracy.
- **Tool use** for structured extraction. Each endpoint defines a single
  tool with a JSON schema and forces Claude to call it — the API guarantees
  the response matches the schema, no fragile prompt-engineering needed.
- **Cost** at typical RFQ volume (~10/day, single 2-page PDF each): ~$0.02
  per call on Sonnet 4.6, ~$0.008 on Haiku 4.5. Budget under $10/month.

## Routes / endpoints

### `POST /api/claude/extract-rfq`

Parse a customer RFQ email into a structured quote draft.

**Request:**
```json
{
  "sender": "Andrew Rose",
  "senderEmail": "arose@alro.com",
  "subject": "RFQ — 50 bracket assemblies",
  "sentDate": "2026-05-17T14:30:00Z",
  "body": "Hi Justin, please quote...",
  "attachments": [
    { "name": "drawing.pdf", "mimeType": "application/pdf", "data": "<base64>" }
  ]
}
```

**Response:**
```json
{
  "parsed": {
    "customer": { "companyName": "...", "contactName": "...", ... },
    "rfqRef": "...",
    "dueDate": "...",
    "parts": [ { "partNum": "...", "qtyBreaks": [10,25,100], ... } ],
    "summary": "...",
    "redFlags": []
  },
  "model": "claude-sonnet-4-6",
  "usage": { "input_tokens": 1234, "output_tokens": 567 }
}
```

### `POST /api/claude/extract-document`

Generic document extraction. Used for receipts, invoices, packing slips,
drawings, POs.

**Request:**
```json
{
  "docType": "packing_slip",
  "hint": "scanned at receiving",
  "attachments": [ { ... } ],
  "context": { "recentJobs": [...] }
}
```

**Response:**
```json
{
  "parsed": {
    "detected_doc_type": "packing_slip",
    "vendor": { "name": "Alro Steel", ... },
    "references": { "poNum": "...", "jobKeyword": "JOB-9876" },
    "lineItems": [ ... ],
    "totals": { ... },
    "summary": "..."
  },
  ...
}
```
