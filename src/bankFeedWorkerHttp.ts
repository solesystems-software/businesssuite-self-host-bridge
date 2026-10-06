import type { JsonBody } from './bankFeedWorkerTypes'

const responseHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
}

export function makeOptionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  })
}

export function jsonResponse(
  status: number,
  body: JsonBody,
  requestId?: string,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...responseHeaders,
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
  })
}

export async function readJsonBody(request: Request): Promise<JsonBody | null> {
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) return null

  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as JsonBody
  } catch {
    return null
  }
}

export function badRequest(requestId: string, message: string) {
  return jsonResponse(400, {
    ok: false,
    requestId,
    message,
  }, requestId)
}

export function unauthorized(requestId: string) {
  return jsonResponse(401, {
    ok: false,
    requestId,
    message: 'Request authentication failed.',
  }, requestId)
}

export function methodNotAllowed(requestId: string) {
  return jsonResponse(405, {
    ok: false,
    requestId,
    message: 'Method not allowed.',
  }, requestId)
}

export function serviceUnavailable(requestId: string, message: string) {
  return jsonResponse(503, {
    ok: false,
    requestId,
    message,
  }, requestId)
}

export function badGateway(
  requestId: string,
  message: string,
  details?: JsonBody,
) {
  return jsonResponse(502, {
    ok: false,
    requestId,
    message,
    ...(details || {}),
  }, requestId)
}

export function notFound(requestId: string) {
  return jsonResponse(404, {
    ok: false,
    requestId,
    message: 'Route not found.',
  }, requestId)
}

export function internalServerError(requestId: string) {
  return jsonResponse(500, {
    ok: false,
    requestId,
    message: 'Unexpected broker error.',
  }, requestId)
}
