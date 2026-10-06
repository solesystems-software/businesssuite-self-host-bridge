import type { Env } from './bankFeedWorkerTypes'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const accessTokenKeyVersion = 1
const aesKeyByteLength = 32
const aesGcmIvByteLength = 12

export class AccessTokenEncryptionConfigurationError extends Error {}

export class AccessTokenDecryptionError extends Error {}

export type EncryptedPlaidAccessToken = {
  encryptedAccessToken: string
  accessTokenIv: string
  accessTokenKeyVersion: number
}

type PlaidAccessTokenIdentity = {
  accountIntegrationId: string
  providerItemId: string
}

type PlaidAccessTokenEncryptionInput = PlaidAccessTokenIdentity & {
  accessToken: string
}

export type PlaidAccessTokenDecryptionInput = PlaidAccessTokenIdentity & {
  encryptedAccessToken: string
  accessTokenIv: string
  accessTokenKeyVersion: number
}

function decodeBase64(
  value: string,
  errorMessage: string,
) {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    throw new AccessTokenDecryptionError(errorMessage)
  }
}

function decodeConfiguredKey(value: string) {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    throw new AccessTokenEncryptionConfigurationError(
      'PLAID_ACCESS_TOKEN_ENCRYPTION_KEY_B64 must be valid Base64.',
    )
  }
}

function encodeBase64(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array
    ? value
    : new Uint8Array(value)
  let binary = ''

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

function createAdditionalData(
  input: PlaidAccessTokenIdentity,
  keyVersion: number,
) {
  return textEncoder.encode(JSON.stringify([
    'businesssuite-bank-feeds',
    keyVersion,
    input.accountIntegrationId,
    'plaid',
    input.providerItemId,
  ]))
}

async function importAccessTokenKey(
  env: Env,
  usage: KeyUsage,
) {
  const encodedKey = env.PLAID_ACCESS_TOKEN_ENCRYPTION_KEY_B64?.trim() || ''

  if (!encodedKey) {
    throw new AccessTokenEncryptionConfigurationError(
      'Plaid access-token encryption is not configured.',
    )
  }

  const keyBytes = decodeConfiguredKey(encodedKey)

  if (keyBytes.byteLength !== aesKeyByteLength) {
    keyBytes.fill(0)
    throw new AccessTokenEncryptionConfigurationError(
      'Plaid access-token encryption key must contain exactly 32 bytes.',
    )
  }

  try {
    return await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      [usage],
    )
  } finally {
    keyBytes.fill(0)
  }
}

export async function createPlaidAccessTokenEncryptor(env: Env) {
  const encryptionKey = await importAccessTokenKey(env, 'encrypt')

  return async function encryptPlaidAccessToken(
    input: PlaidAccessTokenEncryptionInput,
  ): Promise<EncryptedPlaidAccessToken> {
    const iv = crypto.getRandomValues(new Uint8Array(aesGcmIvByteLength))
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: createAdditionalData(input, accessTokenKeyVersion),
        tagLength: 128,
      },
      encryptionKey,
      textEncoder.encode(input.accessToken),
    )

    return {
      encryptedAccessToken: encodeBase64(encrypted),
      accessTokenIv: encodeBase64(iv),
      accessTokenKeyVersion,
    }
  }
}

export async function decryptPlaidAccessToken(
  env: Env,
  input: PlaidAccessTokenDecryptionInput,
) {
  if (input.accessTokenKeyVersion !== accessTokenKeyVersion) {
    throw new AccessTokenEncryptionConfigurationError(
      `Unsupported Plaid access-token key version: ${input.accessTokenKeyVersion}.`,
    )
  }

  const encryptedAccessToken = decodeBase64(
    input.encryptedAccessToken,
    'Stored Plaid access-token ciphertext is invalid.',
  )
  const iv = decodeBase64(
    input.accessTokenIv,
    'Stored Plaid access-token initialization vector is invalid.',
  )

  if (!encryptedAccessToken.byteLength || iv.byteLength !== aesGcmIvByteLength) {
    encryptedAccessToken.fill(0)
    iv.fill(0)
    throw new AccessTokenDecryptionError(
      'Stored Plaid access-token encryption metadata is invalid.',
    )
  }

  const decryptionKey = await importAccessTokenKey(env, 'decrypt')

  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: createAdditionalData(
          input,
          input.accessTokenKeyVersion,
        ),
        tagLength: 128,
      },
      decryptionKey,
      encryptedAccessToken,
    )
    const decryptedBytes = new Uint8Array(decrypted)
    let accessToken: string

    try {
      accessToken = textDecoder.decode(decryptedBytes)
    } finally {
      decryptedBytes.fill(0)
    }

    if (!accessToken || accessToken.length > 1024 || /\s/.test(accessToken)) {
      throw new AccessTokenDecryptionError(
        'Stored Plaid access token is invalid after decryption.',
      )
    }

    return accessToken
  } catch (error) {
    if (error instanceof AccessTokenDecryptionError) throw error

    throw new AccessTokenDecryptionError(
      'Stored Plaid access token could not be decrypted.',
    )
  } finally {
    encryptedAccessToken.fill(0)
    iv.fill(0)
  }
}
