import {
  badGateway,
  badRequest,
  jsonResponse,
  methodNotAllowed,
  serviceUnavailable,
} from './bankFeedWorkerHttp'
import { authenticateBrokerJsonRequest } from './requestAuthentication'
import { decryptStripeSecret } from './stripeApiKeyCrypto'
import {
  createFinancialConnectionsSession,
  createStripeCustomer,
  disconnectFinancialConnectionsAccount,
  listFinancialConnectionsAccountsForSession,
  listFinancialConnectionsTransactions,
  retrieveFinancialConnectionsAccount,
  retrieveFinancialConnectionsSession,
  StripeApiError,
  subscribeFinancialConnectionsAccountToTransactions,
  type StripeFcAccount,
  type StripeFcTransaction,
} from './stripeFinancialConnectionsClient'
import {
  getStripeBankFeedKeyRow,
  resolveAccountStripe,
  saveStripeCustomerId,
} from './stripeBankFeedKeys'
import type { Env } from './bankFeedWorkerTypes'

// Stripe Financial Connections routes for Bank Connections, parallel to the Plaid routes (which are
// untouched). The desktop authenticates exactly as it does for Plaid (authenticateBrokerJsonRequest);
// the account's own Stripe key (stripeBankFeedKeys.ts) authenticates every Stripe call. Response shapes
// mirror what BankFeedBrokerClient already parses for Plaid so the desktop persist/acknowledge protocol
// is unchanged.

const deliveryLifetimeMilliseconds = 24 * 60 * 60 * 1000
const provider = 'stripe' as const

// Stripe's FC transaction `amount` is in the smallest currency unit and is NEGATIVE for money leaving the account
// (verified 2026-09-30 against Stripe's test institution: "Rocket Rides" purchases are -10000, "Typographic"
// payments in are +100000). The desktop expects Plaid's convention (decimal units, positive = money leaving),
// so the sign is flipped.
const outflowSign = -1

type ConnectionRow = {
  id: string
  account_integration_id: string
  stripe_session_id: string | null
  institution_name: string | null
  connection_status: 'active' | 'needs_attention' | 'disconnected' | 'revoked'
  updates_available: number
  last_webhook_at: string | null
  last_webhook_code: string | null
}

type AccountRow = {
  id: string
  connection_id: string
  provider_account_id: string
  display_name: string
  official_name: string | null
  mask: string | null
  account_type: string
  account_subtype: string | null
  iso_currency_code: string | null
  is_active: number
  sync_enabled: number
  acknowledged_cursor: string | null
  pending_batch_id: string | null
  pending_cursor: string | null
}

const accountColumns = `
  id, connection_id, provider_account_id, display_name, official_name, mask, account_type, account_subtype,
  iso_currency_code, is_active, sync_enabled, acknowledged_cursor, pending_batch_id, pending_cursor
`

function nowIso() {
  return new Date().toISOString()
}

function readIdentifier(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : null
}

async function getOwnedConnection(env: Env, accountIntegrationId: string, connectionId: string) {
  return env.DB
    .prepare(`
      SELECT id, account_integration_id, stripe_session_id, institution_name, connection_status,
             updates_available, last_webhook_at, last_webhook_code
      FROM stripe_fc_connections
      WHERE id = ? AND account_integration_id = ?
    `)
    .bind(connectionId, accountIntegrationId)
    .first<ConnectionRow>()
}

async function listAccounts(env: Env, connectionId: string) {
  const result = await env.DB
    .prepare(`SELECT ${accountColumns} FROM stripe_fc_accounts WHERE connection_id = ? ORDER BY provider_account_id`)
    .bind(connectionId)
    .all<AccountRow>()
  return result.results ?? []
}

function accountMetadata(row: AccountRow, institutionName: string | null) {
  return {
    provider,
    providerAccountId: row.provider_account_id,
    institutionName,
    displayName: row.display_name,
    officialName: row.official_name,
    mask: row.mask,
    accountType: row.account_type,
    accountSubtype: row.account_subtype,
    isoCurrencyCode: row.iso_currency_code,
    unofficialCurrencyCode: null,
    isActive: row.is_active === 1,
    syncEnabled: row.sync_enabled === 1,
  }
}

function currencyOf(account: StripeFcAccount) {
  const keys = Object.keys(account.balance?.current ?? {})
  return (keys[0] || 'usd').toUpperCase()
}

function stripeErrorResponse(requestId: string, error: StripeApiError) {
  console.error('Stripe request failed:', { status: error.status, code: error.stripeCode, requestId: error.stripeRequestId, message: error.message })
  return badGateway(requestId, error.message || 'Stripe could not complete the request.', {
    provider,
    providerErrorCode: error.stripeCode ?? undefined,
    providerRequestId: error.stripeRequestId ?? undefined,
  })
}

// Resolves the account's real Stripe credentials or produces the failure response.
async function requireStripe(env: Env, accountIntegrationId: string, requestId: string) {
  let credentials
  try {
    credentials = await resolveAccountStripe(env, accountIntegrationId)
  } catch (error) {
    console.error('Stripe credential lookup failed:', error instanceof Error ? error.message : 'unknown error')
    return { ok: false as const, response: serviceUnavailable(requestId, 'The stored Stripe key could not be read. Save the key again in Settings.') }
  }
  if (credentials.mode === 'none') {
    return { ok: false as const, response: jsonResponse(409, { ok: false, requestId, message: 'No Stripe key is connected for Bank Connections. Save one in Settings first.' }, requestId) }
  }
  if (credentials.mode === 'mock') {
    return { ok: false as const, response: serviceUnavailable(requestId, 'Bank Connections are not available with a development mock key.') }
  }
  return { ok: true as const, credentials }
}

// POST /stripe/link-session -- creates the account's Stripe Customer on first use, then a Financial
// Connections Session. The desktop hands clientSecret + publishableKey to Stripe.js.
export async function handleCreateStripeLinkSession(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId } = authentication.request

  const stripe = await requireStripe(env, accountIntegrationId, requestId)
  if (!stripe.ok) return stripe.response
  const { secretKey, publishableKey, row } = stripe.credentials

  try {
    let customerId = row.customer_id
    if (!customerId) {
      customerId = await createStripeCustomer(env, secretKey, accountIntegrationId)
      await saveStripeCustomerId(env, accountIntegrationId, customerId)
    }
    const session = await createFinancialConnectionsSession(env, secretKey, customerId)
    if (!session.client_secret) throw new StripeApiError(502, 'Stripe returned no client secret for the session.', null, null)

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider,
      sessionId: session.id,
      clientSecret: session.client_secret,
      publishableKey,
    }, requestId)
  } catch (error) {
    if (error instanceof StripeApiError) return stripeErrorResponse(requestId, error)
    throw error
  }
}

// POST /stripe/connections/complete { sessionId } -- after Stripe.js finishes. Verifies the session
// belongs to this account's Customer, stores the linked accounts, and subscribes them to transactions.
export async function handleCompleteStripeConnection(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId, body } = authentication.request

  const sessionId = readIdentifier(body.sessionId)
  if (!sessionId) return badRequest(requestId, 'sessionId is required.')

  const stripe = await requireStripe(env, accountIntegrationId, requestId)
  if (!stripe.ok) return stripe.response
  const { secretKey, row: keyRow } = stripe.credentials

  try {
    const session = await retrieveFinancialConnectionsSession(env, secretKey, sessionId)
    if (!keyRow.customer_id || session.account_holder?.customer !== keyRow.customer_id) {
      return badRequest(requestId, 'That Financial Connections session does not belong to this account.')
    }

    const stripeAccounts = await listFinancialConnectionsAccountsForSession(env, secretKey, sessionId)
    if (stripeAccounts.length === 0) return badRequest(requestId, 'No bank accounts were linked in that session.')

    const timestamp = nowIso()
    const institutionName = stripeAccounts[0].institution_name ?? null
    // Stripe can deactivate accounts right after linking (its status is authoritative), and a deactivated account
    // can neither be subscribed to transactions nor synced. Say so now instead of reporting a healthy connection.
    const activeStripeAccountCount = stripeAccounts.filter(account => account.status === 'active').length
    const linkedConnectionStatus = activeStripeAccountCount > 0 ? 'active' : 'needs_attention'
    const linkedErrorCode = activeStripeAccountCount > 0 ? null : 'accounts_inactive'

    // A re-link of accounts already stored reuses (and reactivates) their existing connection.
    const existing = await env.DB
      .prepare(`
        SELECT connection_id FROM stripe_fc_accounts
        WHERE provider_account_id IN (${stripeAccounts.map(() => '?').join(',')})
      `)
      .bind(...stripeAccounts.map(account => account.id))
      .all<{ connection_id: string }>()
    const existingConnectionIds = [...new Set((existing.results ?? []).map(entry => entry.connection_id))]
    let connectionId = existingConnectionIds.length === 1 ? existingConnectionIds[0] : ''
    const replacedExistingConnection = Boolean(connectionId)

    if (connectionId) {
      const owned = await getOwnedConnection(env, accountIntegrationId, connectionId)
      if (!owned) return badRequest(requestId, 'Those accounts belong to a different Bank Connections account.')
      await env.DB
        .prepare(`UPDATE stripe_fc_connections SET connection_status = ?, stripe_session_id = ?, institution_name = ?, last_error_code = ?, last_error_at = ?, updated_at = ? WHERE id = ?`)
        .bind(linkedConnectionStatus, sessionId, institutionName, linkedErrorCode, linkedErrorCode ? timestamp : null, timestamp, connectionId)
        .run()
    } else {
      connectionId = crypto.randomUUID()
      await env.DB
        .prepare(`
          INSERT INTO stripe_fc_connections (id, account_integration_id, stripe_session_id, institution_name, connection_status, last_error_code, last_error_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(connectionId, accountIntegrationId, sessionId, institutionName, linkedConnectionStatus, linkedErrorCode, linkedErrorCode ? timestamp : null, timestamp, timestamp)
        .run()
    }

    for (const account of stripeAccounts) {
      const displayName = account.display_name || `${account.institution_name || 'Bank'}${account.last4 ? ` ${account.last4}` : ''}`
      await env.DB
        .prepare(`
          INSERT INTO stripe_fc_accounts
            (id, connection_id, provider_account_id, display_name, mask, account_type, account_subtype, iso_currency_code,
             is_active, sync_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT (provider_account_id) DO UPDATE SET
            connection_id = excluded.connection_id,
            display_name = excluded.display_name,
            mask = excluded.mask,
            account_type = excluded.account_type,
            account_subtype = excluded.account_subtype,
            iso_currency_code = excluded.iso_currency_code,
            is_active = excluded.is_active,
            updated_at = excluded.updated_at
        `)
        .bind(
          crypto.randomUUID(), connectionId, account.id, displayName, account.last4 ?? null,
          account.category || 'other', account.subcategory ?? null, currencyOf(account), account.status === 'active' ? 1 : 0, timestamp, timestamp,
        )
        .run()

    }

    // Subscribe every active account at once, not one after another: Stripe's sandbox deactivates the whole link within
    // seconds of the first transactions refresh, and a sequential loop leaves the later accounts inactive (and refused,
    // since Stripe rejects subscriptions on inactive accounts) before their turn comes. Failures never abort the link; a
    // later sync reads whatever Stripe holds.
    const subscriptions = await Promise.allSettled(
      stripeAccounts
        .filter(account => account.status === 'active')
        .map(account => subscribeFinancialConnectionsAccountToTransactions(env, secretKey, account.id)),
    )
    for (const outcome of subscriptions) {
      if (outcome.status === 'rejected') {
        console.error('Stripe transactions subscription failed (continuing):', outcome.reason instanceof Error ? outcome.reason.message : 'unknown error')
      }
    }

    const accounts = await listAccounts(env, connectionId)
    return jsonResponse(200, {
      ok: true,
      requestId,
      provider,
      connectionId,
      connectionStatus: linkedConnectionStatus,
      replacedExistingConnection,
      institutionId: null,
      institutionName,
      consentExpirationAt: null,
      accountCount: accounts.length,
      accounts: accounts.map(account => accountMetadata(account, institutionName)),
    }, requestId)
  } catch (error) {
    if (error instanceof StripeApiError) return stripeErrorResponse(requestId, error)
    throw error
  }
}

// POST /stripe/connections/disconnect { connectionId }
export async function handleDisconnectStripeConnection(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId, body } = authentication.request

  const connectionId = readIdentifier(body.connectionId)
  if (!connectionId) return badRequest(requestId, 'connectionId is required.')
  const connection = await getOwnedConnection(env, accountIntegrationId, connectionId)
  if (!connection) return jsonResponse(404, { ok: false, requestId, message: 'Bank connection not found.' }, requestId)

  // Best effort on Stripe's side: a failure there must not leave the desktop unable to disconnect locally.
  try {
    const credentials = await resolveAccountStripe(env, accountIntegrationId)
    if (credentials.mode === 'real') {
      for (const account of await listAccounts(env, connectionId)) {
        try {
          await disconnectFinancialConnectionsAccount(env, credentials.secretKey, account.provider_account_id)
        } catch (error) {
          console.error('Stripe account disconnect failed (continuing):', error instanceof Error ? error.message : 'unknown error')
        }
      }
    }
  } catch (error) {
    console.error('Stripe credential lookup failed during disconnect (continuing):', error instanceof Error ? error.message : 'unknown error')
  }

  const disconnectedAt = nowIso()
  await env.DB.batch([
    env.DB.prepare(`UPDATE stripe_fc_connections SET connection_status = 'disconnected', updates_available = 0, updated_at = ? WHERE id = ?`).bind(disconnectedAt, connectionId),
    env.DB.prepare(`UPDATE stripe_fc_accounts SET is_active = 0, pending_batch_id = NULL, pending_cursor = NULL, updated_at = ? WHERE connection_id = ?`).bind(disconnectedAt, connectionId),
    env.DB.prepare(`UPDATE stripe_fc_delivery_batches SET delivery_status = 'expired' WHERE connection_id = ? AND delivery_status = 'pending'`).bind(connectionId),
  ])

  return jsonResponse(200, { ok: true, requestId, provider, connectionId, connectionStatus: 'disconnected', disconnectedAt }, requestId)
}

// POST /stripe/connections/accounts/sync-enabled { connectionId, providerAccountId, syncEnabled }
export async function handleSetStripeAccountSyncEnabled(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId, body } = authentication.request

  const connectionId = readIdentifier(body.connectionId)
  const providerAccountId = readIdentifier(body.providerAccountId)
  if (!connectionId || !providerAccountId || typeof body.syncEnabled !== 'boolean') {
    return badRequest(requestId, 'connectionId, providerAccountId and syncEnabled are required.')
  }
  const connection = await getOwnedConnection(env, accountIntegrationId, connectionId)
  if (!connection) return jsonResponse(404, { ok: false, requestId, message: 'Bank connection not found.' }, requestId)

  const updatedAt = nowIso()
  const result = await env.DB
    .prepare(`UPDATE stripe_fc_accounts SET sync_enabled = ?, updated_at = ? WHERE connection_id = ? AND provider_account_id = ?`)
    .bind(body.syncEnabled ? 1 : 0, updatedAt, connectionId, providerAccountId)
    .run()
  if (!result.meta.changes) return jsonResponse(404, { ok: false, requestId, message: 'Bank account not found.' }, requestId)

  return jsonResponse(200, { ok: true, requestId, provider, connectionId, providerAccountId, syncEnabled: body.syncEnabled, updatedAt }, requestId)
}

function toRecord(transaction: StripeFcTransaction) {
  const seconds = transaction.transacted_at
  const iso = new Date(seconds * 1000).toISOString()
  const description = transaction.description || 'Bank transaction'
  return {
    provider,
    providerTransactionId: transaction.id,
    providerAccountId: transaction.account,
    pendingProviderTransactionId: null,
    amount: (outflowSign * transaction.amount) / 100,
    isoCurrencyCode: (transaction.currency || 'usd').toUpperCase(),
    unofficialCurrencyCode: null,
    transactionDate: iso.slice(0, 10),
    transactionDateTime: iso,
    authorizedDate: null,
    authorizedDateTime: null,
    description,
    merchantName: null,
    originalDescription: description,
    pending: transaction.status === 'pending',
    paymentChannel: 'other',
    checkNumber: null,
    transactionCode: null,
    personalFinanceCategoryPrimary: null,
    personalFinanceCategoryDetailed: null,
    personalFinanceCategoryConfidenceLevel: null,
  }
}

// POST /stripe/transactions/sync { connectionId } -- pages each active, sync-enabled account's
// transactions changed since its acknowledged cursor and reserves a delivery batch. Stripe has no
// added/modified distinction to expose, and the desktop upserts both identically, so every changed
// transaction is delivered as "added"; void transactions are delivered as removed.
export async function handleSyncStripeTransactions(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId, body } = authentication.request

  const connectionId = readIdentifier(body.connectionId)
  if (!connectionId) return badRequest(requestId, 'connectionId is required.')
  const connection = await getOwnedConnection(env, accountIntegrationId, connectionId)
  if (!connection) return jsonResponse(404, { ok: false, requestId, message: 'Bank connection not found.' }, requestId)
  if (connection.connection_status === 'disconnected' || connection.connection_status === 'revoked') {
    return jsonResponse(409, { ok: false, requestId, message: 'This bank connection is disconnected.' }, requestId)
  }

  const stripe = await requireStripe(env, accountIntegrationId, requestId)
  if (!stripe.ok) return stripe.response
  const { secretKey } = stripe.credentials

  const startedAt = nowIso()

  // A pending, unexpired batch must be acknowledged first; an expired one is released and reissued.
  const pending = await env.DB
    .prepare(`SELECT id, expires_at FROM stripe_fc_delivery_batches WHERE connection_id = ? AND delivery_status = 'pending' ORDER BY issued_at DESC LIMIT 1`)
    .bind(connectionId)
    .first<{ id: string; expires_at: string }>()
  if (pending) {
    if (Date.parse(pending.expires_at) > Date.now()) {
      return jsonResponse(409, {
        ok: false,
        requestId,
        message: 'A previous delivery for this connection has not been acknowledged yet.',
        pendingBatchId: pending.id,
        pendingBatchExpiresAt: pending.expires_at,
      }, requestId)
    }
    await env.DB.batch([
      env.DB.prepare(`UPDATE stripe_fc_delivery_batches SET delivery_status = 'expired' WHERE id = ?`).bind(pending.id),
      env.DB.prepare(`UPDATE stripe_fc_accounts SET pending_batch_id = NULL, pending_cursor = NULL WHERE connection_id = ?`).bind(connectionId),
    ])
  }

  try {
    const accounts = await listAccounts(env, connectionId)
    const providerAccounts = accounts.map(account => accountMetadata(account, connection.institution_name))
    const added: ReturnType<typeof toRecord>[] = []
    const removed: { provider: typeof provider; providerTransactionId: string; providerAccountId: string }[] = []
    const cursorUpdates: { account: AccountRow; cursor: string }[] = []
    const cursorOnly: { account: AccountRow; cursor: string }[] = []

    for (const account of accounts) {
      if (account.sync_enabled !== 1) continue

      const stripeAccount = await retrieveFinancialConnectionsAccount(env, secretKey, account.provider_account_id)
      if (stripeAccount.status !== 'active') {
        // Stripe can deactivate an account (in its sandbox, right after the first transactions refresh). Record it and
        // keep the connection honest about it -- but the refresh data Stripe already holds is still readable, so an
        // inactive account still delivers anything not yet delivered; only a disconnected account is skipped outright.
        await env.DB.prepare(`UPDATE stripe_fc_accounts SET is_active = 0, updated_at = ? WHERE id = ?`).bind(startedAt, account.id).run()
        await env.DB.prepare(`UPDATE stripe_fc_connections SET connection_status = 'needs_attention', last_error_code = ?, last_error_at = ?, updated_at = ? WHERE id = ?`)
          .bind(`account_${stripeAccount.status}`, startedAt, startedAt, connectionId).run()
        if (stripeAccount.status === 'disconnected') continue
      }

      // Stripe only lists transactions once a refresh has succeeded; a first refresh that is still pending, or a
      // refresh that failed, answers the list call with an error that must not abort the whole connection's sync.
      // The refreshed_transactions webhook (or the next sync) picks the account up when its data exists.
      if (stripeAccount.transaction_refresh?.status !== 'succeeded') continue
      const targetCursor = stripeAccount.transaction_refresh?.id ?? null
      if (!targetCursor || targetCursor === account.acknowledged_cursor) continue

      const transactions = await listFinancialConnectionsTransactions(env, secretKey, account.provider_account_id, account.acknowledged_cursor)
      if (transactions.length === 0) {
        cursorOnly.push({ account, cursor: targetCursor })
        continue
      }
      for (const transaction of transactions) {
        if (transaction.status === 'void') {
          // A void that was never delivered (first sync) has nothing to remove on the desktop.
          if (account.acknowledged_cursor) {
            removed.push({ provider, providerTransactionId: transaction.id, providerAccountId: transaction.account })
          }
        } else {
          added.push(toRecord(transaction))
        }
      }
      cursorUpdates.push({ account, cursor: targetCursor })
    }

    const completedAt = nowIso()
    for (const entry of cursorOnly) {
      await env.DB.prepare(`UPDATE stripe_fc_accounts SET acknowledged_cursor = ?, last_sync_started_at = ?, last_sync_completed_at = ?, updated_at = ? WHERE id = ?`)
        .bind(entry.cursor, startedAt, completedAt, completedAt, entry.account.id).run()
    }

    if (added.length + removed.length === 0) {
      for (const entry of cursorUpdates) {
        await env.DB.prepare(`UPDATE stripe_fc_accounts SET acknowledged_cursor = ?, last_sync_started_at = ?, last_sync_completed_at = ?, updated_at = ? WHERE id = ?`)
          .bind(entry.cursor, startedAt, completedAt, completedAt, entry.account.id).run()
      }
      await env.DB.prepare(`UPDATE stripe_fc_connections SET updates_available = 0, updated_at = ? WHERE id = ?`).bind(completedAt, connectionId).run()
      return jsonResponse(200, {
        ok: true,
        requestId,
        provider,
        connectionId,
        dataReady: false,
        deliveryBatchCreated: false,
        providerAccounts,
      }, requestId)
    }

    const batchId = crypto.randomUUID()
    const issuedAt = completedAt
    const expiresAt = new Date(Date.parse(issuedAt) + deliveryLifetimeMilliseconds).toISOString()
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO stripe_fc_delivery_batches (id, connection_id, delivery_status, added_count, modified_count, removed_count, issued_at, expires_at)
        VALUES (?, ?, 'pending', ?, 0, ?, ?, ?)
      `).bind(batchId, connectionId, added.length, removed.length, issuedAt, expiresAt),
      ...cursorUpdates.map(entry => env.DB
        .prepare(`UPDATE stripe_fc_accounts SET pending_batch_id = ?, pending_cursor = ?, last_sync_started_at = ?, last_sync_completed_at = ?, updated_at = ? WHERE id = ?`)
        .bind(batchId, entry.cursor, startedAt, completedAt, completedAt, entry.account.id)),
    ])

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider,
      connectionId,
      dataReady: true,
      deliveryBatchCreated: true,
      batchId,
      issuedAt,
      expiresAt,
      addedCount: added.length,
      modifiedCount: 0,
      removedCount: removed.length,
      providerAccounts,
      addedRecords: added,
      modifiedRecords: [],
      removedRecords: removed,
    }, requestId)
  } catch (error) {
    if (error instanceof StripeApiError) return stripeErrorResponse(requestId, error)
    throw error
  }
}

// POST /stripe/transactions/acknowledge { connectionId, batchId, persistedAddedCount, ... } -- the
// desktop persisted the batch; advance each account's cursor to the value reserved with it.
export async function handleAcknowledgeStripeDelivery(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId, body } = authentication.request

  const connectionId = readIdentifier(body.connectionId)
  const batchId = readIdentifier(body.batchId)
  if (!connectionId || !batchId) return badRequest(requestId, 'connectionId and batchId are required.')
  const connection = await getOwnedConnection(env, accountIntegrationId, connectionId)
  if (!connection) return jsonResponse(404, { ok: false, requestId, message: 'Bank connection not found.' }, requestId)

  const batch = await env.DB
    .prepare(`SELECT id, delivery_status, added_count, modified_count, removed_count, acknowledged_at FROM stripe_fc_delivery_batches WHERE id = ? AND connection_id = ?`)
    .bind(batchId, connectionId)
    .first<{ id: string; delivery_status: string; added_count: number; modified_count: number; removed_count: number; acknowledged_at: string | null }>()
  if (!batch) return jsonResponse(404, { ok: false, requestId, message: 'Delivery batch not found.' }, requestId)

  if (
    body.persistedAddedCount !== batch.added_count
    || body.persistedModifiedCount !== batch.modified_count
    || body.persistedRemovedCount !== batch.removed_count
  ) {
    return jsonResponse(409, { ok: false, requestId, message: 'Acknowledged counts did not match the delivered batch.' }, requestId)
  }

  const counts = { addedCount: batch.added_count, modifiedCount: batch.modified_count, removedCount: batch.removed_count }

  if (batch.delivery_status === 'acknowledged') {
    return jsonResponse(200, {
      ok: true, requestId, provider, connectionId, batchId,
      deliveryStatus: 'acknowledged', cursorAdvanced: true, alreadyAcknowledged: true,
      acknowledgedAt: batch.acknowledged_at ?? nowIso(), ...counts,
    }, requestId)
  }
  if (batch.delivery_status !== 'pending') {
    return jsonResponse(409, { ok: false, requestId, message: 'This delivery batch has expired.' }, requestId)
  }

  const acknowledgedAt = nowIso()
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE stripe_fc_accounts
      SET acknowledged_cursor = pending_cursor, pending_batch_id = NULL, pending_cursor = NULL,
          last_acknowledged_at = ?, updated_at = ?
      WHERE connection_id = ? AND pending_batch_id = ?
    `).bind(acknowledgedAt, acknowledgedAt, connectionId, batchId),
    env.DB.prepare(`UPDATE stripe_fc_delivery_batches SET delivery_status = 'acknowledged', acknowledged_at = ? WHERE id = ?`).bind(acknowledgedAt, batchId),
    env.DB.prepare(`UPDATE stripe_fc_connections SET updates_available = 0, updated_at = ? WHERE id = ?`).bind(acknowledgedAt, connectionId),
  ])

  return jsonResponse(200, {
    ok: true, requestId, provider, connectionId, batchId,
    deliveryStatus: 'acknowledged', cursorAdvanced: true, alreadyAcknowledged: false,
    acknowledgedAt, ...counts,
  }, requestId)
}

// POST /stripe/transactions/automatic-status -- connections whose webhook says Stripe has new data.
export async function handleGetStripeAutomaticSyncStatus(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId } = authentication.request

  const result = await env.DB
    .prepare(`
      SELECT id, last_webhook_at, last_webhook_code
      FROM stripe_fc_connections
      WHERE account_integration_id = ? AND connection_status = 'active' AND updates_available = 1
    `)
    .bind(accountIntegrationId)
    .all<{ id: string; last_webhook_at: string | null; last_webhook_code: string | null }>()
  const rows = result.results ?? []

  return jsonResponse(200, {
    ok: true,
    requestId,
    provider,
    connectionIds: rows.map(row => row.id),
    connections: rows.map(row => ({
      connectionId: row.id,
      updatesAvailable: true,
      lastWebhookAt: row.last_webhook_at,
      lastWebhookCode: row.last_webhook_code,
    })),
  }, requestId)
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

async function verifyStripeWebhookSignature(rawBody: string, signatureHeader: string, secret: string) {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map(pair => pair.split('=').map(value => value.trim())).filter(pair => pair.length === 2),
  ) as Record<string, string>
  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${rawBody}`))
  const expected = Array.from(new Uint8Array(mac), value => value.toString(16).padStart(2, '0')).join('')
  return signatureHeader.split(',')
    .filter(pair => pair.trim().startsWith('v1='))
    .some(pair => timingSafeEqualHex(expected, pair.trim().slice(3)))
}

// POST /stripe/webhooks/{accountIntegrationId} (PUBLIC -- Stripe posts here; verified by the account's
// own webhook signing secret, stored encrypted by save-key). Marks the affected connection as having
// updates available (or needing attention); the desktop then syncs as it does for Plaid webhooks.
export async function handleStripeWebhook(request: Request, env: Env, requestId: string, accountIntegrationId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature') || ''

  const keyRow = await getStripeBankFeedKeyRow(env, accountIntegrationId)
  if (!keyRow?.encrypted_webhook_secret || !keyRow.webhook_secret_iv || !keyRow.webhook_secret_version) {
    return jsonResponse(404, { ok: false, requestId, message: 'No webhook is registered for this account.' }, requestId)
  }

  let webhookSecret: string
  try {
    webhookSecret = await decryptStripeSecret(env, { accountIntegrationId, kind: 'webhook_secret' }, {
      ciphertext: keyRow.encrypted_webhook_secret,
      iv: keyRow.webhook_secret_iv,
      version: keyRow.webhook_secret_version,
    })
  } catch (error) {
    console.error('Stripe webhook secret could not be read:', error instanceof Error ? error.message : 'unknown error')
    return serviceUnavailable(requestId, 'Webhook secret could not be read.')
  }

  if (!signature || !(await verifyStripeWebhookSignature(rawBody, signature, webhookSecret))) {
    return jsonResponse(400, { ok: false, requestId, message: 'Webhook signature verification failed.' }, requestId)
  }

  let event: { type?: string; data?: { object?: { id?: string } } } | null = null
  try {
    event = JSON.parse(rawBody)
  } catch {
    return badRequest(requestId, 'Webhook body is not valid JSON.')
  }

  const type = event?.type || ''
  const stripeAccountId = event?.data?.object?.id
  if (type.startsWith('financial_connections.account.') && typeof stripeAccountId === 'string') {
    const account = await env.DB
      .prepare(`
        SELECT a.connection_id AS connection_id
        FROM stripe_fc_accounts a JOIN stripe_fc_connections c ON c.id = a.connection_id
        WHERE a.provider_account_id = ? AND c.account_integration_id = ?
      `)
      .bind(stripeAccountId, accountIntegrationId)
      .first<{ connection_id: string }>()

    if (account) {
      const receivedAt = nowIso()
      if (type === 'financial_connections.account.deactivated' || type === 'financial_connections.account.disconnected') {
        await env.DB.batch([
          env.DB.prepare(`UPDATE stripe_fc_accounts SET is_active = 0, updated_at = ? WHERE provider_account_id = ?`).bind(receivedAt, stripeAccountId),
          env.DB.prepare(`UPDATE stripe_fc_connections SET connection_status = 'needs_attention', last_webhook_at = ?, last_webhook_code = ?, last_error_code = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND connection_status = 'active'`)
            .bind(receivedAt, type, type.split('.').pop() ?? null, receivedAt, receivedAt, account.connection_id),
        ])
      } else if (type === 'financial_connections.account.reactivated') {
        await env.DB.batch([
          env.DB.prepare(`UPDATE stripe_fc_accounts SET is_active = 1, updated_at = ? WHERE provider_account_id = ?`).bind(receivedAt, stripeAccountId),
          env.DB.prepare(`UPDATE stripe_fc_connections SET connection_status = 'active', updates_available = 1, last_webhook_at = ?, last_webhook_code = ?, last_error_code = NULL, last_error_at = NULL, updated_at = ? WHERE id = ? AND connection_status = 'needs_attention'`)
            .bind(receivedAt, type, receivedAt, account.connection_id),
        ])
      } else {
        await env.DB
          .prepare(`UPDATE stripe_fc_connections SET updates_available = 1, last_webhook_at = ?, last_webhook_code = ?, updated_at = ? WHERE id = ?`)
          .bind(receivedAt, type, receivedAt, account.connection_id)
          .run()
      }
    }
  }

  return jsonResponse(200, { ok: true, requestId, received: true }, requestId)
}
