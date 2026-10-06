import {
  badGateway,
  badRequest,
  jsonResponse,
  methodNotAllowed,
  serviceUnavailable,
} from './bankFeedWorkerHttp'
import {
  AccessTokenEncryptionConfigurationError,
  createPlaidAccessTokenEncryptor,
} from './accessTokenCrypto'
import {
  BankFeedAccountStorageValidationError,
  BankFeedConnectionOwnershipError,
  BankFeedConnectionStorageUnavailableError,
  assertBankFeedConnectionStorageReady,
  savePlaidConnection,
} from './bankFeedWorkerConnectionsRepository'
import {
  PlaidApiError,
  PlaidConfigurationError,
  exchangePlaidPublicToken,
  getPlaidAccounts,
} from './plaidClient'
import { getBankFeedPlaidWebhookUrl } from './bankFeedWebhookUrl'
import { authenticateBrokerJsonRequest } from './requestAuthentication'
import type { Env } from './bankFeedWorkerTypes'

function readPublicToken(value: unknown) {
  if (typeof value !== 'string') return null

  const publicToken = value.trim()
  if (!publicToken || publicToken.length > 512 || /\s/.test(publicToken)) {
    return null
  }

  return publicToken
}

function plaidErrorResponse(
  env: Env,
  requestId: string,
  operation: string,
  error: PlaidApiError,
) {
  console.error(`Plaid ${operation} failed:`, {
    status: error.status,
    errorType: error.errorType,
    errorCode: error.errorCode,
    errorMessage: error.message,
    plaidRequestId: error.plaidRequestId,
  })

  return badGateway(
    requestId,
    error.displayMessage || `Plaid ${operation} failed.`,
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

export async function handleExchangePlaidPublicToken(
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

  const publicToken = readPublicToken(authentication.request.body.publicToken)
  if (!publicToken) {
    return badRequest(
      requestId,
      'A valid Plaid public token is required.',
    )
  }

  let encryptPlaidAccessToken: Awaited<
    ReturnType<typeof createPlaidAccessTokenEncryptor>
  >

  try {
    await assertBankFeedConnectionStorageReady(env, 4)
    encryptPlaidAccessToken = await createPlaidAccessTokenEncryptor(env)
  } catch (error) {
    if (error instanceof BankFeedConnectionStorageUnavailableError) {
      console.error('Bank-feed connection storage preflight failed:', error)
      return serviceUnavailable(
        requestId,
        'Bank-feed connection storage is unavailable.',
      )
    }

    if (error instanceof AccessTokenEncryptionConfigurationError) {
      console.error('Plaid access-token encryption configuration failed:', error)
      return serviceUnavailable(
        requestId,
        'Plaid access-token encryption is not configured.',
      )
    }

    throw error
  }

  try {
    const exchangeResponse = await exchangePlaidPublicToken(env, {
      public_token: publicToken,
    })

    const accountsResponse = await getPlaidAccounts(env, {
      access_token: exchangeResponse.access_token,
    })

    if (accountsResponse.item.item_id !== exchangeResponse.item_id) {
      throw new Error('Plaid Item identity changed during token exchange.')
    }

    const encryptedAccessToken = await encryptPlaidAccessToken({
      accountIntegrationId: authentication.request.accountIntegrationId,
      providerItemId: exchangeResponse.item_id,
      accessToken: exchangeResponse.access_token,
    })

    const savedConnection = await savePlaidConnection(env, {
      accountIntegrationId: authentication.request.accountIntegrationId,
      providerItemId: exchangeResponse.item_id,
      institutionId: accountsResponse.item.institution_id,
      institutionName: accountsResponse.item.institution_name,
      consentExpirationTime: accountsResponse.item.consent_expiration_time,
      webhookUrl: getBankFeedPlaidWebhookUrl(request),
      webhookConfiguredAt: new Date().toISOString(),
      itemError: accountsResponse.item.error,
      accounts: accountsResponse.accounts,
      ...encryptedAccessToken,
    })

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      connectionId: savedConnection.connectionId,
      connectionStatus: savedConnection.connectionStatus,
      replacedExistingConnection: savedConnection.replacedExistingConnection,
      providerItemId: exchangeResponse.item_id,
      institutionId: accountsResponse.item.institution_id,
      institutionName: accountsResponse.item.institution_name,
      consentExpirationTime: accountsResponse.item.consent_expiration_time,
      accountCount: savedConnection.accountCount,
      accounts: savedConnection.accounts,
      plaidExchangeRequestId: exchangeResponse.request_id,
      plaidAccountsRequestId: accountsResponse.request_id,
    }, requestId)
  } catch (error) {
    if (error instanceof PlaidConfigurationError) {
      console.error('Plaid public-token exchange configuration failed:', error)
      return serviceUnavailable(
        requestId,
        'Plaid public-token exchange is not configured.',
      )
    }

    if (error instanceof PlaidApiError) {
      return plaidErrorResponse(
        env,
        requestId,
        'public-token exchange or account discovery',
        error,
      )
    }

    if (error instanceof BankFeedConnectionOwnershipError) {
      return jsonResponse(409, {
        ok: false,
        requestId,
        message: error.message,
      }, requestId)
    }

    if (error instanceof BankFeedAccountStorageValidationError) {
      console.error('Plaid connected-account validation failed:', error)
      return badGateway(
        requestId,
        'Plaid returned invalid connected-account metadata.',
        {
          provider: 'plaid',
        },
      )
    }

    throw error
  }
}
