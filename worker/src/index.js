// AI Quote — Cloudflare Worker
// Routes:
//   GET  /api/health                  — sanity check + version info
//   POST /api/claude/extract-rfq      — parse RFQ email + attachments into structured quote data
//   POST /api/claude/extract-document — generic doc extraction (receipts, packing slips, drawings, POs)
//
// The Worker holds ANTHROPIC_API_KEY as a Cloudflare secret (set via
//   wrangler secret put ANTHROPIC_API_KEY
// ) so the browser never sees it. CORS is locked to ALLOWED_ORIGIN (set
// in wrangler.toml [vars] section).
//
// Adding a new endpoint? Wire it under handleRequest's switch, then add
// a handler in this file. Keep handlers thin — push Claude-specific logic
// into ./claude.js to stay testable.

import { handlePreflight, jsonResponse, errorResponse } from './cors.js';
import { extractWithTool, attachmentToContentBlock } from './claude.js';

const WORKER_VERSION = '0.1.0';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('origin');

    if (request.method === 'OPTIONS') return handlePreflight(request, env);

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, ''); // strip trailing slash

      // GET /api/health — sanity check, also lets the frontend detect "is Worker reachable"
      if (request.method === 'GET' && path === '/api/health') {
        return jsonResponse({
          ok: true,
          worker_version: WORKER_VERSION,
          model: env.CLAUDE_MODEL,
          model_fast: env.CLAUDE_MODEL_FAST,
          allowed_origin: env.ALLOWED_ORIGIN,
          has_anthropic_key: !!env.ANTHROPIC_API_KEY,
          time: new Date().toISOString(),
        }, 200, env, origin);
      }

      // POST /api/claude/extract-rfq
      if (request.method === 'POST' && path === '/api/claude/extract-rfq') {
        const body = await request.json();
        const result = await handleExtractRfq(env, body);
        return jsonResponse(result, 200, env, origin);
      }

      // POST /api/claude/extract-document
      if (request.method === 'POST' && path === '/api/claude/extract-document') {
        const body = await request.json();
        const result = await handleExtractDocument(env, body);
        return jsonResponse(result, 200, env, origin);
      }

      // POST /api/claude/estimate-outside-service
      if (request.method === 'POST' && path === '/api/claude/estimate-outside-service') {
        const body = await request.json();
        const result = await handleEstimateOutsideService(env, body);
        return jsonResponse(result, 200, env, origin);
      }

      // POST /api/claude/extract-entity
      // Drop-anywhere pipeline: any feature that adds a record (vendor, customer,
      // future: contact, material, part) can drop a file (PDF / image / .msg /
      // plain text) at this endpoint to get back structured field values.
      if (request.method === 'POST' && path === '/api/claude/extract-entity') {
        const body = await request.json();
        const result = await handleExtractEntity(env, body);
        return jsonResponse(result, 200, env, origin);
      }

      return errorResponse(`Not found: ${request.method} ${path}`, 404, env, origin);
    } catch (err) {
      console.error('worker error', err && err.stack || err);
      const status = err && err.status ? err.status : 500;
      return errorResponse(
        (err && err.message) || 'Internal error',
        status,
        env,
        origin,
        // Include upstream diagnostic detail (no PII — just API error category) for debugging
        err && err.upstream ? { upstream_detail: err.upstream } : undefined
      );
    }
  },
};

// =================================================================
// /api/claude/extract-rfq
// Input  : { sender, senderEmail, subject, sentDate, body, attachments: [{name, mimeType, data}] }
// Output : { customer, parts[], notes, urgency, dueDate, summary, model, usage }
// =================================================================
async function handleExtractRfq(env, body) {
  if (!body || typeof body !== 'object') throw badRequest('Body must be JSON');
  const email = {
    sender: body.sender || '',
    senderEmail: body.senderEmail || '',
    subject: body.subject || '',
    sentDate: body.sentDate || '',
    body: body.body || '',
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
  };

  // Build the content blocks: text summary of the email + attachments as documents/images
  const contentBlocks = [];
  contentBlocks.push({
    type: 'text',
    text: [
      `You are analyzing an incoming RFQ (Request For Quote) email at Keystone Machine & Fab, a precision machining + fabrication shop in Cuyahoga Falls, OH.`,
      ``,
      `Extract structured quote data. The email may include attached engineering drawings (PDFs), parts lists, or specifications.`,
      ``,
      `EMAIL HEADERS:`,
      `  From name:   ${email.sender || '(unknown)'}`,
      `  From email:  ${email.senderEmail || '(unknown)'}`,
      `  Subject:     ${email.subject || '(none)'}`,
      `  Sent date:   ${email.sentDate || '(unknown)'}`,
      `  Attachments: ${email.attachments.length ? email.attachments.map(a => `${a.name} (${a.mimeType})`).join(', ') : 'none'}`,
      ``,
      `EMAIL BODY:`,
      `${email.body || '(empty)'}`,
      ``,
      email.attachments.length
        ? `ATTACHMENTS follow below. Read drawings carefully — extract part numbers, dimensions, material specs, finish callouts, tolerances, quantities, and any due date / lead time mentioned. IMPORTANT: if ANY CAD attachments are listed (DWG, DXF, STEP, STP, IGES, etc.), that is a strong signal the customer wants outside cutting (laser/waterjet/plasma/wire-EDM). Populate dxfSuggestions[] with one entry per CAD attachment EVEN IF the email body does not explicitly say "cut" — a flat-part CAD file attached to an RFQ almost always means cutting work. For non-CAD attachments (PDFs), only suggest a DXF entry if the PDF is a drawing showing a flat part with cutting callouts.`
        : `No attachments. Extract whatever you can from the email body alone.`,
    ].join('\n'),
  });
  // Attach each file as its own content block
  for (const att of email.attachments) {
    const block = attachmentToContentBlock(att);
    if (block) contentBlocks.push(block);
  }

  const tool = {
    name: 'submit_extracted_rfq',
    description: 'Submit the structured RFQ data extracted from the email and attachments. ALL fields are optional — leave blank/null whatever you cannot confidently determine. Be conservative: a wrong value is worse than a missing one.',
    input_schema: {
      type: 'object',
      properties: {
        customer: {
          type: 'object',
          description: 'Customer / sender info inferred from email headers + signature block.',
          properties: {
            companyName:  { type: 'string', description: 'Company name (NOT the person — e.g. "Acme Manufacturing", not "John Smith")' },
            contactName:  { type: 'string', description: 'Person who sent the RFQ' },
            contactEmail: { type: 'string', description: 'Sender\'s email address' },
            contactPhone: { type: 'string', description: 'Phone from signature, if any' },
            role:         { type: 'string', description: 'Their job title / role if visible (Buyer, Engineer, Purchasing Manager, etc.)' },
            confidence:   { type: 'string', enum: ['high','medium','low'], description: 'How confident you are in the company identification' },
          },
        },
        rfqRef:    { type: 'string', description: 'Customer\'s RFQ / inquiry number if mentioned' },
        dueDate:   { type: 'string', description: 'When they need a quote back OR when they need parts delivered. Use natural language if not ISO.' },
        urgency:   { type: 'string', enum: ['low','normal','high','urgent'], description: 'Tone-based urgency assessment' },
        parts: {
          type: 'array',
          description: 'Each distinct part being quoted. If the email asks for one part in multiple quantities, that\'s ONE part with qtyBreaks; multi-part RFQs become multiple entries.',
          items: {
            type: 'object',
            properties: {
              partNum:        { type: 'string', description: 'Customer\'s part number, if visible' },
              customerPN:     { type: 'string', description: 'Same as partNum unless KMF has a separate internal number' },
              description:    { type: 'string', description: 'Short description (e.g. "1.250 OD flange, 4 hole bolt pattern")' },
              material:       { type: 'string', description: 'Material spec as stated (4140, 304 SS, 6061-T6, etc.)' },
              dimensions:     { type: 'string', description: 'Free-form dimensions if not parsed into form/L/W/H below' },
              form:           { type: 'string', enum: ['Bar/Block','Round','Sheet','Tube','Other',''], description: 'Stock form if determinable' },
              partLengthIn:   { type: 'number', description: 'Finished length in inches' },
              partWidthIn:    { type: 'number', description: 'Finished width in inches (or OD for Round)' },
              partHeightIn:   { type: 'number', description: 'Finished height/thickness in inches' },
              qtyBreaks:      { type: 'array', items: { type: 'number' }, description: 'Quantity tiers requested (e.g. [10, 25, 100])' },
              dueDate:        { type: 'string', description: 'Per-part delivery date if it differs from the RFQ-level due date' },
              tolerances:     { type: 'string', description: 'Tolerance callouts (e.g. "±.005 unless noted", "GD&T per drawing")' },
              finish:         { type: 'string', description: 'Surface finish / coating (anodize, plate, paint, etc.)' },
              certs:          { type: 'string', description: 'Cert requirements (AWS D1.1, NADCAP, FAI, material certs, etc.)' },
              notes:          { type: 'string', description: 'Anything else the estimator needs to know about this specific part' },
              sourceDocs:     { type: 'array', items: { type: 'string' }, description: 'Filenames of attached drawings/specs that describe THIS part' },
            },
          },
        },
        summary: { type: 'string', description: 'One-paragraph (≤3 sentence) plain-English summary of what the customer is asking for — what the estimator will read first.' },
        redFlags: { type: 'array', items: { type: 'string' }, description: 'Things that warrant human attention: "no quantity stated", "drawing is unreadable", "material call-out is ambiguous", "competitor mentioned", "lead time impossible", etc.' },
        dxfSuggestions: {
          type: 'array',
          description: 'Suggest one entry per distinct CAD/cut file the customer wants outside-cut. STRONG TRIGGERS (always populate when seen): (a) ANY CAD attachment listed (DWG, DXF, STEP, STP, IGES, SLDPRT) — these almost always mean cutting work; populate one entry per attachment. (b) Email/drawing language explicitly mentioning cutting: "laser-cut", "waterjet", "plasma", "wire EDM", "flame cut", "burn out", "cut from plate". (c) Drawings showing flat parts with cutting callouts. WEAKER TRIGGERS (suggest with low confidence): flat-plate parts that LOOK like they\'d be cut (rectangular plates with bolt patterns, gussets, mounting brackets) even without explicit cut language. Each entry can be one-click added to a part\'s DXF Cut Files list and then estimated via /api/claude/estimate-outside-service.',
          items: {
            type: 'object',
            properties: {
              filename:        { type: 'string', description: 'Suggested filename for the DXF (use attachment name if a DXF was sent; otherwise infer from part #)' },
              partIndex:       { type: 'number', description: '0-based index into parts[] for which part this DXF belongs to. If unsure, default to 0 (first part).' },
              suggestedProcess:{ type: 'string', enum: ['laser','waterjet','plasma','wire_edm','sinker_edm','oxy_fuel','shear','turret','machining','other',''], description: 'Best-fit cut process from email/drawing language' },
              qtyPerPart:      { type: 'number', description: 'How many copies of this DXF go into ONE finished part (default 1 — most parts have one blank cut per assembly)' },
              materialNote:    { type: 'string', description: 'Material spec specific to this cut entry if differs from the part-level material (e.g. "1/4 A36 plate")' },
              thicknessIn:     { type: 'number', description: 'Plate thickness in inches if mentioned' },
              notes:           { type: 'string', description: 'Anything else the estimator needs (tolerance class, edge prep, post-cut treatment, single-side vs both, etc.)' },
              reasoning:       { type: 'string', description: 'Why you suggested this (quote the email language or drawing call-out)' },
            },
          },
        },
      },
      required: ['summary'],
    },
  };

  const result = await extractWithTool(env, {
    tool,
    content: contentBlocks,
    system: `You extract structured RFQ data for a precision machining shop's estimating tool. Be conservative — if a value is ambiguous, leave it blank and add a redFlags entry. Always provide a concise summary so the human estimator can see at a glance what arrived.`,
    max_tokens: 4096,
  });

  return {
    parsed: result.data,
    model: result.model,
    usage: result.usage,
    stop_reason: result.stop_reason,
  };
}

// =================================================================
// /api/claude/extract-document
// Generic doc extraction. Used for: vendor receipts/invoices, packing slips,
// engineering drawings, customer POs. Output schema is intentionally loose
// so the frontend can branch on docType.
// Input  : { docType, hint, attachments: [{name, mimeType, data}], context, priorSamples }
//   docType      - optional hint: 'receipt' | 'invoice' | 'packing_slip' | 'drawing' | 'po' | null (auto-detect)
//   hint         - free-text context: "this came from Alro", "scanned with phone"
//   context      - optional structured context the frontend wants Claude to consider
//                     e.g. { recentJobs: [...], activeQuoteId: '...' }
//   priorSamples - v7.65: array of { entityName, docType, parsedFields, notes }
//                  from earlier user-labeled samples for the SAME entity. Injected
//                  as few-shot examples so Claude sees exactly how this vendor's
//                  docs map to fields. Quality of extraction jumps with each
//                  labeled sample — that's the payoff of the training capture.
// Output : { detected_doc_type, vendor, lineItems[], totals, references, dates, ... }
// =================================================================
async function handleExtractDocument(env, body) {
  if (!body || typeof body !== 'object') throw badRequest('Body must be JSON');
  const docTypeHint = body.docType || null;
  const hint = body.hint || '';
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const context = body.context || null;
  const priorSamples = Array.isArray(body.priorSamples) ? body.priorSamples : [];
  if (attachments.length === 0) throw badRequest('At least one attachment is required');

  // v7.65: build few-shot examples from prior labeled samples. We prefer
  // samples of the same docType (most relevant), but include up to 5 total
  // even if other types — they still demonstrate the entity's conventions.
  // Cap each sample's JSON to ~1500 chars so we don't blow the prompt budget
  // (5 samples * 1500 chars = ~7.5KB of prompt overhead, very reasonable).
  let fewShotBlock = '';
  if (priorSamples.length > 0) {
    const sorted = [...priorSamples].sort((a, b) => {
      const aMatch = a.docType === docTypeHint ? 0 : 1;
      const bMatch = b.docType === docTypeHint ? 0 : 1;
      return aMatch - bMatch;  // same-type samples first
    }).slice(0, 5);
    const entityName = sorted[0] && sorted[0].entityName ? sorted[0].entityName : 'this entity';
    fewShotBlock = [
      ``,
      `=== ${sorted.length} PREVIOUSLY LABELED EXAMPLE${sorted.length===1?'':'S'} FROM ${entityName.toUpperCase()} ===`,
      `These are real docs from the same entity, extracted previously and corrected by the user.`,
      `They show the EXACT field conventions this entity uses (where the quote # lives, how line`,
      `items are structured, what their vendor name looks like, etc.). Use them as your guide.`,
      ``,
      ...sorted.map((s, i) => {
        // v7.66: pull _fieldHints out so they get their own dedicated section
        // (location/label hints the user marked via drag-box on the PDF).
        // The remaining parsedFields show field structure + actual values.
        const parsed = s.parsedFields || {};
        const fieldHints = parsed._fieldHints || null;
        const parsedNoHints = { ...parsed };
        delete parsedNoHints._fieldHints;
        const json = JSON.stringify(parsedNoHints, null, 2);
        const trimmed = json.length > 1500 ? json.slice(0, 1500) + '\n  ...(truncated)...\n}' : json;
        let hintsBlock = '';
        if (fieldHints && typeof fieldHints === 'object' && Object.keys(fieldHints).length > 0) {
          const hintLines = Object.entries(fieldHints).map(([key, h]) => {
            if (!h) return '';
            const labelHint = h.nearbyText ? ` · adjacent label/text: "${String(h.nearbyText).slice(0, 100)}"` : '';
            const valHint   = h.value      ? ` · captured value: "${String(h.value).slice(0, 80)}"` : ' · (value blank on this teaching sample — location-only hint)';
            const posHint   = h.bounds     ? ` · page ${h.bounds.page||1}, box ~(${Math.round(h.bounds.left)},${Math.round(h.bounds.top)})-(${Math.round(h.bounds.right)},${Math.round(h.bounds.bottom)})` : '';
            return `      ${key}${labelHint}${valHint}${posHint}`;
          }).filter(Boolean);
          if (hintLines.length > 0) {
            hintsBlock = [
              `   FIELD LOCATION HINTS (user-marked via drag-box on the PDF):`,
              ...hintLines,
            ].join('\n');
          }
        }
        return [
          `--- EXAMPLE ${i+1}: ${s.docType || 'unknown type'}${s.notes ? ' · note: ' + s.notes : ''} ---`,
          trimmed,
          hintsBlock,
          ``,
        ].filter(Boolean).join('\n');
      }),
      `=== END EXAMPLES ===`,
      ``,
      `Now extract the NEW document attached below using the same field shape and conventions.`,
      `Where the new doc has values the examples don't have, infer reasonably. Where structure is`,
      `ambiguous, follow the examples' precedent.`,
      ``,
      `IMPORTANT — about FIELD LOCATION HINTS in the examples above:`,
      `The user marked specific regions on prior docs to teach you WHERE each field appears`,
      `on this entity's documents. The "adjacent label/text" tells you what nearby text to look`,
      `for. The "captured value" shows what the value looked like (blank if the field was empty`,
      `on that teaching sample — but the location hint still applies). The box coordinates give`,
      `the approximate page-region. Use these hints to find the same field on the NEW document,`,
      `even if the layout is slightly different — labels are more reliable than coordinates.`,
      ``,
    ].join('\n');
  }

  const contentBlocks = [];
  contentBlocks.push({
    type: 'text',
    text: [
      `You are processing a document for Keystone Machine & Fab's internal operations tool.`,
      docTypeHint ? `The user says this is a: ${docTypeHint}.` : `The user has NOT specified the document type — identify it yourself.`,
      hint ? `User-provided context: ${hint}` : '',
      ``,
      `Document(s) attached below. Identify the document type, then extract structured data appropriate to that type.`,
      ``,
      `Document types we handle:`,
      `  - receipt       — store receipt (Home Depot, Lowe's, gas station, etc.)`,
      `  - invoice       — vendor invoice (Alro, McMaster, Grainger)`,
      `  - packing_slip  — vendor packing slip received with shipped material`,
      `  - drawing       — engineering drawing / print of a part`,
      `  - po            — purchase order (customer's PO to us, or our PO to a vendor)`,
      `  - other         — anything else (be specific in detected_doc_type)`,
      ``,
      `For each line item / part on the doc, extract qty, description, unit price, and total.`,
      `For drawings, extract part number, material, dimensions, tolerances, finish, GD&T flags, and any title-block info.`,
      `If the document references a keyword that looks like a job number (JOB-1234) or RFQ number (RFQ-5678), surface it under references.`,
      ``,
      `CRITICAL — UNIFIED FIELD NAMES: The downstream training wizard reads from these unified fields, ALWAYS populate them:`,
      `  - references.docNum  ← the PRIMARY identifier shown on this doc (whatever the doc calls it: Order #, Invoice #, Quote #, RFQ #, Packing #, Receipt #). Copy the value into the type-specific field too (e.g. also set references.orderNum for an order confirmation) for back-compat, but docNum is the one the UI reads.`,
      `  - dates.docDate      ← the date the doc was issued / printed. Same value also goes in the type-specific date field (orderDate, invoiceDate, etc.).`,
      `Other fields (poNum, customerPO, shipDate, dueDate, tracking, etc.) should be filled if the doc shows them. Never leave docNum / docDate blank if the doc has them visible.`,
      context ? `\nADDITIONAL CONTEXT FROM THE APP:\n${JSON.stringify(context).slice(0, 2000)}` : '',
      fewShotBlock,  // v7.65: prior training samples injected here
    ].filter(Boolean).join('\n'),
  });
  for (const att of attachments) {
    const block = attachmentToContentBlock(att);
    if (block) contentBlocks.push(block);
  }

  const tool = {
    name: 'submit_extracted_document',
    description: 'Submit the structured data extracted from the attached document(s). Leave fields blank/null where the document does not provide information.',
    input_schema: {
      type: 'object',
      properties: {
        detected_doc_type: { type: 'string', description: 'receipt | invoice | packing_slip | drawing | po | other (be specific)' },
        confidence:        { type: 'string', enum: ['high','medium','low'] },
        vendor: {
          type: 'object',
          properties: {
            name:    { type: 'string' },
            address: { type: 'string' },
            phone:   { type: 'string' },
          },
        },
        references: {
          type: 'object',
          description: 'Identifiers found on the document — order #, PO #, invoice #, RFQ #, job # keyword, etc.',
          properties: {
            docNum:      { type: 'string', description: 'PRIMARY IDENTIFIER for this doc — populate this regardless of the doc type. Whatever the doc calls it: Order #, Invoice #, Quote #, RFQ #, Packing Slip #, Receipt #. This is the field downstream training reads from.' },
            orderNum:    { type: 'string', description: 'Same value as docNum when the doc is an order confirmation (back-compat)' },
            poNum:       { type: 'string', description: 'Customer\'s PO# (their reference to us), not our PO# — see customerPO too' },
            invoiceNum:  { type: 'string', description: 'Same value as docNum when the doc is an invoice (back-compat)' },
            packingNum:  { type: 'string', description: 'Same value as docNum when the doc is a packing slip (back-compat)' },
            rfqNum:      { type: 'string', description: 'Same value as docNum when the doc is a customer RFQ (back-compat)' },
            tracking:    { type: 'string', description: 'Carrier tracking number (UPS / FedEx / etc.) on packing slips' },
            jobKeyword:  { type: 'string', description: 'A user-tagged keyword like JOB-9876 that links this purchase to one of KMF\'s jobs' },
            customerPO:  { type: 'string' },
          },
        },
        dates: {
          type: 'object',
          properties: {
            docDate:      { type: 'string', description: 'PRIMARY DATE for this doc — the date it was issued / printed. Populate this regardless of doc type. The wizard reads from here.' },
            orderDate:    { type: 'string', description: 'Same as docDate when the doc is an order confirmation (back-compat)' },
            shipDate:     { type: 'string', description: 'Date shipped (packing slips / order confirmations only)' },
            invoiceDate:  { type: 'string', description: 'Same as docDate when the doc is an invoice (back-compat)' },
            dueDate:      { type: 'string', description: 'Payment due date (invoices) OR quote expiration date OR customer-required ship date' },
            receivedDate: { type: 'string', description: 'Date the doc was received at KMF (often left blank — receiving fills this)' },
          },
        },
        lineItems: {
          type: 'array',
          description: 'Each row on the document — what was bought / shipped / received',
          items: {
            type: 'object',
            properties: {
              description:   { type: 'string' },
              partNum:       { type: 'string' },
              vendorPartNum: { type: 'string' },
              qty:           { type: 'number' },
              unitOfMeasure: { type: 'string', description: 'each / lb / ft / bar / sheet / pack' },
              unitPrice:     { type: 'number' },
              extended:      { type: 'number' },
              notes:         { type: 'string' },
            },
          },
        },
        totals: {
          type: 'object',
          properties: {
            subtotal: { type: 'number' },
            tax:      { type: 'number' },
            shipping: { type: 'number' },
            total:    { type: 'number' },
            currency: { type: 'string' },
          },
        },
        drawing: {
          type: 'object',
          description: 'Only populate if detected_doc_type is "drawing"',
          properties: {
            partNum:     { type: 'string' },
            revision:    { type: 'string' },
            title:       { type: 'string' },
            material:    { type: 'string' },
            finish:      { type: 'string' },
            tolerances:  { type: 'string' },
            dimensions:  { type: 'string' },
            keyFeatures: { type: 'array', items: { type: 'string' } },
            scale:       { type: 'string' },
            units:       { type: 'string', enum: ['in','mm',''] },
          },
        },
        summary:  { type: 'string', description: 'One-paragraph plain-English summary of what this document is and what action the user might take.' },
        redFlags: { type: 'array', items: { type: 'string' }, description: 'Anything unusual: discrepancies, unreadable sections, missing info that should be there.' },
      },
      required: ['detected_doc_type', 'summary'],
    },
  };

  const result = await extractWithTool(env, {
    tool,
    content: contentBlocks,
    system: `You extract structured data from business documents for a precision machining shop. Be precise on numbers (qty, prices), conservative on inferences. If you can\'t read a value clearly, leave it blank rather than guess.`,
    max_tokens: 4096,
  });

  return {
    parsed: result.data,
    model: result.model,
    usage: result.usage,
    stop_reason: result.stop_reason,
  };
}

// =================================================================
// /api/claude/estimate-outside-service
// Industry-rule-of-thumb cost estimate for outside cutting/EDM/finishing.
// Used by the DXF Cut Files card to populate a ballpark $/piece + setup
// BEFORE the vendor returns a real quote — KMF can quote the customer
// same-day instead of waiting on Alro/cut-house email turnaround.
//
// Input  : { process, material, thicknessIn, lengthIn, widthIn,
//            cutLengthIn?, pierceCount?, qty, vendorName?, notes? }
// Output : { perPieceEstimate, setupEstimate, leadTimeDays,
//            confidence, reasoning, ruleOfThumb, redFlags }
//
// Be conservative — Claude's output is a SANITY-CHECK ballpark, not a
// vendor commitment. UI surfaces it clearly as AI-estimated.
// =================================================================
async function handleEstimateOutsideService(env, body) {
  if (!body || typeof body !== 'object') throw badRequest('Body must be JSON');
  if (!body.process) throw badRequest('process is required');
  if (!body.qty) throw badRequest('qty is required');

  const inputs = {
    process:      body.process,
    material:     body.material || '',
    thicknessIn:  num(body.thicknessIn),
    lengthIn:     num(body.lengthIn),
    widthIn:      num(body.widthIn),
    cutLengthIn:  body.cutLengthIn != null ? num(body.cutLengthIn) : null,
    pierceCount:  body.pierceCount != null ? num(body.pierceCount) : null,
    qty:          num(body.qty),
    vendorName:   body.vendorName || '',
    notes:        body.notes || '',
  };

  // Compose the prompt — give Claude the inputs and let it apply known
  // industry rules of thumb for the named process. Region: NE Ohio (KMF
  // location) so rates reflect that market.
  const userText = [
    `Estimate the outside-service cost for the following cut/EDM/finishing job at a precision machining shop in NE Ohio (Cuyahoga Falls, OH).`,
    ``,
    `Job specs:`,
    `  Process:          ${inputs.process}`,
    `  Material:         ${inputs.material || '(not specified)'}`,
    `  Thickness:        ${inputs.thicknessIn ? inputs.thicknessIn + ' in' : '(not specified)'}`,
    `  Part L × W:       ${inputs.lengthIn || '?'} × ${inputs.widthIn || '?'} in`,
    inputs.cutLengthIn  ? `  Cut length:       ${inputs.cutLengthIn} in (total linear)` : '',
    inputs.pierceCount  ? `  Pierces / starts: ${inputs.pierceCount}` : '',
    `  Quantity:         ${inputs.qty}`,
    inputs.vendorName   ? `  Vendor target:    ${inputs.vendorName}` : '',
    inputs.notes        ? `  Notes:            ${inputs.notes}` : '',
    ``,
    `Apply published / commonly-cited industry rules of thumb for ${inputs.process} in the Midwest US market:`,
    `  - Waterjet:  $1.50–$4.00/in² depending on material+thickness, plus $10–$25 setup/program, plus $0.50–$2 per pierce`,
    `  - Wire EDM:  $1.00–$3.00/hr at typical cut speeds 2–15 in²/hr depending on material+thickness, plus $50–$150 setup`,
    `  - Laser:     $0.50–$2.00/in² depending on material+thickness (thin sheet metal cheapest), plus $10–$30 setup`,
    `  - Plasma:    $0.30–$1.00/in² on plate, plus $10–$30 setup (rough edges vs laser, post-cut prep may be needed)`,
    `  - Oxy-fuel:  Thick plate only (>3/8"), ~$0.20–$0.60/in² + $20 setup`,
    ``,
    `Compute area = L × W (then × 2 for both-side processes). If cut length not provided, estimate from part perimeter.`,
    `Be conservative. If thickness or material is missing, note that the estimate has a wider range. Flag any inputs that are inconsistent or suspicious in redFlags.`,
  ].filter(Boolean).join('\n');

  const tool = {
    name: 'submit_estimate',
    description: 'Return the structured cost estimate for the outside-service job described above.',
    input_schema: {
      type: 'object',
      properties: {
        perPieceEstimate: { type: 'number', description: 'Most-likely $/piece (midpoint of the realistic range)' },
        perPieceRangeLow: { type: 'number', description: 'Low end of the $/piece range' },
        perPieceRangeHigh:{ type: 'number', description: 'High end of the $/piece range' },
        setupEstimate:    { type: 'number', description: 'One-time setup / programming charge in $' },
        leadTimeDays:     { type: 'number', description: 'Typical lead time in business days for this process + qty' },
        confidence:       { type: 'string', enum: ['high','medium','low'], description: 'How tight the range is — high = ±20%, medium = ±50%, low = guess based on incomplete info' },
        reasoning:        { type: 'string', description: 'One-paragraph plain-English walk-through of the math (area, per-area rate, pierce charges, setup, qty multiplier) so the estimator can sanity-check' },
        ruleOfThumb:      { type: 'string', description: 'The specific rule-of-thumb you applied (e.g. "Waterjet 1/4 mild steel ~$2.50/in² + 15min setup")' },
        redFlags:         { type: 'array', items: { type: 'string' }, description: 'Missing/inconsistent inputs, or "vendor confirmation recommended" notes' },
      },
      required: ['perPieceEstimate', 'reasoning', 'confidence'],
    },
  };

  const result = await extractWithTool(env, {
    tool,
    content: [{ type: 'text', text: userText }],
    system: `You estimate outside-service costs for a precision machining + fabrication shop (KMF, Cuyahoga Falls, OH). Apply documented industry rules of thumb for the Midwest US market. Be conservative — your output is a sanity-check ballpark, not a vendor commitment. Always include redFlags for any inputs that are missing or look off.`,
    model: env.CLAUDE_MODEL,
    max_tokens: 2048,
  });

  return {
    estimate: result.data,
    inputs,
    model: result.model,
    usage: result.usage,
  };
}

// =================================================================
// /api/claude/extract-entity
// Generic "drop-a-file-to-prefill" extraction for any place in the UI
// where the user is creating a record (vendor, customer, future: contact,
// material, part, etc.). The frontend hands us the entityType + the
// dropped file(s), we hand back a structured object whose keys match the
// wizard draft schema for that entity.
//
// Why this exists: see v7.70 in index.html. Drag-and-drop-to-prefill is
// a first-class principle in this app — every new wizard / add-form gets
// it. Adding a new entity type? Extend ENTITY_SCHEMAS below and the
// frontend will pick it up automatically.
//
// Input  : { entityType: 'vendor'|'customer', attachments: [{name, mimeType, data}], hint? }
// Output : { parsed: {...matches wizard draft shape}, model, usage }
// =================================================================
const ENTITY_SCHEMAS = {
  customer: {
    name: 'submit_extracted_customer',
    description: 'Submit the structured customer-record data extracted from the dropped document. The user is adding a new CUSTOMER (a buyer who places orders at our machine shop). ALL fields are optional — leave blank/null anything you cannot confidently determine. A wrong value is worse than a missing one.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Company name. NOT a person — e.g. "Acme Manufacturing", not "Sarah Lee".' },
        code:        { type: 'string', description: 'Short alphanumeric code if visible (rare on emails, common on POs). e.g. "ACME-01"' },
        contact:     { type: 'string', description: 'Primary contact person — usually the email signer or buyer name on the PO.' },
        email:       { type: 'string', description: 'Best email address for this customer (their domain, not gmail.com unless that\'s clearly business).' },
        phone:       { type: 'string', description: 'Phone number from signature, header, or letterhead.' },
        billStreet:  { type: 'string', description: 'Billing street address (or just "address" if only one is given).' },
        billCity:    { type: 'string' },
        billState:   { type: 'string', description: '2-letter US state code (PA, OH, MI, etc.) when possible.' },
        billZip:     { type: 'string' },
        shipSameAsBill: { type: 'boolean', description: 'True if no separate ship-to address is given.' },
        shipStreet:  { type: 'string', description: 'Only set if a distinct shipping address is shown (different from billing).' },
        shipCity:    { type: 'string' },
        shipState:   { type: 'string' },
        shipZip:     { type: 'string' },
        salesRep:    { type: 'string', description: 'If document mentions which of our salespeople owns this account.' },
        paymentTerms:{ type: 'string', description: 'e.g. "Net 30", "Due on receipt", "COD".' },
        notes:       { type: 'string', description: 'One short sentence summarizing anything unusual or worth remembering.' },
      },
    },
    promptIntro: `You are pre-filling a "+ Add Customer" form at Keystone Machine & Fab, a precision machining shop. The user has dropped a file (RFQ email, PO, letterhead, business card, screenshot, etc.) and wants the customer's contact + address info extracted into the form fields. Be conservative — only populate fields you can read with confidence. Leave the rest blank.`,
  },
  vendor: {
    name: 'submit_extracted_vendor',
    description: 'Submit the structured vendor-record data extracted from the dropped document. The user is adding a new VENDOR (a supplier we BUY from — steel mill, plating shop, tooling distributor, laser cutting service, etc.). ALL fields are optional — leave blank/null what you cannot determine.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Vendor company name. NOT a person.' },
        contact:     { type: 'string', description: 'Sales rep / contact person name.' },
        email:       { type: 'string' },
        phone:       { type: 'string' },
        fax:         { type: 'string', description: 'Only if explicitly labeled.' },
        accountNum:  { type: 'string', description: 'OUR account # with them (often shown on quotes / invoices addressed to Keystone Machine & Fab).' },
        address:     { type: 'string', description: 'Full mailing address as one string, comma-separated.' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['material','cut','finishing','tooling'] },
          description: 'What categories this vendor supplies. INFER from the document: a steel mill catalog → ["material"]; a laser cutting flyer → ["cut"]; a plating shop quote → ["finishing"]; a tooling distributor (McMaster, MSC, KBC) → ["material","tooling"]. Choose 1-3 categories — most vendors specialize.',
        },
        services: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific service slugs the document indicates this vendor offers. Pick from: laser, waterjet, plasma, wire_edm, sinker_edm, oxy_fuel, shear, machining, turret, heat_treat, black_oxide, anodize, paint, powder_coat, plating, passivate, deburring, media_blast, grinding, bending, rolling, welding, assembly, inspection, kitting, engraving, silkscreen. Empty if the document doesn\'t make this clear.',
        },
        notes:       { type: 'string', description: 'One sentence on lead times / specialty / anything unusual.' },
      },
    },
    promptIntro: `You are pre-filling a "+ Add Vendor" form at Keystone Machine & Fab, a precision machining shop. The user has dropped a file (vendor quote, invoice, business card, website screenshot, capability sheet, email signature, etc.) and wants the supplier's info extracted. Identify WHAT they supply (material / cut / finishing / tooling) and which specific services. Be conservative — only populate fields you can read with confidence.`,
  },
};

async function handleExtractEntity(env, body) {
  if (!body || typeof body !== 'object') throw badRequest('Body must be JSON');
  const entityType = body.entityType;
  if (!entityType || !ENTITY_SCHEMAS[entityType]) {
    throw badRequest(`Unknown entityType: ${entityType}. Supported: ${Object.keys(ENTITY_SCHEMAS).join(', ')}`);
  }
  const schema = ENTITY_SCHEMAS[entityType];
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const hint = (body.hint || '').toString().slice(0, 2000);

  // Build content blocks
  const contentBlocks = [];
  contentBlocks.push({
    type: 'text',
    text: [
      schema.promptIntro,
      '',
      hint ? `USER HINT: ${hint}` : '',
      attachments.length
        ? `Files dropped (${attachments.length}): ${attachments.map(a => `${a.name} (${a.mimeType || 'unknown type'})`).join(', ')}`
        : `No files attached — extract from the hint text only.`,
    ].filter(Boolean).join('\n'),
  });
  for (const att of attachments) {
    const block = attachmentToContentBlock(att);
    if (block) contentBlocks.push(block);
  }

  if (contentBlocks.length === 1 && !hint) {
    throw badRequest('No content to extract from (no attachments and no hint).');
  }

  const result = await extractWithTool(env, {
    tool: { name: schema.name, description: schema.description, input_schema: schema.input_schema },
    content: contentBlocks,
    model: body.model || env.CLAUDE_MODEL,
    max_tokens: 2048,
  });

  return {
    parsed: result.data,
    entityType,
    model: result.model,
    usage: result.usage,
  };
}

// Local num() — mirrors the frontend helper for null/empty/NaN safety
function num(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
