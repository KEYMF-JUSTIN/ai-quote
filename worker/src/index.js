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
        ? `ATTACHMENTS follow below. Read drawings carefully — extract part numbers, dimensions, material specs, finish callouts, tolerances, quantities, and any due date / lead time mentioned.`
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
// Input  : { docType, hint, attachments: [{name, mimeType, data}], context }
//   docType   - optional hint: 'receipt' | 'invoice' | 'packing_slip' | 'drawing' | 'po' | null (auto-detect)
//   hint      - free-text context: "this came from Alro", "scanned with phone"
//   context   - optional structured context the frontend wants Claude to consider
//                  e.g. { recentJobs: [...], activeQuoteId: '...' }
// Output : { detected_doc_type, vendor, lineItems[], totals, references, dates, ... }
// =================================================================
async function handleExtractDocument(env, body) {
  if (!body || typeof body !== 'object') throw badRequest('Body must be JSON');
  const docTypeHint = body.docType || null;
  const hint = body.hint || '';
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const context = body.context || null;
  if (attachments.length === 0) throw badRequest('At least one attachment is required');

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
      context ? `\nADDITIONAL CONTEXT FROM THE APP:\n${JSON.stringify(context).slice(0, 2000)}` : '',
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
            orderNum:    { type: 'string' },
            poNum:       { type: 'string' },
            invoiceNum:  { type: 'string' },
            packingNum:  { type: 'string' },
            rfqNum:      { type: 'string' },
            jobKeyword:  { type: 'string', description: 'A user-tagged keyword like JOB-9876 that links this purchase to one of KMF\'s jobs' },
            customerPO:  { type: 'string' },
          },
        },
        dates: {
          type: 'object',
          properties: {
            orderDate:    { type: 'string' },
            shipDate:     { type: 'string' },
            invoiceDate:  { type: 'string' },
            dueDate:      { type: 'string' },
            receivedDate: { type: 'string' },
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

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
