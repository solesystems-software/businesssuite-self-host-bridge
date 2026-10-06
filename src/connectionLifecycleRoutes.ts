import {
  badGateway,
  badRequest,
  jsonResponse,
  methodNotAllowed,
  serviceUnavailable,
} from './bankFeedWorkerHttp'
import {
  AccessTokenDecryptionError,
  AccessTokenEncryptionConfigurationError,
  decryptPlaidAccessToken,
} from './accessTokenCrypto'
import {
  BankFeedAccountNotFoundError,
  BankFeedAccountStorageValidationError,
  BankFeedAccountSyncStateUnavailableError,
  BankFeedConnectionNotFoundError,
  getStoredPlaidConnectionCredentials,
  markPlaidConnectionDisconnected,
  savePlaidConnection,
  setStoredPlaidAccountSyncEnabled,
} from './bankFeedWorkerConnectionsRepository'
import {
  PlaidApiError,
  PlaidConfigurationError,
  createPlaidLinkToken,
  getPlaidAccounts,
  removePlaidItem,
  updatePlaidItemWebhook,
} from './plaidClient'
import { getBankFeedPlaidWebhookUrl } from './bankFeedWebhookUrl'
import { authenticateBrokerJsonRequest } from './requestAuthentication'
import type { Env, PlaidLinkTokenCreateRequest } from './bankFeedWorkerTypes'

class BankFeedConnectionLifecycleError extends Error {}

function readConnectionId(value: unknown) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /\s/.test(normalized)) {
    return null
  }
  return normalized
}

function lifecycleErrorResponse(
  env: Env,
  requestId: string,
  operation: string,
  error: unknown,
) {
  if (error instanceof BankFeedConnectionNotFoundError) {
    return jsonResponse(404, {
      ok: false,
      requestId,
      message: error.message,
    }, requestId)
  }

  if (error instanceof BankFeedAccountNotFoundError) {
    return jsonResponse(404, {
      ok: false,
      requestId,
      message: error.message,
    }, requestId)
  }

  if (
    error instanceof BankFeedConnectionLifecycleError
    || error instanceof BankFeedAccountSyncStateUnavailableError
  ) {
    return jsonResponse(409, {
      ok: false,
      requestId,
      message: error.message,
    }, requestId)
  }

  if (
    error instanceof AccessTokenEncryptionConfigurationError
    || error instanceof AccessTokenDecryptionError
  ) {
    console.error(`Bank Feed ${operation} credential failure:`, error)
    return serviceUnavailable(
      requestId,
      'Stored Plaid connection credentials are unavailable.',
    )
  }

  if (error instanceof PlaidConfigurationError) {
    console.error(`Plaid ${operation} configuration failed:`, error)
    return serviceUnavailable(
      requestId,
      `Plaid ${operation} is not configured.`,
    )
  }

  if (error instanceof PlaidApiError) {
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

  if (error instanceof BankFeedAccountStorageValidationError) {
    return badGateway(
      requestId,
      'Plaid returned invalid connected-account metadata.',
      { provider: 'plaid' },
    )
  }

  throw error
}

async function loadActiveConnection(
  env: Env,
  accountIntegrationId: string,
  connectionId: string,
) {
  const connection = await getStoredPlaidConnectionCredentials(
    env,
    accountIntegrationId,
    connectionId,
  )

  if (
    connection.connectionStatus === 'disconnected'
    || connection.connectionStatus === 'revoked'
  ) {
    throw new BankFeedConnectionLifecycleError(
      'Disconnected or revoked Bank Feed connections cannot be reconnected.',
    )
  }

  return connection
}

async function decryptConnectionAccessToken(
  env: Env,
  connection: Awaited<ReturnType<typeof getStoredPlaidConnectionCredentials>>,
) {
  return decryptPlaidAccessToken(env, {
    accountIntegrationId: connection.accountIntegrationId,
    providerItemId: connection.providerItemId,
    encryptedAccessToken: connection.encryptedAccessToken,
    accessTokenIv: connection.accessTokenIv,
    accessTokenKeyVersion: connection.accessTokenKeyVersion,
  })
}

export async function handleCreatePlaidReconnectLinkToken(
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

  const connectionId = readConnectionId(authentication.request.body.connectionId)
  if (!connectionId) {
    return badRequest(requestId, 'A valid Bank Feed connection ID is required.')
  }

  try {
    const connection = await loadActiveConnection(
      env,
      authentication.request.accountIntegrationId,
      connectionId,
    )
    const accessToken = await decryptConnectionAccessToken(env, connection)
    const plaidRequest: PlaidLinkTokenCreateRequest = {
      client_name: 'Sole Business Suite',
      language: 'en',
      country_codes: ['US'],
      user: {
        client_user_id: authentication.request.accountIntegrationId,
      },
      access_token: accessToken,
      webhook: getBankFeedPlaidWebhookUrl(request),
    }
    const plaidResponse = await createPlaidLinkToken(env, plaidRequest)

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      connectionId,
      linkToken: plaidResponse.link_token,
      expiration: plaidResponse.expiration,
      plaidRequestId: plaidResponse.request_id,
    }, requestId)
  } catch (error) {
    return lifecycleErrorResponse(env, requestId, 'reconnection Link-token creation', error)
  }
}

export async function handleCompletePlaidReconnect(
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

  const connectionId = readConnectionId(authentication.request.body.connectionId)
  if (!connectionId) {
    return badRequest(requestId, 'A valid Bank Feed connection ID is required.')
  }

  try {
    const connection = await loadActiveConnection(
      env,
      authentication.request.accountIntegrationId,
      connectionId,
    )
    const accessToken = await decryptConnectionAccessToken(env, connection)
    const accountsResponse = await getPlaidAccounts(env, {
      access_token: accessToken,
    })

    if (accountsResponse.item.item_id !== connection.providerItemId) {
      throw new Error('Plaid Item identity changed during reconnection.')
    }

    const webhookUrl = getBankFeedPlaidWebhookUrl(request)
    await updatePlaidItemWebhook(env, {
      access_token: accessToken,
      webhook: webhookUrl,
    })
    const webhookConfiguredAt = new Date().toISOString()

    const savedConnection = await savePlaidConnection(env, {
      accountIntegrationId: authentication.request.accountIntegrationId,
      providerItemId: connection.providerItemId,
      institutionId: accountsResponse.item.institution_id,
      institutionName: accountsResponse.item.institution_name,
      consentExpirationTime: accountsResponse.item.consent_expiration_time,
      webhookUrl,
      webhookConfiguredAt,
      itemError: accountsResponse.item.error,
      accounts: accountsResponse.accounts,
      encryptedAccessToken: connection.encryptedAccessToken,
      accessTokenIv: connection.accessTokenIv,
      accessTokenKeyVersion: connection.accessTokenKeyVersion,
    })

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      connectionId: savedConnection.connectionId,
      connectionStatus: savedConnection.connectionStatus,
      institutionId: accountsResponse.item.institution_id,
      institutionName: accountsResponse.item.institution_name,
      consentExpirationTime: accountsResponse.item.consent_expiration_time,
      accountCount: savedConnection.accountCount,
      accounts: savedConnection.accounts,
      plaidAccountsRequestId: accountsResponse.request_id,
    }, requestId)
  } catch (error) {
    return lifecycleErrorResponse(env, requestId, 'reconnection completion', error)
  }
}

export async function handleDisconnectPlaidConnection(
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

  const connectionId = readConnectionId(authentication.request.body.connectionId)
  if (!connectionId) {
    return badRequest(requestId, 'A valid Bank Feed connection ID is required.')
  }

  try {
    const connection = await getStoredPlaidConnectionCredentials(
      env,
      authentication.request.accountIntegrationId,
      connectionId,
    )
    const disconnectedAt = new Date().toISOString()

    if (connection.connectionStatus !== 'disconnected') {
      if (connection.connectionStatus !== 'revoked') {
        const accessToken = await decryptConnectionAccessToken(env, connection)
        await removePlaidItem(env, { access_token: accessToken })
      }
      await markPlaidConnectionDisconnected(
        env,
        authentication.request.accountIntegrationId,
        connectionId,
        disconnectedAt,
      )
    }

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      connectionId,
      connectionStatus: 'disconnected',
      disconnectedAt,
    }, requestId)
  } catch (error) {
    return lifecycleErrorResponse(env, requestId, 'connection removal', error)
  }
}


export async function handleSetPlaidAccountSyncEnabled(
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

  const connectionId = readConnectionId(
    authentication.request.body.connectionId,
  )
  const providerAccountId = readConnectionId(
    authentication.request.body.providerAccountId,
  )
  const syncEnabled = authentication.request.body.syncEnabled

  if (!connectionId) {
    return badRequest(requestId, 'A valid Bank Feed connection ID is required.')
  }
  if (!providerAccountId) {
    return badRequest(requestId, 'A valid provider account ID is required.')
  }
  if (typeof syncEnabled !== 'boolean') {
    return badRequest(
      requestId,
      'A valid account synchronization state is required.',
    )
  }

  try {
    const result = await setStoredPlaidAccountSyncEnabled(env, {
      accountIntegrationId: authentication.request.accountIntegrationId,
      connectionId,
      providerAccountId,
      syncEnabled,
    })

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      ...result,
    }, requestId)
  } catch (error) {
    return lifecycleErrorResponse(
      env,
      requestId,
      'account connection update',
      error,
    )
  }
}
