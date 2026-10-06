import {
  internalServerError,
  jsonResponse,
  makeOptionsResponse,
  methodNotAllowed,
  notFound,
} from './bankFeedWorkerHttp'
import { handleCreatePlaidLinkToken } from './linkTokenRoutes'
import { handleStripeLinkDonePage, handleStripeLinkPage } from './stripeLinkPage'
import {
  handleCompletePlaidReconnect,
  handleCreatePlaidReconnectLinkToken,
  handleDisconnectPlaidConnection,
  handleSetPlaidAccountSyncEnabled,
} from './connectionLifecycleRoutes'
import { handleExchangePlaidPublicToken } from './publicTokenExchangeRoutes'
import { handleAcknowledgePlaidTransactionDelivery } from './transactionDeliveryAcknowledgmentRoutes'
import {
  handleGetPlaidAutomaticSyncStatus,
  handleRegisterPlaidConnectionWebhooks,
} from './bankFeedAutomaticSyncRoutes'
import { handlePlaidWebhook } from './plaidWebhookRoutes'
import { handleSyncPlaidTransactions } from './transactionSyncRoutes'
import {
  handleAcknowledgeStripeDelivery,
  handleCompleteStripeConnection,
  handleCreateStripeLinkSession,
  handleDisconnectStripeConnection,
  handleGetStripeAutomaticSyncStatus,
  handleSetStripeAccountSyncEnabled,
  handleStripeWebhook,
  handleSyncStripeTransactions,
} from './stripeFinancialConnectionsRoutes'
import {
  handleStripeKeyStatus,
  handleStripeRemoveKey,
  handleStripeSaveKey,
} from './stripeBankFeedKeys'
import type {
  BankFeedSchemaVersionRow,
  Env,
} from './bankFeedWorkerTypes'

const serviceName = 'businesssuite-bank-feeds'
const serviceVersion = '0.14.5'

function normalizePath(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/'
}

function handleHealth(request: Request, env: Env, requestId: string) {
  if (request.method !== 'GET') return methodNotAllowed(requestId)

  return jsonResponse(200, {
    ok: true,
    requestId,
    service: serviceName,
    version: serviceVersion,
    environment: env.SERVICE_ENVIRONMENT,
    plaidEnvironment: env.PLAID_ENVIRONMENT,
    message: 'SoleSystems bank-feed broker is available.',
  }, requestId)
}

async function handleReadiness(request: Request, env: Env, requestId: string) {
  if (request.method !== 'GET') return methodNotAllowed(requestId)

  try {
    const schemaVersion = await env.DB
      .prepare(`
        SELECT version, description, applied_at
        FROM bank_feed_schema_versions
        ORDER BY version DESC
        LIMIT 1
      `)
      .first<BankFeedSchemaVersionRow>()

    if (!schemaVersion) {
      return jsonResponse(503, {
        ok: false,
        requestId,
        service: serviceName,
        message: 'Bank-feed D1 schema has not been initialized.',
      }, requestId)
    }

    return jsonResponse(200, {
      ok: true,
      requestId,
      service: serviceName,
      version: serviceVersion,
      environment: env.SERVICE_ENVIRONMENT,
      plaidEnvironment: env.PLAID_ENVIRONMENT,
      schemaVersion: schemaVersion.version,
      schemaDescription: schemaVersion.description,
      schemaAppliedAt: schemaVersion.applied_at,
      plaidCredentialsConfigured: Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
      tokenEncryptionConfigured: Boolean(env.PLAID_ACCESS_TOKEN_ENCRYPTION_KEY_B64),
      requestSigningAvailable: schemaVersion.version >= 8,
      linkTokenEndpointAvailable: schemaVersion.version >= 2,
      publicTokenExchangeEndpointAvailable: schemaVersion.version >= 2,
      connectedAccountDiscoveryAvailable: schemaVersion.version >= 2,
      transactionSyncEndpointAvailable: schemaVersion.version >= 2,
      deliveryAcknowledgmentEndpointAvailable: schemaVersion.version >= 2,
      reconnectEndpointAvailable: schemaVersion.version >= 2,
      disconnectEndpointAvailable: schemaVersion.version >= 2,
      accountConnectionControlsAvailable: schemaVersion.version >= 3,
      stripeKeyEncryptionConfigured: Boolean(env.STRIPE_API_KEY_ENCRYPTION_KEY),
      stripeKeyStorageAvailable: schemaVersion.version >= 6,
      stripeFinancialConnectionsAvailable: schemaVersion.version >= 7,
      plaidWebhookEndpointAvailable: schemaVersion.version >= 4,
      automaticSynchronizationAvailable: schemaVersion.version >= 4,
      message: 'SoleSystems bank-feed broker is ready.',
    }, requestId)
  } catch (error) {
    console.error('Bank-feed readiness check failed:', error)

    return jsonResponse(503, {
      ok: false,
      requestId,
      service: serviceName,
      message: 'Bank-feed D1 schema is unavailable.',
    }, requestId)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID()

    try {
      if (request.method === 'OPTIONS') return makeOptionsResponse()

      const url = new URL(request.url)
      const pathname = normalizePath(url.pathname)

      if (pathname === '/health') return handleHealth(request, env, requestId)
      if (pathname === '/readiness') return handleReadiness(request, env, requestId)
      // Public, secret-free pages for the desktop's Stripe linking window (see stripeLinkPage.ts).
      if (pathname === '/stripe/link') return handleStripeLinkPage(request)
      if (pathname === '/stripe/link/done') return handleStripeLinkDonePage(request)
      if (pathname === '/plaid/link-token') {
        return handleCreatePlaidLinkToken(request, env, requestId)
      }
      if (pathname === '/plaid/public-token/exchange') {
        return handleExchangePlaidPublicToken(request, env, requestId)
      }
      if (pathname === '/plaid/connections/reconnect-link-token') {
        return handleCreatePlaidReconnectLinkToken(request, env, requestId)
      }
      if (pathname === '/plaid/connections/reconnect') {
        return handleCompletePlaidReconnect(request, env, requestId)
      }
      if (pathname === '/plaid/connections/disconnect') {
        return handleDisconnectPlaidConnection(request, env, requestId)
      }
      if (pathname === '/plaid/connections/accounts/sync-enabled') {
        return handleSetPlaidAccountSyncEnabled(request, env, requestId)
      }
      if (pathname === '/plaid/connections/webhooks/register') {
        return handleRegisterPlaidConnectionWebhooks(request, env, requestId)
      }
      if (pathname === '/plaid/transactions/automatic-status') {
        return handleGetPlaidAutomaticSyncStatus(request, env, requestId)
      }
      if (pathname === '/plaid/webhooks') {
        return handlePlaidWebhook(request, env, requestId)
      }
      if (pathname === '/plaid/transactions/sync') {
        return handleSyncPlaidTransactions(request, env, requestId)
      }
      if (pathname === '/plaid/transactions/acknowledge') {
        return handleAcknowledgePlaidTransactionDelivery(request, env, requestId)
      }

      // Stripe Financial Connections (Bank Connections): Business-owned API key, independent of Client Portal.
      if (pathname === '/stripe/keys/save') return handleStripeSaveKey(request, env, requestId)
      if (pathname === '/stripe/keys/remove') return handleStripeRemoveKey(request, env, requestId)
      if (pathname === '/stripe/keys/status') return handleStripeKeyStatus(request, env, requestId)
      if (pathname === '/stripe/link-session') return handleCreateStripeLinkSession(request, env, requestId)
      if (pathname === '/stripe/connections/complete') return handleCompleteStripeConnection(request, env, requestId)
      if (pathname === '/stripe/connections/disconnect') return handleDisconnectStripeConnection(request, env, requestId)
      if (pathname === '/stripe/connections/accounts/sync-enabled') return handleSetStripeAccountSyncEnabled(request, env, requestId)
      if (pathname === '/stripe/transactions/sync') return handleSyncStripeTransactions(request, env, requestId)
      if (pathname === '/stripe/transactions/acknowledge') return handleAcknowledgeStripeDelivery(request, env, requestId)
      if (pathname === '/stripe/transactions/automatic-status') return handleGetStripeAutomaticSyncStatus(request, env, requestId)
      if (pathname.startsWith('/stripe/webhooks/')) {
        const webhookAccountId = decodeURIComponent(pathname.slice('/stripe/webhooks/'.length))
        return handleStripeWebhook(request, env, requestId, webhookAccountId)
      }

      return notFound(requestId)
    } catch (error) {
      console.error('Unhandled bank-feed broker error:', error)
      return internalServerError(requestId)
    }
  },
}
