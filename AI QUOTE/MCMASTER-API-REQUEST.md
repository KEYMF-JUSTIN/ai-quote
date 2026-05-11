# McMaster-Carr API Access Request — Draft

Where to file: **https://www.mcmaster.com/help/api/** — there's a request link at the bottom of that page. If it routes you to a contact form or an account-team email, this is the text to paste / send.

## Cost

McMaster does **not publish API pricing publicly**, and the search results for "McMaster API monthly fee" turn up nothing. Industry pattern: the McMaster Product Information API is typically issued **at no charge to approved B2B customers in good standing**, because the integration drives more orders to McMaster — that's the whole point of giving you the catalog data. Several open-source projects (Ki-nTree, dltHub's integration) document the auth flow without anyone ever mentioning a fee or quota tier.

**That said: I can't confirm 100% in writing.** If there is a cost, McMaster will surface it during the application back-and-forth before issuing the certificate. There's no risk in applying — they'll quote any fee before activation, and you can walk away.

The Cloudflare Worker proxy I'd build on top of this also costs **$0/month** at KMF's volume (well under the 100K requests/day free tier).

## Information to have ready before you click Submit

- KMF business name + billing address
- Your McMaster customer account number (on any recent invoice/order)
- Justin's contact: justin@keymf.com, phone
- Approximate annual spend with McMaster (helps establish you're a real customer)

## Suggested request text

Paste this into the "Intended Use" or "Description" field — adapt the bracketed pieces to fit:

> Hello — Keystone Machine & Fab is an active McMaster-Carr B2B account holder (account #[INSERT KMF ACCOUNT NUMBER]). We have built an internal-only quoting tool that estimators use to put together customer quotes for our precision machining and fabrication work, and we'd like API access to pull McMaster product information and real-time pricing into the tool.
>
> **Intended use:**
>
> - Pull product details (description, dimensions, materials, datasheet URL, drawing URL) and current pricing for specific part numbers during quote preparation, so estimators can see McMaster cost as a sourcing option when pricing raw stock and tooling for customer jobs.
> - Search the McMaster catalog by material + form + dimension (e.g., "304 stainless round bar 0.5 inch") to identify candidate part numbers and pricing for a job before quoting it out.
> - Cache pricing/results locally for short windows (15–60 minutes) to avoid unnecessary API load. We do not bulk-replicate or redistribute McMaster catalog data.
>
> **Out of scope (we are NOT doing):**
>
> - Automated order placement — all purchasing decisions stay manual through our normal McMaster account workflow.
> - Resale of catalog data, exposing McMaster pricing to our customers, or any public-facing display of McMaster information.
> - Bulk catalog scraping or replication. We'll only query the parts and searches estimators actually need for active quotes.
>
> **Volume estimate:** We expect on the order of 50–500 API requests per business day, ramping with usage. The tool is used by 2 internal estimators at present.
>
> **Architecture:** The quoting tool runs as an internal browser-based app. API calls will go through a small server-side proxy (Cloudflare Worker) that holds the client certificate. Browser code never sees or stores the certificate.
>
> Please let me know what's needed to get this approved — happy to provide any additional information, sign appropriate terms, or have a brief call with your integration team.
>
> Thanks,
> Justin Jenkins
> Keystone Machine & Fab
> justin@keymf.com
> [PHONE NUMBER]

## What McMaster will likely send back

1. A response (often within a few business days) either approving in principle or asking for more detail.
2. Terms of use document to sign — read it for any redistribution / display restrictions.
3. Once approved, they'll deliver:
   - **Client certificate** (`.pfx` file) — the cryptographic identity for KMF
   - **Certificate password**
   - **API username + password** (separate from your web login)
4. Drop those into a folder I can access (NOT committed to GitHub — I'll set up a `.gitignored` `vendor-credentials/` folder when the time comes), and I'll have the proxy + AI Quote integration shipped within a week.

## Next moves on my side while you wait

- Phase 1 is shipped (v7.42.0 vendor search buttons) — usable today.
- I'll prep the Cloudflare Worker code skeleton in a `worker/` subfolder of the repo so it's ready to deploy the moment the cert arrives. No live calls until then.
- If McMaster requires more security info than the above (e.g., a specific data handling addendum), forward whatever they send and I'll draft the responses.
