export type PlaidEnvironment = 'sandbox' | 'development' | 'production'

export type Env = {
  DB: D1Database
  SERVICE_ENVIRONMENT: string
  PLAID_ENVIRONMENT: PlaidEnvironment
  PLAID_CLIENT_ID?: string
  PLAID_SECRET?: string
  PLAID_ACCESS_TOKEN_ENCRYPTION_KEY_B64?: string
  // Stripe Financial Connections (Bank Connections): base64 32-byte AES-GCM key (Worker secret) that
  // encrypts each account's own Stripe API key and webhook signing secret at rest -- see
  // stripeApiKeyCrypto.ts. Independent of Client Portal's own STRIPE_API_KEY_ENCRYPTION_KEY.
  STRIPE_API_KEY_ENCRYPTION_KEY?: string
  // Development-only override of https://api.stripe.com/v1 so local integration tests can stub Stripe.
  // Ignored unless SERVICE_ENVIRONMENT is 'development'.
  STRIPE_API_BASE_URL?: string
}

export type JsonBody = Record<string, unknown>

export type BankFeedSchemaVersionRow = {
  version: number
  description: string
  applied_at: string
}

export type AuthenticatedJsonRequest = {
  accountIntegrationId: string
  body: JsonBody
}

export type PlaidLinkTokenCreateRequest = {
  client_name: string
  language: 'en'
  country_codes: ['US']
  user: {
    client_user_id: string
  }
  products?: ['transactions']
  transactions?: {
    days_requested: 730
  }
  access_token?: string
  update?: {
    account_selection_enabled?: boolean
  }
  webhook?: string
}

export type PlaidLinkTokenCreateResponse = {
  link_token: string
  expiration: string
  request_id: string
}

export type PlaidPublicTokenExchangeRequest = {
  public_token: string
}

export type PlaidPublicTokenExchangeResponse = {
  access_token: string
  item_id: string
  request_id: string
}



export type PlaidItemWebhookUpdateRequest = {
  access_token: string
  webhook: string
}

export type PlaidItemWebhookUpdateResponse = {
  item: PlaidItem
  request_id: string
}

export type PlaidWebhookVerificationKeyRequest = {
  key_id: string
}

export type PlaidWebhookVerificationKey = JsonWebKey & {
  alg: 'ES256'
  crv: 'P-256'
  kid: string
  kty: 'EC'
  use: 'sig'
  created_at: number
  expired_at: number | null
  x: string
  y: string
}

export type PlaidWebhookVerificationKeyResponse = {
  key: PlaidWebhookVerificationKey
  request_id: string
}

export type PlaidWebhookBody = {
  webhook_type: string
  webhook_code: string
  item_id?: string
  request_id?: string
  error?: PlaidErrorResponse | null
  [key: string]: unknown
}

export type PlaidItemRemoveRequest = {
  access_token: string
}

export type PlaidItemRemoveResponse = {
  request_id: string
}

export type PlaidAccountsGetRequest = {
  access_token: string
}

export type PlaidAccountBalances = {
  iso_currency_code: string | null
  unofficial_currency_code: string | null
}

export type PlaidAccount = {
  account_id: string
  balances: PlaidAccountBalances
  mask: string | null
  name: string
  official_name: string | null
  type: string
  subtype: string | null
}

export type PlaidItem = {
  item_id: string
  institution_id: string | null
  institution_name: string | null
  consent_expiration_time: string | null
  error: PlaidErrorResponse | null
}

export type PlaidAccountsGetResponse = {
  accounts: PlaidAccount[]
  item: PlaidItem
  request_id: string
}

export type PlaidTransactionsSyncRequest = {
  access_token: string
  cursor?: string
  count: 500
  options: {
    include_original_description: true
  }
}

export type PlaidPersonalFinanceCategory = {
  primary: string
  detailed: string
  confidence_level: string | null
}

export type PlaidTransaction = {
  account_id: string
  transaction_id: string
  pending_transaction_id: string | null
  amount: number
  iso_currency_code: string | null
  unofficial_currency_code: string | null
  date: string
  datetime: string | null
  authorized_date: string | null
  authorized_datetime: string | null
  name: string
  merchant_name: string | null
  original_description?: string | null
  pending: boolean
  payment_channel: string
  check_number: string | null
  transaction_code: string | null
  personal_finance_category: PlaidPersonalFinanceCategory | null
}

export type PlaidRemovedTransaction = {
  transaction_id: string
  account_id: string
}

export type PlaidTransactionsSyncResponse = {
  added: PlaidTransaction[]
  modified: PlaidTransaction[]
  removed: PlaidRemovedTransaction[]
  next_cursor: string
  has_more: boolean
  request_id: string
  transactions_update_status: string
}

export type PlaidErrorResponse = {
  error_type?: string
  error_code?: string
  error_message?: string
  display_message?: string | null
  request_id?: string
}

export type StripeBankFeedKeyRow = {
  account_integration_id: string
  encrypted_secret_key: string
  secret_key_iv: string
  secret_key_version: number
  key_kind: 'restricted' | 'secret'
  publishable_key: string
  livemode: number
  webhook_endpoint_id: string | null
  encrypted_webhook_secret: string | null
  webhook_secret_iv: string | null
  webhook_secret_version: number | null
  customer_id: string | null
  last_verified_at: string | null
  created_at: string
  updated_at: string
}
