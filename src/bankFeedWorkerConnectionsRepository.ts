import type {
  EncryptedPlaidAccessToken,
} from './accessTokenCrypto'
import type {
  Env,
  PlaidAccount,
  PlaidErrorResponse,
} from './bankFeedWorkerTypes'

type SchemaVersionRow = {
  version: number
}

type ExistingConnectionRow = {
  id: string
  account_integration_id: string
}

type SavePlaidConnectionInput = EncryptedPlaidAccessToken & {
  accountIntegrationId: string
  providerItemId: string
  institutionId: string | null
  institutionName: string | null
  consentExpirationTime: string | null
  webhookUrl: string | null
  webhookConfiguredAt: string | null
  itemError: PlaidErrorResponse | null
  accounts: PlaidAccount[]
}

export type StoredBankFeedAccountMetadata = {
  providerAccountId: string
  displayName: string
  officialName: string | null
  mask: string | null
  accountType: string
  accountSubtype: string | null
  isoCurrencyCode: string | null
  unofficialCurrencyCode: string | null
  isActive: boolean
  syncEnabled: boolean
}

export type SavedPlaidConnection = {
  connectionId: string
  connectionStatus: 'active' | 'needs_attention'
  replacedExistingConnection: boolean
  accountCount: number
  accounts: StoredBankFeedAccountMetadata[]
}

export type SetStoredPlaidAccountSyncEnabledInput = {
  accountIntegrationId: string
  connectionId: string
  providerAccountId: string
  syncEnabled: boolean
}

export type SetStoredPlaidAccountSyncEnabledResult = {
  connectionId: string
  providerAccountId: string
  syncEnabled: boolean
  updatedAt: string
}

export class BankFeedConnectionOwnershipError extends Error {}

export class BankFeedConnectionStorageUnavailableError extends Error {}

export class BankFeedAccountStorageValidationError extends Error {}

export class BankFeedConnectionNotFoundError extends Error {}

export class BankFeedAccountNotFoundError extends Error {}

export class BankFeedAccountSyncStateUnavailableError extends Error {}

function readOptionalString(value: unknown) {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function readRequiredStoredString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizePlaidAccounts(accounts: PlaidAccount[]) {
  const providerAccountIds = new Set<string>()
  const normalizedAccounts: Omit<
    StoredBankFeedAccountMetadata,
    'isActive' | 'syncEnabled'
  >[] = []

  for (const account of accounts) {
    const officialName = readOptionalString(account?.official_name)
    const mask = readOptionalString(account?.mask)
    const accountSubtype = readOptionalString(account?.subtype)
    const isoCurrencyCode = readOptionalString(
      account?.balances?.iso_currency_code,
    )
    const unofficialCurrencyCode = readOptionalString(
      account?.balances?.unofficial_currency_code,
    )

    if (
      !account
      || typeof account.account_id !== 'string'
      || !account.account_id.trim()
      || typeof account.name !== 'string'
      || !account.name.trim()
      || typeof account.type !== 'string'
      || !account.type.trim()
      || officialName === undefined
      || mask === undefined
      || accountSubtype === undefined
      || isoCurrencyCode === undefined
      || unofficialCurrencyCode === undefined
    ) {
      throw new BankFeedAccountStorageValidationError(
        'Plaid returned invalid connected-account metadata.',
      )
    }

    const providerAccountId = account.account_id.trim()
    if (providerAccountIds.has(providerAccountId)) {
      throw new BankFeedAccountStorageValidationError(
        'Plaid returned duplicate connected-account identifiers.',
      )
    }

    providerAccountIds.add(providerAccountId)
    normalizedAccounts.push({
      providerAccountId,
      displayName: account.name.trim(),
      officialName,
      mask,
      accountType: account.type.trim(),
      accountSubtype,
      isoCurrencyCode,
      unofficialCurrencyCode,
    })
  }

  return normalizedAccounts
}

export async function assertBankFeedConnectionStorageReady(
  env: Env,
  minimumVersion = 2,
) {
  try {
    const schemaVersion = await env.DB
      .prepare(`
        SELECT version
        FROM bank_feed_schema_versions
        ORDER BY version DESC
        LIMIT 1
      `)
      .first<SchemaVersionRow>()

    if (!schemaVersion || schemaVersion.version < minimumVersion) {
      throw new BankFeedConnectionStorageUnavailableError(
        'Bank-feed connection storage schema is unavailable.',
      )
    }
  } catch (error) {
    if (error instanceof BankFeedConnectionStorageUnavailableError) {
      throw error
    }

    throw new BankFeedConnectionStorageUnavailableError(
      'Bank-feed connection storage is unavailable.',
    )
  }
}

export async function savePlaidConnection(
  env: Env,
  input: SavePlaidConnectionInput,
): Promise<SavedPlaidConnection> {
  await assertBankFeedConnectionStorageReady(env, 4)
  const normalizedAccounts = normalizePlaidAccounts(input.accounts)

  const existingConnection = await env.DB
    .prepare(`
      SELECT id, account_integration_id
      FROM bank_feed_connections
      WHERE provider = ?
        AND provider_item_id = ?
      LIMIT 1
    `)
    .bind('plaid', input.providerItemId)
    .first<ExistingConnectionRow>()

  if (
    existingConnection
    && existingConnection.account_integration_id !== input.accountIntegrationId
  ) {
    throw new BankFeedConnectionOwnershipError(
      'Plaid Item is already assigned to another Account integration.',
    )
  }

  const connectionId = existingConnection?.id || crypto.randomUUID()
  const timestamp = new Date().toISOString()
  const itemErrorCode = input.itemError?.error_code || null
  const connectionStatus = itemErrorCode
    ? 'needs_attention'
    : 'active'
  const lastErrorAt = itemErrorCode ? timestamp : null

  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(`
        INSERT INTO bank_feed_connections (
          id,
          account_integration_id,
          provider,
          provider_item_id,
          encrypted_access_token,
          access_token_iv,
          access_token_key_version,
          connection_status,
          institution_id,
          institution_name,
          consent_expiration_time,
          webhook_url,
          webhook_configured_at,
          last_error_code,
          last_error_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, provider_item_id) DO UPDATE SET
          encrypted_access_token = excluded.encrypted_access_token,
          access_token_iv = excluded.access_token_iv,
          access_token_key_version = excluded.access_token_key_version,
          connection_status = excluded.connection_status,
          institution_id = excluded.institution_id,
          institution_name = excluded.institution_name,
          consent_expiration_time = excluded.consent_expiration_time,
          webhook_url = COALESCE(excluded.webhook_url, bank_feed_connections.webhook_url),
          webhook_configured_at = COALESCE(excluded.webhook_configured_at, bank_feed_connections.webhook_configured_at),
          last_error_code = excluded.last_error_code,
          last_error_at = excluded.last_error_at,
          updated_at = excluded.updated_at
      `)
      .bind(
        connectionId,
        input.accountIntegrationId,
        'plaid',
        input.providerItemId,
        input.encryptedAccessToken,
        input.accessTokenIv,
        input.accessTokenKeyVersion,
        connectionStatus,
        input.institutionId,
        input.institutionName,
        input.consentExpirationTime,
        input.webhookUrl,
        input.webhookConfiguredAt,
        itemErrorCode,
        lastErrorAt,
        timestamp,
        timestamp,
      ),
    env.DB
      .prepare(`
        INSERT INTO bank_feed_sync_state (
          connection_id,
          acknowledged_cursor,
          pending_batch_id,
          pending_cursor,
          updates_available,
          last_webhook_at,
          last_webhook_code,
          last_webhook_request_id,
          last_sync_started_at,
          last_sync_completed_at,
          last_acknowledged_at,
          updated_at
        ) VALUES (?, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `)
      .bind(connectionId, timestamp),
    env.DB
      .prepare(`
        UPDATE bank_feed_accounts
        SET is_active = 0,
            updated_at = ?
        WHERE connection_id = ?
          AND is_active = 1
      `)
      .bind(timestamp, connectionId),
  ]

  for (const account of normalizedAccounts) {
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO bank_feed_accounts (
            id,
            connection_id,
            provider_account_id,
            display_name,
            official_name,
            mask,
            account_type,
            account_subtype,
            iso_currency_code,
            unofficial_currency_code,
            is_active,
            sync_enabled,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
          ON CONFLICT(connection_id, provider_account_id) DO UPDATE SET
            display_name = excluded.display_name,
            official_name = excluded.official_name,
            mask = excluded.mask,
            account_type = excluded.account_type,
            account_subtype = excluded.account_subtype,
            iso_currency_code = excluded.iso_currency_code,
            unofficial_currency_code = excluded.unofficial_currency_code,
            is_active = 1,
            updated_at = excluded.updated_at
        `)
        .bind(
          crypto.randomUUID(),
          connectionId,
          account.providerAccountId,
          account.displayName,
          account.officialName,
          account.mask,
          account.accountType,
          account.accountSubtype,
          account.isoCurrencyCode,
          account.unofficialCurrencyCode,
          timestamp,
          timestamp,
        ),
      env.DB
        .prepare(`
          INSERT INTO bank_feed_account_sync_state (
            connection_id,
            provider_account_id,
            acknowledged_cursor,
            pending_batch_id,
            pending_cursor,
            last_sync_started_at,
            last_sync_completed_at,
            last_acknowledged_at,
            updated_at
          ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
          ON CONFLICT(connection_id, provider_account_id) DO UPDATE SET
            updated_at = excluded.updated_at
        `)
        .bind(connectionId, account.providerAccountId, timestamp),
    )
  }

  await env.DB.batch(statements)

  const storedAccounts = await listStoredBankFeedProviderAccountsForDelivery(
    env,
    input.accountIntegrationId,
    connectionId,
  )

  return {
    connectionId,
    connectionStatus,
    replacedExistingConnection: Boolean(existingConnection),
    accountCount: storedAccounts.length,
    accounts: storedAccounts.map(account => ({
      providerAccountId: account.providerAccountId,
      displayName: account.displayName,
      officialName: account.officialName,
      mask: account.mask,
      accountType: account.accountType,
      accountSubtype: account.accountSubtype,
      isoCurrencyCode: account.isoCurrencyCode,
      unofficialCurrencyCode: account.unofficialCurrencyCode,
      isActive: account.isActive,
      syncEnabled: account.syncEnabled,
    })),
  }
}

type StoredBankFeedProviderAccountDeliveryRow = {
  provider: string
  institution_name: string | null
  provider_account_id: string
  display_name: string
  official_name: string | null
  mask: string | null
  account_type: string
  account_subtype: string | null
  iso_currency_code: string | null
  unofficial_currency_code: string | null
  is_active: number
  sync_enabled: number
}

export type StoredBankFeedProviderAccountDeliveryMetadata = {
  provider: 'plaid'
  providerAccountId: string
  institutionName: string | null
  displayName: string
  officialName: string | null
  mask: string | null
  accountType: string
  accountSubtype: string | null
  isoCurrencyCode: string | null
  unofficialCurrencyCode: string | null
  isActive: boolean
  syncEnabled: boolean
}

function normalizeStoredProviderAccountDeliveryRow(
  row: StoredBankFeedProviderAccountDeliveryRow,
): StoredBankFeedProviderAccountDeliveryMetadata {
  const providerAccountId = readRequiredStoredString(row.provider_account_id)
  const displayName = readRequiredStoredString(row.display_name)
  const accountType = readRequiredStoredString(row.account_type)
  const institutionName = readOptionalString(row.institution_name)
  const officialName = readOptionalString(row.official_name)
  const mask = readOptionalString(row.mask)
  const accountSubtype = readOptionalString(row.account_subtype)
  const isoCurrencyCode = readOptionalString(row.iso_currency_code)
  const unofficialCurrencyCode = readOptionalString(
    row.unofficial_currency_code,
  )

  if (
    row.provider !== 'plaid'
    || !providerAccountId
    || !displayName
    || !accountType
    || institutionName === undefined
    || officialName === undefined
    || mask === undefined
    || accountSubtype === undefined
    || isoCurrencyCode === undefined
    || unofficialCurrencyCode === undefined
    || (row.is_active !== 0 && row.is_active !== 1)
    || (row.sync_enabled !== 0 && row.sync_enabled !== 1)
  ) {
    throw new BankFeedAccountStorageValidationError(
      'Stored connected-account metadata is invalid.',
    )
  }

  return {
    provider: 'plaid',
    providerAccountId,
    institutionName,
    displayName,
    officialName,
    mask,
    accountType,
    accountSubtype,
    isoCurrencyCode,
    unofficialCurrencyCode,
    isActive: row.is_active === 1,
    syncEnabled: row.sync_enabled === 1,
  }
}

export async function listStoredBankFeedProviderAccountsForDelivery(
  env: Env,
  accountIntegrationId: string,
  connectionId: string,
): Promise<StoredBankFeedProviderAccountDeliveryMetadata[]> {
  await assertBankFeedConnectionStorageReady(env, 3)

  const result = await env.DB
    .prepare(`
      SELECT
        connection.provider,
        connection.institution_name,
        account.provider_account_id,
        account.display_name,
        account.official_name,
        account.mask,
        account.account_type,
        account.account_subtype,
        account.iso_currency_code,
        account.unofficial_currency_code,
        account.is_active,
        account.sync_enabled
      FROM bank_feed_connections AS connection
      INNER JOIN bank_feed_accounts AS account
        ON account.connection_id = connection.id
      INNER JOIN bank_feed_account_sync_state AS account_state
        ON account_state.connection_id = account.connection_id
       AND account_state.provider_account_id = account.provider_account_id
      WHERE connection.id = ?
        AND connection.account_integration_id = ?
        AND connection.provider = 'plaid'
      ORDER BY
        account.is_active DESC,
        account.sync_enabled DESC,
        account.display_name,
        account.provider_account_id
    `)
    .bind(connectionId, accountIntegrationId)
    .all<StoredBankFeedProviderAccountDeliveryRow>()

  const accounts = result.results.map(
    normalizeStoredProviderAccountDeliveryRow,
  )

  if (accounts.length === 0) {
    throw new BankFeedAccountStorageValidationError(
      'Stored connected-account metadata is unavailable.',
    )
  }

  return accounts
}

type StoredPlaidConnectionCredentialRow = {
  id: string
  account_integration_id: string
  provider_item_id: string
  encrypted_access_token: string
  access_token_iv: string
  access_token_key_version: number
  connection_status: string
  institution_id: string | null
  institution_name: string | null
  consent_expiration_time: string | null
  webhook_url: string | null
  webhook_configured_at: string | null
}

export type StoredPlaidConnectionCredentials = {
  connectionId: string
  accountIntegrationId: string
  providerItemId: string
  encryptedAccessToken: string
  accessTokenIv: string
  accessTokenKeyVersion: number
  connectionStatus: 'active' | 'needs_attention' | 'disconnected' | 'revoked'
  institutionId: string | null
  institutionName: string | null
  consentExpirationTime: string | null
  webhookUrl: string | null
  webhookConfiguredAt: string | null
}

function normalizeStoredConnectionStatus(
  value: string,
): StoredPlaidConnectionCredentials['connectionStatus'] {
  if (
    value !== 'active'
    && value !== 'needs_attention'
    && value !== 'disconnected'
    && value !== 'revoked'
  ) {
    throw new BankFeedConnectionStorageUnavailableError(
      'Stored Bank Feed connection status is invalid.',
    )
  }

  return value
}

export async function getStoredPlaidConnectionCredentials(
  env: Env,
  accountIntegrationId: string,
  connectionId: string,
): Promise<StoredPlaidConnectionCredentials> {
  const row = await env.DB
    .prepare(`
      SELECT
        id,
        account_integration_id,
        provider_item_id,
        encrypted_access_token,
        access_token_iv,
        access_token_key_version,
        connection_status,
        institution_id,
        institution_name,
        consent_expiration_time,
        webhook_url,
        webhook_configured_at
      FROM bank_feed_connections
      WHERE id = ?
        AND account_integration_id = ?
        AND provider = 'plaid'
      LIMIT 1
    `)
    .bind(connectionId, accountIntegrationId)
    .first<StoredPlaidConnectionCredentialRow>()

  if (!row) {
    throw new BankFeedConnectionNotFoundError(
      'Bank Feed connection was not found.',
    )
  }

  return {
    connectionId: row.id,
    accountIntegrationId: row.account_integration_id,
    providerItemId: row.provider_item_id,
    encryptedAccessToken: row.encrypted_access_token,
    accessTokenIv: row.access_token_iv,
    accessTokenKeyVersion: Number(row.access_token_key_version),
    connectionStatus: normalizeStoredConnectionStatus(row.connection_status),
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    consentExpirationTime: row.consent_expiration_time,
    webhookUrl: row.webhook_url,
    webhookConfiguredAt: row.webhook_configured_at,
  }
}

type AccountSyncMutationRow = {
  connection_status: string
  connection_pending_batch_id: string | null
  is_active: number
  sync_enabled: number
  account_pending_batch_id: string | null
}

export async function setStoredPlaidAccountSyncEnabled(
  env: Env,
  input: SetStoredPlaidAccountSyncEnabledInput,
): Promise<SetStoredPlaidAccountSyncEnabledResult> {
  await assertBankFeedConnectionStorageReady(env, 3)

  const row = await env.DB
    .prepare(`
      SELECT
        connection.connection_status,
        connection_state.pending_batch_id AS connection_pending_batch_id,
        account.is_active,
        account.sync_enabled,
        account_state.pending_batch_id AS account_pending_batch_id
      FROM bank_feed_connections AS connection
      INNER JOIN bank_feed_sync_state AS connection_state
        ON connection_state.connection_id = connection.id
      INNER JOIN bank_feed_accounts AS account
        ON account.connection_id = connection.id
      LEFT JOIN bank_feed_account_sync_state AS account_state
        ON account_state.connection_id = account.connection_id
       AND account_state.provider_account_id = account.provider_account_id
      WHERE connection.id = ?
        AND connection.account_integration_id = ?
        AND connection.provider = 'plaid'
        AND account.provider_account_id = ?
      LIMIT 1
    `)
    .bind(
      input.connectionId,
      input.accountIntegrationId,
      input.providerAccountId,
    )
    .first<AccountSyncMutationRow>()

  if (!row) {
    throw new BankFeedAccountNotFoundError(
      'Bank Feed account was not found.',
    )
  }
  if (
    row.connection_status !== 'active'
    && row.connection_status !== 'needs_attention'
  ) {
    throw new BankFeedAccountSyncStateUnavailableError(
      'Only an active Bank Feed connection can change account synchronization.',
    )
  }
  if (row.is_active !== 1) {
    throw new BankFeedAccountSyncStateUnavailableError(
      'Unavailable provider accounts cannot be connected for synchronization.',
    )
  }
  if (
    row.connection_pending_batch_id !== null
    || row.account_pending_batch_id !== null
  ) {
    throw new BankFeedAccountSyncStateUnavailableError(
      'Account connection state cannot change while a synchronization delivery is pending.',
    )
  }

  const updatedAt = new Date().toISOString()
  if ((row.sync_enabled === 1) === input.syncEnabled) {
    return {
      connectionId: input.connectionId,
      providerAccountId: input.providerAccountId,
      syncEnabled: input.syncEnabled,
      updatedAt,
    }
  }

  const result = await env.DB
    .prepare(`
      UPDATE bank_feed_accounts
      SET sync_enabled = ?,
          updated_at = ?
      WHERE connection_id = ?
        AND provider_account_id = ?
        AND is_active = 1
        AND EXISTS (
          SELECT 1
          FROM bank_feed_connections AS connection
          WHERE connection.id = bank_feed_accounts.connection_id
            AND connection.account_integration_id = ?
            AND connection.provider = 'plaid'
            AND connection.connection_status IN ('active', 'needs_attention')
        )
    `)
    .bind(
      input.syncEnabled ? 1 : 0,
      updatedAt,
      input.connectionId,
      input.providerAccountId,
      input.accountIntegrationId,
    )
    .run()

  if (result.meta.changes !== 1) {
    throw new BankFeedAccountSyncStateUnavailableError(
      'Bank Feed account synchronization state changed concurrently.',
    )
  }

  await env.DB
    .prepare(`
      INSERT INTO bank_feed_account_sync_state (
        connection_id,
        provider_account_id,
        acknowledged_cursor,
        pending_batch_id,
        pending_cursor,
        last_sync_started_at,
        last_sync_completed_at,
        last_acknowledged_at,
        updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(connection_id, provider_account_id) DO UPDATE SET
        updated_at = excluded.updated_at
    `)
    .bind(input.connectionId, input.providerAccountId, updatedAt)
    .run()

  return {
    connectionId: input.connectionId,
    providerAccountId: input.providerAccountId,
    syncEnabled: input.syncEnabled,
    updatedAt,
  }
}

export async function markPlaidConnectionDisconnected(
  env: Env,
  accountIntegrationId: string,
  connectionId: string,
  disconnectedAt: string,
) {
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(`
        UPDATE bank_feed_delivery_batches
        SET delivery_status = 'failed',
            failure_code = COALESCE(failure_code, 'CONNECTION_DISCONNECTED')
        WHERE connection_id = ?
          AND delivery_status = 'issued'
      `)
      .bind(connectionId),
    env.DB
      .prepare(`
        UPDATE bank_feed_connections
        SET connection_status = 'disconnected',
            last_error_code = NULL,
            last_error_at = NULL,
            updated_at = ?
        WHERE id = ?
          AND account_integration_id = ?
          AND provider = 'plaid'
      `)
      .bind(disconnectedAt, connectionId, accountIntegrationId),
    env.DB
      .prepare(`
        UPDATE bank_feed_accounts
        SET is_active = 0,
            sync_enabled = 0,
            updated_at = ?
        WHERE connection_id = ?
      `)
      .bind(disconnectedAt, connectionId),
    env.DB
      .prepare(`
        UPDATE bank_feed_account_sync_state
        SET pending_batch_id = NULL,
            pending_cursor = NULL,
            updated_at = ?
        WHERE connection_id = ?
      `)
      .bind(disconnectedAt, connectionId),
    env.DB
      .prepare(`
        UPDATE bank_feed_sync_state
        SET pending_batch_id = NULL,
            pending_cursor = NULL,
            updates_available = 0,
            updated_at = ?
        WHERE connection_id = ?
      `)
      .bind(disconnectedAt, connectionId),
  ]

  const results = await env.DB.batch(statements)
  if (results[1]?.meta.changes !== 1) {
    throw new BankFeedConnectionNotFoundError(
      'Bank Feed connection was not found.',
    )
  }
}


export type PlaidWebhookApplicationResult = {
  matchedConnection: boolean
  connectionId: string | null
  updatesAvailable: boolean
}

export type PlaidAutomaticSyncConnection = {
  connectionId: string
  updatesAvailable: true
  lastWebhookAt: string | null
  lastWebhookCode: string | null
}

type PlaidWebhookConnectionRow = {
  id: string
  connection_status: string
}

type PlaidAutomaticSyncConnectionRow = {
  id: string
  updates_available: number
  last_webhook_at: string | null
  last_webhook_code: string | null
}

function normalizeWebhookIdentity(value: unknown, fieldName: string) {
  if (typeof value !== 'string') {
    throw new BankFeedConnectionStorageUnavailableError(
      `${fieldName} is unavailable.`,
    )
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 512) {
    throw new BankFeedConnectionStorageUnavailableError(
      `${fieldName} is invalid.`,
    )
  }
  return normalized
}

export async function applyVerifiedPlaidWebhook(
  env: Env,
  input: {
    providerItemId: string
    webhookType: string
    webhookCode: string
    providerAccountId: string | null
    providerRequestId: string | null
    providerErrorCode: string | null
    receivedAt: string
  },
): Promise<PlaidWebhookApplicationResult> {
  await assertBankFeedConnectionStorageReady(env, 4)

  const providerItemId = normalizeWebhookIdentity(
    input.providerItemId,
    'Plaid webhook Item id',
  )
  const webhookType = normalizeWebhookIdentity(
    input.webhookType,
    'Plaid webhook type',
  )
  const webhookCode = normalizeWebhookIdentity(
    input.webhookCode,
    'Plaid webhook code',
  )
  const providerAccountId = input.providerAccountId == null
    ? null
    : normalizeWebhookIdentity(
        input.providerAccountId,
        'Plaid webhook account id',
      )
  const providerRequestId = input.providerRequestId == null
    ? null
    : normalizeWebhookIdentity(
        input.providerRequestId,
        'Plaid webhook request id',
      )

  const connection = await env.DB
    .prepare(`
      SELECT id, connection_status
      FROM bank_feed_connections
      WHERE provider = 'plaid'
        AND provider_item_id = ?
      LIMIT 1
    `)
    .bind(providerItemId)
    .first<PlaidWebhookConnectionRow>()

  if (!connection) {
    return {
      matchedConnection: false,
      connectionId: null,
      updatesAvailable: false,
    }
  }

  const transactionUpdateCodes = new Set([
    'SYNC_UPDATES_AVAILABLE',
    'DEFAULT_UPDATE',
    'INITIAL_UPDATE',
    'HISTORICAL_UPDATE',
    'TRANSACTIONS_REMOVED',
  ])
  const updatesAvailable = transactionUpdateCodes.has(webhookCode)
    || webhookCode === 'LOGIN_REPAIRED'
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(`
        UPDATE bank_feed_sync_state
        SET updates_available = CASE
              WHEN ? = 1 THEN 1
              ELSE updates_available
            END,
            last_webhook_at = ?,
            last_webhook_code = ?,
            last_webhook_request_id = ?,
            updated_at = ?
        WHERE connection_id = ?
      `)
      .bind(
        updatesAvailable ? 1 : 0,
        input.receivedAt,
        `${webhookType}:${webhookCode}`,
        providerRequestId,
        input.receivedAt,
        connection.id,
      ),
  ]

  if (webhookCode === 'ERROR') {
    statements.push(
      env.DB
        .prepare(`
          UPDATE bank_feed_connections
          SET connection_status = 'needs_attention',
              last_error_code = ?,
              last_error_at = ?,
              updated_at = ?
          WHERE id = ?
            AND connection_status NOT IN ('disconnected', 'revoked')
        `)
        .bind(
          input.providerErrorCode || 'PLAID_WEBHOOK_ERROR',
          input.receivedAt,
          input.receivedAt,
          connection.id,
        ),
    )
  } else if (webhookCode === 'LOGIN_REPAIRED') {
    statements.push(
      env.DB
        .prepare(`
          UPDATE bank_feed_connections
          SET connection_status = 'active',
              last_error_code = NULL,
              last_error_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND connection_status = 'needs_attention'
        `)
        .bind(input.receivedAt, connection.id),
    )
  } else if (
    webhookCode === 'PENDING_DISCONNECT'
    || webhookCode === 'PENDING_EXPIRATION'
    || webhookCode === 'NEW_ACCOUNTS_AVAILABLE'
  ) {
    statements.push(
      env.DB
        .prepare(`
          UPDATE bank_feed_connections
          SET connection_status = 'needs_attention',
              last_error_code = ?,
              last_error_at = ?,
              updated_at = ?
          WHERE id = ?
            AND connection_status = 'active'
        `)
        .bind(webhookCode, input.receivedAt, input.receivedAt, connection.id),
    )
  } else if (webhookCode === 'USER_PERMISSION_REVOKED') {
    statements.push(
      env.DB
        .prepare(`
          UPDATE bank_feed_connections
          SET connection_status = 'revoked',
              last_error_code = 'USER_PERMISSION_REVOKED',
              last_error_at = ?,
              updated_at = ?
          WHERE id = ?
            AND connection_status <> 'disconnected'
        `)
        .bind(input.receivedAt, input.receivedAt, connection.id),
      env.DB
        .prepare(`
          UPDATE bank_feed_accounts
          SET is_active = 0,
              sync_enabled = 0,
              updated_at = ?
          WHERE connection_id = ?
        `)
        .bind(input.receivedAt, connection.id),
      env.DB
        .prepare(`
          UPDATE bank_feed_sync_state
          SET updates_available = 0,
              pending_batch_id = NULL,
              pending_cursor = NULL,
              updated_at = ?
          WHERE connection_id = ?
        `)
        .bind(input.receivedAt, connection.id),
    )
  } else if (webhookCode === 'USER_ACCOUNT_REVOKED' && providerAccountId) {
    statements.push(
      env.DB
        .prepare(`
          UPDATE bank_feed_accounts
          SET is_active = 0,
              sync_enabled = 0,
              updated_at = ?
          WHERE connection_id = ?
            AND provider_account_id = ?
        `)
        .bind(input.receivedAt, connection.id, providerAccountId),
    )
  } else if (webhookCode === 'WEBHOOK_UPDATE_ACKNOWLEDGED') {
    statements.push(
      env.DB
        .prepare(`
          UPDATE bank_feed_connections
          SET webhook_configured_at = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .bind(input.receivedAt, input.receivedAt, connection.id),
    )
  }

  await env.DB.batch(statements)

  return {
    matchedConnection: true,
    connectionId: connection.id,
    updatesAvailable,
  }
}

export async function listPlaidConnectionsWithAutomaticUpdates(
  env: Env,
  accountIntegrationId: string,
): Promise<PlaidAutomaticSyncConnection[]> {
  await assertBankFeedConnectionStorageReady(env, 4)

  const result = await env.DB
    .prepare(`
      SELECT
        connection.id,
        state.updates_available,
        state.last_webhook_at,
        state.last_webhook_code
      FROM bank_feed_connections AS connection
      INNER JOIN bank_feed_sync_state AS state
        ON state.connection_id = connection.id
      WHERE connection.account_integration_id = ?
        AND connection.provider = 'plaid'
        AND connection.connection_status IN ('active', 'needs_attention')
        AND state.updates_available = 1
        AND state.pending_batch_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM bank_feed_accounts AS account
          WHERE account.connection_id = connection.id
            AND account.is_active = 1
            AND account.sync_enabled = 1
        )
      ORDER BY COALESCE(state.last_webhook_at, state.updated_at), connection.id
    `)
    .bind(accountIntegrationId)
    .all<PlaidAutomaticSyncConnectionRow>()

  return result.results.map(row => ({
    connectionId: row.id,
    updatesAvailable: true,
    lastWebhookAt: row.last_webhook_at,
    lastWebhookCode: row.last_webhook_code,
  }))
}

export async function listPlaidConnectionsForWebhookRegistration(
  env: Env,
  accountIntegrationId: string,
): Promise<StoredPlaidConnectionCredentials[]> {
  await assertBankFeedConnectionStorageReady(env, 4)

  const result = await env.DB
    .prepare(`
      SELECT id
      FROM bank_feed_connections
      WHERE account_integration_id = ?
        AND provider = 'plaid'
        AND connection_status IN ('active', 'needs_attention')
      ORDER BY created_at, id
    `)
    .bind(accountIntegrationId)
    .all<{ id: string }>()

  const connections: StoredPlaidConnectionCredentials[] = []
  for (const row of result.results) {
    connections.push(await getStoredPlaidConnectionCredentials(
      env,
      accountIntegrationId,
      row.id,
    ))
  }
  return connections
}

export async function markPlaidConnectionWebhookConfigured(
  env: Env,
  input: {
    accountIntegrationId: string
    connectionId: string
    webhookUrl: string
    configuredAt: string
  },
) {
  await assertBankFeedConnectionStorageReady(env, 4)

  const result = await env.DB
    .prepare(`
      UPDATE bank_feed_connections
      SET webhook_url = ?,
          webhook_configured_at = ?,
          updated_at = ?
      WHERE id = ?
        AND account_integration_id = ?
        AND provider = 'plaid'
        AND connection_status IN ('active', 'needs_attention')
    `)
    .bind(
      input.webhookUrl,
      input.configuredAt,
      input.configuredAt,
      input.connectionId,
      input.accountIntegrationId,
    )
    .run()

  if (result.meta.changes !== 1) {
    throw new BankFeedConnectionNotFoundError(
      'Active Bank Feed connection was not found.',
    )
  }
}
