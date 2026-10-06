import {
  badGateway,
  jsonResponse,
  methodNotAllowed,
  serviceUnavailable,
} from './bankFeedWorkerHttp'
import {
  PlaidApiError,
  PlaidConfigurationError,
  createPlaidLinkToken,
} from './plaidClient'
import { getBankFeedPlaidWebhookUrl } from './bankFeedWebhookUrl'
import { authenticateBrokerJsonRequest } from './requestAuthentication'
import type {
  Env,
  PlaidLinkTokenCreateRequest,
} from './bankFeedWorkerTypes'

export async function handleCreatePlaidLinkToken(
  request: Request,
  env: Env,
  requestId: string,
) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)

  const authentication = await authenticateBrokerJsonRequest(
    request,
    env,
    requestId,
  )

  if (!authentication.ok) return authentication.response

  const plaidRequest: PlaidLinkTokenCreateRequest = {
    client_name: 'Sole Business Suite',
    language: 'en',
    country_codes: ['US'],
    user: {
      client_user_id: authentication.request.accountIntegrationId,
    },
    products: ['transactions'],
    transactions: {
      days_requested: 730,
    },
    webhook: getBankFeedPlaidWebhookUrl(request),
  }

  try {
    const plaidResponse = await createPlaidLinkToken(
      env,
      plaidRequest,
    )

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      linkToken: plaidResponse.link_token,
      expiration: plaidResponse.expiration,
      plaidRequestId: plaidResponse.request_id,
    }, requestId)
  } catch (error) {
    if (error instanceof PlaidConfigurationError) {
      console.error('Plaid Link-token configuration failed:', error)
      return serviceUnavailable(
        requestId,
        'Plaid Link-token creation is not configured.',
      )
    }

    if (error instanceof PlaidApiError) {
      console.error('Plaid Link-token request failed:', {
        status: error.status,
        errorType: error.errorType,
        errorCode: error.errorCode,
        errorMessage: error.message,
        plaidRequestId: error.plaidRequestId,
      })

      return badGateway(
        requestId,
        error.displayMessage || 'Plaid could not create a Link token.',
        {
          provider: 'plaid',
          providerErrorType: error.errorType,
          providerErrorCode: error.errorCode,
          providerErrorMessage: env.SERVICE_ENVIRONMENT === 'development'
            ? error.message
            : undefined,
          providerRequestId: error.plaidRequestId,
        },
      )
    }

    console.error('Unexpected Plaid Link-token failure:', error)
    return badGateway(
      requestId,
      'Plaid Link-token creation failed unexpectedly.',
      {
        provider: 'plaid',
      },
    )
  }
}
