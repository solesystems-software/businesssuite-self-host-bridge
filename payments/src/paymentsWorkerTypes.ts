export type Env = {
  DB: D1Database
  SERVICE_ENVIRONMENT: string
  // Base64, exactly 32 random bytes (Worker secret): encrypts each Business's own Stripe API key and its
  // webhook signing secret at rest -- see stripeApiKeyCrypto.ts.
  STRIPE_API_KEY_ENCRYPTION_KEY?: string
  // Development-only override of https://api.stripe.com/v1 so local integration tests can stub Stripe.
  // Ignored unless SERVICE_ENVIRONMENT is 'development'.
  STRIPE_API_BASE_URL?: string
}

export type JsonBody = Record<string, unknown>

export type PaymentsSchemaVersionRow = {
  version: number
  description: string
  applied_at: string
}

export type AuthenticatedBusinessRequest = {
  businessId: string
  body: JsonBody
}

export type PaymentMethod = 'card_in_app' | 'payment_link'
export type PaymentStatus = 'requires_payment' | 'processing' | 'succeeded' | 'failed' | 'canceled'

export type StripeApiKeyRow = {
  business_id: string
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
  last_verified_at: string | null
  created_at: string
  updated_at: string
}

export type PaymentLinkRow = {
  token: string
  business_id: string
  invoice_ref: string
  title: string
  amount_cents: number
  currency: string
  created_at: string
  revoked_at: string | null
}

export type PaymentRow = {
  id: string
  business_id: string
  invoice_ref: string
  amount_cents: number
  currency: string
  method: PaymentMethod
  payment_intent_id: string
  link_token: string | null
  status: PaymentStatus
  created_at: string
  updated_at: string
  succeeded_at: string | null
  desktop_acknowledged_at: string | null
}
