import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  serviceUnavailable,
} from './bankFeedWorkerHttp'
import {
  BankFeedDeliveryAcknowledgmentConflictError,
  BankFeedDeliveryAcknowledgmentCountMismatchError,
  BankFeedDeliveryAcknowledgmentNotFoundError,
  BankFeedTransactionSyncStorageError,
  acknowledgePlaidTransactionDelivery,
} from './bankFeedTransactionSyncRepository'
import { authenticateBrokerJsonRequest } from './requestAuthentication'
import type { Env } from './bankFeedWorkerTypes'

function readIdentifier(value: unknown) {
  if (typeof value !== 'string') return null

  const identifier = value.trim()
  if (!identifier || identifier.length > 128 || /\s/.test(identifier)) {
    return null
  }

  return identifier
}

function readRecordCount(value: unknown) {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > 1_000_000
  ) {
    return null
  }

  return value
}

export async function handleAcknowledgePlaidTransactionDelivery(
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

  const connectionId = readIdentifier(
    authentication.request.body.connectionId,
  )
  const batchId = readIdentifier(authentication.request.body.batchId)
  const persistedAddedCount = readRecordCount(
    authentication.request.body.persistedAddedCount,
  )
  const persistedModifiedCount = readRecordCount(
    authentication.request.body.persistedModifiedCount,
  )
  const persistedRemovedCount = readRecordCount(
    authentication.request.body.persistedRemovedCount,
  )

  if (!connectionId) {
    return badRequest(requestId, 'A valid bank-feed connection ID is required.')
  }

  if (!batchId) {
    return badRequest(requestId, 'A valid transaction delivery batch ID is required.')
  }

  if (
    persistedAddedCount === null
    || persistedModifiedCount === null
    || persistedRemovedCount === null
  ) {
    return badRequest(
      requestId,
      'Valid persisted transaction record counts are required.',
    )
  }

  try {
    const acknowledgment = await acknowledgePlaidTransactionDelivery(
      env,
      authentication.request.accountIntegrationId,
      {
        connectionId,
        batchId,
        persistedAddedCount,
        persistedModifiedCount,
        persistedRemovedCount,
      },
    )

    return jsonResponse(200, {
      ok: true,
      requestId,
      provider: 'plaid',
      connectionId: acknowledgment.connectionId,
      batchId: acknowledgment.batchId,
      deliveryStatus: 'acknowledged',
      cursorAdvanced: true,
      alreadyAcknowledged: acknowledgment.alreadyAcknowledged,
      acknowledgedAt: acknowledgment.acknowledgedAt,
      addedCount: acknowledgment.addedCount,
      modifiedCount: acknowledgment.modifiedCount,
      removedCount: acknowledgment.removedCount,
    }, requestId)
  } catch (error) {
    if (error instanceof BankFeedDeliveryAcknowledgmentNotFoundError) {
      return jsonResponse(404, {
        ok: false,
        requestId,
        message: error.message,
      }, requestId)
    }

    if (error instanceof BankFeedDeliveryAcknowledgmentCountMismatchError) {
      return jsonResponse(409, {
        ok: false,
        requestId,
        message: error.message,
        expectedAddedCount: error.expectedAddedCount,
        expectedModifiedCount: error.expectedModifiedCount,
        expectedRemovedCount: error.expectedRemovedCount,
      }, requestId)
    }

    if (error instanceof BankFeedDeliveryAcknowledgmentConflictError) {
      return jsonResponse(409, {
        ok: false,
        requestId,
        message: error.message,
        conflictCode: error.conflictCode,
      }, requestId)
    }

    if (error instanceof BankFeedTransactionSyncStorageError) {
      return serviceUnavailable(requestId, error.message)
    }

    throw error
  }
}
