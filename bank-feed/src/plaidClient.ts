import type {
  Env,
  PlaidAccountsGetRequest,
  PlaidAccountsGetResponse,
  PlaidErrorResponse,
  PlaidLinkTokenCreateRequest,
  PlaidLinkTokenCreateResponse,
  PlaidItemRemoveRequest,
  PlaidItemRemoveResponse,
  PlaidItemWebhookUpdateRequest,
  PlaidItemWebhookUpdateResponse,
  PlaidWebhookVerificationKeyRequest,
  PlaidWebhookVerificationKeyResponse,
  PlaidPublicTokenExchangeRequest,
  PlaidPublicTokenExchangeResponse,
  PlaidTransactionsSyncRequest,
  PlaidTransactionsSyncResponse,
} from './bankFeedWorkerTypes'

const plaidApiVersion = '2020-09-14'

export class PlaidConfigurationError extends Error {}

export class PlaidApiError extends Error {
  readonly status: number
  readonly errorType: string | null
  readonly errorCode: string | null
  readonly displayMessage: string | null
  readonly plaidRequestId: string | null

  constructor(
    status: number,
    response: PlaidErrorResponse,
  ) {
    super(response.error_message || 'Plaid API request failed.')
    this.name = 'PlaidApiError'
    this.status = status
    this.errorType = response.error_type || null
    this.errorCode = response.error_code || null
    this.displayMessage = response.display_message || null
    this.plaidRequestId = response.request_id || null
  }
}

function getPlaidBaseUrl(env: Env) {
  switch (env.PLAID_ENVIRONMENT) {
    case 'sandbox':
      return 'https://sandbox.plaid.com'
    case 'development':
      return 'https://development.plaid.com'
    case 'production':
      return 'https://production.plaid.com'
    default:
      throw new PlaidConfigurationError(
        'PLAID_ENVIRONMENT is not configured correctly.',
      )
  }
}

function getPlaidCredentials(env: Env) {
  const clientId = env.PLAID_CLIENT_ID?.trim() || ''
  const secret = env.PLAID_SECRET?.trim() || ''

  if (!clientId || !secret) {
    throw new PlaidConfigurationError(
      'Plaid credentials are not configured.',
    )
  }

  return {
    client_id: clientId,
    secret,
  }
}

async function postPlaid<RequestBody extends Record<string, unknown>, ResponseBody>(
  env: Env,
  path: string,
  body: RequestBody,
): Promise<ResponseBody> {
  const credentials = getPlaidCredentials(env)

  const response = await fetch(`${getPlaidBaseUrl(env)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Plaid-Version': plaidApiVersion,
    },
    body: JSON.stringify({
      ...credentials,
      ...body,
    }),
  })

  const responseText = await response.text()
  let responseBody: unknown = null

  if (responseText) {
    try {
      responseBody = JSON.parse(responseText) as unknown
    } catch {
      if (!response.ok) {
        throw new PlaidApiError(response.status, {
          error_message: 'Plaid returned a non-JSON error response.',
        })
      }

      throw new Error('Plaid returned an invalid JSON response.')
    }
  }

  if (!response.ok) {
    const errorResponse = (
      responseBody
      && typeof responseBody === 'object'
      && !Array.isArray(responseBody)
    )
      ? responseBody as PlaidErrorResponse
      : {}

    throw new PlaidApiError(response.status, errorResponse)
  }

  if (
    !responseBody
    || typeof responseBody !== 'object'
    || Array.isArray(responseBody)
  ) {
    throw new Error('Plaid returned an empty or invalid response.')
  }

  return responseBody as ResponseBody
}

export function createPlaidLinkToken(
  env: Env,
  request: PlaidLinkTokenCreateRequest,
) {
  return postPlaid<
    PlaidLinkTokenCreateRequest,
    PlaidLinkTokenCreateResponse
  >(
    env,
    '/link/token/create',
    request,
  )
}

export function exchangePlaidPublicToken(
  env: Env,
  request: PlaidPublicTokenExchangeRequest,
) {
  return postPlaid<
    PlaidPublicTokenExchangeRequest,
    PlaidPublicTokenExchangeResponse
  >(
    env,
    '/item/public_token/exchange',
    request,
  )
}

export function getPlaidAccounts(
  env: Env,
  request: PlaidAccountsGetRequest,
) {
  return postPlaid<
    PlaidAccountsGetRequest,
    PlaidAccountsGetResponse
  >(
    env,
    '/accounts/get',
    request,
  )
}


export function removePlaidItem(
  env: Env,
  request: PlaidItemRemoveRequest,
) {
  return postPlaid<
    PlaidItemRemoveRequest,
    PlaidItemRemoveResponse
  >(
    env,
    '/item/remove',
    request,
  )
}

export function syncPlaidTransactions(
  env: Env,
  request: PlaidTransactionsSyncRequest,
) {
  return postPlaid<
    PlaidTransactionsSyncRequest,
    PlaidTransactionsSyncResponse
  >(
    env,
    '/transactions/sync',
    request,
  )
}

export function updatePlaidItemWebhook(
  env: Env,
  request: PlaidItemWebhookUpdateRequest,
) {
  return postPlaid<
    PlaidItemWebhookUpdateRequest,
    PlaidItemWebhookUpdateResponse
  >(
    env,
    '/item/webhook/update',
    request,
  )
}

export function getPlaidWebhookVerificationKey(
  env: Env,
  request: PlaidWebhookVerificationKeyRequest,
) {
  return postPlaid<
    PlaidWebhookVerificationKeyRequest,
    PlaidWebhookVerificationKeyResponse
  >(
    env,
    '/webhook_verification_key/get',
    request,
  )
}

