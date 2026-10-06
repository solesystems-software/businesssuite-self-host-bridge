import {
  badGateway,
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
  BankFeedConnectionStorageUnavailableError,
  listPlaidConnectionsForWebhookRegistration,
  listPlaidConnectionsWithAutomaticUpdates,
  markPlaidConnectionWebhookConfigured,
} from './bankFeedWorkerConnectionsRepository'
import { getBankFeedPlaidWebhookUrl } from './bankFeedWebhookUrl'
import {
  PlaidApiError,
  PlaidConfigurationError,
  updatePlaidItemWebhook,
} from './plaidClient'
import { authenticateBrokerJsonRequest } from './requestAuthentication'
import type { Env } from './bankFeedWorkerTypes'

function registrationFailureMessage(error: unknown) {
  if (error instanceof PlaidApiError) {
    return error.displayMessage || error.message || 'Plaid webhook registration failed.'
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return 'Plaid webhook registration failed.'
}

export async function handleRegisterPlaidConnectionWebhooks(
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

  try {
    const connections = await listPlaidConnectionsForWebhookRegistration(
      env,
      authentication.request.accountIntegrationId,
    )
    const webhookUrl = getBankFeedPlaidWebhookUrl(request)
    const failures: Array<{
      connectionId: string
      message: string
    }> = []
    let succeededCount = 0

    for (const connection of connections) {
      try {
        const accessToken = await decryptPlaidAccessToken(env, {
          accountIntegrationId: connection.accountIntegrationId,
          providerItemId: connection.providerItemId,
          encryptedAccessToken: connection.encryptedAccessToken,
          accessTokenIv: connection.accessTokenIv,
          accessTokenKeyVersion: connection.accessTokenKeyVersion,
        })
        await updatePlaidItemWebhook(env, {
          access_token: accessToken,
          webhook: webhookUrl,
        })
        await markPlaidConnectionWebhookConfigured(env, {
          accountIntegrationId: authentication.request.accountIntegrationId,
          connectionId: connection.connectionId,
          webhookUrl,
          configuredAt: new Date().toISOString(),
        })
        succeededCount += 1
      } catch (error) {
        console.error(
          `Plaid webhook registration failed for connection ${connection.connectionId}:`,
          error,
        )
        failures.push({
          connectionId: connection.connectionId,
          message: registrationFailureMessage(error),
        })
      }
    }

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      attemptedCount: connections.length,
      succeededCount,
      failedCount: failures.length,
      failures,
    }, requestId)
  } catch (error) {
    if (
      error instanceof AccessTokenEncryptionConfigurationError
      || error instanceof AccessTokenDecryptionError
      || error instanceof PlaidConfigurationError
      || error instanceof BankFeedConnectionStorageUnavailableError
    ) {
      console.error('Plaid webhook registration is unavailable:', error)
      return serviceUnavailable(
        requestId,
        'Plaid webhook registration is unavailable.',
      )
    }
    if (error instanceof PlaidApiError) {
      return badGateway(
        requestId,
        error.displayMessage || 'Plaid webhook registration failed.',
        { provider: 'plaid' },
      )
    }
    throw error
  }
}

export async function handleGetPlaidAutomaticSyncStatus(
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

  try {
    const connections = await listPlaidConnectionsWithAutomaticUpdates(
      env,
      authentication.request.accountIntegrationId,
    )

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      connectionIds: connections.map(connection => connection.connectionId),
      connections,
    }, requestId)
  } catch (error) {
    if (error instanceof BankFeedConnectionStorageUnavailableError) {
      console.error('Automatic Bank Feed status is unavailable:', error)
      return serviceUnavailable(
        requestId,
        'Automatic Bank Feed status is unavailable.',
      )
    }
    throw error
  }
}
