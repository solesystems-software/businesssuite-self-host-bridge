import { stripeApiBase, stripeAuthHeaders } from './stripeBankFeedKeys'
import type { Env } from './bankFeedWorkerTypes'

// Stripe Financial Connections calls for Bank Connections, authenticated with the account's own
// Stripe API key (Stripe_Unified_Raw_API_Key_Payments_And_Bank_Connections_Task_Spec_20260929.md).
// Parallel to plaidClient.ts, which stays untouched. Response shapes below are the fields this Worker
// actually reads, taken from Stripe's Financial Connections API reference.

export class StripeApiError extends Error {
  readonly status: number
  readonly stripeCode: string | null
  readonly stripeRequestId: string | null

  constructor(status: number, message: string, stripeCode: string | null, stripeRequestId: string | null) {
    super(message)
    this.name = 'StripeApiError'
    this.status = status
    this.stripeCode = stripeCode
    this.stripeRequestId = stripeRequestId
  }
}

export type StripeFcBalance = {
  as_of?: number
  current?: Record<string, number> | null
} | null

export type StripeFcAccount = {
  id: string
  institution_name: string | null
  display_name: string | null
  last4: string | null
  category: string | null
  subcategory: string | null
  status: 'active' | 'inactive' | 'disconnected' | string
  permissions?: string[] | null
  account_holder?: { type?: string; customer?: string | null } | null
  balance?: StripeFcBalance
  transaction_refresh?: { id: string; status?: string; last_attempted_at?: number; next_refresh_available_at?: number | null } | null
}

export type StripeFcSession = {
  id: string
  client_secret?: string
  status?: string
  account_holder?: { type?: string; customer?: string | null } | null
  accounts?: { data?: StripeFcAccount[] } | null
}

export type StripeFcTransaction = {
  id: string
  account: string
  amount: number
  currency: string
  description: string | null
  status: 'pending' | 'posted' | 'void' | string
  status_transitions?: { posted_at?: number | null; void_at?: number | null } | null
  transacted_at: number
  transaction_refresh: string
  updated?: number
}

type StripeList<T> = { data: T[]; has_more: boolean }

async function stripeRequest<T>(
  env: Env,
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  params?: URLSearchParams,
): Promise<T> {
  const url = `${stripeApiBase(env)}${path}${method === 'GET' && params && params.toString() ? `?${params.toString()}` : ''}`
  const response = await fetch(url, {
    method,
    headers: stripeAuthHeaders(
      secretKey,
      method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
    ),
    body: method === 'POST' ? params : undefined,
  })
  const payload = await response.json().catch(() => null) as (T & { error?: { message?: string; code?: string } }) | null
  if (!response.ok || !payload) {
    throw new StripeApiError(
      response.status,
      payload?.error?.message || `Stripe request failed with HTTP ${response.status}.`,
      payload?.error?.code ?? null,
      response.headers.get('request-id'),
    )
  }
  return payload
}

export async function createStripeCustomer(env: Env, secretKey: string, accountIntegrationId: string) {
  const params = new URLSearchParams()
  params.set('description', 'Sole Business Suite bank connections')
  params.set('metadata[account_integration_id]', accountIntegrationId)
  const customer = await stripeRequest<{ id: string }>(env, secretKey, 'POST', '/customers', params)
  return customer.id
}

// Transactions and balances only -- not payment_method or ownership (spec Part G item 6).
//
// No `prefetch`: verified against Stripe's sandbox (2026-09-30) that a Session created with prefetch[]=transactions
// (or balances) has every account it links deactivated by Stripe about 3 seconds after creation -- status
// `inactive`, never subscribable, never syncable -- while the identical Session without prefetch keeps them
// `active`. The transactions subscription made right after linking (subscribeFinancialConnectionsAccountToTransactions)
// starts the first refresh instead. The country filter is harmless.
export async function createFinancialConnectionsSession(env: Env, secretKey: string, customerId: string) {
  const params = new URLSearchParams()
  params.set('account_holder[type]', 'customer')
  params.set('account_holder[customer]', customerId)
  params.append('permissions[]', 'transactions')
  params.append('permissions[]', 'balances')
  params.append('filters[countries][]', 'US')
  return stripeRequest<StripeFcSession>(env, secretKey, 'POST', '/financial_connections/sessions', params)
}

export async function retrieveFinancialConnectionsSession(env: Env, secretKey: string, sessionId: string) {
  return stripeRequest<StripeFcSession>(env, secretKey, 'GET', `/financial_connections/sessions/${encodeURIComponent(sessionId)}`)
}

export async function listFinancialConnectionsAccountsForSession(env: Env, secretKey: string, sessionId: string) {
  const params = new URLSearchParams()
  params.set('session', sessionId)
  params.set('limit', '100')
  const list = await stripeRequest<StripeList<StripeFcAccount>>(env, secretKey, 'GET', '/financial_connections/accounts', params)
  return list.data
}

export async function retrieveFinancialConnectionsAccount(env: Env, secretKey: string, accountId: string) {
  return stripeRequest<StripeFcAccount>(env, secretKey, 'GET', `/financial_connections/accounts/${encodeURIComponent(accountId)}`)
}

// Subscribing also initiates a refresh; Stripe then refreshes roughly daily and fires
// financial_connections.account.refreshed_transactions.
export async function subscribeFinancialConnectionsAccountToTransactions(env: Env, secretKey: string, accountId: string) {
  const params = new URLSearchParams()
  params.append('features[]', 'transactions')
  return stripeRequest<StripeFcAccount>(env, secretKey, 'POST', `/financial_connections/accounts/${encodeURIComponent(accountId)}/subscribe`, params)
}

export async function disconnectFinancialConnectionsAccount(env: Env, secretKey: string, accountId: string) {
  return stripeRequest<StripeFcAccount>(env, secretKey, 'POST', `/financial_connections/accounts/${encodeURIComponent(accountId)}/disconnect`, new URLSearchParams())
}

const transactionPageSize = 100
const maximumTransactionPages = 100

// Every transaction created or updated by a refresh after `afterRefreshId` (all transactions when null).
export async function listFinancialConnectionsTransactions(
  env: Env,
  secretKey: string,
  accountId: string,
  afterRefreshId: string | null,
) {
  const transactions: StripeFcTransaction[] = []
  let startingAfter: string | null = null

  for (let page = 0; page < maximumTransactionPages; page += 1) {
    const params = new URLSearchParams()
    params.set('account', accountId)
    params.set('limit', String(transactionPageSize))
    if (afterRefreshId) params.set('transaction_refresh[after]', afterRefreshId)
    if (startingAfter) params.set('starting_after', startingAfter)

    const list: StripeList<StripeFcTransaction> = await stripeRequest(env, secretKey, 'GET', '/financial_connections/transactions', params)
    transactions.push(...list.data)
    if (!list.has_more || list.data.length === 0) return transactions
    startingAfter = list.data[list.data.length - 1].id
  }

  throw new StripeApiError(502, 'Stripe returned more transaction pages than this Worker will read in one sync.', null, null)
}
