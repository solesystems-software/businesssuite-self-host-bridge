import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  unauthorized,
} from './bankFeedWorkerHttp'
import {
  applyVerifiedPlaidWebhook,
} from './bankFeedWorkerConnectionsRepository'
import {
  PlaidWebhookVerificationError,
  verifyPlaidWebhook,
} from './plaidWebhookVerification'
import type {
  Env,
  PlaidErrorResponse,
  PlaidWebhookBody,
} from './bankFeedWorkerTypes'

const maximumWebhookBodyBytes = 256 * 1024

function readRequiredText(value: unknown, maximumLength = 512) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maximumLength) return null
  return normalized
}

function readOptionalText(value: unknown, maximumLength = 512) {
  if (value === null || value === undefined || value === '') return null
  return readRequiredText(value, maximumLength)
}

function getProviderErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null
  const providerError = error as PlaidErrorResponse
  return readOptionalText(providerError.error_code)
}

export async function handlePlaidWebhook(
  request: Request,
  env: Env,
  requestId: string,
) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)

  const rawBody = await request.text()
  if (new TextEncoder().encode(rawBody).byteLength > maximumWebhookBodyBytes) {
    return badRequest(requestId, 'Plaid webhook body is too large.')
  }

  try {
    await verifyPlaidWebhook(
      env,
      rawBody,
      request.headers.get('plaid-verification'),
    )
  } catch (error) {
    if (error instanceof PlaidWebhookVerificationError) {
      console.error('Plaid webhook verification failed:', error.message)
      return unauthorized(requestId)
    }
    throw error
  }

  let body: PlaidWebhookBody
  try {
    const parsed = JSON.parse(rawBody) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return badRequest(requestId, 'Plaid webhook body must be a JSON object.')
    }
    body = parsed as PlaidWebhookBody
  } catch {
    return badRequest(requestId, 'Plaid webhook body contains invalid JSON.')
  }

  const providerItemId = readRequiredText(body.item_id)
  const webhookType = readRequiredText(body.webhook_type)
  const webhookCode = readRequiredText(body.webhook_code)
  if (!providerItemId || !webhookType || !webhookCode) {
    return badRequest(
      requestId,
      'Plaid webhook Item, type, and code are required.',
    )
  }

  const result = await applyVerifiedPlaidWebhook(env, {
    providerItemId,
    webhookType,
    webhookCode,
    providerAccountId: readOptionalText(body.account_id),
    providerRequestId: readOptionalText(body.request_id),
    providerErrorCode: getProviderErrorCode(body.error),
    receivedAt: new Date().toISOString(),
  })

  return jsonResponse(200, {
    ok: true,
    requestId,
    accepted: true,
    matchedConnection: result.matchedConnection,
  }, requestId)
}
