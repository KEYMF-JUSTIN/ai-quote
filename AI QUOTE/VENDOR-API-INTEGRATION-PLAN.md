# Vendor API Integration Plan

Real automated vendor pricing for AI Quote. Two vendors, two very different paths.

## The architecture problem

AI Quote runs as a single-file HTML page served from GitHub Pages (`keymf-justin.github.io/ai-quote/`). The browser will refuse to make cross-origin requests to `api.mcmaster.com` — the response will not have the right CORS headers, so the fetch fails before any data comes back.

Every "real API" solution therefore has the same shape:

```
┌─────────────┐   HTTPS    ┌──────────────────┐   HTTPS+cert  ┌─────────────────┐
│ AI Quote    │ ─────────► │ Cloudflare       │ ────────────► │ api.mcmaster.com│
│ (browser)   │            │ Worker (proxy)   │               │ /v1             │
│ github.io   │ ◄───────── │ - holds client   │ ◄──────────── │                 │
└─────────────┘   JSON     │   cert securely  │   JSON        └─────────────────┘
                           │ - rate limits    │
                           │ - caches results │
                           │ - CORS-friendly  │
                           └──────────────────┘
```

The Worker is a tiny serverless function (Cloudflare's free tier covers ~100K requests/day at zero cost). It is the only place the client certificate exists. The browser only ever talks to the Worker.

## Vendor 1 — McMaster-Carr (API path)

McMaster has a real REST API at `https://api.mcmaster.com/v1`. KMF already has a B2B account, which is the prerequisite for API approval.

### What's involved

**Step 1 — Apply for API access (Justin does this, takes 1-3 weeks elapsed)**

1. Sign in at `https://www.mcmaster.com/help/api/` with the KMF account
2. Submit an API access request describing intended use ("internal quoting tool — read product info + real-time pricing for cost estimation, no automated ordering")
3. McMaster reviews, approves, and issues:
   - A client certificate (`.pfx` or `.cer` file) tied to KMF's account
   - A certificate password
   - The API username + password (separate from web login)

**Step 2 — Build the Cloudflare Worker proxy (Claude builds this, ~1 day once cert in hand)**

Cloudflare Workers natively support mTLS — the client cert gets uploaded as a Worker Secret and presented automatically on every outbound call to McMaster.

Endpoints the Worker exposes back to AI Quote:

```
GET  /api/mcmaster/search?q={material+form+size}
     → [{ partNum, description, price, url, drawingUrl, inStock }]

GET  /api/mcmaster/price/{partNum}
     → { partNum, price, unit, lastUpdated }

GET  /api/mcmaster/product/{partNum}
     → { description, attributes, drawingUrl, datasheetUrl }
```

Worker behavior:

- Handles the McMaster `/login` flow once per session, caches the Bearer token in Worker KV for up to 23 hours (token expires at 24h)
- Caches search results for 15 minutes (per query) so repeated lookups don't burn API quota
- Caches pricing for 60 minutes per part #
- CORS allows `https://keymf-justin.github.io` origin only
- Rate limit: 60 requests/minute per IP (sane fallback)
- Logs every request to Cloudflare for debugging

**Step 3 — Wire into AI Quote (Claude builds, ~1 day)**

In the part editor's Material section, next to the existing "Material Link" field:

```
[Material: 304 Stainless Steel]  [🔍 Find at McMaster ▾]

   ┌──────────────────────────────────────────────────────┐
   │ Searching McMaster for "304 stainless round 0.5"…   │
   │                                                       │
   │  1388K11   1/2" 304 SS Round Bar, 6 ft                │
   │            $42.18  ·  In stock  ·  📐 CAD             │
   │            [Use this →]                               │
   │                                                       │
   │  8910K11   1/2" 304 SS Round Bar, 3 ft                │
   │            $24.10  ·  In stock  ·  📐 CAD             │
   │            [Use this →]                               │
   │                                                       │
   │  ... (3 more matches)                                 │
   └──────────────────────────────────────────────────────┘
```

Clicking "Use this →" auto-fills:
- `vendorUrl` → McMaster product page
- `vendorPartNum` → "1388K11"
- `vendorId` → linked to McMaster-Carr vendor record
- `materialCost.perBar` or `perPiece` → live price from API
- `_drawingUrl` → CAD/datasheet URL stored for one-click access from the part

McMaster API hosts a "PDS" datasheet and (for many products) a 2D drawing PDF + 3D CAD model files. We'll pull the drawing PDF URL from the product detail endpoint.

### Cost estimate

- Cloudflare Workers: free tier covers <100K requests/day. KMF would use <1K/day. **$0/month**
- McMaster API: free to approved customers. No per-call charge.
- Total runtime cost: **$0/month**
- Build time: **~2 days** once client cert is in hand.

### Risks

1. McMaster may decline API approval if the intended use sounds like resale/scraping. Application phrasing matters — frame as internal quoting tool.
2. McMaster may rate-limit aggressively. Worker caching mitigates.
3. Client certificate must be renewed annually (typical). Set a calendar reminder.

## Vendor 2 — Alro Steel (no API)

Alro **does not have a public API**. Their customer portal at `alro.com` lets logged-in customers see pricing on inventory pages, but there is no programmatic endpoint. Even with KMF's customer login, automated lookup means one of:

### Option A — Stay manual (Recommended for now)

Keep what Phase 1 ships today: a "Search Alro" button in the part editor that opens Alro's site in a new tab with the material query pre-filled. You log in once per session (browser remembers), find the right size, copy the URL back into the Material Link field. The existing Smart Paste workflow then fills in part # and price from the page.

### Option B — Browser automation worker (fragile, last resort)

Build a separate Cloudflare Browser Rendering worker (or a small VPS running Playwright headless) that:
1. Loads alro.com, logs in with KMF credentials stored as a secret
2. Searches for material + size
3. Scrapes results into JSON
4. Returns to AI Quote via the same proxy pattern

Drawbacks:
- Login flow changes break it — Alro updates their site → integration breaks silently → quotes go out with stale or zero prices
- Possible Terms of Service violation (Alro's ToS will need to be reviewed)
- ~$5-15/month for browser rendering or VPS
- Sessions get invalidated by Alro's bot detection → maintenance burden

### Recommendation

Ship Phase 1 ("Search Alro" URL button) and leave Alro as a manual workflow. Revisit once McMaster integration is proven valuable and we know how much volume the automated lookup actually saves. If it turns out you do 50 Alro lookups a day on quotes, the scraping investment pays off. Until then, manual is fine.

## Phased delivery

| Phase | What ships | Effort | Elapsed |
|---|---|---|---|
| **Phase 1** | Vendor search URL buttons (McMaster + Alro + Online Metals) in part editor. Smart Paste already extracts price/part# from pasted URLs. | ½ day | Today |
| **Phase 1.5** | Justin submits McMaster API access request | 1 hr | Within a week |
| **Phase 2** | Cloudflare Worker proxy built + deployed + tested with KMF cert | 1-2 days | Once cert arrives |
| **Phase 3** | AI Quote integration: live McMaster search dropdown, auto-fill of price/part#/drawing in part editor. Ships as v7.50.0. | 1-2 days | Same week as Phase 2 |
| **Phase 4 (optional)** | Alro browser-automation worker if manual proves insufficient | 3-5 days | Future |

Phase 1 ships today (v7.42.0). Phases 2+3 can't start until McMaster issues the cert.

## Action items for Justin

1. **This week**: Submit McMaster API access request at `https://www.mcmaster.com/help/api/` using the KMF B2B account. Forward the confirmation email to me once you've got it.
2. **Once McMaster approves**: Drop the client certificate (`.pfx`) + the password + API username/password into a `vendor-credentials/` folder I can access. I'll handle the Cloudflare Worker deployment.
3. **Decide soon**: Cloudflare Workers requires a Cloudflare account (free). If KMF doesn't have one, we'll set one up under `keymf.com` or similar.

## Files in this build

- `index.html` (v7.42.0) — Phase 1 search URL buttons
- This document — roadmap
- (Future) `worker/` — Cloudflare Worker source
- (Future) `vendor-credentials/` — gitignored, cert + creds
