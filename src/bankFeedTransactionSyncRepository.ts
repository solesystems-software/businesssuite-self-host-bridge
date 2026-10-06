import type { Env } from './bankFeedWorkerTypes'

const deliveryLifetimeMilliseconds = 24 * 60 * 60 * 1000

export type ReservedPlaidAccountTransactionSync = {
  providerAccountId: string
  acknowledgedCursor: string | null
}

export type ReservedPlaidTransactionSync = {
  batchId: string
  connectionId: string
  providerItemId: string
  encryptedAccessToken: string
  accessTokenIv: string
  accessTokenKeyVersion: number
  accountStreams: ReservedPlaidAccountTransactionSync[]
  issuedAt: string
  expiresAt: string
}

type PlaidSyncConnectionRow = {
  id: string
  provider_item_id: string
  encrypted_access_token: string
  access_token_iv: string
  access_token_key_version: number
  connection_status: string
  pending_batch_id: string | null
  pending_delivery_status: string | null
  pending_expires_at: string | null
}

type PlaidAccountSyncRow = {
  provider_account_id: string
  acknowledged_cursor: string | null
  pending_batch_id: string | null
}

type PendingBatchRow = {
  pending_batch_id: string | null
  pending_expires_at: string | null
}

export class BankFeedSyncConnectionNotFoundError extends Error {}

export class BankFeedSyncConnectionUnavailableError extends Error {}

export class BankFeedPendingDeliveryBatchError extends Error {
  readonly batchId: string | null
  readonly expiresAt: string | null

  constructor(batchId: string | null, expiresAt: string | null) {
    super('A transaction delivery batch is already awaiting acknowledgment.')
    this.batchId = batchId
    this.expiresAt = expiresAt
  }
}

export class BankFeedTransactionSyncStorageError extends Error {}

function isFutureTimestamp(value: string | null, now: Date) {
  if (!value) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > now.getTime()
}

async function loadPlaidSyncConnection(
  env: Env,
  accountIntegrationId: string,
  connectionId: string,
) {
  try {
    return await env.DB
      .prepare(`
        SELECT
          connection.id,
          connection.provider_item_id,
          connection.encrypted_access_token,
          connection.access_token_iv,
          connection.access_token_key_version,
          connection.connection_status,
          state.pending_batch_id,
          batch.delivery_status AS pending_delivery_status,
          batch.expires_at AS pending_expires_at
        FROM bank_feed_connections AS connection
        INNER JOIN bank_feed_sync_state AS state
          ON state.connection_id = connection.id
        LEFT JOIN bank_feed_delivery_batches AS batch
          ON batch.id = state.pending_batch_id
        WHERE connection.id = ?
          AND connection.account_integration_id = ?
          AND connection.provider = 'plaid'
        LIMIT 1
      `)
      .bind(connectionId, accountIntegrationId)
      .first<PlaidSyncConnectionRow>()
  } catch (error) {
    console.error('Bank-feed transaction-sync connection query failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed transaction-sync storage is unavailable.',
    )
  }
}

async function loadEnabledAccountStreams(env: Env, connectionId: string) {
  try {
    const result = await env.DB
      .prepare(`
        SELECT
          account.provider_account_id,
          state.acknowledged_cursor,
          state.pending_batch_id
        FROM bank_feed_accounts AS account
        INNER JOIN bank_feed_account_sync_state AS state
          ON state.connection_id = account.connection_id
         AND state.provider_account_id = account.provider_account_id
        WHERE account.connection_id = ?
          AND account.is_active = 1
          AND account.sync_enabled = 1
        ORDER BY account.provider_account_id
      `)
      .bind(connectionId)
      .all<PlaidAccountSyncRow>()

    return result.results
  } catch (error) {
    console.error('Bank-feed account transaction-sync query failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed account synchronization storage is unavailable.',
    )
  }
}

async function clearExpiredOrInvalidPendingBatch(
  env: Env,
  connection: PlaidSyncConnectionRow,
  timestamp: string,
) {
  if (!connection.pending_batch_id) return

  try {
    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE bank_feed_delivery_batches
          SET delivery_status = 'expired',
              failure_code = COALESCE(failure_code, 'DELIVERY_EXPIRED')
          WHERE id = ?
            AND connection_id = ?
            AND delivery_status = 'issued'
        `)
        .bind(connection.pending_batch_id, connection.id),
      env.DB
        .prepare(`
          UPDATE bank_feed_account_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(timestamp, connection.id, connection.pending_batch_id),
      env.DB
        .prepare(`
          UPDATE bank_feed_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(timestamp, connection.id, connection.pending_batch_id),
    ])
  } catch (error) {
    console.error('Expired bank-feed delivery cleanup failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed transaction-sync storage is unavailable.',
    )
  }
}

async function loadCurrentPendingBatch(env: Env, connectionId: string) {
  return env.DB
    .prepare(`
      SELECT
        state.pending_batch_id,
        batch.expires_at AS pending_expires_at
      FROM bank_feed_sync_state AS state
      LEFT JOIN bank_feed_delivery_batches AS batch
        ON batch.id = state.pending_batch_id
      WHERE state.connection_id = ?
      LIMIT 1
    `)
    .bind(connectionId)
    .first<PendingBatchRow>()
}

export async function reservePlaidTransactionSync(
  env: Env,
  accountIntegrationId: string,
  connectionId: string,
): Promise<ReservedPlaidTransactionSync> {
  const connection = await loadPlaidSyncConnection(
    env,
    accountIntegrationId,
    connectionId,
  )

  if (!connection) {
    throw new BankFeedSyncConnectionNotFoundError(
      'Bank-feed connection was not found.',
    )
  }

  if (
    connection.connection_status !== 'active'
    && connection.connection_status !== 'needs_attention'
  ) {
    throw new BankFeedSyncConnectionUnavailableError(
      'Bank-feed connection is not active.',
    )
  }

  const now = new Date()
  const issuedAt = now.toISOString()
  const expiresAt = new Date(
    now.getTime() + deliveryLifetimeMilliseconds,
  ).toISOString()

  if (connection.pending_batch_id) {
    const pendingIsActive = connection.pending_delivery_status === 'issued'
      && isFutureTimestamp(connection.pending_expires_at, now)

    if (pendingIsActive) {
      throw new BankFeedPendingDeliveryBatchError(
        connection.pending_batch_id,
        connection.pending_expires_at,
      )
    }

    await clearExpiredOrInvalidPendingBatch(env, connection, issuedAt)
  }

  const accountRows = await loadEnabledAccountStreams(env, connection.id)
  if (accountRows.some(account => account.pending_batch_id !== null)) {
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed account synchronization contains an unexpected pending batch.',
    )
  }

  const batchId = crypto.randomUUID()

  try {
    const reservationResult = await env.DB
      .prepare(`
        UPDATE bank_feed_sync_state
        SET pending_batch_id = ?,
            pending_cursor = NULL,
            last_sync_started_at = ?,
            updated_at = ?
        WHERE connection_id = ?
          AND pending_batch_id IS NULL
      `)
      .bind(batchId, issuedAt, issuedAt, connection.id)
      .run()

    if (reservationResult.meta.changes !== 1) {
      const pendingBatch = await loadCurrentPendingBatch(env, connection.id)
      throw new BankFeedPendingDeliveryBatchError(
        pendingBatch?.pending_batch_id || null,
        pendingBatch?.pending_expires_at || null,
      )
    }

    if (accountRows.length > 0) {
      const statements = accountRows.map(account => (
        env.DB
          .prepare(`
            UPDATE bank_feed_account_sync_state
            SET last_sync_started_at = ?,
                updated_at = ?
            WHERE connection_id = ?
              AND provider_account_id = ?
              AND pending_batch_id IS NULL
          `)
          .bind(
            issuedAt,
            issuedAt,
            connection.id,
            account.provider_account_id,
          )
      ))
      const results = await env.DB.batch(statements)
      if (results.some(result => result.meta.changes !== 1)) {
        throw new Error('Bank-feed account synchronization state changed concurrently.')
      }
    }
  } catch (error) {
    if (error instanceof BankFeedPendingDeliveryBatchError) throw error

    try {
      await env.DB
        .prepare(`
          UPDATE bank_feed_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(issuedAt, connection.id, batchId)
        .run()
    } catch (cleanupError) {
      console.error('Bank-feed reservation rollback failed:', cleanupError)
    }

    console.error('Bank-feed transaction-sync reservation failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed transaction-sync storage is unavailable.',
    )
  }

  return {
    batchId,
    connectionId: connection.id,
    providerItemId: connection.provider_item_id,
    encryptedAccessToken: connection.encrypted_access_token,
    accessTokenIv: connection.access_token_iv,
    accessTokenKeyVersion: connection.access_token_key_version,
    accountStreams: accountRows.map(account => ({
      providerAccountId: account.provider_account_id,
      acknowledgedCursor: account.acknowledged_cursor,
    })),
    issuedAt,
    expiresAt,
  }
}

export type PlaidAccountCursorTransition = {
  providerAccountId: string
  fromCursor: string | null
  proposedCursor: string
}

type FinalizePlaidTransactionSyncInput = ReservedPlaidTransactionSync & {
  requestId: string
  accountCursors: PlaidAccountCursorTransition[]
  addedCount: number
  modifiedCount: number
  removedCount: number
}

export async function finalizePlaidTransactionSync(
  env: Env,
  input: FinalizePlaidTransactionSyncInput,
) {
  const completedAt = new Date().toISOString()
  const reservedIds = new Set(
    input.accountStreams.map(stream => stream.providerAccountId),
  )
  const transitionIds = new Set(
    input.accountCursors.map(transition => transition.providerAccountId),
  )

  if (
    reservedIds.size !== transitionIds.size
    || [...reservedIds].some(id => !transitionIds.has(id))
    || input.accountCursors.some(transition => !transition.proposedCursor)
  ) {
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed account cursor transitions are incomplete.',
    )
  }

  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(`
        INSERT INTO bank_feed_delivery_batches (
          id,
          connection_id,
          request_id,
          from_cursor,
          proposed_cursor,
          delivery_status,
          added_count,
          modified_count,
          removed_count,
          issued_at,
          acknowledged_at,
          expires_at,
          failure_code
        ) VALUES (?, ?, ?, NULL, NULL, 'issued', ?, ?, ?, ?, NULL, ?, NULL)
      `)
      .bind(
        input.batchId,
        input.connectionId,
        input.requestId,
        input.addedCount,
        input.modifiedCount,
        input.removedCount,
        input.issuedAt,
        input.expiresAt,
      ),
  ]

  for (const transition of input.accountCursors) {
    statements.push(
      env.DB
        .prepare(`
          INSERT INTO bank_feed_delivery_batch_accounts (
            batch_id,
            connection_id,
            provider_account_id,
            from_cursor,
            proposed_cursor
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .bind(
          input.batchId,
          input.connectionId,
          transition.providerAccountId,
          transition.fromCursor,
          transition.proposedCursor,
        ),
      env.DB
        .prepare(`
          UPDATE bank_feed_account_sync_state
          SET pending_batch_id = ?,
              pending_cursor = ?,
              last_sync_completed_at = ?,
              updated_at = ?
          WHERE connection_id = ?
            AND provider_account_id = ?
            AND pending_batch_id IS NULL
            AND acknowledged_cursor IS ?
        `)
        .bind(
          input.batchId,
          transition.proposedCursor,
          completedAt,
          completedAt,
          input.connectionId,
          transition.providerAccountId,
          transition.fromCursor,
        ),
    )
  }

  statements.push(
    env.DB
      .prepare(`
        UPDATE bank_feed_sync_state
        SET pending_cursor = NULL,
            updates_available = 0,
            last_sync_completed_at = ?,
            updated_at = ?
        WHERE connection_id = ?
          AND pending_batch_id = ?
      `)
      .bind(
        completedAt,
        completedAt,
        input.connectionId,
        input.batchId,
      ),
  )

  try {
    const results = await env.DB.batch(statements)
    const expectedChangedIndexes: number[] = []
    for (let index = 0; index < input.accountCursors.length; index += 1) {
      expectedChangedIndexes.push(2 + (index * 2))
    }
    expectedChangedIndexes.push(results.length - 1)

    if (expectedChangedIndexes.some(index => results[index]?.meta.changes !== 1)) {
      throw new Error('Transaction-sync reservation was lost before finalization.')
    }
  } catch (error) {
    console.error('Bank-feed transaction-sync finalization failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed transaction-sync delivery could not be recorded.',
    )
  }
}

type FailPlaidTransactionSyncInput = ReservedPlaidTransactionSync & {
  requestId: string
  failureCode: string
}

export async function failPlaidTransactionSync(
  env: Env,
  input: FailPlaidTransactionSyncInput,
) {
  const completedAt = new Date().toISOString()

  try {
    await env.DB.batch([
      env.DB
        .prepare(`
          INSERT INTO bank_feed_delivery_batches (
            id,
            connection_id,
            request_id,
            from_cursor,
            proposed_cursor,
            delivery_status,
            added_count,
            modified_count,
            removed_count,
            issued_at,
            acknowledged_at,
            expires_at,
            failure_code
          ) VALUES (?, ?, ?, NULL, NULL, 'failed', 0, 0, 0, ?, NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            delivery_status = 'failed',
            failure_code = excluded.failure_code
        `)
        .bind(
          input.batchId,
          input.connectionId,
          input.requestId,
          input.issuedAt,
          input.expiresAt,
          input.failureCode,
        ),
      env.DB
        .prepare(`
          UPDATE bank_feed_account_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              last_sync_completed_at = ?,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(completedAt, completedAt, input.connectionId, input.batchId),
      env.DB
        .prepare(`
          UPDATE bank_feed_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              last_sync_completed_at = ?,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(completedAt, completedAt, input.connectionId, input.batchId),
    ])
  } catch (error) {
    console.error('Bank-feed transaction-sync failure cleanup failed:', error)
  }
}

export async function releasePlaidTransactionSyncReservation(
  env: Env,
  reservation: ReservedPlaidTransactionSync,
) {
  const completedAt = new Date().toISOString()

  try {
    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE bank_feed_account_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              last_sync_completed_at = ?,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(
          completedAt,
          completedAt,
          reservation.connectionId,
          reservation.batchId,
        ),
      env.DB
        .prepare(`
          UPDATE bank_feed_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              last_sync_completed_at = ?,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(
          completedAt,
          completedAt,
          reservation.connectionId,
          reservation.batchId,
        ),
    ])
  } catch (error) {
    console.error('Bank-feed transaction-sync reservation release failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed transaction-sync reservation could not be released.',
    )
  }
}

type PlaidTransactionDeliveryAcknowledgmentRow = {
  id: string
  connection_id: string
  delivery_status: string
  proposed_cursor: string | null
  added_count: number
  modified_count: number
  removed_count: number
  acknowledged_at: string | null
  expires_at: string
  pending_batch_id: string | null
  pending_cursor: string | null
  acknowledged_cursor: string | null
}

type PlaidDeliveryAccountCursorRow = {
  provider_account_id: string
  proposed_cursor: string
  state_pending_batch_id: string | null
  state_pending_cursor: string | null
  state_acknowledged_cursor: string | null
}

export type PlaidTransactionDeliveryAcknowledgmentInput = {
  connectionId: string
  batchId: string
  persistedAddedCount: number
  persistedModifiedCount: number
  persistedRemovedCount: number
}

export type PlaidTransactionDeliveryAcknowledgment = {
  connectionId: string
  batchId: string
  alreadyAcknowledged: boolean
  acknowledgedAt: string
  addedCount: number
  modifiedCount: number
  removedCount: number
}

export class BankFeedDeliveryAcknowledgmentNotFoundError extends Error {}

export class BankFeedDeliveryAcknowledgmentConflictError extends Error {
  readonly conflictCode: string

  constructor(conflictCode: string, message: string) {
    super(message)
    this.conflictCode = conflictCode
  }
}

export class BankFeedDeliveryAcknowledgmentCountMismatchError extends Error {
  readonly expectedAddedCount: number
  readonly expectedModifiedCount: number
  readonly expectedRemovedCount: number

  constructor(row: PlaidTransactionDeliveryAcknowledgmentRow) {
    super('Persisted record counts do not match the issued delivery batch.')
    this.expectedAddedCount = row.added_count
    this.expectedModifiedCount = row.modified_count
    this.expectedRemovedCount = row.removed_count
  }
}

async function loadPlaidTransactionDeliveryAcknowledgment(
  env: Env,
  accountIntegrationId: string,
  connectionId: string,
  batchId: string,
) {
  try {
    return await env.DB
      .prepare(`
        SELECT
          batch.id,
          batch.connection_id,
          batch.delivery_status,
          batch.proposed_cursor,
          batch.added_count,
          batch.modified_count,
          batch.removed_count,
          batch.acknowledged_at,
          batch.expires_at,
          state.pending_batch_id,
          state.pending_cursor,
          state.acknowledged_cursor
        FROM bank_feed_delivery_batches AS batch
        INNER JOIN bank_feed_connections AS connection
          ON connection.id = batch.connection_id
        INNER JOIN bank_feed_sync_state AS state
          ON state.connection_id = batch.connection_id
        WHERE batch.id = ?
          AND batch.connection_id = ?
          AND connection.account_integration_id = ?
          AND connection.provider = 'plaid'
        LIMIT 1
      `)
      .bind(batchId, connectionId, accountIntegrationId)
      .first<PlaidTransactionDeliveryAcknowledgmentRow>()
  } catch (error) {
    console.error('Bank-feed delivery acknowledgment query failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed delivery acknowledgment storage is unavailable.',
    )
  }
}

async function loadDeliveryAccountCursors(
  env: Env,
  connectionId: string,
  batchId: string,
) {
  const result = await env.DB
    .prepare(`
      SELECT
        batch_account.provider_account_id,
        batch_account.proposed_cursor,
        state.pending_batch_id AS state_pending_batch_id,
        state.pending_cursor AS state_pending_cursor,
        state.acknowledged_cursor AS state_acknowledged_cursor
      FROM bank_feed_delivery_batch_accounts AS batch_account
      INNER JOIN bank_feed_account_sync_state AS state
        ON state.connection_id = batch_account.connection_id
       AND state.provider_account_id = batch_account.provider_account_id
      WHERE batch_account.batch_id = ?
        AND batch_account.connection_id = ?
      ORDER BY batch_account.provider_account_id
    `)
    .bind(batchId, connectionId)
    .all<PlaidDeliveryAccountCursorRow>()

  return result.results
}

function assertPersistedCountsMatch(
  row: PlaidTransactionDeliveryAcknowledgmentRow,
  input: PlaidTransactionDeliveryAcknowledgmentInput,
) {
  if (
    row.added_count !== input.persistedAddedCount
    || row.modified_count !== input.persistedModifiedCount
    || row.removed_count !== input.persistedRemovedCount
  ) {
    throw new BankFeedDeliveryAcknowledgmentCountMismatchError(row)
  }
}

function acknowledgedResult(
  row: PlaidTransactionDeliveryAcknowledgmentRow,
  alreadyAcknowledged: boolean,
): PlaidTransactionDeliveryAcknowledgment {
  if (!row.acknowledged_at) {
    throw new BankFeedTransactionSyncStorageError(
      'Acknowledged transaction delivery metadata is incomplete.',
    )
  }

  return {
    connectionId: row.connection_id,
    batchId: row.id,
    alreadyAcknowledged,
    acknowledgedAt: row.acknowledged_at,
    addedCount: row.added_count,
    modifiedCount: row.modified_count,
    removedCount: row.removed_count,
  }
}

async function expirePlaidTransactionDelivery(
  env: Env,
  row: PlaidTransactionDeliveryAcknowledgmentRow,
  timestamp: string,
) {
  try {
    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE bank_feed_delivery_batches
          SET delivery_status = 'expired',
              failure_code = COALESCE(failure_code, 'DELIVERY_EXPIRED')
          WHERE id = ?
            AND connection_id = ?
            AND delivery_status = 'issued'
        `)
        .bind(row.id, row.connection_id),
      env.DB
        .prepare(`
          UPDATE bank_feed_account_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(timestamp, row.connection_id, row.id),
      env.DB
        .prepare(`
          UPDATE bank_feed_sync_state
          SET pending_batch_id = NULL,
              pending_cursor = NULL,
              updated_at = ?
          WHERE connection_id = ?
            AND pending_batch_id = ?
        `)
        .bind(timestamp, row.connection_id, row.id),
    ])
  } catch (error) {
    console.error('Expired bank-feed delivery acknowledgment cleanup failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Bank-feed delivery acknowledgment storage is unavailable.',
    )
  }
}

async function acknowledgeAccountCursorDelivery(
  env: Env,
  row: PlaidTransactionDeliveryAcknowledgmentRow,
  accountCursors: PlaidDeliveryAccountCursorRow[],
  acknowledgedAt: string,
) {
  const statements: D1PreparedStatement[] = []

  for (const account of accountCursors) {
    if (
      account.state_pending_batch_id !== row.id
      || account.state_pending_cursor !== account.proposed_cursor
    ) {
      throw new BankFeedDeliveryAcknowledgmentConflictError(
        'DELIVERY_STATE_MISMATCH',
        'Transaction delivery account cursor is not the current pending delivery.',
      )
    }

    statements.push(
      env.DB
        .prepare(`
          UPDATE bank_feed_account_sync_state
          SET acknowledged_cursor = ?,
              pending_batch_id = NULL,
              pending_cursor = NULL,
              last_acknowledged_at = ?,
              updated_at = ?
          WHERE connection_id = ?
            AND provider_account_id = ?
            AND pending_batch_id = ?
            AND pending_cursor = ?
        `)
        .bind(
          account.proposed_cursor,
          acknowledgedAt,
          acknowledgedAt,
          row.connection_id,
          account.provider_account_id,
          row.id,
          account.proposed_cursor,
        ),
    )
  }

  statements.push(
    env.DB
      .prepare(`
        UPDATE bank_feed_sync_state
        SET pending_batch_id = NULL,
            pending_cursor = NULL,
            updates_available = 0,
            last_acknowledged_at = ?,
            updated_at = ?
        WHERE connection_id = ?
          AND pending_batch_id = ?
      `)
      .bind(acknowledgedAt, acknowledgedAt, row.connection_id, row.id),
    env.DB
      .prepare(`
        UPDATE bank_feed_delivery_batches
        SET delivery_status = 'acknowledged',
            acknowledged_at = ?,
            failure_code = NULL
        WHERE id = ?
          AND connection_id = ?
          AND delivery_status = 'issued'
          AND expires_at > ?
      `)
      .bind(acknowledgedAt, row.id, row.connection_id, acknowledgedAt),
  )

  const results = await env.DB.batch(statements)
  if (results.some(result => result.meta.changes !== 1)) {
    throw new Error('Transaction delivery acknowledgment state changed concurrently.')
  }
}

async function acknowledgeLegacyCursorDelivery(
  env: Env,
  row: PlaidTransactionDeliveryAcknowledgmentRow,
  acknowledgedAt: string,
) {
  if (!row.proposed_cursor) {
    throw new BankFeedDeliveryAcknowledgmentConflictError(
      'DELIVERY_CURSOR_MISSING',
      'Transaction delivery batch does not contain an acknowledgment cursor.',
    )
  }
  if (
    row.pending_batch_id !== row.id
    || row.pending_cursor !== row.proposed_cursor
  ) {
    throw new BankFeedDeliveryAcknowledgmentConflictError(
      'DELIVERY_STATE_MISMATCH',
      'Transaction delivery batch is not the current pending delivery.',
    )
  }

  const results = await env.DB.batch([
    env.DB
      .prepare(`
        UPDATE bank_feed_sync_state
        SET acknowledged_cursor = ?,
            pending_batch_id = NULL,
            pending_cursor = NULL,
            updates_available = 0,
            last_acknowledged_at = ?,
            updated_at = ?
        WHERE connection_id = ?
          AND pending_batch_id = ?
          AND pending_cursor = ?
      `)
      .bind(
        row.proposed_cursor,
        acknowledgedAt,
        acknowledgedAt,
        row.connection_id,
        row.id,
        row.proposed_cursor,
      ),
    env.DB
      .prepare(`
        UPDATE bank_feed_delivery_batches
        SET delivery_status = 'acknowledged',
            acknowledged_at = ?,
            failure_code = NULL
        WHERE id = ?
          AND connection_id = ?
          AND delivery_status = 'issued'
          AND proposed_cursor = ?
          AND expires_at > ?
      `)
      .bind(
        acknowledgedAt,
        row.id,
        row.connection_id,
        row.proposed_cursor,
        acknowledgedAt,
      ),
  ])

  if (results.some(result => result.meta.changes !== 1)) {
    throw new Error('Transaction delivery acknowledgment state changed concurrently.')
  }
}

export async function acknowledgePlaidTransactionDelivery(
  env: Env,
  accountIntegrationId: string,
  input: PlaidTransactionDeliveryAcknowledgmentInput,
): Promise<PlaidTransactionDeliveryAcknowledgment> {
  let row = await loadPlaidTransactionDeliveryAcknowledgment(
    env,
    accountIntegrationId,
    input.connectionId,
    input.batchId,
  )

  if (!row) {
    throw new BankFeedDeliveryAcknowledgmentNotFoundError(
      'Transaction delivery batch was not found.',
    )
  }

  assertPersistedCountsMatch(row, input)
  let accountCursors = await loadDeliveryAccountCursors(
    env,
    row.connection_id,
    row.id,
  )

  if (row.delivery_status === 'acknowledged') {
    const accountCursorsMatch = accountCursors.length > 0
      ? accountCursors.every(account => (
          account.state_acknowledged_cursor === account.proposed_cursor
          && account.state_pending_batch_id === null
          && account.state_pending_cursor === null
        ))
      : row.proposed_cursor !== null
        && row.acknowledged_cursor === row.proposed_cursor

    if (!accountCursorsMatch) {
      throw new BankFeedTransactionSyncStorageError(
        'Acknowledged transaction delivery cursor does not match the batch.',
      )
    }

    return acknowledgedResult(row, true)
  }

  if (row.delivery_status === 'expired') {
    throw new BankFeedDeliveryAcknowledgmentConflictError(
      'DELIVERY_EXPIRED',
      'Transaction delivery batch has expired.',
    )
  }

  if (row.delivery_status !== 'issued') {
    throw new BankFeedDeliveryAcknowledgmentConflictError(
      'DELIVERY_NOT_ACKNOWLEDGEABLE',
      'Transaction delivery batch cannot be acknowledged.',
    )
  }

  const now = new Date()
  const acknowledgedAt = now.toISOString()
  const expiresAt = Date.parse(row.expires_at)

  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    await expirePlaidTransactionDelivery(env, row, acknowledgedAt)
    throw new BankFeedDeliveryAcknowledgmentConflictError(
      'DELIVERY_EXPIRED',
      'Transaction delivery batch has expired.',
    )
  }

  try {
    if (accountCursors.length > 0) {
      await acknowledgeAccountCursorDelivery(
        env,
        row,
        accountCursors,
        acknowledgedAt,
      )
    } else {
      await acknowledgeLegacyCursorDelivery(env, row, acknowledgedAt)
    }
  } catch (error) {
    if (
      error instanceof BankFeedTransactionSyncStorageError
      || error instanceof BankFeedDeliveryAcknowledgmentConflictError
    ) {
      throw error
    }

    row = await loadPlaidTransactionDeliveryAcknowledgment(
      env,
      accountIntegrationId,
      input.connectionId,
      input.batchId,
    )
    accountCursors = row
      ? await loadDeliveryAccountCursors(env, row.connection_id, row.id)
      : []

    const concurrentlyAcknowledged = row
      && row.delivery_status === 'acknowledged'
      && (
        accountCursors.length > 0
          ? accountCursors.every(account => (
              account.state_acknowledged_cursor === account.proposed_cursor
              && account.state_pending_batch_id === null
              && account.state_pending_cursor === null
            ))
          : row.proposed_cursor !== null
            && row.acknowledged_cursor === row.proposed_cursor
      )

    if (row && concurrentlyAcknowledged) {
      return acknowledgedResult(row, true)
    }

    console.error('Bank-feed delivery acknowledgment update failed:', error)
    throw new BankFeedTransactionSyncStorageError(
      'Transaction delivery acknowledgment could not be recorded.',
    )
  }

  row = await loadPlaidTransactionDeliveryAcknowledgment(
    env,
    accountIntegrationId,
    input.connectionId,
    input.batchId,
  )

  if (!row || row.delivery_status !== 'acknowledged') {
    throw new BankFeedTransactionSyncStorageError(
      'Transaction delivery acknowledgment could not be verified.',
    )
  }

  return acknowledgedResult(row, false)
}
