// Anthropic Messages API client. Holds the API key server-side and exposes
// helpers for the two call shapes AI Quote needs:
//   - callClaude(): generic chat with optional tool use for structured output
//   - extractWithTool(): convenience wrapper that forces a tool call and
//     returns the parsed JSON arguments (the cleanest path to typed extraction)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Call Anthropic Messages API. Caller controls model + messages + tools.
 * Returns the full response object.
 */
export async function callClaude(env, { model, system, messages, tools, tool_choice, max_tokens }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY secret is not configured. Run: wrangler secret put ANTHROPIC_API_KEY');
  }
  const body = {
    model: model || env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: max_tokens || 4096,
    messages,
  };
  if (system) body.system = system;
  if (tools) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    const detail = data && data.error ? `${data.error.type}: ${data.error.message}` : `HTTP ${res.status}`;
    const err = new Error(`Anthropic API: ${detail}`);
    err.status = res.status;
    err.upstream = data;
    throw err;
  }
  return data;
}

/**
 * Force Claude to call a single tool and return its parsed input arguments.
 * Cleaner than freeform JSON-in-text because the API guarantees the args
 * match the tool's input_schema.
 *
 * @param {object} env Cloudflare Worker env
 * @param {object} opts.tool — { name, description, input_schema }
 * @param {Array}  opts.content — content blocks for the user message
 * @param {string} [opts.system] — optional system prompt
 * @param {string} [opts.model]
 * @returns parsed input object that matches the tool's input_schema
 */
export async function extractWithTool(env, { tool, content, system, model, max_tokens }) {
  const response = await callClaude(env, {
    model,
    system,
    max_tokens: max_tokens || 4096,
    messages: [{ role: 'user', content }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });
  // Find the tool_use block in the response
  const toolUse = (response.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  if (!toolUse) {
    const textBlock = (response.content || []).find(b => b.type === 'text');
    throw new Error(`Claude did not call the expected tool. Response text: ${textBlock ? textBlock.text.slice(0,200) : '(none)'}`);
  }
  return {
    data: toolUse.input,
    usage: response.usage,
    stop_reason: response.stop_reason,
    model: response.model,
  };
}

/**
 * Build a content block from an attachment dict. Attachments arrive from the
 * browser as JSON like:
 *   { name: 'rfq.pdf', mimeType: 'application/pdf', data: '<base64>' }
 * Claude vision supports PDF and image media types natively.
 */
export function attachmentToContentBlock(attachment) {
  if (!attachment) return null;
  const mime = (attachment.mimeType || '').toLowerCase();
  // v7.54: empty data = filename-only announcement. Used when the frontend
  // detected an attachment by name (e.g. via UTF-16 scan of an Outlook .msg)
  // but couldn't extract its bytes. Claude still gets the signal that a CAD
  // file is attached so it can reason about cutting/outsourcing.
  if (!attachment.data) {
    return {
      type: 'text',
      text: `[Attachment listed (file contents not provided): ${attachment.name || 'unnamed'} (${mime || 'unknown type'})]`,
    };
  }
  if (mime === 'application/pdf') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: attachment.data,
      },
    };
  }
  if (mime.startsWith('image/')) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mime,
        data: attachment.data,
      },
    };
  }
  // Anything else (text/dxf/step/csv) — pass as a text block with a label
  if (mime.startsWith('text/') || /\.(dxf|step|stp|csv|txt|json)$/i.test(attachment.name || '')) {
    let decoded = '';
    try { decoded = atob(attachment.data); } catch (_) { decoded = '(unreadable)'; }
    return {
      type: 'text',
      text: `<<<ATTACHMENT name="${attachment.name || 'unnamed'}" mimeType="${mime || 'unknown'}">>>\n${decoded.slice(0, 50000)}\n<<<END ATTACHMENT>>>`,
    };
  }
  // Binary formats we can't read (SLDPRT, STL) — just note their existence
  return {
    type: 'text',
    text: `[Attachment present but not readable by Claude: ${attachment.name || 'unnamed'} (${mime || 'unknown mime'})]`,
  };
}
