import type { Env } from './bankFeedWorkerTypes'

// Stripe_Unified_Raw_API_Key_Payments_And_Bank_Connections_Task_Spec_20260929.md (Bank Connections, own copy
// per Galen 2026-09-29: the bank-feed Worker is fully independent of Client Portal): at-rest
// encryption for the Business-supplied Stripe API key and the per-account webhook signing secret. Identical
// in design to cloudflare-client-portal/src/stripeApiKeyCrypto.ts (AES-GCM, versioned key, per-record IV,
// identity-bound additional data), kept as a separate copy because the two Workers share no code and
// deploy independently. This Worker's own separate encryption key secret is used.
// The key material is the STRIPE_API_KEY_ENCRYPTION_KEY Worker secret (base64, exactly 32 bytes).

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
export const stripeSecretKeyVersion = 1
const aesKeyByteLength = 32
const aesGcmIvByteLength = 12

export class StripeKeyEncryptionConfigurationError extends Error {}
export class StripeKeyDecryptionError extends Error {}

export type StripeSecretKind = 'api_key' | 'webhook_secret'

export type EncryptedStripeSecret = {
  ciphertext: string
  iv: string
  version: number
}

type StripeSecretIdentity = {
  accountIntegrationId: string
  kind: StripeSecretKind
}

function decodeBase64(value: string, errorMessage: string) {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    throw new StripeKeyDecryptionError(errorMessage)
  }
}

function encodeBase64(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function createAdditionalData(identity: StripeSecretIdentity, version: number) {
  return textEncoder.encode(JSON.stringify([
    'businesssuite-bank-feeds',
    version,
    identity.accountIntegrationId,
    'stripe',
    identity.kind,
  ]))
}

async function importEncryptionKey(env: Env, usage: KeyUsage) {
  const encodedKey = env.STRIPE_API_KEY_ENCRYPTION_KEY?.trim() || ''
  if (!encodedKey) {
    throw new StripeKeyEncryptionConfigurationError('Stripe API key encryption is not configured on this Worker.')
  }

  let keyBytes: Uint8Array
  try {
    const binary = atob(encodedKey)
    keyBytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    throw new StripeKeyEncryptionConfigurationError('STRIPE_API_KEY_ENCRYPTION_KEY must be valid Base64.')
  }

  if (keyBytes.byteLength !== aesKeyByteLength) {
    keyBytes.fill(0)
    throw new StripeKeyEncryptionConfigurationError('Stripe API key encryption key must contain exactly 32 bytes.')
  }

  try {
    return await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [usage])
  } finally {
    keyBytes.fill(0)
  }
}

export async function encryptStripeSecret(
  env: Env,
  identity: StripeSecretIdentity,
  plaintext: string,
): Promise<EncryptedStripeSecret> {
  const encryptionKey = await importEncryptionKey(env, 'encrypt')
  const iv = crypto.getRandomValues(new Uint8Array(aesGcmIvByteLength))
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: createAdditionalData(identity, stripeSecretKeyVersion),
      tagLength: 128,
    },
    encryptionKey,
    textEncoder.encode(plaintext),
  )
  return {
    ciphertext: encodeBase64(encrypted),
    iv: encodeBase64(iv),
    version: stripeSecretKeyVersion,
  }
}

export async function decryptStripeSecret(
  env: Env,
  identity: StripeSecretIdentity,
  encrypted: EncryptedStripeSecret,
): Promise<string> {
  if (encrypted.version !== stripeSecretKeyVersion) {
    throw new StripeKeyEncryptionConfigurationError(`Unsupported Stripe key encryption version: ${encrypted.version}.`)
  }

  const ciphertext = decodeBase64(encrypted.ciphertext, 'Stored Stripe secret ciphertext is invalid.')
  const iv = decodeBase64(encrypted.iv, 'Stored Stripe secret initialization vector is invalid.')

  if (!ciphertext.byteLength || iv.byteLength !== aesGcmIvByteLength) {
    ciphertext.fill(0)
    iv.fill(0)
    throw new StripeKeyDecryptionError('Stored Stripe secret encryption metadata is invalid.')
  }

  const decryptionKey = await importEncryptionKey(env, 'decrypt')

  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: createAdditionalData(identity, encrypted.version),
        tagLength: 128,
      },
      decryptionKey,
      ciphertext,
    )
    const decryptedBytes = new Uint8Array(decrypted)
    let plaintext: string
    try {
      plaintext = textDecoder.decode(decryptedBytes)
    } finally {
      decryptedBytes.fill(0)
    }
    if (!plaintext || plaintext.length > 1024 || /\s/.test(plaintext)) {
      throw new StripeKeyDecryptionError('Stored Stripe secret is invalid after decryption.')
    }
    return plaintext
  } catch (error) {
    if (error instanceof StripeKeyDecryptionError) throw error
    throw new StripeKeyDecryptionError('Stored Stripe secret could not be decrypted.')
  } finally {
    ciphertext.fill(0)
    iv.fill(0)
  }
}
