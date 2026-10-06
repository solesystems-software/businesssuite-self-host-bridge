import {
  badGateway,
  badRequest,
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
  BankFeedAccountStorageValidationError,
  listStoredBankFeedProviderAccountsForDelivery,
} from './bankFeedWorkerConnectionsRepository'
import {
  BankFeedPendingDeliveryBatchError,
  BankFeedSyncConnectionNotFoundError,
  BankFeedSyncConnectionUnavailableError,
  BankFeedTransactionSyncStorageError,
  failPlaidTransactionSync,
  finalizePlaidTransactionSync,
  releasePlaidTransactionSyncReservation,
  reservePlaidTransactionSync,
} from './bankFeedTransactionSyncRepository'
import {
  PlaidApiError,
  PlaidConfigurationError,
  syncPlaidTransactions,
} from './plaidClient'
import { authenticateBrokerJsonRequest } from './requestAuthentication'
import type {
  Env,
  PlaidPersonalFinanceCategory,
  PlaidRemovedTransaction,
  PlaidTransaction,
  PlaidTransactionsSyncResponse,
} from './bankFeedWorkerTypes'

const plaidPageCount = 500 as const
const maximumPaginationPages = 200
const maximumPaginationRestarts = 3
const paginationMutationErrorCode = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'

export type BankFeedProviderTransactionRecord = {
  provider: 'plaid'
  providerTransactionId: string
  providerAccountId: string
  pendingProviderTransactionId: string | null
  amount: number
  isoCurrencyCode: string | null
  unofficialCurrencyCode: string | null
  transactionDate: string
  transactionDateTime: string | null
  authorizedDate: string | null
  authorizedDateTime: string | null
  description: string
  merchantName: string | null
  originalDescription: string | null
  pending: boolean
  paymentChannel: string
  checkNumber: string | null
  transactionCode: string | null
  personalFinanceCategoryPrimary: string | null
  personalFinanceCategoryDetailed: string | null
  personalFinanceCategoryConfidenceLevel: string | null
}

export type BankFeedRemovedProviderTransactionRecord = {
  provider: 'plaid'
  providerTransactionId: string
  providerAccountId: string
}

type CollectedPlaidTransactionUpdates = {
  addedRecords: BankFeedProviderTransactionRecord[]
  modifiedRecords: BankFeedProviderTransactionRecord[]
  removedRecords: BankFeedRemovedProviderTransactionRecord[]
  proposedCursor: string
  transactionsUpdateStatus: string
  plaidRequestIds: string[]
  pageCount: number
  paginationRestartCount: number
}

export class PlaidTransactionPayloadValidationError extends Error {}

export class PlaidTransactionPaginationError extends Error {}

function readConnectionId(value: unknown) {
  if (typeof value !== 'string') return null

  const connectionId = value.trim()
  if (!connectionId || connectionId.length > 128 || /\s/.test(connectionId)) {
    return null
  }

  return connectionId
}

function readRequiredString(value: unknown) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function readOptionalString(value: unknown) {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : undefined
}

function readDate(value: unknown) {
  if (typeof value !== 'string') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function readOptionalDate(value: unknown) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

function readOptionalDateTime(value: unknown) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
}

function readPersonalFinanceCategory(value: unknown) {
  if (value === null || value === undefined) {
    return {
      primary: null,
      detailed: null,
      confidenceLevel: null,
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const category = value as PlaidPersonalFinanceCategory
  const primary = readRequiredString(category.primary)
  const detailed = readRequiredString(category.detailed)
  const confidenceLevel = readOptionalString(category.confidence_level)

  if (!primary || !detailed || confidenceLevel === undefined) return null

  return {
    primary,
    detailed,
    confidenceLevel,
  }
}

function normalizePlaidTransaction(
  value: PlaidTransaction,
): BankFeedProviderTransactionRecord {
  const providerTransactionId = readRequiredString(value?.transaction_id)
  const providerAccountId = readRequiredString(value?.account_id)
  const pendingProviderTransactionId = readOptionalString(
    value?.pending_transaction_id,
  )
  const isoCurrencyCode = readOptionalString(value?.iso_currency_code)
  const unofficialCurrencyCode = readOptionalString(
    value?.unofficial_currency_code,
  )
  const transactionDate = readDate(value?.date)
  const transactionDateTime = readOptionalDateTime(value?.datetime)
  const authorizedDate = readOptionalDate(value?.authorized_date)
  const authorizedDateTime = readOptionalDateTime(value?.authorized_datetime)
  const description = readRequiredString(value?.name)
  const merchantName = readOptionalString(value?.merchant_name)
  const originalDescription = readOptionalString(value?.original_description)
  const paymentChannel = readRequiredString(value?.payment_channel)
  const checkNumber = readOptionalString(value?.check_number)
  const transactionCode = readOptionalString(value?.transaction_code)
  const personalFinanceCategory = readPersonalFinanceCategory(
    value?.personal_finance_category,
  )

  if (
    !providerTransactionId
    || !providerAccountId
    || pendingProviderTransactionId === undefined
    || typeof value?.amount !== 'number'
    || !Number.isFinite(value.amount)
    || isoCurrencyCode === undefined
    || unofficialCurrencyCode === undefined
    || !transactionDate
    || transactionDateTime === undefined
    || authorizedDate === undefined
    || authorizedDateTime === undefined
    || !description
    || merchantName === undefined
    || originalDescription === undefined
    || typeof value?.pending !== 'boolean'
    || !paymentChannel
    || checkNumber === undefined
    || transactionCode === undefined
    || !personalFinanceCategory
  ) {
    throw new PlaidTransactionPayloadValidationError(
      'Plaid returned invalid transaction metadata.',
    )
  }

  return {
    provider: 'plaid',
    providerTransactionId,
    providerAccountId,
    pendingProviderTransactionId,
    amount: value.amount,
    isoCurrencyCode,
    unofficialCurrencyCode,
    transactionDate,
    transactionDateTime,
    authorizedDate,
    authorizedDateTime,
    description,
    merchantName,
    originalDescription,
    pending: value.pending,
    paymentChannel,
    checkNumber,
    transactionCode,
    personalFinanceCategoryPrimary: personalFinanceCategory.primary,
    personalFinanceCategoryDetailed: personalFinanceCategory.detailed,
    personalFinanceCategoryConfidenceLevel:
      personalFinanceCategory.confidenceLevel,
  }
}

function normalizeRemovedPlaidTransaction(
  value: PlaidRemovedTransaction,
): BankFeedRemovedProviderTransactionRecord {
  const providerTransactionId = readRequiredString(value?.transaction_id)
  const providerAccountId = readRequiredString(value?.account_id)

  if (!providerTransactionId || !providerAccountId) {
    throw new PlaidTransactionPayloadValidationError(
      'Plaid returned invalid removed-transaction metadata.',
    )
  }

  return {
    provider: 'plaid',
    providerTransactionId,
    providerAccountId,
  }
}

function validateSyncPage(response: PlaidTransactionsSyncResponse) {
  if (
    !response
    || !Array.isArray(response.added)
    || !Array.isArray(response.modified)
    || !Array.isArray(response.removed)
    || typeof response.next_cursor !== 'string'
    || response.next_cursor.length > 256
    || typeof response.has_more !== 'boolean'
    || !readRequiredString(response.request_id)
    || !readRequiredString(response.transactions_update_status)
  ) {
    throw new PlaidTransactionPayloadValidationError(
      'Plaid returned an invalid transaction-sync response.',
    )
  }
}

function appendUniqueRecords<T>(
  target: T[],
  values: T[],
  identifiers: Set<string>,
  getIdentifier: (value: T) => string,
  duplicateMessage: string,
) {
  for (const value of values) {
    const identifier = getIdentifier(value)

    if (identifiers.has(identifier)) {
      throw new PlaidTransactionPayloadValidationError(duplicateMessage)
    }

    identifiers.add(identifier)
    target.push(value)
  }
}

async function collectPlaidTransactionUpdates(
  env: Env,
  accessToken: string,
  providerAccountIds: ReadonlySet<string>,
  acknowledgedCursor: string | null,
): Promise<CollectedPlaidTransactionUpdates> {
  for (
    let restartCount = 0;
    restartCount <= maximumPaginationRestarts;
    restartCount += 1
  ) {
    const addedRecords: BankFeedProviderTransactionRecord[] = []
    const modifiedRecords: BankFeedProviderTransactionRecord[] = []
    const removedRecords: BankFeedRemovedProviderTransactionRecord[] = []
    const addedIds = new Set<string>()
    const modifiedIds = new Set<string>()
    const removedIds = new Set<string>()
    const plaidRequestIds: string[] = []
    let cursor = acknowledgedCursor || undefined
    let pageCount = 0
    let transactionsUpdateStatus = 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN'
    let restartPagination = false

    while (true) {
      pageCount += 1

      if (pageCount > maximumPaginationPages) {
        throw new PlaidTransactionPaginationError(
          'Plaid transaction synchronization exceeded the page safety limit.',
        )
      }

      let response: PlaidTransactionsSyncResponse

      try {
        response = await syncPlaidTransactions(env, {
          access_token: accessToken,
          ...(cursor ? { cursor } : {}),
          count: plaidPageCount,
          options: {
            include_original_description: true,
          },
        })
      } catch (error) {
        if (
          error instanceof PlaidApiError
          && error.errorCode === paginationMutationErrorCode
          && restartCount < maximumPaginationRestarts
        ) {
          restartPagination = true
          break
        }

        throw error
      }

      validateSyncPage(response)

      const normalizedAdded = response.added
        .map(normalizePlaidTransaction)
        .filter(record => providerAccountIds.has(record.providerAccountId))
      const normalizedModified = response.modified
        .map(normalizePlaidTransaction)
        .filter(record => providerAccountIds.has(record.providerAccountId))
      const normalizedRemoved = response.removed
        .map(normalizeRemovedPlaidTransaction)
        .filter(record => providerAccountIds.has(record.providerAccountId))

      appendUniqueRecords(
        addedRecords,
        normalizedAdded,
        addedIds,
        record => record.providerTransactionId,
        'Plaid returned duplicate added transaction identifiers.',
      )
      appendUniqueRecords(
        modifiedRecords,
        normalizedModified,
        modifiedIds,
        record => record.providerTransactionId,
        'Plaid returned duplicate modified transaction identifiers.',
      )
      appendUniqueRecords(
        removedRecords,
        normalizedRemoved,
        removedIds,
        record => record.providerTransactionId,
        'Plaid returned duplicate removed transaction identifiers.',
      )

      plaidRequestIds.push(response.request_id)
      transactionsUpdateStatus = response.transactions_update_status
      cursor = response.next_cursor

      if (!response.has_more) {
        return {
          addedRecords,
          modifiedRecords,
          removedRecords,
          proposedCursor: response.next_cursor,
          transactionsUpdateStatus,
          plaidRequestIds,
          pageCount,
          paginationRestartCount: restartCount,
        }
      }

      if (!response.next_cursor) {
        throw new PlaidTransactionPayloadValidationError(
          'Plaid returned has_more without a next cursor.',
        )
      }
    }

    if (!restartPagination) break
  }

  throw new PlaidTransactionPaginationError(
    'Plaid transaction synchronization changed repeatedly during pagination.',
  )
}

function plaidErrorResponse(
  env: Env,
  requestId: string,
  error: PlaidApiError,
) {
  console.error('Plaid transaction synchronization failed:', {
    status: error.status,
    errorType: error.errorType,
    errorCode: error.errorCode,
    errorMessage: error.message,
    plaidRequestId: error.plaidRequestId,
  })

  return badGateway(
    requestId,
    error.displayMessage || 'Plaid transaction synchronization failed.',
    {
      provider: 'plaid',
      providerErrorType: error.errorType,
      providerErrorCode: error.errorCode,
      providerErrorMessage: env.SERVICE_ENVIRONMENT === 'development'
        ? error.message
        : undefined,
      providerRequestId: error.plaidRequestId,
    },
  )
}

export async function handleSyncPlaidTransactions(
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

  const connectionId = readConnectionId(
    authentication.request.body.connectionId,
  )

  if (!connectionId) {
    return badRequest(requestId, 'A valid bank-feed connection ID is required.')
  }

  let reservation: Awaited<ReturnType<typeof reservePlaidTransactionSync>>

  try {
    reservation = await reservePlaidTransactionSync(
      env,
      authentication.request.accountIntegrationId,
      connectionId,
    )
  } catch (error) {
    if (error instanceof BankFeedSyncConnectionNotFoundError) {
      return jsonResponse(404, {
        ok: false,
        requestId,
        message: 'Bank-feed connection was not found.',
      }, requestId)
    }

    if (error instanceof BankFeedSyncConnectionUnavailableError) {
      return jsonResponse(409, {
        ok: false,
        requestId,
        message: error.message,
      }, requestId)
    }

    if (error instanceof BankFeedPendingDeliveryBatchError) {
      return jsonResponse(409, {
        ok: false,
        requestId,
        message: error.message,
        pendingBatchId: error.batchId,
        pendingBatchExpiresAt: error.expiresAt,
      }, requestId)
    }

    if (error instanceof BankFeedTransactionSyncStorageError) {
      return serviceUnavailable(requestId, error.message)
    }

    if (error instanceof BankFeedAccountStorageValidationError) {
      console.error('Stored Plaid connected-account metadata is invalid:', error)
      return serviceUnavailable(
        requestId,
        'Stored Plaid connected-account metadata is unavailable.',
      )
    }

    throw error
  }

  try {
    const accessToken = await decryptPlaidAccessToken(env, {
      accountIntegrationId: authentication.request.accountIntegrationId,
      providerItemId: reservation.providerItemId,
      encryptedAccessToken: reservation.encryptedAccessToken,
      accessTokenIv: reservation.accessTokenIv,
      accessTokenKeyVersion: reservation.accessTokenKeyVersion,
    })

    const providerAccounts = await listStoredBankFeedProviderAccountsForDelivery(
      env,
      authentication.request.accountIntegrationId,
      reservation.connectionId,
    )

    if (reservation.accountStreams.length === 0) {
      await releasePlaidTransactionSyncReservation(env, reservation)

      return jsonResponse(200, {
        ok: true,
        requestId,
        provider: 'plaid',
        connectionId: reservation.connectionId,
        dataReady: false,
        deliveryBatchCreated: false,
        transactionsUpdateStatus: 'NO_CONNECTED_ACCOUNTS',
        addedCount: 0,
        modifiedCount: 0,
        removedCount: 0,
        providerAccounts,
        addedRecords: [],
        modifiedRecords: [],
        removedRecords: [],
        plaidRequestIds: [],
      }, requestId)
    }

    const addedRecords: BankFeedProviderTransactionRecord[] = []
    const modifiedRecords: BankFeedProviderTransactionRecord[] = []
    const removedRecords: BankFeedRemovedProviderTransactionRecord[] = []
    const addedIds = new Set<string>()
    const modifiedIds = new Set<string>()
    const removedIds = new Set<string>()
    const accountCursors: Array<{
      providerAccountId: string
      fromCursor: string | null
      proposedCursor: string
    }> = []
    const plaidRequestIds: string[] = []
    const statusValues = new Set<string>()
    let pageCount = 0
    let paginationRestartCount = 0

    const streamGroups = new Map<
      string | null,
      typeof reservation.accountStreams
    >()

    for (const stream of reservation.accountStreams) {
      const group = streamGroups.get(stream.acknowledgedCursor) ?? []
      group.push(stream)
      streamGroups.set(stream.acknowledgedCursor, group)
    }

    for (const [acknowledgedCursor, streams] of streamGroups) {
      const providerAccountIds = new Set(
        streams.map(stream => stream.providerAccountId),
      )
      const updates = await collectPlaidTransactionUpdates(
        env,
        accessToken,
        providerAccountIds,
        acknowledgedCursor,
      )

      appendUniqueRecords(
        addedRecords,
        updates.addedRecords,
        addedIds,
        record => record.providerTransactionId,
        'Plaid returned duplicate added transaction identifiers across account streams.',
      )
      appendUniqueRecords(
        modifiedRecords,
        updates.modifiedRecords,
        modifiedIds,
        record => record.providerTransactionId,
        'Plaid returned duplicate modified transaction identifiers across account streams.',
      )
      appendUniqueRecords(
        removedRecords,
        updates.removedRecords,
        removedIds,
        record => record.providerTransactionId,
        'Plaid returned duplicate removed transaction identifiers across account streams.',
      )

      for (const stream of streams) {
        accountCursors.push({
          providerAccountId: stream.providerAccountId,
          fromCursor: stream.acknowledgedCursor,
          proposedCursor: updates.proposedCursor,
        })
      }

      plaidRequestIds.push(...updates.plaidRequestIds)
      statusValues.add(updates.transactionsUpdateStatus)
      pageCount += updates.pageCount
      paginationRestartCount += updates.paginationRestartCount
    }

    const totalRecordCount = addedRecords.length
      + modifiedRecords.length
      + removedRecords.length
    const cursorChanged = accountCursors.some(cursor => (
      cursor.proposedCursor !== cursor.fromCursor
    ))

    if (totalRecordCount === 0 && !cursorChanged) {
      await releasePlaidTransactionSyncReservation(env, reservation)

      return jsonResponse(200, {
        ok: true,
        requestId,
        provider: 'plaid',
        connectionId: reservation.connectionId,
        dataReady: false,
        deliveryBatchCreated: false,
        transactionsUpdateStatus: [...statusValues].join(',')
          || 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
        addedCount: 0,
        modifiedCount: 0,
        removedCount: 0,
        providerAccounts,
        addedRecords: [],
        modifiedRecords: [],
        removedRecords: [],
        plaidRequestIds,
      }, requestId)
    }

    await finalizePlaidTransactionSync(env, {
      ...reservation,
      requestId,
      accountCursors,
      addedCount: addedRecords.length,
      modifiedCount: modifiedRecords.length,
      removedCount: removedRecords.length,
    })

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      connectionId: reservation.connectionId,
      dataReady: true,
      deliveryBatchCreated: true,
      batchId: reservation.batchId,
      issuedAt: reservation.issuedAt,
      expiresAt: reservation.expiresAt,
      transactionsUpdateStatus: [...statusValues].join(',')
        || 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
      pageCount,
      paginationRestartCount,
      addedCount: addedRecords.length,
      modifiedCount: modifiedRecords.length,
      removedCount: removedRecords.length,
      providerAccounts,
      addedRecords,
      modifiedRecords,
      removedRecords,
      plaidRequestIds,
    }, requestId)
  } catch (error) {
    const failureCode = error instanceof PlaidApiError
      ? error.errorCode || 'PLAID_API_ERROR'
      : error instanceof PlaidConfigurationError
        ? 'PLAID_CONFIGURATION_ERROR'
        : error instanceof AccessTokenEncryptionConfigurationError
        ? 'ACCESS_TOKEN_KEY_CONFIGURATION_ERROR'
        : error instanceof AccessTokenDecryptionError
          ? 'ACCESS_TOKEN_DECRYPTION_FAILED'
          : error instanceof PlaidTransactionPayloadValidationError
            ? 'INVALID_PROVIDER_PAYLOAD'
            : error instanceof PlaidTransactionPaginationError
              ? 'TRANSACTION_PAGINATION_FAILED'
              : error instanceof BankFeedTransactionSyncStorageError
                ? 'DELIVERY_STORAGE_FAILED'
                : error instanceof BankFeedAccountStorageValidationError
                  ? 'ACCOUNT_METADATA_UNAVAILABLE'
                  : 'UNEXPECTED_SYNC_ERROR'

    await failPlaidTransactionSync(env, {
      ...reservation,
      requestId,
      failureCode,
    })

    if (error instanceof PlaidConfigurationError) {
      return serviceUnavailable(
        requestId,
        'Plaid transaction synchronization is not configured.',
      )
    }

    if (error instanceof AccessTokenEncryptionConfigurationError) {
      console.error('Plaid access-token key configuration failed:', error)
      return serviceUnavailable(
        requestId,
        'Plaid access-token encryption is not configured correctly.',
      )
    }

    if (error instanceof AccessTokenDecryptionError) {
      console.error('Stored Plaid access-token decryption failed:', error)
      return serviceUnavailable(
        requestId,
        'Stored Plaid connection credentials are unavailable.',
      )
    }

    if (error instanceof PlaidApiError) {
      return plaidErrorResponse(env, requestId, error)
    }

    if (error instanceof PlaidTransactionPayloadValidationError) {
      console.error('Plaid transaction payload validation failed:', error)
      return badGateway(
        requestId,
        'Plaid returned invalid transaction data.',
        { provider: 'plaid' },
      )
    }

    if (error instanceof PlaidTransactionPaginationError) {
      console.error('Plaid transaction pagination failed:', error)
      return badGateway(
        requestId,
        'Plaid transaction pagination could not be completed.',
        { provider: 'plaid' },
      )
    }

    if (error instanceof BankFeedTransactionSyncStorageError) {
      return serviceUnavailable(requestId, error.message)
    }

    if (error instanceof BankFeedAccountStorageValidationError) {
      console.error('Stored Plaid connected-account metadata is invalid:', error)
      return serviceUnavailable(
        requestId,
        'Stored Plaid connected-account metadata is unavailable.',
      )
    }

    throw error
  }
}
