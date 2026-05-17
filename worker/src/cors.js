// CORS helpers. Locks API access to the AI Quote frontend origin and
// echoes back the request's Authorization-style headers so the browser
// fetch() doesn't reject the response.

export function corsHeaders(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  // Allow either the configured origin or null (for file:// previews during dev)
  const allowOrigin = (origin && (origin === allowed || allowed === '*')) ? origin : allowed;
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-aiq-client-version',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

export function handlePreflight(request, env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env, request.headers.get('origin')),
  });
}

export function jsonResponse(body, status, env, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(env, origin),
    },
  });
}

export function errorResponse(message, status, env, origin, extra) {
  return jsonResponse({ error: message, ...(extra || {}) }, status || 500, env, origin);
}
